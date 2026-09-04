// Pruebas de las funciones de Convex con `convex-test`, que ejecuta el esquema
// y las funciones en memoria: sin despliegue, sin red y sin gastar en modelos.
//
// El entorno es `edge-runtime` a propósito: es el que se parece al runtime por
// defecto de Convex (fetch sí, APIs de Node no), así que una función que use
// algo de Node falla aquí igual que fallaría en el despliegue, en vez de pasar
// en local y romperse arriba.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
  },
});
