// Cuentas: quién pregunta, qué puede hacer y cómo se le cuentan los errores.
// Port de `GET /me`, `GET /users`, `PATCH /users/{id}` y `DELETE /users/{id}`
// de `backend/app/api/routes.py`, y de `list_users`, `update_user` y
// `delete_user` de `backend/app/services/supabase_db.py`.
//
// Aquí viven también los ayudantes que usan TODAS las funciones de datos para
// identificar a quien llama (`usuario`, `administrador`, `sesionDe`). Están en
// este módulo y no en otro porque es el de las cuentas y porque así el grafo de
// imports no tiene ciclos: mensajes, sesiones, documentos, estadísticas y
// semilla importan de aquí, y este no importa de ninguno de ellos.
//
// Errores hacia el navegador. Las clases de permisos.ts son `Error` normales, y
// Convex en producción le enseña al cliente un "Server Error" sin mensaje por
// cualquier excepción que no sea `ConvexError`. Por eso en la frontera se
// convierten a `ConvexError` con `{codigo, mensaje}`: el código es lo que el
// frontend usa para decidir (cerrar la sesión ante `acceso_revocado`, avisar
// ante `conflicto`) y el mensaje es lo que muestra. Es el equivalente de los
// 401/403/404/409 con `detail` del backend anterior.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { rol } from "./schema";
import {
  AccesoRevocado,
  NoAutenticado,
  NoEncontrado,
  SoloAdmin,
  exigirAdmin,
  sesionPropia,
  usuarioActual,
  usuarioActualONulo,
} from "./permisos";

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------
export type CodigoError =
  | "no_autenticado"
  | "acceso_revocado"
  | "no_encontrado"
  | "solo_admin"
  | "conflicto"
  | "invalido";

// Alias y no `interface`: `ConvexError<T>` exige que T sea un `Value` de
// Convex, que lleva firma de índice, y una interfaz no la satisface.
export type DatosError = {
  codigo: CodigoError;
  mensaje: string;
};

/** Un error que el frontend puede leer: `e.data.codigo` y `e.data.mensaje`. */
export function errorDatos(
  codigo: CodigoError,
  mensaje: string,
): ConvexError<DatosError> {
  return new ConvexError<DatosError>({ codigo, mensaje });
}

/** Los errores de permisos.ts convertidos a `ConvexError`; cualquier otro
 *  se devuelve tal cual para relanzarlo. Uso: `throw convertido(e)`. */
export function convertido(e: unknown): unknown {
  if (e instanceof NoAutenticado) return errorDatos("no_autenticado", e.message);
  if (e instanceof AccesoRevocado) return errorDatos("acceso_revocado", e.message);
  if (e instanceof NoEncontrado) return errorDatos("no_encontrado", e.message);
  if (e instanceof SoloAdmin) return errorDatos("solo_admin", e.message);
  return e;
}

/** El usuario del token, o `no_autenticado` / `acceso_revocado`.
 *
 *  El bloqueo se comprueba en CADA llamada (lo hace `usuarioActual`): revocar
 *  el acceso echa a quien ya está dentro, no espera a que vuelva a entrar. */
export async function usuario(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  try {
    return await usuarioActual(ctx);
  } catch (e) {
    throw convertido(e);
  }
}

/** El usuario, exigiendo que sea administrador (`solo_admin` si no). */
export async function administrador(
  ctx: QueryCtx | MutationCtx,
  accion?: string,
): Promise<Doc<"users">> {
  try {
    return await exigirAdmin(ctx, accion);
  } catch (e) {
    throw convertido(e);
  }
}

/** La conversación, si es de quien pregunta. Ajena o inexistente:
 *  `no_encontrado` en los dos casos, para no confirmar que existe. */
export async function sesionDe(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
  userId: Id<"users">,
): Promise<Doc<"sessions">> {
  try {
    return await sesionPropia(ctx, sessionId, userId);
  } catch (e) {
    throw convertido(e);
  }
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------
/** La forma pública de una cuenta. Sin rol guardado se asume `lector`, el de
 *  menos privilegio: es lo que hacía `_DEFAULT_ROLE` en auth.py cuando el
 *  perfil aún no existía. */
function ficha(u: Doc<"users">) {
  return {
    _id: u._id,
    email: u.email ?? "",
    rol: u.rol ?? "lector",
    bloqueado: Boolean(u.bloqueado),
  };
}

/** Quién soy. `null` si no hay sesión iniciada: es una query reactiva que el
 *  frontend puede tener suscrita antes y después de entrar, y un `null` se
 *  pinta como "no has entrado" mientras que una excepción se pinta como fallo.
 *  Una cuenta bloqueada sí recibe `acceso_revocado`: es la señal con la que la
 *  interfaz cierra la sesión y explica el motivo, como hacía `BlockedAccount`
 *  en el backend anterior. */
export const yo = query({
  args: {},
  handler: async (ctx) => {
    const u = await usuarioActualONulo(ctx);
    if (u === null) return null;
    if (u.bloqueado) throw convertido(new AccesoRevocado());
    return ficha(u);
  },
});

/** Cuentas registradas con último acceso y contadores de uso. Solo admin.
 *
 *  Los contadores son SOLO números: esta función nunca devuelve texto de
 *  conversaciones, que son privadas de cada usuario incluso para un
 *  administrador.
 *
 *  Coste: `mensajes` se cuenta leyendo los mensajes del usuario por índice,
 *  porque Convex no tiene agregados y el esquema no lleva contadores. Cada
 *  respuesta del asistente arrastra `sources` y `hops` (decenas de KB), y una
 *  transacción puede leer 16 MiB, así que esto aguanta unos cientos de
 *  respuestas en total. El comentario original ya lo avisaba para Postgres
 *  ("si esto crece a miles, conviene una vista"); aquí el equivalente es una
 *  tabla de contadores, que es un cambio de esquema. */
export const listar = query({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "ver las cuentas");
    const cuentas = await ctx.db.query("users").collect();
    cuentas.sort(
      (a, b) => (a.creadoEn ?? a._creationTime) - (b.creadoEn ?? b._creationTime),
    );
    const salida = [];
    for (const u of cuentas) {
      const sesiones = await ctx.db
        .query("sessions")
        .withIndex("porUsuario", (q) => q.eq("userId", u._id))
        .collect();
      const mensajes = await ctx.db
        .query("messages")
        .withIndex("porUsuario", (q) => q.eq("userId", u._id))
        .collect();
      salida.push({
        ...ficha(u),
        creadoEn: u.creadoEn ?? u._creationTime,
        ultimoAccesoEn: u.ultimoAccesoEn ?? null,
        sesiones: sesiones.length,
        // Preguntas, no mensajes: cada turno tiene un mensaje del usuario y
        // otro del asistente y contar los dos duplicaría la cifra.
        mensajes: mensajes.filter((m) => m.role === "user").length,
      });
    }
    return salida;
  },
});

/** Promueve, degrada, bloquea o desbloquea OTRA cuenta. Solo admin.
 *
 *  Nadie puede cambiarse a sí mismo: evita que el último administrador se
 *  degrade o se bloquee y deje el sistema sin quien lo gestione.
 *
 *  Al bloquear no hace falta tocar las sesiones de Convex Auth: `usuario()`
 *  lee `bloqueado` en cada llamada, así que el token vigente deja de servir en
 *  el acto. En Supabase hacía falta además un baneo en Auth porque el backend
 *  no veía las sesiones; aquí sí. Y borrar las sesiones sería peor: el
 *  bloqueado recibiría `no_autenticado` en vez de `acceso_revocado` y la
 *  interfaz no podría decirle el motivo. */
export const actualizar = mutation({
  args: {
    userId: v.id("users"),
    rol: v.optional(rol),
    bloqueado: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const admin = await administrador(ctx, "gestionar las cuentas");
    if (args.userId === admin._id) {
      throw errorDatos("invalido", "No puedes cambiar tu propia cuenta.");
    }
    if (args.rol === undefined && args.bloqueado === undefined) {
      throw errorDatos("invalido", "Nada que cambiar: indica un rol o un estado de bloqueo.");
    }
    const u = await ctx.db.get(args.userId);
    if (!u) throw errorDatos("no_encontrado", "No se encontró el usuario.");

    const cambios: { rol?: Doc<"users">["rol"]; bloqueado?: boolean } = {};
    if (args.rol !== undefined) cambios.rol = args.rol;
    if (args.bloqueado !== undefined) cambios.bloqueado = args.bloqueado;
    await ctx.db.patch(u._id, cambios);

    const actualizado = await ctx.db.get(u._id);
    return ficha(actualizado ?? { ...u, ...cambios });
  },
});

/** Borra una cuenta y todo lo suyo. Solo admin; nunca a uno mismo.
 *
 *  En Postgres esto lo hacían las claves foráneas con `on delete cascade`:
 *  bastaba borrar `auth.users` y caían `profiles`, sus conversaciones, sus
 *  mensajes y su feedback. Convex no tiene claves foráneas, así que la
 *  cascada va A MANO y en este orden:
 *
 *  1. Conversaciones y feedback: filas pequeñas, se borran aquí mismo.
 *  2. Mensajes: NO se borran aquí. Cada respuesta del asistente pesa decenas
 *     de KB y una transacción puede leer 16 MiB, así que una cuenta con unas
 *     cientos de conversaciones no cabría en una sola mutación y el
 *     administrador no podría borrarla nunca. Se agenda
 *     `mensajes.borrarRestantes`, que va por lotes y se reagenda hasta acabar.
 *  3. Documentos que subió: se conservan y `subidoPor` queda vacío, como el
 *     `uploaded_by` que pasaba a nulo en Postgres.
 *  4. Las filas de Convex Auth (`authSessions` con sus `authRefreshTokens`,
 *     `authAccounts` con sus `authVerificationCodes`) y por último la cuenta.
 *     Sin esto quedarían cuentas de proveedor apuntando a un usuario que no
 *     existe, y un nuevo alta con el mismo correo chocaría con ellas. */
export const borrar = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await administrador(ctx, "borrar cuentas");
    if (args.userId === admin._id) {
      throw errorDatos("invalido", "No puedes borrar tu propia cuenta.");
    }
    const u = await ctx.db.get(args.userId);
    if (!u) throw errorDatos("no_encontrado", "No se encontró el usuario.");

    // 1. Conversaciones y feedback.
    const sesiones = await ctx.db
      .query("sessions")
      .withIndex("porUsuario", (q) => q.eq("userId", u._id))
      .collect();
    for (const s of sesiones) await ctx.db.delete(s._id);
    const votos = await ctx.db
      .query("feedback")
      .withIndex("porUsuarioYMensaje", (q) => q.eq("userId", u._id))
      .collect();
    for (const f of votos) await ctx.db.delete(f._id);

    // 2. Mensajes, por lotes y en segundo plano.
    const algunMensaje = await ctx.db
      .query("messages")
      .withIndex("porUsuario", (q) => q.eq("userId", u._id))
      .first();
    if (algunMensaje) {
      await ctx.scheduler.runAfter(0, internal.mensajes.borrarRestantes, {
        userId: u._id,
      });
    }

    // 3. Documentos que subió. Sin índice por `subidoPor`, pero la tabla es
    //    pequeña (decenas de filas).
    const documentos = await ctx.db.query("documents").collect();
    for (const d of documentos) {
      if (d.subidoPor === u._id) await ctx.db.patch(d._id, { subidoPor: undefined });
    }

    // 4. Convex Auth y la cuenta.
    const sesionesAuth = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", u._id))
      .collect();
    for (const s of sesionesAuth) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const t of tokens) await ctx.db.delete(t._id);
      await ctx.db.delete(s._id);
    }
    const cuentasAuth = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", u._id))
      .collect();
    for (const c of cuentasAuth) {
      const codigos = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", c._id))
        .collect();
      for (const k of codigos) await ctx.db.delete(k._id);
      await ctx.db.delete(c._id);
    }
    await ctx.db.delete(u._id);
    return { ok: true };
  },
});
