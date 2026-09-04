// Detección de idioma: acierta lo evidente y calla cuando no está claro.
//
// Callar importa tanto como acertar: la etiqueta se convierte en un filtro
// exacto, y una etiqueta equivocada deja fuera al documento para siempre.
import { describe, expect, test } from "vitest";
import { detectarIdioma } from "./idioma";

const ES =
  "La concentracion de amiloide beta 42 disminuye en las fases mas tempranas " +
  "de la enfermedad, mientras que la proteina tau total y la fosforilada " +
  "aumentan de forma progresiva con el paso de los anos en los pacientes que " +
  "fueron seguidos durante el estudio en los tres centros participantes.";
const EN =
  "The concentration of amyloid beta 42 decreases in the earliest stages of " +
  "the disease, while total tau and phosphorylated tau increase progressively " +
  "over time in the patients who were followed during the study at the three " +
  "participating centres that took part in this work.";
const PT =
  "A concentracao de amiloide beta 42 diminui nas fases mais precoces da " +
  "doenca, enquanto a proteina tau total e a fosforilada aumentam de forma " +
  "progressiva ao longo do tempo nos doentes que foram seguidos durante o " +
  "estudo nos tres centros que participaram neste trabalho.";

describe("detectarIdioma", () => {
  test("reconoce español, inglés y portugués", () => {
    expect(detectarIdioma(ES)).toBe("es");
    expect(detectarIdioma(EN)).toBe("en");
    expect(detectarIdioma(PT)).toBe("pt");
  });

  test("con acentos también", () => {
    expect(
      detectarIdioma(
        "La concentración de amiloide beta también disminuye según el estudio, " +
          "y la proteína tau aumenta de forma progresiva en los pacientes que " +
          "fueron evaluados durante los años de seguimiento del ensayo clínico.",
      ),
    ).toBe("es");
  });

  test("un texto corto no se arriesga", () => {
    expect(detectarIdioma("Resultados")).toBe("");
    expect(detectarIdioma("")).toBe("");
  });

  test("una tabla de valores no tiene idioma que valga la pena afirmar", () => {
    expect(detectarIdioma("534 912 0.93 0.81 0.68 145 160 91 17 2021 ".repeat(6))).toBe("");
  });

  test("una lista de términos técnicos no se arriesga", () => {
    expect(
      detectarIdioma(
        "amyloid tau biomarker cohort hippocampus atrophy neurofilament " +
          "phosphorylation cerebrospinal dementia cognition apolipoprotein " +
          "positron tomography magnetic resonance imaging volumetry cortex " +
          "entorhinal precuneus amygdala",
      ),
    ).toBe("");
  });
});
