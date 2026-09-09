// Comprobación de ausencias: qué expresiones se comprueban y dónde aparecen.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { apareceEn, expresionesAComprobar, expresionesDe } from "./ausencias";

const modules = import.meta.glob("/convex/**/*.*s");

describe("expresionesDe", () => {
  test("el caso medido: '737' se comprueba; 'Boeing 737' va junto", () => {
    expect(expresionesDe("No encuentro que esto se describa específicamente para el 737 en los documentos.")).toEqual(["737"]);
    expect(expresionesDe("No encuentro nada sobre el Boeing 737 en los documentos.")).toEqual(["Boeing 737"]);
    expect(expresionesDe("No aparece el A320 en los documentos.")).toEqual(["A320"]);
    expect(expresionesDe("No encuentro la figura 14-2 en los documentos.")).toEqual(["14-2"]);
    expect(expresionesDe("Los documentos no indican qué barras del compartimiento P9 se desconectan.")).toEqual(["P9"]);
  });

  test("ADVERSARIAL: las palabras corrientes y los números pequeños o años no identifican nada", () => {
    // "cuatro" está en cualquier documento: solo se comprueba TRU.
    expect(expresionesDe("No encuentro cuatro TRU en los documentos.")).toEqual(["TRU"]);
    // Un "3" suelto o un "28" suelto no son identificadores; con su unidad sí.
    expect(expresionesDe("No encuentro un plazo de 3 segundos para el generador en los documentos.")).toEqual(["3 segundos"]);
    expect(expresionesDe("No encuentro nada de 3 en los documentos.")).toEqual([]);
    expect(expresionesDe("No encuentro el sistema doble de 28 Vcc en los documentos.")).toEqual(["28 Vcc"]);
    expect(expresionesDe("No encuentro el estudio de 2023 en los documentos.")).toEqual([]);
    // La mayúscula inicial de la primera palabra no la convierte en nombre propio.
    expect(expresionesDe("Muchas aeronaves no aparecen en los documentos.")).toEqual([]);
    // Unidades y siglas comunes solas no cuentan.
    expect(expresionesDe("No encuentro las barras de CA y CD en los documentos.")).toEqual([]);
  });

  test("ADVERSARIAL: un número no arrastra palabras corrientes, solo su unidad", () => {
    // Antes "para" se pegaba al número y la expresión quedaba "90 KVA para",
    // que no está en ningún sitio y hacía inútil la comprobación.
    expect(expresionesDe("No encuentro 90 KVA para el generador de la APU en los documentos.")).toEqual(["90 KVA", "APU"]);
    expect(expresionesDe("No encuentro 737 en los documentos.")).toEqual(["737"]);
  });

  test("tope de tres expresiones por frase", () => {
    expect(expresionesDe("No encuentro APU, TRU, GPU, MMSE ni Boeing en los documentos.")).toHaveLength(3);
  });
});

describe("apareceEn y expresionesAComprobar", () => {
  test("ADVERSARIAL: palabra entera, no subcadena; y frase contigua", () => {
    expect(apareceEn("737", ["un ejemplo del sistema del Boeing 737"])).toBe(true);
    expect(apareceEn("737", ["en 1737 y en 7370 no"])).toBe(false);
    expect(apareceEn("90 KVA", ["GEN 1 y GEN 2 de 40 KVA; 90 grados"])).toBe(false);
    expect(apareceEn("90 KVA", ["un generador de 90  kva"])).toBe(true);
    expect(apareceEn("Boeing 737", ["boeing\n737"])).toBe(true);
    expect(apareceEn("P9", ["compartimiento P6"])).toBe(false);
  });

  test("solo se comprueba lo que NO estaba en la evidencia recuperada", () => {
    const ausencias = [
      "No encuentro qué barras concretas recibe la APU cuando asume la carga de GEN 1 en los documentos.",
      "No encuentro que esto se describa específicamente para el 737 en los documentos.",
    ];
    const recuperados = ["El generador de la APU asumirá la carga del generador fallido GEN 1."];
    // APU y GEN 1 sí se vieron: esa frase habla de una relación, no de que
    // los términos no existan. Solo el 737 va al índice.
    expect(expresionesAComprobar(ausencias, recuperados)).toEqual(["737"]);
    expect(expresionesAComprobar(ausencias, [...recuperados, "Boeing 737"])).toEqual([]);
  });
});

describe("dondeAparecen", () => {
  test("encuentra la expresión como palabra entera, solo en el corpus de quien pregunta y dentro del alcance", async () => {
    const t = convexTest(schema, modules);
    const { ana, aviacion, otroDoc } = await t.run(async (ctx) => {
      const base = { rol: "lector" as const, bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 };
      const ana = await ctx.db.insert("users", { email: "ana@airobotix.net", ...base });
      const otra = await ctx.db.insert("users", { email: "otra@airobotix.net", ...base });
      const documento = (propietario: Id<"users">, fileName: string) =>
        ctx.db.insert("documents", { fileName, sha256: fileName, pages: 1, chunks: 1, status: "ready", propietario, ingestadoEn: 1 });
      const aviacion = await documento(ana, "--M6U1_PDF.pdf");
      const otroDoc = await documento(ana, "manual.pdf");
      const ajeno = await documento(otra, "ajeno.pdf");
      const chunk = (propietario: Id<"users">, documentRef: Id<"documents">, text: string, page: number) =>
        ctx.db.insert("chunks", {
          text, contexto: "", embedding: [], sourceFile: "x", page, chunkType: "text",
          documentId: String(documentRef), documentRef, propietario,
        });
      await chunk(ana, aviacion, "En el ejemplo del Boeing 737 las fuentes principales son GEN 1 y GEN 2 de 40 KVA.", 12);
      await chunk(ana, aviacion, "El año 1737 no tiene nada que ver.", 3);
      await chunk(ana, otroDoc, "El Airbus A320 lleva otra arquitectura.", 5);
      await chunk(otra, ajeno, "El A320 y el 737 comparados.", 1);
      return { ana, aviacion, otroDoc };
    });

    // Sin alcance: todo el corpus de Ana. El "737" está en la pág. 12 (no en "1737").
    const libre = await t.query(internal.agente.ausencias.dondeAparecen, {
      propietario: ana, expresiones: ["737", "A320", "90 KVA", "P9"],
    });
    expect(libre.map((h) => [h.expresion, h.page])).toEqual([["737", 12], ["A320", 5]]);

    // Acotado al PDF de aviación: el A320 del manual ya no cuenta.
    const acotado = await t.query(internal.agente.ausencias.dondeAparecen, {
      propietario: ana, documentId: String(aviacion), expresiones: ["737", "A320"],
    });
    expect(acotado.map((h) => h.expresion)).toEqual(["737"]);

    // ADVERSARIAL: el documento de otra persona no refuta nada de Ana.
    const soloAjeno = await t.query(internal.agente.ausencias.dondeAparecen, {
      propietario: ana, documentId: String(otroDoc), expresiones: ["737"],
    });
    expect(soloAjeno).toEqual([]);
  });
});
