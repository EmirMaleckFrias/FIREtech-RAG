import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('No se encontró el elemento #root');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker (solo producción): network-first para navegaciones, /api
// jamás se intercepta (SSE incluido), cache-first para /assets/ hasheados.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // sin red o sin soporte: la app funciona igual, solo no es instalable
    });
  });
}
