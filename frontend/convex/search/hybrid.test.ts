// Búsqueda híbrida sobre la base en memoria de convex-test, sin red: el
// gateway va espiado y los vectores son de 3072 dimensiones, como exige el
// índice, generados de forma determinista.
//
// Lo que el arnés SÍ ejecuta de verdad: `ctx.vectorSearch` (similitud coseno
// sobre los vectores insertados, con el filtro `q.eq`) y la query con
// `withSearchIndex` (filtros `.eq` reales). Lo que NO imita: el orden del lado
// léxico, que aquí es el de inserción y no BM25, y su casación, que es "algún
// término por prefijo". Por eso los textos de prueba usan palabras inventadas
// que solo aparecen donde se quiere, y las pruebas de fusión y desempate se
// construyen con posiciones controladas en las dos listas.
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Fragmento } from "../lib/citas";
import * as gateway from "../lib/gateway";
import { Telemetria } from "../lib/telemetry";
import schema from "../schema";
import {
  buscarHibrido,
  buscarHibridoVarias,
  describirFiltros,
  filtrosActivos,
  fusionarRrf,
  hayFiltros,
} from "./hybrid";

const DIMS = 3072;
const MODELO = "openai/text-embedding-3-large";
const USO = { prompt: 8, cached: 0, completion: 0, reasoning: 0 };

/** Vector de 3072 dimensiones con picos en las posiciones dadas. Entre dos de
 *  estos la similitud coseno la dictan los picos, así que el orden del lado
 *  denso se controla desde el test. */
function vector(picos: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, peso] of Object.entries(picos)) v[Number(i)] = peso;
  return v;
}

/** Sustituye al gateway: cada texto se embebe con la función dada. */
function embedFalso(vectorDe: (texto: string) => number[]) {
  return vi.spyOn(gateway, "embed").mockImplementation(async (textos) => ({
    vectores: textos.map(vectorDe),
    usage: USO,
    modelo: MODELO,
  }));
}

interface Semilla {
  texto: string;
  pico: number;
  sourceFile?: string;
  page?: number;
  documentId?: string;
  documentType?: string;
  language?: string;
}

/** Dos documentos y los fragmentos pedidos, en el orden dado. */
async function sembrar(t: ReturnType<typeof convexTest>, semillas: Semilla[]) {
  return t.run(async (ctx) => {
    const doc = await ctx.db.insert("documents", {
      fileName: "a.pdf",
      sha256: "1",
      pages: 9,
      chunks: semillas.length,
      status: "ready",
      ingestadoEn: 1,
      documentType: "pdf",
      language: "es",
    });
    const ids: Id<"chunks">[] = [];
    for (const [i, s] of semillas.entries()) {
      ids.push(
        await ctx.db.insert("chunks", {
          text: s.texto,
          embedding: vector({ [s.pico]: 1 }),
          sourceFile: s.sourceFile ?? "a.pdf",
          page: s.page ?? i + 1,
          chunkType: "text",
          documentId: s.documentId ?? "doc-1",
          documentType: s.documentType ?? "pdf",
          language: s.language ?? "es",
          documentRef: doc,
        }),
      );
    }
    return ids;
  });
}

/** Un `ActionCtx` cuyo `runQuery` falla solo para la query dada: así se
 *  simula el índice de texto caído sin tocar nada más. */
function conQueryRota(ctx: ActionCtx, nombre: string): ActionCtx {
  const runQuery = (async (ref: unknown, args: unknown) => {
    if (getFunctionName(ref as never) === nombre) throw new Error(`${nombre} caída`);
    return (ctx.runQuery as (r: unknown, a: unknown) => Promise<unknown>)(ref, args);
  }) as ActionCtx["runQuery"];
  return { ...ctx, runQuery };
}

const sinEmbedding = (fragmentos: Fragmento[]) =>
  fragmentos.every((f) => !("embedding" in f) && !("documentRef" in f));

afterEach(() => {
  vi.restoreAllMocks();
});

// A tiene el término y es 2º en el denso; B es 1º en el denso sin el término;
// C es 3º sin el término.
const TRES = [
  { texto: "amiloide en plasma zorro", pico: 0 },
  { texto: "otra cosa sin relación", pico: 1 },
  { texto: "nada que ver aquí", pico: 2 },
];
const CONSULTA_ZORRO = vector({ 1: 3, 0: 2, 2: 1 });

describe("buscarHibrido", () => {
  test("un fragmento presente en los dos lados sube por encima del primero de un solo lado", async () => {
    const t = convexTest(schema);
    const [a, b, c] = await sembrar(t, TRES);
    const embed = embedFalso(() => CONSULTA_ZORRO);
    const tel = new Telemetria();

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 10, tel));

    // Denso: B, A, C. Léxico: solo A. RRF: A = 1/62 + 1/61 > B = 1/61 > C.
    expect(r.recuperacion).toBe("hibrida");
    expect(r.fragmentos.map((f) => f._id)).toEqual([a, b, c]);
    expect(r.fragmentos[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(r.fragmentos[1].score).toBeCloseTo(1 / 61, 12);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toEqual(["zorro"]);
    // Telemetría: la ronda de embeddings y el modo de recuperación.
    expect(tel.rondas).toHaveLength(1);
    expect(tel.rondas[0]).toMatchObject({ componente: "embeddings", modelo: MODELO, prompt: 8, ok: true });
    expect(tel.contadores.recuperacion_hibrida).toBe(1);
  });

  test("el resultado no lleva el vector ni claves internas, pero si todo lo que se cita", async () => {
    const t = convexTest(schema);
    await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 10));

    expect(r.fragmentos).toHaveLength(3);
    expect(sinEmbedding(r.fragmentos)).toBe(true);
    expect(r.fragmentos[0]).toMatchObject({
      text: "amiloide en plasma zorro",
      sourceFile: "a.pdf",
      page: 1,
      chunkType: "text",
      documentId: "doc-1",
      documentType: "pdf",
      language: "es",
    });
    // Sin claves a undefined: `section` no se puso y no debe viajar.
    expect("section" in r.fragmentos[0]).toBe(false);
  });

  test("sin terminos con contenido no se consulta el indice de texto y el modo es densa", async () => {
    const t = convexTest(schema);
    const [a, b, c] = await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);
    const consultadas: string[] = [];

    const r = await t.action((ctx) => {
      const espia: ActionCtx = {
        ...ctx,
        runQuery: (async (ref: unknown, args: unknown) => {
          consultadas.push(getFunctionName(ref as never));
          return (ctx.runQuery as (r: unknown, a: unknown) => Promise<unknown>)(ref, args);
        }) as ActionCtx["runQuery"],
      };
      return buscarHibrido(espia, "¿qué es lo que hay de esto?", {}, 10);
    });

    expect(r.recuperacion).toBe("densa");
    expect(r.fragmentos.map((f) => f._id)).toEqual([b, a, c]); // orden denso puro
    expect(consultadas).not.toContain("search/hybrid:lexica");
    expect(consultadas).toContain("search/hybrid:cargar");
  });

  test("lexico caido: se sigue con el denso y se declara densa", async () => {
    const t = convexTest(schema);
    const [a, b, c] = await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);
    const tel = new Telemetria();

    const r = await t.action((ctx) =>
      buscarHibrido(conQueryRota(ctx, "search/hybrid:lexica"), "zorro", {}, 10, tel),
    );

    expect(r.recuperacion).toBe("densa");
    expect(r.fragmentos.map((f) => f._id)).toEqual([b, a, c]);
    expect(tel.contadores.lado_lexico_caido).toBe(1);
  });

  test("embeddings caidos: se sigue con el lexico, se declara lexica y la telemetria lo anota", async () => {
    const t = convexTest(schema);
    const [a] = await sembrar(t, TRES);
    vi.spyOn(gateway, "embed").mockRejectedValue(new Error("gateway 503"));
    const tel = new Telemetria();

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 10, tel));

    expect(r.recuperacion).toBe("lexica");
    expect(r.fragmentos.map((f) => f._id)).toEqual([a]);
    expect(tel.rondas).toHaveLength(1);
    expect(tel.rondas[0]).toMatchObject({ componente: "embeddings", ok: false });
    expect(tel.rondas[0].nota).toContain("gateway 503");
    expect(tel.contadores.recuperacion_lexica).toBe(1);
  });

  test("la busqueda vectorial lanza: tambien se degrada a lexica", async () => {
    const t = convexTest(schema);
    const [a] = await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => {
      const roto: ActionCtx = {
        ...ctx,
        vectorSearch: (async () => {
          throw new Error("índice vectorial caído");
        }) as ActionCtx["vectorSearch"],
      };
      return buscarHibrido(roto, "zorro", {}, 10);
    });

    expect(r.recuperacion).toBe("lexica");
    expect(r.fragmentos.map((f) => f._id)).toEqual([a]);
  });

  test("los dos lados caidos: error con lista vacia y sin lanzar", async () => {
    const t = convexTest(schema);
    await sembrar(t, TRES);
    vi.spyOn(gateway, "embed").mockRejectedValue(new Error("gateway caído"));
    const tel = new Telemetria();

    const r = await t.action((ctx) =>
      buscarHibrido(conQueryRota(ctx, "search/hybrid:lexica"), "zorro", {}, 10, tel),
    );

    expect(r).toEqual({ fragmentos: [], recuperacion: "error" });
    expect(tel.contadores.recuperacion_error).toBe(1);
  });

  test("si falla la carga de fragmentos no se inventa una lista parcial: error", async () => {
    const t = convexTest(schema);
    await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) =>
      buscarHibrido(conQueryRota(ctx, "search/hybrid:cargar"), "zorro", {}, 10),
    );

    expect(r).toEqual({ fragmentos: [], recuperacion: "error" });
  });

  test("una consulta en blanco no embebe nada y vuelve como error, no como ausencia", async () => {
    const t = convexTest(schema);
    await sembrar(t, TRES);
    const embed = embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => buscarHibrido(ctx, "   ", {}, 10));

    expect(r).toEqual({ fragmentos: [], recuperacion: "error" });
    expect(embed).not.toHaveBeenCalled();
  });

  test("topK recorta la lista fusionada", async () => {
    const t = convexTest(schema);
    const [a, b] = await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 2));

    expect(r.fragmentos.map((f) => f._id)).toEqual([a, b]);
  });
});

describe("filtros", () => {
  test("documentId acota los dos lados aunque el vector prefiera otro documento", async () => {
    const t = convexTest(schema);
    const [a, b] = await sembrar(t, [
      { texto: "zorro en el documento uno", pico: 0, documentId: "doc-1" },
      { texto: "texto del documento uno", pico: 1, documentId: "doc-1" },
      { texto: "zorro en el documento dos", pico: 2, documentId: "doc-2" },
    ]);
    // El vector prefiere claramente el fragmento del documento dos.
    embedFalso(() => vector({ 2: 5, 1: 2, 0: 1 }));

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", { documentId: "doc-1" }, 10));

    expect(r.recuperacion).toBe("hibrida");
    // A está en los dos lados (denso 2º, léxico 1º) y gana a B (denso 1º).
    expect(r.fragmentos.map((f) => f._id)).toEqual([a, b]);
    expect(r.fragmentos.every((f) => f.documentId === "doc-1")).toBe(true);
  });

  test("varios filtros se aplican como AND aunque la vectorial solo admita uno", async () => {
    const t = convexTest(schema);
    const [pdfEs] = await sembrar(t, [
      { texto: "zorro pdf español", pico: 0, documentType: "pdf", language: "es" },
      { texto: "zorro pdf inglés", pico: 1, documentType: "pdf", language: "en" },
      { texto: "zorro docx español", pico: 2, documentType: "docx", language: "es" },
    ]);
    // Adversarial: el vector prefiere justo los que deben quedar fuera, y los
    // tres llevan el término. Si el AND se perdiera, saldrían tres.
    embedFalso(() => vector({ 1: 3, 2: 2, 0: 1 }));

    const r = await t.action((ctx) =>
      buscarHibrido(ctx, "zorro", { documentType: "pdf", language: "es" }, 10),
    );

    expect(r.recuperacion).toBe("hibrida");
    expect(r.fragmentos.map((f) => f._id)).toEqual([pdfEs]);
  });

  test("documentType filtra por si solo", async () => {
    const t = convexTest(schema);
    const [, , docx] = await sembrar(t, [
      { texto: "zorro uno", pico: 0, documentType: "pdf" },
      { texto: "zorro dos", pico: 1, documentType: "pdf" },
      { texto: "zorro tres", pico: 2, documentType: "docx" },
    ]);
    embedFalso(() => vector({ 0: 3, 1: 2, 2: 1 }));

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", { documentType: "docx" }, 10));

    expect(r.fragmentos.map((f) => f._id)).toEqual([docx]);
  });

  test("con filtros que no casan con nada la lista queda vacia y NO se repite sin filtros aqui", async () => {
    const t = convexTest(schema);
    await sembrar(t, TRES);
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => buscarHibrido(ctx, "zorro", { language: "fr" }, 10));

    // Es el llamador quien decide repetir sin filtros y avisar al modelo.
    expect(r).toEqual({ fragmentos: [], recuperacion: "hibrida" });
    expect(hayFiltros({ language: "fr" })).toBe(true);
    expect(describirFiltros({ language: "fr", documentType: " pdf " })).toBe(
      "documentType='pdf', language='fr'",
    );
  });

  test("los filtros vacios o de espacios cuentan como ausentes", () => {
    expect(filtrosActivos({ language: "", documentType: "  ", documentId: " doc-1 " })).toEqual({
      documentId: "doc-1",
    });
    expect(hayFiltros({ language: " " })).toBe(false);
    expect(hayFiltros(undefined)).toBe(false);
    expect(describirFiltros({})).toBe("");
  });
});

describe("fusionarRrf", () => {
  const frag = (id: string, sourceFile: string, page: number): Fragmento => ({
    _id: id,
    text: id,
    sourceFile,
    page,
    chunkType: "text",
  });

  test("premia coincidir en las dos listas y desempata con orden total", () => {
    const x = frag("x", "b.pdf", 9);
    const y = frag("y", "a.pdf", 2);
    const z = frag("z", "a.pdf", 1);
    // x es 2º en las dos listas (2/62) y gana a cualquier primer puesto suelto
    // (1/61). y y z son 1º en una lista cada uno: empate exacto, y el
    // desempate es por (sourceFile, page, _id), no por el orden de llegada.
    expect(fusionarRrf([[y, x], [z, x]]).map((f) => f._id)).toEqual(["x", "z", "y"]);
    // Cambiar el orden de las listas (la otra búsqueda respondió antes) no
    // cambia nada.
    expect(fusionarRrf([[z, x], [y, x]]).map((f) => f._id)).toEqual(["x", "z", "y"]);
    // Y sin empate manda la suma RRF, no el documento: y (1º) antes que z (2º).
    expect(fusionarRrf([[y, z]]).map((f) => f._id)).toEqual(["y", "z"]);
  });

  test("a igual archivo desempata la pagina y despues el id", () => {
    const p9 = frag("k", "a.pdf", 9);
    const p2 = frag("q", "a.pdf", 2);
    expect(fusionarRrf([[p9], [p2]]).map((f) => f._id)).toEqual(["q", "k"]);
    const i1 = frag("id-1", "a.pdf", 2);
    const i2 = frag("id-2", "a.pdf", 2);
    expect(fusionarRrf([[i2], [i1]]).map((f) => f._id)).toEqual(["id-1", "id-2"]);
  });

  test("el score es la suma RRF y no toca el fragmento original", () => {
    const x = frag("x", "a.pdf", 1);
    const [fusionado] = fusionarRrf([[x], [x]]);
    expect(fusionado.score).toBeCloseTo(2 / 61, 12);
    expect(x.score).toBeUndefined();
    expect(fusionarRrf([])).toEqual([]);
  });
});

describe("determinismo", () => {
  test("un empate exacto de RRF sale en el mismo orden en dos ejecuciones y por (sourceFile, page, _id)", async () => {
    const t = convexTest(schema);
    // P se inserta antes (1º en el léxico del arnés) y es 2º en el denso;
    // Q es 1º en el denso y 2º en el léxico: 1/61 + 1/62 los dos. Sin el
    // desempate, ganaría Q, que entra primero en el mapa por venir del lado
    // denso; con él gana P porque "a.pdf" < "b.pdf".
    const [p, q] = await sembrar(t, [
      { texto: "zorro primero", pico: 0, sourceFile: "a.pdf", page: 5 },
      { texto: "zorro segundo", pico: 1, sourceFile: "b.pdf", page: 1 },
    ]);
    embedFalso(() => vector({ 1: 2, 0: 1 }));

    const primera = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 10));
    const segunda = await t.action((ctx) => buscarHibrido(ctx, "zorro", {}, 10));

    expect(primera.fragmentos.map((f) => f._id)).toEqual([p, q]);
    expect(segunda.fragmentos.map((f) => f._id)).toEqual([p, q]);
    // El empate es real: misma puntuación, no una casualidad del orden.
    expect(primera.fragmentos[0].score).toBe(primera.fragmentos[1].score);
  });
});

describe("robustez", () => {
  test("un id de la vectorial cuyo fragmento ya no existe se omite y los rangos se compactan", async () => {
    const t = convexTest(schema);
    const [a, b, c] = await sembrar(t, TRES);
    // Un fragmento que existió y se borró (reindexado entre la búsqueda y la
    // carga): la vectorial real podría devolverlo todavía.
    const borrado = await t.run(async (ctx) => {
      const doc = (await ctx.db.query("documents").first())!;
      const id = await ctx.db.insert("chunks", {
        text: "zorro fantasma",
        embedding: vector({ 3: 1 }),
        sourceFile: "z.pdf",
        page: 1,
        chunkType: "text",
        documentRef: doc._id,
      });
      await ctx.db.delete(id);
      return id;
    });
    embedFalso(() => CONSULTA_ZORRO);

    const r = await t.action((ctx) => {
      const conFantasma: ActionCtx = {
        ...ctx,
        vectorSearch: (async (...args: Parameters<ActionCtx["vectorSearch"]>) => {
          const reales = await ctx.vectorSearch(...args);
          return [{ _id: borrado, _score: 0.99 }, ...reales];
        }) as ActionCtx["vectorSearch"],
      };
      return buscarHibrido(conFantasma, "zorro", {}, 10);
    });

    // El fantasma iba 1º en el denso; sin compactar, B puntuaría como 2º
    // (1/62) y A como 3º (1/63) y los scores cambiarían. Deben ser los
    // mismos que sin fantasma.
    expect(r.fragmentos.map((f) => f._id)).toEqual([a, b, c]);
    expect(r.fragmentos[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(r.fragmentos[1].score).toBeCloseTo(1 / 61, 12);
  });

  test("mas de 64 candidatos se cargan por lotes y llegan todos", async () => {
    const t = convexTest(schema);
    const n = 70;
    const ids = await sembrar(
      t,
      Array.from({ length: n }, (_, i) => ({ texto: `fragmento numero ${i}`, pico: i })),
    );
    // Pesos decrecientes: el orden denso es el de inserción.
    const picos: Record<number, number> = {};
    for (let i = 0; i < n; i++) picos[i] = n - i;
    embedFalso(() => vector(picos));
    const cargas: number[] = [];

    const r = await t.action((ctx) => {
      const espia: ActionCtx = {
        ...ctx,
        runQuery: (async (ref: unknown, args: unknown) => {
          if (getFunctionName(ref as never) === "search/hybrid:cargar") {
            cargas.push((args as { ids: unknown[] }).ids.length);
          }
          return (ctx.runQuery as (r: unknown, a: unknown) => Promise<unknown>)(ref, args);
        }) as ActionCtx["runQuery"],
      };
      // Solo palabras vacías: lado denso puro, para que el orden sea el del vector.
      return buscarHibrido(espia, "¿qué es lo que hay de esto?", {}, n);
    });

    expect(r.recuperacion).toBe("densa");
    expect(r.fragmentos.map((f) => f._id)).toEqual(ids);
    expect(cargas).toEqual([64, 6]);
    expect(sinEmbedding(r.fragmentos)).toBe(true);
  });
});

describe("buscarHibridoVarias", () => {
  test("un solo lote de embeddings para todas las consultas distintas y un resultado por consulta", async () => {
    const t = convexTest(schema);
    const [a, b, c] = await sembrar(t, [
      { texto: "zorro rojo", pico: 0 },
      { texto: "castor gris", pico: 1 },
      { texto: "nutria parda", pico: 2 },
    ]);
    const embed = embedFalso((texto) => (texto === "castor" ? vector({ 1: 3, 2: 2, 0: 1 }) : vector({ 0: 3, 2: 2, 1: 1 })));
    const tel = new Telemetria();

    const rs = await t.action((ctx) =>
      buscarHibridoVarias(ctx, ["zorro", "zorro", "castor"], {}, 10, tel),
    );

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toEqual(["zorro", "castor"]); // sin repetir
    expect(rs).toHaveLength(3);
    expect(rs.map((r) => r.recuperacion)).toEqual(["hibrida", "hibrida", "hibrida"]);
    // "zorro": denso A, C, B; léxico A. "castor": denso B, C, A; léxico B.
    expect(rs[0].fragmentos.map((f) => f._id)).toEqual([a, c, b]);
    expect(rs[1].fragmentos.map((f) => f._id)).toEqual(rs[0].fragmentos.map((f) => f._id));
    expect(rs[2].fragmentos.map((f) => f._id)).toEqual([b, c, a]);
    expect(tel.rondas).toHaveLength(1);
    expect(tel.contadores.recuperacion_hibrida).toBe(3);
  });

  test("si el lote de embeddings falla, cada consulta se degrada a lexica y la vacia a error", async () => {
    const t = convexTest(schema);
    const [a, b] = await sembrar(t, [
      { texto: "zorro rojo", pico: 0 },
      { texto: "castor gris", pico: 1 },
    ]);
    vi.spyOn(gateway, "embed").mockRejectedValue(new Error("sin saldo"));

    const rs = await t.action((ctx) => buscarHibridoVarias(ctx, ["zorro", "", "castor"], {}, 10));

    expect(rs.map((r) => r.recuperacion)).toEqual(["lexica", "error", "lexica"]);
    expect(rs[0].fragmentos.map((f) => f._id)).toEqual([a]);
    expect(rs[1].fragmentos).toEqual([]);
    expect(rs[2].fragmentos.map((f) => f._id)).toEqual([b]);
  });

  test("sin consultas no hay llamadas", async () => {
    const t = convexTest(schema);
    const embed = embedFalso(() => CONSULTA_ZORRO);
    expect(await t.action((ctx) => buscarHibridoVarias(ctx, [], {}, 10))).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});
