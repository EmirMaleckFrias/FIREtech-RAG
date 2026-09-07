// Todos los documentos, a pantalla completa: para buscar entre ellos y verlos
// sin scrollear un panel de 560 px.
//
// El panel lateral es la entrada (la forma del corpus, Notion, subir, y las
// fichas de lo último); esto es el archivo. Comparten la ficha
// (FichaDocumento), la banda (BandaCorpus) y el estado (useDocumentos), así
// que aquí solo hay lo propio de una vista de archivo: buscar, filtrar,
// ordenar y decir cuántos quedan.
//
// Se abre sobre todo lo demás y se cierra con Escape o con la X. El foco entra
// en el buscador, que es lo que se viene a hacer aquí, y vuelve al salir a
// donde estaba.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  FORMATOS,
  ORDENES,
  ORDEN_FORMATOS,
  SIN_FILTROS,
  cifra,
  formatoDe,
  hayFiltros,
  listar,
  type FamiliaFormato,
  type Filtros,
  type Orden,
} from '../lib/biblioteca';
import type { Documentos } from '../lib/useDocumentos';
import type { DocumentStatus } from '../types';
import { BandaCorpus } from './BandaCorpus';
import { FichaDocumento } from './FichaDocumento';
import { IconDocument, IconSearch, IconX } from './icons';

interface BibliotecaProps {
  open: boolean;
  onClose: () => void;
  documentos: Documentos;
  /** Estado por el que abrir ya filtrado (al pulsar "3 sin leer" en la banda
   *  del panel). null = sin filtrar. */
  estadoInicial: DocumentStatus | null;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ESTADOS: Array<{ id: DocumentStatus; etiqueta: string }> = [
  { id: 'ready', etiqueta: 'Listos' },
  { id: 'processing', etiqueta: 'Indexándose' },
  { id: 'failed', etiqueta: 'Sin leer' },
];

export function Biblioteca({ open, onClose, documentos, estadoInicial }: BibliotecaProps) {
  const { docs, maximo } = documentos;
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const [orden, setOrden] = useState<Orden>('recientes');
  const buscadorRef = useRef<HTMLInputElement>(null);
  const cerrarRef = useRef<HTMLButtonElement>(null);

  // Al abrir: el filtro de estado con el que se pidió (o ninguno) y el foco en
  // el buscador. Al cerrar y volver a abrir, se empieza limpio: unos filtros
  // que sobreviven a cerrar la vista hacen creer que faltan documentos.
  useEffect(() => {
    if (!open) return;
    setFiltros({ ...SIN_FILTROS, estado: estadoInicial });
    setOrden('recientes');
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Tras la transición de entrada, para que el navegador no la interrumpa
    // desplazando el foco.
    const t = window.setTimeout(() => buscadorRef.current?.focus(), 180);
    return () => {
      window.clearTimeout(t);
      previo?.focus();
    };
  }, [open, estadoInicial]);

  const visibles = useMemo(() => listar(docs ?? [], filtros, orden), [docs, filtros, orden]);
  const total = docs?.length ?? 0;
  const filtrando = hayFiltros(filtros);

  const raizRef = useRef<HTMLElement>(null);
  const alPulsarTecla = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Tab') {
      // Trampa de Tab: esta vista tapa toda la pantalla, así que el foco no
      // puede salir a lo que hay debajo (el chat, el panel de documentos),
      // que es invisible. Sin esto, tras la última ficha el foco desaparecía.
      const raiz = raizRef.current;
      if (!raiz) return;
      const nodos = Array.from(raiz.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (n) => !n.hasAttribute('disabled') && n.getAttribute('aria-hidden') !== 'true',
      );
      if (nodos.length === 0) return;
      const primero = nodos[0];
      const ultimo = nodos[nodos.length - 1];
      const activo = document.activeElement;
      if (e.shiftKey && (activo === primero || !raiz.contains(activo))) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (activo === ultimo || !raiz.contains(activo))) {
        e.preventDefault();
        primero.focus();
      }
      return;
    }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    // Con filtros puestos, Escape los limpia primero: es lo que se espera al
    // haber buscado algo, y evita salir de la vista por querer borrar el
    // texto del buscador.
    if (filtrando) setFiltros(SIN_FILTROS);
    else onClose();
  };

  const conFormato = (familia: FamiliaFormato | null) =>
    setFiltros((f) => ({ ...f, formato: f.formato === familia ? null : familia }));
  const conEstado = (estado: DocumentStatus | null) =>
    setFiltros((f) => ({ ...f, estado: f.estado === estado ? null : estado }));

  /** Los formatos que ella tiene: un filtro de "Word" en un corpus sin Word es
   *  un botón que no hace nada. */
  const familiasPresentes = useMemo(() => {
    const hay = new Set((docs ?? []).map((d) => formatoDe(d.fileName).familia));
    return ORDEN_FORMATOS.filter((f) => hay.has(f));
  }, [docs]);

  return (
    <section
      ref={raizRef}
      className={`biblio ${open ? '' : 'biblio-cerrada'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Todos tus documentos"
      aria-hidden={!open}
      onKeyDown={alPulsarTecla}
    >
      <header className="biblio-cabecera">
        <h2>Todos tus documentos</h2>
        <button
          ref={cerrarRef}
          type="button"
          className="icon-btn"
          onClick={onClose}
          title="Cerrar"
          aria-label="Cerrar la vista de documentos"
        >
          <IconX size={16} />
        </button>
      </header>

      <div className="biblio-cuerpo">
        {/* Un contenedor centrado, y no una regla que centre a cada hijo: con
            `.biblio-cuerpo > * { margin-inline: auto }`, cualquier hijo que
            declare su propio `margin: 0 ...` (la rejilla, el recuento) lo pisa
            por tener la misma especificidad y venir después, y se quedaba
            pegado a la izquierda mientras la banda sí se centraba. */}
        <div className="biblio-centro">
        {docs !== null && docs.length > 0 && <BandaCorpus docs={docs} />}

        {total > 0 && (
          <div className="biblio-controles">
            <label className="biblio-buscador">
              <IconSearch size={14} />
              <input
                ref={buscadorRef}
                type="search"
                value={filtros.texto}
                onChange={(e) => setFiltros((f) => ({ ...f, texto: e.target.value }))}
                placeholder="Busca por autor, título o nombre de archivo"
                aria-label="Buscar entre tus documentos"
              />
            </label>

            <div className="biblio-chips" role="group" aria-label="Filtrar">
              <button
                type="button"
                className={`biblio-chip ${filtros.formato === null && filtros.estado === null && !filtros.soloNotion ? 'es-activo' : ''}`}
                onClick={() => setFiltros((f) => ({ ...SIN_FILTROS, texto: f.texto }))}
              >
                Todos
              </button>
              {familiasPresentes.map((familia) => (
                <button
                  key={familia}
                  type="button"
                  className={`biblio-chip ${filtros.formato === familia ? 'es-activo' : ''}`}
                  onClick={() => conFormato(familia)}
                  aria-pressed={filtros.formato === familia}
                >
                  <span className={`banda-punto banda-tramo-${familia}`} aria-hidden="true" />
                  {FORMATOS[familia].etiqueta}
                </button>
              ))}
              {ESTADOS.filter((e) => (docs ?? []).some((d) => d.status === e.id)).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`biblio-chip ${filtros.estado === e.id ? 'es-activo' : ''}`}
                  onClick={() => conEstado(e.id)}
                  aria-pressed={filtros.estado === e.id}
                >
                  {e.etiqueta}
                </button>
              ))}
              {(docs ?? []).some((d) => d.origen === 'notion') && (
                <button
                  type="button"
                  className={`biblio-chip ${filtros.soloNotion ? 'es-activo' : ''}`}
                  onClick={() => setFiltros((f) => ({ ...f, soloNotion: !f.soloNotion }))}
                  aria-pressed={filtros.soloNotion}
                >
                  <img src="/notion.svg" alt="" width={11} height={11} />
                  Notion
                </button>
              )}
            </div>

            <label className="biblio-orden">
              <span>Ordenar</span>
              <select
                className="auth-input"
                value={orden}
                onChange={(e) => setOrden(e.target.value as Orden)}
              >
                {ORDENES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.etiqueta}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {docs === null ? (
          <p className="biblio-cargando shimmer-text">Cargando tus documentos…</p>
        ) : total === 0 ? (
          <div className="docs-empty">
            <span className="docs-empty-icon" aria-hidden="true">
              <IconDocument size={20} />
            </span>
            <p>
              Todavía no tienes ningún documento. Súbelos desde el panel de documentos, o conecta
              tu Notion para que lleguen solos.
            </p>
          </div>
        ) : visibles.length === 0 ? (
          <div className="docs-empty">
            <span className="docs-empty-icon" aria-hidden="true">
              <IconSearch size={20} />
            </span>
            <p>
              Ninguno de tus {cifra(total)} documentos casa con lo que buscas.
            </p>
            <button
              type="button"
              className="doc-confirm-btn doc-confirm-no"
              onClick={() => setFiltros(SIN_FILTROS)}
            >
              Quitar los filtros
            </button>
          </div>
        ) : (
          <>
            <p className="biblio-cuenta" aria-live="polite">
              {visibles.length === total
                ? `${cifra(total)} ${total === 1 ? 'documento' : 'documentos'}`
                : `${cifra(visibles.length)} de ${cifra(total)}`}
            </p>
            <ul className="biblio-rejilla">
              {visibles.map((d) => (
                <FichaDocumento
                  key={d.id}
                  doc={d}
                  maximo={maximo}
                  borrando={documentos.borrando.has(String(d.id))}
                  reindexando={documentos.reindexando.has(String(d.id))}
                  confirmando={documentos.confirmando === d.id}
                  errorAbierto={documentos.erroresAbiertos.has(String(d.id))}
                  destella={documentos.recienListos.has(String(d.id))}
                  onConfirmar={() => documentos.confirmar(d.id)}
                  onCancelar={() => documentos.confirmar(null)}
                  onBorrar={() => void documentos.borrar(d)}
                  onReindexar={() => void documentos.reindexar(d)}
                  onAlternarError={() => documentos.alternarError(String(d.id))}
                  errorDeFila={documentos.erroresDeFila[String(d.id)]}
                />
              ))}
            </ul>
          </>
        )}
        </div>
      </div>
    </section>
  );
}
