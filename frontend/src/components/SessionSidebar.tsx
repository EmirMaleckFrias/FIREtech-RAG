import type { Health, SessionInfo, UserRole } from '../types';
import { IconDocument, IconPlus, IconSettings } from './icons';

interface SessionSidebarProps {
  open: boolean;
  sessions: SessionInfo[];
  currentSessionId: string | null;
  loaded: boolean;
  loadError: boolean;
  health: Health | null;
  healthError: boolean;
  /** Estado del slide-over de documentos (para aria-expanded del botón). */
  documentsOpen: boolean;
  /** Estado del slide-over de ajustes (para aria-expanded del botón). */
  settingsOpen: boolean;
  /** Correo de la sesión de Supabase (se trunca con ellipsis si no cabe). */
  userEmail: string;
  /** Rol de GET /api/me; null mientras no se conoce (no se pinta insignia). */
  role: UserRole | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenDocuments: () => void;
  onOpenSettings: () => void;
}

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Administrador',
  vendedor: 'Vendedor',
};

/** Etiqueta de grupo por fecha relativa, estilo ChatGPT/Claude. */
function groupLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Anteriores';
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
    const label = groupLabel(s.created_at, now);
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
  loadError,
  health,
  healthError,
  documentsOpen,
  settingsOpen,
  userEmail,
  role,
  onSelect,
  onNew,
  onOpenDocuments,
  onOpenSettings,
}: SessionSidebarProps) {
  const ok = !healthError && health !== null && health.status === 'ok' && health.qdrant;

  let statusText: string;
  let dotClass: string;
  if (healthError) {
    statusText = 'Backend sin conexión';
    dotClass = 'dot-red';
  } else if (health === null) {
    statusText = 'Conectando…';
    dotClass = 'dot-gray';
  } else if (!ok) {
    statusText = 'Backend con problemas';
    dotClass = 'dot-amber';
  } else {
    statusText = 'En línea';
    dotClass = 'dot-green';
  }

  const groups = groupSessions(sessions);

  return (
    <aside className={`sidebar ${open ? '' : 'sidebar-closed'}`}>
      <div className="sidebar-inner">
        <div className="sidebar-brand">
          <span className="brand-plate" role="img" aria-label="FIREtech">
            <span className="brand-fire" aria-hidden="true">FIRE</span>
            <span className="brand-tech" aria-hidden="true">tech</span>
          </span>
          <span className="brand-badge">RAG</span>
        </div>

        <button type="button" className="new-chat-btn" onClick={onNew}>
          <IconPlus size={15} />
          <span>Nueva conversación</span>
        </button>

        <nav className="session-list" aria-label="Conversaciones">
          {!loaded && !loadError && (
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

          {loadError && (
            <div className="sidebar-empty">
              No se pudieron cargar las conversaciones. ¿Está el backend en marcha?
            </div>
          )}

          {loaded && !loadError && sessions.length === 0 && (
            <div className="sidebar-empty">
              <p className="sidebar-empty-title">Aún no hay conversaciones</p>
              <p>Escribe tu primera pregunta sobre los documentos para empezar.</p>
            </div>
          )}

          {groups.map((g) => (
            <div key={`${g.label}-${g.items[0].id}`} className="session-group">
              <div className="session-group-label">{g.label}</div>
              {g.items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`session-item ${s.id === currentSessionId ? 'session-active' : ''}`}
                  onClick={() => onSelect(s.id)}
                  title={s.title ?? 'Conversación sin título'}
                >
                  <span className="session-title">
                    {s.title || 'Conversación sin título'}
                  </span>
                </button>
              ))}
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

          {/* Ajustes es para todos: dentro, un vendedor solo ve "Mi cuenta"
              (contraseña y cierre de sesión) y un admin además Usuarios y
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

          <div className="sidebar-footer" title="Estado del backend (GET /api/health)">
            <span className={`health-dot ${dotClass}`} aria-hidden="true" />
            <span className="sidebar-status-text">{statusText}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
