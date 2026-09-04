// Slide-over de gestión de documentos indexados. Siempre montado, como
// SourcesPanel, y oculto vía la clase docs-closed, así el estado de una subida
// sobrevive a cerrar el panel.
//
// Decisiones:
// - Roles: todos ven la lista completa, pero subir, reindexar y borrar es
//   exclusivo de admin. Con canManage en false no se monta ni la dropzone ni
//   los botones: la UI no ofrece nada que el servidor vaya a rechazar.
// - La lista es una suscripción (documentos.listar): el paso de "procesando"
//   a "listo" llega solo. Desaparece el sondeo cada 4 s y su tope de fallos,
//   que existían porque el backend HTTP no podía avisar.
// - Subida en dos pasos: el fichero va al almacenamiento de Convex por una
//   URL firmada (con progreso REAL vía XMLHttpRequest, ver lib/subida.ts) y
//   después documentos.registrar recibe el storageId, el nombre y el sha256
//   calculado en el navegador. Como el original queda guardado, reindexar ya
//   no puede fallar por "el archivo ya no está": se retira el camino de
//   resubida que existía por el disco efímero de Vercel.
// - Focus trap ligero: Tab cicla dentro del panel, Escape cierra (o cancela
//   la confirmación de borrado si está abierta) y el foco vuelve al botón
//   que abrió el panel.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { avisarSiEsFatal } from '../lib/auth';
import { mensajeDeError } from '../lib/errores';
import { sha256De, subirFichero } from '../lib/subida';
import { useSheetDrag } from '../lib/useSheetDrag';
import type { DocumentInfo, DocumentStatus } from '../types';
import {
  IconAlert,
  IconCheck,
  IconDocument,
  IconLock,
  IconRefresh,
  IconSpinner,
  IconTrash,
  IconUpload,
  IconX,
} from './icons';

const JUST_READY_MS = 1_800;
const ALLOWED_EXT_RE = /\.(pdf|docx|xlsx|csv|txt|md)$/i;
/** Mismo valor que `limiteSubidaMb` en convex/lib/config.ts (100 MB). Es solo el
 *  valor de reserva mientras no llega el real por `estadisticas.sistema`; la
 *  subida por URL firmada no limita el tamaño, el techo lo pone la ingesta. */
const DEFAULT_UPLOAD_LIMIT_MB = 100;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DocumentsPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * Solo el rol `admin` sube, reindexa y borra. Un lector ve la lista
   * completa, sin dropzone ni botones. También es false mientras no se conoce
   * el rol: se asume el menor permiso.
   */
  canManage: boolean;
}

/** Lo que el frontend lee de un registro de `documents`. Tipo estructural,
 *  para que un campo que la query añada no rompa nada. */
interface DocumentoDoc {
  _id: Id<'documents'>;
  fileName: string;
  pages?: number;
  chunks?: number;
  status?: string;
  error?: string | null;
  ingestadoEn?: number;
  _creationTime?: number;
}

function normalizeDocumento(d: DocumentoDoc): DocumentInfo {
  const status: DocumentStatus =
    d.status === 'processing' || d.status === 'failed' ? d.status : 'ready';
  return {
    id: d._id,
    fileName: d.fileName,
    pages: typeof d.pages === 'number' ? d.pages : 0,
    chunks: typeof d.chunks === 'number' ? d.chunks : 0,
    status,
    error: typeof d.error === 'string' && d.error !== '' ? d.error : null,
    ingestadoEn:
      typeof d.ingestadoEn === 'number'
        ? d.ingestadoEn
        : typeof d._creationTime === 'number'
          ? d._creationTime
          : 0,
  };
}

type FaseSubida = 'subiendo' | 'registrando';

interface UploadState {
  fileName: string;
  /** Fracción 0..1, o null si el navegador no computa el progreso. */
  progress: number | null;
  fase: FaseSubida;
}

function validateFile(file: File, docs: DocumentInfo[] | null, limitMb: number): string | null {
  if (!ALLOWED_EXT_RE.test(file.name)) {
    return 'Formato no admitido. Solo se aceptan PDF, Word (.docx), XLSX, CSV, TXT o MD.';
  }
  if (file.size > limitMb * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `El archivo pesa ${mb} MB y el máximo permitido es ${limitMb} MB.`;
  }
  if (docs?.some((d) => d.fileName === file.name)) {
    return 'Ya existe un documento con ese nombre. Bórralo antes de volver a subirlo.';
  }
  return null;
}

function ingestedTitle(ms: number): string | undefined {
  if (ms <= 0) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return `Indexado el ${d.toLocaleString('es')}`;
}

export function DocumentsPanel({ open, onClose, canManage }: DocumentsPanelProps) {
  // Suscripción permanente: barata, y así el panel abre con la lista ya
  // puesta y ve pasar a "listo" un documento subido con el panel cerrado.
  const docsQuery = useQuery(api.documentos.listar);
  // El límite de subida lo anuncia el despliegue. Solo lo necesita quien
  // sube, y solo con el panel abierto: es un agregado sobre varias tablas y
  // no merece una suscripción viva permanente.
  const stats = useQuery(api.estadisticas.sistema, open && canManage ? {} : 'skip');
  const limiteAnunciado: unknown = stats?.config?.upload_limit_mb;
  const limitMb =
    typeof limiteAnunciado === 'number' && limiteAnunciado > 0
      ? limiteAnunciado
      : DEFAULT_UPLOAD_LIMIT_MB;

  const urlDeSubida = useMutation(api.documentos.urlDeSubida);
  const registrar = useMutation(api.documentos.registrar);
  const reindexar = useMutation(api.documentos.reindexar);
  const borrar = useMutation(api.documentos.borrar);

  // Más recientes primero, como devolvía el backend anterior.
  const docs = useMemo<DocumentInfo[] | null>(
    () =>
      docsQuery === undefined
        ? null
        : docsQuery.map(normalizeDocumento).sort((a, b) => b.ingestadoEn - a.ingestadoEn),
    [docsQuery],
  );

  const [upload, setUpload] = useState<UploadState | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [confirmFor, setConfirmFor] = useState<Id<'documents'> | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [reindexing, setReindexing] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [openErrors, setOpenErrors] = useState<Set<string>>(new Set());
  const [justReady, setJustReady] = useState<Set<string>>(new Set());

  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const prevDocsRef = useRef<DocumentInfo[] | null>(null);
  const readyTimersRef = useRef<number[]>([]);

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

  // Transiciones processing -> ready: micro-animación de éxito. Se detectan
  // comparando cada lista con la anterior, que es lo que antes hacía el
  // sondeo; ahora las entrega la suscripción.
  useEffect(() => {
    const prev = prevDocsRef.current;
    prevDocsRef.current = docs;
    if (prev === null || docs === null) return;
    const prevStatus = new Map(prev.map((d) => [d.id, d.status]));
    const becameReady = docs
      .filter((d) => d.status === 'ready' && prevStatus.get(d.id) === 'processing')
      .map((d) => d.id);
    if (becameReady.length === 0) return;
    setJustReady((s) => new Set([...s, ...becameReady]));
    for (const id of becameReady) {
      const timer = window.setTimeout(() => {
        setJustReady((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }, JUST_READY_MS);
      readyTimersRef.current.push(timer);
    }
  }, [docs]);

  // Foco: al abrir entra al botón de cerrar; al cerrar vuelve a donde estaba.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, [open]);

  // --- subida ---
  const startUpload = useCallback(
    async (file: File) => {
      if (uploadAbortRef.current !== null) return; // ya hay una subida en curso
      setUploadError(null);

      const invalid = validateFile(file, docs, limitMb);
      if (invalid !== null) {
        setUploadError(invalid);
        return;
      }

      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setUpload({ fileName: file.name, progress: 0, fase: 'subiendo' });

      try {
        // La URL firmada y el hash se piden a la vez: el hash recorre el
        // fichero en memoria y no depende de la red.
        const [url, sha256] = await Promise.all([urlDeSubida({}), sha256De(file)]);
        if (controller.signal.aborted) throw new DOMException('Subida cancelada', 'AbortError');
        const storageId = await subirFichero(
          url,
          file,
          (fraction) => {
            setUpload((u) => (u === null ? u : { ...u, progress: fraction }));
          },
          controller.signal,
        );
        // Subido: ahora el servidor lo registra y agenda la ingesta. Ya no se
        // puede cancelar (el fichero está arriba), por eso cambia el texto.
        setUpload((u) => (u === null ? u : { ...u, progress: 1, fase: 'registrando' }));
        await registrar({
          storageId: storageId as Id<'_storage'>,
          fileName: file.name,
          sha256,
        });
        // Aparece como "Procesando" en cuanto la suscripción lo entregue.
      } catch (err) {
        if (controller.signal.aborted) {
          // cancelado a mano: sin aviso
        } else if (!avisarSiEsFatal(err)) {
          setUploadError(
            err instanceof DOMException
              ? 'No se pudo subir el archivo.'
              : mensajeDeError(
                  err,
                  err instanceof Error && err.message !== ''
                    ? err.message
                    : 'No se pudo subir el archivo.',
                ),
          );
        }
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
        setUpload(null);
      }
    },
    [docs, limitMb, registrar, urlDeSubida],
  );

  // --- borrado con confirmación inline de dos pasos ---
  const handleDelete = useCallback(
    async (doc: DocumentInfo) => {
      setConfirmFor(null);
      setRowErrors((errs) => {
        const next = { ...errs };
        delete next[doc.id];
        return next;
      });
      setDeleting((s) => new Set(s).add(doc.id));
      try {
        await borrar({ documentId: doc.id });
        // La fila desaparece con la siguiente entrega de la suscripción, que
        // llega antes de que esta promesa se resuelva.
      } catch (err) {
        if (!avisarSiEsFatal(err)) {
          setRowErrors((errs) => ({
            ...errs,
            [doc.id]: mensajeDeError(err, 'No se pudo borrar el documento.'),
          }));
        }
      } finally {
        setDeleting((s) => {
          const next = new Set(s);
          next.delete(doc.id);
          return next;
        });
      }
    },
    [borrar],
  );

  /**
   * Reintenta la indexación de un documento que falló.
   *
   * Casi siempre falla por algo transitorio (un timeout del gateway, un
   * corte a mitad de embeber), y sin esto la única salida era borrar la fila
   * y volver a buscar el archivo. El fichero original está en el
   * almacenamiento, así que el servidor lo relee de ahí.
   */
  const handleReindex = useCallback(
    async (doc: DocumentInfo) => {
      setRowErrors((errs) => {
        const next = { ...errs };
        delete next[doc.id];
        return next;
      });
      setReindexing((s) => new Set(s).add(doc.id));
      try {
        await reindexar({ documentId: doc.id });
      } catch (err) {
        if (!avisarSiEsFatal(err)) {
          setRowErrors((errs) => ({
            ...errs,
            [doc.id]: mensajeDeError(err, 'No se pudo reindexar el documento.'),
          }));
        }
      } finally {
        setReindexing((s) => {
          const next = new Set(s);
          next.delete(doc.id);
          return next;
        });
      }
    },
    [reindexar],
  );

  const toggleErrorDetail = (id: string) => {
    setOpenErrors((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const showSkeleton = docs === null;

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
                    {upload.fase === 'subiendo' && (
                      <button
                        type="button"
                        className="upload-cancel"
                        onClick={() => uploadAbortRef.current?.abort()}
                      >
                        Cancelar
                      </button>
                    )}
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
                    {upload.fase === 'registrando' ? (
                      <span className="shimmer-text">Registrando el documento…</span>
                    ) : upload.progress === null ? (
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
                const isDeleting = deleting.has(d.id);
                const isReindexing = reindexing.has(d.id);
                const isConfirm = confirmFor === d.id;
                const errOpen = openErrors.has(d.id);
                const popped = justReady.has(d.id);
                const rowError = rowErrors[d.id];
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
                    key={d.id}
                    className={`doc-card ${popped ? 'doc-card-ready-flash' : ''}`}
                  >
                    <div className="doc-row">
                      <span className="doc-icon" aria-hidden="true">
                        <IconDocument size={15} />
                      </span>
                      <span className="doc-info">
                        <span className="doc-file" title={ingestedTitle(d.ingestadoEn)}>
                          {d.fileName}
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
                              onClick={() => void handleDelete(d)}
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
                                onClick={() => toggleErrorDetail(d.id)}
                                aria-expanded={errOpen}
                                title={d.error ?? 'Error durante la ingesta'}
                              >
                                <IconAlert size={11} />
                                Error
                              </button>
                            )}

                            {/* Reintentar: solo en los fallidos y solo para
                                admin. Va ANTES de la papelera a propósito:
                                reintentar es la acción esperada ante un error,
                                y borrar la de último recurso. */}
                            {canManage && d.status === 'failed' && (
                              <button
                                type="button"
                                className="doc-action-btn"
                                disabled={isReindexing}
                                onClick={() => void handleReindex(d)}
                                title="Reintentar la indexación"
                                aria-label={`Reintentar la indexación de ${d.fileName}`}
                              >
                                {isReindexing ? (
                                  <IconSpinner size={14} />
                                ) : (
                                  <IconRefresh size={14} />
                                )}
                              </button>
                            )}

                            {/* gestión solo para admin: el lector ve la
                                ficha completa, sin acciones */}
                            {canManage &&
                              (isDeleting ? (
                                <span
                                  className="doc-lock"
                                  role="status"
                                  aria-label={`Borrando ${d.fileName}`}
                                >
                                  <IconSpinner size={14} />
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="doc-action-btn"
                                  onClick={() => setConfirmFor(d.id)}
                                  title="Borrar del índice"
                                  aria-label={`Borrar ${d.fileName} del índice`}
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
