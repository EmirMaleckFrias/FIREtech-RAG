// De dónde puede venir un documento además de subirse a mano: las fuentes
// que se sincronizan. Es la lista que pintan la ficha del documento (la
// etiqueta "Notion", "Google Drive", "OneDrive") y los chips de filtro de la
// vista de todos, así que añadir una fuente nueva es añadir una línea aquí.

import type { OrigenDocumento } from '../types';

export type OrigenSincronizado = Exclude<OrigenDocumento, 'subida'>;

export interface Fuente {
  id: OrigenSincronizado;
  nombre: string;
  /** Ruta pública del icono (public/). */
  icono: string;
}

export const FUENTES: readonly Fuente[] = [
  { id: 'notion', nombre: 'Notion', icono: '/notion.svg' },
  { id: 'google', nombre: 'Google Drive', icono: '/google-drive.svg' },
  { id: 'onedrive', nombre: 'OneDrive', icono: '/onedrive.svg' },
];

/** La fuente de un documento, o null si se subió a mano (o no consta). */
export function fuenteDe(origen: OrigenDocumento | null): Fuente | null {
  if (origen === null || origen === 'subida') return null;
  return FUENTES.find((f) => f.id === origen) ?? null;
}
