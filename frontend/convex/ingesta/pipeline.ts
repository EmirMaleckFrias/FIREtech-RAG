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
import { LOTE_BORRADO, LOTE_EMBEDDINGS, LOTE_ESCRITURA, MAX_ERROR_CHARS } from "./lotes";
import { parsearDocumento } from "./parsear";
import type { ChunkParseado } from "./tipos";

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

export const ingestar = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const a = ajustes();
    const tel = new Telemetria();
    const t0 = Date.now();
    const run = await ctx.runMutation(internal.ingesta.escritura.abrirRun, {});
    const stats: Record<string, unknown> = { pages: 0, chunks: 0, ms: 0, tokens_embedding: 0 };
    let version: string | null = null;
    let fileName = "";

    try {
      const doc = await ctx.runQuery(internal.ingesta.escritura.documento, { documentId });
      if (!doc) throw new Error("el documento ya no existe en el registro");
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
      version = await sha256Hex(bytes);

      const { chunks, pages } = await parsearDocumento(fileName, bytes);
      stats.pages = pages;
      stats.chunks = chunks.length;
      console.info(`Ingesta de '${fileName}': ${chunks.length} chunks, ${pages} páginas/filas.`);

      // Embeber y escribir lote a lote: la memoria queda acotada a un lote
      // (4000 fragmentos de 3072 números serían ~100 MB de vectores) y un
      // fallo a mitad deja menos que limpiar.
      let tokens = 0;
      for (let i = 0; i < chunks.length; i += LOTE_EMBEDDINGS) {
        const lote = chunks.slice(i, i + LOTE_EMBEDDINGS);
        const t1 = Date.now();
        let respuesta: Awaited<ReturnType<typeof gateway.embed>>;
        try {
          respuesta = await gateway.embed(lote.map((c) => c.text), a);
        } catch (exc) {
          tel.anota("embeddings", a.modeloEmbedding, null, {
            ms: Date.now() - t1,
            ok: false,
            nota: mensajeDe(exc).slice(0, 120),
          });
          throw exc;
        }
        tel.anota("embeddings", respuesta.modelo, respuesta.usage, { ms: Date.now() - t1 });
        tokens += respuesta.usage.prompt;
        if (respuesta.vectores.length !== lote.length) {
          throw new Error(`${respuesta.vectores.length} embeddings para ${lote.length} chunks`);
        }
        for (let j = 0; j < lote.length; j += LOTE_ESCRITURA) {
          const trozo = lote.slice(j, j + LOTE_ESCRITURA);
          await ctx.runMutation(internal.ingesta.escritura.insertarChunks, {
            documentId,
            version,
            chunks: trozo.map((c, k) => aEntrada(c, respuesta.vectores[j + k])),
          });
        }
      }
      stats.tokens_embedding = tokens;

      // Swap seguro por versión: la anterior seguía consultable hasta aquí; se
      // retira solo después de confirmar la nueva. Se llevan también los
      // restos de esta misma versión anteriores a la corrida (una ingesta
      // que murió a medias, o el reindexado de un fichero sin cambios).
      const retirados = await borrarEnLotes(ctx, {
        documentId,
        version,
        desde: run.empezadoEn,
        modo: "antiguos",
      });
      stats.chunks_retirados = retirados;

      const primero = chunks[0];
      await ctx.runMutation(internal.ingesta.escritura.marcarListo, {
        documentId,
        sha256: version,
        pages,
        chunks: chunks.length,
        titulo: oNada(primero.titulo),
        citation: oNada(primero.citation),
        doi: oNada(primero.doi),
        language: oNada(primero.language),
        documentType: primero.documentType,
      });
      stats.ms = Date.now() - t0;
      stats.telemetria = tel.resumen();
      await ctx.runMutation(internal.ingesta.escritura.cerrarRun, {
        runId: run.runId,
        status: "completed",
        stats,
      });
      console.info(`Ingesta de '${fileName}' completa: ${chunks.length} fragmentos.`);
    } catch (exc) {
      const mensaje = mensajeDe(exc).slice(0, MAX_ERROR_CHARS);
      console.error(`Falló la ingesta de '${fileName}': ${mensaje}`);
      // Nada a medias: fuera los fragmentos de la versión nueva escritos en
      // esta corrida. La versión anterior, si la había, sigue intacta.
      if (version !== null) {
        try {
          await borrarEnLotes(ctx, {
            documentId,
            version,
            desde: run.empezadoEn,
            modo: "deEstaCorrida",
          });
        } catch (limpieza) {
          console.error(`No se pudieron limpiar los fragmentos de '${fileName}': ${mensajeDe(limpieza)}`);
        }
      }
      try {
        await ctx.runMutation(internal.ingesta.escritura.marcarFallido, { documentId, error: mensaje });
      } catch (marca) {
        console.error(`No se pudo marcar '${fileName}' como failed: ${mensajeDe(marca)}`);
      }
      stats.ms = Date.now() - t0;
      stats.telemetria = tel.resumen();
      try {
        await ctx.runMutation(internal.ingesta.escritura.cerrarRun, {
          runId: run.runId,
          status: "failed",
          stats,
          error: mensaje,
        });
      } catch (cierre) {
        console.error(`No se pudo cerrar la corrida de '${fileName}': ${mensajeDe(cierre)}`);
      }
    }
  },
});
