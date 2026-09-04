// Tamaños de lote del pipeline. Van en un fichero sin "use node" para que los
// tests los importen sin arrastrar la acción.

/** Textos por petición de embeddings: margen bajo el límite de inputs por
 *  request, como en `embeddings.py`. */
export const LOTE_EMBEDDINGS = 96;

/** Chunks por mutación de escritura. Cada chunk lleva 3072 números (~25 KB en
 *  binario, hasta ~60 KB como JSON de argumentos) más hasta 8000 caracteres
 *  de texto, y en el runtime de Node los argumentos de una función están
 *  limitados a 5 MiB: 32 chunks quedan en ~2,3 MB en el peor caso. */
export const LOTE_ESCRITURA = 32;

/** Chunks borrados por mutación al retirar una versión. Cada uno se LEE
 *  entero para borrarlo (con sus 3072 números), así que 100 son ~2,5 MB
 *  leídos por transacción, lejos del tope. */
export const LOTE_BORRADO = 100;

/** Longitud máxima del mensaje de error que se guarda en `documents.error`. */
export const MAX_ERROR_CHARS = 500;
