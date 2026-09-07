// Slide-over de gestión de documentos indexados. Siempre montado, como
// SourcesPanel, y oculto vía la clase docs-closed, así el estado de una subida
// sobrevive a cerrar el panel.
//
// Decisiones:
// - **Cada persona ve y gestiona SU corpus**, y solo el suyo: la lista, la
//   subida, el reindexado, el borrado y Notion son de quien tiene la sesión
//   abierta (ver `propietario` en convex/schema.ts). Ya no hay un rol que
//   mire y otro que gestione, así que desapareció el `canManage` que apagaba
//   la dropzone y los botones; ser administrador sirve para gestionar cuentas
//   y ver estadísticas, no para tocar los documentos de nadie.
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
// - Notion es un bloque propio, `NotionBloque` (y Google Drive y OneDrive
//   son `NubeBloque`, en su fichero): cada usuaria conecta SU
//   espacio con UN botón (OAuth, en una ventana emergente que no abandona la
//   app), elige la base en un desplegable y ve la sincronización avanzar en
//   vivo por la suscripción a `notion.admin.estado`. Quien lo usa es una
//   médica: aquí no se habla de tokens, variables ni ids, y los textos viven
//   en lib/notion.ts.

import {
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
import {
  abrirEmergenteEnBlanco,
  cerrarEmergente,
  llevarEmergenteA,
  marcarRespaldoPaginaCompleta,
} from '../lib/notionEmergente';
import {
  SUBIDAS_A_LA_VEZ,
  desdeDrop,
  desdeInputDeCarpeta,
  planificar,
  resumenDeTanda,
  textoDeMotivo,
  type ArchivoConRuta,
  type ArchivoOmitido,
  type ArchivoPlaneado,
} from '../lib/carpetas';
import type { Documentos } from '../lib/useDocumentos';
import { sha256De, subirFichero } from '../lib/subida';
import { useSheetDrag } from '../lib/useSheetDrag';
import { BandaCorpus } from './BandaCorpus';
import { FichaDocumento } from './FichaDocumento';
import { NubeBloque } from './NubeBloque';
import type { AvisoNotion, AvisoNube, BaseNotion, DocumentStatus, EstadoNotion } from '../types';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconDocument,
  IconLock,
  IconRefresh,
  IconSpinner,
  IconUpload,
  IconX,
} from './icons';

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
  /** Con qué volvió la usuaria de la pantalla de Notion (`?notion=` en la
   *  URL, leído por App al montar). null si no viene de ahí. */
  notionAviso: AvisoNotion | null;
  onNotionAvisoVisto: () => void;
  /** Lo mismo para Google Drive y OneDrive (`?nube=…`). Cada bloque recibe
   *  solo el aviso de su proveedor. */
  nubeAviso: AvisoNube | null;
  onNubeAvisoVisto: () => void;
  /** Abre la vista de todos los documentos, opcionalmente ya filtrada por un
   *  estado (al pulsar "3 sin leer" en la banda). */
  onVerTodos: (estado: DocumentStatus | null) => void;
  /** La lista suscrita y las acciones, compartidas con la vista de todos para
   *  que no haya dos suscripciones ni dos copias de "borrar". Ver
   *  lib/useDocumentos.ts. */
  documentos: Documentos;
  /** Hay otra capa encima (la vista de todos): el panel sigue abierto debajo
   *  pero no recibe foco ni lo ven los lectores de pantalla. */
  inerte?: boolean;
}

/** Lo que el frontend lee de un registro de `documents`. Tipo estructural,
 *  para que un campo que la query añada no rompa nada. */

/** Un archivo que se está subiendo ahora mismo (hay hasta SUBIDAS_A_LA_VEZ). */
interface SubidaEnVuelo {
  nombre: string;
  /** Fracción 0..1, o null si el navegador no computa el progreso. */
  progreso: number | null;
}

/**
 * La tanda en curso: uno o muchos archivos (una carpeta entera), con una sola
 * barra. Es lo que antes era `UploadState` para un archivo, generalizado, y el
 * caso de un archivo sigue siendo una tanda de uno.
 *
 * - `preparando`: se calculan los hashes y se decide qué se sube y qué se
 *   omite (ver lib/carpetas.ts). Con carpetas grandes tarda unos segundos.
 * - `subiendo`: la cola avanza; `hechos` cuenta terminados, bien o mal.
 * - `terminada`: se enseña el resumen (subidos, fallidos, omitidos y por
 *   qué). Si no hay nada que contar más allá de "todo bien", se cierra solo.
 */
interface ColaSubida {
  fase: 'preparando' | 'subiendo' | 'terminada';
  total: number;
  hechos: number;
  ok: number;
  enVuelo: SubidaEnVuelo[];
  fallidos: Array<{ nombre: string; motivo: string }>;
  omitidos: ArchivoOmitido[];
  /** Se cortó al tope de archivos por tanda: hay que subir el resto aparte. */
  truncada: boolean;
  cancelada: boolean;
}

/** Fracción global de la barra: terminados más lo avanzado de los que van. */
function fraccionDeCola(c: ColaSubida): number | null {
  if (c.total === 0) return null;
  const parcial = c.enVuelo.reduce((suma, s) => suma + (s.progreso ?? 0), 0);
  return Math.min(1, (c.hechos + parcial) / c.total);
}

/** ¿Hay algo que la usuaria deba leer antes de cerrar el resumen? */
function colaMereceResumen(c: ColaSubida): boolean {
  return c.fallidos.length > 0 || c.omitidos.length > 0 || c.truncada || c.cancelada;
}

const FILA = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const;
const CRECE = { flex: 1, minWidth: 0 } as const;

type OcupadoNotion = 'conectar' | 'guardar' | 'sincronizar' | 'desconectar' | null;

interface NotionBloqueProps {
  open: boolean;
  /** Los tres pasos de "cómo conectar": solo mientras el corpus está vacío. */
  mostrarPasos: boolean;
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
function NotionBloque({ open, mostrarPasos, estado, aviso, onAvisoVisto }: NotionBloqueProps) {
  const iniciar = useMutation(api.notion.oauth.iniciar);
  const listarBases = useAction(api.notion.oauth.listarBases);
  const elegirBases = useMutation(api.notion.oauth.elegirBases);
  const desconectar = useMutation(api.notion.oauth.desconectar);
  const sincronizarAhora = useMutation(api.notion.admin.sincronizarAhora);

  const [ocupado, setOcupado] = useState<OcupadoNotion>(null);
  const [error, setError] = useState<string | null>(null);
  const [bases, setBases] = useState<BaseNotion[] | null>(null);
  const [basesError, setBasesError] = useState<string | null>(null);
  const [basesCargando, setBasesCargando] = useState(false);
  /** Pulsó "Cambiar" teniendo ya bases elegidas. */
  const [eligiendo, setEligiendo] = useState(false);
  /** Los ids marcados en la lista de casillas, mientras elige. */
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [confirmDesconectar, setConfirmDesconectar] = useState(false);
  const [avisosAbiertos, setAvisosAbiertos] = useState(false);
  /** La emergente de Notion está abierta y se espera su respuesta. */
  const [esperandoNotion, setEsperandoNotion] = useState(false);
  const emergente = useRef<Window | null>(null);

  const conexion = estado?.conexion ?? null;
  const conectadoEn = conexion?.conectadoEn ?? null;
  /** Las bases que se están sincronizando. Varias a propósito: sus guías
   *  pueden estar en una y sus protocolos en otra. */
  const basesElegidas = estado?.bases ?? [];
  // Viva solo hasta `vivaHasta`: una corrida que murió sin cerrarse no puede
  // dejar el panel en "sincronizando" para siempre.
  const enCurso = estado?.enCurso && estado.enCurso.vivaHasta > Date.now() ? estado.enCurso : null;
  const ultima = estado?.ultimas[0] ?? null;
  const mostrarSelector = conexion !== null && (basesElegidas.length === 0 || eligiendo);

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
    setSeleccion([]);
  }, [conectadoEn]);

  // La lista se pide a Notion solo cuando hace falta el desplegable y aún no
  // se tiene. Tras un fallo no se reintenta solo: hay botón para eso.
  useEffect(() => {
    if (!open || !mostrarSelector || bases !== null || basesCargando || basesError !== null) return;
    void cargarBases();
  }, [open, mostrarSelector, bases, basesCargando, basesError, cargarBases]);

  // Opciones de la lista. Una base que ya se sincroniza pero que Notion no
  // enseña (dejó de compartirse) se ofrece igual, marcada, para que se vea que
  // está y se pueda desmarcar a conciencia.
  const opciones = useMemo<BaseNotion[]>(() => {
    const lista = bases ?? [];
    const faltan = basesElegidas
      .filter((e) => !lista.some((b) => b.id === e.id))
      .map((e) => ({ id: e.id, titulo: e.titulo, ultimaEdicion: '' }));
    return [...faltan, ...lista];
  }, [bases, basesElegidas]);

  // Preselección: lo que ya se sincroniza; si no hay nada y Notion solo
  // comparte una base, esa, que es lo que ella iba a marcar de todas formas.
  //
  // NO espera a que Notion responda, y eso lo destapó una prueba con un token
  // que Notion rechaza: con `if (bases === null) return` las casillas de las
  // bases que YA se sincronizan salían desmarcadas, así que pulsar Guardar las
  // habría quitado todas. Las bases elegidas se conocen sin preguntarle nada a
  // Notion (están en la conexión), así que se marcan igual.
  //
  // Y depende de la LISTA de ids, no de la identidad del array: `estado` se
  // re-emite cada pocas páginas durante una sincronización y traía un array
  // nuevo con las mismas bases; el efecto volvía a correr y, si ella acababa
  // de desmarcarlo todo para cambiar de base, se lo volvía a marcar solo.
  const claveElegidas = basesElegidas.map((b) => b.id).join(',');
  const elegidasRef = useRef(basesElegidas);
  elegidasRef.current = basesElegidas;
  useEffect(() => {
    if (bases === null && basesError === null) return;
    const elegidas = elegidasRef.current;
    setSeleccion((actual) => {
      if (actual.length > 0) return actual;
      if (elegidas.length > 0) return elegidas.map((b) => b.id);
      return bases !== null && bases.length === 1 ? [bases[0].id] : [];
    });
  }, [bases, basesError, claveElegidas]);

  /** Deja de esperar: cierra la emergente si sigue abierta y retira la marca. */
  const cancelarEspera = useCallback(() => {
    cerrarEmergente(emergente.current);
    emergente.current = null;
    setEsperandoNotion(false);
    setOcupado(null);
  }, []);

  // Al desmontar (cerrar el panel) no se deja una emergente huérfana esperando
  // una ventana que ya no escucha... salvo que sí escucha: el aviso lo recoge
  // App, que no se desmonta. Así que la emergente se DEJA abierta a propósito
  // y solo se suelta la referencia.
  useEffect(() => () => {
    emergente.current = null;
  }, []);

  /**
   * Conectar con Notion sin abandonar la aplicación.
   *
   * El orden es lo importante: la emergente se abre EN BLANCO dentro del
   * propio clic, porque la URL de autorización llega después de un `await` y
   * para entonces el navegador ya no ve un gesto de la usuaria y la bloquea.
   * Si aun así la bloquea, se cae al redirigido de página completa, que es lo
   * que hacía antes y sigue funcionando.
   */
  const conectar = useCallback(async () => {
    setError(null);
    setOcupado('conectar');
    const ventana = abrirEmergenteEnBlanco();
    if (ventana === null) marcarRespaldoPaginaCompleta();
    emergente.current = ventana;
    try {
      const { url } = await iniciar({ origen: window.location.origin });
      if (ventana === null) {
        // Respaldo: sin emergente se lleva la pestaña, como antes. El botón se
        // queda "Abriendo Notion…" hasta que el navegador navega.
        window.location.assign(url);
        return;
      }
      llevarEmergenteA(ventana, url);
      setOcupado(null);
      setEsperandoNotion(true);
    } catch (err) {
      cerrarEmergente(ventana);
      emergente.current = null;
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudo abrir la conexión con Notion.'));
      setOcupado(null);
    }
  }, [iniciar]);

  // Llegó la respuesta de Notion (App la recibe por el canal y la baja como
  // `aviso`), o la conexión cambió: se deja de esperar.
  useEffect(() => {
    if (aviso !== null || conectadoEn !== null) {
      emergente.current = null;
      setEsperandoNotion(false);
    }
  }, [aviso, conectadoEn]);

  // La usuaria cerró la emergente sin terminar: se suelta la espera. Se usa
  // solo para eso, nunca para deducir un resultado (cerrar la ventana no dice
  // si Notion guardó algo o no; eso lo dice el servidor).
  //
  // Medido el 7 sep 2026 con curl: ni `api.notion.com/v1/oauth/authorize` ni
  // `app.notion.com` mandan `Cross-Origin-Opener-Policy`, así que el manejador
  // de la ventana sobrevive a la navegación y `closed` es fiable. Si algún día
  // lo mandaran, `closed` empezaría a dar true en cuanto navegase y esto se
  // limitaría a quitar la fila de espera antes de tiempo: el aviso seguiría
  // llegando por el canal y la conexión por la suscripción reactiva.
  useEffect(() => {
    if (!esperandoNotion) return;
    const t = window.setInterval(() => {
      const v = emergente.current;
      if (v === null) return;
      let cerrada = false;
      try {
        cerrada = v.closed;
      } catch {
        cerrada = true;
      }
      if (cerrada) {
        emergente.current = null;
        setEsperandoNotion(false);
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [esperandoNotion]);

  const alternar = useCallback((id: string) => {
    setSeleccion((actual) =>
      actual.includes(id) ? actual.filter((x) => x !== id) : [...actual, id],
    );
  }, []);

  const guardar = useCallback(async () => {
    // Se manda la selección COMPLETA: la mutación reemplaza la anterior, así
    // que desmarcar una base es dejar de traer sus cambios (lo ya traído se
    // conserva, como al desconectar).
    const elegidas = opciones
      .filter((b) => seleccion.includes(b.id))
      .map((b) => ({ databaseId: b.id, titulo: b.titulo }));
    if (elegidas.length === 0) return;
    setError(null);
    setOcupado('guardar');
    try {
      await elegirBases({ bases: elegidas });
      setEligiendo(false);
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudieron guardar las bases de datos elegidas.'));
    } finally {
      setOcupado(null);
    }
  }, [elegirBases, opciones, seleccion]);

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

      <section className="notion-card" aria-label="Integración con Notion" aria-live="polite">
        <div className="notion-card-header">
          <div className="notion-brand-mark"><img src="/notion.svg" alt="" width={32} height={32} /></div>
          <div className="notion-card-heading">
            <span className="notion-eyebrow">FUENTES CONECTADAS</span>
            <h3>Notion</h3>
          </div>
          <span className={`notion-connection-badge${conexion !== null ? ' is-connected' : ''}`}>
            {estado === undefined ? <IconSpinner size={11} /> : conexion !== null ? <IconCheck size={11} /> : <IconLock size={11} />}
            {estado === undefined ? 'Cargando' : conexion !== null ? 'Conectado' : 'Sin conectar'}
          </span>
        </div>
        <div className="notion-card-body">
        {estado === undefined ? (
          <span className="shimmer-text">Comprobando la conexión con Notion…</span>
        ) : conexion === null ? (
          <>
            <div style={FILA}>
              {!estado.habilitada && <IconLock size={13} />}
              <span style={CRECE}>
                {estado.habilitada
                  ? 'Trae tus protocolos y guías directamente desde tu Notion.'
                  : 'La conexión con Notion aún no está habilitada por el equipo técnico.'}
              </span>
              {estado.habilitada && !esperandoNotion && (
                <button
                  type="button"
                  className="user-act-btn notion-connect-btn"
                  disabled={ocupado !== null}
                  onClick={() => void conectar()}
                >
                  {ocupado === 'conectar' ? (
                    <>
                      <IconSpinner size={13} />
                      Abriendo Notion…
                    </>
                  ) : (
                    <><img src="/notion.svg" alt="" width={15} height={15} />Conectar con Notion</>
                  )}
                </button>
              )}
            </div>
            {/* Los tres pasos son instrucciones de una sola vez. Con documentos
                ya en el corpus, lo único que hacían era empujar la lista fuera
                de la primera pantalla: quien abre "Documentos" viene a ver sus
                documentos, no a leer cómo se conecta Notion. */}
            {mostrarPasos && (
              <div className="notion-steps" aria-label="Cómo conectar tus documentos">
                <div><span>1</span><strong>Conecta</strong><small>Tu espacio de trabajo</small></div>
                <div><span>2</span><strong>Elige</strong><small>La base que compartirás</small></div>
                <div><span>3</span><strong>Consulta</strong><small>Sus documentos en el chat</small></div>
              </div>
            )}
            {/* La emergente está abierta: se dice dónde mirar y se ofrece
                salir de la espera. La aplicación sigue aquí, entera. */}
            {esperandoNotion && (
              <div style={FILA} role="status">
                <IconSpinner size={13} />
                <span style={CRECE}>
                  Termina en la ventana de Notion que se acaba de abrir: inicia sesión y elige qué
                  páginas compartir. Esta pantalla se actualizará sola.
                </span>
                <button
                  type="button"
                  className="doc-confirm-btn doc-confirm-no"
                  onClick={cancelarEspera}
                >
                  Cancelar
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="notion-workspace" style={FILA}>
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
                <span style={{ fontWeight: 600 }} id="notion-bases-titulo">
                  Bases de datos a sincronizar
                </span>
                {bases === null && basesError === null && (
                  <span className="shimmer-text">Buscando tus bases de datos…</span>
                )}
                {/* Si Notion no responde, el fallo va ENCIMA de la lista y no
                    en lugar de ella: las bases que ya se sincronizan se
                    conocen sin preguntarle nada a Notion, y sacarlas de la
                    pantalla significaría no poder quitar ninguna hasta que
                    Notion volviera. */}
                {basesError !== null && (
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
                )}
                {bases === null && basesError === null ? null : opciones.length === 0 ? (
                  basesError !== null ? null : (
                    <div style={FILA}>
                      <span style={CRECE}>
                        Notion no compartió ninguna base de datos con la aplicación. Vuelve a
                        pulsar "Conectar con Notion" y marca las que quieres compartir.
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
                  )
                ) : (
                  <>
                    {/* Casillas y no un desplegable: se pueden marcar varias,
                        y se ven todas a la vez sin desplegar nada. */}
                    <ul
                      className="notion-bases-lista"
                      role="group"
                      aria-labelledby="notion-bases-titulo"
                    >
                      {opciones.map((b) => (
                        <li key={b.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={seleccion.includes(b.id)}
                              onChange={() => alternar(b.id)}
                              disabled={ocupado !== null}
                            />
                            <span>{b.titulo}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div style={FILA}>
                      <span style={CRECE}>
                        {seleccion.length === 0
                          ? 'Marca al menos una.'
                          : `${plural(seleccion.length, 'base marcada', 'bases marcadas')}.`}
                      </span>
                      <button
                        type="button"
                        className="user-act-btn user-act-promote"
                        disabled={seleccion.length === 0 || ocupado !== null}
                        onClick={() => void guardar()}
                      >
                        {ocupado === 'guardar' ? <IconSpinner size={13} /> : null}
                        Guardar
                      </button>
                      {basesElegidas.length > 0 && (
                        <button
                          type="button"
                          className="doc-confirm-btn doc-confirm-no"
                          onClick={() => setEligiendo(false)}
                        >
                          Cancelar
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              basesElegidas.length > 0 && (
                <div className="notion-selected-base" style={FILA}>
                  <IconDocument size={18} />
                  <span style={CRECE}>
                    {basesElegidas.length === 1 ? 'Base de datos: ' : 'Bases de datos: '}
                    <strong>{basesElegidas.map((b) => b.titulo).join(', ')}</strong>
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

            {basesElegidas.length > 0 && !mostrarSelector && filaSincronizacion()}
          </>
        )}

        {error !== null && (
          <span className="doc-row-error" style={{ padding: 0 }} role="alert">
            {error}
          </span>
        )}
        </div>
        <div className="notion-card-footer"><IconLock size={12} /><span>Solo se consultan las páginas que compartes con la aplicación.</span></div>
      </section>
    </div>
  );
}

export function DocumentsPanel({
  open,
  onClose,
  notionAviso,
  onNotionAvisoVisto,
  nubeAviso,
  onNubeAvisoVisto,
  onVerTodos,
  documentos,
  inerte = false,
}: DocumentsPanelProps) {
  // La lista llega por `documentos` (App la suscribe mientras el panel o la
  // vista de todos están abiertos, y la pone en `skip` si no).

  // El límite de subida lo anuncia el despliegue. Solo lo necesita quien
  // sube, y solo con el panel abierto: es un agregado sobre varias tablas y
  // no merece una suscripción viva permanente.
  // El límite de subida lo anuncia el despliegue por su propia query, que
  // cualquier cuenta puede pedir: ahora sube todo el mundo, no solo un
  // administrador.
  const limiteQuery = useQuery(api.documentos.limite, open ? {} : 'skip');
  const limiteAnunciado: unknown = limiteQuery?.mb;
  const limitMb =
    typeof limiteAnunciado === 'number' && limiteAnunciado > 0
      ? limiteAnunciado
      : DEFAULT_UPLOAD_LIMIT_MB;

  const urlDeSubida = useMutation(api.documentos.urlDeSubida);
  const registrar = useMutation(api.documentos.registrar);

  const { docs, maximo } = documentos;

  // Notion, con el panel abierto. La suscripción hace que el avance de la
  // sincronización (página a página) y el paso a la cifra final lleguen
  // solos, sin sondeo.
  const notion = useQuery(api.notion.admin.estado, open ? {} : 'skip') as
    | EstadoNotion
    | undefined;

  // Más recientes primero, como devolvía el backend anterior.


  const [cola, setCola] = useState<ColaSubida | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** El desplegable de omitidos del resumen. */
  const [omitidosAbiertos, setOmitidosAbiertos] = useState(false);
  const [dragOver, setDragOver] = useState(false);


  const panelRef = useRef<HTMLElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** El selector de CARPETA. Es un input aparte porque `webkitdirectory`
   *  convierte el diálogo en uno de carpetas y deja de admitir archivos. */
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Bottom sheet en móvil: swipe-down sobre el asa cierra el panel.
  useSheetDrag(panelRef, grabberRef, onClose);

  // `inert` no existe como prop en React 18: se pone como atributo. Con la
  // vista de todos encima, sin esto Tab salía de ella y aterrizaba en los
  // botones de este panel, invisibles bajo la capa opaca.
  useEffect(() => {
    panelRef.current?.toggleAttribute('inert', inerte);
  }, [inerte]);

  // Limpieza al desmontar: la subida en vuelo. El destello de "listo" y sus
  // temporizadores los lleva ahora useDocumentos, que es quien ve las
  // entregas de la suscripción.
  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
    },
    [],
  );

  // Foco: al abrir entra al botón de cerrar; al cerrar vuelve a donde estaba.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, [open]);

  // --- subida (uno o muchos archivos, o una carpeta entera) ---
  //
  // Todo entra por aquí: un archivo suelto es una tanda de uno. Los pasos:
  // 1) hashes de todos (en paralelo, de pocos en pocos); 2) el plan: qué se
  // sube con qué nombre y qué se omite y por qué (lib/carpetas.ts); 3) la
  // cola, con SUBIDAS_A_LA_VEZ trabajadores que van cogiendo el siguiente;
  // 4) el resumen, que se cierra solo si no hay nada que contar.
  //
  // Cancelar aborta los XHR en vuelo y deja de coger nuevos; lo ya
  // registrado se queda (está arriba y en proceso, no tiene sentido fingir
  // que no).
  const startUpload = useCallback(
    async (archivos: ArchivoConRuta[], truncada = false, omitidosPrevios: ArchivoOmitido[] = []) => {
      if (uploadAbortRef.current !== null) return; // ya hay una tanda en curso
      if (archivos.length === 0 && omitidosPrevios.length === 0) return;
      // Sin la lista de documentos todavía (los primeros cientos de ms tras
      // abrir el panel) no hay contra qué deduplicar ni evitar choques de
      // nombre: se pide volver a soltarlos, en vez de subir un duplicado o
      // recibir un "ya está indexado" del servidor.
      if (docs === null) {
        setUploadError('Un momento: todavía estoy cargando tu lista de documentos. Vuelve a soltarlos.');
        return;
      }
      setUploadError(null);
      setOmitidosAbiertos(false);

      const controller = new AbortController();
      uploadAbortRef.current = controller;
      const cancelado = () => controller.signal.aborted;
      setCola({
        fase: 'preparando',
        total: archivos.length,
        hechos: 0,
        ok: 0,
        enVuelo: [],
        fallidos: [],
        omitidos: [],
        truncada,
        cancelada: false,
      });

      try {
        // 1) Hashes. De cuatro en cuatro: cada uno lee el fichero entero en
        //    memoria, y una carpeta de cientos de PDF a la vez se la comería.
        const conHash: Array<ArchivoConRuta & { sha256: string }> = [];
        for (let i = 0; i < archivos.length && !cancelado(); i += 4) {
          const lote = archivos.slice(i, i + 4);
          const hashes = await Promise.all(lote.map((a) => sha256De(a.file)));
          lote.forEach((a, j) => conHash.push({ ...a, sha256: hashes[j] }));
        }
        if (cancelado()) throw new DOMException('Subida cancelada', 'AbortError');

        // 2) El plan, contra lo que ya hay en el corpus.
        // Un documento en `failed` no cuenta como "ya está": el servidor
        // reutiliza su fila al volver a subirlo, y decirle "ya estaba en tus
        // documentos" de algo que no se pudo indexar era falso.
        const plan = planificar(
          conHash,
          docs.filter((d) => d.status !== 'failed').map((d) => ({ fileName: d.fileName, sha256: d.sha256 })),
          limitMb,
          omitidosPrevios,
        );
        setCola((c) =>
          c === null
            ? c
            : { ...c, fase: 'subiendo', total: plan.aSubir.length, omitidos: plan.omitidos },
        );

        // 3) La cola.
        const pendientes: ArchivoPlaneado[] = [...plan.aSubir];
        const subirUno = async (a: ArchivoPlaneado) => {
          setCola((c) =>
            c === null ? c : { ...c, enVuelo: [...c.enVuelo, { nombre: a.nombre, progreso: 0 }] },
          );
          const quitarDeVuelo = (c: ColaSubida) => c.enVuelo.filter((v) => v.nombre !== a.nombre);
          try {
            const url = await urlDeSubida({});
            if (cancelado()) throw new DOMException('Subida cancelada', 'AbortError');
            const storageId = await subirFichero(
              url,
              a.file,
              (fraccion) => {
                setCola((c) =>
                  c === null
                    ? c
                    : {
                        ...c,
                        enVuelo: c.enVuelo.map((v) =>
                          v.nombre === a.nombre ? { ...v, progreso: fraccion } : v,
                        ),
                      },
                );
              },
              controller.signal,
            );
            await registrar({
              storageId: storageId as Id<'_storage'>,
              fileName: a.nombre,
              sha256: a.sha256,
            });
            setCola((c) =>
              c === null ? c : { ...c, hechos: c.hechos + 1, ok: c.ok + 1, enVuelo: quitarDeVuelo(c) },
            );
          } catch (err) {
            if (cancelado()) {
              setCola((c) => (c === null ? c : { ...c, enVuelo: quitarDeVuelo(c) }));
              return;
            }
            if (avisarSiEsFatal(err)) return;
            const motivo =
              err instanceof DOMException
                ? 'no se pudo subir'
                : mensajeDeError(
                    err,
                    err instanceof Error && err.message !== '' ? err.message : 'no se pudo subir',
                  );
            setCola((c) =>
              c === null
                ? c
                : {
                    ...c,
                    hechos: c.hechos + 1,
                    enVuelo: quitarDeVuelo(c),
                    fallidos: [...c.fallidos, { nombre: a.nombre, motivo }],
                  },
            );
          }
        };
        const trabajador = async () => {
          for (;;) {
            const siguiente = pendientes.shift();
            if (siguiente === undefined || cancelado()) return;
            await subirUno(siguiente);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(SUBIDAS_A_LA_VEZ, pendientes.length) }, trabajador),
        );
        if (cancelado()) throw new DOMException('Subida cancelada', 'AbortError');

        // 4) Resumen: solo se queda si hay algo que leer.
        setCola((c) => {
          if (c === null) return c;
          const final: ColaSubida = { ...c, fase: 'terminada', enVuelo: [] };
          return colaMereceResumen(final) ? final : null;
        });
      } catch (err) {
        if (controller.signal.aborted) {
          setCola((c) =>
            c === null ? c : { ...c, fase: 'terminada', enVuelo: [], cancelada: true },
          );
        } else if (!avisarSiEsFatal(err)) {
          setCola(null);
          setUploadError(
            mensajeDeError(
              err,
              err instanceof Error && err.message !== '' ? err.message : 'No se pudo subir.',
            ),
          );
        }
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      }
    },
    [docs, limitMb, registrar, urlDeSubida],
  );

  // --- borrado con confirmación inline de dos pasos ---
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
    // Carpetas y archivos, los que sean: `desdeDrop` recorre las carpetas
    // con la API de entradas y cae a la lista plana si el navegador no la
    // tiene. Se lee AQUÍ, dentro del evento: el `dataTransfer` deja de ser
    // legible en cuanto el manejador termina.
    const dt = e.dataTransfer;
    desdeDrop(dt)
      .then(({ archivos, truncado, ilegibles }) => {
        // Soltar un enlace, texto o una imagen de otra pestaña no trae
        // ficheros: se dice, en vez de que "no pase nada".
        if (archivos.length === 0 && ilegibles.length === 0) {
          setUploadError('Ahí no había archivos. Prueba con los botones de abajo o arrastra ficheros del disco.');
          return;
        }
        return startUpload(archivos, truncado, ilegibles);
      })
      .catch((err: unknown) => {
        setUploadError(
          mensajeDeError(err, 'No pude leer lo que soltaste. Prueba a elegir los archivos con el botón.'),
        );
      });
  };

  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ''; // permite re-elegir lo mismo
    if (files.length > 0) void startUpload(files.map((file) => ({ file, carpeta: '' })));
  };

  const handleFolderPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const { archivos, truncado } = e.target.files
      ? desdeInputDeCarpeta(e.target.files)
      : { archivos: [], truncado: false };
    e.target.value = '';
    if (archivos.length > 0) void startUpload(archivos, truncado);
  };

  // --- focus trap ligero + Escape ---
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (documentos.confirmando !== null) documentos.confirmar(null);
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
          {/* La forma del corpus, antes que nada: es lo primero que hay que
              saber al abrir esto, y con 18 documentos la lista se ve igual que
              con 3. Ver BandaCorpus. */}
          {docs !== null && docs.length > 0 && (
            <BandaCorpus docs={docs} onVerEstado={(estado) => onVerTodos(estado)} />
          )}

          {/* Notion: conectar, elegir la base, sincronizar y ver el avance en
              vivo. Ver NotionBloque. */}
          <NotionBloque
            open={open}
            mostrarPasos={docs === null || docs.length === 0}
            estado={notion}
            aviso={notionAviso}
            onAvisoVisto={onNotionAvisoVisto}
          />

          {/* Google Drive y OneDrive: el mismo bloque, uno por proveedor.
              Cada uno se suscribe a su propio estado. Ver NubeBloque. */}
          <NubeBloque
            proveedor="google"
            open={open}
            aviso={nubeAviso?.proveedor === 'google' ? nubeAviso : null}
            onAvisoVisto={onNubeAvisoVisto}
          />
          <NubeBloque
            proveedor="onedrive"
            open={open}
            aviso={nubeAviso?.proveedor === 'onedrive' ? nubeAviso : null}
            onAvisoVisto={onNubeAvisoVisto}
          />

          {/* zona de subida: archivos sueltos o carpetas enteras */}
          {(
            <div className="docs-upload">
              {cola === null ? (
                <>
                  <button
                    type="button"
                    className={`dropzone ${dragOver ? 'dropzone-active' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    aria-label="Subir documentos: arrastra archivos o una carpeta aquí, o pulsa para elegirlos"
                  >
                    <IconUpload size={20} />
                    <span className="dropzone-text">
                      Arrastra aquí archivos o una carpeta entera
                    </span>
                    <span className="dropzone-hint">
                      PDF, DOCX, XLSX, CSV, TXT, MD o imágenes (JPG, PNG) · máx. {limitMb} MB por archivo
                    </span>
                  </button>
                  {/* Dos botones y no un enlace: el diálogo de archivos del
                      sistema no deja "abrir" una carpeta, y quien intentaba
                      subir una desde el botón grande se quedaba con "Abrir"
                      apagado sin saber por qué. Aquí cada botón abre el
                      diálogo que corresponde. */}
                  <div className="dropzone-botones">
                    <button
                      type="button"
                      className="doc-confirm-btn doc-confirm-no"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <IconDocument size={13} />
                      Elegir archivos
                    </button>
                    <button
                      type="button"
                      className="user-act-btn user-act-promote"
                      onClick={() => folderInputRef.current?.click()}
                    >
                      <IconUpload size={13} />
                      Elegir una carpeta entera
                    </button>
                  </div>
                </>
              ) : (
                <div className="upload-progress" role="status" aria-live="polite">
                  <div className="upload-progress-head">
                    <span className="upload-file">
                      {cola.fase === 'preparando'
                        ? plural(cola.total, 'archivo', 'archivos')
                        : cola.fase === 'subiendo'
                          ? `${Math.min(cola.hechos + 1, cola.total)} de ${plural(cola.total, 'archivo', 'archivos')}`
                          : cola.cancelada
                            ? 'Subida cancelada'
                            : 'Subida terminada'}
                    </span>
                    {cola.fase !== 'terminada' && (
                      <button
                        type="button"
                        className="upload-cancel"
                        onClick={() => uploadAbortRef.current?.abort()}
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                  {cola.fase !== 'terminada' && (
                    <div className="upload-bar" aria-hidden="true">
                      {cola.fase === 'preparando' || fraccionDeCola(cola) === null ? (
                        <div className="upload-fill upload-fill-indeterminate" />
                      ) : (
                        <div
                          className="upload-fill"
                          style={{ transform: `scaleX(${fraccionDeCola(cola) ?? 0})` }}
                        />
                      )}
                    </div>
                  )}
                  {cola.fase === 'preparando' && (
                    <span className="upload-status">
                      <span className="shimmer-text">Revisando los archivos…</span>
                    </span>
                  )}
                  {cola.fase === 'subiendo' && (
                    <span className="upload-status">
                      {cola.enVuelo.length === 0 ? (
                        <span className="shimmer-text">Registrando…</span>
                      ) : (
                        cola.enVuelo
                          .map((v) =>
                            v.progreso === null
                              ? v.nombre
                              : `${v.nombre} ${Math.round(v.progreso * 100)} %`,
                          )
                          .join(' · ')
                      )}
                    </span>
                  )}
                  {cola.fase === 'terminada' && (
                    <>
                      <span className="upload-status">
                        {resumenDeTanda(cola.ok, cola.fallidos.length, cola.omitidos)}
                        {cola.truncada && ' · la carpeta tenía más archivos: sube el resto aparte'}
                      </span>
                      <div className="upload-summary-actions">
                        {(cola.omitidos.length > 0 || cola.fallidos.length > 0) && (
                          <button
                            type="button"
                            className="doc-badge doc-badge-failed"
                            onClick={() => setOmitidosAbiertos((v) => !v)}
                            aria-expanded={omitidosAbiertos}
                          >
                            <IconAlert size={11} />
                            Ver cuáles
                            <IconChevronDown size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="doc-confirm-btn doc-confirm-no"
                          onClick={() => setCola(null)}
                        >
                          Entendido
                        </button>
                      </div>
                      {omitidosAbiertos && (
                        <ul className="upload-summary-list">
                          {cola.fallidos.map((f) => (
                            <li key={`f-${f.nombre}`}>
                              <code>{f.nombre}</code>: {f.motivo}
                            </li>
                          ))}
                          {cola.omitidos.map((o, i) => (
                            <li key={`o-${i}`}>
                              <code>{o.carpeta ? `${o.carpeta}/` : ''}{o.nombre}</code>:{' '}
                              {textoDeMotivo(o.motivo, limitMb)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.webp,.gif"
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFilePicked}
              />
              {/* `webkitdirectory` no está en los tipos de React: se pone
                  como atributo al montar. Sin `accept`: en modo carpeta el
                  navegador lo ignora y el filtrado lo hace el plan. */}
              <input
                ref={(el) => {
                  folderInputRef.current = el;
                  el?.setAttribute('webkitdirectory', '');
                }}
                type="file"
                multiple
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFolderPicked}
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
                Todavía no tienes ningún documento. Sube el primero desde la zona de arriba, o
                conecta tu Notion para que lleguen solos.
              </p>
            </div>
          )}

          {docs !== null && docs.length > 0 && (
            <div className="fichas-cabecera">
              <h3>{docs.length === 1 ? 'Tu documento' : 'Tus documentos'}</h3>
              <button type="button" onClick={() => onVerTodos(null)}>
                Verlos todos
              </button>
            </div>
          )}

          {docs !== null && docs.length > 0 && (
            <ul className="fichas">
              {docs.map((d) => (
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
          )}
        </div>
      </div>
    </aside>
  );
}
