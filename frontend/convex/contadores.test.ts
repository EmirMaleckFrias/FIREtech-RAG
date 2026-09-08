// Los contadores de Ajustes (contadores.ts): que suban y bajen con las mismas
// mutaciones que escriben y borran lo que cuentan, que una cuenta borrada no
// los resucite, que la reconstrucción desde las tablas dé la verdad, y el
// barrido de turnos colgados que vive al lado.
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  CLAVE_PREGUNTAS,
  CLAVE_VOTOS_ABAJO,
  CLAVE_VOTOS_ARRIBA,
  clavePreguntasDe,
  clavePreguntasDelDia,
  claveSesionesDe,
  clavesDeLaVentana,
  LOTE_MENSAJES_RECONSTRUIR,
} from "./contadores";
import { ESPERA_COLGADO_MS, LOTE_MENSAJES, MENSAJE_COLGADO } from "./mensajes";

vi.mock("./agente/bucle", async () => {
  const { internalAction } = await import("./_generated/server");
  return { correr: internalAction(async () => {}) };
});
vi.mock("./ingesta/pipeline", async () => {
  const { internalAction } = await import("./_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

function nuevaBase() {
  return convexTest({ schema });
}
type Base = ReturnType<typeof nuevaBase>;

async function alta(t: Base, email: string, rol: "admin" | "lector" = "lector") {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", { email, rol, bloqueado: false, creadoEn: Date.now(), ultimoAccesoEn: Date.now() }),
  );
  return { id, como: t.withIdentity({ subject: id }) };
}

async function valor(t: Base, clave: string): Promise<number> {
  const fila = await t.run((ctx) =>
    ctx.db.query("contadores").withIndex("porClave", (q) => q.eq("clave", clave)).unique(),
  );
  return fila?.valor ?? 0;
}

async function existe(t: Base, clave: string): Promise<boolean> {
  return (await t.run((ctx) =>
    ctx.db.query("contadores").withIndex("porClave", (q) => q.eq("clave", clave)).unique(),
  )) !== null;
}

async function agendadas(t: Base) {
  await t.finishAllScheduledFunctions(() => {}, 200);
}

/** Inserta a mano `n` turnos (pregunta + respuesta) en una conversación, sin
 *  pasar por `enviar`: es lo que hay en un despliegue anterior a la tabla. */
async function turnosAMano(t: Base, sessionId: Id<"sessions">, userId: Id<"users">, n: number, desde = 1_700_000_000_000) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("messages", { sessionId, userId, role: "user", content: `p${i}`, creadoEn: desde + i * 2 });
      await ctx.db.insert("messages", {
        sessionId, userId, role: "assistant", content: `r${i}`, estado: "listo", creadoEn: desde + i * 2 + 1,
        sources: [], hops: [],
      });
    }
  });
}

afterEach(() => vi.restoreAllMocks());

describe("las mutaciones llevan los contadores", () => {
  test("enviar cuenta la pregunta, su día y la conversación nueva; en la misma conversación no suma otra", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { sessionId } = await ana.como.mutation(api.mensajes.enviar, { texto: "¿p-tau217?", modo: "normal" });
    await ana.como.mutation(api.mensajes.enviar, { sessionId, texto: "¿y la AUC?", modo: "normal" });
    await agendadas(t);

    expect(await valor(t, CLAVE_PREGUNTAS)).toBe(2);
    expect(await valor(t, clavePreguntasDelDia(Date.now()))).toBe(2);
    expect(await valor(t, clavePreguntasDe(ana.id))).toBe(2);
    expect(await valor(t, claveSesionesDe(ana.id))).toBe(1);
    // Y `sesiones.crear` cuenta una conversación aunque aún no tenga preguntas.
    await ana.como.mutation(api.sesiones.crear, { titulo: "Vacía" });
    expect(await valor(t, claveSesionesDe(ana.id))).toBe(2);
  });

  test("calificar: un voto suma, cambiarlo mueve una unidad, repetirlo no toca nada", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    await agendadas(t);
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    expect([await valor(t, CLAVE_VOTOS_ARRIBA), await valor(t, CLAVE_VOTOS_ABAJO)]).toEqual([1, 0]);
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    expect([await valor(t, CLAVE_VOTOS_ARRIBA), await valor(t, CLAVE_VOTOS_ABAJO)]).toEqual([1, 0]);
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: -1, comentario: "no" });
    expect([await valor(t, CLAVE_VOTOS_ARRIBA), await valor(t, CLAVE_VOTOS_ABAJO)]).toEqual([0, 1]);
  });

  test("borrar una conversación larga descuenta sus preguntas y sus votos, lote a lote, y la conversación", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { sessionId, messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    await agendadas(t);
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    // Muchos más turnos de los que caben en un lote de borrado.
    const n = LOTE_MENSAJES + 20;
    await turnosAMano(t, sessionId, ana.id, n);
    await t.mutation(internal.contadores.reconstruir, {});
    await agendadas(t);
    expect(await valor(t, CLAVE_PREGUNTAS)).toBe(n + 1);
    expect(await valor(t, claveSesionesDe(ana.id))).toBe(1);

    await ana.como.mutation(api.sesiones.borrar, { sessionId });
    await agendadas(t);

    expect(await valor(t, CLAVE_PREGUNTAS)).toBe(0);
    expect(await valor(t, clavePreguntasDe(ana.id))).toBe(0);
    expect(await valor(t, claveSesionesDe(ana.id))).toBe(0);
    expect(await valor(t, CLAVE_VOTOS_ARRIBA)).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });

  test("ADVERSARIAL: borrar una cuenta retira sus contadores y el borrado de sus mensajes en segundo plano NO los resucita", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", "admin");
    const ana = await alta(t, "ana@airobotix.net");
    const beto = await alta(t, "beto@airobotix.net");
    const { sessionId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    await turnosAMano(t, sessionId, ana.id, LOTE_MENSAJES + 5);
    const deBeto = await beto.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    await agendadas(t);
    await t.mutation(internal.contadores.reconstruir, {});
    await agendadas(t);
    // Ana vota una respuesta de Beto: ese voto es de Ana y se va con ella.
    await t.run((ctx) => ctx.db.patch(deBeto.messageId, { estado: "listo" }));
    const votoDeAna = await t.run((ctx) => ctx.db.insert("feedback", { messageId: deBeto.messageId, userId: ana.id, rating: -1, creadoEn: Date.now() }));
    void votoDeAna;
    await t.mutation(internal.contadores.reconstruir, {});
    await agendadas(t);
    expect(await valor(t, CLAVE_PREGUNTAS)).toBe(LOTE_MENSAJES + 7);
    expect(await valor(t, CLAVE_VOTOS_ABAJO)).toBe(1);

    await admin.como.mutation(api.usuarios.borrar, { userId: ana.id });
    // Antes de que corran los lotes: los suyos ya no están.
    expect(await existe(t, clavePreguntasDe(ana.id))).toBe(false);
    expect(await existe(t, claveSesionesDe(ana.id))).toBe(false);
    await agendadas(t);
    // Y después tampoco: los decrementos de sus mensajes no los recrean.
    expect(await existe(t, clavePreguntasDe(ana.id))).toBe(false);
    expect(await valor(t, CLAVE_PREGUNTAS)).toBe(1);
    expect(await valor(t, clavePreguntasDe(beto.id))).toBe(1);
    expect(await valor(t, CLAVE_VOTOS_ABAJO)).toBe(0);
    // Ni un contador negativo en toda la tabla.
    const todos = await t.run((ctx) => ctx.db.query("contadores").collect());
    expect(todos.every((c) => c.valor >= 0)).toBe(true);
  });

  test("un contador nunca baja de cero", async () => {
    const t = nuevaBase();
    await t.run(async (ctx) => {
      const { sumar } = await import("./contadores");
      await sumar(ctx, "x", 2);
      await sumar(ctx, "x", -5);
      await sumar(ctx, "nuevo", -1);
    });
    expect(await valor(t, "x")).toBe(0);
    expect(await existe(t, "nuevo")).toBe(false);
  });
});

describe("reconstruir", () => {
  test("recalcula desde las tablas en varios lotes, es idempotente y tira los contadores viejos", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const beto = await alta(t, "beto@airobotix.net");
    const s1 = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "a", userId: ana.id, creadoEn: 1 }));
    const s2 = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "b", userId: ana.id, creadoEn: 2 }));
    const s3 = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "c", userId: beto.id, creadoEn: 3 }));
    const n = LOTE_MENSAJES_RECONSTRUIR * 2 + 7; // tres lotes de mensajes
    await turnosAMano(t, s1, ana.id, n);
    await turnosAMano(t, s2, ana.id, 3);
    await turnosAMano(t, s3, beto.id, 2);
    const [m] = await t.run((ctx) => ctx.db.query("messages").take(1));
    await t.run(async (ctx) => {
      await ctx.db.insert("feedback", { messageId: m._id, userId: ana.id, rating: 1, creadoEn: 1 });
      await ctx.db.insert("feedback", { messageId: m._id, userId: beto.id, rating: -1, creadoEn: 1 });
      // Un contador rancio que no corresponde a nada: tiene que desaparecer.
      await ctx.db.insert("contadores", { clave: "usuario:fantasma:preguntas", valor: 99 });
      await ctx.db.insert("contadores", { clave: CLAVE_PREGUNTAS, valor: 12345 });
    });

    for (let vez = 0; vez < 2; vez++) {
      await t.mutation(internal.contadores.reconstruir, {});
      await agendadas(t);
      expect(await valor(t, CLAVE_PREGUNTAS)).toBe(n + 5);
      expect(await valor(t, clavePreguntasDe(ana.id))).toBe(n + 3);
      expect(await valor(t, clavePreguntasDe(beto.id))).toBe(2);
      expect(await valor(t, claveSesionesDe(ana.id))).toBe(2);
      expect(await valor(t, claveSesionesDe(beto.id))).toBe(1);
      expect(await valor(t, CLAVE_VOTOS_ARRIBA)).toBe(1);
      expect(await valor(t, CLAVE_VOTOS_ABAJO)).toBe(1);
      expect(await existe(t, "usuario:fantasma:preguntas")).toBe(false);
      // Todos los turnos son del mismo día: el contador del día lo dice.
      expect(await valor(t, clavePreguntasDelDia(1_700_000_000_000))).toBe(n + 5);
    }
  });
});

describe("estadisticas con contadores", () => {
  test("la ventana de 7 días es por días naturales: hace 6 días cuenta, hace 9 no", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", "admin");
    const ana = await alta(t, "ana@airobotix.net");
    const dia = 86_400_000;
    const ahora = Date.now();
    const s = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "a", userId: ana.id, creadoEn: ahora }));
    await turnosAMano(t, s, ana.id, 2, ahora - 6 * dia);
    await turnosAMano(t, s, ana.id, 3, ahora - 9 * dia);
    await t.mutation(internal.contadores.reconstruir, {});
    await agendadas(t);
    const stats = await admin.como.query(api.estadisticas.sistema, { ahora });
    expect(stats.activity.questions_total).toBe(5);
    expect(stats.activity.questions_7d).toBe(2);
    expect(clavesDeLaVentana(ahora)).toHaveLength(8);
  });
});

describe("turnos colgados", () => {
  test("el barrido cierra los que siguen en marcha pasado el presupuesto y no toca lo demás", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const s = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "a", userId: ana.id, creadoEn: 1 }));
    const viejo = Date.now() - ESPERA_COLGADO_MS - 60_000;
    const ids = await t.run(async (ctx) => {
      const base = { sessionId: s, userId: ana.id, role: "assistant" as const, content: "" };
      return {
        colgado: await ctx.db.insert("messages", { ...base, estado: "redactando", creadoEn: viejo }),
        colgadoPensando: await ctx.db.insert("messages", { ...base, estado: "pensando", creadoEn: viejo - 1000 }),
        reciente: await ctx.db.insert("messages", { ...base, estado: "buscando", creadoEn: Date.now() - 60_000 }),
        listo: await ctx.db.insert("messages", { ...base, estado: "listo", content: "ok", creadoEn: viejo }),
        cancelado: await ctx.db.insert("messages", { ...base, estado: "cancelado", creadoEn: viejo }),
        pregunta: await ctx.db.insert("messages", { ...base, role: "user", content: "p", creadoEn: viejo }),
      };
    });

    expect(await t.mutation(internal.mensajes.cerrarColgados, {})).toEqual({ cerrados: 2 });
    const leer = (id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
    expect(await leer(ids.colgado)).toMatchObject({ estado: "error", error: MENSAJE_COLGADO });
    expect(await leer(ids.colgadoPensando)).toMatchObject({ estado: "error" });
    expect((await leer(ids.reciente))?.estado).toBe("buscando");
    expect((await leer(ids.listo))?.estado).toBe("listo");
    expect((await leer(ids.cancelado))?.estado).toBe("cancelado");
    expect((await leer(ids.pregunta))?.estado).toBeUndefined();
    // Segunda pasada: ya no hay nada que cerrar.
    expect(await t.mutation(internal.mensajes.cerrarColgados, {})).toEqual({ cerrados: 0 });
  });
});
