// Los ajustes que salen del entorno. Lo que importa aquí es que un valor mal
// puesto se vea, no que se lea como "apagado".
import { afterEach, describe, expect, test, vi } from "vitest";
import { ajustes } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("booleanos de entorno", () => {
  test("los valores reconocidos se leen, en cualquier caja", () => {
    vi.stubEnv("OPENAI_API_KEY", "vck_prueba");
    vi.stubEnv("ENABLE_OCR", "FALSE");
    expect(ajustes().ocrHabilitado).toBe(false);
    vi.stubEnv("ENABLE_OCR", "on");
    expect(ajustes().ocrHabilitado).toBe(true);
    vi.stubEnv("ENABLE_OCR", "0");
    expect(ajustes().ocrHabilitado).toBe(false);
    vi.stubEnv("ENABLE_OCR", "");
    expect(ajustes().ocrHabilitado).toBe(true);
  });

  test("ADVERSARIAL: un valor no reconocido LANZA en vez de apagar la barrera en silencio", () => {
    vi.stubEnv("OPENAI_API_KEY", "vck_prueba");
    vi.stubEnv("ENABLE_ANSWER_VERIFICATION", "enabled");
    expect(() => ajustes()).toThrow(/ENABLE_ANSWER_VERIFICATION="enabled" no es un booleano/);
  });
});
