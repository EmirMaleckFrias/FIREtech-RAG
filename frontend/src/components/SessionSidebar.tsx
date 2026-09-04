import { useState, type KeyboardEvent } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import { ROLE_LABEL, type EstadoConexion, type SessionInfo, type UserRole } from '../types';
import { IconDocument, IconPlus, IconSettings, IconSpinner, IconTrash } from './icons';

interface SessionSidebarProps {
  open: boolean;
  sessions: SessionInfo[];
  currentSessionId: Id<'sessions'> | null;
  /** La suscripcion a sesiones.listar ya entrego su primera lista. */
  loaded: boolean;
  /** Estado del WebSocket con Convex (sustituye al sondeo de /api/health). */
  conexion: EstadoConexion;
  /** Estado del slide-over de documentos (para aria-expanded del botón). */
  documentsOpen: boolean;
  /** Estado del slide-over de ajustes (para aria-expanded del botón). */
  settingsOpen: boolean;
  /** Correo de la cuenta (se trunca con ellipsis si no cabe). */
  userEmail: string;
  /** Rol de usuarios.yo; null mientras no se conoce (no se pinta insignia). */
  role: UserRole | null;
  onSelect: (id: Id<'sessions'>) => void;
  /** Borra la conversación con sus mensajes. Lanza con un mensaje legible. */
  onDelete: (id: Id<'sessions'>) => Promise<void>;
  onNew: () => void;
  onOpenDocuments: () => void;
  onOpenSettings: () => void;
}

const CONEXION: Record<EstadoConexion, { texto: string; clase: string }> = {
  conectando: { texto: 'Conectando…', clase: 'dot-gray' },
  en_linea: { texto: 'En línea', clase: 'dot-green' },
  sin_conexion: { texto: 'Sin conexión', clase: 'dot-red' },
};

/** Etiqueta de grupo por fecha relativa, estilo ChatGPT/Claude. */
function groupLabel(ms: number, now: Date): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || ms <= 0) return 'Anteriores';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7) return 'Últimos 7 días';
  if (diffDays < 30) return 'Últimos 30 días';
  return 'Anteriores';
}

interface SessionGroup {
  label: string;
  items: SessionInfo[];
}

function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const now = new Date();
  const groups: SessionGroup[] = [];
  for (const s of sessions) {
    const label = groupLabel(s.creadoEn, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}

export function SessionSidebar({
  open,
  sessions,
  currentSessionId,
  loaded,
  conexion,
  documentsOpen,
  settingsOpen,
  userEmail,
  role,
  onSelect,
  onDelete,
  onNew,
  onOpenDocuments,
  onOpenSettings,
}: SessionSidebarProps) {
  // Borrado con confirmación inline en dos pasos, como en el panel de
  // documentos: nunca window.confirm. Una sola confirmación abierta a la vez.
  const [confirmFor, setConfirmFor] = useState<Id<'sessions'> | null>(null);
  const [deleting, setDeleting] = useState<Id<'sessions'> | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: Id<'sessions'>; text: string } | null>(null);

  const estado = CONEXION[conexion];
  const groups = groupSessions(sessions);

  const handleDelete = async (id: Id<'sessions'>) => {
    setConfirmFor(null);
    setDeleteError(null);
    setDeleting(id);
    try {
      await onDelete(id);
    } catch (err) {
      setDeleteError({
        id,
        text: err instanceof Error && err.message !== '' ? err.message : 'No se pudo borrar la conversación.',
      });
    } finally {
      setDeleting(null);
    }
  };

  // Escape recoge la confirmación abierta antes de que llegue a nadie más.
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && confirmFor !== null) {
      e.stopPropagation();
      setConfirmFor(null);
    }
  };

  return (
    <aside className={`sidebar ${open ? '' : 'sidebar-closed'}`}>
      <div className="sidebar-inner">
        <div className="sidebar-brand">
          <img className="brand-logo brand-logo-ai" src="/ai-robotix.png" alt="AI ROBOTIX" />
          <img className="brand-logo brand-logo-project" src="/alzheimer-project.png" alt="Alzheimer Project" />
        </div>

        <button type="button" className="new-chat-btn" onClick={onNew}>
          <IconPlus size={15} />
          <span>Nueva conversación</span>
        </button>

        <nav className="session-list" aria-label="Conversaciones" onKeyDown={handleKeyDown}>
          {!loaded && (
            <div
              className="session-skeleton"
              role="status"
              aria-label="Cargando conversaciones"
            >
              <div className="skeleton skel-label" style={{ width: '34%' }} />
              {[88, 64, 76, 52, 70].map((w, i) => (
                <div
                  key={i}
                  className="skeleton skel-row"
                  style={{ width: `${w}%`, animationDelay: `-${i * 140}ms` }}
                />
              ))}
            </div>
          )}

          {loaded && sessions.length === 0 && (
            <div className="sidebar-empty">
              <p className="sidebar-empty-title">Aún no hay conversaciones</p>
              <p>Escribe tu primera pregunta sobre los documentos para empezar.</p>
            </div>
          )}

          {groups.map((g) => (
            <div key={`${g.label}-${g.items[0].id}`} className="session-group">
              <div className="session-group-label">{g.label}</div>
              {g.items.map((s) => {
                const active = s.id === currentSessionId;
                const titulo = s.titulo || 'Conversación sin título';
                return (
                  <div
                    key={s.id}
                    className={`session-row ${active ? 'session-row-active' : ''}`}
                  >
                    {confirmFor === s.id ? (
                      <span
                        className="session-confirm"
                        role="group"
                        aria-label={`Confirmar el borrado de ${titulo}`}
                      >
                        <span className="session-confirm-text">¿Borrar?</span>
                        <button
                          type="button"
                          className="doc-confirm-btn doc-confirm-yes"
                          onClick={() => void handleDelete(s.id)}
                        >
                          Sí
                        </button>
                        {/* el foco entra en "No": Escape y Tab siguen dentro y
                            la salida segura es la primera */}
                        <button
                          type="button"
                          className="doc-confirm-btn doc-confirm-no"
                          onClick={() => setConfirmFor(null)}
                          autoFocus
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`session-item ${active ? 'session-active' : ''}`}
                          onClick={() => onSelect(s.id)}
                          title={titulo}
                        >
                          <span className="session-title">{titulo}</span>
                        </button>
                        {deleting === s.id ? (
                          <span
                            className="session-del session-del-busy"
                            role="status"
                            aria-label={`Borrando ${titulo}`}
                          >
                            <IconSpinner size={13} />
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="session-del"
                            onClick={() => setConfirmFor(s.id)}
                            title="Borrar conversación"
                            aria-label={`Borrar la conversación ${titulo}`}
                          >
                            <IconTrash size={13} />
                          </button>
                        )}
                      </>
                    )}
                    {deleteError !== null && deleteError.id === s.id && (
                      <div className="session-row-error">{deleteError.text}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-docs-btn"
            onClick={onOpenDocuments}
            aria-haspopup="dialog"
            aria-expanded={documentsOpen}
            title="Gestionar los documentos indexados"
          >
            <IconDocument size={15} />
            <span>Documentos</span>
          </button>

          {/* Ajustes es para todos: dentro, un lector solo ve "Mi cuenta"
              (apariencia y cierre de sesión) y un admin además Usuarios y
              Sistema */}
          <button
            type="button"
            className="sidebar-docs-btn"
            onClick={onOpenSettings}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title="Ajustes de la cuenta y del sistema"
          >
            <IconSettings size={15} />
            <span>Ajustes</span>
          </button>

          <div className="sidebar-user">
            <span className="sidebar-user-email" title={userEmail}>
              {userEmail}
            </span>
            {role !== null && (
              <span className={`sidebar-role sidebar-role-${role}`}>{ROLE_LABEL[role]}</span>
            )}
          </div>

          <div className="sidebar-footer" title="Estado de la conexión con Convex">
            <span className={`health-dot ${estado.clase}`} aria-hidden="true" />
            <span className="sidebar-status-text">{estado.texto}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
