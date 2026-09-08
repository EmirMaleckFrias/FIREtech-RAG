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
  /** El texto pasaba de MAX_CHUNK_CHARS y se recortó. No se escribe en la
   *  base: se cuenta en los avisos del documento. */
  recortado?: boolean;
  /** La frase de contexto que escribe el modelo al indexar (ingesta/contexto.ts).
   *  La pone el pipeline justo antes de embeber, nunca el parser. */
  contexto?: string;
}

/** Resultado de parsear un documento: los fragmentos y el "número de páginas"
 *  que se muestra en el listado (páginas reales en PDF; filas o fragmentos en
 *  el resto, como hacía `parse_generic`). */
export interface Parseo {
  chunks: ChunkParseado[];
  pages: number;
  /** Lo que quedó sin leer o recortado. Ausente = nada que avisar. */
  avisos?: AvisosIngesta;
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

/** Qué pasó al leer una imagen. Es la distinción que hace que un fallo del
 *  modelo no se confunda con "no había nada escrito":
 *
 *  - `ok`: hay texto, y la lectura terminó (el modelo no se cortó a medias).
 *  - `sin_texto`: el modelo miró la imagen y respondió que no hay texto. Es un
 *    resultado legítimo, y se cachea.
 *  - `fallo`: el gateway falló, el modelo se cortó por longitud o devolvió un
 *    contenido vacío o rechazado. `texto` lleva lo que haya (puede ser una
 *    transcripción parcial), NUNCA se cachea, y reindexar vuelve a intentarlo.
 *  - `omitida`: no se intentó (tope de imágenes por documento, imagen
 *    demasiado pesada o demasiado pequeña, OCR desactivado). */
export type EstadoOcr = "ok" | "sin_texto" | "fallo" | "omitida";

export interface ResultadoOcr {
  /** Markdown reconocido, o "". */
  texto: string;
  estado: EstadoOcr;
  /** Por qué falló o se omitió, en llano, para el aviso del documento. */
  motivo?: string;
}

/** Un resultado a partir de un texto: `ok` si trae algo, `sin_texto` si no.
 *  Es lo que devuelven los OCR falsos de las pruebas. */
export function resultadoOcr(texto: string): ResultadoOcr {
  return { texto, estado: texto.trim() ? "ok" : "sin_texto" };
}

/** Lee una imagen. Nunca lanza por una imagen concreta: un fallo en una
 *  página no puede tirar la ingesta de las otras 59; lo dice en `estado`. */
export type Ocr = (imagen: ImagenParaOcr, contexto: ContextoOcr) => Promise<ResultadoOcr>;

/** Lo que la ingesta no pudo hacer del todo y la usuaria tiene que saber. Un
 *  documento con avisos sigue siendo "listo" (lo que se leyó se puede
 *  consultar), pero la ficha lo dice y ofrece volver a intentarlo. Antes esto
 *  moría en `console.warn` y en `ingestionRuns`, que nadie lee. */
export interface AvisosIngesta {
  /** Páginas (PDF) o imágenes (Word, imagen suelta) cuyo texto no se pudo
   *  leer por un fallo del modelo o del gateway: reindexar lo reintenta. */
  sinLeer: number;
  /** Imágenes que no se intentaron por pasar del tope por documento. */
  omitidas: number;
  /** Fragmentos cuyo texto se recortó al tope de caracteres: parte de una
   *  tabla o de una celda muy larga no está en el índice. */
  recortados: number;
  /** Fragmentos indexados sin su frase de contexto (ingesta/contexto.ts)
   *  porque el modelo no la pudo escribir: se buscan como antes de existir el
   *  contexto. Opcional porque los parsers no lo conocen: lo pone el
   *  pipeline al embeber. */
  sinContexto?: number;
  /** Primer motivo de fallo, para enseñarlo. */
  motivo?: string;
}

export const SIN_AVISOS: AvisosIngesta = { sinLeer: 0, omitidas: 0, recortados: 0 };

export function hayAvisos(a: AvisosIngesta): boolean {
  return a.sinLeer > 0 || a.omitidas > 0 || a.recortados > 0 || (a.sinContexto ?? 0) > 0;
}
