// Cliente HTTP del backend (contrato en SPEC.md, sección "API Backend").
// En dev, Vite proxya /api -> http://localhost:8000 (ver vite.config.ts).

import { SSEParser } from './lib/sse';
import { getAccessToken } from './lib/session';
import type {
  AdminStats,
  DocumentInfo,
  DocumentStatus,
  Health,
  Hop,
  Me,
  ModoPensamiento,
  ServerMessage,
  SessionInfo,
  Source,
  UploadAccepted,
  UserAccount,
  UserRole,
  Veredicto,
  Verificacion,
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

/* ----------------------------------------------------------------------
   Cuenta bloqueada (SPEC.md, "Gestión de usuarios": efecto del bloqueo).

   Un administrador puede revocar el acceso de una cuenta. A partir de ese
   momento CUALQUIER petición suya responde
   `403 {"detail": "Tu acceso ha sido revocado", "code": "blocked"}`, aunque su
   token siga siendo válido. Ese `code` es la única señal fiable: un 403 a
   secas significa "no tienes permiso para esto" y no debe expulsar a nadie.

   Por eso el cuerpo de todo error se lee por un único sitio (parseErrorBody /
   failure) y ahí se dispara el aviso. El bloqueo es la ÚNICA excepción que
   cierra la sesión sin preguntar: el 401 ya no expulsa salvo que la sesión
   esté muerta de verdad.
   ---------------------------------------------------------------------- */

type AccessRevokedListener = (detail: string) => void;
const accessRevokedListeners = new Set<AccessRevokedListener>();

/** Suscribe un callback al 403 de cuenta bloqueada. Devuelve el des-suscriptor. */
export function onAccessRevoked(listener: AccessRevokedListener): () => void {
  accessRevokedListeners.add(listener);
  return () => {
    accessRevokedListeners.delete(listener);
  };
}

const REVOKED_MSG = 'Tu acceso ha sido revocado';

function accessRevoked(detail: string | null): void {
  const message = detail !== null && detail !== '' ? detail : REVOKED_MSG;
  for (const listener of accessRevokedListeners) listener(message);
}

/** Cuerpo de error ya leído: `detail` legible y si es el 403 de bloqueo. */
interface ErrorBody {
  detail: string | null;
  blocked: boolean;
}

/**
 * Interpreta el cuerpo de un error del backend SIN efectos secundarios.
 * `blocked` solo es true con el 403 del contrato (`code: "blocked"`): ni un
 * 403 por rol ni un cuerpo ilegible pueden cerrar la sesión de nadie.
 */
function parseErrorBody(status: number, body: string): ErrorBody {
  const parsed = safeJson(body);
  const obj =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const detail = typeof obj.detail === 'string' && obj.detail !== '' ? obj.detail : null;
  return { detail, blocked: status === 403 && obj.code === 'blocked' };
}

/**
 * Lee (una sola vez) el cuerpo de una respuesta fallida y, si es el 403 de
 * cuenta bloqueada, avisa a los suscriptores. Todo camino de error de este
 * módulo pasa por aquí: así el bloqueo se detecta llame quien llame.
 */
async function failure(res: Response): Promise<ErrorBody> {
  return failureFrom(res.status, await res.text().catch(() => ''));
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: await authHeaders() });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) {
    const { detail } = await failure(res);
    throw new Error(detail ?? `HTTP ${res.status} en ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * GET /api/health. Endpoint público: se sondea cada 15 s y NO participa del
 * ciclo de 401, para que un backend a medio desplegar marque "sin conexión"
 * en vez de expulsar al usuario a la pantalla de acceso.
 */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health', { headers: await authHeaders() });
  if (!res.ok) {
    // Sigue sin participar del ciclo de 401, pero sí mira si el fallo es el
    // 403 de cuenta bloqueada: al sondearse cada 15 s, es lo que expulsa a un
    // usuario recién bloqueado aunque esté sin tocar nada.
    const { detail } = await failure(res);
    throw new Error(detail ?? `HTTP ${res.status} en /api/health`);
  }
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
  if (!res.ok) {
    const { detail } = await failure(res);
    throw new Error(detail ?? `HTTP ${res.status} al enviar feedback`);
  }
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
      status,
      error: typeof d.error === 'string' && d.error !== '' ? d.error : null,
      ingested_at: typeof d.ingested_at === 'string' ? d.ingested_at : '',
    });
  }
  return out;
}

/**
 * Versión síncrona de failure() para cuerpos ya leídos (el XHR de subida, que
 * no tiene Response). Mismo efecto: detecta el 403 de cuenta bloqueada.
 */
function failureFrom(status: number, body: string): ErrorBody {
  const parsed = parseErrorBody(status, body);
  if (parsed.blocked) accessRevoked(parsed.detail);
  return parsed;
}

/** GET /api/documents: lista de documentos indexados. */
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
    const { detail } = await failure(res);
    throw new Error(detail ?? `Error HTTP ${res.status} al listar los documentos.`);
  }
  const data = (await res.json()) as { documents?: unknown };
  return normalizeDocuments(data.documents);
}

function uploadErrorMessage(status: number, body: string): string {
  const { detail } = failureFrom(status, body);
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

/** DELETE /api/documents/{file_name}: borra el documento y sus fragmentos. */
/** El archivo ya no está en el servidor: la única salida es volver a subirlo. */
export class FileNotStoredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotStoredError';
  }
}

/**
 * Reintenta la indexación de un documento que falló, usando el archivo que
 * quedó en el servidor.
 *
 * Lanza `FileNotStoredError` cuando ese archivo ya no está —en Vercel los
 * uploads van a /tmp, que es efímero—, para que quien llama pueda ofrecer la
 * resubida en vez de mostrar un error sin salida.
 */
export async function reindexDocument(fileName: string): Promise<DocumentStatus> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(fileName)}/reindex`, {
      method: 'POST',
      headers: await authHeaders(),
    });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return body.status === 'ready' || body.status === 'failed' ? body.status : 'processing';
  }
  if (res.status === 401) throw unauthorized();
  const { detail } = await failure(res);
  // La cabecera distingue "no tengo el archivo" de "ya se está procesando":
  // los dos son 409 y llevan a acciones opuestas en la interfaz.
  if (res.status === 409 && res.headers.get('X-Reindex-Code') === 'file_not_stored') {
    throw new FileNotStoredError(
      detail ?? 'El archivo ya no está en el servidor: vuelve a subirlo.',
    );
  }
  if (res.status === 404) {
    throw new Error(detail ?? 'El documento ya no existe en el índice.');
  }
  throw new Error(detail ?? `Error HTTP ${res.status} al reindexar.`);
}

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
  const { detail } = await failure(res);
  if (res.status === 403) {
    throw new Error(detail ?? 'No se pudo borrar este documento.');
  }
  if (res.status === 404) {
    throw new Error(detail ?? 'El documento ya no existe en el índice.');
  }
  throw new Error(detail ?? `Error HTTP ${res.status} al borrar el documento.`);
}

/* ----------------------------------------------------------------------
   Ajustes: gestión de usuarios y estado del sistema (SPEC.md, "Gestión de
   usuarios (solo admin)").

   Mismo trato que los documentos: red caída, endpoint aún no desplegado y
   403 por rol se traducen a mensajes legibles en español. El `detail` del
   backend manda siempre que venga (p. ej. "No puedes cambiar tu propio
   rol"); los textos de aquí son solo el respaldo.
   ---------------------------------------------------------------------- */

const USERS_UNAVAILABLE_MSG = 'La gestión de usuarios aún no está disponible en el backend.';
const USERS_FORBIDDEN_MSG = 'Solo un administrador puede gestionar los usuarios.';
const STATS_UNAVAILABLE_MSG = 'El estado del sistema aún no está disponible en el backend.';

/** Rol desconocido o ausente degrada al de menos permisos (igual que /api/me). */
function normalizeRole(raw: unknown): UserRole {
  return raw === 'admin' ? 'admin' : 'vendedor';
}

/** Entero no negativo, o 0 si el backend manda algo raro (contadores). */
function asCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function normalizeUsers(raw: unknown): UserAccount[] {
  if (!Array.isArray(raw)) return [];
  const out: UserAccount[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const u = item as Record<string, unknown>;
    const id = typeof u.id === 'string' ? u.id : String(u.id ?? '');
    if (id === '') continue; // sin id no hay fila que actualizar
    out.push({
      id,
      email: typeof u.email === 'string' ? u.email : 'desconocido',
      role: normalizeRole(u.role),
      // Solo un true explícito bloquea: un backend sin el campo (o con algo
      // raro) deja la cuenta activa, nunca atenuada por error.
      blocked: u.blocked === true,
      created_at: typeof u.created_at === 'string' ? u.created_at : '',
      last_sign_in_at:
        typeof u.last_sign_in_at === 'string' && u.last_sign_in_at !== ''
          ? u.last_sign_in_at
          : null,
      sessions_count: asCount(u.sessions_count),
      messages_count: asCount(u.messages_count),
    });
  }
  return out;
}

/** GET /api/users: cuentas ordenadas por fecha de alta. 403 para lector. */
export async function fetchUsers(): Promise<UserAccount[]> {
  let res: Response;
  try {
    res = await fetch('/api/users', { headers: await authHeaders() });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.status === 401) throw unauthorized();
  if (res.status === 404 || res.status === 501) throw new Error(USERS_UNAVAILABLE_MSG);
  if (!res.ok) {
    const { detail } = await failure(res);
    if (res.status === 403) throw new Error(detail ?? USERS_FORBIDDEN_MSG);
    throw new Error(detail ?? `Error HTTP ${res.status} al listar los usuarios.`);
  }
  const data = (await res.json()) as { users?: unknown };
  return normalizeUsers(data.users);
}

/** Cambios admitidos por PATCH /api/users/{user_id}: rol, bloqueo o ambos. */
interface UserPatch {
  role?: UserRole;
  blocked?: boolean;
}

/**
 * Fila devuelta por el PATCH: solo identidad, rol y bloqueo (ni fechas ni
 * contadores). `blocked` es null cuando el backend no manda el campo, para
 * que quien llama conserve el valor que ya tenía en vez de inventarse un
 * false.
 */
export interface UpdatedUser {
  id: string;
  email: string;
  role: UserRole;
  blocked: boolean | null;
}

/**
 * PATCH /api/users/{user_id}. Un solo camino para los dos cambios posibles
 * (rol y bloqueo): mismo endpoint, mismos códigos de error y el mismo trato
 * del `detail`, que es el que explica al usuario por qué le dijeron que no.
 *
 * Guardas del backend (SPEC.md): 403 si el administrador intenta degradarse,
 * bloquearse o borrarse a sí mismo; 404 si la cuenta ya no existe.
 */
async function patchUser(userId: string, patch: UserPatch): Promise<UpdatedUser> {
  const changingRole = patch.role !== undefined;
  let res: Response;
  try {
    res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...(await authHeaders()) },
      body: JSON.stringify(patch),
    });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.status === 401) throw unauthorized();
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    // 404 es ambiguo aquí: puede ser "endpoint inexistente" o "usuario
    // borrado". El `detail` del backend distingue; sin él se asume lo
    // segundo solo si el endpoint respondió algo.
    const { detail } = await failure(res);
    throw new Error(detail ?? USERS_UNAVAILABLE_MSG);
  }
  if (!res.ok) {
    const { detail } = await failure(res);
    if (res.status === 400) {
      throw new Error(detail ?? (changingRole ? 'El rol indicado no es válido.' : 'Cambio no válido.'));
    }
    if (res.status === 403) throw new Error(detail ?? USERS_FORBIDDEN_MSG);
    throw new Error(
      detail ??
        `Error HTTP ${res.status} al ${changingRole ? 'cambiar el rol' : 'cambiar el acceso'}.`,
    );
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    id: typeof data.id === 'string' ? data.id : userId,
    email: typeof data.email === 'string' ? data.email : '',
    role: normalizeRole(data.role),
    blocked: typeof data.blocked === 'boolean' ? data.blocked : null,
  };
}

/**
 * Promueve o degrada. El backend responde 403 "No puedes cambiar tu propio
 * rol" si el admin intenta degradarse (evita quedarse sin administradores).
 */
export function updateUserRole(userId: string, role: UserRole): Promise<UpdatedUser> {
  return patchUser(userId, { role });
}

/**
 * Revoca o devuelve el acceso de una cuenta. NO borra nada: la cuenta y sus
 * conversaciones se conservan y la operación es reversible con `false`.
 * Mientras esté bloqueada, toda petición suya recibe el 403 con
 * `code: "blocked"` y su sesión se cierra sola.
 */
export function setUserBlocked(userId: string, blocked: boolean): Promise<UpdatedUser> {
  return patchUser(userId, { blocked });
}

/**
 * DELETE /api/users/{user_id}: borra la cuenta y sus conversaciones de forma
 * PERMANENTE (los documentos que hubiera subido se conservan sin autor). No
 * tiene vuelta atrás, al revés que el bloqueo. 403 si el administrador
 * intenta borrarse a sí mismo.
 */
export async function deleteUser(userId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.ok) return;
  if (res.status === 401) throw unauthorized();
  if (res.status === 405 || res.status === 501) throw new Error(USERS_UNAVAILABLE_MSG);
  const { detail } = await failure(res);
  if (res.status === 403) throw new Error(detail ?? USERS_FORBIDDEN_MSG);
  if (res.status === 404) throw new Error(detail ?? 'Esa cuenta ya no existe.');
  throw new Error(detail ?? `Error HTTP ${res.status} al eliminar la cuenta.`);
}

/** Lista de valores de un campo del índice: strings no vacíos, sin duplicados. */
function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = v.trim();
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

/**
 * GET /api/stats: cifras de índice, actividad y configuración para la pestaña
 * "Sistema" de Ajustes. Solo admin (403 para el resto). Es de solo lectura y
 * NUNCA trae contenido de conversaciones, solo agregados.
 *
 * Cada bloque se normaliza campo a campo: un backend a medio desplegar deja
 * ceros y cadenas vacías en vez de romper el panel.
 */
export async function fetchStats(): Promise<AdminStats> {
  let res: Response;
  try {
    res = await fetch('/api/stats', { headers: await authHeaders() });
  } catch {
    throw new Error(OFFLINE_MSG);
  }
  if (res.status === 401) throw unauthorized();
  if (res.status === 404 || res.status === 501) throw new Error(STATS_UNAVAILABLE_MSG);
  if (!res.ok) {
    const { detail } = await failure(res);
    if (res.status === 403) throw new Error(detail ?? USERS_FORBIDDEN_MSG);
    throw new Error(detail ?? `Error HTTP ${res.status} al leer el estado del sistema.`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const section = (key: string): Record<string, unknown> => {
    const value = data[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  };
  const index = section('index');
  const activity = section('activity');
  const config = section('config');
  const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

  return {
    index: {
      chunks: asCount(index.chunks),
      files: asCount(index.files),
      types: normalizeStringList(index.types),
      languages: normalizeStringList(index.languages),
    },
    activity: {
      questions_total: asCount(activity.questions_total),
      questions_7d: asCount(activity.questions_7d),
      active_users_7d: asCount(activity.active_users_7d),
      feedback_up: asCount(activity.feedback_up),
      feedback_down: asCount(activity.feedback_down),
    },
    config: {
      model: text(config.model),
      embedding_model: text(config.embedding_model),
      max_hops: asCount(config.max_hops),
      upload_limit_mb: asCount(config.upload_limit_mb),
    },
  };
}

/** Array de strings no vacíos, recortado a `max` (campos enriquecidos). */

/**
 * Normaliza el campo `sources` (jsonb: puede venir null o con campos
 * faltantes). Los campos documentales y enriquecidos no existen en mensajes
 * antiguos: reciben valores neutros.
 */
const VEREDICTOS: readonly Veredicto[] = [
  'sostenida',
  'parcial',
  'no_sostenida',
  'cita_no_resuelve',
  'sin_verificar',
];

/** Valida el informe del verificador que llega por SSE.
 *
 * Un veredicto que no esté en el contrato cae a `sin_verificar`, nunca a
 * `sostenida`: si el backend cambiara y el frontend no, el fallo tiene que ser
 * visible como "sin comprobar" y no como un visto bueno inventado. */
export function normalizeVerificacion(raw: unknown): Verificacion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const crudas = Array.isArray(o.afirmaciones) ? o.afirmaciones : [];
  const afirmaciones = crudas.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const a = item as Record<string, unknown>;
    const v = a.veredicto;
    return [
      {
        texto: typeof a.texto === 'string' ? a.texto : '',
        cita: typeof a.cita === 'string' ? a.cita : '',
        veredicto: VEREDICTOS.includes(v as Veredicto)
          ? (v as Veredicto)
          : ('sin_verificar' as Veredicto),
        motivo: typeof a.motivo === 'string' ? a.motivo : '',
        fragmento_id: typeof a.fragmento_id === 'string' ? a.fragmento_id : '',
      },
    ];
  });
  const textos = (valor: unknown): string[] =>
    Array.isArray(valor) ? valor.filter((x): x is string => typeof x === 'string') : [];
  return {
    afirmaciones,
    evidencia_sin_cubrir: textos(o.evidencia_sin_cubrir),
    citas_sin_resolver: textos(o.citas_sin_resolver),
    fidelidad: typeof o.fidelidad === 'number' ? o.fidelidad : null,
    ok: o.ok !== false,
    nota: typeof o.nota === 'string' ? o.nota : '',
  };
}

export function normalizeSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  const out: Source[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    out.push({
      source_file: typeof s.source_file === 'string' ? s.source_file : 'desconocido',
      page: typeof s.page === 'number' ? s.page : null,
      snippet: typeof s.snippet === 'string' ? s.snippet : '',
      score: typeof s.score === 'number' ? s.score : null,
      project_id: typeof s.project_id === 'string' ? s.project_id : null,
      document_id: typeof s.document_id === 'string' ? s.document_id : null,
      section: typeof s.section === 'string' ? s.section.trim() : '',
      language: typeof s.language === 'string' ? s.language.trim() : '',
      document_type: typeof s.document_type === 'string' ? s.document_type.trim() : '',
      source_pages: normalizeNumberArray(s.source_pages),
      chunk_type: typeof s.chunk_type === 'string' ? s.chunk_type : '',
      title: typeof s.title === 'string' ? s.title.trim() : '',
      citation: typeof s.citation === 'string' ? s.citation.trim() : '',
      doi: typeof s.doi === 'string' ? s.doi.trim() : '',
      locator: typeof s.locator === 'string' ? s.locator.trim() : '',
    });
  }
  return out;
}

function normalizeNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
}

export interface ChatStreamHandlers {
  onSession: (sessionId: string) => void;
  onHop: (hop: Hop) => void;
  onSources: (sources: Source[]) => void;
  onVerificacion: (informe: Verificacion) => void;
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
  modo: ModoPensamiento = 'normal',
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      Accept: 'text/event-stream',
      ...(await authHeaders()),
    },
    body: JSON.stringify({ session_id: sessionId, message, modo }),
    signal,
  });

  if (res.status === 401) throw unauthorized();
  if (!res.ok) {
    // failure() también atrapa aquí el 403 de cuenta bloqueada: si revocan el
    // acceso a mitad de conversación, el siguiente envío cierra la sesión.
    const { detail } = await failure(res);
    throw new Error(detail ?? `Error HTTP ${res.status} del backend`);
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
      case 'verificacion': {
        const informe = normalizeVerificacion(parsed);
        if (informe) handlers.onVerificacion(informe);
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
