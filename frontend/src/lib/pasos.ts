// Los pasos de un turno del asistente, como los enseña la línea de tiempo del
// mensaje (components/Pasos.tsx): qué fases lleva, en cuál está, qué buscó
// cada búsqueda y en qué documentos, y cuánto tardó.
//
// Es la lectura "de agente" del turno: en vez de una lista cruda de consultas,
// una secuencia de pasos con nombre (entender, buscar, redactar, comprobar),
// cada búsqueda como una fila de herramienta con sus documentos en monedas
// de formato y su recuento, y al terminar un resumen de una línea. La idea
// viene de los asistentes agénticos (Kimi, entre otros): el paso tiene un
// título corto, la herramienta tiene un icono, un nombre y un metadato, y
// todo cuelga de una misma línea vertical.
//
// Sin React: lo prueba vitest tal cual.

import { formatoDe, type FamiliaFormato } from './biblioteca';
import { puntosDelPlan } from './mensajes';
import type { ChatMessage, EstadoTurno, Hop, Source } from '../types';

export type EstadoPaso = 'hecho' | 'en_curso' | 'pendiente';

export type ClavePaso = 'entender' | 'buscar' | 'redactar' | 'comprobar';

export interface Paso {
  clave: ClavePaso;
  /** Título corto del paso ("Buscando"). */
  titulo: string;
  /** Lo que acompaña al título, al estilo "Thinking | Escalar BM25": el
   *  detalle de este turno. Vacío si no hay nada que decir. */
  detalle: string;
  estado: EstadoPaso;
}

/** Una moneda: un documento como lo pinta la fila de herramienta. La familia
 *  da el color (la misma paleta que la biblioteca); null si no se pudo saber
 *  el formato porque el documento no está entre las fuentes del mensaje. */
export interface Moneda {
  ref: string;
  familia: FamiliaFormato | null;
  sigla: string;
}

/** Cuántas monedas se enseñan antes de resumir el resto en "+N". */
export const MAX_MONEDAS = 3;

/** "0,8 s", "12 s", "1 min 4 s". Sin decimales a partir de 10 s: a ese
 *  tamaño la décima no informa de nada. */
export function formatearDuracion(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10} s`.replace('.', ',');
  const s = ms / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toString().replace('.', ',')} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const resto = Math.round(s - min * 60);
  return resto > 0 ? `${min} min ${resto} s` : `${min} min`;
}

/** Fichero de cada referencia corta del hop, mirando en las fuentes del
 *  mensaje: los hops citan documentos por su cita ("Allegri et al., 2023")
 *  o por su nombre de archivo, y las fuentes traen las dos cosas. */
function ficherosPorReferencia(sources: Source[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const s of sources) {
    if (!s.source_file) continue;
    mapa.set(s.source_file, s.source_file);
    if (s.citation && s.citation.trim() !== '') mapa.set(s.citation.trim(), s.source_file);
  }
  return mapa;
}

/** Las monedas de una lista de referencias, sin repetir y en orden. */
export function monedasDe(referencias: string[], sources: Source[]): Moneda[] {
  const ficheros = ficherosPorReferencia(sources);
  const vistas = new Set<string>();
  const salida: Moneda[] = [];
  for (const cruda of referencias) {
    const ref = cruda.trim();
    if (ref === '' || vistas.has(ref)) continue;
    vistas.add(ref);
    const fichero = ficheros.get(ref) ?? (/\.[a-z0-9]{2,5}$/i.test(ref) ? ref : null);
    if (fichero !== null) {
      const f = formatoDe(fichero);
      salida.push({ ref, familia: f.familia, sigla: f.sigla });
    } else {
      salida.push({ ref, familia: null, sigla: ref.charAt(0).toUpperCase() });
    }
  }
  return salida;
}

/** Documentos distintos que aportaron algo en todo el turno. */
export function documentosDelTurno(hops: Hop[]): string[] {
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const h of hops) {
    for (const d of h.documentos ?? []) {
      const ref = d.trim();
      if (ref === '' || vistos.has(ref)) continue;
      vistos.add(ref);
      salida.push(ref);
    }
  }
  return salida;
}

/** Suma de lo que tardaron las búsquedas. 0 si ningún hop lo trae. */
export function duracionBusquedas(hops: Hop[]): number {
  return hops.reduce((n, h) => n + (typeof h.ms === 'number' && h.ms > 0 ? h.ms : 0), 0);
}

const ORDEN: Record<EstadoTurno, number> = {
  pensando: 0,
  buscando: 1,
  redactando: 2,
  revisando: 3,
  listo: 4,
  error: 4,
};

function estadoDe(indice: number, actual: number, turnoCerrado: boolean): EstadoPaso {
  if (turnoCerrado || indice < actual) return 'hecho';
  return indice === actual ? 'en_curso' : 'pendiente';
}

/**
 * Los cuatro pasos del turno con su estado y su detalle.
 *
 * Un turno cerrado en `listo` los tiene todos hechos; uno en curso tiene el
 * paso de su `estado` en marcha y los siguientes pendientes. En `error` se
 * devuelven los pasos que se sabe que ocurrieron (hasta donde llegó) y nada
 * más: el error lo pinta el mensaje.
 */
export function pasosDelTurno(msg: Pick<ChatMessage, 'estado' | 'hops' | 'plan' | 'sources' | 'verificacion'>): Paso[] {
  const actual = ORDEN[msg.estado] ?? 0;
  const cerrado = msg.estado === 'listo';
  const partes = puntosDelPlan(msg.plan).length;
  const hopsCerrados = msg.hops.filter((h) => typeof h.resultados === 'number');
  const fragmentos = hopsCerrados.reduce((n, h) => n + (h.resultados ?? 0), 0);
  const documentos = documentosDelTurno(msg.hops).length;

  const buscar: Paso = {
    clave: 'buscar',
    titulo: partes > 0 ? 'Buscando cada parte' : 'Buscando en tus documentos',
    detalle:
      partes > 0
        ? `${partes} ${partes === 1 ? 'parte' : 'partes'} de la pregunta`
        : msg.hops.length > 0
          ? `${msg.hops.length} ${msg.hops.length === 1 ? 'búsqueda' : 'búsquedas'}`
          : '',
    estado: estadoDe(1, actual, cerrado),
  };
  if (buscar.estado === 'hecho') buscar.titulo = partes > 0 ? 'Buscado por partes' : 'Buscado en tus documentos';

  const redactar: Paso = {
    clave: 'redactar',
    titulo: estadoDe(2, actual, cerrado) === 'hecho' ? 'Redactado' : 'Redactando',
    detalle:
      fragmentos > 0
        ? `con ${fragmentos} ${fragmentos === 1 ? 'fragmento' : 'fragmentos'} de ${documentos} ${documentos === 1 ? 'documento' : 'documentos'}`
        : '',
    estado: estadoDe(2, actual, cerrado),
  };

  const comprobadas = msg.verificacion?.afirmaciones.length ?? 0;
  const comprobar: Paso = {
    clave: 'comprobar',
    titulo: estadoDe(3, actual, cerrado) === 'hecho' ? 'Comprobado' : 'Comprobando cada afirmación',
    detalle:
      comprobadas > 0
        ? `${comprobadas} ${comprobadas === 1 ? 'afirmación contrastada' : 'afirmaciones contrastadas'} con su fuente`
        : '',
    estado: estadoDe(3, actual, cerrado),
  };

  const pasos: Paso[] = [
    {
      clave: 'entender',
      titulo: estadoDe(0, actual, cerrado) === 'hecho' ? 'Pregunta entendida' : 'Entendiendo la pregunta',
      detalle: partes > 0 ? `dividida en ${partes} ${partes === 1 ? 'parte' : 'partes'}` : '',
      estado: estadoDe(0, actual, cerrado),
    },
    buscar,
    redactar,
    comprobar,
  ];

  if (msg.estado === 'error') {
    // Solo lo que consta: la pregunta se entendió si hubo plan o búsquedas,
    // y se buscó si hay hops. Lo demás no se afirma.
    const hubo = msg.hops.length > 0 || msg.plan.length > 0;
    return pasos
      .filter((p) => (p.clave === 'entender' && hubo) || (p.clave === 'buscar' && msg.hops.length > 0))
      .map((p) => ({ ...p, estado: 'hecho' as const }));
  }
  return pasos;
}

/** El resumen de una línea de un turno cerrado: búsquedas, documentos,
 *  afirmaciones y tiempo. Cada pieza por separado para que la vista ponga
 *  entre ellas un separador visual y no un carácter. */
export function resumenDelTurno(msg: Pick<ChatMessage, 'hops' | 'verificacion' | 'sources'>): string[] {
  const piezas: string[] = [];
  const n = msg.hops.length;
  piezas.push(`${n} ${n === 1 ? 'búsqueda' : 'búsquedas'}`);
  const docs = documentosDelTurno(msg.hops).length;
  if (docs > 0) piezas.push(`${docs} ${docs === 1 ? 'documento' : 'documentos'}`);
  const afirmaciones = msg.verificacion?.afirmaciones.length ?? 0;
  if (afirmaciones > 0) piezas.push(`${afirmaciones} ${afirmaciones === 1 ? 'afirmación comprobada' : 'afirmaciones comprobadas'}`);
  const ms = duracionBusquedas(msg.hops);
  if (ms > 0) piezas.push(formatearDuracion(ms));
  return piezas;
}
