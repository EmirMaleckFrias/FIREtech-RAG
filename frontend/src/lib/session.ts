// Sesión de usuario: token vigente, suscripción a los cambios de auth y
// acciones de alta/entrada/salida con los mensajes ya traducidos al español.
//
// Estrategia de token (SPEC.md, "Autenticación multiusuario"):
//   - supabase-js guarda la sesión en localStorage y renueva el access_token
//     solo (autoRefreshToken). Aquí se mantiene una copia en memoria que
//     onAuthStateChange actualiza en cada login, logout y TOKEN_REFRESHED.
//   - getAccessToken() se llama JUSTO ANTES de cada petición a /api/*: si al
//     token le quedan menos de REFRESH_MARGIN_S segundos, fuerza la renovación
//     antes de devolverlo, de modo que el backend nunca recibe un token que
//     caduque a mitad de un stream largo.
//   - Las renovaciones concurrentes comparten una única promesa en vuelo.

import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Único dominio de correo permitido (lo impone también un trigger de Postgres). */
export const ALLOWED_DOMAIN = 'airobotix.net';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Margen de seguridad: por debajo de esto se renueva antes de usar el token. */
const REFRESH_MARGIN_S = 60;

let cached: Session | null = null;
let initialLoad: Promise<Session | null> | null = null;
let refreshInFlight: Promise<Session | null> | null = null;

// Suscripción de por vida: mantiene `cached` al día aunque nadie escuche.
supabase.auth.onAuthStateChange((_event, session) => {
  cached = session;
});

/** ¿El correo pertenece al dominio permitido? Validación previa al alta. */
export function isAllowedEmail(email: string): boolean {
  const value = email.trim().toLowerCase();
  return EMAIL_RE.test(value) && value.endsWith(`@${ALLOWED_DOMAIN}`);
}

/** Sesión persistida en el navegador (una sola lectura, cacheada). */
export function loadSession(): Promise<Session | null> {
  if (initialLoad === null) {
    initialLoad = supabase.auth
      .getSession()
      .then(({ data }) => {
        cached = data.session;
        return data.session;
      })
      .catch(() => null);
  }
  return initialLoad;
}

/** Suscribe a login / logout / refresco de token. Devuelve el des-suscriptor. */
export function onSessionChange(listener: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cached = session;
    listener(session);
  });
  return () => data.subscription.unsubscribe();
}

function secondsLeft(session: Session): number {
  const expiresAt = session.expires_at ?? 0;
  return expiresAt - Math.floor(Date.now() / 1000);
}

/**
 * Fuerza la renovación del access_token. Varias llamadas simultáneas (el chat
 * en streaming mientras se sondea /api/documents, por ejemplo) comparten la
 * misma petición. Devuelve null si la sesión ya no es renovable.
 */
export function renewAccessToken(): Promise<string | null> {
  if (refreshInFlight === null) {
    refreshInFlight = supabase.auth
      .refreshSession()
      .then(({ data, error }) => {
        if (error !== null) return null;
        cached = data.session;
        return data.session;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight.then((session) => session?.access_token ?? null);
}

/** Token vigente para el header Authorization, o null si no hay sesión. */
export async function getAccessToken(): Promise<string | null> {
  const session = cached ?? (await loadSession());
  if (session === null) return null;
  if (secondsLeft(session) > REFRESH_MARGIN_S) return session.access_token;
  // A punto de caducar (o ya caducado): renovar antes de salir a la red.
  return (await renewAccessToken()) ?? null;
}

/* ----------------------------------------------------------------------
   Mensajes de error: Supabase responde siempre en inglés.
   ---------------------------------------------------------------------- */

const GENERIC_ERROR = 'No se pudo completar la operación. Vuelve a intentarlo.';
/** Mismo texto para el rechazo del trigger y para la validación en cliente. */
export const DOMAIN_ERROR = `Solo se permiten correos @${ALLOWED_DOMAIN}.`;
const ALREADY_REGISTERED = 'Ese correo ya tiene cuenta, entra con tu contraseña.';

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    const parts = [
      typeof e.message === 'string' ? e.message : '',
      typeof e.code === 'string' ? e.code : '',
    ];
    return parts.join(' ');
  }
  return '';
}

/** Traduce el error de Supabase al español del producto. */
export function authErrorMessage(err: unknown): string {
  const raw = errorText(err).toLowerCase();
  if (raw === '') return GENERIC_ERROR;

  // El trigger de dominio de Postgres: Supabase lo envuelve como
  // "Database error saving new user" (unexpected_failure), pero a veces deja
  // pasar el texto del raise. Ambos casos significan lo mismo.
  if (
    raw.includes('airobotix') ||
    raw.includes('database error saving new user') ||
    raw.includes('unexpected_failure')
  ) {
    return DOMAIN_ERROR;
  }
  if (raw.includes('invalid login credentials') || raw.includes('invalid_credentials')) {
    return 'Correo o contraseña incorrectos.';
  }
  if (raw.includes('already registered') || raw.includes('user_already_exists')) {
    return ALREADY_REGISTERED;
  }
  if (raw.includes('email not confirmed')) {
    return 'Aún no has confirmado tu correo. Revisa tu bandeja de entrada.';
  }
  const minLength = /password should be at least (\d+)/.exec(raw);
  if (minLength !== null) {
    return `La contraseña debe tener al menos ${minLength[1]} caracteres.`;
  }
  if (raw.includes('different from the old password') || raw.includes('same_password')) {
    return 'La contraseña nueva debe ser distinta de la actual.';
  }
  if (raw.includes('weak password') || raw.includes('weak_password')) {
    return 'La contraseña es demasiado débil. Usa una más larga y menos previsible.';
  }
  if (raw.includes('for security purposes') || raw.includes('rate limit')) {
    return 'Demasiados intentos seguidos. Espera un momento y vuelve a intentarlo.';
  }
  if (raw.includes('invalid email') || raw.includes('email_address_invalid')) {
    return 'Ese correo no tiene un formato válido.';
  }
  if (raw.includes('signups not allowed') || raw.includes('signup_disabled')) {
    return 'El alta de cuentas está deshabilitada. Pide acceso a un administrador.';
  }
  if (
    raw.includes('failed to fetch') ||
    raw.includes('networkerror') ||
    raw.includes('load failed')
  ) {
    return 'No se pudo conectar con el servicio de acceso. Revisa tu conexión.';
  }
  return GENERIC_ERROR;
}

/* ----------------------------------------------------------------------
   Acciones
   ---------------------------------------------------------------------- */

export type AuthResult =
  | { ok: true; needsConfirmation: boolean }
  | { ok: false; message: string };

/** Entrar con correo y contraseña. El dominio ya se validó en el formulario. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error !== null) return { ok: false, message: authErrorMessage(error) };
    return { ok: true, needsConfirmation: false };
  } catch (err) {
    return { ok: false, message: authErrorMessage(err) };
  }
}

/**
 * Crear cuenta. Si el proyecto tiene la confirmación de correo activa, la
 * respuesta trae usuario pero no sesión: `needsConfirmation` en true.
 */
export async function signUp(email: string, password: string): Promise<AuthResult> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error !== null) return { ok: false, message: authErrorMessage(error) };

    // Con confirmación activa, Supabase no delata si el correo ya existe:
    // devuelve un usuario "vacío" (sin identities). Para el usuario legítimo
    // el mensaje útil es que ya tiene cuenta.
    if (data.user !== null && (data.user.identities?.length ?? 0) === 0) {
      return { ok: false, message: ALREADY_REGISTERED };
    }
    return { ok: true, needsConfirmation: data.session === null };
  } catch (err) {
    return { ok: false, message: authErrorMessage(err) };
  }
}

/**
 * Cambia la contraseña del usuario en sesión. No hay endpoint de backend para
 * esto (SPEC.md no lo define): se llama a Supabase Auth desde el cliente con
 * el token vigente, igual que el alta y la entrada.
 */
export async function updatePassword(password: string): Promise<AuthResult> {
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error !== null) return { ok: false, message: authErrorMessage(error) };
    return { ok: true, needsConfirmation: false };
  } catch (err) {
    return { ok: false, message: authErrorMessage(err) };
  }
}

/** Cierra la sesión local (y la remota si se puede). Nunca lanza. */
export async function signOut(): Promise<void> {
  try {
    await supabase.auth.signOut();
  } catch {
    // Sin red: la sesión local ya quedó invalidada por supabase-js.
  }
  cached = null;
  // Se descarta la lectura cacheada: si alguien vuelve a entrar en esta misma
  // pestaña, loadSession() releerá el almacenamiento en vez de servir el null.
  initialLoad = null;
}
