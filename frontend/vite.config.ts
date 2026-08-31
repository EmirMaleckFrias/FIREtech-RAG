import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy de /api hacia el backend FastAPI (puerto 8000) para evitar CORS en desarrollo.
export default defineConfig({
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
