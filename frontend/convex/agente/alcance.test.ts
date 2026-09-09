// El alcance de una pregunta: a qué documento se limita, resuelto sin modelo.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { elegirDocumento, palabrasQueIdentifican, type DocumentoNombrado } from "./alcance";

const modules = import.meta.glob("/convex/**/*.*s");

const doc = (id: string, fileName: string, titulo?: string): DocumentoNombrado =>
  ({ id: id as Id<"documents">, fileName, ...(titulo ? { titulo } : {}) });

const CORPUS = [
  doc("d1", "--M6U1_PDF.pdf"),
  doc("d2", "Allegri2023_plasma_ptau.pdf", "Plasma p-tau217 in memory clinics"),
  doc("d3", "guia_hta_2024.docx"),
  doc("d4", "Notas de la reunión", "Notas de la reunión"),
];

describe("palabrasQueIdentifican", () => {
  test("quita artículos, genéricos y formatos; conserva nombres y códigos", () => {
    expect(palabrasQueIdentifican("únicamente el PDF indexado")).toEqual([]);
    expect(palabrasQueIdentifican("el PDF M6U1")).toEqual(["m6u1"]);
    expect(palabrasQueIdentifican("el documento de Allegri 2023")).toEqual(["allegri", "2023"]);
    expect(palabrasQueIdentifican("el archivo guia_hta.pdf")).toEqual(["hta"]);
  });
});

describe("elegirDocumento", () => {
  test("el caso medido: 'el PDF indexado' con un solo PDF se resuelve a ese PDF", () => {
    const r = elegirDocumento("el PDF indexado", [doc("d1", "--M6U1_PDF.pdf"), doc("d3", "guia_hta_2024.docx")]);
    expect(r).toEqual({ tipo: "elegido", id: "d1", nombre: "--M6U1_PDF.pdf", generico: true });
  });

  test("ADVERSARIAL: 'el PDF' con varios PDF no adivina: es ambiguo y dice cuántos", () => {
    expect(elegirDocumento("el PDF indexado", CORPUS)).toEqual({ tipo: "ambiguo", candidatos: 2, generico: true });
    // Sin formato, cualquier documento vale: cuatro candidatos.
    expect(elegirDocumento("el documento", CORPUS)).toEqual({ tipo: "ambiguo", candidatos: 4, generico: true });
    // Pero un solo documento en total sí es "el documento".
    expect(elegirDocumento("el documento", [CORPUS[1]])).toMatchObject({ tipo: "elegido", id: "d2" });
  });

  test("con nombre, encuentra por fichero (sin extensión, con guiones) y por título, sin distinguir acentos", () => {
    expect(elegirDocumento("el PDF M6U1", CORPUS)).toMatchObject({ tipo: "elegido", id: "d1", generico: false });
    expect(elegirDocumento("el paper de Allegri", CORPUS)).toMatchObject({ tipo: "elegido", id: "d2", nombre: "Plasma p-tau217 in memory clinics" });
    expect(elegirDocumento("el de p-tau217", CORPUS)).toMatchObject({ tipo: "elegido", id: "d2" });
    expect(elegirDocumento("las notas de la reunion", CORPUS)).toMatchObject({ tipo: "elegido", id: "d4" });
    expect(elegirDocumento("la guía HTA", CORPUS)).toMatchObject({ tipo: "elegido", id: "d3" });
  });

  test("ADVERSARIAL: una palabra no encuentra por trozo interior ni un nombre que no está", () => {
    // "tau" está DENTRO de "restaurante": no debe encajar.
    expect(elegirDocumento("el documento tau", [doc("x", "restaurante.pdf")])).toEqual({ tipo: "desconocido" });
    expect(elegirDocumento("el PDF de Smith 2020", CORPUS)).toEqual({ tipo: "desconocido" });
    // Todas las palabras tienen que estar: "Allegri 2019" no es el de 2023.
    expect(elegirDocumento("Allegri 2019", CORPUS)).toEqual({ tipo: "desconocido" });
  });

  test("ADVERSARIAL: dos documentos que llevan todas las palabras son ambiguos; el mismo fichero duplicado no", () => {
    const parecidos = [doc("a", "guia_hta_2023.pdf"), doc("b", "guia_hta_2024.pdf")];
    expect(elegirDocumento("la guía HTA", parecidos)).toEqual({ tipo: "ambiguo", candidatos: 2, generico: false });
    expect(elegirDocumento("la guía HTA 2024", parecidos)).toMatchObject({ tipo: "elegido", id: "b" });
    const duplicado = [doc("a", "guia_hta.pdf"), doc("b", "guia_hta.pdf")];
    expect(elegirDocumento("guia hta", duplicado)).toMatchObject({ tipo: "elegido", id: "a" });
  });

  test("sin pista o sin documentos no hay alcance", () => {
    expect(elegirDocumento("", CORPUS)).toEqual({ tipo: "sin_pista" });
    expect(elegirDocumento("el PDF", [])).toEqual({ tipo: "sin_pista" });
  });
});

describe("documentosDe", () => {
  test("solo los documentos listos de esa persona, con su título si lo tiene", async () => {
    const t = convexTest(schema, modules);
    const { ana, otro } = await t.run(async (ctx) => {
      const base = { rol: "lector" as const, bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 };
      const ana = await ctx.db.insert("users", { email: "ana@airobotix.net", ...base });
      const otro = await ctx.db.insert("users", { email: "otro@airobotix.net", ...base });
      const d = (propietario: Id<"users">, fileName: string, status: "ready" | "processing", titulo?: string) =>
        ctx.db.insert("documents", { fileName, sha256: fileName, pages: 1, chunks: 1, status, propietario, ingestadoEn: 1, ...(titulo ? { titulo } : {}) });
      await d(ana, "a.pdf", "ready", "Título A");
      await d(ana, "b.pdf", "processing");
      await d(otro, "ajeno.pdf", "ready");
      return { ana, otro };
    });
    const deAna = await t.query(internal.agente.alcance.documentosDe, { propietario: ana });
    expect(deAna.map((d) => [d.fileName, d.titulo])).toEqual([["a.pdf", "Título A"]]);
    const deOtro = await t.query(internal.agente.alcance.documentosDe, { propietario: otro });
    expect(deOtro.map((d) => d.fileName)).toEqual(["ajeno.pdf"]);
    expect(deOtro[0]).not.toHaveProperty("titulo");
  });
});
