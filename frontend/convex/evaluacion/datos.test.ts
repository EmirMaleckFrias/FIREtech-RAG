/// <reference types="vite/client" />
// Las funciones públicas de la pestaña Calidad (datos.ts) con convex-test.
// Lo que hay que romper: que una cuenta vea o toque preguntas, generaciones o
// corridas de otra; que los botones lancen trabajo cuando no toca; y que el
// borrado de una cuenta deje rastro de su evaluación.
import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { ESPERA_TURNO_MS, INTERVALO_SONDEO_MS, configurarEspera } from "./correr";
import { PASO_GENERACION_MAX_MS, PREPARACION_GENERACION_MAX_MS, generacionColgada } from "./datos";

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

// Ni el agente ni la generación reales corren aquí: estas pruebas comprueban
// que se AGENDAN con lo correcto, no lo que hacen después (eso lo prueban
// correr.test.ts y generar.test.ts). Se sustituyen por acciones inertes.
vi.mock("../agente/bucle", async () => {
  const { internalAction } = await import("../_generated/server");
  return { correr: internalAction(async () => {}) };
});
vi.mock("./generar", async () => {
  const { internalAction } = await import("../_generated/server");
  return { generar: internalAction(async () => {}) };
});

async function alta(t: T, email: string, rol: "admin" | "lector" = "lector") {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", { email, rol, bloqueado: false, creadoEn: Date.now(), ultimoAccesoEn: Date.now() }),
  );
  return { id, como: t.withIdentity({ subject: id }) };
}

const DEFINICION = {
  question: "¿Cuál es el AUC?",
  mode: "normal",
  category: "single_hop",
  critical: true,
  min_hops: 1,
  evidence: [
    { id: "ev-1", description: "el AUC", sources: [{ file: "a.pdf", pages: [3] }, { file: "b.pdf", pages: [1] }] },
    { id: "ev-2", description: "otro", sources: [{ file: "a.pdf", pages: [4] }] },
  ],
  answer_must_contain: ["0[.,]94"],
  expect_abstention: false,
};

async function caso(t: T, propietario: Id<"users">, clave: string, estado: "propuesto" | "aprobado" | "descartado", creadoEn = Date.now()) {
  return await t.run((ctx) =>
    ctx.db.insert("evaluacionCasos", {
      propietario, clave, pregunta: "¿Cuál es el AUC?", modo: "normal", categoria: "single_hop", critico: true,
      respuestaEsperada: "0,94", definicion: DEFINICION, estado, origen: "generado", creadoEn,
    }),
  );
}

async function corridaCon(t: T, propietario: Id<"users">, estado: "running" | "ok" | "error" = "ok") {
  const corridaId = await t.run((ctx) =>
    ctx.db.insert("evaluacionCorridas", {
      propietario, empezadoEn: Date.now(), terminadoEn: estado === "running" ? undefined : Date.now(), estado, disparo: "manual",
      casosTotal: 1, casosHechos: estado === "running" ? 0 : 1, repeticiones: 1, versionPrompt: "v4", modelo: "m",
      resumen: estado === "ok" ? { cases: 1, passed: 1 } : undefined,
    }),
  );
  const casoId = await caso(t, propietario, "single_hop-001", "aprobado");
  await t.run((ctx) =>
    ctx.db.insert("evaluacionResultados", {
      corridaId, propietario, casoId, clave: "single_hop-001", pregunta: "¿Cuál es el AUC?", categoria: "single_hop", critico: true,
      puntuacion: { passed: false, failures: ["evidencia no recuperada: ev-2"], metrics: { evidence_recall: 0.5, retrieval_mrr: null } },
      resultado: { runs: 1 },
      corridas: [{ respuesta: "El AUC fue 0,94 [a.pdf, pág. 3].", fuentes: [], fallos: [], ms: 1, coste: 0, error: null }],
      creadoEn: Date.now(),
    }),
  );
  return { corridaId, casoId };
}

async function codigoDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
    return "sin error";
  } catch (e) {
    return e instanceof ConvexError ? (e.data as { codigo: string }).codigo : `otro: ${String(e)}`;
  }
}

beforeEach(() => {
  configurarEspera({ intervaloMs: 5, maxMs: 30 });
});

afterEach(() => {
  configurarEspera({ intervaloMs: INTERVALO_SONDEO_MS, maxMs: ESPERA_TURNO_MS });
  vi.restoreAllMocks();
});

describe("aislamiento entre cuentas", () => {
  test("ADVERSARIAL: nadie ve ni toca las preguntas, generaciones o corridas de otra persona", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    const beto = await alta(t, "beto@alzheimerproject.com", "admin");
    const { corridaId, casoId } = await corridaCon(t, ana.id);
    await t.run((ctx) =>
      ctx.db.insert("evaluacionGeneraciones", { propietario: ana.id, empezadoEn: Date.now(), estado: "running", objetivo: 20, generados: 3, descartados: 1, paso: "Leyendo a.pdf" }),
    );

    // Ana ve lo suyo.
    expect((await ana.como.query(api.evaluacion.datos.casos, {})).map((c) => c.clave)).toEqual(["single_hop-001"]);
    expect(await ana.como.query(api.evaluacion.datos.generacionActual, {})).toMatchObject({ estado: "running", generados: 3, paso: "Leyendo a.pdf" });
    expect((await ana.como.query(api.evaluacion.datos.corridas, {})).map((c) => c._id)).toEqual([corridaId]);
    expect(await ana.como.query(api.evaluacion.datos.resultadosDe, { corridaId })).toEqual([
      {
        clave: "single_hop-001", pregunta: "¿Cuál es el AUC?", categoria: "single_hop", critico: true, passed: false,
        failures: ["evidencia no recuperada: ev-2"], metrics: { evidence_recall: 0.5, retrieval_mrr: null },
        respuesta: "El AUC fue 0,94 [a.pdf, pág. 3].",
      },
    ]);

    // Beto, aunque sea administrador, no ve nada de Ana ni puede tocarlo.
    expect(await beto.como.query(api.evaluacion.datos.casos, {})).toEqual([]);
    expect(await beto.como.query(api.evaluacion.datos.generacionActual, {})).toBeNull();
    expect(await beto.como.query(api.evaluacion.datos.corridas, {})).toEqual([]);
    expect(await codigoDe(beto.como.query(api.evaluacion.datos.resultadosDe, { corridaId }))).toBe("no_encontrado");
    expect(await codigoDe(beto.como.mutation(api.evaluacion.datos.revisar, { casoId, estado: "descartado" }))).toBe("no_encontrado");
    expect(await codigoDe(beto.como.mutation(api.evaluacion.datos.editarRespuesta, { casoId, respuestaEsperada: "pirateada" }))).toBe("no_encontrado");
    expect(await codigoDe(beto.como.mutation(api.evaluacion.datos.borrarCaso, { casoId }))).toBe("no_encontrado");
    const intacto = await t.run((ctx) => ctx.db.get(casoId));
    expect(intacto).toMatchObject({ estado: "aprobado", respuestaEsperada: "0,94" });
    // Sin sesión: no_autenticado, no una lista vacía.
    expect(await codigoDe(t.query(api.evaluacion.datos.casos, {}))).toBe("no_autenticado");
  });
});

describe("casos", () => {
  test("se listan propuestos primero y del más nuevo al más viejo, con los ficheros esperados", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    await caso(t, ana.id, "aprobado-viejo", "aprobado", 100);
    await caso(t, ana.id, "propuesto-viejo", "propuesto", 200);
    await caso(t, ana.id, "descartado", "descartado", 900);
    await caso(t, ana.id, "propuesto-nuevo", "propuesto", 300);
    await caso(t, ana.id, "aprobado-nuevo", "aprobado", 400);
    const lista = await ana.como.query(api.evaluacion.datos.casos, {});
    expect(lista.map((c) => c.clave)).toEqual(["propuesto-nuevo", "propuesto-viejo", "aprobado-nuevo", "aprobado-viejo", "descartado"]);
    expect(lista[0]).toMatchObject({ pregunta: "¿Cuál es el AUC?", modo: "normal", categoria: "single_hop", critico: true, estado: "propuesto", origen: "generado", respuestaEsperada: "0,94" });
    expect(lista[0].fuentes).toEqual(["a.pdf", "b.pdf"]);
    // La forma es exactamente la del contrato con el frontend: ni la definición ni el propietario viajan.
    expect(Object.keys(lista[0]).sort()).toEqual(["_id", "categoria", "clave", "creadoEn", "critico", "estado", "fuentes", "modo", "origen", "pregunta", "respuestaEsperada"]);
  });

  test("revisar, editar la respuesta y borrar funcionan sobre lo propio, con sus límites", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    const casoId = await caso(t, ana.id, "single_hop-001", "propuesto");
    await ana.como.mutation(api.evaluacion.datos.revisar, { casoId, estado: "aprobado" });
    expect(await t.run((ctx) => ctx.db.get(casoId))).toMatchObject({ estado: "aprobado" });
    expect((await t.run((ctx) => ctx.db.get(casoId)))?.revisadoEn).toBeTypeOf("number");
    await ana.como.mutation(api.evaluacion.datos.revisar, { casoId, estado: "propuesto" });
    expect((await t.run((ctx) => ctx.db.get(casoId)))?.estado).toBe("propuesto");

    await ana.como.mutation(api.evaluacion.datos.editarRespuesta, { casoId, respuestaEsperada: "  Un AUC de 0,94.  " });
    expect((await t.run((ctx) => ctx.db.get(casoId)))?.respuestaEsperada).toBe("Un AUC de 0,94.");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.editarRespuesta, { casoId, respuestaEsperada: "   " }))).toBe("invalido");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.editarRespuesta, { casoId, respuestaEsperada: "x".repeat(2001) }))).toBe("invalido");
    expect((await t.run((ctx) => ctx.db.get(casoId)))?.respuestaEsperada).toBe("Un AUC de 0,94.");

    await ana.como.mutation(api.evaluacion.datos.borrarCaso, { casoId });
    expect(await t.run((ctx) => ctx.db.get(casoId))).toBeNull();
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.borrarCaso, { casoId }))).toBe("no_encontrado");
  });
});

describe("generar", () => {
  test("crea la generación y agenda la acción; rechaza sin documentos listos, con una en marcha y con un objetivo fuera de rango", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 20 }))).toBe("conflicto");
    await t.run((ctx) =>
      ctx.db.insert("documents", { fileName: "a.pdf", sha256: "x", pages: 1, chunks: 1, status: "processing", propietario: ana.id, ingestadoEn: 1 }),
    );
    // En proceso no cuenta como listo.
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 20 }))).toBe("conflicto");
    await t.run((ctx) =>
      ctx.db.insert("documents", { fileName: "b.pdf", sha256: "y", pages: 1, chunks: 1, status: "ready", propietario: ana.id, ingestadoEn: 1 }),
    );
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 0 }))).toBe("invalido");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 61 }))).toBe("invalido");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 2.5 }))).toBe("invalido");

    const { generacionId } = await ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 20 });
    expect(await ana.como.query(api.evaluacion.datos.generacionActual, {})).toMatchObject({ _id: generacionId, estado: "running", objetivo: 20, generados: 0, descartados: 0, terminadoEn: null, error: null });
    const agendadas = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(agendadas.map((f) => f.name)).toEqual(["evaluacion/generar:generar"]);
    expect(agendadas[0].args[0]).toMatchObject({ propietario: ana.id, generacionId, objetivo: 20 });
    // Una segunda mientras la primera sigue en marcha: conflicto.
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 5 }))).toBe("conflicto");
    await t.finishAllScheduledFunctions(() => {}, 50);
  });

  test("una generación 'running' muerta hace tiempo no bloquea: se cierra como error y arranca la nueva", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    await t.run((ctx) =>
      ctx.db.insert("documents", { fileName: "b.pdf", sha256: "y", pages: 1, chunks: 1, status: "ready", propietario: ana.id, ingestadoEn: 1 }),
    );
    // Dos horas de vida con 2 pasos dados: como mucho podría llevar 11 + 3 x 11 minutos.
    const muerta = await t.run((ctx) =>
      ctx.db.insert("evaluacionGeneraciones", { propietario: ana.id, empezadoEn: Date.now() - 2 * 3_600_000, estado: "running", objetivo: 20, generados: 2, descartados: 0, paso: "Leyendo" }),
    );
    const { generacionId } = await ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 10 });
    expect(generacionId).not.toBe(muerta);
    expect(await t.run((ctx) => ctx.db.get(muerta))).toMatchObject({ estado: "error", error: "La propuesta anterior no terminó." });
    expect(await ana.como.query(api.evaluacion.datos.generacionActual, {})).toMatchObject({ _id: generacionId, estado: "running" });
    await t.finishAllScheduledFunctions(() => {}, 50);
  });

  test("ADVERSARIAL: una generación larga que avanza no se da por muerta aunque lleve más de 20 minutos", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    await t.run((ctx) =>
      ctx.db.insert("documents", { fileName: "b.pdf", sha256: "y", pages: 1, chunks: 1, status: "ready", propietario: ana.id, ingestadoEn: 1 }),
    );
    // 50 minutos de vida y 24 pasos dados (12 propuestas y 12 descartes): con
    // el tope fijo de 20 minutos de antes se cerraba en error a mitad.
    const viva = await t.run((ctx) =>
      ctx.db.insert("evaluacionGeneraciones", { propietario: ana.id, empezadoEn: Date.now() - 50 * 60_000, estado: "running", objetivo: 60, generados: 12, descartados: 12, paso: "Proponiendo" }),
    );
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.generar, { objetivo: 10 }))).toBe("conflicto");
    expect(await t.run((ctx) => ctx.db.get(viva))).toMatchObject({ estado: "running", generados: 12, descartados: 12 });
    // El tope: la preparación más 25 pasos de 11 minutos. Justo por debajo, viva; por encima, muerta.
    const limite = PREPARACION_GENERACION_MAX_MS + 25 * PASO_GENERACION_MAX_MS;
    const fila = { estado: "running", empezadoEn: 0, generados: 12, descartados: 12 };
    expect(generacionColgada(fila, limite)).toBe(false);
    expect(generacionColgada(fila, limite + 1)).toBe(true);
    expect(generacionColgada({ ...fila, estado: "ok" }, limite * 10)).toBe(false);
    // Recién creada y sin pasos: aguanta la preparación más un paso, no más.
    expect(generacionColgada({ ...fila, generados: 0, descartados: 0 }, PREPARACION_GENERACION_MAX_MS + PASO_GENERACION_MAX_MS)).toBe(false);
    expect(generacionColgada({ ...fila, generados: 0, descartados: 0 }, PREPARACION_GENERACION_MAX_MS + PASO_GENERACION_MAX_MS + 1)).toBe(true);
  });
});

describe("evaluarAhora", () => {
  test("rechaza sin preguntas aprobadas y con una corrida en marcha; con aprobadas crea la corrida manual", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    await caso(t, ana.id, "single_hop-001", "propuesto");
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.evaluarAhora, {}))).toBe("conflicto");
    await caso(t, ana.id, "single_hop-002", "aprobado");
    const { corridaId } = await ana.como.mutation(api.evaluacion.datos.evaluarAhora, { repeticiones: 3 });
    const corridas = await ana.como.query(api.evaluacion.datos.corridas, {});
    expect(corridas).toHaveLength(1);
    expect(corridas[0]).toMatchObject({ _id: corridaId, estado: "running", disparo: "manual", casosTotal: 1, casosHechos: 0, repeticiones: 3, terminadoEn: null, resumen: null, error: null });
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.evaluarAhora, {}))).toBe("conflicto");
    // El primer paso quedó agendado con el único caso aprobado.
    const agendadas = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(agendadas.map((f) => f.name)).toContain("evaluacion/correr:paso");
    await t.finishAllScheduledFunctions(() => {}, 200);
    // Con el agente inerte, el turno no llega: la corrida termina igual, en ok, con el caso fallido.
    const [terminada] = await ana.como.query(api.evaluacion.datos.corridas, {});
    expect(terminada).toMatchObject({ estado: "ok", casosHechos: 1 });
    const resultados = await ana.como.query(api.evaluacion.datos.resultadosDe, { corridaId });
    expect(resultados).toHaveLength(1);
    expect(resultados[0].passed).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toEqual([]);
  });

  test("ADVERSARIAL: una corrida grande que avanza bloquea el botón; una que dejó de avanzar se cierra y deja pasar", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    await caso(t, ana.id, "single_hop-001", "aprobado");
    const corrida = (empezadoEn: number, avance: { casosTotal: number; casosHechos: number; repeticiones: number }) =>
      t.run((ctx) =>
        ctx.db.insert("evaluacionCorridas", {
          propietario: ana.id, empezadoEn, estado: "running", disparo: "manual", ...avance, casoActual: "x", versionPrompt: "v4", modelo: "m",
        }),
      );
    // 5 h de vida, 30 de 60 casos con 3 repeticiones: sana. Antes (tope fijo de 4 h) se habría dado por muerta.
    const grande = await corrida(Date.now() - 5 * 3_600_000, { casosTotal: 60, casosHechos: 30, repeticiones: 3 });
    expect(await codigoDe(ana.como.mutation(api.evaluacion.datos.evaluarAhora, {}))).toBe("conflicto");
    expect(await t.run((ctx) => ctx.db.get(grande))).toMatchObject({ estado: "running", casoActual: "x" });
    await t.run((ctx) => ctx.db.delete(grande));

    // 2 h sin terminar un caso con una repetición: muerta. Se cierra como error y la nueva arranca.
    const muerta = await corrida(Date.now() - 2 * 3_600_000, { casosTotal: 3, casosHechos: 0, repeticiones: 1 });
    const { corridaId } = await ana.como.mutation(api.evaluacion.datos.evaluarAhora, {});
    expect(corridaId).not.toBe(muerta);
    expect(await t.run((ctx) => ctx.db.get(muerta))).toMatchObject({ estado: "error", error: "La evaluación no terminó en el tiempo previsto." });
    expect((await t.run((ctx) => ctx.db.get(muerta)))?.casoActual).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(muerta)))?.terminadoEn).toBeTypeOf("number");
    expect(await t.run((ctx) => ctx.db.get(corridaId))).toMatchObject({ estado: "running", casosTotal: 1 });
    await t.finishAllScheduledFunctions(() => {}, 200);
  });
});

describe("borrado de la cuenta", () => {
  test("usuarios.borrar retira preguntas, generaciones, corridas y resultados de esa cuenta y de ninguna otra", async () => {
    const t = convexTest(schema, modules);
    const admin = await alta(t, "admin@airobotix.net", "admin");
    const ana = await alta(t, "ana@alzheimerproject.com");
    const beto = await alta(t, "beto@alzheimerproject.com");
    await corridaCon(t, ana.id);
    await corridaCon(t, beto.id);
    for (let i = 2; i <= 12; i++) await caso(t, ana.id, `single_hop-${String(i).padStart(3, "0")}`, "propuesto");
    await t.run(async (ctx) => {
      await ctx.db.insert("evaluacionGeneraciones", { propietario: ana.id, empezadoEn: 1, estado: "ok", objetivo: 5, generados: 5, descartados: 0 });
      await ctx.db.insert("evaluacionGeneraciones", { propietario: beto.id, empezadoEn: 1, estado: "ok", objetivo: 5, generados: 5, descartados: 0 });
    });

    await admin.como.mutation(api.usuarios.borrar, { userId: ana.id });
    await t.finishAllScheduledFunctions(() => {}, 200);

    const restantes = await t.run(async (ctx) => ({
      casos: await ctx.db.query("evaluacionCasos").collect(),
      generaciones: await ctx.db.query("evaluacionGeneraciones").collect(),
      corridas: await ctx.db.query("evaluacionCorridas").collect(),
      resultados: await ctx.db.query("evaluacionResultados").collect(),
    }));
    for (const filas of Object.values(restantes)) {
      expect(filas.length).toBeGreaterThan(0);
      expect(filas.every((f) => f.propietario === beto.id)).toBe(true);
    }
    expect(await t.run((ctx) => ctx.db.get(ana.id))).toBeNull();
  });

  test("borrarRastroDeUsuario va por lotes y se reagenda hasta vaciar", async () => {
    const t = convexTest(schema, modules);
    const ana = await alta(t, "ana@alzheimerproject.com");
    // Más filas que un lote (500) en una sola tabla: hace falta más de una vuelta.
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("evaluacionCasos", {
          propietario: ana.id, clave: `c-${i}`, pregunta: "p", modo: "normal", categoria: "single_hop", critico: true,
          respuestaEsperada: "r", definicion: {}, estado: "propuesto", origen: "generado", creadoEn: i,
        });
      }
    });
    await t.mutation(internal.evaluacion.datos.borrarRastroDeUsuario, { propietario: ana.id });
    const trasPrimera = await t.run((ctx) => ctx.db.query("evaluacionCasos").collect());
    expect(trasPrimera.length).toBe(20);
    await t.finishAllScheduledFunctions(() => {}, 50);
    expect(await t.run((ctx) => ctx.db.query("evaluacionCasos").collect())).toEqual([]);
  });
});
