// Tema de la interfaz: claro, oscuro, o lo que diga el sistema.
//
// Decisiones:
// - El CSS NO consulta `prefers-color-scheme` para los tokens: depende de un
//   `data-theme` explícito en <html>, que este módulo escribe siempre. Así el
//   bloque de variables oscuras vive una sola vez en styles.css en vez de
//   duplicarse (una copia para la media query y otra para la elección
//   manual), que es la forma habitual de que las dos paletas se desincronicen.
// - Por eso hay un script inline en index.html que aplica el tema ANTES de
//   pintar. Sin él, quien tiene oscuro vería un fogonazo blanco en cada carga.
//   Ese script y `aplicar()` tienen que dejar el DOM igual.
// - 'sistema' es el valor por defecto y se conserva como opción elegible: es
//   el comportamiento que la app tenía antes de existir este ajuste, y sin él
//   no habría vuelta atrás una vez elegido claro u oscuro.
// - localStorage va en try/catch: en navegación privada lanza, y entonces el
//   tema dura lo que la pestaña, como ya hace 'rag-modo'.

export type Tema = 'sistema' | 'claro' | 'oscuro';

/** Clave de localStorage. Mismo prefijo que el resto de preferencias. */
const CLAVE = 'rag-tema';

/** Fondo de cada tema, para la barra del navegador. Igual que `--bg`. */
const COLOR_UI: Record<'claro' | 'oscuro', string> = {
  claro: '#FAFAF9',
  oscuro: '#101010',
};

function esTema(valor: unknown): valor is Tema {
  return valor === 'sistema' || valor === 'claro' || valor === 'oscuro';
}

/** Preferencia guardada, o 'sistema' si no hay ninguna o no se puede leer. */
export function leerTema(): Tema {
  try {
    const guardado = localStorage.getItem(CLAVE);
    return esTema(guardado) ? guardado : 'sistema';
  } catch {
    return 'sistema';
  }
}

export function guardarTema(tema: Tema): void {
  try {
    localStorage.setItem(CLAVE, tema);
  } catch {
    // Sin almacenamiento (modo privado): el tema dura lo que la pestaña.
  }
}

/** Qué tema toca pintar de verdad: resuelve 'sistema' contra el sistema. */
export function resolverTema(tema: Tema): 'claro' | 'oscuro' {
  if (tema !== 'sistema') return tema;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro';
}

/**
 * Escribe el tema en el DOM. `data-theme` es lo que leen los selectores de
 * styles.css; `theme-color` pinta la barra del navegador y la status bar de
 * iOS, que si no se queda con el color del tema contrario.
 */
export function aplicarTema(tema: Tema): void {
  const efectivo = resolverTema(tema);
  document.documentElement.dataset.theme = efectivo === 'oscuro' ? 'dark' : 'light';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COLOR_UI[efectivo]);
}

/**
 * Sigue los cambios de tema del sistema mientras la preferencia sea
 * 'sistema'. Se instala una vez al arrancar y no se desinstala: `leerTema()`
 * se consulta en cada disparo, así que elegir claro u oscuro lo desactiva de
 * hecho sin tener que resuscribir nada.
 */
export function observarSistema(): void {
  const consulta = window.matchMedia('(prefers-color-scheme: dark)');
  consulta.addEventListener('change', () => {
    if (leerTema() === 'sistema') aplicarTema('sistema');
  });
}
