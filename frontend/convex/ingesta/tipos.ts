// Tipos compartidos del frente de ingesta. Sin "use node": lógica pura que
// importan tanto los parsers como los tests.

/** Identidad del trabajo, para citarlo como lo citaría un humano.
 *  Port de `paper.PaperMeta`. `autor` es el apellido del primer autor, con
 *  partículas ("van der Flier"). Todo vacío significa "no se pudo determinar":
 *  quien cita cae entonces al nombre del archivo, nunca se inventa nada. */
export interface MetaObra {
  titulo: string;
  autor: string;
  anio: string;
  doi: string;
}

export const META_VACIA: MetaObra = { titulo: "", autor: "", anio: "", doi: "" };

/** Un fragmento ya troceado, listo para embeber y escribir en `chunks`.
 *  Es el dict de `generic._base_chunk` sin las claves que rellena el pipeline
 *  (`sourceFile`, `documentId`, `documentVersion`, `embedding`, `documentRef`). */
export interface ChunkParseado {
  text: string;
  /** Página (PDF), número de fila (xlsx/csv), número de tabla o índice de
   *  fragmento (docx/txt): lo que muestra el localizador de la cita. */
  page: number;
  sourcePages: number[];
  section: string;
  chunkType: "text" | "table";
  documentType: string;
  titulo: string;
  citation: string;
  doi: string;
  /** Código de dos letras, o "" si no está claro. Se rellena a nivel de
   *  documento al final del parseo. */
  language: string;
  /** Claves en snake_case como en el payload de Qdrant (`source_row`,
   *  `table_part`, `table_parts`). */
  metadata?: Record<string, unknown>;
}

/** Resultado de parsear un documento: los fragmentos y el "número de páginas"
 *  que se muestra en el listado (páginas reales en PDF; filas o fragmentos en
 *  el resto, como hacía `parse_generic`). */
export interface Parseo {
  chunks: ChunkParseado[];
  pages: number;
}
