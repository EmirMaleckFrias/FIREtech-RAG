// Lo que el administrador ve y puede hacer con la sincronización de Notion
// desde el panel de documentos: su estado y un botón para lanzarla ya.
//
// El token nunca sale de aquí: `estado` dice si está configurado, no cuál es.
import { mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { ajustes } from "../lib/config";
import { administrador, errorDatos } from "../usuarios";

/** Una corrida `running` más joven que esto sigue viva (la acción dura como
 *  mucho 30 minutos) y no se lanza otra encima: dos sincronizaciones a la vez
 *  registrarían los mismos ficheros y pelearían por las mismas filas. */
const CORRIDA_VIVA_MS = 31 * 60_000;

/** Agenda una sincronización inmediata, saltando el intervalo del cron. */
export const sincronizarAhora = mutation({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "sincronizar con Notion");
    const a = ajustes();
    if (!a.notionToken || !a.notionDatabaseId) {
      throw errorDatos(
        "invalido",
        "Notion no está configurado en este despliegue: faltan NOTION_TOKEN y NOTION_DATABASE_ID.",
      );
    }
    const ultima = await ctx.db.query("notionSincronizaciones").order("desc").first();
    if (ultima?.estado === "running" && Date.now() - ultima.empezadoEn < CORRIDA_VIVA_MS) {
      throw errorDatos("conflicto", "Ya hay una sincronización con Notion en curso.");
    }
    await ctx.scheduler.runAfter(0, internal.notion.sync.sincronizar, { forzar: true });
    return { ok: true as const };
  },
});

/** Estado para el bloque del panel: configurado o no (sin revelar el token),
 *  las últimas corridas y cuánto hay sincronizado. */
export const estado = query({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "ver el estado de Notion");
    const a = ajustes();
    const corridas = await ctx.db.query("notionSincronizaciones").order("desc").take(5);
    // Las dos tablas son pequeñas (una fila por página y por documento), así
    // que contarlas recorriéndolas es lo mismo que hace `documentos.listar`.
    const paginas = await ctx.db.query("notionPaginas").collect();
    const documentos = await ctx.db.query("documents").collect();
    return {
      configurado: Boolean(a.notionToken && a.notionDatabaseId),
      periodicaMinutos: a.notionSyncMinutes,
      borrarArchivados: a.notionBorrarArchivados,
      paginas: paginas.length,
      paginasConError: paginas.filter((p) => p.error).length,
      documentos: documentos.filter((d) => d.origen === "notion").length,
      ultimas: corridas.map((c) => ({
        _id: c._id,
        empezadoEn: c.empezadoEn,
        terminadoEn: c.terminadoEn ?? null,
        estado: c.estado,
        paginas: c.paginas,
        nuevos: c.nuevos,
        actualizados: c.actualizados,
        borrados: c.borrados,
        errores: c.errores,
      })),
    };
  },
});
