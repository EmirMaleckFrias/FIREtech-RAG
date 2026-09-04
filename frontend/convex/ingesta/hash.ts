// sha256 del fichero, que es la `documentVersion` de sus fragmentos.
//
// Web Crypto y no `node:crypto`: está en el runtime de Node 20+ y en el de
// Convex por defecto, así que el mismo código vale en la acción "use node" y
// en los tests que corren en edge-runtime.

/** Hex en minúsculas del SHA-256 de `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
