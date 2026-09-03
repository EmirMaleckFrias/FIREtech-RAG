// Slide-over de gestión de documentos indexados (SPEC.md, "Gestión de
// documentos"). Siempre montado,como SourcesPanel, y oculto vía la clase
// docs-closed, así el estado de subida/polling sobrevive a cerrar el panel.
//
// Decisiones:
// - Roles (SPEC.md, "Autenticación multiusuario"): todos ven la lista completa,
//   pero subir y borrar es exclusivo de admin. Con canManage en false no se
//   monta ni la dropzone ni los botones de borrar: la UI no ofrece nada que el
//   backend vaya a rechazar con 403.
// - Progreso de subida REAL con XMLHttpRequest (ver uploadDocument en api.ts);
//   si el navegador no puede computarlo, barra indeterminada con shimmer.
// - Polling de GET /api/documents cada 4 s SOLO mientras haya documentos en
//   "processing" y (el panel esté abierto o la subida la iniciamos nosotros).
//   Tres fallos seguidos del sondeo lo detienen (aviso con "Reintentar"):
//   nunca hay polling infinito contra un backend caído.
// - Focus trap ligero: Tab cicla dentro del panel, Escape cierra (o cancela
//   la confirmación de borrado si está abierta) y el foco vuelve al botón
//   que abrió el panel.

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { deleteDocument, fetchDocuments, uploadDocument } from '../api';
import { useSheetDrag } from '../lib/useSheetDrag';
import type { DocumentInfo } from '../types';
import {
  IconAlert,
  IconCheck,
  IconDocument,
  IconLock,
  IconSpinner,
  IconTrash,
  IconUpload,
  IconX,
} from './icons';


const POLL_INTERVAL_MS = 4_000;
const MAX_POLL_FAILURES = 3;
const JUST_READY_MS = 1_800;
const ALLOWED_EXT_RE = /\.(pdf|docx|xlsx|csv|txt|md)$/i;
/** Fallback si /api/health aún no anuncia upload_limit_mb (backends antiguos). */
const DEFAULT_UPLOAD_LIMIT_MB = 25;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DocumentsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Refresca /api/health (contador del footer) cuando cambia el índice. */
  onHealthRefresh: () => void;
  /**
   * Límite de subida en MB anunciado por GET /api/health (upload_limit_mb:
   * 4 en serverless, 25 en local). undefined mientras no llegue el health o
   * si el backend no lo expone: se asume DEFAULT_UPLOAD_LIMIT_MB.
   */
  uploadLimitMb?: number;
  /**
   * Solo el rol `admin` sube y borra (el backend responde 403 al resto). Un
   * lector ve la lista completa, sin dropzone ni botones de borrar. También
   * es false mientras no se conoce el rol: se asume el menor permiso.
   */
  canManage: boolean;
}

interface UploadState {
  fileName: string;
  /** Fracción 0..1, o null si el navegador no computa el progreso. */
  progress: number | null;
}

function validateFile(file: File, docs: DocumentInfo[] | null, limitMb: number): string | null {
  if (!ALLOWED_EXT_RE.test(file.name)) {
    return 'Formato no admitido. Solo se aceptan PDF, Word (.docx), XLSX, CSV, TXT o MD.';
  }
  if (file.size > limitMb * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `El archivo pesa ${mb} MB y el máximo permitido es ${limitMb} MB.`;
  }
  if (docs?.some((d) => d.file_name === file.name)) {
    return 'Ya existe un documento con ese nombre. Bórralo antes de volver a subirlo.';
  }
  return null;
}

function ingestedTitle(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `Indexado el ${d.toLocaleString('es')}`;
}

export function DocumentsPanel({
  open,
  onClose,
  onHealthRefresh,
  uploadLimitMb,
  canManage,
}: DocumentsPanelProps) {
  const limitMb = uploadLimitMb ?? DEFAULT_UPLOAD_LIMIT_MB;
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [upload, setUpload] = useState<UploadState | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [openErrors, setOpenErrors] = useState<Set<string>>(new Set());
  const [justReady, setJustReady] = useState<Set<string>>(new Set());
  const [pollBroken, setPollBroken] = useState(false);

  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  /** Nombres subidos desde esta sesión: su polling sigue aunque se cierre el panel. */
  const ownUploadsRef = useRef<Set<string>>(new Set());
  const pollFailsRef = useRef(0);
  const docsRef = useRef<DocumentInfo[] | null>(null);
  const readyTimersRef = useRef<number[]>([]);
  /**
   * Secuenciación de refreshDocs (mismo patrón que sessionRequestRef en
   * App.tsx): cada petición toma un id; si al resolver ya no es el vigente,
   * su resultado se descarta. Un DELETE exitoso incrementa la secuencia para
   * que un GET /api/documents en vuelo no "resucite" el documento borrado.
   */
  const docsRequestRef = useRef(0);

  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  // Bottom sheet en móvil: swipe-down sobre el asa cierra el panel.
  useSheetDrag(panelRef, grabberRef, onClose);

  // Limpieza al desmontar: timers de la micro-animación y subida en vuelo.
  useEffect(
    () => () => {
      for (const t of readyTimersRef.current) window.clearTimeout(t);
      uploadAbortRef.current?.abort();
    },
    [],
  );

  const refreshDocs = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      const requestId = ++docsRequestRef.current;
      if (!silent) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const list = await fetchDocuments();
        // Respuesta obsoleta (hubo un DELETE o un refresh más reciente).
        if (docsRequestRef.current !== requestId) return;
        pollFailsRef.current = 0;
        setPollBroken(false);

        // Transiciones processing → ready: micro-animación de éxito y
        // refresco del contador de productos del footer (/api/health).
        const prev = docsRef.current;
        if (prev !== null) {
          const prevStatus = new Map(prev.map((d) => [d.file_name, d.status]));
          const becameReady = list
            .filter(
              (d) => d.status === 'ready' && prevStatus.get(d.file_name) === 'processing',
            )
            .map((d) => d.file_name);
          if (becameReady.length > 0) {
            setJustReady((s) => new Set([...s, ...becameReady]));
            for (const name of becameReady) {
              const timer = window.setTimeout(() => {
                setJustReady((s) => {
                  const next = new Set(s);
                  next.delete(name);
                  return next;
                });
              }, JUST_READY_MS);
              readyTimersRef.current.push(timer);
            }
            onHealthRefresh();
          }
        }

        setDocs(list);
        setLoadError(null);
      } catch (err) {
        if (docsRequestRef.current !== requestId) return;
        if (silent) {
          pollFailsRef.current += 1;
          if (pollFailsRef.current >= MAX_POLL_FAILURES) setPollBroken(true);
        } else {
          setLoadError(
            err instanceof Error ? err.message : 'No se pudo cargar la lista de documentos.',
          );
        }
      } finally {
        if (!silent && docsRequestRef.current === requestId) setLoading(false);
      }
    },
    [onHealthRefresh],
  );

  // Al abrir: primera carga con skeleton; si ya hay datos, refresco silencioso.
  useEffect(() => {
    if (!open) return;
    void refreshDocs({ silent: docsRef.current !== null });
  }, [open, refreshDocs]);

  // Foco: al abrir entra al botón de cerrar; al cerrar vuelve a donde estaba.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, [open]);

  // Polling acotado: cada 4 s solo mientras haya "processing" y tenga sentido.
  const anyProcessing = docs?.some((d) => d.status === 'processing') ?? false;
  const hasOwnPending =
    docs?.some(
      (d) => d.status === 'processing' && ownUploadsRef.current.has(d.file_name),
    ) ?? false;

  useEffect(() => {
    if (pollBroken || !anyProcessing) return;
    if (!open && !hasOwnPending) return;
    const timer = window.setInterval(() => {
      void refreshDocs({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [anyProcessing, hasOwnPending, open, pollBroken, refreshDocs]);

  // --- subida ---
  const startUpload = useCallback(
    async (file: File) => {
      if (uploadAbortRef.current !== null) return; // ya hay una subida en curso
      setUploadError(null);

      const invalid = validateFile(file, docsRef.current, limitMb);
      if (invalid !== null) {
        setUploadError(invalid);
        return;
      }

      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setUpload({ fileName: file.name, progress: 0 });

      try {
        const accepted = await uploadDocument(
          file,
          (fraction) => {
            setUpload((u) => (u === null ? u : { ...u, progress: fraction }));
          },
          controller.signal,
        );

        // 202: aparece de inmediato como "Procesando" y arranca el polling.
        ownUploadsRef.current.add(accepted.file_name);
        pollFailsRef.current = 0;
        setPollBroken(false);
        const optimistic: DocumentInfo = {
          id: accepted.id,
          file_name: accepted.file_name,
          pages: 0,
          chunks: 0,
          status: accepted.status,
          error: null,
          ingested_at: new Date().toISOString(),
        };
        setDocs((prev) => {
          const base = prev ?? [];
          return base.some((d) => d.file_name === optimistic.file_name)
            ? base.map((d) =>
                d.file_name === optimistic.file_name ? { ...d, ...optimistic } : d,
              )
            : [optimistic, ...base];
        });
        void refreshDocs({ silent: true });
      } catch (err) {
        if (!controller.signal.aborted) {
          setUploadError(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
        }
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
        setUpload(null);
      }
    },
    [limitMb, refreshDocs],
  );

  // --- borrado con confirmación inline de dos pasos ---
  const handleDelete = useCallback(
    async (fileName: string) => {
      setConfirmFor(null);
      setRowErrors((errs) => {
        const next = { ...errs };
        delete next[fileName];
        return next;
      });
      setDeleting((s) => new Set(s).add(fileName));
      try {
        await deleteDocument(fileName);
        // Invalida cualquier GET /api/documents en vuelo: su lista aún
        // contiene el documento recién borrado y lo resucitaría.
        docsRequestRef.current++;
        setDocs((prev) => (prev === null ? prev : prev.filter((d) => d.file_name !== fileName)));
        onHealthRefresh();
        void refreshDocs({ silent: true });
      } catch (err) {
        setRowErrors((errs) => ({
          ...errs,
          [fileName]: err instanceof Error ? err.message : 'No se pudo borrar el documento.',
        }));
      } finally {
        setDeleting((s) => {
          const next = new Set(s);
          next.delete(fileName);
          return next;
        });
      }
    },
    [onHealthRefresh, refreshDocs],
  );

  const toggleErrorDetail = (fileName: string) => {
    setOpenErrors((s) => {
      const next = new Set(s);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  };

  // --- drag & drop ---
  const handleDragEnter = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  };
  const handleDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
  };
  const handleDragLeave = () => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(false);
    }
  };
  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files.length > 0 ? e.dataTransfer.files[0] : null;
    if (file) void startUpload(file);
  };

  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files.length > 0 ? e.target.files[0] : null;
    e.target.value = ''; // permite re-elegir el mismo archivo
    if (file) void startUpload(file);
  };

  // --- focus trap ligero + Escape ---
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (confirmFor !== null) setConfirmFor(null);
      else onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = panelRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const retryPolling = () => {
    pollFailsRef.current = 0;
    setPollBroken(false);
    void refreshDocs({ silent: true });
  };

  const showSkeleton = loading && docs === null;
  const showUnavailable = !loading && loadError !== null && docs === null;

  return (
    <aside
      ref={panelRef}
      className={`docs-panel ${open ? '' : 'docs-closed'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Documentos indexados"
      onKeyDown={handleKeyDown}
    >
      <div ref={grabberRef} className="sheet-grabber" aria-hidden="true" />
      <div className="docs-inner">
        <div className="docs-header">
          <h2>Documentos</h2>
          {docs !== null && docs.length > 0 && (
            <span className="sources-badge-count">{docs.length}</span>
          )}
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn docs-close"
            onClick={onClose}
            title="Cerrar"
            aria-label="Cerrar panel de documentos"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="docs-body">
          {/* rol lector: lista completa, gestión fuera (nota discreta) */}
          {!canManage && (
            <p className="docs-readonly-note">
              <IconLock size={13} />
              <span>Solo un administrador puede subir o borrar documentos.</span>
            </p>
          )}

          {/* zona de subida (solo admin) */}
          {canManage && (
            <div className="docs-upload">
              {upload === null ? (
                <button
                  type="button"
                  className={`dropzone ${dragOver ? 'dropzone-active' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  aria-label="Subir un documento: arrastra un archivo aquí o pulsa para elegirlo"
                >
                  <IconUpload size={20} />
                  <span className="dropzone-text">
                    Arrastra un archivo o haz clic para subirlo
                  </span>
                  <span className="dropzone-hint">
                    PDF, DOCX, XLSX, CSV, TXT o MD · máx. {limitMb} MB
                  </span>
                </button>
              ) : (
                <div className="upload-progress" role="status" aria-live="polite">
                  <div className="upload-progress-head">
                    <span className="upload-file" title={upload.fileName}>
                      {upload.fileName}
                    </span>
                    <button
                      type="button"
                      className="upload-cancel"
                      onClick={() => uploadAbortRef.current?.abort()}
                    >
                      Cancelar
                    </button>
                  </div>
                  <div className="upload-bar" aria-hidden="true">
                    {upload.progress === null ? (
                      <div className="upload-fill upload-fill-indeterminate" />
                    ) : (
                      <div
                        className="upload-fill"
                        style={{ transform: `scaleX(${Math.min(1, upload.progress)})` }}
                      />
                    )}
                  </div>
                  <span className="upload-status">
                    {upload.progress === null ? (
                      <span className="shimmer-text">Subiendo…</span>
                    ) : upload.progress >= 1 ? (
                      <span className="shimmer-text">Procesando la subida…</span>
                    ) : (
                      `Subiendo… ${Math.round(upload.progress * 100)} %`
                    )}
                  </span>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFilePicked}
              />

              {uploadError !== null && (
                <div className="upload-error" role="alert">
                  <IconAlert size={14} />
                  <span>{uploadError}</span>
                </div>
              )}
            </div>
          )}

          {/* aviso de sondeo interrumpido */}
          {pollBroken && anyProcessing && (
            <div className="docs-poll-warn" role="status">
              <span>No se pudo actualizar el estado de la ingesta.</span>
              <button type="button" onClick={retryPolling}>
                Reintentar
              </button>
            </div>
          )}

          {/* listado / estados */}
          {showSkeleton && (
            <div className="docs-skeleton" role="status" aria-label="Cargando documentos">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="skeleton skel-doc"
                  style={{ animationDelay: `-${i * 140}ms` }}
                />
              ))}
            </div>
          )}

          {showUnavailable && (
            <div className="docs-empty">
              <span className="docs-empty-icon" aria-hidden="true">
                <IconAlert size={20} />
              </span>
              <p className="docs-empty-title">No disponible</p>
              <p>{loadError}</p>
              <button type="button" className="docs-retry-btn" onClick={() => void refreshDocs()}>
                Reintentar
              </button>
            </div>
          )}

          {docs !== null && docs.length === 0 && (
            <div className="docs-empty">
              <span className="docs-empty-icon" aria-hidden="true">
                <IconDocument size={20} />
              </span>
              <p>
                {canManage
                  ? 'No hay documentos indexados todavía. Sube el primero desde la zona de arriba.'
                  : 'No hay documentos indexados todavía. Un administrador debe subir el primero.'}
              </p>
            </div>
          )}

          {docs !== null && docs.length > 0 && (
            <ul className="docs-list">
              {docs.map((d) => {
                const isDeleting = deleting.has(d.file_name);
                const isConfirm = confirmFor === d.file_name;
                const errOpen = openErrors.has(d.file_name);
                const popped = justReady.has(d.file_name);
                const rowError = rowErrors[d.file_name];
                // Se muestra lo que haya, separado por puntos medios: un
                // documento en cola aún no tiene chunks ni páginas.
                const metaParts: string[] = [];
                if (d.chunks > 0) {
                  metaParts.push(
                    `${d.chunks.toLocaleString('es')} ${d.chunks === 1 ? 'chunk' : 'chunks'}`,
                  );
                }
                if (d.pages > 0) {
                  metaParts.push(
                    `${d.pages.toLocaleString('es')} ${d.pages === 1 ? 'pág.' : 'págs.'}`,
                  );
                }
                return (
                  <li
                    key={d.file_name}
                    className={`doc-card ${popped ? 'doc-card-ready-flash' : ''}`}
                  >
                    <div className="doc-row">
                      <span className="doc-icon" aria-hidden="true">
                        <IconDocument size={15} />
                      </span>
                      <span className="doc-info">
                        <span className="doc-file" title={ingestedTitle(d.ingested_at)}>
                          {d.file_name}
                        </span>
                        {metaParts.length > 0 && (
                          <span className="doc-meta">
                            {metaParts.map((part, i) => (
                              <Fragment key={part}>
                                {i > 0 && <span className="doc-sep">·</span>}
                                <span>{part}</span>
                              </Fragment>
                            ))}
                          </span>
                        )}
                      </span>

                      <span className="doc-side">
                        {isConfirm && canManage ? (
                          <span className="doc-confirm">
                            <span>¿Borrar?</span>
                            <button
                              type="button"
                              className="doc-confirm-btn doc-confirm-yes"
                              onClick={() => void handleDelete(d.file_name)}
                            >
                              Sí
                            </button>
                            <button
                              type="button"
                              className="doc-confirm-btn doc-confirm-no"
                              onClick={() => setConfirmFor(null)}
                            >
                              No
                            </button>
                          </span>
                        ) : (
                          <>
                            {d.status === 'ready' && (
                              <span
                                className={`doc-badge doc-badge-ready ${popped ? 'doc-badge-pop' : ''}`}
                              >
                                <IconCheck size={11} />
                                Listo
                              </span>
                            )}
                            {d.status === 'processing' && (
                              <span className="doc-badge doc-badge-processing" role="status">
                                <IconSpinner size={11} />
                                <span className="shimmer-text">Procesando</span>
                              </span>
                            )}
                            {d.status === 'failed' && (
                              <button
                                type="button"
                                className="doc-badge doc-badge-failed"
                                onClick={() => toggleErrorDetail(d.file_name)}
                                aria-expanded={errOpen}
                                title={d.error ?? 'Error durante la ingesta'}
                              >
                                <IconAlert size={11} />
                                Error
                              </button>
                            )}

                            {/* gestión solo para admin: el lector ve la
                                ficha completa, sin acciones */}
                            {canManage &&
                              (isDeleting ? (
                                <span
                                  className="doc-lock"
                                  role="status"
                                  aria-label={`Borrando ${d.file_name}`}
                                >
                                  <IconSpinner size={14} />
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="doc-action-btn"
                                  onClick={() => setConfirmFor(d.file_name)}
                                  title="Borrar del índice"
                                  aria-label={`Borrar ${d.file_name} del índice`}
                                >
                                  <IconTrash size={15} />
                                </button>
                              ))}
                          </>
                        )}
                      </span>
                    </div>

                    {d.status === 'failed' && errOpen && (
                      <div className="doc-error-detail">
                        {d.error ?? 'Error desconocido durante la ingesta.'}
                      </div>
                    )}
                    {rowError !== undefined && <div className="doc-row-error">{rowError}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
