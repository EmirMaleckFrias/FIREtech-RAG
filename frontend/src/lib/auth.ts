// Sesión de usuario sobre Convex Auth (convex/auth.ts).
//
// Lo que cambia respecto a Supabase Auth, y por qué aquí hay tan poco código:
// - Los tokens los guarda y renueva ConvexAuthProvider; no hay copia en
//   memoria, ni margen de caducidad, ni renovaciones concurrentes que
//   compartir. Quién está dentro lo dice useConvexAuth().
// - Los errores llegan estructurados (ver lib/errores.ts): desaparecen las
//   traducciones por comparación de cadenas en inglés.
// - El dominio permitido se comprueba en cliente ANTES de enviar, igual que
//   antes, y el servidor lo vuelve a comprobar en `createOrUpdateUser`.

import { useCallback } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { esAccesoRevocado, esNoAutenticado, mensajeDeError } from './errores';

/** Único dominio de correo permitido (lo impone también convex/auth.ts). */
export const ALLOWED_DOMAIN = 'airobotix.net';

/** Mismo texto para la validación en cliente y para el aviso permanente. */
export const DOMAIN_ERROR = `Solo se permiten correos @${ALLOWED_DOMAIN}.`;

/** Mínimo del proveedor Password de Convex Auth (rechaza menos de 8). Se
 *  valida antes de salir a la red para dar el motivo exacto. */
export const MIN_PASSWORD = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** ¿El correo pertenece al dominio permitido?
 *
 *  Sufijo `@dominio`, no `includes`: sin la arroba, "airobotix.net.atacante.com"
 *  pasaría. Es la misma regla que `correoPermitido` en convex/auth.ts. */
export function isAllowedEmail(email: string): boolean {
  const value = email.trim().toLowerCase();
  return EMAIL_RE.test(value) && value.endsWith(`@${ALLOWED_DOMAIN}`);
}

export type AuthResult = { ok: true } | { ok: false; message: string };

// Textos de reserva. Dicen qué se intentaba y qué hacer, sin afirmar una
// causa que el cliente no conoce: Convex redacta a "Server Error" cualquier
// excepción que no sea un ConvexError.
//
// El de entrar menciona crear la cuenta a propósito: las cuentas de Supabase
// NO se migraron (las contraseñas no se pueden exportar), así que la primera
// vez en esta versión todo el mundo tiene que darse de alta, y el primer día
// de la migración el primer intento de entrar falló justo por eso, con un
// mensaje que no lo decía.
const SIGNIN_ERROR =
  'No se pudo entrar. Si es tu primera vez en esta versión, crea la cuenta ' +
  'con tu correo de la empresa; si ya la creaste, revisa la contraseña.';
const SIGNUP_ERROR = 'No se pudo crear la cuenta. Si ya tienes una, entra con tu contraseña.';
const GOOGLE_ERROR = 'No se pudo iniciar el acceso con Google. Vuelve a intentarlo.';

// Códigos de error del proveedor Password de Convex Auth. Son IDENTIFICADORES
// estables de la librería (`throw new Error("InvalidAccountId")`), no prosa,
// así que compararlos no es la traducción por cadenas que este módulo
// prohíbe. Solo llegan enteros al cliente en el despliegue de desarrollo: en
// producción Convex los redacta a "Server Error" y cae el texto de reserva.
const CODIGOS_PASSWORD: Record<string, string> = {
  InvalidAccountId: 'No existe una cuenta con ese correo. Crea la cuenta primero.',
  InvalidSecret: 'La contraseña no es correcta.',
  TooManyFailedAttempts: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a probar.',
};

function mensajeDeAuth(err: unknown, porDefecto: string): string {
  const codigo = err instanceof Error ? err.message.trim() : '';
  if (codigo in CODIGOS_PASSWORD) return CODIGOS_PASSWORD[codigo];
  return mensajeDeError(err, porDefecto);
}

/** Acciones de acceso con los mensajes ya resueltos al español del producto. */
export function useAcceso() {
  const { signIn, signOut } = useAuthActions();

  const entrar = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      try {
        await signIn('password', { email: email.trim().toLowerCase(), password, flow: 'signIn' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: mensajeDeAuth(err, SIGNIN_ERROR) };
      }
    },
    [signIn],
  );

  const crearCuenta = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      try {
        await signIn('password', { email: email.trim().toLowerCase(), password, flow: 'signUp' });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: mensajeDeAuth(err, SIGNUP_ERROR) };
      }
    },
    [signIn],
  );

  /** Arranca el flujo OAuth: el navegador se va a Google y vuelve con sesión. */
  const entrarConGoogle = useCallback(async (): Promise<AuthResult> => {
    try {
      await signIn('google');
      return { ok: true };
    } catch (err) {
      return { ok: false, message: mensajeDeError(err, GOOGLE_ERROR) };
    }
  }, [signIn]);

  /** Cierra la sesión local (y la remota si se puede). Nunca lanza. */
  const salir = useCallback(async (): Promise<void> => {
    try {
      await signOut();
    } catch {
      // Sin red: el token local ya quedó descartado por el proveedor.
    }
  }, [signOut]);

  return { entrar, crearCuenta, entrarConGoogle, salir };
}

/**
 * Si el despliegue ofrece Google. El servidor lo sabe (convex/auth.ts,
 * `googleDisponible()`), pero el contrato no expone todavía una query que lo
 * publique al navegador, así que el botón queda oculto: listarlo sin
 * credenciales deja un botón que falla al pulsarlo, que es peor que no tener
 * el botón. Cuando exista `usuarios.googleDisponible`, esto pasa a ser
 * `useQuery(api.usuarios.googleDisponible) === true`.
 */
export function useGoogleDisponible(): boolean {
  return false;
}

/* ----------------------------------------------------------------------
   Salida forzada: el servidor deja de aceptar a quien ya estaba dentro.

   Con Supabase esto eran dos listas de suscriptores en api.ts (401 y 403 con
   `code: "blocked"`) por las que pasaba cada fetch. Aquí la comprobación
   la hace CADA función de Convex (permisos.usuarioActual), así que un
   bloqueo a mitad de uso llega como ConvexError `acceso_revocado` en la
   primera query o mutación que se ejecute, y una sesión que el servidor ya
   no reconoce como `no_autenticado`. Los dos caminos acaban aquí: App
   escucha, cierra la sesión y explica el motivo en la pantalla de acceso.
   ---------------------------------------------------------------------- */

export type MotivoSalida = 'revocado' | 'expirado';

type SalidaListener = (motivo: MotivoSalida) => void;
const salidaListeners = new Set<SalidaListener>();

/** Suscribe a la salida forzada. Devuelve el des-suscriptor. */
export function onSalidaForzada(listener: SalidaListener): () => void {
  salidaListeners.add(listener);
  return () => {
    salidaListeners.delete(listener);
  };
}

/** Motivo de salida que implica un error, o null si es un error corriente. */
export function motivoDeSalida(err: unknown): MotivoSalida | null {
  if (esAccesoRevocado(err)) return 'revocado';
  if (esNoAutenticado(err)) return 'expirado';
  return null;
}

/**
 * Avisa a los suscriptores si el error obliga a salir. Devuelve true en ese
 * caso, para que quien llama no pinte además un error de fila que nadie va a
 * leer. Se invoca desde el límite de errores (queries) y desde cada catch de
 * mutación.
 */
export function avisarSiEsFatal(err: unknown): boolean {
  const motivo = motivoDeSalida(err);
  if (motivo === null) return false;
  for (const listener of salidaListeners) listener(motivo);
  return true;
}
