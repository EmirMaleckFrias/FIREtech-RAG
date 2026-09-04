// Calificador pointwise con completions JSON falsas. Sin red: `completionJson`
// va parcheado sobre el módulo.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import * as gateway from "../lib/gateway";
import { ajustes, modeloRerankResuelto } from "../lib/config";
import type { Fragmento } from "../lib/citas";
import { Telemetria } from "../lib/telemetry";
import { MOTIVO_SIN_GRADOS, calificarEvidencia } from "./calificador";

function fragmentos(n: number): Fragmento[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: `c${i}`,
    text: `producto ${i}`,
    sourceFile: "cat.pdf",
    page: i + 1,
    documentType: "pdf",
    chunkType: "text",
  }));
}

/** Respuesta del calificador con la forma del contrato. */
function grados(pares: Record<number, string>) {
  return {
    fragmentos: Object.entries(pares).map(([i, g]) => ({ i: Number(i), grado: g, motivo: `motivo ${i}` })),
  };
}

function respuesta(datos: unknown) {
  return {
    datos,
    usage: { prompt: 50, cached: 0, completion: 5, reasoning: 0 },
    modelo: "",
    finishReason: "stop",
    razonamientoRechazado: false,
  };
}

let espia: MockInstance<typeof gateway.completionJson>;
beforeEach(() => {
  espia = vi.spyOn(gateway, "completionJson");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function mensajeUsuario(n = -1): string {
  const llamadas = espia.mock.calls;
  const kwargs = llamadas[n < 0 ? llamadas.length + n : n][0] as { messages: { content: string }[] };
  return kwargs.messages[kwargs.messages.length - 1].content;
}

describe("calificarEvidencia", () => {
  test("manda el texto completo sin truncar, con la pregunta y la evidencia necesaria", async () => {
    // La cifra clave en el carácter 1500 debe llegar al modelo: el filtro
    // binario la perdía porque cortaba a 450.
    const relleno = "palabra ".repeat(190); // 1520 caracteres
    const ch: Fragmento = {
      _id: "c0",
      text: relleno + "la tasa de conversión fue del 42,7 % a 24 meses",
      sourceFile: "a.pdf",
      page: 1,
      documentType: "pdf",
      chunkType: "text",
    };
    espia.mockResolvedValueOnce(respuesta(grados({ 0: "directa" })));

    const out = await calificarEvidencia("conversión a demencia", "tasa de conversión", [ch]);

    expect(out).toEqual({ grados: { 0: "directa" }, verificado: true, motivo: "1 directa, 0 parcial, 0 no de 1 fragmentos" });
    const contenido = mensajeUsuario();
    expect(contenido).toContain("42,7 % a 24 meses");
    expect(contenido).toContain(relleno);
    expect(contenido).toContain("Pregunta: conversión a demencia");
    expect(contenido).toContain("Evidencia necesaria: tasa de conversión");
  });

  test("la cabecera lleva fuente, sección, tipo y cita, con el índice global", async () => {
    const conTodo: Fragmento = {
      _id: "c0",
      text: "Tabla 2. Conversión por grupo.",
      sourceFile: "allegri.pdf",
      page: 4,
      citation: "Allegri et al., 2023",
      section: "Resultados",
      chunkType: "table",
      documentType: "pdf",
    };
    const sinNada: Fragmento = { _id: "c1", text: "texto plano", sourceFile: "notas.txt", page: 2, chunkType: "text" };
    espia.mockResolvedValueOnce(respuesta(grados({ 0: "directa", 1: "no" })));

    await calificarEvidencia("q", "e", [conTodo, sinNada]);

    const contenido = mensajeUsuario();
    expect(contenido).toContain(
      "[0] fuente: Allegri et al., 2023 · seccion: Resultados · tipo: tabla " +
        "· cita: [Allegri et al., 2023, pág. 4]\nTabla 2. Conversión por grupo.",
    );
    // Sin cita se nombra por archivo; sin sección se dice que es desconocida,
    // no se deja un hueco que el modelo pueda leer como "sección vacía".
    expect(contenido).toContain(
      "[1] fuente: notas.txt · seccion: desconocida · tipo: texto " +
        "· cita: [notas.txt, fragmento 2]\ntexto plano",
    );
  });

  test("usa el modelo de rerank con el razonamiento del calificador y la temperatura", async () => {
    espia.mockResolvedValueOnce(respuesta(grados({ 0: "parcial" })));
    await calificarEvidencia("q", "e", fragmentos(1));
    const a = ajustes();
    const kwargs = espia.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(modeloRerankResuelto(a));
    expect(kwargs.reasoning_effort).toBe(a.razonamientoCalificador);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect((kwargs.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("un solo fragmento sí se califica y una lista vacía no llama", async () => {
    espia.mockResolvedValueOnce(respuesta(grados({ 0: "no" })));
    expect(await calificarEvidencia("q", "e", fragmentos(1))).toEqual({
      grados: { 0: "no" },
      verificado: true,
      motivo: "0 directa, 0 parcial, 1 no de 1 fragmentos",
    });
    expect(espia).toHaveBeenCalledTimes(1);

    expect(await calificarEvidencia("q", "e", [])).toEqual({ grados: {}, verificado: true, motivo: "sin candidatos" });
    expect(espia).toHaveBeenCalledTimes(1);
  });

  test("parseo con basura: se ignora entrada a entrada, el resto se conserva", async () => {
    espia.mockResolvedValueOnce(
      respuesta({
        fragmentos: [
          { i: 0, grado: "directa", motivo: "ok" },
          { i: 0, grado: "no" }, // repetido: gana el primero
          { i: 7, grado: "parcial" }, // fuera de rango
          { i: -1, grado: "parcial" }, // fuera de rango
          { i: true, grado: "directa" }, // booleano
          { i: 1.5, grado: "directa" }, // no entero
          { i: 1, grado: "quizás" }, // grado inventado
          { i: 1, grado: 2 }, // grado que no es texto
          "basura", // no es un objeto
          null,
          { grado: "no" }, // sin índice
          { i: "2", grado: " Parcial " }, // índice como texto y grado con mayúscula: se acepta
        ],
      }),
    );
    const out = await calificarEvidencia("q", "e", fragmentos(3));
    expect(out.grados).toEqual({ 0: "directa", 2: "parcial" });
    expect(out.verificado).toBe(true);
    expect(out.motivo).toContain("1 sin calificar por el modelo");
  });

  test("sin la lista 'fragmentos' NO se da por verificado", async () => {
    espia.mockResolvedValueOnce(respuesta({ fragmentos: "todos directa" }));
    let out = await calificarEvidencia("q", "e", fragmentos(2));
    expect(out.grados).toEqual({});
    expect(out.verificado).toBe(false);
    expect(out.motivo).toContain("1 de 1 lotes fallaron");

    espia.mockResolvedValueOnce(respuesta({}));
    out = await calificarEvidencia("q", "e", fragmentos(2));
    expect(out.verificado).toBe(false);

    espia.mockResolvedValueOnce(respuesta([{ i: 0, grado: "directa" }]));
    out = await calificarEvidencia("q", "e", fragmentos(2));
    expect(out.verificado).toBe(false);
  });

  test("TRAMPA: cero grados con respuesta bien formada NO es verificado", async () => {
    // `{"fragmentos": []}`: el modelo respondió y no juzgó nada. Antes esto
    // pasaba como verificado y todos los candidatos se entregaban como
    // "parcial" sin grado, con la relevancia marcada como comprobada.
    const tel = new Telemetria();
    espia.mockResolvedValueOnce(respuesta({ fragmentos: [] }));
    let out = await calificarEvidencia("q", "e", fragmentos(3), tel);
    expect(out).toEqual({ grados: {}, verificado: false, motivo: MOTIVO_SIN_GRADOS });
    // La llamada en sí fue bien: la ronda queda ok, el veredicto no.
    expect(tel.rondas.map((r) => [r.componente, r.ok])).toEqual([["grader", true]]);

    // Todas las entradas descartadas por el parseo es el mismo caso.
    espia.mockResolvedValueOnce(respuesta(grados({ 9: "directa", 10: "no" })));
    out = await calificarEvidencia("q", "e", fragmentos(3));
    expect(out.verificado).toBe(false);
    expect(out.motivo).toBe(MOTIVO_SIN_GRADOS);

    // Y con dos lotes que responden vacío, igual.
    espia.mockResolvedValueOnce(respuesta({ fragmentos: [] }));
    espia.mockResolvedValueOnce(respuesta({ fragmentos: [] }));
    out = await calificarEvidencia("q", "e", fragmentos(25));
    expect(out.verificado).toBe(false);
    expect(espia).toHaveBeenCalledTimes(4);
  });

  test("lotes paralelos reindexados al índice global y telemetría por lote", async () => {
    // 35 fragmentos -> 2 llamadas (20 + 15). La cabecera lleva el índice
    // global, así el modelo lo copia y el resultado cae en el índice correcto.
    const chunks = fragmentos(35);
    espia
      .mockResolvedValueOnce(
        respuesta(grados(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, i % 2 === 0 ? "directa" : "no"])))),
      )
      .mockResolvedValueOnce(
        respuesta(grados(Object.fromEntries(Array.from({ length: 15 }, (_, j) => [20 + j, "parcial"])))),
      );
    const tel = new Telemetria();

    const out = await calificarEvidencia("q", "e", chunks, tel);

    expect(espia).toHaveBeenCalledTimes(2);
    expect(out.verificado).toBe(true);
    expect(Object.keys(out.grados)).toHaveLength(35);
    expect(out.grados[0]).toBe("directa");
    expect(out.grados[1]).toBe("no");
    expect(out.grados[19]).toBe("no");
    for (let i = 20; i < 35; i++) expect(out.grados[i]).toBe("parcial");
    expect(Object.keys(out.grados).map(Number)).toEqual(Array.from({ length: 35 }, (_, i) => i));
    // Cada lote lleva SOLO sus fragmentos, con su índice global.
    const primero = mensajeUsuario(0);
    const segundo = mensajeUsuario(1);
    expect(primero).toContain("[0] fuente: cat.pdf");
    expect(primero).toContain("[19] fuente: cat.pdf");
    expect(primero).not.toContain("[20] fuente");
    expect(segundo).toContain("[20] fuente: cat.pdf");
    expect(segundo).toContain("[34] fuente: cat.pdf");
    expect(segundo).not.toContain("[0] fuente");
    expect(segundo).not.toContain("[19] fuente");
    expect(segundo).toContain("\nproducto 20\n");
    expect(segundo.split("\nproducto 34").length - 1).toBe(1);
    expect(segundo).not.toContain("\nproducto 0\n");
    expect(segundo).not.toContain("\nproducto 19\n");
    expect(segundo).toContain("índices 20 a 34");
    // Telemetría: componente propio, nota con n y lote.
    const rondas = tel.rondas.filter((r) => r.componente === "grader");
    expect(rondas.map((r) => r.nota)).toEqual(["calificar n=35 lote=1/2", "calificar n=35 lote=2/2"]);
    expect(rondas.every((r) => r.ok)).toBe(true);
    expect(rondas[0].prompt).toBe(50);
    expect(Object.keys((tel.resumen() as { por_componente: object }).por_componente)).toEqual(["grader"]);
  });

  test("adversarial: índices locales en el segundo lote se ignoran, no pisan al primero", async () => {
    const chunks = fragmentos(35);
    espia
      .mockResolvedValueOnce(respuesta(grados(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, "directa"])))))
      .mockResolvedValueOnce(respuesta(grados(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i, "no"])))));
    const out = await calificarEvidencia("q", "e", chunks);
    for (let i = 0; i < 20; i++) expect(out.grados[i]).toBe("directa");
    for (let i = 20; i < 35; i++) expect(i in out.grados).toBe(false);
    expect(out.verificado).toBe(true);
    expect(out.motivo).toContain("15 sin calificar por el modelo");
  });

  test("un lote caído conserva los grados de los otros y lo dice", async () => {
    const chunks = fragmentos(35);
    espia
      .mockResolvedValueOnce(respuesta(grados(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, "parcial"])))))
      .mockRejectedValueOnce(new Error("timeout"));
    const tel = new Telemetria();

    const out = await calificarEvidencia("q", "e", chunks, tel);

    expect(out.verificado).toBe(false);
    expect(out.motivo).toContain("1 de 2 lotes fallaron");
    expect(out.motivo).toContain("15 fragmentos sin calificar");
    expect(out.grados).toEqual(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, "parcial"])));
    const rondas = tel.rondas.filter((r) => r.componente === "grader");
    expect(rondas.map((r) => r.ok)).toEqual([true, false]);
    expect(rondas[1].nota.startsWith("calificar n=35 lote=2/2: Error: timeout")).toBe(true);
  });

  test("todos los lotes caídos", async () => {
    espia
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockRejectedValueOnce(new Error("c"));
    const out = await calificarEvidencia("q", "e", fragmentos(45)); // 3 lotes: 20 + 20 + 5
    expect(out.grados).toEqual({});
    expect(out.verificado).toBe(false);
    expect(out.motivo).toContain("3 de 3 lotes fallaron");
    expect(espia).toHaveBeenCalledTimes(3);
  });

  test("es determinista dada la misma respuesta, aunque el JSON llegue desordenado", async () => {
    const chunks = fragmentos(25);
    const a = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, i % 3 === 0 ? "directa" : "parcial"]));
    const b = Object.fromEntries(Array.from({ length: 5 }, (_, j) => [20 + j, "no"]));
    const desordenado = { fragmentos: [...grados(b).fragmentos].reverse() };
    espia
      .mockResolvedValueOnce(respuesta(grados(a)))
      .mockResolvedValueOnce(respuesta(grados(b)))
      .mockResolvedValueOnce(respuesta(grados(a)))
      .mockResolvedValueOnce(respuesta(desordenado));

    const uno = await calificarEvidencia("q", "e", chunks);
    const dos = await calificarEvidencia("q", "e", chunks);

    expect(uno).toEqual(dos);
    expect(Object.keys(uno.grados).map(Number)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(espia.mock.calls[0][0]).toEqual(espia.mock.calls[2][0]);
    expect(espia.mock.calls[1][0]).toEqual(espia.mock.calls[3][0]);
  });

  test("los lotes corren en paralelo, no en secuencia", async () => {
    // Con 3 lotes hay 3 llamadas en vuelo a la vez; un bucle secuencial daría 1.
    const enVuelo = { ahora: 0, max: 0 };
    espia.mockImplementation(async () => {
      enVuelo.ahora += 1;
      enVuelo.max = Math.max(enVuelo.max, enVuelo.ahora);
      await new Promise((r) => setTimeout(r, 20));
      enVuelo.ahora -= 1;
      return respuesta(grados({ 0: "directa" }));
    });
    const out = await calificarEvidencia("q", "e", fragmentos(45));
    expect(enVuelo.max).toBe(3);
    // Solo el primer lote devolvió un índice dentro de su ventana.
    expect(out.grados).toEqual({ 0: "directa" });
    expect(out.verificado).toBe(true);
  });
});
