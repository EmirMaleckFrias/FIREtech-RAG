// Imágenes de una página de PDF tal como las entrega pdf.js: el formato de
// UN BIT por píxel de los escaneos en blanco y negro (fax, CCITT), las
// máscaras de imagen, y el RGB de siempre.
//
// El defecto que esto cierra: el código asumía que `kind === 1` era gris de
// un byte por píxel; en pdf.js GRAYSCALE_1BPP es un bit, `data.length` es
// ~ancho*alto/8, la guarda `data.length < ancho*alto` era siempre cierta y
// TODOS los escaneos bitonales se descartaban sin log. Un PDF de fax entero
// fallaba con "no contiene texto legible"; uno mixto perdía esas páginas.
import { describe, expect, test } from "vitest";
import { desempaquetar1bpp, pixelesDe } from "./pdf";

/** Empaqueta una imagen de bits (1 = blanco) por filas alineadas a byte, MSB
 *  primero, como hace pdf.js. */
function empaquetar(bits: number[][]): Uint8Array {
  const alto = bits.length;
  const ancho = bits[0].length;
  const bytesPorFila = (ancho + 7) >> 3;
  const salida = new Uint8Array(bytesPorFila * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      if (bits[y][x]) salida[y * bytesPorFila + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return salida;
}

describe("desempaquetar1bpp", () => {
  test("ADVERSARIAL: ancho que no es múltiplo de 8: cada píxel casa con su bit, incluido el relleno de fila", () => {
    const ancho = 100;
    const alto = 20;
    // Patrón irregular, distinto por fila, para que un desplazamiento de un
    // bit en cualquier fila se note.
    const bits = Array.from({ length: alto }, (_, y) =>
      Array.from({ length: ancho }, (_, x) => ((x * 7 + y * 13) % 5 === 0 ? 1 : 0)),
    );
    const datos = empaquetar(bits);
    expect(datos.length).toBe(13 * alto);
    const gris = desempaquetar1bpp(datos, ancho, alto);
    expect(gris.length).toBe(ancho * alto);
    for (let y = 0; y < alto; y++) {
      for (let x = 0; x < ancho; x++) {
        expect(gris[y * ancho + x]).toBe(bits[y][x] ? 255 : 0);
      }
    }
  });
});

describe("pixelesDe", () => {
  test("kind 1 (un bit por píxel) ya NO se descarta: se desempaqueta a gris de un canal", () => {
    const ancho = 2480;
    const alto = 64;
    const datos = new Uint8Array(((ancho + 7) >> 3) * alto).fill(0xff); // todo blanco
    const r = pixelesDe({ kind: 1, width: ancho, height: alto, data: datos }, false);
    expect(r).not.toBeNull();
    if (r && r.tipo === "pixeles") {
      expect(r.canales).toBe(1);
      expect(r.datos.length).toBe(ancho * alto);
      expect(r.datos[0]).toBe(255);
    }
  });

  test("una máscara de imagen (/ImageMask, sin kind) se lee como bitonal", () => {
    const datos = empaquetar([
      [1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
      [0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    ]);
    const r = pixelesDe({ width: 10, height: 2, data: datos }, true);
    expect(r).not.toBeNull();
    if (r && r.tipo === "pixeles") {
      expect(Array.from(r.datos.slice(0, 10))).toEqual([255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    }
  });

  test("RGB (kind 2) y RGBA (kind 3) pasan tal cual con sus canales", () => {
    const rgb = pixelesDe({ kind: 2, width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 3) }, false);
    const rgba = pixelesDe({ kind: 3, width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) }, false);
    expect(rgb && rgb.tipo === "pixeles" && rgb.canales).toBe(3);
    expect(rgba && rgba.tipo === "pixeles" && rgba.canales).toBe(4);
  });

  test("datos más cortos de lo que dicen ancho y alto -> null (no se inventa una imagen)", () => {
    expect(pixelesDe({ kind: 1, width: 100, height: 20, data: new Uint8Array(5) }, false)).toBeNull();
    expect(pixelesDe({ kind: 2, width: 100, height: 20, data: new Uint8Array(100) }, false)).toBeNull();
    expect(pixelesDe(null, false)).toBeNull();
    expect(pixelesDe({ kind: 2, width: 0, height: 20, data: new Uint8Array(100) }, false)).toBeNull();
  });
});
