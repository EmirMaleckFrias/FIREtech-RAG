// Límite de errores de la parte autenticada de la app.
//
// En Convex una query que lanza (permisos, un recurso que ya no existe, un
// fallo del servidor) no devuelve un error: useQuery lo relanza al pintar, y
// la forma prevista de tratarlo es un error boundary. Este es el único de la
// app y hace dos cosas:
// - Si el error obliga a salir (acceso revocado, sesión que el servidor ya no
//   reconoce), avisa por lib/auth y no pinta nada: App cierra la sesión y la
//   pantalla de acceso explica el motivo.
// - Si no, ofrece reintentar (vuelve a montar la app, así que una conversación
//   borrada desde otra pestaña deja de estar seleccionada) o cerrar sesión.
//
// Es una clase porque React solo expone getDerivedStateFromError en clases.

import { Component, type ReactNode } from 'react';
import { avisarSiEsFatal, motivoDeSalida } from '../lib/auth';
import { mensajeDeError } from '../lib/errores';
import { IconAlert, IconLogout } from './icons';

interface Props {
  onSignOut: () => void;
  children: ReactNode;
}

interface State {
  conError: boolean;
  error: unknown;
  /** El error exige cerrar sesión: no se pinta el panel de reintento. */
  fatal: boolean;
}

const FALLBACK = 'No se pudo cargar esta vista. Vuelve a intentarlo.';

export class LimiteErrores extends Component<Props, State> {
  state: State = { conError: false, error: null, fatal: false };

  static getDerivedStateFromError(error: unknown): State {
    // Puro: decide qué pintar. El aviso a App va en componentDidCatch.
    return { conError: true, error, fatal: motivoDeSalida(error) !== null };
  }

  componentDidCatch(error: unknown): void {
    avisarSiEsFatal(error);
  }

  private reintentar = (): void => {
    this.setState({ conError: false, error: null, fatal: false });
  };

  render(): ReactNode {
    if (!this.state.conError) return this.props.children;

    if (this.state.fatal) {
      return (
        <div className="auth-boot" role="status" aria-label="Cerrando sesión">
          <span className="auth-boot-dot" aria-hidden="true" />
        </div>
      );
    }

    return (
      <div className="auth-screen">
        <main className="auth-card fallo-card">
          <p className="auth-error" role="alert">
            <IconAlert size={14} />
            <span>{mensajeDeError(this.state.error, FALLBACK)}</span>
          </p>
          <button type="button" className="auth-submit" onClick={this.reintentar}>
            Reintentar
          </button>
          <button type="button" className="settings-signout" onClick={this.props.onSignOut}>
            <IconLogout size={15} />
            <span>Cerrar sesión</span>
          </button>
        </main>
      </div>
    );
  }
}
