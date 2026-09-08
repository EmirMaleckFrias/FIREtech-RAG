// Las funciones PÚBLICAS de la evaluación de calidad: lo que consume la
// pestaña Ajustes > Calidad. Todas empiezan por `usuario(ctx)` y todas están
// acotadas a la cuenta de quien pregunta: las preguntas de control, las
// generaciones y las corridas son de cada persona, como su corpus, y un id
// ajeno responde `no_encontrado`, nunca "prohibido" (ver permisos.ts).
//
// El trabajo pesado no ocurre aquí: `generar` y `evaluarAhora` solo crean la
// fila de estado y agendan la acción o la cadena; la pestaña se suscribe a
// `generacionActual` y `corridas` y ve el avance en vivo.
import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { errorDatos, usuario } from "../usuarios";
import { ERROR_CORRIDA_COLGADA, corridaColgada, iniciarCorrida, MAX_CASOS_POR_CORRIDA } from "./correr";

/** Casos que devuelve `casos`. Son filas pequeñas; una persona no revisa a
 *  mano más preguntas que esto. */
export const MAX_CASOS_LISTADOS = 500;
/** Corridas del historial. */
export const MAX_CORRIDAS_LISTADAS = 20;
/** Generaciones que se conservan por persona: poda al insertar, como las
 *  corridas de Notion, para que la tabla no crezca con cada pulsación. */
export const GENERACIONES_CONSERVADAS = 20;
/** Lo más que puede durar el primer paso de una generación (leer los
 *  documentos y armar el plan, sin llamar al modelo): la acción muere a los
 *  600 s; el minuto de más es margen para el planificador. */
export const PREPARACION_GENERACION_MAX_MS = 11 * 60_000;
/** Lo más que puede durar cada paso siguiente (UNA llamada al modelo, cortada
 *  a los 480 s por `generar.LLAMADA_MAX_MS`, más lecturas y escrituras cortas
 *  y el reagendado). */
export const PASO_GENERACION_MAX_MS = 11 * 60_000;

/** Si una generación `running` está muerta: la cadena se cortó sin pasar por
 *  `cerrar` y no debe bloquear el botón para siempre.
 *
 *  Antes el tope era fijo (20 minutos) y una generación sana lo supera: con
 *  objetivo 20 son hasta 31 llamadas al modelo grande con razonamiento, a
 *  15-40 s cada una. Como la fila no tiene fecha de última escritura, el
 *  latido son los contadores: cada paso de la cadena (generar.ts) suma al
 *  menos 1 a `generados + descartados` antes de agendar el siguiente, así que
 *  tras `k` pasos los contadores valen `k` o más, y una generación viva lleva
 *  como mucho la preparación más `k + 1` pasos (los hechos y el que está en
 *  marcha). La que lleve más que eso ha dejado de avanzar. Sin falsos
 *  positivos por construcción: el tope crece con el trabajo hecho. */
export function generacionColgada(
  g: { estado: string; empezadoEn: number; generados: number; descartados: number },
  ahora: number,
): boolean {
  if (g.estado !== "running") return false;
  const pasos = Math.max(0, g.generados) + Math.max(0, g.descartados) + 1;
  return ahora - g.empezadoEn > PREPARACION_GENERACION_MAX_MS + pasos * PASO_GENERACION_MAX_MS;
}
export const OBJETIVO_MIN = 1;
export const OBJETIVO_MAX = 60;
export const RESPUESTA_ESPERADA_MAX = 2000;
/** Filas por transacción al borrar el rastro de una cuenta. */
const LOTE_BORRADO = 500;

const estadoCaso = v.union(v.literal("propuesto"), v.literal("aprobado"), v.literal("descartado"));

// ---------------------------------------------------------------------------
// Ayudantes
// ---------------------------------------------------------------------------
/** El caso, si es de quien pregunta. Ajeno o inexistente: `no_encontrado`. */
async function casoPropio(ctx: QueryCtx | MutationCtx, casoId: Id<"evaluacionCasos">, userId: Id<"users">): Promise<Doc<"evaluacionCasos">> {
  const c = await ctx.db.get(casoId);
  if (!c || c.propietario !== userId) throw errorDatos("no_encontrado", "No se encontró la pregunta.");
  return c;
}

/** Nombres de fichero de las evidencias esperadas de un caso, sin repetir. */
export function fuentesDe(definicion: unknown): string[] {
  const d = definicion as { evidence?: Array<{ sources?: Array<{ file?: unknown }> }> } | null;
  const nombres: string[] = [];
  for (const e of d?.evidence ?? []) {
    for (const s of e?.sources ?? []) {
      if (typeof s?.file === "string" && s.file && !nombres.includes(s.file)) nombres.push(s.file);
    }
  }
  return nombres;
}

const PESO_ESTADO: Record<Doc<"evaluacionCasos">["estado"], number> = { propuesto: 0, aprobado: 1, descartado: 2 };

async function ultimaGeneracion(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("evaluacionGeneraciones")
    .withIndex("porPropietario", (q) => q.eq("propietario", userId))
    .order("desc")
    .first();
}

async function ultimaCorrida(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("evaluacionCorridas")
    .withIndex("porPropietarioYEmpezado", (q) => q.eq("propietario", userId))
    .order("desc")
    .first();
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------
/** Las preguntas de control de quien pregunta, en todos los estados: las
 *  propuestas primero (son las que esperan revisión), y dentro de cada grupo
 *  la más nueva antes. */
export const casos = query({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const filas = await ctx.db
      .query("evaluacionCasos")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", u._id))
      .take(MAX_CASOS_LISTADOS);
    filas.sort((a, b) => PESO_ESTADO[a.estado] - PESO_ESTADO[b.estado] || b.creadoEn - a.creadoEn);
    return filas.map((c) => ({
      _id: c._id,
      clave: c.clave,
      pregunta: c.pregunta,
      modo: c.modo,
      categoria: c.categoria,
      critico: c.critico,
      respuestaEsperada: c.respuestaEsperada,
      estado: c.estado,
      origen: c.origen,
      creadoEn: c.creadoEn,
      fuentes: fuentesDe(c.definicion),
    }));
  },
});

/** Aprobar, descartar o devolver a propuesta una pregunta propia. */
export const revisar = mutation({
  args: { casoId: v.id("evaluacionCasos"), estado: estadoCaso },
  handler: async (ctx, { casoId, estado }) => {
    const u = await usuario(ctx);
    const c = await casoPropio(ctx, casoId, u._id);
    await ctx.db.patch(c._id, { estado, revisadoEn: Date.now() });
    return { ok: true as const };
  },
});

/** Corrige lo que debería decir la respuesta. Es texto para la revisora; no
 *  cambia los patrones con los que se puntúa. */
export const editarRespuesta = mutation({
  args: { casoId: v.id("evaluacionCasos"), respuestaEsperada: v.string() },
  handler: async (ctx, { casoId, respuestaEsperada }) => {
    const u = await usuario(ctx);
    const c = await casoPropio(ctx, casoId, u._id);
    const texto = respuestaEsperada.trim();
    if (!texto) throw errorDatos("invalido", "La respuesta esperada no puede quedar vacía.");
    if (texto.length > RESPUESTA_ESPERADA_MAX) {
      throw errorDatos("invalido", `La respuesta esperada supera los ${RESPUESTA_ESPERADA_MAX} caracteres (tiene ${texto.length}).`);
    }
    await ctx.db.patch(c._id, { respuestaEsperada: texto, revisadoEn: Date.now() });
    return { ok: true as const };
  },
});

/** Borra una pregunta propia. Los resultados de corridas pasadas que la
 *  mencionan se conservan: llevan copiada la pregunta y su clave, y el
 *  historial de una corrida no debe cambiar porque hoy se borre un caso. */
export const borrarCaso = mutation({
  args: { casoId: v.id("evaluacionCasos") },
  handler: async (ctx, { casoId }) => {
    const u = await usuario(ctx);
    const c = await casoPropio(ctx, casoId, u._id);
    await ctx.db.delete(c._id);
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------
/** Pide al asistente que proponga `objetivo` preguntas sobre el corpus de
 *  quien pulsa. Una a la vez por persona: si hay una en marcha responde
 *  `conflicto`; una `running` muerta (`generacionColgada`) se cierra como
 *  error y no bloquea. Sin documentos listos no hay sobre qué proponer, y se
 *  dice antes de crear nada. */
export const generar = mutation({
  args: { objetivo: v.number() },
  handler: async (ctx, { objetivo }) => {
    const u = await usuario(ctx);
    if (!Number.isInteger(objetivo) || objetivo < OBJETIVO_MIN || objetivo > OBJETIVO_MAX) {
      throw errorDatos("invalido", `El número de preguntas debe estar entre ${OBJETIVO_MIN} y ${OBJETIVO_MAX}.`);
    }
    const ahora = Date.now();
    const ultima = await ultimaGeneracion(ctx, u._id);
    if (ultima?.estado === "running") {
      if (!generacionColgada(ultima, ahora)) {
        throw errorDatos("conflicto", "Ya se están proponiendo preguntas. Espera a que termine.");
      }
      await ctx.db.patch(ultima._id, {
        estado: "error",
        error: "La propuesta anterior no terminó.",
        terminadoEn: ahora,
        paso: undefined,
      });
    }
    const algunListo = await ctx.db
      .query("documents")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", u._id).eq("status", "ready"))
      .first();
    if (!algunListo) {
      throw errorDatos("conflicto", "Todavía no hay documentos listos sobre los que proponer preguntas.");
    }
    const generacionId = await ctx.db.insert("evaluacionGeneraciones", {
      propietario: u._id,
      empezadoEn: ahora,
      estado: "running",
      objetivo,
      generados: 0,
      descartados: 0,
      paso: "Preparando",
    });
    // Poda por persona: las más viejas se van, sin cron aparte.
    const todas = await ctx.db
      .query("evaluacionGeneraciones")
      .withIndex("porPropietario", (q) => q.eq("propietario", u._id))
      .order("desc")
      .take(GENERACIONES_CONSERVADAS + 20);
    for (const g of todas.slice(GENERACIONES_CONSERVADAS)) await ctx.db.delete(g._id);
    await ctx.scheduler.runAfter(0, internal.evaluacion.generar.generar, {
      propietario: u._id,
      generacionId,
      objetivo,
    });
    return { generacionId };
  },
});

/** La última generación de quien pregunta, o null si nunca pidió una. */
export const generacionActual = query({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const g = await ultimaGeneracion(ctx, u._id);
    if (!g) return null;
    return {
      _id: g._id,
      empezadoEn: g.empezadoEn,
      terminadoEn: g.terminadoEn ?? null,
      estado: g.estado,
      objetivo: g.objetivo,
      generados: g.generados,
      descartados: g.descartados,
      paso: g.paso ?? null,
      error: g.error ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------
/** Lanza una corrida manual con las preguntas aprobadas de quien pulsa. Una
 *  corrida `running` que ya no puede estar viva (`corridaColgada`: lleva más
 *  de lo que su avance permite) se cierra aquí mismo como error, igual que
 *  haría el barrido, para que el botón no espere al cron. */
export const evaluarAhora = mutation({
  args: { repeticiones: v.optional(v.union(v.literal(1), v.literal(3))) },
  handler: async (ctx, { repeticiones }) => {
    const u = await usuario(ctx);
    const ahora = Date.now();
    const ultima = await ultimaCorrida(ctx, u._id);
    if (ultima?.estado === "running") {
      if (!corridaColgada(ultima, ahora)) {
        throw errorDatos("conflicto", "Ya hay una evaluación en marcha. Espera a que termine.");
      }
      await ctx.db.patch(ultima._id, { estado: "error", error: ERROR_CORRIDA_COLGADA, terminadoEn: ahora, casoActual: undefined });
    }
    const alguna = await ctx.db
      .query("evaluacionCasos")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", u._id).eq("estado", "aprobado"))
      .first();
    if (!alguna) {
      throw errorDatos("conflicto", "Antes de evaluar hay que marcar como correcta al menos una pregunta.");
    }
    const corridaId = await iniciarCorrida(ctx, { propietario: u._id, disparo: "manual", repeticiones: repeticiones ?? 1 });
    if (!corridaId) throw errorDatos("conflicto", "Antes de evaluar hay que marcar como correcta al menos una pregunta.");
    return { corridaId };
  },
});

/** Las últimas corridas de quien pregunta, la más nueva primero. */
export const corridas = query({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const filas = await ctx.db
      .query("evaluacionCorridas")
      .withIndex("porPropietarioYEmpezado", (q) => q.eq("propietario", u._id))
      .order("desc")
      .take(MAX_CORRIDAS_LISTADAS);
    return filas.map((c) => ({
      _id: c._id,
      empezadoEn: c.empezadoEn,
      terminadoEn: c.terminadoEn ?? null,
      estado: c.estado,
      disparo: c.disparo,
      casosTotal: c.casosTotal,
      casosHechos: c.casosHechos,
      casoActual: c.casoActual ?? null,
      repeticiones: c.repeticiones,
      resumen: c.resumen ?? null,
      error: c.error ?? null,
    }));
  },
});

/** Los resultados por pregunta de una corrida PROPIA, por clave. */
export const resultadosDe = query({
  args: { corridaId: v.id("evaluacionCorridas") },
  handler: async (ctx, { corridaId }) => {
    const u = await usuario(ctx);
    const corrida = await ctx.db.get(corridaId);
    if (!corrida || corrida.propietario !== u._id) throw errorDatos("no_encontrado", "No se encontró la evaluación.");
    const filas = await ctx.db
      .query("evaluacionResultados")
      .withIndex("porCorrida", (q) => q.eq("corridaId", corridaId))
      .take(MAX_CASOS_POR_CORRIDA);
    filas.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
    return filas.map((f) => {
      const p = (f.puntuacion ?? {}) as { passed?: boolean; failures?: string[]; metrics?: Record<string, number | boolean | null> };
      const runs = Array.isArray(f.corridas) ? (f.corridas as Array<{ respuesta?: string }>) : [];
      return {
        clave: f.clave,
        pregunta: f.pregunta,
        categoria: f.categoria,
        critico: f.critico,
        passed: Boolean(p.passed),
        failures: Array.isArray(p.failures) ? p.failures : [],
        metrics: p.metrics ?? {},
        respuesta: runs[0]?.respuesta ?? "",
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Borrado de una cuenta
// ---------------------------------------------------------------------------
/** Borra TODO el rastro de la evaluación de una cuenta (resultados, corridas,
 *  generaciones y casos), por lotes y reagendándose. La llama
 *  `usuarios.borrar`, igual que hace con el rastro de Notion y de las nubes. */
export const borrarRastroDeUsuario = internalMutation({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }): Promise<void> => {
    const seguir = async () => {
      await ctx.scheduler.runAfter(0, internal.evaluacion.datos.borrarRastroDeUsuario, { propietario });
    };
    const resultados = await ctx.db
      .query("evaluacionResultados")
      .withIndex("porPropietario", (q) => q.eq("propietario", propietario))
      .take(LOTE_BORRADO);
    for (const r of resultados) await ctx.db.delete(r._id);
    if (resultados.length === LOTE_BORRADO) return await seguir();
    const corridas = await ctx.db
      .query("evaluacionCorridas")
      .withIndex("porPropietarioYEmpezado", (q) => q.eq("propietario", propietario))
      .take(LOTE_BORRADO);
    for (const c of corridas) await ctx.db.delete(c._id);
    if (corridas.length === LOTE_BORRADO) return await seguir();
    const generaciones = await ctx.db
      .query("evaluacionGeneraciones")
      .withIndex("porPropietario", (q) => q.eq("propietario", propietario))
      .take(LOTE_BORRADO);
    for (const g of generaciones) await ctx.db.delete(g._id);
    if (generaciones.length === LOTE_BORRADO) return await seguir();
    const casos = await ctx.db
      .query("evaluacionCasos")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", propietario))
      .take(LOTE_BORRADO);
    for (const c of casos) await ctx.db.delete(c._id);
    if (casos.length === LOTE_BORRADO) return await seguir();
  },
});
