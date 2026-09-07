// Sincronización del corpus con las carpetas elegidas de una nube (Google
// Drive u OneDrive). La nube es la fuente de verdad para lo que entra por
// aquí: lo que está en la carpeta entra al índice, lo que sale de ella sale
// del índice. Es el gemelo de notion/sync.ts para ficheros en vez de páginas.
//
// La corre el cron de convex/crons.ts cada hora (una corrida por conexión) y
// la propia usuaria a demanda (`nube.admin.sincronizarAhora`). Cada corrida:
//
// 1. Se apaga sola si no hay conexión con carpetas, si la conexión necesita
//    reconexión, si DRIVE_SYNC_MINUTES es 0 y no la fuerza la usuaria, o si
//    la última corrida empezó hace menos de ese intervalo.
// 2. Renueva el token si le queda poco (una corrida dura hasta 20 minutos) y
//    lista TODAS las carpetas antes de tocar nada, para anunciar el total.
// 3. Por fichero, compara `version` (md5 o fecha en Drive, cTag en OneDrive)
//    con lo guardado en `nubeFicheros`: sin cambio, ni una petición más. Con
//    cambio: lo descarga (o exporta), lo deduplica por sha256 contra TODO el
//    corpus y lo registra por su nombre con `documentos.registrarDesdeOrigen`,
//    que reutiliza la fila de la versión anterior; la ingesta hace el resto.
// 4. Los ficheros que ya no están en una carpeta recorrida ENTERA pierden su
//    documento si DRIVE_DELETE_REMOVED está activo. Un fichero que se movió a
//    OTRA carpeta elegida no se toca: se sabe porque todas se listaron antes.
//
// El avance se escribe en la fila `running` ANTES de tocar cada fichero, y la
// UI suscrita pinta "8 de 20 archivos, ahora: guia.pdf". Cada fichero va en
// su propio try/catch, y hay un reloj: a los 20 minutos se para, se anota
// "parcial" y se reanuda en un minuto.
import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes } from "../lib/config";
import { proveedorNube } from "../schema";
import { EXTENSIONES_PERMITIDAS, extensionDe, sanearNombre } from "../documentos";
import { sha256Hex } from "../ingesta/hash";
import { clienteDe, MARGEN_CORRIDA_MS, tokensRenovables, tokenVigente } from "./oauth";
import {
  ErrorReconexion,
  MAX_FICHERO_BYTES,
  NOMBRE,
  demasiadoGrande,
  type ClienteNube,
  type FicheroNube,
  type Proveedor,
} from "./proveedores";

/** Tiempo tras el que la corrida se corta y se anota como parcial. */
export const LIMITE_CORRIDA_MS = 20 * 60_000;

/** Cada cuántos ficheros SALTADOS se escribe el avance. */
export const PASO_AVANCE = 25;

/** Una corrida `running` más vieja que esto se da por muerta. */
const CORRIDA_MUERTA_MS = 31 * 60_000;

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

/** Sufijo corto y estable a partir del id del fichero, para desempatar
 *  nombres repetidos ("guia.pdf" en dos carpetas). */
export function sufijoDe(id: string): string {
  const limpio = id.replace(/[^A-Za-z0-9]/g, "");
  return limpio.slice(-8) || "x";
}

interface Cifras {
  ficheros: number;
  nuevos: number;
  actualizados: number;
  borrados: number;
  errores: string[];
}

export const sincronizar = internalAction({
  args: { propietario: v.id("users"), proveedor: proveedorNube, forzar: v.optional(v.boolean()) },
  handler: async (ctx, { propietario, proveedor, forzar }) => {
    const a = ajustes();
    const nombreNube = NOMBRE[proveedor];
    const conexion = await ctx.runQuery(internal.nube.datos.conexion, { propietario, proveedor });
    if (!conexion || conexion.carpetas.length === 0) {
      console.log(`${proveedor}: esta cuenta no tiene conexión con carpetas, sincronización apagada`);
      return { estado: "apagado" as const };
    }
    // Marcada para reconectar: la periódica no insiste cada hora (cada
    // intento fallaría igual); la manual sí lo intenta, por si el permiso
    // volvió.
    if (conexion.necesitaReconexion && !forzar) {
      console.log(`${proveedor}: la conexión necesita reconexión, se salta`);
      return { estado: "apagado" as const };
    }
    if (!forzar && a.nubeSyncMinutes <= 0) {
      console.log(`${proveedor}: DRIVE_SYNC_MINUTES=0, sincronización periódica apagada`);
      return { estado: "apagado" as const };
    }

    const ultima = await ctx.runQuery(internal.nube.datos.ultimaCorrida, { propietario, proveedor });
    const ahora = Date.now();
    if (ultima?.estado === "running") {
      if (ahora - ultima.empezadoEn < CORRIDA_MUERTA_MS) {
        console.log(`${proveedor}: ya hay una sincronización en curso`);
        return { estado: "en_curso" as const };
      }
      await ctx.runMutation(internal.nube.datos.cerrarCorrida, {
        runId: ultima._id,
        ficheros: ultima.ficheros,
        nuevos: ultima.nuevos,
        actualizados: ultima.actualizados,
        borrados: ultima.borrados,
        errores: [...ultima.errores, "la corrida murió sin cerrarse"],
        estado: "error",
      });
    } else if (!forzar && ultima) {
      // Desde el INICIO de la última y con un minuto de margen (ver notion/sync.ts).
      const intervaloMs = a.nubeSyncMinutes * 60_000 - 60_000;
      if (ahora - ultima.empezadoEn < intervaloMs) {
        console.log(`${proveedor}: la última sincronización es reciente, se salta`);
        return { estado: "reciente" as const };
      }
    }

    const runId = await ctx.runMutation(internal.nube.datos.abrirCorrida, { propietario, proveedor });
    const cifras: Cifras = { ficheros: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [] };
    let parcial = false;
    const t0 = Date.now();

    try {
      // Token fresco para toda la corrida, y renovable si la API dice 401.
      const { token } = await tokenVigente(ctx, propietario, proveedor, { margenMs: MARGEN_CORRIDA_MS });
      const cliente = clienteDe(proveedor, tokensRenovables(ctx, propietario, proveedor, token));

      // Documentos de esta nube que existen hoy: un fichero cuyo documento
      // borró su dueña a mano se vuelve a traer aunque no cambiara.
      const vivos = new Set<string>(await ctx.runQuery(internal.nube.datos.idsDocumentosDe, { propietario, proveedor }));

      // 1. Listar TODAS las carpetas antes de tocar nada: el total de la
      //    barra es el real desde el primer segundo, y se sabe qué ficheros
      //    siguen en ALGUNA carpeta elegida (los que se movieron entre dos).
      const porCarpeta: Array<{ carpeta: Doc<"nubeConexion">["carpetas"][number]; ficheros: FicheroNube[]; completo: boolean }> = [];
      for (const carpeta of conexion.carpetas) {
        const listado = await cliente.ficherosDeCarpeta(carpeta.id);
        for (const aviso of listado.avisos) cifras.errores.push(`${carpeta.nombre}: ${aviso}`);
        porCarpeta.push({ carpeta, ficheros: listado.ficheros, completo: listado.completo });
      }
      const enAlgunaCarpeta = new Set<string>();
      for (const { ficheros } of porCarpeta) for (const f of ficheros) enAlgunaCarpeta.add(f.id);
      const total = porCarpeta.reduce((n, c) => n + c.ficheros.length, 0);
      await ctx.runMutation(internal.nube.datos.avanzarCorrida, { runId, ficherosTotal: total, ficherosProcesados: 0 });

      let procesados = 0;
      let ultimoAvance = -1;
      const avanzar = async (etiqueta: string | undefined, forzado: boolean) => {
        if (!forzado && procesados - ultimoAvance < PASO_AVANCE) return;
        ultimoAvance = procesados;
        await ctx.runMutation(internal.nube.datos.avanzarCorrida, {
          runId,
          ficherosProcesados: procesados,
          ...(etiqueta === undefined ? {} : { ficheroActual: etiqueta }),
          ...cifras,
        });
      };

      // 2. Carpeta por carpeta. El cálculo de lo que ha desaparecido es POR
      //    CARPETA y solo si se recorrió entera.
      for (const { carpeta, ficheros, completo } of porCarpeta) {
        const conocidas = new Map(
          (
            await ctx.runQuery(internal.nube.datos.ficherosDeCarpeta, { propietario, proveedor, carpetaId: carpeta.id })
          ).map((f) => [f.ficheroId, f]),
        );
        const vistas = new Set<string>();
        let completa = completo;

        for (const f of ficheros) {
          vistas.add(f.id);
          cifras.ficheros += 1;

          if (Date.now() - t0 > LIMITE_CORRIDA_MS) {
            parcial = true;
            completa = false;
            break;
          }

          // Lo que no se puede traer se DICE en los avisos de la corrida (es
          // lo único que ve la usuaria) y no deja fila: así no se marca como
          // error ni se reintenta una descarga que no va a servir.
          if (f.omitir !== null) {
            cifras.errores.push(`${f.ruta}: ${f.omitir}`);
            procesados += 1;
            await avanzar(undefined, false);
            continue;
          }
          const ext = extensionDe(f.nombre);
          if (!(EXTENSIONES_PERMITIDAS as readonly string[]).includes(ext)) {
            cifras.errores.push(`${f.ruta}: es .${ext || "?"}, un formato que no se puede indexar; conviértelo a PDF`);
            procesados += 1;
            await avanzar(undefined, false);
            continue;
          }
          if (f.tamano !== null && f.tamano > MAX_FICHERO_BYTES) {
            cifras.errores.push(`${f.ruta}: ${demasiadoGrande(f.nombre, f.tamano)}`);
            procesados += 1;
            await avanzar(undefined, false);
            continue;
          }

          // La fila del fichero, esté bajo la carpeta que esté: si se movió
          // de otra carpeta elegida a esta, es el mismo documento.
          const previa =
            conocidas.get(f.id) ??
            (await ctx.runQuery(internal.nube.datos.fichero, { propietario, proveedor, ficheroId: f.id }));
          const intacta =
            previa !== null &&
            previa.version === f.version &&
            !previa.error &&
            (previa.documentId === undefined || vivos.has(previa.documentId));
          if (intacta) {
            if (previa.carpetaId !== carpeta.id) {
              // Se movió entre carpetas elegidas: la fila cambia de casa sin
              // tocar el documento.
              await ctx.runMutation(internal.nube.datos.guardarFichero, {
                propietario,
                proveedor,
                carpetaId: carpeta.id,
                ficheroId: f.id,
                nombre: f.ruta,
                version: f.version,
                documentId: previa.documentId,
              });
            }
            procesados += 1;
            await avanzar(undefined, false);
            continue;
          }

          // Avance ANTES de tocar el fichero, forzado: es el que tarda.
          await avanzar(conexion.carpetas.length > 1 ? `${carpeta.nombre} · ${f.ruta}` : f.ruta, true);

          try {
            const documentId = await procesarFichero(ctx, propietario, proveedor, cliente, f, previa, cifras);
            await ctx.runMutation(internal.nube.datos.guardarFichero, {
              propietario,
              proveedor,
              carpetaId: carpeta.id,
              ficheroId: f.id,
              nombre: f.ruta,
              version: f.version,
              documentId,
            });
          } catch (exc) {
            if (exc instanceof ErrorReconexion) throw exc;
            const msg = mensajeDe(exc);
            cifras.errores.push(`${f.ruta}: ${msg}`);
            await ctx.runMutation(internal.nube.datos.guardarFichero, {
              propietario,
              proveedor,
              carpetaId: carpeta.id,
              ficheroId: f.id,
              nombre: f.ruta,
              version: f.version,
              documentId: previa?.documentId,
              error: msg.slice(0, 500),
            });
          }
          procesados += 1;
        }

        // 3. Ficheros que ya no están EN ESTA CARPETA y en ninguna otra
        //    elegida. Solo si se recorrió entera: si el reloj o un tope la
        //    cortaron, no se sabe qué no se llegó a ver.
        if (completa) {
          for (const fila of conocidas.values()) {
            if (vistas.has(fila.ficheroId) || enAlgunaCarpeta.has(fila.ficheroId)) continue;
            try {
              if (a.nubeBorrarRetirados) {
                if (fila.documentId) {
                  const borrado = await ctx.runMutation(internal.nube.datos.borrarDocumento, {
                    propietario,
                    proveedor,
                    documentId: fila.documentId,
                    ficheroId: fila.ficheroId,
                  });
                  if (borrado) cifras.borrados += 1;
                }
                await ctx.runMutation(internal.nube.datos.borrarFichero, { propietario, proveedor, ficheroId: fila.ficheroId });
              } else if (fila.error !== "retirado") {
                await ctx.runMutation(internal.nube.datos.marcarFichero, {
                  propietario,
                  proveedor,
                  ficheroId: fila.ficheroId,
                  error: "retirado",
                });
              }
            } catch (exc) {
              cifras.errores.push(`${fila.nombre}: al retirar, ${mensajeDe(exc)}`);
            }
          }
        }
        if (parcial) break;
      }

      const huboFallos = cifras.errores.length > 0;
      if (parcial) cifras.errores.push("sincronización parcial, continuará en unos minutos");
      await avanzar(undefined, true);
      await ctx.runMutation(internal.nube.datos.cerrarCorrida, {
        runId,
        ...cifras,
        estado: huboFallos ? "error" : "ok",
      });
      if (parcial && procesados > 0) {
        await ctx.scheduler.runAfter(60_000, internal.nube.sync.sincronizar, { propietario, proveedor, forzar: true });
      }
      console.log(
        `${proveedor}: ${cifras.ficheros} ficheros, ${cifras.nuevos} nuevos, ${cifras.actualizados} ` +
          `actualizados, ${cifras.borrados} borrados, ${cifras.errores.length} avisos, ` +
          `${Date.now() - t0} ms${parcial ? " (parcial)" : ""}`,
      );
      return { estado: parcial ? ("parcial" as const) : ("ok" as const), ...cifras };
    } catch (exc) {
      // Fallo global (la nube no responde, el permiso se revocó): la corrida
      // se cierra como error con el motivo en llano, y lo ya hecho queda.
      const msg =
        exc instanceof ErrorReconexion
          ? `${nombreNube} ya no acepta el permiso de esta conexión. Pulsa "Volver a conectar".`
          : mensajeDe(exc);
      console.error(`${proveedor}: la sincronización falló: ${msg}`);
      await ctx.runMutation(internal.nube.datos.cerrarCorrida, {
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
// Un fichero
// ---------------------------------------------------------------------------
/** Descarga, deduplica y registra un fichero. Devuelve el id del documento
 *  que lo representa, o undefined si es un duplicado exacto de algo que ya
 *  está indexado con otro origen (no se indexa dos veces). */
async function procesarFichero(
  ctx: ActionCtx,
  propietario: Id<"users">,
  proveedor: Proveedor,
  cliente: ClienteNube,
  f: FicheroNube,
  previa: Doc<"nubeFicheros"> | null,
  cifras: Cifras,
): Promise<Id<"documents"> | undefined> {
  // El documento anterior de ESTE fichero, si sigue siendo nuestro: uno
  // reclamado por una subida manual (misma fila, otro origen) ya no lo es.
  const docPrevio = previa?.documentId
    ? await ctx.runQuery(internal.nube.datos.documento, { propietario, id: previa.documentId })
    : null;
  const nuestro = docPrevio && docPrevio.origen === proveedor && docPrevio.nubeFicheroId === f.id ? docPrevio : null;

  const bytes = await cliente.descargar(f);
  if (bytes.length === 0) {
    cifras.errores.push(`${f.ruta}: el fichero está vacío`);
    return nuestro?._id;
  }
  const sha = await sha256Hex(bytes);

  if (nuestro && nuestro.sha256 === sha && nuestro.status !== "failed") {
    // Cambió la versión (un renombrado, una fecha) pero no el contenido: no
    // se vuelve a embeber lo mismo.
    return nuestro._id;
  }

  const existente = await ctx.runQuery(internal.nube.datos.documentoPorSha256, { propietario, sha256: sha });
  if (existente && existente.status !== "failed" && existente._id !== nuestro?._id) {
    // Dedupe global: el mismo fichero, venga de otra carpeta, de Notion o de
    // una subida manual, no se indexa dos veces.
    console.log(`${proveedor}: '${f.ruta}' ya indexado como '${existente.fileName}'`);
    if (nuestro) {
      // Este fichero antes tenía su propio documento y ahora su contenido es
      // el de otro: el suyo sobra.
      const borrado = await ctx.runMutation(internal.nube.datos.borrarDocumento, {
        propietario,
        proveedor,
        documentId: nuestro._id,
        ficheroId: f.id,
      });
      if (borrado) cifras.borrados += 1;
    }
    return undefined;
  }

  // Se conserva el nombre del documento anterior aunque el fichero se haya
  // renombrado: el nombre es el `sourceFile` de las citas ya dadas.
  const ext = extensionDe(f.nombre);
  const base = f.nombre.slice(0, f.nombre.length - ext.length - 1);
  const candidatos = nuestro
    ? [nuestro.fileName, f.nombre, `${base}-${sufijoDe(f.id)}.${ext}`]
    : [f.nombre, `${base}-${sufijoDe(f.id)}.${ext}`];
  const id = await registrar(ctx, propietario, proveedor, bytes, sha, candidatos, f.id);
  if (nuestro && nuestro._id !== id) {
    // Cambió de fila (el nombre viejo lo ocupó otro): la vieja sobra.
    await ctx.runMutation(internal.nube.datos.borrarDocumento, {
      propietario,
      proveedor,
      documentId: nuestro._id,
      ficheroId: f.id,
    });
  }
  if (nuestro) cifras.actualizados += 1;
  else cifras.nuevos += 1;
  return id;
}

/** Guarda los bytes y registra el documento probando nombres en orden. Si
 *  todos chocan, se borra el fichero guardado y se lanza. */
async function registrar(
  ctx: ActionCtx,
  propietario: Id<"users">,
  proveedor: Proveedor,
  bytes: Uint8Array,
  sha256: string,
  candidatos: string[],
  ficheroId: string,
): Promise<Id<"documents">> {
  const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  let ultimo: unknown = null;
  const probados = new Set<string>();
  for (const crudo of candidatos) {
    const nombre = sanearNombre(crudo);
    if (!nombre || probados.has(nombre)) continue;
    probados.add(nombre);
    try {
      const id = await ctx.runMutation(internal.documentos.registrarDesdeOrigen, {
        propietario,
        storageId,
        fileName: nombre,
        sha256,
        origen: proveedor,
        nubeFicheroId: ficheroId,
      });
      return id;
    } catch (exc) {
      ultimo = exc;
      if (codigoDe(exc) !== "conflicto") break;
    }
  }
  await ctx.storage.delete(storageId);
  throw ultimo ?? new Error(`no quedó ningún nombre libre para ${candidatos[0]}`);
}
