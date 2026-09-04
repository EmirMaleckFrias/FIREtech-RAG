// Catálogo exacto del índice: qué documentos hay, con cuántos fragmentos, de
// qué tipo y en qué idioma. Reemplaza a `qdrant.index_inventory`.
//
// Existe por un fallo medido en el backend anterior: a "cuántos documentos
// tienes indexados" el agente respondía sin buscar y hablando de sí mismo,
// porque esa pregunta no se contesta buscando texto (una búsqueda devuelve los
// fragmentos parecidos a la consulta, nunca el catálogo completo). En Qdrant
// esto eran facets sobre el payload de la colección; aquí sale de la tabla
// `documents`, que es pequeña y ya guarda por documento el idioma, el formato
// y el número de fragmentos, así que no hay que recorrer `chunks`.
//
// Solo cuentan los documentos en estado "ready": uno en "processing" todavía
// no tiene fragmentos consultables y uno en "failed" no los tiene ni los va a
// tener. Contarlos diría "hay 12 documentos" sobre un índice que responde
// por 10.
import { internalQuery } from "../_generated/server";

export interface Conteo {
  valor: string;
  chunks: number;
}

/** Forma idéntica a la que devolvía `index_inventory` y consumía la
 *  herramienta del agente, incluida la clave en snake_case. */
export interface Inventario {
  archivos: Conteo[];
  total_chunks: number;
  tipos: Conteo[];
  idiomas: Conteo[];
}

/** Suma `chunks` por valor. Los valores vacíos no entran: en los facets de
 *  Qdrant eran "los huecos", no un valor real del campo, y un documento sin
 *  idioma detectado no es un documento en el idioma "". */
function agrupar(
  filas: Array<{ valor: string | undefined; chunks: number }>,
): Map<string, number> {
  const acumulado = new Map<string, number>();
  for (const f of filas) {
    const valor = (f.valor ?? "").trim();
    if (!valor || f.chunks <= 0) continue;
    acumulado.set(valor, (acumulado.get(valor) ?? 0) + f.chunks);
  }
  return acumulado;
}

/** Comparación de cadenas por punto de código, no por `localeCompare`: el
 *  orden no debe depender de la configuración regional del runtime. */
function porValor(a: Conteo, b: Conteo): number {
  return a.valor < b.valor ? -1 : a.valor > b.valor ? 1 : 0;
}

/** Como los facets: más fragmentos primero y, a igualdad, por valor. */
function porChunks(a: Conteo, b: Conteo): number {
  return b.chunks - a.chunks || porValor(a, b);
}

/** Catálogo exacto del índice: reemplaza a los facets de Qdrant.
 *  Forma idéntica a la que consumía la herramienta del agente. */
export const inventario = internalQuery({
  args: {},
  handler: async (ctx): Promise<Inventario> => {
    const listos = await ctx.db
      .query("documents")
      .withIndex("porEstado", (q) => q.eq("status", "ready"))
      .collect();

    // Por nombre de archivo, que es lo que identifica al documento en las
    // rutas de subida, reindexado y borrado. Si por lo que fuera hubiera dos
    // filas "ready" con el mismo nombre, se suman: es lo que daría un facet
    // sobre `sourceFile` en los fragmentos.
    const archivos = agrupar(listos.map((d) => ({ valor: d.fileName, chunks: d.chunks })));
    const tipos = agrupar(listos.map((d) => ({ valor: d.documentType, chunks: d.chunks })));
    const idiomas = agrupar(listos.map((d) => ({ valor: d.language, chunks: d.chunks })));

    const aLista = (m: Map<string, number>): Conteo[] =>
      Array.from(m, ([valor, chunks]) => ({ valor, chunks }));

    return {
      archivos: aLista(archivos).sort(porValor),
      total_chunks: listos.reduce((suma, d) => suma + Math.max(0, d.chunks), 0),
      tipos: aLista(tipos).sort(porChunks),
      idiomas: aLista(idiomas).sort(porChunks),
    };
  },
});
