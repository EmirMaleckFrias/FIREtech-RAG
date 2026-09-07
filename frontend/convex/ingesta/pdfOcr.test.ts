// PDF escaneado: la página no tiene texto propio, solo una imagen. Con OCR se
// lee; sin OCR falla como antes, con su mensaje. La fixture `escaneado.pdf`
// es la primera página de un artículo real convertida a imagen (JPEG dentro
// de un PDF sin fuentes), como sale de un escáner.
//
// El OCR es falso y se apunta lo que se le pide: aquí se prueba que la
// imagen de la página llega con sus dimensiones y canales, que el texto
// vuelve a la página correcta, y que una página CON texto no se manda al
// modelo.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parsearDocumento } from "./parsear";
import { extraerLineas, parsearPdf, textoDePagina } from "./pdf";
import { resultadoOcr, type ContextoOcr, type ImagenParaOcr, type Ocr } from "./tipos";

function fixture(nombre: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nombre}`, import.meta.url)));
}

const ESCANEADO = fixture("escaneado.pdf");
const CON_TEXTO = fixture("PMC12739034_p1.pdf");

function ocrQueApunta(texto: string) {
  const pedidas: Array<{ imagen: ImagenParaOcr; ctx: ContextoOcr }> = [];
  const ocr: Ocr = async (imagen, ctx) => {
    pedidas.push({ imagen, ctx });
    return resultadoOcr(texto);
  };
  return { ocr, pedidas };
}

describe("un PDF escaneado", () => {
  test("no tiene texto propio: sin OCR falla con el mensaje de siempre", async () => {
    let entregadas = 0;
    const { paginas } = await extraerLineas(ESCANEADO, { conImagenes: () => (entregadas += 1) });
    expect(paginas).toHaveLength(1);
    expect(textoDePagina(paginas[0])).toBeLessThan(40);
    // Sin pedirlas (sin `imagenesSi`), las imágenes no se extraen: es lo que
    // ahorra el trabajo en un artículo normal con figuras.
    expect(entregadas).toBe(0);

    // `parsearPdf` devuelve cero fragmentos; quien lo convierte en el error
    // que ve la usuaria es `parsearDocumento`.
    expect((await parsearPdf(ESCANEADO, "escaneado.pdf")).chunks).toEqual([]);
    await expect(parsearDocumento("escaneado.pdf", ESCANEADO)).rejects.toThrow(/PDF escaneado sin OCR/);
  });

  test("con OCR: la imagen de la página llega con sus píxeles y el texto vuelve a la página 1", async () => {
    const { ocr, pedidas } = ocrQueApunta(
      "# Diagnostic accuracy of plasma p-tau217\n\nBackground: plasma p-tau217 measured with an immunoassay.\n\nResults: the AUC was 0.93.",
    );
    const r = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr });

    expect(pedidas).toHaveLength(1);
    const { imagen, ctx } = pedidas[0];
    expect(ctx).toEqual({ nombre: "escaneado.pdf", pagina: 1, indice: 1 });
    expect(imagen.tipo).toBe("pixeles");
    if (imagen.tipo === "pixeles") {
      // La página escaneada mide 1293x1700 (ver cómo se fabricó la fixture).
      expect(imagen.ancho).toBe(1293);
      expect(imagen.alto).toBe(1700);
      expect([1, 3, 4]).toContain(imagen.canales);
      expect(imagen.datos.length).toBeGreaterThanOrEqual(1293 * 1700 * imagen.canales);
    }

    expect(r.paginasOcr).toBe(1);
    expect(r.pages).toBe(1);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks.every((c) => c.page === 1)).toBe(true);
    const todo = r.chunks.map((c) => c.text).join("\n");
    expect(todo).toContain("AUC was 0.93");
    // Sin bloque de título que leer, el título sale del primer encabezado
    // del OCR y va en la cita.
    expect(r.chunks[0].titulo).toBe("Diagnostic accuracy of plasma p-tau217");
  });

  test("si el OCR no reconoce nada, el documento sigue sin texto y falla diciendo que tampoco en sus imágenes", async () => {
    const { ocr } = ocrQueApunta("");
    const r = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr });
    expect(r.chunks).toEqual([]);
    expect(r.paginasOcr).toBe(0);
    await expect(parsearDocumento("escaneado.pdf", ESCANEADO, { ocr })).rejects.toThrow(
      /ni texto propio ni texto reconocible/,
    );
  });
});

describe("un PDF con texto", () => {
  test("no se manda al modelo aunque haya OCR disponible", async () => {
    const { ocr, pedidas } = ocrQueApunta("esto no debería usarse");
    const r = await parsearPdf(CON_TEXTO, "articulo.pdf", { ocr });
    expect(pedidas).toHaveLength(0);
    expect(r.paginasOcr).toBe(0);
    expect(r.chunks.map((c) => c.text).join("\n")).not.toContain("esto no debería usarse");
  });

  test("el umbral gobierna la decisión: con umbral 0, ni la página escaneada se lee", async () => {
    // Adversarial en la otra dirección: la página escaneada tiene 0
    // caracteres, y 0 < 0 es falso, así que con el umbral a cero NO debe
    // pedirse ninguna lectura. Si el umbral no llegara hasta la extracción,
    // esta prueba vería una petición.
    const { ocr, pedidas } = ocrQueApunta("texto");
    const r = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr, minTextoPagina: 0 });
    expect(pedidas).toHaveLength(0);
    expect(r.paginasOcr).toBe(0);
  });
});

describe("avisos de una página escaneada", () => {
  test("ADVERSARIAL: un fallo del OCR no es 'imagen sin texto': cuenta como página sin leer y el error dice que se reintente", async () => {
    const ocr: Ocr = async () => ({ texto: "", estado: "fallo", motivo: "el servicio de lectura de imágenes falló: gateway 429" });
    const r = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr });
    expect(r.chunks).toEqual([]);
    expect(r.avisos).toMatchObject({ sinLeer: 1, omitidas: 0 });
    expect(r.avisos.motivo).toMatch(/429/);
    await expect(parsearDocumento("escaneado.pdf", ESCANEADO, { ocr })).rejects.toThrow(/no se pudo leer.*reintentar/);
  });

  test("una imagen omitida por el tope cuenta aparte, y una página en blanco de verdad no cuenta", async () => {
    const omitida: Ocr = async () => ({ texto: "", estado: "omitida", motivo: "el documento pasa de 300 imágenes; las demás no se leyeron" });
    const r1 = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr: omitida });
    expect(r1.avisos).toMatchObject({ sinLeer: 0, omitidas: 1 });

    const enBlanco: Ocr = async () => ({ texto: "", estado: "sin_texto" });
    const r2 = await parsearPdf(ESCANEADO, "escaneado.pdf", { ocr: enBlanco });
    expect(r2.avisos).toEqual({ sinLeer: 0, omitidas: 0, recortados: 0 });
    // Y el mensaje sigue siendo el de "sin texto", que es la verdad.
    await expect(parsearDocumento("escaneado.pdf", ESCANEADO, { ocr: enBlanco })).rejects.toThrow(
      /ni texto propio ni texto reconocible/,
    );
  });

  test("las imágenes se entregan según se extrae cada página, no todas al final", async () => {
    // Si `conImagenes` se llamara tras recorrer el documento, los píxeles de
    // todas las páginas habrían convivido en memoria. Se comprueba que la
    // entrega ocurre antes de que extraerLineas devuelva.
    let entregadaAntesDeTerminar = false;
    let terminado = false;
    const p = extraerLineas(ESCANEADO, {
      imagenesSi: () => true,
      conImagenes: () => {
        entregadaAntesDeTerminar = !terminado;
      },
    });
    const r = await p;
    terminado = true;
    expect(entregadaAntesDeTerminar).toBe(true);
    expect(r.imagenesDescartadas).toBe(0);
    expect(r.paginasIlegibles).toEqual([]);
  });
});
