import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CitationRef } from '../lib/markdown';
import type { ChatMessage } from '../types';
import { IconArrowUp, IconStop } from './icons';
import { MessageItem } from './MessageItem';
import { WelcomeIntro, WelcomeSuggestions } from './Welcome';

interface ChatProps {
  messages: ChatMessage[];
  loadingMessages: boolean;
  isStreaming: boolean;
  panelTargetId: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onFeedback: (msg: ChatMessage, rating: 1 | -1) => void;
  onCitation: (msgLocalId: string, ref: CitationRef) => void;
  onShowSources: (msgLocalId: string) => void;
}

/** ~8 líneas de texto (15px · 1.5) + padding vertical del textarea. */
const MAX_TEXTAREA_HEIGHT = 204;

/** Aviso de precios: mismo texto bajo las píldoras y bajo el composer. */
const PRICE_NOTE =
  'Las respuestas provienen de los catálogos indexados y pueden contener errores. Verifica precios antes de cotizar.';

export function Chat({
  messages,
  loadingMessages,
  isStreaming,
  panelTargetId,
  onSend,
  onStop,
  onFeedback,
  onCitation,
  onShowSources,
}: ChatProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  // Ventana durante la cual el scroll suave programático está en curso: sus
  // eventos de scroll intermedios no deben des-fijar el auto-stick.
  const smoothUntilRef = useRef(0);

  // Autoscroll mientras llegan tokens, salvo que el usuario haya subido.
  // Suave solo en saltos discretos (nuevo par de mensajes); durante el goteo
  // de tokens el ajuste directo ya se percibe continuo y no pelea con el
  // animador de scroll del navegador.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevCount = prevCountRef.current;
    prevCountRef.current = messages.length;
    if (!stickToBottomRef.current) return;

    const listGrew = prevCount > 0 && messages.length > prevCount;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (listGrew && !reduceMotion) {
      smoothUntilRef.current = Date.now() + 700;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

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
      if (el) {
        el.style.height = 'auto';
        el.focus();
      }
    });
  };

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
    if (e.nativeEvent.isComposing || e.key === 'Process') return;
    if (e.key === 'Enter' && !e.shiftKey) {
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

        {showWelcome && <WelcomeIntro />}

        {!loadingMessages && messages.length > 0 && (
          <div className="message-list">
            {messages.map((m) => (
              <MessageItem
                key={m.localId}
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
            placeholder="Pregunta sobre los catálogos…"
            aria-label="Escribe tu pregunta"
            onChange={(e) => {
              setDraft(e.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || loadingMessages}
          />
          {isStreaming ? (
            <button
              type="button"
              className="send-btn send-stop"
              onClick={onStop}
              title="Detener la generación"
              aria-label="Detener la generación"
            >
              <IconStop />
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
        </form>
        {!showWelcome && (
          <div className="composer-meta">
            <span className="composer-hint" aria-hidden="true">
              Enter para enviar · Shift+Enter salto de línea
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
