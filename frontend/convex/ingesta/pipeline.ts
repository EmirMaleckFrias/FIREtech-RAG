"use node";
// Ingesta de un documento: leer el fichero del almacenamiento, parsear,
// trocear, embeber e indexar. Port de `_ingest_uploaded` (api/documents.py) y
// del swap por versión de `pipeline.py` al modelo de Convex.
//
// `documentos.registrar` y `documentos.reindexar` dejan el documento en
// `processing` y agendan esta acción. Aquí:
//
// 1. Se lee el fichero ORIGINAL de `ctx.storage` (es lo que arregla el
//    reindexado: en Vercel el disco era efímero y había que volver a subir).
// 2. El sha256 del fichero es la `documentVersion` de sus fragmentos.
// 3. Se embebe en lotes de 96 y se escribe CADA lote en mutaciones de como
//    mucho 32 fragmentos: un fragmento lleva 3072 números y los argumentos de
//    una mutación desde el runtime de Node tienen un tope de 5 MiB.
// 4. Solo después de escribir la versión nueva se retira la anterior: un
//    fallo de embeddings no deja al documento sin ninguna versión consultable.
// 5. Ante cualquier fallo: `failed` con el mensaje, sin fragmentos a medias
//    de la versión nueva, y la corrida cerrada como fallida.
//
// "use node" porque el parseo corre en Node (pdf.js vía unpdf, jszip). Un
// fichero así solo puede exportar acciones: las mutaciones están en
// `escritura.ts` y la lógica pura en el resto del directorio.
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import { Telemetria } from "../lib/telemetry";
import { sha256Hex } from "./hash";
import { PERDIO_EL_DOCUMENTO } from "./escritura";
import { EMBEDDINGS_A_LA_VEZ, LOTE_BORRADO, LOTE_EMBEDDINGS, LOTE_ESCRITURA, MAX_ERROR_CHARS } from "./lotes";
import { crearOcr } from "./ocr";
import { parsearDocumento } from "./parsear";
import type { AvisosIngesta, ChunkParseado } from "./tipos";

function mensajeDe(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Cadena vacía -> campo ausente: en la base no hay "" que filtrar. */
function oNada(valor: string): string | undefined {
  return valor ? valor : undefined;
}

function aEntrada(chunk: ChunkParseado, embedding: number[]) {
  return {
    text: chunk.text,
    embedding,
    page: chunk.page,
    sourcePages: chunk.sourcePages,
    section: oNada(chunk.section),
    chunkType: chunk.chunkType,
    documentType: chunk.documentType,
    language: oNada(chunk.language),
    titulo: oNada(chunk.titulo),
    citation: oNada(chunk.citation),
    doi: oNada(chunk.doi),
    metadata: chunk.metadata,
  };
}

/** Borra en lotes hasta que no quede nada que borrar. */
async function borrarEnLotes(
  ctx: ActionCtx,
  args: {
    documentId: Id<"documents">;
    version: string;
    desde: number;
    modo: "antiguos" | "deEstaCorrida";
    runId: Id<"ingestionRuns">;
  },
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await ctx.runMutation(internal.ingesta.escritura.borrarChunks, {
      ...args,
      lote: LOTE_BORRADO,
    });
    total += n;
    if (n < LOTE_BORRADO) return total;
  }
}

/** Cuánto trabaja una acción de embebido antes de pasar el relevo a la
 *  siguiente. La acción de Node dura 10 minutos; con 7 de trabajo queda
 *  margen para el grupo en vuelo y el cierre. */
let tiempoPorAccionMs = 7 * 60_000;
export function configurarTiempoPorAccion(ms: number): void {
  tiempoPorAccionMs = Math.max(0, ms);
}

/** Fragmentos pendientes que se guardan por mutación al terminar de leer. */
const LOTE_PENDIENTES = 100;
/** Cada cuánto, como mucho, se escribe el avance mientras se lee. */
const PASO_PROGRESO_MS = 1500;

/** Lo que el embebido necesita saber del parseo para cerrar el documento. */
const cabeceraDeIngesta = v.object({
  pages: v.number(),
  chunks: v.number(),
  avisos: v.optional(v.any()),
  titulo: v.optional(v.string()),
  citation: v.optional(v.string()),
  doi: v.optional(v.string()),
  language: v.optional(v.string()),
  documentType: v.optional(v.string()),
});

/**
 * Primera etapa: leer el fichero y dejar los fragmentos en la cola.
 *
 * No hay tope de tamaño por documento. Lo hubo (4000 fragmentos) y hacía
 * fallar un manual de 7 MB con "divide el documento": el límite real es el
 * tiempo de una acción, así que esta lee y parsea (escribiendo el avance
 * página a página), guarda los fragmentos en `fragmentosPendientes` y agenda
 * `embeber`, que los embebe y escribe en acciones encadenadas hasta vaciar la
 * cola. La usuaria ve la fase, cuánto va de cuánto y lo que falta.
 */
export const ingestar = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const a = ajustes();
    const tel = new Telemetria();
    const t0 = Date.now();
    const run = await ctx.runMutation(internal.ingesta.escritura.abrirRun, { documentId });
    const stats: Record<string, unknown> = { pages: 0, chunks: 0, ms: 0, tokens_embedding: 0 };
    let fileName = "";
    let desde = run.empezadoEn;

    try {
      // Reclamar ANTES de leer el fichero: la corrida más reciente es la que
      // gana, y a partir de aquí cualquier otra que estuviera escribiendo
      // este documento se detiene en su siguiente escritura. Ver
      // escritura.reclamarDocumento.
      const reclamo = await ctx.runMutation(internal.ingesta.escritura.reclamarDocumento, {
        documentId,
        runId: run.runId,
      });
      desde = reclamo.reclamadoEn;
      const doc = reclamo.doc;
      fileName = doc.fileName;
      stats.fileName = fileName;
      stats.documentId = String(documentId);
      tel.fija({ documento: fileName });
      if (!doc.storageId) {
        throw new Error("el documento no tiene fichero almacenado: vuelve a subirlo");
      }
      const blob = await ctx.storage.get(doc.storageId);
      if (!blob) throw new Error("el fichero no está en el almacenamiento: vuelve a subirlo");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const version = await sha256Hex(bytes);

      // Avance de la lectura, acotado en frecuencia: un PDF de 600 páginas no
      // escribe 600 veces.
      let ultimoProgreso = 0;
      const progreso = async (hecho: number, total: number, forzar = false) => {
        const ahora = Date.now();
        if (!forzar && ahora - ultimoProgreso < PASO_PROGRESO_MS) return;
        ultimoProgreso = ahora;
        await ctx.runMutation(internal.ingesta.escritura.actualizarProgreso, {
          documentId, runId: run.runId, fase: "leyendo", hecho, total, empezadoEn: t0,
        });
      };
      // Las escrituras de progreso se encadenan sin bloquear el parseo.
      let colaProgreso: Promise<unknown> = Promise.resolve();
      const alAvanzar = (hecho: number, total: number) => {
        colaProgreso = colaProgreso.then(() => progreso(hecho, total)).catch(() => undefined);
      };
      await progreso(0, 0, true);

      // El OCR se inyecta a los parsers: ellos deciden qué imágenes leer (las
      // páginas sin texto, las imágenes sueltas, los adjuntos de Word) y esto
      // las lee, con caché y en paralelo. Ver ingesta/ocr.ts.
      const { ocr, estadisticas: ocrStats } = crearOcr(ctx, a);
      const { chunks, pages, avisos } = await parsearDocumento(fileName, bytes, {
        ocr,
        minTextoPagina: a.ocrMinTextoPagina,
        alAvanzar,
      });
      await colaProgreso;
      stats.pages = pages;
      stats.chunks = chunks.length;
      if (avisos) {
        stats.avisos = avisos;
        console.warn(
          `Ingesta de '${fileName}' con avisos: ${avisos.sinLeer} sin leer, ${avisos.omitidas} omitidas, ` +
            `${avisos.recortados} recortados${avisos.motivo ? ` (${avisos.motivo})` : ""}.`,
        );
      }
      if (ocrStats.imagenes > 0 || ocrStats.omitidasPorTope > 0) {
        stats.ocr = ocrStats;
        console.info(
          `OCR de '${fileName}': ${ocrStats.imagenes} imágenes (${ocrStats.enCache} en caché, ` +
            `${ocrStats.leidas} leídas, ${ocrStats.fallidas} fallidas) en ${ocrStats.ms} ms.`,
        );
      }
      console.info(`Ingesta de '${fileName}': ${chunks.length} chunks, ${pages} páginas/filas.`);

      // A la cola, por lotes: una mutación admite ~5 MiB de argumentos y un
      // fragmento tiene hasta 8000 caracteres.
      for (let i = 0; i < chunks.length; i += LOTE_PENDIENTES) {
        await ctx.runMutation(internal.ingesta.escritura.guardarPendientes, {
          documentId, runId: run.runId, desde: i, chunks: chunks.slice(i, i + LOTE_PENDIENTES),
        });
      }
      stats.ms_lectura = Date.now() - t0;
      stats.telemetria_lectura = tel.resumen();
      await ctx.runMutation(internal.ingesta.escritura.anotarStats, { runId: run.runId, stats });
      await ctx.runMutation(internal.ingesta.escritura.actualizarProgreso, {
        documentId, runId: run.runId, fase: "embebiendo", hecho: 0, total: chunks.length, empezadoEn: Date.now(),
      });

      const primero = chunks[0];
      await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.embeber, {
        documentId,
        runId: run.runId,
        version,
        desde,
        cursor: 0,
        tokens: 0,
        empezadoEn: t0,
        cabecera: {
          pages,
          chunks: chunks.length,
          avisos,
          titulo: oNada(primero.titulo),
          citation: oNada(primero.citation),
          doi: oNada(primero.doi),
          language: oNada(primero.language),
          documentType: primero.documentType,
        },
      });
    } catch (exc) {
      await fallar(ctx, { documentId, runId: run.runId, fileName, exc, stats, t0, tel });
    }
  },
});

/**
 * Segunda etapa, encadenada: embeber y escribir los fragmentos pendientes.
 *
 * Cada invocación trabaja hasta `tiempoPorAccionMs` y, si queda cola, se
 * reagenda a sí misma con el cursor: así un documento de cualquier tamaño
 * se indexa aunque una sola acción no pueda con él. Los lotes de embeddings
 * van de EMBEDDINGS_A_LA_VEZ en paralelo; las escrituras, en orden. El avance
 * se escribe por grupo, y al vaciar la cola se retira la versión anterior, se
 * marca el documento listo y se cierra la corrida con las cifras del parseo
 * más las del embebido.
 */
export const embeber = internalAction({
  args: {
    documentId: v.id("documents"),
    runId: v.id("ingestionRuns"),
    version: v.string(),
    desde: v.number(),
    cursor: v.number(),
    tokens: v.number(),
    empezadoEn: v.number(),
    cabecera: cabeceraDeIngesta,
  },
  handler: async (ctx, args) => {
    const a = ajustes();
    const tel = new Telemetria();
    const tAccion = Date.now();
    let cursor = args.cursor;
    let tokens = args.tokens;
    const stats: Record<string, unknown> = { fileName: undefined, chunks: args.cabecera.chunks };
    let fileName = "";
    try {
      const doc = await ctx.runQuery(internal.ingesta.escritura.documento, { documentId: args.documentId });
      if (!doc) throw new Error("el documento ya no existe en el registro");
      if (doc.ingestaRunId !== args.runId) throw new Error(PERDIO_EL_DOCUMENTO);
      fileName = doc.fileName;
      tel.fija({ documento: fileName });

      const embeberLote = async (lote: ChunkParseado[]) => {
        const t1 = Date.now();
        let respuesta: Awaited<ReturnType<typeof gateway.embed>>;
        try {
          respuesta = await gateway.embed(lote.map((c) => c.text), a);
        } catch (exc) {
          tel.anota("embeddings", a.modeloEmbedding, null, { ms: Date.now() - t1, ok: false, nota: mensajeDe(exc).slice(0, 120) });
          throw exc;
        }
        tel.anota("embeddings", respuesta.modelo, respuesta.usage, { ms: Date.now() - t1 });
        if (respuesta.vectores.length !== lote.length) {
          throw new Error(`${respuesta.vectores.length} embeddings para ${lote.length} chunks`);
        }
        return respuesta;
      };

      for (;;) {
        const pendientes = await ctx.runQuery(internal.ingesta.escritura.leerPendientes, {
          runId: args.runId, desde: cursor, n: LOTE_EMBEDDINGS * EMBEDDINGS_A_LA_VEZ,
        });
        if (!pendientes.length) break;
        const lotes: ChunkParseado[][] = [];
        for (let k = 0; k < pendientes.length; k += LOTE_EMBEDDINGS) {
          lotes.push(pendientes.slice(k, k + LOTE_EMBEDDINGS).map((f) => f.chunk as ChunkParseado));
        }
        const respuestas = await Promise.all(lotes.map(embeberLote));
        for (const [n, lote] of lotes.entries()) {
          const respuesta = respuestas[n];
          tokens += respuesta.usage.prompt;
          for (let j = 0; j < lote.length; j += LOTE_ESCRITURA) {
            const trozo = lote.slice(j, j + LOTE_ESCRITURA);
            await ctx.runMutation(internal.ingesta.escritura.insertarChunks, {
              documentId: args.documentId,
              version: args.version,
              runId: args.runId,
              chunks: trozo.map((c, k) => aEntrada(c, respuesta.vectores[j + k])),
            });
          }
        }
        cursor = pendientes[pendientes.length - 1].indice + 1;
        // Lo ya embebido sale de la cola; el avance, a la ficha.
        await borrarPendientesHasta(ctx, args.runId, cursor);
        await ctx.runMutation(internal.ingesta.escritura.actualizarProgreso, {
          documentId: args.documentId, runId: args.runId, fase: "embebiendo",
          hecho: cursor, total: args.cabecera.chunks, empezadoEn: args.empezadoEn,
        });
        // Un grupo incompleto era el último: no queda nada que embeber.
        const quedaMas = pendientes.length === LOTE_EMBEDDINGS * EMBEDDINGS_A_LA_VEZ;
        if (quedaMas && Date.now() - tAccion > tiempoPorAccionMs) {
          // Relevo: la siguiente acción sigue desde el cursor, con reloj nuevo.
          await ctx.runMutation(internal.ingesta.escritura.anotarStats, {
            runId: args.runId, stats: { relevos_embebido: ((await statsDe(ctx, args.runId)).relevos_embebido as number ?? 0) + 1 },
          });
          await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.embeber, { ...args, cursor, tokens });
          return;
        }
      }

      // Swap seguro por versión: la anterior seguía consultable hasta aquí; se
      // retira solo después de confirmar la nueva. Se llevan también los
      // restos de esta misma versión anteriores al reclamo (una ingesta que
      // murió a medias, el reindexado de un fichero sin cambios, o lo que una
      // corrida perdedora alcanzó a escribir).
      const retirados = await borrarEnLotes(ctx, {
        documentId: args.documentId, version: args.version, desde: args.desde, modo: "antiguos", runId: args.runId,
      });
      const c = args.cabecera;
      await ctx.runMutation(internal.ingesta.escritura.marcarListo, {
        documentId: args.documentId,
        sha256: args.version,
        pages: c.pages,
        chunks: c.chunks,
        titulo: c.titulo,
        citation: c.citation,
        doi: c.doi,
        language: c.language,
        documentType: c.documentType,
        avisos: c.avisos as AvisosIngesta | undefined,
        runId: args.runId,
      });
      const previas = await statsDe(ctx, args.runId);
      await ctx.runMutation(internal.ingesta.escritura.cerrarRun, {
        runId: args.runId,
        status: "completed",
        stats: {
          ...previas,
          chunks_retirados: retirados,
          tokens_embedding: tokens,
          ms: Date.now() - args.empezadoEn,
          telemetria: tel.resumen(),
        },
      });
      console.info(`Ingesta de '${fileName}' completa: ${c.chunks} fragmentos en ${Date.now() - args.empezadoEn} ms.`);
    } catch (exc) {
      await fallar(ctx, { documentId: args.documentId, runId: args.runId, fileName, exc, stats, t0: args.empezadoEn, tel, version: args.version, desde: args.desde });
    }
  },
});

async function statsDe(ctx: ActionCtx, runId: Id<"ingestionRuns">): Promise<Record<string, unknown>> {
  const run = await ctx.runQuery(internal.ingesta.escritura.corrida, { runId });
  return (run?.stats as Record<string, unknown>) ?? {};
}

async function borrarPendientesHasta(ctx: ActionCtx, runId: Id<"ingestionRuns">, hasta?: number): Promise<void> {
  for (;;) {
    const n = await ctx.runMutation(internal.ingesta.escritura.borrarPendientes, { runId, lote: LOTE_PENDIENTES, hasta });
    if (n < LOTE_PENDIENTES) return;
  }
}

/** El camino de fallo, común a las dos etapas. Si otra corrida más reciente
 *  reclamó el documento, esta se retira SIN tocar nada suyo (sus fragmentos
 *  anteriores al reclamo los retira la nueva; el estado es de la nueva): solo
 *  vacía su cola y cierra su corrida diciendo por qué. En cualquier otro
 *  fallo: fuera los fragmentos de esta corrida, fuera su cola, el documento a
 *  `failed` con el motivo, y la corrida cerrada. */
async function fallar(
  ctx: ActionCtx,
  args: {
    documentId: Id<"documents">;
    runId: Id<"ingestionRuns">;
    fileName: string;
    exc: unknown;
    stats: Record<string, unknown>;
    t0: number;
    tel: Telemetria;
    version?: string;
    desde?: number;
  },
): Promise<void> {
  const mensaje = mensajeDe(args.exc).slice(0, MAX_ERROR_CHARS);
  const perdio = mensaje.includes(PERDIO_EL_DOCUMENTO);
  if (perdio) console.warn(`La ingesta de '${args.fileName}' se retira: ${PERDIO_EL_DOCUMENTO}.`);
  else console.error(`Falló la ingesta de '${args.fileName}': ${mensaje}`);
  if (!perdio && args.version !== undefined && args.desde !== undefined) {
    try {
      await borrarEnLotes(ctx, { documentId: args.documentId, version: args.version, desde: args.desde, modo: "deEstaCorrida", runId: args.runId });
    } catch (limpieza) {
      console.error(`No se pudieron limpiar los fragmentos de '${args.fileName}': ${mensajeDe(limpieza)}`);
    }
  }
  try {
    await borrarPendientesHasta(ctx, args.runId);
  } catch (cola) {
    console.error(`No se pudo vaciar la cola de '${args.fileName}': ${mensajeDe(cola)}`);
  }
  if (!perdio) {
    try {
      await ctx.runMutation(internal.ingesta.escritura.marcarFallido, { documentId: args.documentId, error: mensaje, runId: args.runId });
    } catch (marca) {
      console.error(`No se pudo marcar '${args.fileName}' como failed: ${mensajeDe(marca)}`);
    }
  }
  const stats = { ...args.stats, ms: Date.now() - args.t0, telemetria: args.tel.resumen() };
  try {
    const previas = await statsDe(ctx, args.runId);
    await ctx.runMutation(internal.ingesta.escritura.cerrarRun, {
      runId: args.runId, status: "failed", stats: { ...previas, ...stats }, error: mensaje,
    });
  } catch (cierre) {
    console.error(`No se pudo cerrar la corrida de '${args.fileName}': ${mensajeDe(cierre)}`);
  }
}
