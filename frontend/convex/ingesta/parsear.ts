// Punto de entrada del parseo: `parse_generic` de generic.py. Decide por
// extensión, sanea, detecta el idioma del documento entero y aplica los topes.
import { MAX_CHUNKS } from "./chunking";
import { parsearDocx } from "./docx";
import { detectarIdioma } from "./idioma";
import { parsearPdf } from "./pdf";
import { parsearCsvDocumento, parsearXlsx } from "./tabular";
import { parsearTexto } from "./texto";
import type { Parseo } from "./tipos";

export const EXTENSIONES_SOPORTADAS = new Set([".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"]);

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
 *  Lanza si la extensión no está soportada, si no se extrae texto alguno, o
 *  si se supera MAX_CHUNKS. */
export async function parsearDocumento(
  nombre: string,
  bytes: Uint8Array,
  opciones: { omitirReferencias?: boolean } = {},
): Promise<Parseo> {
  const ext = extensionDe(nombre);
  let resultado: Parseo;
  if (ext === ".pdf") {
    const { chunks, pages, descartados } = await parsearPdf(bytes, nombre, opciones);
    if (descartados) console.info(`${nombre}: ${descartados} líneas de bibliografía descartadas.`);
    resultado = { chunks, pages };
  } else if (ext === ".docx") {
    resultado = await parsearDocx(bytes, nombre);
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

  if (!chunks.length) {
    throw new Error(
      `'${nombre}' no contiene texto extraíble (¿PDF escaneado sin OCR o archivo vacío?)`,
    );
  }
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(
      `'${nombre}' genera ${chunks.length} chunks; el máximo permitido es ${MAX_CHUNKS}. ` +
        "Divide el documento en archivos más pequeños.",
    );
  }
  return { chunks, pages: resultado.pages };
}
