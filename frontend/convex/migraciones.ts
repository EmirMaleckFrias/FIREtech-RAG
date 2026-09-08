// Migraciones del índice: llevar los documentos ya indexados a la receta
// actual sin que nadie vuelva a subir nada.
//
// Por qué existe. La receta con la que se escriben los fragmentos cambia
// (septiembre de 2026: la frase de contexto por fragmento, que entra en el
// embedding y tiene su propio índice léxico), y los documentos indexados con
// la receta anterior se buscan peor que los nuevos. La única forma de que
// ganen lo mismo es reindexarlos, y reindexar a mano sesenta documentos, uno
// por uno, no es trabajo para nadie. Esto los recorre y agenda la ingesta de
// los que no están en `VERSION_INDICE`, de pocos en pocos, hasta que no quede
// ninguno. Cada documento enseña su barra de avance en la biblioteca mientras
// se reindexa, como cualquier ingesta.
//
// Es una cadena de mutaciones, no una acción larga: cada paso mira una página
// de la tabla, agenda como mucho `EN_PARALELO` ingestas y se vuelve a agendar
// unos segundos después. Así ni se recorre la tabla entera en una
// transacción, ni se lanzan sesenta ingestas a la vez contra el gateway (cada
// ingesta con contexto son cientos de llamadas), ni la migración muere si un
// documento tarda diez minutos.
//
// Se lanza a mano tras el despliegue: `npx convex run migraciones:reindexarTodo`.
// `estadoDelIndice` dice cuántos documentos quedan por reindexar.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { versionIndiceActual } from "./ingesta/contexto";
import { LATIDO_VIVO_MS } from "./ingesta/escritura";
import { ajustes } from "./lib/config";

/** Ingestas de la migración en vuelo a la vez. Dos: bastante para no tardar
 *  horas y poco para que el gateway (que además atiende preguntas) no
 *  devuelva 429 en cadena. */
export const EN_PARALELO = 2;
/** Documentos que se miran por paso. */
const PAGINA = 100;
/** Cuánto espera un paso que no pudo agendar nada nuevo. */
const ESPERA_MS = 20_000;

/** Si el documento está indexado con la receta actual (la que corresponde al
 *  ajuste del contexto: con él apagado, la receta "sin contexto" es la actual
 *  y no hay nada que reindexar). */
export function alDia(d: Doc<"documents">, version = versionIndiceActual(ajustes().contextoHabilitado)): boolean {
  return d.indiceVersion === version;
}

/** Si una ingesta de este documento puede estar viva: su corrida está
 *  `running` con latido reciente, o todavía no hay corrida que lo haya
 *  reclamado (la acción agendada aún no arrancó) y el registro es reciente.
 *  Es la misma regla que `documentos.ingestaViva`: sin ella, un documento que
 *  la propia migración acababa de agendar no contaba como en vuelo hasta que
 *  su acción reclamaba el documento, y un segundo paso agendaba otros dos. */
async function ingestaPuedeEstarViva(
  ctx: { db: { get: (id: Id<"ingestionRuns">) => Promise<Doc<"ingestionRuns"> | null> } },
  d: Doc<"documents">,
  ahora: number,
): Promise<boolean> {
  if (d.status !== "processing") return false;
  const run = d.ingestaRunId ? await ctx.db.get(d.ingestaRunId) : null;
  if (run && run.status === "running") return ahora - (run.latidoEn ?? run.empezadoEn) < LATIDO_VIVO_MS;
  // Sin corrida viva: la reclamará la acción al arrancar. Mientras el
  // registro sea reciente, se le da por en vuelo.
  return ahora - d.ingestadoEn < LATIDO_VIVO_MS;
}

/** Guarda contra una segunda cadena: el instante del último paso, en una fila
 *  de `contadores` (la tabla de claves sueltas que ya existe). Una invocación
 *  a mano mientras hay una cadena viva no agenda nada. */
export const CLAVE_ULTIMO_PASO = "migracion:indice:ultimoPaso";
/** Un paso más reciente que esto significa que hay una cadena viva. */
const CADENA_VIVA_MS = 90_000;

/** Si al documento le toca reindexarse: está listo, con otra receta, y tiene
 *  su fichero (sin fichero no hay qué leer: son filas heredadas de Supabase,
 *  que solo se arreglan volviendo a subir). Un documento fallido no entra:
 *  reintentarlo es decisión de la usuaria, no de la migración. */
export function pendiente(d: Doc<"documents">, version = versionIndiceActual(ajustes().contextoHabilitado)): boolean {
  return d.status === "ready" && !alDia(d, version) && d.storageId !== undefined;
}

/** Cuántos documentos quedan por reindexar y cuántos están en ello. */
export const estadoDelIndice = internalQuery({
  args: {},
  handler: async (ctx) => {
    let pendientes = 0;
    let alDiaN = 0;
    let procesando = 0;
    let sinFichero = 0;
    let total = 0;
    // La tabla de documentos es pequeña (decenas o cientos): un recorrido por
    // páginas cabe de sobra en una query.
    const version = versionIndiceActual(ajustes().contextoHabilitado);
    let cursor: string | null = null;
    for (;;) {
      const pagina = await ctx.db.query("documents").paginate({ cursor, numItems: PAGINA });
      for (const d of pagina.page) {
        total += 1;
        if (d.status === "processing") procesando += 1;
        else if (alDia(d, version)) alDiaN += 1;
        else if (pendiente(d, version)) pendientes += 1;
        else if (d.status === "ready") sinFichero += 1;
      }
      if (pagina.isDone) break;
      cursor = pagina.continueCursor;
    }
    return { version, total, alDia: alDiaN, pendientes, procesando, sinFichero };
  },
});

/**
 * Un paso de la migración: agenda hasta `EN_PARALELO` ingestas entre los
 * documentos pendientes de la página y se vuelve a agendar.
 *
 * `cursor` es la posición en la tabla; se avanza cuando la página no tiene
 * nada pendiente. Los documentos que se acaban de agendar pasan a
 * `processing`, así que el siguiente paso sobre la misma página no los
 * vuelve a coger, y los que terminan quedan `alDia`. Los `processing` de la
 * página cuentan como en vuelo, salvo los de una corrida muerta (sin latido),
 * que no bloquean a nadie.
 */
export const reindexarTodo = internalMutation({
  // `continuacion` lo ponen solo los pasos que la propia cadena agenda: una
  // invocación a mano (sin él) con una cadena viva no agenda nada.
  args: { cursor: v.optional(v.string()), continuacion: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ agendados: number; hecho: boolean; yaEnMarcha?: boolean }> => {
    const ahora = Date.now();
    const estado = await ctx.db
      .query("contadores")
      .withIndex("porClave", (q) => q.eq("clave", CLAVE_ULTIMO_PASO))
      .first();
    if (!args.continuacion && estado && ahora - estado.valor < CADENA_VIVA_MS) {
      console.info("Migración del índice: ya hay una cadena en marcha; no se agenda otra.");
      return { agendados: 0, hecho: false, yaEnMarcha: true };
    }
    if (estado) await ctx.db.patch(estado._id, { valor: ahora });
    else await ctx.db.insert("contadores", { clave: CLAVE_ULTIMO_PASO, valor: ahora });

    const pagina = await ctx.db.query("documents").paginate({ cursor: args.cursor ?? null, numItems: PAGINA });
    let enVuelo = 0;
    for (const d of pagina.page) {
      if (await ingestaPuedeEstarViva(ctx, d, ahora)) enVuelo += 1;
    }
    const version = versionIndiceActual(ajustes().contextoHabilitado);
    const candidatos = pagina.page.filter((d) => d.status === "ready" && !alDia(d, version) && d.storageId !== undefined);
    let agendados = 0;
    for (const d of candidatos) {
      if (enVuelo + agendados >= EN_PARALELO) break;
      // Igual que `documentos.reindexar`: a `processing` antes de agendar, con
      // `ingestadoEn` renovado para que la guarda de rancio no lo dé por
      // abandonado al instante.
      await ctx.db.patch(d._id, { status: "processing", error: undefined, progreso: undefined, ingestadoEn: ahora });
      await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.ingestar, { documentId: d._id });
      agendados += 1;
    }
    const quedanEnPagina = candidatos.length > agendados;
    if (quedanEnPagina || enVuelo + agendados > 0) {
      // Misma página dentro de un rato: o hay pendientes que no cupieron, o
      // hay ingestas en vuelo que al terminar dejarán la página al día.
      await ctx.scheduler.runAfter(ESPERA_MS, internal.migraciones.reindexarTodo, { cursor: args.cursor, continuacion: true });
      return { agendados, hecho: false };
    }
    if (!pagina.isDone) {
      await ctx.scheduler.runAfter(0, internal.migraciones.reindexarTodo, { cursor: pagina.continueCursor, continuacion: true });
      return { agendados, hecho: false };
    }
    console.info(`Migración del índice a ${version}: no queda ningún documento pendiente.`);
    return { agendados, hecho: true };
  },
});
