// Caché del plan de evidencia (ver la tabla `planes` en schema.ts).
//
// Reglas: la clave normaliza la pregunta (minúsculas, sin acentos, espacios
// colapsados, sin signos finales) y añade el modelo y la versión del prompt;
// una entrada caduca a los 30 días para que un índice que cambia mucho no
// arrastre planes pensados para otro corpus (el plan no depende del índice,
// pero sus consultas en inglés sí pueden envejecer con el vocabulario).
// `.first()` y no `.unique()`: dos puntos del plan que comparten consulta se
// siembran en paralelo y pueden dejar dos filas con la misma clave; con
// `.unique()` esa clave lanzaba y tumbaba la búsqueda ENTERA de la caché en cada
// corrida (medido: cero aciertos con las tablas llenas). Un duplicado es
// inofensivo si se lee la primera fila.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const CADUCIDAD_MS = 30 * 24 * 3600 * 1000;

export function normalizarPregunta(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function claveDe(pregunta: string, modelo: string, version: string): string {
  return `${version}|${modelo}|${normalizarPregunta(pregunta)}`;
}

export const leer = internalQuery({
  args: { clave: v.string() },
  handler: async (ctx, args) => {
    const fila = await ctx.db
      .query("planes")
      .withIndex("porClave", (q) => q.eq("clave", args.clave))
      .first();
    if (!fila) return null;
    if (Date.now() - fila.creadoEn > CADUCIDAD_MS) return null;
    return { items: fila.items as unknown[], preguntaEn: fila.preguntaEn, clase: fila.clase ?? null };
  },
});

export const guardar = internalMutation({
  args: {
    clave: v.string(),
    pregunta: v.string(),
    modelo: v.string(),
    version: v.string(),
    clase: v.optional(v.string()),
    items: v.any(),
    preguntaEn: v.string(),
  },
  handler: async (ctx, args) => {
    const previa = await ctx.db
      .query("planes")
      .withIndex("porClave", (q) => q.eq("clave", args.clave))
      .first();
    if (previa) {
      await ctx.db.patch(previa._id, {
        items: args.items, preguntaEn: args.preguntaEn, clase: args.clase,
        creadoEn: Date.now(), usos: previa.usos + 1,
      });
      return previa._id;
    }
    return await ctx.db.insert("planes", { ...args, creadoEn: Date.now(), usos: 1 });
  },
});

export const contarUso = internalMutation({
  args: { clave: v.string() },
  handler: async (ctx, args) => {
    const fila = await ctx.db
      .query("planes")
      .withIndex("porClave", (q) => q.eq("clave", args.clave))
      .first();
    if (fila) await ctx.db.patch(fila._id, { usos: fila.usos + 1 });
  },
});
