// La ficha de un documento. La usan el panel de documentos y la vista de
// todos, así que vive aquí y no dentro de ninguno de los dos.
//
// Por qué una ficha y no una fila de tabla: quien mira esto es una médica
// buscando una fuente, y lo que reconoce es "Silva-Rodríguez et al., 2026", no
// "PMC13390017.pdf". La ficha invierte la jerarquía de un gestor de archivos:
//
//   Silva-Rodríguez et al., 2026        ← la cita: la identidad
//   Prognostic value of plasma %p-tau…  ← el título: qué es
//   ▇▇▇▇▅ 52 fragmentos · 12 págs · hoy ← el peso: cuánto sostiene
//   PMC13390017.pdf                     ← el fichero: el dato administrativo
//
// Dos decisiones que conviene no re-litigar:
//
// - **"Listo" no lleva insignia.** Estaba en el 100 % de los documentos, así
//   que no informaba de nada y a cambio se llevaba el peso visual que debe
//   tener lo anómalo. Lo que ocupa ese sitio ahora es la BARRA DE PESO, que sí
//   dice algo distinto en cada documento. Procesando y error sí llevan
//   insignia, porque son la excepción.
//
// - **Las acciones se revelan al pasar por encima o al enfocar con el
//   teclado.** Una papelera permanente en cada ficha es ruido y un clic de más
//   cerca del desastre. En pantallas sin puntero (`hover: none`) están siempre
//   visibles, porque ahí no hay "pasar por encima".
import type { KeyboardEvent } from 'react';
import { cifra, fechaCorta, formatoDe, identidadDe, pesoRelativo } from '../lib/biblioteca';
import { fuenteDe } from '../lib/origenes';
import { fraccionDeProgreso, textoDeProgreso } from '../lib/progresoIngesta';
import type { RetraccionDocumento, DocumentInfo } from '../types';
import { IconAlert, IconCheck, IconRefresh, IconSpinner, IconTrash } from './icons';

interface FichaDocumentoProps {
  doc: DocumentInfo;
  /** El documento con más fragmentos del corpus, para escalar la barra. */
  maximo: number;
  borrando: boolean;
  reindexando: boolean;
  /** Confirmación de borrado abierta en ESTA ficha. */
  confirmando: boolean;
  /** Detalle del error desplegado. */
  errorAbierto: boolean;
  /** Acaba de pasar a "listo": destella una vez. */
  destella: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
  onBorrar: () => void;
  onReindexar: () => void;
  onAlternarError: () => void;
  /** Mensaje de error de una acción sobre esta fila (borrar, reindexar). */
  errorDeFila?: string;
}

/** El aviso de un documento listo con partes sin leer, en llano y en una
 *  frase: "3 páginas sin leer", "texto recortado en 2 fragmentos". */
export function textoDeAvisos(a: NonNullable<DocumentInfo['avisos']>): string {
  const partes: string[] = [];
  if (a.sinLeer > 0) partes.push(`${cifra(a.sinLeer)} ${a.sinLeer === 1 ? 'página o imagen sin leer' : 'páginas o imágenes sin leer'}`);
  if (a.omitidas > 0) partes.push(`${cifra(a.omitidas)} ${a.omitidas === 1 ? 'imagen no leída por el tope' : 'imágenes no leídas por el tope'}`);
  if (a.recortados > 0) partes.push(`texto recortado en ${cifra(a.recortados)} ${a.recortados === 1 ? 'fragmento' : 'fragmentos'}`);
  // Sin la frase de contexto, el fragmento se encuentra algo peor. Se dice en
  // términos de lo que nota la usuaria (la búsqueda), no de cómo se indexa.
  if (a.sinContexto > 0) {
    partes.push(
      `${cifra(a.sinContexto)} ${a.sinContexto === 1 ? 'fragmento se buscará' : 'fragmentos se buscarán'} con menos precisión`,
    );
  }
  return partes.join(' · ');
}

/** "Artículo retractado", "Artículo retirado" o "Expresión de preocupación de
 *  la revista", con la fecha en la versión larga. Nunca un código ni un DOI:
 *  quien lee es una médica. */
export function textoDeRetraccion(r: RetraccionDocumento, larga = false): string {
  const base =
    r.tipo === 'retractado'
      ? 'Artículo retractado'
      : r.tipo === 'retirado'
        ? 'Artículo retirado por la revista'
        : 'Expresión de preocupación de la revista';
  if (!larga) return base;
  const fecha = r.fecha ? ` (${r.fecha})` : '';
  return `${base}${fecha}. Según el registro de la revista, este artículo no vale como evidencia; el asistente lo dirá si lo cita.`;
}

/** Fecha completa para el `title`: la ficha enseña "hoy", el navegador el
 *  detalle si alguien se para encima. */
function fechaLarga(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : `Indexado el ${d.toLocaleString('es')}`;
}

export function FichaDocumento({
  doc,
  maximo,
  borrando,
  reindexando,
  confirmando,
  errorAbierto,
  destella,
  onConfirmar,
  onCancelar,
  onBorrar,
  onReindexar,
  onAlternarError,
  errorDeFila,
}: FichaDocumentoProps) {
  const formato = formatoDe(doc.fileName);
  const { principal, secundaria, fichero } = identidadDe(doc);
  // De qué fuente llegó (Notion, Google Drive, OneDrive), o null si se subió a mano.
  const fuente = fuenteDe(doc.origen);
  const listo = doc.status === 'ready';
  const peso = listo ? pesoRelativo(doc.chunks, maximo) : 0;

  // Escape cierra la confirmación antes de que el panel la entienda como
  // "cerrar el panel".
  const alPulsarTecla = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Escape' && confirmando) {
      e.stopPropagation();
      onCancelar();
    }
  };

  return (
    <li
      className={`ficha ficha-${formato.familia} ${destella ? 'ficha-destella' : ''}`}
      onKeyDown={alPulsarTecla}
    >
      <div className="ficha-cuerpo">
        <span className="ficha-sigla" aria-hidden="true">
          {formato.sigla}
        </span>

        <div className="ficha-texto">
          <p className="ficha-principal" title={principal}>
            {principal}
          </p>
          {secundaria !== '' && <p className="ficha-secundaria">{secundaria}</p>}

          <div className="ficha-meta">
            {listo ? (
              <>
                {/* La barra es el estado "listo" y, a la vez, cuánta evidencia
                    aporta este documento comparado con el que más aporta. */}
                <span
                  className="ficha-peso"
                  title={`${cifra(doc.chunks)} fragmentos de los ${cifra(maximo)} del documento que más aporta`}
                >
                  <span className="ficha-peso-riel">
                    <span className="ficha-peso-relleno" style={{ transform: `scaleX(${peso})` }} />
                  </span>
                  {cifra(doc.chunks)} {doc.chunks === 1 ? 'fragmento' : 'fragmentos'}
                </span>
                {doc.pages > 0 && (
                  <span className="ficha-dato">
                    {cifra(doc.pages)} {doc.pages === 1 ? 'pág.' : 'págs.'}
                  </span>
                )}
                {/* Listo, pero no del todo: lo que la ingesta no pudo leer se
                    dice aquí, con el motivo al desplegar, y el botón de
                    reintentar al lado. Antes un escaneo con 39 de 40 páginas
                    sin leer se veía igual que uno perfecto. */}
                {doc.avisos !== null && (
                  <button
                    type="button"
                    className="ficha-insignia ficha-insignia-aviso"
                    onClick={onAlternarError}
                    aria-expanded={errorAbierto}
                    title={doc.avisos.motivo ?? 'Parte del documento no se pudo leer'}
                  >
                    <IconAlert size={11} />
                    {textoDeAvisos(doc.avisos)}
                  </button>
                )}
                {/* Lo que dice la revista del artículo (Crossref): retractado,
                    retirado o con expresión de preocupación. Sigue indexado
                    (se puede preguntar qué decía), pero no vale como evidencia
                    y hay que verlo antes de preguntar nada. */}
                {doc.retraccion !== null && (
                  <span
                    className={`ficha-insignia ${doc.retraccion.tipo === 'preocupacion' ? 'ficha-insignia-aviso' : 'ficha-insignia-retractado'}`}
                    role="status"
                    title={textoDeRetraccion(doc.retraccion, true)}
                  >
                    <IconAlert size={11} />
                    {textoDeRetraccion(doc.retraccion)}
                  </span>
                )}
              </>
            ) : doc.status === 'processing' ? (
              <span className="ficha-insignia ficha-insignia-proceso" role="status">
                <IconSpinner size={11} />
                <span className="shimmer-text">{doc.progreso ? textoDeProgreso(doc.progreso) : 'Indexando'}</span>
              </span>
            ) : (
              <button
                type="button"
                className="ficha-insignia ficha-insignia-error"
                onClick={onAlternarError}
                aria-expanded={errorAbierto}
                title={doc.error ?? 'Error durante la indexación'}
              >
                <IconAlert size={11} />
                No se pudo leer
              </button>
            )}
            {fuente !== null && (
              <span className="ficha-dato ficha-notion" title={`Llegó desde tu ${fuente.nombre}`}>
                <img src={fuente.icono} alt="" width={11} height={11} />
                {fuente.nombre}
              </span>
            )}
            <span className="ficha-dato ficha-fecha" title={fechaLarga(doc.ingestadoEn)}>
              {fechaCorta(doc.ingestadoEn)}
            </span>
          </div>

          {fichero !== '' && <p className="ficha-fichero">{fichero}</p>}

          {/* La barra de la ingesta en marcha: fase, cuánto va de cuánto y lo
              que falta (lib/progresoIngesta.ts). Un documento grande tarda, y
              lo que no puede pasar es que parezca colgado. */}
          {doc.status === 'processing' && doc.progreso !== null && (
            <div className="upload-bar ficha-progreso" aria-hidden="true">
              {fraccionDeProgreso(doc.progreso) === null ? (
                <div className="upload-fill upload-fill-indeterminate" />
              ) : (
                <div className="upload-fill" style={{ transform: `scaleX(${fraccionDeProgreso(doc.progreso)})` }} />
              )}
            </div>
          )}
        </div>

        <div className="ficha-acciones">
          {confirmando ? (
            <span className="ficha-confirmar" role="group" aria-label={`Confirmar borrado de ${doc.fileName}`}>
              <span>¿Borrar?</span>
              <button type="button" className="doc-confirm-btn doc-confirm-yes" onClick={onBorrar}>
                Sí
              </button>
              <button
                type="button"
                className="doc-confirm-btn doc-confirm-no"
                onClick={onCancelar}
                autoFocus
              >
                No
              </button>
            </span>
          ) : (
            <>
              {/* Reintentar va antes de la papelera a propósito: ante un error
                  es la acción esperada, y borrar la de último recurso. */}
              {(doc.status === 'failed' || (listo && doc.avisos !== null)) && (
                <button
                  type="button"
                  className="doc-action-btn ficha-accion"
                  disabled={reindexando}
                  onClick={onReindexar}
                  title={doc.status === 'failed' ? 'Volver a intentar la indexación' : 'Volver a leer lo que quedó sin leer'}
                  aria-label={`Volver a intentar la indexación de ${doc.fileName}`}
                >
                  {reindexando ? <IconSpinner size={14} /> : <IconRefresh size={14} />}
                </button>
              )}
              {borrando ? (
                <span className="doc-lock" role="status" aria-label={`Borrando ${doc.fileName}`}>
                  <IconSpinner size={14} />
                </span>
              ) : (
                <button
                  type="button"
                  className="doc-action-btn ficha-accion"
                  onClick={onConfirmar}
                  title="Quitar de tus documentos"
                  aria-label={`Quitar ${doc.fileName} de tus documentos`}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {errorAbierto && doc.error !== null && (
        <p className="ficha-error-detalle">{doc.error}</p>
      )}
      {errorAbierto && listo && doc.avisos !== null && (
        <p className="ficha-error-detalle ficha-aviso-detalle">
          {doc.avisos.motivo ?? 'Parte del documento no se pudo leer.'} Lo que sí se leyó se puede
          consultar; con el botón de reintentar se vuelve a leer lo que faltó.
        </p>
      )}
      {errorDeFila !== undefined && (
        <p className="ficha-error-detalle" role="alert">
          {errorDeFila}
        </p>
      )}
      {destella && (
        <span className="ficha-listo-flash" aria-hidden="true">
          <IconCheck size={11} />
        </span>
      )}
    </li>
  );
}
