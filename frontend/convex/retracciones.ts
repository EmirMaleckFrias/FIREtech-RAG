// Estado de retracción de los artículos indexados, según Crossref.
//
// Por qué existe. La literatura del Alzheimer es el caso de manual de las
// retracciones (el artículo de Lesné de 2006 en Nature sobre Aβ*56, retractado
// en 2024, se citó más de 2000 veces), y un asistente que cite un artículo
// retractado como "apoyado por un documento" es un peligro clínico que ninguna
// comprobación de fidelidad detecta: la cita resuelve, el fragmento dice lo que
// la respuesta dice, y el dato es falso. Crossref registra las retracciones,
// las retiradas y las expresiones de preocupación como actualizaciones del
// trabajo original (`updated-by` en su API pública, alimentada además por la
// base de Retraction Watch desde 2023), así que basta con preguntar por el DOI.
//
// Qué se hace con un artículo retractado: NADA se borra. La médica puede
// querer saber qué decía, y ocultarlo sería mentirle por omisión. Lo que
// cambia es que cada fragmento suyo llega al modelo con el aviso (el prompt
// prohíbe usarlo como evidencia de un hecho), la fuente se pinta en rojo en la
// respuesta y la ficha del documento lo dice.
//
// Cuándo: al terminar de indexar un documento con DOI (pipeline.ts agenda
// `comprobarDocumento`) y una vez por semana para todos (`comprobarTodos`,
// desde crons.ts), porque una retracción llega años después de publicarse el
// artículo. Sin clave ni cuenta: la API de Crossref es pública; se identifica
// la aplicación en el User-Agent, como piden, y nunca se manda ningún correo
// de nadie.
//
// Sin "use node": `fetch` existe en el runtime por defecto de Convex.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const CROSSREF = "https://api.crossref.org/works/";
const USER_AGENT = "FIREtech-RAG/1.0 (https://github.com/EmirMaleckFrias/FIREtech-RAG)";
const TIMEOUT_MS = 20_000;
/** Documentos por página al recorrer la tabla en la comprobación semanal. */
const PAGINA = 50;
/** Pausa entre peticiones a Crossref: su "polite pool" pide no pasar de unas
 *  pocas por segundo, y aquí no hay ninguna prisa. */
const PAUSA_MS = 250;

/** Cómo se traduce el tipo de actualización de Crossref a lo que se guarda.
 *  Solo lo que invalida el artículo como evidencia: una corrección o una
 *  errata no lo invalidan y no se marcan. */
export const TIPOS_RETRACCION: Record<string, string> = {
  retraction: "retractado",
  partial_retraction: "retractado",
  withdrawal: "retirado",
  removal: "retirado",
  expression_of_concern: "preocupacion",
};

export interface Retraccion {
  tipo: string;
  fecha?: string;
  avisoDoi?: string;
}

/** Lee el `message` de Crossref y devuelve la retracción que declara, o null
 *  si el artículo no tiene ninguna actualización que lo invalide. Tolerante
 *  con la forma: `updated-by` puede faltar, venir vacío o traer entradas sin
 *  tipo. Si hay varias, gana la más grave (retractado > retirado >
 *  preocupación). Función pura, probada sin red. */
export function interpretarCrossref(mensaje: unknown): Retraccion | null {
  if (!mensaje || typeof mensaje !== "object") return null;
  const crudas: unknown = (mensaje as Record<string, unknown>)["updated-by"];
  if (!Array.isArray(crudas)) return null;
  const gravedad: Record<string, number> = { retractado: 3, retirado: 2, preocupacion: 1 };
  let mejor: Retraccion | null = null;
  for (const cruda of crudas) {
    if (!cruda || typeof cruda !== "object") continue;
    const obj = cruda as Record<string, unknown>;
    const tipoCrudo = String(obj.type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const tipo = TIPOS_RETRACCION[tipoCrudo];
    if (!tipo) continue;
    const fecha = fechaDe(obj.updated);
    const avisoDoi = typeof obj.DOI === "string" ? obj.DOI : undefined;
    const candidata: Retraccion = { tipo, ...(fecha ? { fecha } : {}), ...(avisoDoi ? { avisoDoi } : {}) };
    if (!mejor || gravedad[tipo] > gravedad[mejor.tipo]) mejor = candidata;
  }
  return mejor;
}

/** "2024-06-24" a partir de `{ "date-time": "..." }` o `{ "date-parts": [[2024, 6, 24]] }`. */
function fechaDe(updated: unknown): string | undefined {
  if (!updated || typeof updated !== "object") return undefined;
  const obj = updated as Record<string, unknown>;
  if (typeof obj["date-time"] === "string") return obj["date-time"].slice(0, 10);
  const partes = obj["date-parts"];
  if (Array.isArray(partes) && Array.isArray(partes[0])) {
    const [a, m, d] = partes[0] as unknown[];
    if (typeof a === "number") {
      return [a, m, d]
        .filter((x) => typeof x === "number")
        .map((x, i) => (i === 0 ? String(x) : String(x).padStart(2, "0")))
        .join("-");
    }
  }
  return undefined;
}

/** Pregunta a Crossref por un DOI. `null` si no lo conoce (404) o si la
 *  respuesta no tiene la forma esperada; lanza si la red falla, para que el
 *  llamador distinga "no hay retracción" de "no se pudo comprobar". */
export async function consultarCrossref(doi: string): Promise<Retraccion | null> {
  const url = `${CROSSREF}${encodeURIComponent(doi.trim())}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Crossref respondió ${res.status}`);
  const cuerpo = (await res.json()) as { message?: unknown };
  return interpretarCrossref(cuerpo?.message);
}

/** El documento, para la acción. */
export const documento = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => ctx.db.get(documentId),
});

/** Una página de documentos, para la comprobación semanal. */
export const pagina = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const p = await ctx.db.query("documents").paginate({ cursor, numItems: PAGINA });
    return {
      documentos: p.page
        .filter((d) => d.doi && d.status === "ready")
        .map((d) => ({ _id: d._id, doi: d.doi as string })),
      continueCursor: p.continueCursor,
      isDone: p.isDone,
    };
  },
});

/** Escribe lo que dijo Crossref. `retraccion` ausente = el artículo está
 *  limpio (y se borra una marca anterior, por si la revista rectificó). */
export const anotar = internalMutation({
  args: {
    documentId: v.id("documents"),
    retraccion: v.optional(v.object({ tipo: v.string(), fecha: v.optional(v.string()), avisoDoi: v.optional(v.string()) })),
    comprobadoEn: v.number(),
  },
  handler: async (ctx, { documentId, retraccion, comprobadoEn }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return false;
    await ctx.db.patch(documentId, { retraccion, retraccionComprobadaEn: comprobadoEn });
    return true;
  },
});

/** Comprueba UN documento. Un fallo de red queda en el log y no toca nada:
 *  la comprobación semanal volverá a intentarlo. */
export async function comprobar(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  doc: { _id: Id<"documents">; doi: string; fileName?: string },
): Promise<Retraccion | null | undefined> {
  try {
    const retraccion = await consultarCrossref(doc.doi);
    await ctx.runMutation(internal.retracciones.anotar, {
      documentId: doc._id,
      ...(retraccion ? { retraccion } : {}),
      comprobadoEn: Date.now(),
    });
    if (retraccion) {
      console.warn(`Crossref: '${doc.fileName ?? doc.doi}' (${doc.doi}) figura como ${retraccion.tipo}${retraccion.fecha ? ` desde ${retraccion.fecha}` : ""}.`);
    }
    return retraccion;
  } catch (exc) {
    console.warn(`No se pudo comprobar en Crossref el DOI ${doc.doi}: ${String(exc).slice(0, 160)}`);
    return undefined;
  }
}

export const comprobarDocumento = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const doc: Doc<"documents"> | null = await ctx.runQuery(internal.retracciones.documento, { documentId });
    if (!doc || !doc.doi) return null;
    const r = await comprobar(ctx, { _id: doc._id, doi: doc.doi, fileName: doc.fileName });
    return r === undefined ? null : r;
  },
});

/** Todos los documentos con DOI, una página por acción, encadenadas. */
export const comprobarTodos = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ comprobados: number; hecho: boolean }> => {
    const p: { documentos: Array<{ _id: Id<"documents">; doi: string }>; continueCursor: string; isDone: boolean } =
      await ctx.runQuery(internal.retracciones.pagina, { cursor: args.cursor ?? null });
    let comprobados = 0;
    for (const d of p.documentos) {
      if ((await comprobar(ctx, d)) !== undefined) comprobados += 1;
      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
    if (!p.isDone) {
      await ctx.scheduler.runAfter(0, internal.retracciones.comprobarTodos, { cursor: p.continueCursor });
      return { comprobados, hecho: false };
    }
    return { comprobados, hecho: true };
  },
});
