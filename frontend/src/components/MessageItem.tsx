import { useMemo, useState } from 'react';
import { filasCobertura } from '../lib/cobertura';
import { Markdown, type CitationRef } from '../lib/markdown';
import { puntosDelPlan } from '../lib/mensajes';
import type { ChatMessage } from '../types';
import { CoberturaPregunta, PlanEnVivo } from './Cobertura';
import { LineaDeTiempo, ResumenPasos } from './Pasos';
import {
  IconAlert,
  IconChevronDown,
  IconDocument,
  IconSearch,
  IconThumbDown,
  IconThumbUp,
} from './icons';
import { VerificationBadge } from './VerificationBadge';

interface MessageItemProps {
  msg: ChatMessage;
  isPanelTarget: boolean;
  onFeedback: (msg: ChatMessage, rating: 1 | -1) => void;
  /** Guardar la valoración falló: se dice al lado de los pulgares. */
  feedbackError?: string;
  onCitation: (msgLocalId: string, ref: CitationRef) => void;
  onShowSources: (msgLocalId: string) => void;
}

export function MessageItem({
  msg,
  isPanelTarget,
  onFeedback,
  onCitation,
  onShowSources,
  feedbackError,
}: MessageItemProps) {
  // Expansión manual del razonamiento una vez colapsado (turno cerrado).
  const [hopsOpen, setHopsOpen] = useState(false);

  // Cobertura al terminar: del informe del verificador si lo hay, si no de
  // los hops persistidos. Vacia en mensajes antiguos y con el pipeline
  // apagado, y entonces no se pinta nada: la vista queda como antes.
  const filas = useMemo(
    () => filasCobertura(msg.plan, msg.hops, msg.verificacion?.cobertura),
    [msg.plan, msg.hops, msg.verificacion],
  );

  if (msg.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-user-bubble">{msg.content}</div>
      </div>
    );
  }

  // `streaming` es "el turno sigue en curso": el agente escribe el avance en
  // la fila del mensaje y esta vista se vuelve a pintar con cada cambio. El
  // texto llega de golpe al pasar a `listo`, asi que mientras no llega el
  // bloque de razonamiento y la fase son lo unico que se mueve.
  const enCurso = msg.streaming;
  const showHops = enCurso || hopsOpen;
  // Modo normal (plan = [e0], la pregunta literal) NO tiene "partes de la
  // pregunta": se ensena la consulta lanzada, como siempre. La vista por
  // puntos aparece solo cuando el planificador dividio la pregunta.
  const variasPartes = puntosDelPlan(msg.plan).length > 0;
  // Con plan, el bloque de razonamiento existe desde que llega el plan (antes
  // del primer hop) y en vivo muestra los puntos con su estado en vez de la
  // lista cruda de consultas.
  // En curso se enseña desde el primer instante: los pasos (entender, buscar,
  // redactar, comprobar) van apareciendo según ocurren, aunque aún no haya
  // ninguna búsqueda. Cerrado, solo si hubo búsquedas que contar.
  const mostrarRazonamiento = enCurso || msg.hops.length > 0;

  return (
    <div className={`msg msg-assistant ${isPanelTarget ? 'msg-panel-target' : ''}`}>
      {/* El árbol de marca va como fondo en CSS: es decoración, no
          contenido, y así no entra en el árbol de accesibilidad. */}
      <div className="msg-avatar" aria-hidden="true" />

      <div className="msg-body">
        {/*
          Razonamiento del agente: un único elemento que muta de tarjeta en
          vivo a resumen colapsado, para que la altura colapse con una
          transición (grid-template-rows 1fr→0fr) en vez de saltar.
        */}
        {mostrarRazonamiento && (
          <div className={`reasoning ${enCurso ? 'reasoning-live' : 'reasoning-done'}`}>
            {/* En vivo, la fase la dice la propia línea de tiempo (el paso en
                curso lleva el spinner y el texto en movimiento): una cabecera
                encima repetía "Redactando" dos veces seguidas. */}
            {enCurso ? null : (
              <button
                type="button"
                className="reasoning-toggle"
                aria-expanded={hopsOpen}
                onClick={() => setHopsOpen((v) => !v)}
                title="Ver los pasos de esta respuesta"
              >
                <IconSearch size={12} />
                <ResumenPasos msg={msg} />
                <IconChevronDown size={13} className="reasoning-chevron" />
              </button>
            )}
            <div
              className={`reasoning-body ${showHops ? 'reasoning-body-open' : ''}`}
              aria-hidden={!showHops}
            >
              <div className="reasoning-clip">
                {/* Los pasos del turno (lib/pasos.ts). Con varias partes, el
                    plan en vivo cuelga del paso de buscar; si no, cada
                    búsqueda es una fila de herramienta con sus documentos. */}
                <LineaDeTiempo
                  msg={msg}
                  enCurso={enCurso}
                  cuerpoBusqueda={
                    enCurso && variasPartes ? (
                      <PlanEnVivo plan={msg.plan} hops={msg.hops} enCurso={enCurso} />
                    ) : undefined
                  }
                />
              </div>
            </div>
          </div>
        )}

        {msg.content !== '' && (
          <div className="msg-content">
            <Markdown text={msg.content} onCitation={(ref) => onCitation(msg.localId, ref)} />
          </div>
        )}

        {msg.error !== null && (
          <div className="msg-error">
            <IconAlert size={15} />
            <span>{msg.error}</span>
          </div>
        )}

        {/* Cobertura de la pregunta: que partes tienen evidencia y cuales no
            estan en los documentos. Va antes del informe de atribucion porque
            responde a la pregunta mas basica ("¿se busco todo lo que pedi?")
            y el informe a la mas fina ("¿cada frase esta sostenida?"). */}
        {!enCurso && <CoberturaPregunta filas={filas} />}

        {/* Informe de atribución. Solo con la respuesta cerrada: el veredicto
            llega con el texto, en el mismo cambio de estado. */}
        {!enCurso && msg.verificacion !== null && (
          <VerificationBadge informe={msg.verificacion} />
        )}

        {!enCurso && (msg.id !== null || msg.sources.length > 0) && (
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
                {feedbackError !== undefined && msg.feedback === null && (
                  <span className="feedback-error" role="status">
                    {feedbackError}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
