// Pestaña Calidad del panel de Ajustes: preguntas de control sobre los
// documentos de quien la abre, propuestas por el asistente y revisadas por
// ella, y las corridas que las responden y puntúan (convex/evaluacion/).
//
// Decisiones:
// - Visible para todos los roles: la médica es `lector` y es quien conoce las
//   respuestas correctas de su corpus; un administrador solo gestiona cuentas
//   y no sabe más de sus documentos que ella.
// - Todo son suscripciones: el avance de la generación y de la corrida llegan
//   solos, y una acción de fila espera a su mutación y la lista ya viene
//   actualizada al resolverse (Convex no resuelve la mutación antes de que las
//   suscripciones reflejen sus escrituras). Sin parches optimistas.
// - Una generación que figura en marcha más allá de su límite por avance
//   se trata como colgada: se dice que no terminó y el botón se habilita. Sin
//   esto el botón quedaba apagado para siempre, porque el servidor solo cierra
//   la colgada cuando se vuelve a pulsar ese mismo botón (ver lib/calidad.ts).
// - La respuesta esperada se guarda al perder el foco, no por cada tecla: una
//   mutación por pulsación sería una escritura por letra y un parpadeo del
//   texto mientras la suscripción vuelve. Vaciarla no la guarda vacía: se
//   recupera la anterior, porque una respuesta esperada en blanco deja el
//   caso sin criterio para juzgarlo.
// - Descartar no borra: la pregunta queda plegada y se puede recuperar.
//   Borrar es permanente y se confirma en dos pasos inline, nunca con
//   window.confirm, igual que en el resto del panel.
// - Los textos viven en lib/calidad.ts, con su test de "sin jerga": aquí no
//   se enseñan claves, identificadores ni patrones del evaluador.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { avisarSiEsFatal } from '../lib/auth';
import {
  limiteDeGeneracion,
  describirAvanceCorrida,
  describirGeneracion,
  estadoDeCorrida,
  etiquetaCategoria,
  faseDeGeneracion,
  fechaDeCorrida,
  fraccionCorrida,
  fraccionGeneracion,
  frasesDeFallos,
  ordenarCasos,
  resumenDeCorrida,
  textoDeDisparo,
  textoDeFuentes,
} from '../lib/calidad';
import { mensajeDeError } from '../lib/errores';
import { plural } from '../lib/notion';
import type {
  CasoEvaluacion,
  CorridaEvaluacion,
  EstadoCaso,
  GeneracionEvaluacion,
  ResultadoEvaluacion,
} from '../types';
import {
  IconAlert,
  IconBulb,
  IconCheck,
  IconChevronDown,
  IconRefresh,
  IconShieldCheck,
  IconSpinner,
  IconTrash,
  IconX,
} from './icons';

/** Cuántas preguntas se piden por tanda. Veinte caben en una revisión de un
 *  rato y dan una muestra de las cinco categorías. */
const OBJETIVO_GENERACION = 20;
/** Tope del servidor para la respuesta esperada (evaluacion.datos.editarRespuesta). */
const LARGO_MAX_RESPUESTA = 2000;
/** Con menos aprobadas el servidor no programa la corrida semanal (correr.repartir). */
const MINIMO_PARA_SEMANAL = 5;
/** Una clave de caso ("single_hop-003") es un identificador y no se enseña. */
const PARECE_CLAVE_RE = /^[a-z_]+-\d+$/;

type IdCaso = Id<'evaluacionCasos'>;
type IdCorrida = Id<'evaluacionCorridas'>;
type Ocupado = 'generar' | 'evaluar' | null;

/* ---------------------------------------------------------------------
   Piezas pequeñas
   --------------------------------------------------------------------- */

/** Reloj de la pestaña, para saber si la generación que figura en marcha
 *  sigue viva. No hace tictac: se relee al abrir el panel (la pestaña sigue
 *  montada con el panel cerrado, y sin esto "hace un momento" envejecería
 *  horas) y una vez más justo cuando la generación en marcha cumple su
 *  ventana, para que se dé por colgada y el botón se libere sin recargar. Un
 *  intervalo continuo volvería a pintar toda la lista de casos sin motivo. */
function useReloj(open: boolean, limiteEnMarcha: number | null): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setAhora(Date.now());
    if (limiteEnMarcha === null) return;
    const restante = limiteEnMarcha - Date.now();
    if (restante <= 0) return;
    // Un poco después del límite, no en el límite: un temporizador puede
    // despertar unos milisegundos antes y seguir viendo la generación viva.
    const t = window.setTimeout(() => setAhora(Date.now()), restante + 250);
    return () => window.clearTimeout(t);
  }, [open, limiteEnMarcha]);
  return ahora;
}

/** La misma barra que la ficha de un documento (styles.css: .upload-bar). */
function Barra({ fraccion }: { fraccion: number | null }) {
  return (
    <div className="upload-bar calidad-barra" aria-hidden="true">
      {fraccion === null ? (
        <div className="upload-fill upload-fill-indeterminate" />
      ) : (
        <div className="upload-fill" style={{ transform: `scaleX(${fraccion})` }} />
      )}
    </div>
  );
}

function Chip({ tono, children }: { tono?: 'critico'; children: string }) {
  return <span className={`calidad-chip${tono ? ` calidad-chip-${tono}` : ''}`}>{children}</span>;
}

function Cabecera({ caso }: { caso: Pick<CasoEvaluacion, 'categoria' | 'critico'> }) {
  return (
    <div className="calidad-caso-cabecera">
      <Chip>{etiquetaCategoria(caso.categoria)}</Chip>
      {caso.critico && <Chip tono="critico">Importante</Chip>}
    </div>
  );
}

function Trabajando({ etiqueta }: { etiqueta: string }) {
  return (
    <span className="user-saving" role="status">
      <IconSpinner size={13} />
      <span className="shimmer-text">{etiqueta}</span>
    </span>
  );
}

/* ---------------------------------------------------------------------
   Un caso por revisar
   --------------------------------------------------------------------- */

interface CasoPropuestoProps {
  caso: CasoEvaluacion;
  /** Etiqueta del trabajo en curso sobre este caso, o null. */
  ocupado: string | null;
  error: string | null;
  onAprobar: () => void;
  onDescartar: () => void;
  /** Devuelve si se guardó. El error, si lo hay, lo pinta el padre. */
  onGuardarRespuesta: (texto: string) => Promise<boolean>;
}

function CasoPropuesto({ caso, ocupado, error, onAprobar, onDescartar, onGuardarRespuesta }: CasoPropuestoProps) {
  const [borrador, setBorrador] = useState(caso.respuestaEsperada);
  const [sucio, setSucio] = useState(false);
  const [guardado, setGuardado] = useState<'nada' | 'guardando' | 'guardado'>('nada');
  // Cuenta de ediciones y guardado en vuelo. Sin la cuenta, escribir mientras
  // el guardado anterior viaja acababa en `setSucio(false)` al volver, y el
  // efecto de abajo pisaba lo recién escrito con el texto del servidor.
  const edicion = useRef(0);
  const enVuelo = useRef<Promise<void> | null>(null);

  // Si el texto cambia en el servidor (otra pestaña abierta) y aquí no hay
  // una edición a medias, se adopta; si la hay, manda lo que se está escribiendo.
  useEffect(() => {
    if (!sucio) setBorrador(caso.respuestaEsperada);
  }, [caso.respuestaEsperada, sucio]);

  /** Guarda lo escrito si cambió. Nunca lanza y nunca guarda dos veces a la
   *  vez: si ya hay un guardado en vuelo devuelve esa misma promesa. */
  const guardar = useCallback((): Promise<void> => {
    if (enVuelo.current !== null) return enVuelo.current;
    if (!sucio) return Promise.resolve();
    const texto = borrador.trim();
    if (texto === '') {
      setBorrador(caso.respuestaEsperada);
      setSucio(false);
      return Promise.resolve();
    }
    if (texto === caso.respuestaEsperada.trim()) {
      setSucio(false);
      return Promise.resolve();
    }
    const version = edicion.current;
    setGuardado('guardando');
    const promesa = onGuardarRespuesta(texto).then((ok) => {
      enVuelo.current = null;
      // Si se siguió escribiendo mientras tanto, el cuadro sigue sucio y se
      // guardará en la próxima salida; lo escrito no se toca.
      if (edicion.current !== version) return;
      if (ok) {
        setSucio(false);
        setGuardado('guardado');
      } else {
        setGuardado('nada');
      }
    });
    enVuelo.current = promesa;
    return promesa;
  }, [borrador, caso.respuestaEsperada, onGuardarRespuesta, sucio]);

  /** Aprobar o descartar primero guarda lo que haya en el cuadro: en algún
   *  navegador el clic en un botón no quita el foco al cuadro y sin esto la
   *  corrección de la respuesta se perdería al moverse el caso de lista. */
  const trasGuardar = (accion: () => void) => () => {
    void guardar().then(accion);
  };

  const idTextarea = `calidad-respuesta-${caso._id}`;
  const estadoGuardado =
    guardado === 'guardando'
      ? 'Guardando…'
      : guardado === 'guardado'
        ? 'Respuesta guardada'
        : sucio
          ? 'Se guarda al salir del cuadro'
          : '';

  return (
    <li className="calidad-caso">
      <Cabecera caso={caso} />
      <p className="calidad-pregunta">{caso.pregunta}</p>
      <label className="calidad-etiqueta" htmlFor={idTextarea}>
        Respuesta esperada
      </label>
      <textarea
        id={idTextarea}
        className="calidad-textarea"
        value={borrador}
        maxLength={LARGO_MAX_RESPUESTA}
        rows={3}
        disabled={ocupado !== null}
        onChange={(e) => {
          edicion.current += 1;
          setBorrador(e.target.value);
          setSucio(true);
          setGuardado('nada');
        }}
        onBlur={() => void guardar()}
      />
      <div className="calidad-meta">
        <span className="calidad-crece">Documentos esperados: {textoDeFuentes(caso)}</span>
        <span className="calidad-guardado" role="status" aria-live="polite">
          {estadoGuardado}
        </span>
      </div>
      {ocupado !== null ? (
        <Trabajando etiqueta={ocupado} />
      ) : (
        <div className="calidad-acciones">
          <button
            type="button"
            className="user-act-btn user-act-promote"
            onClick={trasGuardar(onAprobar)}
            title="La pregunta y su respuesta son correctas: entra en la evaluación"
          >
            <IconCheck size={12} />
            Correcta
          </button>
          <button
            type="button"
            className="user-act-btn"
            onClick={trasGuardar(onDescartar)}
            title="No sirve: se aparta sin borrarla y se puede recuperar"
          >
            <IconX size={12} />
            Descartar
          </button>
        </div>
      )}
      {error !== null && <span className="doc-row-error calidad-error">{error}</span>}
    </li>
  );
}

/* ---------------------------------------------------------------------
   Un caso aprobado o descartado (compacto)
   --------------------------------------------------------------------- */

interface CasoCompactoProps {
  caso: CasoEvaluacion;
  /** Texto del botón que devuelve el caso a "por revisar". */
  accion: string;
  accionTitulo: string;
  ocupado: string | null;
  error: string | null;
  confirmando: boolean;
  onAccion: () => void;
  onPedirBorrar: () => void;
  onConfirmarBorrar: () => void;
  onCancelarBorrar: () => void;
}

function CasoCompacto({
  caso,
  accion,
  accionTitulo,
  ocupado,
  error,
  confirmando,
  onAccion,
  onPedirBorrar,
  onConfirmarBorrar,
  onCancelarBorrar,
}: CasoCompactoProps) {
  return (
    <li className="calidad-caso calidad-caso-compacto">
      <Cabecera caso={caso} />
      <p className="calidad-pregunta">{caso.pregunta}</p>
      {ocupado !== null ? (
        <Trabajando etiqueta={ocupado} />
      ) : confirmando ? (
        <div className="user-confirm user-confirm-danger" role="group" aria-label="Confirmar el borrado de la pregunta">
          <span className="user-confirm-text" aria-live="polite">
            <IconAlert size={13} />
            <span>¿Borrar esta pregunta? Es permanente: no se puede deshacer.</span>
          </span>
          <span className="user-confirm-actions">
            <button type="button" className="doc-confirm-btn user-confirm-delete" onClick={onConfirmarBorrar}>
              Borrar
            </button>
            {/* el foco entra en "Cancelar": la salida segura es la primera,
                y el botón que confirma cae en otro sitio que el que abrió la
                confirmación, así un doble clic no borra nada por inercia */}
            <button type="button" className="doc-confirm-btn doc-confirm-no" onClick={onCancelarBorrar} autoFocus>
              Cancelar
            </button>
          </span>
        </div>
      ) : (
        <div className="calidad-acciones">
          <button type="button" className="user-act-btn" onClick={onAccion} title={accionTitulo}>
            <IconRefresh size={12} />
            {accion}
          </button>
          <button
            type="button"
            className="icon-btn calidad-borrar"
            onClick={onPedirBorrar}
            title="Borrar esta pregunta"
            aria-label={`Borrar la pregunta: ${caso.pregunta}`}
          >
            <IconTrash size={14} />
          </button>
        </div>
      )}
      {error !== null && <span className="doc-row-error calidad-error">{error}</span>}
    </li>
  );
}

/* ---------------------------------------------------------------------
   El detalle de una corrida: cada pregunta con su veredicto
   --------------------------------------------------------------------- */

function DetalleCorrida({ corrida, open }: { corrida: CorridaEvaluacion; open: boolean }) {
  const resultados = useQuery(
    api.evaluacion.datos.resultadosDe,
    open ? { corridaId: corrida._id } : 'skip',
  ) as ResultadoEvaluacion[] | undefined;

  // Las que fallaron primero: es lo que se viene a mirar. La puntuación se
  // guarda sin esquema (v.any()), así que una fila a medio escribir no puede
  // tumbar la lista entera: lo que no sea lista o texto se trata como vacío.
  const ordenados = useMemo(
    () =>
      resultados === undefined
        ? null
        : resultados
            .map((r) => ({
              ...r,
              clave: typeof r.clave === 'string' ? r.clave : '',
              passed: r.passed === true,
              failures: Array.isArray(r.failures) ? r.failures.filter((f): f is string => typeof f === 'string') : [],
              respuesta: typeof r.respuesta === 'string' ? r.respuesta : '',
            }))
            .sort((a, b) => Number(a.passed) - Number(b.passed) || a.clave.localeCompare(b.clave, 'es', { numeric: true })),
    [resultados],
  );

  return (
    <div className="calidad-detalle-cuerpo">
      {corrida.estado === 'error' && (
        <div className="docs-poll-warn" role="status">
          <IconAlert size={14} />
          <span className="calidad-crece">
            La evaluación se interrumpió antes de terminar.
            {corrida.error ? ` Motivo: ${corrida.error}` : ''}
          </span>
        </div>
      )}
      {ordenados === null ? (
        <span className="shimmer-text">Cargando los resultados…</span>
      ) : ordenados.length === 0 ? (
        <p className="calidad-ayuda">
          {corrida.estado === 'running'
            ? 'Aún no hay resultados: la primera pregunta está en marcha.'
            : 'Esta evaluación no dejó resultados.'}
        </p>
      ) : (
        <ul className="calidad-resultados">
          {ordenados.map((r, i) => {
            const fallos = frasesDeFallos(r.failures);
            return (
              <li key={`${r.clave}-${i}`} className={`calidad-resultado ${r.passed ? '' : 'calidad-resultado-falla'}`}>
                <div className="calidad-caso-cabecera">
                  <span className={`doc-badge ${r.passed ? 'doc-badge-ready' : 'doc-badge-failed'}`}>
                    {r.passed ? 'Pasa' : 'Falla'}
                  </span>
                  <Chip>{etiquetaCategoria(r.categoria)}</Chip>
                  {r.critico && <Chip tono="critico">Importante</Chip>}
                </div>
                <p className="calidad-pregunta">{r.pregunta}</p>
                {fallos.length > 0 && (
                  <ul className="calidad-fallos">
                    {fallos.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
                {!r.passed && fallos.length === 0 && (
                  <p className="calidad-ayuda">Falló sin un motivo concreto que enseñar.</p>
                )}
                {r.respuesta.trim() !== '' && (
                  <details className="calidad-respuesta">
                    <summary>Ver lo que respondió el asistente</summary>
                    <p>{r.respuesta}</p>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   La pestaña
   --------------------------------------------------------------------- */

interface CalidadTabProps {
  /** El panel está abierto. Cerrado, las suscripciones quedan en `skip` y se
   *  recogen confirmaciones y errores, como en la pestaña de usuarios. */
  open: boolean;
}

export function CalidadTab({ open }: CalidadTabProps) {
  const casosQuery = useQuery(api.evaluacion.datos.casos, open ? {} : 'skip') as CasoEvaluacion[] | undefined;
  const generacion = useQuery(api.evaluacion.datos.generacionActual, open ? {} : 'skip') as
    | GeneracionEvaluacion
    | null
    | undefined;
  const corridasQuery = useQuery(api.evaluacion.datos.corridas, open ? {} : 'skip') as CorridaEvaluacion[] | undefined;

  const revisar = useMutation(api.evaluacion.datos.revisar);
  const editarRespuesta = useMutation(api.evaluacion.datos.editarRespuesta);
  const borrarCaso = useMutation(api.evaluacion.datos.borrarCaso);
  const generar = useMutation(api.evaluacion.datos.generar);
  const evaluarAhora = useMutation(api.evaluacion.datos.evaluarAhora);

  const [ocupado, setOcupado] = useState<Ocupado>(null);
  const [errorGenerar, setErrorGenerar] = useState<string | null>(null);
  const [errorEvaluar, setErrorEvaluar] = useState<string | null>(null);
  /** id de caso -> etiqueta del trabajo en curso ("Guardando…"). */
  const [ocupadoCaso, setOcupadoCaso] = useState<Record<string, string>>({});
  const [erroresCaso, setErroresCaso] = useState<Record<string, string>>({});
  const [confirmarBorrado, setConfirmarBorrado] = useState<IdCaso | null>(null);
  const [descartadasAbiertas, setDescartadasAbiertas] = useState(false);
  const [corridaAbierta, setCorridaAbierta] = useState<IdCorrida | null>(null);

  const grupos = useMemo(() => (casosQuery === undefined ? null : ordenarCasos(casosQuery)), [casosQuery]);
  const corridas = corridasQuery ?? [];
  const corridaEnMarcha = corridas.find((c) => c.estado === 'running') ?? null;
  // De la generación solo importa cuándo empezó si sigue `running`: es lo que
  // fija el instante en que el reloj tiene que volver a mirarse.
  // El instante en que la generación en marcha pasa a colgada: depende de su
  // avance (ver limiteDeGeneracion), así que cambia con cada paso que llega.
  const limiteEnMarcha =
    generacion !== undefined && generacion !== null && generacion.estado === 'running' ? limiteDeGeneracion(generacion) : null;
  const ahora = useReloj(open, limiteEnMarcha);
  const fase = generacion === undefined || generacion === null ? null : faseDeGeneracion(generacion, ahora);
  // Una generación colgada NO está en marcha: no apaga el botón. Pulsarlo es
  // justo lo que la cierra en el servidor y arranca otra.
  const generando = fase === 'en_marcha';

  // Al cerrar se recogen confirmaciones y errores: reabrir nunca muestra un
  // "¿Borrar?" a medias ni el motivo de un intento viejo.
  useEffect(() => {
    if (open) return;
    setConfirmarBorrado(null);
    setErroresCaso({});
    setErrorGenerar(null);
    setErrorEvaluar(null);
  }, [open]);

  const limpiarErrorCaso = useCallback((id: string) => {
    setErroresCaso((errs) => {
      if (!(id in errs)) return errs;
      const next = { ...errs };
      delete next[id];
      return next;
    });
  }, []);

  /** Motivo del rechazo bajo el propio caso: manda el `mensaje` del servidor.
   *  Si el error obliga a salir (acceso revocado) no se pinta nada: App ya
   *  está cerrando la sesión. */
  const fallarCaso = useCallback((id: string, err: unknown, porDefecto: string) => {
    if (avisarSiEsFatal(err)) return;
    setErroresCaso((errs) => ({ ...errs, [id]: mensajeDeError(err, porDefecto) }));
  }, []);

  const conCasoOcupado = useCallback(
    async (id: string, etiqueta: string, trabajo: () => Promise<unknown>, porDefecto: string) => {
      limpiarErrorCaso(id);
      setOcupadoCaso((s) => ({ ...s, [id]: etiqueta }));
      try {
        await trabajo();
      } catch (err) {
        fallarCaso(id, err, porDefecto);
      } finally {
        setOcupadoCaso((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        });
      }
    },
    [fallarCaso, limpiarErrorCaso],
  );

  const cambiarEstado = useCallback(
    (caso: CasoEvaluacion, estado: EstadoCaso) => {
      const etiqueta = estado === 'aprobado' ? 'Guardando…' : estado === 'descartado' ? 'Descartando…' : 'Recuperando…';
      return conCasoOcupado(caso._id, etiqueta, () => revisar({ casoId: caso._id, estado }), 'No se pudo cambiar la pregunta.');
    },
    [conCasoOcupado, revisar],
  );

  const guardarRespuesta = useCallback(
    async (caso: CasoEvaluacion, texto: string): Promise<boolean> => {
      limpiarErrorCaso(caso._id);
      try {
        await editarRespuesta({ casoId: caso._id, respuestaEsperada: texto });
        return true;
      } catch (err) {
        fallarCaso(caso._id, err, 'No se pudo guardar la respuesta esperada.');
        return false;
      }
    },
    [editarRespuesta, fallarCaso, limpiarErrorCaso],
  );

  const borrar = useCallback(
    (caso: CasoEvaluacion) => {
      setConfirmarBorrado(null);
      return conCasoOcupado(caso._id, 'Borrando…', () => borrarCaso({ casoId: caso._id }), 'No se pudo borrar la pregunta.');
    },
    [borrarCaso, conCasoOcupado],
  );

  const proponer = useCallback(async () => {
    setErrorGenerar(null);
    setOcupado('generar');
    try {
      await generar({ objetivo: OBJETIVO_GENERACION });
    } catch (err) {
      if (!avisarSiEsFatal(err)) {
        setErrorGenerar(mensajeDeError(err, 'No se pudieron proponer preguntas. Vuelve a intentarlo en un momento.'));
      }
    } finally {
      setOcupado(null);
    }
  }, [generar]);

  const evaluar = useCallback(async () => {
    setErrorEvaluar(null);
    setOcupado('evaluar');
    try {
      await evaluarAhora({ repeticiones: 1 });
    } catch (err) {
      if (!avisarSiEsFatal(err)) {
        setErrorEvaluar(mensajeDeError(err, 'No se pudo empezar la evaluación. Vuelve a intentarlo en un momento.'));
      }
    } finally {
      setOcupado(null);
    }
  }, [evaluarAhora]);

  /** Escape recoge primero lo desplegado (confirmación, detalle de una
   *  corrida) y solo después deja que el panel se cierre. */
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    if (confirmarBorrado !== null) {
      e.stopPropagation();
      setConfirmarBorrado(null);
    } else if (corridaAbierta !== null) {
      e.stopPropagation();
      setCorridaAbierta(null);
    }
  };

  const alternarCorrida = (id: IdCorrida) => setCorridaAbierta((actual) => (actual === id ? null : id));

  // La corrida guarda la clave del caso en curso; aquí se cambia por su
  // pregunta, que es lo que la médica reconoce. Si el caso ya no está y lo
  // que hay es una clave, no se enseña nada.
  const preguntaActual = (() => {
    const actual = corridaEnMarcha?.casoActual ?? null;
    if (actual === null || actual === '') return null;
    const caso = casosQuery?.find((c) => c.clave === actual);
    if (caso !== undefined) return caso.pregunta;
    return PARECE_CLAVE_RE.test(actual) ? null : actual;
  })();

  const aprobadas = grupos?.aprobados.length ?? 0;
  const puedeEvaluar = grupos !== null && aprobadas > 0 && corridaEnMarcha === null && ocupado === null && corridasQuery !== undefined;
  const textoEvaluar =
    grupos === null
      ? 'Cargando las preguntas…'
      : aprobadas === 0
        ? 'Marca al menos una pregunta como correcta para poder evaluar.'
        : `${plural(aprobadas, 'pregunta aprobada', 'preguntas aprobadas')}. Cada una tarda unos minutos y puedes cerrar esta ventana mientras.` +
          (aprobadas >= MINIMO_PARA_SEMANAL
            ? ' Además se evalúan solas una vez a la semana.'
            : ` Con ${MINIMO_PARA_SEMANAL} o más, también se evaluarán solas una vez a la semana.`);

  const totalCasos = grupos === null ? 0 : grupos.propuestos.length + grupos.aprobados.length + grupos.descartados.length;

  const propsCompacto = (caso: CasoEvaluacion) => ({
    caso,
    ocupado: ocupadoCaso[caso._id] ?? null,
    error: erroresCaso[caso._id] ?? null,
    confirmando: confirmarBorrado === caso._id,
    onAccion: () => void cambiarEstado(caso, 'propuesto'),
    onPedirBorrar: () => setConfirmarBorrado(caso._id),
    onConfirmarBorrar: () => void borrar(caso),
    onCancelarBorrar: () => setConfirmarBorrado(null),
  });

  return (
    <div className="settings-tabpanel settings-scroll calidad-tab" onKeyDown={handleKeyDown}>
      <div className="settings-tab-intro">
        <h3>Calidad de las respuestas</h3>
        <p>
          Preguntas de control sobre tus documentos. El asistente las responde de forma periódica y así
          sabes si sigue acertando.
        </p>
      </div>

      {/* 1. Proponer preguntas */}
      <section className="stats-block calidad-bloque" aria-labelledby="calidad-proponer-titulo">
        <h3 className="stats-title" id="calidad-proponer-titulo">
          Proponer preguntas
        </h3>
        <div className="calidad-fila">
          <span className="calidad-crece">
            El asistente lee tus documentos y propone {OBJETIVO_GENERACION} preguntas con su respuesta. Tú
            decides cuáles valen.
          </span>
          <button
            type="button"
            className="user-act-btn user-act-promote"
            disabled={generando || ocupado !== null || generacion === undefined}
            onClick={() => void proponer()}
            title="Proponer preguntas nuevas a partir de tus documentos"
          >
            {ocupado === 'generar' || generando ? <IconSpinner size={13} /> : <IconBulb size={13} />}
            Proponer preguntas
          </button>
        </div>
        {generacion !== undefined && generacion !== null && fase !== null && (
          fase === 'en_marcha' ? (
            <div className="calidad-progreso" role="status">
              <span className="upload-status">{describirGeneracion(generacion, ahora)}</span>
              <Barra fraccion={fraccionGeneracion(generacion)} />
            </div>
          ) : fase === 'colgada' ? (
            // Sin barra: el avance guardado es de una acción que ya no existe.
            <div className="docs-poll-warn" role="status">
              <IconAlert size={14} />
              <span className="calidad-crece">{describirGeneracion(generacion, ahora)}</span>
            </div>
          ) : fase === 'fallida' ? (
            <div className="docs-poll-warn" role="status">
              <IconAlert size={14} />
              <span className="calidad-crece">
                {describirGeneracion(generacion, ahora)}.{generacion.error ? ` Motivo: ${generacion.error}` : ''}
              </span>
            </div>
          ) : (
            <p className="calidad-ayuda" role="status">
              Última vez: {describirGeneracion(generacion, ahora)}.
            </p>
          )
        )}
        {errorGenerar !== null && (
          <span className="doc-row-error calidad-error" role="alert">
            {errorGenerar}
          </span>
        )}
      </section>

      {/* 2. Las preguntas */}
      {grupos === null ? (
        <div className="users-skeleton calidad-skeleton" role="status" aria-label="Cargando las preguntas">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton skel-stats" style={{ animationDelay: `-${i * 140}ms` }} />
          ))}
        </div>
      ) : totalCasos === 0 ? (
        <div className="settings-empty">
          <span className="settings-empty-icon" aria-hidden="true">
            <IconShieldCheck size={20} />
          </span>
          <p className="settings-empty-title">Todavía no hay preguntas de control</p>
          <p>
            Pulsa “Proponer preguntas” y el asistente sugerirá {OBJETIVO_GENERACION} a partir de tus
            documentos. Hace falta tener al menos un documento listo.
          </p>
        </div>
      ) : (
        <>
          {grupos.propuestos.length > 0 && (
            <section className="stats-block calidad-bloque" aria-labelledby="calidad-propuestas-titulo">
              <h3 className="stats-title" id="calidad-propuestas-titulo">
                Por revisar ({grupos.propuestos.length})
              </h3>
              <p className="calidad-ayuda">
                Lee cada pregunta y su respuesta esperada. Corrige la respuesta si hace falta y marca
                “Correcta” para que entre en la evaluación, o descártala.
              </p>
              <ul className="calidad-lista">
                {grupos.propuestos.map((c) => (
                  <CasoPropuesto
                    key={c._id}
                    caso={c}
                    ocupado={ocupadoCaso[c._id] ?? null}
                    error={erroresCaso[c._id] ?? null}
                    onAprobar={() => void cambiarEstado(c, 'aprobado')}
                    onDescartar={() => void cambiarEstado(c, 'descartado')}
                    onGuardarRespuesta={(texto) => guardarRespuesta(c, texto)}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="stats-block calidad-bloque" aria-labelledby="calidad-aprobadas-titulo">
            <h3 className="stats-title" id="calidad-aprobadas-titulo">
              Aprobadas ({grupos.aprobados.length})
            </h3>
            {grupos.aprobados.length === 0 ? (
              <p className="calidad-ayuda">Ninguna todavía. Son las que se evalúan.</p>
            ) : (
              <ul className="calidad-lista">
                {grupos.aprobados.map((c) => (
                  <CasoCompacto
                    key={c._id}
                    {...propsCompacto(c)}
                    accion="Revisar de nuevo"
                    accionTitulo="Devolverla a la lista por revisar"
                  />
                ))}
              </ul>
            )}
          </section>

          {grupos.descartados.length > 0 && (
            <section className="stats-block calidad-bloque" aria-labelledby="calidad-descartadas-titulo">
              {/* el botón va DENTRO del título: un encabezado dentro de un
                  botón no es HTML válido, y así el nombre de la sección es el
                  texto del botón */}
              <h3 className="stats-title" id="calidad-descartadas-titulo">
                <button
                  type="button"
                  className="calidad-plegable"
                  onClick={() => setDescartadasAbiertas((v) => !v)}
                  aria-expanded={descartadasAbiertas}
                  aria-controls="calidad-descartadas-lista"
                >
                  Descartadas ({grupos.descartados.length})
                  <IconChevronDown size={14} />
                </button>
              </h3>
              {descartadasAbiertas && (
                <ul className="calidad-lista" id="calidad-descartadas-lista">
                  {grupos.descartados.map((c) => (
                    <CasoCompacto
                      key={c._id}
                      {...propsCompacto(c)}
                      accion="Recuperar"
                      accionTitulo="Volver a ponerla en la lista por revisar"
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {/* 3. Evaluar */}
      <section className="stats-block calidad-bloque" aria-labelledby="calidad-evaluar-titulo">
        <h3 className="stats-title" id="calidad-evaluar-titulo">
          Evaluar
        </h3>
        <div className="calidad-fila">
          <span className="calidad-crece">{textoEvaluar}</span>
          <button
            type="button"
            className="user-act-btn user-act-promote"
            disabled={!puedeEvaluar}
            onClick={() => void evaluar()}
            title="Responder ahora todas las preguntas aprobadas y puntuarlas"
          >
            {ocupado === 'evaluar' ? <IconSpinner size={13} /> : <IconShieldCheck size={13} />}
            Evaluar ahora
          </button>
        </div>
        {corridaEnMarcha !== null && (
          <div className="calidad-progreso" role="status">
            <span className="upload-status">{describirAvanceCorrida(corridaEnMarcha, preguntaActual)}</span>
            <Barra fraccion={fraccionCorrida(corridaEnMarcha)} />
          </div>
        )}
        {errorEvaluar !== null && (
          <span className="doc-row-error calidad-error" role="alert">
            {errorEvaluar}
          </span>
        )}
      </section>

      {/* 4. Historial */}
      <section className="stats-block calidad-bloque" aria-labelledby="calidad-historial-titulo">
        <h3 className="stats-title" id="calidad-historial-titulo">
          Historial
        </h3>
        {corridasQuery === undefined ? (
          <span className="shimmer-text">Cargando el historial…</span>
        ) : corridas.length === 0 ? (
          <p className="calidad-ayuda">Todavía no se ha evaluado ninguna vez.</p>
        ) : (
          <div className="calidad-tabla-marco">
            <table className="calidad-tabla">
              <thead>
                <tr>
                  <th scope="col">Cuándo</th>
                  <th scope="col" title="Preguntas respondidas correctamente">
                    Bien
                  </th>
                  <th scope="col" title="Proporción de afirmaciones respaldadas por la fuente que citan">
                    Fidelidad
                  </th>
                  <th
                    scope="col"
                    title="Con qué frecuencia la búsqueda encontró la evidencia esperada entre los primeros resultados"
                  >
                    Búsqueda
                  </th>
                  <th scope="col" title="Datos atribuidos a otra entidad: otro fármaco, población o estudio">
                    Otra entidad
                  </th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {corridas.map((c) => {
                  const r = resumenDeCorrida(c.resumen);
                  const estado = estadoDeCorrida(c);
                  const abierta = corridaAbierta === c._id;
                  const idDetalle = `calidad-detalle-${c._id}`;
                  return (
                    <Fragment key={c._id}>
                      <tr
                        className={`calidad-fila-corrida ${abierta ? 'calidad-fila-abierta' : ''}`}
                        onClick={() => alternarCorrida(c._id)}
                      >
                        <td>
                          <button
                            type="button"
                            className="calidad-fila-btn"
                            aria-expanded={abierta}
                            aria-controls={idDetalle}
                            onClick={(e) => {
                              e.stopPropagation();
                              alternarCorrida(c._id);
                            }}
                            title={abierta ? 'Ocultar el detalle' : 'Ver cada pregunta con su resultado'}
                          >
                            <IconChevronDown size={13} />
                            <span>
                              {fechaDeCorrida(c.empezadoEn)}
                              <small>{textoDeDisparo(c.disparo)}</small>
                            </span>
                          </button>
                        </td>
                        {/* en marcha aún no hay "bien": se dice cuántas van respondidas */}
                        <td>
                          {c.estado === 'running'
                            ? `${c.casosHechos.toLocaleString('es')} de ${c.casosTotal.toLocaleString('es')} respondidas`
                            : r.bien}
                        </td>
                        <td>{r.fidelidad}</td>
                        <td>{r.busqueda}</td>
                        <td>{r.atribuciones}</td>
                        <td>
                          <span className={`doc-badge calidad-estado-${estado.tono}`}>
                            {c.estado === 'running' && <IconSpinner size={11} />}
                            {estado.texto}
                          </span>
                        </td>
                      </tr>
                      {abierta && (
                        <tr className="calidad-detalle" id={idDetalle}>
                          <td colSpan={6}>
                            <DetalleCorrida corrida={c} open={open} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
