// Tipos compartidos del frontend, alineados con el contrato de SPEC.md.

export interface Health {
  status: string;
  qdrant: boolean;
  collection_points: number;
  /**
   * Límite de subida en MB (4 en producción serverless, 25 en local).
   * Opcional: backends antiguos no lo envían y el cliente asume 25.
   */
  upload_limit_mb?: number;
}

/** Roles de negocio (profiles.role). `vendedor` solo consulta. */
export type UserRole = 'admin' | 'vendedor';

/** Identidad del usuario del token, tal como la devuelve GET /api/me. */
export interface Me {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * Cuenta de usuario tal como la devuelve GET /api/users (solo admin).
 * `created_at` es la fecha de alta; el backend las entrega ya ordenadas.
 *
 * Los contadores son SOLO números: las conversaciones son privadas y el panel
 * de ajustes nunca muestra su contenido, ni siquiera a un administrador.
 */
export interface UserAccount {
  id: string;
  email: string;
  role: UserRole;
  /**
   * Acceso revocado por un administrador. La cuenta y sus conversaciones se
   * conservan: es reversible (PATCH con `blocked: false`), al revés que el
   * borrado. Un backend antiguo no manda el campo y se asume false.
   */
  blocked: boolean;
  created_at: string;
  /** Último acceso; null si la cuenta nunca ha entrado. */
  last_sign_in_at: string | null;
  sessions_count: number;
  messages_count: number;
}

/** Estado del sistema para el panel de ajustes (GET /api/stats, solo admin). */
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
    max_hops: number;
    upload_limit_mb: number;
  };
}

export interface SessionInfo {
  id: string;
  title: string | null;
  created_at: string;
}

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
  /** Localizador ya resuelto por el backend: "pag. 12", "seccion: Metodos". */
  locator?: string;
}

export interface Hop {
  n: number;
  query: string;
}

/** Mensaje tal como lo devuelve GET /api/sessions/{id}/messages */
export interface ServerMessage {
  id: string;
  role: string;
  content: string;
  sources: unknown;
  created_at: string;
}

/** Mensaje en el estado local del chat (incluye estado de streaming y feedback). */
export interface ChatMessage {
  /** Clave estable local (los mensajes en streaming aún no tienen id de servidor). */
  localId: string;
  /** id de servidor (llega en el evento `done` o al cargar la sesión). */
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  hops: Hop[];
  streaming: boolean;
  error: string | null;
  feedback: 1 | -1 | null;
}

/** Estado de ingesta de un documento (GET /api/documents). */
export type DocumentStatus = 'processing' | 'ready' | 'failed';

/** Documento indexado tal como lo devuelve GET /api/documents. */
export interface DocumentInfo {
  id: string;
  file_name: string;
  pages: number;
  chunks: number;
  status: DocumentStatus;
  error: string | null;
  ingested_at: string;
}

/** Respuesta 202 de POST /api/documents/upload. */
export interface UploadAccepted {
  id: string;
  file_name: string;
  status: DocumentStatus;
}

/** Señal para enfocar una fuente concreta en el panel derecho (clic en una cita). */
export interface SourceFocus {
  file: string;
  page: number | null;
  /** Cambia en cada clic para re-disparar el efecto aunque sea la misma fuente. */
  token: number;
}
