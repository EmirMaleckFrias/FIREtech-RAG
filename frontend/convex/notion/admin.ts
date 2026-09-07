// Lo que cada usuaria ve y puede hacer con SU Notion desde el panel de
// documentos: el estado completo en una sola forma (`estado`) y lanzar la
// sincronización ya (`sincronizarAhora`). Conectar, elegir la base y
// desconectar viven en notion/oauth.ts.
//
// Todo va contra la cuenta de quien llama, nunca contra otra: cada persona
// tiene su propio corpus y su propia conexión (ver `propietario` en
// schema.ts). No hace falta ser administrador; conectar su Notion es parte
// del uso normal.
//
// El token nunca sale de aquí: `estado` dice a qué espacio se está conectado
// y con qué base, no con qué credenciales.
import { mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { ajustes } from "../lib/config";
import { errorDatos, usuario } from "../usuarios";
import { conexionActual, credencialesDe, oauthHabilitado } from "./oauth";

/** Una corrida `running` más joven que esto sigue viva (la acción dura como
 *  mucho 30 minutos) y no se lanza otra encima: dos sincronizaciones a la vez
 *  registrarían los mismos ficheros y pelearían por las mismas filas. */
const CORRIDA_VIVA_MS = 31 * 60_000;

/** Agenda una sincronización inmediata, saltando el intervalo del cron. */
export const sincronizarAhora = mutation({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const cred = await credencialesDe(ctx, u._id);
    if (!cred) {
      throw errorDatos(
        "invalido",
        "Antes de sincronizar hay que conectar con Notion y elegir al menos una base de datos.",
      );
    }
    // La última corrida SUYA: que otra persona esté sincronizando no puede
    // bloquearla.
    const ultima = await ctx.db
      .query("notionSincronizaciones")
      .withIndex("porPropietario", (q) => q.eq("propietario", u._id))
      .order("desc")
      .first();
    if (ultima?.estado === "running" && Date.now() - ultima.empezadoEn < CORRIDA_VIVA_MS) {
      throw errorDatos("conflicto", "Ya hay una sincronización con Notion en curso.");
    }
    await ctx.scheduler.runAfter(0, internal.notion.sync.sincronizar, {
      propietario: u._id,
      forzar: true,
    });
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
    const u = await usuario(ctx);
    const a = ajustes();
    const conexion = await conexionActual(ctx, u._id);
    const corridas = await ctx.db
      .query("notionSincronizaciones")
      .withIndex("porPropietario", (q) => q.eq("propietario", u._id))
      .order("desc")
      .take(5);
    // Solo lo suyo, por índice. Las dos tablas son pequeñas (una fila por
    // página y por documento), así que contarlas recorriéndolas es lo mismo
    // que hace `documentos.listar`.
    const paginas = await ctx.db
      .query("notionPaginas")
      .withIndex("porPropietarioYPageId", (q) => q.eq("propietario", u._id))
      .collect();
    const documentos = await ctx.db
      .query("documents")
      .withIndex("porPropietario", (q) => q.eq("propietario", u._id))
      .collect();

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
      // Las bases que sincroniza, en el orden en que las eligió. Lista vacía
      // = conectada pero sin elegir ninguna todavía.
      bases: conexion?.bases ?? [],
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
