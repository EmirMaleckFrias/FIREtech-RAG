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
// - Notion (solo admin) es un bloque propio, `NotionBloque`: la administradora
//   conecta su espacio con UN botón (OAuth), elige la base en un desplegable y
//   ve la sincronización avanzar en vivo por la suscripción a
//   `notion.admin.estado`. Quien lo usa es una médica: aquí no se habla de
//   tokens, variables ni ids, y los textos viven en lib/notion.ts.

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
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { avisarSiEsFatal } from '../lib/auth';
import { mensajeDeError } from '../lib/errores';
import {
  describirCorrida,
  describirProgreso,
  fraccionProgreso,
  iconoEsImagen,
  plural,
  textoDeAviso,
} from '../lib/notion';
import { sha256De, subirFichero } from '../lib/subida';
import { useSheetDrag } from '../lib/useSheetDrag';
import type { AvisoNotion, BaseNotion, DocumentInfo, DocumentStatus, EstadoNotion } from '../types';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
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
  /** Con qué volvió la usuaria de la pantalla de Notion (`?notion=` en la
   *  URL, leído por App al montar). null si no viene de ahí. */
  notionAviso: AvisoNotion | null;
  onNotionAvisoVisto: () => void;
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
  origen?: string | null;
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
    origen: d.origen === 'notion' || d.origen === 'subida' ? d.origen : null,
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

/** Estilo del contenedor del bloque: la caja de `.docs-readonly-note` (misma
 *  jerarquía visual que la nota de solo lectura) pero en columna, porque aquí
 *  hay varias filas. Inline y no en styles.css a propósito: son tres valores
 *  de disposición sobre una clase que ya existe. */
const COLUMNA = { flexDirection: 'column', alignItems: 'stretch', gap: 8 } as const;
const FILA = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const;
const CRECE = { flex: 1, minWidth: 0 } as const;

type OcupadoNotion = 'conectar' | 'guardar' | 'sincronizar' | 'desconectar' | null;

interface NotionBloqueProps {
  open: boolean;
  /** undefined mientras la suscripción no ha entregado nada. */
  estado: EstadoNotion | undefined;
  aviso: AvisoNotion | null;
  onAvisoVisto: () => void;
}

/**
 * El bloque de Notion del panel, para la administradora.
 *
 * Cuatro situaciones, decididas por el servidor (`notion.admin.estado`):
 * - No habilitada: el equipo técnico aún no registró la integración. Texto
 *   en llano, sin botón: no se ofrece nada que vaya a fallar.
 * - Habilitada y sin conexión: UN botón, "Conectar con Notion", que lleva a
 *   la pantalla de Notion donde ella elige qué compartir.
 * - Conectada: a qué espacio, el desplegable de bases (se pide a Notion al
 *   abrir el selector), Guardar, y con base elegida "Sincronizar ahora", el
 *   resumen de la última corrida y Desconectar (dos pasos).
 * - Sincronizando: barra y "8 de 20 páginas, ahora: <título>", en vivo.
 */
function NotionBloque({ open, estado, aviso, onAvisoVisto }: NotionBloqueProps) {
  const iniciar = useMutation(api.notion.oauth.iniciar);
  const listarBases = useAction(api.notion.oauth.listarBases);
  const elegirBase = useMutation(api.notion.oauth.elegirBase);
  const desconectar = useMutation(api.notion.oauth.desconectar);
  const sincronizarAhora = useMutation(api.notion.admin.sincronizarAhora);

  const [ocupado, setOcupado] = useState<OcupadoNotion>(null);
  const [error, setError] = useState<string | null>(null);
  const [bases, setBases] = useState<BaseNotion[] | null>(null);
  const [basesError, setBasesError] = useState<string | null>(null);
  const [basesCargando, setBasesCargando] = useState(false);
  /** La administradora pulsó "Cambiar" teniendo ya una base elegida. */
  const [eligiendo, setEligiendo] = useState(false);
  const [seleccion, setSeleccion] = useState('');
  const [confirmDesconectar, setConfirmDesconectar] = useState(false);
  const [avisosAbiertos, setAvisosAbiertos] = useState(false);

  const conexion = estado?.conexion ?? null;
  const conectadoEn = conexion?.conectadoEn ?? null;
  const base = estado?.base ?? null;
  const baseId = base?.id ?? null;
  const baseTitulo = base?.titulo ?? null;
  const enCurso = estado?.enCurso ?? null;
  const ultima = estado?.ultimas[0] ?? null;
  const mostrarSelector = conexion !== null && (base === null || eligiendo);

  const cargarBases = useCallback(async () => {
    setBasesCargando(true);
    setBasesError(null);
    try {
      setBases(await listarBases({}));
    } catch (err) {
      if (!avisarSiEsFatal(err)) {
        setBasesError(mensajeDeError(err, 'No se pudo leer la lista de bases de datos de Notion.'));
      }
    } finally {
      setBasesCargando(false);
    }
  }, [listarBases]);

  // Otra conexión (o ninguna): la lista de bases y lo abierto ya no valen.
  useEffect(() => {
    setBases(null);
    setBasesError(null);
    setEligiendo(false);
    setConfirmDesconectar(false);
    setSeleccion('');
  }, [conectadoEn]);

  // La lista se pide a Notion solo cuando hace falta el desplegable y aún no
  // se tiene. Tras un fallo no se reintenta solo: hay botón para eso.
  useEffect(() => {
    if (!open || !mostrarSelector || bases !== null || basesCargando || basesError !== null) return;
    void cargarBases();
  }, [open, mostrarSelector, bases, basesCargando, basesError, cargarBases]);

  // Opciones del desplegable. Si la base en uso no está entre las que Notion
  // enseña (venía configurada por el equipo técnico), se ofrece igual para
  // que salga preseleccionada y se pueda conservar.
  const opciones = useMemo<BaseNotion[]>(() => {
    const lista = bases ?? [];
    if (baseId !== null && !lista.some((b) => b.id === baseId)) {
      return [
        { id: baseId, titulo: baseTitulo ?? 'La configurada por el equipo técnico', ultimaEdicion: '' },
        ...lista,
      ];
    }
    return lista;
  }, [bases, baseId, baseTitulo]);

  // Preselección: la base en uso; si no hay y solo se ve una, esa.
  useEffect(() => {
    if (bases === null) return;
    setSeleccion((actual) => {
      if (actual !== '' && opciones.some((b) => b.id === actual)) return actual;
      if (baseId !== null) return baseId;
      return opciones.length === 1 ? opciones[0].id : '';
    });
  }, [bases, opciones, baseId]);

  const conectar = useCallback(async () => {
    setError(null);
    setOcupado('conectar');
    try {
      const { url } = await iniciar({ origen: window.location.origin });
      // Se abandona la app: el botón se queda "Abriendo Notion…" hasta que
      // el navegador navega, sin rebotar a su estado normal.
      window.location.assign(url);
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudo abrir la conexión con Notion.'));
      setOcupado(null);
    }
  }, [iniciar]);

  const guardar = useCallback(async () => {
    const elegida = opciones.find((b) => b.id === seleccion);
    if (!elegida) return;
    setError(null);
    setOcupado('guardar');
    try {
      await elegirBase({ databaseId: elegida.id, titulo: elegida.titulo });
      setEligiendo(false);
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudo guardar la base de datos elegida.'));
    } finally {
      setOcupado(null);
    }
  }, [elegirBase, opciones, seleccion]);

  const sincronizar = useCallback(async () => {
    setError(null);
    setOcupado('sincronizar');
    try {
      await sincronizarAhora({});
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudo lanzar la sincronización con Notion.'));
    } finally {
      setOcupado(null);
    }
  }, [sincronizarAhora]);

  const handleDesconectar = useCallback(async () => {
    setConfirmDesconectar(false);
    setError(null);
    setOcupado('desconectar');
    try {
      await desconectar({});
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudo desconectar Notion.'));
    } finally {
      setOcupado(null);
    }
  }, [desconectar]);

  // Escape recoge lo abierto aquí antes de que el panel lo interprete como
  // "cerrar": primero la confirmación, luego el selector de cambio de base.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    if (confirmDesconectar) {
      e.stopPropagation();
      setConfirmDesconectar(false);
    } else if (eligiendo) {
      e.stopPropagation();
      setEligiendo(false);
    }
  };

  const fraccion = enCurso !== null ? fraccionProgreso(enCurso) : null;
  const cambiosEnCurso =
    enCurso !== null ? enCurso.nuevos + enCurso.actualizados + enCurso.borrados : 0;

  /** Fila de sincronización: el avance en vivo, o el botón y el resumen de
   *  la última corrida con sus avisos plegados. */
  const filaSincronizacion = () =>
    enCurso !== null ? (
      <div className="upload-progress" style={{ padding: '10px 12px', gap: 6 }} role="status">
        <span className="upload-status">{describirProgreso(enCurso)}</span>
        <div className="upload-bar" aria-hidden="true">
          {fraccion === null ? (
            <div className="upload-fill upload-fill-indeterminate" />
          ) : (
            <div className="upload-fill" style={{ transform: `scaleX(${fraccion})` }} />
          )}
        </div>
        {cambiosEnCurso > 0 && (
          <span className="upload-status">
            Hasta ahora: {plural(enCurso.nuevos, 'documento nuevo', 'documentos nuevos')}
            {enCurso.actualizados > 0 && `, ${plural(enCurso.actualizados, 'actualizado', 'actualizados')}`}
            {enCurso.borrados > 0 && `, ${plural(enCurso.borrados, 'retirado', 'retirados')}`}
          </span>
        )}
      </div>
    ) : (
      <>
        <div style={FILA}>
          <span style={CRECE}>
            {ultima !== null ? describirCorrida(ultima) : 'Todavía no se ha sincronizado.'}
            {estado !== undefined && estado.documentos > 0 && (
              <>
                {' · '}
                {plural(estado.documentos, 'documento', 'documentos')} en el índice
              </>
            )}
          </span>
          <button
            type="button"
            className="user-act-btn user-act-promote"
            disabled={ocupado !== null}
            onClick={() => void sincronizar()}
            title="Traer ahora los cambios de Notion"
          >
            {ocupado === 'sincronizar' ? <IconSpinner size={13} /> : <IconRefresh size={13} />}
            Sincronizar ahora
          </button>
        </div>
        {ultima !== null && ultima.errores.length > 0 && (
          <>
            <button
              type="button"
              className="doc-badge doc-badge-failed"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setAvisosAbiertos((v) => !v)}
              aria-expanded={avisosAbiertos}
            >
              <IconAlert size={11} />
              {plural(ultima.errores.length, 'aviso', 'avisos')} en la última sincronización
              <IconChevronDown size={11} />
            </button>
            {avisosAbiertos && (
              <ul className="doc-error-detail" style={{ margin: 0, padding: '0 0 0 16px' }}>
                {ultima.errores.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </>
    );

  return (
    <div onKeyDown={handleKeyDown}>
      {/* aviso al volver de la pantalla de Notion */}
      {aviso !== null &&
        (aviso.tipo === 'conectado' ? (
          <div className="docs-readonly-note" role="status">
            <IconCheck size={13} />
            <span style={CRECE}>{textoDeAviso(aviso)}</span>
            <button
              type="button"
              className="icon-btn"
              onClick={onAvisoVisto}
              title="Cerrar aviso"
              aria-label="Cerrar aviso"
            >
              <IconX size={13} />
            </button>
          </div>
        ) : (
          <div className="docs-poll-warn" role="alert">
            <IconAlert size={14} />
            <span style={CRECE}>{textoDeAviso(aviso)}</span>
            <button type="button" onClick={onAvisoVisto}>
              Entendido
            </button>
          </div>
        ))}

      <div className="docs-readonly-note" style={COLUMNA} aria-live="polite">
        {estado === undefined ? (
          <span className="shimmer-text">Comprobando la conexión con Notion…</span>
        ) : conexion === null ? (
          <>
            <div style={FILA}>
              {!estado.habilitada && !estado.porEntorno && <IconLock size={13} />}
              <span style={CRECE}>
                <strong>Notion</strong>
                {' · '}
                {estado.porEntorno
                  ? 'Configurado por el equipo técnico.'
                  : estado.habilitada
                    ? 'Trae los protocolos y guías directamente desde Notion.'
                    : 'La conexión con Notion aún no está habilitada por el equipo técnico.'}
              </span>
              {estado.habilitada && (
                <button
                  type="button"
                  className="user-act-btn user-act-promote"
                  disabled={ocupado !== null}
                  onClick={() => void conectar()}
                >
                  {ocupado === 'conectar' ? (
                    <>
                      <IconSpinner size={13} />
                      Abriendo Notion…
                    </>
                  ) : (
                    'Conectar con Notion'
                  )}
                </button>
              )}
            </div>
            {estado.porEntorno && filaSincronizacion()}
          </>
        ) : (
          <>
            <div style={FILA}>
              {iconoEsImagen(conexion.workspaceIcon) ? (
                <img
                  src={conexion.workspaceIcon ?? undefined}
                  alt=""
                  width={16}
                  height={16}
                  style={{ borderRadius: 3, flexShrink: 0 }}
                />
              ) : conexion.workspaceIcon ? (
                <span aria-hidden="true">{conexion.workspaceIcon}</span>
              ) : (
                <IconCheck size={13} />
              )}
              <span style={CRECE}>
                Conectado a <strong>{conexion.workspaceName}</strong>
              </span>
              {!confirmDesconectar && (
                <button
                  type="button"
                  className="user-act-btn user-act-danger"
                  style={{ marginLeft: 0 }}
                  disabled={ocupado !== null || enCurso !== null}
                  onClick={() => setConfirmDesconectar(true)}
                >
                  {ocupado === 'desconectar' ? <IconSpinner size={13} /> : null}
                  Desconectar
                </button>
              )}
            </div>

            {confirmDesconectar && (
              <div className="user-confirm user-confirm-danger" role="group" aria-label="Confirmar desconexión">
                <span className="user-confirm-text" aria-live="polite">
                  <IconAlert size={13} />
                  <span>
                    ¿Desconectar Notion? Los documentos ya traídos se conservan, pero dejarán de
                    actualizarse.
                  </span>
                </span>
                <span className="user-confirm-actions">
                  <button
                    type="button"
                    className="doc-confirm-btn user-confirm-delete"
                    onClick={() => void handleDesconectar()}
                  >
                    Desconectar
                  </button>
                  {/* el foco entra en Cancelar: la salida segura es la primera
                      y el botón que confirma cae en otro sitio que el que abrió
                      la confirmación, así un doble clic no desconecta nada */}
                  <button
                    type="button"
                    className="doc-confirm-btn doc-confirm-no"
                    onClick={() => setConfirmDesconectar(false)}
                    autoFocus
                  >
                    Cancelar
                  </button>
                </span>
              </div>
            )}

            {mostrarSelector ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="notion-base" style={{ fontWeight: 600 }}>
                  Base de datos a sincronizar
                </label>
                {bases === null && basesError === null ? (
                  <span className="shimmer-text">Buscando tus bases de datos…</span>
                ) : basesError !== null ? (
                  <div style={FILA}>
                    <span className="doc-row-error" style={{ padding: 0, ...CRECE }}>
                      {basesError}
                    </span>
                    <button
                      type="button"
                      className="doc-confirm-btn doc-confirm-no"
                      onClick={() => void cargarBases()}
                    >
                      Reintentar
                    </button>
                  </div>
                ) : opciones.length === 0 ? (
                  <div style={FILA}>
                    <span style={CRECE}>
                      Notion no compartió ninguna base de datos con la aplicación. Vuelve a pulsar
                      "Conectar con Notion" y marca la base que quieres compartir.
                    </span>
                    <button
                      type="button"
                      className="user-act-btn user-act-promote"
                      disabled={ocupado !== null}
                      onClick={() => void conectar()}
                    >
                      {ocupado === 'conectar' ? <IconSpinner size={13} /> : null}
                      Conectar con Notion
                    </button>
                  </div>
                ) : (
                  <div style={FILA}>
                    <select
                      id="notion-base"
                      className="auth-input"
                      style={{ fontSize: 13, padding: '6px 8px', ...CRECE }}
                      value={seleccion}
                      onChange={(e) => setSeleccion(e.target.value)}
                      disabled={ocupado !== null}
                    >
                      {seleccion === '' && <option value="">Elige una base de datos</option>}
                      {opciones.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.titulo}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="user-act-btn user-act-promote"
                      disabled={seleccion === '' || ocupado !== null}
                      onClick={() => void guardar()}
                    >
                      {ocupado === 'guardar' ? <IconSpinner size={13} /> : null}
                      Guardar
                    </button>
                    {base !== null && (
                      <button
                        type="button"
                        className="doc-confirm-btn doc-confirm-no"
                        onClick={() => setEligiendo(false)}
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              base !== null && (
                <div style={FILA}>
                  <span style={CRECE}>
                    Base de datos:{' '}
                    <strong>{base.titulo ?? 'la configurada por el equipo técnico'}</strong>
                  </span>
                  <button
                    type="button"
                    className="doc-confirm-btn doc-confirm-no"
                    disabled={ocupado !== null || enCurso !== null}
                    onClick={() => setEligiendo(true)}
                  >
                    Cambiar
                  </button>
                </div>
              )
            )}

            {base !== null && !mostrarSelector && filaSincronizacion()}
          </>
        )}

        {error !== null && (
          <span className="doc-row-error" style={{ padding: 0 }} role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export function DocumentsPanel({
  open,
  onClose,
  canManage,
  notionAviso,
  onNotionAvisoVisto,
}: DocumentsPanelProps) {
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

  // Notion: solo para admin y con el panel abierto, como las estadísticas.
  // La suscripción hace que el avance de la sincronización (página a página)
  // y el paso a la cifra final lleguen solos, sin sondeo.
  const notion = useQuery(api.notion.admin.estado, open && canManage ? {} : 'skip') as
    | EstadoNotion
    | undefined;

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

          {/* Notion (solo admin): conectar, elegir la base, sincronizar y ver
              el avance en vivo. Ver NotionBloque. */}
          {canManage && (
            <NotionBloque
              open={open}
              estado={notion}
              aviso={notionAviso}
              onAvisoVisto={onNotionAvisoVisto}
            />
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
                // Etiqueta discreta: lo trajo la sincronización, no una subida.
                if (d.origen === 'notion') metaParts.push('Notion');
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
