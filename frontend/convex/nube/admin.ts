// Lo que cada usuaria ve y puede hacer con SU Google Drive o SU OneDrive
// desde el panel de documentos: el estado completo en una sola forma
// (`estado`) y lanzar la sincronización ya (`sincronizarAhora`). Conectar,
// elegir carpetas y desconectar viven en nube/oauth.ts.
//
// Todo va contra la cuenta de quien llama y el proveedor que pide, nunca
// contra otra. Los tokens nunca salen de aquí: `estado` dice con qué cuenta
// se conectó y qué carpetas sincroniza, no con qué credenciales.
import { mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { ajustes } from "../lib/config";
import { proveedorNube } from "../schema";
import { errorDatos, usuario } from "../usuarios";
import { conexionActual, oauthHabilitado } from "./oauth";
import { NOMBRE } from "./proveedores";

/** Una corrida `running` más joven que esto sigue viva. */
const CORRIDA_VIVA_MS = 31 * 60_000;

export const sincronizarAhora = mutation({
  args: { proveedor: proveedorNube },
  handler: async (ctx, { proveedor }) => {
    const u = await usuario(ctx);
    const conexion = await conexionActual(ctx, u._id, proveedor);
    if (!conexion || conexion.carpetas.length === 0) {
      throw errorDatos(
        "invalido",
        `Antes de sincronizar hay que conectar con ${NOMBRE[proveedor]} y elegir al menos una carpeta.`,
      );
    }
    const ultima = await ctx.db
      .query("nubeSincronizaciones")
      .withIndex("porPropietarioYProveedor", (q) => q.eq("propietario", u._id).eq("proveedor", proveedor))
      .order("desc")
      .first();
    if (ultima?.estado === "running" && Date.now() - ultima.empezadoEn < CORRIDA_VIVA_MS) {
      throw errorDatos("conflicto", `Ya hay una sincronización con ${NOMBRE[proveedor]} en curso.`);
    }
    await ctx.scheduler.runAfter(0, internal.nube.sync.sincronizar, {
      propietario: u._id,
      proveedor,
      forzar: true,
    });
    return { ok: true as const };
  },
});

/** Todo lo que necesita el bloque de una nube en el panel, en una sola
 *  forma. Sin tokens ni secretos. */
export const estado = query({
  args: { proveedor: proveedorNube },
  handler: async (ctx, { proveedor }) => {
    const u = await usuario(ctx);
    const a = ajustes();
    const conexion = await conexionActual(ctx, u._id, proveedor);
    const corridas = await ctx.db
      .query("nubeSincronizaciones")
      .withIndex("porPropietarioYProveedor", (q) => q.eq("propietario", u._id).eq("proveedor", proveedor))
      .order("desc")
      .take(5);
    const ficheros = await ctx.db
      .query("nubeFicheros")
      .withIndex("porPropietarioYFichero", (q) => q.eq("propietario", u._id).eq("proveedor", proveedor))
      .collect();
    const documentos = await ctx.db
      .query("documents")
      .withIndex("porPropietario", (q) => q.eq("propietario", u._id))
      .collect();

    const primera = corridas[0];
    const enCurso =
      primera && primera.estado === "running"
        ? {
            vivaHasta: primera.empezadoEn + CORRIDA_VIVA_MS,
            empezadoEn: primera.empezadoEn,
            ficherosTotal: primera.ficherosTotal ?? null,
            ficherosProcesados: primera.ficherosProcesados ?? 0,
            ficheroActual: primera.ficheroActual ?? null,
            nuevos: primera.nuevos,
            actualizados: primera.actualizados,
            borrados: primera.borrados,
            errores: primera.errores,
          }
        : null;

    return {
      habilitada: oauthHabilitado(a, proveedor),
      conexion: conexion
        ? {
            cuentaNombre: conexion.cuentaNombre,
            cuentaCorreo: conexion.cuentaCorreo ?? null,
            cuentaImagen: conexion.cuentaImagen ?? null,
            conectadoEn: conexion.conectadoEn,
            necesitaReconexion: conexion.necesitaReconexion === true,
          }
        : null,
      carpetas: conexion?.carpetas ?? [],
      periodicaMinutos: a.nubeSyncMinutes,
      borrarRetirados: a.nubeBorrarRetirados,
      ficheros: ficheros.length,
      ficherosConError: ficheros.filter((f) => f.error).length,
      documentos: documentos.filter((d) => d.origen === proveedor).length,
      enCurso,
      ultimas: corridas.map((c) => ({
        _id: c._id,
        empezadoEn: c.empezadoEn,
        terminadoEn: c.terminadoEn ?? null,
        estado: c.estado,
        ficheros: c.ficheros,
        nuevos: c.nuevos,
        actualizados: c.actualizados,
        borrados: c.borrados,
        errores: c.errores,
      })),
    };
  },
});
