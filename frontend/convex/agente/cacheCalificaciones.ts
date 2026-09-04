// Caché de veredictos del calificador (tabla `calificaciones`, ver schema.ts)
// y el envoltorio que la usa: `calificarConCache` califica solo los fragmentos
// que no tienen veredicto guardado y devuelve una `Calificacion` sobre el
// índice completo de la lista, como si el calificador la hubiera juzgado
// entera.
// `.first()` y no `.unique()`: dos puntos del plan que comparten consulta se
// siembran en paralelo y pueden dejar dos filas con la misma clave; con
// `.unique()` esa clave lanzaba y tumbaba la búsqueda ENTERA de la caché en cada
// corrida (medido: cero aciertos con las tablas llenas). Un duplicado es
// inofensivo si se lee la primera fila.
import { v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Fragmento } from "../lib/citas";
import { ajustes, modeloRerankResuelto } from "../lib/config";
import type { Telemetria } from "../lib/telemetry";
import * as calificador from "./calificador";

function normalizar(t: string): string {
  return t.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function claveDeCalificacion(
  consulta: string, evidenceNeeded: string, fragmentoId: string, modelo: string,
): string {
  return `${modelo}|${normalizar(consulta)}|${normalizar(evidenceNeeded)}|${fragmentoId}`;
}

// Lista de pares y no objeto indexado por clave: ver la nota equivalente en
// search/cacheEmbeddings.ts (los nombres de campo con acentos no son válidos).
export const leer = internalQuery({
  args: { claves: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ clave: string; grado: string }>> => {
    const salida: Array<{ clave: string; grado: string }> = [];
    for (const clave of args.claves) {
      const fila = await ctx.db
        .query("calificaciones")
        .withIndex("porClave", (q) => q.eq("clave", clave))
        .first();
      if (fila) salida.push({ clave, grado: fila.grado });
    }
    return salida;
  },
});

export const guardar = internalMutation({
  args: { entradas: v.array(v.object({ clave: v.string(), grado: v.string() })) },
  handler: async (ctx, args) => {
    let nuevas = 0;
    for (const e of args.entradas) {
      const previa = await ctx.db
        .query("calificaciones")
        .withIndex("porClave", (q) => q.eq("clave", e.clave))
        .first();
      if (previa) continue;
      await ctx.db.insert("calificaciones", { ...e, creadoEn: Date.now() });
      nuevas += 1;
    }
    return nuevas;
  },
});

/** Como `calificador.calificarEvidencia`, pero reutilizando los veredictos ya
 *  guardados para (consulta, evidencia necesaria, fragmento, modelo) y
 *  guardando los nuevos. `verificado` es true si TODO lo que se entrega tiene
 *  veredicto (cacheado o recién emitido) y la parte nueva se calificó bien. */
export async function calificarConCache(
  ctx: ActionCtx,
  consulta: string,
  evidenceNeeded: string,
  fragmentos: Fragmento[],
  tel?: Telemetria,
): Promise<calificador.Calificacion> {
  if (!fragmentos.length) return { grados: {}, verificado: true, motivo: "sin candidatos" };
  const modelo = modeloRerankResuelto(ajustes());
  const claves = fragmentos.map((f) => claveDeCalificacion(consulta, evidenceNeeded, f._id, modelo));

  let cacheados: Record<string, string> = {};
  try {
    // En un contexto sin base (un test con ctx mínimo) esto lanza y se sigue
    // sin caché, que es lo mismo que una caché vacía.
    const pares = await ctx.runQuery(internal.agente.cacheCalificaciones.leer, { claves });
    for (const p of pares ?? []) cacheados[p.clave] = p.grado;
  } catch (exc) {
    console.warn("caché de calificaciones no disponible", String(exc).slice(0, 120));
  }

  const grados: Record<number, calificador.Grado> = {};
  const pendientes: number[] = [];
  fragmentos.forEach((_, i) => {
    const g = cacheados[claves[i]];
    if (g && (calificador.GRADOS as readonly string[]).includes(g)) grados[i] = g as calificador.Grado;
    else pendientes.push(i);
  });
  const aciertos = fragmentos.length - pendientes.length;
  if (aciertos) tel?.incr("calificaciones_en_cache", aciertos);

  if (!pendientes.length) {
    return { grados, verificado: true, motivo: `${aciertos} veredictos desde la caché` };
  }

  const nuevos = await calificador.calificarEvidencia(
    consulta, evidenceNeeded, pendientes.map((i) => fragmentos[i]), tel,
  );
  const entradas: { clave: string; grado: string }[] = [];
  for (const [local, grado] of Object.entries(nuevos.grados)) {
    const i = pendientes[Number(local)];
    if (i === undefined) continue;
    grados[i] = grado;
    entradas.push({ clave: claves[i], grado });
  }
  // Solo se guardan veredictos de una calificación que SÍ se aplicó: un lote
  // caído deja huecos y esos no se cachean.
  if (entradas.length) {
    try {
      void ctx
        .runMutation(internal.agente.cacheCalificaciones.guardar, { entradas })
        .catch((exc: unknown) => console.warn("no se pudo guardar la calificación en caché", String(exc).slice(0, 120)));
    } catch (exc) {
      console.warn("no se pudo guardar la calificación en caché", String(exc).slice(0, 120));
    }
  }
  return {
    grados,
    verificado: nuevos.verificado,
    motivo: aciertos ? `${aciertos} desde la caché; ${nuevos.motivo}` : nuevos.motivo,
  };
}
