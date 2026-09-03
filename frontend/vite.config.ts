import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Identidad de este build. La usa el service worker para nombrar sus cachés:
// public/sw.js NO pasa por Vite (se copia literal), así que no puede leer
// import.meta.env; recibe el valor por la query de su propio registro.
const BUILD_ID = Date.now().toString(36);

// Proxy de /api hacia el backend FastAPI (puerto 8000) para evitar CORS en desarrollo.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
