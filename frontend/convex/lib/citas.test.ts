// Prueba de humo del arnés: lógica pura, sin despliegue ni red.
import { describe, expect, test } from "vitest";
import { cita, claveCita, localizador, pareceAbstencion } from "./citas";

const base = { _id: "x", text: "t", sourceFile: "paper.pdf", page: 4, chunkType: "text" };

describe("citas", () => {
  test("un PDF se cita por pagina y un Word por su seccion", () => {
    expect(localizador({ ...base, documentType: "pdf" })).toBe("pág. 4");
    expect(
      localizador({ ...base, documentType: "docx", section: "Métodos" }),
    ).toBe("sección: Métodos");
  });

  test("una fila de hoja de calculo no se llama pagina", () => {
    expect(
      localizador({ ...base, documentType: "xlsx", chunkType: "table" }),
    ).toBe("fila 4");
    expect(
      localizador({ ...base, documentType: "docx", chunkType: "table" }),
    ).toBe("tabla 4");
  });

  test("la cita usa la referencia corta cuando existe", () => {
    expect(cita({ ...base, documentType: "pdf", citation: "Allegri et al., 2023" }))
      .toBe("[Allegri et al., 2023, pág. 4]");
    expect(cita({ ...base, documentType: "pdf" })).toBe("[paper.pdf, pág. 4]");
  });

  test("la clave de cita ignora espacios y mayusculas, no el contenido", () => {
    expect(claveCita("[Paper.pdf,  pág.  4]")).toBe(claveCita("[paper.pdf, pág. 4]"));
    expect(claveCita("[paper.pdf, pág. 4]")).not.toBe(claveCita("[paper.pdf, pág. 5]"));
  });

  test("solo las formulas de abstencion cuentan como abstencion", () => {
    expect(pareceAbstencion("No encuentro el AUC en los documentos.")).toBe(true);
    expect(pareceAbstencion("Los documentos no indican la dosis.")).toBe(true);
    // Adversarial: esto AFIRMA, y colarlo como abstencion blanquearia una
    // respuesta sin respaldo, que es el peor caso del sistema.
    expect(pareceAbstencion("El AUC fue de 0,94 en la cohorte.")).toBe(false);
    expect(pareceAbstencion("No se pudo encontrar rápidamente")).toBe(false);
  });
});
