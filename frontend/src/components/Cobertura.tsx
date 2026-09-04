// Cobertura de la pregunta: que partes se buscaron, cuales tienen evidencia y
// en que documentos, cuales no estan en los documentos y cuales no se
// pudieron comprobar.
//
// Dos vistas del mismo plan:
// - PlanEnVivo, dentro del bloque de razonamiento mientras el turno esta en
//   curso: cada punto pasa de pendiente a buscando y a encontrado / sin
//   resultados / no comprobado segun el agente escribe los hops. Las
//   busquedas que decide el modelo por su cuenta (origen extra) se listan
//   aparte; si ademas declaran un punto del plan, actualizan la fila de ese
//   punto.
// - CoberturaPregunta, al terminar: una fila por punto con el estado en
//   lenguaje claro y los documentos. Sin ids internos: a la medica "e2" no le
//   dice nada; "biomarcadores en LCR" si.
//
// Lo que NO se afirma: un punto cuyo hop trajo fragmentos pero del que nadie
// dijo si la respuesta los uso se pinta como "evidencia encontrada", no como
// "respondido". La diferencia es justo lo que el verificador existe para
// medir, y aqui no se rellena por defecto. Y una busqueda que fallo se pinta
// "no se pudo comprobar", nunca "no esta en los documentos".

import type { ReactNode } from 'react';
import type { EstadoFila, FilaCobertura } from '../lib/cobertura';
import { ANCLA, hopsPorPunto, trajoEvidencia } from '../lib/cobertura';
import { hopEnCurso } from '../lib/mensajes';
import type { Hop, PlanItem } from '../types';
import {
  IconAlert,
  IconCheck,
  IconCircle,
  IconCircleHalf,
  IconMinusCircle,
  IconSearch,
  IconSpinner,
} from './icons';

/** Cuantos documentos se listan antes de resumir con "y N mas". */
const MAX_DOCS = 3;

/** Texto y clase de cada estado. La clase decide el color via tokens del
 *  tema (--green / --amber / --text-3); no hay colores fijos. */
const ESTILO: Record<EstadoFila, { etiqueta: string; clase: string; icono: ReactNode }> = {
  cubierto: {
    etiqueta: 'Respondido con evidencia',
    clase: 'cob-ok',
    icono: <IconCheck size={13} />,
  },
  parcial: {
    etiqueta: 'Respondido parcialmente',
    clase: 'cob-parcial',
    icono: <IconCircleHalf size={13} />,
  },
  evidencia_no_usada: {
    etiqueta: 'Habia evidencia y la respuesta no la uso',
    clase: 'cob-aviso',
    icono: <IconAlert size={13} />,
  },
  sin_resultados: {
    etiqueta: 'No esta en los documentos',
    clase: 'cob-ausente',
    icono: <IconMinusCircle size={13} />,
  },
  error_busqueda: {
    etiqueta: 'No se pudo comprobar',
    clase: 'cob-aviso',
    icono: <IconAlert size={13} />,
  },
  encontrada: {
    etiqueta: 'Evidencia encontrada, uso sin comprobar',
    clase: 'cob-neutro',
    icono: <IconSearch size={13} />,
  },
  no_buscado: {
    etiqueta: 'No se llego a buscar',
    clase: 'cob-ausente',
    icono: <IconCircle size={13} />,
  },
};

/** "Allegri et al., 2023, Zhang et al., 2021 y 2 mas". Sin duplicados. */
export function resumenDocumentos(documentos: string[]): string {
  const unicos = [...new Set(documentos.map((d) => d.trim()).filter((d) => d !== ''))];
  if (unicos.length === 0) return '';
  if (unicos.length <= MAX_DOCS) return unicos.join(', ');
  const resto = unicos.length - MAX_DOCS;
  return `${unicos.slice(0, MAX_DOCS).join(', ')} y ${resto} mas`;
}

function fragmentos(n: number): string {
  return `${n} ${n === 1 ? 'fragmento' : 'fragmentos'}`;
}

/* ------------------------------ en vivo ---------------------------------- */

interface PlanEnVivoProps {
  plan: PlanItem[];
  hops: Hop[];
  /** El turno sigue abierto: un hop marcador (ver hopEnCurso) es "buscando". */
  enCurso: boolean;
}

type EstadoVivo = 'pendiente' | 'buscando' | 'encontrado' | 'sin_resultados' | 'error';

/** Estado en vivo de un punto a partir del hop que lo representa.
 *
 *  Los hops del plan llegan todos a la vez, ya cerrados, cuando termina la
 *  busqueda paralela: hasta entonces el punto esta pendiente. Un hop extra
 *  que declara el punto entra como marcador antes de buscar (buscando) y se
 *  completa al terminar. */
function estadoVivo(h: Hop | undefined, buscandoAhora: boolean): EstadoVivo {
  if (buscandoAhora) return 'buscando';
  if (!h) return 'pendiente';
  if (trajoEvidencia(h)) return 'encontrado';
  if (h.recuperacion === 'error') return 'error';
  if (h.estado === 'sin_resultados' || typeof h.resultados === 'number') return 'sin_resultados';
  return 'buscando';
}

export function PlanEnVivo({ plan, hops, enCurso }: PlanEnVivoProps) {
  const porPunto = hopsPorPunto(hops);
  const puntos = plan.filter((p) => p.id !== ANCLA);
  // Puntos con una busqueda extra todavia en marcha.
  const buscando = new Set(
    hops.filter((h) => h.plan_item && hopEnCurso(h, enCurso)).map((h) => h.plan_item),
  );
  // Extra: las que el modelo decidio por su cuenta. Un hop antiguo sin
  // `origen` tambien cae aqui: no se puede atribuir a ningun punto.
  const extra = hops.filter((h) => h.origen !== 'plan');

  return (
    <div className="plan-live">
      {puntos.length > 0 && (
        <ol className="plan-list">
          {puntos.map((p) => {
            const h = porPunto.get(p.id);
            const estado = estadoVivo(h, buscando.has(p.id));
            const docs = h ? resumenDocumentos(h.documentos ?? []) : '';
            return (
              <li key={p.id} className={`plan-item plan-${estado}`}>
                <span className="plan-icon" aria-hidden="true">
                  {estado === 'buscando' && <IconSpinner size={12} />}
                  {estado === 'pendiente' && <IconCircle size={12} />}
                  {estado === 'encontrado' && <IconCheck size={12} />}
                  {estado === 'sin_resultados' && <IconMinusCircle size={12} />}
                  {estado === 'error' && <IconAlert size={12} />}
                </span>
                <span className="plan-text">
                  <span className="plan-need">{p.evidence_needed || p.query}</span>
                  <span className="plan-detail">
                    {estado === 'pendiente' && 'pendiente'}
                    {estado === 'buscando' && 'buscando'}
                    {estado === 'encontrado' &&
                      h &&
                      [
                        typeof h.resultados === 'number' ? fragmentos(h.resultados) : 'encontrado',
                        docs,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    {estado === 'sin_resultados' && 'sin resultados'}
                    {estado === 'error' && 'no se pudo comprobar'}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {extra.length > 0 && (
        <div className="plan-extra">
          <span className="plan-extra-label">
            {extra.length === 1 ? 'Busqueda adicional' : 'Busquedas adicionales'}
          </span>
          {extra.map((h) => (
            <div key={`${h.n}-${h.query}`} className="reasoning-step">
              {hopEnCurso(h, enCurso) ? <IconSpinner size={12} /> : <IconSearch size={12} />}
              <code className="reasoning-query">{h.query}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ al terminar ------------------------------- */

interface CoberturaPreguntaProps {
  filas: FilaCobertura[];
}

export function CoberturaPregunta({ filas }: CoberturaPreguntaProps) {
  if (filas.length === 0) return null;
  return (
    <section className="cob" aria-label="Cobertura de la pregunta">
      <h3 className="cob-titulo">Cobertura de la pregunta</h3>
      <ul className="cob-lista">
        {filas.map((f) => {
          const estilo = ESTILO[f.estado];
          const docs = resumenDocumentos(f.documentos);
          const detalle = [
            estilo.etiqueta,
            f.estado !== 'sin_resultados' &&
            f.estado !== 'no_buscado' &&
            f.estado !== 'error_busqueda' &&
            f.n_fragmentos > 0
              ? fragmentos(f.n_fragmentos)
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={f.id} className={`cob-fila ${estilo.clase}`}>
              <span className="cob-icono" aria-hidden="true">
                {estilo.icono}
              </span>
              <span className="cob-cuerpo">
                <span className="cob-need">{f.evidence_needed || f.id}</span>
                <span className="cob-estado">{detalle}</span>
                {docs !== '' && (
                  <span className="cob-docs" title={f.documentos.join('\n')}>
                    {docs}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
