// Estado del índice, actividad agregada y configuración, para la sección de
// Ajustes. Port de `GET /stats` de `backend/app/api/routes.py` y de
// `activity_stats` de `supabase_db.py`. Solo administradores.
//
// Nunca devuelve contenido de conversaciones: las cifras de actividad son
// agregados, no texto de nadie.
import { query } from "./_generated/server";
import { ajustes } from "./lib/config";
import { administrador } from "./usuarios";
import { VERSION_PROMPT } from "./agente/prompt";

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

/** Valores distintos, sin vacíos, en orden alfabético. */
function distintos(valores: Array<string | undefined>): string[] {
  return [...new Set(valores.filter((x): x is string => Boolean(x)))].sort();
}

export const sistema = query({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "ver las estadísticas");
    const a = ajustes();
    const desde = Date.now() - SIETE_DIAS_MS;

    // Índice: se responde desde `documents`, que es pequeña, en vez de recorrer
    // `chunks`. En Qdrant esto eran facets sobre el payload; aquí cada
    // documento listo ya sabe cuántos fragmentos tiene y de qué tipo e idioma
    // es. Solo cuentan los `ready`: un `processing` o un `failed` no aporta
    // nada al índice que se consulta.
    const listos = await ctx.db
      .query("documents")
      .withIndex("porEstado", (q) => q.eq("status", "ready"))
      .collect();
    const index = {
      chunks: listos.reduce((suma, d) => suma + d.chunks, 0),
      files: listos.length,
      types: distintos(listos.map((d) => d.documentType)),
      languages: distintos(listos.map((d) => d.language)),
    };

    // Actividad. Las preguntas se cuentan recorriendo `messages`: Convex no
    // tiene agregados y el esquema no lleva contadores, así que cada
    // respuesta del asistente (con sus `sources` y `hops`) se lee para
    // contar una pregunta. Aguanta unos cientos de respuestas dentro de los
    // 16 MiB que una transacción puede leer; más allá hace falta una tabla
    // de contadores. El backend anterior avisaba de lo mismo con Postgres.
    const mensajes = await ctx.db.query("messages").collect();
    const preguntas = mensajes.filter((m) => m.role === "user");

    // Usuarios activos: los que abrieron alguna conversación en la ventana.
    // Se pregunta por índice y usuario (como mucho una fila leída por cuenta)
    // en vez de recorrer `sessions`, que crece sin límite.
    const cuentas = await ctx.db.query("users").collect();
    let activos = 0;
    for (const u of cuentas) {
      const reciente = await ctx.db
        .query("sessions")
        .withIndex("porUsuario", (q) => q.eq("userId", u._id).gte("creadoEn", desde))
        .first();
      if (reciente) activos++;
    }

    const votos = await ctx.db.query("feedback").collect();

    return {
      index,
      activity: {
        questions_total: preguntas.length,
        questions_7d: preguntas.filter((m) => m.creadoEn >= desde).length,
        active_users_7d: activos,
        feedback_up: votos.filter((f) => f.rating === 1).length,
        feedback_down: votos.filter((f) => f.rating === -1).length,
      },
      config: {
        model: a.modelo,
        embedding_model: a.modeloEmbedding,
        prompt_version: VERSION_PROMPT,
        upload_limit_mb: a.limiteSubidaMb,
      },
    };
  },
});
