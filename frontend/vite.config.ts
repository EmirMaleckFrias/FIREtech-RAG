import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Identidad de este build. La usa el service worker para nombrar sus cachés:
// public/sw.js NO pasa por Vite (se copia literal), así que no puede leer
// import.meta.env; recibe el valor por la query de su propio registro.
const BUILD_ID = Date.now().toString(36);

// Sin proxy: ya no hay backend HTTP propio. El frontend habla con Convex por
// WebSocket directamente contra VITE_CONVEX_URL, y las subidas de ficheros van
// a la URL firmada que devuelve documentos.urlDeSubida.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react()],
  server: {
    port: 5173,
  },
});
