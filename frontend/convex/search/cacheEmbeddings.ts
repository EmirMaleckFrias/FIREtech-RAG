// Caché de vectores de consulta (tabla `consultasEmbebidas`, ver schema.ts).
// `.first()` y no `.unique()`: dos puntos del plan que comparten consulta se
// siembran en paralelo y pueden dejar dos filas con la misma clave; con
// `.unique()` esa clave lanzaba y tumbaba la búsqueda ENTERA de la caché en cada
// corrida (medido: cero aciertos con las tablas llenas). Un duplicado es
// inofensivo si se lee la primera fila.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** Clave: modelo + texto normalizado (espacios colapsados, minúsculas). El
 *  embedding de "P-tau217 AUC" y "p-tau217  auc" es prácticamente el mismo y
 *  compartir vector entre ambas formas es lo deseable. */
export function claveDeConsulta(texto: string, modelo: string): string {
  return `${modelo}|${texto.toLowerCase().split(/\s+/).filter(Boolean).join(" ")}`;
}

// Devuelve una LISTA de pares y no un objeto indexado por clave: Convex valida
// los nombres de campo de lo que devuelve una función y una clave con acentos
// o con "|" no es un nombre de campo válido. Con el objeto, cualquier consulta
// en español hacía lanzar la función entera y la caché daba cero aciertos
// (medido: tablas llenas, ningún acierto en cuatro mediciones seguidas).
export const leer = internalQuery({
  args: { claves: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ clave: string; vector: number[] }>> => {
    const salida: Array<{ clave: string; vector: number[] }> = [];
    for (const clave of args.claves) {
      const fila = await ctx.db
        .query("consultasEmbebidas")
        .withIndex("porClave", (q) => q.eq("clave", clave))
        .first();
      if (fila) salida.push({ clave, vector: fila.vector });
    }
    return salida;
  },
});

export const guardar = internalMutation({
  args: {
    entradas: v.array(v.object({ clave: v.string(), modelo: v.string(), vector: v.array(v.float64()) })),
  },
  handler: async (ctx, args) => {
    let nuevas = 0;
    for (const e of args.entradas) {
      const previa = await ctx.db
        .query("consultasEmbebidas")
        .withIndex("porClave", (q) => q.eq("clave", e.clave))
        .first();
      if (previa) continue;
      await ctx.db.insert("consultasEmbebidas", { ...e, creadoEn: Date.now() });
      nuevas += 1;
    }
    return nuevas;
  },
});
