// Retracciones según Crossref: la lectura de la respuesta (pura), la acción
// con `fetch` parcheado (sin red) y lo que hace el documento con la marca.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { interpretarCrossref } from "./retracciones";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

async function documento(t: T, doi?: string): Promise<Id<"documents">> {
  return t.run(async (ctx) => {
    const propietario = await ctx.db.insert("users", { email: "d@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 });
    return ctx.db.insert("documents", {
      fileName: "lesne2006.pdf", sha256: "x", pages: 8, chunks: 20, status: "ready", propietario, ingestadoEn: 1, doi,
    });
  });
}

function respuestaCrossref(updatedBy: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: "ok", message: { DOI: "10.1038/nature04533", "updated-by": updatedBy } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("interpretarCrossref", () => {
  test("lee la retracción con su fecha y el DOI del aviso; ignora correcciones y entradas rotas", () => {
    expect(
      interpretarCrossref({
        "updated-by": [
          { type: "correction", updated: { "date-time": "2010-01-01T00:00:00Z" }, DOI: "10.1/c" },
          "basura",
          { type: "retraction", updated: { "date-parts": [[2024, 6, 24]] }, DOI: "10.1038/s41586-024-07691-8", label: "Retraction" },
        ],
      }),
    ).toEqual({ tipo: "retractado", fecha: "2024-06-24", avisoDoi: "10.1038/s41586-024-07691-8" });
    // Solo una corrección: no invalida el artículo.
    expect(interpretarCrossref({ "updated-by": [{ type: "correction" }] })).toBeNull();
    expect(interpretarCrossref({})).toBeNull();
    expect(interpretarCrossref(null)).toBeNull();
    expect(interpretarCrossref({ "updated-by": "no es lista" })).toBeNull();
  });

  test("entre varias actualizaciones gana la más grave, y los tipos se leen con tolerancia", () => {
    expect(
      interpretarCrossref({
        "updated-by": [
          { type: "Expression of Concern", updated: { "date-time": "2023-01-01T00:00:00Z" } },
          { type: "withdrawal", updated: { "date-time": "2023-06-01T00:00:00Z" } },
        ],
      }),
    ).toEqual({ tipo: "retirado", fecha: "2023-06-01" });
    expect(interpretarCrossref({ "updated-by": [{ type: "expression_of_concern" }] })).toEqual({ tipo: "preocupacion" });
  });
});

describe("comprobarDocumento", () => {
  test("marca el documento retractado según Crossref y no manda ningún correo en la petición", async () => {
    const t = convexTest(schema, modules);
    const id = await documento(t, "10.1038/nature04533");
    const fetchFalso = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respuestaCrossref([{ type: "retraction", updated: { "date-time": "2024-06-24T00:00:00Z" }, DOI: "10.1038/s41586-024-07691-8" }]),
    );

    const r = await t.action(internal.retracciones.comprobarDocumento, { documentId: id });

    expect(r).toEqual({ tipo: "retractado", fecha: "2024-06-24", avisoDoi: "10.1038/s41586-024-07691-8" });
    const [url, init] = fetchFalso.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.crossref.org/works/10.1038%2Fnature04533");
    expect(JSON.stringify(init.headers)).not.toMatch(/@/);
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.retraccion).toEqual({ tipo: "retractado", fecha: "2024-06-24", avisoDoi: "10.1038/s41586-024-07691-8" });
    expect(typeof doc?.retraccionComprobadaEn).toBe("number");
  });

  test("un artículo limpio borra una marca anterior; un 404 también se anota como comprobado sin marca", async () => {
    const t = convexTest(schema, modules);
    const id = await documento(t, "10.1/limpio");
    await t.run((ctx) => ctx.db.patch(id, { retraccion: { tipo: "retractado" } }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respuestaCrossref([]));
    expect(await t.action(internal.retracciones.comprobarDocumento, { documentId: id })).toBeNull();
    let doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.retraccion).toBeUndefined();

    await t.run((ctx) => ctx.db.patch(id, { retraccion: { tipo: "preocupacion" }, retraccionComprobadaEn: 1 }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("no", { status: 404 }));
    expect(await t.action(internal.retracciones.comprobarDocumento, { documentId: id })).toBeNull();
    doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.retraccion).toBeUndefined();
    expect(doc?.retraccionComprobadaEn).toBeGreaterThan(1);
  });

  test("ADVERSARIAL: un fallo de red no toca la marca ni la fecha de comprobación", async () => {
    const t = convexTest(schema, modules);
    const id = await documento(t, "10.1/red");
    await t.run((ctx) => ctx.db.patch(id, { retraccion: { tipo: "retractado", fecha: "2024-01-01" }, retraccionComprobadaEn: 5 }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sin red"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await t.action(internal.retracciones.comprobarDocumento, { documentId: id })).toBeNull();
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.retraccion).toEqual({ tipo: "retractado", fecha: "2024-01-01" });
    expect(doc?.retraccionComprobadaEn).toBe(5);
    // Y un 500 tampoco.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("caído", { status: 500 }));
    await t.action(internal.retracciones.comprobarDocumento, { documentId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.retraccionComprobadaEn).toBe(5);
  });

  test("sin DOI no hay petición", async () => {
    const t = convexTest(schema, modules);
    const id = await documento(t);
    const fetchFalso = vi.spyOn(globalThis, "fetch");
    expect(await t.action(internal.retracciones.comprobarDocumento, { documentId: id })).toBeNull();
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("comprobarTodos", () => {
  test("recorre solo los documentos listos con DOI y se encadena por páginas", async () => {
    const t = convexTest(schema, modules);
    const conDoi = await documento(t, "10.1/a");
    await t.run(async (ctx) => {
      const doc = (await ctx.db.get(conDoi))!;
      await ctx.db.insert("documents", { ...doc, _id: undefined, _creationTime: undefined, fileName: "sin-doi.pdf", doi: undefined } as never);
      await ctx.db.insert("documents", { ...doc, _id: undefined, _creationTime: undefined, fileName: "fallido.pdf", status: "failed", doi: "10.1/b" } as never);
    });
    const fetchFalso = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaCrossref([]));
    const r = await t.action(internal.retracciones.comprobarTodos, {});
    expect(r).toEqual({ comprobados: 1, hecho: true });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(String(fetchFalso.mock.calls[0][0])).toContain("10.1%2Fa");
  });
});
