// La parte del flujo de Notion que toca el navegador: abrir la ventana
// emergente, anunciar el resultado a la ventana principal y escucharlo. La
// lógica (validar el aviso, la marca, el tamaño de la ventana) está en
// `notion.ts`, que es puro y se prueba sin DOM; aquí solo hay fontanería.
//
// Por qué una emergente y no `location.assign`: la usuaria no debe perder de
// vista la aplicación mientras Notion le pregunta qué páginas comparte. Si el
// navegador bloquea las emergentes se cae al redirigido de página completa,
// que sigue funcionando igual que antes.

import type { AvisoNotion } from '../types';
import {
  avisoParaCerrarEmergente,
  CANAL_NOTION,
  esAvisoNotion,
  ponerMarcaConexion,
  quitarMarcaConexion,
  rasgosEmergente,
} from './notion';

/** Nombre de la ventana: un segundo clic reutiliza la misma en vez de abrir
 *  otra encima. */
const NOMBRE_VENTANA = 'rag-notion-conectar';

/** Lo que va por el canal. `fuente` distingue nuestros mensajes de los de
 *  cualquier otra cosa que use un canal con el mismo nombre. */
interface MensajeNotion {
  fuente: typeof CANAL_NOTION;
  aviso: AvisoNotion;
}

function almacen() {
  return window.localStorage;
}

/**
 * Abre la emergente EN EL MISMO GESTO del clic, en blanco.
 *
 * Es la parte delicada: la URL de autorización la da una mutación, o sea que
 * llega después de un `await`, y para entonces el navegador ya no considera
 * que la apertura venga de un clic y la bloquea. Así que primero se abre en
 * blanco (permitido) y luego se le pone la dirección.
 *
 * Devuelve `null` si el navegador la bloqueó de todas formas; quien llama debe
 * caer entonces al redirigido de página completa.
 */
export function abrirEmergenteEnBlanco(): Window | null {
  let ventana: Window | null = null;
  try {
    ventana = window.open('', NOMBRE_VENTANA, rasgosEmergente(window.screen));
  } catch {
    return null;
  }
  if (!ventana) return null;
  // Algo que leer mientras se pide la URL al servidor, para que no sea un
  // rectángulo blanco. Es su propio documento en blanco, del mismo origen.
  try {
    ventana.document.write(
      '<!doctype html><meta charset="utf-8"><title>Conectar con Notion</title>' +
        '<p style="font:15px/1.5 system-ui,sans-serif;margin:48px;color:#444">' +
        'Abriendo Notion para que elijas qué páginas compartir…</p>',
    );
    ventana.document.close();
  } catch {
    /* si no se puede escribir, se queda en blanco un instante */
  }
  ponerMarcaConexion(almacen(), Date.now());
  return ventana;
}

/** Lleva la emergente a la pantalla de permisos de Notion. */
export function llevarEmergenteA(ventana: Window, url: string): void {
  ventana.location.href = url;
}

/** Se abandona el intento: se cierra la ventana y se retira la marca, para que
 *  una vuelta posterior por página completa no se confunda con una emergente. */
export function cerrarEmergente(ventana: Window | null): void {
  quitarMarcaConexion(almacen());
  if (!ventana) return;
  try {
    ventana.close();
  } catch {
    /* ya no es nuestra */
  }
}

/** Antes de abrir nada: el respaldo de página completa no deja marca. */
export function marcarRespaldoPaginaCompleta(): void {
  quitarMarcaConexion(almacen());
}

/** El aviso a anunciar si esta carga es la vuelta de nuestra emergente, o
 *  `null` si hay que montar la aplicación normalmente. Consume la marca. */
export function avisoDeEmergente(): AvisoNotion | null {
  return avisoParaCerrarEmergente(window.location.search, almacen(), Date.now());
}

/** Manda el aviso a la ventana principal. No lleva el estado de la conexión:
 *  ese llega solo por la suscripción reactiva de Convex. */
export function anunciarAviso(aviso: AvisoNotion): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const canal = new BroadcastChannel(CANAL_NOTION);
    const mensaje: MensajeNotion = { fuente: CANAL_NOTION, aviso };
    canal.postMessage(mensaje);
    canal.close();
  } catch {
    /* sin canal se pierde la frase, no la conexión */
  }
}

/** Escucha los avisos de la emergente. Devuelve la función para dejar de
 *  escuchar. */
export function escucharAvisos(alRecibir: (aviso: AvisoNotion) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  let canal: BroadcastChannel;
  try {
    canal = new BroadcastChannel(CANAL_NOTION);
  } catch {
    return () => {};
  }
  canal.onmessage = (ev: MessageEvent<unknown>) => {
    const datos = ev.data as { fuente?: unknown; aviso?: unknown } | null;
    if (typeof datos !== 'object' || datos === null) return;
    if (datos.fuente !== CANAL_NOTION) return;
    if (!esAvisoNotion(datos.aviso)) return;
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

/** La emergente ya terminó: se despide y se cierra. Si el navegador se niega a
 *  cerrarla, quien llama monta la aplicación para que no quede una ventana con
 *  un texto muerto. */
export function despedirEmergente(conectado: boolean): void {
  const raiz = document.getElementById('root');
  if (raiz) {
    raiz.innerHTML =
      '<p style="font:15px/1.5 system-ui,sans-serif;margin:48px;color:#444">' +
      (conectado ? 'Listo. Ya puedes volver a la aplicación.' : 'Puedes volver a la aplicación.') +
      '</p>';
  }
  try {
    window.close();
  } catch {
    /* algunos navegadores no cierran ventanas que no abrieron ellos */
  }
}
