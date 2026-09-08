// Escrituras de la ingesta: las mutaciones y la consulta que usa la acción
// `ingestar`. Van aparte porque `pipeline.ts` es "use node" y un fichero así
// solo puede exportar acciones.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { avisosIngesta, tipoFragmento } from "../schema";

/** La corrida, para leer sus cifras parciales entre acciones. */
export const corrida = internalQuery({
  args: { runId: v.id("ingestionRuns") },
  handler: async (ctx, { runId }) => ctx.db.get(runId),
});

/** El documento a ingerir, o null si lo borraron. */
export const documento = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => ctx.db.get(documentId),
});

/** Abre la corrida. Devuelve también su instante de inicio, medido en el
 *  reloj de la base: es el que se compara con `_creationTime` al retirar
 *  fragmentos, así que no puede venir del reloj de la acción. */
export const abrirRun = internalMutation({
  args: { documentId: v.optional(v.id("documents")) },
  handler: async (ctx, { documentId }) => {
    const empezadoEn = Date.now();
    const runId = await ctx.db.insert("ingestionRuns", {
      empezadoEn,
      latidoEn: empezadoEn,
      documentId,
      status: "running",
    });
    return { runId, empezadoEn };
  },
});

/** El texto con el que se avisa de que OTRA corrida se quedó el documento.
 *  Lo distingue `pipeline.ingestar` para no limpiar ni marcar nada: lo que
 *  esta corrida dejó escrito lo retira la nueva, y el estado del documento es
 *  de la nueva. */
export const PERDIO_EL_DOCUMENTO = "otra ingesta más reciente reclamó el documento";

/** Una corrida `running` cuyo último latido es más viejo que esto está
 *  muerta: la acción de Node dura como mucho 10 minutos, así que ninguna
 *  corrida viva pasa tanto tiempo sin escribir. */
export const LATIDO_VIVO_MS = 11 * 60_000;

/**
 * La corrida reclama el documento: desde aquí es SU dueña, y cualquier otra
 * corrida que estuviera escribiendo se entera en su siguiente escritura y se
 * detiene. La más reciente gana siempre, sea un reindexado a mano, una
 * sincronización que trae otra versión o un segundo intento tras un cuelgue:
 * es la que leyó el fichero más nuevo.
 *
 * Devuelve `reclamadoEn` (reloj de la base): es el instante que separa los
 * fragmentos de esta corrida (`_creationTime` posterior) de todo lo anterior,
 * incluidos los que una corrida perdedora alcanzó a escribir antes de perder.
 * Es el `desde` con el que se retiran los antiguos al terminar.
 */
export const reclamarDocumento = internalMutation({
  args: { documentId: v.id("documents"), runId: v.id("ingestionRuns") },
  handler: async (ctx, { documentId, runId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new Error("el documento ya no existe en el registro");
    const reclamadoEn = Date.now();
    await ctx.db.patch(documentId, { ingestaRunId: runId });
    await ctx.db.patch(runId, { latidoEn: reclamadoEn, documentId });
    return { reclamadoEn, doc };
  },
});

/** ¿Sigue siendo esta corrida la dueña del documento? Lanza si no, con el
 *  texto que el pipeline reconoce. Un documento borrado lanza lo suyo.
 *
 *  La igualdad es ESTRICTA: un documento sin dueña también rechaza. La
 *  primera versión aceptaba `ingestaRunId` ausente, y como la corrida que
 *  terminaba soltaba el documento, la corrida perdedora que despertaba
 *  después lo encontraba libre y escribía sus fragmentos encima de los de la
 *  ganadora (lo cazó la prueba adversarial: 10 fragmentos en vez de 5). Por
 *  eso el documento CONSERVA la última corrida al terminar y `reindexar` mira
 *  si esa corrida está viva, no si hay dueña. */
async function exigirPropiedad(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  runId: Id<"ingestionRuns">,
): Promise<Doc<"documents">> {
  const doc = await ctx.db.get(documentId);
  if (!doc) throw new Error("el documento fue borrado durante la ingesta");
  if (doc.ingestaRunId !== runId) throw new Error(PERDIO_EL_DOCUMENTO);
  return doc;
}

export const cerrarRun = internalMutation({
  args: {
    runId: v.id("ingestionRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    stats: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { runId, status, stats, error }) => {
    await ctx.db.patch(runId, { terminadoEn: Date.now(), status, stats, error });
  },
});

const chunkEntrada = v.object({
  text: v.string(),
  // La frase de contexto (ingesta/contexto.ts); ausente si el modelo no la
  // pudo escribir. Va en su propio campo, no dentro de `text`, porque `text`
  // es lo que se cita y se verifica.
  contexto: v.optional(v.string()),
  embedding: v.array(v.float64()),
  page: v.number(),
  sourcePages: v.array(v.number()),
  section: v.optional(v.string()),
  chunkType: tipoFragmento,
  documentType: v.string(),
  language: v.optional(v.string()),
  titulo: v.optional(v.string()),
  citation: v.optional(v.string()),
  doi: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

/** Inserta un lote de fragmentos de la versión `version` del documento.
 *
 *  Si el documento ya no existe (lo borraron mientras se ingería) lanza, y
 *  la acción limpia lo que hubiera escrito: el registro nunca resucita. */
export const insertarChunks = internalMutation({
  args: {
    documentId: v.id("documents"),
    version: v.string(),
    chunks: v.array(chunkEntrada),
    // La corrida que escribe. Si el documento ya lo reclamó otra, se lanza y
    // no se escribe nada: es lo que impide que dos ingestas dupliquen los
    // fragmentos de la misma versión. Opcional solo por los llamadores
    // antiguos; el pipeline lo manda siempre.
    runId: v.optional(v.id("ingestionRuns")),
  },
  handler: async (ctx, { documentId, version, chunks, runId }) => {
    const doc = runId
      ? await exigirPropiedad(ctx, documentId, runId)
      : await ctx.db.get(documentId);
    if (!doc) throw new Error("el documento fue borrado durante la ingesta");
    // Latido: la corrida sigue viva mientras escribe.
    if (runId) await ctx.db.patch(runId, { latidoEn: Date.now() });
    for (const chunk of chunks) {
      await ctx.db.insert("chunks", {
        ...chunk,
        sourceFile: doc.fileName,
        documentRef: documentId,
        // Se COPIA del documento, no llega por argumento: así no hay forma de
        // que un llamador escriba fragmentos en el corpus de otra persona, ni
        // de que el fragmento y su documento discrepen de dueño.
        propietario: doc.propietario,
        documentId: String(documentId),
        documentVersion: version,
      });
    }
    return chunks.length;
  },
});

/** Borra hasta `lote` fragmentos del documento y devuelve cuántos borró.
 *
 *  `antiguos`: todo lo creado ANTES de `desde` (el inicio de la corrida):
 *  las otras versiones y los restos de esta misma versión de una corrida
 *  anterior que murió a medias, o la copia vieja de un reindexado del mismo
 *  fichero. Se llama DESPUÉS de escribir la versión nueva: es el swap seguro,
 *  la anterior sigue consultable si falla la ingesta y solo se retira al
 *  confirmar la nueva.
 *
 *  `deEstaCorrida`: los de esta versión creados desde `desde`, para no dejar
 *  fragmentos a medias cuando la ingesta falla.
 *
 *  Los dos modos acotan por `_creationTime` EN EL RANGO DEL ÍNDICE (todo
 *  índice de Convex termina implícitamente en `_creationTime`), no con un
 *  `filter`: un filtro sobre la versión leía los fragmentos de la versión
 *  nueva para descartarlos, y con 4000 fragmentos de 3072 números son ~100 MB
 *  leídos en una sola mutación, muy por encima del tope de 16 MiB por
 *  transacción ("data not returned due to a filter counts as scanned",
 *  docs.convex.dev/production/state/limits). Así solo se leen los que se van
 *  a borrar. Ojo: convex-test no contabiliza lo que descarta un filtro, así
 *  que ningún test en memoria detectaría volver al filtro. */
export const borrarChunks = internalMutation({
  args: {
    documentId: v.id("documents"),
    version: v.string(),
    desde: v.number(),
    modo: v.union(v.literal("antiguos"), v.literal("deEstaCorrida")),
    lote: v.number(),
    runId: v.optional(v.id("ingestionRuns")),
  },
  handler: async (ctx, { documentId, version, desde, modo, lote, runId }) => {
    // Solo la dueña retira fragmentos: una corrida que perdió el documento
    // podría borrar, en `deEstaCorrida`, lo que la nueva acaba de escribir
    // (misma versión, creados después de su `desde`).
    if (runId) {
      await exigirPropiedad(ctx, documentId, runId);
      await ctx.db.patch(runId, { latidoEn: Date.now() });
    }
    const candidatos =
      modo === "antiguos"
        ? await ctx.db
            .query("chunks")
            .withIndex("porDocumento", (q) =>
              q.eq("documentRef", documentId).lt("_creationTime", desde),
            )
            .take(lote)
        : await ctx.db
            .query("chunks")
            .withIndex("porDocumento", (q) =>
              q.eq("documentRef", documentId).gte("_creationTime", desde),
            )
            .filter((q) => q.eq(q.field("documentVersion"), version))
            .take(lote);
    for (const c of candidatos) await ctx.db.delete(c._id);
    return candidatos.length;
  },
});

/** Documento indexado: estado, recuento y metadatos de la obra. El sha256 se
 *  escribe con el hash real del fichero almacenado, que es la versión de sus
 *  fragmentos. */
export const marcarListo = internalMutation({
  args: {
    documentId: v.id("documents"),
    sha256: v.string(),
    pages: v.number(),
    chunks: v.number(),
    titulo: v.optional(v.string()),
    citation: v.optional(v.string()),
    doi: v.optional(v.string()),
    language: v.optional(v.string()),
    documentType: v.optional(v.string()),
    avisos: v.optional(avisosIngesta),
    runId: v.optional(v.id("ingestionRuns")),
    // Con qué receta se escribieron sus fragmentos (ver `VERSION_INDICE` en
    // ingesta/contexto.ts): es lo que mira `migraciones.reindexarTodo`.
    indiceVersion: v.optional(v.string()),
  },
  handler: async (ctx, { documentId, avisos, runId, ...campos }): Promise<boolean> => {
    const doc = runId ? await exigirPropiedad(ctx, documentId, runId) : await ctx.db.get(documentId);
    if (!doc) throw new Error("el documento fue borrado durante la ingesta");
    await ctx.db.patch(documentId, {
      ...campos,
      // Se escribe siempre (o se borra): un reindexado que ya no tiene nada
      // que avisar tiene que limpiar el aviso anterior.
      avisos,
      status: "ready",
      error: undefined,
      progreso: undefined,
      ingestadoEn: Date.now(),
      // `ingestaRunId` se CONSERVA: la corrida cerrada ya no bloquea a nadie
      // (ver documentos.ingestaViva), y soltar el documento abriría la puerta
      // a una corrida vieja que despertara después.
    });
    return true;
  },
});

/** Documento fallido, con el motivo. Si ya no existe, no hay nada que marcar;
 *  si lo reclamó otra corrida, tampoco: el estado es de la nueva. */
export const marcarFallido = internalMutation({
  args: { documentId: v.id("documents"), error: v.string(), runId: v.optional(v.id("ingestionRuns")) },
  handler: async (ctx, { documentId, error, runId }): Promise<boolean> => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return false;
    if (runId && doc.ingestaRunId !== runId) return false;
    await ctx.db.patch(documentId, { status: "failed", error, progreso: undefined, ingestadoEn: Date.now() });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Avance y cola de fragmentos pendientes
// ---------------------------------------------------------------------------
/** El avance de la ingesta, para la barra de la ficha. Solo lo escribe la
 *  dueña; una corrida que perdió el documento no pinta nada. También cuenta
 *  como latido. */
export const actualizarProgreso = internalMutation({
  args: {
    documentId: v.id("documents"),
    runId: v.id("ingestionRuns"),
    fase: v.union(v.literal("leyendo"), v.literal("embebiendo")),
    hecho: v.number(),
    total: v.number(),
    empezadoEn: v.number(),
  },
  handler: async (ctx, { documentId, runId, ...avance }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ingestaRunId !== runId) return false;
    const ahora = Date.now();
    await ctx.db.patch(documentId, { progreso: { ...avance, actualizadoEn: ahora } });
    await ctx.db.patch(runId, { latidoEn: ahora });
    return true;
  },
});

/** Guarda un lote de fragmentos parseados a la espera de embeberse. */
export const guardarPendientes = internalMutation({
  args: {
    documentId: v.id("documents"),
    runId: v.id("ingestionRuns"),
    desde: v.number(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, { documentId, runId, desde, chunks }) => {
    await exigirPropiedad(ctx, documentId, runId);
    await ctx.db.patch(runId, { latidoEn: Date.now() });
    for (const [i, chunk] of chunks.entries()) {
      await ctx.db.insert("fragmentosPendientes", { documentId, runId, indice: desde + i, chunk });
    }
    return chunks.length;
  },
});

/** Los siguientes `n` fragmentos pendientes de una corrida, desde `desde`. */
export const leerPendientes = internalQuery({
  args: { runId: v.id("ingestionRuns"), desde: v.number(), n: v.number() },
  handler: async (ctx, { runId, desde, n }) =>
    await ctx.db
      .query("fragmentosPendientes")
      .withIndex("porRun", (q) => q.eq("runId", runId).gte("indice", desde))
      .take(n),
});

/** Borra hasta `lote` fragmentos pendientes de una corrida (los ya embebidos,
 *  o todos al abandonar). Devuelve cuántos borró. */
export const borrarPendientes = internalMutation({
  args: { runId: v.id("ingestionRuns"), lote: v.number(), hasta: v.optional(v.number()) },
  handler: async (ctx, { runId, lote, hasta }) => {
    const filas = await ctx.db
      .query("fragmentosPendientes")
      .withIndex("porRun", (q) => (hasta === undefined ? q.eq("runId", runId) : q.eq("runId", runId).lt("indice", hasta)))
      .take(lote);
    for (const f of filas) await ctx.db.delete(f._id);
    return filas.length;
  },
});

/** Anota cifras parciales en la corrida sin cerrarla (las del parseo, que
 *  ocurre en otra acción que el embebido). */
export const anotarStats = internalMutation({
  args: { runId: v.id("ingestionRuns"), stats: v.any() },
  handler: async (ctx, { runId, stats }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    await ctx.db.patch(runId, { stats: { ...((run.stats as Record<string, unknown>) ?? {}), ...stats } });
  },
});

// ---------------------------------------------------------------------------
// Caché del OCR
// ---------------------------------------------------------------------------
/** Los textos ya reconocidos para esas claves. Devuelve pares y no un objeto
 *  con las claves como campos: una clave es un hash y Convex valida los
 *  nombres de campo de lo que devuelve una función. */
export const leerOcr = internalQuery({
  args: { claves: v.array(v.string()) },
  handler: async (ctx, { claves }) => {
    const pares: Array<{ clave: string; texto: string }> = [];
    for (const clave of claves) {
      const fila = await ctx.db
        .query("ocrCache")
        .withIndex("porClave", (q) => q.eq("clave", clave))
        .first();
      if (fila) pares.push({ clave, texto: fila.texto });
    }
    return pares;
  },
});

/** Guarda textos reconocidos. Idempotente: una clave que ya está no se
 *  duplica (dos ingestas del mismo escaneo pueden correr a la vez). */
export const guardarOcr = internalMutation({
  args: {
    entradas: v.array(v.object({ clave: v.string(), texto: v.string(), modelo: v.string() })),
  },
  handler: async (ctx, { entradas }) => {
    const ahora = Date.now();
    for (const e of entradas) {
      const previa = await ctx.db
        .query("ocrCache")
        .withIndex("porClave", (q) => q.eq("clave", e.clave))
        .first();
      if (previa) continue;
      await ctx.db.insert("ocrCache", { ...e, creadoEn: ahora });
    }
  },
});

