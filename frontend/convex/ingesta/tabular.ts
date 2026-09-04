// Tabulares: XLSX y CSV. Port de `_detect_header`, `_rows_to_chunks`,
// `_parse_xlsx` y `_parse_csv` de generic.py: detección de fila de encabezado y
// un chunk por fila ("Campo: valor"), con `chunkType` "table" y `page` = número
// de fila.
//
// El XLSX se lee directamente del paquete (jszip + fast-xml-parser, las mismas
// piezas que el .docx) en vez de con una librería de hojas de cálculo: el
// `xlsx` de npm está congelado en 0.18.5 con una vulnerabilidad conocida, y
// exceljs arrastra una decena de dependencias antiguas (unzipper, archiver,
// tmp) que había que empaquetar para el runtime de Convex. Lo que hace falta
// aquí es poco: hojas en orden, cadenas compartidas, celdas y fechas.
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { MAX_CHUNKS, chunkBase } from "./chunking";
import { decodificarBytes } from "./texto";
import type { ChunkParseado, Parseo } from "./tipos";

/** (número de fila 1-based, celdas como texto). */
export type Fila = [number, string[]];

/** `_looks_numeric`: cifra, porcentaje o importe. */
export function pareceNumero(s: string): boolean {
  return /^[-+]?[\d.,%$ ]+$/.test(s);
}

/** [cabecera, índice en `filas` de la fila de cabecera] o [null, -1].
 *
 *  Cabecera = la primera fila con >=2 celdas no vacías, si >=60 % de esas
 *  celdas son textuales (no numéricas). Si esa primera fila "ancha" es
 *  numérica, se asume que no hay encabezado. */
export function detectarCabecera(filas: Fila[]): [string[] | null, number] {
  for (let idx = 0; idx < Math.min(filas.length, 10); idx++) {
    const celdas = filas[idx][1];
    const noVacias = celdas.filter(Boolean);
    if (noVacias.length < 2) continue;
    const textuales = noVacias.filter((c) => !pareceNumero(c));
    if (textuales.length / noVacias.length >= 0.6) return [celdas, idx];
    return [null, -1];
  }
  return [null, -1];
}

/** Un chunk por fila de datos ("Campo: valor"). page = número de fila. */
export function filasAChunks(filas: Fila[], nombre: string, etiquetaHoja?: string): ChunkParseado[] {
  if (!filas.length) return [];
  const [cabecera, indiceCabecera] = detectarCabecera(filas);
  const filasDeDatos = cabecera !== null ? filas.slice(indiceCabecera + 1) : filas;

  const nombreCampo = (j: number): string => {
    if (cabecera !== null && j < cabecera.length && cabecera[j]) return cabecera[j];
    return `Columna ${j + 1}`;
  };

  const chunks: ChunkParseado[] = [];
  for (const [numeroFila, celdas] of filasDeDatos) {
    const lineas: string[] = [];
    celdas.forEach((valor, j) => {
      if (valor) lineas.push(`${nombreCampo(j)}: ${valor}`);
    });
    if (!lineas.length) continue;
    if (etiquetaHoja) lineas.unshift(`Hoja: ${etiquetaHoja}, fila ${numeroFila}`);
    const texto = lineas.join("\n").trim();
    if (!texto) continue;
    chunks.push(chunkBase(nombre, texto, numeroFila, [numeroFila], "table", { sourceRow: numeroFila }));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------
const parserXlsx = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  // openpyxl escribe los acentos como entidades numéricas ("&#237;") y
  // fast-xml-parser solo las decodifica con esta opción.
  htmlEntities: true,
  isArray: (nombre) =>
    ["sheet", "row", "c", "si", "xf", "numFmt", "Relationship", "r", "t"].includes(nombre),
});

type NodoXml = Record<string, unknown>;

/** Texto de un nodo: cadena, `#text`, o la concatenación de sus runs (`r`/`t`),
 *  saltando la fonética (`rPh`) y las propiedades de formato. */
function textoNodo(n: unknown): string {
  if (n === null || n === undefined) return "";
  if (typeof n === "string" || typeof n === "number" || typeof n === "boolean") return String(n);
  if (Array.isArray(n)) return n.map(textoNodo).join("");
  if (typeof n === "object") {
    const o = n as NodoXml;
    if ("#text" in o) return textoNodo(o["#text"]);
    let s = "";
    for (const [clave, valor] of Object.entries(o)) {
      if (clave.startsWith("@_") || clave === "rPr" || clave === "rPh" || clave === "phoneticPr") continue;
      s += textoNodo(valor);
    }
    return s;
  }
  return "";
}

function atributo(n: unknown, nombre: string): string | undefined {
  if (n === null || typeof n !== "object") return undefined;
  const v = (n as NodoXml)[`@_${nombre}`];
  return v === undefined ? undefined : String(v);
}

/** Índice 0-based de la columna de una referencia "AB12". */
function indiceDeColumna(ref: string): number | null {
  const m = /^([A-Z]+)\d*$/i.exec(ref.trim());
  if (!m) return null;
  let indice = 0;
  for (const letra of m[1].toUpperCase()) indice = indice * 26 + (letra.charCodeAt(0) - 64);
  return indice - 1;
}

// Formatos de fecha y hora integrados de Excel (los que openpyxl trata como
// fecha con `data_only=True`).
const FORMATOS_FECHA_INTEGRADOS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** ¿El formato numérico es de fecha u hora? Para los personalizados se miran
 *  los códigos de día/mes/año/hora fuera de literales y corchetes, y se exige
 *  que no lleven dígitos de máscara ("0.00" es un número aunque tenga letras
 *  en una cola literal ya quitada). */
export function esFormatoFecha(numFmtId: number, codigo: string | undefined): boolean {
  if (FORMATOS_FECHA_INTEGRADOS.has(numFmtId)) return true;
  if (!codigo) return false;
  const limpio = codigo
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  if (/[#0?]/.test(limpio)) return false;
  return /[dmyhs]/i.test(limpio);
}

/** Fecha (y hora si la tiene) de un serial de Excel, como texto ISO.
 *
 *  openpyxl devolvía `datetime` y `str()` daba "2023-01-05 00:00:00"; aquí la
 *  medianoche se omite ("2023-01-05"), que es lo que quien lee la fila espera
 *  de una fecha de visita. Un serial menor que 1 es solo una hora. */
export function fechaDeSerial(serial: number, base1904 = false): string {
  const segundosTotales = Math.round(serial * 86400);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (serial < 1) {
    const h = Math.floor(segundosTotales / 3600);
    const m = Math.floor((segundosTotales % 3600) / 60);
    const s = segundosTotales % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  const epoca = base1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoca + segundosTotales * 1000);
  const fecha = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return h || m || s ? `${fecha} ${pad(h)}:${pad(m)}:${pad(s)}` : fecha;
}

/** `_cell_str` para números: "60" y no "60.0", "71.4" tal cual. */
function formatearNumero(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v.trim();
}

interface ContextoLibro {
  compartidas: string[];
  estilosFecha: boolean[];
  base1904: boolean;
}

/** Valor de una celda como texto, con la misma semántica que openpyxl con
 *  `data_only=True`: cadena compartida o en línea, booleano ("True"/"False"),
 *  error tal cual, fecha si el estilo lo dice, y el resultado cacheado de una
 *  fórmula (sin resultado, vacío). */
function valorDeCelda(c: NodoXml, libro: ContextoLibro): string {
  const tipo = atributo(c, "t") ?? "n";
  if (tipo === "inlineStr") return textoNodo(c.is).trim();
  const v = c.v === undefined ? "" : textoNodo(c.v);
  if (tipo === "s") {
    const indice = parseInt(v, 10);
    return (Number.isFinite(indice) ? libro.compartidas[indice] ?? "" : "").trim();
  }
  if (tipo === "str" || tipo === "e" || tipo === "d") return v.trim();
  if (tipo === "b") return v.trim() === "1" ? "True" : "False";
  if (!v.trim()) return "";
  const estilo = parseInt(atributo(c, "s") ?? "", 10);
  if (Number.isFinite(estilo) && libro.estilosFecha[estilo]) {
    const n = Number(v);
    if (Number.isFinite(n)) return fechaDeSerial(n, libro.base1904);
  }
  return formatearNumero(v);
}

function comoLista(x: unknown): NodoXml[] {
  if (x === undefined || x === null) return [];
  return (Array.isArray(x) ? x : [x]) as NodoXml[];
}

async function xmlDelZip(zip: JSZip, ruta: string): Promise<NodoXml | null> {
  const fichero = zip.file(ruta) ?? zip.file(ruta.replace(/^\//, ""));
  if (!fichero) return null;
  return parserXlsx.parse(await fichero.async("string")) as NodoXml;
}

/** Filas no vacías de cada hoja, en el orden del libro: [nombre, filas]. */
export async function leerXlsx(bytes: Uint8Array): Promise<Array<[string, Fila[]]>> {
  const zip = await JSZip.loadAsync(bytes);
  const libro = await xmlDelZip(zip, "xl/workbook.xml");
  if (!libro) throw new Error("no es un libro de Excel válido (falta xl/workbook.xml)");
  const workbook = (libro.workbook ?? {}) as NodoXml;
  const base1904 = ["1", "true"].includes(
    String(atributo(workbook.workbookPr, "date1904") ?? "").toLowerCase(),
  );

  // Hoja -> fichero, por las relaciones del libro.
  const rels = await xmlDelZip(zip, "xl/_rels/workbook.xml.rels");
  const destinos = new Map<string, string>();
  for (const rel of comoLista(((rels?.Relationships ?? {}) as NodoXml).Relationship)) {
    const id = atributo(rel, "Id");
    let destino = atributo(rel, "Target") ?? "";
    if (!id || !destino) continue;
    destino = destino.replace(/^\//, "");
    if (!destino.startsWith("xl/")) destino = `xl/${destino}`;
    destinos.set(id, destino);
  }

  // Cadenas compartidas y estilos de fecha.
  const sst = await xmlDelZip(zip, "xl/sharedStrings.xml");
  const compartidas = comoLista(((sst?.sst ?? {}) as NodoXml).si).map((si) => textoNodo(si));
  const estilos = await xmlDelZip(zip, "xl/styles.xml");
  const hojaEstilos = (estilos?.styleSheet ?? {}) as NodoXml;
  const codigos = new Map<number, string>();
  for (const f of comoLista(((hojaEstilos.numFmts ?? {}) as NodoXml).numFmt)) {
    const id = parseInt(atributo(f, "numFmtId") ?? "", 10);
    if (Number.isFinite(id)) codigos.set(id, atributo(f, "formatCode") ?? "");
  }
  const estilosFecha = comoLista(((hojaEstilos.cellXfs ?? {}) as NodoXml).xf).map((xf) => {
    const id = parseInt(atributo(xf, "numFmtId") ?? "0", 10);
    return esFormatoFecha(id, codigos.get(id));
  });
  const contexto: ContextoLibro = { compartidas, estilosFecha, base1904 };

  const hojas: Array<[string, Fila[]]> = [];
  for (const hoja of comoLista(((workbook.sheets ?? {}) as NodoXml).sheet)) {
    const nombre = atributo(hoja, "name") ?? `Hoja ${hojas.length + 1}`;
    const rid = atributo(hoja, "id") ?? atributo(hoja, "r:id");
    const ruta = rid ? destinos.get(rid) : undefined;
    if (!ruta || !/worksheets\//.test(ruta)) continue; // hojas de gráfico y similares
    const xml = await xmlDelZip(zip, ruta);
    if (!xml) continue;
    const datos = ((xml.worksheet ?? {}) as NodoXml).sheetData as NodoXml | undefined;
    const filas: Fila[] = [];
    let numeroFila = 0;
    for (const fila of comoLista(datos?.row)) {
      const declarada = parseInt(atributo(fila, "r") ?? "", 10);
      numeroFila = Number.isFinite(declarada) ? declarada : numeroFila + 1;
      const celdas: string[] = [];
      let columna = -1;
      for (const c of comoLista(fila.c)) {
        const ref = atributo(c, "r");
        const indice = ref ? indiceDeColumna(ref) : null;
        columna = indice ?? columna + 1;
        while (celdas.length < columna) celdas.push("");
        celdas[columna] = valorDeCelda(c, contexto);
      }
      if (celdas.some(Boolean)) filas.push([numeroFila, celdas]);
      // Corta temprano cuando el tope ya está garantizadamente excedido (+10:
      // margen por la posible fila de header).
      if (filas.length > MAX_CHUNKS + 10) break;
    }
    if (filas.length) hojas.push([nombre, filas]);
  }
  return hojas;
}

export async function parsearXlsx(bytes: Uint8Array, nombre: string): Promise<Parseo> {
  const hojas = await leerXlsx(bytes);
  const multi = hojas.length > 1;
  const chunks: ChunkParseado[] = [];
  for (const [titulo, filas] of hojas) {
    chunks.push(...filasAChunks(filas, nombre, multi ? titulo : undefined));
  }
  return { chunks, pages: chunks.length };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
const DELIMITADORES = [",", ";", "\t", "|"];

/** Ocurrencias de `ch` fuera de comillas dobles. */
function contarFuera(linea: string, ch: string): number {
  let n = 0;
  let enComillas = false;
  for (const c of linea) {
    if (c === '"') enComillas = !enComillas;
    else if (c === ch && !enComillas) n++;
  }
  return n;
}

/** El delimitador más consistente en las primeras líneas de la muestra, entre
 *  coma, punto y coma, tabulador y barra; coma si ninguno lo es. Es lo que
 *  hacía `csv.Sniffer` con `delimiters=",;\t|"`: gana el que aparece el mismo
 *  número de veces en más líneas, y a igualdad el que aparece más. */
export function detectarDelimitador(muestra: string): string {
  const lineas = muestra
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 20);
  if (!lineas.length) return ",";
  let mejor = ",";
  let mejorConsistencia = -1;
  let mejorModa = -1;
  for (const candidato of DELIMITADORES) {
    const conteos = lineas.map((l) => contarFuera(l, candidato)).filter((c) => c > 0);
    if (!conteos.length) continue;
    const frecuencia = new Map<number, number>();
    for (const c of conteos) frecuencia.set(c, (frecuencia.get(c) ?? 0) + 1);
    const [moda, veces] = [...frecuencia].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const consistencia = veces / lineas.length;
    if (consistencia > mejorConsistencia || (consistencia === mejorConsistencia && moda > mejorModa)) {
      mejor = candidato;
      mejorConsistencia = consistencia;
      mejorModa = moda;
    }
  }
  return mejorConsistencia >= 0.5 ? mejor : ",";
}

/** Registros de un CSV (RFC 4180: comillas dobles, comilla doblada, saltos
 *  dentro de comillas). Una línea en blanco es un registro vacío, como en
 *  `csv.reader`, para que la numeración de filas coincida con el fichero. */
export function leerCsv(texto: string, delimitador: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let enComillas = false;
  let campoEntrecomillado = false;
  const n = texto.length;
  for (let i = 0; i < n; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"' && campo === "" && !campoEntrecomillado) {
      enComillas = true;
      campoEntrecomillado = true;
      continue;
    }
    if (c === delimitador) {
      fila.push(campo);
      campo = "";
      campoEntrecomillado = false;
      continue;
    }
    if (c === "\r" || c === "\n") {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
      campoEntrecomillado = false;
      if (c === "\r" && texto[i + 1] === "\n") i++;
      continue;
    }
    campo += c;
  }
  if (campo !== "" || campoEntrecomillado || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

export function parsearCsvDocumento(bytes: Uint8Array, nombre: string): Parseo {
  const texto = decodificarBytes(bytes);
  const delimitador = detectarDelimitador(texto.slice(0, 8192));
  const filas: Fila[] = [];
  let numero = 0;
  for (const registro of leerCsv(texto, delimitador)) {
    numero++;
    const celdas = registro.map((c) => c.trim());
    if (celdas.some(Boolean)) filas.push([numero, celdas]);
    if (filas.length > MAX_CHUNKS + 10) break; // ver comentario en leerXlsx
  }
  const chunks = filasAChunks(filas, nombre);
  return { chunks, pages: chunks.length };
}
