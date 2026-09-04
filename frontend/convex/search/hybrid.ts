// Búsqueda híbrida: denso + léxico fusionados por rango recíproco (RRF).
// Reemplaza a `qdrant.hybrid_search` (backend/app/services/qdrant.py).
//
// En Qdrant las dos búsquedas y la fusión ocurrían en el servidor con una sola
// llamada (`prefetch` denso + `prefetch` BM25 + `FusionQuery(RRF)`). En Convex
// no hay fusión nativa: el lado denso es `ctx.vectorSearch` sobre el índice
// `porEmbedding`, que solo existe en acciones y devuelve `{_id, _score}`; el
// lado léxico es una query sobre el índice de texto `porTexto`, que puntúa por
// BM25 más proximidad y coincidencias exactas; y la fusión se hace aquí, en la
// acción, con el mismo RRF (k=60) y el mismo orden total que ya usaba
// `evidencia.fusionar_rrf` en Python.
//
// Dos decisiones que conviene no re-litigar:
//
// - **La búsqueda vectorial de Convex no admite AND entre campos.** La
//   documentación (docs.convex.dev/search/vector-search) describe el filtro
//   como "Optional filter expression made up of `q.or` and `q.eq` operating
//   over the filter fields of the index", y el `VectorFilterBuilder` del SDK
//   solo tiene `eq` y `or`: se puede pedir "documentType = pdf OR language =
//   es", pero no "pdf AND es". Qdrant sí aceptaba un `must` con los cuatro
//   filtros. Así que en la vectorial se aplica SOLO el filtro más selectivo
//   (documentId > projectId > documentType > language), se sobre-recupera
//   (hasta 256 candidatos, el tope documentado: "Maximum result set: 256") y
//   los filtros restantes se aplican al cargar los documentos. El lado léxico
//   sí encadena `.eq` para cada filtro, que allí es AND ("Zero or more equality
//   expressions constructed with `.eq`"). Consecuencia honesta: con filtros
//   muy selectivos sobre campos que no son el elegido, el lado denso puede
//   devolver menos de topK candidatos válidos; el léxico no.
//
// - **Los fragmentos se cargan por lotes y sin el vector.** `db.get` lee la
//   fila entera, y el vector son 3072 números (unos 25 KB por fragmento). La
//   unión de candidatos de una consulta puede pasar de 300 filas, y de dos
//   consultas de 700: una sola query se acercaría al tope de lectura por
//   transacción ("Data read: 16 MiB"). En lotes de 64 en paralelo cada query
//   lee menos de 2 MiB y la acción nunca recibe el vector, que después de la
//   búsqueda no sirve para nada.
//
// Regla heredada de qdrant.py que aquí NO se aplica: si con filtros no sale
// nada, es el LLAMADOR quien decide repetir sin filtros y avisar al modelo (el
// 2 sep 2026 un filtro `language: es` sobre puntos con `language` vacío dio
// cero y el agente concluyó que el documento no existía). Para eso se exportan
// `filtrosActivos`, `hayFiltros` y `describirFiltros`.
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type ActionCtx } from "../_generated/server";
import type { Fragmento } from "../lib/citas";
import { ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import type { Telemetria } from "../lib/telemetry";
import { terminosDeBusqueda } from "./terminos";
import { claveDeConsulta } from "./cacheEmbeddings";

export interface FiltrosBusqueda {
  projectId?: string;
  documentId?: string;
  documentType?: string;
  language?: string;
}

export type ModoRecuperacion = "hibrida" | "densa" | "lexica" | "error";

export interface ResultadoBusqueda {
  fragmentos: Fragmento[];
  recuperacion: ModoRecuperacion;
}

export type CampoFiltro = keyof FiltrosBusqueda;

/** Del más selectivo al menos. Un documento concreto acota más que un
 *  proyecto; un formato más que un idioma, porque el corpus es casi todo PDF
 *  en un solo idioma y ese filtro deja casi todo dentro. */
export const ORDEN_SELECTIVIDAD: readonly CampoFiltro[] = [
  "documentId",
  "projectId",
  "documentType",
  "language",
];

/** Constante del RRF. La misma que en `evidencia.fusionar_rrf`. */
export const RRF_K = 60;

// Topes documentados del índice (docs.convex.dev/production/state/limits).
const MAX_DENSO = 256; // vector search: "Maximum result set: 256"
const MAX_LEXICO = 1024; // full text search: "Maximum result set: 1024"
// Tamaño del lote de carga: 64 filas con vector son menos de 2 MiB.
const LOTE_CARGA = 64;

/** Sin filtros. Lo que el llamador pasa al repetir la búsqueda. */
export const SIN_FILTROS: FiltrosBusqueda = {};

/** Los filtros que de verdad se aplican: sin vacíos ni espacios.
 *
 *  Una cadena vacía o de espacios cuenta como ausente, como hacía
 *  `_filtros_de_args` en Python: si no, `language: ""` filtraría por el
 *  idioma vacío literal y daría cero resultados en silencio. */
export function filtrosActivos(
  filtros: FiltrosBusqueda | null | undefined,
): Partial<Record<CampoFiltro, string>> {
  const activos: Partial<Record<CampoFiltro, string>> = {};
  for (const campo of ORDEN_SELECTIVIDAD) {
    const valor = filtros?.[campo];
    if (typeof valor === "string" && valor.trim()) activos[campo] = valor.trim();
  }
  return activos;
}

export function hayFiltros(filtros: FiltrosBusqueda | null | undefined): boolean {
  return Object.keys(filtrosActivos(filtros)).length > 0;
}

/** "language='es', documentType='pdf'": para el aviso al modelo cuando la
 *  búsqueda se repite sin filtros. */
export function describirFiltros(filtros: FiltrosBusqueda | null | undefined): string {
  return Object.entries(filtrosActivos(filtros))
    .map(([campo, valor]) => `${campo}='${valor}'`)
    .join(", ");
}

/** El único filtro que puede ir a la búsqueda vectorial. */
function filtroMasSelectivo(
  activos: Partial<Record<CampoFiltro, string>>,
): { campo: CampoFiltro; valor: string } | null {
  for (const campo of ORDEN_SELECTIVIDAD) {
    const valor = activos[campo];
    if (valor !== undefined) return { campo, valor };
  }
  return null;
}

function pasaFiltros(
  doc: Doc<"chunks">,
  activos: Partial<Record<CampoFiltro, string>>,
): boolean {
  for (const campo of ORDEN_SELECTIVIDAD) {
    const esperado = activos[campo];
    if (esperado !== undefined && doc[campo] !== esperado) return false;
  }
  return true;
}

const CAMPOS_OPCIONALES = [
  "sourcePages",
  "section",
  "projectId",
  "documentId",
  "documentVersion",
  "documentType",
  "language",
  "titulo",
  "citation",
  "doi",
  "metadata",
] as const;

/** La fila de `chunks` como `Fragmento`: sin `embedding`, sin `documentRef` y
 *  sin claves a `undefined`. Port de `_point_to_chunk`. */
export function aFragmento(doc: Doc<"chunks">): Fragmento {
  const f: Fragmento = {
    _id: doc._id,
    text: doc.text,
    sourceFile: doc.sourceFile,
    page: doc.page,
    chunkType: doc.chunkType,
  };
  for (const campo of CAMPOS_OPCIONALES) {
    if (doc[campo] !== undefined) Object.assign(f, { [campo]: doc[campo] });
  }
  return f;
}

const filtrosValidator = v.object({
  projectId: v.optional(v.string()),
  documentId: v.optional(v.string()),
  documentType: v.optional(v.string()),
  language: v.optional(v.string()),
});

// --- Lado léxico -------------------------------------------------------------

/** Ids de los fragmentos que casan con los términos, en orden de relevancia
 *  (BM25 más proximidad y coincidencias exactas, según la documentación).
 *  Aquí sí se aplican TODOS los filtros, encadenando `.eq`. Devuelve solo
 *  ids: la fila completa se carga después junto con las del lado denso. */
export const lexica = internalQuery({
  args: { terminos: v.string(), n: v.number(), filtros: filtrosValidator },
  handler: async (ctx, args): Promise<Id<"chunks">[]> => {
    const activos = filtrosActivos(args.filtros);
    const n = Math.max(1, Math.min(MAX_LEXICO, Math.floor(args.n)));
    const filas = await ctx.db
      .query("chunks")
      .withSearchIndex("porTexto", (q) =>
        (Object.entries(activos) as Array<[CampoFiltro, string]>).reduce(
          (expr, [campo, valor]) => expr.eq(campo, valor),
          q.search("text", args.terminos),
        ),
      )
      .take(n);
    return filas.map((fila) => fila._id);
  },
});

// --- Carga -------------------------------------------------------------------

/** Los fragmentos de esos ids, en el mismo orden, sin el vector, y solo los
 *  que pasan los filtros: es donde se aplica el AND que la búsqueda vectorial
 *  no sabe hacer. Un id que ya no existe (el documento se reindexó entre la
 *  búsqueda y la carga) simplemente se omite. */
export const cargar = internalQuery({
  args: { ids: v.array(v.id("chunks")), filtros: filtrosValidator },
  handler: async (ctx, args): Promise<Fragmento[]> => {
    const activos = filtrosActivos(args.filtros);
    const filas = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    const out: Fragmento[] = [];
    for (const fila of filas) {
      if (fila === null || !pasaFiltros(fila, activos)) continue;
      out.push(aFragmento(fila));
    }
    return out;
  },
});

// --- Fusión ------------------------------------------------------------------

function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fusión RRF de varias listas con orden total. Port de `fusionar_rrf`.
 *
 *  El desempate por (sourceFile, page, _id) importa: dos fragmentos con la
 *  misma puntuación RRF quedarían en el orden que diera el mapa, y ese orden
 *  depende de cuál de las dos búsquedas respondió antes. Se compara por punto
 *  de código y no con `localeCompare`, que depende de la configuración
 *  regional del runtime. El `score` de cada fragmento pasa a ser su suma RRF,
 *  como en la respuesta de fusión de Qdrant. */
export function fusionarRrf(listas: Fragmento[][]): Fragmento[] {
  const puntuacion = new Map<string, number>();
  const porId = new Map<string, Fragmento>();
  for (const lista of listas) {
    lista.forEach((f, indice) => {
      puntuacion.set(f._id, (puntuacion.get(f._id) ?? 0) + 1 / (RRF_K + indice + 1));
      if (!porId.has(f._id)) porId.set(f._id, f);
    });
  }
  return Array.from(porId.values())
    .map((f) => ({ ...f, score: puntuacion.get(f._id) ?? 0 }))
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        comparar(a.sourceFile, b.sourceFile) ||
        a.page - b.page ||
        comparar(a._id, b._id),
    );
}

// --- Búsqueda ----------------------------------------------------------------

function modeloEmbeddingConfigurado(): string {
  try {
    return ajustes().modeloEmbedding;
  } catch {
    return "";
  }
}

/** Ejecuta un lado de la búsqueda. `null` significa que ese lado FALLÓ: la
 *  búsqueda no lanza nunca, degrada y lo dice en `recuperacion`. */
async function intentar<T>(
  lado: "denso" | "lexico",
  fn: () => Promise<T>,
  tel?: Telemetria,
): Promise<T | null> {
  try {
    return await fn();
  } catch (exc) {
    console.warn(`búsqueda híbrida: el lado ${lado} falló`, String(exc).slice(0, 200));
    tel?.incr(`lado_${lado}_caido`);
    return null;
  }
}

async function ladoDenso(
  ctx: ActionCtx,
  vector: number[],
  selectivo: { campo: CampoFiltro; valor: string } | null,
  limite: number,
): Promise<Id<"chunks">[]> {
  const resultados = selectivo
    ? await ctx.vectorSearch("chunks", "porEmbedding", {
        vector,
        limit: limite,
        filter: (q) => q.eq(selectivo.campo, selectivo.valor),
      })
    : await ctx.vectorSearch("chunks", "porEmbedding", { vector, limit: limite });
  return resultados.map((r) => r._id);
}

/** Varias consultas a la vez, con UN solo lote de embeddings.
 *
 *  Las consultas de un punto del plan (la original y su versión en inglés)
 *  salen juntas: una petición de embeddings en vez de N, las 2N búsquedas en
 *  paralelo y UNA carga de la unión de candidatos. Cada consulta recibe su
 *  propio resultado y su propio `recuperacion`:
 *  - "hibrida": los dos lados respondieron;
 *  - "densa": el léxico falló o la consulta no dejó ningún término con
 *    contenido (solo palabras vacías);
 *  - "lexica": los embeddings o la búsqueda vectorial fallaron;
 *  - "error": fallaron los dos, o falló la carga de los fragmentos. Lista
 *    vacía, y NUNCA se lanza: "error" no es "no está en los documentos", y
 *    el llamador lo tiene que poder distinguir. */
export async function buscarHibridoVarias(
  ctx: ActionCtx,
  consultas: string[],
  filtros: FiltrosBusqueda,
  topK: number,
  tel?: Telemetria,
): Promise<ResultadoBusqueda[]> {
  if (!consultas.length) return [];
  const k = Math.max(1, Math.floor(topK) || 1);
  const activos = filtrosActivos(filtros);
  const selectivo = filtroMasSelectivo(activos);
  // Filtros que la vectorial no puede aplicar y se aplican al cargar.
  const hayResiduales = Object.keys(activos).length > (selectivo ? 1 : 0);
  // Como el `prefetch_limit = max(top_k * 2, 20)` de Qdrant por lado; el
  // denso pide el doble cuando hay filtros residuales, porque una parte de
  // lo que devuelva se va a descartar al cargar.
  const limiteDenso = Math.min(MAX_DENSO, Math.max(20, k * (hayResiduales ? 4 : 2)));
  const limiteLexico = Math.min(MAX_LEXICO, Math.max(20, k * 2));

  // 1. Embeddings: un lote con las consultas distintas y no vacías.
  const textos = consultas.map((c) => (c ?? "").trim());
  const unicos = Array.from(new Set(textos.filter(Boolean)));
  let vectores: Map<string, number[]> | null = null;
  if (unicos.length) {
    const t0 = Date.now();
    try {
      // Primero la caché: el mismo texto con el mismo modelo reutiliza su
      // vector, que es lo que hace determinista el lado denso (ver la tabla
      // `consultasEmbebidas` en schema.ts). Solo se embebe lo que falta.
      const modelo = modeloEmbeddingConfigurado();
      const claves = unicos.map((t) => claveDeConsulta(t, modelo));
      let cacheados: Record<string, number[]> = {};
      try {
        const pares = await ctx.runQuery(internal.search.cacheEmbeddings.leer, { claves });
        for (const p of pares ?? []) cacheados[p.clave] = p.vector;
      } catch (exc) {
        console.warn("caché de embeddings no disponible", String(exc).slice(0, 120));
      }
      const faltan = unicos.filter((_, i) => !cacheados[claves[i]]);
      vectores = new Map(
        unicos.flatMap((t, i) => (cacheados[claves[i]] ? [[t, cacheados[claves[i]]] as [string, number[]]] : [])),
      );
      if (Object.keys(cacheados).length) tel?.incr("embeddings_en_cache", Object.keys(cacheados).length);
      if (faltan.length) {
        const r = await gateway.embed(faltan);
        tel?.anota("embeddings", r.modelo, r.usage, { ms: Date.now() - t0 });
        faltan.forEach((texto, i) => vectores!.set(texto, r.vectores[i]));
        void ctx
          .runMutation(internal.search.cacheEmbeddings.guardar, {
            entradas: faltan.map((texto, i) => ({
              clave: claveDeConsulta(texto, modelo), modelo: r.modelo || modelo, vector: r.vectores[i],
            })),
          })
          .catch((exc: unknown) => console.warn("no se pudo guardar el embedding en caché", String(exc).slice(0, 120)));
      }
    } catch (exc) {
      // Anotado como ronda fallida, igual que hacía `embed_query`: en la
      // telemetría tiene que verse que el lado denso no llegó a buscar.
      tel?.anota("embeddings", modeloEmbeddingConfigurado(), null, {
        ms: Date.now() - t0,
        ok: false,
        nota: String(exc).slice(0, 120),
      });
      console.warn("búsqueda híbrida: embeddings caídos, se sigue solo con el léxico", String(exc).slice(0, 200));
    }
  }

  // 2. Por consulta, los dos lados en paralelo. Cada lado devuelve ids en
  //    orden de rango, o null si falló / no procede.
  const lados = await Promise.all(
    textos.map(async (texto) => {
      const terminos = texto ? terminosDeBusqueda(texto) : [];
      const vector = vectores?.get(texto);
      const [denso, lexico] = await Promise.all([
        vector
          ? intentar("denso", () => ladoDenso(ctx, vector, selectivo, limiteDenso), tel)
          : Promise.resolve(null),
        terminos.length
          ? intentar(
              "lexico",
              () =>
                ctx.runQuery(internal.search.hybrid.lexica, {
                  terminos: terminos.join(" "),
                  n: limiteLexico,
                  filtros: activos,
                }),
              tel,
            )
          : Promise.resolve(null),
      ]);
      return { denso, lexico };
    }),
  );

  // 3. Una carga de la unión de candidatos, por lotes en paralelo. Los
  //    filtros residuales se aplican dentro de la query.
  const union: Id<"chunks">[] = [];
  const vistos = new Set<string>();
  for (const { denso, lexico } of lados) {
    for (const id of [...(denso ?? []), ...(lexico ?? [])]) {
      if (!vistos.has(id)) {
        vistos.add(id);
        union.push(id);
      }
    }
  }
  const porId = new Map<string, Fragmento>();
  let cargaOk = true;
  try {
    const lotes: Id<"chunks">[][] = [];
    for (let i = 0; i < union.length; i += LOTE_CARGA) {
      lotes.push(union.slice(i, i + LOTE_CARGA));
    }
    const cargados = await Promise.all(
      lotes.map((ids) => ctx.runQuery(internal.search.hybrid.cargar, { ids, filtros: activos })),
    );
    for (const lista of cargados) for (const f of lista) porId.set(f._id, f);
  } catch (exc) {
    cargaOk = false;
    tel?.incr("carga_fragmentos_caida");
    console.warn("búsqueda híbrida: no se pudieron cargar los fragmentos", String(exc).slice(0, 200));
  }

  // 4. Fusión por consulta. Los rangos se asignan sobre los supervivientes de
  //    cada lado (los que existen y pasan los filtros), como hacía Qdrant al
  //    filtrar dentro de cada `prefetch`: si no, un fragmento válido en la
  //    posición 7 del denso, con los 6 anteriores descartados por filtro,
  //    puntuaría como séptimo y perdería contra el primero del léxico.
  return lados.map(({ denso, lexico }) => {
    if (!cargaOk || (denso === null && lexico === null)) {
      tel?.incr("recuperacion_error");
      return { fragmentos: [], recuperacion: "error" as const };
    }
    const materializar = (ids: Id<"chunks">[]): Fragmento[] =>
      ids.map((id) => porId.get(id)).filter((f): f is Fragmento => f !== undefined);
    const listas: Fragmento[][] = [];
    if (denso !== null) listas.push(materializar(denso));
    if (lexico !== null) listas.push(materializar(lexico));
    const recuperacion: ModoRecuperacion =
      denso !== null && lexico !== null ? "hibrida" : denso !== null ? "densa" : "lexica";
    tel?.incr(`recuperacion_${recuperacion}`);
    return { fragmentos: fusionarRrf(listas).slice(0, k), recuperacion };
  });
}

/** Denso + léxico fusionados por rango recíproco. Reemplaza a
 *  `qdrant.hybrid_search`. Se llama desde una ACCIÓN (la búsqueda vectorial
 *  solo existe ahí). */
export async function buscarHibrido(
  ctx: ActionCtx,
  consulta: string,
  filtros: FiltrosBusqueda,
  topK: number,
  tel?: Telemetria,
): Promise<ResultadoBusqueda> {
  const [resultado] = await buscarHibridoVarias(ctx, [consulta], filtros, topK, tel);
  return resultado;
}
