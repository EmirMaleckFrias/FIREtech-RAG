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

/** El gateway parcheado: un vector por texto, sin red. */
function embedFalso() {
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

async function documentoConFichero(t: T, fileName: string, contenido: Uint8Array): Promise<Id<"documents">> {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([contenido]));
    return ctx.db.insert("documents", {
      fileName,
      sha256: "pendiente",
      pages: 0,
      chunks: 0,
      status: "processing",
      ingestadoEn: Date.now(),
      storageId,
    });
  });
}

async function chunksDe(t: T, documentId: Id<"documents">) {
  return t.run((ctx) =>
    ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect(),
  );
}

async function chunkAjeno(t: T, documentId: Id<"documents">, version: string, text: string) {
  return t.run((ctx) =>
    ctx.db.insert("chunks", {
      text,
      embedding: vectorFalso(0),
      sourceFile: "datos.csv",
      page: 1,
      chunkType: "table",
      documentRef: documentId,
      documentId: String(documentId),
      documentVersion: version,
    }),
  );
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

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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
    for (let desde = 0; desde < viejos; desde += 100) {
      await t.run(async (ctx) => {
        for (let i = desde; i < desde + 100; i++) {
          await ctx.db.insert("chunks", {
            text: `viejo ${i}`, embedding, sourceFile: "datos.csv", page: i, chunkType: "table",
            documentRef: documentId, documentId: String(documentId), documentVersion: "version-vieja",
          });
        }
      });
    }
    await chunkAjeno(t, documentId, sha256(bytes), "resto de una corrida que murió a medias");
    expect(await contarChunksDe(t, documentId)).toBe(viejos + 1);
    embedFalso();

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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
    let llamadas = 0;
    vi.spyOn(gateway, "embed").mockImplementation(async (textos) => {
      if (++llamadas > 1) throw new Error("gateway 429: " + "x".repeat(2000));
      return { vectores: textos.map((_, i) => vectorFalso(i)), usage: USO(textos.length), modelo: "m" };
    });

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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
    expect(telemetria.por_componente.embeddings.errores).toBe(1);
  });

  test("un fichero que no se puede parsear deja failed con el motivo y no llama al gateway", async () => {
    const t = convexTest(schema, modules);
    const documentId = await documentoConFichero(t, "presentacion.pptx", new TextEncoder().encode("x"));
    const embed = embedFalso();

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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

    await t.action(internal.ingesta.pipeline.ingestar, { documentId });

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
