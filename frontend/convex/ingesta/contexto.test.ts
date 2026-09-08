// Recuperación contextual: la ficha, el mensaje por grupo, la lectura
// tolerante de la respuesta y la contextualización por grupos con fallos
// parciales. Sin red: `completionJson` va parcheado.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import * as gateway from "../lib/gateway";
import { ajustes, modeloContextoResuelto } from "../lib/config";
import { Telemetria } from "../lib/telemetry";
import { chunkBase } from "./chunking";
import {
  MAX_CONTEXTO_CHARS,
  TAMANO_GRUPO,
  contextualizar,
  fichaEnTexto,
  inicioDe,
  mensajeDeGrupo,
  parsearContextos,
  seccionesDe,
  textoParaEmbeber,
  type FichaDocumento,
} from "./contexto";
import type { ChunkParseado } from "./tipos";

function fragmento(i: number, section = "Results"): ChunkParseado {
  return chunkBase("paper.pdf", `Texto del fragmento ${i} con su cifra ${i * 10} pg/mL.`, i + 1, [i + 1], "text", { section });
}

function respuesta(datos: unknown) {
  return {
    datos,
    usage: { prompt: 100, cached: 0, completion: 20, reasoning: 0 },
    modelo: "openai/gpt-5.4-mini",
    finishReason: "stop",
    razonamientoRechazado: false,
  };
}

const FICHA: FichaDocumento = {
  fileName: "paper.pdf",
  titulo: "Plasma p-tau217 in a memory clinic",
  citation: "Luechaipanit et al., 2025",
  doi: "10.1/xyz",
  language: "en",
  documentType: "pdf",
  pages: 9,
  secciones: ["Abstract", "Methods", "Results"],
  inicio: "Plasma p-tau217 in a memory clinic. Abstract. We measured...",
};

let espia: MockInstance<typeof gateway.completionJson>;
beforeEach(() => {
  espia = vi.spyOn(gateway, "completionJson");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ficha y mensaje", () => {
  test("la ficha solo escribe lo que se sabe y el mensaje numera los fragmentos desde 0", () => {
    const completa = fichaEnTexto(FICHA);
    expect(completa).toContain("Documento: paper.pdf");
    expect(completa).toContain("Título: Plasma p-tau217 in a memory clinic");
    expect(completa).toContain("Cita: Luechaipanit et al., 2025");
    expect(completa).toContain("Secciones: Abstract | Methods | Results");
    expect(completa).toContain("Comienzo del documento: Plasma p-tau217");
    // Sin título ni cita ni secciones: ni una línea vacía ni un "Título:" hueco.
    const minima = fichaEnTexto({ fileName: "notas.txt" });
    expect(minima).toBe("Documento: notas.txt");

    const mensaje = mensajeDeGrupo(FICHA, [fragmento(0), fragmento(1, "")]);
    expect(mensaje).toContain("[0] página 1 · sección: Results · tipo: texto\nTexto del fragmento 0");
    expect(mensaje).toContain("[1] página 2 · sección: desconocida · tipo: texto");
    expect(mensaje).toContain("índices 0 a 1");
    expect(mensaje).toContain('"contextos"');
  });

  test("seccionesDe no repite ni cuenta vacías, e inicioDe recorta el comienzo", () => {
    const chunks = [fragmento(0, "Abstract"), fragmento(1, "Abstract"), fragmento(2, ""), fragmento(3, " Methods "), fragmento(4, "Methods")];
    expect(seccionesDe(chunks)).toEqual(["Abstract", "Methods"]);
    const inicio = inicioDe(chunks);
    expect(inicio.startsWith("Texto del fragmento 0 con su cifra 0 pg/mL. Texto del fragmento 1")).toBe(true);
    expect(inicio.length).toBeLessThanOrEqual(1500);
    // Un documento con un primer fragmento enorme se recorta al tope.
    const largo = [chunkBase("x.txt", "a".repeat(5000), 1, [1], "text")];
    expect(inicioDe(largo).length).toBe(1500);
  });

  test("textoParaEmbeber antepone el contexto solo cuando lo hay", () => {
    expect(textoParaEmbeber("Del estudio X, cohorte MCI.", "the mean was 542")).toBe("Del estudio X, cohorte MCI.\n\nthe mean was 542");
    expect(textoParaEmbeber(undefined, "texto")).toBe("texto");
    expect(textoParaEmbeber("   ", "texto")).toBe("texto");
  });
});

describe("parsearContextos", () => {
  test("acepta índices como número o texto, ignora lo que no cuadra y recorta al tope", () => {
    const salida = parsearContextos(
      {
        contextos: [
          { i: 0, contexto: "  primero   con   espacios  " },
          { i: "1", contexto: "x".repeat(MAX_CONTEXTO_CHARS + 50) },
          { i: 1, contexto: "repetido: se ignora" },
          { i: 2, contexto: "" },
          { i: 3, contexto: 42 },
          { i: 9, contexto: "fuera de rango" },
          { i: true, contexto: "booleano" },
          { i: 1.5, contexto: "no entero" },
          "basura",
          null,
        ],
      },
      4,
    );
    expect(salida).toEqual(["primero con espacios", "x".repeat(MAX_CONTEXTO_CHARS), undefined, undefined]);
  });

  test("sin la lista, o sin objeto, lanza: es un fallo del grupo, no un grupo vacío", () => {
    expect(() => parsearContextos({}, 2)).toThrow(/sin lista/);
    expect(() => parsearContextos([], 2)).toThrow(/no es un objeto/);
    expect(() => parsearContextos(null, 2)).toThrow();
  });
});

describe("contextualizar", () => {
  test("un grupo por cada TAMANO_GRUPO fragmentos consecutivos, con el modelo y el razonamiento del contexto", async () => {
    const n = TAMANO_GRUPO + 3;
    const chunks = Array.from({ length: n }, (_, i) => fragmento(i));
    espia.mockImplementation(async (kwargs) => {
      const usuario = (kwargs.messages as Array<{ content: string }>)[1].content;
      const m = /índices 0 a (\d+)/.exec(usuario)!;
      const cuantos = Number(m[1]) + 1;
      return respuesta({ contextos: Array.from({ length: cuantos }, (_, i) => ({ i, contexto: `ctx ${usuario.includes("fragmento 0 ") ? "A" : "B"} ${i}` })) });
    });
    const tel = new Telemetria();

    const r = await contextualizar(FICHA, chunks, ajustes(), tel);

    expect(espia).toHaveBeenCalledTimes(2);
    const a = ajustes();
    const kwargs = espia.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(modeloContextoResuelto(a));
    expect(kwargs.reasoning_effort).toBe(a.razonamientoContexto);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect(r.fallidos).toBe(0);
    expect(r.contextos).toHaveLength(n);
    // El primer grupo lleva los 12 primeros; el segundo, los 3 restantes con
    // índices que vuelven a empezar en 0 y se recolocan por posición global.
    expect(r.contextos.slice(0, TAMANO_GRUPO)).toEqual(Array.from({ length: TAMANO_GRUPO }, (_, i) => `ctx A ${i}`));
    expect(r.contextos.slice(TAMANO_GRUPO)).toEqual(["ctx B 0", "ctx B 1", "ctx B 2"]);
    expect(tel.rondas).toHaveLength(2);
    expect(tel.rondas.every((x) => x.componente === "contexto" && x.ok)).toBe(true);
  });

  test("ADVERSARIAL: un grupo caído deja los suyos sin contexto y cuenta como fallidos; los demás siguen", async () => {
    const n = TAMANO_GRUPO * 2;
    const chunks = Array.from({ length: n }, (_, i) => fragmento(i));
    let llamada = 0;
    espia.mockImplementation(async () => {
      if (++llamada === 1) throw new Error("gateway 503");
      return respuesta({ contextos: Array.from({ length: TAMANO_GRUPO }, (_, i) => ({ i, contexto: `ok ${i}` })) });
    });
    const tel = new Telemetria();

    const r = await contextualizar(FICHA, chunks, ajustes(), tel);

    expect(r.fallidos).toBe(TAMANO_GRUPO);
    expect(r.contextos.slice(0, TAMANO_GRUPO).every((c) => c === undefined)).toBe(true);
    expect(r.contextos.slice(TAMANO_GRUPO)).toEqual(Array.from({ length: TAMANO_GRUPO }, (_, i) => `ok ${i}`));
    expect(tel.rondas.filter((x) => !x.ok)).toHaveLength(1);
    expect(tel.rondas.find((x) => !x.ok)?.nota).toContain("gateway 503");
  });

  test("ADVERSARIAL: una respuesta 200 sin la lista es un grupo fallido, no un grupo de contextos vacíos aprobado", async () => {
    espia.mockResolvedValueOnce(respuesta({ resultado: "sin la clave que toca" }));
    const tel = new Telemetria();
    const r = await contextualizar(FICHA, [fragmento(0), fragmento(1)], ajustes(), tel);
    expect(r.fallidos).toBe(2);
    expect(r.contextos).toEqual([undefined, undefined]);
    expect(tel.rondas[0].ok).toBe(false);
  });

  test("el modelo que se salta un fragmento lo deja sin contexto y se cuenta, aunque el grupo respondiera", async () => {
    espia.mockResolvedValueOnce(respuesta({ contextos: [{ i: 0, contexto: "solo el primero" }] }));
    const r = await contextualizar(FICHA, [fragmento(0), fragmento(1), fragmento(2)]);
    expect(r.contextos).toEqual(["solo el primero", undefined, undefined]);
    expect(r.fallidos).toBe(2);
  });

  test("sin fragmentos no hay llamadas", async () => {
    const r = await contextualizar(FICHA, []);
    expect(r).toEqual({ contextos: [], fallidos: 0 });
    expect(espia).not.toHaveBeenCalled();
  });
});
