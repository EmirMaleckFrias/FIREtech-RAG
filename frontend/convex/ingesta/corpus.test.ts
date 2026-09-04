// @vitest-environment node
// Cinco PDF REALES de acceso abierto (PMC), cuatro de Alzheimer's & Dementia
// (Wiley: tres resúmenes de congreso y un artículo de investigación) y uno de
// Neurology. Son los que destaparon, el 4 sep 2026, la autoría con separadores
// de Wiley, las secciones falsas por formato y las columnas fundidas. Los
// sintéticos prueban cada regla; estos prueban que las reglas sobreviven a un
// archivo de verdad.
//
// Recortados con pdf-lib para que la carpeta entre en un repositorio público
// (menos de 600 KB en total): los resúmenes de congreso a su página 1 (las
// otras dos son figuras de 300 a 750 KB), Neurology a sus dos primeras, y el
// artículo de Wiley a las páginas 1, 3, 4 y 11 del original: portada, dos
// páginas del cuerpo a dos columnas (con "2 METHODS", "3 RESULTS" y el
// encabezado partido en dos líneas) y la de REFERENCES, con la cabecera
// corrida en tres de las cuatro para que se detecte como repetida.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as paper from "./paper";
import { parsearPdf } from "./pdf";
import type { ChunkParseado } from "./tipos";

function fixture(nombre: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nombre}`, import.meta.url)));
}

function frecuencias(chunks: ChunkParseado[]): Map<string, number> {
  const f = new Map<string, number>();
  for (const c of chunks) f.set(c.section, (f.get(c.section) ?? 0) + 1);
  return f;
}

const CASOS = [
  {
    fichero: "PMC13390017_p1-3-4-11.pdf",
    titulo: "Prognostic value of plasma %p-tau217 in cognitively unimpaired older adults",
    cita: "Silva-Rodríguez et al., 2026",
    doi: "10.1002/alz.71599",
    paginas: 4,
  },
  {
    fichero: "PMC12739034_p1.pdf",
    titulo:
      "Diagnostic and discriminative accuracy of plasma phosphorylated tau 217 for symptomatic Alzheimer’s disease in a Chinese cohort",
    cita: "Che et al., 2025",
    doi: "10.1002/alz70856_099222",
    paginas: 1,
  },
  {
    fichero: "PMC12777541_p1.pdf",
    titulo: "Head to head comparison of plasma phosphorylated tau 217 assays in real life memory clinic in Thailand",
    cita: "Luechaipanit et al., 2025",
    doi: "10.1002/alz70856_104726",
    paginas: 1,
  },
  {
    fichero: "PMC12741034.pdf",
    titulo:
      "Longitudinal analysis of human plasma biomarkers for Alzheimer’s disease: Phosphorylated Tau-217, Phosphorylated Tau-181, and Glial fibrillation acidic protein",
    cita: "Mugosa et al., 2025",
    doi: "10.1002/alz70856_102320",
    paginas: 1,
  },
  {
    fichero: "PMC13382852_p1-2.pdf",
    titulo: "Performance of Alzheimer Disease Plasma Biomarkers in Patients With Prion Diseases",
    cita: "Coysh et al., 2026",
    doi: "10.1212/WNL.0000000000214712",
    paginas: 2,
  },
];

describe.each(CASOS)("$fichero", ({ fichero, titulo, cita, doi, paginas }) => {
  test("título, cita, DOI y año son los del trabajo, y viajan en todos los fragmentos", async () => {
    const { chunks, pages } = await parsearPdf(fixture(fichero), fichero);
    expect(pages).toBe(paginas);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].titulo).toBe(titulo);
    expect(chunks.every((c) => c.citation === cita)).toBe(true);
    expect(chunks.every((c) => c.doi === doi)).toBe(true);
  });

  test("ninguna sección es la cola del título, una cabecera con letras espaciadas, una línea de autores o una línea de párrafo", async () => {
    const { chunks } = await parsearPdf(fixture(fichero), fichero);
    for (const seccion of new Set(chunks.map((c) => c.section))) {
      if (!seccion) continue;
      // Cola del título: un sufijo propio del título.
      expect(seccion !== titulo && titulo.endsWith(seccion), seccion).toBe(false);
      expect(paper.esLetrasEspaciadas(seccion), seccion).toBe(false);
      expect(paper.esLineaDeAutores(seccion), seccion).toBe(false);
      // Etiqueta de resumen estructurado seguida de frase, o renglón partido.
      expect(/^[A-Za-z]+:\s+\S+\s+\S+\s+\S+/.test(seccion), seccion).toBe(false);
      expect(/[\p{L}]-$/u.test(seccion), seccion).toBe(false);
    }
  });

  test("el contexto lleva el título una sola vez", async () => {
    const { chunks } = await parsearPdf(fixture(fichero), fichero);
    const cola = titulo.slice(-24);
    for (const chunk of chunks) {
      const cabecera = chunk.text.split("\n\n")[0];
      expect(cabecera.split(cola).length - 1, chunk.text.slice(0, 200)).toBeLessThanOrEqual(1);
    }
  });
});

describe("secciones de los documentos reales", () => {
  test("los resúmenes de congreso de Wiley: portada con el título y el resumen con 'Abstract'", async () => {
    for (const fichero of ["PMC12739034_p1.pdf", "PMC12777541_p1.pdf", "PMC12741034.pdf"]) {
      const { chunks } = await parsearPdf(fixture(fichero), fichero);
      const secciones = frecuencias(chunks);
      expect(secciones.has("Abstract"), fichero).toBe(true);
      // Las columnas de la portada (afiliaciones a la izquierda, resumen a la
      // derecha) ya no se funden: el texto del resumen no lleva afiliaciones.
      const resumen = chunks.filter((c) => c.section === "Abstract").map((c) => c.text).join("\n");
      expect(resumen, fichero).not.toMatch(/Correspondence|Email:/);
    }
  });

  test("el artículo de Wiley a dos columnas recupera sus encabezados numerados y descarta la bibliografía", async () => {
    const fichero = "PMC13390017_p1-3-4-11.pdf";
    const { chunks } = await parsearPdf(fixture(fichero), fichero);
    const secciones = [...frecuencias(chunks).keys()];
    // Con las columnas fundidas, "2  METHODS  2. Interpretation: ..." no era
    // sección y 35 de 49 fragmentos llevaban "2.3 Plasma biomarker measurements".
    // "2 METHODS" y "3 RESULTS" van seguidos de su primera subsección sin texto
    // entre medias, así que no tienen fragmento propio: lo que se comprueba es
    // que cada subsección numerada de las dos columnas es una sección.
    for (const subseccion of [
      /^2\.1\s+Study participants$/, /^2\.2\s+Clinical and neuropsychological assessment$/,
      /^2\.3\s+Plasma biomarker measurements$/, /^2\.6\s+Statistical analysis$/,
      /^2\.7\s+Replication analyses$/,
    ]) {
      expect(secciones.some((s) => subseccion.test(s)), String(subseccion)).toBe(true);
    }
    expect(secciones.some((s) => /^2\.3 Plasma biomarker measurements/.test(s) && frecuencias(chunks).get(s)! > 10)).toBe(false);
    // El encabezado partido en dos líneas es uno solo.
    expect(
      secciones.some((s) => /^3\.1\s+Longitudinal trajectories of cognition across %p-tau217 groups$/.test(s)),
    ).toBe(true);
    expect(secciones).not.toContain("%p-tau217 groups");
    const todo = chunks.map((c) => c.text).join("\n");
    // La bibliografía (tras "REFERENCES", en la última página del recorte) no se
    // indexa; la cabecera corrida y el folio tampoco.
    expect(secciones.some((s) => /^REFERENCES/.test(s))).toBe(false);
    expect(chunks.filter((c) => c.page === 4).every((c) => !/^\d+\.\s+[A-Z][a-z]+ [A-Z]{1,3},/.test(c.text))).toBe(true);
    expect(todo).not.toMatch(/\b\d+ of 12\b/);
    expect(todo).not.toContain("SILVA-RODRÍGUEZ ET AL.");
  });

  test("Neurology: el resumen estructurado y las secciones del cuerpo", async () => {
    const { chunks } = await parsearPdf(fixture("PMC13382852_p1-2.pdf"), "PMC13382852_p1-2.pdf");
    const secciones = frecuencias(chunks);
    expect(secciones.has("Methods")).toBe(true);
    expect(secciones.has("Results")).toBe(true);
    expect(secciones.has("Introduction")).toBe(true);
    expect(secciones.has("in Patients With Prion Diseases")).toBe(false);
  });
});
