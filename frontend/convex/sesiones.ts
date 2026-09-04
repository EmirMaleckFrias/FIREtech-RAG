// Conversaciones. Port de `GET /sessions` de `backend/app/api/routes.py` y de
// `create_session` / `list_sessions` de `supabase_db.py`, más el borrado que el
// backend anterior no tenía como endpoint.
//
// Aislamiento por usuario (era la migración 004): `sessions.userId` es el
// dueño. Cada usuario ve y escribe solo en las suyas, y el rol NO amplía la
// visibilidad: un administrador tampoco ve conversaciones ajenas. Una sesión
// de otro responde `no_encontrado`, nunca "prohibida", para no confirmar que
// existe (ver permisos.ts).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { LONGITUD_TITULO, borrarMensajesDeSesion } from "./mensajes";
import { sesionDe, usuario } from "./usuarios";

/** Conversaciones del usuario y de nadie más, la más nueva primero. */
export const listar = query({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const filas = await ctx.db
      .query("sessions")
      .withIndex("porUsuario", (q) => q.eq("userId", u._id))
      .order("desc")
      .collect();
    return filas.map((s) => ({ _id: s._id, titulo: s.titulo, creadoEn: s.creadoEn }));
  },
});

/** Una conversación vacía. El título se recorta como el que pone `enviar`
 *  a partir de la primera pregunta, y uno vacío recibe un nombre por defecto
 *  para que la lista no muestre una fila sin texto. */
export const crear = mutation({
  args: { titulo: v.string() },
  handler: async (ctx, { titulo }) => {
    const u = await usuario(ctx);
    const limpio = titulo.trim().slice(0, LONGITUD_TITULO) || "Nueva conversación";
    return await ctx.db.insert("sessions", {
      titulo: limpio,
      userId: u._id,
      creadoEn: Date.now(),
    });
  },
});

/** Borra una conversación propia con sus mensajes y su feedback.
 *
 *  Los mensajes van por lotes (ver `mensajes.borrarMensajesDeSesion`): el
 *  primero aquí mismo y el resto en segundo plano, porque una conversación
 *  larga con sus fuentes y sus hops puede pesar más de lo que una transacción
 *  puede leer. La fila de la sesión se borra ya, así que la lista del usuario
 *  la pierde al instante. */
export const borrar = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const u = await usuario(ctx);
    await sesionDe(ctx, sessionId, u._id);
    await borrarMensajesDeSesion(ctx, sessionId);
    await ctx.db.delete(sessionId);
    return { ok: true };
  },
});
