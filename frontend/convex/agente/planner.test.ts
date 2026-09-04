// Planificador: post-proceso determinista, ancla e0 con su inglés y la
// clasificación previa. Sin red: `completionJson` va parcheado.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import * as gateway from "../lib/gateway";
import { ajustes, modeloRerankResuelto } from "../lib/config";
import { Telemetria } from "../lib/telemetry";
import {
  ANCLA_EVIDENCE_NEEDED,
  clasificar,
  conAncla,
  planificar,
  type PuntoPlan,
} from "./planner";

function respuesta(datos: unknown, extra: Partial<{ modelo: string; finishReason: string }> = {}) {
  return {
    datos,
    usage: { prompt: 100, cached: 0, completion: 20, reasoning: 5 },
    modelo: extra.modelo ?? "",
    finishReason: extra.finishReason ?? "stop",
    razonamientoRechazado: false,
  };
}

function ultimoMensajeUsuario(espia: MockInstance<typeof gateway.completionJson>, n = -1): string {
  const llamadas = espia.mock.calls;
  const kwargs = llamadas[n < 0 ? llamadas.length + n : n][0] as { messages: { role: string; content: string }[] };
  return kwargs.messages[kwargs.messages.length - 1].content;
}

let espia: MockInstance<typeof gateway.completionJson>;
beforeEach(() => {
  espia = vi.spyOn(gateway, "completionJson");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("planificar", () => {
  test("deduplica, renumera, acota y devuelve pregunta_en", async () => {
    espia.mockResolvedValueOnce(
      respuesta({
        pregunta_en: "  a literal question ",
        items: [
          { id: "e7", query: "AUC p-tau217", query_en: "AUC p-tau217", evidence_needed: "el AUC" },
          { id: "e1", query: "auc  P-TAU217", evidence_needed: "repetida" },
          { query: "", evidence_needed: "sin consulta" },
          "basura",
          null,
          ["query", "en lista"],
          { query: "cohorte", query_en: "cohort", evidence_needed: "" },
          { query: "una pregunta literal", evidence_needed: "igual que e0" },
          { query: "sobra", evidence_needed: "por el tope" },
          { query: "ya no cabe", evidence_needed: "tope" },
        ],
      }),
    );
    const { items, preguntaEn } = await planificar("una pregunta literal", [], 3);

    // El tope cuenta items VÁLIDOS (los repetidos, vacíos o iguales a la
    // pregunta no gastan hueco), y los ids salen por posición, no del modelo.
    expect(items.map((it) => [it.id, it.query, it.queryEn])).toEqual([
      ["e1", "AUC p-tau217", ""], // query_en igual a query se vacía
      ["e2", "cohorte", "cohort"],
      ["e3", "sobra", ""],
    ]);
    expect(items[1].evidenceNeeded).toBe("evidencia para esta subpregunta");
    expect(preguntaEn).toBe("a literal question");

    espia.mockResolvedValueOnce(
      respuesta({ items: Array.from({ length: 6 }, (_, i) => ({ query: `q${i}`, evidence_needed: "d" })) }),
    );
    const otro = await planificar("p", [], 4);
    expect(otro.items.map((it) => it.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(otro.preguntaEn).toBe(""); // sin pregunta_en no se inventa una
  });

  test("una pregunta_en igual a la pregunta se vacía: no hay segunda búsqueda que hacer", async () => {
    espia.mockResolvedValueOnce(
      respuesta({ pregunta_en: "Plasma  P-TAU217 AUC", items: [{ query: "x", evidence_needed: "d" }] }),
    );
    const { preguntaEn } = await planificar("plasma p-tau217 auc", [], 3);
    expect(preguntaEn).toBe("");
  });

  test("falla a items vacío y preguntaEn vacía, y anota UNA ronda por llamada", async () => {
    const tel = new Telemetria();
    espia.mockResolvedValueOnce(respuesta({ pregunta_en: "q", items: "no es lista" }));
    expect(await planificar("p", [], 3, tel)).toEqual({ items: [], preguntaEn: "" });

    espia.mockRejectedValueOnce(new SyntaxError("Unexpected token < in JSON"));
    expect(await planificar("p", [], 3, tel)).toEqual({ items: [], preguntaEn: "" });

    espia.mockRejectedValueOnce(new Error("gateway 503"));
    expect(await planificar("p", [], 3, tel)).toEqual({ items: [], preguntaEn: "" });

    // Lista vacía válida: no es un fallo, y el inglés del ancla se conserva.
    espia.mockResolvedValueOnce(respuesta({ pregunta_en: "the question", items: [] }));
    expect(await planificar("la pregunta", [], 3, tel)).toEqual({ items: [], preguntaEn: "the question" });

    // Una ronda por llamada, ni una más: el JSON sin lista NO deja una ronda
    // "ok" y otra en fallo.
    expect(tel.rondas.map((r) => [r.componente, r.ok])).toEqual([
      ["planner", false],
      ["planner", false],
      ["planner", false],
      ["planner", true],
    ]);
    expect(tel.rondas[0].nota).toContain("sin lista items");
    expect(tel.rondas[3].prompt).toBe(100);
  });

  test("usa el modelo grande, el razonamiento del planner, el historial y pide pregunta_en", async () => {
    espia.mockResolvedValueOnce(respuesta({ items: [] }));
    const historial = [
      { role: "user", content: "vieja 1" },
      { role: "assistant", content: "vieja 2" },
      { role: "system", content: "no debe salir" },
      { role: "user", content: "¿cuál es el AUC de p-tau217?" },
      { role: "assistant", content: "  El AUC   fue\n0,94 " + "x".repeat(700) },
      { role: "user", content: "¿y en la otra cohorte?" },
    ];
    await planificar("¿y en la otra cohorte?", historial, 5);

    const a = ajustes();
    const kwargs = espia.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(a.modelo);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect(kwargs.reasoning_effort).toBe(a.razonamientoPlanner);
    const sistema = (kwargs.messages as { content: string }[])[0].content;
    expect(sistema).toContain('"pregunta_en"');
    expect(sistema).toContain("contradicciones");
    expect(sistema).toContain('"query_en"');
    expect(sistema).toContain('"evidence_needed"');
    const usuario = ultimoMensajeUsuario(espia);
    // Los últimos 4 turnos user/assistant, sin el de sistema y sin "vieja 1".
    expect(usuario).toContain("Historial reciente");
    expect(usuario).not.toContain("vieja 1");
    expect(usuario).toContain("Asistente: vieja 2");
    expect(usuario).not.toContain("no debe salir");
    expect(usuario).toContain("Asistente: El AUC fue 0,94 xxx"); // espacios colapsados
    expect(usuario).not.toContain("x".repeat(700)); // recortado a 600
    expect(usuario).toContain("Máximo: 5\nPregunta: ¿y en la otra cohorte?");
  });

  test("sin historial no se añade la sección de historial", async () => {
    espia.mockResolvedValueOnce(respuesta({ items: [] }));
    await planificar("p", [], 2);
    expect(ultimoMensajeUsuario(espia)).toBe("Máximo: 2\nPregunta: p");
  });
});

describe("conAncla", () => {
  test("pone e0 con la pregunta literal y su inglés, deduplica y renumera", () => {
    const solo = conAncla("  Pregunta literal ", "", []);
    expect(solo.map((it) => [it.id, it.query, it.queryEn])).toEqual([["e0", "Pregunta literal", ""]]);
    expect(solo[0].evidenceNeeded).toBe(ANCLA_EVIDENCE_NEEDED);

    const items: PuntoPlan[] = [
      { id: "e1", query: "pregunta  LITERAL", queryEn: "", evidenceNeeded: "dup" },
      { id: "e2", query: "otra", queryEn: "other", evidenceNeeded: "d2" },
      { id: "e3", query: "otra", queryEn: "", evidenceNeeded: "d3" },
      { id: "e9", query: "   ", queryEn: "", evidenceNeeded: "vacía" },
      { id: "e4", query: "tercera", queryEn: "", evidenceNeeded: "d4" },
    ];
    const plan = conAncla("Pregunta literal", "  Literal question ", items);
    expect(plan.map((it) => [it.id, it.query, it.queryEn])).toEqual([
      ["e0", "Pregunta literal", "Literal question"],
      ["e1", "otra", "other"],
      ["e2", "tercera", ""],
    ]);
    expect(plan[1].evidenceNeeded).toBe("d2");
  });

  test("un preguntaEn igual a la pregunta no se cuela como inglés", () => {
    const plan = conAncla("Plasma p-tau217 AUC", "plasma  P-TAU217 auc", []);
    expect(plan[0].queryEn).toBe("");
  });

  test("es determinista: la misma entrada da los mismos ids en el mismo orden", () => {
    const items: PuntoPlan[] = [
      { id: "z", query: "b", queryEn: "", evidenceNeeded: "" },
      { id: "y", query: "a", queryEn: "", evidenceNeeded: "" },
    ];
    expect(conAncla("q", "", items)).toEqual(conAncla("q", "", items));
    expect(conAncla("q", "", items).map((it) => it.id)).toEqual(["e0", "e1", "e2"]);
  });
});

describe("clasificar", () => {
  test("reconoce las tres clases con el modelo pequeño y el razonamiento ya medido", async () => {
    const tel = new Telemetria();
    espia.mockResolvedValueOnce(respuesta({ clase: "sobre_el_asistente" }));
    expect(await clasificar("¿qué eres?", [], tel)).toBe("sobre_el_asistente");
    espia.mockResolvedValueOnce(respuesta({ clase: "conversacional" }));
    expect(await clasificar("hola", [], tel)).toBe("conversacional");
    espia.mockResolvedValueOnce(respuesta({ clase: "documental" }));
    expect(await clasificar("¿cuál es el AUC?", [], tel)).toBe("documental");

    const a = ajustes();
    const kwargs = espia.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(modeloRerankResuelto(a));
    // El mismo esfuerzo que el calificador, medido con este modelo: un valor
    // distinto que la API rechazara apagaría el razonamiento de todo el turno.
    expect(kwargs.reasoning_effort).toBe(a.razonamientoCalificador);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect(ultimoMensajeUsuario(espia, 0)).toBe("Mensaje a clasificar: ¿qué eres?");
    expect(tel.rondas.map((r) => [r.componente, r.ok, r.nota])).toEqual([
      ["clasificador", true, "clase=sobre_el_asistente"],
      ["clasificador", true, "clase=conversacional"],
      ["clasificador", true, "clase=documental"],
    ]);
  });

  test("tolera la forma pero no el contenido: variantes se aceptan, lo desconocido es documental", async () => {
    espia.mockResolvedValueOnce(respuesta({ clase: " Sobre el asistente " }));
    expect(await clasificar("¿qué sabes hacer?", [])).toBe("sobre_el_asistente");
    espia.mockResolvedValueOnce(respuesta({ clase: "otra cosa" }));
    expect(await clasificar("x", [])).toBe("documental");
    espia.mockResolvedValueOnce(respuesta({}));
    expect(await clasificar("x", [])).toBe("documental");
    espia.mockResolvedValueOnce(respuesta({ clase: 3 }));
    expect(await clasificar("x", [])).toBe("documental");
  });

  test("ante un fallo cae a documental: buscar de más es más seguro que no buscar", async () => {
    const tel = new Telemetria();
    espia.mockRejectedValueOnce(new Error("gateway 503"));
    expect(await clasificar("hola", [], tel)).toBe("documental");
    expect(tel.rondas.map((r) => [r.componente, r.ok])).toEqual([["clasificador", false]]);
  });

  test("enseña el historial reciente para que una repregunta corta sea documental", async () => {
    espia.mockResolvedValueOnce(respuesta({ clase: "documental" }));
    await clasificar("¿y en la otra?", [
      { role: "user", content: "AUC de p-tau217" },
      { role: "assistant", content: "0,94 [a.pdf, pág. 3]" },
    ]);
    const usuario = ultimoMensajeUsuario(espia);
    expect(usuario).toContain("Usuario: AUC de p-tau217");
    expect(usuario).toContain("Asistente: 0,94 [a.pdf, pág. 3]");
    expect(usuario.endsWith("Mensaje a clasificar: ¿y en la otra?")).toBe(true);
  });
});
