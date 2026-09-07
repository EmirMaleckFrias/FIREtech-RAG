// Sincronización del corpus con una base de datos de Notion. Notion es la
// fuente de verdad: lo que está en la base entra al índice, lo que se archiva
// o se saca de la base sale del índice. No hay subidas manuales en este flujo.
//
// La corre el cron de convex/crons.ts cada hora y el administrador a demanda
// (`notion.admin.sincronizarAhora`). Cada corrida:
//
// 1. Se apaga sola si no hay credenciales (la función existe pero no hace
//    nada), si NOTION_SYNC_MINUTES es 0 y no la fuerza el administrador, o si
//    la última corrida empezó hace menos de ese intervalo. Las credenciales
//    salen PRIMERO de la conexión hecha en la app (`notionConexion`, OAuth) y,
//    de esa persona (ver notion/oauth.ts); nunca de una variable del
//    despliegue, que no tendría dueño.
// 2. Recorre la base entera y, por página, compara `last_edited_time` con lo
//    guardado en `notionPaginas`: sin cambio, no hay ninguna petición más.
// 3. Con cambio: renderiza la página a Markdown y la registra como un `.md`
//    si tiene texto suficiente; baja cada adjunto soportado, lo deduplica
//    por sha256 contra TODO el registro y lo registra por su nombre. El
//    registro va por `documentos.registrarDesdeOrigen`, que reutiliza la fila
//    de la versión anterior, y la ingesta existente hace el resto (parsear,
//    embeber, retirar los fragmentos viejos).
// 4. Las páginas que ya no están (archivadas, excluidas o borradas de la
//    base) pierden sus documentos si NOTION_DELETE_ARCHIVED está activo.
//
// El avance se escribe en la fila `running` de `notionSincronizaciones` ANTES
// de mirar cada página (cuántas van, cuál se está leyendo, contadores
// parciales): la UI está suscrita a esa fila y pinta "8 de 20 páginas, ahora:
// <título>" con una barra, en vez de un "Sincronizando…" mudo durante minutos.
//
// Cada página va en su propio try/catch: un PDF corrupto o una URL caducada
// se anota en `errores` y las demás páginas siguen. Y hay un reloj: la acción
// del runtime por defecto muere a los 30 minutos, así que a los 20 se para,
// se anota "parcial" y la siguiente corrida continúa donde tocaba (las
// páginas ya hechas tienen su `lastEdited` guardado y se saltan solas).
//
// Sin "use node": aquí solo hay `fetch`, Web Crypto y el almacenamiento; el
// parseo de PDF y DOCX lo hace la ingesta en su propia acción de Node.
import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes } from "../lib/config";
import { EXTENSIONES_PERMITIDAS, extensionDe, sanearNombre } from "../documentos";
import { sha256Hex } from "../ingesta/hash";
import {
  ClienteNotion,
  UrlCaducada,
  adjuntosDe,
  estaExcluida,
  normalizarId,
  tituloDe,
  type Adjunto,
  type PaginaNotion,
} from "./api";
import { renderizarPagina, textoUtil } from "./markdown";
import type { BaseElegida } from "./oauth";

/** Caracteres de texto útil a partir de los cuales una página merece su
 *  propio documento. Por debajo es una ficha (título y un par de líneas) que
 *  solo mete ruido en las búsquedas. */
export const MIN_TEXTO_UTIL = 200;

/** Tiempo tras el que la corrida se corta y se anota como parcial. La acción
 *  del runtime por defecto tiene 30 minutos; 20 deja margen para cerrar. */
export const LIMITE_CORRIDA_MS = 20 * 60_000;

/** Cada cuántas páginas SALTADAS se escribe el avance. Las que sí se procesan
 *  lo escriben siempre, porque son las que tardan. Existe porque escribir una
 *  fila por página no escalaba: en régimen normal casi todas las páginas están
 *  intactas, y una base de 10.000 páginas generaba 10.000 escrituras por
 *  corrida sin contar nada nuevo. 25 páginas se saltan en mucho menos de lo
 *  que el ojo distingue en una barra de progreso. */
export const PASO_AVANCE = 25;

/** Una corrida `running` más vieja que esto se da por muerta (la acción
 *  murió sin cerrarla) y no bloquea a la siguiente. */
const CORRIDA_MUERTA_MS = 31 * 60_000;

const PREFIJO_TEXTO = "notion-";

function mensajeDe(exc: unknown): string {
  if (exc instanceof ConvexError) {
    const d = exc.data as { mensaje?: string } | string;
    return typeof d === "string" ? d : (d?.mensaje ?? exc.message);
  }
  return exc instanceof Error ? exc.message : String(exc);
}

function codigoDe(exc: unknown): string | null {
  if (!(exc instanceof ConvexError)) return null;
  const d = exc.data as { codigo?: string } | string;
  return typeof d === "string" ? null : (d?.codigo ?? null);
}

/** Slug ASCII del título para el nombre del fichero de texto: sin acentos,
 *  minúsculas, guiones. Vacío si el título no tiene nada aprovechable. */
export function slugDe(titulo: string): string {
  return titulo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

interface Cifras {
  paginas: number;
  nuevos: number;
  actualizados: number;
  borrados: number;
  errores: string[];
}

interface ResultadoPagina {
  documentIds: Id<"documents">[];
  documentoTextoId?: Id<"documents">;
}

export const sincronizar = internalAction({
  // `propietario`: de quién es el Notion que se sincroniza y a qué corpus
  // entran los documentos. Nunca sale de una identidad del cliente (el cron no
  // tiene ninguna), sino de la fila de conexión de esa persona.
  //
  // `forzar`: la pide la propia usuaria desde el panel; salta el intervalo y
  // el apagado por NOTION_SYNC_MINUTES=0, pero no la falta de credenciales.
  args: { propietario: v.id("users"), forzar: v.optional(v.boolean()) },
  handler: async (ctx, { propietario, forzar }) => {
    const a = ajustes();
    const cred = await ctx.runQuery(internal.notion.oauth.credenciales, { propietario });
    if (!cred) {
      console.log("notion: esta cuenta no tiene conexión con Notion, sincronización apagada");
      return { estado: "apagado" as const };
    }
    if (!forzar && a.notionSyncMinutes <= 0) {
      console.log("notion: NOTION_SYNC_MINUTES=0, sincronización periódica apagada");
      return { estado: "apagado" as const };
    }

    const ultima = await ctx.runQuery(internal.notion.datos.ultimaCorrida, { propietario });
    const ahora = Date.now();
    if (ultima?.estado === "running") {
      if (ahora - ultima.empezadoEn < CORRIDA_MUERTA_MS) {
        console.log("notion: ya hay una sincronización en curso");
        return { estado: "en_curso" as const };
      }
      await ctx.runMutation(internal.notion.datos.cerrarCorrida, {
        runId: ultima._id,
        paginas: ultima.paginas,
        nuevos: ultima.nuevos,
        actualizados: ultima.actualizados,
        borrados: ultima.borrados,
        errores: [...ultima.errores, "la corrida murió sin cerrarse"],
        estado: "error",
      });
    } else if (!forzar && ultima) {
      // Se mide desde el INICIO de la última corrida y con un minuto de
      // margen: el cron corre cada 60 minutos exactos, y midiendo desde el
      // final una corrida de 5 minutos dejaría la siguiente a 55 minutos, por
      // debajo del intervalo, y se saltaría una de cada dos.
      const intervaloMs = a.notionSyncMinutes * 60_000 - 60_000;
      if (ahora - ultima.empezadoEn < intervaloMs) {
        console.log("notion: la última sincronización es reciente, se salta");
        return { estado: "reciente" as const };
      }
    }

    const runId = await ctx.runMutation(internal.notion.datos.abrirCorrida, { propietario });
    const cifras: Cifras = { paginas: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [] };
    let parcial = false;
    const t0 = Date.now();

    try {
      const cliente = new ClienteNotion(cred.token);
      // Documentos de Notion que existen hoy: una página cuyo documento borró
      // su dueña a mano se vuelve a traer aunque Notion no cambiara, porque
      // Notion manda sobre lo que hay en el índice.
      const vivos = new Set<string>(
        await ctx.runQuery(internal.notion.datos.idsDocumentosNotion, { propietario }),
      );

      // 1. Listar TODAS las bases antes de tocar ninguna página. Cuesta una
      //    petición por cada 100 páginas, y a cambio el total que ve la
      //    usuaria en la barra es el de verdad desde el primer segundo, en vez
      //    de ir creciendo a saltos según se descubre cada base.
      const porBase: Array<{ base: BaseElegida; activas: PaginaNotion[] }> = [];
      for (const base of cred.bases) {
        const paginas = await cliente.paginasDeBase(base.id);
        // Las archivadas y las excluidas no cuentan: se tratan abajo, con las
        // que ya no están. Filtrar antes permite anunciar el total real.
        porBase.push({
          base,
          activas: paginas.filter((p) => !(Boolean(p.archived || p.in_trash) || estaExcluida(p))),
        });
      }
      const total = porBase.reduce((n, b) => n + b.activas.length, 0);
      await ctx.runMutation(internal.notion.datos.avanzarCorrida, {
        runId,
        paginasTotal: total,
        paginasProcesadas: 0,
      });

      // Progreso por LOTES. Antes se escribía una fila por página, incluso por
      // las que no cambiaban: con 10.000 páginas eran 10.000 escrituras por
      // corrida sin contar nada nuevo. Ahora se escribe cuando de verdad hay
      // algo que enseñar (una página que se va a procesar, que es la que
      // tarda) o cada `PASO_AVANCE` páginas saltadas.
      let procesadas = 0;
      let ultimoAvance = -1;
      const avanzar = async (etiqueta: string | undefined, forzar: boolean) => {
        if (!forzar && procesadas - ultimoAvance < PASO_AVANCE) return;
        ultimoAvance = procesadas;
        await ctx.runMutation(internal.notion.datos.avanzarCorrida, {
          runId,
          paginasProcesadas: procesadas,
          ...(etiqueta === undefined ? {} : { paginaActual: etiqueta }),
          ...cifras,
        });
      };

      // 2. Base por base. El recorrido y el cálculo de lo que ha desaparecido
      //    son POR BASE a propósito: si se juntaran, acabar con `Docs` dejaría
      //    las páginas de `Tasks` como no vistas y se borraría su corpus.
      for (const { base, activas } of porBase) {
        const conocidas = new Map(
          (
            await ctx.runQuery(internal.notion.datos.paginasDeBase, {
              propietario,
              databaseId: base.id,
            })
          ).map((pg) => [pg.pageId, pg]),
        );
        const vistas = new Set<string>();
        let completa = true;

        for (const pagina of activas) {
          const pageId = normalizarId(pagina.id);
          vistas.add(pageId);
          cifras.paginas += 1;

          if (Date.now() - t0 > LIMITE_CORRIDA_MS) {
            parcial = true;
            completa = false;
            break;
          }

          const titulo = tituloDe(pagina) || `pagina-${pageId.slice(0, 8)}`;
          const previa = conocidas.get(pageId) ?? null;
          const intacta =
            previa !== null &&
            previa.lastEdited === pagina.last_edited_time &&
            !previa.error &&
            previa.documentIds.every((id) => vivos.has(id));
          if (intacta) {
            procesadas += 1;
            await avanzar(undefined, false);
            continue;
          }

          // Avance ANTES de tocar la página, y este sí forzado: es la que
          // puede tardar (adjuntos grandes) y la UI tiene que decir cuál es.
          // Con varias bases se dice también de cuál, porque si no la usuaria
          // ve un título suelto sin saber de dónde sale.
          //
          // `paginasProcesadas` cuenta las TERMINADAS, no incluida esta: el
          // texto que lee la usuaria es "7 de 20 páginas, ahora: Protocolo
          // dos", y contarse a sí misma haría que la barra adelantara al
          // trabajo real.
          await avanzar(cred.bases.length > 1 ? `${base.titulo} · ${titulo}` : titulo, true);

          try {
            const r = await procesarPagina(ctx, propietario, cliente, pagina, pageId, titulo, previa, cifras);
            await ctx.runMutation(internal.notion.datos.guardarPagina, {
              propietario,
              databaseId: base.id,
              pageId,
              titulo,
              lastEdited: pagina.last_edited_time,
              documentIds: r.documentIds,
              documentoTextoId: r.documentoTextoId,
            });
          } catch (exc) {
            const msg = mensajeDe(exc);
            cifras.errores.push(`${titulo}: ${msg}`);
            await ctx.runMutation(internal.notion.datos.guardarPagina, {
              propietario,
              databaseId: base.id,
              pageId,
              titulo,
              lastEdited: pagina.last_edited_time,
              documentIds: previa?.documentIds ?? [],
              documentoTextoId: previa?.documentoTextoId,
              error: msg.slice(0, 500),
            });
          }
          procesadas += 1;
        }

        // Páginas que ya no están EN ESTA BASE: archivadas, excluidas o
        // borradas. Solo si se recorrió entera: si el reloj la cortó a medias
        // no se sabe qué no se llegó a ver, y borrar por no haber mirado sería
        // destruir corpus.
        if (completa) {
          for (const fila of conocidas.values()) {
            if (vistas.has(fila.pageId)) continue;
            try {
              if (a.notionBorrarArchivados) {
                for (const id of fila.documentIds) {
                  const borrado = await ctx.runMutation(internal.notion.datos.borrarDocumento, {
                    propietario,
                    documentId: id,
                    pageId: fila.pageId,
                  });
                  if (borrado) cifras.borrados += 1;
                }
                await ctx.runMutation(internal.notion.datos.borrarPagina, {
                  propietario,
                  pageId: fila.pageId,
                });
              } else if (fila.error !== "archivada") {
                await ctx.runMutation(internal.notion.datos.marcarPagina, {
                  propietario,
                  pageId: fila.pageId,
                  error: "archivada",
                });
              }
            } catch (exc) {
              cifras.errores.push(`${fila.titulo}: al retirar, ${mensajeDe(exc)}`);
            }
          }
        }
        if (parcial) break;
      }
      // Con errores de página la corrida es "error", parcial o no: antes el
      // aviso de "parcial" se añadía a la misma lista y la condición de abajo
      // guardaba "ok" para toda corrida parcial, aunque hubieran fallado
      // veinte páginas.
      const huboFallos = cifras.errores.length > 0;
      if (parcial) cifras.errores.push("sincronización parcial, continuará en unos minutos");
      // Y el último avance, para que la barra llegue al final antes de cerrar.
      await avanzar(undefined, true);

      await ctx.runMutation(internal.notion.datos.cerrarCorrida, {
        runId,
        ...cifras,
        estado: huboFallos ? "error" : "ok",
      });
      // Cortada por el reloj y con trabajo hecho: se reanuda en un minuto en
      // vez de esperar al cron (hasta 40 minutos con una base grande). Solo si
      // avanzó, para que una base que no progresa no se reagende en bucle.
      if (parcial && procesadas > 0) {
        await ctx.scheduler.runAfter(60_000, internal.notion.sync.sincronizar, { propietario, forzar: true });
      }
      console.log(
        `notion: ${cifras.paginas} páginas, ${cifras.nuevos} nuevos, ${cifras.actualizados} ` +
          `actualizados, ${cifras.borrados} borrados, ${cifras.errores.length} errores, ` +
          `${Date.now() - t0} ms${parcial ? " (parcial)" : ""}`,
      );
      return { estado: parcial ? ("parcial" as const) : ("ok" as const), ...cifras };
    } catch (exc) {
      // Fallo global (la base no responde, el token no vale): la corrida se
      // cierra como error con el motivo, y las páginas ya procesadas quedan.
      const msg = mensajeDe(exc);
      console.error(`notion: la sincronización falló: ${msg}`);
      await ctx.runMutation(internal.notion.datos.cerrarCorrida, {
        runId,
        ...cifras,
        errores: [...cifras.errores, msg.slice(0, 500)],
        estado: "error",
      });
      return { estado: "error" as const, ...cifras, errores: [...cifras.errores, msg] };
    }
  },
});

// ---------------------------------------------------------------------------
// Una página
// ---------------------------------------------------------------------------
async function procesarPagina(
  ctx: ActionCtx,
  propietario: Id<"users">,
  cliente: ClienteNotion,
  pagina: PaginaNotion,
  pageId: string,
  titulo: string,
  previa: Doc<"notionPaginas"> | null,
  cifras: Cifras,
): Promise<ResultadoPagina> {
  const bloques = await cliente.bloquesDePagina(pagina.id);
  const slug = slugDe(titulo) || pageId.slice(0, 8);
  // Solo los que siguen siendo de esta página: uno reclamado por una subida
  // manual (misma fila, otro origen) ya no es nuestro ni para reutilizar ni
  // para borrar.
  const previos = (
    previa
      ? await ctx.runQuery(internal.notion.datos.documentosDe, {
          propietario,
          ids: previa.documentIds,
        })
      : []
  ).filter((d) => d.origen === "notion" && d.notionPageId === pageId);
  const previosPorId = new Map(previos.map((d) => [d._id, d]));
  const documentIds: Id<"documents">[] = [];
  const nombresUsados = new Set<string>();
  let documentoTextoId: Id<"documents"> | undefined;

  // (a) El texto de la página.
  const markdown = renderizarPagina(titulo, bloques);
  if (textoUtil(markdown) > MIN_TEXTO_UTIL) {
    const bytes = new TextEncoder().encode(markdown);
    const sha = await sha256Hex(bytes);
    const textoPrevio = previa?.documentoTextoId ? previosPorId.get(previa.documentoTextoId) : undefined;
    if (textoPrevio && textoPrevio.sha256 === sha && textoPrevio.status !== "failed") {
      // Cambió la página (una propiedad, un adjunto) pero no su texto: no se
      // vuelve a embeber lo mismo.
      documentoTextoId = textoPrevio._id;
    } else {
      // Se conserva el nombre del documento anterior aunque cambie el título:
      // el nombre es el `sourceFile` de las citas de respuestas ya dadas.
      const candidatos = textoPrevio
        ? [textoPrevio.fileName]
        : [`${PREFIJO_TEXTO}${slug}.md`, `${PREFIJO_TEXTO}${slug}-${pageId.slice(0, 8)}.md`];
      documentoTextoId = await registrar(ctx, propietario, bytes, "text/markdown", sha, candidatos, pageId, nombresUsados);
      if (textoPrevio) cifras.actualizados += 1;
      else cifras.nuevos += 1;
    }
    documentIds.push(documentoTextoId);
  }

  // (b) Los adjuntos.
  const adjuntos = adjuntosDe(pagina, bloques);
  for (const adj of adjuntos) {
    const ext = extensionDe(adj.nombre);
    if (!(EXTENSIONES_PERMITIDAS as readonly string[]).includes(ext)) {
      // Se DICE en los avisos de la corrida (es lo único que ve la usuaria),
      // sin marcar la página con error: `intacta` exige que no lo tenga, y
      // marcarla la haría re-descargarse entera cada hora. Antes era un
      // `console.log` y el .pptx que ella adjuntó quedaba fuera del corpus
      // para siempre sin ninguna señal.
      cifras.errores.push(
        `${titulo}: el adjunto '${adj.nombre}' es .${ext || "?"}, un formato que no se puede indexar; conviértelo a PDF`,
      );
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await descargarConRefresco(cliente, pagina, adj);
    } catch (exc) {
      // Con el nombre del adjunto: "Protocolos: el adjunto 'x.pdf' pesa 30 MB…"
      // le dice a la usuaria qué fichero es, no solo en qué página está.
      throw new Error(`el adjunto '${adj.nombre}': ${mensajeDe(exc)}`);
    }
    if (bytes.length === 0) {
      cifras.errores.push(`${titulo}: el adjunto '${adj.nombre}' está vacío`);
      continue;
    }
    const sha = await sha256Hex(bytes);
    const existente = await ctx.runQuery(internal.notion.datos.documentoPorSha256, {
      propietario,
      sha256: sha,
    });
    if (existente && existente.status !== "failed") {
      // Dedupe global: el mismo fichero, venga de otra página o de una
      // subida manual, no se indexa dos veces. Solo se reclama como propio
      // si ya era de esta página.
      if (existente.notionPageId === pageId && !documentIds.includes(existente._id)) {
        documentIds.push(existente._id);
        nombresUsados.add(existente.fileName);
      } else if (existente.notionPageId !== pageId) {
        console.log(`notion: adjunto '${adj.nombre}' de '${titulo}' ya indexado como '${existente.fileName}'`);
      }
      continue;
    }
    const base = adj.nombre.slice(0, adj.nombre.length - ext.length - 1);
    const candidatos = [adj.nombre, `${base}-${slug}.${ext}`, `${base}-${slug}-${pageId.slice(0, 8)}.${ext}`];
    const id = await registrar(ctx, propietario, bytes, "application/octet-stream", sha, candidatos, pageId, nombresUsados);
    if (!documentIds.includes(id)) documentIds.push(id);
    if (previosPorId.has(id)) cifras.actualizados += 1;
    else cifras.nuevos += 1;
  }

  // (c) Lo que la página tenía y ya no: un adjunto quitado, o un texto que
  // bajó del mínimo. Notion manda, así que se retira.
  for (const d of previos) {
    if (documentIds.includes(d._id)) continue;
    const borrado = await ctx.runMutation(internal.notion.datos.borrarDocumento, {
      propietario,
      documentId: d._id,
      pageId,
    });
    if (borrado) cifras.borrados += 1;
  }

  return { documentIds, documentoTextoId };
}

/** Guarda los bytes y registra el documento probando nombres en orden: el
 *  primero libre (o reutilizable por ser de esta misma página) gana. Si todos
 *  chocan, se borra el fichero guardado y se lanza: la mutación no puede
 *  borrar y fallar a la vez, así que la limpieza va aquí. */
async function registrar(
  ctx: ActionCtx,
  propietario: Id<"users">,
  bytes: Uint8Array,
  tipo: string,
  sha256: string,
  candidatos: string[],
  pageId: string,
  nombresUsados: Set<string>,
): Promise<Id<"documents">> {
  const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: tipo }));
  let ultimo: unknown = null;
  for (const crudo of candidatos) {
    const nombre = sanearNombre(crudo);
    // Dos adjuntos con el mismo nombre en la misma página: el segundo no
    // puede reutilizar la fila del primero, que acaba de registrarse.
    if (!nombre || nombresUsados.has(nombre)) continue;
    try {
      const id = await ctx.runMutation(internal.documentos.registrarDesdeOrigen, {
        propietario,
        storageId,
        fileName: nombre,
        sha256,
        origen: "notion",
        notionPageId: pageId,
      });
      nombresUsados.add(nombre);
      return id;
    } catch (exc) {
      ultimo = exc;
      if (codigoDe(exc) !== "conflicto") break;
    }
  }
  await ctx.storage.delete(storageId);
  throw ultimo ?? new Error(`no quedó ningún nombre libre para ${candidatos[0]}`);
}

/** Descarga un adjunto y, si la URL firmada caducó, relee la página para
 *  obtener una fresca y lo intenta una vez más. */
async function descargarConRefresco(
  cliente: ClienteNotion,
  pagina: PaginaNotion,
  adj: Adjunto,
): Promise<Uint8Array> {
  try {
    return await cliente.descargar(adj.url);
  } catch (exc) {
    if (!(exc instanceof UrlCaducada)) throw exc;
    const fresca = await cliente.pagina(pagina.id);
    const bloques = await cliente.bloquesDePagina(pagina.id);
    const nuevo = adjuntosDe(fresca, bloques).find((x) => x.nombre === adj.nombre);
    if (!nuevo) throw new Error(`el adjunto '${adj.nombre}' ya no está en la página`);
    return await cliente.descargar(nuevo.url);
  }
}
