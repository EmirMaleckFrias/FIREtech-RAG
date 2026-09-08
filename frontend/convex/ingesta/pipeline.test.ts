// @vitest-environment node
/// <reference types="vite/client" />
// La acción de ingesta con `convex-test`: base en memoria, fichero en el
// almacenamiento, y el gateway parcheado con `vi.spyOn` sobre el módulo (nunca
// se llama al gateway real). Entorno Node porque la acción es "use node".
import { createHash } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { PaginationResult } from "convex/server";
import * as gateway from "../lib/gateway";
import schema from "../schema";
import { TAMANO_GRUPO, VERSION_INDICE } from "./contexto";
import { PERDIO_EL_DOCUMENTO } from "./escritura";
import { LOTE_EMBEDDINGS, MAX_ERROR_CHARS } from "./lotes";
import { escribirPdf } from "./pdfFalso.test-util";

// Patrón ABSOLUTO desde la raíz del proyecto: con uno relativo ("../**"),
// Vite devuelve "./pipeline.ts" para los ficheros de este mismo directorio y
// convex-test, que deduce el prefijo de la ruta de "_generated", no los
// encuentra ("Could not find module for: ingesta/pipeline").
const modules = import.meta.glob("/convex/**/*.*s");

type T = TestConvex<typeof schema>;

function vectorFalso(i: number): number[] {
  const v = new Array<number>(3072).fill(0);
  v[i % 3072] = 1;
  return v;
}

const USO = (n: number) => ({ prompt: n * 10, cached: 0, completion: 0, reasoning: 0 });

/** El contexto por fragmento, parcheado: una frase por índice, para
 *  cualquier tamaño de grupo (los índices de más se ignoran). */
function contextoFalso(texto = "contexto de prueba") {
  return vi.spyOn(gateway, "completionJson").mockImplementation(async () => ({
    datos: { contextos: Array.from({ length: TAMANO_GRUPO }, (_, i) => ({ i, contexto: `${texto} ${i}` })) },
    usage: { prompt: 50, cached: 0, completion: 30, reasoning: 0 },
    modelo: "openai/gpt-5.4-mini",
    finishReason: "stop",
    razonamientoRechazado: false,
  }));
}

/** El gateway parcheado: un vector por texto y un contexto por fragmento,
 *  sin red. La ingesta contextualiza antes de embeber, así que las dos
 *  llamadas van juntas en casi todos los casos. */
function embedFalso() {
  contextoFalso();
  return vi.spyOn(gateway, "embed").mockImplementation(async (textos) => ({
    vectores: textos.map((_, i) => vectorFalso(i)),
    usage: USO(textos.length),
    modelo: "openai/text-embedding-3-large",
  }));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function csvGrande(n: number): Uint8Array {
  const filas = ["id;grupo;valor"];
  for (let i = 1; i <= n; i++) filas.push(`${i};grupo${i % 3};${i * 1.5}`);
  return new TextEncoder().encode(filas.join("\n"));
}

/** Un documento en el corpus de una cuenta recién creada. El propietario lo
 *  copian los fragmentos al insertarse (ingesta/escritura.ts), así que la
 *  ingesta no lo recibe por argumento: sale del documento. */
async function documentoConFichero(t: T, fileName: string, contenido: Uint8Array): Promise<Id<"documents">> {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([contenido]));
    const propietario = await ctx.db.insert("users", {
      email: `duena-${fileName}@airobotix.net`,
      rol: "lector",
      bloqueado: false,
      creadoEn: 1,
      ultimoAccesoEn: 1,
    });
    return ctx.db.insert("documents", {
      fileName,
      sha256: "pendiente",
      pages: 0,
      chunks: 0,
      status: "processing",
      propietario,
      ingestadoEn: Date.now(),
      storageId,
    });
  });
}

/** Ingesta completa: la acción que lee y encola, y las encadenadas que
 *  embeben hasta vaciar la cola. */
async function ingerir(t: T, documentId: Id<"documents">) {
  await t.action(internal.ingesta.pipeline.ingestar, { documentId });
  await t.finishAllScheduledFunctions(() => {}, 200);
}

async function pendientesDe(t: T) {
  return t.run((ctx) => ctx.db.query("fragmentosPendientes").collect());
}

async function chunksDe(t: T, documentId: Id<"documents">) {
  return t.run((ctx) =>
    ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect(),
  );
}

async function chunkAjeno(t: T, documentId: Id<"documents">, version: string, text: string) {
  return t.run(async (ctx) => {
    const doc = (await ctx.db.get(documentId))!;
    return ctx.db.insert("chunks", {
      text,
      embedding: vectorFalso(0),
      sourceFile: "datos.csv",
      page: 1,
      chunkType: "table",
      documentRef: documentId,
      documentId: String(documentId),
      documentVersion: version,
      propietario: doc.propietario,
    });
  });
}

/** Cuenta paginando: bajo los límites reales un `collect` de 1500 fragmentos
 *  de 25 KB reventaría la transacción, igual que el borrado sin lotes. */
async function contarChunksDe(t: T, documentId: Id<"documents">): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const cursorActual: string | null = cursor;
    const pagina: PaginationResult<Doc<"chunks">> = await t.run(async (ctx) =>
      ctx.db
        .query("chunks")
        .withIndex("porDocumento", (q) => q.eq("documentRef", documentId))
        .paginate({ cursor: cursorActual, numItems: 200 }),
    );
    total += pagina.page.length;
    if (pagina.isDone) return total;
    cursor = pagina.continueCursor;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestar", () => {
  test("embebe en lotes de 96, escribe los chunks y deja el documento listo", async () => {
    const t = convexTest(schema, modules);
    const bytes = csvGrande(250);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    const embed = embedFalso();

    await ingerir(t, documentId);

    // Tres peticiones al gateway, ninguna por encima del lote.
    const tamanos = embed.mock.calls.map(([textos]) => textos.length);
    expect(tamanos).toEqual([LOTE_EMBEDDINGS, LOTE_EMBEDDINGS, 250 - 2 * LOTE_EMBEDDINGS]);

    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(250);
    const version = sha256(bytes);
    expect(chunks.every((c) => c.documentVersion === version)).toBe(true);
    expect(chunks.every((c) => c.sourceFile === "datos.csv" && c.documentId === String(documentId))).toBe(true);
    expect(chunks.every((c) => c.embedding.length === 3072 && c.chunkType === "table")).toBe(true);
    expect(chunks.every((c) => c.documentType === "csv")).toBe(true);
    expect(chunks.find((c) => c.page === 251)?.text).toBe("id: 250\ngrupo: grupo1\nvalor: 375");

    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.error).toBeUndefined();
    expect(doc?.pages).toBe(250);
    expect(doc?.chunks).toBe(250);
    expect(doc?.sha256).toBe(version);
    expect(doc?.documentType).toBe("csv");

    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].terminadoEn).toBeDefined();
    const stats = runs[0].stats as Record<string, unknown>;
    expect(stats.pages).toBe(250);
    expect(stats.chunks).toBe(250);
    expect(stats.tokens_embedding).toBe(2500);
    expect(typeof stats.ms).toBe("number");
    const telemetria = stats.telemetria as { por_componente: Record<string, { rondas: number }> };
    expect(telemetria.por_componente.embeddings.rondas).toBe(3);
  });

  test("retira la versión anterior y los restos de una corrida muerta, pero solo tras escribir la nueva", async () => {
    const t = convexTest(schema, modules);
    const bytes = csvGrande(5);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    await chunkAjeno(t, documentId, "version-vieja", "de la versión anterior");
    await chunkAjeno(t, documentId, sha256(bytes), "resto de una corrida que murió a medias");
    // Otro documento no se toca.
    const otro = await documentoConFichero(t, "otro.csv", csvGrande(2));
    await chunkAjeno(t, otro, "v", "de otro documento");
    embedFalso();

    await ingerir(t, documentId);

    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(5);
    expect(chunks.some((c) => c.text.includes("versión anterior"))).toBe(false);
    expect(chunks.some((c) => c.text.includes("murió a medias"))).toBe(false);
    expect(await chunksDe(t, otro)).toHaveLength(1);
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect((runs[0].stats as Record<string, unknown>).chunks_retirados).toBe(2);
  });

  test("con los límites reales de transacción, retirar la versión vieja no lee la versión nueva", async () => {
    // Con `transactionLimits` convex-test impone los límites de una
    // transacción de Convex (16 MiB leídos, 32 000 documentos...) sobre lo
    // que las mutaciones LEEN y ESCRIBEN: los lotes de inserción (32
    // fragmentos de 3072 números) y los de borrado (100) tienen que caber.
    //
    // Lo que este test NO puede probar, y se dice para que nadie lo crea: un
    // borrado que filtrase por versión sobre el índice del documento leería
    // también los 800 fragmentos NUEVOS (~20 MB) para descartarlos, y en
    // Convex "data not returned due to a filter counts as scanned"
    // (docs.convex.dev/production/state/limits), o sea que reventaría el tope
    // de 16 MiB. Medido el 4 sep 2026: convex-test solo contabiliza los
    // documentos que el stream devuelve, así que con ese filtro este test
    // pasa igual. La garantía está en `borrarChunks`, que acota por
    // `_creationTime` en el rango del índice y no lee la versión nueva.
    const t = convexTest({ schema, modules, transactionLimits: true });
    const bytes = csvGrande(800);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    const embedding = Array.from({ length: 3072 }, (_, i) => i / 3072);
    const viejos = 200;
    const propietario = await t.run(async (ctx) => (await ctx.db.get(documentId))!.propietario);
    for (let desde = 0; desde < viejos; desde += 100) {
      await t.run(async (ctx) => {
        for (let i = desde; i < desde + 100; i++) {
          await ctx.db.insert("chunks", {
            text: `viejo ${i}`, embedding, sourceFile: "datos.csv", page: i, chunkType: "table",
            documentRef: documentId, documentId: String(documentId), documentVersion: "version-vieja",
            propietario,
          });
        }
      });
    }
    await chunkAjeno(t, documentId, sha256(bytes), "resto de una corrida que murió a medias");
    expect(await contarChunksDe(t, documentId)).toBe(viejos + 1);
    embedFalso();

    await ingerir(t, documentId);

    expect(await contarChunksDe(t, documentId)).toBe(800);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect(runs[0].status).toBe("completed");
    expect((runs[0].stats as Record<string, unknown>).chunks_retirados).toBe(viejos + 1);
  });

  test("si el gateway falla el documento queda en failed, sin chunks nuevos y con la versión vieja intacta", async () => {
    const t = convexTest(schema, modules);
    const bytes = csvGrande(250);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    await chunkAjeno(t, documentId, "version-vieja", "de la versión anterior");
    // El primer lote entra y el segundo falla: lo escrito por esta corrida
    // tiene que desaparecer, y el error largo se recorta.
    contextoFalso();
    let llamadas = 0;
    vi.spyOn(gateway, "embed").mockImplementation(async (textos) => {
      if (++llamadas > 1) throw new Error("gateway 429: " + "x".repeat(2000));
      return { vectores: textos.map((_, i) => vectorFalso(i)), usage: USO(textos.length), modelo: "m" };
    });

    await ingerir(t, documentId);

    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].documentVersion).toBe("version-vieja");
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("failed");
    expect(doc?.error?.startsWith("gateway 429: ")).toBe(true);
    expect(doc?.error?.length).toBe(MAX_ERROR_CHARS);
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error?.length).toBe(MAX_ERROR_CHARS);
    const telemetria = (runs[0].stats as { telemetria: { por_componente: Record<string, { errores: number }> } }).telemetria;
    // Los lotes van de tres en tres: el primero entró y los otros dos del
    // grupo fallaron a la vez, así que son dos errores, no uno.
    expect(telemetria.por_componente.embeddings.errores).toBe(2);
  });

  test("un fichero que no se puede parsear deja failed con el motivo y no llama al gateway", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "presentacion.pptx", new TextEncoder().encode("x"));
    const embed = embedFalso();

    await ingerir(t, documentId);

    expect(embed).not.toHaveBeenCalled();
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("failed");
    expect(doc?.error).toContain("Extensión no soportada");
    expect(await chunksDe(t, documentId)).toHaveLength(0);
  });

  test("un documento borrado antes de procesarse no deja nada y la corrida queda fallida", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "datos.csv", csvGrande(3));
    await t.run((ctx) => ctx.db.delete(documentId));
    const embed = embedFalso();

    await ingerir(t, documentId);

    expect(embed).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("chunks").collect())).toHaveLength(0);
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toContain("ya no existe");
  });

  test("un artículo en PDF deja título, cita, DOI e idioma en el documento", async () => {
    const t = convexTest(schema, modules);
    const pdf = escribirPdf([[
      ["Cerebrospinal fluid biomarkers in early Alzheimer disease", 17],
      ["Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11],
      ["doi:10.3233/JAD-220123  J Alzheimers Dis 2023", 8],
      ["Abstract", 12],
      ["Amyloid beta 42 decreases in the earliest stages of the disease, while total tau", 10],
      ["and phosphorylated tau increase progressively over time in the patients who were", 10],
      ["followed during the study at the three participating centres of this work.", 10],
    ]]);
    const documentId = await documentoConFichero(t, "biomarkers.pdf", pdf);
    embedFalso();

    await ingerir(t, documentId);

    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.pages).toBe(1);
    expect(doc?.titulo).toBe("Cerebrospinal fluid biomarkers in early Alzheimer disease");
    expect(doc?.citation).toBe("Allegri et al., 2023");
    expect(doc?.doi).toBe("10.3233/JAD-220123");
    expect(doc?.language).toBe("en");
    expect(doc?.documentType).toBe("pdf");
    const chunks = await chunksDe(t, documentId);
    expect(chunks.every((c) => c.citation === "Allegri et al., 2023" && c.language === "en")).toBe(true);
    // La línea de autores (11 pt sobre un cuerpo de 10) cuenta como encabezado
    // por formato, igual que en el Python, y la del DOI forma su propio chunk:
    // lo que importa es que el resumen sabe de qué sección sale.
    expect(chunks.find((c) => c.text.includes("Amyloid beta 42"))?.section).toBe("Abstract");
  });
});

describe("ingestar: dos corridas sobre el mismo documento", () => {
  test("ADVERSARIAL: la más reciente gana, la vieja se retira sin tocar nada y no queda ningún fragmento duplicado", async () => {
    const t = convexTest(schema, modules);
    const bytes = csvGrande(5);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    // En cuanto la PRIMERA corrida pide embeddings (ya tiene sus fragmentos en
    // la cola), arranca una segunda ingesta del mismo documento y se deja
    // terminar entera (su lectura y su embebido). Es el reindexado que entra
    // a la vez que una ingesta en marcha.
    let segundaLanzada = false;
    contextoFalso();
    vi.spyOn(gateway, "embed").mockImplementation(async (textos) => {
      if (!segundaLanzada) {
        segundaLanzada = true;
        await t.action(internal.ingesta.pipeline.ingestar, { documentId });
        // La segunda dejó agendado su embebido: se corre aquí mismo y se
        // retira de la cola de agendados para que no corra dos veces.
        const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
        const doc = await t.run((ctx) => ctx.db.get(documentId));
        const suyo = trabajos.find((j) => j.name.includes("embeber") && (j.args[0] as { runId: string }).runId === doc?.ingestaRunId && j.state.kind === "pending");
        if (!suyo) throw new Error("la segunda corrida no agendó su embebido");
        await t.run((ctx) => ctx.scheduler.cancel(suyo._id));
        await t.action(internal.ingesta.pipeline.embeber, suyo.args[0] as never);
      }
      return {
        vectores: textos.map((_, i) => vectorFalso(i)),
        usage: USO(textos.length),
        modelo: "openai/text-embedding-3-large",
      };
    });

    await ingerir(t, documentId);

    // Un solo juego de fragmentos: el de la corrida que ganó.
    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(5);
    expect(new Set(chunks.map((c) => c.text)).size).toBe(5);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.chunks).toBe(5);
    // Dos corridas: la segunda completa, la primera retirada con el motivo. Y
    // el documento se queda con la ganadora, no sin dueña. La cola, vacía.
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").order("asc").collect());
    expect(runs.map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(runs[0].error).toContain(PERDIO_EL_DOCUMENTO);
    expect(doc?.ingestaRunId).toBe(runs[1]._id);
    expect(runs.every((r) => r.documentId === documentId)).toBe(true);
    expect(await pendientesDe(t)).toEqual([]);
  });

  test("una corrida que ya no es la dueña no puede escribir, borrar ni cambiar el estado del documento", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "datos.csv", csvGrande(2));
    const r1 = await t.mutation(internal.ingesta.escritura.abrirRun, { documentId });
    await t.mutation(internal.ingesta.escritura.reclamarDocumento, { documentId, runId: r1.runId });
    const r2 = await t.mutation(internal.ingesta.escritura.abrirRun, { documentId });
    await t.mutation(internal.ingesta.escritura.reclamarDocumento, { documentId, runId: r2.runId });

    const entrada = {
      text: "x", embedding: vectorFalso(0), page: 1, sourcePages: [1], chunkType: "table" as const,
      documentType: "csv",
    };
    await expect(
      t.mutation(internal.ingesta.escritura.insertarChunks, { documentId, version: "v", runId: r1.runId, chunks: [entrada] }),
    ).rejects.toThrow(PERDIO_EL_DOCUMENTO);
    await expect(
      t.mutation(internal.ingesta.escritura.borrarChunks, { documentId, version: "v", desde: 0, modo: "deEstaCorrida", lote: 10, runId: r1.runId }),
    ).rejects.toThrow(PERDIO_EL_DOCUMENTO);
    expect(await t.mutation(internal.ingesta.escritura.marcarFallido, { documentId, error: "x", runId: r1.runId })).toBe(false);
    await expect(
      t.mutation(internal.ingesta.escritura.marcarListo, { documentId, sha256: "s", pages: 1, chunks: 1, runId: r1.runId }),
    ).rejects.toThrow(PERDIO_EL_DOCUMENTO);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("processing");
    expect(doc?.ingestaRunId).toBe(r2.runId);
    // La dueña sí puede, y el documento se queda con ella (ADVERSARIAL: si lo
    // soltara, la corrida vieja que despertase después lo encontraría libre).
    expect(await t.mutation(internal.ingesta.escritura.marcarListo, { documentId, sha256: "s", pages: 1, chunks: 1, runId: r2.runId })).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(documentId)))?.ingestaRunId).toBe(r2.runId);
    await expect(
      t.mutation(internal.ingesta.escritura.insertarChunks, { documentId, version: "v", runId: r1.runId, chunks: [entrada] }),
    ).rejects.toThrow(PERDIO_EL_DOCUMENTO);
  });
});

describe("ingestar: sin tope de tamaño, con avance visible", () => {
  test("el avance se escribe en el documento mientras se embebe, y se limpia al terminar", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "datos.csv", csvGrande(250));
    const vistos: Array<{ fase: string; hecho: number; total: number }> = [];
    contextoFalso();
    vi.spyOn(gateway, "embed").mockImplementation(async (textos) => {
      const doc = await t.run((ctx) => ctx.db.get(documentId));
      if (doc?.progreso) vistos.push({ fase: doc.progreso.fase, hecho: doc.progreso.hecho, total: doc.progreso.total });
      return { vectores: textos.map((_, i) => vectorFalso(i)), usage: USO(textos.length), modelo: "m" };
    });
    await ingerir(t, documentId);
    // Al empezar a embeber: fase embebiendo, 0 de 250. La cola de 250 se
    // embebe en un solo grupo de tres lotes, así que las tres llamadas ven
    // el mismo avance.
    expect(vistos[0]).toEqual({ fase: "embebiendo", hecho: 0, total: 250 });
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.progreso).toBeUndefined();
    expect(await pendientesDe(t)).toEqual([]);
  });

  test("ADVERSARIAL: cuando una acción agota su tiempo, la siguiente sigue desde el cursor y nada se pierde ni se repite", async () => {
    const { configurarTiempoPorAccion } = await import("./pipeline");
    configurarTiempoPorAccion(0); // cada acción hace un grupo y pasa el relevo
    try {
      const t = convexTest(schema, modules);
      const n = LOTE_EMBEDDINGS * 3 * 2 + 17; // tres grupos: dos llenos y uno corto
      const bytes = csvGrande(n);
      const documentId = await documentoConFichero(t, "datos.csv", bytes);
      embedFalso();
      await ingerir(t, documentId);
      const chunks = await chunksDe(t, documentId);
      expect(chunks).toHaveLength(n);
      expect(new Set(chunks.map((c) => c.page)).size).toBe(n);
      const doc = await t.run((ctx) => ctx.db.get(documentId));
      expect(doc?.status).toBe("ready");
      expect(doc?.chunks).toBe(n);
      expect(await pendientesDe(t)).toEqual([]);
      const [run] = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
      expect(run.status).toBe("completed");
      const stats = run.stats as Record<string, unknown>;
      expect(stats.relevos_embebido).toBe(2);
      expect(stats.tokens_embedding).toBe(n * 10);
      expect(stats.pages).toBe(n);
    } finally {
      configurarTiempoPorAccion(5 * 60_000);
    }
  });

  test("un fallo del gateway a mitad de la cadena vacía la cola y deja el documento en failed", async () => {
    const { configurarTiempoPorAccion } = await import("./pipeline");
    configurarTiempoPorAccion(0);
    try {
      const t = convexTest(schema, modules);
      const documentId = await documentoConFichero(t, "datos.csv", csvGrande(LOTE_EMBEDDINGS * 3 * 2));
      let llamadas = 0;
      contextoFalso();
      vi.spyOn(gateway, "embed").mockImplementation(async (textos) => {
        // El segundo grupo (segunda acción) falla.
        if (++llamadas > 3) throw new Error("gateway caído");
        return { vectores: textos.map((_, i) => vectorFalso(i)), usage: USO(textos.length), modelo: "m" };
      });
      await ingerir(t, documentId);
      const doc = await t.run((ctx) => ctx.db.get(documentId));
      expect(doc?.status).toBe("failed");
      expect(doc?.error).toBe("gateway caído");
      expect(doc?.progreso).toBeUndefined();
      // Lo que el primer grupo escribió se retiró: nada a medias.
      expect(await chunksDe(t, documentId)).toEqual([]);
      expect(await pendientesDe(t)).toEqual([]);
    } finally {
      configurarTiempoPorAccion(5 * 60_000);
    }
  });
});

describe("ingestar: aislamiento y avisos", () => {
  test("cada fragmento escrito lleva el propietario del documento (la frontera del corpus)", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "propios.csv", csvGrande(30));
    embedFalso();
    await ingerir(t, documentId);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    const chunks = await t.run((ctx) =>
      ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect(),
    );
    expect(chunks.length).toBe(30);
    expect(chunks.every((c) => c.propietario === doc?.propietario)).toBe(true);
    // Y tras reindexar, igual.
    await ingerir(t, documentId);
    const otraVez = await t.run((ctx) =>
      ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect(),
    );
    expect(otraVez.length).toBe(30);
    expect(otraVez.every((c) => c.propietario === doc?.propietario)).toBe(true);
  });

  test("ADVERSARIAL: un Word con una imagen cuyo OCR se corta queda LISTO con aviso, sin fila envenenada en la caché", async () => {
    const { escribirDocx } = await import("./docxFalso.test-util");
    const JSZip = (await import("jszip")).default;
    const base = await escribirDocx([{ tipo: "p", texto: "Párrafo normal del documento con texto suficiente." }]);
    const zip = await JSZip.loadAsync(base);
    zip.file("word/media/image1.png", new Uint8Array(4096).fill(7));
    const docx = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "informe.docx", docx);
    embedFalso();
    vi.stubEnv("ENABLE_OCR", "true");
    vi.spyOn(gateway, "crearCompletion").mockResolvedValue({
      datos: { choices: [{ message: { content: "| Dosis |" }, finish_reason: "length" }], usage: {} },
      razonamientoRechazado: false,
    });
    try {
      await ingerir(t, documentId);
    } finally {
      vi.unstubAllEnvs();
    }
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.avisos).toMatchObject({ sinLeer: 1, omitidas: 0, recortados: 0 });
    expect(doc?.avisos?.motivo).toMatch(/se cortó/);
    expect(await t.run((ctx) => ctx.db.query("ocrCache").collect())).toEqual([]);
    const runs = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect((runs[0].stats as { avisos?: unknown }).avisos).toMatchObject({ sinLeer: 1 });
  });

  test("una guía sin autores ni DOI queda SIN cita: se cita por el nombre del fichero, no por un autor inventado", async () => {
    const t = convexTest(schema, modules);
    const pdf = escribirPdf([[
      ["Guia de manejo de la hipertension arterial en atencion primaria", 17],
      ["Global Outcomes", 11],
      ["Documento de consenso, edicion 2025.", 9],
      ["Introduccion", 12],
      ["La hipertension arterial es el principal factor de riesgo cardiovascular modificable", 10],
      ["y su control reduce la incidencia de ictus y de insuficiencia cardiaca en la poblacion.", 10],
    ]]);
    const documentId = await documentoConFichero(t, "guia-hta.pdf", pdf);
    embedFalso();
    await ingerir(t, documentId);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.citation).toBeUndefined();
    const chunks = await t.run((ctx) =>
      ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect(),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.citation === undefined)).toBe(true);
    expect(chunks.every((c) => c.sourceFile === "guia-hta.pdf")).toBe(true);
  });
});

describe("ingestar: recuperación contextual", () => {
  test("cada fragmento se embebe con su contexto delante y lo guarda aparte; el documento queda en la versión del índice", async () => {
    const t = convexTest(schema, modules);
    const bytes = csvGrande(30);
    const documentId = await documentoConFichero(t, "datos.csv", bytes);
    const embed = embedFalso();
    const contexto = vi.spyOn(gateway, "completionJson");

    await ingerir(t, documentId);

    // 30 fragmentos: tres grupos de contexto (12 + 12 + 6), un lote de embeddings.
    expect(contexto).toHaveBeenCalledTimes(3);
    const mensajes = contexto.mock.calls.map((c) => (c[0].messages as Array<{ content: string }>)[1].content);
    expect(mensajes[0]).toContain("Documento: datos.csv");
    expect(mensajes[0]).toContain("índices 0 a 11");
    expect(mensajes[2]).toContain("índices 0 a 5");
    // Lo que se embebe lleva el contexto y después el texto; lo que se guarda
    // los separa: `text` es lo que se cita y se verifica.
    const textos = embed.mock.calls[0][0];
    expect(textos[0].startsWith("contexto de prueba 0\n\nid: 1\n")).toBe(true);
    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(30);
    expect(chunks.every((c) => typeof c.contexto === "string" && c.contexto.startsWith("contexto de prueba"))).toBe(true);
    expect(chunks.every((c) => !c.text.includes("contexto de prueba"))).toBe(true);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.indiceVersion).toBe(VERSION_INDICE);
    expect(doc?.avisos).toBeUndefined();
    const [run] = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect((run.stats as Record<string, unknown>).contextos_fallidos).toBe(0);
    const telemetria = (run.stats as { telemetria: { por_componente: Record<string, { rondas: number }> } }).telemetria;
    expect(telemetria.por_componente.contexto.rondas).toBe(3);
  });

  test("ADVERSARIAL: si el modelo de contexto falla, el documento queda LISTO sin contexto y con el aviso, no en failed", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "datos.csv", csvGrande(20));
    embedFalso();
    let llamada = 0;
    vi.spyOn(gateway, "completionJson").mockImplementation(async () => {
      // El primer grupo (12) falla; el segundo (8) responde.
      if (++llamada === 1) throw new Error("gateway 503");
      return {
        datos: { contextos: Array.from({ length: 8 }, (_, i) => ({ i, contexto: `ok ${i}` })) },
        usage: { prompt: 1, cached: 0, completion: 1, reasoning: 0 },
        modelo: "m",
        finishReason: "stop",
        razonamientoRechazado: false,
      };
    });

    await ingerir(t, documentId);

    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.avisos).toEqual({ sinLeer: 0, omitidas: 0, recortados: 0, sinContexto: 12 });
    expect(doc?.indiceVersion).toBe(VERSION_INDICE);
    const chunks = await chunksDe(t, documentId);
    expect(chunks).toHaveLength(20);
    // Sin contexto se escribe "" (la fila tiene que estar en su índice); al
    // leerla, `aFragmento` lo convierte en ausencia.
    expect(chunks.filter((c) => !c.contexto)).toHaveLength(12);
    expect(chunks.filter((c) => c.contexto?.startsWith("ok "))).toHaveLength(8);
    const [run] = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
    expect(run.status).toBe("completed");
    expect((run.stats as Record<string, unknown>).contextos_fallidos).toBe(12);
  });

  test("ADVERSARIAL: los fragmentos sin contexto se acumulan entre relevos y el aviso los suma todos", async () => {
    const { configurarTiempoPorAccion } = await import("./pipeline");
    configurarTiempoPorAccion(0); // cada acción hace un grupo y pasa el relevo
    try {
      const t = convexTest(schema, modules);
      const n = LOTE_EMBEDDINGS * 3 * 2; // dos grupos de embebido, dos acciones
      const documentId = await documentoConFichero(t, "datos.csv", csvGrande(n));
      embedFalso();
      // Ningún grupo de contexto responde: todos los fragmentos van sin él.
      vi.spyOn(gateway, "completionJson").mockRejectedValue(new Error("sin saldo"));
      await ingerir(t, documentId);
      const doc = await t.run((ctx) => ctx.db.get(documentId));
      expect(doc?.status).toBe("ready");
      expect(doc?.avisos?.sinContexto).toBe(n);
      const [run] = await t.run((ctx) => ctx.db.query("ingestionRuns").collect());
      // Dos grupos llenos: cada uno pasa el relevo (el segundo no sabe que
      // era el último hasta que la tercera acción encuentra la cola vacía).
      expect((run.stats as Record<string, unknown>).relevos_embebido).toBe(2);
      expect((run.stats as Record<string, unknown>).contextos_fallidos).toBe(n);
    } finally {
      configurarTiempoPorAccion(5 * 60_000);
    }
  });

  test("con ENABLE_CHUNK_CONTEXT=false no se llama al modelo y se embebe el texto tal cual", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "datos.csv", csvGrande(5));
    const embed = embedFalso();
    const contexto = vi.spyOn(gateway, "completionJson");
    vi.stubEnv("ENABLE_CHUNK_CONTEXT", "false");
    try {
      await ingerir(t, documentId);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(contexto).not.toHaveBeenCalled();
    expect(embed.mock.calls[0][0][0].startsWith("id: 1\n")).toBe(true);
    const chunks = await chunksDe(t, documentId);
    expect(chunks.every((c) => c.contexto === "")).toBe(true);
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.status).toBe("ready");
    expect(doc?.avisos).toBeUndefined();
    // Con el contexto apagado la receta es OTRA: al encenderlo, la migración
    // los reindexa; apagado, no los da por pendientes.
    expect(doc?.indiceVersion).toBe(`${VERSION_INDICE}-sin-contexto`);
  });
});

describe("ingestar: el contexto entre relevos", () => {
  test("ADVERSARIAL: la primera acción sin contexto y la segunda con él: el aviso cuenta solo los del primer grupo", async () => {
    const { configurarTiempoPorAccion } = await import("./pipeline");
    configurarTiempoPorAccion(0);
    try {
      const t = convexTest(schema, modules);
      const n = LOTE_EMBEDDINGS * 3 * 2; // dos grupos, dos acciones
      const documentId = await documentoConFichero(t, "datos.csv", csvGrande(n));
      embedFalso();
      let llamada = 0;
      vi.spyOn(gateway, "completionJson").mockImplementation(async () => {
        // Los 24 grupos de contexto de la primera acción fallan; los de la segunda responden.
        if (++llamada <= 24) throw new Error("gateway 503");
        return {
          datos: { contextos: Array.from({ length: TAMANO_GRUPO }, (_, i) => ({ i, contexto: `ok ${i}` })) },
          usage: { prompt: 1, cached: 0, completion: 1, reasoning: 0 },
          modelo: "m", finishReason: "stop", razonamientoRechazado: false,
        };
      });
      await ingerir(t, documentId);
      const doc = await t.run((ctx) => ctx.db.get(documentId));
      expect(doc?.status).toBe("ready");
      expect(doc?.avisos?.sinContexto).toBe(LOTE_EMBEDDINGS * 3);
      const chunks = await chunksDe(t, documentId);
      expect(chunks.filter((c) => !c.contexto)).toHaveLength(LOTE_EMBEDDINGS * 3);
      expect(chunks.filter((c) => c.contexto?.startsWith("ok "))).toHaveLength(LOTE_EMBEDDINGS * 3);
    } finally {
      configurarTiempoPorAccion(5 * 60_000);
    }
  });
});
