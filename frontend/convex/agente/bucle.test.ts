// El bucle del agente, probado para ROMPERLO, no para confirmarlo. Cada caso
// le hace al bucle lo que el modelo, la base o el reloj le pueden hacer en
// producción: argumentos JSON rotos, llamadas repetidas, tope ignorado, base
// caída a mitad, revisor que lanza, presupuesto agotado antes de empezar.
//
// Sin red: cada colaborador (planner, evidencia, revisor, verificador y el
// gateway) va parcheado sobre su módulo importado como namespace, que es como
// lo llama bucle.ts, y `fetch` está prohibido por si alguno se escapa. La
// acción se ejecuta de dos formas: por `t.action` (el camino real, con
// validación de argumentos) y llamando al handler con un `ctx` propio, que
// es la única manera de ver la SECUENCIA de escrituras y de hacer fallar una
// concreta.
//
// Los casos que destapan un fallo real quedan como `test.fails`, con la línea
// de bucle.ts y el arreglo en el nombre o en el comentario: si alguien lo
// arregla, el test pasa a fallar y avisa de que hay que promoverlo a `test`.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import * as gateway from "../lib/gateway";
import type { Fragmento } from "../lib/citas";
import { EXTENDIDO, NORMAL } from "../lib/modos";
import type { ModoRecuperacion } from "../search/hybrid";
import type { Grado } from "./calificador";
import * as planner from "./planner";
import type { PuntoPlan } from "./planner";
import * as evidencia from "./evidencia";
import * as verificador from "./verificador";
import type { CoberturaPunto, Verificacion } from "./verificador";
import * as revisor from "./revisor";
import { correr } from "./bucle";
import {
  HERRAMIENTAS,
  INSTRUCCION_SIN_DOCUMENTOS,
  NOMBRE_BUSCAR,
  NOMBRE_INVENTARIO,
  SYSTEM_PROMPT,
} from "./prompt";

// ---------------------------------------------------------------------------
// Arnés
// ---------------------------------------------------------------------------
type Base = ReturnType<typeof convexTest>;
type Trozo = gateway.TrozoStream;
type Kwargs = Record<string, unknown>;
type Mensaje = Record<string, unknown>;
type Hop = Record<string, unknown>;
type Fuente = Record<string, unknown>;

interface Ids {
  messageId: Id<"messages">;
  sessionId: Id<"sessions">;
  userId: Id<"users">;
}
interface ArgsCorrer extends Ids {
  texto: string;
  modo: string;
  historial: { role: string; content: string }[];
}
interface Metrics {
  rondas: number;
  counters: Record<string, number>;
  meta: Record<string, any>;
  por_componente: Record<string, Record<string, number>>;
}

const PREGUNTA = "¿Cuál es el AUC de p-tau217 para detectar Alzheimer?";
const RESPUESTA = "El AUC de p-tau217 fue 0,94 [a.pdf, pág. 3].";
const USO = { prompt: 100, cached: 0, completion: 20, reasoning: 5 };

function nuevaBase(): Base {
  return convexTest(schema);
}

/** Usuario, conversación, pregunta y el mensaje del asistente en `pensando`,
 *  tal como los deja `mensajes.enviar` antes de agendar al agente. */
async function sembrar(t: Base, texto = PREGUNTA): Promise<Ids> {
  return await t.run(async (ctx) => {
    const ahora = Date.now();
    const userId = await ctx.db.insert("users", {
      email: "ana@airobotix.net",
      rol: "lector",
      bloqueado: false,
      creadoEn: ahora,
      ultimoAccesoEn: ahora,
    });
    const sessionId = await ctx.db.insert("sessions", { titulo: texto.slice(0, 60), userId, creadoEn: ahora });
    await ctx.db.insert("messages", { sessionId, userId, role: "user", content: texto, creadoEn: ahora });
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      userId,
      role: "assistant",
      content: "",
      estado: "pensando",
      creadoEn: ahora + 1,
    });
    return { userId, sessionId, messageId };
  });
}

async function fila(t: Base, messageId: Id<"messages">): Promise<Doc<"messages">> {
  const m = await t.run(async (ctx) => ctx.db.get(messageId));
  if (!m) throw new Error("el mensaje del asistente desapareció");
  return m;
}

function argsDe(ids: Ids, extra: Partial<Omit<ArgsCorrer, keyof Ids>> = {}): ArgsCorrer {
  return { ...ids, texto: PREGUNTA, modo: "normal", historial: [], ...extra };
}

/** El camino real: la acción por convex-test, con validación de argumentos. */
async function correrEn(t: Base, ids: Ids, extra: Partial<Omit<ArgsCorrer, keyof Ids>> = {}) {
  await t.action(internal.agente.bucle.correr, argsDe(ids, extra));
  return await fila(t, ids.messageId);
}

// El handler a pelo, con un `ctx` propio. Convex cuelga el handler original
// en `_handler` (es lo que convex-test resuelve también), así que se puede
// invocar con un `runMutation` que registre cada escritura y falle a demanda.
type Handler = (ctx: ActionCtx, args: ArgsCorrer) => Promise<void>;
const handlerDirecto = (correr as unknown as { _handler: Handler })._handler;

function ctxDirecto(t: Base, opciones: { falla?: (n: number) => boolean; inventarioRoto?: boolean } = {}) {
  const escrituras: Array<Record<string, unknown>> = [];
  const base = t as unknown as {
    mutation: (ref: unknown, args: unknown) => Promise<unknown>;
    query: (ref: unknown, args: unknown) => Promise<unknown>;
  };
  const ctx = {
    runMutation: async (ref: unknown, args: { messageId: Id<"messages">; cambios: Record<string, unknown> }) => {
      // Solo cuentan las escrituras del TURNO (actualizarTurno lleva `cambios`).
      // Otras mutaciones del bucle (la caché del plan, por ejemplo) no son
      // "avance del mensaje" y no deben mover la numeración de las fallas.
      if (!args || !("cambios" in args)) return await base.mutation(ref, args);
      escrituras.push(args.cambios);
      if (opciones.falla?.(escrituras.length)) throw new Error(`base caída en la escritura ${escrituras.length}`);
      return await base.mutation(ref, args);
    },
    runQuery: async (ref: unknown, args: unknown) => {
      if (opciones.inventarioRoto) throw new Error("inventario caído");
      return await base.query(ref, args);
    },
  } as unknown as ActionCtx;
  return { ctx, escrituras };
}

function frag(id: string, extra: Partial<Fragmento> = {}): Fragmento {
  return {
    _id: id,
    text: `texto de ${id}`,
    sourceFile: "a.pdf",
    page: 3,
    documentType: "pdf",
    chunkType: "text",
    ...extra,
  };
}

function metricasDe(m: Doc<"messages">): Metrics {
  return m.metrics as Metrics;
}
function hopsDe(m: Doc<"messages">): Hop[] {
  return m.hops as Hop[];
}
function fuentesDe(m: Doc<"messages">): Fuente[] {
  return m.sources as Fuente[];
}
function mensajesDe(kwargs: Kwargs): Mensaje[] {
  return kwargs.messages as Mensaje[];
}
/** El mensaje `tool` que respondió a una llamada concreta, tal como lo vio el modelo. */
function herramientaDe(kwargs: Kwargs, toolCallId: string): string {
  const m = mensajesDe(kwargs).find((x) => x.role === "tool" && x.tool_call_id === toolCallId);
  if (!m) throw new Error(`el modelo no recibió respuesta para ${toolCallId}`);
  return String(m.content);
}
function ultimoDe(kwargs: Kwargs): Mensaje {
  const ms = mensajesDe(kwargs);
  return ms[ms.length - 1];
}

// --- El stream del modelo, por guiones -------------------------------------
//
// Cada ronda es una lista de trozos (o una función de los kwargs que la
// produce). Un `Error` en la lista se lanza en ese punto, como un stream que
// se corta. Los kwargs se copian al entrar porque el bucle MUTA el array de
// mensajes después: sin la copia, la primera llamada "vería" los mensajes de
// la última.
type Guion = Array<Trozo | Error> | ((kwargs: Kwargs) => Array<Trozo | Error>);
let modelo: { guiones: Guion[]; porDefecto: Guion; llamadas: Kwargs[] };

function rondaTexto(texto: string): Trozo[] {
  // Partido en dos: el bucle tiene que concatenar.
  const mitad = Math.ceil(texto.length / 2);
  return [
    { texto: texto.slice(0, mitad) },
    { texto: texto.slice(mitad) },
    { finishReason: "stop" },
    { usage: USO, modelo: "openai/gpt-5.4" },
  ];
}

interface Llamada {
  id: string;
  name: string;
  arguments: string;
}
function llamadaBuscar(id: string, args: Record<string, unknown>): Llamada {
  return { id, name: NOMBRE_BUSCAR, arguments: JSON.stringify(args) };
}
/** Tool calls como llegan por el stream: primero id y nombre, luego los
 *  argumentos partidos en deltas que el bucle debe ir pegando por `index`. */
function rondaHerramientas(llamadas: Llamada[], texto = ""): Trozo[] {
  const trozos: Trozo[] = [];
  if (texto) trozos.push({ texto });
  llamadas.forEach((l, index) => {
    trozos.push({ toolCalls: [{ index, id: l.id, name: l.name, arguments: "" }] });
    const mitad = Math.ceil(l.arguments.length / 2);
    trozos.push({ toolCalls: [{ index, arguments: l.arguments.slice(0, mitad) }] });
    trozos.push({ toolCalls: [{ index, arguments: l.arguments.slice(mitad) }] });
  });
  trozos.push({ finishReason: "tool_calls" }, { usage: USO, modelo: "openai/gpt-5.4" });
  return trozos;
}

// --- Evidencia del plan, determinista ----------------------------------------
interface DatosPunto {
  fragmentos: Fragmento[];
  grados?: Record<string, Grado>;
  recuperacion?: ModoRecuperacion;
  documentosRevisados?: string[];
  relevanciaVerificada?: boolean;
}
let porPunto: Record<string, DatosPunto>;

function puntoDe(p: PuntoPlan, d: DatosPunto): evidencia.PuntoEvidencia {
  const cubierto = d.fragmentos.length > 0;
  return {
    id: p.id,
    query: p.query,
    queryEn: p.queryEn,
    evidenceNeeded: p.evidenceNeeded,
    fragmentos: d.fragmentos,
    documentosRevisados: d.documentosRevisados ?? [],
    estado: cubierto ? "cubierto" : "sin_resultados",
    relevanciaVerificada: d.relevanciaVerificada ?? cubierto,
    recuperacion: d.recuperacion ?? "hibrida",
    ms: 25,
    nCandidatos: d.fragmentos.length,
    grados: d.grados ?? Object.fromEntries(d.fragmentos.map((f) => [f._id, "directa" as Grado])),
  };
}

/** Lo que devolvería `ejecutarPlan` para este plan con `porPunto`, con el
 *  mismo post-proceso (mapa, acumulado, grados, huella). */
function evidenciaDe(plan: PuntoPlan[]): evidencia.EvidenciaPlan {
  const ev: evidencia.EvidenciaPlan = { puntos: [], mapa: {}, acumulado: new Map(), grados: {}, huella: "" };
  for (const p of plan) {
    const punto = puntoDe(p, porPunto[p.id] ?? { fragmentos: [] });
    ev.puntos.push(punto);
    for (const ch of punto.fragmentos) {
      const ids = (ev.mapa[ch._id] ??= []);
      if (!ids.includes(p.id)) ids.push(p.id);
      if (!ev.acumulado.has(ch._id)) ev.acumulado.set(ch._id, ch);
      const g = punto.grados[ch._id];
      if (g && !ev.grados[ch._id]) ev.grados[ch._id] = g;
    }
  }
  ev.huella = evidencia.huellaDe([...ev.acumulado.keys()]);
  return ev;
}

/** Resultado de una búsqueda extra, con la misma forma que devuelve
 *  `buscarYCalificar`: `evidenceNeeded || consulta` y `punto || "extra"`. */
function resultadoExtra(
  punto: string,
  consulta: string,
  fragmentos: Fragmento[],
  extra: Partial<evidencia.PuntoEvidencia> = {},
  evidenceNeeded = "",
): evidencia.PuntoEvidencia {
  const base = puntoDe(
    { id: punto || "extra", query: consulta, queryEn: "", evidenceNeeded: evidenceNeeded || consulta },
    { fragmentos, documentosRevisados: fragmentos.length ? [] : ["a.pdf"] },
  );
  return { ...base, ...extra };
}

// --- Revisión ----------------------------------------------------------------
function informeVacio(campos: Partial<Verificacion> = {}): Verificacion {
  return {
    afirmaciones: [],
    evidencia_sin_cubrir: [],
    cobertura: [],
    citas_sin_resolver: [],
    fidelidad: null,
    ok: true,
    nota: "",
    ...campos,
  };
}
function cobertura(id: string, estado: CoberturaPunto["estado"]): CoberturaPunto {
  return { id, evidence_needed: `dato ${id}`, estado, n_fragmentos: 1, documentos: ["a.pdf"], afirmaciones: [] };
}
function aprobar(borrador: string, informe = informeVacio()): revisor.ResultadoRevision {
  return { contenido: borrador, informe, revisiones: 0, usoAbstencionSegura: false, motivoAbstencion: null, informeBorrador: null, frasesEliminadas: [], publicadaTrasTope: false };
}
function abstenerse(motivo = "rechazada_tras_correccion"): revisor.ResultadoRevision {
  return {
    contenido: revisor.ABSTENCION_SEGURA,
    informe: informeVacio({ nota: "abstención" }),
    revisiones: 1,
    usoAbstencionSegura: true,
    motivoAbstencion: motivo,
    informeBorrador: informeVacio({ ok: false, nota: "el borrador no se sostenía" }),    frasesEliminadas: [],
    publicadaTrasTope: false,
  };
}

type RespuestaTexto = Awaited<ReturnType<typeof gateway.crearCompletion>>;
function respuestaTexto(texto: string | null): RespuestaTexto {
  return {
    datos: {
      model: "openai/gpt-5.4",
      choices: [{ message: { role: "assistant", content: texto }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 12 },
    },
    razonamientoRechazado: false,
  };
}

// Los tipos de los espías salen de las funciones, no del genérico de
// `vi.spyOn`, que en vitest 2.1 no admite instanciación explícita.
const espiarStream = () => vi.spyOn(gateway, "streamCompletion");
const espiarRedactor = () => vi.spyOn(gateway, "crearCompletion");
const espiarClasificar = () => vi.spyOn(planner, "clasificar");
const espiarPlanificar = () => vi.spyOn(planner, "planificar");
const espiarPlan = () => vi.spyOn(evidencia, "ejecutarPlan");
const espiarBusqueda = () => vi.spyOn(evidencia, "buscarYCalificar");
const espiarRevisar = () => vi.spyOn(revisor, "revisarAntesDePublicar");
const espiarVerificar = () => vi.spyOn(verificador, "verificar");
let stream: ReturnType<typeof espiarStream>;
let redactor: ReturnType<typeof espiarRedactor>;
let clasificar: ReturnType<typeof espiarClasificar>;
let planificar: ReturnType<typeof espiarPlanificar>;
let ejecutarPlan: ReturnType<typeof espiarPlan>;
let busqueda: ReturnType<typeof espiarBusqueda>;
let revisar: ReturnType<typeof espiarRevisar>;
let verificar: ReturnType<typeof espiarVerificar>;

// Variables que el bucle lee del entorno y que un shell de desarrollo podría
// traer puestas. Se quitan (y se restauran al final) para que el test no
// dependa de la máquina. Ojo: NO se fijan a "", porque `texto()` en config.ts
// devuelve "" tal cual (un OPENAI_MODEL vacío daría model ""), al revés que
// `numero()` y `booleano()`, que sí tratan "" como ausente.
const ENV_NEUTRO = [
  "MAX_HOPS",
  "AGENT_BUDGET_S",
  "AGENT_MAX_HOPS_SIN_AVANCE",
  "PRESUPUESTO_TOTAL_S",
  "ENABLE_QUERY_PLANNING",
  "ENABLE_ANSWER_VERIFICATION",
  "ENABLE_PRE_RESPONSE_REVIEW",
  "EVIDENCE_PREFETCH_TIMEOUT_S",
  "AGENT_REASONING_EFFORT",
  "OPENAI_MODEL",
  "LLM_TEMPERATURE",
];

const envOriginal: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_NEUTRO) {
    envOriginal[k] = process.env[k];
    delete process.env[k];
  }
  vi.stubEnv("OPENAI_API_KEY", "vck_prueba");
  gateway._reiniciarRazonamiento();

  // Nada sale a la red: si un colaborador no parcheado llegara al gateway,
  // que falle aquí con un mensaje claro y no con un timeout.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("red prohibida en los tests"));
  vi.spyOn(gateway, "completionJson").mockRejectedValue(new Error("completionJson no programado"));

  modelo = { guiones: [], porDefecto: rondaTexto(RESPUESTA), llamadas: [] };
  stream = espiarStream().mockImplementation(async function* (kwargs) {
    modelo.llamadas.push({ ...kwargs, messages: [...mensajesDe(kwargs)] });
    const guion = modelo.guiones.shift() ?? modelo.porDefecto;
    const trozos = typeof guion === "function" ? guion(kwargs) : guion;
    for (const tr of trozos) {
      if (tr instanceof Error) throw tr;
      yield tr;
    }
  });
  redactor = espiarRedactor().mockRejectedValue(new Error("crearCompletion no programado"));

  clasificar = espiarClasificar().mockResolvedValue({ clase: "documental", consulta: PREGUNTA });
  planificar = espiarPlanificar().mockResolvedValue({ items: [], preguntaEn: "" });

  porPunto = {};
  ejecutarPlan = espiarPlan().mockImplementation(async (_ctx, _propietario, plan) => evidenciaDe(plan));
  busqueda = espiarBusqueda().mockRejectedValue(new Error("búsqueda extra no programada"));

  revisar = espiarRevisar().mockImplementation(async (_pregunta, borrador) => aprobar(borrador));
  verificar = espiarVerificar().mockResolvedValue(informeVacio());

  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const k of ENV_NEUTRO) {
    if (envOriginal[k] === undefined) delete process.env[k];
    else process.env[k] = envOriginal[k];
  }
});

// ---------------------------------------------------------------------------
// 1. Camino no documental
// ---------------------------------------------------------------------------
describe("camino no documental", () => {
  test("una pregunta sobre el asistente no ejecuta el pipeline y publica directo", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t, "¿Qué eres?");
    const historial = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "Hola, ¿qué quieres consultar?" },
    ];
    clasificar.mockResolvedValue({ clase: "sobre_el_asistente", consulta: PREGUNTA });
    redactor.mockResolvedValue(respuestaTexto("Soy el asistente de la empresa: respondo con los documentos indexados."));

    const m = await correrEn(t, ids, { texto: "¿Qué eres?", historial });

    expect(m.estado).toBe("listo");
    expect(m.content).toBe("Soy el asistente de la empresa: respondo con los documentos indexados.");
    expect(m.hops).toEqual([]);
    expect(m.plan).toEqual([]);
    expect(m.sources).toEqual([]);
    expect(m.verificacion).toBeUndefined();
    expect(m.error).toBeUndefined();
    const metrics = metricasDe(m);
    expect(metrics.meta.clase).toBe("sobre_el_asistente");
    expect(metrics.meta.modo).toBe("normal");
    expect(metrics.meta.prompt_version).toBe("v5");
    expect(metrics.por_componente.agente.rondas).toBe(1);

    // Nada del pipeline documental se tocó.
    expect(planificar).not.toHaveBeenCalled();
    expect(ejecutarPlan).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(revisar).not.toHaveBeenCalled();
    expect(verificar).not.toHaveBeenCalled();
    expect(clasificar).toHaveBeenCalledWith("¿Qué eres?", historial, expect.anything());

    // Una sola llamada, sin herramientas, con la coda y el historial en orden.
    expect(redactor).toHaveBeenCalledTimes(1);
    const kwargs = redactor.mock.calls[0][0];
    expect(kwargs).not.toHaveProperty("tools");
    expect(kwargs.reasoning_effort).toBe("low");
    const msgs = mensajesDe(kwargs);
    expect(msgs[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(msgs[1]).toEqual({ role: "system", content: INSTRUCCION_SIN_DOCUMENTOS });
    expect(msgs.slice(2)).toEqual([...historial, { role: "user", content: "¿Qué eres?" }]);
  });

  test("un saludo con el modelo mudo publica el texto de respaldo, nunca vacío", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t, "hola");
    clasificar.mockResolvedValue({ clase: "conversacional", consulta: PREGUNTA });
    redactor.mockResolvedValue(respuestaTexto(null));

    const m = await correrEn(t, ids, { texto: "hola" });

    expect(m.estado).toBe("listo");
    expect(m.content).toContain("Soy el asistente de investigación");
    expect(metricasDe(m).meta.clase).toBe("conversacional");
  });

  test("si el modelo falla en el camino sin documentos, el mensaje acaba en error, no en pensando", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t, "gracias");
    clasificar.mockResolvedValue({ clase: "conversacional", consulta: PREGUNTA });
    redactor.mockRejectedValue(new gateway.ErrorGateway(429, "credit_balance_exhausted", false));

    const m = await correrEn(t, ids, { texto: "gracias" });

    expect(m.estado).toBe("error");
    expect(m.error).toContain("gateway 429");
    expect(m.content).toBe("");
    expect(metricasDe(m).meta.clase).toBe("conversacional");
  });

  test("un modo desconocido no tumba la pregunta: se resuelve al normal", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };

    const m = await correrEn(t, ids, { modo: "turbo" });

    expect(m.estado).toBe("listo");
    expect(metricasDe(m).meta.modo).toBe("normal");
    expect(mensajesDe(modelo.llamadas[0])[1]).toEqual({ role: "system", content: NORMAL.instruccion });
  });
});

// ---------------------------------------------------------------------------
// 2. Camino documental, modo normal
// ---------------------------------------------------------------------------
describe("camino documental, modo normal", () => {
  test("plan de un punto: estados en orden, plan y hops del contrato, huella en metrics y el borrador privado hasta el final", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const historial = [
      { role: "user", content: "¿qué es p-tau217?" },
      { role: "assistant", content: "Un biomarcador plasmático [a.pdf, pág. 1]." },
    ];
    porPunto = {
      e0: { fragmentos: [frag("c1"), frag("c2", { page: 5, section: "Results" })], grados: { c1: "directa", c2: "parcial" } },
    };
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { historial }));

    // ADVERSARIAL: el plan se ejecuta con el userId de QUIEN PREGUNTA. Los
    // mocks ignoran el argumento, así que sin esto pasar cualquier otro id
    // (el de un administrador, el propietario de un documento) compilaba y no
    // rompía ningún test.
    expect(ejecutarPlan).toHaveBeenCalled();
    expect(ejecutarPlan.mock.calls[0][1]).toBe(ids.userId);

    // La secuencia de estados del contrato, y el borrador NUNCA antes de listo.
    const estados = escrituras.map((c) => c.estado).filter(Boolean);
    expect(estados).toEqual(["buscando", "redactando", "revisando", "listo"]);
    for (const c of escrituras.slice(0, -1)) expect(c).not.toHaveProperty("content");
    const conPlan = escrituras.find((c) => c.plan);
    expect(conPlan?.plan).toEqual([
      { id: "e0", query: PREGUNTA, query_en: "", evidence_needed: planner.ANCLA_EVIDENCE_NEEDED },
    ]);

    const m = await fila(t, ids.messageId);
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(m.error).toBeUndefined();
    // Hop del plan con los campos del contrato F, en snake_case.
    expect(m.hops).toEqual([
      {
        n: 1,
        query: PREGUNTA,
        origen: "plan",
        plan_item: "e0",
        evidence_needed: planner.ANCLA_EVIDENCE_NEEDED,
        resultados: 2,
        documentos: ["a.pdf"],
        estado: "cubierto",
        recuperacion: "hibrida",
        relevancia_verificada: true,
        ms: 25,
        en_curso: false,
      },
    ]);
    const fuentes = fuentesDe(m);
    expect(fuentes).toHaveLength(2);
    expect(fuentes[0]).toMatchObject({ source_file: "a.pdf", page: 3, plan_items: ["e0"], grado: "directa", locator: "pág. 3", fuente: "a.pdf" });
    expect(fuentes[1]).toMatchObject({ page: 5, section: "Results", plan_items: ["e0"], grado: "parcial" });
    const metrics = metricasDe(m);
    expect(metrics.meta.huella_evidencia).toBe(evidencia.huellaDe(["c1", "c2"]));
    expect(metrics.meta.clase).toBe("documental");
    expect(metrics.counters.hops_plan).toBe(1);
    expect(metrics.counters.puntos_sin_resultados).toBe(0);
    expect(metrics.counters.hops_extra).toBeUndefined();
    expect(metrics.meta.verificacion).toMatchObject({ revision_previa: true, revisiones: 0, abstencion_segura: false });

    // Lo que vio el modelo: prompt, modo, historial, pregunta y la evidencia
    // como intercambio sintético de herramientas.
    expect(stream).toHaveBeenCalledTimes(1);
    const kwargs = modelo.llamadas[0];
    expect(kwargs).toMatchObject({ model: "openai/gpt-5.4", temperature: 0, tool_choice: "auto", parallel_tool_calls: false, reasoning_effort: "medium" });
    expect(kwargs.tools).toBe(HERRAMIENTAS);
    const msgs = mensajesDe(kwargs);
    expect(msgs[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(msgs[1]).toEqual({ role: "system", content: NORMAL.instruccion });
    expect(msgs[2]).toEqual(historial[0]);
    expect(msgs[3]).toEqual(historial[1]);
    expect(msgs[4]).toEqual({ role: "user", content: PREGUNTA });
    expect(msgs[5]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_plan_e0", function: { name: NOMBRE_BUSCAR } }] });
    expect(msgs[6]).toMatchObject({ role: "tool", tool_call_id: "call_plan_e0" });
    expect(String(msgs[6].content)).toContain("PUNTO e0");
    expect(String(msgs[6].content)).toContain("cita: [a.pdf, pág. 3]");
    expect(msgs).toHaveLength(8);
    expect(planificar).not.toHaveBeenCalled();

    // La barrera recibe la pregunta, el borrador, la evidencia, el mapa y un
    // tiempo que nunca es negativo.
    expect(revisar).toHaveBeenCalledTimes(1);
    const [pregunta, borrador, mensajes, fragmentos, requerida, mapa, tiempo] = revisar.mock.calls[0];
    expect(pregunta).toBe(PREGUNTA);
    expect(borrador).toBe(RESPUESTA);
    expect(mensajes).toHaveLength(8);
    expect(fragmentos.map((f) => f._id)).toEqual(["c1", "c2"]);
    expect(requerida).toEqual({ e0: planner.ANCLA_EVIDENCE_NEEDED });
    expect(mapa).toEqual({ c1: ["e0"], c2: ["e0"] });
    expect(tiempo).toBeGreaterThanOrEqual(0);
    expect(tiempo).toBeLessThanOrEqual(540);
  });

  test("un punto sin resultados y otro en error se distinguen en los hops", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("ENABLE_QUERY_PLANNING", "true");
    planificar.mockResolvedValue({
      items: [
        { id: "x", query: "especificidad de p-tau217", queryEn: "specificity of p-tau217", evidenceNeeded: "especificidad" },
        { id: "y", query: "coste de la prueba", queryEn: "cost of the test", evidenceNeeded: "coste" },
      ],
      preguntaEn: "What is the AUC of p-tau217?",
    });
    porPunto = {
      e0: { fragmentos: [frag("c1")] },
      e1: { fragmentos: [], documentosRevisados: ["a.pdf", "b.pdf"] },
      e2: { fragmentos: [], recuperacion: "error" },
    };

    const m = await correrEn(t, ids, { modo: "extendido" });

    const hops = hopsDe(m);
    expect(hops.map((h) => h.plan_item)).toEqual(["e0", "e1", "e2"]);
    expect(hops[0].query).toBe(`${PREGUNTA} · en: What is the AUC of p-tau217?`);
    expect(hops[1]).toMatchObject({ estado: "sin_resultados", recuperacion: "hibrida", documentos: ["a.pdf", "b.pdf"], resultados: 0 });
    expect(hops[2]).toMatchObject({ estado: "sin_resultados", recuperacion: "error", documentos: [] });
    expect(metricasDe(m).counters.puntos_sin_resultados).toBe(2);
    expect(m.plan).toEqual([
      { id: "e0", query: PREGUNTA, query_en: "What is the AUC of p-tau217?", evidence_needed: planner.ANCLA_EVIDENCE_NEEDED },
      { id: "e1", query: "especificidad de p-tau217", query_en: "specificity of p-tau217", evidence_needed: "especificidad" },
      { id: "e2", query: "coste de la prueba", query_en: "cost of the test", evidence_needed: "coste" },
    ]);
    expect(mensajesDe(modelo.llamadas[0])[1]).toEqual({ role: "system", content: EXTENDIDO.instruccion });
    expect(modelo.llamadas[0].reasoning_effort).toBe("high");
  });

  test("si la conversación se borra mientras el agente trabaja, ABANDONA: no recrea el mensaje ni sigue gastando", async () => {
    // Antes terminaba la respuesta entera (redactaba y revisaba) para
    // descubrir al publicar que no había fila. Ahora la primera escritura que
    // no encuentra el turno lo da por abandonado y se para ahí, que es el
    // mismo mecanismo con el que funciona el botón de parar.
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan) => {
      await t.run(async (ctx) => ctx.db.delete(ids.messageId));
      return evidenciaDe(plan);
    });

    await t.action(internal.agente.bucle.correr, argsDe(ids));

    const mensajes = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(mensajes.map((x) => x.role)).toEqual(["user"]);
    expect(stream).not.toHaveBeenCalled();
    expect(revisar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3 a 7. Búsquedas extra del modelo
// ---------------------------------------------------------------------------
describe("búsquedas extra", () => {
  test("argumentos JSON malformados no tumban la respuesta: hop sin_resultados, mensaje tool de error y el bucle sigue", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    modelo.guiones = [
      rondaHerramientas([{ id: "call_rota", name: NOMBRE_BUSCAR, arguments: "{semantico: sin comillas" }]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(busqueda).not.toHaveBeenCalled();
    const hops = hopsDe(m);
    expect(hops).toHaveLength(2);
    expect(hops[1]).toMatchObject({
      n: 2,
      origen: "extra",
      plan_item: "",
      estado: "sin_resultados",
      recuperacion: "error",
      resultados: 0,
      documentos: [],
    });
    expect(herramientaDe(modelo.llamadas[1], "call_rota")).toContain("Falta una consulta semántica");
    // Paridad con Python: la llamada rota gasta la única búsqueda extra del
    // modo normal, así que la segunda ronda ya va forzada. Discutible, pero
    // documentado.
    expect(modelo.llamadas[1].tool_choice).toBe("none");
    const metrics = metricasDe(m);
    expect(metrics.counters.hops_extra).toBe(1);
    expect(metrics.counters.forced_final).toBe(1);
  });

  test("FALLO (bucle.ts:364): argumentos JSON `null` tumban la respuesta entera; Object.keys(null) lanza en claveDeLlamada y el mensaje acaba en error. Arreglo: tras el parse, si no es un objeto plano usar {} (Python: isinstance(args, dict))", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    modelo.guiones = [
      rondaHerramientas([{ id: "call_null", name: NOMBRE_BUSCAR, arguments: "null" }]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
  });

  test("repetir exactamente una consulta del plan (otro punto, otro limit, otras mayúsculas) no se ejecuta ni gasta búsqueda", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("call_rep", { semantico: `  ${PREGUNTA.toUpperCase()} `, punto: "e1", limit: 5 })]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    expect(busqueda).not.toHaveBeenCalled();
    expect(herramientaDe(modelo.llamadas[1], "call_rep")).toContain("IDÉNTICA");
    // No gastó la búsqueda extra: la ronda siguiente sigue libre.
    expect(modelo.llamadas[1].tool_choice).toBe("auto");
    expect(hopsDe(m)).toHaveLength(1);
    const metrics = metricasDe(m);
    expect(metrics.counters.llamadas_repetidas).toBe(1);
    expect(metrics.counters.hops_extra).toBeUndefined();
    expect(metrics.counters.forced_final).toBeUndefined();
  });

  test("repetir una búsqueda extra ya ejecutada tampoco se ejecuta, y un filtro nuevo sí la hace distinta", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("x1", { page: 9 })], {}, e));
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("call_a", { semantico: "p-tau217 specificity", punto: "" })]),
      rondaHerramientas([llamadaBuscar("call_a2", { semantico: "P-TAU217 SPECIFICITY", punto: "e0", limit: 3 })]),
      rondaHerramientas([llamadaBuscar("call_a3", { semantico: "p-tau217 specificity", language: "en" })]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(busqueda).toHaveBeenCalledTimes(2);
    expect(herramientaDe(modelo.llamadas[2], "call_a2")).toContain("IDÉNTICA");
    expect(herramientaDe(modelo.llamadas[3], "call_a3")).toContain("cita: [a.pdf, pág. 9]");
    expect(metricasDe(m).counters.llamadas_repetidas).toBe(1);
    expect(metricasDe(m).counters.hops_extra).toBe(2);
  });

  test("FALLO (bucle.ts:262): la variante inglesa (query_en) de un punto del plan no se siembra como ejecutada; el modelo la repite y se busca dos veces lo mismo. Python sembraba query y query_en", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const en = "What is the AUC of p-tau217 for detecting Alzheimer?";
    planificar.mockResolvedValue({ items: [], preguntaEn: en });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("c1")], {}, e));
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_en", { semantico: en, punto: "e0" })]), rondaTexto(RESPUESTA)];

    await correrEn(t, ids, { modo: "extendido" });

    expect(busqueda).not.toHaveBeenCalled();
  });

  test("modo extendido: a la tercera búsqueda extra se fuerza la respuesta con tool_choice none y aviso al modelo", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planificar.mockResolvedValue({
      items: [{ id: "x", query: "sensibilidad de p-tau217", queryEn: "sensitivity of p-tau217", evidenceNeeded: "sensibilidad" }],
      preguntaEn: "",
    });
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [], documentosRevisados: ["a.pdf"] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) =>
      resultadoExtra(punto, consulta, [frag(`x_${consulta.split(" ").pop()}`, { page: 11 })], {}, e),
    );
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("call_a", { semantico: "p-tau217 sensitivity plasma", punto: "e1" })]),
      rondaHerramientas([llamadaBuscar("call_b", { semantico: "p-tau217 sensitivity CSF", punto: "e1" })]),
    ];
    // Si no lo forzaran, el modelo seguiría pidiendo búsquedas.
    modelo.porDefecto = (kwargs) =>
      kwargs.tool_choice === "none"
        ? rondaTexto(RESPUESTA)
        : rondaHerramientas([llamadaBuscar("call_z", { semantico: "insistiendo", punto: "e1" })]);

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(busqueda).toHaveBeenCalledTimes(2);
    expect(busqueda.mock.calls.map((c) => c[2])).toEqual(["p-tau217 sensitivity plasma", "p-tau217 sensitivity CSF"]);
    // La búsqueda extra hereda el evidence_needed del punto que rellena.
    expect(busqueda.mock.calls[0][3]).toBe("sensibilidad");
    expect(busqueda.mock.calls[0][4]).toBe("e1");
    expect(modelo.llamadas[0].tool_choice).toBe("auto");
    expect(modelo.llamadas[1].tool_choice).toBe("auto");
    const tercera = modelo.llamadas[2];
    expect(tercera.tool_choice).toBe("none");
    expect(tercera).not.toHaveProperty("parallel_tool_calls");
    expect(ultimoDe(tercera)).toMatchObject({ role: "system" });
    expect(String(ultimoDe(tercera).content)).toContain("Se acabó el presupuesto de búsquedas (tope de 2 búsquedas extra)");
    const metrics = metricasDe(m);
    expect(metrics.counters.forced_final).toBe(1);
    expect(metrics.counters.hops_extra).toBe(2);
    // Los hops extra rellenan e1 en la UI y en la trazabilidad.
    const hops = hopsDe(m);
    expect(hops).toHaveLength(4);
    expect(hops[2]).toMatchObject({ n: 3, origen: "extra", plan_item: "e1", evidence_needed: "sensibilidad", estado: "cubierto", resultados: 1, nuevos: 1 });
    expect(hops[3]).toMatchObject({ n: 4, origen: "extra", plan_item: "e1", nuevos: 1 });
    const x = fuentesDe(m).find((f) => f.snippet === "texto de x_plasma");
    expect(x).toMatchObject({ plan_items: ["e1"] });
  });

  test("varias tool calls en una ronda se ejecutan en orden de index aunque los deltas lleguen desordenados", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag(`x_${consulta}`)], {}, e));
    const a1 = JSON.stringify({ semantico: "segunda" });
    const a0 = JSON.stringify({ semantico: "primera" });
    modelo.guiones = [
      [
        { toolCalls: [{ index: 1, id: "call_1", name: NOMBRE_BUSCAR, arguments: a1.slice(0, 5) }] },
        { toolCalls: [{ index: 0, id: "call_0", name: NOMBRE_BUSCAR, arguments: a0.slice(0, 5) }] },
        { toolCalls: [{ index: 1, arguments: a1.slice(5) }, { index: 0, arguments: a0.slice(5) }] },
        { finishReason: "tool_calls" },
        { usage: USO, modelo: "openai/gpt-5.4" },
      ],
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(busqueda.mock.calls.map((c) => c[2])).toEqual(["primera", "segunda"]);
    const asistente = mensajesDe(modelo.llamadas[1]).find((x) => x.role === "assistant" && Array.isArray(x.tool_calls) && x.tool_calls.length === 2);
    expect(asistente?.tool_calls).toEqual([
      { id: "call_0", type: "function", function: { name: NOMBRE_BUSCAR, arguments: a0 } },
      { id: "call_1", type: "function", function: { name: NOMBRE_BUSCAR, arguments: a1 } },
    ]);
    expect(hopsDe(m).map((h) => h.query)).toEqual([PREGUNTA, "primera", "segunda"]);
  });

  test("FALLO (bucle.ts:357-507): dos búsquedas en la MISMA ronda saltan el tope del modo (normal: 1 extra), porque el tope solo se comprueba entre rondas y parallel_tool_calls=false es una petición, no una garantía. Arreglo: dentro del for, si hopsExtra >= maxHopsExtra responder a la tool call con 'tope alcanzado' sin ejecutarla", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag(`x_${consulta}`)], {}, e));
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("call_0", { semantico: "primera" }), llamadaBuscar("call_1", { semantico: "segunda" })]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids);

    expect(metricasDe(m).counters.hops_extra).toBeLessThanOrEqual(NORMAL.maxHopsExtra);
  });

  test("si el modelo ignora tool_choice none y pide otra búsqueda sin texto, no se busca y el borrador vacío va a la barrera", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("x1")], {}, e));
    revisar.mockImplementation(async (_p, borrador) => (borrador.trim() ? aprobar(borrador) : abstenerse("borrador_vacio")));
    modelo.porDefecto = () => rondaHerramientas([llamadaBuscar(`call_${modelo.llamadas.length}`, { semantico: `consulta ${modelo.llamadas.length}` })]);

    const m = await correrEn(t, ids);

    expect(busqueda).toHaveBeenCalledTimes(NORMAL.maxHopsExtra);
    expect(stream).toHaveBeenCalledTimes(NORMAL.maxHopsExtra + 1);
    expect(revisar.mock.calls[0][1]).toBe("");
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(revisor.ABSTENCION_SEGURA);
    expect(metricasDe(m).meta.barrera).toMatchObject({ motivo: "borrador_vacio" });
  });

  test("el inventario no cuenta como búsqueda extra ni como ronda sin avance, y el catálogo exacto llega al modelo", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    // Con este techo, si el inventario contara como "sin avance" la segunda
    // ronda ya iría forzada: es lo que distingue los dos comportamientos.
    vi.stubEnv("AGENT_MAX_HOPS_SIN_AVANCE", "1");
    await t.run(async (ctx) => {
      const base = { sha256: "x", pages: 1, ingestadoEn: 1, documentType: "pdf", propietario: ids.userId };
      await ctx.db.insert("documents", { ...base, fileName: "estudio.pdf", chunks: 6, status: "ready", language: "es" });
      await ctx.db.insert("documents", { ...base, fileName: "folleto.pdf", chunks: 2, status: "ready" });
      await ctx.db.insert("documents", { ...base, fileName: "roto.docx", chunks: 5, status: "failed", error: "no se pudo parsear" });
    });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("x1", { sourceFile: "estudio.pdf" })], {}, e));
    modelo.guiones = [
      rondaHerramientas([{ id: "call_inv", name: NOMBRE_INVENTARIO, arguments: "{}" }]),
      rondaHerramientas([llamadaBuscar("call_b", { semantico: "AUC p-tau217 cohort" })]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(m.estado).toBe("listo");
    const hops = hopsDe(m);
    expect(hops[1]).toEqual({
      n: 2,
      query: "inventario de documentos",
      origen: "extra",
      plan_item: "",
      evidence_needed: "",
      resultados: 0,
      documentos: [],
      estado: "cubierto",
      recuperacion: "hibrida",
      relevancia_verificada: true,
      ms: expect.any(Number),
      en_curso: false,
    });
    const catalogo = herramientaDe(modelo.llamadas[1], "call_inv");
    expect(catalogo).toContain("Hay 2 documentos indexados y 8 fragmentos en total");
    expect(catalogo).toContain("- estudio.pdf: 6 fragmentos");
    expect(catalogo).toContain("- folleto.pdf: 2 fragmentos");
    expect(catalogo).not.toContain("roto.docx");
    expect(catalogo).toContain("Idiomas detectados: es (6)");
    // Ni gastó búsqueda ni contó como "sin avance": las dos rondas siguientes siguen libres.
    expect(modelo.llamadas[1].tool_choice).toBe("auto");
    expect(modelo.llamadas[2].tool_choice).toBe("auto");
    const metrics = metricasDe(m);
    expect(metrics.counters.hops_extra).toBe(1);
    expect(metrics.counters.forced_final).toBeUndefined();
    expect(metrics.counters.hops_con_error).toBeUndefined();
    expect(hops[2]).toMatchObject({ n: 3, query: "AUC p-tau217 cohort", estado: "cubierto", documentos: ["estudio.pdf"] });
  });

  test("FALLO (bucle.ts:392-404): si la consulta de inventario lanza, el hop se guarda como cubierto/hibrida aunque el modelo recibió un error; la UI lo pinta en verde. Arreglo: recuperacion 'error' y estado 'sin_resultados' en el hop cuando falla", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    modelo.guiones = [rondaHerramientas([{ id: "call_inv", name: NOMBRE_INVENTARIO, arguments: "{}" }]), rondaTexto(RESPUESTA)];
    const { ctx } = ctxDirecto(t, { inventarioRoto: true });

    await handlerDirecto(ctx, argsDe(ids));

    const m = await fila(t, ids.messageId);
    expect(herramientaDe(modelo.llamadas[1], "call_inv")).toContain("Error al consultar el inventario");
    expect(metricasDe(m).counters.hops_con_error).toBe(1);
    expect(hopsDe(m)[1].recuperacion).toBe("error");
  });

  test("filtros que dejan la búsqueda vacía: se repite sin filtros y el resultado llega con AVISO", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto, _modo, filtros) =>
      Object.keys(filtros).length
        ? resultadoExtra(punto, consulta, [], { documentosRevisados: [], nCandidatos: 0 }, e)
        : resultadoExtra(punto, consulta, [frag("x1", { page: 7 })], {}, e),
    );
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("call_f", { semantico: "p-tau217 AUC", language: "es", document_type: "pdf" })]),
      rondaTexto(RESPUESTA),
    ];

    const m = await correrEn(t, ids);

    expect(busqueda).toHaveBeenCalledTimes(2);
    // Los filtros viajan con las claves de FiltrosBusqueda.
    expect(busqueda.mock.calls[0][6]).toEqual({ language: "es", documentType: "pdf" });
    expect(busqueda.mock.calls[1][6]).toEqual({});
    const texto = herramientaDe(modelo.llamadas[1], "call_f");
    expect(texto.startsWith("AVISO: con los filtros que pusiste (")).toBe(true);
    expect(texto).toContain('language="es"');
    expect(texto).toContain("cita: [a.pdf, pág. 7]");
    const hop = hopsDe(m)[1];
    expect(hop).toMatchObject({ estado: "cubierto", resultados: 1, nuevos: 1, recuperacion: "hibrida", relevancia_verificada: true, plan_item: "" });
    expect(hop.query).toBe("p-tau217 AUC · tipo: pdf · idioma: es");
    expect(fuentesDe(m).find((f) => f.snippet === "texto de x1")).toMatchObject({ plan_items: ["extra"], page: 7 });
    expect(m.estado).toBe("listo");
  });

  test("FALLO (bucle.ts:121-133): un filtro en blanco ('  ') no se aplica (filtrosDe lo recorta) pero sí aparece en la etiqueta del hop como 'proyecto:   '; la UI muestra un filtro fantasma. Arreglo: etiquetaDeLlamada debe recortar igual que filtrosDe", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("x1")], {}, e));
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_b", { semantico: "p-tau217 AUC", project_id: "  " })]), rondaTexto(RESPUESTA)];

    const m = await correrEn(t, ids);

    expect(busqueda.mock.calls[0][6]).toEqual({});
    expect(hopsDe(m)[1].query).toBe("p-tau217 AUC");
  });

  test("si también sin filtros sale vacía, el mensaje tool describe lo revisado y el hop queda sin_resultados", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) =>
      resultadoExtra(punto, consulta, [], { documentosRevisados: ["a.pdf", "b.pdf"], nCandidatos: 4 }, e),
    );
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_v", { semantico: "algo que no está", language: "en" })]), rondaTexto(RESPUESTA)];

    const m = await correrEn(t, ids);

    expect(busqueda).toHaveBeenCalledTimes(2);
    const texto = herramientaDe(modelo.llamadas[1], "call_v");
    expect(texto).not.toContain("AVISO");
    expect(texto).toContain("Se revisaron los candidatos más parecidos");
    expect(texto).toContain("a.pdf; b.pdf");
    expect(hopsDe(m)[1]).toMatchObject({ estado: "sin_resultados", recuperacion: "hibrida", resultados: 0, nuevos: 0, documentos: ["a.pdf", "b.pdf"] });
  });

  test("una búsqueda extra que lanza deja el hop en error, avisa al modelo y el bucle sigue", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockRejectedValue(new Error("embeddings caídos"));
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_e", { semantico: "specificity", punto: "e0" })]), rondaTexto(RESPUESTA)];

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    const hop = hopsDe(m)[1];
    expect(hop).toMatchObject({ estado: "sin_resultados", recuperacion: "error", resultados: 0, plan_item: "e0" });
    expect(hop).not.toHaveProperty("nuevos");
    expect(herramientaDe(modelo.llamadas[1], "call_e")).toContain("Error al ejecutar la búsqueda");
    expect(metricasDe(m).counters.hops_con_error).toBe(1);
  });

  test("una búsqueda extra en recuperación error dice al modelo que no concluya ausencia", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [], { recuperacion: "error", documentosRevisados: [] }, e));
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_r", { semantico: "specificity" })]), rondaTexto(RESPUESTA)];

    const m = await correrEn(t, ids);

    const texto = herramientaDe(modelo.llamadas[1], "call_r");
    expect(texto).toContain("no se pudo completar");
    expect(texto).not.toContain("no lo encuentras");
    expect(hopsDe(m)[1]).toMatchObject({ estado: "sin_resultados", recuperacion: "error" });
  });

  test("FALLO (bucle.ts:485-487): el grado del calificador de una búsqueda extra se pierde; se lee ev.grados (del plan) en vez de resultado.grados, así que sources[].grado queda vacío para lo que trae el modelo. Python usaba punto_extra.grados", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")], grados: { c1: "directa" } } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) =>
      resultadoExtra(punto, consulta, [frag("x1")], { grados: { x1: "parcial" } }, e),
    );
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_g", { semantico: "specificity p-tau217" })]), rondaTexto(RESPUESTA)];

    const m = await correrEn(t, ids);

    expect(fuentesDe(m).find((f) => f.snippet === "texto de x1")?.grado).toBe("parcial");
  });

  test("FALLO (bucle.ts:365-377): una llamada idéntica repetida no cuenta como ronda sin avance, así que un modelo que insiste solo lo para el reloj del modo (60 rondas en normal). Arreglo: hopsSinAvance += 1 en la rama de repetición", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    // Cada ronda del modelo "tarda" un segundo de reloj simulado.
    const ahoraReal = Date.now.bind(Date);
    let desfase = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ahoraReal() + desfase);
    modelo.porDefecto = (kwargs) => {
      desfase += 1000;
      return kwargs.tool_choice === "none"
        ? rondaTexto(RESPUESTA)
        : rondaHerramientas([llamadaBuscar(`call_${modelo.llamadas.length}`, { semantico: PREGUNTA, punto: "e0" })]);
    };

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    expect(busqueda).not.toHaveBeenCalled();
    // Lo deseable: tras maxHopsSinAvance repeticiones seguidas, forzar el final.
    expect(stream.mock.calls.length).toBeLessThanOrEqual(NORMAL.maxHopsSinAvance + 2);
  });
});

// ---------------------------------------------------------------------------
// 8 a 11. Barrera de revisión y cobertura
// ---------------------------------------------------------------------------
describe("barrera de revisión", () => {
  test("una abstención segura se publica como listo, con su contador y el diagnóstico de la barrera", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    revisar.mockResolvedValue(abstenerse());

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    expect(m.content).toBe(revisor.ABSTENCION_SEGURA);
    expect(m.error).toBeUndefined();
    const metrics = metricasDe(m);
    expect(metrics.counters.abstenciones_seguras).toBe(1);
    expect(metrics.counters.respuestas_revisadas).toBe(1);
    expect(metrics.meta.verificacion).toMatchObject({ revision_previa: true, revisiones: 1, abstencion_segura: true });
    expect(metrics.meta.barrera).toMatchObject({ motivo: "rechazada_tras_correccion", informe_borrador: { ok: false } });
    expect(m.verificacion).toMatchObject({ nota: "abstención" });
  });

  test("si el revisor lanza, el mensaje acaba en error con metrics y sin publicar el borrador", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    revisar.mockRejectedValue(new Error("el juez se cayó"));

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("error");
    expect(m.error).toBe("el juez se cayó");
    expect(m.content).toBe("");
    const metrics = metricasDe(m);
    expect(metrics.meta.clase).toBe("documental");
    expect(metrics.por_componente.agente.rondas).toBe(1);
    // Lo escrito antes del fallo se conserva para diagnosticar.
    expect(hopsDe(m)).toHaveLength(1);
    expect(m.plan).toHaveLength(1);
  });

  test("si el stream del modelo se corta a mitad, el mensaje acaba en error y la ronda queda anotada como fallida", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    modelo.guiones = [[{ texto: "El AUC" }, new gateway.ErrorGateway(502, "upstream", true)]];

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("error");
    expect(m.error).toContain("gateway 502");
    expect(m.content).toBe("");
    expect(revisar).not.toHaveBeenCalled();
    expect(metricasDe(m).por_componente.agente.errores).toBe(1);
  });

  test("si el pipeline de evidencia lanza (no debería), el mensaje acaba en error, no en buscando", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    ejecutarPlan.mockRejectedValue(new Error("índice caído"));

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("error");
    expect(m.error).toBe("índice caído");
    expect(stream).not.toHaveBeenCalled();
  });

  test("sin clave del gateway el mensaje acaba en error con la instrucción para ponerla", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("OPENAI_API_KEY", "");

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("error");
    expect(m.error).toContain("OPENAI_API_KEY");
    expect(clasificar).not.toHaveBeenCalled();
  });

  test("sin revisión previa, el verificador anota y su cobertura vuelve a los hops", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("ENABLE_PRE_RESPONSE_REVIEW", "false");
    planificar.mockResolvedValue({ items: [{ id: "x", query: "especificidad", queryEn: "specificity", evidenceNeeded: "especificidad" }], preguntaEn: "" });
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [frag("c2")] } };
    verificar.mockResolvedValue(informeVacio({ cobertura: [cobertura("e1", "cubierto")], fidelidad: 1 }));

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(revisar).not.toHaveBeenCalled();
    expect(verificar).toHaveBeenCalledWith(RESPUESTA, expect.any(Array), { e0: planner.ANCLA_EVIDENCE_NEEDED, e1: "especificidad" }, { c1: ["e0"], c2: ["e1"] }, expect.anything(), expect.objectContaining({ pregunta: PREGUNTA }));
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(m.verificacion).toMatchObject({ fidelidad: 1 });
    expect(hopsDe(m)[1]).toMatchObject({ estado_final: "cubierto", usado_en_respuesta: true });
    expect(metricasDe(m).meta.verificacion).toMatchObject({ revision_previa: false, fidelidad: 1 });
  });

  test("FALLO (bucle.ts:558-564): sin revisión previa, si el verificador lanza la respuesta se publica sin auditar y sin dejar rastro en metrics; solo hay un console.error. Arreglo: tel.incr('verificacion_fallida') y una nota en verificacion", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("ENABLE_PRE_RESPONSE_REVIEW", "false");
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    verificar.mockRejectedValue(new Error("verificador caído"));

    const m = await correrEn(t, ids);

    // Esto es lo que hace hoy: publica como si nada.
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(m.verificacion).toBeUndefined();
    // Y esto es lo que falta.
    expect(metricasDe(m).counters.verificacion_fallida).toBe(1);
  });

  test("la cobertura por punto vuelve a los hops del plan: usado solo para cubierto y parcial", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planificar.mockResolvedValue({
      items: [
        { id: "a", query: "sensibilidad", queryEn: "sensitivity", evidenceNeeded: "dato e1" },
        { id: "b", query: "especificidad", queryEn: "specificity", evidenceNeeded: "dato e2" },
        { id: "c", query: "coste", queryEn: "cost", evidenceNeeded: "dato e3" },
        { id: "d", query: "tamaño muestral", queryEn: "sample size", evidenceNeeded: "dato e4" },
      ],
      preguntaEn: "What is the AUC of p-tau217?",
    });
    porPunto = {
      e0: { fragmentos: [frag("c0")] },
      e1: { fragmentos: [frag("c1")] },
      e2: { fragmentos: [frag("c2")] },
      e3: { fragmentos: [frag("c3")] },
      e4: { fragmentos: [] },
    };
    const informe = informeVacio({
      cobertura: [cobertura("e1", "cubierto"), cobertura("e2", "evidencia_no_usada"), cobertura("e3", "parcial"), cobertura("e4", "sin_resultados")],
      evidencia_sin_cubrir: ["e2"],
      fidelidad: 0.75,
    });
    revisar.mockImplementation(async (_p, borrador) => aprobar(borrador, informe));

    const m = await correrEn(t, ids, { modo: "extendido" });

    const hops = hopsDe(m);
    expect(hops.map((h) => h.plan_item)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    // e0 no es un punto de evidencia: no lleva cobertura.
    expect(hops[0]).not.toHaveProperty("estado_final");
    expect(hops[0]).not.toHaveProperty("usado_en_respuesta");
    expect(hops[1]).toMatchObject({ estado_final: "cubierto", usado_en_respuesta: true });
    expect(hops[2]).toMatchObject({ estado_final: "evidencia_no_usada", usado_en_respuesta: false });
    expect(hops[3]).toMatchObject({ estado_final: "parcial", usado_en_respuesta: true });
    expect(hops[4]).toMatchObject({ estado_final: "sin_resultados", usado_en_respuesta: false });
    const metrics = metricasDe(m);
    expect(metrics.counters.puntos_no_usados).toBe(1);
    expect(metrics.counters.puntos_sin_resultados).toBe(1);
    expect(metrics.counters.hops_plan).toBe(5);
    expect(metrics.meta.verificacion.cobertura).toHaveLength(4);
    expect(metrics.meta.verificacion.fidelidad).toBe(0.75);
    expect(m.verificacion).toEqual(informe);
    // El revisor recibió el plan completo como evidencia requerida.
    expect(revisar.mock.calls[0][4]).toEqual({ e0: planner.ANCLA_EVIDENCE_NEEDED, e1: "dato e1", e2: "dato e2", e3: "dato e3", e4: "dato e4" });
  });
});

// ---------------------------------------------------------------------------
// 10. La base falla al escribir el avance
// ---------------------------------------------------------------------------
describe("escrituras del avance", () => {
  test("si escribir el avance falla a mitad, el bucle no se cae: sigue y publica al final", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    // 3 = los marcadores del plan (uno por punto, antes de buscar),
    // 4 = hops+sources del plan ya buscado.
    const { ctx, escrituras } = ctxDirecto(t, { falla: (n) => n === 3 || n === 4 });

    await handlerDirecto(ctx, argsDe(ids));

    const m = await fila(t, ids.messageId);
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(escrituras).toHaveLength(7);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(revisar).toHaveBeenCalledTimes(1);
    // Lo que falló en la escritura 3 se recupera en la publicación final.
    expect(hopsDe(m)).toHaveLength(1);
    expect(fuentesDe(m)).toHaveLength(1);
    expect(m.plan).toHaveLength(1);
  });

  test("FALLO (bucle.ts:223-230 y 581-589): el plan se escribe una sola vez; si esa escritura falla, la publicación final no lo incluye y la tabla de cobertura no se puede reconstruir. Arreglo: incluir `plan` en la escritura final", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx } = ctxDirecto(t, { falla: (n) => n === 2 });

    await handlerDirecto(ctx, argsDe(ids));

    const m = await fila(t, ids.messageId);
    expect(m.estado).toBe("listo");
    expect(m.plan).toHaveLength(1);
  });

  test("FALLO (bucle.ts:178-187 y 581-589): si falla la escritura FINAL, `actualizar` se traga el error y el mensaje se queda en 'revisando' para siempre sin content ni error. Arreglo: reintentar la publicación con espera y, si no hay manera, escribir estado error", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx } = ctxDirecto(t, { falla: (n) => n === 6 });

    await handlerDirecto(ctx, argsDe(ids));

    const m = await fila(t, ids.messageId);
    expect(m.estado).not.toBe("revisando");
  });
});

// ---------------------------------------------------------------------------
// 12. El reloj
// ---------------------------------------------------------------------------
describe("reloj", () => {
  test("con el presupuesto total casi agotado se fuerza el final en la primera ronda y aun así se publica", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("PRESUPUESTO_TOTAL_S", "1");
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    // Si no lo forzaran, el modelo pediría una búsqueda.
    modelo.porDefecto = (kwargs) =>
      kwargs.tool_choice === "none" ? rondaTexto(RESPUESTA) : rondaHerramientas([llamadaBuscar("call_x", { semantico: "algo" })]);

    const m = await correrEn(t, ids);

    expect(stream).toHaveBeenCalledTimes(1);
    expect(modelo.llamadas[0].tool_choice).toBe("none");
    expect(modelo.llamadas[0]).not.toHaveProperty("parallel_tool_calls");
    expect(busqueda).not.toHaveBeenCalled();
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(metricasDe(m).counters.forced_final).toBe(1);
    // La evidencia recibe como mucho lo que queda, y la revisión nunca un negativo.
    expect(ejecutarPlan.mock.calls[0][6]).toBeLessThanOrEqual(1000);
    const tiempo = revisar.mock.calls[0][6] as number;
    expect(tiempo).toBeGreaterThanOrEqual(0);
    expect(tiempo).toBeLessThanOrEqual(1);
  });

  test("si la evidencia se come el presupuesto entero, la revisión recibe 0 exacto, nunca un negativo", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const ahoraReal = Date.now.bind(Date);
    let desfase = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ahoraReal() + desfase);
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan) => {
      desfase += 600_000; // 600 s: más que los 540 del presupuesto total
      return evidenciaDe(plan);
    });

    const m = await correrEn(t, ids);

    expect(modelo.llamadas[0].tool_choice).toBe("none");
    expect(revisar.mock.calls[0][6]).toBe(0);
    expect(m.estado).toBe("listo");
    expect(m.content).toBe(RESPUESTA);
    expect(metricasDe(m).counters.forced_final).toBe(1);
  });

  test("el presupuesto del modo (240 s en extendido) fuerza el final aunque queden búsquedas", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const ahoraReal = Date.now.bind(Date);
    let desfase = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ahoraReal() + desfase);
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => {
      desfase += EXTENDIDO.presupuestoS * 1000 + 1000;
      return resultadoExtra(punto, consulta, [frag("x1")], {}, e);
    });
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_1", { semantico: "primera" })])];
    modelo.porDefecto = (kwargs) =>
      kwargs.tool_choice === "none" ? rondaTexto(RESPUESTA) : rondaHerramientas([llamadaBuscar("call_2", { semantico: "segunda" })]);

    const m = await correrEn(t, ids, { modo: "extendido" });

    expect(busqueda).toHaveBeenCalledTimes(1);
    expect(String(ultimoDe(modelo.llamadas[1]).content)).toMatch(/Se acabó el presupuesto de búsquedas \(tiempo agotado \(\d+ s\)\)/);
    expect(m.estado).toBe("listo");
    // Quedaba tiempo del presupuesto total (540 - 241 s): la revisión lo recibe.
    expect(revisar.mock.calls[0][6]).toBeGreaterThan(250);
    expect(revisar.mock.calls[0][6]).toBeLessThanOrEqual(300);
  });
});

describe("repreguntas: se busca la consulta autónoma, se responde la literal", () => {
  test("ADVERSARIAL: 'hazme un mapa mental' tras hablar de hipertensión busca hipertensión, no 'mapa mental'", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const historial = [
      { role: "user", content: "háblame de la hipertensión arterial" },
      { role: "assistant", content: "Es una elevación persistente de la PA [a.pdf, pág. 3]." },
    ];
    const CONSULTA = "mapa mental de la hipertensión arterial: definición, diagnóstico y tratamiento";
    clasificar.mockResolvedValue({ clase: "documental", consulta: CONSULTA });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { texto: "hazme un mapa mental o un diagrama visual", historial }));

    // El ancla del plan (lo que se busca) es la consulta reformulada...
    const plan = ejecutarPlan.mock.calls[0][2] as Array<{ id: string; query: string }>;
    expect(plan[0]).toMatchObject({ id: "e0", query: CONSULTA });
    // ...y lo que el redactor recibe como pregunta es el texto literal.
    const kwargs = stream.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const ultimoUsuario = kwargs.messages.filter((m) => m.role === "user").pop();
    expect(ultimoUsuario?.content).toBe("hazme un mapa mental o un diagrama visual");
  });

  test("sin historial el ancla es la pregunta literal, pase lo que pase con el clasificador", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    // El clasificador real ya devuelve la literal sin historial; el bucle no
    // depende de eso: con la clase en caché ni siquiera lo llama.
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx } = ctxDirecto(t);
    await handlerDirecto(ctx, argsDe(ids));
    const plan = ejecutarPlan.mock.calls[0][2] as Array<{ id: string; query: string }>;
    expect(plan[0].query).toBe(PREGUNTA);
  });
});

// ---------------------------------------------------------------------------
// El inglés del ancla en modo normal, las reformulaciones y la telemetría de
// recuperación y de entidad
// ---------------------------------------------------------------------------
describe("inglés del ancla, reformulaciones y telemetría", () => {
  test("en modo normal el ancla se busca también con el inglés del clasificador, y se recuerda en la caché", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const EN = "What is the AUC of p-tau217 for detecting Alzheimer?";
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, consultaEn: EN });
    porPunto = { e0: { fragmentos: [frag("c1")] } };

    const m = await correrEn(t, ids);

    expect(planificar).not.toHaveBeenCalled();
    const plan = ejecutarPlan.mock.calls[0][2] as Array<{ id: string; query: string; queryEn: string }>;
    expect(plan[0]).toMatchObject({ id: "e0", query: PREGUNTA, queryEn: EN });
    expect(hopsDe(m)[0].query).toBe(`${PREGUNTA} · en: ${EN}`);
    expect(m.plan).toEqual([{ id: "e0", query: PREGUNTA, query_en: EN, evidence_needed: planner.ANCLA_EVIDENCE_NEEDED }]);
    // Repetir la pregunta con el inglés ya en el índice no llama al modelo y
    // el inglés sobrevive.
    const filas = await t.run((ctx) => ctx.db.query("planes").collect());
    expect(filas).toHaveLength(1);
    expect(filas[0].preguntaEn).toBe(EN);
  });

  test("con la clase en caché, el inglés del ancla sale de la caché aunque no se llame al clasificador", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const EN = "What is the AUC of p-tau217?";
    await t.run(async (ctx) => {
      const { claveDe } = await import("./cachePlan");
      await ctx.db.insert("planes", {
        clave: claveDe(PREGUNTA, "openai/gpt-5.4", "v5"),
        pregunta: PREGUNTA, modelo: "openai/gpt-5.4", version: "v5", clase: "documental",
        items: [], preguntaEn: EN, creadoEn: Date.now(), usos: 1,
      });
    });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    await correrEn(t, ids);
    expect(clasificar).not.toHaveBeenCalled();
    const plan = ejecutarPlan.mock.calls[0][2] as Array<{ id: string; queryEn: string }>;
    expect(plan[0].queryEn).toBe(EN);
  });

  test("en modo extendido manda el inglés del planificador; si viene vacío, queda el del clasificador; las reformulaciones viajan al plan", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, consultaEn: "classifier english" });
    planificar.mockResolvedValue({
      items: [{ id: "x", query: "especificidad", queryEn: "specificity", evidenceNeeded: "esp", variantes: ["true negative rate"] }],
      preguntaEn: "planner english",
      variantesPregunta: ["phosphorylated tau 217 AUC"],
    });
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [frag("c2")] } };

    const m = await correrEn(t, ids, { modo: "extendido" });

    const plan = ejecutarPlan.mock.calls[0][2] as Array<{ id: string; queryEn: string; variantes?: string[] }>;
    expect(plan[0].queryEn).toBe("planner english");
    expect(plan[0].variantes).toEqual(["phosphorylated tau 217 AUC"]);
    expect(plan[1].variantes).toEqual(["true negative rate"]);
    expect(m.plan).toEqual([
      { id: "e0", query: PREGUNTA, query_en: "planner english", evidence_needed: planner.ANCLA_EVIDENCE_NEEDED, variantes: ["phosphorylated tau 217 AUC"] },
      { id: "e1", query: "especificidad", query_en: "specificity", evidence_needed: "esp", variantes: ["true negative rate"] },
    ]);
    const filas = await t.run((ctx) => ctx.db.query("planes").collect());
    expect(filas[0].variantes).toEqual(["phosphorylated tau 217 AUC"]);

    // Planificador sin inglés: se conserva el del clasificador.
    const t2 = nuevaBase();
    const ids2 = await sembrar(t2);
    planificar.mockResolvedValue({ items: [], preguntaEn: "" });
    await correrEn(t2, ids2, { modo: "extendido" });
    const plan2 = ejecutarPlan.mock.calls[ejecutarPlan.mock.calls.length - 1][2] as Array<{ queryEn: string }>;
    expect(plan2[0].queryEn).toBe("classifier english");
  });

  test("ADVERSARIAL: repetir una reformulación del plan como búsqueda extra no se ejecuta", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planificar.mockResolvedValue({ items: [], preguntaEn: "", variantesPregunta: ["phosphorylated tau 217 AUC"] });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) => resultadoExtra(punto, consulta, [frag("c1")], {}, e));
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_v", { semantico: "Phosphorylated tau 217 AUC", punto: "e0" })]), rondaTexto(RESPUESTA)];
    await correrEn(t, ids, { modo: "extendido" });
    expect(busqueda).not.toHaveBeenCalled();
  });

  test("la telemetría lleva los candidatos de cada punto y de cada búsqueda extra, y las atribuciones a otra entidad", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    // El plan falso no calcula candidatos: la clave existe con lista vacía.
    busqueda.mockImplementation(async (_ctx, _propietario, consulta, e, punto) =>
      resultadoExtra(punto, consulta, [frag("x1", { page: 9 })], {
        candidatos: [{ f: "a.pdf", p: 9, loc: "pág. 9" }, { f: "b.pdf", p: 2, sec: "Results", loc: "pág. 2" }],
      }, e),
    );
    modelo.guiones = [rondaHerramientas([llamadaBuscar("call_a", { semantico: "specificity of p-tau217", punto: "e0" })]), rondaTexto(RESPUESTA)];
    const informe = informeVacio({
      afirmaciones: [
        { texto: "Redujo un 30 %", cita: "[a.pdf, pág. 3]", veredicto: "no_sostenida", motivo: "otra entidad", fragmento_id: "", fragmentos: ["c1"], entidad_distinta: true },
        { texto: "El AUC fue 0,94", cita: "[a.pdf, pág. 3]", veredicto: "sostenida", motivo: "ok", fragmento_id: "", fragmentos: ["c1"] },
      ],
      fidelidad: 0.5,
    });
    revisar.mockImplementation(async (_p, borrador) => aprobar(borrador, informe));

    const m = await correrEn(t, ids);

    const meta = metricasDe(m).meta;
    expect(meta.recuperacion).toEqual({
      e0: [],
      "extra:2": [{ f: "a.pdf", p: 9, loc: "pág. 9" }, { f: "b.pdf", p: 2, sec: "Results", loc: "pág. 2" }],
    });
    expect(meta.verificacion).toMatchObject({ no_sostenidas: 1, entidad_distinta: 1, sostenidas: 1 });
  });
});

// ---------------------------------------------------------------------------
// Latencia: verificación anticipada durante el stream y plan en paralelo
// ---------------------------------------------------------------------------
describe("solapes que no cambian ningún veredicto", () => {
  const parrafo = (n: number, cita: string) =>
    `${"Frase larga número " + n + " sobre la evidencia recuperada del estudio, con detalle suficiente para pasar del umbral. ".repeat(6).trim()} ${cita}`;

  test("el borrador se verifica por párrafos mientras llega, y la barrera arranca con esos veredictos", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const borrador = [parrafo(1, "[a.pdf, pág. 3]"), parrafo(2, "[a.pdf, pág. 3]"), parrafo(3, "[a.pdf, pág. 3]"), "Cola final [a.pdf, pág. 3]."].join("\n\n");
    // El stream entrega el borrador en trozos de 200 caracteres.
    const trozos: Trozo[] = [];
    for (let i = 0; i < borrador.length; i += 200) trozos.push({ texto: borrador.slice(i, i + 200) });
    trozos.push({ finishReason: "stop" }, { usage: USO, modelo: "openai/gpt-5.4" });
    modelo.porDefecto = trozos;
    // Cada verificación devuelve una afirmación sostenida distinta por texto.
    let n = 0;
    verificar.mockImplementation(async (texto) =>
      informeVacio({
        afirmaciones: [
          { texto: `frase ${++n} de ${texto.length}`, cita: "[a.pdf, pág. 3]", veredicto: "sostenida", motivo: "ok", fragmento_id: "", fragmentos: ["c1"] },
        ],
      }),
    );
    let verificacionesAlRevisar = -1;
    revisar.mockImplementation(async (_p, b, _m, _f, _r, _mapa, _t, _tel, opciones) => {
      verificacionesAlRevisar = verificar.mock.calls.length;
      expect(opciones?.veredictosIniciales?.size).toBeGreaterThanOrEqual(1);
      return aprobar(b);
    });

    const m = await correrEn(t, ids);

    expect(m.estado).toBe("listo");
    // Hubo verificaciones ANTES de la barrera, sobre textos parciales que
    // acaban en párrafo completo y son prefijos del borrador.
    expect(verificacionesAlRevisar).toBeGreaterThanOrEqual(1);
    for (const llamada of verificar.mock.calls) {
      const parcial = llamada[0] as string;
      expect(borrador.startsWith(parcial)).toBe(true);
      expect(parcial.endsWith("]") || parcial.endsWith(".")).toBe(true);
      expect((llamada[5] as { pregunta?: string }).pregunta).toBe(PREGUNTA);
    }
    expect(metricasDe(m).counters.verificaciones_anticipadas).toBe(verificacionesAlRevisar);
    expect(metricasDe(m).meta.veredictos_anticipados).toBeGreaterThanOrEqual(1);
  });

  test("un borrador corto no dispara verificaciones anticipadas; con la verificación apagada tampoco", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    await correrEn(t, ids);
    expect(verificar).not.toHaveBeenCalled();
    expect(metricasDe(await fila(t, ids.messageId)).counters.verificaciones_anticipadas).toBeUndefined();
  });

  test("sin historial, el planificador arranca a la vez que el clasificador con la pregunta literal; con historial espera a la consulta autónoma", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    vi.stubEnv("ENABLE_QUERY_PLANNING", "true");
    let planificarAntesDeClasificar = false;
    clasificar.mockImplementation(async () => {
      planificarAntesDeClasificar = planificar.mock.calls.length === 1;
      return { clase: "documental", consulta: PREGUNTA };
    });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    await correrEn(t, ids, { modo: "extendido" });
    expect(planificarAntesDeClasificar).toBe(true);
    expect(planificar).toHaveBeenCalledTimes(1);
    expect(planificar).toHaveBeenCalledWith(PREGUNTA, [], expect.any(Number), expect.anything());

    // Con historial, la consulta autónoma manda y el planificador espera.
    const t2 = nuevaBase();
    const ids2 = await sembrar(t2);
    const historial = [{ role: "user", content: "háblame de p-tau217" }, { role: "assistant", content: "Es un biomarcador [a.pdf, pág. 1]." }];
    clasificar.mockResolvedValue({ clase: "documental", consulta: "AUC de p-tau217 en la otra cohorte" });
    planificar.mockClear();
    await correrEn(t2, ids2, { modo: "extendido", texto: "¿y en la otra cohorte?", historial });
    expect(planificar).toHaveBeenCalledTimes(1);
    expect(planificar.mock.calls[0][0]).toBe("AUC de p-tau217 en la otra cohorte");
    expect(planificar.mock.calls[0][1]).toEqual(historial);
  });
});

// ---------------------------------------------------------------------------
// Alcance: la pregunta pide limitarse a un documento
// ---------------------------------------------------------------------------
describe("alcance de la pregunta a un documento", () => {
  async function conDocumentos(t: Base, ids: Ids, nombres: string[]): Promise<Id<"documents">[]> {
    return await t.run(async (ctx) => {
      const salida: Id<"documents">[] = [];
      for (const fileName of nombres) {
        salida.push(
          await ctx.db.insert("documents", {
            fileName, sha256: fileName, pages: 1, chunks: 1, status: "ready", propietario: ids.userId, ingestadoEn: 1,
          }),
        );
      }
      return salida;
    });
  }
  const mensajesDelRedactor = () => mensajesDe(modelo.llamadas[0]);
  const notaDeSistema = () => mensajesDelRedactor().filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

  test("el caso medido: 'únicamente el PDF indexado' con un solo PDF limita el plan a ese documento", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t, "Usando únicamente el PDF indexado, analiza este escenario");
    const [pdf] = await conDocumentos(t, ids, ["--M6U1_PDF.pdf", "notas.docx"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF indexado" });
    porPunto = { e0: { fragmentos: [frag("c1", { sourceFile: "--M6U1_PDF.pdf" })] } };
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { texto: "Usando únicamente el PDF indexado, analiza este escenario" }));

    expect(ejecutarPlan).toHaveBeenCalledTimes(1);
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({ documentId: String(pdf) });
    const conAlcance = escrituras.filter((c) => c.alcance);
    expect(conAlcance.length).toBeGreaterThan(0);
    expect(conAlcance[conAlcance.length - 1].alcance).toEqual({
      pista: "el PDF indexado", documento: "--M6U1_PDF.pdf", candidatos: undefined, encontrado: true,
    });
    expect(notaDeSistema()).toContain("únicamente con el documento «--M6U1_PDF.pdf»");
    const m = await fila(t, ids.messageId);
    expect(m.estado).toBe("listo");
    expect(metricasDe(m).meta.alcance).toBe("elegido");
  });

  test("ADVERSARIAL: una búsqueda extra del modelo no puede salirse del documento, ni al relajar sus propios filtros", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const [pdf] = await conDocumentos(t, ids, ["M6U1.pdf"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF M6U1" });
    porPunto = { e0: { fragmentos: [frag("c1", { sourceFile: "M6U1.pdf" })] } };
    modelo.guiones = [
      rondaHerramientas([llamadaBuscar("t1", { semantico: "alternador", language: "es" })]),
      rondaTexto(RESPUESTA),
    ];
    // Con el filtro del modelo (idioma) no hay nada; sin él, sí.
    busqueda.mockImplementation(async (_ctx, _u, consulta, _ev, punto, _modo, filtros) =>
      resultadoExtra(punto, consulta, (filtros as { language?: string }).language ? [] : [frag("c9", { sourceFile: "M6U1.pdf" })]),
    );
    const { ctx } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { modo: EXTENDIDO.nombre }));

    expect(busqueda).toHaveBeenCalledTimes(2);
    // La primera lleva el filtro del modelo Y el del alcance; el reintento
    // quita el del modelo pero conserva el documento.
    expect(busqueda.mock.calls[0][6]).toEqual({ language: "es", documentId: String(pdf) });
    expect(busqueda.mock.calls[1][6]).toEqual({ documentId: String(pdf) });
    const aviso = herramientaDe(modelo.llamadas[1], "t1");
    expect(aviso).toContain('language="es"');
    expect(aviso).not.toContain("documentId");
  });

  test("si el documento acotado no tiene nada, se busca en todos y la respuesta tiene que decirlo", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const [pdf] = await conDocumentos(t, ids, ["M6U1.pdf", "otro.pdf"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF M6U1" });
    // Primera llamada (acotada): nada. Segunda (sin filtros): un fragmento de otro documento.
    let llamada = 0;
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan) => {
      llamada += 1;
      porPunto = llamada === 1 ? {} : { e0: { fragmentos: [frag("c1", { sourceFile: "otro.pdf" })] } };
      return evidenciaDe(plan);
    });
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids));

    expect(ejecutarPlan).toHaveBeenCalledTimes(2);
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({ documentId: String(pdf) });
    expect(ejecutarPlan.mock.calls[1][4]).toEqual({});
    const ultimo = escrituras.filter((c) => c.alcance).pop();
    expect(ultimo?.alcance).toMatchObject({ documento: "M6U1.pdf", encontrado: false });
    expect(notaDeSistema()).toContain("no se encontró NADA sobre esto");
    expect(notaDeSistema()).toContain("No le atribuyas a ese documento ningún dato");
    const m = await fila(t, ids.messageId);
    expect(metricasDe(m).counters.alcance_sin_resultados).toBe(1);
  });

  test("ADVERSARIAL: con varios PDF, 'el PDF' no elige ninguno: se busca en todos y se exige decir de cuál sale cada dato", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    await conDocumentos(t, ids, ["a.pdf", "b.pdf", "c.pdf"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF indexado" });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids));

    expect(ejecutarPlan).toHaveBeenCalledTimes(1);
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({});
    const ultimo = escrituras.filter((c) => c.alcance).pop();
    expect(ultimo?.alcance).toEqual({ pista: "el PDF indexado", documento: null, candidatos: 3, encontrado: true });
    expect(notaDeSistema()).toContain("hay 3 que encajan");
    expect(notaDeSistema()).toContain("de qué documento sale cada dato");
  });

  test("una pista que no corresponde a ningún documento avisa; sin pista no se escribe alcance ni se listan documentos", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    await conDocumentos(t, ids, ["a.pdf"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF de Smith 2020" });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx, escrituras } = ctxDirecto(t);
    await handlerDirecto(ctx, argsDe(ids));
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({});
    expect(escrituras.filter((c) => c.alcance).pop()?.alcance).toMatchObject({ documento: null, encontrado: true });
    expect(notaDeSistema()).toContain("ningún documento indexado se llama así");

    const t2 = nuevaBase();
    const ids2 = await sembrar(t2);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "" });
    const { ctx: ctx2, escrituras: escrituras2 } = ctxDirecto(t2);
    await handlerDirecto(ctx2, argsDe(ids2));
    expect(escrituras2.some((c) => c.alcance)).toBe(false);
    expect(mensajesDe(modelo.llamadas[modelo.llamadas.length - 1]).some((m) => String(m.content).includes("ALCANCE"))).toBe(false);
  });

  test("la pista sobrevive a la caché del plan: la segunda vez, sin clasificador, se acota igual", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const [pdf] = await conDocumentos(t, ids, ["M6U1.pdf", "otro.docx"]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF" });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    await handlerDirecto(ctxDirecto(t).ctx, argsDe(ids));
    expect(clasificar).toHaveBeenCalledTimes(1);

    const ids2 = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", { titulo: "otra", userId: ids.userId, creadoEn: 2 });
      const messageId = await ctx.db.insert("messages", { sessionId, userId: ids.userId, role: "assistant", content: "", estado: "pensando", creadoEn: 3 });
      return { userId: ids.userId, sessionId, messageId };
    });
    await handlerDirecto(ctxDirecto(t).ctx, argsDe(ids2));
    // El clasificador no volvió a correr (clase en caché) y el filtro sigue ahí.
    expect(clasificar).toHaveBeenCalledTimes(1);
    expect(ejecutarPlan.mock.calls[1][4]).toEqual({ documentId: String(pdf) });
  });
});

// ---------------------------------------------------------------------------
// Avance visible dentro de las fases largas
// ---------------------------------------------------------------------------
describe("progreso del turno", () => {
  test("la barrera escribe el avance del verificador y de la corrección, y no repite el mismo texto", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    revisar.mockImplementation(async (_pregunta, borrador, _m, _f, _r, _mapa, _t, _tel, opciones) => {
      const avisar = opciones?.alAvanzar;
      avisar?.({ fase: "verificando", hechas: 0, total: 31 });
      avisar?.({ fase: "verificando", hechas: 12, total: 31 });
      avisar?.({ fase: "verificando", hechas: 12, total: 31 });
      avisar?.({ fase: "corrigiendo", ronda: 1, rondas: 2, fallos: 3 });
      avisar?.({ fase: "verificando", hechas: 0, total: 3 });
      avisar?.({ fase: "verificando", hechas: 3, total: 3 });
      return aprobar(borrador);
    });
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids));

    const progresos = escrituras.filter((c) => typeof c.progreso === "string").map((c) => c.progreso);
    expect(progresos).toEqual([
      "Contrastando cada afirmación con su fuente",
      "Comprobando 31 afirmaciones · 0 de 31 listas",
      "Comprobando 31 afirmaciones · 12 de 31 listas",
      "Corrigiendo 3 afirmaciones sin respaldo · ronda 1 de 2",
      "Comprobando 3 afirmaciones · 0 de 3 listas",
      "Comprobando 3 afirmaciones · 3 de 3 listas",
    ]);
    // El estado `revisando` y el primer texto van en la misma escritura: la
    // fase nunca aparece muda.
    const revisando = escrituras.find((c) => c.estado === "revisando");
    expect(revisando?.progreso).toBe("Contrastando cada afirmación con su fuente");
    const m = await fila(t, ids.messageId);
    expect(m.estado).toBe("listo");
  });
});

// ---------------------------------------------------------------------------
// Cada parte de la pregunta se marca en cuanto termina
// ---------------------------------------------------------------------------
describe("los hops del plan se escriben punto por punto", () => {
  /** El hop en la forma corta que le importa a la interfaz: "buscando" (una
   *  búsqueda en marcha) o el estado con el que se cerró. */
  const forma = (h: Hop): string => (h.en_curso ? "buscando" : `${h.estado}/${h.recuperacion}`);
  const escrituraDeHops = (escrituras: Array<Record<string, unknown>>): string[][] =>
    escrituras.filter((c) => Array.isArray(c.hops)).map((c) => (c.hops as Hop[]).map(forma));

  const planDeDos = () =>
    planificar.mockResolvedValue({
      items: [
        { id: "x", query: "especificidad de p-tau217", queryEn: "specificity of p-tau217", evidenceNeeded: "especificidad" },
      ],
      preguntaEn: "What is the AUC of p-tau217?",
    });

  test("primero un marcador por punto y luego cada punto según acaba, sin esperar a los demás", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planDeDos();
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [frag("c2", { page: 8 })] } };
    // El segundo punto del plan acaba ANTES que el primero, que es lo que pasa
    // de verdad: se buscan en paralelo y cada calificador tarda lo suyo.
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan, _modo, _filtros, _tel, _limite, opciones) => {
      const ev = evidenciaDe(plan);
      for (const i of [1, 0]) {
        opciones?.alTerminarPunto?.(ev.puntos[i], i);
        await Promise.resolve();
      }
      return ev;
    });
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { modo: EXTENDIDO.nombre }));

    const secuencia = escrituraDeHops(escrituras);
    // Los dos marcadores, luego el segundo punto hecho, luego los dos.
    expect(secuencia.slice(0, 3)).toEqual([
      ["buscando", "buscando"],
      ["buscando", "cubierto/hibrida"],
      ["cubierto/hibrida", "cubierto/hibrida"],
    ]);
    // Y el marcador llega ANTES de que se ejecute el plan: la interfaz enseña
    // las partes buscando desde el primer instante.
    const antesDelPlan = escrituras.findIndex((c) => Array.isArray(c.hops));
    expect(antesDelPlan).toBeGreaterThanOrEqual(0);
    expect(escrituras[antesDelPlan].hops).toHaveLength(2);

    // El estado final es exactamente el de siempre: los hops del retorno, con
    // su tiempo y sus documentos, y ninguno marcado como en curso.
    const m = await fila(t, ids.messageId);
    const finales = hopsDe(m);
    expect(finales.map((h) => [h.n, h.plan_item, h.resultados, h.estado])).toEqual([
      [1, "e0", 1, "cubierto"],
      [2, "e1", 1, "cubierto"],
    ]);
    expect(finales.every((h) => h.en_curso === false || h.en_curso === undefined)).toBe(true);
    expect(finales.every((h) => Number(h.ms ?? 0) > 0)).toBe(true);
  });

  test("ADVERSARIAL: un punto que falla al instante se escribe como fallo, no como buscando", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planDeDos();
    // El primer punto falla con cero resultados y cero ms: la misma terna que
    // el marcador. Si "en curso" se infiriera de ella, esa parte de la
    // pregunta se quedaría con el reloj girando hasta el final del turno.
    porPunto = { e0: { fragmentos: [], recuperacion: "error" }, e1: { fragmentos: [frag("c2")] } };
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan, _modo, _filtros, _tel, _limite, opciones) => {
      const ev = evidenciaDe(plan);
      ev.puntos[0] = { ...ev.puntos[0], ms: 0 };
      opciones?.alTerminarPunto?.(ev.puntos[0], 0);
      opciones?.alTerminarPunto?.(ev.puntos[1], 1);
      return ev;
    });
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { modo: EXTENDIDO.nombre }));

    const ultima = escrituraDeHops(escrituras).pop();
    expect(ultima).toEqual(["sin_resultados/error", "cubierto/hibrida"]);
    const fallado = hopsDe(await fila(t, ids.messageId))[0];
    expect(fallado.en_curso).toBe(false);
    expect(fallado.ms).toBe(0);
  });

  test("ADVERSARIAL: si el aviso de un punto no llega, el estado final sale igual del retorno", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planDeDos();
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [frag("c2")] } };
    // Solo avisa del segundo, y del primero avisa con un valor equivocado.
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan, _modo, _filtros, _tel, _limite, opciones) => {
      const ev = evidenciaDe(plan);
      opciones?.alTerminarPunto?.({ ...ev.puntos[0], fragmentos: [], estado: "sin_resultados" }, 0);
      return ev;
    });
    const { ctx } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { modo: EXTENDIDO.nombre }));

    const finales = hopsDe(await fila(t, ids.messageId));
    expect(finales.map((h) => [h.plan_item, h.resultados, h.estado])).toEqual([
      ["e0", 1, "cubierto"],
      ["e1", 1, "cubierto"],
    ]);
    expect(finales.some((h) => h.en_curso === true)).toBe(false);
  });

  test("ADVERSARIAL: una escritura de avance que llega tarde no puede pisar el estado final", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    planDeDos();
    porPunto = { e0: { fragmentos: [frag("c1")] }, e1: { fragmentos: [frag("c2")] } };
    ejecutarPlan.mockImplementation(async (_ctx, _propietario, plan, _modo, _filtros, _tel, _limite, opciones) => {
      const ev = evidenciaDe(plan);
      // Los dos avisos, sin ceder el turno: sus escrituras se encolan y se
      // resuelven mientras el bucle sigue.
      opciones?.alTerminarPunto?.(ev.puntos[0], 0);
      opciones?.alTerminarPunto?.(ev.puntos[1], 1);
      return ev;
    });
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids, { modo: EXTENDIDO.nombre }));

    // Ninguna escritura posterior a la de las fuentes deja un hop en curso.
    const conFuentes = escrituras.findIndex((c) => Array.isArray(c.sources) && (c.sources as unknown[]).length > 0);
    expect(conFuentes).toBeGreaterThan(0);
    for (const c of escrituras.slice(conFuentes)) {
      if (!Array.isArray(c.hops)) continue;
      expect((c.hops as Hop[]).some((h) => h.en_curso)).toBe(false);
    }
    const m = await fila(t, ids.messageId);
    expect(hopsDe(m).every((h) => !h.en_curso)).toBe(true);
    expect(m.estado).toBe("listo");
  });
});

describe("alcance por el contenido cuando la pista no nombra el fichero", () => {
  /** Documento con fragmentos suyos, para que la pista se pueda resolver por
   *  el índice léxico igual que en producción. */
  async function conCorpus(t: Base, ids: Ids, docs: Array<[fileName: string, texto: string, n: number]>) {
    return await t.run(async (ctx) => {
      const salida: Id<"documents">[] = [];
      for (const [fileName, texto, n] of docs) {
        const documentRef = await ctx.db.insert("documents", {
          fileName, sha256: fileName, pages: 1, chunks: n, status: "ready", propietario: ids.userId, ingestadoEn: 1,
        });
        for (let i = 0; i < n; i++) {
          await ctx.db.insert("chunks", {
            text: texto, contexto: "", embedding: [], sourceFile: fileName, page: 1, chunkType: "text",
            documentId: String(documentRef), documentRef, propietario: ids.userId,
          });
        }
        salida.push(documentRef);
      }
      return salida;
    });
  }
  const notaDeSistema = () =>
    mensajesDe(modelo.llamadas[0]).filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

  test("el caso medido: 'el PDF de sistemas eléctricos y electrónicos de aeronaves' se resuelve al único que trata de eso", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    const [electrico] = await conCorpus(t, ids, [
      ["--M6U1_PDF.pdf", "El sistema eléctrico de la aeronave y sus sistemas electrónicos", 10],
      ["meteorologia.pdf", "La aeronave despega con viento cruzado", 4],
    ]);
    clasificar.mockResolvedValue({
      clase: "documental", consulta: PREGUNTA, documento: "el PDF de sistemas eléctricos y electrónicos de aeronaves",
    });
    porPunto = { e0: { fragmentos: [frag("c1", { sourceFile: "--M6U1_PDF.pdf" })] } };
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids));

    // El nombre del fichero no dice nada de sistemas eléctricos: quien lo
    // resuelve es el índice, y la búsqueda queda acotada igual.
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({ documentId: String(electrico) });
    expect(escrituras.filter((c) => c.alcance).pop()?.alcance).toMatchObject({
      documento: "--M6U1_PDF.pdf", por_contenido: true, encontrado: true,
    });
    // Y el redactor tiene que decir con qué documento está respondiendo,
    // porque el documento se dedujo del tema y pudo deducirse mal.
    expect(notaDeSistema()).toContain("No lo nombró");
    expect(notaDeSistema()).toContain("di al principio de la respuesta con qué documento estás respondiendo");
    const m = await fila(t, ids.messageId);
    expect(metricasDe(m).counters.alcance_por_contenido).toBe(1);
    expect(metricasDe(m).meta.alcance).toBe("elegido");
  });

  test("ADVERSARIAL: si el tema está repartido entre documentos no se acota a ninguno", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    await conCorpus(t, ids, [
      ["uno.pdf", "El sistema eléctrico de la aeronave", 6],
      ["dos.pdf", "El sistema eléctrico de la aeronave", 6],
    ]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "el PDF del sistema eléctrico de la aeronave" });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    const { ctx, escrituras } = ctxDirecto(t);

    await handlerDirecto(ctx, argsDe(ids));

    expect(ejecutarPlan.mock.calls[0][4]).toEqual({});
    expect(escrituras.filter((c) => c.alcance).pop()?.alcance).toMatchObject({ documento: null });
    expect(notaDeSistema()).toContain("ningún documento indexado se llama así");
    expect(metricasDe(await fila(t, ids.messageId)).counters.alcance_por_contenido).toBeUndefined();
  });

  test("ADVERSARIAL: el nombre manda sobre el contenido, y el documento de otra persona no se elige", async () => {
    const t = nuevaBase();
    const ids = await sembrar(t);
    // "guia_hta" encaja por NOMBRE; el otro documento propio habla mucho más
    // de hipertensión, y no debe ganarle al nombre.
    const [guia] = await conCorpus(t, ids, [
      ["guia_hta.pdf", "Recomendaciones de tratamiento", 2],
      ["revision.pdf", "La hipertensión arterial y su guía de manejo de la hipertensión", 20],
    ]);
    clasificar.mockResolvedValue({ clase: "documental", consulta: PREGUNTA, documento: "la guía HTA" });
    porPunto = { e0: { fragmentos: [frag("c1")] } };
    await handlerDirecto(ctxDirecto(t).ctx, argsDe(ids));
    expect(ejecutarPlan.mock.calls[0][4]).toEqual({ documentId: String(guia) });

    // Y una pista que solo casa con el documento de OTRA cuenta no elige
    // nada: ese documento, para quien pregunta, no existe.
    const t2 = nuevaBase();
    const ids2 = await sembrar(t2);
    await conCorpus(t2, ids2, [["propio.pdf", "Notas de la reunión", 2]]);
    await t2.run(async (ctx) => {
      const otro = await ctx.db.insert("users", {
        email: "otro@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      });
      const ajeno = await ctx.db.insert("documents", {
        fileName: "ajeno.pdf", sha256: "ajeno", pages: 1, chunks: 20, status: "ready", propietario: otro, ingestadoEn: 1,
      });
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("chunks", {
          text: "El sistema eléctrico de la aeronave y sus sistemas electrónicos", contexto: "", embedding: [],
          sourceFile: "ajeno.pdf", page: 1, chunkType: "text", documentId: String(ajeno), documentRef: ajeno, propietario: otro,
        });
      }
    });
    clasificar.mockResolvedValue({
      clase: "documental", consulta: PREGUNTA, documento: "el PDF de sistemas eléctricos y electrónicos de aeronaves",
    });
    const { escrituras } = ctxDirecto(t2);
    await handlerDirecto(ctxDirecto(t2).ctx, argsDe(ids2));
    expect(ejecutarPlan.mock.calls[1][4]).toEqual({});
    expect(escrituras.every((c) => !c.alcance || (c.alcance as { documento: string | null }).documento === null)).toBe(true);
  });
});
