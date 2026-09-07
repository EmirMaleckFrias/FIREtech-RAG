// @vitest-environment node
/// <reference types="vite/client" />
// La función `crearOcr` con la caché real (convex-test) y el gateway
// parcheado. Lo que se prueba aquí es lo que no se veía en las pruebas de los
// ayudantes puros: qué se cachea y qué no.
//
// El test que importa es el adversarial: una respuesta cortada por longitud o
// sin contenido NO puede dejar fila en `ocrCache`. Antes se cacheaba "" para
// esos casos, `guardarOcr` no sobrescribe y la tabla no caduca, así que la
// página quedaba muda para siempre y reindexar no lo arreglaba.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { Ajustes } from "../lib/config";
import { ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import schema from "../schema";
import { crearOcr } from "./ocr";
import type { ImagenParaOcr } from "./tipos";

const modules = import.meta.glob("/convex/**/*.*s");

function base() {
  const t = convexTest(schema, modules);
  // Un ActionCtx de mentira que encamina las funciones internas a la base en
  // memoria; es lo único que crearOcr usa de él.
  const ctx = {
    runQuery: (ref: unknown, args: unknown) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;
  return { t, ctx };
}

function imagen(semilla: number): ImagenParaOcr {
  // 64x64 gris con un patrón distinto por semilla, para que la clave cambie.
  const datos = new Uint8Array(64 * 64);
  for (let i = 0; i < datos.length; i++) datos[i] = (i * semilla) & 0xff;
  return { tipo: "pixeles", ancho: 64, alto: 64, datos, canales: 1 };
}

function conAjustes(extra: Partial<Ajustes> = {}): Ajustes {
  return { ...ajustes(), ocrHabilitado: true, ocrModelo: "openai/gpt-5.4-mini", ocrMaxImagenesPorDocumento: 300, ...extra };
}

function respuesta(contenido: string | null, finish: string | null = "stop") {
  return {
    datos: {
      choices: [{ message: { content: contenido }, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
    razonamientoRechazado: false,
  };
}

async function filasDeCache(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("ocrCache").collect());
}

// Espera a que la mutación de guardado (que crearOcr lanza sin esperar) acabe.
const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => vi.restoreAllMocks());

describe("crearOcr: qué se cachea", () => {
  test("una lectura completa se cachea y la segunda vez no llama al modelo", async () => {
    const { t, ctx } = base();
    const llamada = vi.spyOn(gateway, "crearCompletion").mockResolvedValue(respuesta("# Guía\n\nDosis: 5 mg."));
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes());

    const r1 = await ocr(imagen(1), { nombre: "a.pdf", pagina: 1 });
    expect(r1).toEqual({ texto: "# Guía\n\nDosis: 5 mg.", estado: "ok" });
    await tick();
    expect(await filasDeCache(t)).toHaveLength(1);

    const r2 = await ocr(imagen(1), { nombre: "a.pdf", pagina: 2 });
    expect(r2.texto).toBe(r1.texto);
    expect(llamada).toHaveBeenCalledTimes(1);
    expect(estadisticas).toMatchObject({ imagenes: 2, leidas: 1, enCache: 1, fallidas: 0 });
    // Se pide poco razonamiento: transcribir no es razonar, y el esfuerzo por
    // defecto se comía el presupuesto de la respuesta.
    expect(llamada.mock.calls[0][0]).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 6000 });
  });

  test("'SIN TEXTO' es un resultado legítimo: se cachea como vacío y no se vuelve a preguntar", async () => {
    const { t, ctx } = base();
    const llamada = vi.spyOn(gateway, "crearCompletion").mockResolvedValue(respuesta("SIN TEXTO."));
    const { ocr } = crearOcr(ctx, conAjustes());
    expect(await ocr(imagen(2), { nombre: "b.pdf" })).toEqual({ texto: "", estado: "sin_texto" });
    await tick();
    expect(await filasDeCache(t)).toEqual([expect.objectContaining({ texto: "" })]);
    expect(await ocr(imagen(2), { nombre: "b.pdf" })).toEqual({ texto: "", estado: "sin_texto" });
    expect(llamada).toHaveBeenCalledTimes(1);
  });

  test("ADVERSARIAL: cortada por longitud -> fallo, NO se cachea, y la siguiente vez se vuelve a preguntar", async () => {
    const { t, ctx } = base();
    const llamada = vi
      .spyOn(gateway, "crearCompletion")
      .mockResolvedValueOnce(respuesta("| Dosis | mg |\n| --- |", "length"))
      .mockResolvedValueOnce(respuesta("| Dosis | mg |\n| --- | --- |\n| A | 5 |"));
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes());

    const r1 = await ocr(imagen(3), { nombre: "c.pdf", pagina: 7 });
    expect(r1.estado).toBe("fallo");
    expect(r1.motivo).toMatch(/se cortó/);
    // Lo parcial se devuelve (mejor media tabla que nada), pero marcado.
    expect(r1.texto).toContain("Dosis");
    await tick();
    expect(await filasDeCache(t)).toEqual([]);

    const r2 = await ocr(imagen(3), { nombre: "c.pdf", pagina: 7 });
    expect(r2.estado).toBe("ok");
    expect(llamada).toHaveBeenCalledTimes(2);
    expect(estadisticas).toMatchObject({ fallidas: 1, leidas: 1 });
    await tick();
    expect(await filasDeCache(t)).toHaveLength(1);
  });

  test("ADVERSARIAL: contenido nulo (filtro, rechazo) -> fallo y sin fila en la caché", async () => {
    const { t, ctx } = base();
    vi.spyOn(gateway, "crearCompletion").mockResolvedValue(respuesta(null, "content_filter"));
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes());
    const r = await ocr(imagen(4), { nombre: "d.png" });
    expect(r).toMatchObject({ texto: "", estado: "fallo" });
    expect(r.motivo).toMatch(/content_filter/);
    await tick();
    expect(await filasDeCache(t)).toEqual([]);
    expect(estadisticas.fallidas).toBe(1);
    expect(estadisticas.leidas).toBe(0);
  });

  test("si el gateway lanza -> fallo con el motivo, sin cachear y sin propagar", async () => {
    const { t, ctx } = base();
    vi.spyOn(gateway, "crearCompletion").mockRejectedValue(new Error("gateway 429: rate limit"));
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes());
    const r = await ocr(imagen(5), { nombre: "e.pdf", pagina: 1 });
    expect(r.estado).toBe("fallo");
    expect(r.motivo).toMatch(/429/);
    await tick();
    expect(await filasDeCache(t)).toEqual([]);
    expect(estadisticas.fallidas).toBe(1);
  });
});

describe("crearOcr: topes", () => {
  test("pasado el tope por documento, las demás son 'omitida' sin llamar al modelo", async () => {
    const { ctx } = base();
    const llamada = vi.spyOn(gateway, "crearCompletion").mockResolvedValue(respuesta("texto"));
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes({ ocrMaxImagenesPorDocumento: 2 }));
    const r = await Promise.all([1, 2, 3, 4].map((i) => ocr(imagen(10 + i), { nombre: "f.pdf", pagina: i })));
    expect(r.map((x) => x.estado)).toEqual(["ok", "ok", "omitida", "omitida"]);
    expect(r[2].motivo).toMatch(/pasa de 2/);
    expect(llamada).toHaveBeenCalledTimes(2);
    expect(estadisticas).toMatchObject({ imagenes: 2, omitidasPorTope: 2 });
  });

  test("con el OCR desactivado todo es 'omitida' y no hay ninguna llamada", async () => {
    const { ctx } = base();
    const llamada = vi.spyOn(gateway, "crearCompletion");
    const { ocr } = crearOcr(ctx, conAjustes({ ocrHabilitado: false }));
    expect(await ocr(imagen(1), { nombre: "g.pdf" })).toMatchObject({ estado: "omitida" });
    expect(llamada).not.toHaveBeenCalled();
  });

  test("una imagen diminuta es 'omitida' sin contar como intentada", async () => {
    const { ctx } = base();
    const llamada = vi.spyOn(gateway, "crearCompletion");
    const { ocr, estadisticas } = crearOcr(ctx, conAjustes());
    const chica: ImagenParaOcr = { tipo: "pixeles", ancho: 10, alto: 10, datos: new Uint8Array(100), canales: 1 };
    expect(await ocr(chica, { nombre: "h.pdf" })).toMatchObject({ estado: "omitida" });
    expect(llamada).not.toHaveBeenCalled();
    expect(estadisticas.imagenes).toBe(0);
  });
});
