// La migración del índice: qué documentos se reindexan, de cuántos en
// cuántos, y cuándo se da por terminada. Con convex-test, sin correr las
// ingestas agendadas (se inspecciona `_scheduled_functions`).
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { VERSION_INDICE } from "./ingesta/contexto";
import { EN_PARALELO } from "./migraciones";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

async function cuenta(t: T): Promise<Id<"users">> {
  return t.run((ctx) =>
    ctx.db.insert("users", { email: "duena@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 }),
  );
}

async function documento(
  t: T,
  propietario: Id<"users">,
  fileName: string,
  extra: { status?: "ready" | "processing" | "failed"; indiceVersion?: string; sinFichero?: boolean } = {},
): Promise<Id<"documents">> {
  return t.run(async (ctx) => {
    const storageId = extra.sinFichero ? undefined : await ctx.storage.store(new Blob([new TextEncoder().encode("x")]));
    return ctx.db.insert("documents", {
      fileName,
      sha256: fileName,
      pages: 1,
      chunks: 1,
      status: extra.status ?? "ready",
      propietario,
      ingestadoEn: 1,
      storageId,
      indiceVersion: extra.indiceVersion,
    });
  });
}

async function agendadas(t: T): Promise<Array<{ name: string; args: unknown }>> {
  const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return trabajos.filter((j) => j.state.kind === "pending").map((j) => ({ name: j.name, args: j.args[0] }));
}

describe("reindexarTodo", () => {
  test("agenda solo los listos con otra versión y con fichero, de EN_PARALELO en EN_PARALELO, y los deja en processing", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    const viejo1 = await documento(t, u, "viejo1.pdf");
    const viejo2 = await documento(t, u, "viejo2.pdf", { indiceVersion: "2026-01-antigua" });
    const viejo3 = await documento(t, u, "viejo3.pdf");
    const alDia = await documento(t, u, "aldia.pdf", { indiceVersion: VERSION_INDICE });
    const fallido = await documento(t, u, "roto.pdf", { status: "failed" });
    const sinFichero = await documento(t, u, "heredado.pdf", { sinFichero: true });

    const r = await t.mutation(internal.migraciones.reindexarTodo, {});

    expect(r).toEqual({ agendados: EN_PARALELO, hecho: false });
    const ingestas = (await agendadas(t)).filter((j) => j.name.includes("ingestar"));
    expect(ingestas).toHaveLength(EN_PARALELO);
    const ids = ingestas.map((j) => (j.args as { documentId: string }).documentId).sort();
    expect(ids).toEqual([viejo1, viejo2].sort());
    for (const id of [viejo1, viejo2]) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("processing");
    }
    // El tercero espera su turno; los demás no se tocan.
    expect((await t.run((ctx) => ctx.db.get(viejo3)))?.status).toBe("ready");
    for (const id of [alDia, fallido, sinFichero]) {
      const d = await t.run((ctx) => ctx.db.get(id));
      expect(ids).not.toContain(id);
      expect(d?.status).not.toBe("processing");
    }
    // Y se vuelve a agendar a sí misma sobre la misma página.
    const siguientes = (await agendadas(t)).filter((j) => j.name.includes("reindexarTodo"));
    expect(siguientes).toHaveLength(1);
  });

  test("ADVERSARIAL: no relanza un documento ya en processing con corrida viva, pero una corrida muerta no bloquea la cuota", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    const ahora = Date.now();
    // Uno en marcha de verdad (latido reciente) y uno muerto (sin latido hace
    // mucho): el vivo ocupa una plaza, el muerto no.
    const vivo = await documento(t, u, "vivo.pdf", { status: "processing" });
    const muerto = await documento(t, u, "muerto.pdf", { status: "processing" });
    await t.run(async (ctx) => {
      const rVivo = await ctx.db.insert("ingestionRuns", { empezadoEn: ahora, latidoEn: ahora, documentId: vivo, status: "running" });
      await ctx.db.patch(vivo, { ingestaRunId: rVivo });
      const rMuerto = await ctx.db.insert("ingestionRuns", { empezadoEn: ahora - 3_600_000, latidoEn: ahora - 3_600_000, documentId: muerto, status: "running" });
      await ctx.db.patch(muerto, { ingestaRunId: rMuerto });
    });
    const pendienteA = await documento(t, u, "a.pdf");
    const pendienteB = await documento(t, u, "b.pdf");

    const r = await t.mutation(internal.migraciones.reindexarTodo, {});

    // Una plaza ocupada por el vivo: solo cabe UNA ingesta nueva.
    expect(r.agendados).toBe(EN_PARALELO - 1);
    const ingestas = (await agendadas(t)).filter((j) => j.name.includes("ingestar"));
    const ids = ingestas.map((j) => (j.args as { documentId: string }).documentId);
    expect(ids).toEqual([pendienteA]);
    expect(ids).not.toContain(vivo);
    expect(ids).not.toContain(muerto);
    expect((await t.run((ctx) => ctx.db.get(pendienteB)))?.status).toBe("ready");
  });

  test("sin nada pendiente ni en vuelo termina y no se vuelve a agendar", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    await documento(t, u, "aldia.pdf", { indiceVersion: VERSION_INDICE });
    await documento(t, u, "roto.pdf", { status: "failed" });
    const r = await t.mutation(internal.migraciones.reindexarTodo, {});
    expect(r).toEqual({ agendados: 0, hecho: true });
    expect(await agendadas(t)).toEqual([]);
  });

  test("estadoDelIndice cuenta al día, pendientes, en proceso y sin fichero", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    await documento(t, u, "aldia.pdf", { indiceVersion: VERSION_INDICE });
    await documento(t, u, "viejo.pdf");
    await documento(t, u, "viejo2.pdf", { indiceVersion: "otra" });
    await documento(t, u, "enproceso.pdf", { status: "processing" });
    await documento(t, u, "heredado.pdf", { sinFichero: true });
    await documento(t, u, "roto.pdf", { status: "failed" });
    expect(await t.query(internal.migraciones.estadoDelIndice, {})).toEqual({
      version: VERSION_INDICE,
      total: 6,
      alDia: 1,
      pendientes: 2,
      procesando: 1,
      sinFichero: 1,
    });
  });
});

describe("reindexarTodo: cuota y cadena", () => {
  test("ADVERSARIAL: un documento que la propia migración acaba de agendar cuenta como en vuelo aunque su acción no haya arrancado", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    for (const n of ["a", "b", "c", "d"]) await documento(t, u, `${n}.pdf`);
    const r1 = await t.mutation(internal.migraciones.reindexarTodo, {});
    // Un segundo paso de la MISMA cadena, antes de que ninguna ingesta arranque.
    const r2 = await t.mutation(internal.migraciones.reindexarTodo, { continuacion: true });
    expect(r1.agendados).toBe(EN_PARALELO);
    expect(r2.agendados).toBe(0);
    const ingestas = (await agendadas(t)).filter((j) => j.name.includes("ingestar"));
    expect(ingestas).toHaveLength(EN_PARALELO);
  });

  test("ADVERSARIAL: lanzar la migración a mano con una cadena viva no agenda otra", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    for (const n of ["a", "b", "c"]) await documento(t, u, `${n}.pdf`);
    await t.mutation(internal.migraciones.reindexarTodo, {});
    const otra = await t.mutation(internal.migraciones.reindexarTodo, {});
    expect(otra).toEqual({ agendados: 0, hecho: false, yaEnMarcha: true });
    const pasos = (await agendadas(t)).filter((j) => j.name.includes("reindexarTodo"));
    expect(pasos).toHaveLength(1);
  });

  test("con más de una página, el cursor avanza y los pendientes de la segunda se agendan", async () => {
    const t = convexTest(schema, modules);
    const u = await cuenta(t);
    // 100 al día en la primera página y dos pendientes en la segunda.
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("documents", {
          fileName: `aldia-${i}.pdf`, sha256: `s${i}`, pages: 1, chunks: 1, status: "ready", propietario: u, ingestadoEn: 1,
          indiceVersion: VERSION_INDICE,
        });
      }
    });
    const p1 = await documento(t, u, "pendiente-1.pdf");
    const p2 = await documento(t, u, "pendiente-2.pdf");
    const r1 = await t.mutation(internal.migraciones.reindexarTodo, {});
    expect(r1).toEqual({ agendados: 0, hecho: false });
    const siguiente = (await agendadas(t)).find((j) => j.name.includes("reindexarTodo"));
    expect(siguiente).toBeDefined();
    const args = siguiente!.args as { cursor?: string; continuacion?: boolean };
    expect(typeof args.cursor).toBe("string");
    expect(args.continuacion).toBe(true);
    const r2 = await t.mutation(internal.migraciones.reindexarTodo, args);
    expect(r2.agendados).toBe(2);
    const ids = (await agendadas(t)).filter((j) => j.name.includes("ingestar")).map((j) => (j.args as { documentId: string }).documentId).sort();
    expect(ids).toEqual([p1, p2].sort());
  });
});
