// Gestión de documentos: listar, subir, reindexar y borrar. Port de
// `backend/app/api/documents.py` (la parte de rutas; la ingesta en sí es
// `convex/ingesta/pipeline.ts`).
//
// Los documentos son compartidos: cualquier usuario autenticado los ve y los
// consulta. Subirlos, reindexarlos y borrarlos es exclusivo del administrador.
//
// Qué cambia respecto al backend anterior:
//
// - **La subida no pasa por la función.** El navegador pide una URL de subida
//   firmada (`urlDeSubida`), sube el fichero directamente al almacenamiento de
//   Convex y luego registra el `storageId` (`registrar`). En Vercel el cuerpo
//   de la petición tenía un tope de 4,5 MB y por eso el límite efectivo era de
//   4 MB; aquí el límite lo pone `UPLOAD_LIMIT_MB` y es bastante más alto.
// - **El fichero original queda guardado** (`documents.storageId`). Es lo que
//   arregla el reindexado: en Vercel el disco era efímero y el reintento
//   respondía 409 `file_not_stored` pidiendo resubir. Ese caso desaparece.
// - **Los fragmentos viven en la tabla `chunks`**, no en Qdrant, así que
//   borrar un documento es borrar filas por el índice `porDocumento`, con un
//   detalle que en Qdrant no existía: el tamaño de la transacción (ver
//   `LOTE_CHUNKS`).
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ajustes } from "./lib/config";
import { administrador, errorDatos, usuario } from "./usuarios";

export const EXTENSIONES_PERMITIDAS = ["pdf", "docx", "xlsx", "csv", "txt", "md"] as const;

// Minutos tras los que un documento en `processing` se considera abandonado y
// se puede reintentar. Existe porque había una forma de quedarse en
// `processing` PARA SIEMPRE: si la función de Vercel moría por el corte de
// 300 s a mitad de ingesta no había excepción de Python, así que nadie marcaba
// `failed`. Y entonces los dos caminos de recuperación se bloqueaban entre sí:
// subir respondía 409 porque el nombre existía, y reindexar respondía 409
// porque estaba "procesando". La única salida era borrar y resubir. Una
// acción de Convex puede morir igual (600 s, o un despliegue a mitad), así que
// la regla sigue haciendo falta; nada legítimo sigue vivo pasados 10 minutos.
export const MINUTOS_PROCESSING_RANCIO = 10;

// Fragmentos que borra una mutación de una vez. Un fragmento lleva su
// embedding de 3072 float64, que son 24 KB por sí solos, más el texto (hasta
// unos pocos KB en una tabla): unos 30 KB en el peor caso. Una transacción de
// Convex puede leer 16 MiB, y borrar por índice exige leer cada documento que
// se borra, así que un documento de 1000 páginas con miles de fragmentos no
// cabe en una sola mutación: fallaría entera y el documento no se podría
// borrar nunca. 300 fragmentos son unos 9 MB en el peor caso y dejan margen;
// el resto se borra en lotes sucesivos agendados.
export const LOTE_CHUNKS = 300;

// ---------------------------------------------------------------------------
// Ayudantes puros (exportados para probarlos sin base)
// ---------------------------------------------------------------------------
/** Nombre de archivo saneado: sin rutas, solo [A-Za-z0-9._-], sin puntos al
 *  principio. El cliente puede mandar rutas con `\` o `/`, y un nombre que
 *  empieza por punto sería un fichero oculto o una extensión sin nombre. */
export function sanearNombre(crudo: string): string {
  const partes = crudo.replace(/\\/g, "/").split("/");
  const base = partes[partes.length - 1] ?? "";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
}

/** Extensión en minúsculas, sin el punto; "" si no hay. */
export function extensionDe(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i <= 0 ? "" : nombre.slice(i + 1).toLowerCase();
}

/** ¿Este `processing` lleva tanto tiempo que ya no puede estar vivo?
 *
 *  Sin fecha utilizable se responde `true`: un registro en `processing` sin
 *  marca de tiempo es indistinguible de uno abandonado, y bloquear el
 *  reintento para siempre es peor que permitir uno de más (que como mucho
 *  reingiere algo que ya estaba bien). */
export function processingRancio(
  doc: { ingestadoEn: number },
  ahora: number = Date.now(),
): boolean {
  if (!Number.isFinite(doc.ingestadoEn)) return true;
  return ahora - doc.ingestadoEn > MINUTOS_PROCESSING_RANCIO * 60_000;
}

// ---------------------------------------------------------------------------
// Consultas y mutaciones
// ---------------------------------------------------------------------------
/** El registro entero, del más antiguo al más nuevo. Cualquier usuario
 *  autenticado: los documentos son compartidos. */
export const listar = query({
  args: {},
  handler: async (ctx) => {
    await usuario(ctx);
    const docs = await ctx.db.query("documents").collect();
    docs.sort((a, b) => a.ingestadoEn - b.ingestadoEn);
    return docs.map((d) => ({
      _id: d._id,
      fileName: d.fileName,
      pages: d.pages,
      chunks: d.chunks,
      status: d.status,
      error: d.error ?? null,
      ingestadoEn: d.ingestadoEn,
      titulo: d.titulo ?? null,
      citation: d.citation ?? null,
    }));
  },
});

/** URL firmada para subir un fichero directamente al almacenamiento. */
export const urlDeSubida = mutation({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "subir documentos");
    return await ctx.storage.generateUploadUrl();
  },
});

/** Registra un fichero ya subido y arranca su ingesta.
 *
 *  Se registra ANTES de agendar la ingesta, en `processing`: así el listado lo
 *  refleja al instante y el frontend solo tiene que estar suscrito.
 *
 *  Duplicados: un nombre ya registrado responde `conflicto`, salvo que el que
 *  existe esté en `failed`. En ese caso se REUTILIZA su fila (mismo `_id`) en
 *  vez de crear otra: los fragmentos apuntan al documento por `documentRef`,
 *  y una fila nueva dejaría huérfanos los que hubiera dejado el intento
 *  fallido. La ingesta es la que limpia los fragmentos viejos del documento
 *  antes de escribir los nuevos.
 *
 *  Si la validación falla, el fichero subido se queda huérfano en el
 *  almacenamiento: no se puede borrar Y fallar en la misma mutación, porque
 *  un fallo revierte la transacción entera, incluido el borrado. */
export const registrar = mutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await administrador(ctx, "subir documentos");

    const nombre = sanearNombre(args.fileName);
    if (!nombre) throw errorDatos("invalido", "Nombre de archivo inválido.");
    const ext = extensionDe(nombre);
    if (!(EXTENSIONES_PERMITIDAS as readonly string[]).includes(ext)) {
      throw errorDatos(
        "invalido",
        `Extensión '${ext || "(ninguna)"}' no permitida. Permitidas: ` +
          `${[...EXTENSIONES_PERMITIDAS].sort().join(", ")}.`,
      );
    }
    const sha256 = args.sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw errorDatos("invalido", "El sha256 debe ser hexadecimal de 64 caracteres.");
    }

    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) {
      throw errorDatos("invalido", "El archivo no está en el almacenamiento: vuelve a subirlo.");
    }
    if (meta.size === 0) throw errorDatos("invalido", "El archivo está vacío.");
    const limiteMb = ajustes().limiteSubidaMb;
    if (meta.size > limiteMb * 1024 * 1024) {
      throw errorDatos(
        "invalido",
        `Archivo demasiado grande (${meta.size} bytes; máx. ${limiteMb} MB en este despliegue).`,
      );
    }

    const existentes = await ctx.db
      .query("documents")
      .withIndex("porNombre", (q) => q.eq("fileName", nombre))
      .collect();
    const vivo = existentes.find((d) => d.status !== "failed");
    if (vivo) {
      throw errorDatos("conflicto", `'${nombre}' ya está indexado. Bórralo primero.`);
    }

    const ahora = Date.now();
    const fallido = existentes[0];
    let documentId: Id<"documents">;
    if (fallido) {
      if (fallido.storageId && fallido.storageId !== args.storageId) {
        await borrarFichero(ctx, fallido.storageId);
      }
      await ctx.db.patch(fallido._id, {
        sha256,
        pages: 0,
        chunks: 0,
        status: "processing",
        error: undefined,
        subidoPor: admin._id,
        ingestadoEn: ahora,
        storageId: args.storageId,
      });
      documentId = fallido._id;
    } else {
      documentId = await ctx.db.insert("documents", {
        fileName: nombre,
        sha256,
        pages: 0,
        chunks: 0,
        status: "processing",
        subidoPor: admin._id,
        ingestadoEn: ahora,
        storageId: args.storageId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.ingestar, { documentId });
    return documentId;
  },
});

/** Reintenta la ingesta a partir del fichero guardado.
 *
 *  Existe porque una ingesta falla casi siempre por algo transitorio (un
 *  timeout del gateway, un corte) y sin esto la única salida era borrar y
 *  volver a buscar el archivo a mano; `registrar` responde `conflicto` si el
 *  nombre ya existe, así que reintentar por ahí no es posible.
 *
 *  Se rechaza con `conflicto` solo si de verdad SIGUE procesándose: reingerir
 *  en paralelo duplicaría fragmentos y pelearía por el registro. Ver
 *  `MINUTOS_PROCESSING_RANCIO` para el caso abandonado. */
export const reindexar = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    await administrador(ctx, "reindexar documentos");
    const d = await ctx.db.get(documentId);
    if (!d) throw errorDatos("no_encontrado", "El documento no está registrado.");
    if (d.status === "processing" && !processingRancio(d)) {
      throw errorDatos("conflicto", `'${d.fileName}' ya se está procesando.`);
    }
    // El esquema deja `storageId` opcional (filas traídas de Supabase, donde
    // el fichero no se guardaba). Sin fichero no hay qué reindexar.
    if (!d.storageId || !(await ctx.db.system.get(d.storageId))) {
      throw errorDatos(
        "conflicto",
        `El archivo de '${d.fileName}' no está guardado: bórralo y vuelve a subirlo.`,
      );
    }

    // A `processing` ANTES de agendar, igual que al registrar: el listado
    // refleja el reintento al instante.
    //
    // Se renueva `ingestadoEn`, y no es cosmético: es el campo con el que
    // `processingRancio` mide la antigüedad. Sin renovarlo, el reintento
    // heredaba la fecha vieja, se consideraba abandonado de inmediato y un
    // segundo reindex concurrente pasaba la guarda: dos ingestas a la vez
    // duplicando fragmentos. La guarda se saltaba a sí misma.
    await ctx.db.patch(d._id, {
      status: "processing",
      error: undefined,
      ingestadoEn: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.ingestar, { documentId: d._id });
    return { fileName: d.fileName, status: "processing" as const };
  },
});

/** Borra un documento: sus fragmentos (por lotes), su fichero y su fila.
 *
 *  La fila y el fichero se borran ya; los fragmentos que no quepan en el
 *  primer lote se borran en segundo plano, así que durante unos instantes una
 *  búsqueda puede seguir devolviéndolos. Es el precio de que el borrado no
 *  falle entero por el tamaño (ver `LOTE_CHUNKS`). */
export const borrar = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }): Promise<{ ok: true }> => {
    await administrador(ctx, "borrar documentos");
    const d = await ctx.db.get(documentId);
    if (!d) throw errorDatos("no_encontrado", "El documento no está registrado.");

    const quedan = await borrarLoteDeChunks(ctx, documentId);
    if (quedan) {
      await ctx.scheduler.runAfter(0, internal.documentos.borrarChunksRestantes, { documentId });
    }
    if (d.storageId) await borrarFichero(ctx, d.storageId);
    await ctx.db.delete(d._id);
    return { ok: true };
  },
});

/** Sigue borrando fragmentos de un documento ya borrado, un lote por
 *  transacción, y se reagenda mientras queden. El documento en sí ya no
 *  existe cuando esto corre: solo se necesita su id, que es lo que llevan los
 *  fragmentos en `documentRef`. */
export const borrarChunksRestantes = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }): Promise<void> => {
    const quedan = await borrarLoteDeChunks(ctx, documentId);
    if (quedan) {
      await ctx.scheduler.runAfter(0, internal.documentos.borrarChunksRestantes, { documentId });
    }
  },
});

// ---------------------------------------------------------------------------
// Ayudantes con base
// ---------------------------------------------------------------------------
/** Borra hasta `LOTE_CHUNKS` fragmentos del documento. Devuelve `true` si el
 *  lote salió lleno, o sea, si puede quedar más. */
async function borrarLoteDeChunks(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<boolean> {
  const lote = await ctx.db
    .query("chunks")
    .withIndex("porDocumento", (q) => q.eq("documentRef", documentId))
    .take(LOTE_CHUNKS);
  for (const c of lote) await ctx.db.delete(c._id);
  return lote.length === LOTE_CHUNKS;
}

/** Borra un fichero del almacenamiento si sigue ahí. `storage.delete` lanza
 *  si el id no existe, y un fichero que ya no está no debe impedir borrar el
 *  documento. */
async function borrarFichero(ctx: MutationCtx, storageId: Id<"_storage">) {
  const meta = await ctx.db.system.get(storageId);
  if (meta) await ctx.storage.delete(storageId);
}

export type FilaDocumento = Doc<"documents">;
