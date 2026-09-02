// Cliente de Supabase Auth (SPEC.md, "Autenticación multiusuario").
//
// El frontend usa Supabase SOLO para autenticar: nunca lee ni escribe tablas
// de negocio (eso pasa siempre por el backend, que es quien tiene la service
// key). De aquí sale el access_token que viaja como Authorization: Bearer en
// todas las llamadas a /api/*.
//
// La anon/publishable key es pública por diseño; la seguridad la dan la
// validación del token en el backend y las policies RLS.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Mensaje de configuración ausente, o null si todo está en su sitio.
 * La app no revienta al arrancar: se muestra en la pantalla de acceso, que es
 * donde el problema es accionable (falta el .env del frontend).
 */
export const supabaseConfigError: string | null =
  url && anonKey
    ? null
    : 'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. Copia frontend/.env.example a frontend/.env y reinicia el servidor de desarrollo.';

// Valores de reserva solo para que createClient no lance con el .env ausente:
// cualquier petición con ellos falla, pero la UI llega a pintar el aviso.
const FALLBACK_URL = 'https://sin-configurar.supabase.co';
const FALLBACK_KEY = 'sin-configurar';

export const supabase = createClient(url ?? FALLBACK_URL, anonKey ?? FALLBACK_KEY, {
  auth: {
    persistSession: true,
    // Renueva el access_token solo antes de que caduque (~1 h de vida).
    autoRefreshToken: true,
    // El enlace de confirmación de correo vuelve con el token en la URL.
    detectSessionInUrl: true,
    storageKey: 'rag-docs-auth',
  },
});
