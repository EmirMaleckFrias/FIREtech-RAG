import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CitationRef } from '../lib/markdown';
import { debeEnviar, usePreferencias } from '../lib/preferencias';
import type { ChatMessage, ModoPensamiento } from '../types';
import { IconArrowUp, IconCheck, IconChevronDown, IconStop } from './icons';
import { MessageItem } from './MessageItem';
import { WelcomeIntro, WelcomeSuggestions } from './Welcome';

interface ChatProps {
  userName: string;
  messages: ChatMessage[];
  loadingMessages: boolean;
  isStreaming: boolean;
  panelTargetId: string | null;
  onSend: (text: string) => void;
  modo: ModoPensamiento;
  onModoChange: (modo: ModoPensamiento) => void;
  onFeedback: (msg: ChatMessage, rating: 1 | -1) => void;
  /** Detener la respuesta en marcha (botón de parar). */
  onStop: () => void;
  /** Detener falló: se dice debajo del cuadro de texto. */
  stopError?: string | null;
  /** Mensaje por id de respuesta cuando guardar la valoración falló. */
  feedbackErrores?: Record<string, string>;
  onCitation: (msgLocalId: string, ref: CitationRef) => void;
  onShowSources: (msgLocalId: string) => void;
}

/** Los dos modos, con la explicación que ve el usuario al pasar por encima. */
const MODOS: {
  valor: ModoPensamiento;
  etiqueta: string;
  corta: string;
  ayuda: string;
}[] = [
  {
    valor: 'normal',
    etiqueta: 'Pensamiento normal',
    corta: 'Normal',
    ayuda: 'Una o dos búsquedas. Para preguntas directas.',
  },
  {
    valor: 'extendido',
    etiqueta: 'Pensamiento extendido',
    corta: 'Extendido',
    ayuda: 'Busca sin tope y contrasta entre documentos. Tarda y cuesta más.',
  },
];

/** ~8 líneas de texto (15px · 1.5) + padding vertical del textarea. */
const MAX_TEXTAREA_HEIGHT = 204;

/** Aviso de precios: mismo texto bajo las píldoras y bajo el composer. */
const PRICE_NOTE =
  'Las respuestas se basan en los documentos indexados. Verifica la evidencia antes de tomar decisiones.';

export function Chat({
  userName,
  messages,
  loadingMessages,
  isStreaming,
  panelTargetId,
  onSend,
  modo,
  onModoChange,
  onFeedback,
  onCitation,
  onShowSources,
  feedbackErrores = {},
  onStop,
  stopError = null,
}: ChatProps) {
  const [draft, setDraft] = useState('');
  const preferencias = usePreferencias();
  const [modoMenuAbierto, setModoMenuAbierto] = useState(false);
  const modoActual = MODOS.find((m) => m.valor === modo) ?? MODOS[0];
  const modoRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  // Ventana durante la cual el scroll suave programático está en curso: sus
  // eventos de scroll intermedios no deben des-fijar el auto-stick.
  const smoothUntilRef = useRef(0);

  // El menu de modo se cierra al pulsar fuera o con Escape, como cualquier
  // menu: si no, queda abierto tapando el composer.
  useEffect(() => {
    if (!modoMenuAbierto) return;
    const fuera = (e: MouseEvent) => {
      if (!modoRef.current?.contains(e.target as Node)) setModoMenuAbierto(false);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setModoMenuAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', escape);
    };
  }, [modoMenuAbierto]);

  // Autoscroll mientras el asistente avanza (plan, hops, respuesta), salvo
  // que el usuario haya subido. Suave solo en saltos discretos (nuevo par de
  // mensajes); en las actualizaciones intermedias el ajuste directo ya se
  // percibe continuo y no pelea con el animador de scroll del navegador.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevCount = prevCountRef.current;
    prevCountRef.current = messages.length;
    if (!stickToBottomRef.current) return;

    const listGrew = prevCount > 0 && messages.length > prevCount;
    const reduceMotion = preferencias.reducirMovimiento ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (listGrew && !reduceMotion) {
      smoothUntilRef.current = Date.now() + 700;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, preferencias.reducirMovimiento]);

  // Teclado virtual: con interactive-widget=resizes-content + 100dvh el
  // layout se encoge solo en Chrome Android; en iOS Safari el layout no
  // cambia, así que al redimensionarse el visual viewport (abrir/cerrar
  // teclado) se re-ancla el hilo al fondo si el usuario ya estaba abajo,
  // dejando visibles el último mensaje y el composer.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!stickToBottomRef.current) return;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (Date.now() < smoothUntilRef.current) {
      // Scroll programático en curso: no interpretar como gesto del usuario.
      if (nearBottom) smoothUntilRef.current = 0;
      return;
    }
    stickToBottomRef.current = nearBottom;
  };

  // Un gesto real del usuario (rueda/touch) cancela la ventana programática
  // para que subir durante el scroll suave lo detenga de inmediato.
  const cancelSmoothWindow = () => {
    smoothUntilRef.current = 0;
  };

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming || loadingMessages) return;
    stickToBottomRef.current = true;
    onSend(text);
    setDraft('');
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    });
  };

  // El foco vuelve al composer cuando termina la respuesta. Al enviar, el
  // textarea pasa a `disabled` en el mismo render y el navegador suelta el
  // foco a `body`; un `focus()` en ese momento no hace nada, y sin esto quien
  // navega con teclado tenía que tabular desde el principio de la página en
  // cada turno. Solo si el foco está suelto: si ella se fue a otro sitio
  // mientras esperaba, no se le roba.
  const estabaEnCurso = useRef(isStreaming);
  useEffect(() => {
    const antes = estabaEnCurso.current;
    estabaEnCurso.current = isStreaming;
    if (!antes || isStreaming || loadingMessages) return;
    const suelto = document.activeElement === null || document.activeElement === document.body;
    if (suelto) textareaRef.current?.focus();
  }, [isStreaming, loadingMessages]);

  /**
   * Sugerencia del estado vacío: escribe la pregunta en el composer y le da
   * foco, sin enviarla. El foco va síncrono dentro del gesto (en iOS es la
   * única forma de que se abra el teclado); el resto espera al rAF, cuando
   * React ya pintó el texto y se puede medir la altura real.
   */
  const fillDraft = (question: string) => {
    textareaRef.current?.focus();
    setDraft(question);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.setSelectionRange(el.value.length, el.value.length);
      resizeTextarea();
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter durante una composición IME (japonés, chino, coreano...) solo
    // confirma el texto compuesto: no debe enviar. Algunos navegadores
    // reportan la tecla como "Process" mientras dura la composición.
    if (debeEnviar(e.nativeEvent, preferencias.enterEnvia)) {
      e.preventDefault();
      submit();
    }
  };

  const showWelcome = !loadingMessages && messages.length === 0;
  // Mientras carga el historial de la sesión, el composer se deshabilita
  // igual que durante el streaming: enviar en ese estado perdería la carga.
  const canSend = draft.trim() !== '' && !loadingMessages;

  // Estado vacío: el hilo y el bloque de sugerencias hacen de espaciadores
  // (flex:1 cada uno) y dejan el composer centrado en vertical, sin moverlo
  // del DOM ni duplicar su estado. Al llegar el primer mensaje cae la clase y
  // el composer vuelve a su sitio de siempre, abajo.
  return (
    <main className={`chat${showWelcome ? ' chat-empty' : ''}`}>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={cancelSmoothWindow}
        onTouchMove={cancelSmoothWindow}
      >
        {loadingMessages && (
          <div
            className="message-list chat-skeleton"
            role="status"
            aria-label="Cargando conversación"
          >
            <div className="skel-user">
              <div className="skeleton skel-bubble" style={{ width: '46%' }} />
            </div>
            <div className="skel-assistant">
              <div className="skeleton skel-avatar" />
              <div className="skel-lines">
                <div className="skeleton skel-line" style={{ width: '96%' }} />
                <div className="skeleton skel-line" style={{ width: '88%' }} />
                <div className="skeleton skel-line" style={{ width: '58%' }} />
              </div>
            </div>
            <div className="skel-user">
              <div className="skeleton skel-bubble" style={{ width: '32%' }} />
            </div>
            <div className="skel-assistant">
              <div className="skeleton skel-avatar" />
              <div className="skel-lines">
                <div className="skeleton skel-line" style={{ width: '92%' }} />
                <div className="skeleton skel-line" style={{ width: '70%' }} />
              </div>
            </div>
          </div>
        )}

        {showWelcome && <WelcomeIntro userName={userName} />}

        {!loadingMessages && messages.length > 0 && (
          <div className="message-list">
            {messages.map((m) => (
              <MessageItem
                key={m.localId}
                feedbackError={m.id !== null ? feedbackErrores[m.id] : undefined}
                msg={m}
                isPanelTarget={m.localId === panelTargetId}
                onFeedback={onFeedback}
                onCitation={onCitation}
                onShowSources={onShowSources}
              />
            ))}
          </div>
        )}
      </div>

      <div className="composer-area">
        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder="Pregunta sobre tus documentos…"
            aria-label="Escribe tu pregunta"
            onChange={(e) => {
              setDraft(e.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || loadingMessages}
          />
          <div className="composer-controles">
            <div className="modo-selector" ref={modoRef}>
              <button
                type="button"
                className="modo-boton"
                aria-haspopup="menu"
                aria-expanded={modoMenuAbierto}
                disabled={isStreaming}
                onClick={() => setModoMenuAbierto((v) => !v)}
              >
                <span>{modoActual.corta}</span>
                <IconChevronDown size={12} />
              </button>
              {modoMenuAbierto && (
                <div className="modo-menu" role="menu" aria-label="Modo de pensamiento">
                  {MODOS.map((m) => (
                    <button
                      key={m.valor}
                      type="button"
                      role="menuitemradio"
                      aria-checked={modo === m.valor}
                      className="modo-item"
                      onClick={() => {
                        onModoChange(m.valor);
                        setModoMenuAbierto(false);
                      }}
                    >
                      <span className="modo-item-texto">
                        <span className="modo-item-nombre">{m.etiqueta}</span>
                        <span className="modo-item-ayuda">{m.ayuda}</span>
                      </span>
                      {modo === m.valor && (
                        <span className="modo-item-check" aria-hidden="true">
                          <IconCheck size={14} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {isStreaming ? (
              /* Parar, como en cualquier chat. La cancelación es cooperativa:
                 `mensajes.detener` marca el turno y desde ese momento el
                 agente, que corre en el servidor y no se puede abortar desde
                 aquí, no puede escribir nada más; el borrador a medio revisar
                 NO se publica (ver convex/mensajes.ts). */
              <button
                type="button"
                className="send-btn send-stop"
                onClick={onStop}
                title="Detener la respuesta"
                aria-label="Detener la respuesta"
              >
                <IconStop size={13} />
              </button>
            ) : (
              <button
                type="submit"
                className={`send-btn ${canSend ? 'send-ready' : ''}`}
                disabled={!canSend}
                title="Enviar mensaje"
                aria-label="Enviar mensaje"
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </form>
        {stopError !== null && (
          <p className="composer-note composer-aviso" role="status">
            {stopError}
          </p>
        )}
        {!showWelcome && (
          <div className="composer-meta">
            <span className="composer-hint" aria-hidden="true">
              {preferencias.enterEnvia
                ? 'Enter para enviar · Shift+Enter salto de línea'
                : 'Ctrl / ⌘ + Enter para enviar · Enter salto de línea'}
            </span>
            <p className="composer-note">{PRICE_NOTE}</p>
          </div>
        )}
      </div>

      {showWelcome && (
        <div className="empty-tail">
          <WelcomeSuggestions onPick={fillDraft} disabled={isStreaming} />
          <p className="composer-note empty-note">{PRICE_NOTE}</p>
        </div>
      )}
    </main>
  );
}
