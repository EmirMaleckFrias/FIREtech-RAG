import { useState } from 'react';
import { Markdown, type CitationRef } from '../lib/markdown';
import type { ChatMessage } from '../types';
import {
  IconAlert,
  IconChevronDown,
  IconDocument,
  IconSearch,
  IconSpinner,
  IconThumbDown,
  IconThumbUp,
} from './icons';

interface MessageItemProps {
  msg: ChatMessage;
  isPanelTarget: boolean;
  onFeedback: (msg: ChatMessage, rating: 1 | -1) => void;
  onCitation: (msgLocalId: string, ref: CitationRef) => void;
  onShowSources: (msgLocalId: string) => void;
}

export function MessageItem({
  msg,
  isPanelTarget,
  onFeedback,
  onCitation,
  onShowSources,
}: MessageItemProps) {
  // Expansión manual del razonamiento una vez colapsado (post-streaming).
  const [hopsOpen, setHopsOpen] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-user-bubble">{msg.content}</div>
      </div>
    );
  }

  const thinking = msg.streaming && msg.content === '';
  const showHops = msg.streaming || hopsOpen;

  return (
    <div className={`msg msg-assistant ${isPanelTarget ? 'msg-panel-target' : ''}`}>
      <div className="msg-avatar" aria-hidden="true">
        F
      </div>

      <div className="msg-body">
        {/*
          Razonamiento del agente: un único elemento que muta de tarjeta en
          vivo a resumen colapsado, para que la altura colapse con una
          transición (grid-template-rows 1fr→0fr) en vez de saltar.
        */}
        {msg.hops.length > 0 && (
          <div className={`reasoning ${msg.streaming ? 'reasoning-live' : 'reasoning-done'}`}>
            {msg.streaming ? (
              <div className="reasoning-head">
                <IconSpinner size={13} />
                <span className="shimmer-text">Buscando en los documentos…</span>
              </div>
            ) : (
              <button
                type="button"
                className="reasoning-toggle"
                aria-expanded={hopsOpen}
                onClick={() => setHopsOpen((v) => !v)}
              >
                <IconSearch size={12} />
                <span>
                  {msg.hops.length}{' '}
                  {msg.hops.length === 1 ? 'búsqueda realizada' : 'búsquedas realizadas'}
                </span>
                <IconChevronDown size={13} className="reasoning-chevron" />
              </button>
            )}
            <div
              className={`reasoning-body ${showHops ? 'reasoning-body-open' : ''}`}
              aria-hidden={!showHops}
            >
              <div className="reasoning-clip">
                <div className="reasoning-steps">
                  {msg.hops.map((h, idx) => (
                    <div
                      key={`${h.n}-${h.query}`}
                      className="reasoning-step"
                      style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}
                    >
                      <IconSearch size={12} />
                      <code className="reasoning-query">{h.query}</code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {thinking && msg.hops.length === 0 && (
          <div className="thinking">
            <IconSpinner size={13} />
            <span className="shimmer-text">Pensando…</span>
          </div>
        )}

        {msg.content !== '' && (
          <div className={`msg-content ${msg.streaming ? 'msg-streaming' : ''}`}>
            <Markdown
              text={msg.content}
              onCitation={(ref) => onCitation(msg.localId, ref)}
              tail={
                msg.streaming ? (
                  <span className="caret stream-caret" aria-hidden="true" />
                ) : undefined
              }
            />
          </div>
        )}

        {msg.error !== null && (
          <div className="msg-error">
            <IconAlert size={15} />
            <span>{msg.error}</span>
          </div>
        )}

        {!msg.streaming && (msg.id !== null || msg.sources.length > 0) && (
          <div className={`msg-footer ${msg.feedback !== null ? 'msg-footer-voted' : ''}`}>
            {msg.sources.length > 0 && (
              <button
                type="button"
                className="sources-count-btn"
                onClick={() => onShowSources(msg.localId)}
                title="Ver las fuentes de esta respuesta en el panel derecho"
              >
                <IconDocument size={12} />
                {msg.sources.length} {msg.sources.length === 1 ? 'fuente' : 'fuentes'}
              </button>
            )}
            {msg.id !== null && (
              <div className="feedback">
                <button
                  type="button"
                  className={`feedback-btn ${msg.feedback === 1 ? 'feedback-active' : ''}`}
                  title="Respuesta útil"
                  aria-label="Marcar respuesta como útil"
                  aria-pressed={msg.feedback === 1}
                  disabled={msg.feedback !== null}
                  onClick={() => onFeedback(msg, 1)}
                >
                  <IconThumbUp size={15} filled={msg.feedback === 1} />
                </button>
                <button
                  type="button"
                  className={`feedback-btn ${msg.feedback === -1 ? 'feedback-active' : ''}`}
                  title="Respuesta no útil"
                  aria-label="Marcar respuesta como no útil"
                  aria-pressed={msg.feedback === -1}
                  disabled={msg.feedback !== null}
                  onClick={() => onFeedback(msg, -1)}
                >
                  <IconThumbDown size={15} filled={msg.feedback === -1} />
                </button>
                {msg.feedback !== null && <span className="feedback-thanks">Gracias</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
