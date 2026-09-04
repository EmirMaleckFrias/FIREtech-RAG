// Quién puede hacer qué. Port de `backend/app/services/auth.py` (la parte de
// permisos) y de los chequeos de propiedad de `supabase_db.py`.
//
// En Supabase la seguridad era "solo la clave de servicio del backend toca
// datos": se activó RLS sin políticas en las siete tablas y la migración 007
// revocó todo privilegio a `anon` y `authenticated`. Aquí el equivalente es
// que NINGUNA tabla se lee desde el navegador: solo a través de estas
// funciones, y todas empiezan comprobando quién pregunta.
//
// Dos cosas que se conservan tal cual porque estaban bien pensadas:
//
// - **"No existe" y "es de otro" dan el mismo error.** Una conversación ajena
//   responde "no encontrada", nunca "prohibida": decir "prohibida" confirma
//   que existe, y quien pregunta no tiene por qué saberlo.
// - **Ser administrador NO da acceso a las conversaciones de nadie.** El rol
//   sirve para gestionar documentos y cuentas; los contenidos son privados
//   incluso para un administrador. En el backend anterior `is_admin` se pasaba
//   a ocho sitios y deliberadamente no concedía nada; aquí simplemente no se
//   pasa.
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";

export class NoAutenticado extends Error {
  constructor() {
    super("Hay que iniciar sesión.");
    this.name = "NoAutenticado";
  }
}

export class AccesoRevocado extends Error {
  constructor() {
    super(
      "Un administrador revocó el acceso de esta cuenta. Habla con quien " +
        "administra el asistente.",
    );
    this.name = "AccesoRevocado";
  }
}

export class NoEncontrado extends Error {
  constructor(que = "recurso") {
    super(`No se encontró el ${que}.`);
    this.name = "NoEncontrado";
  }
}

export class SoloAdmin extends Error {
  constructor(accion = "esta acción") {
    super(`Solo un administrador puede ${accion}.`);
    this.name = "SoloAdmin";
  }
}

/** El usuario del token, o null si no hay sesión. */
export async function usuarioActualONulo(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const id = await getAuthUserId(ctx);
  if (!id) return null;
  return await ctx.db.get(id);
}

/** El usuario del token. Lanza si no hay sesión o si está bloqueado.
 *
 *  El bloqueo se comprueba en CADA llamada, no al iniciar sesión: revocar el
 *  acceso tiene que echar a quien ya está dentro, no esperar a que vuelva a
 *  entrar. */
export async function usuarioActual(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const u = await usuarioActualONulo(ctx);
  if (!u) throw new NoAutenticado();
  if (u.bloqueado) throw new AccesoRevocado();
  return u;
}

/** True si el rol es administrador. La única definición. */
export function esAdmin(u: Doc<"users"> | null): boolean {
  return u?.rol === "admin";
}

/** El usuario, exigiendo que sea administrador. */
export async function exigirAdmin(
  ctx: QueryCtx | MutationCtx,
  accion?: string,
): Promise<Doc<"users">> {
  const u = await usuarioActual(ctx);
  if (!esAdmin(u)) throw new SoloAdmin(accion);
  return u;
}

/** La conversación, comprobando que es de quien pregunta.
 *
 *  Devuelve `NoEncontrado` tanto si no existe como si es de otra persona: ver
 *  la nota de arriba sobre por qué no es un 403. */
export async function sesionPropia(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
  userId: Id<"users">,
): Promise<Doc<"sessions">> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.userId !== userId) throw new NoEncontrado("conversación");
  return s;
}

/** El id del usuario desde una acción (que no puede tocar la base directamente). */
export async function usuarioDeAccion(ctx: ActionCtx): Promise<Id<"users">> {
  const id = await getAuthUserId(ctx);
  if (!id) throw new NoAutenticado();
  return id;
}
