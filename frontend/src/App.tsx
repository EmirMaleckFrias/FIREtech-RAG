import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  fetchHealth,
  fetchMe,
  fetchSessionMessages,
  fetchSessions,
  normalizeSources,
  onAccessRevoked,
  onUnauthorized,
  sendFeedback,
  streamChat,
} from './api';
import { Chat } from './components/Chat';
import { AuthScreen } from './components/AuthScreen';
import { DocumentsPanel } from './components/DocumentsPanel';
import { Header } from './components/Header';
import { SessionSidebar } from './components/SessionSidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { SourcesPanel } from './components/SourcesPanel';
import type { CitationRef } from './lib/markdown';
import {
  hasValidSession,
  loadSession,
  onSessionChange,
  renewAccessToken,
  signOut,
} from './lib/session';
import type {
  ChatMessage,
  Health,
  Me,
  ServerMessage,
  SessionInfo,
  SourceFocus,
} from './types';

const HEALTH_INTERVAL_MS = 15_000;

/**
 * Cada cuánto, como mucho, se pide un token nuevo ante 401 seguidos. Es solo
 * un freno para no martillear a Supabase: agotarlo NO cierra la sesión.
 */
const RENEW_THROTTLE_MS = 10_000;

function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function displayName(session: Session | null): string {
  const fullName = session?.user.user_metadata?.full_name;
  if (typeof fullName === 'string' && fullName.trim() !== '') return fullName.trim();
  const emailName = session?.user.email?.split('@')[0] ?? '';
  const words = emailName.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return 'investigador';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

function toChatMessage(server: ServerMessage): ChatMessage {
  return {
    localId: server.id || newLocalId(),
    id: server.id || null,
    role: server.role === 'user' ? 'user' : 'assistant',
    content: server.content ?? '',
    sources: normalizeSources(server.sources),
    hops: [],
    streaming: false,
    error: null,
    feedback: null,
  };
}

export default function App() {
  // --- sesión de usuario (Supabase Auth) ---
  // authLoading: se está leyendo la sesión persistida (evita el parpadeo de la
  // pantalla de acceso al recargar con sesión válida).
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [expired, setExpired] = useState(false);
  /** Expulsado por bloqueo de la cuenta: la pantalla de acceso lo explica. */
  const [revoked, setRevoked] = useState(false);

  const hasSessionRef = useRef(false);
  const lastRenewRef = useRef(0);

  useEffect(() => {
    let alive = true;
    void loadSession().then((s) => {
      if (!alive) return;
      setSession(s);
      setAuthLoading(false);
    });
    // login, logout y TOKEN_REFRESHED (en esta y en otras pestañas)
    const off = onSessionChange((s) => {
      if (!alive) return;
      setSession(s);
      setAuthLoading(false);
      if (s !== null) {
        setExpired(false);
        setRevoked(false); // quien entra de nuevo ya no arrastra el aviso
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    hasSessionRef.current = session !== null;
  }, [session]);

  const userId = session?.user.id ?? null;
  const userEmail = session?.user.email ?? '';

  // --- estado global ---
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Panel de fuentes: mensaje seleccionado + foco de cita.
  const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);

  // Paneles laterales (abiertos por defecto en pantallas anchas).
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 821px)').matches,
  );
  const [sourcesOpen, setSourcesOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1101px)').matches,
  );

  // Slide-overs de gestión (siempre overlay, desde la derecha). Comparten
  // sitio y scrim, así que nunca están abiertos los dos a la vez.
  const [docsOpen, setDocsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRequestRef = useRef(0);

  // --- salud del backend, con sondeo periódico ---
  // Reutilizable: el panel de documentos la invoca tras indexar/borrar para
  // refrescar el contador de productos del footer.
  const refreshHealth = useCallback(async () => {
    try {
      const h = await fetchHealth();
      setHealth(h);
      setHealthError(false);
    } catch {
      setHealthError(true);
    }
  }, []);

  useEffect(() => {
    if (userId === null) return; // sin sesión no hay app que vigilar
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshHealth, userId]);

  // --- sesiones ---
  const refreshSessions = useCallback(async () => {
    try {
      const list = await fetchSessions();
      setSessions(list);
      setSessionsError(false);
    } catch {
      setSessionsError(true);
    } finally {
      setSessionsLoaded(true);
    }
  }, []);

  // Las conversaciones son privadas: solo se piden con sesión, y se vuelven a
  // pedir al cambiar de usuario.
  useEffect(() => {
    if (userId === null) return;
    void refreshSessions();
  }, [refreshSessions, userId]);

  // --- identidad y rol (GET /api/me) ---
  useEffect(() => {
    if (userId === null) return;
    let alive = true;
    void fetchMe()
      .then((info) => {
        if (alive) setMe(info);
      })
      .catch(() => {
        // Sin /api/me no se conoce el rol: se asume el de menos permisos
        // (el sidebar no pinta insignia y Documentos queda en solo lectura).
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Cambio de usuario o cierre de sesión: nada del usuario anterior sobrevive
  // en memoria (mensajes, conversaciones, panel de fuentes).
  useEffect(() => {
    abortRef.current?.abort();
    sessionRequestRef.current++;
    setMessages([]);
    setSessions([]);
    setSessionsLoaded(false);
    setSessionsError(false);
    setCurrentSessionId(null);
    setSelectedMsgId(null);
    setSourceFocus(null);
    setLoadingMessages(false);
    if (userId === null) setMe(null);
  }, [userId]);

  /**
   * 401 del backend. La sesión SOLO se cierra si de verdad murió: mientras el
   * navegador conserve una sesión vigente se mantiene al usuario dentro, aunque
   * el backend rechace peticiones (un 401 puede venir de un problema del
   * servidor, no del usuario). Así, una vez dentro, solo se sale al pulsar
   * cerrar sesión.
   */
  const handleUnauthorized = useCallback(async () => {
    if (!hasSessionRef.current) return; // ya estamos fuera
    const now = Date.now();
    if (now - lastRenewRef.current > RENEW_THROTTLE_MS) {
      lastRenewRef.current = now;
      const token = await renewAccessToken();
      if (token !== null) return; // token nuevo: la siguiente petición irá bien
    }
    if (await hasValidSession()) return; // el problema no es la sesión
    hasSessionRef.current = false;
    setExpired(true);
    await signOut();
    setSession(null);
  }, []);

  useEffect(
    () => onUnauthorized(() => void handleUnauthorized()),
    [handleUnauthorized],
  );

  /**
   * 403 con `code: "blocked"`: un administrador revocó el acceso de esta
   * cuenta. Es la ÚNICA excepción a la regla de arriba y sale por la puerta
   * contraria: aquí no se renueva el token ni se comprueba la sesión, porque
   * el token sigue siendo válido y aun así no sirve de nada. Se cierra la
   * sesión al instante y se explica el motivo en la pantalla de acceso.
   *
   * El backend manda su propio texto ("Tu acceso ha sido revocado"); la
   * pantalla usa una copia más explícita sobre quién lo hizo y qué hacer.
   */
  const handleAccessRevoked = useCallback(async () => {
    if (!hasSessionRef.current) return; // ya estamos fuera
    hasSessionRef.current = false;
    setExpired(false);
    setRevoked(true);
    setDocsOpen(false);
    setSettingsOpen(false);
    await signOut();
    setSession(null);
  }, []);

  useEffect(
    () => onAccessRevoked(() => void handleAccessRevoked()),
    [handleAccessRevoked],
  );

  const handleSignOut = useCallback(async () => {
    hasSessionRef.current = false;
    setExpired(false);
    setRevoked(false);
    await signOut();
    setSession(null);
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const selectSession = useCallback(
    async (id: string) => {
      if (id === currentSessionId) return;
      stopStreaming();
      const requestId = ++sessionRequestRef.current;
      setCurrentSessionId(id);
      setSelectedMsgId(null);
      setSourceFocus(null);
      setMessages([]);
      setLoadingMessages(true);
      try {
        const serverMessages = await fetchSessionMessages(id);
        if (sessionRequestRef.current !== requestId) return; // el usuario cambió de sesión
        setMessages(serverMessages.map(toChatMessage));
      } catch {
        if (sessionRequestRef.current !== requestId) return;
        setMessages([
          {
            localId: newLocalId(),
            id: null,
            role: 'assistant',
            content: '',
            sources: [],
            hops: [],
            streaming: false,
            error: 'No se pudieron cargar los mensajes de esta conversación.',
            feedback: null,
          },
        ]);
      } finally {
        if (sessionRequestRef.current === requestId) setLoadingMessages(false);
      }
    },
    [currentSessionId, stopStreaming],
  );

  const newConversation = useCallback(() => {
    stopStreaming();
    sessionRequestRef.current++;
    setCurrentSessionId(null);
    setMessages([]);
    setSelectedMsgId(null);
    setSourceFocus(null);
    setLoadingMessages(false);
  }, [stopStreaming]);

  // --- helpers de mensajes ---
  const updateMessage = useCallback(
    (localId: string, fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.localId === localId ? fn(m) : m)));
    },
    [],
  );

  // --- envío con streaming SSE ---
  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      // loadingMessages bloquea el envío (el composer también se deshabilita
      // en Chat): enviar durante la carga del historial descartaría esa carga
      // y la conversación quedaría solo con el par nuevo.
      if (!trimmed || isStreaming || loadingMessages) return;

      const assistantLocalId = newLocalId();
      const userMsg: ChatMessage = {
        localId: newLocalId(),
        id: null,
        role: 'user',
        content: trimmed,
        sources: [],
        hops: [],
        streaming: false,
        error: null,
        feedback: null,
      };
      const draft: ChatMessage = {
        localId: assistantLocalId,
        id: null,
        role: 'assistant',
        content: '',
        sources: [],
        hops: [],
        streaming: true,
        error: null,
        feedback: null,
      };

      // No hay cargas de mensajes en vuelo que invalidar: toda carga de
      // selectSession mantiene loadingMessages en true mientras dura, y el
      // guard de arriba impide llegar aquí en ese estado. Las cargas ya
      // invalidadas (newConversation) se descartan por sessionRequestRef.

      setMessages((prev) => [...prev, userMsg, draft]);
      setSelectedMsgId(null);
      setSourceFocus(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let finished = false;

      try {
        await streamChat(
          currentSessionId,
          trimmed,
          {
            onSession: (id) => {
              setCurrentSessionId((prev) => prev ?? id);
            },
            onHop: (hop) => {
              updateMessage(assistantLocalId, (m) => ({ ...m, hops: [...m.hops, hop] }));
            },
            onSources: (incoming) => {
              updateMessage(assistantLocalId, (m) => {
                const merged = [...m.sources];
                for (const s of incoming) {
                  const dup = merged.some(
                    (x) =>
                      x.source_file === s.source_file &&
                      x.page === s.page &&
                      x.snippet === s.snippet,
                  );
                  if (!dup) merged.push(s);
                }
                return { ...m, sources: merged };
              });
            },
            onToken: (t) => {
              updateMessage(assistantLocalId, (m) => ({ ...m, content: m.content + t }));
            },
            onDone: (messageId) => {
              finished = true;
              // message_id puede venir "" si el backend no pudo persistir el
              // mensaje: id null deja el feedback deshabilitado (MessageItem
              // solo lo pinta con id, y handleFeedback exige id no vacío).
              updateMessage(assistantLocalId, (m) => ({
                ...m,
                id: messageId || null,
                streaming: false,
              }));
            },
            onError: (detail) => {
              finished = true;
              updateMessage(assistantLocalId, (m) => ({
                ...m,
                streaming: false,
                error: detail || 'Error del servidor durante la generación.',
              }));
            },
          },
          controller.signal,
        );

        // El stream terminó sin evento done/error (conexión cortada).
        if (!finished) {
          updateMessage(assistantLocalId, (m) =>
            m.streaming
              ? {
                  ...m,
                  streaming: false,
                  error:
                    m.content === ''
                      ? 'La conexión se interrumpió antes de recibir la respuesta.'
                      : 'La respuesta se interrumpió antes de completarse.',
                }
              : m,
          );
        }
      } catch (err) {
        const aborted = controller.signal.aborted;
        const detail =
          err instanceof Error && err.message ? err.message : 'Error de red desconocido';
        updateMessage(assistantLocalId, (m) => ({
          ...m,
          streaming: false,
          error: aborted
            ? m.content === ''
              ? 'Generación detenida.'
              : null
            : `No se pudo completar la solicitud: ${detail}`,
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsStreaming(false);
        // El título de la sesión puede haberse creado/actualizado en el backend.
        void refreshSessions();
      }
    },
    [currentSessionId, isStreaming, loadingMessages, refreshSessions, updateMessage],
  );

  // --- feedback ---
  const handleFeedback = useCallback(
    async (msg: ChatMessage, rating: 1 | -1) => {
      if (!msg.id || msg.feedback !== null) return;
      updateMessage(msg.localId, (m) => ({ ...m, feedback: rating }));
      try {
        await sendFeedback(msg.id, rating);
      } catch {
        // revierte si el POST falla
        updateMessage(msg.localId, (m) => ({ ...m, feedback: null }));
      }
    },
    [updateMessage],
  );

  // --- panel de fuentes ---
  const panelMessage = useMemo(() => {
    if (selectedMsgId !== null) {
      const found = messages.find((m) => m.localId === selectedMsgId);
      if (found) return found;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && (m.sources.length > 0 || m.streaming)) return m;
    }
    return null;
  }, [messages, selectedMsgId]);

  const handleCitation = useCallback((msgLocalId: string, ref: CitationRef) => {
    setSelectedMsgId(msgLocalId);
    setSourcesOpen(true);
    setSourceFocus({ file: ref.file, page: ref.firstPage, token: Date.now() });
  }, []);

  const handleShowSources = useCallback((msgLocalId: string) => {
    setSelectedMsgId(msgLocalId);
    setSourcesOpen(true);
  }, []);

  // --- paneles de gestión (documentos y ajustes) ---
  const openDocuments = useCallback(() => {
    setDocsOpen(true);
    setSettingsOpen(false); // ocupan el mismo hueco a la derecha
    // En pantallas estrechas el sidebar es un overlay: se cierra para no
    // apilar dos slide-overs.
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 821px)').matches) {
      setSidebarOpen(false);
    }
  }, []);

  const closeDocuments = useCallback(() => {
    setDocsOpen(false);
  }, []);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    setDocsOpen(false);
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 821px)').matches) {
      setSidebarOpen(false);
    }
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const currentTitle =
    currentSessionId !== null
      ? sessions.find((s) => s.id === currentSessionId)?.title ?? 'Conversación'
      : messages.length > 0
        ? 'Nueva conversación'
        : null;

  // Leyendo la sesión persistida: ni app ni pantalla de acceso todavía (con
  // sesión válida el salto directo evita un parpadeo del formulario).
  if (authLoading) {
    return (
      <div className="auth-boot" role="status" aria-label="Cargando">
        <span className="auth-boot-dot" aria-hidden="true" />
      </div>
    );
  }

  // Sin sesión: solo la pantalla de acceso. Ninguna llamada a /api/* sale
  // hasta que haya token (los efectos están condicionados a userId).
  if (session === null) {
    return <AuthScreen expired={expired} revoked={revoked} />;
  }

  return (
    <div className="app">
      <SessionSidebar
        open={sidebarOpen}
        sessions={sessions}
        currentSessionId={currentSessionId}
        loaded={sessionsLoaded}
        loadError={sessionsError}
        health={health}
        healthError={healthError}
        documentsOpen={docsOpen}
        settingsOpen={settingsOpen}
        userEmail={userEmail}
        role={me?.role ?? null}
        onSelect={(id) => void selectSession(id)}
        onNew={newConversation}
        onOpenDocuments={openDocuments}
        onOpenSettings={openSettings}
      />
      {sidebarOpen && (
        <div
          className="scrim scrim-left"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="main">
        <Header
          title={currentTitle}
          sidebarOpen={sidebarOpen}
          sourcesOpen={sourcesOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleSources={() => setSourcesOpen((v) => !v)}
        />
        <Chat
          userName={displayName(session)}
          messages={messages}
          loadingMessages={loadingMessages}
          isStreaming={isStreaming}
          panelTargetId={panelMessage?.localId ?? null}
          onSend={(t) => void handleSend(t)}
          onStop={stopStreaming}
          onFeedback={(m, r) => void handleFeedback(m, r)}
          onCitation={handleCitation}
          onShowSources={handleShowSources}
        />
      </div>

      {sourcesOpen && (
        <div
          className="scrim scrim-right"
          onClick={() => setSourcesOpen(false)}
          aria-hidden="true"
        />
      )}
      <SourcesPanel
        open={sourcesOpen}
        message={panelMessage}
        focus={sourceFocus}
        onClose={() => setSourcesOpen(false)}
      />

      {docsOpen && (
        <div className="scrim scrim-docs" onClick={closeDocuments} aria-hidden="true" />
      )}
      <DocumentsPanel
        open={docsOpen}
        onClose={closeDocuments}
        onHealthRefresh={() => void refreshHealth()}
        uploadLimitMb={health?.upload_limit_mb}
        canManage={me?.role === 'admin'}
      />

      {settingsOpen && (
        <div className="scrim scrim-docs" onClick={closeSettings} aria-hidden="true" />
      )}
      <SettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        role={me?.role ?? null}
        currentUserId={userId}
        userEmail={userEmail}
        onSignOut={() => void handleSignOut()}
      />
    </div>
  );
}
