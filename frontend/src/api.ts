// Cliente HTTP del backend (contrato en SPEC.md, sección "API Backend").
// En dev, Vite proxya /api -> http://localhost:8000 (ver vite.config.ts).

import { SSEParser } from './lib/sse';
import { getAccessToken } from './lib/session';
import type {
  DocumentInfo,
  DocumentStatus,
  Health,
  Hop,
  Me,
  ServerMessage,
  SessionInfo,
  Source,
  UploadAccepted,
} from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/* ----------------------------------------------------------------------
   Autenticación (SPEC.md, "Autenticación multiusuario").

   TODAS las llamadas a /api/* (fetch, el XHR de subida y el stream del chat)
   viajan con `Authorization: Bearer <access_token de Supabase>`. El token se
   pide justo antes de cada petición: getAccessToken() lo renueva solo si le
   queda poco de vida, así que un stream largo nunca sale con un token a punto
   de caducar. GET /api/health es público y funciona igual sin token.

   Si el backend responde 401 se notifica a los suscriptores (App vuelve a la
   pantalla de acceso).
   ---------------------------------------------------------------------- */

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token !== null ? { Authorization: `Bearer ${token}` } : {};
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Suscribe un callback a los 401 del backend. Devuelve el des-suscriptor. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

const UNAUTHORIZED_MSG = 'Sesión no válida o expirada.';

/** Notifica el 401 a los suscriptores y devuelve el Error a lanzar. */
function unauthorized(): Error {
  for (const listener of unauthorizedListeners) listener();
  return new Error(UNAUTHORIZED_MSG);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: await authHeaders() });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return (await res.json()) as T;
}

/**
 * GET /api/health. Endpoint público: se sondea cada 15 s y NO participa del
 * ciclo de 401, para que un backend a medio desplegar marque "sin conexión"
 * en vez de expulsar al usuario a la pantalla de acceso.
 */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} en /api/health`);
  return (await res.json()) as Health;
}

/** GET /api/me: identidad y rol del usuario del token. */
export async function fetchMe(): Promise<Me> {
  const data = await getJson<Record<string, unknown>>('/api/me');
  return {
    id: typeof data.id === 'string' ? data.id : '',
    email: typeof data.email === 'string' ? data.email : '',
    // Cualquier valor inesperado degrada al rol con menos permisos.
    role: data.role === 'admin' ? 'admin' : 'vendedor',
  };
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const data = await getJson<{ sessions?: SessionInfo[] }>('/api/sessions');
  return data.sessions ?? [];
}

export async function fetchSessionMessages(sessionId: string): Promise<ServerMessage[]> {
  const data = await getJson<{ messages?: ServerMessage[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return data.messages ?? [];
}

export async function sendFeedback(messageId: string, rating: 1 | -1): Promise<void> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(await authHeaders()) },
    body: JSON.stringify({ message_id: messageId, rating, comment: null }),
  });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status} al enviar feedback`);
}

/* ----------------------------------------------------------------------
   Gestión de documentos (SPEC.md, "Gestión de documentos"). El backend se
   implementa en paralelo: los errores de red y los 404 (endpoint aún no
   disponible) se traducen a mensajes legibles en español, nunca a crashes.
   ---------------------------------------------------------------------- */

// El límite de subida es dinámico: GET /api/health lo anuncia en
// upload_limit_mb (4 en serverless, 25 en local) y DocumentsPanel lo valida
// en cliente con fallback de 25 MB si el campo no viene.

/** Extensiones aceptadas por POST /api/documents/upload. */
export const UPLOAD_EXTENSIONS = ['.pdf', '.xlsx', '.csv', '.txt', '.md'] as const;

const OFFLINE_MSG = 'No se pudo conectar con el backend. ¿Está en marcha?';
const UNAVAILABLE_MSG = 'La gestión de documentos aún no está disponible en el backend.';

function normalizeDocuments(raw: unknown): DocumentInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentInfo[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    const status: DocumentStatus =
      d.status === 'processing' || d.status === 'failed' ? d.status : 'ready';
    out.push({
      id: typeof d.id === 'string' ? d.id : String(d.id ?? ''),
      file_name: typeof d.file_name === 'string' ? d.file_name : 'desconocido',
      pages: typeof d.pages === 'number' ? d.pages : 0,
      chunks: typeof d.chunks === 'number' ? d.chunks : 0,
      brand: typeof d.brand === 'string' ? d.brand : '',
      status,
      error: typeof d.error === 'string' && d.error !== '' ? d.error : null,
      ingested_at: typeof d.ingested_at === 'string' ? d.ingested_at : '',
    });
  }
  return out;
}

/** Extrae `detail` de un cuerpo de error FastAPI (o null si no es legible). */
function extractDetail(body: string): string | null {
  const parsed = safeJson(body);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const detail = (parsed as Record<string, unknown>).detail;
  return typeof detail === 'string' && detail !== '' ? detail : null;
}

/** GET /api/documents: lista de documentos indexados (incluye los 6 catálogos base). */
export async function fetchDocuments(): Promise<DocumentInfo[]> {
  let res: Response;
  try {
    res = await fetch('/api/documents', { headers: await authHeaders() });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.status === 401) throw unauthorized();
  if (res.status === 404 || res.status === 501) throw new Error(UNAVAILABLE_MSG);
  if (!res.ok) {
    throw new Error(
      extractDetail(await res.text().catch(() => '')) ??
        `Error HTTP ${res.status} al listar los documentos.`,
    );
  }
  const data = (await res.json()) as { documents?: unknown };
  return normalizeDocuments(data.documents);
}

function uploadErrorMessage(status: number, body: string): string {
  const detail = extractDetail(body);
  switch (status) {
    case 400:
      return detail ?? 'El backend rechazó el archivo (formato o contenido no válido).';
    case 409:
      return (
        detail ?? 'Ya existe un documento con ese nombre. Bórralo antes de volver a subirlo.'
      );
    case 404:
    case 405:
    case 501:
      return UNAVAILABLE_MSG;
    case 413:
      return detail ?? 'El archivo supera el tamaño máximo que acepta el servidor.';
    default:
      return detail ?? `Error HTTP ${status} al subir el archivo.`;
  }
}

/**
 * POST /api/documents/upload (multipart, campo `file`).
 *
 * Usa XMLHttpRequest en lugar de fetch: es la única vía en navegador para
 * obtener progreso REAL de subida (fetch no expone upload.onprogress sin
 * streams duplex, aún no soportados de forma fiable). `onProgress` recibe la
 * fracción 0..1, o null si el navegador no puede computarla (la UI muestra
 * entonces un estado indeterminado con shimmer).
 *
 * 400/409 se rechazan con Error cuyo mensaje es el `detail` del backend (o
 * un texto legible en español si no vino). Cancelable vía AbortSignal.
 *
 * El token se resuelve ANTES de abrir el XHR: setRequestHeader solo es válido
 * entre open() y send(), y una subida puede durar minutos, así que se manda el
 * más reciente posible.
 */
export async function uploadDocument(
  file: File,
  onProgress?: (fraction: number | null) => void,
  signal?: AbortSignal,
): Promise<UploadAccepted> {
  const headers = await authHeaders();

  return new Promise<UploadAccepted>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Subida cancelada', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.open('POST', '/api/documents/upload');
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (ev) => {
      onProgress?.(ev.lengthComputable && ev.total > 0 ? ev.loaded / ev.total : null);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = safeJson(xhr.responseText);
        const p =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
        resolve({
          id: typeof p.id === 'string' ? p.id : '',
          file_name: typeof p.file_name === 'string' ? p.file_name : file.name,
          status: p.status === 'ready' || p.status === 'failed' ? p.status : 'processing',
        });
      } else if (xhr.status === 401) {
        reject(unauthorized());
      } else {
        reject(new Error(uploadErrorMessage(xhr.status, xhr.responseText)));
      }
    };
    xhr.onerror = () => reject(new Error(OFFLINE_MSG));
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'));

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** DELETE /api/documents/{file_name}: los 6 catálogos base devuelven 403. */
export async function deleteDocument(fileName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.ok) return;
  if (res.status === 401) throw unauthorized();
  const detail = extractDetail(await res.text().catch(() => ''));
  if (res.status === 403) {
    throw new Error(detail ?? 'Este catálogo base no se puede borrar.');
  }
  if (res.status === 404) {
    throw new Error(detail ?? 'El documento ya no existe en el índice.');
  }
  throw new Error(detail ?? `Error HTTP ${res.status} al borrar el documento.`);
}

/** Array de strings no vacíos, recortado a `max` (campos enriquecidos). */
function normalizeStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim() !== '') out.push(v.trim());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Normaliza el campo `sources` (jsonb: puede venir null o con campos
 * faltantes). Los campos enriquecidos (skus, product_names, category,
 * chunk_type) no existen en mensajes antiguos: defaults [] / "".
 */
export function normalizeSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  const out: Source[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    out.push({
      source_file: typeof s.source_file === 'string' ? s.source_file : 'desconocido',
      page: typeof s.page === 'number' ? s.page : null,
      brand: typeof s.brand === 'string' && s.brand ? s.brand : null,
      snippet: typeof s.snippet === 'string' ? s.snippet : '',
      score: typeof s.score === 'number' ? s.score : null,
      skus: normalizeStringArray(s.skus, 8),
      product_names: normalizeStringArray(s.product_names, 2),
      category: typeof s.category === 'string' ? s.category.trim() : '',
      chunk_type: typeof s.chunk_type === 'string' ? s.chunk_type : '',
    });
  }
  return out;
}

export interface ChatStreamHandlers {
  onSession: (sessionId: string) => void;
  onHop: (hop: Hop) => void;
  onSources: (sources: Source[]) => void;
  onToken: (text: string) => void;
  onDone: (messageId: string) => void;
  onError: (detail: string) => void;
}

/**
 * POST /api/chat con streaming SSE leído vía fetch + ReadableStream
 * (EventSource no soporta POST). Despacha los eventos del contrato:
 * session, hop, sources, token, done, error.
 */
export async function streamChat(
  sessionId: string | null,
  message: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      Accept: 'text/event-stream',
      ...(await authHeaders()),
    },
    body: JSON.stringify({ session_id: sessionId, message }),
    signal,
  });

  if (res.status === 401) throw unauthorized();
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // cuerpo no-JSON: se ignora
    }
    throw new Error(detail || `Error HTTP ${res.status} del backend`);
  }
  if (!res.body) {
    throw new Error('Este navegador no soporta lectura en streaming de la respuesta');
  }

  const parser = new SSEParser();
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();

  const dispatch = (eventName: string, data: string): void => {
    const parsed = safeJson(data);
    switch (eventName) {
      case 'session': {
        const id = asString(parsed, 'session_id');
        if (id) handlers.onSession(id);
        break;
      }
      case 'hop': {
        if (typeof parsed !== 'object' || parsed === null) break;
        const h = parsed as Record<string, unknown>;
        handlers.onHop({
          n: typeof h.n === 'number' ? h.n : 0,
          query: typeof h.query === 'string' ? h.query : '',
        });
        break;
      }
      case 'sources': {
        if (typeof parsed !== 'object' || parsed === null) break;
        const raw = (parsed as Record<string, unknown>).sources;
        handlers.onSources(normalizeSources(raw));
        break;
      }
      case 'token': {
        const text = asString(parsed, 'text');
        if (text !== null) handlers.onToken(text);
        break;
      }
      case 'done': {
        const id = asString(parsed, 'message_id');
        handlers.onDone(id ?? '');
        break;
      }
      case 'error': {
        const detail = asString(parsed, 'detail');
        handlers.onError(detail ?? 'Error desconocido del servidor');
        break;
      }
      default:
        // Evento no contemplado en el contrato: se ignora.
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }), (ev) => dispatch(ev.event, ev.data));
    }
    const tail = decoder.decode();
    if (tail) parser.feed(tail, (ev) => dispatch(ev.event, ev.data));
    parser.flush((ev) => dispatch(ev.event, ev.data));
  } finally {
    reader.releaseLock();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asString(parsed: unknown, key: string): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
