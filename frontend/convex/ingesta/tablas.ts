// Tablas como texto para el índice: la fila como línea de celdas, cuántas
// filas iniciales son cabecera y el reparto en bloques que la repiten. Son
// funciones PURAS sobre una forma común (`FilaTabla`), compartidas por el
// parser de Word (que la saca de la cuadrícula del documento) y el de PDF (que
// la reconstruye por geometría, ver pdf.ts `filasDeTablaPdf`). Sin "use node".
//
// Las decisiones de aquí se midieron con tablas clínicas reales de Word (ver
// los comentarios de cada función): la posición de cada valor es su columna,
// una combinada ocupa k posiciones con el texto en la primera, la cabecera se
// repite en cada bloque y nunca se asciende una fila de datos a cabecera.
import { TARGET_TOKENS, estTokens } from "./chunking";

/** Una celda real de la cuadrícula: su texto, la columna donde empieza y
 *  cuántas columnas abarca (`w:gridSpan`). */
export interface CeldaTabla {
  texto: string;
  desde: number;
  ancho: number;
}

/** Una fila: las celdas por COLUMNA de la cuadrícula (texto en la primera
 *  posición de una combinada y "" en las demás), y las celdas reales. */
export interface FilaTabla {
  celdas: string[];
  reales: CeldaTabla[];
}

/** Fila como línea de texto, celdas separadas por ' | '.
 *
 *  Se separan con ' | ' para que el modelo pueda leer la fila entera; las
 *  tablas de un documento clínico suelen llevar los datos que a nadie le sirve
 *  perder. Del final se recortan las celdas vacías, que no llevan ningún valor
 *  cuya columna se pueda confundir: una combinada que llega hasta la última
 *  columna pierde así su extensión visual, pero ningún dato cambia de sitio. */
export function filaATexto(celdas: string[]): string {
  // Solo por la derecha (`rstrip`): un hueco INICIAL es una columna real (la
  // fila que empieza en la segunda columna por `w:gridBefore`, o la esquina
  // vacía de una cabecera) y quitarlo desplazaría todos los valores.
  return celdas.join(" | ").replace(/[ |]+$/, "");
}

/** Cuántas filas iniciales son cabecera y hay que repetir en cada bloque.
 *
 *  Normalmente una. Pero en las tablas clínicas de Word la fila 0 es a menudo
 *  un TÍTULO combinado a todo el ancho ("Table 1. Baseline characteristics"),
 *  a veces seguido de una NOTA también combinada, y la cabecera real es la
 *  siguiente; tomando ciegamente la fila 0, los bloques 2..N repetían el
 *  título y NO llevaban los nombres de columna, que es exactamente lo que se
 *  quería evitar: medido con una tabla de 200 filas, las cinco partes salían
 *  encabezadas por "Table 1. Baseline characteristics" y sin "ID | Grupo |
 *  Basal | Final".
 *
 *  Criterio: se cuentan las filas iniciales consecutivas con UNA sola celda
 *  efectiva que abarca todo el ancho (título, nota), luego las filas de
 *  cabecera de grupo (una combinada que agrupa columnas, con alguna celda
 *  vacía y menos celdas con texto que la fila de debajo: el "" | "Grupo" de
 *  una cabecera de dos pisos), y la cabecera son todas ellas más la primera
 *  fila que nombra las columnas. Se exige que quede al menos una fila de
 *  datos.
 *
 *  Lo que NUNCA se hace es ascender una fila de datos a cabecera: una fila 0
 *  con una sola celda con texto pero SIN combinar a todo el ancho (una tabla
 *  de dos columnas cuya cabecera solo nombra la primera, ["Fármaco", ""]) es
 *  cabecera de una fila, no de dos; con el criterio anterior, que solo
 *  contaba celdas no vacías, la primera fila de datos se duplicaba en cada
 *  bloque y desaparecía de su sitio (revisión adversarial final). */
export function cabeceraDeTabla(filas: FilaTabla[]): number {
  if (filas.length < 2) return 1;
  const columnas = Math.max(...filas.map((f) => f.celdas.length));
  if (columnas < 2) return 1;
  const conTexto = (f: FilaTabla) => f.reales.filter((c) => c.texto).length;
  const esTituloCompleto = (f: FilaTabla) =>
    conTexto(f) === 1 &&
    (f.reales.length === 1 ||
      f.reales.some((c) => c.texto && c.desde === 0 && c.ancho >= columnas));
  const esCabeceraDeGrupo = (f: FilaTabla, siguiente: FilaTabla) =>
    f.reales.some((c) => c.ancho >= 2) &&
    f.reales.some((c) => !c.texto) &&
    conTexto(f) < conTexto(siguiente);

  let k = 0;
  while (k < filas.length - 1 && esTituloCompleto(filas[k])) k++;
  while (k < filas.length - 1 && esCabeceraDeGrupo(filas[k], filas[k + 1])) k++;
  if (k === 0) return 1;
  return Math.min(k + 1, filas.length - 1);
}

/** Reparte las filas de una tabla en bloques de ~TARGET_TOKENS, cada uno
 *  encabezado por las filas de cabecera.
 *
 *  Antes la tabla era un único chunk recortado a MAX_CHUNK_CHARS: en una
 *  tabla larga las filas del final desaparecían sin aviso. Y en un bloque que
 *  no sea el primero "74.0 (5.8)" no significa nada sin la fila "Control |
 *  MCI | AD | p" que le da columna, así que la cabecera se repite en todos. */
export function tablaEnBloques(filas: FilaTabla[]): string[] {
  if (filas.length < 2) return filas.map((f) => filaATexto(f.celdas));
  const corte = cabeceraDeTabla(filas);
  // La cabecera no puede comerse el bloque: con una "cabecera" de varias
  // filas combinadas (una tabla usada como caja de texto) el presupuesto de
  // filas caía a 1 y cada bloque era cabecera + una fila, muy por encima de
  // MAX_CHUNK_CHARS, y el recorte volvía a perder filas. Si la cabecera pasa
  // de la mitad del objetivo, se conserva solo su cola: la última fila es la
  // que da nombre a las columnas, que es lo que un bloque necesita.
  const filasCabecera = filas.slice(0, corte).map((f) => filaATexto(f.celdas));
  while (filasCabecera.length > 1 && estTokens(filasCabecera.join("\n")) > TARGET_TOKENS / 2) {
    filasCabecera.shift();
  }
  const cabecera = filasCabecera.join("\n");
  const cuerpo = filas.slice(corte).map((f) => filaATexto(f.celdas));
  const presupuesto = Math.max(TARGET_TOKENS - estTokens(cabecera), TARGET_TOKENS / 4);
  const bloques: string[] = [];
  let actual: string[] = [];
  let actualTok = 0;
  for (const fila of cuerpo) {
    const tok = estTokens(fila);
    if (actual.length && actualTok + tok > presupuesto) {
      bloques.push([cabecera, ...actual].join("\n"));
      actual = [];
      actualTok = 0;
    }
    actual.push(fila);
    actualTok += tok;
  }
  if (actual.length) bloques.push([cabecera, ...actual].join("\n"));
  return bloques;
}

