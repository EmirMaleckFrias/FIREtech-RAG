// @vitest-environment node
// La parte pura del OCR: reducir píxeles, codificar PNG, la clave de caché y la
// limpieza de la respuesta. El modelo no se toca; lo que se prueba es que lo
// que se le manda es una imagen válida y del tamaño previsto, y que lo que
// devuelve se interpreta bien.
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  LADO_MAXIMO,
  LADO_MINIMO,
  OCR_PROMPT_VERSION,
  claveDeOcr,
  codificarPng,
  crc32,
  limpiarRespuestaOcr,
  prepararImagen,
  reducirARgb,
} from "./ocr";

/** Lee la estructura de un PNG: firma, IHDR y el IDAT inflado. */
function leerPng(png: Uint8Array) {
  const firma = Array.from(png.subarray(0, 8));
  const vista = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  const trozos: Array<{ tipo: string; datos: Uint8Array; crcOk: boolean }> = [];
  while (o < png.length) {
    const len = vista.getUint32(o);
    const tipo = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const datos = png.subarray(o + 8, o + 8 + len);
    const crcLeido = vista.getUint32(o + 8 + len);
    const crcCalculado = crc32(png.subarray(o + 4, o + 8 + len));
    trozos.push({ tipo, datos, crcOk: crcLeido === crcCalculado });
    o += 12 + len;
  }
  const ihdr = trozos.find((t) => t.tipo === "IHDR")!;
  const v = new DataView(ihdr.datos.buffer, ihdr.datos.byteOffset, ihdr.datos.byteLength);
  const idat = trozos.find((t) => t.tipo === "IDAT")!;
  return {
    firma,
    ancho: v.getUint32(0),
    alto: v.getUint32(4),
    bits: ihdr.datos[8],
    color: ihdr.datos[9],
    tipos: trozos.map((t) => t.tipo),
    crcTodosOk: trozos.every((t) => t.crcOk),
    crudo: new Uint8Array(inflateSync(idat.datos)),
  };
}

describe("crc32", () => {
  test("coincide con el vector de referencia de la norma", () => {
    // CRC-32 de "123456789" es 0xCBF43926: es EL vector de prueba del algoritmo.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("reducirARgb", () => {
  test("una imagen pequeña no se reduce, solo pasa a RGB (gris y RGBA incluidos)", () => {
    const gris = new Uint8Array([0, 128, 255, 64]);
    const r = reducirARgb(2, 2, gris, 1);
    expect([r.ancho, r.alto]).toEqual([2, 2]);
    expect(Array.from(r.rgb)).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255, 64, 64, 64]);

    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 0]);
    const r2 = reducirARgb(2, 1, rgba, 4);
    expect(Array.from(r2.rgb)).toEqual([10, 20, 30, 40, 50, 60]); // el alfa se tira
  });

  test("una imagen grande se reduce por un factor entero promediando bloques", () => {
    // 4x2 en RGB: bloques 2x2 → 2x1. Con lado máximo 2, factor = ceil(4/2) = 2.
    const rgb = new Uint8Array([
      0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255,
      50, 50, 50, 150, 150, 150, 0, 0, 0, 55, 55, 55,
    ]);
    const r = reducirARgb(4, 2, rgb, 3, 2);
    expect([r.ancho, r.alto]).toEqual([2, 1]);
    // Bloque izquierdo: (0+100+50+150)/4 = 75. Derecho: (200+255+0+55)/4 = 127.5 → 128.
    expect(Array.from(r.rgb)).toEqual([75, 75, 75, 128, 128, 128]);
  });

  test("un escaneo a 300 ppp queda por debajo del lado máximo", () => {
    const ancho = 2480;
    const alto = 3508;
    const r = reducirARgb(ancho, alto, new Uint8Array(ancho * alto), 1);
    expect(Math.max(r.ancho, r.alto)).toBeLessThanOrEqual(LADO_MAXIMO);
    // Factor 3: 2480/3 = 826, 3508/3 = 1169. Y el texto sigue legible a eso.
    expect([r.ancho, r.alto]).toEqual([826, 1169]);
    expect(r.rgb.length).toBe(826 * 1169 * 3);
  });
});

describe("codificarPng", () => {
  test("produce un PNG válido: firma, IHDR de 8 bits RGB, CRC correctos y los píxeles se recuperan", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2x2
    const png = codificarPng(2, 2, rgb);
    const p = leerPng(png);
    expect(p.firma).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([p.ancho, p.alto, p.bits, p.color]).toEqual([2, 2, 8, 2]);
    expect(p.tipos).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(p.crcTodosOk).toBe(true);
    // Cada fila lleva delante su byte de filtro (0).
    expect(Array.from(p.crudo)).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  test("un fondo blanco grande comprime a una fracción: es lo que hace ligera la petición", () => {
    const ancho = 800;
    const alto = 1100;
    const rgb = new Uint8Array(ancho * alto * 3).fill(255);
    const png = codificarPng(ancho, alto, rgb);
    expect(png.length).toBeLessThan((ancho * alto * 3) / 50);
    expect(leerPng(png).crudo.length).toBe((ancho * 3 + 1) * alto);
  });
});

describe("prepararImagen", () => {
  test("los bytes de un fichero pasan tal cual con su MIME", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(prepararImagen({ tipo: "bytes", bytes, mime: "image/jpeg" })).toEqual({ bytes, mime: "image/jpeg" });
  });

  test("una imagen diminuta (icono, línea) no se manda", () => {
    const chica = prepararImagen({
      tipo: "pixeles",
      ancho: LADO_MINIMO - 1,
      alto: 200,
      datos: new Uint8Array((LADO_MINIMO - 1) * 200),
      canales: 1,
    });
    expect(chica).toBeNull();
  });

  test("los píxeles salen como PNG reducido", () => {
    const ancho = 3200;
    const alto = 100;
    const r = prepararImagen({ tipo: "pixeles", ancho, alto, datos: new Uint8Array(ancho * alto * 3), canales: 3 })!;
    expect(r.mime).toBe("image/png");
    const p = leerPng(r.bytes);
    expect(p.ancho).toBe(1600); // factor 2
    expect(p.alto).toBe(50);
  });
});

describe("claveDeOcr y limpiarRespuestaOcr", () => {
  test("la clave cambia con los bytes, el modelo y la versión del prompt", () => {
    const a = claveDeOcr(new Uint8Array([1]), "m1");
    expect(a).toBe(claveDeOcr(new Uint8Array([1]), "m1"));
    expect(a).not.toBe(claveDeOcr(new Uint8Array([2]), "m1"));
    expect(a).not.toBe(claveDeOcr(new Uint8Array([1]), "m2"));
    expect(a.endsWith(`|m1|${OCR_PROMPT_VERSION}`)).toBe(true);
  });

  test("quita la cerca de código que el modelo a veces pone y reconoce SIN TEXTO", () => {
    expect(limpiarRespuestaOcr("```markdown\n# Título\n\ntexto\n```")).toBe("# Título\n\ntexto");
    expect(limpiarRespuestaOcr("  # Título  ")).toBe("# Título");
    expect(limpiarRespuestaOcr("SIN TEXTO")).toBe("");
    expect(limpiarRespuestaOcr("sin texto.")).toBe("");
    // Pero un texto que EMPIEZA así no se pierde.
    expect(limpiarRespuestaOcr("SIN TEXTO en la primera columna; la segunda dice 42")).toContain("42");
  });
});
