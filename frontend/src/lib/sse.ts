// Parser incremental de Server-Sent Events sobre un stream de texto.
//
// Un evento SSE llega como líneas `event: X` / `data: {...}` terminadas por una
// línea en blanco (doble newline). Un chunk del ReadableStream puede cortar un
// evento (o incluso una secuencia \r\n) por la mitad, así que aquí se bufferiza
// hasta tener bloques completos.

export interface SSEEvent {
  event: string;
  data: string;
}

export class SSEParser {
  /** Texto ya normalizado (\n) pendiente de formar un bloque completo. */
  private buffer = '';
  /** Un '\r' final puede ser la primera mitad de un '\r\n' partido entre chunks. */
  private pendingCR = false;

  feed(chunk: string, emit: (ev: SSEEvent) => void): void {
    if (this.pendingCR) {
      chunk = '\r' + chunk;
      this.pendingCR = false;
    }
    if (chunk.endsWith('\r')) {
      this.pendingCR = true;
      chunk = chunk.slice(0, -1);
    }
    // Normaliza terminadores de línea (\r\n y \r sueltos -> \n).
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseEventBlock(raw);
      if (ev) emit(ev);
    }
  }

  /** Procesa lo que quede en el buffer al cerrarse el stream. */
  flush(emit: (ev: SSEEvent) => void): void {
    if (this.pendingCR) {
      this.buffer += '\n';
      this.pendingCR = false;
    }
    if (this.buffer.trim().length > 0) {
      const ev = parseEventBlock(this.buffer);
      if (ev) emit(ev);
    }
    this.buffer = '';
  }
}

function parseEventBlock(raw: string): SSEEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // comentario / keep-alive
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}
