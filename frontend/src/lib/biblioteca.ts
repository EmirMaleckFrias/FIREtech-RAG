// La lógica de la vista de todos los documentos (components/Biblioteca.tsx):
// qué formato es cada uno, cómo se busca, cómo se ordena y qué forma tiene el
// corpus. Es pura y vive aparte para poder probarla sin navegador.
//
// La idea que gobierna esta vista: los documentos de una médica que investiga
// no son "archivos", son FUENTES DE EVIDENCIA. Dos consecuencias:
//
// - **La identidad de un paper es su cita, no su nombre de fichero.** Ella
//   reconoce "Silva-Rodríguez et al., 2026", no "PMC13390017.pdf". Así que la
//   cita va primero y el nombre del fichero queda como dato secundario, al
//   revés de lo que hace un gestor de archivos.
//
// - **Cada documento aporta un peso medible: sus fragmentos.** Uno con 57
//   sostiene mucho más de sus respuestas que uno con 3, y eso explica por qué
//   a veces una pregunta sale fina. Es un dato que ningún gestor de archivos
//   tiene y aquí es el que de verdad informa, así que se enseña.

import type { DocumentInfo, DocumentStatus } from '../types';
import type { OrigenSincronizado } from './origenes';

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------

/** Familias de formato, no extensiones: a ella le da igual .xlsx o .csv, son
 *  "hojas de cálculo". Cada una lleva su color, que se usa SOLO como lomo de la
 *  ficha para poder barrer la rejilla con la vista. */
export type FamiliaFormato = 'pdf' | 'word' | 'hoja' | 'imagen' | 'texto';

export interface Formato {
  familia: FamiliaFormato;
  /** Lo que se lee en el filtro y en la ficha. */
  etiqueta: string;
  /** Dos o tres letras para el monograma de la ficha. */
  sigla: string;
}

const POR_EXTENSION: Record<string, FamiliaFormato> = {
  pdf: 'pdf',
  docx: 'word',
  doc: 'word',
  xlsx: 'hoja',
  xls: 'hoja',
  csv: 'hoja',
  jpg: 'imagen',
  jpeg: 'imagen',
  png: 'imagen',
  webp: 'imagen',
  gif: 'imagen',
  md: 'texto',
  txt: 'texto',
};

export const FORMATOS: Record<FamiliaFormato, Formato> = {
  pdf: { familia: 'pdf', etiqueta: 'PDF', sigla: 'PDF' },
  word: { familia: 'word', etiqueta: 'Word', sigla: 'DOC' },
  hoja: { familia: 'hoja', etiqueta: 'Hojas', sigla: 'XLS' },
  imagen: { familia: 'imagen', etiqueta: 'Imágenes', sigla: 'IMG' },
  texto: { familia: 'texto', etiqueta: 'Texto', sigla: 'TXT' },
};

/** El orden en que se enseñan los formatos: el más frecuente en un corpus
 *  clínico primero, y el genérico al final. Fijo y no por cantidad, para que
 *  la barra de composición no baile cada vez que se sube un documento. */
export const ORDEN_FORMATOS: FamiliaFormato[] = ['pdf', 'word', 'hoja', 'imagen', 'texto'];

/** El formato por la extensión del nombre. Lo desconocido cae en `texto`: es
 *  la familia sin color propio, y el servidor no acepta nada que no esté en la
 *  lista, así que no debería llegar aquí. */
export function formatoDe(fileName: string): Formato {
  const m = /\.([^.]+)$/.exec(fileName.toLowerCase());
  const familia = m ? POR_EXTENSION[m[1]] : undefined;
  return FORMATOS[familia ?? 'texto'];
}

// ---------------------------------------------------------------------------
// Identidad de un documento
// ---------------------------------------------------------------------------

export interface Identidad {
  /** La línea grande: la cita, o el título, o el nombre del fichero. */
  principal: string;
  /** La línea de lectura: el título de la obra, si aporta algo distinto. */
  secundaria: string;
  /** Siempre el nombre del fichero, en pequeño: es lo que ella subió. */
  fichero: string;
}

/** Qué se enseña de un documento y en qué orden de importancia.
 *
 *  Con cita, la cita manda y el título va debajo. Sin cita pero con título, el
 *  título manda (y no se repite debajo). Sin ninguno de los dos, el nombre del
 *  fichero es lo único que hay, y entonces NO se repite abajo: enseñarlo dos
 *  veces es ruido. */
export function identidadDe(doc: DocumentInfo): Identidad {
  const cita = (doc.citation ?? '').trim();
  const titulo = (doc.titulo ?? '').trim();
  if (cita) return { principal: cita, secundaria: titulo, fichero: doc.fileName };
  if (titulo) return { principal: titulo, secundaria: '', fichero: doc.fileName };
  return { principal: doc.fileName, secundaria: '', fichero: '' };
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

/** Sin tildes, minúsculas y con los espacios colapsados: buscar "silva
 *  rodriguez" tiene que encontrar "Silva-Rodríguez". Los guiones y los puntos
 *  cuentan como espacio, que es lo que hace que "PMC13390017" se encuentre
 *  escribiendo parte del nombre del fichero. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    // Rango de marcas diacríticas combinantes, escrito con escapes: los
    // caracteres literales aquí son invisibles y cualquier editor se los come.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** ¿El documento casa con la búsqueda? Todas las palabras tienen que aparecer
 *  en alguna parte de su identidad (cita, título o nombre), no
 *  necesariamente en la misma: escribir "silva 2026" encuentra el paper cuya
 *  cita es "Silva-Rodríguez et al., 2026". */
export function casa(doc: DocumentInfo, consulta: string): boolean {
  const palabras = normalizar(consulta).split(' ').filter(Boolean);
  if (palabras.length === 0) return true;
  const heno = normalizar(`${doc.fileName} ${doc.titulo ?? ''} ${doc.citation ?? ''}`);
  return palabras.every((p) => heno.includes(p));
}

// ---------------------------------------------------------------------------
// Filtros y orden
// ---------------------------------------------------------------------------

export type Orden = 'recientes' | 'peso' | 'nombre';

export const ORDENES: Array<{ id: Orden; etiqueta: string }> = [
  { id: 'recientes', etiqueta: 'Más recientes' },
  { id: 'peso', etiqueta: 'Más fragmentos' },
  { id: 'nombre', etiqueta: 'Nombre' },
];

export interface Filtros {
  texto: string;
  /** null = todos los formatos. */
  formato: FamiliaFormato | null;
  /** null = todos los estados. */
  estado: DocumentStatus | null;
  /** Solo los que llegaron por una sincronización concreta (Notion, Google
   *  Drive, OneDrive); null = de cualquier origen. */
  origen: OrigenSincronizado | null;
}

export const SIN_FILTROS: Filtros = { texto: '', formato: null, estado: null, origen: null };

export function hayFiltros(f: Filtros): boolean {
  return f.texto.trim() !== '' || f.formato !== null || f.estado !== null || f.origen !== null;
}

/** Compara cadenas con las reglas del español (para que la ñ y las tildes
 *  queden donde una persona las busca), con un desempate estable por si dos
 *  nombres son iguales. */
function porTexto(a: string, b: string): number {
  return a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true });
}

/** Filtra y ordena. Devuelve un array nuevo; nunca toca el de entrada, que
 *  viene de una suscripción de Convex. */
export function listar(docs: DocumentInfo[], filtros: Filtros, orden: Orden): DocumentInfo[] {
  const salida = docs.filter((d) => {
    if (filtros.formato !== null && formatoDe(d.fileName).familia !== filtros.formato) return false;
    if (filtros.estado !== null && d.status !== filtros.estado) return false;
    if (filtros.origen !== null && d.origen !== filtros.origen) return false;
    return casa(d, filtros.texto);
  });
  const cmp: Record<Orden, (a: DocumentInfo, b: DocumentInfo) => number> = {
    // Desempates explícitos en los tres: sin ellos el orden de dos documentos
    // subidos en el mismo milisegundo (una carpeta entera) cambiaba entre
    // renders y las fichas saltaban de sitio.
    recientes: (a, b) => b.ingestadoEn - a.ingestadoEn || porTexto(a.fileName, b.fileName),
    peso: (a, b) => b.chunks - a.chunks || porTexto(a.fileName, b.fileName),
    nombre: (a, b) => porTexto(a.fileName, b.fileName),
  };
  return salida.sort(cmp[orden]);
}

// ---------------------------------------------------------------------------
// La forma del corpus
// ---------------------------------------------------------------------------

export interface Resumen {
  documentos: number;
  fragmentos: number;
  procesando: number;
  fallidos: number;
  /** Los que llegaron por alguna sincronización, no a mano. */
  sincronizados: number;
}

export function resumir(docs: DocumentInfo[]): Resumen {
  return {
    documentos: docs.length,
    // Solo cuentan los fragmentos de lo que está listo: un documento en
    // proceso todavía no aporta nada a una respuesta, y uno fallido no va a
    // aportar. Contarlos infla la cifra que dice cuánta evidencia hay.
    fragmentos: docs.reduce((n, d) => n + (d.status === 'ready' ? d.chunks : 0), 0),
    procesando: docs.filter((d) => d.status === 'processing').length,
    fallidos: docs.filter((d) => d.status === 'failed').length,
    sincronizados: docs.filter((d) => d.origen !== null && d.origen !== 'subida').length,
  };
}

export interface TramoComposicion {
  formato: Formato;
  documentos: number;
  fragmentos: number;
  /** Parte del total de FRAGMENTOS, 0..1. La barra mide evidencia, no
   *  documentos: dos PDF de 50 fragmentos pesan más en las respuestas que diez
   *  notas de uno, y la barra tiene que decir eso. */
  fraccion: number;
}

/** La composición del corpus por formato, en el orden fijo de `ORDEN_FORMATOS`
 *  y sin los formatos que no tiene. Con todo en proceso (o sin nada listo) las
 *  fracciones son 0: la barra sale vacía en vez de repartir a ciegas. */
export function componer(docs: DocumentInfo[]): TramoComposicion[] {
  const listos = docs.filter((d) => d.status === 'ready');
  const total = listos.reduce((n, d) => n + d.chunks, 0);
  const tramos: TramoComposicion[] = [];
  for (const familia of ORDEN_FORMATOS) {
    const suyos = docs.filter((d) => formatoDe(d.fileName).familia === familia);
    if (suyos.length === 0) continue;
    const fragmentos = suyos.reduce((n, d) => n + (d.status === 'ready' ? d.chunks : 0), 0);
    tramos.push({
      formato: FORMATOS[familia],
      documentos: suyos.length,
      fragmentos,
      fraccion: total > 0 ? fragmentos / total : 0,
    });
  }
  return tramos;
}

/** Peso de un documento respecto del que más aporta, 0..1, para la barrita de
 *  su ficha. Se compara con el MÁXIMO y no con el total porque lo que informa
 *  es "¿este documento aporta mucho o poco, comparado con los que tengo?"; con
 *  el total, en un corpus de cien documentos todas las barras saldrían a cero.
 *
 *  Escala de raíz cuadrada: entre 3 y 57 fragmentos hay una diferencia que se
 *  tiene que ver, y en lineal los pequeños quedan en una línea invisible. */
export function pesoRelativo(chunks: number, maximo: number): number {
  if (maximo <= 0 || chunks <= 0) return 0;
  return Math.min(1, Math.sqrt(chunks / maximo));
}

export function maxFragmentos(docs: DocumentInfo[]): number {
  return docs.reduce((n, d) => Math.max(n, d.status === 'ready' ? d.chunks : 0), 0);
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "hoy", "ayer", "7 sep" o "7 sep 2025". Corta a propósito: en una ficha la
 *  fecha es un dato de apoyo, y "7 de septiembre de 2026, 10:42" ocupa la
 *  línea entera para decir lo mismo. La completa va en el `title`. */
export function fechaCorta(ms: number, ahora = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const hoy = new Date(ahora);
  const dias = Math.round(
    (new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'ayer';
  const mismoAnio = d.getFullYear() === hoy.getFullYear();
  return `${d.getDate()} ${MESES[d.getMonth()]}${mismoAnio ? '' : ` ${d.getFullYear()}`}`;
}

/** Los números grandes con el separador español: 1.240 fragmentos.
 *
 *  A mano y no con `toLocaleString('es')`: el resultado de esa función depende
 *  de los datos de idioma que traiga el runtime, y en el entorno de las
 *  pruebas (sin ICU completo) devolvía "1240". Una cifra que se lee distinto
 *  según dónde corra no se puede probar, y aquí es texto que ve la usuaria. */
export function cifra(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const entero = Math.trunc(Math.abs(n));
  const partes: string[] = [];
  let resto = String(entero);
  while (resto.length > 3) {
    partes.unshift(resto.slice(-3));
    resto = resto.slice(0, -3);
  }
  partes.unshift(resto);
  return `${n < 0 ? '-' : ''}${partes.join('.')}`;
}
