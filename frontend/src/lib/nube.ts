// Texto y lectura de URL para los bloques de Google Drive y OneDrive del
// panel de documentos. Funciones puras, separadas del componente para poder
// probarlas, y con el mismo criterio de redacción que las de Notion: quien lee
// es una médica, no una programadora. Aquí no aparecen "token", "variable",
// "id" ni "API".

import type { AvisoNube, CorridaNube, ProgresoNube, ProveedorNube } from '../types';
import { haceCuanto, plural, type AlmacenSimple } from './notion';

export const NOMBRE_NUBE: Record<ProveedorNube, string> = {
  google: 'Google Drive',
  onedrive: 'OneDrive',
};

export const ICONO_NUBE: Record<ProveedorNube, string> = {
  // Recursos publicados por cada proveedor. No son dibujos recreados: Drive
  // sale del Brand Resource Center de Google y OneDrive de su CDN de Office.
  google: 'https://www.gstatic.com/marketing-cms/assets/images/a1/a6/49e0b7d9453b9b2a56526c0df3ff/drive.webp=s160-fcrop64=1,00000000ffffffff-rw',
  onedrive: 'https://res.cdn.office.net/files/fabric-cdn-prod_20221209.001/assets/brand-icons/product/svg/onedrive_48x1.svg',
};

export const PROVEEDORES_NUBE: readonly ProveedorNube[] = ['google', 'onedrive'];

export function esProveedorNube(x: unknown): x is ProveedorNube {
  return x === 'google' || x === 'onedrive';
}

/** Lee `?nube=google|onedrive&resultado=conectado|cancelado|error&motivo=…`.
 *  Cualquier otra cosa se ignora: la URL la escribe el servidor, pero puede
 *  llegar manipulada y no hay que pintar nada que no se reconozca. */
export function leerAvisoNube(search: string): AvisoNube | null {
  const params = new URLSearchParams(search);
  const proveedor = params.get('nube');
  if (!esProveedorNube(proveedor)) return null;
  const tipo = params.get('resultado');
  if (tipo === 'conectado' || tipo === 'cancelado') return { proveedor, tipo };
  if (tipo === 'error') {
    const motivo = params.get('motivo');
    return { proveedor, tipo, motivo: motivo !== null && /^[a-z_]{1,32}$/.test(motivo) ? motivo : null };
  }
  return null;
}

/** La misma URL sin `nube`, `resultado` ni `motivo`, como ruta relativa. */
export function urlSinAvisoNube(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('nube');
  u.searchParams.delete('resultado');
  u.searchParams.delete('motivo');
  return `${u.pathname}${u.search}${u.hash}`;
}

export function textoDeAvisoNube(aviso: AvisoNube): string {
  const nombre = NOMBRE_NUBE[aviso.proveedor];
  switch (aviso.tipo) {
    case 'conectado':
      return `${nombre} quedó conectado. Elige las carpetas que quieres sincronizar.`;
    case 'cancelado':
      return `No se completó la conexión con ${nombre}: se canceló en la pantalla de ${nombre}.`;
    case 'error':
      switch (aviso.motivo) {
        case 'estado':
          return `No se completó la conexión con ${nombre}: el enlace había caducado o ya se había usado. Vuelve a pulsar "Conectar con ${nombre}".`;
        case 'no_habilitada':
          return 'No se completó la conexión: aún no está habilitada por el equipo técnico.';
        default:
          return `No se completó la conexión con ${nombre}. Vuelve a intentarlo en un momento.`;
      }
  }
}

/** "Hace 12 minutos: 14 archivos revisados, 3 documentos nuevos, 1 actualizado". */
export function describirCorridaNube(c: CorridaNube, ahora = Date.now()): string {
  const cuando = haceCuanto(c.terminadoEn ?? c.empezadoEn, ahora);
  const partes: string[] = [plural(c.ficheros, 'archivo revisado', 'archivos revisados')];
  const cambios: string[] = [];
  if (c.nuevos > 0) cambios.push(plural(c.nuevos, 'documento nuevo', 'documentos nuevos'));
  if (c.actualizados > 0) cambios.push(plural(c.actualizados, 'actualizado', 'actualizados'));
  if (c.borrados > 0) cambios.push(plural(c.borrados, 'retirado', 'retirados'));
  partes.push(...(cambios.length > 0 ? cambios : ['sin cambios']));
  const texto = `${cuando}: ${partes.join(', ')}`;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** "Sincronizando: 8 de 20 archivos, ahora: Protocolos/guia.pdf". */
export function describirProgresoNube(p: ProgresoNube): string {
  if (p.ficherosTotal === null) return 'Sincronizando: leyendo las carpetas…';
  const base = `Sincronizando: ${p.ficherosProcesados.toLocaleString('es')} de ${plural(p.ficherosTotal, 'archivo', 'archivos')}`;
  return p.ficheroActual ? `${base}, ahora: ${p.ficheroActual}` : base;
}

export function fraccionProgresoNube(p: ProgresoNube): number | null {
  if (p.ficherosTotal === null) return null;
  if (p.ficherosTotal <= 0) return 1;
  return Math.min(1, Math.max(0, p.ficherosProcesados / p.ficherosTotal));
}

// ---------------------------------------------------------------------------
// Vuelta de la nube sin abandonar la aplicación
// ---------------------------------------------------------------------------
// Mismo mecanismo que el de Notion (ver lib/notion.ts): consentimiento en una
// ventana emergente, aviso de vuelta por un canal de mismo origen, y una MARCA
// en localStorage para saber que la página que vuelve es la emergente y debe
// cerrarse. Canal y marca son propios para no cruzarse con los de Notion.

export const CANAL_NUBE = 'rag-nube';
export const CLAVE_MARCA_NUBE = 'rag:nube-conectando';
export const MARCA_VIDA_MS = 12 * 60_000;

export function esAvisoNube(dato: unknown): dato is AvisoNube {
  if (typeof dato !== 'object' || dato === null) return false;
  const d = dato as { proveedor?: unknown; tipo?: unknown; motivo?: unknown };
  if (!esProveedorNube(d.proveedor)) return false;
  if (d.tipo === 'conectado' || d.tipo === 'cancelado') return true;
  if (d.tipo !== 'error') return false;
  return d.motivo === null || d.motivo === undefined || typeof d.motivo === 'string';
}

export function ponerMarcaNube(almacen: AlmacenSimple, ahora: number): void {
  try {
    almacen.setItem(CLAVE_MARCA_NUBE, String(ahora));
  } catch {
    /* sin almacén: la vuelta se montará como página normal */
  }
}

export function quitarMarcaNube(almacen: AlmacenSimple): void {
  try {
    almacen.removeItem(CLAVE_MARCA_NUBE);
  } catch {
    /* nada que quitar */
  }
}

/** Consume la marca: la segunda vez ya no está. Una marca vieja no cuenta. */
export function consumirMarcaNube(almacen: AlmacenSimple, ahora: number): boolean {
  let crudo: string | null = null;
  try {
    crudo = almacen.getItem(CLAVE_MARCA_NUBE);
  } catch {
    return false;
  }
  quitarMarcaNube(almacen);
  if (crudo === null) return false;
  const puesta = Number(crudo);
  return Number.isFinite(puesta) && ahora - puesta >= 0 && ahora - puesta < MARCA_VIDA_MS;
}

/** El aviso a anunciar si esta carga es la vuelta de nuestra emergente, o
 *  null si hay que montar la aplicación. Se mira PRIMERO la URL: consumir la
 *  marca es destructivo y una carga cualquiera no debe gastarla. */
export function avisoParaCerrarEmergenteNube(
  search: string,
  almacen: AlmacenSimple,
  ahora: number,
): AvisoNube | null {
  const aviso = leerAvisoNube(search);
  if (aviso === null) return null;
  return consumirMarcaNube(almacen, ahora) ? aviso : null;
}
