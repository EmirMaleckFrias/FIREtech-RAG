// Imágenes sueltas y el troceado del Markdown que devuelve el OCR. El OCR es
// falso: aquí se prueba qué se hace con su texto, no el modelo.
import { describe, expect, test } from "vitest";
import { chunksDeMarkdown, mimeDeImagen, parsearImagen, primerEncabezado } from "./imagen";
import { parsearDocumento } from "./parsear";
import { resultadoOcr, type Ocr } from "./tipos";

const MD =
  "# Protocolo de p-tau217 en plasma\n\n" +
  "## Preanalítica\n\n" +
  "La muestra se extrae en ayunas y se centrifuga en menos de dos horas a 2000 g.\n\n" +
  "| Parámetro | Valor |\n| --- | --- |\n| Tubo | EDTA K2 |\n| Temperatura | 4 °C |\n\n" +
  "## Analítica\n\n" +
  "El ensayo es de inmunoprecipitación seguida de espectrometría de masas. Los resultados " +
  "se informan en picogramos por mililitro y se interpretan junto con la clínica del paciente, " +
  "porque un valor aislado no basta para establecer el diagnóstico de la enfermedad.";

const ocrFalso = (texto: string): Ocr => async () => resultadoOcr(texto);

describe("primerEncabezado", () => {
  test("toma el primer # y le quita el formato", () => {
    expect(primerEncabezado(MD)).toBe("Protocolo de p-tau217 en plasma");
    expect(primerEncabezado("## **Título** en negrita\ntexto")).toBe("Título en negrita");
    expect(primerEncabezado("sin encabezados")).toBe("");
  });
});

describe("chunksDeMarkdown", () => {
  test("trocea por párrafos, respeta la tabla y pone sección y página", () => {
    const chunks = chunksDeMarkdown("foto.jpg", MD, 1, "Protocolo", "imagen");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.page === 1 && c.section === "Protocolo" && c.documentType === "imagen")).toBe(true);
    const todo = chunks.map((c) => c.text).join("\n");
    expect(todo).toContain("| Tubo | EDTA K2 |");
    expect(todo).toContain("2000 g");
  });

  test("Markdown vacío o solo espacios no produce chunks", () => {
    expect(chunksDeMarkdown("a.png", "   \n\n  ", 1, "", "imagen")).toEqual([]);
  });
});

describe("parsearImagen", () => {
  test("el OCR se pide con el MIME de la extensión y el resultado es un documento de tipo imagen", async () => {
    let pedido: { mime: string; nombre: string } | null = null;
    const ocr: Ocr = async (img, ctx) => {
      if (img.tipo === "bytes") pedido = { mime: img.mime, nombre: ctx.nombre };
      return resultadoOcr(MD);
    };
    const r = await parsearImagen(new Uint8Array([1, 2, 3]), "foto.JPG", ".jpg", ocr);
    expect(pedido).toEqual({ mime: "image/jpeg", nombre: "foto.JPG" });
    expect(r.pages).toBe(1);
    expect(r.chunks[0].titulo).toBe("Protocolo de p-tau217 en plasma");
    expect(r.chunks.every((c) => c.documentType === "imagen")).toBe(true);
  });

  test("una imagen sin texto legible falla con un motivo en llano, no con chunks vacíos", async () => {
    await expect(parsearImagen(new Uint8Array([1]), "paisaje.png", ".png", ocrFalso(""))).rejects.toThrow(
      /no contiene texto legible/,
    );
  });

  test("mimeDeImagen cubre las extensiones admitidas", () => {
    expect(mimeDeImagen(".png")).toBe("image/png");
    expect(mimeDeImagen(".WEBP")).toBe("image/webp");
    expect(mimeDeImagen(".bmp")).toBe("application/octet-stream");
  });
});

describe("parsearDocumento con imágenes", () => {
  test("despacha .png/.jpg al OCR y detecta el idioma del texto reconocido", async () => {
    const r = await parsearDocumento("captura.png", new Uint8Array([9]), { ocr: ocrFalso(MD) });
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0].language).toBe("es");
  });

  test("sin OCR una imagen falla explicando que la lectura no está disponible", async () => {
    await expect(parsearDocumento("captura.png", new Uint8Array([9]))).rejects.toThrow(/OCR/);
  });
});
