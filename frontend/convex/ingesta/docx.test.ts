// @vitest-environment node
// Parser de Word: tablas que no cambian los números de columna, secciones y
// rótulos. Port de test_parse_docx.py y de la parte Word de
// test_generic_chunking.py, más los adversariales de la revisión final.
//
// Los .docx sintéticos se escriben a mano (docxFalso.test-util) y el fichero
// real de python-docx (fixtures/estudio.docx) cruza las suposiciones sobre el
// XML que genera Word de verdad.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { OVERLAP_TOKENS, estTokens } from "./chunking";
import { cabeceraDeTabla, parsearDocx, type FilaTabla } from "./docx";
import { escribirDocx, type BloqueFalso, type FilaFalsa } from "./docxFalso.test-util";
import { parsearDocumento } from "./parsear";
import type { ChunkParseado } from "./tipos";

function fixture(nombre: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nombre}`, import.meta.url)));
}

function cuerpo(chunk: ChunkParseado): string {
  const i = chunk.text.indexOf("\n\n");
  return i >= 0 ? chunk.text.slice(i + 2) : chunk.text;
}

const tablas = (chunks: ChunkParseado[]) => chunks.filter((c) => c.chunkType === "table");
const p = (texto: string, estilo?: string): BloqueFalso => ({ tipo: "p", texto, estilo });
const tabla = (filas: FilaFalsa[]): BloqueFalso => ({ tipo: "tabla", filas });

async function parsear(bloques: BloqueFalso[], opciones?: { estilos?: Record<string, string> | null }) {
  const bytes = await escribirDocx(bloques, opciones);
  return (await parsearDocx(bytes, "estudio.docx")).chunks;
}

/** Párrafos finales de `anterior` con los que arranca `siguiente`. */
function solape(anterior: ChunkParseado, siguiente: ChunkParseado): string[] {
  const ant = cuerpo(anterior).split("\n\n");
  const sig = cuerpo(siguiente).split("\n\n");
  for (let k = Math.min(ant.length, sig.length); k > 0; k--) {
    if (ant.slice(-k).join("\n") === sig.slice(0, k).join("\n")) return sig.slice(0, k);
  }
  return [];
}

describe("secciones y párrafos", () => {
  const DOCUMENTO: BloqueFalso[] = [
    p("Introducción", "Heading1"),
    p("La enfermedad se describe por primera vez en 1906."),
    p(""),
    p("Métodos", "Heading2"),
    p("Se reclutaron 120 participantes de tres centros."),
    p("El seguimiento fue de 24 meses."),
    tabla([["Grupo", "N", "Edad media"], ["Control", "60", "71.4"]]),
  ];

  test("agrupa por sección y no mezcla", async () => {
    const chunks = await parsear(DOCUMENTO);
    const texto = chunks.filter((c) => c.chunkType === "text");
    const secciones = texto.map((c) => c.section);
    expect(secciones).toContain("Introducción");
    expect(secciones).toContain("Métodos");
    for (const chunk of texto) {
      if (chunk.section === "Introducción") expect(chunk.text).not.toContain("participantes");
      if (chunk.section === "Métodos") expect(chunk.text).not.toContain("1906");
    }
  });

  test("la tabla se indexa como tal, con tipo docx y páginas = fragmentos", async () => {
    const bytes = await escribirDocx(DOCUMENTO);
    const { chunks, pages } = await parsearDocx(bytes, "estudio.docx");
    const t = tablas(chunks);
    expect(t).toHaveLength(1);
    expect(t[0].text).toContain("Grupo | N | Edad media");
    expect(t[0].text).toContain("Control | 60 | 71.4");
    expect(pages).toBe(chunks.length);
    expect(new Set(chunks.map((c) => c.documentType))).toEqual(new Set(["docx"]));
  });

  test("los párrafos de Word se solapan y llevan la sección", async () => {
    const bloques: BloqueFalso[] = [p("Métodos", "Heading1")];
    for (let i = 0; i < 40; i++) {
      bloques.push(
        p(
          `Paso ${String(i).padStart(3, "0")} del reclutamiento, descrito con el detalle suficiente ` +
            "para que el parrafo ocupe unas veinte palabras completas.",
        ),
      );
    }
    bloques.push(p("Resultados", "Heading1"), p("La media de amiloide fue 542 pg/mL en el grupo afectado."));
    const chunks = await parsear(bloques);
    const metodos = chunks.filter((c) => c.section === "Métodos");
    expect(metodos.length).toBeGreaterThanOrEqual(2);
    expect(metodos[0].text.startsWith("Métodos\n\nPaso 000")).toBe(true);
    expect(metodos[0].text.split("Métodos").length - 1).toBe(1);
    for (let i = 1; i < metodos.length; i++) {
      expect(metodos[i].text.startsWith("Métodos\n\n")).toBe(true);
      const cola = solape(metodos[i - 1], metodos[i]);
      expect(cola.length).toBeGreaterThan(0);
      const tokens = cola.reduce((s, x) => s + estTokens(x), 0);
      expect(tokens).toBeGreaterThanOrEqual(OVERLAP_TOKENS / 2);
      expect(tokens).toBeLessThanOrEqual(2 * OVERLAP_TOKENS);
    }
    const [resultados] = chunks.filter((c) => c.section === "Resultados");
    expect(resultados.text).not.toContain("reclutamiento");
    expect(resultados.text.startsWith("Resultados\n\nLa media")).toBe(true);
  });

  test("el contenido de un control de contenido (w:sdt) se indexa", async () => {
    const chunks = await parsear([
      { tipo: "sdt", bloques: [p("Resultados", "Heading1"), p("El AUC fue de 0.93 en la cohorte.")] },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Resultados");
    expect(chunks[0].text).toContain("0.93");
  });

  test("los encabezados se reconocen por el nombre del estilo, y sin styles.xml por su identificador", async () => {
    // "Title" no es un encabezado (como en el original), "Heading 1" sí.
    let chunks = await parsear([p("Un título de obra", "Title"), p("Métodos", "Heading1"), p("Cuerpo.")]);
    expect(chunks.map((c) => c.section)).toEqual(["", "Métodos"]);
    // Sin styles.xml: Word escribe "Ttulo1" como identificador de "Título 1".
    chunks = await parsear([p("Métodos", "Ttulo1"), p("Cuerpo.")], { estilos: null });
    expect(chunks.map((c) => c.section)).toEqual(["Métodos"]);
  });

  test("un .doc antiguo y un .docx vacío dan un error que explica qué hacer", async () => {
    await expect(parsearDocumento("notas.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(
      "guárdalo como .docx",
    );
    const vacio = await escribirDocx([]);
    await expect(parsearDocumento("vacio.docx", vacio)).rejects.toThrow("no contiene texto extraíble");
    await expect(parsearDocumento("roto.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow("no es un documento Word");
  });
});

describe("tablas que no cambian los números de columna", () => {
  test("dos celdas iguales no combinadas se conservan", async () => {
    // Antes salía "Edad | 72.4 (6.1) | 74.0 (5.8) | 0.31": una columna menos y
    // 74.0 leído bajo MCI en vez de AD.
    const chunks = await parsear([
      p("Results", "Heading1"),
      tabla([["Variable", "Control", "MCI", "AD", "p"], ["Edad", "72.4 (6.1)", "72.4 (6.1)", "74.0 (5.8)", "0.31"]]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[0]).toBe("Variable | Control | MCI | AD | p");
    expect(filas[1]).toBe("Edad | 72.4 (6.1) | 72.4 (6.1) | 74.0 (5.8) | 0.31");
  });

  test("una celda combinada de verdad ocupa todas sus columnas, y la vertical repite su texto", async () => {
    const chunks = await parsear([
      tabla([
        ["Grupo", "Medida", "Basal", "Final"],
        [{ texto: "Control", vMerge: "restart" }, { texto: "72.4", gridSpan: 2 }, "72.4"],
        [{ texto: "", vMerge: "continue" }, "MMSE", "28", "28"],
      ]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[0]).toBe("Grupo | Medida | Basal | Final");
    expect(filas[1]).toBe("Control | 72.4 |  | 72.4");
    expect(filas[1].split(" | ")[3]).toBe("72.4");
    expect(filas[2]).toBe("Control | MMSE | 28 | 28");
    expect(filas.every((f) => f.split(" | ").length === 4)).toBe(true);
  });

  test("una combinada en medio de la fila no desplaza la última columna", async () => {
    const chunks = await parsear([
      p("Results", "Heading1"),
      tabla([["Grupo", "Basal", "Final", "p"], ["AD", { texto: "n=40 (both visits)", gridSpan: 2 }, "0.03"]]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[0].split(" | ")).toEqual(["Grupo", "Basal", "Final", "p"]);
    expect(filas[1].split(" | ")).toEqual(["AD", "n=40 (both visits)", "", "0.03"]);
  });

  test("una combinada al final de la fila no mueve los valores", async () => {
    const chunks = await parsear([
      tabla([["Variable", "Control", "AD", "p"], ["MMSE", "28.1", { texto: "not tested", gridSpan: 2 }]]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[1].split(" | ")).toEqual(["MMSE", "28.1", "not tested"]);
    expect(filas[0].split(" | ")[1]).toBe("Control");
  });

  test("una fila que empieza en la segunda columna no desplaza sus valores", async () => {
    const chunks = await parsear([
      tabla([
        ["Variable", "Control", "AD"],
        ["Edad", "72", "74"],
        { celdas: ["28", "21"], gridBefore: 1 },
      ]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[2].split(" | ")).toEqual(["", "28", "21"]);
    expect(filas[0].split(" | ")[1]).toBe("Control");
  });

  test("una celda vacía al inicio de la cabecera no desplaza las columnas", async () => {
    const chunks = await parsear([tabla([["", "Control", "MCI"], ["Edad", "72", "73"]])]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[0].split(" | ")).toEqual(["", "Control", "MCI"]);
    expect(filas[1].split(" | ")).toEqual(["Edad", "72", "73"]);
  });

  test("las tablas heredan la sección y su rótulo, y no comparten el rótulo entre sí", async () => {
    const chunks = await parsear([
      p("Methods", "Heading1"),
      p("Participants were recruited from three memory clinics."),
      p("Results", "Heading1"),
      p("Table 1. Baseline characteristics by diagnostic group"),
      tabla([["Variable", "Control"], ["Edad", "72.4"]]),
      p("Discussion", "Heading1"),
      p("These results should be read with caution."),
      tabla([["Limitation", "Sample size"]]),
    ]);
    const t = tablas(chunks);
    expect(t.map((c) => c.section)).toEqual(["Results", "Discussion"]);
    expect(t.map((c) => c.page)).toEqual([1, 2]);
    expect(t[0].text).toBe(
      "Results\nTable 1. Baseline characteristics by diagnostic group\n\nVariable | Control\nEdad | 72.4",
    );
    expect(t[1].text).toBe("Discussion\n\nLimitation | Sample size");

    const consecutivas = await parsear([
      p("Results", "Heading1"),
      p("Table 1. Baseline characteristics"),
      tabla([["Edad", "72.4"]]),
      tabla([["MMSE", "28.1"]]),
    ]);
    expect(tablas(consecutivas)[0].text).toBe("Results\nTable 1. Baseline characteristics\n\nEdad | 72.4");
    expect(tablas(consecutivas)[1].text).toBe("Results\n\nMMSE | 28.1");
  });

  test("una tabla larga repite la cabecera y no pierde filas", async () => {
    const n = 300;
    const filas: FilaFalsa[] = [["ID", "Grupo", "Basal", "Final"]];
    for (let i = 1; i <= n; i++) filas.push([`paciente${String(i).padStart(3, "0")}`, `grupo${i % 3}`, `b${i}`, `f${i}`]);
    const chunks = await parsear([p("Results", "Heading1"), tabla(filas)]);
    const partes = tablas(chunks);
    expect(partes.length).toBeGreaterThan(1);
    partes.forEach((parte, k) => {
      expect(cuerpo(parte).split("\n")[0]).toBe("ID | Grupo | Basal | Final");
      expect(parte.page).toBe(1);
      expect(parte.section).toBe("Results");
      expect(parte.metadata).toEqual({ table_part: k + 1, table_parts: partes.length });
    });
    const texto = partes.map((c) => c.text).join("\n");
    for (let i = 1; i <= n; i++) {
      expect(texto.split(`paciente${String(i).padStart(3, "0")} |`).length - 1).toBe(1);
    }
  });

  test("una fila de título no sustituye a la cabecera en cada bloque", async () => {
    const n = 200;
    const filas: FilaFalsa[] = [
      [{ texto: "Table 1. Baseline characteristics", gridSpan: 4 }],
      ["ID", "Grupo", "Basal", "Final"],
    ];
    for (let i = 1; i <= n; i++) filas.push([`paciente${String(i).padStart(3, "0")}`, `grupo${i % 3}`, `b${i}`, `f${i}`]);
    const partes = tablas(await parsear([p("Results", "Heading1"), tabla(filas)]));
    expect(partes.length).toBeGreaterThan(1);
    for (const parte of partes) {
      const lineas = cuerpo(parte).split("\n");
      expect(lineas[0]).toBe("Table 1. Baseline characteristics");
      expect(lineas[1]).toBe("ID | Grupo | Basal | Final");
    }
    const texto = partes.map((c) => c.text).join("\n");
    for (let i = 1; i <= n; i++) {
      expect(texto.split(`paciente${String(i).padStart(3, "0")} |`).length - 1).toBe(1);
    }
  });

  test("título más nota más cabecera: los tres viajan en cada bloque", async () => {
    // La maqueta habitual de una tabla clínica: título y nota combinados a
    // todo el ancho, y debajo la fila que nombra las columnas.
    const filas: FilaFalsa[] = [
      [{ texto: "Table 2. Outcomes at 24 months", gridSpan: 4 }],
      [{ texto: "Values are mean (SD) unless stated", gridSpan: 4 }],
      ["ID", "Grupo", "Basal", "Final"],
    ];
    for (let i = 1; i <= 120; i++) filas.push([`p${String(i).padStart(3, "0")}`, `g${i % 3}`, `b${i}`, `f${i}`]);
    const partes = tablas(await parsear([tabla(filas)]));
    expect(partes.length).toBeGreaterThan(1);
    for (const parte of partes) {
      const lineas = cuerpo(parte).split("\n");
      expect(lineas.slice(0, 3)).toEqual([
        "Table 2. Outcomes at 24 months",
        "Values are mean (SD) unless stated",
        "ID | Grupo | Basal | Final",
      ]);
      expect(lineas[3].startsWith("p")).toBe(true);
    }
    const texto = partes.map((c) => c.text).join("\n");
    expect(texto.split("p001 |").length - 1).toBe(1);
  });

  test("una fila 0 con una sola celda con texto pero sin combinar NO asciende la primera fila de datos", async () => {
    // Tabla de dos columnas cuya cabecera solo nombra la primera: ["Fármaco", ""]
    // es cabecera de UNA fila. Con el criterio anterior (contar celdas no
    // vacías) la fila "Donepezilo | 10 mg" se duplicaba en cada bloque.
    const filas: FilaFalsa[] = [["Fármaco", ""], ["Donepezilo", "10 mg"]];
    for (let i = 1; i <= 150; i++) filas.push([`farmaco${String(i).padStart(3, "0")}`, `${i} mg`]);
    const partes = tablas(await parsear([tabla(filas)]));
    expect(partes.length).toBeGreaterThan(1);
    for (const parte of partes) expect(cuerpo(parte).split("\n")[0]).toBe("Fármaco");
    const texto = partes.map((c) => c.text).join("\n");
    expect(texto.split("Donepezilo | 10 mg").length - 1).toBe(1);
  });

  test("una cabecera normal sigue siendo una sola fila", async () => {
    const chunks = await parsear([
      tabla([["Variable", "Control", "MCI"], ["Edad", "72", "73"], ["MMSE", "28", "26"], ["Tau", "1.1", "2.4"]]),
    ]);
    expect(cuerpo(tablas(chunks)[0]).split("\n")).toEqual([
      "Variable | Control | MCI", "Edad | 72 | 73", "MMSE | 28 | 26", "Tau | 1.1 | 2.4",
    ]);
  });

  test("una tabla de una columna no pierde su primera fila", async () => {
    const chunks = await parsear([tabla([["Criterios de exclusión"], ["Ictus previo"], ["Epilepsia"]])]);
    expect(cuerpo(tablas(chunks)[0]).split("\n")).toEqual(["Criterios de exclusión", "Ictus previo", "Epilepsia"]);
  });

  test("la cabecera de dos pisos viaja entera, y una fila de datos con combinada no se toma por grupo", () => {
    const fila = (celdas: Array<[string, number]>): FilaTabla => {
      const reales = [];
      const cols: string[] = [];
      let desde = 0;
      for (const [texto, ancho] of celdas) {
        reales.push({ texto, desde, ancho });
        cols.push(texto, ...Array<string>(ancho - 1).fill(""));
        desde += ancho;
      }
      return { celdas: cols, reales };
    };
    // "" | Grupo (2) encima de Variable | Control | AD: dos filas de cabecera.
    expect(
      cabeceraDeTabla([
        fila([["", 1], ["Grupo", 2]]),
        fila([["Variable", 1], ["Control", 1], ["AD", 1]]),
        fila([["Edad", 1], ["72", 1], ["74", 1]]),
      ]),
    ).toBe(2);
    // Título y luego una fila con combinada pero SIN celdas vacías: no es una
    // cabecera de grupo, así que la cabecera es el título más esa primera fila
    // con varias celdas (la regla de siempre), y no tres filas.
    expect(
      cabeceraDeTabla([
        fila([["Table 1", 4]]),
        fila([["AD", 1], ["n=40", 2], ["0.03", 1]]),
        fila([["Control", 1], ["72.4", 1], ["72.4", 1], ["0.31", 1]]),
        fila([["MCI", 1], ["73.0", 1], ["72.9", 1], ["0.44", 1]]),
      ]),
    ).toBe(2);
  });

  test("una tabla anidada dentro de una celda no se pierde", async () => {
    const chunks = await parsear([
      tabla([
        ["Grupo", "Detalle"],
        ["Control", { texto: "Ver desglose", anidada: [["MMSE", "28"], ["CDR", "0"]] }],
      ]),
    ]);
    const filas = cuerpo(tablas(chunks)[0]).split("\n");
    expect(filas[1]).toBe("Control | Ver desglose MMSE | 28 CDR | 0");
  });

  test("el fichero real de python-docx se lee igual que el sintético", async () => {
    const { chunks, pages } = await parsearDocx(fixture("estudio.docx"), "estudio.docx");
    expect(pages).toBe(chunks.length);
    const texto = chunks.filter((c) => c.chunkType === "text");
    expect(texto.map((c) => c.section)).toEqual(["Introducción", "Métodos", "Results", "Discussion"]);
    const t = tablas(chunks);
    expect(t).toHaveLength(3);
    // Título combinado (gridSpan 4) + cabecera real, combinada en medio y fila normal.
    expect(t[0].text).toBe(
      "Results\nTable 1. Baseline characteristics by diagnostic group\n\n" +
        "Table 1. Baseline characteristics\nGrupo | Basal | Final | p\n" +
        "AD | n=40 (both visits) |  | 0.03\nControl | 72.4 | 72.4 | 0.31",
    );
    // gridBefore: la fila arranca en la segunda columna; sin rótulo heredado.
    expect(t[1].text).toBe("Results\n\nVariable | Control | AD\nEdad | 72 | 74\n | 28 | 21");
    // vMerge: el rótulo de grupo se repite en la segunda fila.
    expect(t[2].text).toBe("Results\n\nGrupo | Medida\nControl | MMSE 28\nControl | CDR 0");
  });
});
