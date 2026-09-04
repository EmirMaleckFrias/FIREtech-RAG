// Lo que la administradora ve y puede hacer con Notion desde el panel de
// documentos: el estado completo en una sola forma (`estado`) y lanzar la
// sincronización ya (`sincronizarAhora`). Conectar, elegir la base y
// desconectar viven en notion/oauth.ts.
//
// El token nunca sale de aquí: `estado` dice a qué espacio se está conectado
// y con qué base, no con qué credenciales.
import { mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { ajustes } from "../lib/config";
import { administrador, errorDatos } from "../usuarios";
import { conexionActual, credencialesDe, oauthHabilitado } from "./oauth";

/** Una corrida `running` más joven que esto sigue viva (la acción dura como
 *  mucho 30 minutos) y no se lanza otra encima: dos sincronizaciones a la vez
 *  registrarían los mismos ficheros y pelearían por las mismas filas. */
const CORRIDA_VIVA_MS = 31 * 60_000;

/** Agenda una sincronización inmediata, saltando el intervalo del cron. */
export const sincronizarAhora = mutation({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "sincronizar con Notion");
    const cred = await credencialesDe(ctx);
    if (!cred) {
      throw errorDatos(
        "invalido",
        "Antes de sincronizar hay que conectar con Notion y elegir la base de datos.",
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

/** Todo lo que necesita el bloque de Notion del panel, en una sola forma:
 *  si la conexión está habilitada por el equipo técnico, a qué espacio se
 *  está conectado, qué base se sincroniza, la corrida en curso con su
 *  progreso, las últimas cinco y cuánto hay sincronizado. Sin tokens ni
 *  secretos: ni el de la conexión ni los de la integración. */
export const estado = query({
  args: {},
  handler: async (ctx) => {
    await administrador(ctx, "ver el estado de Notion");
    const a = ajustes();
    const conexion = await conexionActual(ctx);
    const cred = await credencialesDe(ctx);
    const corridas = await ctx.db.query("notionSincronizaciones").order("desc").take(5);
    // Las dos tablas son pequeñas (una fila por página y por documento), así
    // que contarlas recorriéndolas es lo mismo que hace `documentos.listar`.
    const paginas = await ctx.db.query("notionPaginas").collect();
    const documentos = await ctx.db.query("documents").collect();

    const primera = corridas[0];
    const enCurso =
      primera && primera.estado === "running" && Date.now() - primera.empezadoEn < CORRIDA_VIVA_MS
        ? {
            empezadoEn: primera.empezadoEn,
            paginasTotal: primera.paginasTotal ?? null,
            paginasProcesadas: primera.paginasProcesadas ?? 0,
            paginaActual: primera.paginaActual ?? null,
            nuevos: primera.nuevos,
            actualizados: primera.actualizados,
            borrados: primera.borrados,
            errores: primera.errores,
          }
        : null;

    return {
      // La integración pública está registrada (NOTION_CLIENT_ID y secreto).
      habilitada: oauthHabilitado(a),
      conexion: conexion
        ? {
            workspaceName: conexion.workspaceName,
            workspaceIcon: conexion.workspaceIcon ?? null,
            conectadoEn: conexion.conectadoEn,
          }
        : null,
      // La base con la que se sincroniza: la elegida en la app o, si aún no
      // se eligió ninguna, la que venía por variable (preseleccionada).
      base: cred
        ? {
            id: cred.databaseId,
            titulo: conexion?.databaseId ? (conexion.databaseTitulo ?? null) : null,
            elegidaEnApp: Boolean(conexion?.databaseId),
          }
        : null,
      // Sin conexión en la app pero con las variables de la primera versión:
      // funciona, y la UI lo cuenta como "configurado por el equipo técnico".
      porEntorno: cred?.fuente === "entorno",
      periodicaMinutos: a.notionSyncMinutes,
      borrarArchivados: a.notionBorrarArchivados,
      paginas: paginas.length,
      paginasConError: paginas.filter((p) => p.error).length,
      documentos: documentos.filter((d) => d.origen === "notion").length,
      enCurso,
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
