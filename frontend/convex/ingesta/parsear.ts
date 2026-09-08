// Punto de entrada del parseo: `parse_generic` de generic.py. Decide por
// extensión, sanea, detecta el idioma del documento entero y aplica los topes.
import { MAX_CHUNK_CHARS } from "./chunking";
import { parsearDocx } from "./docx";
import { EXTENSIONES_IMAGEN, parsearImagen } from "./imagen";
import { detectarIdioma } from "./idioma";
import { parsearPdf } from "./pdf";
import { parsearCsvDocumento, parsearXlsx } from "./tabular";
import { parsearTexto } from "./texto";
import { SIN_AVISOS, hayAvisos, type AvisosIngesta, type Ocr, type Parseo } from "./tipos";

export const EXTENSIONES_SOPORTADAS = new Set([".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md", ...EXTENSIONES_IMAGEN]);

/** ".pdf", en minúsculas, o "" si el nombre no tiene extensión. */
export function extensionDe(nombre: string): string {
  const m = /\.[^./\\]+$/.exec(nombre);
  return m ? m[0].toLowerCase() : "";
}

/** Parsea un documento -> { chunks, pages }.
 *
 *  `pages`: número de páginas para PDF; número de filas/chunks para el resto
 *  (es lo que se muestra como "pages" en el listado de documentos).
 *
 *  `omitirReferencias`: descarta la bibliografía de un PDF (por defecto). Son
 *  títulos de trabajos ajenos: casan con cualquier consulta, no son evidencia
 *  de nada y se pagan igual al embeberlos. Ponerlo en false solo tiene sentido
 *  si lo que se quiere consultar ES la bibliografía.
 *
 *  `ocr`: la función que lee imágenes (ingesta/ocr.ts). Con ella, una imagen
 *  suelta es un documento, un PDF escaneado se lee página a página y las
 *  imágenes incrustadas en un Word se indexan. Sin ella (las pruebas, o
 *  ENABLE_OCR=false) los parsers se comportan como antes.
 *
 *  Lanza si la extensión no está soportada o si no se extrae texto alguno. No
 *  hay tope de fragmentos: un documento grande tarda más, y el avance se ve.
 *  `alAvanzar` recibe (hecho, total) según se leen las páginas de un PDF. */
export async function parsearDocumento(
  nombre: string,
  bytes: Uint8Array,
  opciones: {
    omitirReferencias?: boolean;
    ocr?: Ocr;
    minTextoPagina?: number;
    alAvanzar?: (hecho: number, total: number) => void;
  } = {},
): Promise<Parseo> {
  const ext = extensionDe(nombre);
  let resultado: Parseo;
  if (ext === ".pdf") {
    const { chunks, pages, descartados, paginasOcr, avisos } = await parsearPdf(bytes, nombre, opciones);
    if (descartados) console.info(`${nombre}: ${descartados} líneas de bibliografía descartadas.`);
    if (paginasOcr) console.info(`${nombre}: ${paginasOcr} páginas leídas por OCR.`);
    resultado = { chunks, pages, avisos };
  } else if (ext === ".docx") {
    resultado = await parsearDocx(bytes, nombre, { ocr: opciones.ocr });
  } else if (EXTENSIONES_IMAGEN.has(ext)) {
    if (!opciones.ocr) {
      throw new Error(`'${nombre}' es una imagen y la lectura de imágenes (OCR) no está disponible.`);
    }
    resultado = await parsearImagen(bytes, nombre, ext, opciones.ocr);
  } else if (ext === ".doc") {
    throw new Error(
      "El formato .doc (Word 97-2003) no se puede leer. Abre el archivo en Word y " +
        "guárdalo como .docx, o expórtalo a PDF.",
    );
  } else if (ext === ".xlsx") {
    resultado = await parsearXlsx(bytes, nombre);
  } else if (ext === ".csv") {
    resultado = parsearCsvDocumento(bytes, nombre);
  } else if (ext === ".txt" || ext === ".md") {
    resultado = parsearTexto(bytes, nombre);
  } else {
    throw new Error(`Extensión no soportada: ${ext || "(ninguna)"}`);
  }

  // Saneo final: sin texto -> fuera (defensa extra; ya se filtra antes).
  const chunks = resultado.chunks.filter((c) => c.text.trim());

  // Idioma del documento entero, no por fragmento: un artículo está escrito
  // en un idioma, y decidirlo sobre todo el texto es mucho más fiable que
  // sobre un párrafo corto. Si no queda claro se deja vacío.
  const idioma = detectarIdioma(chunks.slice(0, 40).map((c) => c.text).join("\n"));
  for (const chunk of chunks) chunk.language = idioma;

  const avisos: AvisosIngesta = { ...SIN_AVISOS, ...(resultado.avisos ?? {}) };
  avisos.recortados = chunks.filter((c) => c.recortado).length;
  if (avisos.recortados) {
    console.warn(`${nombre}: ${avisos.recortados} fragmento(s) recortados a ${MAX_CHUNK_CHARS} caracteres.`);
  }

  if (!chunks.length) {
    // Un documento sin nada legible cuyas páginas FALLARON al leerse no es
    // "un escaneo en blanco": es un fallo, y reintentar puede arreglarlo.
    if (avisos.sinLeer > 0) {
      throw new Error(
        `'${nombre}' no se pudo leer: ${avisos.motivo ?? "sus páginas no se pudieron reconocer"}. ` +
          "Vuelve a intentarlo en unos minutos con el botón de reintentar.",
      );
    }
    throw new Error(
      opciones.ocr
        ? `'${nombre}' no contiene texto legible: ni texto propio ni texto reconocible en sus imágenes.`
        : `'${nombre}' no contiene texto extraíble (¿PDF escaneado sin OCR o archivo vacío?)`,
    );
  }
  return { chunks, pages: resultado.pages, ...(hayAvisos(avisos) ? { avisos } : {}) };
}
