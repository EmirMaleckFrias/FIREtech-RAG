// Pipeline de evidencia: ejecuta el plan de búsquedas por código, no el modelo.
// Port de `backend/app/services/evidencia.py`.
//
// Por qué existe. El agente decidía libremente cuántas búsquedas hacía
// (medido: 6-10 para la misma pregunta), el plan del planificador solo se le
// SUGERÍA como texto, ningún fragmento sabía qué punto del plan lo había
// traído y un paper largo podía ocupar los 12 huecos que llegan al modelo. El
// resultado medido fue que la misma pregunta daba una fidelidad entre 0.33 y
// 1.00 según la corrida. Bajar la temperatura no lo arregla (ver el comentario
// de `temperatura` en lib/config.ts): hay que sacar la decisión de qué buscar
// de manos del modelo.
//
// Aquí la evidencia pasa a ser una función determinista de (pregunta, índice):
//
// 1. Cada punto del plan lanza EN PARALELO la búsqueda híbrida con su consulta
//    y, si la hay, con su versión en inglés (el corpus es mayormente inglés y
//    el lado léxico no traduce), en UNA llamada a `buscarHibridoVarias`, que
//    embebe las dos de un golpe. Las dos listas se fusionan por RRF con orden
//    total.
// 2. Se podan las secciones que nunca son evidencia (bibliografía,
//    agradecimientos, financiación, conflictos) y se deduplica por id y por
//    texto normalizado. NUNCA por solape de shingles: dos fragmentos contiguos
//    comparten solo el párrafo de solape y son dos evidencias distintas.
// 3. Se preseleccionan N candidatos garantizando una cuota mínima por
//    documento, para que un paper largo no expulse al resto antes de que
//    nadie los lea.
// 4. El calificador (`calificador.calificarEvidencia`) lee cada candidato
//    completo y le da un grado frente al dato que se buscaba: directa, parcial
//    o no.
// 5. El orden final es determinista: grado > peso de la sección (Resultados
//    pesa más que Discusión; una sección desconocida es neutra, jamás
//    descarta) > rango RRF > id. Se entregan hasta `modo.fragmentos`, otra vez
//    con cuota mínima por documento.
//
// Todo con orden total y desempates explícitos, para que la misma entrada
// produzca los mismos ids: `huellaDe` lo mide en telemetría.
import type { ActionCtx } from "../_generated/server";
import * as hybrid from "../search/hybrid";
import type { FiltrosBusqueda, ModoRecuperacion } from "../search/hybrid";
// El calificador se invoca a través de `calificarConCache` (cacheCalificaciones.ts),
// que llama a `calificador.calificarEvidencia` solo para lo que no tiene veredicto guardado.
import { calificarConCache } from "./cacheCalificaciones";
import type { Calificacion, Grado } from "./calificador";
import { cita, fuente, localizador, type Fragmento } from "../lib/citas";
import { ajustes } from "../lib/config";
import type { Modo } from "../lib/modos";
import type { Telemetria } from "../lib/telemetry";
import type { PuntoPlan } from "./planner";

// Constante clásica de RRF. Con k=60 el primer puesto vale 1/61 y el décimo
// 1/70: premia coincidir en las dos listas sin que un solo primer puesto
// arrase.
export const RRF_K = 60;

export const CUBIERTO = "cubierto";
export const SIN_RESULTADOS = "sin_resultados";
/** Origen de un fragmento que trajo una búsqueda del modelo, no del plan. */
export const EXTRA = "extra";

// Cuota mínima por documento en la preselección de candidatos (paso 3) y en
// la entrega final (paso 5). Es un SUELO, no un techo: garantiza que un
// segundo documento entre a que lo lea el calificador, pero no recorta al
// primero si el resto no tiene nada relevante.
export const CUOTA_CANDIDATOS = 3;
export const CUOTA_FINAL = 2;

export const MAX_DOCUMENTOS_REVISADOS = 5;

// Secciones que no son evidencia y que aun así recupera la búsqueda porque
// repiten los términos de la pregunta (la bibliografía es el peor caso: cada
// referencia nombra el biomarcador y la cohorte). Lista local a propósito: no
// se importa nada de la ingesta.
const SECCIONES_PODADAS = [
  "bibliograf",
  "referenc",
  "agradecim",
  "acknowledg",
  "funding",
  "financia",
  "conflict",
  "conflicto",
  "competing interest",
  "declaration of interest",
];

// Peso de la sección en el orden final. En un trabajo científico un dato en
// Resultados es evidencia del propio estudio; el mismo enunciado en Discusión
// es interpretación de sus autores. Sección desconocida = 1.0 (neutro): el
// peso ordena, nunca descarta.
const PESOS_SECCION: Array<[string[], number]> = [
  [["result", "finding", "hallazgo"], 3.0],
  [["method", "metodo", "material", "abstract", "resumen", "summary"], 2.0],
  [["discus", "conclu", "limitation", "limitacion"], 1.5],
];

const GRADO_RANGO: Record<Grado, number> = { directa: 0, parcial: 1, no: 2 };

export interface PuntoEvidencia {
  id: string;
  query: string;
  queryEn: string;
  evidenceNeeded: string;
  fragmentos: Fragmento[];
  /** Documentos de los que salían los candidatos (para que, si no hay
   *  evidencia, el modelo sepa qué se revisó antes de decir "no está").
   *  Nombres ÚNICOS, como máximo `MAX_DOCUMENTOS_REVISADOS`. */
  documentosRevisados: string[];
  estado: "cubierto" | "sin_resultados";
  /** false cuando el calificador no se pudo aplicar: los fragmentos van en
   *  orden RRF y nadie debe concluir nada de que estén o no. */
  relevanciaVerificada: boolean;
  /** "error" = la búsqueda lanzó o no llegó a tiempo. NO es ausencia. */
  recuperacion: ModoRecuperacion;
  ms: number;
  /** Candidatos que llegaron al calificador. 0 con recuperación distinta de
   *  "error" significa que el índice no devolvió nada parecido. Es lo que la
   *  cabecera "se revisaron N fragmentos" necesita; el contrato no lo lista,
   *  pero el Python lo tenía y sin él el número no se puede reconstruir. */
  nCandidatos: number;
  /** Grado del calificador por `_id` del fragmento entregado. Vacío cuando no
   *  se calificó. Extensión respecto al contrato por la misma razón. */
  grados: Record<string, Grado>;
}

export interface EvidenciaPlan {
  puntos: PuntoEvidencia[];
  /** chunk `_id` -> ids de los puntos que lo recuperaron ("extra" para hops
   *  del modelo, que añade el bucle). Es la trazabilidad que antes no
   *  existía: con ella el verificador puede decir qué punto quedó sin usar. */
  mapa: Record<string, string[]>;
  /** Todo lo entregado al modelo, por `_id`, en orden estable (orden del
   *  plan y, dentro de cada punto, orden de entrega). */
  acumulado: Map<string, Fragmento>;
  /** chunk `_id` -> grado. Ausente = sin calificar. */
  grados: Record<string, Grado>;
  /** sha256 de los ids ordenados, para medir determinismo. */
  huella: string;
}

// --- utilidades deterministas -------------------------------------------------

/** Comparación de cadenas por unidad de código, sin locale: `localeCompare`
 *  depende de la configuración del runtime y aquí la misma entrada tiene que
 *  dar el mismo orden en cualquier máquina. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minúsculas sin acentos y con espacios colapsados: la forma en la que se
 *  comparan textos y nombres de sección. */
export function normalizar(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function seccionPodada(section: string | null | undefined): boolean {
  const norm = normalizar(section);
  return !!norm && SECCIONES_PODADAS.some((clave) => norm.includes(clave));
}

export function pesoSeccion(section: string | null | undefined): number {
  const norm = normalizar(section);
  if (!norm) return 1.0;
  for (const [claves, peso] of PESOS_SECCION) {
    if (claves.some((clave) => norm.includes(clave))) return peso;
  }
  return 1.0;
}

/** Fusión RRF de varias listas con orden total.
 *
 *  El desempate por (sourceFile, page, _id) importa: dos fragmentos con la
 *  misma puntuación RRF quedarían en el orden que diera el diccionario, y ese
 *  orden depende de cuál de las dos búsquedas respondió antes. */
export function fusionarRrf(listas: Fragmento[][]): Fragmento[] {
  const puntuacion = new Map<string, number>();
  const porId = new Map<string, Fragmento>();
  for (const lista of listas) {
    lista.forEach((ch, idx) => {
      puntuacion.set(ch._id, (puntuacion.get(ch._id) ?? 0) + 1 / (RRF_K + idx + 1));
      if (!porId.has(ch._id)) porId.set(ch._id, ch);
    });
  }
  return [...porId.values()].sort(
    (x, y) =>
      puntuacion.get(y._id)! - puntuacion.get(x._id)! ||
      cmpStr(x.sourceFile, y.sourceFile) ||
      x.page - y.page ||
      cmpStr(x._id, y._id),
  );
}

export function podar(chunks: Fragmento[]): Fragmento[] {
  return chunks.filter((c) => !seccionPodada(c.section));
}

/** Quita repetidos por id y por texto normalizado, conservando el primero.
 *
 *  Solo texto IDÉNTICO. Dos fragmentos contiguos comparten el párrafo de
 *  solape (unos 60 de 400 tokens) y son dos evidencias distintas: fusionarlos
 *  por solape de shingles perdía la segunda. */
export function deduplicar(chunks: Fragmento[]): Fragmento[] {
  const vistosId = new Set<string>();
  const vistosTexto = new Set<string>();
  const salida: Fragmento[] = [];
  for (const c of chunks) {
    const claveTexto = normalizar(c.text);
    if (vistosId.has(c._id) || (claveTexto && vistosTexto.has(claveTexto))) continue;
    vistosId.add(c._id);
    vistosTexto.add(claveTexto);
    salida.push(c);
  }
  return salida;
}

/** Los primeros `tope` de `ordenados`, garantizando `cuota` por documento.
 *
 *  La cuota es un suelo: si hay varios documentos, cada uno mete al menos
 *  `cuota` fragmentos (o los que tenga) desplazando a los últimos del
 *  documento que ya supera la cuota. Las tablas (chunkType "table") nunca se
 *  desplazan: una fila con la cifra es justo lo que se busca y suele quedar
 *  abajo del ranking porque tiene poco texto. Si solo quedan tablas por
 *  desplazar, la cuota cede y el tope se respeta igual. */
export function seleccionarConCuota(
  ordenados: Fragmento[],
  tope: number,
  cuota: number,
): Fragmento[] {
  if (tope <= 0) return [];
  if (ordenados.length <= tope) return [...ordenados];
  const porDoc = new Map<string, Fragmento[]>();
  for (const c of ordenados) {
    const lista = porDoc.get(c.sourceFile);
    if (lista) lista.push(c);
    else porDoc.set(c.sourceFile, [c]);
  }
  const seleccion = ordenados.slice(0, tope);
  if (porDoc.size < 2 || cuota <= 0) return seleccion;
  const ids = new Set(seleccion.map((c) => c._id));
  const cuenta = (doc: string): number =>
    seleccion.filter((c) => c.sourceFile === doc).length;

  // Documentos en orden de aparición en el ranking: el mejor documento
  // asegura su cuota antes que el siguiente.
  for (const [doc, lista] of porDoc) {
    const faltan = Math.max(0, cuota - cuenta(doc));
    const pendientes = lista.filter((c) => !ids.has(c._id)).slice(0, faltan);
    for (const candidato of pendientes) {
      let victima: Fragmento | null = null;
      for (let i = seleccion.length - 1; i >= 0; i--) {
        const c = seleccion[i];
        if (c.chunkType === "table" || c.sourceFile === doc) continue;
        if (cuenta(c.sourceFile) > cuota) {
          victima = c;
          break;
        }
      }
      if (!victima) break;
      seleccion.splice(seleccion.indexOf(victima), 1);
      ids.delete(victima._id);
      seleccion.push(candidato);
      ids.add(candidato._id);
    }
  }
  const rango = new Map(ordenados.map((c, i) => [c._id, i] as const));
  seleccion.sort((x, y) => rango.get(x._id)! - rango.get(y._id)!);
  return seleccion;
}

/** Nombres de documento únicos, en orden de aparición. */
function documentos(chunks: Fragmento[]): string[] {
  return [...new Set(chunks.map((c) => fuente(c)))];
}

// --- ejecución de un punto ------------------------------------------------------

/** Búsqueda híbrida de la consulta y, si difiere, de su versión en inglés,
 *  las dos en UNA llamada (un solo lote de embeddings), fusionadas por RRF.
 *  Si una de las dos viene en error se sigue con la otra; si las dos, lanza.
 *
 *  La recuperación del punto es la de la búsqueda más degradada de las que
 *  respondieron: si una fue híbrida y la otra cayó a solo densa, decir
 *  "híbrida" ocultaría que la mitad del punto no tuvo lado léxico. */
async function recuperar(
  ctx: ActionCtx,
  query: string,
  queryEn: string,
  filtros: FiltrosBusqueda,
  topK: number,
  tel: Telemetria,
): Promise<{ fusion: Fragmento[]; recuperacion: ModoRecuperacion }> {
  const consultas = [query];
  if (queryEn && normalizar(queryEn) !== normalizar(query)) consultas.push(queryEn);
  const resultados = await hybrid.buscarHibridoVarias(ctx, consultas, filtros, topK, tel);
  const utiles = (resultados ?? []).filter((r) => r && r.recuperacion !== "error");
  if (!utiles.length) {
    throw new Error(`las ${consultas.length} búsquedas del punto fallaron`);
  }
  if (utiles.length < consultas.length) {
    console.warn("Una de las búsquedas del punto falló; se sigue con la otra.");
  }
  const degradada = utiles.map((r) => r.recuperacion).find((m) => m !== "hibrida");
  return {
    fusion: fusionarRrf(utiles.map((r) => r.fragmentos)),
    recuperacion: degradada ?? "hibrida",
  };
}

function puntoVacio(item: PuntoPlan): PuntoEvidencia {
  return {
    id: item.id,
    query: item.query,
    queryEn: item.queryEn ?? "",
    evidenceNeeded: item.evidenceNeeded,
    fragmentos: [],
    documentosRevisados: [],
    estado: SIN_RESULTADOS,
    relevanciaVerificada: false,
    recuperacion: "error",
    ms: 0,
    nCandidatos: 0,
    grados: {},
  };
}

async function ejecutarPunto(
  ctx: ActionCtx,
  item: PuntoPlan,
  modo: Modo,
  filtros: FiltrosBusqueda,
  tel: Telemetria,
): Promise<PuntoEvidencia> {
  const t0 = Date.now();
  const punto = puntoVacio(item);
  const cerrar = (): PuntoEvidencia => {
    punto.ms = Date.now() - t0;
    return punto;
  };

  let fusion: Fragmento[];
  try {
    const r = await recuperar(ctx, item.query, item.queryEn ?? "", filtros, ajustes().searchTopK, tel);
    fusion = r.fusion;
    punto.recuperacion = r.recuperacion;
  } catch (exc) {
    console.warn(`Punto ${item.id}: la búsqueda falló (${String(exc).slice(0, 160)}).`);
    punto.recuperacion = "error";
    return cerrar();
  }

  const candidatos = seleccionarConCuota(
    deduplicar(podar(fusion)),
    Math.max(1, Math.trunc(modo.candidatosPorPunto) || 1),
    CUOTA_CANDIDATOS,
  );
  punto.nCandidatos = candidatos.length;
  punto.documentosRevisados = documentos(candidatos).slice(0, MAX_DOCUMENTOS_REVISADOS);
  if (!candidatos.length) return cerrar();

  let calificacion: Calificacion;
  try {
    // Con caché de veredictos: la misma (consulta, evidencia necesaria,
    // fragmento) reutiliza su grado, que es lo que hace que repetir una
    // pregunta reproduzca la misma evidencia (ver cacheCalificaciones.ts).
    calificacion = await calificarConCache(
      ctx,
      item.query,
      item.evidenceNeeded,
      candidatos,
      tel,
    );
  } catch (exc) {
    // Igual que el resto del sistema: el fallo del modelo degrada, no tumba.
    // Pero queda marcado, porque nadie debe leer estos fragmentos como
    // "relevantes": son "los más parecidos".
    console.warn(`Punto ${item.id}: el calificador falló (${String(exc).slice(0, 160)}).`);
    calificacion = { grados: {}, verificado: false, motivo: `calificador no aplicado: ${exc}` };
  }
  // Defensa en profundidad de la trampa "verificado con cero grados": el
  // calificador ya la cierra, pero si un sustituto (o un test) devolviera
  // verificado=true sin un solo grado, aquí se trata igual que un fallo.
  // Sin eso, todos los candidatos saldrían como "parcial" sin grado y con la
  // relevancia marcada como comprobada.
  const sinGrados = Object.keys(calificacion.grados).length === 0;

  const tope = Math.max(1, Math.trunc(modo.fragmentos) || 1);
  if (!calificacion.verificado || sinGrados) {
    punto.fragmentos = candidatos.slice(0, tope);
    punto.relevanciaVerificada = false;
  } else {
    // Un índice AUSENTE con verificado=true (el modelo se saltó una entrada)
    // no es un "no": nadie debe concluir nada de un grado ausente, y perder
    // una cifra por un descarte es peor que un fragmento de más. Se ordena
    // como "parcial" y se entrega sin grado.
    const gradoDe = (i: number): Grado => calificacion.grados[i] ?? "parcial";
    const relevantes = candidatos
      .map((c, i) => ({ i, c }))
      .filter(({ i }) => gradoDe(i) !== "no");
    // Orden final determinista: grado > peso de sección > rango RRF > id. El
    // índice `i` ES el rango RRF (los candidatos conservan ese orden).
    relevantes.sort(
      (x, y) =>
        GRADO_RANGO[gradoDe(x.i)] - GRADO_RANGO[gradoDe(y.i)] ||
        pesoSeccion(y.c.section) - pesoSeccion(x.c.section) ||
        x.i - y.i ||
        cmpStr(x.c._id, y.c._id),
    );
    punto.fragmentos = seleccionarConCuota(relevantes.map(({ c }) => c), tope, CUOTA_FINAL);
    const entregados = new Set(punto.fragmentos.map((c) => c._id));
    for (const { i, c } of relevantes) {
      if (entregados.has(c._id) && i in calificacion.grados) {
        punto.grados[c._id] = calificacion.grados[i];
      }
    }
    punto.relevanciaVerificada = true;
  }
  punto.estado = punto.fragmentos.length ? CUBIERTO : SIN_RESULTADOS;
  return cerrar();
}

function puntoFallido(item: PuntoPlan, ms: number, motivo: string): PuntoEvidencia {
  console.warn(`Punto ${item.id} no llegó: ${motivo}`);
  const punto = puntoVacio(item);
  punto.ms = ms;
  return punto;
}

const VENCIDO = Symbol("vencido");

/** Ejecuta todos los puntos del plan en paralelo y fusiona la evidencia.
 *
 *  Cada punto es una tarea propia bajo un único tope de reloj: `limiteMs` (lo
 *  que quede del presupuesto de la pregunta, según el bucle), recortado al
 *  `prefetchTimeoutS` del despliegue igual que hacía el Python con
 *  `evidence_prefetch_timeout_s`. Sin ese recorte, una búsqueda colgada se
 *  comería el presupuesto entero y dejaría sin tiempo a la redacción. El
 *  punto que no llega queda "sin_resultados" con recuperación "error" y el
 *  resto se entrega igual. Con `limiteMs <= 0` no se lanza ninguna búsqueda:
 *  no hay tiempo que gastar en llamadas cuyo resultado se va a descartar.
 *  Nunca lanza. */
export async function ejecutarPlan(
  ctx: ActionCtx,
  plan: PuntoPlan[],
  modo: Modo,
  filtros: FiltrosBusqueda,
  tel: Telemetria,
  limiteMs: number,
): Promise<EvidenciaPlan> {
  const evidencia: EvidenciaPlan = {
    puntos: [],
    mapa: {},
    acumulado: new Map(),
    grados: {},
    huella: huellaDe([]),
  };
  if (!plan.length) return evidencia;

  // Nunca por encima de lo que admite `setTimeout` (2^31-1 ms): Node trata
  // un valor mayor (o Infinity) como 1 ms, y con eso todos los puntos
  // vencerían al instante y el plan entero saldría en "error".
  const MAX_TIMEOUT_MS = 2_147_483_647;
  const prefetchMs = ajustes().prefetchTimeoutS * 1000;
  let tope = Math.max(0, Number(limiteMs) || 0);
  if (prefetchMs > 0) tope = Math.min(tope, prefetchMs);
  tope = Math.min(tope, MAX_TIMEOUT_MS);
  const t0 = Date.now();
  let puntos: PuntoEvidencia[];
  if (tope <= 0) {
    puntos = plan.map((it) => puntoFallido(it, 0, "sin tiempo para buscar"));
  } else {
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vencimiento = new Promise<typeof VENCIDO>((r) => {
      reloj = setTimeout(() => r(VENCIDO), tope);
    });
    try {
      const resultados = await Promise.all(
        plan.map((it) =>
          Promise.race([
            ejecutarPunto(ctx, it, modo, filtros, tel).then(
              (punto) => ({ punto }),
              (error: unknown) => ({ error }),
            ),
            vencimiento,
          ]),
        ),
      );
      const ms = Date.now() - t0;
      puntos = resultados.map((r, i) => {
        if (r === VENCIDO) {
          return puntoFallido(plan[i], ms, `no llegó en ${Math.round(tope / 1000)} s`);
        }
        if ("punto" in r) return r.punto;
        return puntoFallido(plan[i], ms, `excepción: ${String(r.error).slice(0, 160)}`);
      });
    } finally {
      clearTimeout(reloj);
    }
  }

  for (const punto of puntos) {
    evidencia.puntos.push(punto);
    for (const ch of punto.fragmentos) {
      const ids = (evidencia.mapa[ch._id] ??= []);
      if (!ids.includes(punto.id)) ids.push(punto.id);
      if (!evidencia.acumulado.has(ch._id)) evidencia.acumulado.set(ch._id, ch);
      // Un grado presente gana sobre ninguno (un punto sin calificador pudo
      // entregar el mismo fragmento que otro sí calificado); entre dos grados
      // manda el del primer punto del plan que lo trajo.
      const grado = punto.grados[ch._id];
      if (grado && !evidencia.grados[ch._id]) evidencia.grados[ch._id] = grado;
    }
  }
  evidencia.huella = huellaDe([...evidencia.acumulado.keys()]);
  return evidencia;
}

/** El mismo camino que un punto del plan, para UNA consulta.
 *
 *  Lo usan las búsquedas extra del modelo: así un hop del modelo pasa por la
 *  misma poda, la misma cuota y el mismo calificador que el plan, y su
 *  evidencia queda igual de trazable (`punto` = id del plan que intenta
 *  rellenar, o vacío = "extra"). */
export async function buscarYCalificar(
  ctx: ActionCtx,
  consulta: string,
  evidenceNeeded: string,
  punto: string,
  modo: Modo,
  filtros: FiltrosBusqueda,
  tel: Telemetria,
): Promise<PuntoEvidencia> {
  const item: PuntoPlan = {
    id: (punto ?? "").trim() || EXTRA,
    query: consulta,
    queryEn: "",
    evidenceNeeded: evidenceNeeded || consulta,
  };
  return ejecutarPunto(ctx, item, modo, filtros, tel);
}

// --- huella -----------------------------------------------------------------

/** sha256 hex de los ids entregados, ordenados. Dos corridas de la misma
 *  pregunta sobre el mismo índice deben dar la misma huella: es lo que mide
 *  el determinismo en telemetría. */
export function huellaDe(ids: string[]): string {
  const ordenados = [...ids].sort(cmpStr);
  return sha256Hex(new TextEncoder().encode(ordenados.join("\n")));
}

// SHA-256 puro (FIPS 180-4). Va escrito aquí porque la firma del contrato es
// síncrona (`huellaDe(ids): string`) y `crypto.subtle.digest` es asíncrono; y
// el runtime por defecto de Convex no trae `node:crypto`. Se comprueba en el
// test contra `crypto.subtle` con entradas de uno y de varios bloques.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(datos: Uint8Array): string {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = datos.length;
  // Relleno: 0x80, ceros hasta 56 mod 64, y la longitud en bits en 64 bits
  // big-endian.
  const conRelleno = new Uint8Array(Math.ceil((l + 9) / 64) * 64);
  conRelleno.set(datos);
  conRelleno[l] = 0x80;
  const vista = new DataView(conRelleno.buffer);
  const bits = l * 8;
  vista.setUint32(conRelleno.length - 8, Math.floor(bits / 0x100000000));
  vista.setUint32(conRelleno.length - 4, bits >>> 0);

  const W = new Uint32Array(64);
  for (let off = 0; off < conRelleno.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = vista.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

// --- lo que lee el modelo -----------------------------------------------------

/** Formato de resultados de la herramienta de búsqueda. Es el formato que el
 *  agente entrega desde siempre, con una línea opcional de grado del
 *  calificador. El verificador resuelve las citas por `cita(ch)`: la línea
 *  "cita:" tiene que seguir ahí, literal. */
export function formatearResultados(
  chunks: Fragmento[],
  grados?: Record<string, Grado> | null,
): string {
  if (!chunks.length) return "Sin resultados para esta búsqueda.";
  return chunks
    .map((ch, idx) => {
      // La cita va etiquetada y entre corchetes, ya montada, para que el
      // modelo la copie literal. La sección va en su propia línea y no
      // pegada a la cita: cuando iban juntas, el modelo arrastraba el
      // "sección: X" fuera de los corchetes y ensuciaba cada línea de la
      // respuesta con un texto que además no forma parte de la cita.
      const lineas = [`--- Resultado ${idx + 1} ---`, `cita: ${cita(ch)}`];
      if (ch.section && localizador(ch) !== `sección: ${ch.section}`) {
        lineas.push(`(sección del documento: ${ch.section})`);
      }
      const grado = grados?.[ch._id];
      if (grado) lineas.push(`(evidencia ${grado} para este punto)`);
      lineas.push(ch.text);
      return lineas.join("\n");
    })
    .join("\n\n");
}

export const AVISO_SIN_VERIFICAR =
  "AVISO: no se pudo verificar la relevancia de estos fragmentos, así " +
  "que puede haber alguno que no venga al caso. Cita solo lo que de " +
  "verdad responda a la pregunta.";

/** Si el punto se buscó de verdad en los dos idiomas. Es la misma condición
 *  con la que `recuperar` decide lanzar la segunda consulta: la cabecera no
 *  puede decir "en inglés" si no hubo una segunda búsqueda. */
function buscadoEnIngles(punto: PuntoEvidencia): boolean {
  return !!punto.queryEn && normalizar(punto.queryEn) !== normalizar(punto.query);
}

/** El mensaje `tool` de un punto: cabecera de estado + resultados.
 *
 *  La cabecera existe para que el modelo sepa QUÉ dato se buscaba y en qué
 *  quedó, sin tener que inferirlo de los fragmentos. DESCRIBE, no ordena: el
 *  Python decía "di que no lo encuentras" y eso convertía cualquier punto
 *  vacío en una orden de abstención. En el caso vacío dice qué documentos se
 *  revisaron: afirmar "no está" es una afirmación fuerte y el modelo tiene
 *  que poder darse cuenta si el usuario preguntó justo por uno de esos. Y un
 *  punto en error dice "no se pudo comprobar", que no es lo mismo que
 *  "no está en los documentos". */
export function textoDePunto(punto: PuntoEvidencia): string {
  const etiqueta =
    punto.id === EXTRA
      ? `BÚSQUEDA EXTRA (${punto.evidenceNeeded})`
      : `PUNTO ${punto.id} (${punto.evidenceNeeded})`;
  const idiomas = buscadoEnIngles(punto)
    ? "buscado en español e inglés"
    : "buscado solo con la formulación original";

  if (punto.estado === CUBIERTO && punto.fragmentos.length) {
    const docs = documentos(punto.fragmentos).join("; ");
    let cabecera =
      `${etiqueta}: cubierto, ${punto.fragmentos.length} fragmentos de: ${docs} ` +
      `(${idiomas})`;
    if (!punto.relevanciaVerificada) cabecera += "\n" + AVISO_SIN_VERIFICAR;
    return cabecera + "\n\n" + formatearResultados(punto.fragmentos, punto.grados);
  }

  if (punto.recuperacion === "error") {
    return (
      `${etiqueta}: no se pudo comprobar: la búsqueda falló o no llegó a tiempo, ` +
      `así que no hay fragmentos que leer y su ausencia no dice nada sobre los ` +
      `documentos.`
    );
  }
  if (punto.documentosRevisados.length) {
    const docs = punto.documentosRevisados.join("; ");
    return (
      `${etiqueta}: sin resultados: se revisaron ${punto.nCandidatos} fragmentos ` +
      `de ${docs} y ninguno aporta evidencia sobre este punto (${idiomas}).`
    );
  }
  return (
    `${etiqueta}: sin resultados: el índice no devolvió ningún fragmento ` +
    `parecido a esta consulta (${idiomas}).`
  );
}

export function idDeLlamada(puntoId: string): string {
  return `call_plan_${puntoId}`;
}

/** UN mensaje assistant con N tool_calls y N mensajes tool, en el orden del
 *  plan. Así la evidencia entra en la conversación exactamente como si el
 *  modelo la hubiera pedido, y el modelo la lee como resultados de búsqueda,
 *  que es lo que las reglas de fidelidad le mandan usar. El gateway acepta
 *  ids sintéticos: comprobado el 4 sep 2026, 200. */
export function mensajesSinteticos(
  ev: EvidenciaPlan,
  plan: PuntoPlan[],
): Record<string, unknown>[] {
  if (!ev.puntos.length) return [];
  const porId = new Map(plan.map((it) => [it.id, it] as const));
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: ev.puntos.map((p) => ({
      id: idDeLlamada(p.id),
      type: "function",
      function: {
        name: "buscar_documentos",
        arguments: JSON.stringify({
          semantico: porId.get(p.id)?.query ?? p.query,
          punto: p.id,
        }),
      },
    })),
  };
  const tools = ev.puntos.map((p) => ({
    role: "tool",
    tool_call_id: idDeLlamada(p.id),
    content: textoDePunto(p),
  }));
  return [assistant, ...tools];
}
