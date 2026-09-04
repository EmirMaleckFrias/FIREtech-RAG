// Tipos compartidos del frontend, alineados con el contrato de la migración a
// Convex (convex/CONTRATO.md: "Funciones de datos" y "Estado del turno").
//
// Conviven dos familias de formas, y es a propósito:
// - Lo que el agente guarda dentro de `messages` (Source, Hop, Verificacion,
//   CoberturaPunto, PlanItem) va en snake_case porque el contrato lo fija así:
//   son las mismas formas que ya viajaban por SSE y el agente las escribe
//   idénticas. No se renombran.
// - Lo que sale de las tablas (sesiones, documentos, usuarios) va en camelCase
//   y en español, como los campos de convex/schema.ts, y los ids son los `_id`
//   de Convex en vez de los uuid de Postgres.

import type { Id } from '../convex/_generated/dataModel';

/** Roles de negocio (users.rol).
 *
 * `lector` sustituye al antiguo `vendedor`: en Supabase el identificador no se
 * pudo cambiar porque la migración 010 nunca llegó a aplicarse, y el esquema
 * de Convex nace ya con el nombre que el producto quería. */
export type UserRole = 'admin' | 'lector';

/** Etiqueta visible de cada rol. Única definición: antes estaba duplicada en
 *  SessionSidebar y SettingsPanel, que es la forma habitual de que las dos
 *  copias acaben diciendo cosas distintas. */
export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Administrador',
  lector: 'Lector',
};

/** Identidad del usuario en sesión (usuarios.yo). */
export interface Me {
  id: Id<'users'>;
  email: string;
  rol: UserRole;
}

/**
 * Cuenta de usuario tal como la devuelve usuarios.listar (solo admin).
 *
 * Los contadores son SOLO números: las conversaciones son privadas y el panel
 * de ajustes nunca muestra su contenido, ni siquiera a un administrador.
 */
export interface UserAccount {
  id: Id<'users'>;
  email: string;
  rol: UserRole;
  /**
   * Acceso revocado por un administrador. La cuenta y sus conversaciones se
   * conservan: es reversible (usuarios.actualizar con `bloqueado: false`), al
   * revés que el borrado.
   */
  bloqueado: boolean;
  /** Fecha de alta en ms; null si el registro no la trae. */
  creadoEn: number | null;
  /** Último acceso en ms; null si la cuenta nunca ha entrado. */
  ultimoAccesoEn: number | null;
  sesiones: number;
  mensajes: number;
}

/** Estado del sistema para el panel de ajustes (estadisticas.sistema, solo admin). */
export interface AdminStats {
  index: {
    chunks: number;
    files: number;
    /** Extensiones presentes en el índice (pdf, docx...). */
    types: string[];
    /** Idiomas detectados en los documentos. */
    languages: string[];
  };
  activity: {
    questions_total: number;
    questions_7d: number;
    active_users_7d: number;
    feedback_up: number;
    feedback_down: number;
  };
  config: {
    model: string;
    embedding_model: string;
    prompt_version: string;
    upload_limit_mb: number;
  };
}

/** Conversación tal como la devuelve sesiones.listar. */
export interface SessionInfo {
  id: Id<'sessions'>;
  titulo: string;
  creadoEn: number;
}

/** Estado de la conexión WebSocket con Convex. Sustituye al sondeo de
 *  /api/health: ya no hay backend HTTP que vigilar, y si el socket está
 *  abierto las suscripciones llegan; si no, nada llega. */
export type EstadoConexion = 'conectando' | 'en_linea' | 'sin_conexion';

/** Cuánto se le deja buscar y deliberar al agente. No cambia las reglas de
 *  fidelidad: un modo rápido que además miente no sirve de nada. */
export type ModoPensamiento = 'normal' | 'extendido';

export interface Source {
  source_file: string;
  page: number | null;
  snippet: string;
  score: number | null;
  project_id?: string | null;
  document_id?: string | null;
  section?: string;
  language?: string;
  document_type?: string;
  source_pages?: number[];
  chunk_type?: string;
  /** Titulo del trabajo, si el documento es un articulo. */
  title?: string;
  /** Referencia corta ("Allegri et al., 2023"); vacia si no se pudo extraer. */
  citation?: string;
  doi?: string;
  /** Localizador ya resuelto por el agente: "pag. 12", "seccion: Metodos". */
  locator?: string;
  /** Puntos del plan que recuperaron este fragmento ("e0", "e2"...). */
  plan_items?: string[];
  /** Grado que le dio el calificador respecto a su punto del plan. Vacio =
   *  sin calificar (calificador apagado o caido): NO significa "no". */
  grado?: Grado;
}

/** Grado de relevancia de un fragmento para su punto del plan. */
export type Grado = 'directa' | 'parcial' | '';

/** Punto del plan de evidencia (columna `plan` del mensaje). El ancla `e0` es
 *  siempre la pregunta literal del usuario; los demas son los sub-puntos que
 *  el planificador decidio buscar por separado. */
export interface PlanItem {
  id: string;
  query: string;
  query_en?: string;
  /** Que evidencia hace falta, en lenguaje claro. Es lo que se le muestra a
   *  quien pregunta (los ids son internos). */
  evidence_needed: string;
}

/** Estado de un punto del plan tras el verificador (contrato D/F). */
export type EstadoCobertura = 'cubierto' | 'parcial' | 'evidencia_no_usada' | 'sin_resultados';

/** Cómo se recuperó la evidencia de un hop.
 *
 *  `error` significa que la búsqueda lanzó o no llegó a tiempo, y NO es "no
 *  está en los documentos": la UI lo pinta como "no se pudo comprobar". Se
 *  aceptan las dos grafías porque los mensajes anteriores a la migración
 *  guardan las inglesas (`hybrid`, `dense`) y el agente de Convex escribe las
 *  de convex/search/hybrid.ts. */
export type Recuperacion = 'hibrida' | 'densa' | 'lexica' | 'error' | 'hybrid' | 'dense';

/** Busqueda del agente. Solo `n` y `query` estan garantizados: los mensajes
 *  antiguos persistieron unicamente esos dos campos, y el resto son
 *  opcionales para poder leerlos igual. */
export interface Hop {
  n: number;
  query: string;
  /** 'plan' si la lanzo un punto del plan; 'extra' si la decidio el modelo. */
  origen?: 'plan' | 'extra';
  /** Id del punto del plan al que sirve ("e1"). Lo llevan los hops del plan
   *  y tambien los extra en los que el modelo declaro el punto: esos
   *  actualizan el estado de ese punto en la UI. Vacio si no hay punto. */
  plan_item?: string;
  evidence_needed?: string;
  resultados?: number;
  /** Referencias cortas de los documentos que aportaron fragmentos. */
  documentos?: string[];
  estado?: 'cubierto' | 'sin_resultados';
  recuperacion?: Recuperacion;
  relevancia_verificada?: boolean;
  ms?: number;
  /** Solo en hops de plan ya cerrados: estado de cobertura que le dio el
   *  verificador. Permite reconstruir la cobertura de un mensaje antiguo
   *  aunque el informe no se hubiera guardado. */
  estado_final?: EstadoCobertura;
  usado_en_respuesta?: boolean;
}

/** Veredicto de una afirmación frente al fragmento que citó.
 *
 * `sin_verificar` es el estado por defecto del agente y NO significa
 * "correcta": significa que nadie la comprobó (modelo caído, JSON inválido o
 * respuesta por encima del tope). Pintarlo como aprobado sería exactamente el
 * fallo que el verificador existe para evitar. */
export type Veredicto =
  | 'sostenida'
  | 'parcial'
  | 'no_sostenida'
  /** La cita no corresponde a ningún fragmento recuperado. */
  | 'cita_no_resuelve'
  /** La respuesta afirma y no cita nada, sin declarar ausencia de evidencia. */
  | 'sin_cita'
  | 'sin_verificar';

export interface Afirmacion {
  texto: string;
  cita: string;
  veredicto: Veredicto;
  motivo: string;
  fragmento_id: string;
}

/** Informe de atribución de una respuesta (columna `verificacion`). */
export interface Verificacion {
  afirmaciones: Afirmacion[];
  evidencia_sin_cubrir: string[];
  /** Citas que no corresponden a ningún fragmento recuperado. El fallo grave. */
  citas_sin_resolver: string[];
  /** Proporción de sostenidas sobre las juzgadas. null = no se juzgó ninguna. */
  fidelidad: number | null;
  ok: boolean;
  nota: string;
  /** Cobertura por punto del plan (sin `e0`). Vacia si no hubo plan o el
   *  informe es anterior al contrato. */
  cobertura: CoberturaPunto[];
}

/** Estado de cobertura de un punto del plan segun el verificador. */
export interface CoberturaPunto {
  id: string;
  evidence_needed: string;
  estado: EstadoCobertura;
  n_fragmentos: number;
  documentos: string[];
  /** Indices (en `afirmaciones`) de las afirmaciones que usaron su evidencia. */
  afirmaciones: number[];
}

/** Fase del turno del asistente (columna `estado` del mensaje). El agente la
 *  va escribiendo y el cliente se resuscribe: `pensando` -> `buscando` ->
 *  `redactando` -> `revisando` -> `listo` | `error`. El texto de la respuesta
 *  NO aparece hasta `listo`: la barrera de revisión lo retiene. */
export type EstadoTurno = 'pensando' | 'buscando' | 'redactando' | 'revisando' | 'listo' | 'error';

/** Mensaje en el estado local del chat. */
export interface ChatMessage {
  /** Clave estable local. Es el `_id` en los mensajes ya guardados y una
   *  clave provisional en el par optimista que se pinta mientras la mutación
   *  de envío está en vuelo. */
  localId: string;
  /** id de Convex; null solo en el par optimista. */
  id: Id<'messages'> | null;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  hops: Hop[];
  /** Plan de evidencia. Vacio en modo normal sin planificador, en preguntas
   *  que no van a los documentos y en mensajes anteriores al contrato. */
  plan: PlanItem[];
  /** Informe del verificador. null mientras no llega o si está desactivado. */
  verificacion: Verificacion | null;
  estado: EstadoTurno;
  /** true mientras `estado` no es final (listo o error). Es derivado, no se
   *  guarda: existe para que los componentes que ya distinguian "en curso"
   *  sigan haciendolo igual que con el streaming. */
  streaming: boolean;
  error: string | null;
  feedback: 1 | -1 | null;
  /** Momento de creacion en ms. Con el permite detectar un turno colgado. */
  creadoEn: number;
}

/** Estado de ingesta de un documento (documents.status). */
export type DocumentStatus = 'processing' | 'ready' | 'failed';

/** Documento indexado tal como lo devuelve documentos.listar. */
export interface DocumentInfo {
  id: Id<'documents'>;
  fileName: string;
  pages: number;
  chunks: number;
  status: DocumentStatus;
  error: string | null;
  ingestadoEn: number;
  /** De dónde salió: subida manual o sincronización con Notion. null en los
   *  registros anteriores a que existiera el campo. */
  origen: 'subida' | 'notion' | null;
}

/** Señal para enfocar una fuente concreta en el panel derecho (clic en una cita). */
export interface SourceFocus {
  file: string;
  page: number | null;
  /** Cambia en cada clic para re-disparar el efecto aunque sea la misma fuente. */
  token: number;
}
