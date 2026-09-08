import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSheetDrag } from '../lib/useSheetDrag';
import { piezasDeMeta, tituloDeFuente } from '../lib/fuentes';
import {
  agruparFuentes, enlaceDoi, filtrarFuentes, puntosDeFuentes, resolverDestino,
  textoParaCopiar, type FiltroFuentes, type FuenteExplorable,
} from '../lib/exploradorFuentes';
import { usePreferencias } from '../lib/preferencias';
import type { ChatMessage, SourceFocus } from '../types';
import {
  IconAlert, IconCheck, IconChevronDown, IconCopy,
  IconPanelRight, IconSearch, IconX,
} from './icons';
import './SourcesPanel.css';

interface SourcesPanelProps {
  open: boolean;
  message: ChatMessage | null;
  focus: SourceFocus | null;
  onClose: () => void;
}

export function SourcesPanel({ open, message, focus, onClose }: SourcesPanelProps) {
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<FiltroFuentes>('todas');
  const [punto, setPunto] = useState('');
  const [ampliado, setAmpliado] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());
  const [gruposAbiertos, setGruposAbiertos] = useState<Map<string, boolean>>(new Map());
  const [resaltadas, setResaltadas] = useState<Set<string>>(new Set());
  const [aviso, setAviso] = useState('');
  const [copia, setCopia] = useState<{ key: string; estado: 'copiando' | 'copiado' | 'error' } | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const focoConsumido = useRef<number | null>(null);
  const copiaVersion = useRef(0);
  const preferencias = usePreferencias();
  const msgKey = message?.localId ?? null;
  const grupos = useMemo(() => agruparFuentes(message?.sources ?? [], message?.content ?? ''),
    [message?.sources, message?.content]);
  const puntos = useMemo(() => puntosDeFuentes(message), [message?.plan, message?.hops, message?.verificacion]);
  const visibles = useMemo(() => filtrarFuentes(grupos, busqueda, filtro, punto), [grupos, busqueda, filtro, punto]);
  const total = grupos.reduce((n, g) => n + g.items.length, 0);
  const citadas = grupos.reduce((n, g) => n + g.items.filter((i) => i.cita !== null).length, 0);
  const mostradas = visibles.reduce((n, g) => n + g.items.length, 0);
  const filtrando = Boolean(busqueda.trim() || punto || filtro !== 'todas');

  useSheetDrag(panelRef, grabberRef, onClose);

  useEffect(() => {
    if (copia?.estado !== 'copiado') return;
    const timer = window.setTimeout(() => setCopia(null), 2400);
    return () => window.clearTimeout(timer);
  }, [copia]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const actualizar = () => setOverlay(media.matches);
    actualizar();
    media.addEventListener('change', actualizar);
    return () => media.removeEventListener('change', actualizar);
  }, []);

  useEffect(() => {
    setBusqueda(''); setFiltro('todas'); setPunto('');
    setExpandidas(new Set()); setGruposAbiertos(new Map()); setResaltadas(new Set());
    setAviso(''); setCopia(null); setScrollTarget(null);
    copiaVersion.current++;
    return () => { copiaVersion.current++; };
  }, [msgKey]);

  // En escritorio se puede seguir leyendo el chat; en overlay el foco no
  // debe escaparse detrás del panel. Al cerrar vuelve al control anterior.
  useEffect(() => {
    if (!open) return;
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (overlay) closeRef.current?.focus();
    return () => {
      if (panelRef.current?.contains(document.activeElement)) anterior?.focus();
    };
  }, [open, overlay]);

  useEffect(() => {
    if (!open || !focus || !message || focoConsumido.current === focus.token) return;
    // Mientras llegan las fuentes, conservar la solicitud de navegación.
    if (grupos.length === 0 && message.streaming) return;
    const destino = resolverDestino(grupos, focus);
    if (destino.estado !== 'encontrada' && message.streaming) return;
    focoConsumido.current = focus.token;
    setBusqueda(''); setFiltro('todas'); setPunto(''); setResaltadas(new Set());
    if (destino.estado === 'encontrada') {
      setAviso('');
      setGruposAbiertos((prev) => new Map(prev).set(destino.grupo, true));
      setExpandidas((prev) => new Set([...prev, ...destino.tarjetas]));
      setResaltadas(new Set(destino.tarjetas));
      setScrollTarget(destino.tarjetas[0]);
    } else if (destino.estado === 'pagina_ausente') {
      setGruposAbiertos((prev) => new Map(prev).set(destino.grupo, true));
      setAviso('No tenemos un fragmento de la página ' + focus.page +
        ' para esta respuesta. El documento aparece abajo, pero no lo sustituimos por otra página.');
    } else if (destino.estado === 'ambigua') {
      setAviso('Esta referencia coincide con varios documentos. Revisa el nombre del archivo: no podemos elegir uno con seguridad.');
    } else {
      setAviso('No encontramos esta referencia entre las fuentes disponibles de la respuesta.');
    }
  }, [open, focus, grupos, message]);

  useEffect(() => {
    if (!open || !scrollTarget) return;
    const el = itemRefs.current.get(scrollTarget);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({
      behavior: preferencias.reducirMovimiento || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'nearest',
    });
    setScrollTarget(null);
  }, [open, scrollTarget, visibles, expandidas, preferencias.reducirMovimiento]);

  const limpiar = () => { setBusqueda(''); setFiltro('todas'); setPunto(''); };
  const grupoAbierto = (key: string, index: number) => gruposAbiertos.get(key) ?? (filtrando || index < 2);
  const copiar = async (item: FuenteExplorable) => {
    const version = ++copiaVersion.current;
    setCopia({ key: item.key, estado: 'copiando' });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Portapapeles no disponible');
      await navigator.clipboard.writeText(textoParaCopiar(item.source));
      if (copiaVersion.current === version) setCopia({ key: item.key, estado: 'copiado' });
    } catch {
      if (copiaVersion.current === version) setCopia({ key: item.key, estado: 'error' });
    }
  };

  const teclado = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (!overlay || e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const controles = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, a[href], summary')]
      .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    const primero = controles[0], ultimo = controles[controles.length - 1];
    if (!primero || !ultimo) return;
    if (e.shiftKey && (document.activeElement === primero || !panel.contains(document.activeElement))) {
      e.preventDefault(); ultimo.focus();
    } else if (!e.shiftKey && (document.activeElement === ultimo || !panel.contains(document.activeElement))) {
      e.preventDefault(); primero.focus();
    }
  };

  const tarjeta = (item: FuenteExplorable) => {
    const s = item.source;
    const expandida = expandidas.has(item.key);
    const meta = piezasDeMeta(s, [], tituloDeFuente(s)).filter((p) => p.clase !== 'source-meta-plan');
    const doi = enlaceDoi(s.doi);
    const relacionados = puntos.filter((p) => s.plan_items?.includes(p.id));
    const estadoCopia = copia?.key === item.key ? copia.estado : null;
    return (
      <div key={item.key} className={`fuentes-card ${resaltadas.has(item.key) ? 'fuentes-highlight' : ''}`}
        tabIndex={-1} ref={(el) => { if (el) itemRefs.current.set(item.key, el); else itemRefs.current.delete(item.key); }}>
        <button type="button" className="fuentes-card-head" aria-expanded={expandida}
          onClick={() => setExpandidas((prev) => {
            const next = new Set(prev);
            if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
            return next;
          })}>
          <span className="fuentes-card-heading">
            <span className="fuentes-card-location">{s.locator || (s.page !== null ? `Página ${s.page}` : 'Fragmento sin página')}</span>
            <span className="fuentes-badges">
              {item.cita && <span className="fuentes-cited">{item.cita === 'pagina' ? 'Página citada' : 'Documento citado'}</span>}
              {s.chunk_type === 'table' && <span>Tabla</span>}
            </span>
          </span>
          <IconChevronDown size={14} className={expandida ? 'fuentes-chevron-open' : ''} />
        </button>
        {!expandida && <p className="fuentes-preview">{s.snippet || 'Sin fragmento disponible.'}</p>}
        {expandida && (
          <div className="fuentes-card-body">
            {meta.length > 0 && <p className="fuentes-meta">{meta.map((m) => m.texto).join(' · ')}</p>}
            <div className="fuentes-snippet">{s.snippet || 'Sin fragmento disponible.'}</div>
            {relacionados.length > 0 && (
              <div className="fuentes-related">
                <span>Recuperado para</span>
                {relacionados.map((p) => <button type="button" key={p.id} onClick={() => {
                  setPunto(p.id); setBusqueda(''); setFiltro('todas');
                }}>{p.texto}</button>)}
              </div>
            )}
            {(s.grado || (s.score !== null && Number.isFinite(s.score))) && (
              <details className="fuentes-technical">
                <summary>Detalles de recuperación</summary>
                {s.grado && <p>Relevancia {s.grado === 'directa' ? 'directa' : 'parcial'} según el calificador para el punto buscado. No es un dictamen sobre la respuesta completa.</p>}
                {s.score !== null && Number.isFinite(s.score) && <p>Score de recuperación: {s.score.toFixed(4)}. No es un porcentaje de certeza ni de fidelidad.</p>}
              </details>
            )}
            <div className="fuentes-actions">
              <button type="button" disabled={copia?.estado === 'copiando' || !s.snippet}
                onClick={() => void copiar(item)}>
                {estadoCopia === 'copiado' ? <IconCheck size={14} /> : <IconCopy size={14} />}
                {estadoCopia === 'copiado' ? 'Copiado' : estadoCopia === 'copiando' ? 'Copiando…' : 'Copiar con referencia'}
              </button>
              {doi && <a href={doi} target="_blank" rel="noopener noreferrer" aria-label="Abrir DOI en una pestaña nueva">Abrir DOI ↗</a>}
            </div>
            {estadoCopia === 'error' && <p className="fuentes-copy-error" role="alert">No se pudo copiar. Puedes seleccionar y copiar el fragmento manualmente.</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside ref={panelRef} className={`sources-panel fuentes-panel ${ampliado ? 'fuentes-wide' : ''} ${open ? '' : 'sources-closed'}`}
      aria-label="Fuentes de la respuesta" aria-hidden={!open} role={overlay ? 'dialog' : undefined}
      aria-modal={overlay && open ? true : undefined} onKeyDown={teclado}>
      <div ref={grabberRef} className="sheet-grabber" aria-hidden="true" />
      <div className="sources-inner fuentes-inner">
        <header className="fuentes-header">
          <div><h2>Fuentes</h2>{total > 0 && <p>{grupos.length} {grupos.length === 1 ? 'documento' : 'documentos'} · {total} {total === 1 ? 'fragmento' : 'fragmentos'}</p>}</div>
          <div className="fuentes-header-actions">
            <button type="button" className="icon-btn fuentes-expand" aria-pressed={ampliado}
              title={ampliado ? 'Reducir panel' : 'Ampliar panel'} aria-label={ampliado ? 'Reducir panel' : 'Ampliar panel'}
              onClick={() => setAmpliado((v) => !v)}><IconPanelRight size={17} /></button>
            <button type="button" className="icon-btn" ref={closeRef} onClick={onClose} aria-label="Cerrar fuentes" title="Cerrar fuentes"><IconX size={17} /></button>
          </div>
        </header>
        <div className="fuentes-body">
          {aviso && <p className="fuentes-warning" role="status"><IconAlert size={16} />{aviso}</p>}
          {total === 0 ? (
            <div className="fuentes-empty">
              <h3>{message?.streaming ? 'Buscando fuentes…' : 'Sin fuentes todavía'}</h3>
              <p>{message?.streaming ? 'Las fuentes aparecerán mientras avanza la búsqueda.' :
                'Selecciona una cita o abre las fuentes de una respuesta para consultar sus fragmentos.'}</p>
            </div>
          ) : (
            <>
              <div className="fuentes-tools">
                <div className="fuentes-search">
                  <IconSearch size={16} />
                  <input type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
                    placeholder="Título, autor o texto…" aria-label="Buscar en las fuentes de esta respuesta" />
                </div>
                <div className="fuentes-filters" role="group" aria-label="Filtrar fuentes">
                  <button type="button" aria-pressed={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas <span>{total}</span></button>
                  <button type="button" aria-pressed={filtro === 'citadas'} onClick={() => setFiltro('citadas')}>Citadas <span>{citadas}</span></button>
                </div>
                {puntos.length > 0 && <details className="fuentes-point-disclosure">
                  <summary>Filtrar por punto{punto ? ' · activo' : ''}</summary>
                  <label className="fuentes-point">
                  <span>Punto investigado</span>
                  <select value={punto} onChange={(e) => setPunto(e.target.value)}>
                    <option value="">Todos los puntos</option>
                    {puntos.map((p) => <option value={p.id} key={p.id}>{p.texto}</option>)}
                  </select>
                </label></details>}
                {punto && <p className="fuentes-selected-point">{puntos.find((p) => p.id === punto)?.texto}</p>}
              </div>
              {filtrando && <div className="fuentes-result-toolbar">
                <span role="status">{mostradas} de {total} {total === 1 ? 'fragmento' : 'fragmentos'} · {visibles.length} {visibles.length === 1 ? 'documento' : 'documentos'}</span>
                {filtrando && <button type="button" onClick={limpiar}>Limpiar filtros</button>}
              </div>}
              {visibles.length === 0 ? (
                <div className="fuentes-empty fuentes-no-results"><h3>Sin coincidencias</h3>
                  <p>No hay fragmentos que coincidan con estos filtros en esta respuesta.</p>
                  <button type="button" onClick={limpiar}>Mostrar todas las fuentes</button>
                </div>
              ) : (
                <div className="fuentes-results">
                  {visibles.map((g, index) => {
                    const expandido = grupoAbierto(g.key, index);
                    const source = g.items[0].source;
                    return <section key={g.key} className="fuentes-group">
                      <button type="button" className="fuentes-group-head" aria-expanded={expandido}
                        onClick={() => setGruposAbiertos((prev) => new Map(prev).set(g.key, !expandido))}>
                        <span className="fuentes-group-title">
                          <strong>{tituloDeFuente(source)}</strong>
                          {source.title && source.title !== tituloDeFuente(source)
                            ? <span>{source.title}</span>
                            : g.file !== tituloDeFuente(source) ? <span>{g.file}</span> : null}
                          <small>{g.items.length} {g.items.length === 1 ? 'fragmento' : 'fragmentos'}</small>
                        </span>
                        <IconChevronDown size={14} className={expandido ? 'fuentes-chevron-open' : ''} />
                      </button>
                      {expandido && <div className="fuentes-group-body">{g.items.map(tarjeta)}</div>}
                    </section>;
                  })}
                </div>
              )}
              <details className="fuentes-explanation">
                <summary>Sobre las citas</summary>
                <p>La respuesta menciona ese documento o página. No garantiza que cada fragmento de esa página respalde una afirmación. «Recuperado para» indica el punto que motivó la búsqueda, no una verificación.</p>
              </details>
            </>
          )}
          <span className="fuentes-sr-only" role="status">{copia?.estado === 'copiado' ? 'Fragmento y referencia copiados.' : ''}</span>
        </div>
      </div>
    </aside>
  );
}
