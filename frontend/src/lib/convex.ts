// Cliente de Convex. Un solo objeto para toda la app: lo consume
// ConvexAuthProvider en main.tsx y de él salen las suscripciones (useQuery) y
// las mutaciones (useMutation) de todos los componentes.
//
// La URL del despliegue es pública por diseño (viaja en el bundle): quien
// protege los datos es el servidor, que comprueba quién pregunta en cada
// función (convex/permisos.ts). Aquí no hay ninguna clave.

import { ConvexReactClient } from 'convex/react';

const url = import.meta.env.VITE_CONVEX_URL;

/**
 * Mensaje de configuración ausente, o null si todo está en su sitio.
 * La app no revienta al arrancar: se muestra en la pantalla de acceso, que es
 * donde el problema es accionable (falta el .env del frontend).
 */
export const convexConfigError: string | null = url
  ? null
  : 'Falta VITE_CONVEX_URL. Copia frontend/.env.example a frontend/.env y reinicia el servidor de desarrollo.';

// Valor de reserva solo para que el constructor no lance con el .env ausente:
// no hay nada escuchando en ese host, pero la UI llega a pintar el aviso.
const FALLBACK_URL = 'https://sin-configurar.convex.cloud';

export const convex = new ConvexReactClient(url || FALLBACK_URL);
