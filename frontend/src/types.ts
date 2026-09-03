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

/** Roles de negocio (profiles.role).
 *
 * OJO con el desajuste, es deliberado y temporal: el identificador almacenado
 * sigue siendo `vendedor` porque la base solo acepta admin/vendedor hasta que
 * se aplique supabase/migrations/009_rol_lector.sql, y hoy nadie del equipo
 * tiene acceso al proyecto de Supabase para correrla. Lo que el usuario LEE ya
 * es "Lector" (ver ROLE_LABEL). No renombres el identificador a `lector` antes
 * de aplicar 009: el check constraint rechazaría la escritura y el boton de
 * degradar en Ajustes fallaria. */
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
/** Veredicto de una afirmación frente al fragmento que citó.
 *
 * `sin_verificar` es el estado por defecto del backend y NO significa
 * "correcta": significa que nadie la comprobó (modelo caído, JSON inválido o
 * respuesta por encima del tope). Pintarlo como aprobado sería exactamente el
 * fallo que el verificador existe para evitar. */
export type Veredicto =
  | 'sostenida'
  | 'parcial'
  | 'no_sostenida'
  | 'cita_no_resuelve'
  | 'sin_verificar';

export interface Afirmacion {
  texto: string;
  cita: string;
  veredicto: Veredicto;
  motivo: string;
  fragmento_id: string;
}

/** Informe de atribución de una respuesta (evento SSE `verificacion`). */
export interface Verificacion {
  afirmaciones: Afirmacion[];
  evidencia_sin_cubrir: string[];
  /** Citas que no corresponden a ningún fragmento recuperado. El fallo grave. */
  citas_sin_resolver: string[];
  /** Proporción de sostenidas sobre las juzgadas. null = no se juzgó ninguna. */
  fidelidad: number | null;
  ok: boolean;
  nota: string;
}

export interface ChatMessage {
  /** Clave estable local (los mensajes en streaming aún no tienen id de servidor). */
  localId: string;
  /** id de servidor (llega en el evento `done` o al cargar la sesión). */
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  hops: Hop[];
  /** Informe del verificador. null mientras no llega o si está desactivado. */
  verificacion: Verificacion | null;
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
