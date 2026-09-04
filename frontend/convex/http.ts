// Rutas HTTP del despliegue. Por ahora solo las de autenticación, que Convex
// Auth necesita para el flujo de OAuth y la verificación por correo.
//
// Nota para más adelante: la subida de documentos NO va por aquí, va por
// almacenamiento de ficheros con una URL de subida firmada, que admite ficheros
// mucho mayores que el tope de una petición HTTP.
import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

export default http;
