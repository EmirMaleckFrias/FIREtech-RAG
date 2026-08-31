import { useState } from 'react';
import type { FormEvent } from 'react';
import { setStoredAppKey, verifyAppKey } from '../api';

interface Props {
  /** Invocado tras validar y guardar la clave (App recarga el estado). */
  onUnlocked: () => void;
}

/**
 * Pantalla mínima de desbloqueo: aparece cuando el backend responde 401
 * (despliegue con APP_ACCESS_KEY). Valida la clave contra un endpoint
 * protegido, la guarda en localStorage (firetech_app_key) y reintenta.
 * En dev local (sin APP_ACCESS_KEY) nunca se muestra.
 */
export function UnlockGate({ onUnlocked }: Props) {
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const candidate = key.trim();
    if (candidate === '' || checking) return;
    setChecking(true);
    setError(null);
    try {
      const ok = await verifyAppKey(candidate);
      if (!ok) {
        setError('Clave incorrecta. Vuelve a intentarlo.');
        return;
      }
      setStoredAppKey(candidate);
      onUnlocked();
    } catch {
      setError('No se pudo verificar la clave. ¿Hay conexión con el servidor?');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="sidebar-brand unlock-brand">
          <span className="brand-plate" role="img" aria-label="FIREtech">
            <span className="brand-fire" aria-hidden="true">FIRE</span>
            <span className="brand-tech" aria-hidden="true">tech</span>
          </span>
          <span className="brand-badge">RAG</span>
        </div>
        <p className="unlock-hint">
          Este espacio es privado. Introduce la clave de acceso para continuar.
        </p>
        <label className="visually-hidden" htmlFor="unlock-key">
          Clave de acceso
        </label>
        <input
          id="unlock-key"
          className="unlock-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          placeholder="Clave de acceso"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={checking}
        />
        {error !== null && (
          <p className="unlock-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="unlock-submit"
          disabled={checking || key.trim() === ''}
        >
          {checking ? 'Comprobando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
