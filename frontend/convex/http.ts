// Rutas HTTP del despliegue: las de autenticación, que Convex Auth necesita
// para el flujo de OAuth y la verificación por correo, y la vuelta del OAuth
// de Notion (convex/notion/oauth.ts) y de las nubes de ficheros
// (convex/nube/oauth.ts).
//
// Nota para más adelante: la subida de documentos NO va por aquí, va por
// almacenamiento de ficheros con una URL de subida firmada, que admite ficheros
// mucho mayores que el tope de una petición HTTP.
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { callback as callbackNotion } from "./notion/oauth";
import { callbackGoogle, callbackOnedrive } from "./nube/oauth";

const http = httpRouter();
auth.addHttpRoutes(http);

// Es la redirect URI registrada en la integración pública de Notion:
// `${CONVEX_SITE_URL}/notion/callback`. Llega sin sesión; el `state`
// identifica a quien pulsó "Conectar".
http.route({ path: "/notion/callback", method: "GET", handler: callbackNotion });

// Y las de Google Drive y OneDrive (convex/nube/oauth.ts), registradas en la
// aplicación de cada proveedor como `${CONVEX_SITE_URL}/google/callback` y
// `${CONVEX_SITE_URL}/onedrive/callback`.
http.route({ path: "/google/callback", method: "GET", handler: callbackGoogle });
http.route({ path: "/onedrive/callback", method: "GET", handler: callbackOnedrive });

export default http;
