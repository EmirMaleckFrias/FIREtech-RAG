/// <reference types="vite/client" />
// Los tipos de node entran aquí a propósito. Al importar `api` desde
// convex/_generated, tsc typechequea transitivamente convex/*.ts (el fichero
// generado enlaza cada módulo por tipo), y convex/auth.ts y convex/lib/config.ts
// leen `process.env`, que sin esto no existe con `types: ["vite/client"]`.
// convex/tsconfig.json ya declara `types: ["node"]`; esto lo iguala. El código
// del frontend sigue usando `window.setTimeout` y compañía para no depender de
// qué sobrecarga de los timers gana.
/// <reference types="node" />

interface ImportMetaEnv {
  /** URL pública del despliegue de Convex (https://<nombre>.convex.cloud). */
  readonly VITE_CONVEX_URL?: string;
}
