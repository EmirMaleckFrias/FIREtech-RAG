// Escrituras de la ingesta: las mutaciones y la consulta que usa la acción
// `ingestar`. Van aparte porque `pipeline.ts` es "use node" y un fichero así
// solo puede exportar acciones.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { tipoFragmento } from "../schema";

/** El documento a ingerir, o null si lo borraron. */
export const documento = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => ctx.db.get(documentId),
});

/** Abre la corrida. Devuelve también su instante de inicio, medido en el
 *  reloj de la base: es el que se compara con `_creationTime` al retirar
 *  fragmentos, así que no puede venir del reloj de la acción. */
export const abrirRun = internalMutation({
  args: {},
  handler: async (ctx) => {
    const empezadoEn = Date.now();
    const runId = await ctx.db.insert("ingestionRuns", { empezadoEn, status: "running" });
    return { runId, empezadoEn };
  },
});

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
  },
  handler: async (ctx, { documentId, version, chunks }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new Error("el documento fue borrado durante la ingesta");
    for (const chunk of chunks) {
      await ctx.db.insert("chunks", {
        ...chunk,
        sourceFile: doc.fileName,
        documentRef: documentId,
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
  },
  handler: async (ctx, { documentId, version, desde, modo, lote }) => {
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
  },
  handler: async (ctx, { documentId, ...campos }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new Error("el documento fue borrado durante la ingesta");
    await ctx.db.patch(documentId, {
      ...campos,
      status: "ready",
      error: undefined,
      ingestadoEn: Date.now(),
    });
  },
});

/** Documento fallido, con el motivo. Si ya no existe, no hay nada que marcar. */
export const marcarFallido = internalMutation({
  args: { documentId: v.id("documents"), error: v.string() },
  handler: async (ctx, { documentId, error }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return;
    await ctx.db.patch(documentId, { status: "failed", error, ingestadoEn: Date.now() });
  },
});
