// Slide-over de Ajustes: cuenta propia, calidad de las respuestas y, para
// administradores, usuarios y estado del sistema.
// Misma superficie que DocumentsPanel (slide-over lateral, bottom sheet con
// asa en móvil, focus trap, Escape cierra) con una fila de pestañas dentro.
//
// Decisiones:
// - Visibilidad por rol: todo el mundo tiene "Mi cuenta" y "Calidad" (la
//   médica es `lector` y es quien revisa las preguntas de control de SU
//   corpus); "Usuarios" y "Sistema" son solo de administrador y para un
//   lector ni siquiera se montan, así que sus queries de admin
//   (usuarios.listar, estadisticas.sistema) nunca se suscriben desde su
//   sesión. Antes un lector no veía la fila de pestañas porque solo tenía
//   una; con dos, la fila se enseña a todos.
// - Solo se monta el contenido de la pestaña activa, pero sigue montado con
//   el panel cerrado: reabrir no parpadea y el cierre anima con contenido.
// - Privacidad: de las conversaciones ajenas solo se muestran CONTADORES
//   (cuántas y cuántas preguntas). Ni títulos ni texto, en ningún rol.
// - Las listas son suscripciones. Una acción de fila espera a su mutación y
//   la lista ya llega actualizada cuando la promesa se resuelve (Convex no
//   resuelve una mutación hasta que las suscripciones reflejan sus
//   escrituras), así que sobran el parche optimista, su reversión y la
//   secuenciación de peticiones que hacían falta con fetch. La confirmación
//   sigue siendo inline y en dos pasos, nunca window.confirm.
// - La fila entera abre y cierra sus acciones al hacer clic. La fila propia
//   lleva "Tú", no despliega nada y no ofrece acción: el servidor rechaza a
//   quien intenta cambiarse el rol, bloquearse o borrarse a sí mismo, y la
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
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { avisarSiEsFatal } from '../lib/auth';
import { mensajeDeError } from '../lib/errores';
import { useSheetDrag } from '../lib/useSheetDrag';
import { AccountSettings } from './AccountSettings';
import { CalidadTab } from './CalidadTab';
import { ROLE_LABEL, type AdminStats, type UserAccount, type UserRole } from '../types';
import {
  IconAlert,
  IconBulb,
  IconChevronDown,
  IconLock,
  IconSettings,
  IconSearch,
  IconShieldCheck,
  IconSpinner,
  IconTrash,
  IconUser,
  IconUsers,
  IconX,
} from './icons';

type SettingsTab = 'cuenta' | 'calidad' | 'usuarios' | 'sistema';

/** Las pestañas reservadas a administradores. */
const TABS_ADMIN: readonly SettingsTab[] = ['usuarios', 'sistema'];

const NOTICE_MS = 3_200;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Miles con separador español (1.234). */
function num(value: number): string {
  return value.toLocaleString('es');
}

function plural(count: number, one: string, many: string): string {
  return `${num(count)} ${count === 1 ? one : many}`;
}

/** Fecha corta para la línea de metadatos ("3 mar 2026"). */
function shortDate(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Fecha y hora completas para el atributo title. */
function fullDate(ms: number | null): string | undefined {
  if (ms === null || ms <= 0) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('es');
}

/**
 * Último acceso en lenguaje llano: "hace 2 horas", "ayer", o la fecha si ya
 * es antigua. null significa que la cuenta nunca entró.
 */
function lastSeenText(ms: number | null): string {
  if (ms === null || ms <= 0) return 'Nunca ha entrado';
  const d = new Date(ms);
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
  return shortDate(ms) ?? 'Nunca ha entrado';
}

/** Orden por fecha de alta (más antiguas primero); las sin fecha, al final. */
function bySignup(a: UserAccount, b: UserAccount): number {
  if (a.creadoEn === null && b.creadoEn === null) return 0;
  if (a.creadoEn === null) return 1;
  if (b.creadoEn === null) return -1;
  return a.creadoEn - b.creadoEn;
}

/** Entero no negativo, o 0 si el servidor manda algo raro (contadores). */
function asCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Rol desconocido o ausente degrada al de menos permisos. */
function normalizeRole(raw: unknown): UserRole {
  return raw === 'admin' ? 'admin' : 'lector';
}

/** Lo que el frontend lee de una fila de usuarios.listar. Tipo estructural. */
interface UsuarioDoc {
  _id: Id<'users'>;
  _creationTime?: number;
  email?: string;
  rol?: string;
  bloqueado?: boolean;
  creadoEn?: number | null;
  ultimoAccesoEn?: number | null;
  sesiones?: number;
  mensajes?: number;
}

function normalizeUser(u: UsuarioDoc): UserAccount {
  return {
    id: u._id,
    email: typeof u.email === 'string' && u.email !== '' ? u.email : 'desconocido',
    rol: normalizeRole(u.rol),
    // Solo un true explícito bloquea: un campo ausente deja la cuenta
    // activa, nunca atenuada por error.
    bloqueado: u.bloqueado === true,
    creadoEn:
      typeof u.creadoEn === 'number'
        ? u.creadoEn
        : typeof u._creationTime === 'number'
          ? u._creationTime
          : null,
    ultimoAccesoEn: typeof u.ultimoAccesoEn === 'number' ? u.ultimoAccesoEn : null,
    sesiones: asCount(u.sesiones),
    mensajes: asCount(u.mensajes),
  };
}

/* ======================================================================
   Pestaña 1: Usuarios (solo admin)
   ====================================================================== */

/** Acciones de fila; todas pasan por confirmación en dos pasos. */
type RowAction = 'demote' | 'block' | 'unblock' | 'delete';

/** Verde para lo que restablece o amplía; neutro para lo que restringe. */
type NoticeTone = 'ok' | 'plain';

interface PendingConfirm {
  id: Id<'users'>;
  action: RowAction;
}

/**
 * Texto de la confirmación. Cada acción dice exactamente qué pasa con la
 * cuenta y sus conversaciones, y si tiene vuelta atrás: es lo único que
 * separa "bloquear" de "eliminar" para quien lee en vez de mirar colores.
 */
function confirmPrompt(action: RowAction, user: UserAccount): { question: string; verb: string } {
  const chats = plural(user.sesiones, 'conversación', 'conversaciones');
  switch (action) {
    case 'demote':
      return {
        question:
          '¿Quitarle el rol de administrador? Seguirá teniendo su propio espacio con sus ' +
          'documentos; lo que pierde es gestionar cuentas.',
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
  /** El panel está abierto. Al cerrarse se recogen confirmaciones y errores. */
  open: boolean;
  currentUserId: Id<'users'> | null;
}

function UsersTab({ open, currentUserId }: UsersTabProps) {
  // En `skip` con el panel cerrado: el componente sigue montado (para que
  // reabrir no parpadee) y conserva el último valor pintado, pero no mantiene
  // abierta de por vida una suscripción a toda la tabla de usuarios.
  const listaQuery = useQuery(api.usuarios.listar, open ? {} : 'skip');
  const actualizar = useMutation(api.usuarios.actualizar);
  const borrar = useMutation(api.usuarios.borrar);

  const users = useMemo<UserAccount[] | null>(
    () => (listaQuery === undefined ? null : listaQuery.map(normalizeUser).sort(bySignup)),
    [listaQuery],
  );

  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<Id<'users'> | null>(null);
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

  const noticeTimerRef = useRef<number | null>(null);

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

  /** Motivo del rechazo en la propia fila: manda el `mensaje` del servidor.
   *  Si el error obliga a salir (acceso revocado) no se pinta nada: App ya
   *  está cerrando la sesión. */
  const failRow = useCallback((id: string, err: unknown, fallback: string) => {
    if (avisarSiEsFatal(err)) return;
    setRowErrors((errs) => ({ ...errs, [id]: mensajeDeError(err, fallback) }));
  }, []);

  const changeRole = useCallback(
    async (user: UserAccount, nextRole: UserRole) => {
      setConfirm(null);
      clearRowError(user.id);
      startSaving(user.id, 'Guardando…');
      try {
        await actualizar({ userId: user.id, rol: nextRole });
        setExpandedId(null);
        showNotice(
          nextRole === 'admin'
            ? `${user.email} ya es administrador.`
            : `${user.email} ya no es administrador.`,
        );
      } catch (err) {
        failRow(user.id, err, 'No se pudo cambiar el rol.');
      } finally {
        stopSaving(user.id);
      }
    },
    [actualizar, clearRowError, failRow, showNotice, startSaving, stopSaving],
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
      try {
        await actualizar({ userId: user.id, bloqueado: nextBlocked });
        showNotice(
          nextBlocked
            ? `${user.email} ya no puede entrar. Puedes devolverle el acceso cuando quieras.`
            : `${user.email} vuelve a tener acceso.`,
          nextBlocked ? 'plain' : 'ok',
        );
      } catch (err) {
        failRow(user.id, err, 'No se pudo cambiar el acceso de la cuenta.');
      } finally {
        stopSaving(user.id);
      }
    },
    [actualizar, clearRowError, failRow, showNotice, startSaving, stopSaving],
  );

  /** Borrado permanente. La fila desaparece cuando la suscripción lo refleja,
   *  y si el servidor dice que no, el motivo queda debajo de la fila. */
  const removeUser = useCallback(
    async (user: UserAccount) => {
      setConfirm(null);
      clearRowError(user.id);
      startSaving(user.id, 'Eliminando…');
      try {
        await borrar({ userId: user.id });
        setExpandedId((prev) => (prev === user.id ? null : prev));
        showNotice(`Cuenta de ${user.email} eliminada, con sus conversaciones.`, 'plain');
      } catch (err) {
        failRow(user.id, err, 'No se pudo eliminar la cuenta.');
      } finally {
        stopSaving(user.id);
      }
    },
    [borrar, clearRowError, failRow, showNotice, startSaving, stopSaving],
  );

  /** Ejecuta la acción ya confirmada en el segundo paso. */
  const runAction = useCallback(
    (user: UserAccount, action: RowAction) => {
      switch (action) {
        case 'demote':
          void changeRole(user, 'lector');
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

  const toggleRow = (id: Id<'users'>) => {
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

  return (
    <div className="settings-tabpanel" onKeyDown={handleListKeyDown}>
      <div className="settings-tab-intro">
        <h3>Tu equipo de investigación</h3>
        <p>Gestiona accesos y permisos. Las conversaciones de cada persona siguen siendo privadas.</p>
      </div>
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

      {users === null && (
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
            const since = shortDate(u.creadoEn);
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
                    <span className={`sidebar-role sidebar-role-${u.rol}`}>
                      {ROLE_LABEL[u.rol]}
                    </span>
                    {/* el bloqueo manda sobre todo lo demás de la fila: va
                        justo detrás del rol y en ámbar de aviso */}
                    {u.bloqueado && (
                      <span className="user-blocked-badge">
                        <IconLock size={11} />
                        <span>Bloqueado</span>
                      </span>
                    )}
                    {since !== null && (
                      <span className="user-since" title={fullDate(u.creadoEn)}>
                        Alta {since}
                      </span>
                    )}
                  </span>
                  {/* solo cifras: el contenido de las conversaciones ajenas
                      no se muestra ni a un administrador */}
                  <span className="user-counts">
                    <span title={fullDate(u.ultimoAccesoEn)}>{lastSeenText(u.ultimoAccesoEn)}</span>
                    <span className="doc-sep">·</span>
                    <span>{plural(u.sesiones, 'conversación', 'conversaciones')}</span>
                    <span className="doc-sep">·</span>
                    <span>{plural(u.mensajes, 'pregunta', 'preguntas')}</span>
                  </span>
                </span>
              </>
            );

            return (
              <li
                key={u.id}
                className={`user-card ${isOpen ? 'user-card-open' : ''} ${
                  u.bloqueado ? 'user-card-blocked' : ''
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
                        {u.rol === 'admin' ? (
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
                            setConfirm({ id: u.id, action: u.bloqueado ? 'unblock' : 'block' })
                          }
                          aria-label={
                            u.bloqueado
                              ? `Desbloquear el acceso de ${u.email}`
                              : `Bloquear el acceso de ${u.email}`
                          }
                        >
                          <IconLock size={12} />
                          <span>{u.bloqueado ? 'Desbloquear' : 'Bloquear acceso'}</span>
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
 * Cifras de índice, actividad y configuración. Es de solo lectura y NUNCA
 * trae contenido de conversaciones, solo agregados. Cada bloque se normaliza
 * campo a campo: un despliegue a medio actualizar deja ceros y cadenas vacías
 * en vez de romper el panel.
 */
function normalizeStats(data: unknown): AdminStats {
  const root = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const section = (key: string): Record<string, unknown> => {
    const value = root[key];
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
      prompt_version: text(config.prompt_version),
      upload_limit_mb: asCount(config.upload_limit_mb),
    },
  };
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** El "ahora" que se manda a la query, redondeado a cinco minutos: el
 *  servidor no lee el reloj (la guía de Convex), y un argumento que cambiase
 *  en cada render abriría una suscripción nueva cada vez. */
function ahoraRedondeado(): number {
  const paso = 5 * 60_000;
  return Math.floor(Date.now() / paso) * paso;
}

function SystemTab() {
  const [ahora] = useState(ahoraRedondeado);
  const statsQuery = useQuery(api.estadisticas.sistema, { ahora });
  const stats = useMemo(
    () => (statsQuery === undefined ? null : normalizeStats(statsQuery)),
    [statsQuery],
  );

  if (stats === null) {
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

  const { index, activity, config } = stats;
  const configRows: Array<{ key: string; value: string }> = [
    { key: 'Modelo', value: config.model || 'Sin dato' },
    { key: 'Embeddings', value: config.embedding_model || 'Sin dato' },
    { key: 'Versión del prompt', value: config.prompt_version || 'Sin dato' },
    { key: 'Límite de subida', value: `${num(config.upload_limit_mb)} MB` },
  ];

  return (
    <div className="settings-tabpanel settings-scroll">
      <div className="settings-tab-intro">
        <h3>Una mirada al sistema</h3>
        <p>El índice, la actividad y la configuración del proyecto, en un solo lugar.</p>
      </div>
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
   Panel
   ====================================================================== */

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Rol de usuarios.yo; null mientras no se conoce (se asume lector). */
  role: UserRole | null;
  /** id del usuario de la sesión: su fila se marca "Tú" y no tiene acción. */
  currentUserId: Id<'users'> | null;
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
  const [tab, setTab] = useState<SettingsTab>('cuenta');

  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Mi cuenta es la entrada para todos. Al perder permisos, salir SOLO de las
  // pestañas de administración (sin suscribir queries reservadas); quien
  // estaba en Calidad se queda en Calidad.
  useEffect(() => {
    if (role !== 'admin') setTab((actual) => (TABS_ADMIN.includes(actual) ? 'cuenta' : actual));
  }, [role]);

  // Lo que se pinta no espera al efecto: entre el render en que el rol cae y
  // el efecto que corrige el estado, un lector con `usuarios` guardado vería
  // un panel vacío durante un frame.
  const tabVisible: SettingsTab = !isAdmin && TABS_ADMIN.includes(tab) ? 'cuenta' : tab;

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
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof IconUser }> = [
    { id: 'cuenta', label: 'Mi cuenta', icon: IconUser },
    { id: 'calidad', label: 'Calidad', icon: IconShieldCheck },
    ...(isAdmin
      ? [
          { id: 'usuarios' as const, label: 'Usuarios', icon: IconUsers },
          { id: 'sistema' as const, label: 'Sistema', icon: IconBulb },
        ]
      : []),
  ];

  const handleTabKeys = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setTab(tabs[next].id);
    panelRef.current?.querySelector<HTMLButtonElement>(`#settings-tab-${tabs[next].id}`)?.focus();
  };

  return (
    <aside
      ref={panelRef}
      className={`settings-panel settings-redesign ${open ? '' : 'settings-closed'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Ajustes"
      onKeyDown={handleKeyDown}
    >
      <div ref={grabberRef} className="sheet-grabber" aria-hidden="true" />
      <div className="settings-inner">
        <div className="settings-header">
          <div className="settings-heading">
            <span className="settings-heading-icon"><IconSettings size={22} /></span>
            <div><h2>Ajustes</h2><p>Tu espacio, a tu manera.</p></div>
          </div>
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

        {/* todos ven la fila: Mi cuenta y Calidad; los administradores además
            Usuarios y Sistema */}
        <div className="auth-tabs settings-tabs" role="tablist" aria-label="Secciones de ajustes">
          {tabs.map((t, index) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tabVisible === t.id}
              tabIndex={tabVisible === t.id ? 0 : -1}
              aria-controls="settings-panel-body"
              className={`auth-tab ${tabVisible === t.id ? 'auth-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => handleTabKeys(e, index)}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>

        <div
          className="settings-body"
          id="settings-panel-body"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tabVisible}`}
        >
          {isAdmin && tabVisible === 'usuarios' && (
            <UsersTab open={open} currentUserId={currentUserId} />
          )}
          {isAdmin && tabVisible === 'sistema' && <SystemTab />}
          {tabVisible === 'calidad' && <CalidadTab open={open} />}
          {tabVisible === 'cuenta' && (
            <AccountSettings userEmail={userEmail} role={role} onSignOut={onSignOut} />
          )}
        </div>
      </div>
    </aside>
  );
}
