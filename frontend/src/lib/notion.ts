// Texto y lectura de URL para el bloque de Notion del panel de documentos.
// Son funciones puras, separadas del componente para poder probarlas y
// porque el criterio de redacción es uno solo: quien lee es una médica, no
// una programadora. Aquí no aparecen "token", "variable", "id" ni "API".

import type { AvisoNotion, CorridaNotion, ProgresoNotion } from '../types';

/** Lee `?notion=conectado|cancelado|error&motivo=…` de una query string.
 *  Cualquier otro valor se ignora: la URL la escribe el servidor, pero puede
 *  llegar manipulada y no hay que pintar nada que no se reconozca. */
export function leerAvisoNotion(search: string): AvisoNotion | null {
  const params = new URLSearchParams(search);
  const tipo = params.get('notion');
  if (tipo === 'conectado') return { tipo };
  if (tipo === 'cancelado') return { tipo };
  if (tipo === 'error') {
    const motivo = params.get('motivo');
    return { tipo, motivo: motivo !== null && /^[a-z_]{1,32}$/.test(motivo) ? motivo : null };
  }
  return null;
}

/** La misma URL sin `notion` ni `motivo`, como ruta relativa para
 *  `history.replaceState`: al recargar no debe volver a salir el aviso. */
export function urlSinAvisoNotion(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('notion');
  u.searchParams.delete('motivo');
  return `${u.pathname}${u.search}${u.hash}`;
}

/** El aviso breve al volver de Notion, en llano. */
export function textoDeAviso(aviso: AvisoNotion): string {
  switch (aviso.tipo) {
    case 'conectado':
      return 'Notion quedó conectado. Elige la base de datos que quieres sincronizar.';
    case 'cancelado':
      return 'No se completó la conexión con Notion: se canceló en la pantalla de Notion.';
    case 'error':
      switch (aviso.motivo) {
        case 'estado':
          return 'No se completó la conexión con Notion: el enlace había caducado o ya se había usado. Vuelve a pulsar "Conectar con Notion".';
        case 'no_habilitada':
          return 'No se completó la conexión: aún no está habilitada por el equipo técnico.';
        default:
          return 'No se completó la conexión con Notion. Vuelve a intentarlo en un momento.';
      }
  }
}

export function plural(n: number, singular: string, pluralForm: string): string {
  return `${n.toLocaleString('es')} ${n === 1 ? singular : pluralForm}`;
}

/** "hace un momento", "hace 12 minutos", "hace 3 horas", "hace 2 días". Con
 *  palabras completas: "12 min" y "3 h" son jerga de pantalla. */
export function haceCuanto(ms: number, ahora = Date.now()): string {
  const diff = Math.max(0, ahora - ms);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${plural(min, 'minuto', 'minutos')}`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${plural(h, 'hora', 'horas')}`;
  return `hace ${plural(Math.round(h / 24), 'día', 'días')}`;
}

/** Resumen de una corrida terminada: "Hace 12 minutos: 14 páginas revisadas,
 *  3 documentos nuevos, 1 actualizado". Sin cambios lo dice así. */
export function describirCorrida(c: CorridaNotion, ahora = Date.now()): string {
  const cuando = haceCuanto(c.terminadoEn ?? c.empezadoEn, ahora);
  const partes: string[] = [plural(c.paginas, 'página revisada', 'páginas revisadas')];
  const cambios: string[] = [];
  if (c.nuevos > 0) cambios.push(plural(c.nuevos, 'documento nuevo', 'documentos nuevos'));
  if (c.actualizados > 0) cambios.push(plural(c.actualizados, 'actualizado', 'actualizados'));
  if (c.borrados > 0) cambios.push(plural(c.borrados, 'retirado', 'retirados'));
  partes.push(...(cambios.length > 0 ? cambios : ['sin cambios']));
  const texto = `${cuando}: ${partes.join(', ')}`;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** "Sincronizando: 8 de 20 páginas, ahora: Protocolo de p-tau217". */
export function describirProgreso(p: ProgresoNotion): string {
  if (p.paginasTotal === null) return 'Sincronizando: leyendo la lista de páginas…';
  const base = `Sincronizando: ${p.paginasProcesadas.toLocaleString('es')} de ${plural(p.paginasTotal, 'página', 'páginas')}`;
  return p.paginaActual ? `${base}, ahora: ${p.paginaActual}` : base;
}

/** Fracción 0..1 para la barra, o null si aún no se conoce el total. */
export function fraccionProgreso(p: ProgresoNotion): number | null {
  if (p.paginasTotal === null) return null;
  if (p.paginasTotal <= 0) return 1;
  return Math.min(1, Math.max(0, p.paginasProcesadas / p.paginasTotal));
}

/** Si el icono del espacio es una imagen que se puede pintar (Notion da una
 *  URL o un emoji). Solo http(s): nada de `data:` ni `javascript:`. */
export function iconoEsImagen(icono: string | null): boolean {
  return icono !== null && /^https?:\/\//i.test(icono);
}
