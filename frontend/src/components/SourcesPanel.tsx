import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useSheetDrag } from '../lib/useSheetDrag';
import { piezasDeMeta, tituloDeFuente } from '../lib/fuentes';
import { citationFileKey, citationPages, extractCitations } from '../lib/markdown';
import type { ChatMessage, Source, SourceFocus } from '../types';
import { IconChevronDown, IconDocument } from './icons';

interface SourcesPanelProps {
  open: boolean;
  /** Mensaje del asistente cuyas fuentes se muestran (o null si no hay). */
  message: ChatMessage | null;
  focus: SourceFocus | null;
  /** Cierre (scrim, swipe-down del bottom sheet en móvil). */
  onClose: () => void;
}

/* ------------------------------- modelo ---------------------------------- */

interface SourceItem {
  /** Clave estable de la tarjeta (dedupe, refs, expansión). */
  key: string;
  source: Source;
  cited: boolean;
}

interface SourceGroup {
  /** Nombre de archivo tal cual llegó (primera aparición). */
  file: string;
  fileKey: string;
  items: SourceItem[];
  citedCount: number;
}

/** Páginas citadas de un archivo; all=true si alguna cita no menciona página. */
interface CitedEntry {
  all: boolean;
  pages: Set<number>;
}

function buildCitedMap(content: string): Map<string, CitedEntry> {
  const map = new Map<string, CitedEntry>();
  for (const ref of extractCitations(content)) {
    const key = citationFileKey(ref.file);
    let entry = map.get(key);
    if (!entry) {
      entry = { all: false, pages: new Set() };
      map.set(key, entry);
    }
    const pages = citationPages(ref);
    if (pages.length === 0) entry.all = true;
    else for (const p of pages) entry.pages.add(p);
  }
  return map;
}

/** Claves con las que una cita puede referirse a esta fuente.
 *
 *  El modelo cita por el nombre del archivo, pero cuando el documento es un
 *  artículo con autor y año cita "Allegri et al., 2021", que es como se cita
 *  de verdad un trabajo. Sin esta segunda clave, esas citas no enlazaban con
 *  su fuente y el panel mostraba todo como no citado. */
function sourceKeys(s: Source): string[] {
  const claves = [citationFileKey(s.source_file)];
  if (s.citation) claves.push(citationFileKey(s.citation));
  return claves;
}

function isCited(s: Source, citedMap: Map<string, CitedEntry>): boolean {
  for (const clave of sourceKeys(s)) {
    const entry = citedMap.get(clave);
    if (!entry) continue;
    if (entry.all) return true;
    // Fuente sin página de un archivo citado: no se puede descartar, cuenta.
    if (s.page === null) return true;
    if (entry.pages.has(s.page)) return true;
  }
  return false;
}

/**
 * Dedupe fuerte por archivo, página y fragmento
 * y agrupación por archivo. Citadas primero: dentro de cada grupo y los
 * grupos con citadas por delante (orden estable en ambas particiones).
 */
function buildGroups(sources: Source[], citedMap: Map<string, CitedEntry>): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const byFile = new Map<string, SourceGroup>();
  const seen = new Set<string>();

  for (const s of sources) {
    const fileKey = citationFileKey(s.source_file);
    const identity = `t:${s.snippet.trim().slice(0, 80)}`;
    const key = `${fileKey}|${s.page ?? 'x'}|${identity}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let group = byFile.get(fileKey);
    if (!group) {
      group = { file: s.source_file, fileKey, items: [], citedCount: 0 };
      byFile.set(fileKey, group);
      groups.push(group);
    }
    const cited = isCited(s, citedMap);
    group.items.push({ key, source: s, cited });
    if (cited) group.citedCount++;
  }

  for (const g of groups) {
    g.items = [...g.items.filter((i) => i.cited), ...g.items.filter((i) => !i.cited)];
  }
  return [...groups.filter((g) => g.citedCount > 0), ...groups.filter((g) => g.citedCount === 0)];
}

/* ------------------------------ helpers UI -------------------------------- */

function scorePercent(score: number | null): number | null {
  if (score === null || Number.isNaN(score)) return null;
  const clamped = Math.max(0, Math.min(1, score));
  return Math.round(clamped * 100);
}

/** Badge del tipo de fragmento (solo los que aportan contexto). */
function chunkBadge(chunkType: string | undefined): string | null {
  if (chunkType === 'table') return 'Tabla';
  return null;
}

/** Etiqueta del grado que dio el calificador. Vacio = sin calificar, y
 *  entonces no se pinta nada: "sin etiqueta" no debe leerse como "no sirve". */
function gradoLabel(grado: Source['grado']): string | null {
  if (grado === 'directa') return 'Directa';
  if (grado === 'parcial') return 'Parcial';
  return null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/* --------------------------------- panel ---------------------------------- */

export function SourcesPanel({ open, message, focus, onClose }: SourcesPanelProps) {
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  /** Overrides del usuario sobre el colapsado por defecto de cada grupo. */
  const [groupToggles, setGroupToggles] = useState<Map<string, boolean>>(new Map());
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingScroll = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const msgKey = message?.localId ?? null;
  const content = message?.content ?? '';
  const rawSources = message?.sources;
  const plan = message?.plan ?? [];

  // Bottom sheet en móvil: swipe-down sobre el asa cierra el panel.
  useSheetDrag(panelRef, grabberRef, onClose);

  // Al cambiar de mensaje, colapsa tarjetas y resetea los grupos.
  useEffect(() => {
    setExpandedCards(new Set());
    setGroupToggles(new Map());
  }, [msgKey]);

  // Citas (archivo, página) presentes en la respuesta: mismo parser que los chips.
  const citedMap = useMemo(() => buildCitedMap(content), [content]);

  const groups = useMemo(
    () => buildGroups(rawSources ?? [], citedMap),
    [rawSources, citedMap],
  );

  const totalCount = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const citedCount = useMemo(() => groups.reduce((n, g) => n + g.citedCount, 0), [groups]);

  // Colapsado por defecto: solo si hay >2 grupos Y el grupo no tiene citadas.
  const groupIsOpen = (g: SourceGroup): boolean =>
    groupToggles.get(g.fileKey) ?? (groups.length <= 2 || g.citedCount > 0);

  // Clic en una cita del mensaje: expande el grupo + la tarjeta y desplaza.
  useEffect(() => {
    if (!focus || !message) return;
    // La cita puede venir por nombre de archivo o por referencia del trabajo
    // ("Allegri et al., 2021"), asi que se busca el grupo por las dos vias.
    const clave = citationFileKey(focus.file);
    const group =
      groups.find((g) => g.fileKey === clave) ??
      groups.find((g) => g.items.some((i) => sourceKeys(i.source).includes(clave)));
    if (!group) return;
    const fileKey = group.fileKey;
    const target =
      (focus.page !== null
        ? group.items.find((i) => i.source.page === focus.page)
        : undefined) ??
      group.items.find((i) => focus.page === null || i.source.page === null) ??
      group.items[0];
    if (!target) return;
    setGroupToggles((prev) => {
      const next = new Map(prev);
      next.set(fileKey, true);
      return next;
    });
    setExpandedCards((prev) => {
      const next = new Set(prev);
      next.add(target.key);
      return next;
    });
    pendingScroll.current = target.key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  // El scroll corre tras el render que monta la tarjeta (el grupo pudo estar
  // colapsado). Respeta prefers-reduced-motion: sin smooth scrolling.
  useEffect(() => {
    const key = pendingScroll.current;
    if (key === null) return;
    const el = itemRefs.current.get(key);
    if (!el) return; // aún no montada: reintenta en el siguiente render
    pendingScroll.current = null;
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
    });
  });

  const toggleCard = (key: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (g: SourceGroup) => {
    const open = groupIsOpen(g);
    setGroupToggles((prev) => {
      const next = new Map(prev);
      next.set(g.fileKey, !open);
      return next;
    });
  };

  const renderCard = (item: SourceItem) => {
    const s = item.source;
    const title = tituloDeFuente(s);
    const badge = chunkBadge(s.chunk_type);
    const isOpen = expandedCards.has(item.key);
    const dimmed = citedCount > 0 && !item.cited;
    const pct = scorePercent(s.score);
    const grado = gradoLabel(s.grado);
    // De dónde sale y para qué sirvió, sin repetir lo que ya dice el título
    // (ver lib/fuentes.ts).
    const meta = piezasDeMeta(s, plan, title);

    return (
      <div
        key={item.key}
        ref={(el) => {
          if (el) itemRefs.current.set(item.key, el);
          else itemRefs.current.delete(item.key);
        }}
        className={`source-card ${isOpen ? 'source-open' : ''} ${dimmed ? 'source-uncited' : ''}`}
      >
        <button
          type="button"
          className="source-head"
          onClick={() => toggleCard(item.key)}
          aria-expanded={isOpen}
        >
          <span className="source-doc-icon" aria-hidden="true">
            <IconDocument size={15} />
          </span>
          <span className="source-badge">
            <span className="source-title-line">
              <span className="source-title">{title}</span>
              {item.cited && <span className="badge-cited">Citada</span>}
              {grado !== null && (
                <span
                  className={`badge-grado badge-grado-${s.grado}`}
                  title={
                    s.grado === 'directa'
                      ? 'El calificador juzgo que este fragmento responde directamente a su punto'
                      : 'El calificador juzgo que este fragmento responde solo en parte a su punto'
                  }
                >
                  {grado}
                </span>
              )}
              {badge !== null && <span className="badge-type">{badge}</span>}
            </span>
            {/* Las piezas van cada una en su caja y la fila las deja pasar
                de línea: en 320 px, un `flex` sin envoltura las aplastaba por
                debajo de su contenido y el texto se pintaba encima de la
                vecina. El separador es hermano, no hijo, para que el nombre
                del fichero pueda recortarse sin llevárselo. */}
            {meta.length > 0 && (
              <span className="source-meta">
                {meta.map((pieza, i) => (
                  <Fragment key={i}>
                    {i > 0 && (
                      <span className="source-sep" aria-hidden="true">
                        ·
                      </span>
                    )}
                    <span className={`source-meta-item ${pieza.clase ?? ''}`} title={pieza.titulo}>
                      {pieza.texto}
                    </span>
                  </Fragment>
                ))}
              </span>
            )}
          </span>
          <IconChevronDown size={13} className="source-chevron" />
        </button>

        {isOpen && (
          <div className="source-snippet">{s.snippet || 'Sin fragmento disponible.'}</div>
        )}

        {s.score !== null && (
          <div className="source-score" title={`Score: ${s.score.toFixed(4)}`}>
            <div className="score-bar">
              {/* scaleX (no width): anima de 0 a su valor al montar, compositable */}
              <div
                className="score-fill"
                style={{ transform: `scaleX(${(pct ?? 0) / 100})` }}
              />
            </div>
            <span className="score-num">{s.score.toFixed(2)}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside ref={panelRef} className={`sources-panel ${open ? '' : 'sources-closed'}`}>
      <div ref={grabberRef} className="sheet-grabber" aria-hidden="true" />
      <div className="sources-inner">
        <div className="sources-header">
          <h2>Fuentes</h2>
          {totalCount > 0 && <span className="sources-badge-count">{totalCount}</span>}
          {citedCount > 0 && (
            <span className="sources-cited-note">
              · {citedCount} {citedCount === 1 ? 'citada' : 'citadas'}
            </span>
          )}
        </div>

        {totalCount === 0 ? (
          <div className="sources-empty">
            <span className="sources-empty-icon" aria-hidden="true">
              <IconDocument size={22} />
            </span>
            <p>
              {message?.streaming
                ? 'Buscando en los documentos…'
                : 'Las fuentes de la respuesta aparecerán aquí. Haz clic en una cita dentro de la respuesta para resaltar su fuente.'}
            </p>
          </div>
        ) : (
          <div className="sources-list">
            {groups.map((g) => {
              const isOpen = groupIsOpen(g);
              return (
                <section key={g.fileKey} className="source-group">
                  <button
                    type="button"
                    className="source-group-head"
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(g)}
                  >
                    <span className="source-group-icon" aria-hidden="true">
                      <IconDocument size={13} />
                    </span>
                    <span className="source-group-file" title={g.file}>
                      {g.file}
                    </span>
                    <span className="source-sep">·</span>
                    <span className="source-group-count">
                      {g.items.length} {g.items.length === 1 ? 'fragmento' : 'fragmentos'}
                    </span>
                    {g.citedCount > 0 && (
                      <span className="source-group-cited">
                        {g.citedCount} {g.citedCount === 1 ? 'citada' : 'citadas'}
                      </span>
                    )}
                    <IconChevronDown size={13} className="source-chevron" />
                  </button>
                  {isOpen && <div className="source-group-body">{g.items.map(renderCard)}</div>}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
