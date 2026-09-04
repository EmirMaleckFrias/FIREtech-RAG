// Lectura de los errores que devuelven las funciones de Convex.
//
// Regla: el frontend NO reconoce cadenas. Antes había quince traducciones de
// mensajes de GoTrue por comparación de texto en inglés, y un cambio de
// redacción en el proveedor las dejaba mudas. Con Convex el servidor lanza
// `ConvexError` con datos estructurados: `codigo` dice qué pasó y `mensaje`
// trae el texto ya en español. Cualquier otro error (un `Error` a secas, que
// Convex además redacta a "Server Error" en producción) recibe el texto
// genérico que pase quien llama.

import { ConvexError } from 'convex/values';

type Datos = Record<string, unknown> | string;

function datosDe(err: unknown): Datos | null {
  // `instanceof` cubre el caso normal; la comprobación por nombre, el de un
  // bundle con dos copias de convex/values, donde instanceof falla en silencio.
  const esConvex =
    err instanceof ConvexError ||
    (err instanceof Error && err.name === 'ConvexError' && 'data' in err);
  if (!esConvex) return null;
  const d: unknown = (err as { data?: unknown }).data;
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && d !== null) return d as Record<string, unknown>;
  return null;
}

/** Código estructurado del error (`data.codigo`), o null si no es un ConvexError con él. */
export function codigoDeError(err: unknown): string | null {
  const d = datosDe(err);
  if (d === null || typeof d === 'string') return null;
  const c = d.codigo ?? d.code;
  return typeof c === 'string' && c !== '' ? c : null;
}

/**
 * Texto para el usuario. Solo se enseña lo que el servidor puso en `mensaje`
 * (o un `data` que sea directamente texto); todo lo demás cae en `porDefecto`,
 * que debe decir qué se intentaba y qué hacer.
 */
export function mensajeDeError(err: unknown, porDefecto: string): string {
  const d = datosDe(err);
  if (typeof d === 'string') return d.trim() !== '' ? d : porDefecto;
  if (d !== null) {
    const m = d.mensaje ?? d.message;
    if (typeof m === 'string' && m.trim() !== '') return m;
  }
  return porDefecto;
}

/** Un administrador revocó el acceso de esta cuenta (permisos.AccesoRevocado). */
export function esAccesoRevocado(err: unknown): boolean {
  return codigoDeError(err) === 'acceso_revocado';
}

/** El servidor no reconoce la sesión (permisos.NoAutenticado). */
export function esNoAutenticado(err: unknown): boolean {
  return codigoDeError(err) === 'no_autenticado';
}
