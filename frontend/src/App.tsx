// Raíz de la aplicación. Dos capas:
//
// - `App` es la puerta: consulta a Convex Auth si hay sesión y decide entre el
//   arranque, la pantalla de acceso y la app. También es quien cierra la
//   sesión cuando el servidor deja de aceptar al usuario (acceso revocado por
//   un administrador o sesión que ya no reconoce) y quien recuerda el motivo
//   para que la pantalla de acceso lo explique.
// - `Aplicacion` es la app en sí, montada solo con sesión. Todo su estado de
//   datos son suscripciones (useQuery) y mutaciones (useMutation): no hay
//   fetch, ni token que renovar, ni sondeo de salud, ni stream que parsear.
//   El turno del asistente se sigue leyendo la fila del mensaje, que el agente
//   va actualizando (estado, plan, hops, sources, content, verificacion).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvexAuth } from '@convex-dev/auth/react';
import { useConvexConnectionState, useMutation, useQueries, useQuery } from 'convex/react';
import type { RequestForQueries } from 'convex/react';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { AuthScreen } from './components/AuthScreen';
import { Chat } from './components/Chat';
import { DocumentsPanel } from './components/DocumentsPanel';
import { Header } from './components/Header';
import { LimiteErrores } from './components/LimiteErrores';
import { SessionSidebar } from './components/SessionSidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { SourcesPanel } from './components/SourcesPanel';
import { avisarSiEsFatal, onSalidaForzada, useAcceso, type MotivoSalida } from './lib/auth';
import { codigoDeError, mensajeDeError } from './lib/errores';
import type { CitationRef } from './lib/markdown';
import { mensajeDesdeDoc, type MensajeDoc } from './lib/mensajes';
import { leerAvisoNotion, urlSinAvisoNotion } from './lib/notion';
import type {
  AvisoNotion,
  ChatMessage,
  EstadoConexion,
  Me,
  ModoPensamiento,
  SessionInfo,
  SourceFocus,
} from './types';

/** Cada cuánto se relee el reloj mientras hay un turno en curso. Sirve solo
 *  para detectar un turno colgado (ver TURNO_MAX_MS en lib/mensajes.ts). */
const RELOJ_MS = 15_000;

function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function displayName(email: string): string {
  const emailName = email.split('@')[0] ?? '';
  const words = emailName.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return 'investigador';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/** Hora actual, releída cada `intervaloMs` mientras `activo`. */
function useAhora(activo: boolean, intervaloMs: number): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!activo) return;
    setAhora(Date.now());
    const timer = window.setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => window.clearInterval(timer);
  }, [activo, intervaloMs]);
  return ahora;
}

/**
 * Par de mensajes que se pinta mientras la mutación de envío está en vuelo y
 * hasta que la suscripción entrega los mensajes reales. Sin él, entre pulsar
 * Enter y que llegue la fila habría un instante sin nada, y en una
 * conversación nueva además el cambio de sesión vaciaría el hilo un momento.
 */
interface Pendiente {
  localId: string;
  texto: string;
  /** Id del mensaje del asistente, cuando la mutación ya respondió. */
  messageId: Id<'messages'> | null;
  /** La mutación falló: el par se queda con el motivo hasta el siguiente envío. */
  error: string | null;
  creadoEn: number;
}

function mensajesPendientes(p: Pendiente): ChatMessage[] {
  const base = {
    sources: [],
    hops: [],
    plan: [],
    verificacion: null,
    feedback: null,
    creadoEn: p.creadoEn,
  };
  return [
    {
      ...base,
      localId: `${p.localId}-u`,
      id: null,
      role: 'user',
      content: p.texto,
      estado: 'listo',
      streaming: false,
      error: null,
    },
    {
      ...base,
      localId: `${p.localId}-a`,
      id: null,
      role: 'assistant',
      content: '',
      estado: p.error === null ? 'pensando' : 'error',
      streaming: p.error === null,
      error: p.error,
    },
  ];
}

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { salir } = useAcceso();

  /** La sesión dejó de valer sin que el usuario la cerrara. */
  const [expired, setExpired] = useState(false);
  /** Expulsado por bloqueo de la cuenta: la pantalla de acceso lo explica. */
  const [revoked, setRevoked] = useState(false);

  const estuvoDentroRef = useRef(false);
  // Salidas que decide la app (botón, revocación): no son una caducidad.
  const salidaAvisadaRef = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) {
      estuvoDentroRef.current = true;
      salidaAvisadaRef.current = false;
      // Quien entra de nuevo ya no arrastra ningún aviso.
      setExpired(false);
      setRevoked(false);
      return;
    }
    // Fuera. Si estábamos dentro y nadie pulsó salir ni nos echaron, la
    // renovación del token falló: sesión caducada.
    if (estuvoDentroRef.current && !salidaAvisadaRef.current) setExpired(true);
    estuvoDentroRef.current = false;
  }, [isLoading, isAuthenticated]);

  const cerrarSesion = useCallback(
    async (motivo: MotivoSalida | 'manual') => {
      salidaAvisadaRef.current = true;
      setRevoked(motivo === 'revocado');
      setExpired(motivo === 'expirado');
      await salir();
    },
    [salir],
  );

  // Acceso revocado o sesión no reconocida, detectados por cualquier query o
  // mutación (ver lib/auth.ts): se sale al instante y se explica el motivo.
  useEffect(() => onSalidaForzada((motivo) => void cerrarSesion(motivo)), [cerrarSesion]);

  // Leyendo la sesión persistida: ni app ni pantalla de acceso todavía (con
  // sesión válida el salto directo evita un parpadeo del formulario).
  if (isLoading) {
    return (
      <div className="auth-boot" role="status" aria-label="Cargando">
        <span className="auth-boot-dot" aria-hidden="true" />
      </div>
    );
  }

  // Sin sesión: solo la pantalla de acceso. Ninguna suscripción se abre
  // hasta que haya sesión (Aplicacion no se monta).
  if (!isAuthenticated) {
    return <AuthScreen expired={expired} revoked={revoked} />;
  }

  const salirManual = () => void cerrarSesion('manual');
  return (
    <LimiteErrores onSignOut={salirManual}>
      <Aplicacion onSignOut={salirManual} />
    </LimiteErrores>
  );
}

interface AplicacionProps {
  onSignOut: () => void;
}

function Aplicacion({ onSignOut }: AplicacionProps) {
  // --- identidad y rol ---
  const yo = useQuery(api.usuarios.yo);
  const me = useMemo<Me | null>(
    () =>
      yo
        ? {
            id: yo._id,
            email: typeof yo.email === 'string' ? yo.email : '',
            // Cualquier valor inesperado degrada al rol con menos permisos.
            rol: yo.rol === 'admin' ? 'admin' : 'lector',
          }
        : null,
    [yo],
  );
  const userEmail = me?.email ?? '';

  // --- conexión (sustituye al sondeo de /api/health) ---
  const conexion = useConvexConnectionState();
  const estadoConexion: EstadoConexion = conexion.isWebSocketConnected
    ? 'en_linea'
    : conexion.hasEverConnected
      ? 'sin_conexion'
      : 'conectando';

  // --- conversaciones ---
  const sesionesQuery = useQuery(api.sesiones.listar);
  const sessions = useMemo<SessionInfo[]>(
    () =>
      (sesionesQuery ?? []).map((s) => ({
        id: s._id,
        titulo: typeof s.titulo === 'string' ? s.titulo : '',
        creadoEn: typeof s.creadoEn === 'number' ? s.creadoEn : 0,
      })),
    [sesionesQuery],
  );

  const [currentSessionId, setCurrentSessionId] = useState<Id<'sessions'> | null>(null);
  // useQueries y no useQuery a propósito: useQuery relanza el error al pintar
  // y lo atraparía el límite de errores, que vacía la app entera. Aquí el
  // error es un valor. Importa porque `no_encontrado` es un caso normal: al
  // borrar la conversación activa la suscripción refleja el borrado ANTES de
  // que la mutación resuelva, y lo mismo pasa si se borra desde otra pestaña.
  // Ese caso vuelve al estado vacío; cualquier otro fallo se pinta dentro del
  // hilo, como hacía la carga con fetch.
  // El objeto de consultas va MEMORIZADO: useQueries lo compara por identidad
  // y con un objeto nuevo en cada render volvía a fijar las consultas en cada
  // pintado, lo que disparaba "Too many re-renders" nada más entrar (medido en
  // producción el 4 sep 2026: la app entera caía al límite de errores).
  const consultasMensajes = useMemo(() => {
    // Construido sobre un objeto tipado y no como unión con `{}`: TypeScript
    // ensancha esa unión a `{ mensajes?: undefined }`, que no encaja en
    // RequestForQueries.
    const consultas: RequestForQueries = {};
    if (currentSessionId !== null) {
      consultas.mensajes = { query: api.mensajes.deSesion, args: { sessionId: currentSessionId } };
    }
    return consultas;
  }, [currentSessionId]);
  const resultados = useQueries(consultasMensajes);
  const crudo: unknown = resultados.mensajes;
  const errorMensajes = crudo instanceof Error ? crudo : null;
  // deSesion devuelve los documentos de `messages` tal cual; el tipo
  // estructural es el que lee mensajeDesdeDoc.
  const mensajesQuery = Array.isArray(crudo) ? (crudo as MensajeDoc[]) : undefined;

  const enviar = useMutation(api.mensajes.enviar);
  const calificar = useMutation(api.mensajes.calificar);
  const borrarSesion = useMutation(api.sesiones.borrar);

  // Modo de pensamiento elegido. Se recuerda entre recargas porque quien
  // trabaja con literatura suele quedarse en extendido toda la sesion.
  const [modo, setModo] = useState<ModoPensamiento>(() => {
    try {
      return localStorage.getItem('rag-modo') === 'extendido' ? 'extendido' : 'normal';
    } catch {
      return 'normal';
    }
  });

  /** Valoraciones dadas en esta pestaña, por id de mensaje. La tabla
   *  `feedback` es aparte y la query de mensajes puede no traerla. */
  const [feedbackLocal, setFeedbackLocal] = useState<Record<string, 1 | -1>>({});

  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  // Copia del pendiente para las promesas en vuelo: si el usuario cambió de
  // conversación mientras viajaba la mutación, su resultado ya no se aplica.
  const pendienteRef = useRef<Pendiente | null>(null);
  const fijarPendiente = useCallback((p: Pendiente | null) => {
    pendienteRef.current = p;
    setPendiente(p);
  }, []);

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

  // Vuelta de la pantalla de Notion: el servidor devuelve a la usuaria a
  // `/?notion=conectado|cancelado|error`. Se lee UNA vez al montar (si hacía
  // falta entrar, la pantalla de acceso conservó la URL y se lee al montar
  // después), se abre el panel de documentos con el aviso, y se limpia la
  // URL para que una recarga no lo repita.
  const [notionAviso, setNotionAviso] = useState<AvisoNotion | null>(() =>
    typeof window === 'undefined' ? null : leerAvisoNotion(window.location.search),
  );
  useEffect(() => {
    if (typeof window === 'undefined' || leerAvisoNotion(window.location.search) === null) return;
    window.history.replaceState(window.history.state, '', urlSinAvisoNotion(window.location.href));
  }, []);

  // Slide-overs de gestión (siempre overlay, desde la derecha). Comparten
  // sitio y scrim, así que nunca están abiertos los dos a la vez.
  const [docsOpen, setDocsOpen] = useState(() => notionAviso !== null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const selectSession = useCallback(
    (id: Id<'sessions'>) => {
      if (id === currentSessionId) return;
      fijarPendiente(null);
      setCurrentSessionId(id);
      setSelectedMsgId(null);
      setSourceFocus(null);
    },
    [currentSessionId, fijarPendiente],
  );

  const newConversation = useCallback(() => {
    fijarPendiente(null);
    setCurrentSessionId(null);
    setSelectedMsgId(null);
    setSourceFocus(null);
  }, [fijarPendiente]);

  // La conversación no se puede leer. Si es porque ya no existe (borrada aquí
  // o desde otra pestaña), al estado vacío. Si el servidor echó al usuario,
  // lib/auth cierra la sesión. El resto se pinta en el hilo (abajo).
  useEffect(() => {
    if (errorMensajes === null) return;
    if (avisarSiEsFatal(errorMensajes)) return;
    if (codigoDeError(errorMensajes) === 'no_encontrado') newConversation();
  }, [errorMensajes, newConversation]);

  // --- mensajes de la conversación actual ---
  // El reloj solo corre mientras la fila de algún turno sigue abierta.
  const turnoAbierto = (mensajesQuery ?? []).some(
    (d) => d.role === 'assistant' && d.estado !== undefined && d.estado !== 'listo' && d.estado !== 'error',
  );
  const ahora = useAhora(turnoAbierto, RELOJ_MS);

  const messages = useMemo<ChatMessage[]>(() => {
    if (errorMensajes !== null && codigoDeError(errorMensajes) !== 'no_encontrado') {
      return [
        {
          localId: 'carga-fallida',
          id: null,
          role: 'assistant',
          content: '',
          sources: [],
          hops: [],
          plan: [],
          verificacion: null,
          estado: 'error',
          streaming: false,
          error: mensajeDeError(
            errorMensajes,
            'No se pudieron cargar los mensajes de esta conversación.',
          ),
          feedback: null,
          creadoEn: 0,
        },
      ];
    }
    const docs = mensajesQuery ?? [];
    const lista = docs.map((d) => mensajeDesdeDoc(d, ahora, feedbackLocal[d._id] ?? null));
    // El par optimista se retira en cuanto la suscripción trae el mensaje
    // real, en el mismo render: sin parpadeo entre uno y otro.
    if (
      pendiente !== null &&
      (pendiente.messageId === null || !docs.some((d) => d._id === pendiente.messageId))
    ) {
      lista.push(...mensajesPendientes(pendiente));
    }
    return lista;
  }, [ahora, errorMensajes, feedbackLocal, mensajesQuery, pendiente]);

  useEffect(() => {
    if (pendiente === null || pendiente.messageId === null) return;
    if ((mensajesQuery ?? []).some((d) => d._id === pendiente.messageId)) fijarPendiente(null);
  }, [fijarPendiente, mensajesQuery, pendiente]);

  // La conversación seleccionada dejó de existir (borrada desde otra pestaña
  // o desde el propio panel): se vuelve al estado vacío en vez de quedarse
  // mirando una lista que ya no se puede leer.
  useEffect(() => {
    if (currentSessionId === null || sesionesQuery === undefined || pendiente !== null) return;
    if (sesionesQuery.some((s) => s._id === currentSessionId)) return;
    setCurrentSessionId(null);
    setSelectedMsgId(null);
    setSourceFocus(null);
  }, [currentSessionId, pendiente, sesionesQuery]);

  const loadingMessages =
    currentSessionId !== null &&
    mensajesQuery === undefined &&
    errorMensajes === null &&
    pendiente === null;
  // Composer bloqueado mientras el asistente trabaja en ESTA conversación.
  // Otra conversación puede seguir usándose.
  const isStreaming = messages.some((m) => m.role === 'assistant' && m.streaming);

  // --- envío ---
  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      // loadingMessages bloquea el envío (el composer también se deshabilita
      // en Chat): enviar durante la carga del historial mezclaría el par
      // nuevo con una lista que aún no ha llegado.
      if (!trimmed || isStreaming || loadingMessages) return;

      const localId = newLocalId();
      const nuevo: Pendiente = { localId, texto: trimmed, messageId: null, error: null, creadoEn: Date.now() };
      fijarPendiente(nuevo);
      setSelectedMsgId(null);
      setSourceFocus(null);

      try {
        // Crea la sesión si hace falta, inserta el par de mensajes (el del
        // asistente en `pensando`) y agenda al agente. A partir de aquí todo
        // llega por la suscripción a mensajes.deSesion.
        const r = await enviar({
          sessionId: currentSessionId ?? undefined,
          texto: trimmed,
          modo,
        });
        if (pendienteRef.current?.localId !== localId) return; // el usuario cambió de conversación
        setCurrentSessionId((prev) => prev ?? r.sessionId);
        fijarPendiente({ ...nuevo, messageId: r.messageId });
      } catch (err) {
        if (pendienteRef.current?.localId !== localId) return;
        if (avisarSiEsFatal(err)) return;
        fijarPendiente({
          ...nuevo,
          error: mensajeDeError(err, 'No se pudo enviar la pregunta. Vuelve a intentarlo.'),
        });
      }
    },
    [currentSessionId, enviar, fijarPendiente, isStreaming, loadingMessages, modo],
  );

  // --- borrado de conversación ---
  const handleDeleteSession = useCallback(
    async (id: Id<'sessions'>) => {
      try {
        await borrarSesion({ sessionId: id });
      } catch (err) {
        if (avisarSiEsFatal(err)) return;
        throw new Error(mensajeDeError(err, 'No se pudo borrar la conversación.'));
      }
      if (currentSessionId === id) newConversation();
    },
    [borrarSesion, currentSessionId, newConversation],
  );

  // --- feedback ---
  const handleFeedback = useCallback(
    async (msg: ChatMessage, rating: 1 | -1) => {
      if (msg.id === null || msg.feedback !== null) return;
      const id = msg.id;
      setFeedbackLocal((prev) => ({ ...prev, [id]: rating }));
      try {
        await calificar({ messageId: id, rating });
      } catch (err) {
        // revierte si el servidor lo rechaza
        setFeedbackLocal((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        avisarSiEsFatal(err);
      }
    },
    [calificar],
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
      ? sessions.find((s) => s.id === currentSessionId)?.titulo || 'Conversación'
      : messages.length > 0
        ? 'Nueva conversación'
        : null;

  return (
    <div className="app">
      <SessionSidebar
        open={sidebarOpen}
        sessions={sessions}
        currentSessionId={currentSessionId}
        loaded={sesionesQuery !== undefined}
        conexion={estadoConexion}
        documentsOpen={docsOpen}
        settingsOpen={settingsOpen}
        userEmail={userEmail}
        role={me?.rol ?? null}
        onSelect={selectSession}
        onDelete={handleDeleteSession}
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
          userName={displayName(userEmail)}
          messages={messages}
          loadingMessages={loadingMessages}
          isStreaming={isStreaming}
          panelTargetId={panelMessage?.localId ?? null}
          onSend={(t) => void handleSend(t)}
          modo={modo}
          onModoChange={(m) => {
            setModo(m);
            try {
              localStorage.setItem('rag-modo', m);
            } catch {
              // Sin almacenamiento (modo privado): el modo dura la sesion.
            }
          }}
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
        canManage={me?.rol === 'admin'}
        notionAviso={notionAviso}
        onNotionAvisoVisto={() => setNotionAviso(null)}
      />

      {settingsOpen && (
        <div className="scrim scrim-docs" onClick={closeSettings} aria-hidden="true" />
      )}
      <SettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        role={me?.rol ?? null}
        currentUserId={me?.id ?? null}
        userEmail={userEmail}
        onSignOut={onSignOut}
      />
    </div>
  );
}
