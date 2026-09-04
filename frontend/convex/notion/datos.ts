// Lecturas y escrituras que usa la acción `notion.sync.sincronizar`. Una
// acción no toca la base directamente, así que todo lo que la sincronización
// necesita leer o escribir pasa por aquí como función interna.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { LOTE_CHUNKS } from "../documentos";

/** Corridas que se conservan. Es un histórico para el bloque de estado del
 *  administrador, no un registro de auditoría: con 20 se ve un día entero de
 *  corridas horarias. */
export const CORRIDAS_CONSERVADAS = 20;

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------
/** Todas las páginas conocidas. La tabla tiene una fila por página de la base
 *  de Notion (cientos como mucho), así que se lee entera al empezar la corrida
 *  y se compara en memoria en vez de una consulta por página. */
export const paginasConocidas = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("notionPaginas").collect(),
});

export const documentosDe = internalQuery({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, { ids }) => {
    const salida = [];
    for (const id of ids) {
      const d = await ctx.db.get(id);
      if (d) salida.push(d);
    }
    return salida;
  },
});

/** El documento con ese sha256, si lo hay. Sin índice: el esquema de
 *  `documents` no se amplía con índices desde aquí y la tabla es pequeña (un
 *  documento por fichero, no por fragmento), así que recorrerla cuesta menos
 *  que una petición a Notion. `marcarListo` escribe el hash real del fichero
 *  al terminar la ingesta, y la subida manual lo calcula en el navegador, así
 *  que el campo compara bien contra el hash de un adjunto recién bajado. */
export const documentoPorSha256 = internalQuery({
  args: { sha256: v.string() },
  handler: async (ctx, { sha256 }) => {
    const todos = await ctx.db.query("documents").collect();
    return todos.find((d) => d.sha256 === sha256) ?? null;
  },
});

/** Ids de todos los documentos que trajo Notion, para saber en una sola
 *  lectura si a una página le falta alguno (un administrador lo borró a mano)
 *  y hay que volver a traerlo aunque Notion no haya cambiado. */
export const idsDocumentosNotion = internalQuery({
  args: {},
  handler: async (ctx) => {
    const todos = await ctx.db.query("documents").collect();
    return todos.filter((d) => d.origen === "notion").map((d) => d._id);
  },
});

export const ultimaCorrida = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("notionSincronizaciones").order("desc").first(),
});

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------
export const abrirCorrida = internalMutation({
  args: {},
  handler: async (ctx) => {
    const runId = await ctx.db.insert("notionSincronizaciones", {
      empezadoEn: Date.now(),
      paginas: 0,
      nuevos: 0,
      actualizados: 0,
      borrados: 0,
      errores: [],
      estado: "running",
    });
    // Poda al insertar: así la tabla nunca pasa de N+1 filas y no hace falta
    // otro cron para limpiarla.
    const todas = await ctx.db.query("notionSincronizaciones").order("desc").collect();
    for (const vieja of todas.slice(CORRIDAS_CONSERVADAS)) await ctx.db.delete(vieja._id);
    return runId;
  },
});

/** Avance de una corrida en curso, para que la UI suscrita lo pinte en vivo.
 *  Solo lo que venga se escribe: `paginasTotal` una vez al conocer la base,
 *  y por cada página la posición, el título y los contadores parciales. Si
 *  la corrida ya no está `running` (la cerró otro camino o la podó
 *  `abrirCorrida`), no se toca: un avance tardío no debe reabrirla. */
export const avanzarCorrida = internalMutation({
  args: {
    runId: v.id("notionSincronizaciones"),
    paginasTotal: v.optional(v.number()),
    paginasProcesadas: v.optional(v.number()),
    paginaActual: v.optional(v.string()),
    paginas: v.optional(v.number()),
    nuevos: v.optional(v.number()),
    actualizados: v.optional(v.number()),
    borrados: v.optional(v.number()),
    errores: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { runId, ...avance }) => {
    const fila = await ctx.db.get(runId);
    if (!fila || fila.estado !== "running") return;
    const cambios: Record<string, unknown> = {};
    for (const [k, valor] of Object.entries(avance)) if (valor !== undefined) cambios[k] = valor;
    if (Object.keys(cambios).length > 0) await ctx.db.patch(runId, cambios);
  },
});

export const cerrarCorrida = internalMutation({
  args: {
    runId: v.id("notionSincronizaciones"),
    paginas: v.number(),
    nuevos: v.number(),
    actualizados: v.number(),
    borrados: v.number(),
    errores: v.array(v.string()),
    estado: v.union(v.literal("ok"), v.literal("error")),
  },
  handler: async (ctx, { runId, ...resto }) => {
    // Puede haberla podado `abrirCorrida` de una corrida posterior si esta
    // duró más que 20 corridas seguidas; no es un error.
    if (!(await ctx.db.get(runId))) return;
    // `paginaActual` se retira: cerrada, ya no hay "ahora leyendo…". Con
    // `patch`, un campo en undefined desaparece del documento.
    await ctx.db.patch(runId, { ...resto, terminadoEn: Date.now(), paginaActual: undefined });
  },
});

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------
/** Crea o actualiza la fila de una página. */
export const guardarPagina = internalMutation({
  args: {
    pageId: v.string(),
    titulo: v.string(),
    lastEdited: v.string(),
    documentIds: v.array(v.id("documents")),
    documentoTextoId: v.optional(v.id("documents")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const previa = await ctx.db
      .query("notionPaginas")
      .withIndex("porPageId", (q) => q.eq("pageId", args.pageId))
      .unique();
    const campos = { ...args, sincronizadoEn: Date.now() };
    if (previa) {
      // `replace` y no `patch`: un `error` o `documentoTextoId` que ya no
      // viene tiene que desaparecer, y `patch` con undefined lo dejaría.
      await ctx.db.replace(previa._id, campos);
      return previa._id;
    }
    return await ctx.db.insert("notionPaginas", campos);
  },
});

/** Solo el error de una página, sin tocar lo demás. */
export const marcarPagina = internalMutation({
  args: { pageId: v.string(), error: v.string() },
  handler: async (ctx, { pageId, error }) => {
    const fila = await ctx.db
      .query("notionPaginas")
      .withIndex("porPageId", (q) => q.eq("pageId", pageId))
      .unique();
    if (fila) await ctx.db.patch(fila._id, { error });
  },
});

export const borrarPagina = internalMutation({
  args: { pageId: v.string() },
  handler: async (ctx, { pageId }) => {
    const fila = await ctx.db
      .query("notionPaginas")
      .withIndex("porPageId", (q) => q.eq("pageId", pageId))
      .unique();
    if (fila) await ctx.db.delete(fila._id);
  },
});

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------
/** Borra un documento que trajo Notion: el primer lote de fragmentos aquí,
 *  el resto en segundo plano con `documentos.borrarChunksRestantes` (mismo
 *  esquema que `documentos.borrar` y `pruebas.borrarDocumentoDePrueba`: una
 *  mutación no puede leer miles de fragmentos de 25 KB), y después el fichero
 *  y la fila. Devuelve false si el documento ya no existía.
 *
 *  Solo borra si el documento SIGUE siendo de esa página. La lista
 *  `documentIds` de la página es una foto del pasado: si entre medias un
 *  administrador borró el documento y subió a mano otro con el mismo nombre
 *  reutilizando la fila, o si `registrar` reutilizó una fila fallida, el id
 *  ya no es de Notion y borrarlo destruiría una subida manual. */
export const borrarDocumento = internalMutation({
  args: { documentId: v.id("documents"), pageId: v.string() },
  handler: async (ctx, { documentId, pageId }): Promise<boolean> => {
    const d = await ctx.db.get(documentId);
    if (!d) return false;
    if (d.origen !== "notion" || d.notionPageId !== pageId) return false;
    const lote = await ctx.db
      .query("chunks")
      .withIndex("porDocumento", (q) => q.eq("documentRef", documentId))
      .take(LOTE_CHUNKS);
    for (const c of lote) await ctx.db.delete(c._id);
    if (lote.length === LOTE_CHUNKS) {
      await ctx.scheduler.runAfter(0, internal.documentos.borrarChunksRestantes, { documentId });
    }
    if (d.storageId && (await ctx.db.system.get(d.storageId))) {
      await ctx.storage.delete(d.storageId);
    }
    await ctx.db.delete(d._id);
    return true;
  },
});
