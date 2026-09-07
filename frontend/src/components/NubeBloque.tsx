// El bloque de una nube de ficheros (Google Drive u OneDrive) en el panel de
// documentos. Es el gemelo de `NotionBloque` (DocumentsPanel.tsx) para
// carpetas en vez de bases de datos, y con una situación más: la conexión
// que el proveedor dejó de aceptar y hay que rehacer.
//
// Cinco situaciones, decididas por el servidor (`nube.admin.estado`):
// - No habilitada: el equipo técnico aún no registró la aplicación. Texto en
//   llano, sin botón.
// - Habilitada y sin conexión: UN botón, "Conectar con Google Drive", que
//   abre la pantalla del proveedor en una emergente sin abandonar la app.
// - Conectada: con qué cuenta, la lista de carpetas con casillas (se pide al
//   proveedor al abrir la lista), Guardar, y con carpetas elegidas
//   "Sincronizar ahora", el resumen de la última corrida y Desconectar.
// - Sincronizando: barra y "8 de 20 archivos, ahora: guia.pdf", en vivo.
// - Necesita reconexión: el permiso se revocó o caducó; botón "Volver a
//   conectar" en lugar de fallar cada hora en silencio.
//
// Quien lo usa es una médica: aquí no se habla de tokens ni de ids, y los
// textos viven en lib/nube.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { avisarSiEsFatal } from '../lib/auth';
import { mensajeDeError } from '../lib/errores';
import { plural } from '../lib/notion';
import {
  describirCorridaNube,
  describirProgresoNube,
  fraccionProgresoNube,
  ICONO_NUBE,
  NOMBRE_NUBE,
  textoDeAvisoNube,
} from '../lib/nube';
import {
  abrirEmergenteNubeEnBlanco,
  cerrarEmergenteNube,
  llevarEmergenteA,
  marcarRespaldoPaginaCompletaNube,
} from '../lib/nubeEmergente';
import type { AvisoNube, CarpetaNube, EstadoNube, ProveedorNube } from '../types';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconDocument,
  IconLock,
  IconRefresh,
  IconSpinner,
  IconX,
} from './icons';

const FILA = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const;
const CRECE = { flex: 1, minWidth: 0 } as const;

type Ocupado = 'conectar' | 'guardar' | 'sincronizar' | 'desconectar' | null;

interface NubeBloqueProps {
  proveedor: ProveedorNube;
  open: boolean;
  /** El aviso de vuelta de la emergente DE ESTE proveedor, o null. */
  aviso: AvisoNube | null;
  onAvisoVisto: () => void;
}

export function NubeBloque({ proveedor, open, aviso, onAvisoVisto }: NubeBloqueProps) {
  const nombre = NOMBRE_NUBE[proveedor];
  const icono = ICONO_NUBE[proveedor];

  // La suscripción hace que el avance de la sincronización y el paso a la
  // cifra final lleguen solos. Solo con el panel abierto.
  const estado = useQuery(api.nube.admin.estado, open ? { proveedor } : 'skip') as EstadoNube | undefined;
  const iniciar = useMutation(api.nube.oauth.iniciar);
  const listarCarpetas = useAction(api.nube.oauth.listarCarpetas);
  const elegirCarpetas = useMutation(api.nube.oauth.elegirCarpetas);
  const desconectar = useMutation(api.nube.oauth.desconectar);
  const sincronizarAhora = useMutation(api.nube.admin.sincronizarAhora);

  const [ocupado, setOcupado] = useState<Ocupado>(null);
  const [error, setError] = useState<string | null>(null);
  const [carpetas, setCarpetas] = useState<CarpetaNube[] | null>(null);
  const [carpetasError, setCarpetasError] = useState<string | null>(null);
  const [carpetasCargando, setCarpetasCargando] = useState(false);
  const [eligiendo, setEligiendo] = useState(false);
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [confirmDesconectar, setConfirmDesconectar] = useState(false);
  const [avisosAbiertos, setAvisosAbiertos] = useState(false);
  const [esperando, setEsperando] = useState(false);
  const emergente = useRef<Window | null>(null);

  const conexion = estado?.conexion ?? null;
  const conectadoEn = conexion?.conectadoEn ?? null;
  const elegidas = estado?.carpetas ?? [];
  const enCurso = estado?.enCurso && estado.enCurso.vivaHasta > Date.now() ? estado.enCurso : null;
  const ultima = estado?.ultimas[0] ?? null;
  const necesitaReconexion = conexion?.necesitaReconexion === true;
  const mostrarSelector = conexion !== null && !necesitaReconexion && (elegidas.length === 0 || eligiendo);

  const cargarCarpetas = useCallback(async () => {
    setCarpetasCargando(true);
    setCarpetasError(null);
    try {
      setCarpetas(await listarCarpetas({ proveedor }));
    } catch (err) {
      if (!avisarSiEsFatal(err)) {
        setCarpetasError(mensajeDeError(err, `No se pudo leer la lista de carpetas de ${nombre}.`));
      }
    } finally {
      setCarpetasCargando(false);
    }
  }, [listarCarpetas, nombre, proveedor]);

  // Otra conexión (o ninguna): la lista y lo abierto ya no valen.
  useEffect(() => {
    setCarpetas(null);
    setCarpetasError(null);
    setEligiendo(false);
    setConfirmDesconectar(false);
    setSeleccion([]);
  }, [conectadoEn]);

  // La lista se pide solo cuando hace falta el selector y aún no se tiene.
  // Tras un fallo no se reintenta solo: hay botón para eso.
  useEffect(() => {
    if (!open || !mostrarSelector || carpetas !== null || carpetasCargando || carpetasError !== null) return;
    void cargarCarpetas();
  }, [open, mostrarSelector, carpetas, carpetasCargando, carpetasError, cargarCarpetas]);

  // Una carpeta que ya se sincroniza pero que el proveedor no enseña (dejó de
  // compartirse) se ofrece igual, marcada, para poder quitarla a conciencia.
  const opciones = useMemo<CarpetaNube[]>(() => {
    const lista = carpetas ?? [];
    const faltan = elegidas.filter((e) => !lista.some((c) => c.id === e.id));
    return [...faltan, ...lista];
  }, [carpetas, elegidas]);

  // Preselección: lo que ya se sincroniza, sin esperar al proveedor (las
  // elegidas se conocen sin preguntarle nada). Depende de la LISTA de ids,
  // no de la identidad del array, que cambia con cada avance de la corrida.
  const claveElegidas = elegidas.map((c) => c.id).join(',');
  const elegidasRef = useRef(elegidas);
  elegidasRef.current = elegidas;
  useEffect(() => {
    if (carpetas === null && carpetasError === null) return;
    const actuales = elegidasRef.current;
    setSeleccion((actual) => (actual.length > 0 ? actual : actuales.map((c) => c.id)));
  }, [carpetas, carpetasError, claveElegidas]);

  const cancelarEspera = useCallback(() => {
    cerrarEmergenteNube(emergente.current);
    emergente.current = null;
    setEsperando(false);
    setOcupado(null);
  }, []);

  useEffect(() => () => {
    emergente.current = null;
  }, []);

  /** Conectar sin abandonar la aplicación: la emergente se abre EN BLANCO
   *  dentro del propio clic y se le pone la URL cuando llega. */
  const conectar = useCallback(async () => {
    setError(null);
    setOcupado('conectar');
    const ventana = abrirEmergenteNubeEnBlanco(proveedor);
    if (ventana === null) marcarRespaldoPaginaCompletaNube();
    emergente.current = ventana;
    try {
      const { url } = await iniciar({ proveedor, origen: window.location.origin });
      if (ventana === null) {
        window.location.assign(url);
        return;
      }
      llevarEmergenteA(ventana, url);
      setOcupado(null);
      setEsperando(true);
    } catch (err) {
      cerrarEmergenteNube(ventana);
      emergente.current = null;
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, `No se pudo abrir la conexión con ${nombre}.`));
      setOcupado(null);
    }
  }, [iniciar, nombre, proveedor]);

  // Llegó la respuesta (App la recibe por el canal y la baja como `aviso`), o
  // la conexión cambió: se deja de esperar.
  useEffect(() => {
    if (aviso !== null || conectadoEn !== null) {
      emergente.current = null;
      setEsperando(false);
    }
  }, [aviso, conectadoEn]);

  // La usuaria cerró la emergente sin terminar: se suelta la espera. Nunca se
  // deduce un resultado de esto; eso lo dice el servidor.
  useEffect(() => {
    if (!esperando) return;
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
        setEsperando(false);
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [esperando]);

  const alternar = useCallback((id: string) => {
    setSeleccion((actual) => (actual.includes(id) ? actual.filter((x) => x !== id) : [...actual, id]));
  }, []);

  const guardar = useCallback(async () => {
    const marcadas = opciones
      .filter((c) => seleccion.includes(c.id))
      .map((c) => ({ id: c.id, nombre: c.nombre, ruta: c.ruta }));
    if (marcadas.length === 0) return;
    setError(null);
    setOcupado('guardar');
    try {
      await elegirCarpetas({ proveedor, carpetas: marcadas });
      setEligiendo(false);
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, 'No se pudieron guardar las carpetas elegidas.'));
    } finally {
      setOcupado(null);
    }
  }, [elegirCarpetas, opciones, proveedor, seleccion]);

  const sincronizar = useCallback(async () => {
    setError(null);
    setOcupado('sincronizar');
    try {
      await sincronizarAhora({ proveedor });
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, `No se pudo lanzar la sincronización con ${nombre}.`));
    } finally {
      setOcupado(null);
    }
  }, [nombre, proveedor, sincronizarAhora]);

  const handleDesconectar = useCallback(async () => {
    setConfirmDesconectar(false);
    setError(null);
    setOcupado('desconectar');
    try {
      await desconectar({ proveedor });
    } catch (err) {
      if (!avisarSiEsFatal(err)) setError(mensajeDeError(err, `No se pudo desconectar ${nombre}.`));
    } finally {
      setOcupado(null);
    }
  }, [desconectar, nombre, proveedor]);

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

  const fraccion = enCurso !== null ? fraccionProgresoNube(enCurso) : null;
  const cambiosEnCurso = enCurso !== null ? enCurso.nuevos + enCurso.actualizados + enCurso.borrados : 0;
  const idTitulo = `nube-${proveedor}-carpetas-titulo`;

  const botonConectar = (texto: string) => (
    <button
      type="button"
      className="user-act-btn notion-connect-btn"
      disabled={ocupado !== null}
      onClick={() => void conectar()}
    >
      {ocupado === 'conectar' ? (
        <>
          <IconSpinner size={13} />
          Abriendo {nombre}…
        </>
      ) : (
        <>
          <img src={icono} alt="" width={15} height={15} />
          {texto}
        </>
      )}
    </button>
  );

  const filaEspera = esperando && (
    <div style={FILA} role="status">
      <IconSpinner size={13} />
      <span style={CRECE}>
        Termina en la ventana de {nombre} que se acaba de abrir: inicia sesión y acepta el permiso de
        lectura. Esta pantalla se actualizará sola.
      </span>
      <button type="button" className="doc-confirm-btn doc-confirm-no" onClick={cancelarEspera}>
        Cancelar
      </button>
    </div>
  );

  const filaSincronizacion = () =>
    enCurso !== null ? (
      <div className="upload-progress" style={{ padding: '10px 12px', gap: 6 }} role="status">
        <span className="upload-status">{describirProgresoNube(enCurso)}</span>
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
            {ultima !== null ? describirCorridaNube(ultima) : 'Todavía no se ha sincronizado.'}
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
            title={`Traer ahora los cambios de ${nombre}`}
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
      {aviso !== null &&
        (aviso.tipo === 'conectado' ? (
          <div className="docs-readonly-note" role="status">
            <IconCheck size={13} />
            <span style={CRECE}>{textoDeAvisoNube(aviso)}</span>
            <button type="button" className="icon-btn" onClick={onAvisoVisto} title="Cerrar aviso" aria-label="Cerrar aviso">
              <IconX size={13} />
            </button>
          </div>
        ) : (
          <div className="docs-poll-warn" role="alert">
            <IconAlert size={14} />
            <span style={CRECE}>{textoDeAvisoNube(aviso)}</span>
            <button type="button" onClick={onAvisoVisto}>
              Entendido
            </button>
          </div>
        ))}

      <section className="notion-card nube-card" aria-label={`Integración con ${nombre}`} aria-live="polite">
        <div className="notion-card-header">
          <div className="notion-brand-mark">
            <img src={icono} alt="" width={32} height={32} />
          </div>
          <div className="notion-card-heading">
            <span className="notion-eyebrow">FUENTES CONECTADAS</span>
            <h3>{nombre}</h3>
          </div>
          <span
            className={`notion-connection-badge${conexion !== null && !necesitaReconexion ? ' is-connected' : ''}`}
          >
            {estado === undefined ? (
              <IconSpinner size={11} />
            ) : necesitaReconexion ? (
              <IconAlert size={11} />
            ) : conexion !== null ? (
              <IconCheck size={11} />
            ) : (
              <IconLock size={11} />
            )}
            {estado === undefined
              ? 'Cargando'
              : necesitaReconexion
                ? 'Volver a conectar'
                : conexion !== null
                  ? 'Conectado'
                  : 'Sin conectar'}
          </span>
        </div>
        <div className="notion-card-body">
          {estado === undefined ? (
            <span className="shimmer-text">Comprobando la conexión con {nombre}…</span>
          ) : conexion === null ? (
            <>
              <div style={FILA}>
                {!estado.habilitada && <IconLock size={13} />}
                <span style={CRECE}>
                  {estado.habilitada
                    ? `Trae tus protocolos y guías directamente desde las carpetas de tu ${nombre}.`
                    : `La conexión con ${nombre} aún no está habilitada por el equipo técnico.`}
                </span>
                {estado.habilitada && !esperando && botonConectar(`Conectar con ${nombre}`)}
              </div>
              {filaEspera}
            </>
          ) : (
            <>
              <div className="notion-workspace" style={FILA}>
                {conexion.cuentaImagen ? (
                  <img
                    src={conexion.cuentaImagen}
                    alt=""
                    width={16}
                    height={16}
                    referrerPolicy="no-referrer"
                    style={{ borderRadius: '50%', flexShrink: 0 }}
                  />
                ) : (
                  <IconCheck size={13} />
                )}
                <span style={CRECE}>
                  Conectado como <strong>{conexion.cuentaNombre}</strong>
                  {conexion.cuentaCorreo && conexion.cuentaCorreo !== conexion.cuentaNombre && (
                    <> ({conexion.cuentaCorreo})</>
                  )}
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
                      ¿Desconectar {nombre}? Los documentos ya traídos se conservan, pero dejarán de
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

              {/* El permiso dejó de valer: se dice en llano y se ofrece
                  rehacer la conexión con un solo botón. */}
              {necesitaReconexion && (
                <>
                  <div className="docs-poll-warn" role="alert">
                    <IconAlert size={14} />
                    <span style={CRECE}>
                      {nombre} dejó de aceptar el permiso de esta conexión (suele pasar al cambiar la
                      contraseña o al retirar el acceso desde la cuenta). Vuelve a conectar para que la
                      sincronización continúe; las carpetas elegidas se conservan.
                    </span>
                  </div>
                  {!esperando && botonConectar('Volver a conectar')}
                  {filaEspera}
                </>
              )}

              {mostrarSelector ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontWeight: 600 }} id={idTitulo}>
                    Carpetas a sincronizar
                  </span>
                  {carpetas === null && carpetasError === null && (
                    <span className="shimmer-text">Buscando tus carpetas…</span>
                  )}
                  {carpetasError !== null && (
                    <div style={FILA}>
                      <span className="doc-row-error" style={{ padding: 0, ...CRECE }}>
                        {carpetasError}
                      </span>
                      <button type="button" className="doc-confirm-btn doc-confirm-no" onClick={() => void cargarCarpetas()}>
                        Reintentar
                      </button>
                    </div>
                  )}
                  {carpetas === null && carpetasError === null ? null : opciones.length === 0 ? (
                    carpetasError !== null ? null : (
                      <span>No se encontró ninguna carpeta en tu {nombre}.</span>
                    )
                  ) : (
                    <>
                      <ul className="notion-bases-lista nube-carpetas-lista" role="group" aria-labelledby={idTitulo}>
                        {opciones.map((c) => (
                          <li key={c.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={seleccion.includes(c.id)}
                                onChange={() => alternar(c.id)}
                                disabled={ocupado !== null}
                              />
                              <span>
                                {c.nombre}
                                {c.ruta !== c.nombre && <small className="nube-carpeta-ruta">{c.ruta}</small>}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <div style={FILA}>
                        <span style={CRECE}>
                          {seleccion.length === 0
                            ? 'Marca al menos una. Se incluyen sus subcarpetas.'
                            : `${plural(seleccion.length, 'carpeta marcada', 'carpetas marcadas')}, con sus subcarpetas.`}
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
                        {elegidas.length > 0 && (
                          <button type="button" className="doc-confirm-btn doc-confirm-no" onClick={() => setEligiendo(false)}>
                            Cancelar
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                elegidas.length > 0 && (
                  <div className="notion-selected-base" style={FILA}>
                    <IconDocument size={18} />
                    <span style={CRECE}>
                      {elegidas.length === 1 ? 'Carpeta: ' : 'Carpetas: '}
                      <strong>{elegidas.map((c) => c.nombre).join(', ')}</strong>
                    </span>
                    {!necesitaReconexion && (
                      <button
                        type="button"
                        className="doc-confirm-btn doc-confirm-no"
                        disabled={ocupado !== null || enCurso !== null}
                        onClick={() => setEligiendo(true)}
                      >
                        Cambiar
                      </button>
                    )}
                  </div>
                )
              )}

              {elegidas.length > 0 && !mostrarSelector && !necesitaReconexion && filaSincronizacion()}
            </>
          )}

          {error !== null && (
            <span className="doc-row-error" style={{ padding: 0 }} role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="notion-card-footer">
          <IconLock size={12} />
          <span>Solo lectura: la aplicación consulta las carpetas que eliges y nunca modifica tus archivos.</span>
        </div>
      </section>
    </div>
  );
}
