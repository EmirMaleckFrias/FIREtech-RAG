// Slide-over de Ajustes: usuarios, estado del sistema y cuenta propia.
// Misma superficie que DocumentsPanel (slide-over lateral, bottom sheet con
// asa en móvil, focus trap, Escape cierra) con una fila de pestañas dentro.
//
// Decisiones:
// - Visibilidad por rol: un vendedor solo tiene "Mi cuenta" y ni siquiera se
//   monta la pestaña de usuarios ni la de sistema, así que sus endpoints de
//   admin (GET /api/users, GET /api/stats) nunca se llaman desde su sesión.
// - Solo se monta el contenido de la pestaña activa, pero sigue montado con
//   el panel cerrado: reabrir no parpadea y el cierre anima con contenido.
//   Cada pestaña pide sus datos cuando el panel se abre, no al montarse.
// - Privacidad: de las conversaciones ajenas solo se muestran CONTADORES
//   (cuántas y cuántas preguntas). Ni títulos ni texto, en ningún rol.
// - Toda acción de fila es OPTIMISTA con reversión si el backend la rechaza,
//   y pide confirmación inline en dos pasos, nunca window.confirm.
// - La fila entera abre y cierra sus acciones al hacer clic. La fila propia
//   lleva "Tú", no despliega nada y no ofrece acción: el backend responde 403
//   a quien intenta cambiarse el rol, bloquearse o borrarse a sí mismo, y la
//   UI no ofrece lo que se va a rechazar.
// - Bloquear y eliminar son cosas MUY distintas y se pintan distinto:
//   bloquear es reversible y conserva la cuenta, así que va en ámbar (el
//   color de aviso que ya usa el panel de documentos) y sin relleno; eliminar
//   es permanente, así que es lo único de la fila que nace en rojo, lleva
//   papelera, se separa a la derecha y su confirmación es la única con
//   relleno rojo. El acento de marca (que también es rojo) queda para
//   promover, la acción constructiva.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { deleteUser, fetchStats, fetchUsers, setUserBlocked, updateUserRole } from '../api';
import { useSheetDrag } from '../lib/useSheetDrag';
import { updatePassword } from '../lib/session';
import type { AdminStats, UserAccount, UserRole } from '../types';
import {
  IconAlert,
  IconChevronDown,
  IconLock,
  IconLogout,
  IconSearch,
  IconSpinner,
  IconTrash,
  IconUser,
  IconUsers,
  IconX,
} from './icons';

type SettingsTab = 'usuarios' | 'sistema' | 'cuenta';

const NOTICE_MS = 3_200;
/** Mínimo que exige el producto para una contraseña nueva. */
const MIN_PASSWORD = 8;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Administrador',
  vendedor: 'Vendedor',
};

/** Miles con separador español (1.234). */
function num(value: number): string {
  return value.toLocaleString('es');
}

function plural(count: number, one: string, many: string): string {
  return `${num(count)} ${count === 1 ? one : many}`;
}

/** Fecha corta para la línea de metadatos ("3 mar 2026"). */
function shortDate(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Fecha y hora completas para el atributo title. */
function fullDate(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('es');
}

/**
 * Último acceso en lenguaje llano: "hace 2 horas", "ayer", o la fecha si ya
 * es antigua. null (o fecha ilegible) significa que la cuenta nunca entró.
 */
function lastSeenText(iso: string | null): string {
  if (iso === null || iso === '') return 'Nunca ha entrado';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Nunca ha entrado';

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'Hace un momento';
  if (diffMin < 60) return `Hace ${plural(diffMin, 'minuto', 'minutos')}`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Hace ${plural(diffHours, 'hora', 'horas')}`;

  // A partir de un día se cuenta por días de calendario: a las 00:30 de hoy,
  // algo de las 23:00 de ayer es "ayer" y no "hace 1 día".
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 1) return 'Ayer';
  if (diffDays < 7) return `Hace ${diffDays} días`;
  return shortDate(iso) ?? 'Nunca ha entrado';
}

/** Orden por fecha de alta (más antiguas primero); las ilegibles, al final. */
function bySignup(a: UserAccount, b: UserAccount): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

/* ======================================================================
   Pestaña 1: Usuarios (solo admin)
   ====================================================================== */

/** Acciones de fila; todas pasan por confirmación en dos pasos. */
type RowAction = 'demote' | 'block' | 'unblock' | 'delete';

/** Verde para lo que restablece o amplía; neutro para lo que restringe. */
type NoticeTone = 'ok' | 'plain';

interface PendingConfirm {
  id: string;
  action: RowAction;
}

/**
 * Texto de la confirmación. Cada acción dice exactamente qué pasa con la
 * cuenta y sus conversaciones, y si tiene vuelta atrás: es lo único que
 * separa "bloquear" de "eliminar" para quien lee en vez de mirar colores.
 */
function confirmPrompt(action: RowAction, user: UserAccount): { question: string; verb: string } {
  const chats = plural(user.sessions_count, 'conversación', 'conversaciones');
  switch (action) {
    case 'demote':
      return {
        question: '¿Quitarle el rol de administrador? Seguirá entrando como vendedor.',
        verb: 'Quitar',
      };
    case 'block':
      return {
        question: `¿Bloquear su acceso? Se conservan la cuenta y sus ${chats}: puedes devolvérselo cuando quieras.`,
        verb: 'Bloquear',
      };
    case 'unblock':
      return {
        question: '¿Devolverle el acceso? Volverá a entrar con normalidad.',
        verb: 'Desbloquear',
      };
    case 'delete':
      return {
        question: `Se borran la cuenta y sus ${chats}. Es permanente: no se puede deshacer.`,
        verb: 'Eliminar cuenta',
      };
  }
}

interface UsersTabProps {
  /** El panel está abierto: momento de pedir (o refrescar) la lista. */
  open: boolean;
  currentUserId: string | null;
}

function UsersTab({ open, currentUserId }: UsersTabProps) {
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  /** id de fila -> etiqueta del trabajo en curso ("Bloqueando…", ...). */
  const [saving, setSaving] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  /**
   * Aviso breve tras una acción. El tono "plain" (neutro) es para las
   * restrictivas: revocar un acceso o borrar una cuenta se confirma, no se
   * celebra en verde.
   */
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>(null);

  const usersRef = useRef<UserAccount[] | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  /**
   * Secuenciación de refreshUsers (mismo patrón que docsRequestRef en
   * DocumentsPanel): cada petición toma un id y, si al resolver ya no es la
   * vigente, su resultado se descarta. Un PATCH exitoso incrementa la
   * secuencia para que un GET /api/users en vuelo no reponga el rol viejo.
   */
  const usersRequestRef = useRef(0);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const showNotice = useCallback((text: string, tone: NoticeTone = 'ok') => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ text, tone });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, NOTICE_MS);
  }, []);

  const refreshUsers = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    const requestId = ++usersRequestRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const list = await fetchUsers();
      if (usersRequestRef.current !== requestId) return; // respuesta obsoleta
      setUsers([...list].sort(bySignup));
      setLoadError(null);
    } catch (err) {
      if (usersRequestRef.current !== requestId) return;
      if (!silent) {
        setLoadError(
          err instanceof Error ? err.message : 'No se pudo cargar la lista de usuarios.',
        );
      }
    } finally {
      if (!silent && usersRequestRef.current === requestId) setLoading(false);
    }
  }, []);

  // Al abrir: primera carga con skeleton; si ya hay datos, refresco silencioso.
  useEffect(() => {
    if (!open) return;
    void refreshUsers({ silent: usersRef.current !== null });
  }, [open, refreshUsers]);

  // Al cerrar se recogen las acciones desplegadas y los errores de fila:
  // reabrir nunca muestra un "¿Eliminar?" a medias ni el motivo de un intento
  // viejo junto a una fila que ya luce el estado correcto.
  useEffect(() => {
    if (open) return;
    setConfirm(null);
    setExpandedId(null);
    setRowErrors({});
  }, [open]);

  /* --- utilidades comunes a las tres acciones de fila --- */

  const startSaving = useCallback((id: string, label: string) => {
    setSaving((s) => ({ ...s, [id]: label }));
  }, []);

  const stopSaving = useCallback((id: string) => {
    setSaving((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  }, []);

  const clearRowError = useCallback((id: string) => {
    setRowErrors((errs) => {
      if (!(id in errs)) return errs;
      const next = { ...errs };
      delete next[id];
      return next;
    });
  }, []);

  /** Motivo del rechazo en la propia fila: manda el `detail` del backend. */
  const failRow = useCallback((id: string, err: unknown, fallback: string) => {
    setRowErrors((errs) => ({
      ...errs,
      [id]: err instanceof Error && err.message !== '' ? err.message : fallback,
    }));
  }, []);

  /** Aplica un parche local a una fila (sin tocar el resto de la lista). */
  const patchRow = useCallback((id: string, patch: Partial<UserAccount>) => {
    setUsers((prev) =>
      prev === null ? prev : prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }, []);

  const changeRole = useCallback(
    async (user: UserAccount, nextRole: UserRole) => {
      setConfirm(null);
      clearRowError(user.id);
      startSaving(user.id, 'Guardando…');

      // Optimista: la fila ya luce el rol nuevo mientras viaja el PATCH.
      const previousRole = user.role;
      patchRow(user.id, { role: nextRole });

      try {
        const updated = await updateUserRole(user.id, nextRole);
        // Invalida cualquier GET /api/users en vuelo: su lista trae el rol
        // anterior y desharía el cambio recién confirmado.
        usersRequestRef.current++;
        // Solo se fusiona lo que esta acción cambia: el bloqueo lo lleva su
        // propia acción y nunca se pisa desde aquí.
        patchRow(user.id, { role: updated.role, email: updated.email || user.email });
        setExpandedId(null);
        showNotice(
          updated.role === 'admin'
            ? `${user.email} ya es administrador.`
            : `${user.email} ya no es administrador.`,
        );
      } catch (err) {
        // Reversión: la fila vuelve al rol que tenía antes del intento.
        patchRow(user.id, { role: previousRole });
        failRow(user.id, err, 'No se pudo cambiar el rol.');
      } finally {
        stopSaving(user.id);
      }
    },
    [clearRowError, failRow, patchRow, showNotice, startSaving, stopSaving],
  );

  /**
   * Bloquea o desbloquea. NO borra nada: la cuenta y sus conversaciones se
   * quedan donde están y la fila sigue en la lista, atenuada y con la
   * insignia "Bloqueado". La fila se deja desplegada a propósito, para que
   * deshacerlo esté a un clic.
   */
  const changeBlocked = useCallback(
    async (user: UserAccount, nextBlocked: boolean) => {
      setConfirm(null);
      clearRowError(user.id);
      startSaving(user.id, nextBlocked ? 'Bloqueando…' : 'Desbloqueando…');

      const previousBlocked = user.blocked;
      patchRow(user.id, { blocked: nextBlocked });

      try {
        const updated = await setUserBlocked(user.id, nextBlocked);
        usersRequestRef.current++;
        // `blocked` null = el backend no devolvió el campo: vale lo pedido.
        patchRow(user.id, {
          blocked: updated.blocked ?? nextBlocked,
          email: updated.email || user.email,
        });
        showNotice(
          nextBlocked
            ? `${user.email} ya no puede entrar. Puedes devolverle el acceso cuando quieras.`
            : `${user.email} vuelve a tener acceso.`,
          nextBlocked ? 'plain' : 'ok',
        );
      } catch (err) {
        patchRow(user.id, { blocked: previousBlocked });
        failRow(user.id, err, 'No se pudo cambiar el acceso de la cuenta.');
      } finally {
        stopSaving(user.id);
      }
    },
    [clearRowError, failRow, patchRow, showNotice, startSaving, stopSaving],
  );

  /**
   * Borrado permanente. Optimista igual que el resto: la fila desaparece al
   * instante y, si el backend dice que no, vuelve a su sitio exacto con el
   * motivo debajo (nunca al final de la lista, que parecería otra cuenta).
   */
  const removeUser = useCallback(
    async (user: UserAccount) => {
      setConfirm(null);
      setExpandedId((prev) => (prev === user.id ? null : prev));
      clearRowError(user.id);

      const previousIndex = usersRef.current?.findIndex((u) => u.id === user.id) ?? -1;
      setUsers((prev) => (prev === null ? prev : prev.filter((u) => u.id !== user.id)));
      // Un GET en vuelo traería la cuenta de vuelta: se descarta su respuesta.
      usersRequestRef.current++;

      try {
        await deleteUser(user.id);
        usersRequestRef.current++;
        showNotice(`Cuenta de ${user.email} eliminada, con sus conversaciones.`, 'plain');
      } catch (err) {
        setUsers((prev) => {
          if (prev === null) return prev;
          if (prev.some((u) => u.id === user.id)) return prev; // ya repuesta
          const restored = [...prev];
          const at = previousIndex >= 0 ? Math.min(previousIndex, restored.length) : restored.length;
          restored.splice(at, 0, user);
          return restored;
        });
        failRow(user.id, err, 'No se pudo eliminar la cuenta.');
      }
    },
    [clearRowError, failRow, showNotice],
  );

  /** Ejecuta la acción ya confirmada en el segundo paso. */
  const runAction = useCallback(
    (user: UserAccount, action: RowAction) => {
      switch (action) {
        case 'demote':
          void changeRole(user, 'vendedor');
          break;
        case 'block':
          void changeBlocked(user, true);
          break;
        case 'unblock':
          void changeBlocked(user, false);
          break;
        case 'delete':
          void removeUser(user);
          break;
      }
    },
    [changeBlocked, changeRole, removeUser],
  );

  const toggleRow = (id: string) => {
    setConfirm(null);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  /**
   * Escape dentro de la lista recoge lo desplegado antes de dejar que el
   * panel se cierre: primero la confirmación, luego las acciones de la fila.
   */
  const handleListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    if (confirm !== null) {
      e.stopPropagation();
      setConfirm(null);
    } else if (expandedId !== null) {
      e.stopPropagation();
      setExpandedId(null);
    }
  };

  // Búsqueda manual sobre la lista ya cargada: filtrar por correo no merece
  // una petición por pulsación (las cuentas del equipo caben de sobra).
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (users === null) return null;
    if (needle === '') return users;
    return users.filter((u) => u.email.toLowerCase().includes(needle));
  }, [needle, users]);

  const showSkeleton = loading && users === null;
  const showUnavailable = !loading && loadError !== null && users === null;

  return (
    <div className="settings-tabpanel" onKeyDown={handleListKeyDown}>
      {users !== null && users.length > 0 && (
        <div className="users-search">
          <span className="users-search-icon" aria-hidden="true">
            <IconSearch size={14} />
          </span>
          <input
            className="auth-input users-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por correo"
            aria-label="Buscar usuarios por correo"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      )}

      {/* aviso breve de éxito, se retira solo */}
      {notice !== null && (
        <p
          className={`users-notice ${notice.tone === 'plain' ? 'users-notice-plain' : ''}`}
          role="status"
          aria-live="polite"
        >
          {notice.text}
        </p>
      )}

      {showSkeleton && (
        <div className="users-skeleton" role="status" aria-label="Cargando usuarios">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="skeleton skel-user"
              style={{ animationDelay: `-${i * 140}ms` }}
            />
          ))}
        </div>
      )}

      {showUnavailable && (
        <div className="settings-empty">
          <span className="settings-empty-icon" aria-hidden="true">
            <IconAlert size={20} />
          </span>
          <p className="settings-empty-title">No disponible</p>
          <p>{loadError}</p>
          <button type="button" className="docs-retry-btn" onClick={() => void refreshUsers()}>
            Reintentar
          </button>
        </div>
      )}

      {users !== null && users.length === 0 && (
        <div className="settings-empty">
          <span className="settings-empty-icon" aria-hidden="true">
            <IconUsers size={20} />
          </span>
          <p>Todavía no hay cuentas registradas.</p>
        </div>
      )}

      {visible !== null && users !== null && users.length > 0 && visible.length === 0 && (
        <div className="settings-empty">
          <p>Sin resultados para “{query.trim()}”.</p>
        </div>
      )}

      {visible !== null && visible.length > 0 && (
        <ul className="users-list">
          {visible.map((u) => {
            const isSelf = currentUserId !== null && u.id === currentUserId;
            const savingLabel = saving[u.id];
            const isSaving = savingLabel !== undefined;
            const isOpen = expandedId === u.id;
            const pending = confirm !== null && confirm.id === u.id ? confirm.action : null;
            const rowError = rowErrors[u.id];
            const since = shortDate(u.created_at);
            const actionsId = `user-actions-${u.id}`;

            const rowContent = (
              <>
                <span className="user-icon" aria-hidden="true">
                  <IconUser size={15} />
                </span>
                <span className="user-info">
                  <span className="user-email" title={u.email}>
                    {u.email}
                  </span>
                  <span className="user-meta">
                    <span className={`sidebar-role sidebar-role-${u.role}`}>
                      {ROLE_LABEL[u.role]}
                    </span>
                    {/* el bloqueo manda sobre todo lo demás de la fila: va
                        justo detrás del rol y en ámbar de aviso */}
                    {u.blocked && (
                      <span className="user-blocked-badge">
                        <IconLock size={11} />
                        <span>Bloqueado</span>
                      </span>
                    )}
                    {since !== null && (
                      <span className="user-since" title={fullDate(u.created_at)}>
                        Alta {since}
                      </span>
                    )}
                  </span>
                  {/* solo cifras: el contenido de las conversaciones ajenas
                      no se muestra ni a un administrador */}
                  <span className="user-counts">
                    <span title={fullDate(u.last_sign_in_at ?? '')}>
                      {lastSeenText(u.last_sign_in_at)}
                    </span>
                    <span className="doc-sep">·</span>
                    <span>{plural(u.sessions_count, 'conversación', 'conversaciones')}</span>
                    <span className="doc-sep">·</span>
                    <span>{plural(u.messages_count, 'pregunta', 'preguntas')}</span>
                  </span>
                </span>
              </>
            );

            return (
              <li
                key={u.id}
                className={`user-card ${isOpen ? 'user-card-open' : ''} ${
                  u.blocked ? 'user-card-blocked' : ''
                }`}
              >
                {isSelf ? (
                  <div className="user-row user-row-static">
                    {rowContent}
                    <span className="user-self">Tú</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="user-row"
                    onClick={() => toggleRow(u.id)}
                    aria-expanded={isOpen}
                    aria-controls={actionsId}
                  >
                    {rowContent}
                    <span
                      className={`user-chevron ${isOpen ? 'user-chevron-open' : ''}`}
                      aria-hidden="true"
                    >
                      <IconChevronDown size={14} />
                    </span>
                  </button>
                )}

                {!isSelf && (isOpen || isSaving) && (
                  <div className="user-actions" id={actionsId}>
                    {isSaving ? (
                      <span className="user-saving" role="status">
                        <IconSpinner size={13} />
                        <span className="shimmer-text">{savingLabel}</span>
                      </span>
                    ) : pending !== null ? (
                      (() => {
                        const { question, verb } = confirmPrompt(pending, u);
                        const danger = pending === 'delete';
                        return (
                          <div
                            className={`user-confirm ${danger ? 'user-confirm-danger' : ''}`}
                            role="group"
                            aria-label={`Confirmar acción sobre ${u.email}`}
                          >
                            <span className="user-confirm-text" aria-live="polite">
                              {danger && <IconAlert size={13} />}
                              <span>{question}</span>
                            </span>
                            <span className="user-confirm-actions">
                              <button
                                type="button"
                                className={`doc-confirm-btn ${
                                  danger ? 'user-confirm-delete' : 'doc-confirm-yes'
                                }`}
                                onClick={() => runAction(u, pending)}
                                aria-label={`${verb}: ${u.email}`}
                              >
                                {verb}
                              </button>
                              {/* el foco entra en "Cancelar": Escape y Tab
                                  siguen dentro del panel y la salida segura
                                  es la primera. Además el botón que confirma
                                  cae en otro sitio que el que abrió la
                                  confirmación, así un doble clic no borra
                                  nada por inercia. */}
                              <button
                                type="button"
                                className="doc-confirm-btn doc-confirm-no"
                                onClick={() => setConfirm(null)}
                                autoFocus
                              >
                                Cancelar
                              </button>
                            </span>
                          </div>
                        );
                      })()
                    ) : (
                      <>
                        {u.role === 'admin' ? (
                          <button
                            type="button"
                            className="user-act-btn user-act-demote"
                            onClick={() => setConfirm({ id: u.id, action: 'demote' })}
                            aria-label={`Quitar administrador a ${u.email}`}
                          >
                            Quitar administrador
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="user-act-btn user-act-promote"
                            onClick={() => void changeRole(u, 'admin')}
                            aria-label={`Hacer administrador a ${u.email}`}
                          >
                            Hacer administrador
                          </button>
                        )}

                        {/* reversible: conserva cuenta y conversaciones */}
                        <button
                          type="button"
                          className="user-act-btn user-act-block"
                          onClick={() =>
                            setConfirm({ id: u.id, action: u.blocked ? 'unblock' : 'block' })
                          }
                          aria-label={
                            u.blocked
                              ? `Desbloquear el acceso de ${u.email}`
                              : `Bloquear el acceso de ${u.email}`
                          }
                        >
                          <IconLock size={12} />
                          <span>{u.blocked ? 'Desbloquear' : 'Bloquear acceso'}</span>
                        </button>

                        {/* permanente: apartado a la derecha y en rojo */}
                        <button
                          type="button"
                          className="user-act-btn user-act-danger"
                          onClick={() => setConfirm({ id: u.id, action: 'delete' })}
                          aria-label={`Eliminar la cuenta de ${u.email} y sus conversaciones`}
                        >
                          <IconTrash size={12} />
                          <span>Eliminar cuenta</span>
                        </button>
                      </>
                    )}
                  </div>
                )}

                {rowError !== undefined && <div className="user-row-error">{rowError}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ======================================================================
   Pestaña 2: Sistema (solo admin, solo lectura)
   ====================================================================== */

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function SystemTab({ open }: { open: boolean }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const statsRef = useRef<AdminStats | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  const refreshStats = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    const requestId = ++requestRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const data = await fetchStats();
      if (requestRef.current !== requestId) return;
      setStats(data);
      setLoadError(null);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      if (!silent) {
        setLoadError(
          err instanceof Error ? err.message : 'No se pudo leer el estado del sistema.',
        );
      }
    } finally {
      if (!silent && requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshStats({ silent: statsRef.current !== null });
  }, [open, refreshStats]);

  if (loading && stats === null) {
    return (
      <div className="settings-tabpanel">
        <div className="users-skeleton" role="status" aria-label="Cargando el estado del sistema">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="skeleton skel-stats"
              style={{ animationDelay: `-${i * 140}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (stats === null) {
    return (
      <div className="settings-tabpanel">
        <div className="settings-empty">
          <span className="settings-empty-icon" aria-hidden="true">
            <IconAlert size={20} />
          </span>
          <p className="settings-empty-title">No disponible</p>
          <p>{loadError ?? 'No se pudo leer el estado del sistema.'}</p>
          <button type="button" className="docs-retry-btn" onClick={() => void refreshStats()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const { index, activity, config } = stats;
  const configRows: Array<{ key: string; value: string }> = [
    { key: 'Modelo', value: config.model || 'Sin dato' },
    { key: 'Embeddings', value: config.embedding_model || 'Sin dato' },
    { key: 'Saltos máximos del agente', value: num(config.max_hops) },
    { key: 'Límite de subida', value: `${num(config.upload_limit_mb)} MB` },
  ];

  return (
    <div className="settings-tabpanel settings-scroll">
      <section className="stats-block">
        <h3 className="stats-title">Índice</h3>
        <div className="stats-grid">
          <StatTile value={num(index.chunks)} label="Fragmentos" />
          <StatTile value={num(index.files)} label="Archivos" />
        </div>
      </section>

      <section className="stats-block">
        <h3 className="stats-title">Actividad</h3>
        <div className="stats-grid">
          <StatTile value={num(activity.questions_total)} label="Preguntas totales" />
          <StatTile value={num(activity.questions_7d)} label="Preguntas (7 días)" />
          <StatTile value={num(activity.active_users_7d)} label="Usuarios activos (7 días)" />
          <StatTile value={num(activity.feedback_up)} label="Valoraciones a favor" />
          <StatTile value={num(activity.feedback_down)} label="Valoraciones en contra" />
        </div>
      </section>

      <section className="stats-block">
        <h3 className="stats-title">Configuración</h3>
        <dl className="config-list">
          {configRows.map((row) => (
            <div key={row.key} className="config-row">
              <dt className="config-key">{row.key}</dt>
              <dd className="config-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

/* ======================================================================
   Pestaña 3: Mi cuenta (todos los roles)
   ====================================================================== */

interface AccountTabProps {
  userEmail: string;
  role: UserRole | null;
  onSignOut: () => void;
}

function AccountTab({ userEmail, role, onSignOut }: AccountTabProps) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const passwordId = useId();
  const repeatId = useId();

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);

    if (password.length < MIN_PASSWORD) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      return;
    }
    if (password !== repeat) {
      setError('Las dos contraseñas no coinciden.');
      return;
    }

    setBusy(true);
    try {
      const result = await updatePassword(password);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPassword('');
      setRepeat('');
      setInfo('Tu contraseña quedó actualizada.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-tabpanel settings-scroll">
      <div className="account-identity">
        <span className="account-email" title={userEmail}>
          {userEmail}
        </span>
        {role !== null && (
          <span className={`sidebar-role sidebar-role-${role}`}>{ROLE_LABEL[role]}</span>
        )}
      </div>

      <form className="auth-form account-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <h3 className="stats-title">Cambiar contraseña</h3>

        <div className="auth-field">
          <label className="auth-label" htmlFor={passwordId}>
            Nueva contraseña
          </label>
          <input
            id={passwordId}
            className="auth-input"
            type="password"
            autoComplete="new-password"
            placeholder={`Mínimo ${MIN_PASSWORD} caracteres`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor={repeatId}>
            Repite la contraseña
          </label>
          <input
            id={repeatId}
            className="auth-input"
            type="password"
            autoComplete="new-password"
            placeholder="La misma otra vez"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
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
              <span>Guardando…</span>
            </>
          ) : (
            <span>Guardar contraseña</span>
          )}
        </button>
      </form>

      <button type="button" className="settings-signout" onClick={onSignOut}>
        <IconLogout size={15} />
        <span>Cerrar sesión</span>
      </button>
    </div>
  );
}

/* ======================================================================
   Panel
   ====================================================================== */

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Rol de GET /api/me; null mientras no se conoce (se asume vendedor). */
  role: UserRole | null;
  /** id del usuario de la sesión: su fila se marca "Tú" y no tiene acción. */
  currentUserId: string | null;
  userEmail: string;
  onSignOut: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  role,
  currentUserId,
  userEmail,
  onSignOut,
}: SettingsPanelProps) {
  const isAdmin = role === 'admin';
  const [tab, setTab] = useState<SettingsTab>(isAdmin ? 'usuarios' : 'cuenta');

  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // El rol llega asíncrono (GET /api/me) y puede cambiar de usuario: la
  // pestaña por defecto se recalcula al conocerlo, y un vendedor nunca se
  // queda mirando una pestaña de admin.
  useEffect(() => {
    setTab(role === 'admin' ? 'usuarios' : 'cuenta');
  }, [role]);

  // Bottom sheet en móvil: swipe-down sobre el asa cierra el panel.
  useSheetDrag(panelRef, grabberRef, onClose);

  // Foco: al abrir entra al botón de cerrar; al cerrar vuelve a donde estaba.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, [open]);

  // --- focus trap ligero + Escape ---
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = panelRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'usuarios', label: 'Usuarios' },
    { id: 'sistema', label: 'Sistema' },
    { id: 'cuenta', label: 'Mi cuenta' },
  ];

  return (
    <aside
      ref={panelRef}
      className={`settings-panel ${open ? '' : 'settings-closed'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Ajustes"
      onKeyDown={handleKeyDown}
    >
      <div ref={grabberRef} className="sheet-grabber" aria-hidden="true" />
      <div className="settings-inner">
        <div className="settings-header">
          <h2>Ajustes</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn settings-close"
            onClick={onClose}
            title="Cerrar"
            aria-label="Cerrar ajustes"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* un vendedor solo tiene "Mi cuenta": sin fila de pestañas */}
        {isAdmin && (
          <div className="auth-tabs settings-tabs" role="tablist" aria-label="Secciones de ajustes">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="settings-panel-body"
                className={`auth-tab ${tab === t.id ? 'auth-tab-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div
          className="settings-body"
          id="settings-panel-body"
          role={isAdmin ? 'tabpanel' : undefined}
          aria-labelledby={isAdmin ? `settings-tab-${tab}` : undefined}
        >
          {isAdmin && tab === 'usuarios' && (
            <UsersTab open={open} currentUserId={currentUserId} />
          )}
          {isAdmin && tab === 'sistema' && <SystemTab open={open} />}
          {(!isAdmin || tab === 'cuenta') && (
            <AccountTab userEmail={userEmail} role={role} onSignOut={onSignOut} />
          )}
        </div>
      </div>
    </aside>
  );
}
