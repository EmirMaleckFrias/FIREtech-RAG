// Lecturas y escrituras que usa la acción `nube.sync.sincronizar` y el OAuth
// de las nubes. Una acción no toca la base directamente, así que todo lo que
// la sincronización necesita leer o escribir pasa por aquí como función
// interna. Es el gemelo de notion/datos.ts con un `proveedor` más.
//
// **Todo lleva `propietario` y `proveedor`.** Cada persona conecta su propia
// cuenta y sincroniza a su propio corpus, y su Google Drive y su OneDrive son
// dos conexiones distintas con sus propios ficheros y corridas.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { LOTE_CHUNKS } from "../documentos";
import { proveedorNube } from "../schema";

export const CORRIDAS_CONSERVADAS = 20;

/** Filas de `nubeFicheros`/`nubeSincronizaciones` por transacción al borrar
 *  una cuenta. */
export const LOTE_FILAS = 500;

// ---------------------------------------------------------------------------
// Conexión y tokens
// ---------------------------------------------------------------------------
/** La conexión entera, con sus tokens. INTERNA: la leen la sincronización y
 *  la renovación del token, nunca una query pública. */
export const conexion = internalQuery({
  args: { propietario: v.id("users"), proveedor: proveedorNube },
  handler: async (ctx, { propietario, proveedor }) =>
    await ctx.db
      .query("nubeConexion")
      .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", propietario).eq("proveedor", proveedor))
      .first(),
});

/** Guarda el token renovado. Si el proveedor devolvió también un refresh
 *  token nuevo (Microsoft los rota), se sustituye; si no, se conserva. */
export const actualizarToken = internalMutation({
  args: {
    conexionId: v.id("nubeConexion"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiraEn: v.number(),
  },
  handler: async (ctx, { conexionId, refreshToken, ...resto }) => {
    const c = await ctx.db.get(conexionId);
    if (!c) return;
    await ctx.db.patch(conexionId, {
      ...resto,
      ...(refreshToken ? { refreshToken } : {}),
      necesitaReconexion: undefined,
    });
  },
});

/** El proveedor rechazó la renovación: la conexión queda marcada para que
 *  la UI ofrezca volver a conectar, y la periódica deja de intentarlo. */
export const marcarReconexion = internalMutation({
  args: { conexionId: v.id("nubeConexion") },
  handler: async (ctx, { conexionId }) => {
    if (await ctx.db.get(conexionId)) await ctx.db.patch(conexionId, { necesitaReconexion: true });
  },
});

// ---------------------------------------------------------------------------
// Lecturas para la sincronización
// ---------------------------------------------------------------------------
/** Los ficheros conocidos DE UNA CARPETA ELEGIDA. Por carpeta, como las
 *  páginas de Notion por base: el cálculo de "qué ha desaparecido" es por
 *  carpeta, y juntarlas borraría el corpus de una al terminar otra. */
export const ficherosDeCarpeta = internalQuery({
  args: { propietario: v.id("users"), proveedor: proveedorNube, carpetaId: v.string() },
  handler: async (ctx, { propietario, proveedor, carpetaId }) =>
    await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYCarpeta", (q) =>
        q.eq("propietario", propietario).eq("proveedor", proveedor).eq("carpetaId", carpetaId),
      )
      .collect(),
});

/** La fila de un fichero, esté bajo la carpeta que esté: un fichero que se
 *  movió de una carpeta elegida a otra sigue siendo el mismo documento. */
export const fichero = internalQuery({
  args: { propietario: v.id("users"), proveedor: proveedorNube, ficheroId: v.string() },
  handler: async (ctx, { propietario, proveedor, ficheroId }) =>
    await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) =>
        q.eq("propietario", propietario).eq("proveedor", proveedor).eq("ficheroId", ficheroId),
      )
      .unique(),
});

export const documento = internalQuery({
  args: { propietario: v.id("users"), id: v.id("documents") },
  handler: async (ctx, { propietario, id }) => {
    const d = await ctx.db.get(id);
    // Un id ajeno no debería llegar aquí, pero se comprueba igual: sería el
    // único hueco por el que un documento de otra persona entraría en esta
    // sincronización.
    return d && d.propietario === propietario ? d : null;
  },
});

/** El documento de esa persona con ese sha256, si lo hay. Por índice: se
 *  llama una vez por fichero descargado. */
export const documentoPorSha256 = internalQuery({
  args: { propietario: v.id("users"), sha256: v.string() },
  handler: async (ctx, { propietario, sha256 }) =>
    await ctx.db
      .query("documents")
      .withIndex("porPropietarioYSha256", (q) => q.eq("propietario", propietario).eq("sha256", sha256))
      .first(),
});

/** Ids de los documentos que trajo esta nube, para saber en una lectura si a
 *  un fichero le falta el suyo (su dueña lo borró a mano) y volver a traerlo. */
export const idsDocumentosDe = internalQuery({
  args: { propietario: v.id("users"), proveedor: proveedorNube },
  handler: async (ctx, { propietario, proveedor }) => {
    const suyos = await ctx.db
      .query("documents")
      .withIndex("porPropietario", (q) => q.eq("propietario", propietario))
      .collect();
    return suyos.filter((d) => d.origen === proveedor).map((d) => d._id);
  },
});

export const ultimaCorrida = internalQuery({
  args: { propietario: v.id("users"), proveedor: proveedorNube },
  handler: async (ctx, { propietario, proveedor }) =>
    await ctx.db
      .query("nubeSincronizaciones")
      .withIndex("porPropietarioYProveedor", (q) => q.eq("propietario", propietario).eq("proveedor", proveedor))
      .order("desc")
      .first(),
});

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------
export const abrirCorrida = internalMutation({
  args: { propietario: v.id("users"), proveedor: proveedorNube },
  handler: async (ctx, { propietario, proveedor }) => {
    const runId = await ctx.db.insert("nubeSincronizaciones", {
      propietario,
      proveedor,
      empezadoEn: Date.now(),
      ficheros: 0,
      nuevos: 0,
      actualizados: 0,
      borrados: 0,
      errores: [],
      estado: "running",
    });
    // Poda al insertar, por persona y proveedor: la tabla nunca pasa de N+1
    // filas por conexión y no hace falta otro cron.
    const suyas = await ctx.db
      .query("nubeSincronizaciones")
      .withIndex("porPropietarioYProveedor", (q) => q.eq("propietario", propietario).eq("proveedor", proveedor))
      .order("desc")
      .collect();
    for (const vieja of suyas.slice(CORRIDAS_CONSERVADAS)) await ctx.db.delete(vieja._id);
    return runId;
  },
});

/** Avance de una corrida en curso, para la UI suscrita. Si ya no está
 *  `running`, no se toca: un avance tardío no debe reabrirla. */
export const avanzarCorrida = internalMutation({
  args: {
    runId: v.id("nubeSincronizaciones"),
    ficherosTotal: v.optional(v.number()),
    ficherosProcesados: v.optional(v.number()),
    ficheroActual: v.optional(v.string()),
    ficheros: v.optional(v.number()),
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
    runId: v.id("nubeSincronizaciones"),
    ficheros: v.number(),
    nuevos: v.number(),
    actualizados: v.number(),
    borrados: v.number(),
    errores: v.array(v.string()),
    estado: v.union(v.literal("ok"), v.literal("error")),
  },
  handler: async (ctx, { runId, ...resto }) => {
    if (!(await ctx.db.get(runId))) return;
    await ctx.db.patch(runId, { ...resto, terminadoEn: Date.now(), ficheroActual: undefined });
  },
});

// ---------------------------------------------------------------------------
// Ficheros
// ---------------------------------------------------------------------------
/** Crea o actualiza la fila de un fichero. `replace` y no `patch`: un `error`
 *  o un `documentId` que ya no viene tiene que desaparecer. */
export const guardarFichero = internalMutation({
  args: {
    propietario: v.id("users"),
    proveedor: proveedorNube,
    carpetaId: v.string(),
    ficheroId: v.string(),
    nombre: v.string(),
    version: v.string(),
    documentId: v.optional(v.id("documents")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const previa = await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) =>
        q.eq("propietario", args.propietario).eq("proveedor", args.proveedor).eq("ficheroId", args.ficheroId),
      )
      .unique();
    const campos = { ...args, sincronizadoEn: Date.now() };
    if (previa) {
      await ctx.db.replace(previa._id, campos);
      return previa._id;
    }
    return await ctx.db.insert("nubeFicheros", campos);
  },
});

/** Solo el error de un fichero, sin tocar lo demás. */
export const marcarFichero = internalMutation({
  args: { propietario: v.id("users"), proveedor: proveedorNube, ficheroId: v.string(), error: v.string() },
  handler: async (ctx, { propietario, proveedor, ficheroId, error }) => {
    const fila = await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) =>
        q.eq("propietario", propietario).eq("proveedor", proveedor).eq("ficheroId", ficheroId),
      )
      .unique();
    if (fila) await ctx.db.patch(fila._id, { error });
  },
});

export const borrarFichero = internalMutation({
  args: { propietario: v.id("users"), proveedor: proveedorNube, ficheroId: v.string() },
  handler: async (ctx, { propietario, proveedor, ficheroId }) => {
    const fila = await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) =>
        q.eq("propietario", propietario).eq("proveedor", proveedor).eq("ficheroId", ficheroId),
      )
      .unique();
    if (fila) await ctx.db.delete(fila._id);
  },
});

/** Borra un documento que trajo esta nube: el primer lote de fragmentos aquí,
 *  el resto en segundo plano, y después el fichero y la fila. Devuelve false
 *  si ya no existía.
 *
 *  Solo si el documento SIGUE siendo de este fichero: si entre medias su
 *  dueña lo borró y subió a mano otro con el mismo nombre reutilizando la
 *  fila, el id ya no es nuestro y borrarlo destruiría una subida manual. */
export const borrarDocumento = internalMutation({
  args: {
    propietario: v.id("users"),
    proveedor: proveedorNube,
    documentId: v.id("documents"),
    ficheroId: v.string(),
  },
  handler: async (ctx, { propietario, proveedor, documentId, ficheroId }): Promise<boolean> => {
    const d = await ctx.db.get(documentId);
    if (!d) return false;
    if (d.propietario !== propietario) return false;
    if (d.origen !== proveedor || d.nubeFicheroId !== ficheroId) return false;
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

/** Borra TODAS las filas de `nubeFicheros` y `nubeSincronizaciones` de una
 *  cuenta, por lotes y reagendándose. La llama `usuarios.borrar`. */
export const borrarRastroDeUsuario = internalMutation({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }): Promise<void> => {
    const ficheros = await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) => q.eq("propietario", propietario))
      .take(LOTE_FILAS);
    for (const f of ficheros) await ctx.db.delete(f._id);
    if (ficheros.length === LOTE_FILAS) {
      await ctx.scheduler.runAfter(0, internal.nube.datos.borrarRastroDeUsuario, { propietario });
      return;
    }
    const corridas = await ctx.db
      .query("nubeSincronizaciones")
      .withIndex("porPropietarioYProveedor", (q) => q.eq("propietario", propietario))
      .take(LOTE_FILAS);
    for (const c of corridas) await ctx.db.delete(c._id);
    if (corridas.length === LOTE_FILAS) {
      await ctx.scheduler.runAfter(0, internal.nube.datos.borrarRastroDeUsuario, { propietario });
    }
  },
});
