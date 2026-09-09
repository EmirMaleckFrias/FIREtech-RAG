// @vitest-environment node
/// <reference types="vite/client" />
// Las cachés que hacen determinista la recuperación (SPEC §8): el plan por
// pregunta y los veredictos del calificador. Ninguna tenía tests, y las dos
// arrastran una regresión ya pagada: `.unique()` sobre una clave duplicada
// tumbaba la búsqueda entera de la caché.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { claveDe, normalizarPregunta } from "./cachePlan";
import { claveDeCalificacion } from "./cacheCalificaciones";

const modules = import.meta.glob("/convex/**/*.*s");
const DIA = 24 * 3600 * 1000;

describe("caché del plan", () => {
  test("la clave normaliza la pregunta y cambia con el modelo y con la versión del prompt", () => {
    // Minúsculas, sin acentos, espacios colapsados y sin los signos de
    // apertura ni de cierre: "¿Qué dice…?  " y "que dice" son la misma clave.
    expect(normalizarPregunta("  ¿Qué dice la  GUÍA sobre p-tau217?  ")).toBe("que dice la guia sobre p-tau217");
    const a = claveDe("¿Qué dice la guía?", "openai/gpt-5.4", "v3");
    expect(claveDe("que dice la guia", "openai/gpt-5.4", "v3")).toBe(a);
    expect(claveDe("¿Qué dice la guía?", "openai/gpt-5.4-mini", "v3")).not.toBe(a);
    expect(claveDe("¿Qué dice la guía?", "openai/gpt-5.4", "v4")).not.toBe(a);
  });

  test("guardar y leer; una entrada de más de 30 días se ignora", async () => {
    const t = convexTest(schema, modules);
    const clave = claveDe("pregunta", "m", "v");
    await t.mutation(internal.agente.cachePlan.guardar, {
      clave, pregunta: "pregunta", modelo: "m", version: "v", items: [{ id: "e0" }], preguntaEn: "question", clase: "documental",
    });
    const ahora = Date.now();
    expect(await t.query(internal.agente.cachePlan.leer, { clave, ahora })).toEqual({
      items: [{ id: "e0" }], preguntaEn: "question", clase: "documental", variantes: [], documento: "",
    });
    // Las reformulaciones de la pregunta se guardan y se leen con el plan.
    await t.mutation(internal.agente.cachePlan.guardar, {
      clave, pregunta: "pregunta", modelo: "m", version: "v", items: [{ id: "e0" }], preguntaEn: "question", clase: "documental",
      variantes: ["query variant", "another"],
    });
    expect((await t.query(internal.agente.cachePlan.leer, { clave, ahora }))?.variantes).toEqual(["query variant", "another"]);
    expect(await t.query(internal.agente.cachePlan.leer, { clave, ahora: ahora + 31 * DIA })).toBeNull();
    expect(await t.query(internal.agente.cachePlan.leer, { clave: "otra", ahora })).toBeNull();
  });

  test("ADVERSARIAL: dos filas con la misma clave no lanzan (la regresión de .unique())", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("planes", {
          clave: "dup", pregunta: "p", modelo: "m", version: "v", items: [i], preguntaEn: "", creadoEn: Date.now(), usos: 1,
        });
      }
    });
    const r = await t.query(internal.agente.cachePlan.leer, { clave: "dup", ahora: Date.now() });
    expect(r).not.toBeNull();
    await t.mutation(internal.agente.cachePlan.contarUso, { clave: "dup" });
  });
});

describe("caché de calificaciones", () => {
  test("guardar es idempotente por clave y leer devuelve solo lo que hay", async () => {
    const t = convexTest(schema, modules);
    const k1 = claveDeCalificacion("consulta", "dato", "frag1", "m");
    const k2 = claveDeCalificacion("consulta", "dato", "frag2", "m");
    expect(await t.mutation(internal.agente.cacheCalificaciones.guardar, { entradas: [{ clave: k1, grado: "directa" }] })).toBe(1);
    expect(await t.mutation(internal.agente.cacheCalificaciones.guardar, { entradas: [{ clave: k1, grado: "no" }] })).toBe(0);
    const r = await t.query(internal.agente.cacheCalificaciones.leer, { claves: [k1, k2] });
    expect(r).toEqual([{ clave: k1, grado: "directa" }]);
  });

  test("la clave distingue consulta, evidencia necesaria, fragmento y modelo, e ignora espacios y mayúsculas", () => {
    const base = claveDeCalificacion("Consulta  X", "Dato", "f", "m");
    expect(claveDeCalificacion("consulta x", "dato", "f", "m")).toBe(base);
    expect(claveDeCalificacion("consulta x", "dato", "g", "m")).not.toBe(base);
    expect(claveDeCalificacion("consulta x", "otro", "f", "m")).not.toBe(base);
    expect(claveDeCalificacion("consulta x", "dato", "f", "m2")).not.toBe(base);
  });

  test("ADVERSARIAL: dos filas con la misma clave no lanzan", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("calificaciones", { clave: "dup", grado: "directa", creadoEn: 1 });
      await ctx.db.insert("calificaciones", { clave: "dup", grado: "parcial", creadoEn: 2 });
    });
    expect(await t.query(internal.agente.cacheCalificaciones.leer, { claves: ["dup"] })).toEqual([
      { clave: "dup", grado: "directa" },
    ]);
  });
});
