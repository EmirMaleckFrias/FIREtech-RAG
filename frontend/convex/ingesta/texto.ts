// TXT y Markdown: párrafos por líneas en blanco, empaquetados con solape. Port
// de `_parse_text` y `_decode_bytes` de generic.py.
import { chunkBase, empaquetar, partirParrafos } from "./chunking";
import type { ChunkParseado, Parseo } from "./tipos";

/** Texto a partir de bytes probando las codificaciones habituales, en el
 *  mismo orden que el Python: utf-8 (con o sin BOM), cp1252 y latin-1.
 *  `TextDecoder` con `fatal` lanza ante bytes inválidos, que es lo que
 *  permite caer a la siguiente. Como último recurso, utf-8 con sustitución. */
export function decodificarBytes(raw: Uint8Array): string {
  for (const codificacion of ["utf-8", "windows-1252", "iso-8859-1"]) {
    try {
      return new TextDecoder(codificacion, { fatal: true }).decode(raw);
    } catch {
      continue;
    }
  }
  return new TextDecoder("utf-8").decode(raw);
}

export function parsearTexto(bytes: Uint8Array, nombre: string): Parseo {
  const texto = decodificarBytes(bytes);
  const paras: Array<[string, number]> = partirParrafos(texto).map((p) => [p, 0]);

  const chunks: ChunkParseado[] = [];
  let i = 0;
  for (const grupo of empaquetar(paras)) {
    const cuerpo = grupo.map(([p]) => p).join("\n\n").trim();
    if (!cuerpo) continue;
    i++;
    // page = índice de chunk (1-based): no hay páginas reales.
    chunks.push(chunkBase(nombre, cuerpo, i, [i], "text"));
  }
  return { chunks, pages: chunks.length };
}
