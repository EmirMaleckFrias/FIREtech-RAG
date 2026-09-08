// Contadores agregados: cuántas preguntas se han hecho (en total, por día y
// por cuenta), cuántas conversaciones tiene cada cuenta y cuántos votos hay de
// cada signo. Es lo que leen Ajustes > Sistema y Ajustes > Usuarios.
//
// Por qué existen: Convex no tiene agregados. Antes `estadisticas.sistema`
// contaba preguntas recorriendo `messages` entera y `usuarios.listar` leía
// todos los mensajes de cada cuenta, y cada respuesta del asistente arrastra
// sus fuentes y sus hops (decenas de KB). Aguantaba unos cientos de respuestas
// dentro de los 16 MiB que una transacción puede leer; pasado eso, las dos
// pantallas fallaban sin que nada más se rompiera. Aquí cada cifra es una fila
// pequeña que se lee por índice.
//
// Reglas:
// - Se actualizan EN LA MISMA TRANSACCIÓN que escribe o borra lo que cuentan
//   (`mensajes.enviar`, `mensajes.calificar`, los borrados de mensajes,
//   `sesiones.crear/borrar`, `usuarios.borrar`). Así nunca hay una ventana en
//   la que la cifra y la tabla discrepen.
// - Un contador nunca baja de cero: si un decremento lo dejaría negativo es
//   que algo se contó de menos, y se deja en cero antes que enseñar un número
//   absurdo.
// - Los de una cuenta borrada se eliminan; un decremento posterior (los
//   mensajes se borran por lotes en segundo plano) NO los recrea.
// - `reconstruir` los recalcula desde las tablas, por lotes acotados y
//   reagendándose: para estrenar la tabla en un despliegue con datos y para
//   volver a la verdad si alguna vez hace falta.
import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Claves
// ---------------------------------------------------------------------------
export const CLAVE_PREGUNTAS = "preguntas";
export const CLAVE_VOTOS_ARRIBA = "votos:arriba";
export const CLAVE_VOTOS_ABAJO = "votos:abajo";

/** Día UTC de un instante, "AAAA-MM-DD". Por día natural y no por ventana
 *  exacta: los contadores no pueden saber cuándo se les preguntará. */
export function diaDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function clavePreguntasDelDia(ms: number): string {
  return `preguntas:dia:${diaDe(ms)}`;
}

export function clavePreguntasDe(userId: Id<"users">): string {
  return `usuario:${userId}:preguntas`;
}

export function claveSesionesDe(userId: Id<"users">): string {
  return `usuario:${userId}:sesiones`;
}

export function claveVotos(rating: 1 | -1): string {
  return rating === 1 ? CLAVE_VOTOS_ARRIBA : CLAVE_VOTOS_ABAJO;
}

/** Las claves de los días que tocan la ventana [ahora - dias, ahora]: el día
 *  de `ahora` y los `dias` anteriores. "Últimos 7 días" pasa a ser "los
 *  últimos 7 días naturales más el de hoy", que para una cifra de actividad
 *  es la misma información. */
export function clavesDeLaVentana(ahora: number, dias = 7): string[] {
  const claves: string[] = [];
  for (let d = 0; d <= dias; d++) claves.push(clavePreguntasDelDia(ahora - d * 86_400_000));
  return claves;
}

// ---------------------------------------------------------------------------
// Lectura y escritura
// ---------------------------------------------------------------------------
export async function leer(ctx: QueryCtx | MutationCtx, clave: string): Promise<number> {
  const fila = await ctx.db
    .query("contadores")
    .withIndex("porClave", (q) => q.eq("clave", clave))
    .unique();
  return fila?.valor ?? 0;
}

export async function leerVarias(ctx: QueryCtx | MutationCtx, claves: string[]): Promise<number> {
  let total = 0;
  for (const c of claves) total += await leer(ctx, c);
  return total;
}

/** Suma `delta` (positivo o negativo) al contador. Sin bajar de cero. Con
 *  `soloSiExiste`, un contador que no está no se crea: es lo que evita que el
 *  borrado en segundo plano de los mensajes de una cuenta ya eliminada
 *  resucite sus contadores (en negativo, además). */
export async function sumar(
  ctx: MutationCtx,
  clave: string,
  delta: number,
  opciones: { soloSiExiste?: boolean } = {},
): Promise<void> {
  if (delta === 0) return;
  const fila = await ctx.db
    .query("contadores")
    .withIndex("porClave", (q) => q.eq("clave", clave))
    .unique();
  if (!fila) {
    if (opciones.soloSiExiste || delta < 0) return;
    await ctx.db.insert("contadores", { clave, valor: delta });
    return;
  }
  const valor = Math.max(0, fila.valor + delta);
  if (valor !== fila.valor) await ctx.db.patch(fila._id, { valor });
}

/** Una pregunta nueva de esa cuenta en ese instante (y, si abrió una
 *  conversación, esa también). Lo llaman `mensajes.enviar` y el arnés de
 *  pruebas, que inserta los mensajes por su cuenta. */
export async function anotarPregunta(
  ctx: MutationCtx,
  userId: Id<"users">,
  creadoEn: number,
  opciones: { sesionNueva?: boolean } = {},
): Promise<void> {
  await sumar(ctx, CLAVE_PREGUNTAS, 1);
  await sumar(ctx, clavePreguntasDelDia(creadoEn), 1);
  await sumar(ctx, clavePreguntasDe(userId), 1);
  if (opciones.sesionNueva) await sumar(ctx, claveSesionesDe(userId), 1);
}

/** Se borró una pregunta (un mensaje `user`). Los de la cuenta solo si la
 *  cuenta sigue teniéndolos: ver `sumar`. */
export async function desanotarPregunta(
  ctx: MutationCtx,
  userId: Id<"users">,
  creadoEn: number,
): Promise<void> {
  await sumar(ctx, CLAVE_PREGUNTAS, -1);
  await sumar(ctx, clavePreguntasDelDia(creadoEn), -1);
  await sumar(ctx, clavePreguntasDe(userId), -1, { soloSiExiste: true });
}

/** Retira los contadores de una cuenta que se borra. */
export async function borrarDeUsuario(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  for (const clave of [clavePreguntasDe(userId), claveSesionesDe(userId)]) {
    const fila = await ctx.db
      .query("contadores")
      .withIndex("porClave", (q) => q.eq("clave", clave))
      .unique();
    if (fila) await ctx.db.delete(fila._id);
  }
}

// ---------------------------------------------------------------------------
// Reconstrucción desde las tablas
// ---------------------------------------------------------------------------
/** Filas por transacción. Los mensajes van de 100 en 100 porque cada respuesta
 *  arrastra fuentes y hops (el mismo lote que usa su borrado); las demás
 *  tablas son de filas pequeñas. */
export const LOTE_MENSAJES_RECONSTRUIR = 100;
export const LOTE_FILAS_RECONSTRUIR = 500;

const fase = v.union(
  v.literal("vaciar"),
  v.literal("mensajes"),
  v.literal("feedback"),
  v.literal("sesiones"),
);

/**
 * Recalcula TODOS los contadores desde `messages`, `feedback` y `sessions`.
 *
 * Va por fases y por lotes, reagendándose: primero vacía la tabla, luego
 * recorre cada tabla por su índice de creación con un cursor. Mientras corre
 * las cifras son parciales; al terminar, exactas. Es idempotente: lanzarla dos
 * veces deja lo mismo. Se lanza a mano (`npx convex run contadores:reconstruir`)
 * al estrenar la tabla en un despliegue con datos, y sirve de red si alguna
 * vez las cifras se desviaran.
 */
export const reconstruir = internalMutation({
  args: { fase: v.optional(fase), cursor: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ fase: string; hecho: boolean }> => {
    const faseActual = args.fase ?? "vaciar";
    const cursor = args.cursor ?? 0;
    const seguir = async (siguiente: typeof faseActual, cursorSiguiente: number) => {
      await ctx.scheduler.runAfter(0, internal.contadores.reconstruir, {
        fase: siguiente,
        cursor: cursorSiguiente,
      });
      return { fase: siguiente, hecho: false };
    };

    if (faseActual === "vaciar") {
      const filas = await ctx.db.query("contadores").take(LOTE_FILAS_RECONSTRUIR);
      for (const f of filas) await ctx.db.delete(f._id);
      if (filas.length === LOTE_FILAS_RECONSTRUIR) return await seguir("vaciar", 0);
      return await seguir("mensajes", 0);
    }

    if (faseActual === "mensajes") {
      const lote = await ctx.db
        .query("messages")
        .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
        .order("asc")
        .take(LOTE_MENSAJES_RECONSTRUIR);
      for (const m of lote) {
        if (m.role !== "user") continue;
        await sumar(ctx, CLAVE_PREGUNTAS, 1);
        await sumar(ctx, clavePreguntasDelDia(m.creadoEn), 1);
        await sumar(ctx, clavePreguntasDe(m.userId), 1);
      }
      if (lote.length === LOTE_MENSAJES_RECONSTRUIR) {
        return await seguir("mensajes", lote[lote.length - 1]._creationTime);
      }
      return await seguir("feedback", 0);
    }

    if (faseActual === "feedback") {
      const lote = await ctx.db
        .query("feedback")
        .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
        .order("asc")
        .take(LOTE_FILAS_RECONSTRUIR);
      for (const f of lote) await sumar(ctx, claveVotos(f.rating), 1);
      if (lote.length === LOTE_FILAS_RECONSTRUIR) {
        return await seguir("feedback", lote[lote.length - 1]._creationTime);
      }
      return await seguir("sesiones", 0);
    }

    const lote = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(LOTE_FILAS_RECONSTRUIR);
    for (const s of lote) await sumar(ctx, claveSesionesDe(s.userId), 1);
    if (lote.length === LOTE_FILAS_RECONSTRUIR) {
      return await seguir("sesiones", lote[lote.length - 1]._creationTime);
    }
    return { fase: "sesiones", hecho: true };
  },
});
