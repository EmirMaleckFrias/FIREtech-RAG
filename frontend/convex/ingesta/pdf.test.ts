// @vitest-environment node
// PDF de punta a punta: se genera un PDF de verdad y se parsea con el camino
// real (pdf.js vía unpdf), que es la única forma de comprobar que las
// heurísticas sobreviven a un archivo. Port de test_generic_chunking.py (parte
// PDF), test_parse_pdf_paper.py y los casos de punta a punta de test_paper.py.
import { describe, expect, test } from "vitest";
import { OVERLAP_TOKENS, estTokens } from "./chunking";
import { extraerLineas, parsearPdf } from "./pdf";
import { escribirPdf, fila, type LineaFalsa } from "./pdfFalso.test-util";
import type { ChunkParseado } from "./tipos";

const TITULO = "Cerebrospinal fluid biomarkers in early Alzheimer disease";

const PORTADA: LineaFalsa[] = [
  [TITULO, 17],
  ["Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11],
  ["doi:10.3233/JAD-220123  J Alzheimers Dis 2023", 8],
];

function texto(chunks: ChunkParseado[]): string {
  return chunks.map((c) => c.text).join("\n");
}

/** Texto del chunk sin las líneas de contexto (título y sección). */
function cuerpo(chunk: ChunkParseado): string {
  const i = chunk.text.indexOf("\n\n");
  return i >= 0 ? chunk.text.slice(i + 2) : chunk.text;
}

function deSeccion(chunks: ChunkParseado[], seccion: string): ChunkParseado[] {
  return chunks.filter((c) => c.section === seccion);
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

async function parsear(paginas: LineaFalsa[][], nombre = "articulo.pdf") {
  const { chunks } = await parsearPdf(escribirPdf(paginas), nombre);
  return chunks;
}

describe("párrafos reconstruidos a partir de líneas físicas", () => {
  test("las líneas físicas se unen en párrafos: oración partida y palabra cortada", async () => {
    const chunks = await parsear([[
      ...PORTADA,
      ["Methods", 12],
      ["We recruited 120 participants aged between 55 and 85 years between 2018 and", 10],
      ["2021. Volumetric MRI focused on the hippocam-", 10],
      ["pal formation and adjacent cortex.", 10],
    ]]);
    const metodos = deSeccion(chunks, "Methods");
    expect(metodos).toHaveLength(1);
    expect(metodos[0].text).toContain("between 2018 and 2021.");
    expect(metodos[0].text).toContain("hippocampal formation");
    expect(metodos[0].text).not.toContain("hippocam-");
    expect(metodos[0].text).not.toContain("and\n\n2021");
  });

  test("una cifra no se separa de su unidad", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["Mean amyloid beta 42 was 542", 10],
      ["pg/mL in the impaired group and 912 pg/mL in controls.", 10],
    ]]);
    expect(texto(chunks)).toContain("542 pg/mL in the impaired group");
  });

  test("un párrafo que cruza de página conserva las dos páginas", async () => {
    const chunks = await parsear([
      [...PORTADA, ["Methods", 12], ["Participants were enrolled at three memory clinics between 2018 and", 10]],
      [["2021. Volumetric MRI focused on the hippocam-", 10], ["pal formation and adjacent cortex.", 10]],
    ]);
    const metodos = deSeccion(chunks, "Methods");
    expect(metodos).toHaveLength(1);
    expect(metodos[0].text).toContain("between 2018 and 2021.");
    expect(metodos[0].text).toContain("hippocampal");
    expect(metodos[0].page).toBe(1);
    expect(metodos[0].sourcePages).toEqual([1, 2]);
  });

  test("el guion se conserva cuando forma parte del término", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Methods", 12],
      ["Prior treatment with anti-", 10], ["Alzheimer agents and any COVID-", 10],
      ["19 vaccination were recorded at baseline.", 10],
    ]]);
    expect(texto(chunks)).toContain("anti-Alzheimer agents");
    expect(texto(chunks)).toContain("COVID-19 vaccination");
  });

  test("el guion del compuesto sobrevive al corte de línea, y la palabra partida se une", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Methods", 12],
      ["Chronic use of anti-", 10], ["inflammatory drugs and beta-", 10],
      ["amyloid targeting agents was recorded in the hippocam-", 10], ["pal subgroup.", 10],
    ]]);
    expect(texto(chunks)).toContain("anti-inflammatory drugs");
    expect(texto(chunks)).toContain("beta-amyloid targeting");
    expect(texto(chunks)).toContain("hippocampal subgroup");
  });

  test("un decimal a final de línea no cierra la oración", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["The mean difference was 0.31", 10], ["Compared with controls it was small.", 10],
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    expect(cuerpo(resultados)).toBe("The mean difference was 0.31 Compared with controls it was small.");
  });

  test("una oración con cita Vancouver en superíndice cierra el párrafo", async () => {
    // El superíndice va pegado al punto, más pequeño y elevado, como lo
    // extrae pdf.js de una revista médica: "decline.12,13".
    const chunks = await parsear([[
      ...PORTADA, ["Discussion", 12],
      { size: 10, segmentos: [
        { texto: "Higher tau load was associated with faster cognitive decline." },
        { texto: "12,13", pegado: true, size: 6, elevar: 4 },
      ] },
      { size: 10, segmentos: [
        { texto: "The association was independent of amyloid burden." },
        { texto: "14", pegado: true, size: 6, elevar: 4 },
      ] },
      ["Replication in an independent cohort is still needed.", 10],
    ]]);
    const [discusion] = deSeccion(chunks, "Discussion");
    const parrafos = cuerpo(discusion).split("\n\n");
    expect(parrafos).toHaveLength(3);
    expect(parrafos[0]).toBe("Higher tau load was associated with faster cognitive decline.12,13");
  });

  test("un subtítulo no canónico no se come la primera frase", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Methods", 12],
      ["Participants were recruited from three memory clinics between 2018 and 2021.", 10],
      ["Statistical analysis", 10],
      ["Group differences were tested with analysis of variance and chi square.", 10],
    ]]);
    const [metodos] = deSeccion(chunks, "Methods");
    const parrafos = cuerpo(metodos).split("\n\n");
    expect(parrafos).toContain("Statistical analysis");
    expect(parrafos).toContain("Group differences were tested with analysis of variance and chi square.");
  });

  test("un subtítulo en negrita al cuerpo de letra del texto abre sección", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Methods", 12],
      ["Participants were recruited from three memory clinics.", 10],
      { size: 10, segmentos: [{ texto: "Statistical analysis", negrita: true }] },
      ["Group differences were tested with analysis of variance.", 10],
    ]]);
    expect(deSeccion(chunks, "Statistical analysis")).toHaveLength(1);
    expect(deSeccion(chunks, "Statistical analysis")[0].text).toContain("analysis of variance");
    expect(deSeccion(chunks, "Methods")[0].text).not.toContain("analysis of variance");
  });
});

describe("tablas dentro del PDF, por geometría", () => {
  test("una tabla conserva una fila por párrafo y la prosa que la presenta sigue entera", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["Baseline characteristics of the 120 participants are summarized in", 10],
      ["Table 1. The three groups did not differ in age or sex distribution.", 10],
      ["Table 1. Baseline characteristics", 10],
      fila(["Variable", "Control", "MCI", "AD", "p"]),
      fila(["Age, years", "72.4 (6.1)", "72.4 (6.1)", "74.0 (5.8)", "0.31"]),
      fila(["MMSE", "28.1 (1.2)", "26.0 (2.1)", "21.3 (3.4)", "<0.001"]),
      fila(["Amyloid beta 42", "912 (210)", "640 (180)", "542 (150)", "<0.001"]),
      ["Values are mean (SD) unless stated.", 10],
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    const parrafos = cuerpo(resultados).split("\n\n");
    for (const f of [
      "Table 1. Baseline characteristics",
      "Variable  Control  MCI  AD  p",
      "Age, years  72.4 (6.1)  72.4 (6.1)  74.0 (5.8)  0.31",
      "MMSE  28.1 (1.2)  26.0 (2.1)  21.3 (3.4)  <0.001",
      "Amyloid beta 42  912 (210)  640 (180)  542 (150)  <0.001",
      "Values are mean (SD) unless stated.",
    ]) {
      expect(parrafos, JSON.stringify(parrafos)).toContain(f);
    }
    expect(parrafos).toContain(
      "Baseline characteristics of the 120 participants are summarized in " +
        "Table 1. The three groups did not differ in age or sex distribution.",
    );
  });

  test("una tabla sin números conserva sus cinco filas", async () => {
    // La heurística por densidad de cifras no veía esta tabla: la de estudios
    // incluidos de cualquier revisión sistemática.
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      fila(["Study", "Design", "Population", "Outcome", "Risk of bias"]),
      fila(["Smith 2019", "Cohort", "Memory clinic", "Conversion", "Low"]),
      fila(["Garcia 2021", "Case control", "Community", "Mortality", "Some concerns"]),
      fila(["Nakamura 2020", "Trial", "Primary care", "Cognition", "High"]),
      fila(["Rosario 2022", "Cohort", "Hospital", "Function", "Low"]),
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    const parrafos = cuerpo(resultados).split("\n\n");
    expect(parrafos).toHaveLength(5);
    expect(parrafos[0]).toBe("Study  Design  Population  Outcome  Risk of bias");
    expect(parrafos[2]).toBe("Garcia 2021  Case control  Community  Mortality  Some concerns");
  });

  test("una tabla de dos columnas también es tabla: las filas se alinean entre sí", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      { size: 10, segmentos: [{ texto: "Variable" }, { texto: "Control", x: 300 }] },
      { size: 10, segmentos: [{ texto: "Edad" }, { texto: "72.4", x: 300 }] },
      { size: 10, segmentos: [{ texto: "MMSE" }, { texto: "28.1", x: 300 }] },
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    expect(cuerpo(resultados).split("\n\n")).toEqual(["Variable  Control", "Edad  72.4", "MMSE  28.1"]);
  });

  test("la prosa con muchas cifras no se toma por una tabla", async () => {
    // El adversarial: un párrafo de Resultados lleno de cifras no puede
    // partirse por parecer una tabla ni separar una cifra de su unidad.
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["We recruited 120 participants aged between 55 and 85 years between 2018 and", 10],
      ["2021. The mean amyloid beta 42 concentration was 542", 10],
      ["pg/mL in the impaired group and 912 pg/mL in the 45 controls.", 10],
      ["Los 72 pacientes recibieron 10 mg", 10],
      ["de donepezilo al dia durante todo el periodo de seguimiento del estudio.", 10],
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    expect(cuerpo(resultados).split("\n\n")).toEqual([
      "We recruited 120 participants aged between 55 and 85 years between " +
        "2018 and 2021. The mean amyloid beta 42 concentration was 542 pg/mL " +
        "in the impaired group and 912 pg/mL in the 45 controls.",
      "Los 72 pacientes recibieron 10 mg de donepezilo al dia durante todo el periodo de seguimiento del estudio.",
    ]);
  });

  test("una cabecera de columnas en negrita no se convierte en sección", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["Baseline characteristics of the participants are shown below by group.", 10],
      { size: 10, segmentos: [
        { texto: "Variable", negrita: true }, { texto: "Control", x: 200, negrita: true },
        { texto: "AD", x: 300, negrita: true },
      ] },
      fila(["Edad", "72.4", "74.0"]),
    ]]);
    const [resultados] = deSeccion(chunks, "Results");
    expect(chunks.some((c) => c.section.startsWith("Variable"))).toBe(false);
    expect(cuerpo(resultados).split("\n\n")).toEqual([
      "Baseline characteristics of the participants are shown below by group.",
      "Variable  Control  AD",
      "Edad  72.4  74.0",
    ]);
  });

  test("el rótulo partido de una fila se recompone aunque la siguiente sea fila", async () => {
    const { paginas } = await extraerLineas(escribirPdf([[
      ["hippocam-", 10],
      fila(["pal volume", "3.2 cm3", "4.1 cm3"]),
      fila(["MMSE", "28", "21"]),
    ]]));
    expect(paginas[0].map((l) => l.esFila)).toEqual([false, true, true]);
    const chunks = await parsear([[
      ["hippocam-", 10],
      fila(["pal volume", "3.2 cm3", "4.1 cm3"]),
      fila(["MMSE", "28", "21"]),
    ]]);
    // Sin título ni sección no hay líneas de contexto: el texto es el cuerpo.
    expect(chunks[0].text.split("\n\n")).toEqual(["hippocampal volume  3.2 cm3  4.1 cm3", "MMSE  28  21"]);
  });

  test("un encabezado con el folio a la derecha no es una fila", async () => {
    const { paginas } = await extraerLineas(escribirPdf([[
      { size: 12, segmentos: [{ texto: "3 RESULTS" }, { texto: "5", x: 540 }] },
      ["Mean amyloid beta 42 was 542 pg/mL in the impaired group.", 10],
    ]]));
    expect(paginas[0][0].texto).toBe("3 RESULTS  5");
    expect(paginas[0][0].esFila).toBe(false);
  });
});

describe("contexto, solape y secciones", () => {
  test("cada chunk lleva título y sección dentro del texto, y la cita en el payload", async () => {
    const chunks = await parsear([[
      ...PORTADA,
      ["Methods", 12], ["We recruited 120 participants from three memory clinics.", 10],
      ["Results", 12], ["Mean amyloid beta 42 was 542 pg/mL in the impaired group.", 10],
      ["Discussion", 12], ["These findings may indicate an earlier onset than assumed.", 10],
    ]]);
    for (const seccion of ["Methods", "Results", "Discussion"]) {
      const [chunk] = deSeccion(chunks, seccion);
      expect(chunk.text.startsWith(`${TITULO}\n${seccion}\n\n`), chunk.text).toBe(true);
    }
    expect(chunks.every((c) => c.titulo === TITULO)).toBe(true);
    expect(chunks.every((c) => c.citation === "Allegri et al., 2023")).toBe(true);
    expect(chunks.every((c) => c.doi === "10.3233/JAD-220123")).toBe(true);
    expect(chunks.every((c) => c.documentType === "pdf" && c.chunkType === "text")).toBe(true);
  });

  test("el título no se repite cuando ya es la sección vigente", async () => {
    const chunks = await parsear([[
      ["Tau load and cognition", 16],
      ["Higher tau load was associated with faster cognitive decline.", 10],
    ]]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Tau load and cognition");
    expect(chunks[0].text.split("Tau load and cognition").length - 1).toBe(1);
    expect(chunks[0].text.startsWith("Tau load and cognition\n\nHigher tau")).toBe(true);
  });

  test("sin título ni sección el texto queda limpio y no se inventa sección", async () => {
    const chunks = await parsear([[
      ["Primera linea del documento sin ninguna estructura visible.", 10],
      ["Segunda linea que continua el mismo parrafo de siempre.", 10],
      ["Tercera linea con mas contenido corrido y sin titulares.", 10],
    ]], "plano.pdf");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.startsWith("Primera linea")).toBe(true);
    expect(chunks.every((c) => c.section === "")).toBe(true);
    expect(chunks[0].titulo).toBe("");
    expect(chunks[0].citation).toBe("");
  });

  test("los chunks se solapan dentro de una sección y no entre secciones", async () => {
    const oraciones: LineaFalsa[] = Array.from({ length: 44 }, (_, i) => [
      `Methods sentence ${String(i).padStart(3, "0")} describes one recruitment step of the cohort in detail.`,
      10,
    ]);
    const chunks = await parsear([
      [...PORTADA, ["Methods", 12], ...oraciones.slice(0, 22)],
      [...oraciones.slice(22), ["Results", 12], ["Mean amyloid beta 42 was 542 pg/mL.", 10]],
    ]);
    const deMetodos = deSeccion(chunks, "Methods");
    expect(deMetodos.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < deMetodos.length; i++) {
      const cola = solape(deMetodos[i - 1], deMetodos[i]);
      expect(cola.length).toBeGreaterThan(0);
      const tokens = cola.reduce((s, p) => s + estTokens(p), 0);
      expect(tokens).toBeGreaterThanOrEqual(OVERLAP_TOKENS / 2);
      expect(tokens).toBeLessThanOrEqual(2 * OVERLAP_TOKENS);
      expect(cola.length).toBeLessThan(cuerpo(deMetodos[i - 1]).split("\n\n").length);
    }
    const [resultados] = deSeccion(chunks, "Results");
    expect(resultados.text).not.toContain("recruitment step");
    const todo = texto(chunks);
    for (let i = 0; i < 44; i++) expect(todo).toContain(`sentence ${String(i).padStart(3, "0")}`);
  });

  test("cada fragmento sabe de qué sección sale y la bibliografía no se indexa", async () => {
    const paginas: LineaFalsa[][] = [
      [
        ["Downloaded from journals.example.org on 12 July 2026", 7],
        [TITULO, 17], ["Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11],
        ["Department of Neurology, INTEC, Santo Domingo", 8.5],
        ["doi:10.3233/JAD-220123  J Alzheimers Dis 2023", 8],
        ["Abstract", 12],
        ["Amyloid beta 42 decreases in the earliest stages of the disease, while", 10],
        ["total tau and phosphorylated tau increase progressively over time.", 10],
        ["Introduction", 12],
        ["Previous work by other groups suggested a link that remained unproven", 10],
        ["across several independent cohorts studied during the last decade.", 10],
        ["Methods", 12],
        ["We recruited 120 participants aged between 55 and 85 years from three", 10],
        ["memory clinics, with follow up visits scheduled every six months.", 10],
        ["Results", 12],
        ["Mean amyloid beta 42 was 534 pg per mL in the impaired group and 912", 10],
        ["pg per mL in controls, a difference that reached statistical relevance.", 10],
      ],
      [
        ["Discussion", 12],
        ["These findings may indicate an earlier onset than previously assumed,", 10],
        ["although the sample size limits how far the claim can be extended.", 10],
        ["References", 12],
        ["1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 9],
        ["2. Garcia L. Tau propagation across cortical networks. Neuron 2021.", 9],
        ["3. Nakamura T. Longitudinal cohorts in dementia research. 2020.", 9],
      ],
    ];
    const bytes = escribirPdf(paginas);
    const { chunks, pages } = await parsearPdf(bytes, "biomarkers.pdf");
    expect(pages).toBe(2);
    const porSeccion = new Map(chunks.map((c) => [c.section, c.text]));
    expect(porSeccion.get("Results")).toContain("534 pg per mL");
    expect(porSeccion.get("Methods")).toContain("120 participants");
    expect(porSeccion.get("Discussion")).not.toContain("534 pg");
    const todo = texto(chunks);
    expect(todo).not.toContain("Smith J");
    expect(todo).not.toContain("Tau propagation across cortical networks");
    expect(chunks.some((c) => c.section === "References")).toBe(false);
    expect(todo).not.toContain("Downloaded from");
    expect(chunks.every((c) => c.citation === "Allegri et al., 2023")).toBe(true);
    // Y se pueden conservar las referencias si se piden.
    const conRefs = await parsearPdf(bytes, "biomarkers.pdf", { omitirReferencias: false });
    expect(texto(conRefs.chunks)).toContain("Smith J");
  });

  test("las cabeceras repetidas de la revista no entran al índice", async () => {
    const cuerpos = [
      "Plasma p-tau217 reached an area under the curve of 0.93 overall.",
      "Sensitivity was 88 percent at the predefined cutoff of 2.4 pg per mL.",
      "Specificity reached 91 percent in the independent validation cohort.",
      "No differences were observed between the two recruiting centres.",
    ];
    const chunks = await parsear(
      cuerpos.map((c): LineaFalsa[] => [
        ["Alzheimers Dement 2021;17:1145-1157", 7], ["Results", 12], [c, 10], ["page footer 1", 7],
      ]),
    );
    expect(texto(chunks)).not.toContain("1145-1157");
    expect(texto(chunks)).toContain("0.93");
  });

  test("una sección no se arrastra por lo que no describe", async () => {
    // El fallo del índice de producción del 2 sep 2026: una guía de 4 páginas
    // quedó con "sección: Introducción" en TODOS sus fragmentos.
    const chunks = await parsear([[
      ["Guia estrategica del mazo", 18],
      ["Introduccion", 13],
      ["Esta guia analiza el mazo y como jugarlo en cada fase.", 10],
      ["Composicion del Mazo", 13],
      ["El mazo lo forman ocho cartas con roles complementarios.", 10],
      ["Estrategia Ofensiva", 13],
      ["El empuje principal se arma detras de la unidad tanque.", 10],
    ]], "guia.pdf");
    const seccionDe = (fragmento: string) => chunks.find((c) => c.text.includes(fragmento))?.section;
    expect(seccionDe("ocho cartas")).toBe("Composicion del Mazo");
    expect(seccionDe("empuje principal")).toBe("Estrategia Ofensiva");
    expect(seccionDe("analiza el mazo")).toBe("Introduccion");
  });

  test("acentos en el PDF", async () => {
    const chunks = await parsear([[
      ["Métodos", 12],
      ["La concentración de amiloide beta también disminuye según el estudio realizado.", 10],
    ]]);
    expect(chunks[0].section).toBe("Métodos");
    expect(chunks[0].text).toContain("concentración");
  });
});

describe("artículos maquetados como Wiley", () => {
  test("con cabeceras al cuerpo de letra se secciona por el nombre y la cita es la del trabajo", async () => {
    const chunks = await parsear([
      [
        ["Plasma p-tau217 as a marker of amyloid pathology", 17],
        ["van der Flier WM, Scheltens P, Jack CR Jr", 11],
        ["Department of Neurology, Amsterdam UMC", 8.5],
        ["doi:10.1002/alz.12345  Alzheimers Dement 2023", 8],
        ["Abstract", 10],
        ["Plasma p-tau217 separated amyloid positive from negative participants.", 10],
        ["1 | INTRODUCTION", 10],
        ["Earlier reports suggested that plasma markers could track pathology.", 10],
        ["2 | METHODS", 10],
        ["We recruited 240 participants from two memory clinics in Amsterdam.", 10],
        ["3 | RESULTS", 10],
        ["Plasma p-tau217 reached an area under the curve of 0.93 overall.", 10],
      ],
      [
        ["4 | DISCUSSION", 10],
        ["These results may indicate that plasma markers can replace PET scans.", 10],
        ["5 | REFERENCES", 10],
        ["1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 10],
        ["2. Garcia L. Tau propagation across cortical networks. Neuron 2021.", 10],
      ],
    ], "wiley.pdf");
    const seccionDe = (fragmento: string) => chunks.find((c) => c.text.includes(fragmento))?.section;
    expect(seccionDe("240 participants")).toBe("2 | METHODS");
    expect(seccionDe("0.93 overall")).toBe("3 | RESULTS");
    expect(seccionDe("replace PET scans")).toBe("4 | DISCUSSION");
    expect(chunks.find((c) => c.text.includes("PET scans"))?.text).not.toContain("0.93");
    const todo = texto(chunks);
    expect(todo).not.toContain("Smith J");
    expect(todo).not.toContain("Tau propagation");
    const titulo = "Plasma p-tau217 as a marker of amyloid pathology";
    // Ningún fragmento del CUERPO lleva el título como sección; la portada sí,
    // porque es la sección que fija el bloque del título (antes no lo llevaba
    // solo porque la línea de autores se colaba como encabezado).
    for (const fragmento of ["240 participants", "0.93 overall", "replace PET scans", "track pathology"]) {
      expect(seccionDe(fragmento), fragmento).not.toBe(titulo);
    }
    expect(chunks.every((c) => c.citation === "van der Flier et al., 2023")).toBe(true);
    expect(chunks[0].titulo).toBe(titulo);
  });

  test("una portada con título partido, autores con barras y dirección se cita por su primer autor", async () => {
    const chunks = await parsear([[
      ["Blood biomarkers for Alzheimer disease:", 17],
      ["Limitations and Opportunities", 17],
      ["Wiesje M. van der Flier1 | Philip Scheltens1 | Frederik Barkhof2", 11],
      ["Boston, MA 02115, USA", 8.5],
      ["doi:10.1002/alz.12345  Alzheimers Dement 2023", 8],
      ["Abstract", 10],
      ["Blood markers separated amyloid positive from negative participants.", 10],
      ["1 | INTRODUCTION", 10],
      ["Earlier reports suggested that plasma markers could track pathology.", 10],
      ["5 | REFERENCES", 10],
      ["1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 10],
    ]], "portada.pdf");
    expect(chunks[0].titulo).toBe("Blood biomarkers for Alzheimer disease: Limitations and Opportunities");
    expect(chunks.every((c) => c.citation === "van der Flier et al., 2023")).toBe(true);
    expect(texto(chunks)).not.toContain("Amyloid imaging in preclinical");
  });
});

describe("lo que enseñaron cinco PDF reales (4 sep 2026)", () => {
  test("una etiqueta en negrita al principio de un párrafo no convierte la línea en encabezado", async () => {
    // "Conclusion:" va en negrita y el resto no: con "algún item en negrita"
    // la línea entera contaba como negrita y salía como sección.
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["Plasma p-tau217 outperformed other biomarkers in discriminating AD patients.", 10],
      { size: 10, segmentos: [
        { texto: "Conclusion:", negrita: true },
        { texto: " Plasma p-tau217 demonstrated exceptional diagnostic accuracy for AD", pegado: true },
      ] },
      ["even at early stages in the Chinese population.", 10],
    ]]);
    expect(chunks.some((c) => c.section.startsWith("Conclusion"))).toBe(false);
    const [resultados] = deSeccion(chunks, "Results");
    expect(cuerpo(resultados)).toContain("Conclusion: Plasma p-tau217 demonstrated exceptional diagnostic accuracy for AD even at early stages");
  });

  test("las líneas del bloque del título nunca son sección, y el título no se repite en el contexto", async () => {
    const chunks = await parsear([[
      ["DOI: 10.1002/alz70856_102320", 7],
      { size: 9, segmentos: [{ texto: "B I O M A R K E R S", negrita: true }] },
      { size: 17.9, segmentos: [{ texto: "Longitudinal analysis of human plasma biomarkers for", negrita: true }] },
      { size: 17.9, segmentos: [{ texto: "Alzheimer disease: Phosphorylated Tau-217, Phosphorylated", negrita: true }] },
      { size: 17.9, segmentos: [{ texto: "Tau-181, and Glial fibrillation acidic protein", negrita: true }] },
      { size: 12, segmentos: [{ texto: "MayaRae N Mugosa1", negrita: true }, { texto: "Jefferson W Kinney2", x: 200, negrita: true }] },
      ["1UNLV, Las Vegas, NV, USA", 7],
      { size: 10, segmentos: [{ texto: "Abstract", negrita: true }] },
      ["Background: Alzheimer disease is a progressive neurodegenerative disease that affects memory.", 9],
      ["Results: Concentrations of these proteins were analyzed for differences between groups.", 9],
    ]]);
    const titulo =
      "Longitudinal analysis of human plasma biomarkers for Alzheimer disease: Phosphorylated Tau-217, Phosphorylated Tau-181, and Glial fibrillation acidic protein";
    expect(chunks[0].titulo).toBe(titulo);
    expect(chunks.every((c) => c.citation === "Mugosa et al., 2025" || c.citation === "")).toBe(true);
    const secciones = new Set(chunks.map((c) => c.section));
    expect(secciones.has("Tau-181, and Glial fibrillation acidic protein")).toBe(false);
    expect(secciones.has("B I O M A R K E R S")).toBe(false);
    expect(secciones.has("MayaRae N Mugosa1  Jefferson W Kinney2")).toBe(false);
    expect(secciones.has("Abstract")).toBe(true);
    // La portada lleva el título entero como sección y `conContexto` lo deja una vez.
    const portada = chunks.find((c) => c.text.includes("UNLV"));
    expect(portada?.section).toBe(titulo);
    expect(portada?.text.split("Glial fibrillation acidic protein").length).toBe(2);
  });

  test("un encabezado partido en dos líneas es una sola sección", async () => {
    const chunks = await parsear([[
      ...PORTADA, ["Results", 12],
      ["Baseline values are reported first.", 10],
      // El número y el texto son items distintos, como en Wiley (pdf.js
      // colapsa los espacios dobles dentro de un mismo item).
      { size: 12, segmentos: [{ texto: "3.2", negrita: true }, { texto: "Longitudinal cognitive trajectories of", x: 90, negrita: true }] },
      { size: 12, segmentos: [{ texto: "%p-tau217 groups", negrita: true }] },
      ["Cognitive decline in the Elevated and High groups was paralleled by slower gait.", 10],
      { size: 12, segmentos: [{ texto: "3.3", negrita: true }, { texto: "Clinical progression", x: 90, negrita: true }] },
      ["Progression to dementia was more frequent in the High group.", 10],
    ]]);
    const seccionDe = (fragmento: string) => chunks.find((c) => c.text.includes(fragmento))?.section;
    expect(seccionDe("slower gait")).toMatch(/^3\.2\s+Longitudinal cognitive trajectories of %p-tau217 groups$/);
    expect(seccionDe("more frequent")).toMatch(/^3\.3\s+Clinical progression$/);
    expect(chunks.some((c) => c.section === "%p-tau217 groups")).toBe(false);
  });

  test("el folio de la cabecera no entra al índice", async () => {
    const chunks = await parsear([[
      { size: 7, segmentos: [{ texto: "SILVA ET AL.", negrita: true }, { texto: "3 of 12", x: 520 }] },
      ...PORTADA, ["Results", 12],
      ["Mean amyloid beta 42 was 542 pg/mL in the impaired group.", 10],
    ]]);
    expect(texto(chunks)).not.toContain("3 of 12");
    expect(texto(chunks)).toContain("542 pg/mL");
  });
});

describe("dos columnas", () => {
  // Frases de la misma longitud (solo cambia una cifra) para que el margen
  // derecho de la columna quede recto, como en el texto justificado de una
  // revista.
  const izquierda = (n: number) => `Left column sentence ${n} describes the cohort.`;
  const derecha = (n: number) => `Right column sentence ${n} reports the results.`;

  function paginaADosColumnas(): LineaFalsa[] {
    const lineas: LineaFalsa[] = [
      { size: 7, segmentos: [{ texto: "SMITH ET AL." }, { texto: "3 of 12", x: 520 }] },
      // Encabezado numerado de la izquierda a la misma altura que una línea
      // de la derecha: fundidos, "2  METHODS  Right column..." no era sección.
      { size: 10, segmentos: [
        { texto: "2", negrita: true, size: 12 }, { texto: "METHODS", x: 84, negrita: true, size: 12 },
        { texto: derecha(1), x: 320 },
      ] },
    ];
    for (let i = 1; i <= 7; i++) {
      lineas.push({ size: 10, segmentos: [{ texto: izquierda(i) }, { texto: derecha(i + 1), x: 320 }] });
    }
    return lineas;
  }

  test("las líneas de las dos columnas se separan y se leen columna a columna", async () => {
    const { paginas } = await extraerLineas(escribirPdf([paginaADosColumnas()]));
    const textos = paginas[0].map((l) => l.texto);
    expect(textos.some((t) => /^2\s+METHODS$/.test(t))).toBe(true);
    expect(textos.some((t) => t.includes("Left column") && t.includes("Right column"))).toBe(false);
    // Orden de lectura: toda la izquierda antes que la derecha.
    const primeraDerecha = textos.findIndex((t) => t.startsWith("Right column"));
    const ultimaIzquierda = textos.map((t) => t.startsWith("Left column")).lastIndexOf(true);
    expect(ultimaIzquierda).toBeLessThan(primeraDerecha);
    // Y ninguna línea de prosa queda marcada como fila de tabla por el canal.
    expect(paginas[0].filter((l) => l.esFila)).toHaveLength(0);
  });

  test("el encabezado de la columna izquierda se reconoce y los párrafos se reconstruyen", async () => {
    const chunks = await parsear([paginaADosColumnas()]);
    const seccionDe = (fragmento: string) => chunks.find((c) => c.text.includes(fragmento))?.section;
    expect(seccionDe("Left column sentence 3")).toMatch(/^2\s+METHODS$/);
    expect(seccionDe("Right column sentence 5")).toMatch(/^2\s+METHODS$/);
    const todo = texto(chunks);
    expect(todo.indexOf("Left column sentence 7")).toBeLessThan(todo.indexOf("Right column sentence 1"));
    expect(todo).not.toContain("3 of 12");
  });

  test("una página de una columna con una tabla de dos no se parte en columnas", async () => {
    const { paginas } = await extraerLineas(escribirPdf([[
      ...PORTADA, ["Results", 12],
      ["Baseline characteristics of the 120 participants are summarized in the table below.", 10],
      ["The three groups did not differ in age or sex distribution at inclusion.", 10],
      { size: 10, segmentos: [{ texto: "Variable" }, { texto: "Control", x: 300 }] },
      { size: 10, segmentos: [{ texto: "Edad" }, { texto: "72.4", x: 300 }] },
      { size: 10, segmentos: [{ texto: "MMSE" }, { texto: "28.1", x: 300 }] },
      { size: 10, segmentos: [{ texto: "Sexo femenino" }, { texto: "45 (60%)", x: 300 }] },
      ["Values are mean (SD) unless stated otherwise in the footnote of the table.", 10],
    ]]));
    const textos = paginas[0].map((l) => l.texto);
    expect(textos).toContain("Variable  Control");
    expect(textos).toContain("Sexo femenino  45 (60%)");
  });
});
