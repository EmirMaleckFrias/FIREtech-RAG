// Estado del índice, actividad agregada y configuración, para la sección de
// Ajustes. Port de `GET /stats` de `backend/app/api/routes.py` y de
// `activity_stats` de `supabase_db.py`. Solo administradores.
//
// Nunca devuelve contenido de conversaciones: las cifras de actividad son
// agregados, no texto de nadie.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { ajustes } from "./lib/config";
import { CLAVE_PREGUNTAS, CLAVE_VOTOS_ABAJO, CLAVE_VOTOS_ARRIBA, clavesDeLaVentana, leer, leerVarias } from "./contadores";
import { administrador } from "./usuarios";
import { VERSION_PROMPT } from "./agente/prompt";

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

/** Valores distintos, sin vacíos, en orden alfabético. */
function distintos(valores: Array<string | undefined>): string[] {
  return [...new Set(valores.filter((x): x is string => Boolean(x)))].sort();
}

export const sistema = query({
  // `ahora` lo manda el cliente (redondeado a unos minutos): una query no
  // lee el reloj, porque no se vuelve a ejecutar por el paso del tiempo y la
  // ventana de "activos 7 días" se quedaría congelada en la caché.
  args: { ahora: v.number() },
  handler: async (ctx, { ahora }) => {
    await administrador(ctx, "ver las estadísticas");
    const a = ajustes();
    const desde = ahora - SIETE_DIAS_MS;

    // Índice: se responde desde `documents`, que es pequeña, en vez de recorrer
    // `chunks`. En Qdrant esto eran facets sobre el payload; aquí cada
    // documento listo ya sabe cuántos fragmentos tiene y de qué tipo e idioma
    // es. Solo cuentan los `ready`: un `processing` o un `failed` no aporta
    // nada al índice que se consulta.
    //
    // Estas cifras son de TODO el despliegue, no del corpus de quien mira, y
    // eso no contradice el aislamiento entre corpus: son agregados
    // operativos (cuánto hay indexado, de qué formatos) para dimensionar el
    // servicio, y no revelan ni un nombre de fichero ni una línea de texto de
    // nadie. Ver los documentos de otra persona sigue siendo imposible, aquí
    // y en cualquier otro sitio. Se recorre la tabla porque ya no hay un
    // índice global por estado: todos empiezan por `propietario`, justamente
    // para que no exista una lectura cómoda que cruce cuentas.
    const listos = (await ctx.db.query("documents").collect()).filter(
      (d) => d.status === "ready",
    );
    const index = {
      chunks: listos.reduce((suma, d) => suma + d.chunks, 0),
      files: listos.length,
      types: distintos(listos.map((d) => d.documentType)),
      languages: distintos(listos.map((d) => d.language)),
    };

    // Actividad: de los contadores (contadores.ts), no recorriendo
    // `messages`. Antes cada respuesta del asistente (con sus `sources` y
    // `hops`) se leía para contar una pregunta, y a unos cientos de
    // respuestas la query pasaba de los 16 MiB de una transacción y esta
    // pantalla fallaba. Las de "7 días" son las de los últimos siete días
    // naturales más hoy.
    const preguntasTotal = await leer(ctx, CLAVE_PREGUNTAS);
    const preguntas7d = await leerVarias(ctx, clavesDeLaVentana(ahora, 7));

    // Usuarios activos: los que abrieron alguna conversación en la ventana.
    // Se pregunta por índice y usuario (como mucho una fila leída por cuenta)
    // en vez de recorrer `sessions`, que crece sin límite.
    const cuentas = await ctx.db.query("users").collect();
    let activos = 0;
    for (const u of cuentas) {
      const reciente = await ctx.db
        .query("sessions")
        .withIndex("porUsuarioYCreacion", (q) => q.eq("userId", u._id).gte("creadoEn", desde))
        .first();
      if (reciente) activos++;
    }

    return {
      index,
      activity: {
        questions_total: preguntasTotal,
        questions_7d: preguntas7d,
        active_users_7d: activos,
        feedback_up: await leer(ctx, CLAVE_VOTOS_ARRIBA),
        feedback_down: await leer(ctx, CLAVE_VOTOS_ABAJO),
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
