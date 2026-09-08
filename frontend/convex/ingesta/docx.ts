// Word (.docx): párrafos agrupados por sección, más las tablas del documento.
// Port de `_parse_docx`, `_filas_de_tabla`, `_cabecera_de_tabla` y
// `_tabla_en_bloques` de generic.py.
//
// Se lee el XML del paquete (jszip + fast-xml-parser) y no con mammoth: mammoth
// convierte a HTML y pierde `w:gridSpan`, y sin el número de columnas de cada
// celda combinada se repite el defecto que motivó este módulo: un valor leído
// bajo la cabecera equivocada. Se recorre `w:body` en orden de documento (w:p
// y w:tbl) para que una tabla herede la sección bajo la que aparece y el
// rótulo que la precede.
//
// Word no tiene páginas: el salto de página lo calcula el visor al
// renderizar, así que el localizador de cita es la sección (el encabezado
// vigente) y, a falta de encabezados, el número de fragmento.
import JSZip from "jszip";
import { chunksDeMarkdown, EXTENSIONES_IMAGEN, mimeDeImagen } from "./imagen";
import { XMLParser } from "fast-xml-parser";
import {
  agruparPorSeccion,
  chunkBase,
  conContexto,
  empaquetar,
  partirParrafoLargo,
} from "./chunking";
import { ROTULO_TABLA } from "./lineas";
import { filaATexto, tablaEnBloques, type CeldaTabla, type FilaTabla } from "./tablas";
// Las funciones puras de tabla (filaATexto, cabeceraDeTabla, tablaEnBloques)
// viven en tablas.ts, compartidas con el parser de PDF; se reexportan para
// quien las importaba de aquí.
export { cabeceraDeTabla, filaATexto, tablaEnBloques, type CeldaTabla, type FilaTabla } from "./tablas";
import { SIN_AVISOS, type AvisosIngesta, type ChunkParseado, type Ocr, type Parseo } from "./tipos";

// `preserveOrder` conserva el orden de w:p y w:tbl dentro de w:body, que es lo
// que importa aquí; el precio es una estructura más verbosa: cada nodo es
// `{ "w:p": [hijos], ":@": {atributos} }` y el texto va en `{ "#text": "..." }`.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  processEntities: true,
  // Las entidades numéricas ("&#237;") solo se decodifican con esta opción:
  // sin ella, "Edad m&#237;nima" llegaba literal al índice (medido con el
  // fichero de openpyxl del fixture).
  htmlEntities: true,
});

type Nodo = Record<string, unknown>;

function etiqueta(n: Nodo): string {
  return Object.keys(n).find((k) => k !== ":@") ?? "";
}

function hijos(n: Nodo): Nodo[] {
  const h = n[etiqueta(n)];
  return Array.isArray(h) ? (h as Nodo[]) : [];
}

function atributo(n: Nodo | undefined, nombre: string): string | undefined {
  if (!n) return undefined;
  const attrs = n[":@"] as Record<string, unknown> | undefined;
  const v = attrs?.[nombre];
  return v === undefined ? undefined : String(v);
}

function hijo(n: Nodo, tag: string): Nodo | undefined {
  return hijos(n).find((h) => etiqueta(h) === tag);
}

// Lo que NO es texto del párrafo: propiedades, texto borrado con control de
// cambios, códigos de campo, y dibujos o cuadros de texto (python-docx tampoco
// los incluye en `paragraph.text`).
const NO_ES_TEXTO = new Set([
  "w:pPr", "w:rPr", "w:del", "w:instrText", "w:delText", "mc:AlternateContent",
  "w:drawing", "w:pict", "w:object", "w:tbl", "w:rPh", "#text",
]);

/** Texto de un párrafo como `paragraph.text` de python-docx: runs, hipervínculos
 *  e inserciones, con tabulador, salto y guion de no separación. */
function textoDeRuns(nodo: Nodo, salida: string[]): void {
  for (const h of hijos(nodo)) {
    const tag = etiqueta(h);
    if (NO_ES_TEXTO.has(tag)) continue;
    if (tag === "w:t") {
      salida.push(hijos(h).map((x) => (x["#text"] === undefined ? "" : String(x["#text"]))).join(""));
      continue;
    }
    if (tag === "w:tab" || tag === "w:ptab") {
      salida.push("\t");
      continue;
    }
    if (tag === "w:br" || tag === "w:cr") {
      salida.push("\n");
      continue;
    }
    if (tag === "w:noBreakHyphen") {
      salida.push("-");
      continue;
    }
    if (tag === "w:sym" || tag === "w:softHyphen") continue;
    textoDeRuns(h, salida);
  }
}

function textoDeParrafo(p: Nodo): string {
  const salida: string[] = [];
  textoDeRuns(p, salida);
  return salida.join("");
}

function estiloDe(p: Nodo): string {
  const pPr = hijo(p, "w:pPr");
  return (pPr && atributo(hijo(pPr, "w:pStyle"), "w:val")) ?? "";
}

// Prefijos de nombre de estilo que marcan un encabezado. Es lo que miraba el
// Python en `style.name`: "Heading 1", "Título 1", "Subtitle". "Title" a secas
// NO está, como en el original.
const PREFIJOS_TITULO = ["heading", "título", "titulo", "subtitle", "subtítulo"];
// Identificadores de estilo cuando no hay nombre (styles.xml ausente o estilo
// no declarado): Word escribe el identificador sin acentos ("Ttulo1").
const PREFIJOS_ID_TITULO = ["heading", "titulo", "ttulo", "subtitle", "subttulo"];

/** ¿El párrafo es un encabezado? Por estilo, que es lo fiable en Word. */
export function esTitulo(styleId: string, nombres: Map<string, string>): boolean {
  if (!styleId) return false;
  const nombre = nombres.get(styleId);
  if (nombre !== undefined) {
    const bajo = nombre.toLowerCase();
    return PREFIJOS_TITULO.some((p) => bajo.startsWith(p));
  }
  const id = styleId.toLowerCase();
  return PREFIJOS_ID_TITULO.some((p) => id.startsWith(p));
}

/** styleId -> nombre, de word/styles.xml (vacío si no existe). */
async function nombresDeEstilo(zip: JSZip): Promise<Map<string, string>> {
  const nombres = new Map<string, string>();
  const xml = await zip.file("word/styles.xml")?.async("string");
  if (!xml) return nombres;
  const raiz = parser.parse(xml) as Nodo[];
  const estilos = raiz.find((n) => etiqueta(n) === "w:styles");
  if (!estilos) return nombres;
  for (const estilo of hijos(estilos)) {
    if (etiqueta(estilo) !== "w:style") continue;
    const id = atributo(estilo, "w:styleId");
    const nombre = atributo(hijo(estilo, "w:name"), "w:val");
    if (id && nombre !== undefined) nombres.set(id, nombre);
  }
  return nombres;
}

/** Bloques del cuerpo en orden de documento: w:p y w:tbl, también dentro de
 *  controles de contenido (w:sdt) y XML personalizado, que python-docx se
 *  saltaba. */
function* bloquesDelCuerpo(nodos: Nodo[]): Generator<Nodo> {
  for (const n of nodos) {
    const tag = etiqueta(n);
    if (tag === "w:p" || tag === "w:tbl") {
      yield n;
    } else if (tag === "w:sdt") {
      const contenido = hijo(n, "w:sdtContent");
      if (contenido) yield* bloquesDelCuerpo(hijos(contenido));
    } else if (tag === "w:customXml" || tag === "w:smartTag") {
      yield* bloquesDelCuerpo(hijos(n));
    }
  }
}

function elementos(nodo: Nodo, tag: string): Nodo[] {
  const salida: Nodo[] = [];
  for (const h of hijos(nodo)) {
    const t = etiqueta(h);
    if (t === tag) salida.push(h);
    else if (t === "w:sdt") {
      const contenido = hijo(h, "w:sdtContent");
      if (contenido) salida.push(...elementos(contenido, tag));
    } else if (t === "w:customXml") salida.push(...elementos(h, tag));
  }
  return salida;
}

/** Texto de una celda como `cell.text` de python-docx (párrafos unidos por
 *  salto de línea), más las tablas anidadas aplanadas fila a fila, que
 *  `cell.text` perdía. */
function textoDeCelda(tc: Nodo): string {
  const partes: string[] = [];
  const recorrer = (nodo: Nodo) => {
    for (const h of hijos(nodo)) {
      const tag = etiqueta(h);
      if (tag === "w:p") partes.push(textoDeParrafo(h));
      else if (tag === "w:tbl") {
        for (const fila of filasDeTabla(h)) partes.push(filaATexto(fila.celdas));
      } else if (tag === "w:sdt") {
        const contenido = hijo(h, "w:sdtContent");
        if (contenido) recorrer(contenido);
      } else if (tag === "w:customXml") recorrer(h);
    }
  };
  recorrer(tc);
  return partes.join("\n");
}

/** Filas de una tabla de Word como celdas, UNA POR COLUMNA de la cuadrícula.
 *
 *  Devuelve celdas y no la línea ya montada porque la cabecera (ver
 *  `cabeceraDeTabla`) se decide contando celdas efectivas y sus anchos, y
 *  contar '|' en un texto es adivinar.
 *
 *  Dos formas de perder columnas, las dos medidas con documentos reales:
 *
 *  1. Deduplicar por TEXTO creyendo que dos celdas iguales son una combinada.
 *     Una tabla de basales con dos grupos de la misma edad media, "Edad | 72.4
 *     (6.1) | 72.4 (6.1) | 74.0 (5.8) | 0.31", salía como "Edad | 72.4 (6.1) |
 *     74.0 (5.8) | 0.31": 74.0 pasaba a leerse bajo MCI y 0.31 bajo AD.
 *  2. Colapsar la combinada de verdad a UNA posición. En una tabla de cabecera
 *     ["Grupo","Basal","Final","p"], la fila con la celda de "Basal"+"Final"
 *     combinada salía como "AD | n=40 (both visits) | 0.03", tres columnas
 *     contra cuatro, y 0.03 se leía como "Final".
 *
 *  La regla que arregla las dos: se recorre la cuadrícula y una celda que
 *  abarca k columnas (su `w:gridSpan`) ocupa k posiciones, con el TEXTO EN LA
 *  PRIMERA y un marcador vacío en las k-1 siguientes. Así la posición de cada
 *  valor es su columna, que es lo único que hace falta para leerlo bajo su
 *  cabecera.
 *
 *  Marcador vacío y no texto repetido a propósito: repetirlo pondría el valor
 *  bajo una cabecera en la que no se midió ("0.03" bajo "Final" es justo el
 *  error que se está corrigiendo), y una fila de título combinada a todo el
 *  ancho se repetiría cuatro veces en cada bloque de la tabla.
 *
 *  Las combinadas VERTICALES (`w:vMerge`) sí repiten el texto de la celda de
 *  arriba en cada fila, que es lo que hacía python-docx en `fila.cells` y lo
 *  que permite leer una fila sola sin buscar el rótulo de grupo filas más
 *  arriba.
 *
 *  Las celdas vacías se conservan en su sitio y solo se recorta el final de la
 *  fila (en `filaATexto`): el hueco de la esquina superior izquierda de una
 *  tabla de basales es una columna, y quitarlo desplazaría la cabecera
 *  respecto a los datos. Word permite además que una fila empiece más allá de
 *  la primera columna (`w:gridBefore`); esos huecos también son columnas. */
export function filasDeTabla(tbl: Nodo): FilaTabla[] {
  const filas: FilaTabla[] = [];
  const arriba = new Map<number, string>();
  for (const tr of elementos(tbl, "w:tr")) {
    const trPr = hijo(tr, "w:trPr");
    const gridBefore = parseInt((trPr && atributo(hijo(trPr, "w:gridBefore"), "w:val")) ?? "0", 10);
    const celdas: string[] = Array<string>(Math.max(0, Number.isFinite(gridBefore) ? gridBefore : 0)).fill("");
    const reales: CeldaTabla[] = [];
    let columna = celdas.length;
    for (const tc of elementos(tr, "w:tc")) {
      const tcPr = hijo(tc, "w:tcPr");
      const span = parseInt((tcPr && atributo(hijo(tcPr, "w:gridSpan"), "w:val")) ?? "1", 10);
      const ancho = Number.isFinite(span) && span > 0 ? span : 1;
      const vMerge = tcPr ? hijo(tcPr, "w:vMerge") : undefined;
      const continua = vMerge !== undefined && (atributo(vMerge, "w:val") ?? "continue") !== "restart";
      let texto = textoDeCelda(tc).replace(/\s+/g, " ").trim();
      if (continua) texto = arriba.get(columna) ?? texto;
      arriba.set(columna, texto);
      reales.push({ texto, desde: columna, ancho });
      celdas.push(texto, ...Array<string>(ancho - 1).fill(""));
      columna += ancho;
    }
    if (!celdas.some(Boolean)) continue;
    filas.push({ celdas, reales });
  }
  return filas;
}

/** Las imágenes incrustadas (word/media/*) que se pueden leer: fotos y
 *  capturas. Los formatos vectoriales de Office (emf, wmf, svg) no son
 *  imágenes para el modelo y se dejan. */
export async function imagenesDeDocx(zip: JSZip): Promise<Array<{ nombre: string; bytes: Uint8Array; ext: string }>> {
  const salida: Array<{ nombre: string; bytes: Uint8Array; ext: string }> = [];
  const nombres = Object.keys(zip.files)
    .filter((n) => /^word\/media\//.test(n) && !zip.files[n].dir)
    .sort();
  for (const n of nombres) {
    const ext = (/\.[^./]+$/.exec(n)?.[0] ?? "").toLowerCase();
    if (!EXTENSIONES_IMAGEN.has(ext)) continue;
    const bytes = await zip.file(n)?.async("uint8array");
    if (bytes && bytes.length > 0) salida.push({ nombre: n.slice("word/media/".length), bytes, ext });
  }
  return salida;
}

export async function parsearDocx(
  bytes: Uint8Array,
  nombre: string,
  opciones: { ocr?: Ocr } = {},
): Promise<Parseo> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(`'${nombre}' no es un documento Word válido (no es un paquete .docx)`);
  }
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error(`'${nombre}' no es un documento Word válido (falta word/document.xml)`);
  const nombres = await nombresDeEstilo(zip);
  const raiz = parser.parse(xml) as Nodo[];
  const documento = raiz.find((n) => etiqueta(n) === "w:document");
  const cuerpo = documento ? hijo(documento, "w:body") : undefined;
  if (!cuerpo) throw new Error(`'${nombre}' no es un documento Word válido (falta w:body)`);

  // (texto, sin localizador, sección) en el orden del documento.
  const bloques: Array<[string, null, string]> = [];
  // (filas, sección, rótulo) por tabla, en el orden del documento.
  const tablas: Array<[FilaTabla[], string, string]> = [];
  let seccion = "";
  let ultimoParrafo = "";

  for (const elemento of bloquesDelCuerpo(hijos(cuerpo))) {
    if (etiqueta(elemento) === "w:tbl") {
      const filas = filasDeTabla(elemento);
      if (filas.length) {
        const rotulo = ROTULO_TABLA.test(ultimoParrafo) ? ultimoParrafo : "";
        tablas.push([filas, seccion, rotulo]);
      }
      // Un rótulo describe UNA tabla: sin este reset, dos tablas consecutivas
      // heredaban las dos "Table 1. ..." (medido el 4 sep 2026) y la segunda
      // quedaba citada como la primera.
      ultimoParrafo = "";
      continue;
    }
    const texto = textoDeParrafo(elemento).trim();
    if (!texto) continue;
    if (esTitulo(estiloDe(elemento), nombres)) {
      seccion = texto;
      // El título también se indexa: es la mejor pista de qué viene.
      bloques.push([texto, null, seccion]);
      // Un rótulo de tabla es el párrafo INMEDIATAMENTE anterior a ella; si
      // en medio hay un encabezado, ya no describe la tabla.
      ultimoParrafo = "";
      continue;
    }
    for (const pieza of partirParrafoLargo(texto)) bloques.push([pieza, null, seccion]);
    ultimoParrafo = texto;
  }

  const chunks: ChunkParseado[] = [];
  let indice = 0;

  // Empaquetado por tramos de sección con el solape de empaquetar, y la
  // sección vigente delante de cada chunk (salvo el primero de la sección,
  // que ya empieza por el encabezado indexado como bloque).
  for (const [sec, grupo] of agruparPorSeccion(bloques)) {
    for (const paquete of empaquetar(grupo)) {
      const texto = paquete.map(([t]) => t).join("\n\n").trim();
      if (!texto) continue;
      indice++;
      chunks.push(chunkBase(nombre, conContexto(texto, sec), indice, [indice], "text", { section: sec }));
    }
  }

  // Las tablas se numeran aparte (tabla 1, tabla 2...): es como las busca
  // quien abre el documento, y no comparten numeración con los párrafos. Una
  // tabla larga sale en varios chunks que citan el MISMO número de tabla, y
  // cada uno lleva la cabecera y la sección para leerse por sí solo.
  tablas.forEach(([filas, sec, rotulo], i) => {
    const numero = i + 1;
    const partes = tablaEnBloques(filas);
    partes.forEach((texto, j) => {
      const chunk = chunkBase(nombre, conContexto(texto, sec, rotulo), numero, [numero], "table", {
        section: sec,
      });
      if (partes.length > 1) chunk.metadata = { table_part: j + 1, table_parts: partes.length };
      chunks.push(chunk);
    });
  });

  // Las imágenes incrustadas, por OCR, al final y en su propia sección: una
  // foto de una tabla o un diagrama con texto pegado en el Word es contenido
  // que sin esto no existía para quien pregunta. Cada imagen se cita por su
  // número ("imagen 2"), aparte de párrafos y tablas.
  const avisos: AvisosIngesta = { ...SIN_AVISOS };
  if (opciones.ocr) {
    const ocr = opciones.ocr;
    const medios = await imagenesDeDocx(zip);
    const resultados = await Promise.all(
      medios.map((m, i) =>
        ocr({ tipo: "bytes", bytes: m.bytes, mime: mimeDeImagen(m.ext) }, { nombre, indice: i + 1 }),
      ),
    );
    resultados.forEach((r, i) => {
      // Una imagen que no se pudo leer se cuenta; una omitida por el tope
      // también. Sin texto legítimo no hay nada que avisar.
      if (r.estado === "fallo") {
        avisos.sinLeer += 1;
        avisos.motivo = avisos.motivo ?? r.motivo;
      } else if (r.estado === "omitida" && r.motivo?.includes("pasa de")) {
        avisos.omitidas += 1;
        avisos.motivo = avisos.motivo ?? r.motivo;
      }
      if (!r.texto.trim()) return;
      const nuevos = chunksDeMarkdown(nombre, r.texto, i + 1, "Imágenes del documento", "docx");
      for (const c of nuevos) c.metadata = { ...(c.metadata ?? {}), imagen: medios[i].nombre };
      chunks.push(...nuevos);
    });
  }

  return { chunks, pages: chunks.length, avisos };
}
