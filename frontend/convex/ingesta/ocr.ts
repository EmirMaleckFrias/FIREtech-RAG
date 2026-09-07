"use node";
// La directiva va aquí y no solo en pipeline.ts porque Convex bundlea cada
// fichero de convex/ como entrada propia: sin ella intentaba resolver
// `node:zlib` y `node:crypto` para el runtime por defecto y el despliegue
// fallaba. Este módulo no define funciones de Convex, solo ayudantes; los
// importa la acción de ingesta, que también es de Node.
// OCR con un modelo de visión por el AI Gateway. Es la implementación de la
// función `Ocr` que los parsers reciben inyectada (ver tipos.ts): ellos
// encuentran imágenes, esto las lee.
//
// SOLO se importa desde el runtime de Node (ingesta/pipeline.ts): usa
// `node:zlib` para codificar PNG y `node:crypto` para la clave de caché. Los
// parsers y sus pruebas no lo tocan.
//
// Por qué un modelo de visión y no Tesseract: la usuaria sube escaneos de
// protocolos, fotos de guías y tablas; un motor OCR clásico en WASM es lento
// (varios segundos por página), flojo con tablas y letra a mano, y devuelve
// texto plano sin estructura. El modelo devuelve Markdown con encabezados y
// tablas, en el idioma del documento, y lee lo que un OCR clásico no.
//
// Por qué gpt-5.4-mini y no el grande: medido el 7 sep 2026 sobre una página
// escaneada de un artículo real, los dos transcribieron lo mismo (9/11 frases
// clave frente a 8/11) y el pequeño tardó 3,9 s frente a 9,8 s. Un escaneo de
// 60 páginas son 60 lecturas: la latencia manda. `OCR_MODEL` lo cambia.
//
// Dónde está la eficiencia:
// - Solo se hace OCR de lo que NO tiene texto (lo decide el parser de PDF con
//   `ocrMinTextoPagina`); un artículo con figuras no se manda al modelo.
// - Los píxeles de una página escaneada se REDUCEN antes de codificar: un
//   escaneo a 300 ppp son 2500x3500 píxeles y 26 MB crudos; a 1600 de lado
//   largo el texto se lee igual y la petición pesa la décima parte.
// - Caché por sha256 de los bytes enviados: reindexar no vuelve a leer nada.
// - Las lecturas van en paralelo hasta el tope del gateway (`plaza`, 8).
// - Nunca lanza por una imagen: una página ilegible no tira la ingesta.
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import type { ContextoOcr, ImagenParaOcr, Ocr } from "./tipos";

/** Versión del prompt: va en la clave de caché, así cambiar el prompt
 *  invalida las entradas solas. */
export const OCR_PROMPT_VERSION = "ocr-v2";

/** Lado largo máximo de una imagen de píxeles antes de mandarla. */
export const LADO_MAXIMO = 1600;

/** Imágenes más pequeñas que esto no se leen: son iconos, líneas, viñetas. */
export const LADO_MINIMO = 48;

/** Tope de la petición. El límite documentado de OpenAI por imagen son 20 MB;
 *  se deja margen para el resto del cuerpo y el base64. */
const MAX_BYTES_IMAGEN = 15 * 1024 * 1024;

// v2: el título del documento va PRIMERO y como `#`. Medido en el despliegue el
// 7 sep 2026 con v1: la página escaneada empezaba por "DOI: …" y el título iba
// como texto plano, así que el documento quedaba sin título en la cita; la
// foto de página empezaba por "# Abstract" y ese era el "título". El parser
// toma el primer encabezado como título del documento, así que hay que
// pedírselo al modelo.
export const PROMPT_OCR =
  "Transcribe TODO el texto legible de esta imagen de un documento, en su idioma " +
  "original, como Markdown. Si la imagen muestra el título del documento (el " +
  "encabezado principal de un artículo, guía o protocolo), escríbelo en la PRIMERA " +
  "línea como `# Título`; el resto de encabezados con `##`. Párrafos separados por " +
  "una línea en blanco, tablas como tablas Markdown (con su fila de cabecera), " +
  "listas como listas. " +
  "Conserva cifras, unidades, símbolos y abreviaturas exactamente como están. No " +
  "resumas, no expliques, no traduzcas y no añadas nada que no esté escrito. Si una " +
  "palabra es ilegible escribe [ilegible]. Si la imagen no contiene texto, responde " +
  "exactamente: SIN TEXTO.";

// ---------------------------------------------------------------------------
// Píxeles -> PNG
// ---------------------------------------------------------------------------

/** Reduce por un factor entero promediando bloques (box filter) y deja RGB de
 *  3 canales. Es la reducción más simple que no produce aliasing en texto, y
 *  con factor entero no hay interpolación que inventar. Con factor 1 solo
 *  convierte a RGB. */
export function reducirARgb(
  ancho: number,
  alto: number,
  datos: Uint8ClampedArray | Uint8Array,
  canales: 1 | 3 | 4,
  ladoMaximo = LADO_MAXIMO,
): { ancho: number; alto: number; rgb: Uint8Array } {
  const factor = Math.max(1, Math.ceil(Math.max(ancho, alto) / ladoMaximo));
  const ancho2 = Math.max(1, Math.floor(ancho / factor));
  const alto2 = Math.max(1, Math.floor(alto / factor));
  const rgb = new Uint8Array(ancho2 * alto2 * 3);
  const area = factor * factor;
  for (let y2 = 0; y2 < alto2; y2++) {
    for (let x2 = 0; x2 < ancho2; x2++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        const y = y2 * factor + dy;
        let i = (y * ancho + x2 * factor) * canales;
        for (let dx = 0; dx < factor; dx++, i += canales) {
          if (canales === 1) {
            const v = datos[i];
            r += v;
            g += v;
            b += v;
          } else {
            r += datos[i];
            g += datos[i + 1];
            b += datos[i + 2];
          }
        }
      }
      const o = (y2 * ancho2 + x2) * 3;
      rgb[o] = Math.round(r / area);
      rgb[o + 1] = Math.round(g / area);
      rgb[o + 2] = Math.round(b / area);
    }
  }
  return { ancho: ancho2, alto: alto2, rgb };
}

// CRC-32 de PNG (polinomio 0xEDB88320). Node 22 trae `zlib.crc32`, pero el
// runtime de Convex no garantiza esa versión; la tabla son 256 enteros.
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozoPng(tipo: string, datos: Uint8Array): Uint8Array {
  const salida = new Uint8Array(12 + datos.length);
  const vista = new DataView(salida.buffer);
  vista.setUint32(0, datos.length);
  salida.set([tipo.charCodeAt(0), tipo.charCodeAt(1), tipo.charCodeAt(2), tipo.charCodeAt(3)], 4);
  salida.set(datos, 8);
  vista.setUint32(8 + datos.length, crc32(salida.subarray(4, 8 + datos.length)));
  return salida;
}

/** PNG de 8 bits RGB sin filtros (byte de filtro 0 por fila). Es el codificador
 *  mínimo válido: ~40 líneas y sin dependencias, y `deflateSync` comprime el
 *  fondo blanco de un escaneo igual de bien que un filtro fino. */
export function codificarPng(ancho: number, alto: number, rgb: Uint8Array): Uint8Array {
  const fila = ancho * 3;
  const crudo = new Uint8Array((fila + 1) * alto);
  for (let y = 0; y < alto; y++) {
    crudo[y * (fila + 1)] = 0;
    crudo.set(rgb.subarray(y * fila, (y + 1) * fila), y * (fila + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, ancho);
  v.setUint32(4, alto);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, color tipo 2 (RGB), sin entrelazado
  const partes = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozoPng("IHDR", ihdr),
    trozoPng("IDAT", new Uint8Array(deflateSync(crudo))),
    trozoPng("IEND", new Uint8Array(0)),
  ];
  const total = partes.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of partes) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

/** Los bytes que se van a mandar, con su MIME: un fichero de imagen tal cual,
 *  o los píxeles reducidos y codificados como PNG. `null` si la imagen es
 *  demasiado pequeña para tener texto. */
export function prepararImagen(imagen: ImagenParaOcr): { bytes: Uint8Array; mime: string } | null {
  if (imagen.tipo === "bytes") return { bytes: imagen.bytes, mime: imagen.mime };
  if (imagen.ancho < LADO_MINIMO || imagen.alto < LADO_MINIMO) return null;
  const { ancho, alto, rgb } = reducirARgb(imagen.ancho, imagen.alto, imagen.datos, imagen.canales);
  return { bytes: codificarPng(ancho, alto, rgb), mime: "image/png" };
}

/** Clave de caché: hash de los bytes enviados, el modelo y la versión del
 *  prompt. Cambiar cualquiera de los tres invalida la entrada sola. */
export function claveDeOcr(bytes: Uint8Array, modelo: string): string {
  const h = createHash("sha256").update(bytes).digest("hex");
  return `${h}|${modelo}|${OCR_PROMPT_VERSION}`;
}

/** El modelo a veces envuelve la respuesta en ```markdown ... ```; se quita.
 *  Y "SIN TEXTO" es la señal de que no había nada que leer. */
export function limpiarRespuestaOcr(crudo: string): string {
  let t = crudo.trim();
  const cerca = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  if (cerca) t = cerca[1].trim();
  if (/^SIN TEXTO\.?$/i.test(t)) return "";
  return t;
}

// ---------------------------------------------------------------------------
// La función Ocr
// ---------------------------------------------------------------------------

export interface EstadisticasOcr {
  /** Imágenes que se intentaron leer (sin contar las descartadas por tamaño). */
  imagenes: number;
  enCache: number;
  leidas: number;
  fallidas: number;
  /** Descartadas por pasar del tope por documento. */
  omitidasPorTope: number;
  ms: number;
  tokens: { prompt: number; completion: number };
}

/**
 * Construye la función de OCR para UNA ingesta. Lleva su propio contador para
 * el tope por documento y sus estadísticas para la telemetría.
 *
 * Con `ENABLE_OCR=false` devuelve una función que responde "" a todo: los
 * parsers siguen funcionando (un PDF escaneado fallará como antes, con su
 * mensaje) y no se hace ninguna llamada.
 */
export function crearOcr(
  ctx: ActionCtx,
  a: Ajustes,
): { ocr: Ocr; estadisticas: EstadisticasOcr } {
  const est: EstadisticasOcr = {
    imagenes: 0,
    enCache: 0,
    leidas: 0,
    fallidas: 0,
    omitidasPorTope: 0,
    ms: 0,
    tokens: { prompt: 0, completion: 0 },
  };
  if (!a.ocrHabilitado) {
    return { ocr: async () => "", estadisticas: est };
  }
  const modelo = a.ocrModelo;

  const ocr: Ocr = async (imagen, contexto) => {
    const donde = describir(contexto);
    if (est.imagenes >= a.ocrMaxImagenesPorDocumento) {
      est.omitidasPorTope += 1;
      if (est.omitidasPorTope === 1) {
        console.warn(`OCR: '${contexto.nombre}' pasa de ${a.ocrMaxImagenesPorDocumento} imágenes; el resto se omite.`);
      }
      return "";
    }
    const preparada = prepararImagen(imagen);
    if (preparada === null) return "";
    if (preparada.bytes.length > MAX_BYTES_IMAGEN) {
      console.warn(`OCR: ${donde} pesa ${preparada.bytes.length} bytes, más de lo que admite el modelo; se omite.`);
      return "";
    }
    est.imagenes += 1;
    const t0 = Date.now();
    const clave = claveDeOcr(preparada.bytes, modelo);

    try {
      const cacheados = await ctx.runQuery(internal.ingesta.escritura.leerOcr, { claves: [clave] });
      if (cacheados.length > 0) {
        est.enCache += 1;
        est.ms += Date.now() - t0;
        return cacheados[0].texto;
      }
    } catch (exc) {
      console.warn(`OCR: caché no disponible (${String(exc).slice(0, 100)}); se lee igual.`);
    }

    try {
      const dataUrl = `data:${preparada.mime};base64,${Buffer.from(preparada.bytes).toString("base64")}`;
      const { datos } = await gateway.crearCompletion(
        {
          model: modelo,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT_OCR },
                { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
              ],
            },
          ],
          max_completion_tokens: 6000,
        },
        a,
      );
      const uso = gateway.usoDe(datos?.usage);
      est.tokens.prompt += uso.prompt;
      est.tokens.completion += uso.completion;
      const contenido = datos?.choices?.[0]?.message?.content;
      const texto = typeof contenido === "string" ? limpiarRespuestaOcr(contenido) : "";
      est.leidas += 1;
      est.ms += Date.now() - t0;
      // Se guarda también el vacío: una imagen sin texto no hay que volver a
      // preguntarla.
      void ctx
        .runMutation(internal.ingesta.escritura.guardarOcr, {
          entradas: [{ clave, texto, modelo }],
        })
        .catch((exc: unknown) => console.warn(`OCR: no se pudo guardar en caché: ${String(exc).slice(0, 100)}`));
      return texto;
    } catch (exc) {
      est.fallidas += 1;
      est.ms += Date.now() - t0;
      console.warn(`OCR: no se pudo leer ${donde}: ${String(exc).slice(0, 200)}`);
      return "";
    }
  };

  return { ocr, estadisticas: est };
}

function describir(c: ContextoOcr): string {
  const partes = [`'${c.nombre}'`];
  if (c.pagina !== undefined) partes.push(`pág. ${c.pagina}`);
  if (c.indice !== undefined) partes.push(`imagen ${c.indice}`);
  return partes.join(", ");
}
