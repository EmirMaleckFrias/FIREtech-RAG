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

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------
//
// Los parsers no hacen OCR: encuentran imágenes y se las entregan a una
// función que les inyecta el pipeline. Así los parsers siguen siendo puros
// (se prueban con un OCR falso) y la parte que habla con el modelo y codifica
// PNG con `node:zlib` vive solo en el runtime de Node (ingesta/ocr.ts).

/** Una imagen tal como la encuentra un parser. `bytes` es un fichero de imagen
 *  entero (un .jpg suelto, un adjunto de Word); `pixeles` son los píxeles
 *  crudos que pdf.js ya decodificó de una página escaneada, con sus canales
 *  (1 gris, 3 RGB, 4 RGBA). */
export type ImagenParaOcr =
  | { tipo: "bytes"; bytes: Uint8Array; mime: string }
  | {
      tipo: "pixeles";
      ancho: number;
      alto: number;
      datos: Uint8ClampedArray | Uint8Array;
      canales: 1 | 3 | 4;
    };

/** De dónde sale la imagen, para el log y para el prompt. */
export interface ContextoOcr {
  nombre: string;
  pagina?: number;
  indice?: number;
}

/** Texto reconocido en Markdown, o "" si no había nada legible. Nunca lanza
 *  por una imagen concreta: un fallo en una página no puede tirar la ingesta
 *  de las otras 59. */
export type Ocr = (imagen: ImagenParaOcr, contexto: ContextoOcr) => Promise<string>;

