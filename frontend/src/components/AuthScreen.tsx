// Pantalla de acceso (SPEC.md, "Autenticación multiusuario"). Sustituye al
// antiguo gate de clave compartida: aquí se entra con correo y contraseña de
// Supabase Auth.
//
// Decisiones:
// - El dominio se valida en cliente ANTES de llamar a Supabase: el trigger de
//   Postgres lo rechazaría igual, pero el error viaja mucho más rápido y sin
//   quemar cuota de altas.
// - Los inputs son de 16px: por debajo de ese tamaño iOS Safari hace zoom al
//   enfocarlos y descoloca la pantalla.
// - Un solo formulario para las dos pestañas (mismos campos): al cambiar de
//   pestaña se conserva lo escrito y se limpian los mensajes.

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ALLOWED_DOMAIN, DOMAIN_ERROR, isAllowedEmail, signIn, signUp } from '../lib/session';
import { supabaseConfigError } from '../lib/supabase';
import { IconAlert, IconLock, IconSpinner } from './icons';

type Tab = 'signin' | 'signup';

/** Mínimo de Supabase por defecto; se valida antes de salir a la red. */
const MIN_PASSWORD = 6;

interface AuthScreenProps {
  /** true si se llega aquí por un 401 del backend (sesión caducada). */
  expired?: boolean;
  /**
   * true si un administrador revocó el acceso de la cuenta (403 con
   * `code: "blocked"`). Manda sobre `expired`: el motivo es otro y volver a
   * entrar no lo arregla.
   */
  revoked?: boolean;
}

export function AuthScreen({ expired = false, revoked = false }: AuthScreenProps) {
  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  const isSignup = tab === 'signup';

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setError(null);
    setInfo(null);
    emailRef.current?.focus();
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;

    const mail = email.trim().toLowerCase();
    setError(null);
    setInfo(null);

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
      const result = isSignup ? await signUp(mail, password) : await signIn(mail, password);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.needsConfirmation) {
        setInfo('Te enviamos un correo para confirmar tu cuenta.');
        setPassword('');
        return;
      }
      // Con sesión: onAuthStateChange despierta a App y esta pantalla se
      // desmonta sola, sin recargar la página.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <main className="auth-card">
        <div className="sidebar-brand auth-brand">
          <img className="brand-logo brand-logo-ai" src="/ai-robotix.svg" alt="AI ROBOTIX" />
          <img className="brand-logo brand-logo-project" src="/alzheimer-project.svg" alt="Alzheimer Project" />
        </div>

        <p className="auth-lead">Asistente documental para el equipo.</p>

        {supabaseConfigError !== null && (
          <p className="auth-error" role="alert">
            <IconAlert size={14} />
            <span>{supabaseConfigError}</span>
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

          {info !== null && (
            <p className="auth-info" role="status">
              {info}
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

        <p className="auth-domain-note">
          Solo se permiten correos <strong>@{ALLOWED_DOMAIN}</strong>. Los archivos son
          compartidos; tus conversaciones son privadas.
        </p>
      </main>
    </div>
  );
}
