// El prompt del sistema, sus herramientas y los formatos con los que el bucle
// habla con el modelo y con el usuario. Lo que se intenta romper: que la
// sección se cuele dentro de la cita o se duplique, que `fuentesPayload`
// cambie una clave que el frontend ya consume, que el inventario mienta con
// un índice vacío, y que el prompt exija una fórmula que el propio verificador
// no reconoce (cruce con lib/citas.ts, que es la misma regex del evaluador).
import { afterEach, describe, expect, test, vi } from "vitest";
import * as gateway from "../lib/gateway";
import { CITA_INVENTARIO, PATRON_CITA, pareceAbstencion, type Fragmento } from "../lib/citas";
import { EXTENDIDO, NORMAL } from "../lib/modos";
import { verificar } from "./verificador";
import { ABSTENCION_SEGURA } from "./revisor";
import {
  HERRAMIENTAS,
  HERRAMIENTA_BUSCAR,
  HERRAMIENTA_INVENTARIO,
  INSTRUCCION_SIN_DOCUMENTOS,
  NOMBRE_BUSCAR,
  NOMBRE_INVENTARIO,
  SYSTEM_PROMPT,
  VERSION_PROMPT,
  formatearResultados,
  fuentesPayload,
  textoDeInventario,
} from "./prompt";

afterEach(() => vi.restoreAllMocks());

function frag(id: string, extra: Partial<Fragmento> = {}): Fragmento {
  return {
    _id: id,
    text: `Texto del fragmento ${id}.`,
    sourceFile: "a.pdf",
    page: 12,
    documentType: "pdf",
    chunkType: "text",
    ...extra,
  };
}

// El carácter se escribe escapado para que este fichero tampoco lo contenga literal.
const GUION_LARGO = "\u2014";

// ---------------------------------------------------------------------------
// formatearResultados
// ---------------------------------------------------------------------------
describe("formatearResultados", () => {
  test("PDF con página y sección: la cita lleva la página y la sección va en su propia línea, fuera de los corchetes", () => {
    const salida = formatearResultados([frag("c1", { section: "Results" })]);

    expect(salida).toBe(
      ["--- Resultado 1 ---", "cita: [a.pdf, pág. 12]", "(sección del documento: Results)", "Texto del fragmento c1."].join("\n"),
    );
    // La sección nunca dentro de la cita.
    const citas = salida.match(PATRON_CITA) ?? [];
    expect(citas).toEqual(["[a.pdf, pág. 12]"]);
  });

  test("docx con sección: el localizador ES la sección y no se repite en otra línea", () => {
    const salida = formatearResultados([frag("d1", { sourceFile: "informe.docx", documentType: "docx", page: 4, section: "Métodos" })]);

    expect(salida).toBe(["--- Resultado 1 ---", "cita: [informe.docx, sección: Métodos]", "Texto del fragmento d1."].join("\n"));
    expect(salida.split("Métodos")).toHaveLength(2);
  });

  test("PDF sin número de página cae a la sección como localizador, también sin duplicarla", () => {
    const salida = formatearResultados([frag("p0", { page: 0, section: "Discussion" })]);

    expect(salida).toContain("cita: [a.pdf, sección: Discussion]");
    expect(salida).not.toContain("(sección del documento");
  });

  test("tablas: fila en hoja de cálculo, tabla en Word, y la sección sí acompaña", () => {
    const salida = formatearResultados([
      frag("t1", { sourceFile: "datos.xlsx", documentType: "xlsx", chunkType: "table", page: 30, section: "Hoja1" }),
      frag("t2", { sourceFile: "informe.docx", documentType: "docx", chunkType: "table", page: 2, section: "Resultados" }),
    ]);

    expect(salida).toContain("--- Resultado 1 ---\ncita: [datos.xlsx, fila 30]\n(sección del documento: Hoja1)");
    expect(salida).toContain("--- Resultado 2 ---\ncita: [informe.docx, tabla 2]\n(sección del documento: Resultados)");
    expect(salida.split("\n\n")).toHaveLength(2);
  });

  test("con referencia corta, la cita nombra la obra y no el archivo", () => {
    const salida = formatearResultados([frag("r1", { citation: "Allegri et al., 2023", page: 4 })]);

    expect(salida).toContain("cita: [Allegri et al., 2023, pág. 4]");
    expect(salida).not.toContain("a.pdf");
  });

  test("sin resultados devuelve la frase de reintento, sin cabeceras vacías", () => {
    expect(formatearResultados([])).toBe("Sin resultados para esta búsqueda. Prueba otra formulación de la consulta.");
  });

  test("cada cita generada casa con el patrón que usa el verificador", () => {
    const variados = [
      frag("a", { section: "Results" }),
      frag("b", { sourceFile: "n.txt", documentType: "txt", page: 7 }),
      frag("c", { sourceFile: "n.md", documentType: "md", page: 2, section: "Intro" }),
      frag("d", { sourceFile: "x.csv", documentType: "csv", chunkType: "table", page: 9 }),
    ];
    const salida = formatearResultados(variados);
    const citas = salida.match(PATRON_CITA) ?? [];
    expect(citas).toEqual(["[a.pdf, pág. 12]", "[n.txt, fragmento 7]", "[n.md, sección: Intro]", "[x.csv, fila 9]"]);
    expect(salida).not.toContain(GUION_LARGO);
  });
});

// ---------------------------------------------------------------------------
// fuentesPayload
// ---------------------------------------------------------------------------
describe("fuentesPayload", () => {
  test("devuelve exactamente las claves en snake_case que consume el frontend, más plan_items y grado", () => {
    const ch = frag("c1", {
      section: "Results",
      projectId: "p1",
      documentId: "d1",
      language: "en",
      sourcePages: [12, 13],
      score: 0.87,
      titulo: "Un paper",
      citation: "Allegri et al., 2023",
      doi: "10.1000/x",
      text: "x".repeat(300),
    });
    const [f] = fuentesPayload([ch], { c1: ["e0", "e2"] }, { c1: "directa" });

    expect(Object.keys(f).sort()).toEqual(
      [
        "source_file", "page", "project_id", "document_id", "section", "language", "document_type",
        "source_pages", "snippet", "score", "chunk_type", "title", "citation", "doi", "locator", "fuente",
        "plan_items", "grado",
      ].sort(),
    );
    expect(f).toEqual({
      source_file: "a.pdf",
      page: 12,
      project_id: "p1",
      document_id: "d1",
      section: "Results",
      language: "en",
      document_type: "pdf",
      source_pages: [12, 13],
      snippet: "x".repeat(240),
      score: 0.87,
      chunk_type: "text",
      title: "Un paper",
      citation: "Allegri et al., 2023",
      doi: "10.1000/x",
      locator: "pág. 12",
      fuente: "Allegri et al., 2023",
      plan_items: ["e0", "e2"],
      grado: "directa",
    });
    for (const k of Object.keys(f)) expect(k).toMatch(/^[a-z_]+$/);
  });

  test("los opcionales ausentes salen con el valor neutro de siempre, nunca undefined, y sin mapa ni grado salen [] y ''", () => {
    const [f] = fuentesPayload([frag("solo")], {}, {});

    expect(f).toMatchObject({
      project_id: null,
      document_id: null,
      section: "",
      language: "",
      source_pages: [],
      score: 0,
      title: "",
      citation: "",
      doi: "",
      fuente: "a.pdf",
      plan_items: [],
      grado: "",
    });
    for (const v of Object.values(f)) expect(v).not.toBeUndefined();
  });

  test("acepta cualquier iterable y conserva el orden de entrega", () => {
    const acumulado = new Map<string, Fragmento>([
      ["z", frag("z", { page: 3 })],
      ["a", frag("a", { page: 1 })],
    ]);
    const salida = fuentesPayload(acumulado.values(), { a: ["e1"] }, {});

    expect(salida.map((f) => f.page)).toEqual([3, 1]);
    expect(salida.map((f) => f.plan_items)).toEqual([[], ["e1"]]);
    expect(fuentesPayload([], {}, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// textoDeInventario
// ---------------------------------------------------------------------------
describe("textoDeInventario", () => {
  test("índice vacío: lo dice y no inventa conteos", () => {
    const salida = textoDeInventario({ archivos: [], total_chunks: 0, tipos: [], idiomas: [] });

    expect(salida).toBe("El índice está vacío: no hay ningún documento indexado.");
    // Adversarial: `archivos` ausente (un inventario viejo o roto) tampoco rompe.
    const roto = { total_chunks: 5 } as unknown as Parameters<typeof textoDeInventario>[0];
    expect(textoDeInventario(roto)).toBe("El índice está vacío: no hay ningún documento indexado.");
  });

  test("con documentos: conteo exacto citable como [inventario del índice], una línea por archivo, formatos e idiomas", () => {
    const salida = textoDeInventario({
      archivos: [
        { valor: "estudio.pdf", chunks: 6 },
        { valor: "folleto.pdf", chunks: 2 },
      ],
      total_chunks: 8,
      tipos: [{ valor: "pdf", chunks: 8 }],
      idiomas: [{ valor: "es", chunks: 6 }],
    });
    const lineas = salida.split("\n");

    expect(lineas[0]).toContain("Hay 2 documentos indexados y 8 fragmentos en total");
    expect(CITA_INVENTARIO.test(lineas[0])).toBe(true);
    expect(lineas[1]).toBe("- estudio.pdf: 6 fragmentos");
    expect(lineas[2]).toBe("- folleto.pdf: 2 fragmentos");
    expect(lineas[3]).toBe("Formatos: pdf (8)");
    expect(lineas[4]).toBe("Idiomas detectados: es (6)");
    expect(lineas[5]).toContain("Esto dice QUÉ documentos hay, no de qué tratan");
    expect(lineas).toHaveLength(6);
    // El inventario se cita con una forma que NO es una cita de fragmento: el
    // verificador la reconoce por CITA_INVENTARIO, no por PATRON_CITA.
    expect(salida.match(PATRON_CITA)).toBeNull();
  });

  test("sin idiomas detectados lo dice en vez de omitirlo; sin tipos no hay línea de formatos", () => {
    const salida = textoDeInventario({ archivos: [{ valor: "x.txt", chunks: 1 }], total_chunks: 1, tipos: [], idiomas: [] });

    expect(salida).toContain("Idiomas: sin detectar en ningún documento.");
    expect(salida).not.toContain("Formatos:");
    expect(salida).not.toContain(GUION_LARGO);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT, herramientas y fórmulas
// ---------------------------------------------------------------------------
describe("SYSTEM_PROMPT y herramientas", () => {
  test("ningún texto que llega al modelo lleva guion largo", () => {
    const textos = [
      SYSTEM_PROMPT,
      INSTRUCCION_SIN_DOCUMENTOS,
      NORMAL.instruccion,
      EXTENDIDO.instruccion,
      JSON.stringify(HERRAMIENTAS),
    ];
    for (const t of textos) expect(t).not.toContain(GUION_LARGO);
  });

  test("el prompt exige las fórmulas literales de ausencia y de no comprobado, y prohíbe el guion largo", () => {
    expect(SYSTEM_PROMPT).toContain('"No encuentro X en los documentos"');
    expect(SYSTEM_PROMPT).toContain("No pude comprobar X");
    expect(SYSTEM_PROMPT).toContain("U+2014");
    expect(SYSTEM_PROMPT).toContain(`\`${NOMBRE_BUSCAR}\``);
    expect(SYSTEM_PROMPT).toContain(`\`${NOMBRE_INVENTARIO}\``);
    // Dice la verdad sobre los idiomas: ya no afirma que todo se buscó en inglés.
    expect(SYSTEM_PROMPT).toContain("Cada resultado de arriba dice en qué idiomas se buscó");
    expect(SYSTEM_PROMPT).not.toMatch(/ya se buscaron también en inglés/);
    expect(VERSION_PROMPT).toBe("v4");
  });

  test("la fórmula de ausencia del prompt y la abstención segura las reconoce el verificador como abstención", () => {
    expect(pareceAbstencion("No encuentro la especificidad en los documentos.")).toBe(true);
    expect(pareceAbstencion(ABSTENCION_SEGURA)).toBe(true);
  });

  test("FALLO (prompt.ts:49-51 y 112-114 frente a lib/citas.ts PATRONES_ABSTENCION): la fórmula 'No pude comprobar X en los documentos' que el prompt exige para un punto en error NO es una abstención para el verificador; sin cita queda sin_cita, que es bloqueante, y la barrera tumba la respuesta. Arreglo: o el prompt usa una fórmula que casa con los patrones (p. ej. 'No hay datos comprobables de X: la búsqueda falló') o el verificador reconoce 'no pude comprobar' como declaración de ausencia (y el evaluador Python igual)", async () => {
    vi.spyOn(gateway, "completionJson").mockRejectedValue(new Error("no debería llamarse"));
    const frase = "No pude comprobar la especificidad en los documentos.";

    const informe = await verificar(frase, []);

    expect(pareceAbstencion(frase)).toBe(true);
    expect(informe.afirmaciones.map((a) => a.veredicto)).not.toContain("sin_cita");
    expect(informe.ok).toBe(true);
  });

  test("las dos herramientas tienen la forma de function tool de la API y solo `semantico` es obligatorio", () => {
    expect(HERRAMIENTAS).toEqual([HERRAMIENTA_BUSCAR, HERRAMIENTA_INVENTARIO]);
    expect(HERRAMIENTA_BUSCAR.type).toBe("function");
    expect(HERRAMIENTA_BUSCAR.function.name).toBe(NOMBRE_BUSCAR);
    expect(HERRAMIENTA_BUSCAR.function.parameters.required).toEqual(["semantico"]);
    const props = HERRAMIENTA_BUSCAR.function.parameters.properties;
    // Sin `limit`: se quitó del esquema de la herramienta (el bucle todavía lo ignora en claveDeLlamada, inofensivo).
    expect(Object.keys(props).sort()).toEqual(["document_id", "document_type", "language", "project_id", "punto", "semantico"]);
    expect(props.document_type.enum).toEqual(["pdf", "docx", "xlsx", "csv", "txt", "md"]);
    expect(props.language.enum).toEqual(["es", "en", "pt", "fr"]);
    expect(HERRAMIENTA_INVENTARIO.function.name).toBe(NOMBRE_INVENTARIO);
    expect(HERRAMIENTA_INVENTARIO.function.parameters).toEqual({ type: "object", properties: {} });
    // Los nombres son los que el bucle compara: distintos entre sí y sin espacios.
    expect(NOMBRE_BUSCAR).not.toBe(NOMBRE_INVENTARIO);
    expect(NOMBRE_BUSCAR).toMatch(/^[a-z_]+$/);
    expect(NOMBRE_INVENTARIO).toMatch(/^[a-z_]+$/);
  });

  test("la coda sin documentos no deja citar ni buscar", () => {
    expect(INSTRUCCION_SIN_DOCUMENTOS).toContain("sin citar nada");
    expect(INSTRUCCION_SIN_DOCUMENTOS).toContain("QUÉ ERES");
    expect(INSTRUCCION_SIN_DOCUMENTOS).not.toContain(NOMBRE_BUSCAR);
  });
});
