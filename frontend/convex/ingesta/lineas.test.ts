// Reglas de unión de líneas físicas de un PDF, una a una. Lógica pura.
import { describe, expect, test } from "vitest";
import { abreParrafo, cierraOracion, unirLineas } from "./lineas";

describe("unirLineas", () => {
  test.each([
    ["hippocam-", "pal formation", "hippocampal formation"],
    ["anti-", "Alzheimer agents", "anti-Alzheimer agents"],
    // Compuesto partido EN su propio guion: el guion es del término y sin él
    // el término no existe en el índice ("antiinflammatory").
    ["anti-", "inflammatory drugs were allowed", "anti-inflammatory drugs were allowed"],
    ["beta-", "amyloid plaques", "beta-amyloid plaques"],
    ["non-", "carriers of APOE", "non-carriers of APOE"],
    ["long-", "term follow up", "long-term follow up"],
    ["meta-", "analysis of six trials", "meta-analysis of six trials"],
    ["follow-", "up visits", "follow-up visits"],
    ["cross-", "sectional design", "cross-sectional design"],
    ["community-", "dwelling adults", "community-dwelling adults"],
    ["pre-", "existing conditions", "pre-existing conditions"],
    ["co-", "occurring symptoms", "co-occurring symptoms"],
    ["COVID-", "19 vaccination", "COVID-19 vaccination"],
    ["doses of 12-", "15 mg", "doses of 12-15 mg"],
    ["between 2018 and", "2021.", "between 2018 and 2021."],
  ])("%s + %s -> %s", (anterior, linea, esperado) => {
    expect(unirLineas(anterior, linea)).toBe(esperado);
  });

  test("los cortes de maquetador de dos columnas se unen sin guion", () => {
    // La regla anterior conservaba el guion con cualquier izquierda de <= 5
    // caracteres, y "sig-nificant" o "de-mentia" quedaban así en el índice.
    expect(unirLineas("sig-", "nificant differences")).toBe("significant differences");
    expect(unirLineas("pa-", "tients were")).toBe("patients were");
    expect(unirLineas("cog-", "nitive decline")).toBe("cognitive decline");
    expect(unirLineas("de-", "mentia was")).toBe("dementia was");
    expect(unirLineas("re-", "sults show")).toBe("results show");
    // Prefijos que también son sílaba inicial: sin vocal detrás, se unen.
    expect(unirLineas("pre-", "vious work")).toBe("previous work");
    expect(unirLineas("co-", "hort of 240")).toBe("cohort of 240");
    expect(unirLineas("inter-", "vention arm")).toBe("intervention arm");
    expect(unirLineas("multi-", "ple comparisons")).toBe("multiple comparisons");
    // Y "anti" delante de consonante es la palabra entera, no el compuesto.
    expect(unirLineas("anti-", "body titres")).toBe("antibody titres");
  });
});

describe("abreParrafo", () => {
  test.each([
    // Oración cerrada + mayúscula: párrafo nuevo (aunque a veces sea la
    // misma, cortar entre oraciones no hace daño).
    ["decline over time.", "The second cohort was smaller.", true],
    ["was significant (p < 0.05).", "Table 1 shows the baseline data.", true],
    ['as "probable AD."', "We then compared both groups.", true],
    ["decline over time.", "2021 was the last year of follow up.", true],
    // Sin cerrar la oración, nada abre párrafo: ni una cifra ni mayúscula.
    ["between 2018 and", "2021. Volumetric MRI was used.", false],
    ["Mean amyloid beta 42 was 542", "pg/mL in the impaired group.", false],
    ["hippocam-", "pal formation", false],
    ["were assessed by", "Smith and colleagues in 2019.", false],
    // Abreviaturas con punto que no cierran la oración.
    ["as reported by Smith et al.", "(2019) in a larger cohort.", false],
    ["several biomarkers, e.g.", "amyloid and tau.", false],
    // Minúscula tras punto: abreviatura no listada o punto decimal.
    ["as shown in Fig.", "2 of the supplement.", false],
    ["the threshold was approx.", "2.4 pg/mL in both groups.", false],
    // Viñetas abren párrafo aunque la anterior no cierre.
    ["inclusion criteria were", "• age over 65 years", true],
    // Una referencia a la tabla DENTRO de la oración no es un rótulo: partir
    // ahí sería volver a separar "in" de "Table 1".
    ["as summarized in", "Table 1, the groups differed at baseline.", false],
    ["differences are shown in", "Table 2 and Figure 3 for both cohorts.", false],
    ["differences are shown in", "Figure 3). No other effect was seen.", false],
    // Un número negativo no es una viñeta.
    ["the coefficient was", "-0.31 (p = 0.02) in the adjusted model.", false],
    // El punto de "Table 1." puede ser el que cierra la FRASE que la cita.
    ["summarized in", "Table 1. The groups did not differ.", false],
    ["as reported in", "Figure 2. Curves diverged after 12 months.", false],
    // Cita Vancouver pegada al punto: la oración sí cerró.
    ["associated with faster cognitive decline.12,13", "The second cohort was smaller.", true],
    ["only the first one.14", "A sensitivity analysis followed.", true],
    ["reported before.12-14", "We repeated the model without them.", true],
    // ...pero no si lo que hay delante del superíndice es una abreviatura.
    ["as shown by Smith et al.12", "Reported values were lower.", false],
    ["as shown in Fig.2", "The curves diverged after a year.", false],
    // Subtítulo no detectado: línea corta, sin puntuación, seguida de
    // mayúscula. No debe comerse la primera frase del párrafo.
    ["Statistical analysis", "Group differences were tested with ANOVA.", true],
    ["Sample size calculation", "We assumed a drop out rate of 15%.", true],
    // Y la prosa cortada que también es corta NO es un subtítulo.
    ["Cognition was measured with", "Mini Mental State Examination scores.", false],
    ["The risk of dementia was", "higher in carriers of the allele.", false],
    // Ni una primera línea corta que acaba en cifra: es prosa de Resultados,
    // y además el decimal no puede leerse como fin de oración.
    ["The mean difference was 0.31", "Compared with controls it was small.", false],
    ["We used gpt-5.4", "The model was not changed afterwards.", false],
    // Prosa con dos cifras: la heurística por densidad de números la tomaba
    // por fila de tabla y no la pegaba a la línea siguiente.
    ["Los 72 pacientes recibieron 10 mg", "de donepezilo al día durante el estudio.", false],
    ["We enrolled 120 patients aged 65 years", "The mean follow up was 24 months.", false],
  ])("%s | %s -> %s", (anterior, linea, abre) => {
    expect(abreParrafo(anterior, linea)).toBe(abre);
  });

  test("una fila de tabla nunca se pega, ni delante ni detrás", () => {
    // La fila la decide la geometría (pdf.ts) y llega como flag.
    expect(abreParrafo("Table 1. Baseline characteristics", "Variable Control MCI AD p", { lineaEsFila: true })).toBe(true);
    expect(abreParrafo("Variable Control MCI AD p", "Age, years 72.4 (6.1)", { anteriorEsFila: true, lineaEsFila: true })).toBe(true);
    expect(abreParrafo("MMSE 28.1 (1.2) 21.3 (3.4)", "Values are mean (SD) unless stated.", { anteriorEsFila: true })).toBe(true);
    // El rótulo tras una fila abre párrafo aunque la fila no cierre oración.
    expect(abreParrafo("Age, years 72.4 (6.1) 74.0 (5.8)", "Table 2. Outcomes at 24 months", { anteriorEsFila: true })).toBe(true);
    expect(abreParrafo("Age, years 72.4 (6.1) 74.0 (5.8)", "Figure 3: Kaplan Meier curves", { anteriorEsFila: true })).toBe(true);
    expect(abreParrafo("Age, years 72.4 (6.1) 74.0 (5.8)", "TABLE S1 | Sensitivity analyses", { anteriorEsFila: true })).toBe(true);
  });

  test("la palabra cortada con guion manda sobre la fila: el rótulo partido de una fila se recompone", () => {
    // Medido: "hippocam-" + "pal 3.2 cm3 4.1 cm3" no se recomponía y el
    // término desaparecía del índice.
    expect(abreParrafo("hippocam-", "pal 3.2 cm3 4.1 cm3", { lineaEsFila: true })).toBe(false);
    expect(unirLineas("hippocam-", "pal 3.2 cm3 4.1 cm3")).toBe("hippocampal 3.2 cm3 4.1 cm3");
  });
});

describe("cierraOracion", () => {
  test.each([
    ["decline over time.", true],
    ['as "probable AD."', true],
    // Cita Vancouver pegada al punto: el estilo de casi toda revista médica.
    ["associated with faster cognitive decline.12,13", true],
    ["the first one.14", true],
    ["reported before.12-14", true],
    // Y el decimal y la versión NO cierran oración: llevan un dígito, no una
    // letra, delante del punto. Si cerraran, el párrafo se partiría en
    // mitad de una cifra.
    ["the mean difference was 0.31", false],
    ["we used gpt-5.4", false],
    ["between 2018 and", false],
  ])("%s -> %s", (texto, cierra) => {
    expect(cierraOracion(texto)).toBe(cierra);
  });
});
