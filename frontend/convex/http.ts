// Rutas HTTP del despliegue: las de autenticación, que Convex Auth necesita
// para el flujo de OAuth y la verificación por correo, y la vuelta del OAuth
// de Notion (convex/notion/oauth.ts).
//
// Nota para más adelante: la subida de documentos NO va por aquí, va por
// almacenamiento de ficheros con una URL de subida firmada, que admite ficheros
// mucho mayores que el tope de una petición HTTP.
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { callback as callbackNotion } from "./notion/oauth";

const http = httpRouter();
auth.addHttpRoutes(http);

// Es la redirect URI registrada en la integración pública de Notion:
// `${CONVEX_SITE_URL}/notion/callback`. Llega sin sesión; el `state`
// identifica a quien pulsó "Conectar".
http.route({ path: "/notion/callback", method: "GET", handler: callbackNotion });

export default http;
