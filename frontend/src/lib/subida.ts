// Subida de un documento al almacenamiento de ficheros de Convex.
//
// El camino es: documentos.urlDeSubida (mutación, solo admin) devuelve una
// URL firmada; el fichero se envía a esa URL con un POST; la respuesta trae
// el `storageId`; y documentos.registrar recibe ese id junto con el nombre y
// el sha256, que se calcula aquí, en el navegador. El fichero original queda
// guardado, así que reindexar ya no exige volver a subirlo: desaparece el
// 409 `file_not_stored` de Vercel, cuyo disco era efímero.

/** SHA-256 en hexadecimal, con WebCrypto. Solo existe en contextos seguros
 *  (https o localhost), que son los únicos desde los que corre la app. */
export async function sha256De(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * POST del fichero a la URL de subida. Devuelve el `storageId`.
 *
 * Usa XMLHttpRequest en lugar de fetch: es la única vía en navegador para
 * obtener progreso REAL de subida (fetch no expone upload.onprogress sin
 * streams duplex, aún no soportados de forma fiable). `onProgress` recibe la
 * fracción 0..1, o null si el navegador no puede computarla (la UI muestra
 * entonces un estado indeterminado con shimmer). Cancelable vía AbortSignal.
 */
export function subirFichero(
  url: string,
  file: File,
  onProgress?: (fraction: number | null) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Subida cancelada', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.open('POST', url);
    xhr.responseType = 'text';
    // El almacenamiento guarda el tipo que se declare aquí y lo devuelve al
    // servir el fichero. Un navegador puede no conocer el tipo (.md, .csv en
    // algunos sistemas): mejor un genérico que una cabecera vacía.
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (ev) => {
      onProgress?.(ev.lengthComputable && ev.total > 0 ? ev.loaded / ev.total : null);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = safeJson(xhr.responseText);
        const id =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as { storageId?: unknown }).storageId
            : undefined;
        if (typeof id === 'string' && id !== '') resolve(id);
        else reject(new Error('El almacenamiento no devolvió el identificador del archivo.'));
      } else if (xhr.status === 413) {
        reject(new Error('El archivo supera el tamaño máximo que acepta el almacenamiento.'));
      } else {
        reject(new Error(`No se pudo subir el archivo (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('No se pudo conectar con el almacenamiento. Revisa tu conexión.'));
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'));

    xhr.send(file);
  });
}
