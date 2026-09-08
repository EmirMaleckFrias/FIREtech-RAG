// @vitest-environment node
// Port de backend/tests/test_evaluation.py: puntuación de una corrida,
// agregado de N corridas y resumen. Todo sintético: ni Convex ni modelos.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  agregarCorridas,
  cargarCasos,
  puntuarCaso,
  resumir,
  validarCaso,
  type Caso,
  type Resultado,
} from "./puntuar";

function caso(extra: Record<string, unknown> = {}): Caso {
  return validarCaso({
    id: "mh-1",
    question: "compara A y B",
    mode: "extendido",
    category: "multi_hop",
    min_hops: 2,
    evidence: [
      { id: "a", description: "resultado A", sources: [{ file: "a.pdf", pages: [3] }] },
      { id: "b", description: "resultado B", sources: [{ file: "b.pdf", section_patterns: ["results|resultados"] }] },
    ],
    hop_patterns: ["cohorte A", "cohorte B"],
    answer_must_contain: ["42%"],
    answer_must_not_contain: ["100%"],
    ...extra,
  });
}

function resultado(): Resultado {
  return {
    answer: "La cohorte tuvo 42% [a.pdf, pág. 3]. El segundo estudio coincide [Autor et al., sección: Resultados].",
    sources: [
      { source_file: "a.pdf", page: 3, source_pages: [3, 4], locator: "pág. 3", citation: "" },
      { source_file: "b.pdf", page: 0, source_pages: [], section: "Resultados", locator: "sección: Resultados", citation: "Autor et al." },
    ],
    hops: [{ query: "cohorte A biomarcador" }, { query: "cohorte B biomarcador" }],
    metrics: { cost_usd: 0.02, ms_total: 1200 },
    error: null,
  };
}

/** Un resultado con el informe del verificador dentro de la telemetría, tal
 *  como lo deja `agente/bucle.ts` en `metrics.meta.verificacion`. */
function conVerificacion(campos: Record<string, unknown> = {}): Resultado {
  const r = resultado();
  r.metrics = { ...r.metrics, meta: { verificacion: { fidelidad: 1.0, no_sostenidas: 0, sin_verificar: 0, ...campos } } };
  return r;
}

function corrida(fidelidad: number, opciones: { hops?: number; ms_total?: number; cost_usd?: number; no_sostenidas?: number } = {}): Resultado {
  const r = conVerificacion({ fidelidad, no_sostenidas: opciones.no_sostenidas ?? 0 });
  const hops = opciones.hops ?? 2;
  r.hops = [...(r.hops ?? []), ...Array.from({ length: Math.max(0, hops - 2) }, (_, i) => ({ query: `búsqueda extra ${i}` }))];
  r.metrics = { ...r.metrics, ms_total: opciones.ms_total ?? 1200, cost_usd: opciones.cost_usd ?? 0.02 };
  return r;
}

function sinHops(fidelidad: number, hops: number): Resultado {
  const r = corrida(fidelidad);
  r.hops = (r.hops ?? []).slice(0, hops);
  return r;
}

function agregar(c: Caso, results: Resultado[]) {
  return agregarCorridas(results.map((r) => puntuarCaso(c, r)), results);
}

describe("puntuarCaso", () => {
  test("un caso completo pasa y mide cobertura", () => {
    const s = puntuarCaso(caso(), resultado());
    expect(s.passed).toBe(true);
    expect(s.metrics.evidence_recall).toBe(1);
    expect(s.metrics.citation_precision).toBe(1);
    expect(s.metrics.hop_pattern_coverage).toBe(1);
  });

  test("una evidencia que falta hace fallar el caso", () => {
    const r = resultado();
    r.sources = (r.sources ?? []).slice(0, 1);
    const s = puntuarCaso(caso(), r);
    expect(s.passed).toBe(false);
    expect(s.metrics.evidence_recall).toBe(0.5);
    expect(s.failures).toContain("evidencia no recuperada: b");
  });

  test("una cita inventada no se considera fiel", () => {
    const r = resultado();
    r.answer += " Dato extra [fantasma.pdf, pág. 9].";
    const s = puntuarCaso(caso(), r);
    expect(s.passed).toBe(false);
    expect(s.metrics.citation_precision).toBeLessThan(1);
    expect(s.failures.some((f) => f.includes("fantasma.pdf"))).toBe(true);
  });

  test("la abstención correcta pasa sin citas, incluida la fórmula 'no pude comprobar' de Convex", () => {
    const c = validarCaso({ id: "neg-1", question: "algo ausente", category: "abstention", min_hops: 1, evidence: [], expect_abstention: true });
    expect(puntuarCaso(c, { answer: "No encuentro esa información en los documentos.", sources: [], hops: [{}] }).passed).toBe(true);
    const s = puntuarCaso(c, { answer: "No pude comprobar ese dato en los documentos.", sources: [], hops: [{}] });
    expect(s.passed).toBe(true);
    expect(s.metrics.citation_precision).toBe(1);
  });

  test("ADVERSARIAL: una respuesta factual que se abstiene, o que no cita nada, falla", () => {
    const abst = puntuarCaso(caso(), { ...resultado(), answer: "No hay evidencia sobre eso." });
    expect(abst.failures).toContain("se abstuvo en un caso con evidencia esperada");
    const sinCitas = puntuarCaso(caso(), { ...resultado(), answer: "La cohorte tuvo 42%." });
    expect(sinCitas.failures).toContain("respuesta factual sin citas");
    expect(sinCitas.metrics.citation_precision).toBe(0);
  });

  test("un error de ejecución es un fallo con su detalle", () => {
    const s = puntuarCaso(caso(), { ...resultado(), error: "timeout" });
    expect(s.passed).toBe(false);
    expect(s.failure_types).toContainEqual({ type: "error de ejecución", detail: "timeout" });
  });
});

describe("dataset", () => {
  test("rechaza ids duplicados, casos incoherentes y regex rotas, señalando la línea", () => {
    const fila = JSON.stringify({ id: "x", question: "q", evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] });
    expect(() => cargarCasos(`${fila}\n${fila}\n`, "casos.jsonl")).toThrow(/casos\.jsonl:2: id duplicado: x/);
    expect(() => validarCaso({ id: "x", question: "q", expect_abstention: true, evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] })).toThrow(/abstención/);
    expect(() => validarCaso({ id: "x", question: "q" })).toThrow(/al menos una evidencia/);
    expect(() => validarCaso({ id: "x", question: "q", min_faithfulness: 1.5, evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] })).toThrow(/min_faithfulness/);
    expect(() => cargarCasos(JSON.stringify({ id: "x", question: "q", hop_patterns: ["("], evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] }), "c.jsonl")).toThrow(/c\.jsonl:1: regex inválida/);
    expect(() => cargarCasos("# solo comentarios\n\n")).toThrow(/no contiene casos/);
  });

  test("la plantilla del benchmark sigue validando", () => {
    const casos = cargarCasos(readFileSync(new URL("../../evals/alzheimer.template.jsonl", import.meta.url), "utf8"));
    expect(casos.length).toBeGreaterThanOrEqual(3);
    expect(casos.every((c) => c.min_faithfulness === null)).toBe(true);
  });
});

describe("resumir", () => {
  test("no oculta un fallo crítico detrás de un promedio", () => {
    const ok = puntuarCaso(caso({ id: "ok" }), resultado());
    const malo = resultado();
    malo.sources = [];
    const bad = puntuarCaso(caso({ id: "bad" }), malo);
    const r = resumir([ok, bad], [resultado(), malo]);
    expect(r.pass_rate).toBe(0.5);
    expect(r.release_gate_passed).toBe(false);
    expect(r.critical_failures).toEqual(["bad"]);
  });

  test("ids repetidos sin agregar rompen en vez de resumir mal", () => {
    const s = puntuarCaso(caso(), resultado());
    expect(() => resumir([s, s], [resultado(), resultado()])).toThrow(/ids repetidos/);
  });
});

describe("fidelidad: la mide el verificador, aquí solo se lee", () => {
  test("sin verificación es null y no penaliza", () => {
    const s = puntuarCaso(caso(), resultado());
    expect(s.metrics.faithfulness).toBeNull();
    expect(s.passed).toBe(true);
  });

  test("una afirmación no sostenida es un fallo duro", () => {
    const s = puntuarCaso(caso(), conVerificacion({ fidelidad: 0.5, no_sostenidas: 1 }));
    expect(s.passed).toBe(false);
    expect(s.failures.some((f) => f.includes("no sostiene"))).toBe(true);
    expect(s.metrics.unsupported_claims).toBe(1);
    expect(s.metrics.faithfulness).toBe(0.5);
  });

  test("el umbral del caso se respeta, y exigirlo sin medirlo es un fallo", () => {
    const c = caso({ min_faithfulness: 0.9 });
    expect(puntuarCaso(c, conVerificacion({ fidelidad: 1.0 })).passed).toBe(true);
    const bajo = puntuarCaso(c, conVerificacion({ fidelidad: 0.8 }));
    expect(bajo.passed).toBe(false);
    expect(bajo.failures.some((f) => f.includes("por debajo del mínimo"))).toBe(true);
    const sinMedir = puntuarCaso(c, resultado());
    expect(sinMedir.passed).toBe(false);
    expect(sinMedir.failures.some((f) => f.includes("no la midió"))).toBe(true);
  });

  test("la media de fidelidad promedia solo lo medido y se suman las no sostenidas", () => {
    const medido = puntuarCaso(caso({ id: "medido" }), conVerificacion({ fidelidad: 0.5 }));
    const sinMedir = puntuarCaso(caso({ id: "sin-medir" }), resultado());
    const r = resumir([medido, sinMedir], [resultado(), resultado()]);
    expect(r.mean_faithfulness).toBe(0.5);
    expect(r.faithfulness_measured_cases).toBe(1);
    const a = puntuarCaso(caso({ id: "a" }), conVerificacion({ fidelidad: 0.5, no_sostenidas: 2 }));
    const b = puntuarCaso(caso({ id: "b" }), conVerificacion({ fidelidad: 0.0, no_sostenidas: 3 }));
    const r2 = resumir([a, b], [resultado(), resultado()]);
    expect(r2.unsupported_claims_total).toBe(5);
    expect(r2.release_gate_passed).toBe(false);
  });
});

describe("agregarCorridas", () => {
  test("una sola corrida es idéntica a puntuarCaso más las claves aditivas", () => {
    const c = caso({ min_faithfulness: 0.9 });
    const r = corrida(0.8);
    const unico = puntuarCaso(c, r);
    const [score, agregado] = agregarCorridas([unico], [r]);
    const sinAditivas = ({ runs: _r, passed_rate: _p, dispersion: _d, evidence: _e, ...resto }: typeof score) => resto;
    const { evidence: _e2, ...restoUnico } = unico;
    expect(sinAditivas(score)).toEqual(restoUnico);
    expect(score.evidence.map(({ found_rate: _f, ...e }) => e)).toEqual(unico.evidence);
    expect(score.runs).toBe(1);
    expect(score.passed_rate).toBe(0);
    expect(agregado.metrics).toMatchObject({ cost_usd: 0.02, ms_total: 1200, cost_usd_all_runs: 0.02 });
  });

  test("la mediana no se deja arrastrar por un valor atípico, y con N par es el punto medio", () => {
    const [score, agregado] = agregar(caso(), [
      corrida(1.0, { hops: 6, ms_total: 1000, cost_usd: 0.02 }),
      corrida(1.0, { hops: 7, ms_total: 1100, cost_usd: 0.021 }),
      corrida(0.33, { hops: 15, ms_total: 9000, cost_usd: 0.09 }),
    ]);
    expect(score.metrics.faithfulness).toBe(1);
    expect(score.metrics.hops).toBe(7);
    expect(agregado.metrics.ms_total).toBe(1100);
    expect(agregado.metrics.cost_usd).toBe(0.021);
    expect(agregado.metrics.cost_usd_all_runs).toBe(0.131);
    expect(agregado.runs).toBe(3);
    const [par] = agregar(caso(), [corrida(1.0, { hops: 6 }), corrida(1.0, { hops: 10 })]);
    expect(par.metrics.hops).toBe(8);
  });

  test("passed es mayoría estricta con su tasa; un empate no pasa; el fallo minoritario sigue listado", () => {
    const c = caso({ min_faithfulness: 0.9 });
    const [dosDeTres] = agregar(c, [corrida(1.0), corrida(1.0), corrida(0.33)]);
    const [unaDeTres] = agregar(c, [corrida(1.0), corrida(0.33), corrida(0.33)]);
    expect(dosDeTres.passed).toBe(true);
    expect(dosDeTres.passed_rate).toBe(0.6667);
    expect(unaDeTres.passed).toBe(false);
    expect(unaDeTres.passed_rate).toBe(0.3333);
    expect(dosDeTres.failures).toEqual(["fidelidad por debajo del mínimo 0.90 (1/3 corridas): 0.33"]);
    const [empate] = agregar(c, [corrida(1.0), corrida(0.33)]);
    expect(empate.passed).toBe(false);
    expect(empate.passed_rate).toBe(0.5);
  });

  test("con N par la mediana puede cumplir el umbral y el caso fallar; la dispersión lo delata", () => {
    const [score] = agregar(caso({ min_faithfulness: 0.8 }), [corrida(1.0), corrida(0.6)]);
    expect(score.metrics.faithfulness).toBe(0.8);
    expect(score.passed).toBe(false);
    expect(score.dispersion?.passed).toEqual({ rate: 0.5, values: [true, false] });
    expect(score.failures).toEqual(["fidelidad por debajo del mínimo 0.80 (1/2 corridas): 0.60"]);
    expect("passed" in score.metrics).toBe(false);
  });

  test("los fallos agregados van por frecuencia y por tipo, sin trocearse por la medición de cada corrida", () => {
    const c = caso({ min_faithfulness: 0.9 });
    const sinB = corrida(0.33);
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const [score] = agregar(c, [corrida(0.33), sinB, corrida(1.0)]);
    expect(score.failures).toEqual([
      "fidelidad por debajo del mínimo 0.90 (2/3 corridas): 0.33",
      "evidencia no recuperada: b (1/3 corridas)",
      "citas no resolubles (1/3 corridas): [Autor et al., sección: Resultados]",
    ]);
    const [hops] = agregar(caso(), [sinHops(1.0, 0), sinHops(1.0, 1), sinHops(1.0, 0)]);
    expect(hops.failures[0]).toBe("hops insuficientes (3/3 corridas): 0 < 2, 1 < 2");
    expect(hops.failure_types[0]).toEqual({ type: "hops insuficientes", detail: "0 < 2, 1 < 2", runs: 3 });
    const [repetido] = agregar(caso(), [sinHops(1.0, 0), sinHops(1.0, 0), sinHops(1.0, 0)]);
    expect(repetido.failures).toContain("hops insuficientes (3/3 corridas): 0 < 2");
  });

  test("ADVERSARIAL: agrupar por tipo no funde fallos de evidencias distintas", () => {
    const sinA = corrida(1.0);
    sinA.sources = (sinA.sources ?? []).slice(1);
    const sinB = corrida(1.0);
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const [score] = agregar(caso(), [sinA, sinB]);
    expect(score.failures).toContain("evidencia no recuperada: a (1/2 corridas)");
    expect(score.failures).toContain("evidencia no recuperada: b (1/2 corridas)");
    expect(score.failure_types.some((t) => t.type === "evidencia no recuperada")).toBe(false);
  });

  test("una fila sin failure_types, o descuadrada, se agrupa por el mensaje literal sin reventar", () => {
    const c = caso({ min_faithfulness: 0.9 });
    const corridas = [corrida(0.33), corrida(0.33)];
    const viejas = corridas.map((r) => puntuarCaso(c, r));
    for (const f of viejas) delete (f as Partial<typeof f>).failure_types;
    const [score] = agregarCorridas(viejas, corridas);
    expect(score.failures).toEqual(["fidelidad 0.33 por debajo del mínimo 0.90 (2/2 corridas)"]);
    const descuadradas = corridas.map((r) => puntuarCaso(c, r));
    for (const f of descuadradas) f.failure_types = f.failure_types.slice(0, -1);
    expect(agregarCorridas(descuadradas, corridas)[0].failures).toEqual(["fidelidad 0.33 por debajo del mínimo 0.90 (2/2 corridas)"]);
  });

  test("el mismo tipo dos veces en una corrida cuenta una sola corrida", () => {
    const r = corrida(1.0);
    const fila = puntuarCaso(caso(), r);
    fila.failures = ["error de ejecución: timeout", "error de ejecución: 502"];
    fila.failure_types = [{ type: "error de ejecución", detail: "timeout" }, { type: "error de ejecución", detail: "502" }];
    const [score] = agregarCorridas([fila, puntuarCaso(caso(), r)], [r, r]);
    expect(score.failures).toEqual(["error de ejecución (1/2 corridas): timeout, 502"]);
  });

  test("la dispersión delata la inestabilidad que la mediana tapa, y la fidelidad se mediana solo sobre lo medido", () => {
    const [score, agregado] = agregar(caso(), [
      corrida(1.0, { hops: 6, ms_total: 1000, cost_usd: 0.02 }),
      corrida(0.33, { hops: 10, ms_total: 3000, cost_usd: 0.05 }),
      corrida(1.0, { hops: 8, ms_total: 1200, cost_usd: 0.02 }),
    ]);
    expect(score.metrics.faithfulness).toBe(1);
    expect(score.dispersion?.faithfulness).toEqual({ min: 0.33, max: 1, n: 3, values: [1, 0.33, 1] });
    expect(score.dispersion?.hops).toEqual({ min: 6, max: 10, n: 3, values: [6, 10, 8] });
    expect(score.dispersion?.abstained).toEqual({ rate: 0, values: [false, false, false] });
    expect(agregado.dispersion.ms_total).toEqual({ min: 1000, max: 3000, n: 3, values: [1000, 3000, 1200] });
    const [conHueco] = agregar(caso(), [resultado(), corrida(0.5), corrida(1.0)]);
    expect(conHueco.metrics.faithfulness).toBe(0.75);
    expect(conHueco.dispersion?.faithfulness).toEqual({ min: 0.5, max: 1, n: 2, values: [null, 0.5, 1] });
    const [ninguna] = agregar(caso(), [resultado(), resultado()]);
    expect(ninguna.metrics.faithfulness).toBeNull();
  });

  test("la evidencia agregada va por mayoría y une las fuentes; mezclar casos o agregar agregados rompe", () => {
    const sinB = corrida(1.0);
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const [score] = agregar(caso(), [corrida(1.0), corrida(1.0), sinB]);
    const b = score.evidence.find((e) => e.id === "b")!;
    expect(b.found).toBe(true);
    expect(b.found_rate).toBe(0.6667);
    expect(b.matched_sources).toEqual(["b.pdf"]);
    expect(() => agregarCorridas([puntuarCaso(caso({ id: "a" }), resultado()), puntuarCaso(caso({ id: "b" }), resultado())], [resultado(), resultado()])).toThrow(/mezcla casos/);
    expect(() => agregarCorridas([score], [resultado()])).toThrow(/ya están agregadas/);
  });

  test("resumir sobre agregados cuenta un caso por fila y señala los inestables", () => {
    const c = caso({ min_faithfulness: 0.9 });
    const [inestable, rInestable] = agregar(c, [corrida(1.0), corrida(1.0), corrida(0.33)]);
    const [estable, rEstable] = agregar(caso({ id: "otro" }), [corrida(1.0), corrida(1.0), corrida(1.0)]);
    const r = resumir([inestable, estable], [rInestable, rEstable]);
    expect(r.cases).toBe(2);
    expect(r.runs_total).toBe(6);
    expect(r.run_pass_rate).toBe(0.8333);
    expect(r.unstable_cases).toEqual(["mh-1"]);
    expect(r.release_gate_passed).toBe(true);
    expect(r.total_cost_usd_all_runs).toBe(0.12);
  });
});

// ---------------------------------------------------------------------------
// Métricas de recuperación y etapa del fallo (frente de evaluación continua)
// ---------------------------------------------------------------------------
/** Un candidato tal como lo anota el agente en `metrics.meta.recuperacion`. */
function cand(f: string, p: number, extra: { sp?: number[]; sec?: string; loc?: string } = {}) {
  return { f, p, loc: extra.loc ?? (p ? `pág. ${p}` : ""), ...(extra.sp ? { sp: extra.sp } : {}), ...(extra.sec !== undefined ? { sec: extra.sec } : {}) };
}

/** Relleno: candidatos de otro documento que no casan con nada. */
function ruido(n: number) {
  return Array.from({ length: n }, (_, i) => cand("ruido.pdf", i + 1));
}

function conRecuperacion(recuperacion: Record<string, unknown>, base: Resultado = resultado()): Resultado {
  const meta = (base.metrics?.meta as Record<string, unknown> | undefined) ?? {};
  return { ...base, metrics: { ...base.metrics, meta: { ...meta, recuperacion } } };
}

describe("recuperación: MRR, hit@k, precisión del contexto y etapa del fallo", () => {
  test("el rango de cada evidencia es el mejor entre los puntos, y el MRR y hit@k salen de ahí", () => {
    // `a` aparece la 7.ª en e0 y la 2.ª en e1: cuenta la 2. `b` es la 1.ª de e2.
    const r = conRecuperacion({
      e0: [...ruido(6), cand("a.pdf", 3)],
      e1: [cand("ruido.pdf", 9), cand("a.pdf", 3, { sp: [3, 4] })],
      e2: [cand("b.pdf", 0, { sec: "Resultados", loc: "sección: Resultados" })],
    });
    const s = puntuarCaso(caso(), r);
    expect(s.evidence.map((e) => [e.id, e.rank])).toEqual([["a", 2], ["b", 1]]);
    expect(s.metrics.retrieval_mrr).toBe(0.75);
    expect(s.metrics.retrieval_hit_at_5).toBe(1);
    expect(s.metrics.retrieval_hit_at_20).toBe(1);
    expect(s.passed).toBe(true);
  });

  test("hit@5 y hit@20 distinguen una evidencia que aparece la octava", () => {
    const r = conRecuperacion({
      e0: [...ruido(7), cand("a.pdf", 3)],
      e1: [cand("b.pdf", 0, { sec: "Results" })],
    });
    const s = puntuarCaso(caso(), r);
    expect(s.metrics.retrieval_hit_at_5).toBe(0.5);
    expect(s.metrics.retrieval_hit_at_20).toBe(1);
    expect(s.metrics.retrieval_mrr).toBe(0.5625);
    // Un candidato pasado el puesto 20 cuenta para el MRR pero no para hit@20.
    const lejos = puntuarCaso(caso(), conRecuperacion({ e0: [...ruido(24), cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }));
    expect(lejos.metrics.retrieval_hit_at_20).toBe(0.5);
    expect(lejos.evidence[0].rank).toBe(25);
  });

  test("ADVERSARIAL: un candidato del fichero correcto en OTRA página no cuenta, salvo que la traiga en sus páginas de origen", () => {
    const otraPagina = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 9)], e1: [cand("b.pdf", 0, { sec: "Results" })] }));
    expect(otraPagina.evidence[0].rank).toBeNull();
    expect(otraPagina.metrics.retrieval_mrr).toBe(0.5);
    const enOrigen = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 9, { sp: [2, 3] })], e1: [cand("b.pdf", 0, { sec: "Results" })] }));
    expect(enOrigen.evidence[0].rank).toBe(1);
    // Y la sección esperada se exige también al candidato: b.pdf en Métodos no es b.pdf en Resultados.
    const otraSeccion = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Methods" })] }));
    expect(otraSeccion.evidence[1].rank).toBeNull();
  });

  test("la etapa del fallo se deduce por eliminación: búsqueda, calificación o redacción", () => {
    // b no está entre los candidatos ni en las fuentes: la perdió la búsqueda.
    const base = resultado();
    base.sources = (base.sources ?? []).slice(0, 1);
    const busqueda = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: ruido(3) }, base));
    expect(busqueda.evidence[1]).toMatchObject({ found: false, rank: null, failure_stage: "retrieval" });
    expect(busqueda.failures).toContain("evidencia no recuperada: b");
    // b estaba entre los candidatos pero no llegó a las fuentes: la descartó el calificador.
    const calificacion = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }, base));
    expect(calificacion.evidence[1]).toMatchObject({ found: false, rank: 1, failure_stage: "grading" });
    // b llegó a las fuentes pero la respuesta no la citó: la ignoró la redacción. NO es un fallo del caso.
    const sinCitarB = resultado();
    sinCitarB.answer = "La cohorte tuvo 42% [a.pdf, pág. 3].";
    const redaccion = puntuarCaso(caso(), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }, sinCitarB));
    expect(redaccion.evidence[1]).toMatchObject({ found: true, cited: false, failure_stage: "generation" });
    expect(redaccion.evidence[0]).toMatchObject({ found: true, cited: true, failure_stage: null });
    expect(redaccion.passed).toBe(true);
    expect(redaccion.failures).toEqual([]);
  });

  test("sin candidatos informados (mensajes antiguos) las métricas de recuperación quedan null y nada falla", () => {
    const s = puntuarCaso(caso(), resultado());
    expect(s.metrics.retrieval_mrr).toBeNull();
    expect(s.metrics.retrieval_hit_at_5).toBeNull();
    expect(s.metrics.retrieval_hit_at_20).toBeNull();
    expect(s.evidence.every((e) => e.rank === null)).toBe(true);
    expect(s.passed).toBe(true);
    // Una evidencia que falta sin candidatos no puede achacarse a ninguna etapa.
    const sinB = resultado();
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const f = puntuarCaso(caso(), sinB);
    expect(f.evidence[1]).toMatchObject({ found: false, rank: null, failure_stage: null });
    expect(f.passed).toBe(false);
  });

  test("ADVERSARIAL: una `recuperacion` malformada se trata como ausente, y una vacía como cero", () => {
    const rota = puntuarCaso(caso(), conRecuperacion("esto no es un objeto" as unknown as Record<string, unknown>));
    expect(rota.metrics.retrieval_mrr).toBeNull();
    const lista = puntuarCaso(caso(), conRecuperacion({ e0: "no es una lista", e1: [null, 7, cand("a.pdf", 3)] }));
    expect(lista.evidence[0].rank).toBe(1);
    expect(lista.evidence[1].rank).toBeNull();
    const vacia = puntuarCaso(caso(), conRecuperacion({}));
    expect(vacia.metrics.retrieval_mrr).toBe(0);
    expect(vacia.metrics.retrieval_hit_at_5).toBe(0);
    expect(vacia.evidence.every((e) => e.rank === null)).toBe(true);
    // Y sigue pasando: la recuperación mide, no penaliza.
    expect(vacia.passed).toBe(true);
  });

  test("un caso de abstención no exige evidencias: MRR null y precisión del contexto 1", () => {
    const c = validarCaso({ id: "neg-1", question: "algo ausente", category: "abstencion", evidence: [], expect_abstention: true });
    const s = puntuarCaso(c, conRecuperacion({ e0: ruido(5) }, { answer: "No encuentro esa información en los documentos.", sources: [], hops: [{}] }));
    expect(s.metrics.retrieval_mrr).toBeNull();
    expect(s.metrics.retrieval_hit_at_5).toBeNull();
    expect(s.metrics.context_precision).toBe(1);
    expect(s.passed).toBe(true);
  });

  test("la precisión del contexto es la fracción de fuentes entregadas que el caso esperaba", () => {
    expect(puntuarCaso(caso(), resultado()).metrics.context_precision).toBe(1);
    const conRuido = resultado();
    conRuido.sources = [...(conRuido.sources ?? []), { source_file: "ruido.pdf", page: 1, locator: "pág. 1" }, { source_file: "a.pdf", page: 9, locator: "pág. 9" }];
    expect(puntuarCaso(caso(), conRuido).metrics.context_precision).toBe(0.5);
    const sinFuentes = puntuarCaso(caso(), { ...resultado(), sources: [] });
    expect(sinFuentes.metrics.context_precision).toBe(1);
    expect(sinFuentes.passed).toBe(false);
  });

  test("las atribuciones a otra entidad se leen del verificador y valen 0 si faltan", () => {
    expect(puntuarCaso(caso(), resultado()).metrics.entity_misattributions).toBe(0);
    const s = puntuarCaso(caso(), conVerificacion({ fidelidad: 0.5, no_sostenidas: 2, entidad_distinta: 1 }));
    expect(s.metrics.entity_misattributions).toBe(1);
    expect(s.passed).toBe(false);
    expect(puntuarCaso(caso(), conVerificacion({ entidad_distinta: "dos" })).metrics.entity_misattributions).toBe(0);
  });

  test("agregarCorridas mediana las métricas nuevas, deja null lo que ninguna corrida midió y agrega la etapa con coherencia", () => {
    const rec = (rango: number) => ({ e0: [...ruido(rango - 1), cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] });
    const [score] = agregar(caso(), [conRecuperacion(rec(1)), conRecuperacion(rec(2)), conRecuperacion(rec(10))]);
    expect(score.metrics.retrieval_mrr).toBe(0.75);
    expect(score.metrics.retrieval_hit_at_5).toBe(1);
    expect(score.dispersion?.retrieval_mrr).toEqual({ min: 0.55, max: 1, n: 3, values: [1, 0.75, 0.55] });
    expect(score.evidence[0]).toMatchObject({ found: true, rank: 2, cited: true, failure_stage: null });
    const [antiguas] = agregar(caso(), [resultado(), resultado()]);
    expect(antiguas.metrics.retrieval_mrr).toBeNull();
    expect(antiguas.metrics.context_precision).toBe(1);
    expect(antiguas.dispersion?.retrieval_mrr).toEqual({ min: null, max: null, n: 0, values: [null, null] });
  });

  test("ADVERSARIAL: la etapa agregada nunca contradice a `found`", () => {
    // b falta en dos corridas (una por búsqueda, otra por calificación) y aparece citada en una: por mayoría falta.
    const sinB = resultado();
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const [falta] = agregar(caso(), [
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: ruido(2) }, sinB),
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }, sinB),
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }),
    ]);
    const b = falta.evidence.find((e) => e.id === "b")!;
    expect(b.found).toBe(false);
    expect(["retrieval", "grading"]).toContain(b.failure_stage);
    // Al revés: encontrada dos de tres veces, la vez que faltó fue por búsqueda. La etapa no puede ser "retrieval".
    const [aparece] = agregar(caso(), [
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }),
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }),
      conRecuperacion({ e0: [cand("a.pdf", 3)], e1: ruido(2) }, sinB),
    ]);
    const b2 = aparece.evidence.find((e) => e.id === "b")!;
    expect(b2.found).toBe(true);
    expect(b2.failure_stage).toBeNull();
  });

  test("resumir promedia solo lo medido, suma las atribuciones y cuenta los fallos por etapa", () => {
    const sinB = resultado();
    sinB.sources = (sinB.sources ?? []).slice(0, 1);
    const medido = puntuarCaso(caso({ id: "medido" }), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: ruido(2) }, sinB));
    const antiguo = puntuarCaso(caso({ id: "antiguo" }), conVerificacion({ entidad_distinta: 2, no_sostenidas: 2, fidelidad: 0.5 }));
    const sinCitarB = resultado();
    sinCitarB.answer = "La cohorte tuvo 42% [a.pdf, pág. 3].";
    const redaccion = puntuarCaso(caso({ id: "redaccion" }), conRecuperacion({ e0: [cand("a.pdf", 3)], e1: [cand("b.pdf", 0, { sec: "Results" })] }, sinCitarB));
    const r = resumir([medido, antiguo, redaccion], [sinB, resultado(), sinCitarB]);
    expect(r.mean_retrieval_mrr).toBe(0.75);
    expect(r.mean_retrieval_hit_at_5).toBe(0.75);
    expect(r.mean_context_precision).toBe(1);
    expect(r.entity_misattributions_total).toBe(2);
    expect(r.failures_by_stage).toEqual({ retrieval: 1, grading: 0, generation: 1 });
    // Solo abstenciones o solo turnos antiguos: no hay media que dar.
    const soloAntiguo = resumir([antiguo], [resultado()]);
    expect(soloAntiguo.mean_retrieval_mrr).toBeNull();
    expect(soloAntiguo.failures_by_stage).toEqual({ retrieval: 0, grading: 0, generation: 0 });
  });
});
