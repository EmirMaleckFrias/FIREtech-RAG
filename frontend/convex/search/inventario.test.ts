// El inventario sale de `documents`, en memoria con convex-test, sin red.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

describe("inventario", () => {
  test("cuenta solo los documentos listos y omite los idiomas sin detectar", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("documents", {
        fileName: "folleto.pdf",
        sha256: "2",
        pages: 2,
        chunks: 2,
        status: "ready",
        ingestadoEn: 2,
        documentType: "pdf",
        // Sin `language`: no debe aparecer como idioma "" ni como nada.
      });
      await ctx.db.insert("documents", {
        fileName: "estudio_cohorte.pdf",
        sha256: "1",
        pages: 10,
        chunks: 6,
        status: "ready",
        ingestadoEn: 1,
        documentType: "pdf",
        language: "es",
      });
      // Adversarial: un documento fallido con idioma y tipo detectados. Si
      // contara, "hay 3 documentos" hablaría de un índice que responde por 2.
      await ctx.db.insert("documents", {
        fileName: "roto.docx",
        sha256: "3",
        pages: 0,
        chunks: 5,
        status: "failed",
        error: "no se pudo parsear",
        ingestadoEn: 3,
        documentType: "docx",
        language: "en",
      });
      await ctx.db.insert("documents", {
        fileName: "subiendo.pdf",
        sha256: "4",
        pages: 0,
        chunks: 0,
        status: "processing",
        ingestadoEn: 4,
      });
    });

    const inv = await t.query(internal.search.inventario.inventario, {});

    // La misma forma que consumía `_execute_inventory` en Python.
    expect(inv).toEqual({
      archivos: [
        { valor: "estudio_cohorte.pdf", chunks: 6 },
        { valor: "folleto.pdf", chunks: 2 },
      ],
      total_chunks: 8,
      tipos: [{ valor: "pdf", chunks: 8 }],
      idiomas: [{ valor: "es", chunks: 6 }],
    });
  });

  test("un indice vacio devuelve ceros y listas vacias, no lanza", async () => {
    const t = convexTest(schema);
    expect(await t.query(internal.search.inventario.inventario, {})).toEqual({
      archivos: [],
      total_chunks: 0,
      tipos: [],
      idiomas: [],
    });
  });

  test("tipos e idiomas van de mas a menos fragmentos y a igualdad por valor", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const base = { sha256: "x", pages: 1, status: "ready" as const, ingestadoEn: 1 };
      await ctx.db.insert("documents", { ...base, fileName: "a.docx", chunks: 3, documentType: "docx", language: "en" });
      await ctx.db.insert("documents", { ...base, fileName: "b.pdf", chunks: 3, documentType: "pdf", language: "es" });
      await ctx.db.insert("documents", { ...base, fileName: "c.pdf", chunks: 4, documentType: "pdf", language: "en" });
    });
    const inv = await t.query(internal.search.inventario.inventario, {});
    expect(inv.tipos).toEqual([
      { valor: "pdf", chunks: 7 },
      { valor: "docx", chunks: 3 },
    ]);
    expect(inv.idiomas).toEqual([
      { valor: "en", chunks: 7 },
      { valor: "es", chunks: 3 },
    ]);
    expect(inv.total_chunks).toBe(10);
  });
});
