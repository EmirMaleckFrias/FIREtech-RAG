// Verificación de atribución: troceo, resolución de citas y veredictos.
//
// Lo que se protege aquí es el contrato que hace útil al verificador en
// investigación médica: que NUNCA apruebe por omisión. Un verificador que ante
// un fallo del modelo, un JSON roto o un tope alcanzado deja las afirmaciones
// como "sostenidas" produce una garantía falsa, que es peor que no tener
// verificación.
//
// Sin red: `gateway.completionJson` se parchea con `vi.spyOn` sobre el módulo
// importado como namespace, que es como lo llama la implementación.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as gateway from "../lib/gateway";
import { ajustes } from "../lib/config";
import { Telemetria } from "../lib/telemetry";
import { cita, type Fragmento } from "../lib/citas";
import * as revisor from "./revisor";
import {
  _esAusenciaPura,
  CITA_NO_RESUELVE,
  NO_SOSTENIDA,
  PARCIAL,
  SIN_CITA,
  SIN_VERIFICAR,
  SOSTENIDA,
  _cobertura,
  _tieneAfirmaciones,
  _trocear,
  cifrasDe,
  cifrasSinRespaldo,
  claveDeAfirmacion,
  identificadoresDe,
  identificadoresSinRespaldo,
  limpiarEncabezado,
  informeVacio,
  verificar,
  veredictosDe,
  type Afirmacion,
  type Verificacion,
} from "./verificador";

// --- Utilidades --------------------------------------------------------------

function frag(id: string, texto: string, archivo: string, pagina: number, extra: Partial<Fragmento> = {}): Fragmento {
  return { _id: id, text: texto, sourceFile: archivo, page: pagina, chunkType: "text", documentType: "pdf", ...extra };
}

type RespuestaJson = Awaited<ReturnType<typeof gateway.completionJson>>;

function respuestaJson(datos: unknown, usage = { prompt: 50, cached: 0, completion: 5, reasoning: 0 }): RespuestaJson {
  return { datos, usage, modelo: "openai/gpt-5.4-mini", finishReason: "stop", razonamientoRechazado: false };
}

function veredictos(informe: Verificacion): string[] {
  return informe.afirmaciones.map((a) => a.veredicto);
}

function ultimoMensaje(llamada: unknown[]): string {
  const kwargs = llamada[0] as { messages: Array<{ content: string }> };
  return kwargs.messages[kwargs.messages.length - 1].content;
}

function afirmacion(campos: Partial<Afirmacion> & { texto: string }): Afirmacion {
  return { cita: "", veredicto: SIN_VERIFICAR, motivo: "", fragmento_id: "", fragmentos: [], ...campos };
}

const ENV_TOCADO = ["VERIFIER_MAX_CLAIMS", "VERIFIER_REASONING_EFFORT", "LLM_TEMPERATURE", "VERIFIER_MODEL", "RERANK_MODEL"];

// El tipo del espía se deriva de una función y no del genérico de `vi.spyOn`,
// que en vitest 2.1 no admite instanciación explícita.
const espiar = () => vi.spyOn(gateway, "completionJson");
let espia: ReturnType<typeof espiar>;

beforeEach(() => {
  for (const k of ENV_TOCADO) delete process.env[k];
  gateway._reiniciarRazonamiento();
  // Sin implementación: si algún test llega al gateway sin haberlo programado,
  // falla en vez de salir a la red.
  espia = espiar().mockRejectedValue(new Error("llamada no programada"));
  // Los lotes caídos avisan por consola; en los tests es ruido esperado.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ENV_TOCADO) delete process.env[k];
});

// ---------------------------------------------------------------------------
// Troceo y resolución de citas: deterministas, sin modelo
// ---------------------------------------------------------------------------
describe("sin citas", () => {
  test("una abstención sin citas es correcta y no gasta llamada", async () => {
    // No citar es lo correcto cuando la respuesta declara que no hay datos.
    // Es el único caso en que la ausencia de citas no es un fallo.
    const informe = await verificar("No encuentro ese dato en los documentos.", []);

    expect(informe.afirmaciones).toEqual([]);
    expect(informe.fidelidad).toBeNull();
    expect(informe.ok).toBe(true);
    expect(informe.nota).toContain("se abstiene");
    expect(espia).not.toHaveBeenCalled();
  });

  test("(e) una respuesta entera de abstención, con fragmentos recuperados, sigue siendo ok", async () => {
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);
    const informe = await verificar(
      "No encuentro la especificidad en los documentos. Los documentos no mencionan la sensibilidad.",
      [ch],
    );

    expect(informe.afirmaciones).toEqual([]);
    expect(informe.ok).toBe(true);
    expect(informe.citas_sin_resolver).toEqual([]);
    expect(espia).not.toHaveBeenCalled();
  });

  test("una respuesta factual sin citas es el peor caso", async () => {
    // Regresión de una permisividad que se colaba: antes CUALQUIER respuesta
    // sin citas devolvía ok=true con "nada que atribuir". El razonamiento
    // estaba al revés.
    const informe = await verificar("El AUC de p-tau217 fue 0.94 en una cohorte de 412 pacientes.", []);

    expect(informe.ok).toBe(false);
    expect(veredictos(informe)).toEqual([SIN_CITA]);
    // 0.0 y no null: aquí sí se midió, y nada está respaldado
    expect(informe.fidelidad).toBe(0);
    expect(informe.nota).toContain("sin una sola cita");
    expect(espia).not.toHaveBeenCalled();
  });

  test("sin citas y sin abstención reporta el plan entero sin cubrir (sin mapa)", async () => {
    const informe = await verificar("Los tres estudios coinciden en el desenlace.", [], {
      e1: "la cifra",
      e2: "la cohorte",
    });
    expect(informe.ok).toBe(false);
    expect(informe.evidencia_sin_cubrir).toEqual(["e1", "e2"]);
  });

  test("una respuesta de inventario no es una afirmación sin cita", async () => {
    // `[inventario del índice]` NO casa con el patrón de citas a propósito: no
    // apunta a un fragmento sino a un conteo exacto. Sin reconocerla, "tienes
    // 12 documentos" se leía como el peor veredicto posible.
    const informe = await verificar("Hay 12 documentos indexados y 173 fragmentos en total [inventario del índice].", []);

    expect(informe.ok).toBe(true);
    expect(informe.afirmaciones).toEqual([]);
    expect(informe.fidelidad).toBeNull();
    expect(informe.nota).toContain("inventario del índice");
    expect(espia).not.toHaveBeenCalled();
  });

  test("la cita de inventario se reconoce sin tilde ni mayúsculas", async () => {
    for (const variante of ["Hay 3 documentos [inventario del indice].", "Hay 3 documentos [Inventario del Índice]."]) {
      const informe = await verificar(variante, []);
      expect(informe.ok, variante).toBe(true);
      expect(informe.afirmaciones, variante).toEqual([]);
    }
  });
});

describe("resolución de citas", () => {
  test("una cita que no resuelve se marca sin llamar al modelo", async () => {
    const chunks = [frag("c1", "El AUC fue 0.94.", "estudio_a.pdf", 3)];
    const informe = await verificar("El AUC fue 0.94 [inventado.pdf, pág. 9].", chunks);

    expect(veredictos(informe)).toEqual([CITA_NO_RESUELVE]);
    expect(informe.citas_sin_resolver).toEqual(["[inventado.pdf, pág. 9]"]);
    expect(informe.fidelidad).toBeNull(); // ninguna llegó a juicio del modelo
    expect(espia).not.toHaveBeenCalled();
  });

  test("la cita resuelve aunque cambien los espacios", async () => {
    // Estricto en contenido, laxo en forma: un espacio de más no es una cita
    // inventada, y tratarlo como tal sería un falso positivo constante.
    const ch = frag("c1", "La conversión fue del 31.6%.", "estudio_a.pdf", 3);
    const alterada = cita(ch).replace(", ", ",  ");
    expect(alterada).not.toBe(cita(ch));
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(`La conversión fue del 31.6% ${alterada}.`, [ch]);

    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.citas_sin_resolver).toEqual([]);
  });

  test("citar el inventario no blanquea una respuesta de contenido", async () => {
    const ch = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "no consta" }] }));

    const informe = await verificar(`Hay 3 documentos [inventario del índice]. El AUC fue 0.99 ${cita(ch)}.`, [ch]);

    expect(veredictos(informe)).toEqual([NO_SOSTENIDA]);
    expect(informe.afirmaciones[0].texto).toBe("El AUC fue 0.99");
    expect(informe.fidelidad).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Veredictos del modelo
// ---------------------------------------------------------------------------
describe("veredictos", () => {
  test("reparte veredictos y calcula la fidelidad en una sola llamada", async () => {
    const a = frag("c1", "La conversión a demencia fue del 31.6%.", "a.pdf", 2);
    const b = frag("c2", "El AUC de p-tau217 fue 0.94.", "b.pdf", 5);
    const c = frag("c3", "La cohorte incluyó 412 pacientes.", "c.pdf", 1);
    const respuesta =
      `La conversión fue del 31.6% ${cita(a)}. El AUC alcanzó 0.99 ${cita(b)}. ` +
      `Participaron 412 pacientes, todos varones ${cita(c)}.`;
    espia.mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 0, veredicto: "sostenida", motivo: "cifra idéntica" },
          { i: 1, veredicto: "no_sostenida", motivo: "el fragmento dice 0.94" },
          { i: 2, veredicto: "parcial", motivo: "el sexo no consta" },
        ],
      }),
    );

    const informe = await verificar(respuesta, [a, b, c]);

    expect(veredictos(informe)).toEqual([SOSTENIDA, NO_SOSTENIDA, PARCIAL]);
    expect(informe.fidelidad).toBeCloseTo(1 / 3);
    expect(informe.ok).toBe(true);
    expect(espia).toHaveBeenCalledTimes(1);
    // el fragmento citado viaja en el prompt: sin su texto no hay verificación
    expect(ultimoMensaje(espia.mock.calls[0])).toContain("El AUC de p-tau217 fue 0.94.");
  });

  test("el motivo del modelo llega al informe y fragmento_id es la cita del hermano", async () => {
    const ch = frag("c1", "El seguimiento fue de 36 meses.", "a.pdf", 4);
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "el fragmento dice 36, no 60" }] }),
    );

    const informe = await verificar(`El seguimiento fue de 60 meses ${cita(ch)}.`, [ch]);

    expect(informe.afirmaciones[0].motivo).toBe("el fragmento dice 36, no 60");
    expect(informe.afirmaciones[0].fragmento_id).toBe(cita(ch));
    expect(informe.afirmaciones[0].fragmentos).toEqual(["c1"]);
  });

  test("el veredicto se normaliza en mayúsculas y el motivo se recorta", async () => {
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: "0", veredicto: " SOSTENIDA ", motivo: "x".repeat(500) }] }),
    );
    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch]);
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.afirmaciones[0].motivo).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// El contrato que importa: nunca aprobar por omisión
// ---------------------------------------------------------------------------
describe("nunca aprobar por omisión", () => {
  test("si el modelo falla nada queda sostenido", async () => {
    const ch = frag("c1", "La conversión fue del 31.6%.", "a.pdf", 2);
    espia.mockRejectedValueOnce(new Error("API caída"));

    const informe = await verificar(`Cualquier cosa ${cita(ch)}.`, [ch]);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR]);
    expect(informe.ok).toBe(false);
    expect(informe.fidelidad).toBeNull();
    expect(informe.nota).toContain("no pudo dictaminar");
  });

  test("un JSON sin lista de veredictos no sostiene nada", async () => {
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ otra_cosa: [] }));

    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch]);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR]);
    expect(informe.ok).toBe(false);
  });

  test("un veredicto inventado se descarta", async () => {
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "excelente", motivo: "muy bien" }] }));

    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch]);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR]);
    expect(informe.fidelidad).toBeNull();
  });

  test("un índice fuera de rango, negativo o no entero no contamina", async () => {
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 7, veredicto: "sostenida", motivo: "no existe" },
          { i: -1, veredicto: "sostenida", motivo: "no existe" },
          { i: 0.5, veredicto: "sostenida", motivo: "no existe" },
          // `Number(true)` es 1: sin la comprobación de tipo se colaría
          { i: true, veredicto: "sostenida", motivo: "no existe" },
          { veredicto: "sostenida", motivo: "sin índice" },
          "basura",
          null,
        ],
      }),
    );

    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch]);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR]);
  });

  test("una respuesta larga se verifica EN LOTES sin dejar nada fuera", async () => {
    // El tope acota el tamaño de cada petición, no cuánto se verifica. Antes
    // recortaba: lo que excedía el tope quedaba sin_verificar, un agujero
    // silencioso justo en las respuestas largas (34 y 36 afirmaciones con 10
    // y 12 sin juzgar en la sesión de estrés).
    process.env.VERIFIER_MAX_CLAIMS = "2";
    const chunks = [0, 1, 2, 3].map((i) => frag(`c${i}`, `Dato ${i}.`, `doc_${i}.pdf`, i + 1));
    const respuesta = chunks.map((c, i) => `Afirmación ${i} ${cita(c)}.`).join(" ");
    // dos lotes de dos: el índice `i` de cada respuesta es LOCAL a su lote
    espia
      .mockResolvedValueOnce(
        respuestaJson({
          veredictos: [
            { i: 0, veredicto: "sostenida", motivo: "ok" },
            { i: 1, veredicto: "no_sostenida", motivo: "no consta" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        respuestaJson({
          veredictos: [
            { i: 0, veredicto: "sostenida", motivo: "ok" },
            { i: 1, veredicto: "parcial", motivo: "a medias" },
          ],
        }),
      );

    const informe = await verificar(respuesta, chunks);

    expect(veredictos(informe)).toEqual([SOSTENIDA, NO_SOSTENIDA, SOSTENIDA, PARCIAL]);
    expect(informe.fidelidad).toBeCloseTo(0.5);
    expect(espia).toHaveBeenCalledTimes(2);
  });

  test("sin afirmaciones sostenidas el plan queda sin cubrir (sin mapa)", async () => {
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "no lo dice" }] }));

    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch], { e1: "la cifra", e2: "la cohorte" });

    expect(informe.evidencia_sin_cubrir).toEqual(["e1", "e2"]);
  });

  test("el informe es serializable tal cual", async () => {
    // Viaja a la fila del mensaje: si no serializa, reventaría en producción.
    const ch = frag("c1", "Texto.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`Afirmación ${cita(ch)}.`, [ch]);
    const plano = JSON.parse(JSON.stringify(informe));

    expect(plano.fidelidad).toBe(1);
    expect(plano.afirmaciones[0].veredicto).toBe(SOSTENIDA);
    expect(plano.afirmaciones[0].cita).toBe(cita(ch));
  });
});

// ---------------------------------------------------------------------------
// Regresiones: la fidelidad reportada era una garantía falsa por dos vías
// ---------------------------------------------------------------------------
describe("troceo", () => {
  test("una lista con una sola cita audita todas sus viñetas y salta la cabecera", async () => {
    // El prompt del agente empuja a citar UNA vez por lista, y antes solo se
    // auditaba la última frase del tramo: cinco viñetas producían una
    // afirmación y "fidelidad 1.0". Las otras cuatro desaparecían.
    const ch = frag("c1", "Datos del estudio.", "estudio.pdf", 3);
    const respuesta =
      "Los hallazgos principales son:\n" +
      "- La conversión fue del 31.6%.\n" +
      "- El AUC de p-tau217 fue 0.94.\n" +
      `- La cohorte incluyó 412 pacientes ${cita(ch)}.`;
    espia.mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 0, veredicto: "sostenida", motivo: "ok" },
          { i: 1, veredicto: "no_sostenida", motivo: "no consta" },
          { i: 2, veredicto: "sostenida", motivo: "ok" },
        ],
      }),
    );

    const informe = await verificar(respuesta, [ch]);

    expect(informe.afirmaciones).toHaveLength(3);
    expect(veredictos(informe)).toEqual([SOSTENIDA, NO_SOSTENIDA, SOSTENIDA]);
    expect(informe.fidelidad).toBeCloseTo(2 / 3);
    expect(informe.afirmaciones.every((a) => !a.texto.includes("hallazgos principales"))).toBe(true);
  });

  test("el punto suelto tras una cita no es una afirmación", async () => {
    const a = frag("c1", "Primero.", "a.pdf", 1);
    const b = frag("c2", "Segundo.", "b.pdf", 2);
    espia.mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 0, veredicto: "sostenida", motivo: "ok" },
          { i: 1, veredicto: "sostenida", motivo: "ok" },
        ],
      }),
    );

    const informe = await verificar(`Uno ${cita(a)}. Dos ${cita(b)}.`, [a, b]);

    expect(informe.afirmaciones.map((x) => x.texto)).toEqual(["Uno", "Dos"]);
  });

  test("una cita compartida por varios fragmentos los manda todos al juez", async () => {
    // `cita()` no es única: con fragmentos de ~400 tokens una página produce
    // dos o tres con la MISMA cita. Con un mapa de un fragmento por cita se
    // juzgaba contra el hermano equivocado.
    const a = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 4, { citation: "Allegri et al., 2023" });
    const b = frag("c2", "El AUC fue 0.94.", "e.pdf", 4, { citation: "Allegri et al., 2023" });
    expect(cita(a)).toBe(cita(b)); // la premisa del bug
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "consta" }] }));

    const informe = await verificar(`La conversión fue del 31.6% ${cita(a)}.`, [a, b]);

    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.afirmaciones[0].fragmentos).toEqual(["c1", "c2"]);
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado).toContain("La conversión fue del 31.6%.");
    expect(enviado).toContain("El AUC fue 0.94.");
    expect(enviado).toContain("FRAGMENTO 1 DE 2");
    expect(enviado).toContain("FRAGMENTO 2 DE 2");
  });

  test("una afirmación después de la última cita no desaparece", async () => {
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(`El AUC fue 0.94 ${cita(ch)}. La cohorte tuvo 900 pacientes.`, [ch]);

    expect(veredictos(informe)).toEqual([SOSTENIDA, SIN_CITA]);
    expect(informe.afirmaciones[1].motivo).toContain("posterior a la última cita");
    expect(informe.ok).toBe(false);
  });

  test("un encabezado Markdown no es una afirmación, pero una afirmación en negrita sí", async () => {
    // El modelo actual titula en negrita ("**Lo que no está**"). Sin esto, el
    // encabezado se auditaba contra la cita de la frase siguiente y el juez lo
    // condenaba: un bloqueante por un título.
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);
    espia.mockResolvedValue(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`## Resultados\n**Lo que sí está**\n- El AUC fue 0.94 ${cita(ch)}.\n\n**Lo que no está**\n`, [ch]);
    expect(informe.afirmaciones.map((a) => a.texto)).toEqual(["- El AUC fue 0.94"]);
    expect(veredictos(informe)).toEqual([SOSTENIDA]);

    // adversarial: una frase entera en negrita con una cifra es una afirmación
    // y se audita; el encabezado en negrita se distingue por no llevar dígitos
    const conNegrita = await verificar(`**El AUC fue 0.99** ${cita(ch)}.`, [ch]);
    expect(conNegrita.afirmaciones.map((a) => a.texto)).toEqual(["**El AUC fue 0.99**"]);
    expect(_trocear("**Resultados:**\nDato [a.pdf, pág. 1].").trozos.map((t) => t.texto)).toEqual(["Dato"]);
    expect(_tieneAfirmaciones("**Lo que no está**\n- ")).toBe(false);
    expect(_tieneAfirmaciones("**Lo que no está**\n- Dos.")).toBe(true);
  });

  test("_trocear: sin citas no hay trozos y lo dice; con citas la cabecera y la puntuación se saltan", () => {
    expect(_trocear("No encuentro nada.")).toEqual({ trozos: [], hayCitas: false });
    const { trozos, hayCitas } = _trocear("Resultados:\n- Uno [a.pdf, pág. 1].\n; Dos [b.pdf, pág. 2].");
    expect(hayCitas).toBe(true);
    expect(trozos).toEqual([
      { texto: "- Uno", citas: ["[a.pdf, pág. 1]"], cita: "[a.pdf, pág. 1]", encabezado: "" },
      { texto: "Dos", citas: ["[b.pdf, pág. 2]"], cita: "[b.pdf, pág. 2]", encabezado: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Declaraciones de ausencia: la regla corregida tras la revisión adversarial
// ---------------------------------------------------------------------------
describe("declaraciones de ausencia", () => {
  test("(d) una abstención pura delante de una frase citada no se audita ni es sin_cita", async () => {
    // Regresión de la sesión de estrés: la declaración iba adosada a la cita
    // siguiente, el juez la daba no_sostenida y tumbaba la respuesta entera.
    const ch = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "consta" }] }));

    const informe = await verificar(
      `No encuentro la mortalidad en los documentos. La conversión fue del 31.6% ${cita(ch)}.`,
      [ch],
    );

    expect(informe.afirmaciones.map((a) => a.texto)).toEqual(["La conversión fue del 31.6%"]);
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.ok).toBe(true);
    expect(ultimoMensaje(espia.mock.calls[0])).not.toContain("mortalidad");
  });

  test("una abstención pura tras la última cita no es sin_cita", async () => {
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(`El AUC fue 0.94 ${cita(ch)}. Los documentos no mencionan la especificidad.`, [ch]);

    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.ok).toBe(true);
  });

  test("(a) un hallazgo negativo con cita SÍ llega al juez y su veredicto cuenta", async () => {
    // Trampa medida: "No hay evidencia de que reduzca la mortalidad [cita]" es
    // una AFIRMACIÓN sobre esa fuente y puede ser lo contrario de lo que dice
    // el fragmento. La regla anterior la saltaba por casar con los patrones.
    const ch = frag("c1", "El tratamiento redujo la mortalidad un 30% (p<0.01).", "e.pdf", 3);
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "el fragmento dice lo contrario" }] }),
    );

    const informe = await verificar(`No hay evidencia de que reduzca la mortalidad ${cita(ch)}.`, [ch]);

    expect(espia).toHaveBeenCalledTimes(1);
    expect(ultimoMensaje(espia.mock.calls[0])).toContain("No hay evidencia de que reduzca la mortalidad");
    expect(veredictos(informe)).toEqual([NO_SOSTENIDA]);
    expect(revisor.bloqueantes(informe)).toHaveLength(1);
    expect(informe.fidelidad).toBe(0);
  });

  test("(b) una cita inventada pegada a una frase de abstención acaba en citas_sin_resolver", async () => {
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);

    const informe = await verificar("No encuentro la especificidad en los documentos [inventado.pdf, pág. 9].", [ch]);

    expect(veredictos(informe)).toEqual([CITA_NO_RESUELVE]);
    expect(informe.citas_sin_resolver).toEqual(["[inventado.pdf, pág. 9]"]);
    expect(revisor.aprobada(informe)).toBe(false);
    expect(espia).not.toHaveBeenCalled();
  });

  test("(c) una declaración con dígito en la cola queda sin_cita", async () => {
    // "No hay datos de X" se salta; "No hay datos de X, pero el AUC fue 0,94"
    // afirma una cifra sin fuente y es bloqueante, que es lo correcto.
    const ch = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "consta" }] }));

    const informe = await verificar(
      `La conversión fue del 31.6% ${cita(ch)}. No hay datos de especificidad. ` +
        "No hay datos de sensibilidad, pero el AUC fue 0,94.",
      [ch],
    );

    expect(veredictos(informe)).toEqual([SOSTENIDA, SIN_CITA]);
    expect(informe.afirmaciones[1].texto).toBe("No hay datos de sensibilidad, pero el AUC fue 0,94.");
    expect(informe.ok).toBe(false);
    expect(revisor.aprobada(informe)).toBe(false);
  });

  test("una abstención no blanquea la afirmación sin cita que la sigue", async () => {
    const ch = frag("c1", "El AUC fue 0.94.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(
      `El AUC fue 0.94 ${cita(ch)}. No encuentro la especificidad en los documentos. La cohorte tuvo 900 pacientes.`,
      [ch],
    );

    expect(veredictos(informe)).toEqual([SOSTENIDA, SIN_CITA]);
    expect(informe.afirmaciones[1].texto).toBe("La cohorte tuvo 900 pacientes.");
    expect(informe.ok).toBe(false);
  });

  test("una ausencia que solo nombra cifras del asunto que falta NO se audita (antes sí, por la regla del dígito)", async () => {
    // Cambio deliberado del 9 sep 2026. Antes cualquier dígito quitaba la
    // exención ("a 90 días" la perdía) y la frase viajaba al juez; en
    // producción eso convirtió declaraciones honestas en afirmaciones sin
    // cita, bloqueantes, que el recorte de la barrera borró. Ahora lo que
    // quita la exención es una cifra con forma de medida o una segunda
    // cláusula, no un número que solo nombra lo que falta.
    const ch = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "consta" }] }),
    );

    const informe = await verificar(
      `No encuentro la mortalidad a 90 días en los documentos. La conversión fue del 31.6% ${cita(ch)}.`,
      [ch],
    );

    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.afirmaciones[0].texto).toBe("La conversión fue del 31.6%");
    // Al juez solo le llega la frase que afirma, no la que declara el hueco.
    expect(ultimoMensaje(espia.mock.calls[0])).not.toContain("mortalidad a 90 días");
    expect(informe.ok).toBe(true);
    expect(revisor.aprobada(informe)).toBe(true);
  });

  test("una segunda cita inventada tras la frase va a citas_sin_resolver y la frase se juzga contra la buena", async () => {
    // Hueco hermano de la trampa: "dato [a] [b]" dejaba [b] con tramo vacío y
    // el Python la descartaba en silencio, así que una cita inventada ahí
    // nunca llegaba a citas_sin_resolver. Ahora las dos citas son de la misma
    // frase: UNA afirmación, juzgada contra lo que sí resuelve, y la
    // inventada bloquea por su cuenta hasta que se quite.
    const a = frag("c1", "El AUC fue 0.94.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`El AUC fue 0.94 ${cita(a)} [inventado.pdf, pág. 9].`, [a]);

    expect(informe.afirmaciones.map((x) => [x.texto, x.veredicto, x.fragmentos])).toEqual([
      ["El AUC fue 0.94", SOSTENIDA, ["c1"]],
    ]);
    expect(informe.afirmaciones[0].cita).toBe(`${cita(a)} [inventado.pdf, pág. 9]`);
    expect(informe.citas_sin_resolver).toEqual(["[inventado.pdf, pág. 9]"]);
    expect(ultimoMensaje(espia.mock.calls[0])).not.toContain("inventado");
    // la inventada sigue bloqueando aunque el veredicto sea sostenida
    expect(revisor.aprobada(informe)).toBe(false);
  });

  test("una cita delante de todo el texto pertenece a la frase que la sigue", async () => {
    const a = frag("c1", "El AUC fue 0.94.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`${cita(a)} El AUC fue 0.94.`, [a]);

    expect(informe.afirmaciones.map((x) => [x.texto, x.veredicto])).toEqual([["El AUC fue 0.94.", SOSTENIDA]]);
    expect(informe.ok).toBe(true);
  });

  test("una respuesta que es solo una cita inventada no se da por buena", async () => {
    const informe = await verificar("[inventado.pdf, pág. 9]", []);
    expect(veredictos(informe)).toEqual([CITA_NO_RESUELVE]);
    expect(informe.citas_sin_resolver).toEqual(["[inventado.pdf, pág. 9]"]);
  });
});

// ---------------------------------------------------------------------------
// Trazabilidad por fragmento y cobertura por punto del plan
// ---------------------------------------------------------------------------
function planDeCuatro() {
  // e1 cubierto, e2 parcial, e3 evidencia sin usar, e4 sin resultados.
  const c1 = frag("c1", "Dato uno.", "uno.pdf", 1);
  const c2 = frag("c2", "Dato dos.", "dos.pdf", 2);
  const c3 = frag("c3", "Dato tres.", "tres.pdf", 3);
  const c3b = frag("c3b", "Dato tres bis.", "tres_bis.pdf", 7);
  const evidencia = {
    e0: "respuesta directa a la pregunta tal como la formuló quien pregunta",
    e1: "la conversión",
    e2: "el AUC",
    e3: "la mortalidad",
    e4: "los efectos adversos",
  };
  const mapa = { c1: ["e1"], c2: ["e2"], c3: ["e3"], c3b: ["e3"] };
  return { chunks: [c1, c2, c3, c3b], evidencia, mapa };
}

describe("cobertura por punto", () => {
  test("fragmentos lleva todos los hermanos y sobrevive al veredicto", async () => {
    const a = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 4, { citation: "Allegri et al., 2023" });
    const b = frag("c2", "El AUC fue 0.94.", "e.pdf", 4, { citation: "Allegri et al., 2023" });
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "parcial", motivo: "generaliza" }] }));

    const informe = await verificar(`La conversión fue del 31.6% ${cita(a)}.`, [a, b]);

    expect(informe.afirmaciones[0].veredicto).toBe(PARCIAL);
    expect(informe.afirmaciones[0].fragmentos).toEqual(["c1", "c2"]);
    expect(informe.afirmaciones[0].fragmento_id).toBe(cita(a));
  });

  test("distingue los cuatro estados y excluye e0", async () => {
    const { chunks, evidencia, mapa } = planDeCuatro();
    const [c1, c2] = chunks;
    espia.mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 0, veredicto: "sostenida", motivo: "ok" },
          { i: 1, veredicto: "parcial", motivo: "generaliza" },
        ],
      }),
    );

    const informe = await verificar(`Uno ${cita(c1)}. Dos ${cita(c2)}.`, chunks, evidencia, mapa);

    expect(informe.cobertura.map((c) => c.id)).toEqual(["e1", "e2", "e3", "e4"]);
    const porId = Object.fromEntries(informe.cobertura.map((c) => [c.id, c]));
    expect(porId.e1.estado).toBe("cubierto");
    expect(porId.e1.afirmaciones).toEqual([0]);
    expect(porId.e1.documentos).toEqual(["uno.pdf"]);
    expect(porId.e1.evidence_needed).toBe("la conversión");
    expect(porId.e2.estado).toBe("parcial");
    expect(porId.e2.afirmaciones).toEqual([1]);
    expect(porId.e3.estado).toBe("evidencia_no_usada");
    expect(porId.e3.n_fragmentos).toBe(2);
    expect(porId.e3.documentos).toEqual(["tres.pdf", "tres_bis.pdf"]);
    expect(porId.e3.afirmaciones).toEqual([]);
    expect(porId.e4.estado).toBe("sin_resultados");
    expect(porId.e4.n_fragmentos).toBe(0);
    expect(porId.e4.documentos).toEqual([]);
    // sin_cubrir = SOLO los evidencia_no_usada: un punto sin resultados en el
    // índice no es un fallo del redactor, y ponerlo aquí llevaría a rellenarlo
    expect(informe.evidencia_sin_cubrir).toEqual(["e3"]);
    expect(JSON.parse(JSON.stringify(informe)).cobertura[3].estado).toBe("sin_resultados");
  });

  test("la sobrecobertura ambigua cubre ambos puntos", async () => {
    const c1 = frag("c1", "Dato.", "uno.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`Dato ${cita(c1)}.`, [c1], { e0: "pregunta", e1: "a", e3: "b" }, { c1: ["e1", "e3"] });

    expect(informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "cubierto"],
      ["e3", "cubierto"],
    ]);
    expect(informe.evidencia_sin_cubrir).toEqual([]);
  });

  test("una afirmación no sostenida no cubre su punto", async () => {
    const c1 = frag("c1", "El AUC fue 0.94.", "uno.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "dice 0.94" }] }));

    const informe = await verificar(`El AUC fue 0.99 ${cita(c1)}.`, [c1], { e0: "pregunta", e1: "el AUC" }, { c1: ["e1"] });

    expect(informe.cobertura[0].estado).toBe("evidencia_no_usada");
    expect(informe.cobertura[0].afirmaciones).toEqual([0]);
    expect(informe.evidencia_sin_cubrir).toEqual(["e1"]);
  });

  test("una afirmación sin verificar deja su punto en parcial", async () => {
    // Si el juez no llegó, la respuesta SÍ usó esa evidencia (está citada y
    // es trazable); decir "no la usa" sería falso.
    const c1 = frag("c1", "Dato.", "uno.pdf", 1);
    espia.mockRejectedValueOnce(new Error("API caída"));

    const informe = await verificar(`Dato ${cita(c1)}.`, [c1], { e0: "pregunta", e1: "a" }, { c1: ["e1"] });

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR]);
    expect(informe.cobertura[0].estado).toBe("parcial");
    expect(informe.evidencia_sin_cubrir).toEqual([]);
  });

  test("una abstención completa con mapa devuelve cobertura", async () => {
    const { chunks, evidencia, mapa } = planDeCuatro();

    const informe = await verificar("No encuentro esa información en los documentos.", chunks, evidencia, mapa);

    expect(informe.ok).toBe(true);
    expect(informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "evidencia_no_usada"],
      ["e2", "evidencia_no_usada"],
      ["e3", "evidencia_no_usada"],
      ["e4", "sin_resultados"],
    ]);
    expect(informe.evidencia_sin_cubrir).toEqual(["e1", "e2", "e3"]);
    expect(espia).not.toHaveBeenCalled();
  });

  test("una respuesta sin citas con mapa usa la cobertura por punto", async () => {
    const { chunks, evidencia, mapa } = planDeCuatro();

    const informe = await verificar("Los tres estudios coinciden.", chunks, evidencia, mapa);

    expect(veredictos(informe)).toEqual([SIN_CITA]);
    expect(informe.evidencia_sin_cubrir).toEqual(["e1", "e2", "e3"]);
    expect(informe.cobertura[informe.cobertura.length - 1].estado).toBe("sin_resultados");
  });

  test("sin mapa se conserva el todo o nada", async () => {
    const c1 = frag("c1", "Dato.", "uno.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`Dato ${cita(c1)}.`, [c1], { e0: "pregunta", e1: "a", e2: "b" });

    expect(informe.cobertura).toEqual([]);
    expect(informe.evidencia_sin_cubrir).toEqual([]);
  });

  test("_cobertura es pura, respeta el orden del plan y deduplica documentos por fuente", () => {
    const c1 = frag("c1", "Dato.", "uno.pdf", 1, { citation: "Allegri et al., 2023" });
    const c1b = frag("c1b", "Más.", "uno.pdf", 2, { citation: "Allegri et al., 2023" });
    const afs = [afirmacion({ texto: "Dato", cita: cita(c1), veredicto: SOSTENIDA, fragmentos: ["c1"] })];
    const porId = new Map([
      ["c1", c1],
      ["c1b", c1b],
    ]);

    const cob = _cobertura({ e0: "x", e2: "b", e1: "a" }, { c1: ["e1"], c1b: ["e1"] }, afs, porId);

    expect(cob.map((c) => [c.id, c.estado])).toEqual([
      ["e2", "sin_resultados"],
      ["e1", "cubierto"],
    ]);
    expect(cob[1].documentos).toEqual(["Allegri et al., 2023"]);
    expect(cob[1].n_fragmentos).toBe(2);
  });

  test("un mapa con puntos y un plan vacío no produce cobertura", async () => {
    const c1 = frag("c1", "Dato.", "uno.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const informe = await verificar(`Dato ${cita(c1)}.`, [c1], {}, { c1: ["e1"] });
    expect(informe.cobertura).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lotes en paralelo: uno caído no tira el resto; todos caídos = sin señal
// ---------------------------------------------------------------------------
describe("lotes", () => {
  test("un lote caído conserva los veredictos de los demás", async () => {
    process.env.VERIFIER_MAX_CLAIMS = "2";
    const chunks = [0, 1, 2, 3].map((i) => frag(`c${i}`, `Dato ${i}.`, `doc_${i}.pdf`, i + 1));
    const respuesta = chunks.map((c, i) => `Afirmación ${i} ${cita(c)}.`).join(" ");
    espia
      .mockResolvedValueOnce(
        respuestaJson({
          veredictos: [
            { i: 0, veredicto: "sostenida", motivo: "ok" },
            { i: 1, veredicto: "no_sostenida", motivo: "no consta" },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error("500 en el segundo lote"));

    const informe = await verificar(respuesta, chunks);

    expect(veredictos(informe)).toEqual([SOSTENIDA, NO_SOSTENIDA, SIN_VERIFICAR, SIN_VERIFICAR]);
    expect(informe.fidelidad).toBeCloseTo(0.5);
    // no es "sin señal": hay veredictos con los que corregir
    expect(informe.ok).toBe(true);
    expect(revisor.sinSenal(informe)).toBe(false);
    expect(informe.nota).toContain("1 de 2 lotes");
    expect(informe.nota).toContain("afirmaciones 2-3");
    expect(informe.nota).toContain("500 en el segundo lote");
    expect(espia).toHaveBeenCalledTimes(2);
  });

  test("todos los lotes caídos es sin señal", async () => {
    process.env.VERIFIER_MAX_CLAIMS = "1";
    const a = frag("c1", "Uno.", "a.pdf", 1);
    const b = frag("c2", "Dos.", "b.pdf", 2);
    espia.mockRejectedValueOnce(new Error("caído 1")).mockRejectedValueOnce(new Error("caído 2"));

    const informe = await verificar(`Uno ${cita(a)}. Dos ${cita(b)}.`, [a, b]);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR, SIN_VERIFICAR]);
    expect(informe.ok).toBe(false);
    expect(informe.nota).toContain("no pudo dictaminar");
    expect(revisor.sinSenal(informe)).toBe(true);
    expect(revisor.aprobada(informe)).toBe(false);
  });

  test("los lotes se ejecutan en paralelo", async () => {
    // Prueba directa de concurrencia: cada lote espera a que el OTRO también
    // esté en vuelo. Si fueran secuenciales, el primero esperaría solo, la
    // barrera vencería por timeout y ese lote "caería".
    process.env.VERIFIER_MAX_CLAIMS = "1";
    let enVuelo = 0;
    let abrir!: () => void;
    const ambosEnVuelo = new Promise<void>((r) => (abrir = r));
    espia.mockImplementation(async () => {
      enVuelo += 1;
      if (enVuelo === 2) abrir();
      await Promise.race([
        ambosEnVuelo,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("secuencial")), 1000)),
      ]);
      return respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] });
    });
    const a = frag("c1", "Uno.", "a.pdf", 1);
    const b = frag("c2", "Dos.", "b.pdf", 2);

    const informe = await verificar(`Uno ${cita(a)}. Dos ${cita(b)}.`, [a, b]);

    expect(veredictos(informe)).toEqual([SOSTENIDA, SOSTENIDA]);
    expect(informe.nota).toBe("");
  });

  test("un lote de tamaño no válido no rompe el troceo en lotes", async () => {
    process.env.VERIFIER_MAX_CLAIMS = "0";
    const a = frag("c1", "Uno.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const informe = await verificar(`Uno ${cita(a)}.`, [a]);
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(espia).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Lo que recibe el juez y lo que queda en telemetría
// ---------------------------------------------------------------------------
describe("juez y telemetría", () => {
  test("el juez recibe razonamiento, temperatura, modelo resuelto y cabecera por fragmento", async () => {
    const tabla = frag("t1", "Fila: AUC 0.94", "tab.xlsx", 3, {
      documentType: "xlsx",
      chunkType: "table",
      section: "Resultados",
      citation: "Allegri et al., 2023",
    });
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const tel = new Telemetria();

    const informe = await verificar(`El AUC fue 0.94 ${cita(tabla)}.`, [tabla], null, null, tel);

    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    const kwargs = espia.mock.calls[0][0] as Record<string, unknown>;
    const a = ajustes();
    expect(kwargs.reasoning_effort).toBe(a.razonamientoVerificador);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect(kwargs.model).toBe("openai/gpt-5.4-mini");
    // los ajustes viajan explícitos al gateway: se leen una vez por verificación
    expect(espia.mock.calls[0][1]).toMatchObject({ modelo: a.modelo });
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado).toContain("fuente: Allegri et al., 2023");
    expect(enviado).toContain("sección: Resultados");
    expect(enviado).toContain("tipo: tabla");
    expect(enviado).toContain("FRAGMENTO 1 DE 1");
    expect(enviado).toContain(`(${cita(tabla)})`);
    // el prompt del sistema exige estrictez y trata el hallazgo negativo con cita
    const sistema = (kwargs.messages as Array<{ role: string; content: string }>)[0];
    expect(sistema.role).toBe("system");
    const sistemaPlano = sistema.content.replace(/\s+/g, " ");
    expect(sistemaPlano).toContain("aprobar una atribución dudosa es el fallo caro");
    expect(sistemaPlano).toContain("un hallazgo negativo colgado de una fuente que dice lo opuesto");
    expect(sistemaPlano).toContain("basta con que UNO sostenga la afirmación");
    // telemetría: una ronda del componente verificador, ok, con el modelo real
    expect(tel.rondas).toHaveLength(1);
    expect(tel.rondas[0]).toMatchObject({ componente: "verificador", ok: true, modelo: "openai/gpt-5.4-mini", nota: "afirmaciones=1" });
    expect(tel.rondas[0].prompt).toBe(50);
  });

  test("un fallo del gateway deja una ronda en error y un rechazo de razonamiento se cuenta", async () => {
    const a = frag("c1", "Uno.", "a.pdf", 1);
    const b = frag("c2", "Dos.", "b.pdf", 2);
    process.env.VERIFIER_MAX_CLAIMS = "1";
    espia
      .mockRejectedValueOnce(new Error("gateway 503"))
      .mockResolvedValueOnce({
        ...respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }),
        razonamientoRechazado: true,
      });
    const tel = new Telemetria();

    const informe = await verificar(`Uno ${cita(a)}. Dos ${cita(b)}.`, [a, b], null, null, tel);

    expect(veredictos(informe)).toEqual([SIN_VERIFICAR, SOSTENIDA]);
    expect(tel.rondas.map((r) => [r.componente, r.ok])).toEqual([
      ["verificador", false],
      ["verificador", true],
    ]);
    expect(tel.rondas[0].nota).toContain("gateway 503");
    expect(tel.contadores.razonamiento_rechazado).toBe(1);
  });

  test("una respuesta sin lista de veredictos se anota como ronda fallida, una sola vez", async () => {
    const a = frag("c1", "Uno.", "a.pdf", 1);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: "no es una lista" }));
    const tel = new Telemetria();

    await verificar(`Uno ${cita(a)}.`, [a], null, null, tel);

    expect(tel.rondas).toHaveLength(1);
    expect(tel.rondas[0].ok).toBe(false);
    expect(tel.rondas[0].nota).toContain("sin lista veredictos");
  });

  test("el modelo del juez respeta VERIFIER_MODEL y hereda RERANK_MODEL si está vacío", async () => {
    const a = frag("c1", "Uno.", "a.pdf", 1);
    process.env.RERANK_MODEL = "openai/otro-mini";
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    await verificar(`Uno ${cita(a)}.`, [a]);
    expect((espia.mock.calls[0][0] as Record<string, unknown>).model).toBe("openai/otro-mini");

    process.env.VERIFIER_MODEL = "openai/gpt-5.4";
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    await verificar(`Uno ${cita(a)}.`, [a]);
    expect((espia.mock.calls[1][0] as Record<string, unknown>).model).toBe("openai/gpt-5.4");
  });
});

// ---------------------------------------------------------------------------
// Varias citas seguidas: una sola afirmación contra la unión de sus fragmentos
// ---------------------------------------------------------------------------
describe("varias citas seguidas", () => {
  // Defecto medido en el despliegue (paper de Alzheimer's & Dementia): la frase
  // iba seguida de tres citas, cada fragmento sostenía una parte y el juez la
  // condenó tres veces. Tres no_sostenidas mandaron una respuesta buena a la
  // abstención segura.
  const p1 = frag("f1", "Participants were followed annually for up to 12 years.", "paper.pdf", 1, {
    citation: "Smith et al., 2024",
  });
  const p4 = frag("f4", "Mean follow-up duration was 7.9 ± 3.3 years.", "paper.pdf", 4, {
    citation: "Smith et al., 2024",
  });
  const p5 = frag("f5", "The mean number of follow-up visits was 5.2.", "paper.pdf", 5, {
    citation: "Smith et al., 2024",
  });
  const frase =
    "El seguimiento fue anual for up to 12 years, con follow-up duration de 7.9 ± 3.3 years y " +
    "number of follow-up visits de 5.2";

  test("la frase con tres citas llega al juez UNA vez con los tres fragmentos y cabeceras que los distinguen", async () => {
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "cada parte está en alguno" }] }),
    );

    const informe = await verificar(`${frase} ${cita(p1)} ${cita(p4)} ${cita(p5)}.`, [p1, p4, p5]);

    expect(informe.afirmaciones).toHaveLength(1);
    expect(informe.afirmaciones[0].fragmentos).toEqual(["f1", "f4", "f5"]);
    expect(informe.afirmaciones[0].cita).toBe(`${cita(p1)} ${cita(p4)} ${cita(p5)}`);
    expect(informe.afirmaciones[0].fragmento_id).toBe(cita(p1));
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.fidelidad).toBe(1);
    expect(informe.citas_sin_resolver).toEqual([]);
    expect(espia).toHaveBeenCalledTimes(1);
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado).toContain("(evidencia repartida en 3 citas)");
    expect(enviado).toContain(`FRAGMENTO 1 DE 3 (${cita(p1)})`);
    expect(enviado).toContain(`FRAGMENTO 2 DE 3 (${cita(p4)})`);
    expect(enviado).toContain(`FRAGMENTO 3 DE 3 (${cita(p5)})`);
    expect(enviado).toContain("Mean follow-up duration was 7.9 ± 3.3 years.");
    // y el prompt del sistema explica qué significa "sostenida" con evidencia repartida
    const sistema = (espia.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(sistema.replace(/\s+/g, " ")).toContain(
      "la evidencia está REPARTIDA y \"sostenida\" significa que cada parte de la afirmación está en alguno de los fragmentos",
    );
  });

  test("(adversarial) [A][B] con B inventada: B a citas_sin_resolver y la afirmación se juzga solo contra A", async () => {
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`${frase} ${cita(p1)}[inventado.pdf, pág. 9].`, [p1, p4, p5]);

    expect(informe.afirmaciones).toHaveLength(1);
    expect(informe.afirmaciones[0].fragmentos).toEqual(["f1"]);
    expect(informe.afirmaciones[0].cita).toBe(`${cita(p1)}[inventado.pdf, pág. 9]`);
    expect(informe.citas_sin_resolver).toEqual(["[inventado.pdf, pág. 9]"]);
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado).toContain("FRAGMENTO 1 DE 1");
    expect(enviado).not.toContain("inventado");
    expect(enviado).not.toContain("evidencia repartida");
    expect(revisor.aprobada(informe)).toBe(false);
  });

  test("si ninguna de las citas resuelve, la afirmación es cita_no_resuelve y todas van a la lista", async () => {
    const informe = await verificar(`${frase} [inv.pdf, pág. 1] [inv.pdf, pág. 2].`, [p1]);

    expect(veredictos(informe)).toEqual([CITA_NO_RESUELVE]);
    expect(informe.afirmaciones[0].motivo).toContain("ninguna de las citas");
    expect(informe.citas_sin_resolver).toEqual(["[inv.pdf, pág. 1]", "[inv.pdf, pág. 2]"]);
    expect(espia).not.toHaveBeenCalled();
  });

  test("las citas de cierre respaldan TODAS las frases del tramo, y con coma también son consecutivas", () => {
    const { trozos } = _trocear(`- Uno.\n- Dos ${cita(p1)}, ${cita(p4)}.`);
    expect(trozos.map((t) => [t.texto, t.citas])).toEqual([
      ["- Uno.", [cita(p1), cita(p4)]],
      ["- Dos", [cita(p1), cita(p4)]],
    ]);
    // tal cual aparecen en el texto, coma incluida
    expect(trozos[1].cita).toBe(`${cita(p1)}, ${cita(p4)}`);
  });

  test("la misma cita repetida no duplica fragmentos", async () => {
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(`Dato ${cita(p1)} ${cita(p1)}.`, [p1]);

    expect(informe.afirmaciones[0].fragmentos).toEqual(["f1"]);
    expect(ultimoMensaje(espia.mock.calls[0])).toContain("FRAGMENTO 1 DE 1");
  });

  test("la cobertura cuenta la afirmación para los puntos de todas sus citas", async () => {
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));

    const informe = await verificar(
      `${frase} ${cita(p1)} ${cita(p4)}.`,
      [p1, p4, p5],
      { e0: "pregunta", e1: "el seguimiento", e2: "la duración", e3: "las visitas" },
      { f1: ["e1"], f4: ["e2"], f5: ["e3"] },
    );

    expect(informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "cubierto"],
      ["e2", "cubierto"],
      ["e3", "evidencia_no_usada"],
    ]);
  });

  test("_tieneAfirmaciones distingue contenido auditable de ausencia pura, cabeceras y puntuación", () => {
    expect(_tieneAfirmaciones("- Uno.\n- Dos.")).toBe(true);
    expect(_tieneAfirmaciones("No encuentro la mortalidad en los documentos.")).toBe(false);
    expect(_tieneAfirmaciones("Los hallazgos son:")).toBe(false);
    expect(_tieneAfirmaciones(". \n- ")).toBe(false);
    expect(_tieneAfirmaciones("")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Reutilización de veredictos entre rondas del mismo turno
// ---------------------------------------------------------------------------
describe("veredictos previos", () => {
  const ch = frag("c1", "El AUC fue 0.94 en la cohorte de 300 pacientes.", "a.pdf", 3);

  /** Un juez que dictamina "parcial" a todo lo que le llega y apunta qué le llegó. */
  function juezQueApunta(pedidas: string[]) {
    espia.mockImplementation(async (kwargs: Record<string, unknown>) => {
      const payload = ultimoMensaje([kwargs]);
      const lineas = [...payload.matchAll(/^\[(\d+)\] AFIRMACIÓN[^:]*: (.*)$/gm)];
      for (const m of lineas) pedidas.push(m[2]);
      return respuestaJson({ veredictos: lineas.map((m) => ({ i: Number(m[1]), veredicto: "parcial", motivo: "nueva" })) });
    });
  }

  test("la misma frase con la misma cita no se vuelve a mandar al modelo; una frase nueva y una sin_verificar sí", async () => {
    const previo = informeVacio({
      afirmaciones: [
        afirmacion({ texto: "El AUC fue 0.94", cita: cita(ch), veredicto: SOSTENIDA, motivo: "coincide", fragmentos: [ch._id] }),
        afirmacion({ texto: "Nadie la juzgó", cita: cita(ch), veredicto: SIN_VERIFICAR, fragmentos: [ch._id] }),
      ],
    });
    const previos = veredictosDe(previo);
    // Solo los del modelo entran en el mapa: la sin_verificar se vuelve a preguntar.
    expect([...previos.keys()]).toEqual([claveDeAfirmacion("El AUC fue 0.94", cita(ch))]);

    const pedidas: string[] = [];
    juezQueApunta(pedidas);
    const tel = new Telemetria();
    const r = await verificar(
      `El AUC fue   0.94 ${cita(ch)}. Nadie la juzgó ${cita(ch)}. La cohorte tuvo 300 pacientes ${cita(ch)}.`,
      [ch], null, null, tel, { veredictosPrevios: previos },
    );
    // Al modelo solo fueron la sin_verificar y la nueva; la reutilizada
    // conserva veredicto y motivo aunque el redactor cambiara los espacios.
    expect(pedidas).toEqual(["Nadie la juzgó", "La cohorte tuvo 300 pacientes"]);
    expect(r.afirmaciones.map((a) => [a.texto, a.veredicto])).toEqual([
      ["El AUC fue   0.94", SOSTENIDA],
      ["Nadie la juzgó", PARCIAL],
      ["La cohorte tuvo 300 pacientes", PARCIAL],
    ]);
    expect(r.afirmaciones[0].motivo).toBe("coincide");
    expect(tel.contadores.veredictos_reutilizados).toBe(1);
  });

  test("ADVERSARIAL: la misma frase con OTRA cita no reutiliza nada: la cita es parte de la afirmación", async () => {
    const otro = frag("c2", "Otro texto.", "otro.pdf", 7);
    const previos = veredictosDe(
      informeVacio({
        afirmaciones: [afirmacion({ texto: "El AUC fue 0.94", cita: cita(ch), veredicto: SOSTENIDA, fragmentos: [ch._id] })],
      }),
    );
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "no consta" }] }));
    const r = await verificar(`El AUC fue 0.94 ${cita(otro)}.`, [ch, otro], null, null, undefined, { veredictosPrevios: previos });
    expect(espia).toHaveBeenCalledTimes(1);
    expect(r.afirmaciones[0].veredicto).toBe(NO_SOSTENIDA);
  });

  test("con todo reutilizado no hay ninguna llamada al modelo y el informe sigue teniendo señal", async () => {
    const previos = veredictosDe(
      informeVacio({
        afirmaciones: [afirmacion({ texto: "El AUC fue 0.94", cita: cita(ch), veredicto: SOSTENIDA, fragmentos: [ch._id] })],
      }),
    );
    const r = await verificar(`El AUC fue 0.94 ${cita(ch)}.`, [ch], null, null, undefined, { veredictosPrevios: previos });
    expect(espia).not.toHaveBeenCalled();
    expect(r.afirmaciones).toHaveLength(1);
    expect(r.fidelidad).toBe(1);
    expect(r.ok).toBe(true);
    expect(revisor.sinSenal(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Un diagrama Mermaid dentro de la respuesta
// ---------------------------------------------------------------------------
// El prompt pide que las citas del diagrama vayan en la línea siguiente al
// cierre del bloque, solas. Eso es lo que hace que el troceo lo tome como UNA
// afirmación con esas citas, en vez de partirlo en fragmentos de sintaxis, y
// es la razón de que un diagrama no pueda colar contenido sin auditar.
describe("diagramas", () => {
  const DIAGRAMA = [
    "```mermaid",
    "flowchart TD",
    '  A["PA en consulta 140/90 o más"] --> B["Confirmar con MAPA"]',
    '  B -->|se confirma| C["Iniciar tratamiento"]',
    "```",
  ].join("\n");

  test("con sus citas tras el cierre es UNA afirmación auditada, no varios trozos de sintaxis", () => {
    const ch = frag("c1", "El algoritmo indica confirmar con MAPA antes de tratar.", "guia.pdf", 4);
    const { trozos, hayCitas } = _trocear(`${DIAGRAMA}\n${cita(ch)}`);
    expect(hayCitas).toBe(true);
    expect(trozos).toHaveLength(1);
    expect(trozos[0].citas).toEqual([cita(ch)]);
    // El texto que ve el juez es el bloque entero, con sus etiquetas legibles.
    expect(trozos[0].texto).toContain("Confirmar con MAPA");
    expect(trozos[0].texto).toContain("flowchart TD");
  });

  test("ADVERSARIAL: un diagrama SIN cita no se cuela: cuenta como afirmación sin fuente", async () => {
    const ch = frag("c1", "Texto de la guía.", "guia.pdf", 4);
    const r = await verificar(`Esto es el algoritmo ${cita(ch)}.\n\n${DIAGRAMA}`, [ch]);
    // La primera frase sí resuelve; el diagrama queda en la cola sin cita.
    const veredictosDelDiagrama = r.afirmaciones
      .filter((a) => a.texto.includes("flowchart"))
      .map((a) => a.veredicto);
    expect(veredictosDelDiagrama).toEqual([SIN_CITA]);
    expect(r.ok).toBe(false);
  });

  test("ADVERSARIAL: una etiqueta con punto y espacio partiría el bloque; el prompt las prohíbe y aquí se documenta", () => {
    const conPunto = [
      "```mermaid",
      "flowchart TD",
      '  A["Medir la PA. Confirmar luego"] --> B["Tratar"]',
      "```",
    ].join("\n");
    const ch = frag("c1", "texto", "guia.pdf", 4);
    const { trozos } = _trocear(`${conPunto}\n${cita(ch)}`);
    // Se parte en dos: la primera mitad se queda sin cita propia y comparte la
    // del tramo. Por eso el prompt exige etiquetas cortas y sin punto final.
    expect(trozos.length).toBeGreaterThan(1);
    expect(trozos.every((t) => t.citas.length === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entidad: el dato es real, la cita resuelve, y no es de quien se dice
// ---------------------------------------------------------------------------
describe("atribución a otra entidad", () => {
  const ch = frag("r1", "Rivastigmine reduced mortality by 30 % in the trial.", "trial.pdf", 4, {
    contexto: "Ensayo de rivastigmina en demencia leve",
  });

  test("el juez recibe la pregunta y el apartado de cada frase, y el prompt exige comprobar la entidad", async () => {
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok", entidad_distinta: false }] }));
    await verificar(`## Donepezilo\n- Redujo la mortalidad un 30 % ${cita(ch)}.`, [ch], null, null, undefined, {
      pregunta: "¿Cuánto reduce la mortalidad el donepezilo?",
    });
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado.startsWith("PREGUNTA DE QUIEN CONSULTA: ¿Cuánto reduce la mortalidad el donepezilo?")).toBe(true);
    expect(enviado).toContain('[0] AFIRMACIÓN (bajo el apartado "Donepezilo"): - Redujo la mortalidad un 30 %');
    // El contexto del fragmento va etiquetado como NO evidencia.
    expect(enviado).toContain("que NO es evidencia y no sostiene ninguna cifra: Ensayo de rivastigmina");
    const sistema = (espia.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content.replace(/\s+/g, " ");
    expect(sistema).toContain('"entidad_distinta": true');
    expect(sistema).toContain("el fragmento habla de rivastigmina, no de donepezilo");
  });

  test("ADVERSARIAL: entidad_distinta manda sobre el veredicto: una 'sostenida' de otra entidad sale no_sostenida y marcada", async () => {
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "el fragmento habla de rivastigmina, no de donepezilo", entidad_distinta: true }] }),
    );
    const tel = new Telemetria();
    const informe = await verificar(`Redujo la mortalidad un 30 % ${cita(ch)}.`, [ch], null, null, tel, {
      pregunta: "¿Cuánto reduce la mortalidad el donepezilo?",
    });
    expect(informe.afirmaciones[0].veredicto).toBe(NO_SOSTENIDA);
    expect(informe.afirmaciones[0].entidad_distinta).toBe(true);
    expect(informe.afirmaciones[0].motivo).toContain("rivastigmina");
    expect(informe.fidelidad).toBe(0);
    expect(tel.contadores.entidad_distinta).toBe(1);
    // "true" como texto también cuenta; cualquier otra cosa, no.
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "parcial", motivo: "m", entidad_distinta: "true" }] }));
    expect((await verificar(`Otra ${cita(ch)}.`, [ch])).afirmaciones[0].veredicto).toBe(NO_SOSTENIDA);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "parcial", motivo: "m", entidad_distinta: "no" }] }));
    const sinMarca = await verificar(`Otra ${cita(ch)}.`, [ch]);
    expect(sinMarca.afirmaciones[0].veredicto).toBe(PARCIAL);
    expect(sinMarca.afirmaciones[0].entidad_distinta).toBeUndefined();
  });

  test("_trocear anota bajo qué encabezado cae cada frase, limpio de marcas y sin dos puntos", () => {
    const { trozos } = _trocear(
      `## Donepezilo\n- Redujo un 30 % [a.pdf, pág. 1].\n\n**Rivastigmina: ensayo**\nOtra cosa [b.pdf, pág. 2].\nY la cola sin cita.`,
    );
    // ADVERSARIAL: el encabezado con ": " dentro no se parte en dos frases
    // (antes "ensayo**" se auditaba como una afirmación).
    expect(trozos.map((t) => [t.texto, t.encabezado])).toEqual([
      ["- Redujo un 30 %", "Donepezilo"],
      ["Otra cosa", "Rivastigmina ensayo"],
      ["Y la cola sin cita.", "Rivastigmina ensayo"],
    ]);
    expect(limpiarEncabezado("### Cohorte china:")).toBe("Cohorte china");
    expect(limpiarEncabezado("**Lo que no está**:")).toBe("Lo que no está");
  });

  test("ADVERSARIAL: la misma frase con la misma cita bajo OTRO apartado no reutiliza el veredicto", async () => {
    const previos = veredictosDe(
      informeVacio({
        afirmaciones: [afirmacion({ texto: "Redujo un 30 %", cita: cita(ch), veredicto: SOSTENIDA, fragmentos: [ch._id], encabezado: "Rivastigmina" })],
      }),
    );
    expect([...previos.keys()]).toEqual([claveDeAfirmacion("Redujo un 30 %", cita(ch), "Rivastigmina")]);
    espia.mockResolvedValueOnce(
      respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "otra entidad", entidad_distinta: true }] }),
    );
    const r = await verificar(`## Donepezilo\nRedujo un 30 % ${cita(ch)}.`, [ch], null, null, undefined, { veredictosPrevios: previos });
    // Se volvió a juzgar (una llamada) y salió condenada.
    expect(espia).toHaveBeenCalledTimes(1);
    expect(r.afirmaciones[0]).toMatchObject({ veredicto: NO_SOSTENIDA, entidad_distinta: true, encabezado: "Donepezilo" });
    // Y bajo el mismo apartado sí se reutiliza, con su marca.
    const previos2 = veredictosDe(r);
    const r2 = await verificar(`## Donepezilo\nRedujo un 30 % ${cita(ch)}.`, [ch], null, null, undefined, { veredictosPrevios: previos2 });
    expect(espia).toHaveBeenCalledTimes(1);
    expect(r2.afirmaciones[0]).toMatchObject({ veredicto: NO_SOSTENIDA, entidad_distinta: true });
  });

  test("sin pregunta no se inventa una cabecera de pregunta", async () => {
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    await verificar(`Frase ${cita(ch)}.`, [ch]);
    expect(ultimoMensaje(espia.mock.calls[0]).startsWith("[0] AFIRMACIÓN: Frase")).toBe(true);
  });
});

describe("apartado por frase, no por tramo", () => {
  test("ADVERSARIAL: una frase sin cita bajo un apartado, seguida de otro apartado con cita, conserva SU apartado", () => {
    const { trozos } = _trocear(
      "## Rivastigmina\nLa rivastigmina redujo la mortalidad un 30 %.\n\n## Donepezilo\nEl donepezilo mejoró el MMSE 2 puntos [guia.pdf, pág. 3].",
    );
    expect(trozos.map((t) => [t.texto, t.encabezado])).toEqual([
      ["La rivastigmina redujo la mortalidad un 30 %.", "Rivastigmina"],
      ["El donepezilo mejoró el MMSE 2 puntos", "Donepezilo"],
    ]);
    const negrita = _trocear("**Donepezilo**\nMejoró el MMSE 2 puntos [guia.pdf, pág. 3].\n**Rivastigmina**\nRedujo la mortalidad [guia.pdf, pág. 4].");
    expect(negrita.trozos.map((t) => t.encabezado)).toEqual(["Donepezilo", "Rivastigmina"]);
  });
});

// ---------------------------------------------------------------------------
// Cifras e identificadores: lo determinista delante del juez
// ---------------------------------------------------------------------------
describe("cifras e identificadores", () => {
  test("cifrasSinRespaldo normaliza coma, punto medio y separadores, y respeta los límites del número", () => {
    const textos = ["The AUC was 0·94 (95% CI 0.91-0.97) in 1 234 patients; p<0.001; dose 12.5 mg."];
    expect(cifrasSinRespaldo("El AUC fue 0,94 (IC 95 % 0,91 a 0,97) en 1.234 pacientes con 12,5 mg [a.pdf, pág. 3].", textos)).toEqual([]);
    // 0.9 no es 0.94, y "10.945" no contiene 0.94 como cifra.
    expect(cifrasSinRespaldo("El AUC fue 0,9.", textos)).toEqual(["0.9"]);
    expect(cifrasSinRespaldo("El AUC fue 0,94.", ["value 10.945"])).toEqual(["0.94"]);
    // Las cifras de la propia cita no cuentan (la página no es un dato).
    expect(cifrasDe("Dato sin cifras [a.pdf, pág. 33].")).toEqual([]);
    expect(identificadoresDe("En NCT01234567 y rs429358 (doi:10.1038/s41586-024-07691-8).")).toEqual([
      "NCT01234567", "10.1038/s41586-024-07691-8", "rs429358",
    ]);
    expect(identificadoresSinRespaldo("El ensayo NCT01234567 [a.pdf, pág. 1].", ["Trial NCT01234567 enrolled 300."])).toEqual([]);
    expect(identificadoresSinRespaldo("El ensayo NCT09999999 [a.pdf, pág. 1].", ["Trial NCT01234567 enrolled 300."])).toEqual(["NCT09999999"]);
  });

  test("el juez recibe qué cifras de la frase no aparecen literalmente, y solo esas", async () => {
    const ch = frag("c1", "The conversion rate was 31.6% at 24 months in 412 patients.", "a.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "no_sostenida", motivo: "la cifra no está" }] }));
    await verificar(`La conversión fue del 30 % a los 24 meses en 412 pacientes ${cita(ch)}.`, [ch]);
    const enviado = ultimoMensaje(espia.mock.calls[0]);
    expect(enviado).toContain("(cifras de la afirmación que NO aparecen literalmente en ningún fragmento: 30)");
    expect(enviado).not.toContain("24,");
    // Con todas las cifras presentes no hay nota.
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    await verificar(`La conversión fue del 31,6 % a los 24 meses ${cita(ch)}.`, [ch]);
    expect(ultimoMensaje(espia.mock.calls[1])).not.toContain("cifras de la afirmación");
  });

  test("ADVERSARIAL: un identificador que no está en el fragmento citado se condena sin juez; uno que sí está pasa al juez", async () => {
    const ch = frag("c1", "The trial NCT01234567 enrolled 300 patients.", "a.pdf", 3);
    const tel = new Telemetria();
    const informe = await verificar(`El ensayo NCT09999999 incluyó 300 pacientes ${cita(ch)}.`, [ch], null, null, tel);
    expect(espia).not.toHaveBeenCalled();
    expect(informe.afirmaciones[0]).toMatchObject({ veredicto: NO_SOSTENIDA });
    expect(informe.afirmaciones[0].motivo).toContain("NCT09999999");
    expect(tel.contadores.identificadores_sin_respaldo).toBe(1);
    expect(informe.fidelidad).toBe(0);

    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const bien = await verificar(`El ensayo NCT01234567 incluyó 300 pacientes ${cita(ch)}.`, [ch]);
    expect(espia).toHaveBeenCalledTimes(1);
    expect(bien.afirmaciones[0].veredicto).toBe(SOSTENIDA);
  });
});

describe("aviso de avance (alAvanzar)", () => {
  test("avisa con (0, total) antes de juzgar y una vez por lote, también por el lote que falla", async () => {
    process.env.VERIFIER_MAX_CLAIMS = "1";
    const c1 = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    const c2 = frag("c2", "El AUC fue 0.94.", "e.pdf", 4);
    const c3 = frag("c3", "La edad media fue 72 años.", "e.pdf", 5);
    espia
      .mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }))
      .mockRejectedValueOnce(new Error("lote caído"))
      .mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const avisos: Array<[number, number]> = [];
    const informe = await verificar(
      `La conversión fue del 31.6% ${cita(c1)}. El AUC fue 0.94 ${cita(c2)}. La edad media fue 72 años ${cita(c3)}.`,
      [c1, c2, c3],
      null,
      null,
      undefined,
      { alAvanzar: (hechas, total) => avisos.push([hechas, total]) },
    );
    expect(avisos[0]).toEqual([0, 3]);
    expect(avisos).toHaveLength(4);
    expect(avisos[avisos.length - 1]).toEqual([3, 3]);
    expect(avisos.every(([h, t]) => h <= t)).toBe(true);
    // El lote caído no cambió el resultado: dos sostenidas y una sin veredicto.
    expect(veredictos(informe).filter((v) => v === SOSTENIDA)).toHaveLength(2);
  });

  test("ADVERSARIAL: un aviso que lanza no tumba el juicio", async () => {
    const c1 = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const informe = await verificar(`La conversión fue del 31.6% ${cita(c1)}.`, [c1], null, null, undefined, {
      alAvanzar: () => {
        throw new Error("la base se cayó");
      },
    });
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
  });

  test("sin afirmaciones nuevas (todas reutilizadas) no se avisa: no hay nada que esperar", async () => {
    const c1 = frag("c1", "La conversión fue del 31.6%.", "e.pdf", 3);
    const texto = `La conversión fue del 31.6% ${cita(c1)}.`;
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "ok" }] }));
    const previo = await verificar(texto, [c1]);
    const avisos: unknown[] = [];
    await verificar(texto, [c1], null, null, undefined, { veredictosPrevios: veredictosDe(previo), alAvanzar: (h, t) => avisos.push([h, t]) });
    expect(avisos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Declaraciones de ausencia dentro de una respuesta larga
// ---------------------------------------------------------------------------
describe("declaraciones puras de ausencia", () => {
  test("REGRESIÓN de producción: la ausencia que nombra GEN 1 sigue siendo ausencia", () => {
    // Medido el 9 sep 2026: estas dos frases se auditaron como afirmación sin
    // cita y el recorte de la barrera las borró de la sección "Lo que no
    // está", dejando la respuesta más completa de lo que era.
    expect(
      _esAusenciaPura("No encuentro qué barras concretas recibe la APU cuando asume la carga de GEN 1 en los documentos."),
    ).toBe(true);
    expect(_esAusenciaPura("No encuentro qué ocurre tras la falla de GEN 2 en los documentos.")).toBe(true);
    // Otros números que solo nombran lo que falta: sistema, año, compartimiento.
    expect(_esAusenciaPura("No encuentro el sistema doble de 28 Vcc en los documentos.")).toBe(true);
    expect(_esAusenciaPura("No aparece el estudio de 2023 en los documentos.")).toBe(true);
    expect(_esAusenciaPura("Los documentos no indican qué barras del compartimiento P6 se desconectan.")).toBe(true);
    // Y las que ya funcionaban, sin ningún número.
    expect(_esAusenciaPura("No pude comprobar el orden de entrada en los documentos.")).toBe(true);
  });

  test("ADVERSARIAL: esto NO puede servir de comodín para colar un dato sin cita", () => {
    // Una cifra con forma de medida, con o sin cláusula adversativa.
    expect(_esAusenciaPura("No hay datos de X, pero el AUC fue 0,94.")).toBe(false);
    expect(_esAusenciaPura("No encuentro el desglose; la conversión fue del 31,6 %.")).toBe(false);
    expect(_esAusenciaPura("No encuentro el dato: la mortalidad fue 30 % menor en el brazo tratado.")).toBe(false);
    expect(_esAusenciaPura("No hay información del reclutamiento y hubo 412 participantes en los documentos.")).toBe(false);
    // Una segunda cláusula, aunque no lleve ninguna cifra.
    expect(_esAusenciaPura("No encuentro el orden, aunque el generador de la APU entra primero.")).toBe(false);
    expect(_esAusenciaPura("No aparece la lógica, sin embargo la batería alimenta la barra caliente.")).toBe(false);
    // Y lo que no declara ninguna ausencia sigue siendo una afirmación.
    expect(_esAusenciaPura("La batería alimenta la barra de batería caliente.")).toBe(false);
  });

  test("de punta a punta: la sección 'Lo que no está' no bloquea ni se cuenta como afirmación sin cita", async () => {
    const ch = frag("c1", "Los alternadores suministran la corriente del sistema.", "M6U1.pdf", 7);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(
      `Los alternadores suministran la corriente del sistema ${cita(ch)}.\n\n` +
        "## Lo que no está\n\n" +
        "- No encuentro qué barras concretas recibe la APU cuando asume la carga de GEN 1 en los documentos.\n" +
        "- No encuentro qué ocurre tras la falla de GEN 2 en los documentos.\n",
      [ch],
    );

    // Una sola afirmación auditada, la que cita; las dos ausencias no entran.
    expect(veredictos(informe)).toEqual([SOSTENIDA]);
    expect(informe.ok).toBe(true);
    expect(informe.fidelidad).toBe(1);
    expect(informe.afirmaciones.some((a) => a.texto.includes("GEN 1"))).toBe(false);
  });

  test("ADVERSARIAL de punta a punta: una ausencia que además afirma una cifra SÍ sale como sin_cita", async () => {
    const ch = frag("c1", "Los alternadores suministran la corriente del sistema.", "M6U1.pdf", 7);
    espia.mockResolvedValueOnce(respuestaJson({ veredictos: [{ i: 0, veredicto: "sostenida", motivo: "coincide" }] }));

    const informe = await verificar(
      `Los alternadores suministran la corriente del sistema ${cita(ch)}.\n\n` +
        "No encuentro el desglose de cargas en los documentos, pero la barra de reserva soporta 0,5 A.\n",
      [ch],
    );

    expect(veredictos(informe)).toContain(SIN_CITA);
    expect(informe.ok).toBe(false);
    expect(informe.afirmaciones.some((a) => a.veredicto === SIN_CITA && a.texto.includes("0,5 A"))).toBe(true);
  });
});
