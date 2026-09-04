// Del documento `messages` de Convex al ChatMessage que pintan los componentes.
//
// Puro a propósito (sin React ni cliente): se prueba en node contra
// documentos viejos y nuevos (src/lib/mensajes.test.ts).
//
// Lo que aquí se decide, y por qué:
// - **Un mensaje sin `estado` es un mensaje terminado.** Los anteriores al
//   contrato no tienen la columna; si tienen `error` se pintan como error y
//   si no, como respuesta lista. Nunca se les inventa un "pensando".
// - **Un turno colgado se declara.** Una acción de Convex muere a los 600 s.
//   Si el agente no llegó a escribir `listo` ni `error` (la acción reventó
//   antes del catch, el despliegue se reinició), la fila se quedaría en
//   `pensando` para siempre y con ella el composer deshabilitado. Pasado el
//   tope se pinta como error de tiempo, sin tocar la base.
// - **El texto llega de golpe.** La barrera retiene `content` hasta `listo`,
//   así que no hay tokens sueltos ni caret que perseguir.

import type { Id } from '../../convex/_generated/dataModel';
import type { ChatMessage, EstadoTurno, Hop, PlanItem } from '../types';
import { ANCLA } from './cobertura';
import { normalizeHops, normalizePlan, normalizeSources, normalizeVerificacion } from './normalize';

/** Tope de un turno: los 600 s de una acción de Convex más el margen del
 *  planificador de tareas. Pasado esto, nadie va a escribir en esa fila. */
export const TURNO_MAX_MS = 630_000;

export const TIMEOUT_MSG = 'El asistente no respondió a tiempo. Vuelve a intentarlo.';
const ERROR_GENERICO = 'Error del servidor durante la generación.';

const ESTADOS: readonly EstadoTurno[] = [
  'pensando',
  'buscando',
  'redactando',
  'revisando',
  'listo',
  'error',
];

/** Lo que el frontend lee de un documento `messages`. Es un tipo estructural
 *  (no el Doc generado) para que un campo que la query añada, como el
 *  feedback del propio usuario, no rompa nada. */
export interface MensajeDoc {
  _id: Id<'messages'>;
  role: string;
  content: string;
  sources?: unknown;
  hops?: unknown;
  plan?: unknown;
  verificacion?: unknown;
  estado?: string;
  error?: string;
  creadoEn: number;
  feedback?: unknown;
}

function esEstado(value: unknown): value is EstadoTurno {
  return ESTADOS.includes(value as EstadoTurno);
}

/** Estado declarado por la fila, sin mirar el reloj. */
function estadoDeclarado(doc: Pick<MensajeDoc, 'role' | 'estado' | 'error'>): EstadoTurno {
  if (doc.role !== 'assistant') return 'listo';
  if (esEstado(doc.estado)) return doc.estado;
  return typeof doc.error === 'string' && doc.error.trim() !== '' ? 'error' : 'listo';
}

export function esFinal(estado: EstadoTurno): boolean {
  return estado === 'listo' || estado === 'error';
}

/** Estado a pintar, con el tope de tiempo aplicado. */
export function estadoDeMensaje(
  doc: Pick<MensajeDoc, 'role' | 'estado' | 'error' | 'creadoEn'>,
  ahora: number,
): EstadoTurno {
  const estado = estadoDeclarado(doc);
  if (esFinal(estado)) return estado;
  return ahora - doc.creadoEn > TURNO_MAX_MS ? 'error' : estado;
}

export function mensajeDesdeDoc(
  doc: MensajeDoc,
  ahora: number,
  feedbackLocal: 1 | -1 | null,
): ChatMessage {
  const declarado = estadoDeclarado(doc);
  const estado = estadoDeMensaje(doc, ahora);
  const caducado = estado === 'error' && !esFinal(declarado);
  let error: string | null = null;
  if (estado === 'error') {
    error = caducado
      ? TIMEOUT_MSG
      : typeof doc.error === 'string' && doc.error.trim() !== ''
        ? doc.error
        : ERROR_GENERICO;
  }
  // El feedback que devuelva la query manda; si no viene, el que el usuario
  // acaba de dar en esta pestaña (la tabla `feedback` es aparte).
  const fb = doc.feedback;
  const feedback: 1 | -1 | null = fb === 1 || fb === -1 ? fb : feedbackLocal;

  return {
    localId: doc._id,
    id: doc._id,
    role: doc.role === 'user' ? 'user' : 'assistant',
    content: doc.content ?? '',
    sources: normalizeSources(doc.sources),
    hops: normalizeHops(doc.hops),
    plan: normalizePlan(doc.plan),
    verificacion: normalizeVerificacion(doc.verificacion),
    estado,
    streaming: !esFinal(estado),
    error,
    feedback,
    creadoEn: doc.creadoEn,
  };
}

/** Puntos del plan sin el ancla e0 (la pregunta entera). Con plan `[e0]`, que
 *  es el modo normal, NO hay "partes de la pregunta" que enseñar. */
export function puntosDelPlan(plan: PlanItem[]): PlanItem[] {
  return plan.filter((p) => p.id !== ANCLA);
}

/**
 * Si la búsqueda de este hop aún no ha terminado.
 *
 * El agente inserta un hop extra ANTES de buscar, como marcador, con
 * `recuperacion: "error"`, `resultados: 0` y `ms: 0`, y lo completa al
 * terminar. Mientras el turno está en curso, esa combinación es "buscando";
 * en un turno ya cerrado nadie va a completarla, así que es un fallo real.
 */
export function hopEnCurso(h: Hop, turnoEnCurso: boolean): boolean {
  return (
    turnoEnCurso &&
    h.recuperacion === 'error' &&
    (h.resultados ?? 0) === 0 &&
    (h.ms ?? 0) === 0
  );
}

/** La búsqueda de este hop falló: no se pudo comprobar el punto. Distinto de
 *  "sin resultados", que sí afirma que se buscó y no estaba. */
export function hopFallido(h: Hop, turnoEnCurso: boolean): boolean {
  return h.recuperacion === 'error' && (h.resultados ?? 0) === 0 && !hopEnCurso(h, turnoEnCurso);
}

/** Texto de la fase en curso, para la cabecera del razonamiento. */
export function etiquetaFase(estado: EstadoTurno, variasPartes: boolean): string {
  switch (estado) {
    case 'buscando':
      return variasPartes ? 'Buscando cada parte de la pregunta…' : 'Buscando en los documentos…';
    case 'redactando':
      return 'Redactando…';
    case 'revisando':
      return 'Comprobando cada afirmación…';
    default:
      return 'Pensando…';
  }
}
