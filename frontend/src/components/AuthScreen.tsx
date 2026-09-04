// Pantalla de acceso. Se entra con correo y contraseña de Convex Auth
// (convex/auth.ts) y, si el despliegue lo ofrece, con Google.
//
// Decisiones:
// - El dominio se valida en cliente ANTES de llamar al servidor: la regla
//   vive también en `createOrUpdateUser`, pero el error viaja mucho más rápido
//   y no gasta un alta.
// - Los errores del servidor se muestran desde `data.mensaje` si son un
//   ConvexError y, si no, con un texto genérico que dice qué hacer. Nada de
//   reconocer cadenas en inglés (ver lib/errores.ts): Convex redacta a
//   "Server Error" cualquier excepción que no sea un ConvexError.
// - Los inputs son de 16px: por debajo de ese tamaño iOS Safari hace zoom al
//   enfocarlos y descoloca la pantalla.
// - Un solo formulario para las dos pestañas (mismos campos): al cambiar de
//   pestaña se conserva lo escrito y se limpian los mensajes.

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ALLOWED_DOMAIN,
  DOMAIN_ERROR,
  MIN_PASSWORD,
  isAllowedEmail,
  useAcceso,
  useGoogleDisponible,
} from '../lib/auth';
import { convexConfigError } from '../lib/convex';
import { IconAlert, IconLock, IconSpinner } from './icons';

type Tab = 'signin' | 'signup';

interface AuthScreenProps {
  /** true si la sesión dejó de ser válida sin que el usuario la cerrara. */
  expired?: boolean;
  /**
   * true si un administrador revocó el acceso de la cuenta (ConvexError
   * `acceso_revocado`). Manda sobre `expired`: el motivo es otro y volver a
   * entrar no lo arregla.
   */
  revoked?: boolean;
}

export function AuthScreen({ expired = false, revoked = false }: AuthScreenProps) {
  const { entrar, crearCuenta, entrarConGoogle } = useAcceso();
  const googleDisponible = useGoogleDisponible();

  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  const isSignup = tab === 'signup';

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setError(null);
    emailRef.current?.focus();
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;

    const mail = email.trim().toLowerCase();
    setError(null);

    if (mail === '') {
      setError('Escribe tu correo de trabajo.');
      return;
    }
    if (!isAllowedEmail(mail)) {
      setError(DOMAIN_ERROR);
      return;
    }
    if (password === '') {
      setError('Escribe tu contraseña.');
      return;
    }
    if (isSignup && password.length < MIN_PASSWORD) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      return;
    }

    setBusy(true);
    try {
      const result = isSignup ? await crearCuenta(mail, password) : await entrar(mail, password);
      if (!result.ok) setError(result.message);
      // Con sesión: useConvexAuth despierta a App y esta pantalla se
      // desmonta sola, sin recargar la página.
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    const result = await entrarConGoogle();
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
    }
    // Si arrancó, el navegador se va a Google: no hay nada que rehabilitar.
  };

  return (
    <div className="auth-screen">
      <main className="auth-card">
        <div className="sidebar-brand auth-brand">
          <img className="brand-logo brand-logo-ai" src="/ai-robotix.png" alt="AI ROBOTIX" />
          <img className="brand-logo brand-logo-project" src="/alzheimer-project.png" alt="Alzheimer Project" />
        </div>

        <p className="auth-lead">Asistente documental para el equipo.</p>

        {convexConfigError !== null && (
          <p className="auth-error" role="alert">
            <IconAlert size={14} />
            <span>{convexConfigError}</span>
          </p>
        )}

        {revoked && (
          <p className="auth-notice auth-notice-revoked" role="status">
            <IconLock size={14} />
            <span>
              Un administrador revocó tu acceso. Si crees que es un error, habla con el
              equipo.
            </span>
          </p>
        )}

        {expired && !revoked && error === null && (
          <p className="auth-notice" role="status">
            Tu sesión caducó. Vuelve a entrar para continuar.
          </p>
        )}

        <div className="auth-tabs" role="tablist" aria-label="Acceso">
          <button
            type="button"
            role="tab"
            id="auth-tab-signin"
            aria-selected={!isSignup}
            aria-controls="auth-panel"
            className={`auth-tab ${!isSignup ? 'auth-tab-active' : ''}`}
            onClick={() => switchTab('signin')}
          >
            Entrar
          </button>
          <button
            type="button"
            role="tab"
            id="auth-tab-signup"
            aria-selected={isSignup}
            aria-controls="auth-panel"
            className={`auth-tab ${isSignup ? 'auth-tab-active' : ''}`}
            onClick={() => switchTab('signup')}
          >
            Crear cuenta
          </button>
        </div>

        <form
          id="auth-panel"
          role="tabpanel"
          aria-labelledby={isSignup ? 'auth-tab-signup' : 'auth-tab-signin'}
          className="auth-form"
          onSubmit={(e) => void handleSubmit(e)}
          noValidate
        >
          <div className="auth-field">
            <label className="auth-label" htmlFor={emailId}>
              Correo
            </label>
            <input
              ref={emailRef}
              id={emailId}
              className="auth-input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={`nombre@${ALLOWED_DOMAIN}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor={passwordId}>
              Contraseña
            </label>
            <input
              id={passwordId}
              className="auth-input"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              placeholder={isSignup ? `Mínimo ${MIN_PASSWORD} caracteres` : 'Tu contraseña'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          {error !== null && (
            <p className="auth-error" role="alert">
              <IconAlert size={14} />
              <span>{error}</span>
            </p>
          )}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? (
              <>
                <IconSpinner size={15} />
                <span>{isSignup ? 'Creando cuenta…' : 'Entrando…'}</span>
              </>
            ) : (
              <span>{isSignup ? 'Crear cuenta' : 'Entrar'}</span>
            )}
          </button>
        </form>

        {/* Solo si el despliegue tiene credenciales de Google: un boton que
            falla al pulsarlo es peor que no tener el boton. */}
        {googleDisponible && (
          <>
            <div className="auth-divider" aria-hidden="true">
              <span>o</span>
            </div>
            <button
              type="button"
              className="auth-alt"
              onClick={() => void handleGoogle()}
              disabled={busy}
            >
              Entrar con Google
            </button>
          </>
        )}

        <p className="auth-domain-note">
          Solo se permiten correos <strong>@{ALLOWED_DOMAIN}</strong>. Los archivos son
          compartidos; tus conversaciones son privadas.
        </p>
      </main>
    </div>
  );
}
