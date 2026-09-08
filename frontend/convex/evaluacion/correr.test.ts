/// <reference types="vite/client" />
// La corrida encadenada (correr.ts) con convex-test: base en memoria, el
// agente REAL sustituido por una acción que escribe en el turno lo que cada
// test decida, y el sondeo del turno acelerado. Nada de red.
//
// Lo que se intenta romper: que la conversación oculta se vea o cuente; que un
// turno en error o que no llega pare la corrida; que `repartir` lance dos
// corridas seguidas; que el barrido cierre lo que no debe; que la cadena siga
// escribiendo sobre una corrida ya cerrada.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { CLAVE_PREGUNTAS, clavePreguntasDe, claveSesionesDe } from "../contadores";
import {
  CORRIDA_COLGADA_MIN_MS,
  ESPERA_TURNO_MS,
  INTERVALO_PROGRAMADA_MS,
  INTERVALO_SONDEO_MS,
  TURNO_MAX_MS,
  configurarEspera,
  corridaColgada,
  limiteDeCorrida,
} from "./correr";

// Patrón ABSOLUTO desde la raíz del proyecto: con uno relativo, Vite devuelve
// "./correr.ts" para los ficheros de este directorio y convex-test no los
// encuentra (ver ingesta/pipeline.test.ts).
const modules = import.meta.glob("/convex/**/*.*s");

type T = TestConvex<typeof schema>;
type Cambios = Record<string, unknown>;

// El agente de verdad hablaría con el gateway. Aquí `correr` es una acción que
// pregunta al test qué escribir en el turno y lo escribe por el MISMO camino
// que el agente real (`mensajes.actualizarTurno`); si el test no responde
// nada, el turno se queda en `pensando`, que es lo que pasa cuando el agente
// muere sin cerrar.
const agente = vi.hoisted(() => ({
  responder: null as null | ((args: { texto: string; messageId: string }) => Promise<Cambios | null> | Cambios | null),
}));
vi.mock("../agente/bucle", async () => {
  const { internalAction } = await import("../_generated/server");
  const { internal } = await import("../_generated/api");
  return {
    correr: internalAction(async (ctx, args: { texto: string; messageId: Id<"messages"> }) => {
      const cambios = agente.responder ? await agente.responder(args) : null;
      if (!cambios) return;
      await ctx.runMutation(internal.mensajes.actualizarTurno, { messageId: args.messageId, cambios });
    }),
  };
});

const PREGUNTA_AUC = "¿Cuál es el AUC de p-tau217 para detectar Alzheimer?";
const PREGUNTA_AUSENTE = "¿Qué dosis de donanemab se usó?";

/** Lo que escribiría el agente en un turno correcto sobre a.pdf, con los
 *  candidatos de la recuperación y el resumen del verificador en la
 *  telemetría, tal como los deja bucle.ts. */
function turnoCorrecto(): Cambios {
  return {
    estado: "listo",
    content: "El AUC de p-tau217 fue 0,94 [a.pdf, pág. 3].",
    sources: [{ source_file: "a.pdf", page: 3, source_pages: [3], section: "Results", locator: "pág. 3", citation: "" }],
    hops: [{ query: PREGUNTA_AUC }],
    plan: [],
    metrics: {
      ms_total: 1200,
      cost_usd: 0.01,
      meta: {
        recuperacion: { e0: [{ f: "ruido.pdf", p: 1, loc: "pág. 1" }, { f: "a.pdf", p: 3, loc: "pág. 3" }] },
        verificacion: { fidelidad: 1, no_sostenidas: 0, sin_verificar: 0, entidad_distinta: 0 },
      },
    },
  };
}

function turnoAbstencion(): Cambios {
  return {
    estado: "listo",
    content: "No encuentro esa información en los documentos.",
    sources: [],
    hops: [{ query: PREGUNTA_AUSENTE }],
    plan: [],
    metrics: { ms_total: 800, cost_usd: 0.005, meta: { recuperacion: {} } },
  };
}

function turnoError(): Cambios {
  return { estado: "error", error: "El asistente falló" };
}

/** Responde bien a las dos preguntas del arnés. */
function agenteQueAcierta(args: { texto: string }): Cambios {
  return args.texto === PREGUNTA_AUC ? turnoCorrecto() : turnoAbstencion();
}

const DEF_AUC = {
  question: PREGUNTA_AUC,
  mode: "normal",
  category: "single_hop",
  critical: true,
  min_hops: 1,
  evidence: [{ id: "ev-1", description: "el AUC", sources: [{ file: "a.pdf", pages: [3] }] }],
  answer_must_contain: ["0[.,]94"],
  expect_abstention: false,
};
const DEF_AUSENTE = {
  question: PREGUNTA_AUSENTE,
  mode: "normal",
  category: "abstencion",
  critical: true,
  min_hops: 1,
  evidence: [],
  expect_abstention: true,
};

async function alta(t: T, email = "ana@alzheimerproject.com"): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { email, rol: "lector", bloqueado: false, creadoEn: Date.now(), ultimoAccesoEn: Date.now() }),
  );
}

async function caso(
  t: T,
  propietario: Id<"users">,
  clave: string,
  definicion: Record<string, unknown>,
  estado: "propuesto" | "aprobado" | "descartado" = "aprobado",
): Promise<Id<"evaluacionCasos">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("evaluacionCasos", {
      propietario,
      clave,
      pregunta: String(definicion.question),
      modo: definicion.mode === "extendido" ? "extendido" : "normal",
      categoria: String(definicion.category),
      critico: true,
      respuestaEsperada: "lo que sea",
      definicion,
      estado,
      origen: "generado",
      creadoEn: Date.now(),
    }),
  );
}

async function tablas(t: T) {
  return await t.run(async (ctx) => ({
    sesiones: await ctx.db.query("sessions").collect(),
    mensajes: await ctx.db.query("messages").collect(),
    contadores: await ctx.db.query("contadores").collect(),
    corridas: await ctx.db.query("evaluacionCorridas").collect(),
    resultados: await ctx.db.query("evaluacionResultados").collect(),
  }));
}

/** Deja correr la cadena entera. El perro guardián de cada turno queda
 *  agendado a 630 s reales y nunca dispara: convex-test lo salta tras unos
 *  turnos ociosos, así que esto termina en cuanto la cadena termina. */
async function terminar(t: T) {
  await t.finishAllScheduledFunctions(() => {}, 500);
}

beforeEach(() => {
  // Sondeo cada 5 ms y como mucho 2 s por turno: el agente falso responde al
  // instante, y un turno que no llega no debe costar 570 s de test.
  configurarEspera({ intervaloMs: 5, maxMs: 2_000 });
  agente.responder = agenteQueAcierta;
});

afterEach(() => {
  configurarEspera({ intervaloMs: INTERVALO_SONDEO_MS, maxMs: ESPERA_TURNO_MS });
  agente.responder = null;
  vi.restoreAllMocks();
});

describe("la corrida de punta a punta", () => {
  test("responde cada caso aprobado en una conversación oculta, lo puntúa, resume y no deja rastro", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", DEF_AUC);
    await caso(t, propietario, "abstencion-001", DEF_AUSENTE);
    await caso(t, propietario, "single_hop-002", DEF_AUC, "propuesto");

    // Mientras el agente falso "responde", la conversación oculta EXISTE, y ni
    // se lista ni cuenta. Se mira desde dentro del propio agente, que es el
    // único momento en que está viva.
    const vistas: Array<{ listadas: number; ocultas: number; preguntas: number }> = [];
    agente.responder = async (args) => {
      const listadas = await t.withIdentity({ subject: propietario }).query(api.sesiones.listar, {});
      const ocultas = await t.run(async (ctx) => (await ctx.db.query("sessions").collect()).filter((s) => s.oculta).length);
      const preguntas = await t.run(async (ctx) =>
        (await ctx.db.query("contadores").withIndex("porClave", (q) => q.eq("clave", CLAVE_PREGUNTAS)).unique())?.valor ?? 0,
      );
      vistas.push({ listadas: listadas.length, ocultas, preguntas });
      return agenteQueAcierta(args);
    };

    const corridaId = await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 1 });
    expect(corridaId).not.toBeNull();
    await terminar(t);

    const corrida = await t.run((ctx) => ctx.db.get(corridaId!));
    expect(corrida).toMatchObject({ estado: "ok", casosTotal: 2, casosHechos: 2, disparo: "manual", repeticiones: 1 });
    expect(corrida?.casoActual).toBeUndefined();
    expect(corrida?.terminadoEn).toBeTypeOf("number");
    const resumen = corrida?.resumen as Record<string, unknown>;
    expect(resumen).toMatchObject({ cases: 2, passed: 2, pass_rate: 1, release_gate_passed: true, mean_retrieval_mrr: 0.5 });
    expect(resumen.by_category).toEqual({ single_hop: { total: 1, passed: 1 }, abstencion: { total: 1, passed: 1 } });

    const { sesiones, mensajes, contadores, resultados } = await tablas(t);
    // Se vio viva y oculta dos veces (una por caso), nunca listada ni contada.
    expect(vistas).toEqual([
      { listadas: 0, ocultas: 1, preguntas: 0 },
      { listadas: 0, ocultas: 1, preguntas: 0 },
    ]);
    expect(sesiones).toEqual([]);
    expect(mensajes).toEqual([]);
    expect(contadores).toEqual([]);
    expect(resultados.map((r) => r.clave).sort()).toEqual(["abstencion-001", "single_hop-001"]);
    const auc = resultados.find((r) => r.clave === "single_hop-001")!;
    expect(auc.puntuacion).toMatchObject({ passed: true, runs: 1, metrics: { retrieval_mrr: 0.5, evidence_recall: 1 } });
    expect(auc.corridas).toHaveLength(1);
    expect(auc.corridas[0]).toMatchObject({
      respuesta: "El AUC de p-tau217 fue 0,94 [a.pdf, pág. 3].",
      fuentes: [{ source_file: "a.pdf", page: 3, section: "Results", locator: "pág. 3" }],
      fallos: [],
      ms: 1200,
      coste: 0.01,
      error: null,
    });
    // La respuesta guardada no arrastra el snippet ni los hops: solo lo recortado.
    expect(Object.keys(auc.corridas[0].fuentes[0]).sort()).toEqual(["locator", "page", "section", "source_file"]);
  });

  test("ADVERSARIAL: un turno que acaba en error puntúa como fallo y la corrida sigue con el siguiente caso", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", DEF_AUC);
    await caso(t, propietario, "abstencion-001", DEF_AUSENTE);
    agente.responder = (args) => (args.texto === PREGUNTA_AUC ? turnoError() : turnoAbstencion());

    const corridaId = await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 1 });
    await terminar(t);

    const corrida = await t.run((ctx) => ctx.db.get(corridaId!));
    expect(corrida).toMatchObject({ estado: "ok", casosHechos: 2 });
    expect(corrida?.error).toBeUndefined();
    expect(corrida?.resumen).toMatchObject({ cases: 2, passed: 1, release_gate_passed: false, critical_failures: ["single_hop-001"] });
    const { resultados, sesiones, mensajes } = await tablas(t);
    const fallido = resultados.find((r) => r.clave === "single_hop-001")!;
    expect(fallido.puntuacion.passed).toBe(false);
    expect(fallido.puntuacion.failures).toContain("error de ejecución: El asistente falló");
    expect(fallido.corridas[0].error).toBe("El asistente falló");
    expect(resultados.find((r) => r.clave === "abstencion-001")!.puntuacion.passed).toBe(true);
    // La conversación del turno fallido también se borró.
    expect(sesiones).toEqual([]);
    expect(mensajes).toEqual([]);
  });

  test("ADVERSARIAL: un turno que nunca llega se puntúa como 'no terminó', se borra su conversación y la corrida sigue", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", DEF_AUC);
    await caso(t, propietario, "abstencion-001", DEF_AUSENTE);
    configurarEspera({ intervaloMs: 5, maxMs: 60 });
    // El agente no escribe nada en la primera pregunta: el turno se queda en `pensando`.
    agente.responder = (args) => (args.texto === PREGUNTA_AUC ? null : turnoAbstencion());

    const corridaId = await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 1 });
    await terminar(t);

    const corrida = await t.run((ctx) => ctx.db.get(corridaId!));
    expect(corrida?.estado).toBe("ok");
    const { resultados, sesiones, mensajes } = await tablas(t);
    const colgado = resultados.find((r) => r.clave === "single_hop-001")!;
    expect(colgado.puntuacion.passed).toBe(false);
    expect(colgado.puntuacion.failures.some((f: string) => /no terminó en \d+ s \(estado: pensando\)/.test(f))).toBe(true);
    expect(sesiones).toEqual([]);
    expect(mensajes).toEqual([]);
  });

  test("con 3 repeticiones acumula las corridas crudas en una sola fila, agrega por mayoría y solo cuenta el caso al terminar la última", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", DEF_AUC);
    let vez = 0;
    const hechosVistos: number[] = [];
    agente.responder = async () => {
      vez += 1;
      const c = (await t.run((ctx) => ctx.db.query("evaluacionCorridas").first()))!;
      hechosVistos.push(c.casosHechos);
      return vez === 2 ? turnoError() : turnoCorrecto();
    };

    const corridaId = await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 3 });
    await terminar(t);

    expect(hechosVistos).toEqual([0, 0, 0]);
    const corrida = await t.run((ctx) => ctx.db.get(corridaId!));
    expect(corrida).toMatchObject({ estado: "ok", casosHechos: 1, casosTotal: 1, repeticiones: 3 });
    const { resultados } = await tablas(t);
    expect(resultados).toHaveLength(1);
    const fila = resultados[0];
    expect(fila.corridas).toHaveLength(3);
    expect(fila.corridas.map((r: { error: string | null }) => r.error)).toEqual([null, "El asistente falló", null]);
    expect(fila.puntuacion).toMatchObject({ passed: true, runs: 3, passed_rate: 0.6667 });
    // La repetición en error arrastra sus fallos (sin evidencia, sin citas...),
    // todos con frecuencia 1 de 3; ninguno con 2 o más.
    expect(fila.puntuacion.failures).toContain("error de ejecución (1/3 corridas): El asistente falló");
    expect(fila.puntuacion.failures.every((f: string) => f.includes("(1/3 corridas)"))).toBe(true);
    expect(fila.resultado).toMatchObject({ runs: 3, errors: ["El asistente falló"] });
    expect(corrida?.resumen).toMatchObject({ cases: 1, passed: 1, runs_total: 3, run_pass_rate: 0.6667, unstable_cases: ["single_hop-001"] });
  });

  test("un caso borrado a mitad de la corrida se salta sin parar la cadena", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    const borrado = await caso(t, propietario, "single_hop-001", DEF_AUC);
    const vivo = await caso(t, propietario, "abstencion-001", DEF_AUSENTE);
    const corridaId = await t.run((ctx) =>
      ctx.db.insert("evaluacionCorridas", {
        propietario, empezadoEn: Date.now(), estado: "running", disparo: "manual",
        casosTotal: 2, casosHechos: 0, repeticiones: 1, versionPrompt: "v4", modelo: "m",
      }),
    );
    await t.run((ctx) => ctx.db.delete(borrado));
    await t.action(internal.evaluacion.correr.paso, { corridaId, casos: [borrado, vivo], indice: 0, rep: 1 });
    await terminar(t);
    const corrida = await t.run((ctx) => ctx.db.get(corridaId));
    expect(corrida).toMatchObject({ estado: "ok", casosHechos: 2 });
    const { resultados } = await tablas(t);
    expect(resultados.map((r) => r.clave)).toEqual(["abstencion-001"]);
  });

  test("ADVERSARIAL: una corrida ya cerrada por el barrido no recibe más escrituras ni abre conversaciones", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    const casoId = await caso(t, propietario, "single_hop-001", DEF_AUC);
    const corridaId = await t.run((ctx) =>
      ctx.db.insert("evaluacionCorridas", {
        propietario, empezadoEn: Date.now(), estado: "error", error: "cerrada", disparo: "manual",
        casosTotal: 1, casosHechos: 0, repeticiones: 1, versionPrompt: "v4", modelo: "m",
      }),
    );
    await t.action(internal.evaluacion.correr.paso, { corridaId, casos: [casoId], indice: 0, rep: 1 });
    await terminar(t);
    const { sesiones, resultados, corridas } = await tablas(t);
    expect(sesiones).toEqual([]);
    expect(resultados).toEqual([]);
    expect(corridas[0]).toMatchObject({ estado: "error", error: "cerrada", casosHechos: 0 });
  });

  test("un caso cuya definición ya no valida se puntúa como error con el motivo, sin lanzar al agente", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", { ...DEF_AUC, evidence: [] });
    let llamadas = 0;
    agente.responder = () => {
      llamadas += 1;
      return turnoCorrecto();
    };
    const corridaId = await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 1 });
    await terminar(t);
    expect(llamadas).toBe(0);
    const { resultados } = await tablas(t);
    expect(resultados[0].puntuacion.passed).toBe(false);
    expect(resultados[0].puntuacion.failures.some((f: string) => f.includes("no está bien definida"))).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(corridaId!)))?.estado).toBe("ok");
  });

  test("iniciar sin casos aprobados no crea nada", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    await caso(t, propietario, "single_hop-001", DEF_AUC, "propuesto");
    expect(await t.mutation(internal.evaluacion.correr.iniciar, { propietario, disparo: "manual", repeticiones: 1 })).toBeNull();
    expect((await tablas(t)).corridas).toEqual([]);
  });
});

describe("la conversación oculta", () => {
  test("lanzar crea una conversación oculta que `sesiones.listar` no devuelve y que no toca contadores; borrarla tampoco", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    const casoId = await caso(t, propietario, "single_hop-001", DEF_AUC);
    const corridaId = await t.run((ctx) =>
      ctx.db.insert("evaluacionCorridas", {
        propietario, empezadoEn: Date.now(), estado: "running", disparo: "manual",
        casosTotal: 1, casosHechos: 0, repeticiones: 1, versionPrompt: "v4", modelo: "m",
      }),
    );
    // Contadores previos de la cuenta, para comprobar que ni suben ni bajan.
    await t.run(async (ctx) => {
      await ctx.db.insert("contadores", { clave: CLAVE_PREGUNTAS, valor: 7 });
      await ctx.db.insert("contadores", { clave: clavePreguntasDe(propietario), valor: 3 });
      await ctx.db.insert("contadores", { clave: claveSesionesDe(propietario), valor: 2 });
    });
    // Una conversación normal de la usuaria, para ver que ESA sí se lista.
    const visible = await t.run((ctx) => ctx.db.insert("sessions", { titulo: "Mi consulta", userId: propietario, creadoEn: 1 }));
    // El agente falso no escribe: la conversación se queda viva para mirarla.
    agente.responder = null;

    const { sessionId, messageId } = await t.mutation(internal.evaluacion.correr.lanzar, { corridaId, casoId });
    await t.finishInProgressScheduledFunctions();
    const listadas = await t.withIdentity({ subject: propietario }).query(api.sesiones.listar, {});
    expect(listadas.map((s) => s._id)).toEqual([visible]);
    const sesion = await t.run((ctx) => ctx.db.get(sessionId));
    expect(sesion).toMatchObject({ oculta: true, userId: propietario, titulo: PREGUNTA_AUC.slice(0, 60) });
    const mensajes = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("porSesionYCreacion", (q) => q.eq("sessionId", sessionId)).collect(),
    );
    expect(mensajes.map((m) => [m.role, m.estado ?? null])).toEqual([["user", null], ["assistant", "pensando"]]);
    expect(mensajes[1]._id).toBe(messageId);
    expect((await t.run((ctx) => ctx.db.get(corridaId)))?.casoActual).toBe("single_hop-001");
    const contadores = async () =>
      Object.fromEntries((await t.run((ctx) => ctx.db.query("contadores").collect())).map((c) => [c.clave, c.valor]));
    expect(await contadores()).toEqual({ [CLAVE_PREGUNTAS]: 7, [clavePreguntasDe(propietario)]: 3, [claveSesionesDe(propietario)]: 2 });

    expect(await t.mutation(internal.evaluacion.correr.borrarSesionOculta, { sessionId })).toEqual({ borrada: true });
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
    expect(await contadores()).toEqual({ [CLAVE_PREGUNTAS]: 7, [clavePreguntasDe(propietario)]: 3, [claveSesionesDe(propietario)]: 2 });
    // Idempotente.
    expect(await t.mutation(internal.evaluacion.correr.borrarSesionOculta, { sessionId })).toEqual({ borrada: false });
    // Y la conversación visible sigue ahí.
    expect(await t.run((ctx) => ctx.db.get(visible))).not.toBeNull();
  });
});

describe("cron", () => {
  async function conCasos(t: T, email: string, n: number, estado: "aprobado" | "propuesto" = "aprobado") {
    const propietario = await alta(t, email);
    for (let i = 1; i <= n; i++) await caso(t, propietario, `abstencion-${String(i).padStart(3, "0")}`, DEF_AUSENTE, estado);
    return propietario;
  }

  test("ADVERSARIAL: repartir no lanza dos corridas seguidas para el mismo propietario, ni para quien tiene menos de 5 casos", async () => {
    const t = convexTest(schema, modules);
    const ahora = Date.now();
    const conCinco = await conCasos(t, "cinco@alzheimerproject.com", 5);
    await conCasos(t, "cuatro@alzheimerproject.com", 4);
    const soloPropuestos = await conCasos(t, "propuestos@alzheimerproject.com", 6, "propuesto");
    agente.responder = () => turnoAbstencion();

    expect(await t.mutation(internal.evaluacion.correr.repartir, { ahora })).toEqual({ agendadas: 1 });
    // Segunda pasada inmediata: la corrida sigue en marcha, no se duplica.
    expect(await t.mutation(internal.evaluacion.correr.repartir, { ahora })).toEqual({ agendadas: 0 });
    await terminar(t);
    let corridas = (await tablas(t)).corridas;
    expect(corridas).toHaveLength(1);
    expect(corridas[0]).toMatchObject({ propietario: conCinco, disparo: "programada", repeticiones: 1, estado: "ok", casosHechos: 5 });
    expect(corridas.some((c) => c.propietario === soloPropuestos)).toBe(false);

    // Un día después: terminada, pero reciente. Siete días después: toca otra.
    expect(await t.mutation(internal.evaluacion.correr.repartir, { ahora: ahora + 86_400_000 })).toEqual({ agendadas: 0 });
    expect(await t.mutation(internal.evaluacion.correr.repartir, { ahora: ahora + INTERVALO_PROGRAMADA_MS + 3_600_000 })).toEqual({ agendadas: 1 });
    await terminar(t);
    corridas = (await tablas(t)).corridas;
    expect(corridas).toHaveLength(2);
    expect(corridas.every((c) => c.propietario === conCinco)).toBe(true);
  });

  test("el tope de una corrida crece con su trabajo: nunca baja de 1 h y una corrida grande y sana no lo supera", () => {
    const H = 3_600_000;
    // Recién empezada, una repetición: el suelo de una hora.
    expect(limiteDeCorrida({ casosHechos: 0, repeticiones: 1 })).toBe(CORRIDA_COLGADA_MIN_MS);
    // Con el caso 25 (0-based 24) en marcha y 3 repeticiones: 75 turnos de 15 min.
    expect(limiteDeCorrida({ casosHechos: 24, repeticiones: 3 })).toBe(75 * TURNO_MAX_MS);
    // El escenario del revisor: 25 casos x 3 repeticiones x 5 min de turno
    // extendido son 6,25 h de corrida SANA. Con el tope fijo de 4 h se cerraba.
    const sana = { estado: "running", empezadoEn: 0, casosHechos: 24, repeticiones: 3 };
    expect(corridaColgada(sana, 6.25 * H)).toBe(false);
    expect(corridaColgada(sana, 18 * H)).toBe(false);
    expect(corridaColgada(sana, 19 * H)).toBe(true);
    // Una que murió sin avanzar se detecta en cuanto pasa el suelo.
    const muerta = { estado: "running", empezadoEn: 0, casosHechos: 0, repeticiones: 1 };
    expect(corridaColgada(muerta, CORRIDA_COLGADA_MIN_MS)).toBe(false);
    expect(corridaColgada(muerta, CORRIDA_COLGADA_MIN_MS + 1)).toBe(true);
    // Terminada: nunca colgada, lleve lo que lleve.
    expect(corridaColgada({ ...sana, estado: "ok" }, 100 * H)).toBe(false);
    // Repeticiones absurdas no rompen el cálculo.
    expect(limiteDeCorrida({ casosHechos: 0, repeticiones: 0 })).toBe(CORRIDA_COLGADA_MIN_MS);
  });

  test("ADVERSARIAL: cerrarColgadas respeta una corrida grande que avanza (5 h con 30 de 60 casos y 3 repeticiones) y cierra la que dejó de avanzar", async () => {
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    // El reloj del test va 5 h por delante del real, porque `_creationTime`
    // no se puede fijar al insertar: así una fila insertada ahora queda
    // dentro de la ventana que mira el barrido.
    const ahora = Date.now() + 5 * 3_600_000;
    const fila = (empezadoEn: number, estado: "running" | "ok", avance: { casosTotal: number; casosHechos: number; repeticiones: number }) =>
      t.run((ctx) =>
        ctx.db.insert("evaluacionCorridas", {
          propietario, empezadoEn, estado, disparo: "manual", ...avance, casoActual: "x", versionPrompt: "v4", modelo: "m",
        }),
      );
    // El escenario del revisor: 5 h de vida, a mitad y avanzando. Antes se cerraba como error.
    const grande = await fila(ahora - 5 * 3_600_000, "running", { casosTotal: 60, casosHechos: 30, repeticiones: 3 });
    // Muerta: 2 h sin terminar ni un caso con una sola repetición.
    const muerta = await fila(ahora - 2 * 3_600_000, "running", { casosTotal: 3, casosHechos: 0, repeticiones: 1 });
    // Reciente: media hora, por debajo del suelo.
    const reciente = await fila(ahora - 1_800_000, "running", { casosTotal: 3, casosHechos: 0, repeticiones: 1 });
    const terminada = await fila(ahora - 5 * 3_600_000, "ok", { casosTotal: 3, casosHechos: 3, repeticiones: 1 });

    expect(await t.mutation(internal.evaluacion.correr.cerrarColgadas, { ahora })).toEqual({ cerradas: 1 });
    expect(await t.run((ctx) => ctx.db.get(muerta))).toMatchObject({
      estado: "error", error: "La evaluación no terminó en el tiempo previsto.", terminadoEn: ahora, casosHechos: 0,
    });
    expect((await t.run((ctx) => ctx.db.get(muerta)))?.casoActual).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(grande))).toMatchObject({ estado: "running", casosHechos: 30, casoActual: "x" });
    expect(await t.run((ctx) => ctx.db.get(reciente))).toMatchObject({ estado: "running", casoActual: "x" });
    expect(await t.run((ctx) => ctx.db.get(terminada))).toMatchObject({ estado: "ok" });
    // Idempotente.
    expect(await t.mutation(internal.evaluacion.correr.cerrarColgadas, { ahora })).toEqual({ cerradas: 0 });
    // Y la grande, cuando lleva más de lo que 31 casos x 3 repeticiones pueden
    // durar (23,25 h), sí se cierra; la "reciente" a esas alturas lleva 19,5 h
    // sin terminar un caso y cae también.
    const masTarde = ahora + 19 * 3_600_000;
    expect(await t.mutation(internal.evaluacion.correr.cerrarColgadas, { ahora: masTarde })).toEqual({ cerradas: 2 });
    expect(await t.run((ctx) => ctx.db.get(grande))).toMatchObject({ estado: "error", terminadoEn: masTarde });
    expect(await t.run((ctx) => ctx.db.get(reciente))).toMatchObject({ estado: "error", terminadoEn: masTarde });
  });

  test("ADVERSARIAL: la cadena que despierta tras el barrido no reescribe una corrida ya cerrada", async () => {
    // Una corrida cerrada por el barrido y un `paso` rezagado que llega
    // después: `cerrarCorrida`, `avanzarCorrida` y `marcarError` exigen
    // `running`, así que ninguno debe tocar la fila.
    const t = convexTest(schema, modules);
    const propietario = await alta(t);
    const casoId = await caso(t, propietario, "single_hop-001", DEF_AUC);
    const ahora = Date.now() + 5 * 3_600_000;
    const corridaId = await t.run((ctx) =>
      ctx.db.insert("evaluacionCorridas", {
        propietario, empezadoEn: ahora - 2 * 3_600_000, estado: "running", disparo: "manual",
        casosTotal: 1, casosHechos: 0, repeticiones: 1, versionPrompt: "v4", modelo: "m",
      }),
    );
    expect(await t.mutation(internal.evaluacion.correr.cerrarColgadas, { ahora })).toEqual({ cerradas: 1 });
    await t.mutation(internal.evaluacion.correr.avanzarCorrida, { corridaId, casosHechos: 1 });
    await t.mutation(internal.evaluacion.correr.cerrarCorrida, { corridaId });
    await t.mutation(internal.evaluacion.correr.marcarError, { corridaId, error: "otro" });
    await t.action(internal.evaluacion.correr.paso, { corridaId, casos: [casoId], indice: 1, rep: 1 });
    await terminar(t);
    expect(await t.run((ctx) => ctx.db.get(corridaId))).toMatchObject({
      estado: "error", error: "La evaluación no terminó en el tiempo previsto.", casosHechos: 0, terminadoEn: ahora,
    });
    expect((await t.run((ctx) => ctx.db.get(corridaId)))?.resumen).toBeUndefined();
  });
});
