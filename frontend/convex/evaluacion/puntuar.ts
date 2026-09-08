// Evaluación determinista del RAG contra casos revisados por especialistas.
// Port de `backend/app/evaluation.py`, que apuntaba a la API de FastAPI que
// ya no existe; el runner que habla con Convex es `scripts/evaluar.ts`.
//
// Este módulo NO llama a modelos ni a Convex: es lógica pura. Comprueba lo
// que puede verificarse sin un juez probabilístico: cobertura de las
// evidencias esperadas, resolución de citas, conceptos cubiertos por las
// búsquedas, contenido obligatorio y prohibido, abstención, y la fidelidad
// que MIDIÓ el verificador en runtime (aquí solo se lee). Mantener esta capa
// determinista evita que un LLM juez esconda una regresión crítica detrás de
// una puntuación subjetiva.
//
// Los patrones de cita y de abstención son los de `lib/citas.ts`, los mismos
// que usa el verificador en producción: si runtime y benchmark contaran citas
// distintas, el benchmark dejaría de describir lo que hace el producto.
//
// Las claves del reporte se conservan en inglés y con los mismos nombres que
// tenía el evaluador Python (`passed`, `failures`, `evidence_recall`...) para
// que un reporte nuevo se pueda comparar con uno antiguo.
import { PATRONES_ABSTENCION, nuevaRegexCitas } from "../lib/citas";

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------
export interface FuenteEsperada {
  file: string;
  pages: number[];
  section_patterns: string[];
  locator_patterns: string[];
}

export interface Evidencia {
  id: string;
  description: string;
  /** Cualquiera de estas fuentes satisface el requisito. */
  sources: FuenteEsperada[];
}

export interface Caso {
  id: string;
  question: string;
  mode: "normal" | "extendido";
  category: string;
  critical: boolean;
  min_hops: number;
  evidence: Evidencia[];
  hop_patterns: string[];
  answer_must_contain: string[];
  answer_must_not_contain: string[];
  expect_abstention: boolean;
  /** Fidelidad mínima exigida (0..1), o null para no exigir ninguna. La mide
   *  el verificador en runtime; aquí solo se lee. */
  min_faithfulness: number | null;
  notes: string;
}

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function textoObligatorio(d: Record<string, unknown>, campo: string): string {
  const v = d[campo];
  if (typeof v !== "string" || v === "") throw new Error(`'${campo}' debe ser un texto no vacío`);
  return v;
}

function listaDeTextos(d: Record<string, unknown>, campo: string): string[] {
  const v = d[campo];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`'${campo}' debe ser una lista de textos`);
  }
  return v as string[];
}

function listaDeEnteros(d: Record<string, unknown>, campo: string): number[] {
  const v = d[campo];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isInteger(x))) {
    throw new Error(`'${campo}' debe ser una lista de enteros`);
  }
  return v as number[];
}

function booleano(d: Record<string, unknown>, campo: string, porDefecto: boolean): boolean {
  const v = d[campo];
  if (v === undefined) return porDefecto;
  if (typeof v !== "boolean") throw new Error(`'${campo}' debe ser true o false`);
  return v;
}

function fuenteEsperada(crudo: unknown): FuenteEsperada {
  if (!esObjeto(crudo)) throw new Error("cada fuente esperada debe ser un objeto");
  return {
    file: textoObligatorio(crudo, "file"),
    pages: listaDeEnteros(crudo, "pages"),
    section_patterns: listaDeTextos(crudo, "section_patterns"),
    locator_patterns: listaDeTextos(crudo, "locator_patterns"),
  };
}

function evidencia(crudo: unknown): Evidencia {
  if (!esObjeto(crudo)) throw new Error("cada evidencia debe ser un objeto");
  const sources = crudo.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`la evidencia '${String(crudo.id ?? "?")}' debe declarar al menos una fuente`);
  }
  return {
    id: textoObligatorio(crudo, "id"),
    description: textoObligatorio(crudo, "description"),
    sources: sources.map(fuenteEsperada),
  };
}

/** Valida un caso crudo (una línea del JSONL) y lo completa con los valores
 *  por defecto. Lanza con el motivo exacto. */
export function validarCaso(crudo: unknown): Caso {
  if (!esObjeto(crudo)) throw new Error("un caso debe ser un objeto JSON");
  const mode = crudo.mode ?? "extendido";
  if (mode !== "normal" && mode !== "extendido") throw new Error("'mode' debe ser normal o extendido");
  const minHops = crudo.min_hops ?? 1;
  if (typeof minHops !== "number" || !Number.isInteger(minHops) || minHops < 0) {
    throw new Error("'min_hops' debe ser un entero >= 0");
  }
  let minFaithfulness: number | null = null;
  if (crudo.min_faithfulness !== undefined && crudo.min_faithfulness !== null) {
    const f = crudo.min_faithfulness;
    if (typeof f !== "number" || !(f >= 0 && f <= 1)) throw new Error("'min_faithfulness' debe estar entre 0 y 1");
    minFaithfulness = f;
  }
  const evidence = Array.isArray(crudo.evidence) ? crudo.evidence.map(evidencia) : [];
  if (crudo.evidence !== undefined && !Array.isArray(crudo.evidence)) throw new Error("'evidence' debe ser una lista");
  const caso: Caso = {
    id: textoObligatorio(crudo, "id"),
    question: textoObligatorio(crudo, "question"),
    mode,
    category: typeof crudo.category === "string" && crudo.category ? crudo.category : "single_hop",
    critical: booleano(crudo, "critical", true),
    min_hops: minHops,
    evidence,
    hop_patterns: listaDeTextos(crudo, "hop_patterns"),
    answer_must_contain: listaDeTextos(crudo, "answer_must_contain"),
    answer_must_not_contain: listaDeTextos(crudo, "answer_must_not_contain"),
    expect_abstention: booleano(crudo, "expect_abstention", false),
    min_faithfulness: minFaithfulness,
    notes: typeof crudo.notes === "string" ? crudo.notes : "",
  };
  if (caso.expect_abstention && caso.evidence.length > 0) {
    throw new Error("un caso de abstención no puede exigir evidencias");
  }
  if (!caso.expect_abstention && caso.evidence.length === 0) {
    throw new Error("un caso factual debe declarar al menos una evidencia");
  }
  // Las regex se validan al cargar: un patrón roto tiene que fallar aquí, con
  // su línea, y no a mitad de un benchmark de una hora.
  for (const p of [...caso.hop_patterns, ...caso.answer_must_contain, ...caso.answer_must_not_contain]) regex(p);
  for (const e of caso.evidence) {
    for (const s of e.sources) for (const p of [...s.section_patterns, ...s.locator_patterns]) regex(p);
  }
  return caso;
}

/** Carga un JSONL (una línea por caso; las vacías y las que empiezan por `#`
 *  se saltan) con errores que señalan exactamente la línea. */
export function cargarCasos(texto: string, origen = "dataset"): Caso[] {
  const casos: Caso[] = [];
  const vistos = new Set<string>();
  const lineas = texto.split(/\r?\n/);
  lineas.forEach((cruda, i) => {
    const linea = cruda.trim();
    if (!linea || linea.startsWith("#")) return;
    let caso: Caso;
    try {
      caso = validarCaso(JSON.parse(linea));
    } catch (exc) {
      throw new Error(`${origen}:${i + 1}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    if (vistos.has(caso.id)) throw new Error(`${origen}:${i + 1}: id duplicado: ${caso.id}`);
    vistos.add(caso.id);
    casos.push(caso);
  });
  if (casos.length === 0) throw new Error(`${origen}: el benchmark no contiene casos`);
  return casos;
}

// ---------------------------------------------------------------------------
// Puntuación de una corrida
// ---------------------------------------------------------------------------
/** Lo que el runner captura de un turno del asistente. Acepta los nombres en
 *  inglés (los del reporte) y en español (los de la fila de Convex). */
export interface Resultado {
  id?: string;
  question?: string;
  mode?: string;
  answer?: string;
  respuesta?: string;
  sources?: unknown[];
  fuentes?: unknown[];
  hops?: unknown[];
  metrics?: Record<string, unknown>;
  error?: string | null;
  [k: string]: unknown;
}

/** En qué etapa del pipeline se perdió una evidencia esperada:
 *  - `retrieval`: no estaba entre los candidatos fusionados de ningún punto
 *    (la búsqueda no la trajo);
 *  - `grading`: sí estaba entre los candidatos pero el calificador o la cuota
 *    la dejaron fuera de las fuentes entregadas al modelo;
 *  - `generation`: llegó a las fuentes y la respuesta no la citó.
 *  Distinguirlas importa porque el arreglo es distinto en cada caso (índice y
 *  consultas, calificador, redacción); antes `evidence_recall` solo decía
 *  "no apareció" y todo se achacaba a la búsqueda. */
export type EtapaFallo = "retrieval" | "grading" | "generation";

export interface FilaEvidencia {
  id: string;
  description: string;
  found: boolean;
  matched_sources: string[];
  /** Posición (desde 1) del primer candidato fusionado que casa con alguna
   *  fuente esperada, la mejor entre los puntos del plan. `null` si ningún
   *  candidato casó o si el turno no informó candidatos
   *  (`metrics.meta.recuperacion` ausente en los mensajes antiguos). */
  rank?: number | null;
  /** Si alguna cita de la respuesta resuelve contra una fuente que casa con
   *  esta evidencia. Solo tiene sentido con `found`. */
  cited?: boolean;
  /** `null` cuando se encontró y se citó, o cuando no se puede saber (sin
   *  candidatos informados no se distingue `retrieval` de `grading`). */
  failure_stage?: EtapaFallo | null;
  /** Solo en el agregado de N corridas. */
  found_rate?: number;
}

export interface TipoDeFallo {
  type: string;
  detail: string;
  /** Solo en el agregado: en cuántas corridas ocurrió. */
  runs?: number;
}

export interface Metricas {
  evidence_recall: number;
  citation_precision: number;
  hops: number;
  hop_pattern_coverage: number;
  answer_pattern_coverage: number;
  abstained: boolean;
  faithfulness: number | null;
  unsupported_claims: number;
  unverified_claims: number;
  /** Media de 1/rank sobre las evidencias esperadas (0 la que no aparece
   *  entre los candidatos). `null` si el turno no informó candidatos o el
   *  caso no exige evidencias (abstención). */
  retrieval_mrr: number | null;
  /** Fracción de evidencias con rank <= 5 / <= 20. `null` como el MRR. */
  retrieval_hit_at_5: number | null;
  retrieval_hit_at_20: number | null;
  /** Fracción de las fuentes entregadas que casan con alguna evidencia
   *  esperada; 1 en un caso de abstención o sin fuentes. */
  context_precision: number | null;
  /** Afirmaciones que atribuyen a la entidad preguntada un dato de otra
   *  (`meta.verificacion.entidad_distinta`); 0 si falta. */
  entity_misattributions: number;
  [k: string]: number | boolean | null;
}

export interface Puntuacion {
  id: string;
  passed: boolean;
  critical: boolean;
  category: string;
  failures: string[];
  failure_types: TipoDeFallo[];
  evidence: FilaEvidencia[];
  metrics: Metricas;
  runs?: number;
  passed_rate?: number;
  dispersion?: Record<string, unknown>;
}

const cacheRegex = new Map<string, RegExp>();

/** Regex del caso: sin distinguir mayúsculas y con `.` cruzando saltos de
 *  línea, como `re.IGNORECASE | re.DOTALL`. Inválida = error del dataset. */
function regex(patron: string): RegExp {
  const previa = cacheRegex.get(patron);
  if (previa) return previa;
  try {
    const r = new RegExp(patron, "is");
    cacheRegex.set(patron, r);
    return r;
  } catch (exc) {
    throw new Error(`regex inválida ${JSON.stringify(patron)}: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

function casa(patron: string, texto: string): boolean {
  return regex(patron).test(texto);
}

function nombreDeFichero(ruta: string): string {
  const partes = ruta.replace(/\\/g, "/").split("/");
  return (partes[partes.length - 1] ?? "").toLowerCase();
}

function texto(x: unknown): string {
  return x === undefined || x === null ? "" : String(x);
}

/** La cita literal que resuelve esta fuente, tal como la copiaría el modelo. */
function citaDeFuente(fuente: Record<string, unknown>): string {
  const nombre = (texto(fuente.citation) || texto(fuente.source_file)).trim();
  let localizador = texto(fuente.locator).trim();
  if (!localizador) {
    const page = fuente.page;
    localizador = typeof page === "number" && page ? `pág. ${page}` : "";
  }
  return nombre && localizador ? `[${nombre}, ${localizador}]` : "";
}

/** Lo que hace falta de una fuente para compararla con una `FuenteEsperada`.
 *  Las fuentes entregadas (`sources`) y los candidatos de la recuperación
 *  (`meta.recuperacion`, con claves cortas para no engordar la fila del
 *  mensaje) se reducen a esta misma vista, así que la regla de "casa" es una
 *  sola y no puede divergir entre las dos. */
interface VistaFuente {
  archivo: string;
  paginas: Set<number>;
  seccion: string;
  localizador: string;
}

function paginasDe(pagina: unknown, varias: unknown): Set<number> {
  const paginas = new Set<number>(
    Array.isArray(varias) ? varias.filter((p): p is number => typeof p === "number") : [],
  );
  if (typeof pagina === "number") paginas.add(pagina);
  return paginas;
}

function vistaDeFuente(fuente: Record<string, unknown>): VistaFuente {
  return {
    archivo: texto(fuente.source_file),
    paginas: paginasDe(fuente.page, fuente.source_pages),
    seccion: texto(fuente.section),
    localizador: texto(fuente.locator),
  };
}

/** Un candidato tal como lo anota el agente en `metrics.meta.recuperacion`:
 *  `f` fichero, `p` página, `sp` páginas de origen, `sec` sección, `loc`
 *  localizador. Claves cortas a propósito: son hasta 20 por punto del plan y
 *  viajan en cada mensaje. */
interface Candidato {
  f: string;
  p: number;
  sp?: number[];
  sec?: string;
  loc: string;
}

function vistaDeCandidato(c: Candidato): VistaFuente {
  return {
    archivo: c.f,
    paginas: paginasDe(c.p, c.sp),
    seccion: c.sec ?? "",
    localizador: c.loc,
  };
}

function casaVista(esperada: FuenteEsperada, vista: VistaFuente): boolean {
  if (nombreDeFichero(vista.archivo) !== nombreDeFichero(esperada.file)) return false;
  if (esperada.pages.length && !esperada.pages.some((p) => vista.paginas.has(p))) return false;
  if (esperada.section_patterns.length && !esperada.section_patterns.some((p) => casa(p, vista.seccion))) return false;
  if (esperada.locator_patterns.length && !esperada.locator_patterns.some((p) => casa(p, vista.localizador))) return false;
  return true;
}

function fuenteCasa(esperada: FuenteEsperada, fuente: Record<string, unknown>): boolean {
  return casaVista(esperada, vistaDeFuente(fuente));
}

/** Los candidatos por punto que anotó el agente, saneados, o `null` si el
 *  turno no los trajo (mensajes anteriores a la marca, o un turno que murió
 *  antes de buscar). `null` y "un objeto vacío" son cosas distintas: vacío
 *  significa que se buscó y no hubo candidatos, y eso sí puntúa como 0. */
function candidatosDe(meta: Record<string, unknown>): Record<string, Candidato[]> | null {
  const crudo = meta.recuperacion;
  if (!esObjeto(crudo)) return null;
  const salida: Record<string, Candidato[]> = {};
  for (const [punto, lista] of Object.entries(crudo)) {
    if (!Array.isArray(lista)) continue;
    salida[punto] = lista.filter(esObjeto).map((c) => ({
      f: texto(c.f),
      p: typeof c.p === "number" ? c.p : Number(c.p) || 0,
      sp: Array.isArray(c.sp) ? c.sp.filter((x): x is number => typeof x === "number") : undefined,
      sec: typeof c.sec === "string" ? c.sec : undefined,
      loc: texto(c.loc),
    }));
  }
  return salida;
}

/** Posición (desde 1) del primer candidato que casa con la evidencia, la
 *  mejor entre todos los puntos (los hops extra van bajo "extra:<n>" y
 *  cuentan igual: si la trajo una búsqueda del modelo, se recuperó). */
function rangoDe(requisito: Evidencia, candidatos: Record<string, Candidato[]>): number | null {
  let mejor: number | null = null;
  for (const lista of Object.values(candidatos)) {
    const i = lista.findIndex((c) => requisito.sources.some((op) => casaVista(op, vistaDeCandidato(c))));
    if (i >= 0 && (mejor === null || i + 1 < mejor)) mejor = i + 1;
  }
  return mejor;
}

function redondear(x: number, decimales: number): number {
  const f = 10 ** decimales;
  return Math.round(x * f) / f;
}

/**
 * Puntúa una corrida de un caso.
 *
 * Cada fallo sale dos veces: como mensaje legible en `failures` y como
 * `{type, detail}` en `failure_types`, misma posición y misma longitud. El
 * desdoble no es adorno: `agregarCorridas` cuenta la frecuencia de cada fallo
 * en N corridas, y por cadena literal contaba mal porque varios fallos llevan
 * una medición de la corrida dentro del mensaje ("hops insuficientes: 0 < 2"
 * frente a "1 < 2"). El `type` es lo estable entre corridas (incluido lo que
 * identifica QUÉ falló: el id de la evidencia, el umbral) y el `detail` solo
 * lo que varía.
 */
export function puntuarCaso(caso: Caso, resultado: Resultado): Puntuacion {
  const answer = texto(resultado.answer ?? resultado.respuesta);
  const fuentes = ((resultado.sources ?? resultado.fuentes ?? []) as unknown[]).filter(esObjeto);
  const hops = (resultado.hops ?? []) as unknown[];
  const error = resultado.error;
  const fallos: Array<[string, string, string]> = [];
  const anotar = (tipo: string, mensaje?: string, detalle = "") => {
    fallos.push([tipo, mensaje ?? tipo, detalle]);
  };

  // Las citas de la respuesta se leen antes de recorrer las evidencias: hacen
  // falta para decidir si cada evidencia encontrada se CITÓ, no solo si llegó
  // a las fuentes.
  const citas = answer.match(nuevaRegexCitas()) ?? [];
  const citasEnRespuesta = new Set(citas.map((c) => c.toLowerCase()));
  const meta = esObjeto(resultado.metrics) && esObjeto(resultado.metrics.meta) ? resultado.metrics.meta : {};
  const candidatos = candidatosDe(meta);

  const evidence: FilaEvidencia[] = [];
  for (const requisito of caso.evidence) {
    const fuentesCasadas = fuentes.filter((f) => requisito.sources.some((op) => fuenteCasa(op, f)));
    const casadas = fuentesCasadas.map((f) => texto(f.source_file));
    const ok = casadas.length > 0;
    const cited = fuentesCasadas.some((f) => citasEnRespuesta.has(citaDeFuente(f).toLowerCase()));
    const rank = candidatos === null ? null : rangoDe(requisito, candidatos);
    // La etapa se deduce por eliminación: si no llegó a las fuentes y tampoco
    // estaba entre los candidatos, la perdió la búsqueda; si estaba entre los
    // candidatos, la descartó el calificador; si llegó a las fuentes y no se
    // citó, la ignoró la redacción. Sin candidatos informados no se puede
    // separar búsqueda de calificación, y se deja en null antes que adivinar.
    let failureStage: EtapaFallo | null = null;
    if (!ok) failureStage = candidatos === null ? null : rank === null ? "retrieval" : "grading";
    else if (!cited) failureStage = "generation";
    evidence.push({
      id: requisito.id,
      description: requisito.description,
      found: ok,
      matched_sources: [...new Set(casadas)].sort(),
      rank,
      cited,
      failure_stage: failureStage,
    });
    // El id viaja en el TIPO: dos evidencias distintas que faltan son dos
    // hallazgos distintos con su propia frecuencia al agregar.
    if (!ok) anotar(`evidencia no recuperada: ${requisito.id}`);
  }
  const evidenceRecall = evidence.length ? evidence.filter((e) => e.found).length / evidence.length : 1;

  // Métricas de recuperación. Miden la BÚSQUEDA, no la respuesta: un caso
  // puede pasar con MRR bajo (la evidencia estaba la vigésima y el
  // calificador la rescató) y fallar con MRR 1 (estaba la primera y la
  // redacción la ignoró). Null cuando no hay contra qué medir: sin candidatos
  // informados o sin evidencias exigidas. No penalizan: no generan fallo.
  const conCandidatos = candidatos !== null && evidence.length > 0;
  const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const retrievalMrr = conCandidatos
    ? redondear(media(evidence.map((e) => (e.rank ? 1 / e.rank : 0))), 4)
    : null;
  const hitAt = (k: number) =>
    conCandidatos ? redondear(evidence.filter((e) => e.rank !== null && e.rank !== undefined && e.rank <= k).length / evidence.length, 4) : null;
  // Precisión del contexto: de lo que se le puso delante al modelo, cuánto
  // era lo que el caso esperaba. En abstención o sin fuentes no hay nada que
  // medir y vale 1, no 0: entregar nada cuando no hay nada es lo correcto.
  const contextPrecision =
    caso.expect_abstention || fuentes.length === 0
      ? 1
      : redondear(
          fuentes.filter((f) => caso.evidence.some((e) => e.sources.some((op) => fuenteCasa(op, f)))).length / fuentes.length,
          4,
        );

  const textoHops = hops.map((h) => (esObjeto(h) ? texto(h.query) : "")).join("\n");
  const patronesHopQueFaltan = caso.hop_patterns.filter((p) => !casa(p, textoHops));
  if (hops.length < caso.min_hops) {
    anotar("hops insuficientes", `hops insuficientes: ${hops.length} < ${caso.min_hops}`, `${hops.length} < ${caso.min_hops}`);
  }
  if (patronesHopQueFaltan.length) anotar(`conceptos ausentes en búsquedas: ${patronesHopQueFaltan.join(", ")}`);

  const faltanEnRespuesta = caso.answer_must_contain.filter((p) => !casa(p, answer));
  const prohibidosPresentes = caso.answer_must_not_contain.filter((p) => casa(p, answer));
  if (faltanEnRespuesta.length) anotar(`respuesta incompleta: ${faltanEnRespuesta.join(", ")}`);
  if (prohibidosPresentes.length) anotar(`contenido prohibido: ${prohibidosPresentes.join(", ")}`);

  const abstained = PATRONES_ABSTENCION.some((p) => new RegExp(p, "i").test(answer));
  if (caso.expect_abstention && !abstained) anotar("debía abstenerse y no lo hizo");
  if (!caso.expect_abstention && abstained) anotar("se abstuvo en un caso con evidencia esperada");

  const resolubles = new Set(fuentes.map((f) => citaDeFuente(f).toLowerCase()));
  const noResolubles = citas.filter((c) => !resolubles.has(c.toLowerCase()));
  const citationPrecision = citas.length
    ? (citas.length - noResolubles.length) / citas.length
    : caso.expect_abstention
      ? 1
      : 0;
  if (noResolubles.length) {
    anotar("citas no resolubles", `citas no resolubles: ${noResolubles.join(", ")}`, noResolubles.join(", "));
  }
  if (!caso.expect_abstention && citas.length === 0) anotar("respuesta factual sin citas");
  if (error) anotar("error de ejecución", `error de ejecución: ${texto(error)}`, texto(error));

  // Fidelidad tal como la dictaminó el verificador en la corrida. Ausente =
  // verificación apagada: no se mide ni se penaliza, pero queda como null y
  // no como 1.0.
  const verificacion = esObjeto(meta.verificacion) ? meta.verificacion : {};
  const faithfulness = typeof verificacion.fidelidad === "number" ? verificacion.fidelidad : null;
  const noSostenidas = Number(verificacion.no_sostenidas ?? 0) || 0;
  const sinVerificar = Number(verificacion.sin_verificar ?? 0) || 0;
  // Atribuciones a otra entidad: el dato es real pero no es de quien la
  // pregunta dice. Van dentro de `no_sostenidas` (el verificador las fuerza a
  // ese veredicto), así que no se anota un fallo aparte: se cuentan para que
  // el resumen diga cuántas de las no sostenidas eran de esta clase.
  const entidadDistinta = Number(verificacion.entidad_distinta ?? 0) || 0;
  if (noSostenidas) {
    // Una atribución que su propio fragmento no sostiene es un fallo duro,
    // no un punto menos de nota.
    anotar(
      "afirmaciones que su fragmento citado no sostiene",
      `${noSostenidas} afirmación(es) que su fragmento citado no sostiene`,
      String(noSostenidas),
    );
  }
  if (caso.min_faithfulness !== null) {
    if (faithfulness === null) {
      anotar("el caso exige fidelidad mínima pero la verificación no la midió");
    } else if (faithfulness < caso.min_faithfulness) {
      const umbral = caso.min_faithfulness.toFixed(2);
      anotar(
        `fidelidad por debajo del mínimo ${umbral}`,
        `fidelidad ${faithfulness.toFixed(2)} por debajo del mínimo ${umbral}`,
        faithfulness.toFixed(2),
      );
    }
  }

  return {
    id: caso.id,
    passed: fallos.length === 0,
    critical: caso.critical,
    category: caso.category,
    failures: fallos.map(([, mensaje]) => mensaje),
    failure_types: fallos.map(([type, , detail]) => ({ type, detail })),
    evidence,
    metrics: {
      evidence_recall: redondear(evidenceRecall, 4),
      citation_precision: redondear(citationPrecision, 4),
      hops: hops.length,
      hop_pattern_coverage: caso.hop_patterns.length
        ? redondear(1 - patronesHopQueFaltan.length / caso.hop_patterns.length, 4)
        : 1,
      answer_pattern_coverage: caso.answer_must_contain.length
        ? redondear(1 - faltanEnRespuesta.length / caso.answer_must_contain.length, 4)
        : 1,
      abstained,
      faithfulness: faithfulness === null ? null : redondear(faithfulness, 4),
      unsupported_claims: noSostenidas,
      unverified_claims: sinVerificar,
      retrieval_mrr: retrievalMrr,
      retrieval_hit_at_5: hitAt(5),
      retrieval_hit_at_20: hitAt(20),
      context_precision: contextPrecision,
      entity_misattributions: entidadDistinta,
    },
  };
}

// ---------------------------------------------------------------------------
// Agregado de N corridas del mismo caso
// ---------------------------------------------------------------------------
/** k > N/2. Un empate (1 de 2, 2 de 4) NO es mayoría: un caso que falla la
 *  mitad de las veces no es fiable y no debe abrir el gate. */
function mayoriaEstricta(valores: boolean[]): boolean {
  return valores.filter(Boolean).length * 2 > valores.length;
}

/** Mediana redondeada, o null sin valores. Con N impar es un valor real de
 *  una corrida; con N par, el punto medio. */
function mediana(valores: number[], decimales: number): number | null {
  if (!valores.length) return null;
  const orden = valores.slice().sort((a, b) => a - b);
  const mitad = Math.floor(orden.length / 2);
  const m = orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
  return redondear(m, decimales);
}

/** (tipo, detalle) de cada fallo. Si `failure_types` falta o no cuadra en
 *  longitud (una fila de un reporte viejo), se degrada a agrupar por el
 *  mensaje literal: peor, pero legible y sin reventar. */
function entradasDeFallo(score: Puntuacion): Array<[string, string]> {
  const tipos = score.failure_types;
  const mensajes = score.failures ?? [];
  if (Array.isArray(tipos) && tipos.length === mensajes.length) {
    return tipos.map((t) => [texto(t.type), texto(t.detail)]);
  }
  return mensajes.map((m) => [m, ""]);
}

/** Agrupa los fallos de N corridas por TIPO, con su frecuencia (una corrida
 *  cuenta una vez aunque el tipo aparezca varias) y los detalles vistos como
 *  variantes, sin repetir. Los más frecuentes primero; a igualdad, el que se
 *  vio antes. */
function agruparFallos(scores: Puntuacion[], n: number): [string[], TipoDeFallo[]] {
  const cuentas = new Map<string, number>();
  const detalles = new Map<string, string[]>();
  const primeraVez = new Map<string, number>();
  for (const corrida of scores) {
    const vistos = new Set<string>();
    for (const [tipo, detalle] of entradasDeFallo(corrida)) {
      if (!primeraVez.has(tipo)) primeraVez.set(tipo, primeraVez.size);
      const variantes = detalles.get(tipo) ?? [];
      if (detalle && !variantes.includes(detalle)) variantes.push(detalle);
      detalles.set(tipo, variantes);
      if (!vistos.has(tipo)) {
        vistos.add(tipo);
        cuentas.set(tipo, (cuentas.get(tipo) ?? 0) + 1);
      }
    }
  }
  const ordenados = [...cuentas.entries()].sort(
    (a, b) => b[1] - a[1] || (primeraVez.get(a[0]) ?? 0) - (primeraVez.get(b[0]) ?? 0),
  );
  const mensajes: string[] = [];
  const tipos: TipoDeFallo[] = [];
  for (const [tipo, k] of ordenados) {
    const detalle = (detalles.get(tipo) ?? []).join(", ");
    mensajes.push(`${tipo} (${k}/${n} corridas)` + (detalle ? `: ${detalle}` : ""));
    tipos.push({ type: tipo, detail: detalle, runs: k });
  }
  return [mensajes, tipos];
}

export interface ResultadoAgregado {
  id: string;
  question: unknown;
  mode: unknown;
  runs: number;
  errors: string[];
  metrics: {
    cost_usd: number | null;
    ms_total: number | null;
    cost_usd_all_runs: number;
    ms_total_all_runs: number;
  };
  dispersion: Record<string, unknown>;
}

function coste(r: Resultado): number {
  const m = esObjeto(r.metrics) ? r.metrics : {};
  return Number(m.cost_usd ?? r.coste_usd ?? 0) || 0;
}

function latencia(r: Resultado): number {
  const m = esObjeto(r.metrics) ? r.metrics : {};
  return Number(m.ms_total ?? 0) || 0;
}

/**
 * Reduce N corridas del MISMO caso a una puntuación y un resultado.
 *
 * Por qué existe: la misma pregunta corrida 5 veces dio fidelidad entre 0.33 y
 * 1.00, entre 6 y 10 hops y entre 5 y 15 afirmaciones (medido el 3 sep 2026).
 * Con una sola pasada, cualquier "mejoró" tras un cambio es ruido.
 *
 * - Numéricas: MEDIANA, no media (un valor atípico no arrastra). La fidelidad
 *   solo sobre las corridas que la midieron.
 * - Booleanas (`passed`, `abstained`, `found`): MAYORÍA ESTRICTA, más la tasa.
 * - `dispersion[metrica]`: min, max, cuántas la midieron y el valor de cada
 *   corrida. Es la señal de inestabilidad que la mediana sola taparía.
 * - `failures`: la unión de lo visto, agrupada por tipo con su frecuencia.
 *
 * Con N = 1 devuelve la puntuación INTACTA más las claves aditivas `runs`,
 * `passed_rate` y `dispersion`.
 */
export function agregarCorridas(scores: Puntuacion[], results: Resultado[]): [Puntuacion, ResultadoAgregado] {
  if (!scores.length || scores.length !== results.length) {
    throw new Error("agregarCorridas necesita N >= 1 puntuaciones y sus N resultados");
  }
  const ids = [...new Set(scores.map((s) => String(s.id)))].sort();
  if (ids.length !== 1) throw new Error(`agregarCorridas mezcla casos distintos: ${JSON.stringify(ids)}`);
  const idsResultados = [...new Set(results.filter((r) => r.id !== undefined && r.id !== null).map((r) => String(r.id)))];
  if (idsResultados.some((x) => x !== ids[0])) {
    throw new Error(`agregarCorridas mezcla casos distintos: puntuaciones ${JSON.stringify(ids)} con resultados ${JSON.stringify(idsResultados.sort())}`);
  }
  if (scores.some((s) => "runs" in s)) {
    throw new Error(`${ids[0]}: las filas ya están agregadas; pasa las corridas crudas`);
  }

  const n = scores.length;
  const primera = scores[0];
  const metrics: Record<string, number | boolean | null> = {};
  const dispersion: Record<string, unknown> = {};
  for (const clave of Object.keys(primera.metrics)) {
    const crudos = scores.map((s) => s.metrics[clave]);
    const medidos = crudos.filter((v): v is number | boolean => v !== null && v !== undefined);
    if (medidos.length && medidos.every((v) => typeof v === "boolean")) {
      const positivos = medidos.filter(Boolean).length;
      metrics[clave] = mayoriaEstricta(medidos as boolean[]);
      dispersion[clave] = { rate: redondear(positivos / medidos.length, 4), values: crudos };
    } else {
      const numeros = medidos as number[];
      metrics[clave] = mediana(numeros, 4);
      dispersion[clave] = {
        min: numeros.length ? Math.min(...numeros) : null,
        max: numeros.length ? Math.max(...numeros) : null,
        n: numeros.length,
        values: crudos,
      };
    }
  }

  const evidenciaPorCorrida = scores.map((s) => new Map(s.evidence.map((e) => [e.id, e])));
  const evidence: FilaEvidencia[] = primera.evidence.map((fila) => {
    const filas = evidenciaPorCorrida.map((m) => m.get(fila.id));
    const found = filas.map((f) => Boolean(f?.found));
    const matched = [...new Set(filas.flatMap((f) => f?.matched_sources ?? []))].sort();
    const encontrada = mayoriaEstricta(found);
    // Rango: mediana de las corridas en que apareció entre los candidatos.
    // Citada: mayoría entre las corridas que lo midieron. La etapa se deduce
    // del agregado y no se vota suelta: si por mayoría se encontró, la única
    // etapa posible es la redacción (y solo si por mayoría no se citó); si
    // por mayoría faltó, la más frecuente entre las corridas en que faltó. Un
    // voto suelto podía decir "found: true, failure_stage: retrieval", que no
    // significa nada.
    const rangos = filas.map((f) => f?.rank).filter((r): r is number => typeof r === "number");
    const citadas = filas.map((f) => f?.cited).filter((c): c is boolean => typeof c === "boolean");
    const cited = citadas.length ? mayoriaEstricta(citadas) : undefined;
    let failureStage: EtapaFallo | null = null;
    if (encontrada) {
      failureStage = cited === false ? "generation" : null;
    } else {
      const cuentas = new Map<EtapaFallo, number>();
      for (const f of filas) {
        if (f && !f.found && (f.failure_stage === "retrieval" || f.failure_stage === "grading")) {
          cuentas.set(f.failure_stage, (cuentas.get(f.failure_stage) ?? 0) + 1);
        }
      }
      const orden: EtapaFallo[] = ["retrieval", "grading"];
      failureStage =
        [...cuentas.entries()].sort((a, b) => b[1] - a[1] || orden.indexOf(a[0]) - orden.indexOf(b[0]))[0]?.[0] ?? null;
    }
    return {
      ...fila,
      found: encontrada,
      found_rate: redondear(found.filter(Boolean).length / n, 4),
      matched_sources: matched,
      rank: mediana(rangos, 1),
      ...(cited === undefined ? {} : { cited }),
      failure_stage: failureStage,
    };
  });

  let failures: string[];
  let failureTypes: TipoDeFallo[];
  if (n === 1) {
    failures = primera.failures.slice();
    failureTypes = (primera.failure_types ?? []).map((t) => ({ ...t }));
  } else {
    [failures, failureTypes] = agruparFallos(scores, n);
  }

  const aprobadas = scores.map((s) => Boolean(s.passed));
  const kAprobadas = aprobadas.filter(Boolean).length;
  dispersion.passed = { rate: redondear(kAprobadas / n, 4), values: aprobadas };
  const score: Puntuacion = {
    id: primera.id,
    passed: mayoriaEstricta(aprobadas),
    critical: primera.critical,
    category: primera.category,
    failures,
    failure_types: failureTypes,
    evidence,
    metrics: metrics as Metricas,
    runs: n,
    passed_rate: redondear(kAprobadas / n, 4),
    dispersion,
  };

  const costes = results.map(coste);
  const latencias = results.map(latencia);
  const result: ResultadoAgregado = {
    id: primera.id,
    question: results[0].question,
    mode: results[0].mode,
    runs: n,
    errors: results.filter((r) => r.error).map((r) => texto(r.error)),
    metrics: {
      cost_usd: mediana(costes, 6),
      ms_total: mediana(latencias, 1),
      cost_usd_all_runs: redondear(costes.reduce((a, b) => a + b, 0), 6),
      ms_total_all_runs: redondear(latencias.reduce((a, b) => a + b, 0), 1),
    },
    dispersion: {
      cost_usd: { min: Math.min(...costes), max: Math.max(...costes), n, values: costes },
      ms_total: { min: Math.min(...latencias), max: Math.max(...latencias), n, values: latencias },
    },
  };
  return [score, result];
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
export interface Resumen {
  cases: number;
  passed: number;
  pass_rate: number;
  runs_total: number;
  run_pass_rate: number;
  unstable_cases: string[];
  critical_failures: string[];
  release_gate_passed: boolean;
  mean_evidence_recall: number;
  mean_citation_precision: number;
  mean_faithfulness: number | null;
  faithfulness_measured_cases: number;
  unsupported_claims_total: number;
  /** Medias de las métricas de recuperación sobre los casos que las midieron
   *  (null si ninguno: turnos antiguos sin candidatos, o solo abstenciones). */
  mean_retrieval_mrr: number | null;
  mean_retrieval_hit_at_5: number | null;
  mean_retrieval_hit_at_20: number | null;
  mean_context_precision: number | null;
  entity_misattributions_total: number;
  /** Evidencias esperadas perdidas, por la etapa en que se perdieron. Es un
   *  diagnóstico, no un gate: `generation` cuenta evidencias entregadas y no
   *  citadas, que no hacen fallar el caso. */
  failures_by_stage: Record<EtapaFallo, number>;
  total_cost_usd: number;
  total_cost_usd_all_runs: number;
  mean_latency_ms: number;
  by_category: Record<string, { total: number; passed: number }>;
}

/** Agrega sin esconder fallos críticos detrás de un promedio. Una fila es UN
 *  caso (cruda o ya agregada por `agregarCorridas`); el gate exige cero
 *  fallos críticos y todos los casos aprobados. */
export function resumir(scored: Puntuacion[], results: Array<Resultado | ResultadoAgregado>): Resumen {
  if (!scored.length) throw new Error("no hay resultados que resumir");
  const repetidos = [...scored.reduce((m, s) => m.set(s.id, (m.get(s.id) ?? 0) + 1), new Map<string, number>())]
    .filter(([, k]) => k > 1)
    .map(([id]) => id)
    .sort();
  if (repetidos.length) {
    throw new Error(`ids repetidos en el resumen: ${JSON.stringify(repetidos)}; agrega las repeticiones con agregarCorridas antes de resumir`);
  }
  const n = scored.length;
  const runs = scored.map((s) => Number(s.runs ?? 1));
  const aprobadasPorCaso = scored.map((s, i) => Math.round(Number(s.passed_rate ?? (s.passed ? 1 : 0)) * runs[i]));
  const criticos = scored.filter((s) => s.critical && !s.passed).map((s) => s.id);
  const costes = results.map((r) => coste(r as Resultado));
  const gastado = results.map((r, i) => {
    const m = esObjeto(r.metrics) ? (r.metrics as Record<string, unknown>) : {};
    return Number(m.cost_usd_all_runs ?? costes[i]) || 0;
  });
  const latencias = results.map((r) => latencia(r as Resultado));
  const porCategoria: Record<string, { total: number; passed: number }> = {};
  for (const s of scored) {
    const b = (porCategoria[s.category] ??= { total: 0, passed: 0 });
    b.total += 1;
    b.passed += s.passed ? 1 : 0;
  }
  const medidos = scored.filter((s) => s.metrics.faithfulness !== null && s.metrics.faithfulness !== undefined);
  const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  // Media de una métrica sobre los casos que la midieron; null si ninguno.
  // Las filas de un reporte anterior a estas métricas no las llevan y no
  // deben contar como 0.
  const mediaMedida = (clave: string): number | null => {
    const valores = scored
      .map((s) => s.metrics[clave])
      .filter((x): x is number => typeof x === "number");
    return valores.length ? redondear(suma(valores) / valores.length, 4) : null;
  };
  const porEtapa: Record<EtapaFallo, number> = { retrieval: 0, grading: 0, generation: 0 };
  for (const s of scored) {
    for (const e of s.evidence) {
      if (e.failure_stage === "retrieval" || e.failure_stage === "grading" || e.failure_stage === "generation") {
        porEtapa[e.failure_stage] += 1;
      }
    }
  }
  return {
    cases: n,
    passed: scored.filter((s) => s.passed).length,
    pass_rate: redondear(scored.filter((s) => s.passed).length / n, 4),
    runs_total: suma(runs),
    run_pass_rate: redondear(suma(aprobadasPorCaso) / suma(runs), 4),
    unstable_cases: scored.filter((_, i) => aprobadasPorCaso[i] > 0 && aprobadasPorCaso[i] < runs[i]).map((s) => s.id),
    critical_failures: criticos,
    release_gate_passed: criticos.length === 0 && scored.every((s) => s.passed),
    mean_evidence_recall: redondear(suma(scored.map((s) => Number(s.metrics.evidence_recall))) / n, 4),
    mean_citation_precision: redondear(suma(scored.map((s) => Number(s.metrics.citation_precision))) / n, 4),
    mean_faithfulness: medidos.length
      ? redondear(suma(medidos.map((s) => Number(s.metrics.faithfulness))) / medidos.length, 4)
      : null,
    faithfulness_measured_cases: medidos.length,
    unsupported_claims_total: suma(scored.map((s) => Number(s.metrics.unsupported_claims ?? 0))),
    mean_retrieval_mrr: mediaMedida("retrieval_mrr"),
    mean_retrieval_hit_at_5: mediaMedida("retrieval_hit_at_5"),
    mean_retrieval_hit_at_20: mediaMedida("retrieval_hit_at_20"),
    mean_context_precision: mediaMedida("context_precision"),
    entity_misattributions_total: suma(scored.map((s) => Number(s.metrics.entity_misattributions ?? 0) || 0)),
    failures_by_stage: porEtapa,
    total_cost_usd: redondear(suma(costes), 6),
    total_cost_usd_all_runs: redondear(suma(gastado), 6),
    mean_latency_ms: redondear(suma(latencias) / n, 1),
    by_category: porCategoria,
  };
}
