// Heurísticas de artículo: detección de secciones y metadatos de la obra.
// Port de tests/test_paper.py más los adversariales de la revisión final.
//
// Nada de esto llama a un modelo: son reglas deterministas, y por eso hay que
// probarlas con los casos raros de un PDF de revista de verdad.
import { describe, expect, test } from "vitest";
import * as paper from "./paper";

function lineas(bloques: Array<[string, number]>): paper.LineaFormato[] {
  return bloques.map(([texto, tamano]) => ({ texto, tamano, negrita: false }));
}

const PRIMERA_PAGINA = lineas([
  ["Downloaded from journals.example.org on July 2026", 7],
  ["Cerebrospinal fluid biomarkers in early Alzheimer disease", 17],
  ["Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11],
  ["Department of Neurology, INTEC, Santo Domingo", 8.5],
  ["Abstract", 12],
  ["Background: amyloid beta 42 decreases in early stages.", 10],
]);

function autorDe(lineaAutores: string): string {
  const pagina = lineas([
    ["Plasma p-tau217 as a marker of amyloid pathology", 16],
    [lineaAutores, 11],
    ["Abstract", 12],
    ["Plasma p-tau217 separated amyloid positive from negative cases.", 10],
  ]);
  return paper.extraerMetadatos(pagina, "texto").autor;
}

describe("detección de secciones", () => {
  test("reconoce los encabezados habituales", () => {
    const casos: Record<string, string> = {
      Abstract: "resumen", RESUMEN: "resumen", "1. Introduction": "introduccion",
      Antecedentes: "introduccion", "2 Materials and Methods": "metodos",
      "MATERIALES Y MÉTODOS": "metodos", "III. Results": "resultados",
      Discussion: "discusion", Conclusiones: "conclusiones", References: "referencias",
      Bibliografía: "referencias", Acknowledgements: "agradecimientos", Appendix: "anexos",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
  });

  test("no confunde prosa con encabezado", () => {
    for (const linea of [
      "The methods described by Smith et al. were adapted for this cohort.",
      "En la introducción del trabajo previo se afirma lo contrario.",
      "Results were compared against the reference standard.",
      "This section presents our discussion of the findings.",
      "see References for the complete list of included trials.",
    ]) {
      expect(paper.detectarSeccion(linea), linea).toBeNull();
    }
  });

  test("ignora líneas vacías y demasiado largas", () => {
    expect(paper.detectarSeccion("")).toBeNull();
    expect(paper.detectarSeccion("   ")).toBeNull();
    expect(paper.detectarSeccion("Methods " + "x".repeat(100))).toBeNull();
  });

  test("reconoce las cabeceras numeradas con barra de Wiley", () => {
    // Medido el 3 sep 2026 sobre Alzheimer's & Dementia: "2 | METHODS" daba
    // None y la bibliografía entera se embebía.
    const casos: Record<string, string> = {
      "1 | INTRODUCTION": "introduccion", "2 | METHODS": "metodos", "3 | RESULTS": "resultados",
      "4 | DISCUSSION": "discusion", "5 | REFERENCES": "referencias", "2|METHODS": "metodos",
      "2 · Methods": "metodos", "2 – Methods": "metodos", "2 — Methods": "metodos",
      "X | Discussion": "discusion",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
    expect(paper.detectarSeccion("2.1 | Participants")).toBeNull();
  });

  test("un número de página pegado no esconde la cabecera", () => {
    const casos: Record<string, string> = {
      "3 RESULTS 5": "resultados", "3 | RESULTS 5": "resultados",
      "References 12": "referencias", "Discussion 1123": "discusion",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
    for (const linea of ["3", "2 3", "Table 1", "Section 3"]) {
      expect(paper.detectarSeccion(linea), linea).toBeNull();
    }
  });

  test("quitar la numeración no se come la inicial de la sección", () => {
    const casos: Record<string, string> = {
      Introduction: "introduccion", Introduccion: "introduccion", Conclusions: "conclusiones",
      Conclusion: "conclusiones", Limitations: "limitaciones", "Literature cited": "referencias",
      "Conflict of interest": "agradecimientos", "I Introduction": "introduccion",
      "I. Introduction": "introduccion", "V Results": "resultados", "XI. Conclusions": "conclusiones",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
  });

  test("la numeración romana solo cuenta en mayúsculas y bien formada", () => {
    expect(paper.detectarSeccion("IV Results")).toBe("resultados");
    expect(paper.detectarSeccion("III. Results")).toBe("resultados");
    expect(paper.detectarSeccion("iv Results")).toBeNull();
    expect(paper.detectarSeccion("ivxlc Results")).toBeNull();
    expect(paper.detectarSeccion("IVXLC Results")).toBeNull();
  });

  test("dos secciones en una cabecera toman la primera, salvo el resumen", () => {
    const casos: Record<string, string> = {
      "Results and Discussion": "resultados", "RESULTS AND DISCUSSION": "resultados",
      "Resultados y Discusion": "resultados", "Subjects and Methods": "metodos",
      "Study Design and Methods": "metodos", "Discussion/Conclusion": "discusion",
      "Strengths and Limitations": "limitaciones", "Conclusions and Relevance": "conclusiones",
      "Conflict of Interest Statement": "agradecimientos",
      "Data Availability Statement": "agradecimientos", "3 | RESULTS AND DISCUSSION 12": "resultados",
      "Summary and Conclusions": "conclusiones", "Resumen y Conclusiones": "conclusiones",
      "Abstract and Introduction": "introduccion",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
  });

  test("una línea corta que empieza por una sección no es cabecera", () => {
    for (const linea of [
      "Results were compared against", "Methods used in this", "Summary of Product Characteristics",
      "Results Are Shown Below", "Results of the Survey", "Results and Discussion of the Cohort",
      "Results and", "https://doi.org/10.1002/alz", "Neurology 2019",
    ]) {
      expect(paper.detectarSeccion(linea), linea).toBeNull();
    }
  });

  test("la segunda línea de un título partido no es una cabecera", () => {
    for (const linea of [
      "Limitations and Opportunities", "Findings and Implications", "Results and Perspectives",
      "Discussion and Outlook", "Methods and Challenges", "Conclusions and Opportunities",
    ]) {
      expect(paper.detectarSeccion(linea), linea).toBeNull();
    }
  });

  test("la exigencia no se come las cabeceras compuestas reales", () => {
    const casos: Record<string, string> = {
      "Subjects and Methods": "metodos", "Patients and Methods": "metodos",
      "Study Design and Methods": "metodos", "Strengths and Limitations": "limitaciones",
      "Materials and Methods": "metodos", "Results and Discussion": "resultados",
      "Discussion and Conclusions": "discusion", "3 | RESULTS AND DISCUSSION": "resultados",
    };
    for (const [linea, esperado] of Object.entries(casos)) {
      expect(paper.detectarSeccion(linea), linea).toBe(esperado);
    }
  });
});

describe("metadatos", () => {
  test("extrae el título por tamaño de fuente", () => {
    expect(paper.extraerMetadatos(PRIMERA_PAGINA, "texto").titulo).toBe(
      "Cerebrospinal fluid biomarkers in early Alzheimer disease",
    );
  });

  test("el apellido del primer autor sale de la línea de autores", () => {
    expect(paper.extraerMetadatos(PRIMERA_PAGINA, "texto").autor).toBe("Allegri");
  });

  test("apellido en formato apellido, inicial", () => {
    const pagina = lineas([
      ["Biomarkers in Alzheimer disease", 16], ["Allegri, R., Colome, M., Guilbe, J.", 11],
      ["Abstract", 12], ["We measured biomarker levels in cerebrospinal fluid samples.", 10],
    ]);
    expect(paper.extraerMetadatos(pagina, "texto").autor).toBe("Allegri");
  });

  test("ignora la afiliación como línea de autores", () => {
    const pagina = lineas([
      ["Tau phosphorylation and cognitive decline", 16],
      ["Universidad Nacional, Departamento de Neurologia", 10],
      ["Maria Fernanda Rosario, Pedro Nunez", 11], ["Abstract", 12],
      ["Phosphorylated tau was associated with faster decline in memory.", 10],
    ]);
    expect(paper.extraerMetadatos(pagina, "texto").autor).toBe("Rosario");
  });

  test("extrae DOI y año del texto", () => {
    const texto =
      "J Alzheimers Dis 2023; 91(2): 145-160.\n" +
      "https://doi.org/10.3233/JAD-220123 published 2023.\n" +
      "Earlier work from 1998 is cited later.";
    const meta = paper.extraerMetadatos(PRIMERA_PAGINA, texto);
    expect(meta.doi).toBe("10.3233/JAD-220123");
    expect(meta.anio).toBe("2023");
  });

  test("la fecha de descarga no se toma por año de publicación", () => {
    const meta = paper.extraerMetadatos(
      PRIMERA_PAGINA,
      "Downloaded from example.org on 3 March 2026\nNeurology 2019;92:e1-e9\n",
    );
    expect(meta.anio).toBe("2019");
  });

  test("un rango de vigencia o un año futuro no se convierten en año de publicación", () => {
    let meta = paper.extraerMetadatos(PRIMERA_PAGINA, "Updated Global Action Plan on AMR 2026-2036");
    expect(meta.anio).toBe("");
    expect(paper.referenciaDe(meta)).toBe("");
    meta = paper.extraerMetadatos(PRIMERA_PAGINA, "Plan estrategico 2036");
    expect(meta.anio).toBe("");
  });

  test("sin DOI no toma un año del cuerpo o las referencias", () => {
    const meta = paper.extraerMetadatos(
      PRIMERA_PAGINA,
      "Abstract\nThe cohort was recruited between 2019 and 2024.\nReferences\nSmith J. Previous study. 2025.\n",
    );
    expect(meta.anio).toBe("");
  });

  test("una organización o un subtítulo no se convierten en autor et al.", () => {
    let pagina = lineas([
      ["Diabetes mellitus tipo 2: diagnostico y control", 16],
      ["Organizacion Mundial de la Salud, 2026", 11], ["Resumen", 12],
      ["Documento de sintesis para profesionales sanitarios.", 10],
    ]);
    let meta = paper.extraerMetadatos(pagina, "OMS 2026\nResumen");
    expect(meta.autor).toBe("");
    expect(paper.referenciaDe(meta)).toBe("");

    pagina = lineas([
      ["Resistencia a los antimicrobianos", 16], ["Documentos base principales", 11],
      ["Vigilancia y uso responsable con enfoque One Health", 11], ["Resumen", 12],
      ["Sintesis de multiples fuentes internacionales.", 10],
    ]);
    meta = paper.extraerMetadatos(pagina, "Plan 2026-2036\nResumen");
    expect(meta.autor).toBe("");
  });

  test("la referencia es autor y año cuando se puede, y nunca el título", () => {
    expect(paper.referenciaDe(paper.extraerMetadatos(PRIMERA_PAGINA, "doi:10.1000/xyz 2024"))).toBe(
      "Allegri et al., 2024",
    );
    const pagina = lineas([
      ["Guia clinica de manejo del deterioro cognitivo", 16], ["Resumen", 12],
      ["Documento de consenso para el manejo inicial en atencion primaria.", 10],
    ]);
    const meta = paper.extraerMetadatos(pagina, "sin anio ni doi");
    expect(meta.autor).toBe("");
    expect(meta.titulo).toBe("Guia clinica de manejo del deterioro cognitivo");
    expect(paper.referenciaDe(meta)).toBe("");
    expect(paper.referenciaDe(paper.extraerMetadatos([], ""))).toBe("");
    expect(paper.referenciaDe({ titulo: "", autor: "van der Flier", anio: "2023", doi: "" })).toBe(
      "van der Flier et al., 2023",
    );
  });

  test("el ruido de cabecera no se toma por título", () => {
    const pagina = lineas([
      ["Downloaded from journals.example.org", 20], ["Amyloid load and hippocampal atrophy", 15],
      ["Abstract", 12], ["Cortical thinning was measured in 84 participants over two years.", 10],
    ]);
    expect(paper.extraerMetadatos(pagina, "texto").titulo).toBe("Amyloid load and hippocampal atrophy");
  });

  test("una cabecera compuesta no corta el título dentro de su bloque, pero sí fuera", () => {
    let pagina = lineas([
      ["Plasma biomarkers in memory clinics:", 17], ["Methods and Limitations", 17],
      ["Wiesje M. van der Flier, Philip Scheltens", 11], ["Abstract", 12],
      ["Plasma markers were compared against amyloid PET in 240 cases.", 10],
    ]);
    let meta = paper.extraerMetadatos(pagina, "texto");
    expect(meta.titulo).toBe("Plasma biomarkers in memory clinics: Methods and Limitations");
    expect(meta.autor).toBe("van der Flier");

    pagina = lineas([
      ["Amyloid load and hippocampal atrophy", 17], ["Ricardo F. Allegri, Manuel Colome", 11],
      ["Results and Discussion", 17],
      ["Cortical thinning was measured in 84 participants over two years.", 10],
    ]);
    meta = paper.extraerMetadatos(pagina, "texto");
    expect(meta.titulo).toBe("Amyloid load and hippocampal atrophy");
    expect(meta.autor).toBe("Allegri");
  });
});

describe("firma Vancouver, partículas y apellidos compuestos", () => {
  test("la firma Vancouver no anula la cita", () => {
    const casos: Record<string, string> = {
      "van der Flier WM, Scheltens P, Jack CR Jr": "van der Flier",
      "Allegri RF, Colome M, Sarasola D": "Allegri", "Jack CR Jr, Bennett DA": "Jack",
      "Li X, Wang Y": "Li", "Sperling RA": "Sperling", "Garcia Ribas MJ, Fortea J": "Garcia Ribas",
      "de la Torre JC, Perez J": "de la Torre", "Allegri RF1,2, Colome M3": "Allegri",
      "Allegri R.F., Colome M.": "Allegri", "RF Allegri, M Colome": "Allegri",
      "Mendez-Sanchez R, Lopez J": "Mendez-Sanchez",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("las partículas forman parte del apellido", () => {
    const casos: Record<string, string> = {
      "Wiesje M. van der Flier, Philip Scheltens": "van der Flier",
      "Maria de la Torre, Juan Perez": "de la Torre",
      "Emma L. van den Berg, Piet Smit": "van den Berg",
      "Bart De Strooper, Lucia Chavez": "De Strooper",
      "Christine Van Broeckhoven, Kristel Sleegers": "Van Broeckhoven",
      "van der Flier, W. M., Scheltens, P.": "van der Flier",
      "Prof Wiesje M van der Flier PhD, Philip Scheltens": "van der Flier",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
    expect(autorDe("Le Wang, Yu Chen")).toBe("Wang");
  });

  test("el apellido compuesto español se conserva cuando es inequívoco", () => {
    const casos: Record<string, string> = {
      "Maria Jose Garcia Ribas, Juan Fortea": "Garcia Ribas",
      "Maria J. Garcia Ribas, Juan Fortea": "Garcia Ribas",
      "Jose Antonio Garcia-Ribas, Ana Ruiz": "Garcia-Ribas",
      "Ricardo F. Allegri, Manuel Colome": "Allegri",
      "John R. R. Tolkien, Clive S. Lewis": "Tolkien",
      "Maria Fernanda Rosario, Pedro Nunez": "Rosario",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("un nombre de pila compuesto hispano no se parte, y el apellido doble sobrevive", () => {
    const casos: Record<string, string> = {
      "Maria del Carmen Garcia, Juan Perez": "Garcia", "Jose de Jesus Ramirez, Ana Ruiz": "Ramirez",
      "Maria de los Angeles Ruiz, Luis Diaz": "Ruiz", "Juan de Dios Lopez, Ana Gil": "Lopez",
      "Maria Jose Garcia Ribas, Juan Fortea": "Garcia Ribas",
      "Wiesje M. van der Flier, Philip Scheltens": "van der Flier",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("los sufijos, grados y tratamientos no se toman por apellido", () => {
    const casos: Record<string, string> = {
      "Clifford R. Jack Jr, David A. Bennett": "Jack",
      "Ricardo F. Allegri PhD, Manuel Colome MD": "Allegri",
      "Ricardo F. Allegri MD, Manuel Colome": "Allegri", "Sean O'Brien, Mary Walsh": "O'Brien",
      "Prof Dr Ricardo Allegri, Manuel Colome": "Allegri", "Dr. Ricardo Allegri, Manuel Colome": "Allegri",
      "Dra Maria Rosario, Pedro Nunez": "Rosario", "Ricardo Allegri MD, Manuel Colome": "Allegri",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("quitar el tratamiento no puede dejar la firma sin autor", () => {
    // "Dr. Allegri, M Colome" perdía a Allegri: un solo token no pasaba la
    // exigencia de dos palabras propias (revisión adversarial final).
    expect(autorDe("Dr. Allegri, M Colome")).toBe("Allegri");
    expect(autorDe("Prof. Scheltens, P Barkhof")).toBe("Scheltens");
    // Y sin más autores en la línea un token suelto sigue sin ser firma.
    expect(autorDe("Dr. Allegri")).toBe("");
  });

  test("la rama Vancouver no fabrica autores con términos y siglas", () => {
    for (const linea of [
      "Figure A", "Jack C", "Alzheimer disease AD, mild cognitive impairment MCI",
      "Mild Cognitive Impairment MCI, Alzheimer Disease AD", "Documentos base principales", "WM",
      "Ana Li", "Cerebrospinal Fluid CSF", "Amyloid PET", "Open Access CC BY",
      "Corresponding Author RF", "Original Article OA", "Alzheimer Disease AD",
      "Supplementary Material SM", "Review Article RA",
    ]) {
      expect(autorDe(linea), linea).toBe("");
    }
  });

  test("los términos que no son persona se rechazan también sin iniciales", () => {
    // "Open Access Article" daba "Article" por la rama occidental.
    for (const linea of ["Open Access Article", "Supplementary Information Available", "Research Article Open"]) {
      expect(autorDe(linea), linea).toBe("");
    }
  });

  test("la lista de términos no descarta firmas Vancouver reales", () => {
    const casos: Record<string, string> = {
      "van der Flier WM, Scheltens P": "van der Flier", "Allegri RF, Colome M": "Allegri",
      "Jack CR Jr, Bennett DA": "Jack", "Sperling RA": "Sperling",
      "Garcia Ribas MJ, Fortea J": "Garcia Ribas", "Mendez-Sanchez R, Lopez J": "Mendez-Sanchez",
      "de la Torre JC, Perez J": "de la Torre",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("un apellido corto en mayúsculas gana solo cuando toda la línea sigue esa convención", () => {
    const casos: Record<string, string> = {
      "Xin LI, Jian WU": "Li", "Jian WU, Xin LI": "Wu", "Jack Jr CR, Bennett DA": "Jack",
      "Clifford R. Jack Jr, David A. Bennett": "Jack",
      // Misma forma, firmas Vancouver corrientes: ni "Li" ni "He".
      "Sperling LI": "Sperling", "Bennett HE, Smith J": "Bennett", "Sperling LI, Johnson KA": "Sperling",
      "Sperling RA, Johnson K": "Sperling", "Jack CR, Bennett D": "Jack",
      "Knopman DS, Petersen R": "Knopman", "Xin QQ, Jian PP": "Xin", "Li X, Wang Y": "Li",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("una línea de dirección no se convierte en autor", () => {
    for (const linea of [
      "Boston, MA 02115, USA", "Amsterdam, NL", "Rochester, MN 55905", "Barcelona, ES",
      "Corresponding author: Wiesje van der Flier, Amsterdam", "Amsterdam, NL, Rotterdam, NL",
      // La forma "Apellido AB" de una institución con su sigla.
      "Amsterdam UMC, Department of Neurology", "Amsterdam UMC",
    ]) {
      expect(autorDe(linea), linea).toBe("");
    }
  });

  test("la guarda de dirección no anula el formato bibliográfico", () => {
    const casos: Record<string, string> = {
      "Allegri, R., Colome, M., Guilbe, J.": "Allegri", "van der Flier, W. M., Scheltens, P.": "van der Flier",
      "Ryan, CA, Smith, JB": "Ryan", "Sperling, RA, Johnson KA": "Sperling",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("el ruido de institución se mira en el segmento del primer autor, no en la línea", () => {
    // Maqueta de un solo grupo: la línea de autores arrastra institución,
    // ciudad y país. Con la comprobación sobre toda la línea se descartaba
    // la autoría legítima (revisión adversarial final).
    expect(autorDe("Ricardo F. Allegri, Department of Neurology, Boston, MA 02115, USA")).toBe("Allegri");
    expect(autorDe("van der Flier WM, Scheltens P, Alzheimer Center Amsterdam, Netherlands")).toBe("van der Flier");
    // Y una línea que EMPIEZA por la institución sigue sin ser autoría.
    expect(autorDe("Department of Neurology, Ricardo F. Allegri")).toBe("");
  });

  test("los autores separados por barra dan el primero, y un pie de tabla con barra no es autoría", () => {
    const casos: Record<string, string> = {
      "Wiesje M. van der Flier1 | Philip Scheltens1 | Frederik Barkhof2": "van der Flier",
      "van der Flier WM1 | Scheltens P1 | Barkhof F3": "van der Flier",
      "Ricardo F. Allegri | Manuel Colome": "Allegri", "Ricardo F. Allegri · Manuel Colome": "Allegri",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
    for (const linea of ["Table 1 | Baseline characteristics", "FIGURE 2 | Study flow diagram"]) {
      expect(autorDe(linea), linea).toBe("");
    }
  });
});

describe("ruido de página y cabeceras repetidas", () => {
  test("las líneas que se repiten en el borde de casi todas las páginas son cabecera", () => {
    // Seis líneas por página: las dos primeras y las dos últimas son borde.
    const paginas = Array.from({ length: 4 }, (_, i) => [
      "Alzheimers Dement 2021;17:1145-1157", `Cuerpo distinto ${i}`, "Results",
      `Otro cuerpo distinto ${i}`, `Y otro mas ${i}`, `page footer ${i}`,
    ]);
    const repetidas = paper.lineasRepetidas(paginas);
    expect(repetidas.has(paper.normalizar("Alzheimers Dement 2021;17:1145-1157"))).toBe(true);
    // Solo se miran los bordes: "Results" se repite en todas las páginas pero
    // está en el interior, y borrarlo sería perder contenido.
    expect(repetidas.has("results")).toBe(false);
    expect(paper.lineasRepetidas(paginas.slice(0, 2)).size).toBe(0);
  });

  test("marcas de agua y avisos legales", () => {
    expect(paper.esRuidoDePagina("Downloaded from journals.example.org by a reader")).toBe(true);
    expect(paper.esRuidoDePagina("Higher tau load was associated with faster decline.")).toBe(false);
  });

  test("un encabezado por formato es corto, sin puntuación final y más grande o en negrita", () => {
    expect(paper.esEncabezadoPorFormato("Composicion del Mazo", 13, 10, false)).toBe(true);
    expect(paper.esEncabezadoPorFormato("Statistical analysis", 10, 10, true)).toBe(true);
    expect(paper.esEncabezadoPorFormato("Statistical analysis", 10, 10, false)).toBe(false);
    expect(paper.esEncabezadoPorFormato("Esta guia analiza el mazo.", 13, 10, false)).toBe(false);
    expect(paper.esEncabezadoPorFormato("12 34", 13, 10, false)).toBe(false);
  });
});

describe("lo que enseñaron cinco PDF reales (4 sep 2026)", () => {
  test("una cabecera con letras espaciadas se reconoce por su nombre, pero no es encabezado por formato", () => {
    expect(paper.desespaciar("B I O M A R K E R S")).toBe("BIOMARKERS");
    expect(paper.desespaciar("R E S U L T S  A N D  D I S C U S S I O N")).toBe("RESULTS AND DISCUSSION");
    expect(paper.desespaciar("Plasma p-tau217")).toBe("Plasma p-tau217");
    expect(paper.detectarSeccion("R E S U L T S")).toBe("resultados");
    expect(paper.detectarSeccion("B I O M A R K E R S")).toBeNull();
    expect(paper.esLetrasEspaciadas("B I O M A R K E R S")).toBe(true);
    expect(paper.esLetrasEspaciadas("A B C de la prosa normal con palabras")).toBe(false);
    // "B I O M A R K E R S" iba en negrita y al cuerpo de letra: pasaba por encabezado.
    expect(paper.esEncabezadoPorFormato("B I O M A R K E R S", 9, 9, true)).toBe(false);
    expect(paper.esEncabezadoPorFormato("R E S E A R C H A R T I C L E", 9, 8, true)).toBe(false);
  });

  test("una línea de autores con superíndices no es encabezado, y una de contenido con dígitos sí puede serlo", () => {
    expect(paper.esLineaDeAutores("Ping Che1  Nan Zhang2")).toBe(true);
    expect(paper.esLineaDeAutores("MayaRae N Mugosa1  Jefferson W Kinney2  Lorenzo Gabriel Pasia3")).toBe(true);
    expect(paper.esLineaDeAutores("Alfredo Ramírez3,4,8,9,10  Pamela Martino-Adami8")).toBe(true);
    expect(paper.esLineaDeAutores("Ping Che1")).toBe(true);
    expect(paper.esLineaDeAutores("Table 1")).toBe(false);
    expect(paper.esLineaDeAutores("Plasma Aβ42 Levels")).toBe(false);
    expect(paper.esLineaDeAutores("COVID-19 and dementia")).toBe(false);
    expect(paper.esLineaDeAutores("Longitudinal analysis of human plasma biomarkers")).toBe(false);
    expect(paper.esEncabezadoPorFormato("Ping Che1  Nan Zhang2", 12, 9, true)).toBe(false);
    expect(paper.esEncabezadoPorFormato("2.3  Plasma biomarker measurements", 10, 8, true)).toBe(true);
  });

  test("las líneas de un párrafo del resumen (a 9 pt sobre un cuerpo de 8) no son encabezados", () => {
    // Etiqueta con dos puntos seguida de una frase.
    expect(paper.esEncabezadoPorFormato("METHODS: We analyzed 982 community-dwelling individuals followed", 9, 8, false)).toBe(false);
    expect(paper.esEncabezadoPorFormato("Conclusion: Plasma p-tau217 demonstrated exceptional diagnostic accuracy for AD", 9, 9, true)).toBe(false);
    // Renglón que empieza en minúscula o acaba en palabra cortada.
    expect(paper.esEncabezadoPorFormato("impairment (MCI)/dementia. Results were replicated with immu-", 9, 8, false)).toBe(false);
    expect(paper.esEncabezadoPorFormato("risk of progression to MCI and dementia, and faster neu-", 10, 8, true)).toBe(false);
    // Y los encabezados de verdad siguen pasando, con dos puntos cortos incluidos.
    expect(paper.esEncabezadoPorFormato("Composicion del Mazo", 13, 10, false)).toBe(true);
    expect(paper.esEncabezadoPorFormato("Highlights", 10, 8, true)).toBe(true);
    expect(paper.esEncabezadoPorFormato("Background: Objectives", 12, 10, false)).toBe(true);
  });

  test("los folios no son contenido", () => {
    for (const folio of ["3 of 12", "12", "Page 4", "pág. 7", "2 / 15"]) expect(paper.esNumeroDePagina(folio), folio).toBe(true);
    for (const no of ["12 patients", "Table 3", "2021", "of 12"]) expect(paper.esNumeroDePagina(no), no).toBe(false);
  });

  test("autores separados por dobles espacios con el superíndice pegado: el primero manda", () => {
    // PMC12739034 salía "Nan Zhang et al."; PMC12777541 "Adipa Chongsuksantikul et al.";
    // PMC12741034 se quedaba sin cita.
    const casos: Record<string, string> = {
      "Ping Che1  Nan Zhang2": "Che",
      "MayaRae N Mugosa1  Jefferson W Kinney2  Lorenzo Gabriel Pasia3": "Mugosa",
      "Watayuth Luechaipanit1  Thanaporn Haethaisong2  Adipa Chongsuksantikul1": "Luechaipanit",
      "Jesús Silva-Rodríguez1,2  Linda Zhang1  Luca Kleineidam3,4": "Silva-Rodríguez",
      // Neurology: comas y el superíndice tras la coma.
      "Thomas Coysh,1,2 Rhiannon Laban,3 Elena Veleva,3 Amanda J. Heslegrave,3,4": "Coysh",
    };
    for (const [linea, esperado] of Object.entries(casos)) expect(autorDe(linea), linea).toBe(esperado);
  });

  test("el año sale de la referencia bibliográfica junto al DOI del pie, no del cuerpo del resumen", () => {
    // La primera aparición del DOI (esquina superior) no tiene año al lado; la
    // del pie sí. PMC12777541 daba 2022 por "enrolled between 2022 and October 2024".
    const texto =
      "DOI: 10.1002/alz70856_104726\nB I O M A R K E R S\nHead to head comparison\nAbstract\n" +
      "Background: Participants were enrolled between 2022 and October 2024.\n" +
      "© 2025 The Alzheimer's Association.\n" +
      "Alzheimer's Dement. 2025;21(Suppl. 2):e104726.  wileyonlinelibrary.com/journal/alz  1 of 3\n" +
      "https://doi.org/10.1002/alz70856_104726";
    expect(paper.extraerMetadatos(PRIMERA_PAGINA, texto).anio).toBe("2025");
  });

  test("la línea de fechas editoriales manda sobre el cuerpo, y la referencia bibliográfica de la portada pone el suelo", () => {
    const editorial =
      "Received: 27 January 2026  Revised: 22 May 2026  Accepted: 28 May 2026\nDOI: 10.1002/alz.71599\n" +
      "Abstract\nData from 2011 to 2023 were used.";
    expect(paper.extraerMetadatos(PRIMERA_PAGINA, editorial).anio).toBe("2026");

    // Sin DOI y con un año viejo en la cabecera: nunca por debajo de "Neurology 2026;107".
    const portada = lineas([
      ["Performance of plasma biomarkers", 22], ["Thomas Coysh, Rhiannon Laban", 8],
      ["Neurology 2026;107:e214712", 9], ["Abstract", 10], ["Body text of the abstract.", 10],
    ]);
    expect(paper.extraerMetadatos(portada, "Study data from 2019 were reused.\nNeurology 2026;107:e214712").anio).toBe("2026");
  });

  test("el bloque del título: sus líneas se devuelven para que nunca sean sección", () => {
    const pagina = lineas([
      ["DOI: 10.1002/alz70856_102320", 7],
      ["Longitudinal analysis of human plasma biomarkers for", 17.9],
      ["Alzheimer's disease: Phosphorylated Tau-217, Phosphorylated", 17.9],
      ["Tau-181, and Glial fibrillation acidic protein", 17.9],
      ["MayaRae N Mugosa1  Jefferson W Kinney2", 12],
      ["Abstract", 10],
      ["Background: Alzheimer's disease (AD) is a progressive neurodegenerative disease.", 9],
    ]);
    const { meta, lineasTitulo } = paper.extraerMetadatosConBloque(pagina, "texto");
    expect(meta.titulo).toBe(
      "Longitudinal analysis of human plasma biomarkers for Alzheimer's disease: Phosphorylated Tau-217, Phosphorylated Tau-181, and Glial fibrillation acidic protein",
    );
    expect([...lineasTitulo].sort()).toEqual([1, 2, 3]);
    expect(meta.autor).toBe("Mugosa");
  });
});
