// Configuración del emisor de tokens para Convex Auth. Las claves (JWT_PRIVATE_KEY
// y JWKS) las genera `npx @convex-dev/auth` y viven en las variables del
// despliegue, nunca en el repositorio, que además es público.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
