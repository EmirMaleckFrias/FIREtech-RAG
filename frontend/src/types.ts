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

export interface SessionInfo {
  id: string;
  title: string | null;
  created_at: string;
}

export interface Source {
  source_file: string;
  page: number | null;
  brand: string | null;
  snippet: string;
  score: number | null;
  /* --- campos enriquecidos del backend (2026-08) ---
     Mensajes ANTIGUOS persistidos en Supabase no los traen: son opcionales
     y normalizeSources (api.ts) les da defaults ([] / ""), de modo que la
     UI degrada con gracia al formato clásico archivo · pág · marca. */
  /** SKUs presentes en el chunk (hasta 8). */
  skus?: string[];
  /** Nombres de producto (hasta 2). */
  product_names?: string[];
  /** Categoría del producto o familia ("" si se desconoce). */
  category?: string;
  /** "product" | "family_summary" | "doc_text" | "doc_row" | "page" | "". */
  chunk_type?: string;
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
  brand: string;
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
