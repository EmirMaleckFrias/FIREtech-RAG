// Normalizadores de lo que el agente guarda en `messages` (sources, hops,
// plan, verificacion).
//
// Son funciones puras, sin cliente ni React, para poder probarlas contra
// documentos viejos y nuevos con un script de node (ver
// src/checks/normalize.check.ts) y con vitest.
//
// Regla comun: un campo ausente o con el tipo equivocado recibe un valor
// neutro, nunca uno que afirme algo. Los mensajes antiguos solo traen `n` y
// `query` en cada hop, y las fuentes sin `grado` NO son fuentes "no
// relevantes": son fuentes que nadie califico.

import type {
  CoberturaPunto,
  EstadoCobertura,
  Grado,
  Hop,
  PlanItem,
  Recuperacion,
  Source,
  Veredicto,
  Verificacion,
} from '../types';

const VEREDICTOS: readonly Veredicto[] = [
  'sostenida',
  'parcial',
  'no_sostenida',
  'cita_no_resuelve',
  'sin_cita',
  'sin_verificar',
];

const ESTADOS_COBERTURA: readonly EstadoCobertura[] = [
  'cubierto',
  'parcial',
  'evidencia_no_usada',
  'sin_resultados',
];

// Las dos grafias: la del agente de Convex (convex/search/hybrid.ts) y la
// inglesa de los mensajes anteriores a la migracion. Solo `error` cambia
// algo en la UI, pero un valor fuera de la lista se omite igual que antes.
const RECUPERACIONES: readonly Recuperacion[] = [
  'hibrida',
  'densa',
  'lexica',
  'error',
  'hybrid',
  'dense',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textos(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function enteros(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
    : [];
}

function estadoCobertura(value: unknown): EstadoCobertura | null {
  return ESTADOS_COBERTURA.includes(value as EstadoCobertura) ? (value as EstadoCobertura) : null;
}

/** Columna `plan` del mensaje: el agente de Convex guarda directamente la
 *  lista [{id, query, query_en, evidence_needed}]; el evento SSE anterior la
 *  envolvia en {"items": [...]}. Se aceptan las dos, y tambien las claves en
 *  camelCase del tipo PuntoPlan del planificador (queryEn, evidenceNeeded),
 *  por si alguna fila se escribio sin traducir. Se descartan los items sin
 *  id: sin id no hay forma de casarlos con los hops. */
export function normalizePlan(raw: unknown): PlanItem[] {
  const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : null;
  if (items === null) return [];
  const out: PlanItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = text(item.id).trim();
    if (id === '') continue;
    out.push({
      id,
      query: text(item.query),
      query_en: text(item.query_en ?? item.queryEn),
      evidence_needed: text(item.evidence_needed ?? item.evidenceNeeded),
    });
  }
  return out;
}

/** Un hop de la columna `hops`. Los campos nuevos solo se incluyen si vienen
 *  con el tipo correcto: un hop antiguo queda exactamente como {n, query},
 *  que es lo que el render antiguo espera. */
export function normalizeHop(raw: unknown): Hop | null {
  if (!isRecord(raw)) return null;
  const hop: Hop = {
    n: typeof raw.n === 'number' ? raw.n : 0,
    query: text(raw.query),
  };
  if (raw.origen === 'plan' || raw.origen === 'extra') hop.origen = raw.origen;
  if (typeof raw.plan_item === 'string' && raw.plan_item !== '') hop.plan_item = raw.plan_item;
  if (typeof raw.evidence_needed === 'string' && raw.evidence_needed !== '') {
    hop.evidence_needed = raw.evidence_needed;
  }
  if (typeof raw.resultados === 'number') hop.resultados = raw.resultados;
  if (Array.isArray(raw.documentos)) hop.documentos = textos(raw.documentos);
  if (raw.estado === 'cubierto' || raw.estado === 'sin_resultados') hop.estado = raw.estado;
  if (RECUPERACIONES.includes(raw.recuperacion as Recuperacion)) {
    hop.recuperacion = raw.recuperacion as Recuperacion;
  }
  if (typeof raw.relevancia_verificada === 'boolean') {
    hop.relevancia_verificada = raw.relevancia_verificada;
  }
  if (typeof raw.ms === 'number') hop.ms = raw.ms;
  const estadoFinal = estadoCobertura(raw.estado_final);
  if (estadoFinal !== null) hop.estado_final = estadoFinal;
  if (typeof raw.usado_en_respuesta === 'boolean') hop.usado_en_respuesta = raw.usado_en_respuesta;
  return hop;
}

/** Lista de hops persistida (messages.hops): null o basura -> []. */
export function normalizeHops(raw: unknown): Hop[] {
  if (!Array.isArray(raw)) return [];
  const out: Hop[] = [];
  for (const item of raw) {
    const hop = normalizeHop(item);
    if (hop !== null) out.push(hop);
  }
  return out;
}

/**
 * Normaliza el campo `sources` (puede venir ausente o con campos faltantes).
 * Los campos documentales y enriquecidos no existen en mensajes antiguos:
 * reciben valores neutros. Lo que el agente añada de mas (p. ej. `fuente`)
 * se ignora.
 */
export function normalizeSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  const out: Source[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const s = item;
    // Un grado fuera del contrato se trata como "sin calificar", no como
    // "directa": si el backend cambia y el frontend no, que se note como
    // ausencia y no como un aval inventado.
    const grado: Grado = s.grado === 'directa' || s.grado === 'parcial' ? s.grado : '';
    out.push({
      source_file: typeof s.source_file === 'string' ? s.source_file : 'desconocido',
      page: typeof s.page === 'number' ? s.page : null,
      snippet: text(s.snippet),
      score: typeof s.score === 'number' ? s.score : null,
      project_id: typeof s.project_id === 'string' ? s.project_id : null,
      document_id: typeof s.document_id === 'string' ? s.document_id : null,
      section: text(s.section).trim(),
      language: text(s.language).trim(),
      document_type: text(s.document_type).trim(),
      source_pages: enteros(s.source_pages),
      chunk_type: text(s.chunk_type),
      title: text(s.title).trim(),
      citation: text(s.citation).trim(),
      doi: text(s.doi).trim(),
      locator: text(s.locator).trim(),
      plan_items: textos(s.plan_items),
      grado,
    });
  }
  return out;
}

/** Cobertura por punto del informe. Se descartan las filas sin id o con un
 *  estado fuera del contrato: pintar un estado desconocido como cualquiera de
 *  los cuatro seria afirmar algo que el backend no dijo. */
export function normalizeCobertura(raw: unknown): CoberturaPunto[] {
  if (!Array.isArray(raw)) return [];
  const out: CoberturaPunto[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = text(item.id).trim();
    const estado = estadoCobertura(item.estado);
    if (id === '' || estado === null) continue;
    out.push({
      id,
      evidence_needed: text(item.evidence_needed),
      estado,
      n_fragmentos: typeof item.n_fragmentos === 'number' ? item.n_fragmentos : 0,
      documentos: textos(item.documentos),
      afirmaciones: enteros(item.afirmaciones),
    });
  }
  return out;
}

/** Valida el informe del verificador (columna `verificacion`).
 *
 * Un veredicto que no esté en el contrato cae a `sin_verificar`, nunca a
 * `sostenida`: si el backend cambiara y el frontend no, el fallo tiene que ser
 * visible como "sin comprobar" y no como un visto bueno inventado. */
export function normalizeVerificacion(raw: unknown): Verificacion | null {
  if (!isRecord(raw)) return null;
  const o = raw;
  const crudas = Array.isArray(o.afirmaciones) ? o.afirmaciones : [];
  const afirmaciones = crudas.flatMap((item) => {
    if (!isRecord(item)) return [];
    const a = item;
    const v = a.veredicto;
    return [
      {
        texto: text(a.texto),
        cita: text(a.cita),
        veredicto: VEREDICTOS.includes(v as Veredicto)
          ? (v as Veredicto)
          : ('sin_verificar' as Veredicto),
        motivo: text(a.motivo),
        fragmento_id: text(a.fragmento_id),
      },
    ];
  });
  return {
    afirmaciones,
    evidencia_sin_cubrir: textos(o.evidencia_sin_cubrir),
    citas_sin_resolver: textos(o.citas_sin_resolver),
    fidelidad: typeof o.fidelidad === 'number' ? o.fidelidad : null,
    ok: o.ok !== false,
    nota: text(o.nota),
    cobertura: normalizeCobertura(o.cobertura),
  };
}
