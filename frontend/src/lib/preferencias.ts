import { useSyncExternalStore } from 'react';

export type TamanoLectura = 'estandar' | 'comodo' | 'grande';
export interface Preferencias {
  tamanoLectura: TamanoLectura;
  enterEnvia: boolean;
  reducirMovimiento: boolean;
}

export const CLAVE_PREFERENCIAS = 'rag-preferencias';
export const PREFERENCIAS_INICIALES: Readonly<Preferencias> = Object.freeze({
  tamanoLectura: 'estandar',
  enterEnvia: true,
  reducirMovimiento: false,
});

/** Solo preferencias de interfaz: nunca se envían al agente ni al backend. */
export function normalizarPreferencias(valor: unknown): Preferencias {
  const v = valor !== null && typeof valor === 'object'
    ? valor as Record<string, unknown> : {};
  return {
    tamanoLectura: v.tamanoLectura === 'comodo' || v.tamanoLectura === 'grande'
      ? v.tamanoLectura : 'estandar',
    enterEnvia: typeof v.enterEnvia === 'boolean' ? v.enterEnvia : true,
    reducirMovimiento: typeof v.reducirMovimiento === 'boolean' ? v.reducirMovimiento : false,
  };
}

export function leerPreferencias(): Preferencias {
  try {
    return normalizarPreferencias(JSON.parse(localStorage.getItem(CLAVE_PREFERENCIAS) ?? 'null'));
  } catch {
    return { ...PREFERENCIAS_INICIALES };
  }
}

// Snapshot estable para React. Si el almacenamiento está bloqueado, los
// cambios siguen funcionando durante esta sesión, incluso al cerrar Ajustes.
let actual: Preferencias | undefined;
const oyentes = new Set<() => void>();
function snapshot(): Preferencias {
  return actual ??= leerPreferencias();
}
function suscribir(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => { oyentes.delete(oyente); };
}
function aplicar(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.lectura = snapshot().tamanoLectura;
  document.documentElement.dataset.reducirMovimiento = String(snapshot().reducirMovimiento);
}
function notificar(): void {
  aplicar();
  oyentes.forEach((oyente) => oyente());
}

export function guardarPreferencias(cambio: Partial<Preferencias>): boolean {
  actual = normalizarPreferencias({ ...snapshot(), ...cambio });
  let guardado = true;
  try {
    localStorage.setItem(CLAVE_PREFERENCIAS, JSON.stringify(actual));
  } catch {
    guardado = false;
  }
  notificar();
  return guardado;
}

/** Inicializar antes de montar React. Sin red, sin identificadores de usuario. */
export function iniciarPreferencias(): () => void {
  aplicar();
  const sincronizar = (evento: StorageEvent) => {
    if (evento.key !== CLAVE_PREFERENCIAS && evento.key !== null) return;
    // sessionStorage no es el almacén de preferencias.
    try {
      if (evento.storageArea !== null && evento.storageArea !== localStorage) return;
    } catch { return; }
    actual = leerPreferencias();
    notificar();
  };
  window.addEventListener('storage', sincronizar);
  return () => window.removeEventListener('storage', sincronizar);
}

export function usePreferencias(): Preferencias {
  return useSyncExternalStore(suscribir, snapshot, () => PREFERENCIAS_INICIALES);
}

interface TeclaEnvio {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}

/** Shift+Enter siempre inserta línea; Ctrl/Cmd+Enter siempre permite enviar. */
export function debeEnviar(tecla: TeclaEnvio, enterEnvia: boolean): boolean {
  return tecla.key === 'Enter' && !tecla.isComposing && tecla.keyCode !== 229 &&
    !tecla.shiftKey && !tecla.altKey && (enterEnvia || tecla.ctrlKey || tecla.metaKey);
}
