// Una imagen suelta (.jpg, .png, .webp, .gif) como documento: se lee por OCR y
// el Markdown que devuelve se trocea como un texto. Una foto de un protocolo
// pegado en la pared, un escaneo en JPG, una captura de una tabla: para quien
// pregunta es un documento como otro cualquiera, con su nombre y su cita.
import { chunkBase, conContexto, empaquetar, partirParrafos } from "./chunking";
import type { ChunkParseado, Ocr, Parseo } from "./tipos";

export const EXTENSIONES_IMAGEN = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mimeDeImagen(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

/** El primer encabezado del Markdown, para usarlo de título y de sección; ""
 *  si no hay. Un escaneo de una guía suele empezar por su título en grande, y
 *  el modelo lo devuelve como `#`. */
export function primerEncabezado(markdown: string): string {
  const m = /^#{1,3}\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1].replace(/[#*_`]/g, "").trim() : "";
}

/**
 * Trocea el Markdown de un OCR en chunks, todos con la misma "página"
 * (`pagina`) y la sección dada. Lo comparten la imagen suelta, las páginas
 * escaneadas de un PDF y los adjuntos de Word.
 */
export function chunksDeMarkdown(
  nombre: string,
  markdown: string,
  pagina: number,
  seccion: string,
  documentType: string,
  desdeIndice = 0,
): ChunkParseado[] {
  const paras = partirParrafos(markdown).filter((p) => p.trim() !== "");
  const chunks: ChunkParseado[] = [];
  let indice = desdeIndice;
  for (const paquete of empaquetar<null>(paras.map((p) => [p, null] as [string, null]))) {
    const texto = paquete.map(([t]) => t).join("\n\n").trim();
    if (!texto) continue;
    indice++;
    const chunk = chunkBase(nombre, conContexto(texto, seccion), pagina, [pagina], "text", {
      section: seccion,
    });
    chunk.documentType = documentType;
    chunks.push(chunk);
  }
  return chunks;
}

export async function parsearImagen(
  bytes: Uint8Array,
  nombre: string,
  ext: string,
  ocr: Ocr,
): Promise<Parseo> {
  const markdown = await ocr({ tipo: "bytes", bytes, mime: mimeDeImagen(ext) }, { nombre });
  if (!markdown.trim()) {
    throw new Error(
      `'${nombre}' no contiene texto legible: es una imagen sin texto, o el texto no se pudo reconocer.`,
    );
  }
  const titulo = primerEncabezado(markdown);
  const chunks = chunksDeMarkdown(nombre, markdown, 1, titulo, "imagen");
  for (const c of chunks) c.titulo = titulo;
  return { chunks, pages: 1 };
}
