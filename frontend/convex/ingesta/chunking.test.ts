// Empaquetado con solape y prefijo de contexto: lógica pura, corre en el
// entorno por defecto (edge-runtime) porque no toca nada de Node.
import { describe, expect, test } from "vitest";
import {
  MAX_CHUNK_CHARS,
  OVERLAP_TOKENS,
  TARGET_TOKENS,
  agruparPorSeccion,
  chunkBase,
  conContexto,
  empaquetar,
  estTokens,
  partirParrafoLargo,
  partirParrafos,
  tipoDeDocumento,
} from "./chunking";

function oraciones(n: number): string[] {
  // ~80 caracteres cada una, o sea ~20 tokens, como en el test del Python.
  return Array.from(
    { length: n },
    (_, i) => `Methods sentence ${String(i).padStart(3, "0")} describes one recruitment step of the cohort in detail.`,
  );
}

/** Párrafos finales de `anterior` con los que arranca `siguiente`. */
function solape(anterior: string[], siguiente: string[]): string[] {
  for (let k = Math.min(anterior.length, siguiente.length); k > 0; k--) {
    if (anterior.slice(-k).join("\n") === siguiente.slice(0, k).join("\n")) return siguiente.slice(0, k);
  }
  return [];
}

describe("estimación y subdivisión", () => {
  test("cuatro caracteres por token, nunca cero", () => {
    expect(estTokens("")).toBe(1);
    expect(estTokens("a".repeat(400))).toBe(100);
  });

  test("un párrafo corto se deja tal cual", () => {
    expect(partirParrafoLargo("Una frase. Otra frase.")).toEqual(["Una frase. Otra frase."]);
  });

  test("un párrafo largo se parte por oraciones en piezas de ~400 tokens", () => {
    const largo = oraciones(60).join(" "); // ~1200 tokens
    const piezas = partirParrafoLargo(largo);
    expect(piezas.length).toBeGreaterThan(1);
    for (const pieza of piezas) {
      expect(estTokens(pieza)).toBeLessThanOrEqual(TARGET_TOKENS + 25);
      // Cada pieza empieza y acaba en frontera de oración.
      expect(pieza.startsWith("Methods sentence")).toBe(true);
      expect(pieza.endsWith("in detail.")).toBe(true);
    }
    expect(piezas.join(" ")).toBe(largo);
  });

  test("texto sin puntuación se corta por palabras, no por caracteres", () => {
    const palabras = Array.from({ length: 900 }, (_, i) => `palabra${i}`).join(" ");
    const piezas = partirParrafoLargo(palabras);
    expect(piezas.length).toBeGreaterThan(1);
    // Ninguna palabra queda partida: la concatenación devuelve el original.
    expect(piezas.join(" ")).toBe(palabras);
  });

  test("los párrafos se separan por líneas en blanco", () => {
    expect(partirParrafos("Uno.\n\nDos.\n   \nTres.\n")).toEqual(["Uno.", "Dos.", "Tres."]);
  });
});

describe("empaquetar", () => {
  test("chunks de ~400 tokens con la cola del anterior como solape", () => {
    const paras = oraciones(44).map((p) => [p, 0] as [string, number]);
    const paquetes = empaquetar(paras);
    expect(paquetes.length).toBeGreaterThanOrEqual(2);
    for (const paquete of paquetes) {
      const tokens = paquete.reduce((s, [p]) => s + estTokens(p), 0);
      expect(tokens).toBeLessThanOrEqual(TARGET_TOKENS);
    }
    for (let i = 1; i < paquetes.length; i++) {
      const anterior = paquetes[i - 1].map(([p]) => p);
      const siguiente = paquetes[i].map(([p]) => p);
      const cola = solape(anterior, siguiente);
      expect(cola.length).toBeGreaterThan(0);
      const tokensCola = cola.reduce((s, p) => s + estTokens(p), 0);
      // Del orden del 15 % prometido: ni una línea suelta ni el chunk entero.
      expect(tokensCola).toBeGreaterThanOrEqual(OVERLAP_TOKENS / 2);
      expect(tokensCola).toBeLessThanOrEqual(2 * OVERLAP_TOKENS);
      expect(cola.length).toBeLessThan(anterior.length);
    }
    // Nada se pierde.
    const todo = paquetes.flat().map(([p]) => p);
    for (const o of oraciones(44)) expect(todo).toContain(o);
  });

  test("el solape no puede ser el chunk entero: párrafos grandes no se duplican", () => {
    const grande = "x".repeat(1500); // 375 tokens: cada uno llena un chunk
    const paquetes = empaquetar([[grande, 1], [grande + "y", 2], [grande + "z", 3]]);
    expect(paquetes.map((p) => p.length)).toEqual([1, 1, 1]);
  });

  test("el localizador viaja opaco", () => {
    const paquetes = empaquetar([["a", { pagina: 3 }], ["b", { pagina: 4 }]]);
    expect(paquetes).toEqual([[["a", { pagina: 3 }], ["b", { pagina: 4 }]]]);
  });
});

describe("agrupar por sección y prefijo de contexto", () => {
  test("tramos consecutivos de una misma sección", () => {
    const grupos = agruparPorSeccion([
      ["a", 1, "Methods"], ["b", 1, "Methods"], ["c", 2, "Results"], ["d", 2, "Methods"],
    ]);
    expect(grupos.map(([sec, paras]) => [sec, paras.length])).toEqual([
      ["Methods", 2], ["Results", 1], ["Methods", 1],
    ]);
  });

  test("título y sección van delante, una sola vez cada uno", () => {
    expect(conContexto("cuerpo", "Titulo", "Results")).toBe("Titulo\nResults\n\ncuerpo");
    // La portada: el título se detectó como encabezado por formato y ES la sección.
    expect(conContexto("cuerpo", "Tau load", "Tau load")).toBe("Tau load\n\ncuerpo");
    // Word: el encabezado ya es el primer bloque del cuerpo.
    expect(conContexto("Métodos\n\nPaso 1", "Métodos")).toBe("Métodos\n\nPaso 1");
    expect(conContexto("cuerpo", "", "")).toBe("cuerpo");
  });

  test("el chunk base lleva el tipo de documento y recorta a 8000 caracteres", () => {
    const chunk = chunkBase("Datos.XLSX", "x".repeat(9000), 7, [7], "table", { sourceRow: 7 });
    expect(chunk.documentType).toBe("xlsx");
    expect(chunk.text.length).toBe(MAX_CHUNK_CHARS);
    expect(chunk.metadata).toEqual({ source_row: 7 });
    expect(tipoDeDocumento("sin_extension")).toBe("unknown");
  });
});
