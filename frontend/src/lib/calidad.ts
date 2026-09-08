// Textos y orden de la pestaña Calidad (Ajustes > Calidad). Funciones puras,
// separadas del componente para poder probarlas sin DOM, con el mismo
// criterio que lib/nube.ts: quien lee es una médica. Aquí se traduce el
// vocabulario del evaluador (convex/evaluacion/puntuar.ts) a frases llanas y
// no aparecen "regex", "MRR", "chunk", "embedding", "token", "id" ni "JSON".
//
// Los fallos llegan como los MENSAJES de `puntuarCaso` (no como los tipos), y
// tras `agregarCorridas` con el sufijo "(k/n corridas)" y el detalle detrás:
// "hops insuficientes: 0 < 2" en una corrida, "hops insuficientes (2/3
// corridas): 0 < 2, 1 < 2" en tres. Por eso cada traducción reconoce el
// principio del mensaje y no la cadena entera.

import type {
  CasoEvaluacion,
  CorridaEvaluacion,
  GeneracionEvaluacion,
  ResumenEvaluacion,
} from '../types';
import { haceCuanto, plural } from './notion';

/* ---------------------------------------------------------------------
   Categorías
   --------------------------------------------------------------------- */

const ETIQUETAS_CATEGORIA: Record<string, string> = {
  single_hop: 'Un documento',
  multi_hop: 'Varios documentos',
  tabla: 'Tabla o cifra',
  abstencion: 'Debe decir que no está',
  entidad: 'Trampa de otra entidad',
};

/** La categoría del evaluador en palabras. Una desconocida no se enseña tal
 *  cual (sería un identificador técnico): se dice que es de otro tipo. */
export function etiquetaCategoria(categoria: string): string {
  return ETIQUETAS_CATEGORIA[categoria] ?? 'Otro tipo';
}

/** Qué documentos debería usar la respuesta. Un caso de abstención o de
 *  trampa no tiene documento esperado y no es un dato que falte. */
export function textoDeFuentes(caso: Pick<CasoEvaluacion, 'fuentes' | 'categoria'>): string {
  const nombres = [...new Set(caso.fuentes.map((f) => f.trim()).filter((f) => f !== ''))];
  if (nombres.length > 0) return nombres.join(', ');
  if (caso.categoria === 'abstencion' || caso.categoria === 'entidad') {
    return 'Ninguno: la respuesta correcta es que no está en tus documentos';
  }
  return 'Sin documento concreto';
}

/* ---------------------------------------------------------------------
   Fallos
   --------------------------------------------------------------------- */

const CORRIDAS_RE = /\s*\((\d+)\/(\d+) corridas\)/;

/** Caracteres que delatan un patrón de búsqueda en vez de un texto: si el
 *  detalle los trae, se calla en vez de enseñar un patrón a la médica. */
const PARECE_PATRON_RE = /[()[\]|?*+^$]/;

/** El detalle que sigue al primer ": " del mensaje, sin las barras de escape
 *  del patrón ("0\.94" es "0.94"), o null si no lo hay o parece un patrón. */
function detalleLegible(mensaje: string): string | null {
  const pos = mensaje.indexOf(': ');
  if (pos === -1) return null;
  const crudo = mensaje.slice(pos + 2).replace(/\\(.)/g, '$1').trim();
  if (crudo === '' || PARECE_PATRON_RE.test(crudo)) return null;
  return crudo;
}

/**
 * Un fallo del evaluador en una frase llana.
 *
 * Los prefijos son los `type` de puntuar.ts; lo que va detrás varía entre
 * corridas (qué evidencia, qué umbral, cuántas afirmaciones) y por eso se
 * mira solo el principio. Un fallo desconocido recibe una frase genérica y
 * NUNCA el texto original, que puede llevar patrones o identificadores.
 */
export function fraseDeFallo(fallo: string): string {
  const m = CORRIDAS_RE.exec(fallo);
  const base = fallo.replace(CORRIDAS_RE, '').trim();
  const frase = fraseBase(base);
  if (m === null) return frase;
  const veces = Number(m[1]);
  const total = Number(m[2]);
  if (!(total > 1) || !(veces >= 0)) return frase;
  return `${frase} (en ${veces} de ${total} intentos)`;
}

function fraseBase(mensaje: string): string {
  if (mensaje.startsWith('evidencia no recuperada')) return 'No encontró la evidencia esperada en tus documentos';
  if (mensaje.startsWith('hops insuficientes')) return 'Buscó menos veces de las necesarias';
  if (mensaje.startsWith('conceptos ausentes en búsquedas')) {
    return conDetalle('No buscó algunos conceptos clave', detalleLegible(mensaje));
  }
  if (mensaje.startsWith('respuesta incompleta')) {
    return conDetalle('La respuesta no menciona algo que debía decir', detalleLegible(mensaje));
  }
  if (mensaje.startsWith('contenido prohibido')) {
    return conDetalle('La respuesta incluye algo que no debía decir', detalleLegible(mensaje));
  }
  if (mensaje.startsWith('debía abstenerse')) return 'Respondió cuando debía decir que no está en tus documentos';
  if (mensaje.startsWith('se abstuvo')) return 'Dijo que no estaba en tus documentos, y sí estaba';
  if (mensaje.startsWith('citas no resolubles')) return 'Citó una fuente que no existe';
  if (mensaje.startsWith('respuesta factual sin citas')) return 'Afirmó cosas sin citar ninguna fuente';
  if (mensaje.startsWith('error de ejecución')) return 'El asistente no llegó a responder por un error';
  // El mensaje de una corrida empieza por la cifra ("2 afirmación(es) que su
  // fragmento citado no sostiene"); el agregado, por el tipo.
  if (/afirmaci[oó]n(?:\(es\)|es)? que su fragmento citado no sostiene/.test(mensaje)) {
    return 'Afirmó algo que su fuente no dice';
  }
  if (mensaje.startsWith('el caso exige fidelidad mínima')) {
    return 'No se pudo comprobar si las afirmaciones tenían respaldo';
  }
  if (mensaje.startsWith('fidelidad')) return 'Demasiadas afirmaciones sin respaldo en las fuentes citadas';
  return 'Otro fallo en la comprobación automática';
}

function conDetalle(frase: string, detalle: string | null): string {
  return detalle === null ? frase : `${frase}: ${detalle}`;
}

/** Las frases de una lista de fallos, sin repetir: dos evidencias que faltan
 *  son la misma frase y no hace falta leerla dos veces. */
export function frasesDeFallos(fallos: readonly string[]): string[] {
  return [...new Set(fallos.map(fraseDeFallo))];
}

/* ---------------------------------------------------------------------
   Resumen de una corrida
   --------------------------------------------------------------------- */

export interface ResumenLegible {
  /** "8 de 10 preguntas bien", o "Sin resultados" si no hay resumen. */
  bien: string;
  /** Fracción 0..1 de preguntas bien, o null sin resumen o sin preguntas. */
  fraccionBien: number | null;
  /** "92 %" o "Sin medir". */
  fidelidad: string;
  /** Con qué frecuencia la evidencia esperada salió entre los primeros
   *  resultados de la búsqueda: "80 %" o "Sin medir". */
  busqueda: string;
  /** Datos atribuidos a otra entidad: "0", "2" o "Sin medir". */
  atribuciones: string;
  /** Todas las preguntas bien y sin fallos importantes. */
  todoBien: boolean;
}

const SIN_MEDIR = 'Sin medir';

/** Una proporción 0..1 como porcentaje entero ("92 %"), o null si no es un
 *  número: las corridas anteriores a una métrica no la traen. */
export function porcentaje(x: unknown): string | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const acotado = Math.min(1, Math.max(0, x));
  return `${Math.round(acotado * 100).toLocaleString('es')} %`;
}

function entero(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
}

export function resumenDeCorrida(resumen: ResumenEvaluacion | null | undefined): ResumenLegible {
  if (resumen === null || resumen === undefined) {
    return {
      bien: 'Sin resultados',
      fraccionBien: null,
      fidelidad: SIN_MEDIR,
      busqueda: SIN_MEDIR,
      atribuciones: SIN_MEDIR,
      todoBien: false,
    };
  }
  const casos = entero(resumen.cases) ?? 0;
  const bien = Math.min(casos, entero(resumen.passed) ?? 0);
  const atribuciones = entero(resumen.entity_misattributions_total);
  return {
    bien: `${bien.toLocaleString('es')} de ${plural(casos, 'pregunta', 'preguntas')} bien`,
    fraccionBien: casos > 0 ? bien / casos : null,
    fidelidad: porcentaje(resumen.mean_faithfulness) ?? SIN_MEDIR,
    busqueda: porcentaje(resumen.mean_retrieval_hit_at_5) ?? SIN_MEDIR,
    atribuciones: atribuciones === null ? SIN_MEDIR : atribuciones.toLocaleString('es'),
    todoBien: casos > 0 && bien === casos && resumen.release_gate_passed === true,
  };
}

/* ---------------------------------------------------------------------
   Corridas: estado, fecha, avance
   --------------------------------------------------------------------- */

export type TonoEstado = 'curso' | 'bien' | 'fallos' | 'error';

/** El estado de una corrida en una palabra y un tono para pintarla. Una
 *  corrida terminada no es "Terminada" sin más: la médica quiere saber si
 *  fue bien o hubo fallos sin abrir la fila. */
export function estadoDeCorrida(c: Pick<CorridaEvaluacion, 'estado' | 'resumen'>): { texto: string; tono: TonoEstado } {
  switch (c.estado) {
    case 'running':
      return { texto: 'En marcha', tono: 'curso' };
    case 'error':
      return { texto: 'Interrumpida', tono: 'error' };
    default:
      return resumenDeCorrida(c.resumen).todoBien
        ? { texto: 'Todo bien', tono: 'bien' }
        : { texto: 'Con fallos', tono: 'fallos' };
  }
}

export function textoDeDisparo(disparo: CorridaEvaluacion['disparo']): string {
  return disparo === 'programada' ? 'Automática' : 'A petición';
}

/** "8 sept, 14:32". Sin año: el historial guarda 20 corridas, que en el peor
 *  caso (una a la semana) caben en cinco meses. */
export function fechaDeCorrida(ms: number): string {
  const d = new Date(ms);
  if (!(ms > 0) || Number.isNaN(d.getTime())) return 'Sin fecha';
  return d.toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "Evaluando: 3 de 12 preguntas · ahora: ¿Qué dosis...?". `preguntaActual`
 *  es la pregunta del caso en curso ya resuelta por quien llama (la corrida
 *  guarda solo su clave, que es un identificador y no se enseña). */
export function describirAvanceCorrida(
  c: Pick<CorridaEvaluacion, 'casosHechos' | 'casosTotal'>,
  preguntaActual: string | null = null,
): string {
  const hechos = Math.max(0, Math.min(c.casosHechos, c.casosTotal));
  const base = `Evaluando: ${hechos.toLocaleString('es')} de ${plural(c.casosTotal, 'pregunta', 'preguntas')}`;
  const actual = preguntaActual?.trim() ?? '';
  return actual === '' ? base : `${base} · ahora: ${actual}`;
}

export function fraccionCorrida(c: Pick<CorridaEvaluacion, 'casosHechos' | 'casosTotal'>): number | null {
  if (!(c.casosTotal > 0)) return null;
  return Math.min(1, Math.max(0, c.casosHechos / c.casosTotal));
}

/* ---------------------------------------------------------------------
   Generación de preguntas
   --------------------------------------------------------------------- */

/**
 * Una generación que figura `running` desde hace más de esto está muerta: la
 * acción del servidor no puede durar más de 10 minutos y, si Convex la mata
 * por tiempo o el despliegue se reinicia, su `catch` no llega a cerrarla y la
 * fila se queda en marcha para siempre.
 *
 * Es el MISMO umbral con el que `evaluacion.datos.generar` la da por muerta y
 * la cierra al volver a pulsar (`generacionColgada` en convex/evaluacion/
 * datos.ts). No se importa de allí porque ese módulo arrastra el runtime del
 * servidor al paquete del navegador; calidad.test.ts comprueba que los dos
 * valores no se separan. Y hace falta aplicarlo aquí porque la pestaña
 * apagaba el botón mientras la fila dijera `running`, sin mirar la edad, y la
 * única vía del servidor para cerrarla era ese mismo botón: una generación
 * colgada dejaba "Proponiendo preguntas: 7 de 20" con la barra en marcha y el
 * botón apagado para siempre, recarga incluida (medido con una fila de hace
 * 3 h, que seguía dando el texto de avance).
 */
export const PREPARACION_GENERACION_MAX_MS = 11 * 60_000;
export const PASO_GENERACION_MAX_MS = 11 * 60_000;

/** Cuándo, como muy tarde, una generación con este avance tiene que haber dado
 *  señales de vida: el servidor la da por muerta pasado ese instante. El tope
 *  crece con el trabajo hecho (cada paso suma al menos uno a `generados +
 *  descartados`), así que una generación sana de 60 preguntas no se da por
 *  colgada por tardar. Es la MISMA fórmula que `generacionColgada` en
 *  convex/evaluacion/datos.ts; calidad.test.ts comprueba que no se separan. */
export function limiteDeGeneracion(g: Pick<GeneracionEvaluacion, 'empezadoEn' | 'generados' | 'descartados'>): number {
  const pasos = Math.max(0, g.generados) + Math.max(0, g.descartados) + 1;
  return g.empezadoEn + PREPARACION_GENERACION_MAX_MS + pasos * PASO_GENERACION_MAX_MS;
}

/** `true` si la generación figura en marcha desde hace tanto que ya no puede
 *  seguir viva. Con `>`, igual que el servidor: en el mismo instante en que
 *  aquí se habilita el botón, allí se acepta la pulsación (con el mismo reloj;
 *  un navegador con la hora adelantada solo adelanta el botón, y el servidor
 *  responde "espera a que termine", que se enseña). */
export function generacionColgada(
  g: Pick<GeneracionEvaluacion, 'estado' | 'empezadoEn' | 'generados' | 'descartados'>,
  ahora = Date.now(),
): boolean {
  return g.estado === 'running' && ahora > limiteDeGeneracion(g);
}

export type FaseGeneracion = 'en_marcha' | 'colgada' | 'fallida' | 'terminada';

/** En qué punto está una generación para la pantalla. `running` se desdobla
 *  en `en_marcha` y `colgada`: solo la primera enseña avance y apaga el botón. */
export function faseDeGeneracion(
  g: Pick<GeneracionEvaluacion, 'estado' | 'empezadoEn' | 'generados' | 'descartados'>,
  ahora = Date.now(),
): FaseGeneracion {
  if (g.estado === 'running') return generacionColgada(g, ahora) ? 'colgada' : 'en_marcha';
  return g.estado === 'error' ? 'fallida' : 'terminada';
}

/** El estado de una generación en una línea: el avance si sigue, que no
 *  terminó si se quedó colgada, el resultado si acabó. El motivo de un error
 *  lo enseña el componente aparte, porque viene del servidor y no pasa por
 *  aquí. */
export function describirGeneracion(g: GeneracionEvaluacion, ahora = Date.now()): string {
  switch (faseDeGeneracion(g, ahora)) {
    case 'colgada':
      // Sin el avance guardado ("7 de 20 · Leyendo x.pdf"): es de una acción
      // que ya no existe y parecería viva.
      return `La propuesta anterior no terminó (empezó ${haceCuanto(g.empezadoEn, ahora)}). Puedes volver a intentarlo.`;
    case 'en_marcha': {
      const hechas = Math.max(0, Math.min(g.generados, g.objetivo));
      const base = `Proponiendo preguntas: ${hechas.toLocaleString('es')} de ${g.objetivo.toLocaleString('es')}`;
      const paso = g.paso?.trim() ?? '';
      return paso === '' ? base : `${base} · ${paso}`;
    }
    case 'fallida':
      return `No se pudieron proponer las preguntas (${haceCuanto(g.terminadoEn ?? g.empezadoEn, ahora)})`;
    default: {
      const cuando = haceCuanto(g.terminadoEn ?? g.empezadoEn, ahora);
      const partes = [plural(g.generados, 'pregunta propuesta', 'preguntas propuestas')];
      if (g.descartados > 0) partes.push(plural(g.descartados, 'descartada por no poder comprobarse', 'descartadas por no poder comprobarse'));
      return `${partes.join(', ')} (${cuando})`;
    }
  }
}

export function fraccionGeneracion(g: Pick<GeneracionEvaluacion, 'generados' | 'objetivo'>): number | null {
  if (!(g.objetivo > 0)) return null;
  return Math.min(1, Math.max(0, g.generados / g.objetivo));
}

/* ---------------------------------------------------------------------
   Orden de los casos
   --------------------------------------------------------------------- */

export interface CasosAgrupados<T> {
  propuestos: T[];
  aprobados: T[];
  descartados: T[];
}

type CasoOrdenable = Pick<CasoEvaluacion, 'estado' | 'creadoEn' | 'clave'>;

const porClave = (a: CasoOrdenable, b: CasoOrdenable) => a.clave.localeCompare(b.clave, 'es', { numeric: true });
const masNuevoPrimero = (a: CasoOrdenable, b: CasoOrdenable) => b.creadoEn - a.creadoEn || porClave(a, b);

/**
 * Agrupa por estado y ordena cada grupo para la pantalla: las propuestas más
 * nuevas primero (es la cola de revisión, y el servidor las manda así); las
 * aprobadas por clave, que es el orden en que la corrida las responde y
 * agrupa las de una misma categoría; las descartadas, las más nuevas primero.
 * Un estado que no se reconoce va con las propuestas: mejor a la vista que
 * perdido en silencio.
 */
export function ordenarCasos<T extends CasoOrdenable>(casos: readonly T[]): CasosAgrupados<T> {
  const grupos: CasosAgrupados<T> = { propuestos: [], aprobados: [], descartados: [] };
  for (const c of casos) {
    if (c.estado === 'aprobado') grupos.aprobados.push(c);
    else if (c.estado === 'descartado') grupos.descartados.push(c);
    else grupos.propuestos.push(c);
  }
  grupos.propuestos.sort(masNuevoPrimero);
  grupos.aprobados.sort(porClave);
  grupos.descartados.sort(masNuevoPrimero);
  return grupos;
}
