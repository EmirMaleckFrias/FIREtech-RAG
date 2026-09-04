// Mensajes de una conversación y el arranque de un turno del asistente.
// Port de `POST /chat` (la parte que no es el agente), `GET
// /sessions/{id}/messages` y `POST /feedback` de `backend/app/api/routes.py`,
// y de `get_messages`, `save_message` y `save_feedback` de `supabase_db.py`.
//
// El cambio de fondo respecto al backend anterior: allí `POST /chat` abría un
// stream SSE y el agente corría DENTRO de la petición, con todo lo que eso
// arrastraba (guardar respuestas parciales si el cliente abortaba, mensajes
// `user` huérfanos si el servidor fallaba). Aquí `enviar` es una mutación
// corta: guarda la pregunta, deja el mensaje del asistente en `pensando` y
// agenda la acción del agente, que va escribiendo su avance en esa misma fila
// con `actualizarTurno`. El cliente solo se suscribe a la conversación.
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import schema from "./schema";
import { errorDatos, sesionDe, usuario } from "./usuarios";

/** Tope de la pregunta. Una pregunta más larga que esto es casi siempre un
 *  documento pegado por error, y hay una vía para eso (subirlo). */
export const LIMITE_TEXTO = 4000;
/** Título de una conversación nueva: los primeros caracteres de la pregunta. */
export const LONGITUD_TITULO = 60;
/** Mensajes de contexto que viajan con cada pregunta (8 = 4 turnos). Era
 *  `_HISTORY_MAX_MESSAGES`: suficiente para las repreguntas ("y el precio de
 *  ese?") sin que una conversación larga arrastre temas viejos a preguntas
 *  nuevas ni infle la entrada de cada llamada al modelo. */
export const HISTORIAL_MAX = 8;
/** Cuántos mensajes recientes se leen para armar el historial. Leer la
 *  conversación entera cargaría el `sources` y los `hops` de cada respuesta
 *  (decenas de KB cada una) para quedarse con ocho líneas de texto; con tres
 *  veces el tope hay margen para que algún turno que acabó en error (sin
 *  contenido) no deje el historial corto. */
const VENTANA_HISTORIAL = HISTORIAL_MAX * 3;
/** Mensajes que borra una mutación de una vez. Una respuesta del asistente
 *  con sus fuentes y sus hops pesa decenas de KB, y una transacción puede leer
 *  16 MiB: 100 deja margen incluso si alguna llega a 100 KB. */
export const LOTE_MENSAJES = 100;

const camposMensaje = schema.tables.messages.validator.fields;

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
/** Los últimos turnos completos, como los veía el modelo en el backend
 *  anterior: solo `user`/`assistant` con contenido, y como mucho
 *  `HISTORIAL_MAX` mensajes.
 *
 *  Se exige además que cada pregunta vaya seguida de su respuesta. Una
 *  pregunta cuyo turno acabó en `error` (contenido vacío) o que todavía está
 *  en marcha se salta: el backend anterior documentó dos veces que dos `user`
 *  seguidos contaminaban el historial que se enviaba al modelo, y lo parcheaba
 *  guardando respuestas parciales. Aquí la regla vive en un solo sitio. */
export function historialDe(
  mensajes: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const conContenido = mensajes.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "",
  );
  const turnos: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < conContenido.length; i++) {
    const m = conContenido[i];
    const siguiente = conContenido[i + 1];
    if (m.role === "user" && siguiente?.role === "assistant") {
      turnos.push(
        { role: "user", content: m.content },
        { role: "assistant", content: siguiente.content },
      );
      i++;
    }
  }
  return turnos.slice(-HISTORIAL_MAX);
}

// ---------------------------------------------------------------------------
// Lectura y envío
// ---------------------------------------------------------------------------
/** Mensajes de una conversación propia, del más antiguo al más nuevo. */
export const deSesion = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const u = await usuario(ctx);
    await sesionDe(ctx, sessionId, u._id);
    return await ctx.db
      .query("messages")
      .withIndex("porSesion", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

/** Una pregunta nueva. Crea la conversación si no viene, guarda la pregunta,
 *  deja el mensaje del asistente en `pensando` y agenda al agente.
 *
 *  La pertenencia de la sesión se comprueba ANTES de escribir nada, y una
 *  ajena responde `no_encontrado`, nunca "prohibida": era el 404 que el
 *  endpoint devolvía antes de abrir el stream. */
export const enviar = mutation({
  args: {
    sessionId: v.optional(v.id("sessions")),
    texto: v.string(),
    // "normal" o "extendido". Un valor desconocido no es un error: el agente
    // lo resuelve al modo normal, que es el que menos supone (lib/modos.ts).
    modo: v.string(),
  },
  handler: async (ctx, args) => {
    const u = await usuario(ctx);
    const texto = args.texto.trim();
    if (!texto) throw errorDatos("invalido", "Escribe una pregunta.");
    if (texto.length > LIMITE_TEXTO) {
      throw errorDatos(
        "invalido",
        `La pregunta supera los ${LIMITE_TEXTO} caracteres (tiene ${texto.length}).`,
      );
    }

    const ahora = Date.now();
    let sessionId = args.sessionId;
    if (sessionId !== undefined) {
      await sesionDe(ctx, sessionId, u._id);
    } else {
      sessionId = await ctx.db.insert("sessions", {
        titulo: texto.slice(0, LONGITUD_TITULO),
        userId: u._id,
        creadoEn: ahora,
      });
    }

    // Historial previo, ANTES de guardar el mensaje actual.
    const recientes = await ctx.db
      .query("messages")
      .withIndex("porSesion", (q) => q.eq("sessionId", sessionId!))
      .order("desc")
      .take(VENTANA_HISTORIAL);
    const historial = historialDe(recientes.reverse());

    await ctx.db.insert("messages", {
      sessionId,
      userId: u._id,
      role: "user",
      content: texto,
      creadoEn: ahora,
    });
    // +1 ms: los dos se insertan en el mismo instante y el índice `porSesion`
    // ordena por `creadoEn`; sin esto la respuesta podría listarse antes que
    // la pregunta.
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      userId: u._id,
      role: "assistant",
      content: "",
      estado: "pensando",
      creadoEn: ahora + 1,
    });

    await ctx.scheduler.runAfter(0, internal.agente.bucle.correr, {
      messageId,
      sessionId,
      userId: u._id,
      texto,
      modo: args.modo,
      historial,
    });

    // Perro guardián: ver `marcarColgado`. 540 s de presupuesto + 90 de margen.

    await ctx.scheduler.runAfter(630_000, internal.mensajes.marcarColgado, { messageId });
    return { sessionId, messageId };
  },
});

/** El agente escribe su avance aquí: solo los campos que llegan.
 *
 *  Si el mensaje ya no existe (la conversación se borró mientras el agente
 *  trabajaba) devuelve `false` y no crea nada: recrearlo "resucitaría" algo
 *  que el usuario borró, que es la misma regla que tenía
 *  `upsert_document_status` para los documentos. Y no lanza, para que el
 *  agente no se caiga en cada actualización posterior por una fila que ya no
 *  le importa a nadie. */
export const actualizarTurno = internalMutation({
  args: {
    messageId: v.id("messages"),
    cambios: v.object({
      estado: camposMensaje.estado,
      content: v.optional(camposMensaje.content),
      sources: camposMensaje.sources,
      hops: camposMensaje.hops,
      verificacion: camposMensaje.verificacion,
      metrics: camposMensaje.metrics,
      plan: camposMensaje.plan,
      error: camposMensaje.error,
    }),
  },
  handler: async (ctx, { messageId, cambios }): Promise<boolean> => {
    const m = await ctx.db.get(messageId);
    if (!m) return false;
    // `patch` con un valor `undefined` BORRA el campo. Los campos que no
    // llegan no deben tocarse, así que se quitan antes.
    const parche = Object.fromEntries(
      Object.entries(cambios).filter(([, valor]) => valor !== undefined),
    ) as typeof cambios;
    if (Object.keys(parche).length > 0) await ctx.db.patch(messageId, parche);
    return true;
  },
});

/** Pulgar arriba o abajo sobre un mensaje de una conversación propia.
 *
 *  Un voto por usuario y mensaje: repetir reemplaza al anterior, que es lo que
 *  espera quien cambia de opinión (en Postgres se acumulaban filas). Un
 *  mensaje que no existe o cuya conversación es de otro responde
 *  `no_encontrado` en los dos casos, sin revelar cuál. */
export const calificar = mutation({
  args: {
    messageId: v.id("messages"),
    rating: v.union(v.literal(1), v.literal(-1)),
    comentario: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const u = await usuario(ctx);
    const m = await ctx.db.get(args.messageId);
    if (!m) throw errorDatos("no_encontrado", "No se encontró el mensaje.");
    await sesionDe(ctx, m.sessionId, u._id);

    const comentario = args.comentario?.trim() || undefined;
    const previo = await ctx.db
      .query("feedback")
      .withIndex("porUsuarioYMensaje", (q) =>
        q.eq("userId", u._id).eq("messageId", m._id),
      )
      .unique();
    if (previo) {
      await ctx.db.patch(previo._id, {
        rating: args.rating,
        comentario,
        creadoEn: Date.now(),
      });
      return previo._id;
    }
    return await ctx.db.insert("feedback", {
      messageId: m._id,
      userId: u._id,
      rating: args.rating,
      comentario,
      creadoEn: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Borrado por lotes
// ---------------------------------------------------------------------------
/** Borra estos mensajes y su feedback. */
async function borrarMensajes(ctx: MutationCtx, mensajes: Doc<"messages">[]) {
  for (const m of mensajes) {
    const votos = await ctx.db
      .query("feedback")
      .withIndex("porMensaje", (q) => q.eq("messageId", m._id))
      .collect();
    for (const f of votos) await ctx.db.delete(f._id);
    await ctx.db.delete(m._id);
  }
}

/** Un lote de mensajes de una conversación o de un usuario. */
async function loteDeMensajes(
  ctx: MutationCtx,
  filtro: { sessionId?: Id<"sessions">; userId?: Id<"users"> },
): Promise<Doc<"messages">[]> {
  if (filtro.sessionId !== undefined) {
    const sessionId = filtro.sessionId;
    return await ctx.db
      .query("messages")
      .withIndex("porSesion", (q) => q.eq("sessionId", sessionId))
      .take(LOTE_MENSAJES);
  }
  if (filtro.userId !== undefined) {
    const userId = filtro.userId;
    return await ctx.db
      .query("messages")
      .withIndex("porUsuario", (q) => q.eq("userId", userId))
      .take(LOTE_MENSAJES);
  }
  throw new Error("loteDeMensajes: hace falta sessionId o userId");
}

/** Borra los mensajes de una conversación: el primer lote aquí mismo, para
 *  que la interfaz los vea desaparecer con la conversación, y el resto en
 *  segundo plano si había más de un lote. La llama `sesiones.borrar`. */
export async function borrarMensajesDeSesion(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const lote = await loteDeMensajes(ctx, { sessionId });
  await borrarMensajes(ctx, lote);
  if (lote.length === LOTE_MENSAJES) {
    await ctx.scheduler.runAfter(0, internal.mensajes.borrarRestantes, { sessionId });
  }
}

/** Sigue borrando mensajes por lotes hasta que no queden. Se reagenda a sí
 *  misma: cada ejecución es una transacción pequeña que cabe de sobra en los
 *  límites, en vez de una grande que fallaría entera. */
export const borrarRestantes = internalMutation({
  args: {
    sessionId: v.optional(v.id("sessions")),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<void> => {
    const lote = await loteDeMensajes(ctx, args);
    await borrarMensajes(ctx, lote);
    if (lote.length === LOTE_MENSAJES) {
      await ctx.scheduler.runAfter(0, internal.mensajes.borrarRestantes, args);
    }
  },
});


/** Perro guardián del turno del asistente.
 *
 *  Si la acción del agente muere sin escribir `error` (la plataforma la mata
 *  a los 600 s, o una llamada colgada la retiene), el mensaje se quedaba en
 *  `redactando` para siempre y el composer bloqueado. `enviar` agenda esta
 *  mutación con margen sobre el presupuesto total de la pregunta: si el turno
 *  sigue abierto, lo cierra con un error honesto. Lo señaló la revisión
 *  adversarial del bucle. */
export const marcarColgado = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<boolean> => {
    const m = await ctx.db.get(messageId);
    if (!m || m.role !== "assistant") return false;
    if (m.estado === "listo" || m.estado === "error") return false;
    await ctx.db.patch(messageId, {
      estado: "error",
      error:
        "El asistente no terminó de responder en el tiempo previsto. Vuelve a " +
        "hacer la pregunta; si se repite, prueba en pensamiento normal.",
    });
    return true;
  },
});
