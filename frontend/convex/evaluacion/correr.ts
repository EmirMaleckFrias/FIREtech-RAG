// La corrida de la evaluación continua: responde con el agente REAL cada
// pregunta de control aprobada por la usuaria y la puntúa con la misma lógica
// determinista del benchmark (puntuar.ts). Es lo que `scripts/evaluar.ts`
// hace desde la terminal, hecho desde dentro de Convex para que corra solo
// (cron semanal) o con un botón (Ajustes > Calidad), sin terminal ni claves.
//
// Cómo se encadena y por qué así:
//
// - **Un caso por acción, no la corrida entera.** Una acción de Convex muere
//   a los 600 s y una pregunta en modo extendido puede tardar 4 o 5 minutos.
//   `paso` lanza UN turno, espera a que termine, lo puntúa y se reagenda para
//   el siguiente (o para la siguiente repetición del mismo). Una corrida de 30
//   casos son 30 acciones cortas y no una que se corta a la mitad.
// - **La lista de casos viaja en los argumentos de la cadena.** Se fija al
//   iniciar y no se vuelve a leer: si la usuaria aprueba o descarta preguntas
//   mientras la corrida está en marcha, los índices no se mueven bajo los
//   pies del `paso` siguiente.
// - **La conversación que crea cada caso es OCULTA** (`sessions.oculta`): el
//   agente la responde como cualquier otra, pero no aparece en la barra
//   lateral, no suma a los contadores de preguntas de la persona y se borra
//   al puntuarla. Por eso NO se borra con `mensajes.borrarMensajesDeSesion`:
//   esa función descuenta contadores (`desanotarPregunta`) y aquí nunca se
//   sumaron; restarlos dejaría las cifras de Ajustes por debajo de la verdad.
// - **Un turno que acaba en error puntúa como fallo y la corrida sigue.** Solo
//   un fallo de la propia maquinaria (no se pudo crear la conversación, no se
//   pudo guardar el resultado) marca la corrida `error`, y en ese caso la
//   conversación oculta se borra igual: nada de lo que hace la evaluación
//   puede quedarse visible o vivo en la cuenta de la usuaria.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes } from "../lib/config";
import { VERSION_PROMPT } from "../agente/prompt";
import { ESPERA_COLGADO_MS, LONGITUD_TITULO, LOTE_MENSAJES } from "../mensajes";
import {
  agregarCorridas,
  puntuarCaso,
  resumir,
  validarCaso,
  type Caso,
  type Puntuacion,
  type Resultado,
  type ResultadoAgregado,
} from "./puntuar";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
/** Casos aprobados que entran en una corrida. Las filas de `evaluacionCasos`
 *  son pequeñas (la definición son unos KB), así que 500 caben de sobra en
 *  una transacción y son muchas más preguntas de control de las que una
 *  persona revisa a mano. */
export const MAX_CASOS_POR_CORRIDA = 500;
/** Cuánto se espera al turno del asistente. La acción muere a los 600 s y el
 *  perro guardián del turno salta a los 630 (`ESPERA_COLGADO_MS`): con 570 se
 *  puntúa el caso como "no terminó" y se pasa al siguiente antes de que la
 *  plataforma mate la acción y se pierda todo. */
export const ESPERA_TURNO_MS = 570_000;
/** Cada cuánto se consulta el turno mientras se espera. */
export const INTERVALO_SONDEO_MS = 3_000;
/** Lo más que puede durar UN turno de la corrida de principio a fin: la
 *  espera al asistente (`ESPERA_TURNO_MS`), puntuar y guardar, borrar la
 *  conversación y reagendar. La acción entera muere a los 600 s, así que un
 *  turno sano nunca pasa de ahí; los cinco minutos de más son margen para los
 *  retrasos del planificador de Convex. */
export const TURNO_MAX_MS = 15 * 60_000;
/** Ninguna corrida se da por colgada antes de esto, por corta que sea. */
export const CORRIDA_COLGADA_MIN_MS = 60 * 60_000;
/** Cuánto se mira hacia atrás al buscar corridas colgadas: mirar más de 30
 *  días atrás es recorrer historia por nada. */
const VENTANA_COLGADAS_MS = 30 * 86_400_000;
/** Lo que lee la usuaria en una corrida cerrada por el barrido. */
export const ERROR_CORRIDA_COLGADA = "La evaluación no terminó en el tiempo previsto.";

/** Cuánto puede llevar viva, como mucho, una corrida sana con ese avance.
 *
 *  Antes el tope era fijo (4 h) y mataba corridas que iban bien: la corrida
 *  admite 500 casos con 3 repeticiones y un turno en modo extendido tarda
 *  4 o 5 minutos, así que 25 casos con 3 repeticiones ya son más de 6 h. El
 *  tope tiene que depender del trabajo: mientras se responde el caso `i`
 *  (0-based), `casosHechos` vale `i`, y los turnos hechos o en marcha son a lo
 *  sumo `(i + 1) * repeticiones`, cada uno de menos de `TURNO_MAX_MS`. Una
 *  corrida que lleve viva más que eso ha dejado de avanzar: la cadena se cortó
 *  sin pasar por su `catch` (un despliegue a mitad, la plataforma). Es la
 *  misma lógica que `datos.generacionColgada` para las generaciones. */
export function limiteDeCorrida(c: { casosHechos: number; repeticiones: number }): number {
  const turnos = (Math.max(0, c.casosHechos) + 1) * Math.max(1, c.repeticiones);
  return Math.max(CORRIDA_COLGADA_MIN_MS, turnos * TURNO_MAX_MS);
}

export function corridaColgada(
  c: { estado: string; empezadoEn: number; casosHechos: number; repeticiones: number },
  ahora: number,
): boolean {
  return c.estado === "running" && ahora - c.empezadoEn > limiteDeCorrida(c);
}
/** La corrida programada semanal no repite si la última empezó hace menos de
 *  esto: el cron corre cada 168 h exactas y medir 7 días justos dejaría una
 *  de cada dos fuera por segundos. */
export const INTERVALO_PROGRAMADA_MS = 6 * 86_400_000;
/** Casos aprobados que hacen falta para que la corrida programada se lance
 *  sola. Con menos, el resumen no dice nada que la usuaria no vea pulsando
 *  "Evaluar ahora". */
export const MIN_CASOS_PROGRAMADA = 5;
/** Respuesta guardada por corrida, recortada: es para ver POR QUÉ falló, no
 *  para conservar la conversación. */
export const RESPUESTA_MAX = 4_000;
/** Cuentas que se recorren al repartir las corridas programadas. */
const MAX_USUARIOS = 2_000;

/** Espera del sondeo del turno. Configurable SOLO para los tests, que no
 *  pueden esperar 3 s reales por consulta ni 570 s por un turno que no llega. */
let espera = { intervaloMs: INTERVALO_SONDEO_MS, maxMs: ESPERA_TURNO_MS };
export function configurarEspera(nueva: Partial<typeof espera>): void {
  espera = { ...espera, ...nueva };
}

const disparo = v.union(v.literal("manual"), v.literal("programada"));

// ---------------------------------------------------------------------------
// Iniciar
// ---------------------------------------------------------------------------
/** Crea la corrida con los casos aprobados de la cuenta (por clave) y agenda
 *  el primer `paso`. Devuelve null, sin crear nada, si no hay ninguno: quien
 *  llama ya lo comprobó, pero un `iniciar` a ciegas no debe dejar una corrida
 *  vacía en el historial. Exportada como función para que `datos.evaluarAhora`
 *  y `repartir` la usen dentro de su propia transacción. */
export async function iniciarCorrida(
  ctx: MutationCtx,
  args: { propietario: Id<"users">; disparo: "manual" | "programada"; repeticiones: number; ahora?: number },
): Promise<Id<"evaluacionCorridas"> | null> {
  const aprobados = await ctx.db
    .query("evaluacionCasos")
    .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", args.propietario).eq("estado", "aprobado"))
    .take(MAX_CASOS_POR_CORRIDA);
  if (!aprobados.length) return null;
  // Por clave y no por fecha: el orden de la corrida es el orden en que la
  // usuaria ve sus preguntas, y una corrida se compara con la anterior caso a
  // caso.
  aprobados.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
  const repeticiones = Math.max(1, Math.floor(args.repeticiones) || 1);
  const a = ajustes();
  const corridaId = await ctx.db.insert("evaluacionCorridas", {
    propietario: args.propietario,
    empezadoEn: args.ahora ?? Date.now(),
    estado: "running",
    disparo: args.disparo,
    casosTotal: aprobados.length,
    casosHechos: 0,
    repeticiones,
    versionPrompt: VERSION_PROMPT,
    modelo: a.modelo,
  });
  await ctx.scheduler.runAfter(0, internal.evaluacion.correr.paso, {
    corridaId,
    casos: aprobados.map((c) => c._id),
    indice: 0,
    rep: 1,
  });
  return corridaId;
}

export const iniciar = internalMutation({
  args: {
    propietario: v.id("users"),
    disparo,
    repeticiones: v.number(),
    ahora: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"evaluacionCorridas"> | null> => await iniciarCorrida(ctx, args),
});

// ---------------------------------------------------------------------------
// Lecturas y escrituras que usa `paso`
// ---------------------------------------------------------------------------
export const leerCorrida = internalQuery({
  args: { corridaId: v.id("evaluacionCorridas") },
  handler: async (ctx, { corridaId }): Promise<Doc<"evaluacionCorridas"> | null> => await ctx.db.get(corridaId),
});

export const leerCaso = internalQuery({
  args: { casoId: v.id("evaluacionCasos") },
  handler: async (ctx, { casoId }): Promise<Doc<"evaluacionCasos"> | null> => await ctx.db.get(casoId),
});

/** Crea la conversación OCULTA de un caso, con la pregunta y el turno del
 *  asistente en `pensando`, y agenda al agente y su perro guardián, igual que
 *  `mensajes.enviar` y `pruebas.prepararPregunta`. Lo que NO hace, a
 *  propósito: anotar la pregunta en los contadores. Una pregunta de control
 *  no es una pregunta de la persona. */
export const lanzar = internalMutation({
  args: { corridaId: v.id("evaluacionCorridas"), casoId: v.id("evaluacionCasos") },
  handler: async (ctx, { corridaId, casoId }): Promise<{ sessionId: Id<"sessions">; messageId: Id<"messages"> }> => {
    const corrida = await ctx.db.get(corridaId);
    if (!corrida) throw new Error("la corrida ya no existe");
    const caso = await ctx.db.get(casoId);
    if (!caso) throw new Error("la pregunta de control ya no existe");
    const ahora = Date.now();
    const sessionId = await ctx.db.insert("sessions", {
      titulo: caso.pregunta.slice(0, LONGITUD_TITULO),
      userId: corrida.propietario,
      creadoEn: ahora,
      oculta: true,
    });
    await ctx.db.insert("messages", {
      sessionId,
      userId: corrida.propietario,
      role: "user",
      content: caso.pregunta,
      creadoEn: ahora,
    });
    // +1 ms, como en `enviar`: el índice ordena por `creadoEn`.
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      userId: corrida.propietario,
      role: "assistant",
      content: "",
      estado: "pensando",
      creadoEn: ahora + 1,
    });
    await ctx.scheduler.runAfter(0, internal.agente.bucle.correr, {
      messageId,
      sessionId,
      userId: corrida.propietario,
      texto: caso.pregunta,
      modo: caso.modo,
      historial: [],
    });
    await ctx.scheduler.runAfter(ESPERA_COLGADO_MS, internal.mensajes.marcarColgado, { messageId });
    await ctx.db.patch(corridaId, { casoActual: caso.clave });
    return { sessionId, messageId };
  },
});

/** Una corrida cruda de un caso, recortada para guardarla: lo justo para ver
 *  por qué falló sin conservar la conversación. `puntuacion` va dentro porque
 *  el agregado de N repeticiones (`agregarCorridas`) necesita la puntuación de
 *  CADA una, y volver a puntuar exigiría guardar la respuesta entera con sus
 *  fuentes y sus hops. */
const corridaCruda = v.object({
  respuesta: v.string(),
  fuentes: v.array(
    v.object({
      source_file: v.string(),
      page: v.number(),
      section: v.string(),
      locator: v.string(),
    }),
  ),
  fallos: v.array(v.string()),
  ms: v.union(v.number(), v.null()),
  coste: v.union(v.number(), v.null()),
  error: v.union(v.string(), v.null()),
  puntuacion: v.any(),
});

type CorridaCruda = {
  respuesta: string;
  fuentes: Array<{ source_file: string; page: number; section: string; locator: string }>;
  fallos: string[];
  ms: number | null;
  coste: number | null;
  error: string | null;
  puntuacion: Puntuacion;
};

/** Guarda (o amplía) la fila de resultados del caso con una corrida más y
 *  recalcula el agregado sobre todas las que lleva. Se agrega en CADA
 *  repetición y no solo en la última: así la fila siempre es coherente aunque
 *  la cadena muera entre dos repeticiones, y con una sola repetición el
 *  agregado es la puntuación intacta más `runs`, `passed_rate` y `dispersion`. */
export const guardarResultado = internalMutation({
  args: {
    corridaId: v.id("evaluacionCorridas"),
    casoId: v.id("evaluacionCasos"),
    resultadoId: v.optional(v.id("evaluacionResultados")),
    clave: v.string(),
    pregunta: v.string(),
    modo: v.string(),
    categoria: v.string(),
    critico: v.boolean(),
    run: corridaCruda,
  },
  handler: async (ctx, args): Promise<Id<"evaluacionResultados">> => {
    const corrida = await ctx.db.get(args.corridaId);
    if (!corrida) throw new Error("la corrida ya no existe");
    const previa = args.resultadoId ? await ctx.db.get(args.resultadoId) : null;
    const runs: CorridaCruda[] = [...((previa?.corridas as CorridaCruda[] | undefined) ?? []), args.run as CorridaCruda];
    const [puntuacion, resultado] = agregarCorridas(
      runs.map((r) => r.puntuacion),
      runs.map(
        (r): Resultado => ({
          id: args.clave,
          question: args.pregunta,
          mode: args.modo,
          metrics: { cost_usd: r.coste ?? 0, ms_total: r.ms ?? 0 },
          error: r.error,
        }),
      ),
    );
    const fila = {
      corridaId: args.corridaId,
      propietario: corrida.propietario,
      casoId: args.casoId,
      clave: args.clave,
      pregunta: args.pregunta,
      categoria: args.categoria,
      critico: args.critico,
      puntuacion,
      resultado,
      corridas: runs,
      creadoEn: previa?.creadoEn ?? Date.now(),
    };
    if (previa) {
      await ctx.db.patch(previa._id, fila);
      return previa._id;
    }
    return await ctx.db.insert("evaluacionResultados", fila);
  },
});

/** Borra la conversación oculta con sus mensajes, SIN tocar contadores (ver la
 *  cabecera). Una conversación de control tiene dos mensajes y ningún voto;
 *  se recorre igual por lotes por si algo la hubiera engordado. Idempotente:
 *  borrar una que ya no existe no es un error. */
export const borrarSesionOculta = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }): Promise<{ borrada: boolean }> => {
    const mensajes = await ctx.db
      .query("messages")
      .withIndex("porSesionYCreacion", (q) => q.eq("sessionId", sessionId))
      .take(LOTE_MENSAJES);
    for (const m of mensajes) {
      const votos = await ctx.db
        .query("feedback")
        .withIndex("porMensaje", (q) => q.eq("messageId", m._id))
        .collect();
      for (const f of votos) await ctx.db.delete(f._id);
      await ctx.db.delete(m._id);
    }
    if (mensajes.length === LOTE_MENSAJES) {
      await ctx.scheduler.runAfter(0, internal.evaluacion.correr.borrarSesionOculta, { sessionId });
      return { borrada: false };
    }
    const s = await ctx.db.get(sessionId);
    if (s) await ctx.db.delete(sessionId);
    return { borrada: s !== null };
  },
});

export const avanzarCorrida = internalMutation({
  args: { corridaId: v.id("evaluacionCorridas"), casosHechos: v.number() },
  handler: async (ctx, { corridaId, casosHechos }): Promise<void> => {
    const c = await ctx.db.get(corridaId);
    if (!c || c.estado !== "running") return;
    await ctx.db.patch(corridaId, { casosHechos });
  },
});

/** Cierra la corrida en `ok` con el resumen de todas sus filas. */
export const cerrarCorrida = internalMutation({
  args: { corridaId: v.id("evaluacionCorridas") },
  handler: async (ctx, { corridaId }): Promise<void> => {
    const c = await ctx.db.get(corridaId);
    if (!c || c.estado !== "running") return;
    const filas = await ctx.db
      .query("evaluacionResultados")
      .withIndex("porCorrida", (q) => q.eq("corridaId", corridaId))
      .take(MAX_CASOS_POR_CORRIDA);
    let resumen: unknown = undefined;
    if (filas.length) {
      resumen = resumir(
        filas.map((f) => f.puntuacion as Puntuacion),
        filas.map((f) => f.resultado as ResultadoAgregado),
      );
    }
    await ctx.db.patch(corridaId, {
      estado: "ok",
      terminadoEn: Date.now(),
      casosHechos: c.casosTotal,
      casoActual: undefined,
      resumen,
    });
  },
});

/** Cierra la corrida en `error`. Un estado final previo no se toca: si
 *  `cerrarColgadas` la dio por muerta y luego la acción despierta, no se
 *  reescribe la historia. */
export const marcarError = internalMutation({
  args: { corridaId: v.id("evaluacionCorridas"), error: v.string() },
  handler: async (ctx, { corridaId, error }): Promise<void> => {
    const c = await ctx.db.get(corridaId);
    if (!c || c.estado !== "running") return;
    await ctx.db.patch(corridaId, {
      estado: "error",
      error: error.slice(0, 500),
      terminadoEn: Date.now(),
      casoActual: undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// El paso: un caso, una repetición
// ---------------------------------------------------------------------------
interface Turno {
  estado: string | null;
  error: string | null;
  content: string;
  sources: unknown[];
  hops: unknown[];
  plan: unknown[];
  verificacion: unknown;
  metrics: Record<string, unknown>;
}

const FINALES = new Set(["listo", "error", "cancelado"]);

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mensajeDe(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** El `Resultado` que se puntúa, construido como lo hace `scripts/evaluar.ts`:
 *  la misma reconstrucción de `metrics.meta.verificacion` a partir del informe
 *  cuando la telemetría no la trae (contando también las atribuciones a otra
 *  entidad), y CUALQUIER fallo de la espera convertido en un resultado con
 *  `error`, para que puntúe y falle como los demás. */
function resultadoDe(caso: Caso, turno: Turno): Resultado {
  const metrics: Record<string, unknown> = { ...turno.metrics };
  const meta = (metrics.meta ?? {}) as Record<string, unknown>;
  if (!meta.verificacion && turno.verificacion && typeof turno.verificacion === "object") {
    const v = turno.verificacion as {
      fidelidad?: number | null;
      afirmaciones?: Array<{ veredicto?: string; entidad_distinta?: boolean }>;
    };
    const afirmaciones = v.afirmaciones ?? [];
    const cuenta = (x: string) => afirmaciones.filter((a) => a.veredicto === x).length;
    metrics.meta = {
      ...meta,
      verificacion: {
        fidelidad: v.fidelidad ?? null,
        no_sostenidas: cuenta("no_sostenida"),
        sin_verificar: cuenta("sin_verificar"),
        entidad_distinta: afirmaciones.filter((a) => a.entidad_distinta === true).length,
      },
    };
  }
  return {
    id: caso.id,
    question: caso.question,
    mode: caso.mode,
    answer: turno.content,
    sources: turno.sources,
    hops: turno.hops,
    metrics,
    error:
      turno.estado === "error"
        ? (turno.error ?? "error sin detalle")
        : turno.estado === "cancelado"
          ? "turno cancelado"
          : null,
  };
}

function resultadoConError(caso: Caso, error: string): Resultado {
  return { id: caso.id, question: caso.question, mode: caso.mode, answer: "", sources: [], hops: [], metrics: {}, error };
}

/** Lo que se guarda de una corrida cruda. */
function recortar(resultado: Resultado, puntuacion: Puntuacion): CorridaCruda {
  const metrics = (resultado.metrics ?? {}) as Record<string, unknown>;
  const fuentes = ((resultado.sources ?? []) as unknown[])
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      source_file: String(f.source_file ?? ""),
      page: typeof f.page === "number" ? f.page : 0,
      section: String(f.section ?? ""),
      locator: String(f.locator ?? ""),
    }));
  return {
    respuesta: String(resultado.answer ?? "").slice(0, RESPUESTA_MAX),
    fuentes,
    fallos: puntuacion.failures,
    ms: typeof metrics.ms_total === "number" ? metrics.ms_total : null,
    coste: typeof metrics.cost_usd === "number" ? metrics.cost_usd : null,
    error: resultado.error ? String(resultado.error) : null,
    puntuacion,
  };
}

/** Un caso cuya definición guardada ya no valida (alguien la editó a mano, o
 *  cambió el formato). No se lanza el agente: se puntúa como error de
 *  ejecución con el motivo, para que la usuaria vea la pregunta en rojo con
 *  una explicación en vez de que la corrida entera se pare. */
function casoDeEmergencia(doc: Doc<"evaluacionCasos">): Caso {
  return {
    id: doc.clave,
    question: doc.pregunta,
    mode: doc.modo,
    category: doc.categoria,
    critical: doc.critico,
    min_hops: 0,
    evidence: [],
    hop_patterns: [],
    answer_must_contain: [],
    answer_must_not_contain: [],
    expect_abstention: false,
    min_faithfulness: null,
    notes: "",
  };
}

export const paso = internalAction({
  args: {
    corridaId: v.id("evaluacionCorridas"),
    casos: v.array(v.id("evaluacionCasos")),
    indice: v.number(),
    rep: v.number(),
    // La fila de resultados del caso en curso, a partir de la 2.ª repetición.
    resultadoId: v.optional(v.id("evaluacionResultados")),
  },
  handler: async (ctx, args): Promise<void> => {
    const corrida = await ctx.runQuery(internal.evaluacion.correr.leerCorrida, { corridaId: args.corridaId });
    // Cerrada por `cerrarColgadas` o borrada con la cuenta: la cadena se
    // detiene aquí sin escribir nada.
    if (!corrida || corrida.estado !== "running") return;
    if (args.indice >= args.casos.length) {
      await ctx.runMutation(internal.evaluacion.correr.cerrarCorrida, { corridaId: args.corridaId });
      return;
    }

    let sessionId: Id<"sessions"> | null = null;
    const limpiar = async () => {
      if (!sessionId) return;
      const id = sessionId;
      sessionId = null;
      await ctx.runMutation(internal.evaluacion.correr.borrarSesionOculta, { sessionId: id });
    };
    const siguiente = async (indice: number, rep: number, resultadoId?: Id<"evaluacionResultados">) => {
      await ctx.scheduler.runAfter(0, internal.evaluacion.correr.paso, {
        corridaId: args.corridaId,
        casos: args.casos,
        indice,
        rep,
        ...(resultadoId ? { resultadoId } : {}),
      });
    };

    try {
      const casoId = args.casos[args.indice];
      const doc = await ctx.runQuery(internal.evaluacion.correr.leerCaso, { casoId });
      if (!doc) {
        // Borrado a mitad de la corrida: se salta sin dejar hueco en la cuenta.
        await ctx.runMutation(internal.evaluacion.correr.avanzarCorrida, {
          corridaId: args.corridaId,
          casosHechos: args.indice + 1,
        });
        await siguiente(args.indice + 1, 1);
        return;
      }

      let caso: Caso;
      let resultado: Resultado;
      try {
        caso = validarCaso({ ...(doc.definicion as Record<string, unknown>), id: doc.clave });
      } catch (exc) {
        caso = casoDeEmergencia(doc);
        resultado = resultadoConError(caso, `la pregunta de control no está bien definida: ${mensajeDe(exc)}`);
        return await guardarYSeguir(doc, caso, resultado);
      }

      const lanzado = await ctx.runMutation(internal.evaluacion.correr.lanzar, { corridaId: args.corridaId, casoId });
      sessionId = lanzado.sessionId;
      try {
        const turno = await esperarTurno(lanzado.messageId);
        resultado = resultadoDe(caso, turno);
      } catch (exc) {
        resultado = resultadoConError(caso, mensajeDe(exc));
      }
      await guardarYSeguir(doc, caso, resultado);
    } catch (exc) {
      console.error("La evaluación falló", args.corridaId, exc);
      try {
        await limpiar();
      } catch (otro) {
        console.error("No se pudo borrar la conversación oculta de la evaluación", otro);
      }
      // Lo que lee la usuaria empieza en llano; el detalle técnico va detrás
      // porque es lo que permite diagnosticar desde la propia pestaña sin ir
      // a los logs.
      await ctx.runMutation(internal.evaluacion.correr.marcarError, {
        corridaId: args.corridaId,
        error: `La evaluación se interrumpió por un fallo interno y no llegó a terminar (${mensajeDe(exc).slice(0, 300)}).`,
      });
    }

    async function esperarTurno(messageId: Id<"messages">): Promise<Turno> {
      const limite = Date.now() + espera.maxMs;
      let turno: Turno | null = null;
      while (Date.now() < limite) {
        await dormir(espera.intervaloMs);
        turno = (await ctx.runQuery(internal.pruebas.leerTurno, { messageId })) as Turno | null;
        if (turno === null) throw new Error("la conversación desapareció mientras se esperaba la respuesta");
        if (turno.estado && FINALES.has(turno.estado)) return turno;
      }
      throw new Error(
        `el asistente no terminó en ${Math.round(espera.maxMs / 1000)} s (estado: ${turno?.estado ?? "?"})`,
      );
    }

    async function guardarYSeguir(doc: Doc<"evaluacionCasos">, caso: Caso, resultado: Resultado): Promise<void> {
      const puntuacion = puntuarCaso(caso, resultado);
      const resultadoId = await ctx.runMutation(internal.evaluacion.correr.guardarResultado, {
        corridaId: args.corridaId,
        casoId: doc._id,
        resultadoId: args.resultadoId,
        clave: doc.clave,
        pregunta: doc.pregunta,
        modo: doc.modo,
        categoria: doc.categoria,
        critico: doc.critico,
        run: recortar(resultado, puntuacion),
      });
      // La conversación oculta se va ANTES de agendar nada más: si lo que
      // sigue fallara, no debe quedar viva.
      await limpiar();
      const ultimaRep = args.rep >= corrida!.repeticiones;
      await ctx.runMutation(internal.evaluacion.correr.avanzarCorrida, {
        corridaId: args.corridaId,
        casosHechos: ultimaRep ? args.indice + 1 : args.indice,
      });
      if (ultimaRep) await siguiente(args.indice + 1, 1);
      else await siguiente(args.indice, args.rep + 1, resultadoId);
    }
  },
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
/** Reparto semanal: una corrida programada por cada cuenta con al menos
 *  `MIN_CASOS_PROGRAMADA` preguntas aprobadas y sin corrida en los últimos
 *  6 días (ni una en marcha). `ahora` se recibe por argumento para poder
 *  probar el calendario sin esperar una semana. */
export const repartir = internalMutation({
  args: { ahora: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ agendadas: number }> => {
    const ahora = args.ahora ?? Date.now();
    const cuentas = await ctx.db.query("users").take(MAX_USUARIOS);
    let agendadas = 0;
    for (const u of cuentas) {
      const aprobados = await ctx.db
        .query("evaluacionCasos")
        .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", u._id).eq("estado", "aprobado"))
        .take(MIN_CASOS_PROGRAMADA);
      if (aprobados.length < MIN_CASOS_PROGRAMADA) continue;
      const ultima = await ctx.db
        .query("evaluacionCorridas")
        .withIndex("porPropietarioYEmpezado", (q) => q.eq("propietario", u._id))
        .order("desc")
        .first();
      if (ultima && (ultima.estado === "running" || ahora - ultima.empezadoEn < INTERVALO_PROGRAMADA_MS)) continue;
      const id = await iniciarCorrida(ctx, { propietario: u._id, disparo: "programada", repeticiones: 1, ahora });
      if (id) agendadas += 1;
    }
    return { agendadas };
  },
});

/** Barrido: corridas `running` que llevan vivas más de lo que su avance
 *  permite (`corridaColgada`) pasan a `error`. Se lee por rango de
 *  `_creationTime`, de la última hora hacia atrás hasta 30 días, y se filtra
 *  por estado: la tabla no tiene índice por estado, y recorrerla entera cada
 *  30 minutos crecería con la historia. */
export const cerrarColgadas = internalMutation({
  args: { ahora: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ cerradas: number }> => {
    const ahora = args.ahora ?? Date.now();
    const limite = ahora - CORRIDA_COLGADA_MIN_MS;
    const candidatas = await ctx.db
      .query("evaluacionCorridas")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", limite - VENTANA_COLGADAS_MS).lt("_creationTime", limite))
      .filter((q) => q.eq(q.field("estado"), "running"))
      .take(50);
    let cerradas = 0;
    for (const c of candidatas) {
      if (!corridaColgada(c, ahora)) continue;
      await ctx.db.patch(c._id, {
        estado: "error",
        error: ERROR_CORRIDA_COLGADA,
        terminadoEn: ahora,
        casoActual: undefined,
      });
      cerradas += 1;
    }
    if (cerradas > 0) console.warn(`evaluaciones colgadas cerradas por el barrido: ${cerradas}`);
    return { cerradas };
  },
});
