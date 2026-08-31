import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchHealth,
  fetchSessionMessages,
  fetchSessions,
  normalizeSources,
  onUnauthorized,
  sendFeedback,
  streamChat,
} from './api';
import { Chat } from './components/Chat';
import { UnlockGate } from './components/UnlockGate';
import { DocumentsPanel } from './components/DocumentsPanel';
import { Header } from './components/Header';
import { SessionSidebar } from './components/SessionSidebar';
import { SourcesPanel } from './components/SourcesPanel';
import type { CitationRef } from './lib/markdown';
import type {
  ChatMessage,
  Health,
  ServerMessage,
  SessionInfo,
  SourceFocus,
} from './types';

const HEALTH_INTERVAL_MS = 15_000;

function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  // --- gate de acceso (401 del backend con APP_ACCESS_KEY) ---
  const [locked, setLocked] = useState(false);

  useEffect(() => onUnauthorized(() => setLocked(true)), []);

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

  // Slide-over de gestión de documentos (siempre overlay, desde la derecha).
  const [docsOpen, setDocsOpen] = useState(false);

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
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshHealth]);

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

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

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

  // --- panel de documentos ---
  const openDocuments = useCallback(() => {
    setDocsOpen(true);
    // En pantallas estrechas el sidebar es un overlay: se cierra para no
    // apilar dos slide-overs.
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 821px)').matches) {
      setSidebarOpen(false);
    }
  }, []);

  const closeDocuments = useCallback(() => {
    setDocsOpen(false);
  }, []);

  const currentTitle =
    currentSessionId !== null
      ? sessions.find((s) => s.id === currentSessionId)?.title ?? 'Conversación'
      : messages.length > 0
        ? 'Nueva conversación'
        : null;

  // Bloqueado: solo la pantalla de desbloqueo. Tras validar y guardar la
  // clave se recarga la página, de modo que todas las cargas iniciales
  // (salud, sesiones, documentos) se reintentan ya con el header X-App-Key.
  if (locked) {
    return <UnlockGate onUnlocked={() => window.location.reload()} />;
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
        onSelect={(id) => void selectSession(id)}
        onNew={newConversation}
        onOpenDocuments={openDocuments}
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
      />
    </div>
  );
}
