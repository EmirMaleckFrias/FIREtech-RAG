import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import '@fontsource-variable/inter';
import App from './App';
import { convex } from './lib/convex';
import { anunciarAviso, avisoDeEmergente, despedirEmergente } from './lib/notionEmergente';
import { observarSistema } from './lib/theme';
import { iniciarPreferencias } from './lib/preferencias';
import './styles.css';
import './settings.css';

// El tema ya lo aplico el script inline de index.html (antes de pintar).
// Esto solo engancha los cambios de tema del SISTEMA, para que la opcion
// 'sistema' siga al SO en vivo sin recargar.
observarSistema();
iniciarPreferencias();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('No se encontró el elemento #root');
}

// Vuelta de Notion en la ventana emergente: se le pasa el aviso a la ventana
// principal, que sigue montada con la aplicación, y esta se cierra. NO se monta
// React aquí: montarlo enseñaría la aplicación entera dentro de una ventanita
// durante el instante que tarda en cerrarse.
//
// El orden lo garantiza `avisoParaCerrarEmergente`: primero se mira si la URL
// trae `?notion=`, porque consumir la marca es destructivo y una carga normal
// (una recarga de la ventana principal con la emergente abierta) no debe
// gastarla.
//
// Si el navegador se niega a cerrar la ventana, a los 400 ms se monta la
// aplicación igualmente: mejor la app en una ventana pequeña que un texto
// muerto. Y si no había marca (porque el navegador bloqueó las emergentes y se
// usó el redirigido de página completa), esto no se activa y la aplicación se
// monta como siempre, leyendo el aviso de la URL.
const avisoDeVuelta = avisoDeEmergente();

// ConvexAuthProvider sustituye a ConvexProvider: ademas de dar el cliente a
// useQuery/useMutation, guarda y renueva los tokens de Convex Auth y expone
// useConvexAuth (isLoading / isAuthenticated), que es lo que App consulta.
function montar() {
  createRoot(rootElement!).render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}

if (avisoDeVuelta !== null) {
  anunciarAviso(avisoDeVuelta);
  despedirEmergente(avisoDeVuelta.tipo === 'conectado');
  window.setTimeout(montar, 400);
} else {
  montar();
}

// Service worker (solo producción): network-first para navegaciones y
// cache-first para /assets/ hasheados. Solo cachea estáticos del propio
// origen: la conexión con Convex es un WebSocket a otro origen y no pasa por
// él, así que no hay nada de datos que pueda quedarse rancio en caché.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // La query no es decorativa: el SW toma de ahí el nombre de sus cachés,
    // y al cambiar el id purga las del build anterior en su `activate`.
    navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {
      // sin red o sin soporte: la app funciona igual, solo no es instalable
    });
  });
}
