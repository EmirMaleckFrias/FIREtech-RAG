// Lógica pura, sin despliegue ni red.
import { describe, expect, test } from "vitest";
import { MAX_CARACTERES_TERMINO, MAX_TERMINOS, terminosDeBusqueda } from "./terminos";

const PREGUNTA_ES =
  "¿Cuál es la sensibilidad y la especificidad de p-tau217 en el plasma " +
  "para la detección de la enfermedad de Alzheimer, según los documentos?";
const PREGUNTA_EN =
  "What is the sensitivity of plasma p-tau217 for the detection of " +
  "Alzheimer's disease in the APOE4 carriers?";

describe("terminosDeBusqueda", () => {
  test("quita puntuacion y palabras vacias en espanol y conserva el resto en orden", () => {
    expect(terminosDeBusqueda(PREGUNTA_ES)).toEqual([
      "sensibilidad",
      "especificidad",
      "p-tau217",
      "plasma",
      "detección",
      "enfermedad",
      "Alzheimer",
      "documentos",
    ]);
  });

  test("quita las palabras vacias en ingles y el apostrofe no deja letras sueltas", () => {
    const terminos = terminosDeBusqueda(PREGUNTA_EN);
    expect(terminos).toEqual([
      "sensitivity",
      "plasma",
      "p-tau217",
      "detection",
      "Alzheimer",
      "disease",
      "APOE4",
      "carriers",
    ]);
    // "s" de "Alzheimer's" y "the/of/for/in/what/is" no deben pasar.
    expect(terminos).not.toContain("s");
    for (const vacia of ["what", "is", "the", "of", "for", "in"]) {
      expect(terminos.map((t) => t.toLowerCase())).not.toContain(vacia);
    }
  });

  test("conserva los terminos tecnicos con guion o digitos y descarta los numeros sueltos", () => {
    const terminos = terminosDeBusqueda(
      "El AUC de p-tau217 fue 0,94 en 2023 (n=94) y APOE4 subió el riesgo; MMSE 24.",
    );
    expect(terminos).toContain("p-tau217");
    expect(terminos).toContain("APOE4");
    expect(terminos).toContain("MMSE");
    expect(terminos).toContain("AUC");
    // Números sueltos: no son palabras y el tokenizador los partiría.
    for (const numero of ["0,94", "0", "94", "2023", "24"]) {
      expect(terminos).not.toContain(numero);
    }
    // "n" de "(n=94)" es un solo carácter: casaría con todo por prefijo.
    expect(terminos).not.toContain("n");
  });

  test("deduplica sin distinguir mayusculas, porque el indice pone todo en minusculas", () => {
    expect(terminosDeBusqueda("tau Tau TAU tau217")).toEqual(["tau", "tau217"]);
  });

  test("nunca devuelve mas de 16 terminos ni terminos de mas de 32 caracteres", () => {
    const largas = Array.from({ length: 30 }, (_, i) => `palabra${"x".repeat(i)}`);
    const terminos = terminosDeBusqueda(largas.join(" "));
    expect(terminos.length).toBeLessThanOrEqual(MAX_TERMINOS);
    for (const t of terminos) {
      expect(Array.from(t).length).toBeLessThanOrEqual(MAX_CARACTERES_TERMINO);
      expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(MAX_CARACTERES_TERMINO);
    }
    // El recorte a 32 caracteres no descarta el término: lo acorta.
    const terminoLargo = "a".repeat(40) + "-" + "b".repeat(5);
    expect(terminosDeBusqueda(terminoLargo)).toEqual(["a".repeat(32)]);
    // Y con acentos el tope en bytes también se respeta.
    const acentuado = "é".repeat(40);
    expect(new TextEncoder().encode(terminosDeBusqueda(acentuado)[0]).length).toBeLessThanOrEqual(32);
  });

  test("si sobran, se quedan los que llevan digitos o mayusculas y los mas largos, en el orden de la frase", () => {
    // 18 términos con contenido: 16 palabras corrientes cortas y, al final,
    // dos que el vector denso distingue mal. Deben sobrevivir los dos.
    const corrientes = [
      "casa", "perro", "mesa", "coche", "libro", "verde", "puerta", "camino",
      "nube", "playa", "monte", "silla", "fruta", "reloj", "papel", "lluvia",
    ];
    const terminos = terminosDeBusqueda([...corrientes, "p-tau217", "MMSE"].join(" "));
    expect(terminos.length).toBeLessThanOrEqual(MAX_TERMINOS);
    expect(terminos).toContain("p-tau217");
    expect(terminos).toContain("MMSE");
    // El orden es el de la frase, no el de prioridad: los dos técnicos van al
    // final porque ahí estaban, y por eso el último casa por prefijo.
    expect(terminos.slice(-2)).toEqual(["p-tau217", "MMSE"]);
    // Y entre corrientes se van antes las más cortas.
    expect(terminos).not.toContain("casa");
    expect(terminos).not.toContain("nube");
  });

  test("un termino con guion cuenta como los segmentos que vera el tokenizador del indice", () => {
    // El tokenizador del índice parte en la puntuación, así que 16 términos
    // "a-b" serían 32 para él. Con presupuesto 16 caben 8.
    const conGuion = Array.from({ length: 16 }, (_, i) => `alfa${i}-beta${i}`);
    const terminos = terminosDeBusqueda(conGuion.join(" "));
    expect(terminos.length).toBe(8);
    expect(terminos.every((t) => t.includes("-"))).toBe(true);
  });

  test("la inicial de la frase en mayuscula no cuenta como sigla", () => {
    // "Cuánta" es mayúscula por posición; "AUC" es una sigla. Con presupuesto
    // para dos, deben quedar AUC y la palabra más larga, no "Cuánta".
    const terminos = terminosDeBusqueda("Cuánta sensibilidad tiene AUC hoy", 2);
    expect(terminos).toEqual(["sensibilidad", "AUC"]);
  });

  test("max acota y se recorta a 16 aunque pidan mas", () => {
    // Con presupuesto para dos quedan los dos más largos, en el orden de la
    // frase: "tres" y "cuatro", no los dos primeros.
    expect(terminosDeBusqueda("uno dos tres cuatro", 2)).toEqual(["tres", "cuatro"]);
    // A igual longitud manda la posición.
    expect(terminosDeBusqueda("gato lobo pato", 2)).toEqual(["gato", "lobo"]);
    expect(terminosDeBusqueda("uno dos", 0)).toEqual([]);
    const treinta = Array.from({ length: 30 }, (_, i) => `termino${i}z`).join(" ");
    expect(terminosDeBusqueda(treinta, 99).length).toBe(MAX_TERMINOS);
    // Adversarial: un `max` no finito no puede saltarse el tope del índice.
    expect(terminosDeBusqueda(treinta, Number.NaN).length).toBe(MAX_TERMINOS);
    expect(terminosDeBusqueda(treinta, null as unknown as number).length).toBe(MAX_TERMINOS);
    expect(terminosDeBusqueda(treinta, Number.POSITIVE_INFINITY).length).toBe(MAX_TERMINOS);
  });

  test("una consulta solo de palabras vacias no deja terminos", () => {
    expect(terminosDeBusqueda("¿qué es lo que hay de esto?")).toEqual([]);
    expect(terminosDeBusqueda("")).toEqual([]);
    expect(terminosDeBusqueda("   ")).toEqual([]);
  });

  test("los acentos se conservan en la salida porque el indice no los pliega", () => {
    expect(terminosDeBusqueda("detección precoz")).toEqual(["detección", "precoz"]);
  });
});
