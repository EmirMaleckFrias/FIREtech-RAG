// La línea de tiempo del turno del asistente: los pasos con nombre (entender,
// buscar, redactar, comprobar), cada búsqueda como una fila de herramienta
// con sus documentos en monedas y su recuento, y al terminar un resumen de
// una línea. Ver lib/pasos.ts para la lógica; aquí solo se pinta.
//
// Qué se ha copiado, deliberadamente, de los asistentes agénticos: el paso
// tiene un título corto y un icono; la herramienta tiene icono, nombre, un
// separador vertical y su meta (aquí, las monedas de los documentos y los
// fragmentos); lo que cuelga de un paso va anidado bajo una misma línea
// vertical, con una viñeta que dice qué se buscaba. Lo que NO se ha copiado:
// nada de esto sustituye al plan en vivo ni a la cobertura, que siguen
// donde estaban; esto los envuelve.
import type { ReactNode } from 'react';
import { hopEnCurso, hopFallido } from '../lib/mensajes';
import { ANCLA, parcial } from '../lib/cobertura';
import {
  MAX_MONEDAS,
  formatearDuracion,
  monedasDe,
  pasosDelTurno,
  resumenDelTurno,
  type Paso,
} from '../lib/pasos';
import type { ChatMessage, Hop, Source } from '../types';
import { IconBulb, IconCheck, IconPen, IconSearch, IconShieldCheck, IconSpinner } from './icons';

/** Los documentos de una búsqueda como monedas: hasta MAX_MONEDAS con la
 *  sigla de su formato en su color, y "+N" para el resto. */
export function Monedas({ referencias, sources }: { referencias: string[]; sources: Source[] }) {
  const monedas = monedasDe(referencias, sources);
  if (monedas.length === 0) return null;
  const visibles = monedas.slice(0, MAX_MONEDAS);
  const resto = monedas.length - visibles.length;
  return (
    <span className="monedas" aria-label={`Documentos: ${monedas.map((m) => m.ref).join(', ')}`}>
      {visibles.map((m) => (
        <span
          key={m.ref}
          className={`moneda ${m.familia !== null ? `moneda-${m.familia}` : 'moneda-neutra'}`}
          title={m.ref}
        >
          {m.sigla}
        </span>
      ))}
      {resto > 0 && <span className="moneda moneda-resto">+{resto}</span>}
    </span>
  );
}

function IconoDePaso({ clave, estado }: { clave: Paso['clave']; estado: Paso['estado'] }) {
  if (estado === 'en_curso') return <IconSpinner size={13} />;
  if (estado === 'hecho' && clave !== 'entender') return <IconCheck size={13} />;
  switch (clave) {
    case 'entender':
      return <IconBulb size={13} />;
    case 'buscar':
      return <IconSearch size={13} />;
    case 'redactar':
      return <IconPen size={13} />;
    case 'comprobar':
      return <IconShieldCheck size={13} />;
  }
}

/** Una búsqueda como fila de herramienta: icono, "Búsqueda", separador, las
 *  monedas de sus documentos y el recuento; debajo, qué se buscaba. */
export function FilaBusqueda({ hop, sources, enCurso }: { hop: Hop; sources: Source[]; enCurso: boolean }) {
  const buscando = hopEnCurso(hop, enCurso);
  const fallo = hopFallido(hop, enCurso);
  const n = hop.resultados;
  let meta: string | null = null;
  if (buscando) meta = 'buscando';
  else if (fallo) meta = 'no se pudo comprobar';
  else if (parcial(hop)) meta = 'búsqueda incompleta, sin resultados';
  else if (typeof n === 'number') meta = n === 0 ? (hop.estado === 'cubierto' ? null : 'sin resultados') : `${n} ${n === 1 ? 'fragmento' : 'fragmentos'}`;
  const duracion = typeof hop.ms === 'number' && hop.ms > 0 && !buscando ? formatearDuracion(hop.ms) : '';
  // Qué se buscaba, como viñeta. No para el ancla (la pregunta literal): su
  // "evidencia necesaria" es una frase interna del planificador, y la
  // consulta ya es la propia pregunta.
  const busca =
    hop.plan_item !== ANCLA &&
    hop.evidence_needed &&
    hop.evidence_needed.trim() !== '' &&
    hop.evidence_needed !== hop.query
      ? hop.evidence_needed
      : '';
  return (
    <li className={`tl-herramienta ${buscando ? 'tl-buscando' : ''} ${fallo ? 'tl-fallo' : ''}`}>
      <div className="tl-fila">
        <span className="tl-icono" aria-hidden="true">
          {buscando ? <IconSpinner size={12} /> : <IconSearch size={12} />}
        </span>
        <span className="tl-nombre">{hop.origen === 'extra' ? 'Búsqueda adicional' : 'Búsqueda'}</span>
        <span className="tl-sep" aria-hidden="true" />
        <code className="tl-consulta" title={hop.query}>
          {hop.query}
        </code>
        {(hop.documentos?.length ?? 0) > 0 && (
          <>
            <span className="tl-sep" aria-hidden="true" />
            <Monedas referencias={hop.documentos ?? []} sources={sources} />
          </>
        )}
        {meta !== null && <span className="tl-meta">{meta}</span>}
        {duracion !== '' && <span className="tl-tiempo">{duracion}</span>}
      </div>
      {busca !== '' && <p className="tl-vineta">{busca}</p>}
    </li>
  );
}

interface LineaDeTiempoProps {
  msg: ChatMessage;
  enCurso: boolean;
  /** Lo que cuelga del paso de buscar: por defecto, una fila por búsqueda.
   *  El plan en vivo (varias partes) se pasa aquí para que quede anidado. */
  cuerpoBusqueda?: ReactNode;
}

/** Los pasos del turno, con lo que cuelga de cada uno. */
export function LineaDeTiempo({ msg, enCurso, cuerpoBusqueda }: LineaDeTiempoProps) {
  const pasos = pasosDelTurno(msg);
  if (pasos.length === 0) return null;
  return (
    <ol className="tl" aria-label="Pasos de la respuesta">
      {pasos.map((p) => (
        <li key={p.clave} className={`tl-paso tl-${p.estado}`}>
          <div className="tl-fila tl-cabecera">
            <span className="tl-icono" aria-hidden="true">
              <IconoDePaso clave={p.clave} estado={p.estado} />
            </span>
            <span className={`tl-titulo ${p.estado === 'en_curso' ? 'shimmer-text' : ''}`}>{p.titulo}</span>
            {p.detalle !== '' && (
              <>
                <span className="tl-sep" aria-hidden="true" />
                <span className="tl-detalle">{p.detalle}</span>
              </>
            )}
          </div>
          {p.clave === 'buscar' && (msg.hops.length > 0 || cuerpoBusqueda !== undefined) && (
            <div className="tl-anidado">
              {cuerpoBusqueda !== undefined ? (
                cuerpoBusqueda
              ) : (
                <ul className="tl-herramientas">
                  {msg.hops.map((h) => (
                    <FilaBusqueda key={`${h.n}-${h.query}`} hop={h} sources={msg.sources} enCurso={enCurso} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** El resumen de una línea de un turno cerrado, con las monedas de sus
 *  documentos: lo que se lee en el botón que despliega los pasos. */
export function ResumenPasos({ msg }: { msg: ChatMessage }) {
  const piezas = resumenDelTurno(msg);
  const docs = msg.hops.flatMap((h) => h.documentos ?? []);
  return (
    <span className="resumen-pasos">
      {piezas.map((p, i) => (
        <span key={p} className="resumen-pieza">
          {i > 0 && <span className="tl-sep" aria-hidden="true" />}
          {p}
        </span>
      ))}
      {docs.length > 0 && (
        <>
          <span className="tl-sep" aria-hidden="true" />
          <Monedas referencias={docs} sources={msg.sources} />
        </>
      )}
    </span>
  );
}
