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

// ---------------------------------------------------------------------------
// Vuelta de Notion sin abandonar la aplicación
// ---------------------------------------------------------------------------
//
// La primera versión llevaba la pestaña entera a Notion con
// `location.assign`. Si algo salía mal allí, la usuaria se quedaba plantada en
// la web de Notion y perdía de vista la aplicación. Ahora el consentimiento se
// pide en una ventana EMERGENTE y la app se queda montada detrás.
//
// El aviso vuelve de la emergente a la ventana principal por un canal de
// mismo origen (`BroadcastChannel`), no por `window.opener`: Notion puede
// mandar `Cross-Origin-Opener-Policy` y romper esa referencia al navegar, y
// entonces la emergente no tendría a quién avisar. El canal no depende de eso.
//
// Y para saber si la página que vuelve es una emergente que debe cerrarse, o
// una pestaña normal que viene del respaldo de página completa, se deja una
// MARCA en `localStorage` al abrir la emergente. Sin marca, la página se
// monta como siempre.
//
// El estado de la conexión NO viaja por aquí: eso lo trae la suscripción
// reactiva a `notion.admin.estado`, que es la verdad del servidor. Por el
// canal solo va el texto del aviso, así que si el navegador no tuviera
// `BroadcastChannel` lo único que se pierde es la frase, no la conexión.

export const CANAL_NOTION = 'rag-notion';
export const CLAVE_MARCA_NOTION = 'rag:notion-conectando';

/** Cuánto vale la marca. Un poco más que los 10 minutos que vive el `state`
 *  en el servidor: si el `state` ya caducó, la emergente vuelve con
 *  `?notion=error&motivo=estado` y también hay que cerrarla. */
export const MARCA_VIDA_MS = 12 * 60_000;

/** Lo mínimo de `localStorage` que se usa aquí, para poder probarlo sin
 *  navegador (las pruebas corren en `edge-runtime`, no en jsdom). */
export interface AlmacenSimple {
  getItem(clave: string): string | null;
  setItem(clave: string, valor: string): void;
  removeItem(clave: string): void;
}

/** ¿Es esto un aviso de Notion válido? Lo que llega por el canal viene de otra
 *  ventana del mismo origen, pero se valida igual: solo se pinta lo que se
 *  reconoce. */
export function esAvisoNotion(dato: unknown): dato is AvisoNotion {
  if (typeof dato !== 'object' || dato === null) return false;
  const d = dato as { tipo?: unknown; motivo?: unknown };
  if (d.tipo === 'conectado' || d.tipo === 'cancelado') return true;
  if (d.tipo !== 'error') return false;
  return d.motivo === null || d.motivo === undefined || typeof d.motivo === 'string';
}

/** Se deja al abrir la emergente. Un almacén que lance (modo privado con las
 *  cookies bloqueadas) no debe tumbar el flujo: sin marca, la vuelta se
 *  comporta como el respaldo de página completa. */
export function ponerMarcaConexion(almacen: AlmacenSimple, ahora: number): void {
  try {
    almacen.setItem(CLAVE_MARCA_NOTION, String(ahora));
  } catch {
    /* sin almacén: la vuelta se montará como página normal */
  }
}

export function quitarMarcaConexion(almacen: AlmacenSimple): void {
  try {
    almacen.removeItem(CLAVE_MARCA_NOTION);
  } catch {
    /* nada que quitar */
  }
}

/** ¿Venimos de una emergente que abrimos nosotros? Consume la marca: la
 *  segunda vez ya no está, así que una pestaña que se recargue o que se abra
 *  luego con la misma URL no intenta cerrarse. Una marca vieja o ilegible no
 *  cuenta. */
export function consumirMarcaConexion(almacen: AlmacenSimple, ahora: number): boolean {
  let crudo: string | null = null;
  try {
    crudo = almacen.getItem(CLAVE_MARCA_NOTION);
  } catch {
    return false;
  }
  quitarMarcaConexion(almacen);
  if (crudo === null) return false;
  const puesta = Number(crudo);
  return Number.isFinite(puesta) && ahora - puesta >= 0 && ahora - puesta < MARCA_VIDA_MS;
}

/** Rasgos de `window.open`: una ventana centrada en la pantalla de la usuaria,
 *  del tamaño que pide la pantalla de permisos de Notion. */
export function rasgosEmergente(pantalla: { width: number; height: number }): string {
  const ancho = Math.min(820, Math.max(420, pantalla.width - 80));
  const alto = Math.min(860, Math.max(480, pantalla.height - 120));
  const izquierda = Math.max(0, Math.round((pantalla.width - ancho) / 2));
  const arriba = Math.max(0, Math.round((pantalla.height - alto) / 2));
  return `popup=yes,width=${ancho},height=${alto},left=${izquierda},top=${arriba},noopener=no,noreferrer=no`;
}

/**
 * ¿Esta carga de la página es la vuelta de nuestra emergente, que debe
 * anunciar el aviso y cerrarse?
 *
 * El orden de las dos condiciones es la razón de que esto sea una función y no
 * dos líneas suel­tas: se mira PRIMERO que la URL traiga `?notion=`, porque
 * consumir la marca es destructivo y una carga cualquiera (una recarga de la
 * ventana principal mientras la emergente sigue abierta) no debe gastarla. Si
 * la gastara, la emergente volvería sin marca y se montaría la aplicación
 * entera dentro de la ventanita.
 *
 * Devuelve el aviso a anunciar, o `null` si hay que montar la aplicación
 * normalmente (incluido el caso del respaldo de página completa, que trae
 * `?notion=` pero no deja marca).
 */
export function avisoParaCerrarEmergente(
  search: string,
  almacen: AlmacenSimple,
  ahora: number,
): AvisoNotion | null {
  const aviso = leerAvisoNotion(search);
  if (aviso === null) return null;
  return consumirMarcaConexion(almacen, ahora) ? aviso : null;
}
