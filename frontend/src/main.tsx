import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import '@fontsource-variable/inter';
import App from './App';
import { convex } from './lib/convex';
import { observarSistema } from './lib/theme';
import './styles.css';

// El tema ya lo aplico el script inline de index.html (antes de pintar).
// Esto solo engancha los cambios de tema del SISTEMA, para que la opcion
// 'sistema' siga al SO en vivo sin recargar.
observarSistema();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('No se encontró el elemento #root');
}

// ConvexAuthProvider sustituye a ConvexProvider: ademas de dar el cliente a
// useQuery/useMutation, guarda y renueva los tokens de Convex Auth y expone
// useConvexAuth (isLoading / isAuthenticated), que es lo que App consulta.
createRoot(rootElement).render(
  <StrictMode>
    <ConvexAuthProvider client={convex}>
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);

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
