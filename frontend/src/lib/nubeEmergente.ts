// La parte del flujo de Google Drive y OneDrive que toca el navegador: abrir
// la ventana emergente, anunciar el resultado a la ventana principal y
// escucharlo. La lógica está en `nube.ts`, que es pura; aquí solo hay
// fontanería, la misma que en notionEmergente.ts.

import type { AvisoNube, ProveedorNube } from '../types';
import { despedirEmergente, llevarEmergenteA } from './notionEmergente';
import {
  avisoParaCerrarEmergenteNube,
  CANAL_NUBE,
  esAvisoNube,
  NOMBRE_NUBE,
  ponerMarcaNube,
  quitarMarcaNube,
} from './nube';
import { rasgosEmergente } from './notion';

export { despedirEmergente, llevarEmergenteA };

const NOMBRE_VENTANA = 'rag-nube-conectar';

interface MensajeNube {
  fuente: typeof CANAL_NUBE;
  aviso: AvisoNube;
}

function almacen() {
  return window.localStorage;
}

/** Abre la emergente EN EL MISMO GESTO del clic, en blanco: la URL llega tras
 *  un `await` y para entonces el navegador ya no la permitiría. null si la
 *  bloqueó: quien llama cae al redirigido de página completa. */
export function abrirEmergenteNubeEnBlanco(proveedor: ProveedorNube): Window | null {
  let ventana: Window | null = null;
  try {
    ventana = window.open('', NOMBRE_VENTANA, rasgosEmergente(window.screen));
  } catch {
    return null;
  }
  if (!ventana) return null;
  const nombre = NOMBRE_NUBE[proveedor];
  try {
    ventana.document.write(
      `<!doctype html><meta charset="utf-8"><title>Conectar con ${nombre}</title>` +
        '<p style="font:15px/1.5 system-ui,sans-serif;margin:48px;color:#444">' +
        `Abriendo ${nombre} para que inicies sesión y des permiso de lectura…</p>`,
    );
    ventana.document.close();
  } catch {
    /* si no se puede escribir, se queda en blanco un instante */
  }
  ponerMarcaNube(almacen(), Date.now());
  return ventana;
}

export function cerrarEmergenteNube(ventana: Window | null): void {
  quitarMarcaNube(almacen());
  if (!ventana) return;
  try {
    ventana.close();
  } catch {
    /* ya no es nuestra */
  }
}

export function marcarRespaldoPaginaCompletaNube(): void {
  quitarMarcaNube(almacen());
}

export function avisoDeEmergenteNube(): AvisoNube | null {
  return avisoParaCerrarEmergenteNube(window.location.search, almacen(), Date.now());
}

export function anunciarAvisoNube(aviso: AvisoNube): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const canal = new BroadcastChannel(CANAL_NUBE);
    const mensaje: MensajeNube = { fuente: CANAL_NUBE, aviso };
    canal.postMessage(mensaje);
    canal.close();
  } catch {
    /* sin canal se pierde la frase, no la conexión */
  }
}

export function escucharAvisosNube(alRecibir: (aviso: AvisoNube) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  let canal: BroadcastChannel;
  try {
    canal = new BroadcastChannel(CANAL_NUBE);
  } catch {
    return () => {};
  }
  canal.onmessage = (ev: MessageEvent<unknown>) => {
    const datos = ev.data as { fuente?: unknown; aviso?: unknown } | null;
    if (typeof datos !== 'object' || datos === null) return;
    if (datos.fuente !== CANAL_NUBE) return;
    if (!esAvisoNube(datos.aviso)) return;
    alRecibir(datos.aviso);
  };
  return () => {
    try {
      canal.close();
    } catch {
      /* ya cerrado */
    }
  };
}
