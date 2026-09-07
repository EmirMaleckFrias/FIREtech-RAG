/// <reference types="vite/client" />
// La sincronización con Google Drive y OneDrive sobre convex-test, con las
// dos nubes simuladas (nubeFalsa.test-util.ts). La ingesta está anulada: lo
// que se comprueba es qué se descarga, qué se registra, qué se reutiliza y
// qué se retira.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { NubeFalsa, REFRESH, TOKEN, TOKEN2 } from "./nubeFalsa.test-util";
import { configurarEspera, MAX_FICHERO_BYTES, MAX_PROFUNDIDAD, type Proveedor } from "./proveedores";

vi.mock("../ingesta/pipeline", async () => {
  const { internalAction } = await import("../_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

const PDF_A = new TextEncoder().encode("%PDF-1.4 contenido de la guía A");
const PDF_A2 = new TextEncoder().encode("%PDF-1.4 contenido de la guía A, segunda versión");
const PDF_B = new TextEncoder().encode("%PDF-1.4 otro contenido distinto");
const DOCX = new TextEncoder().encode("PK docx exportado");
const TXT = new TextEncoder().encode("Notas del protocolo de p-tau217 en plasma.");

let nube: NubeFalsa;
let DUENO: Id<"users">;

const CARPETA = { id: "F1", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" };

/** La carpeta de partida: una guía en PDF, un Documento de Google (nativo,
 *  exportado a docx), unas notas en una subcarpeta, y cuatro cosas que no se
 *  traen: un formulario, un acceso directo, un .pptx y un fichero enorme. */
function carpetaInicial(proveedor: Proveedor = "google") {
  nube.carpeta("F1", "Protocolos");
  nube.carpeta("F2", "2026", "F1");
  nube.fichero("g1", "guia.pdf", "F1", PDF_A, { mime: "application/pdf", version: "md5-a1" });
  nube.fichero("t1", "notas.txt", "F2", TXT, { mime: "text/plain", version: "md5-t1" });
  nube.fichero("p1", "charla.pptx", "F1", PDF_B, { version: "md5-p1" });
  nube.fichero("big", "atlas.pdf", "F1", PDF_B, { mime: "application/pdf", version: "md5-big", tamano: MAX_FICHERO_BYTES + 1 });
  if (proveedor === "google") {
    nube.fichero("d1", "Protocolo p-tau", "F1", new Uint8Array(), {
      mime: "application/vnd.google-apps.document", version: "2026-09-01T10:00:00.000Z", exportado: DOCX,
    });
    nube.fichero("form", "Encuesta", "F1", new Uint8Array(), { mime: "application/vnd.google-apps.form", version: "2026-09-01T10:00:00.000Z" });
    nube.fichero("sc", "acceso.pdf", "F1", PDF_B, { accesoDirecto: true, version: "md5-sc" });
  } else {
    nube.fichero("nb", "Cuaderno", "F1", new Uint8Array(), { paquete: true, version: "c-nb" });
  }
}

async function nuevaBase(proveedor: Proveedor = "google", carpetas = [CARPETA]): Promise<T> {
  const t = convexTest(schema, modules);
  DUENO = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "duena@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
    });
    await ctx.db.insert("nubeConexion", {
      proveedor,
      accessToken: TOKEN,
      refreshToken: REFRESH,
      expiraEn: Date.now() + 3600_000,
      cuentaId: "perm-1",
      cuentaNombre: "Dra. Neuro",
      conectadoPor: userId,
      conectadoEn: 1,
      carpetas,
    });
    return userId;
  });
  return t;
}

async function sincronizar(t: T, proveedor: Proveedor = "google", forzar = true) {
  return await t.action(internal.nube.sync.sincronizar, { propietario: DUENO, proveedor, forzar });
}

function conCifras(r: Awaited<ReturnType<typeof sincronizar>>) {
  if (r.estado === "apagado" || r.estado === "en_curso" || r.estado === "reciente") {
    throw new Error(`la corrida no se abrió: ${r.estado}`);
  }
  return r;
}

async function documentos(t: T): Promise<Doc<"documents">[]> {
  const docs = await t.run((ctx) => ctx.db.query("documents").collect());
  return docs.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

async function ficheros(t: T): Promise<Doc<"nubeFicheros">[]> {
  const f = await t.run((ctx) => ctx.db.query("nubeFicheros").collect());
  return f.sort((a, b) => a.ficheroId.localeCompare(b.ficheroId));
}

async function corridas(t: T): Promise<Doc<"nubeSincronizaciones">[]> {
  return await t.run((ctx) => ctx.db.query("nubeSincronizaciones").order("desc").collect());
}

async function bytesAlmacenados(t: T, doc: Doc<"documents">): Promise<string> {
  return await t.run(async (ctx) => (await ctx.storage.get(doc.storageId!))!.text());
}

async function marcarListo(t: T, id: Id<"documents">) {
  await t.run((ctx) => ctx.db.patch(id, { status: "ready", chunks: 3, pages: 1 }));
}

async function insertarChunks(t: T, doc: Doc<"documents">, n: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("chunks", {
        text: `fragmento ${i}`,
        embedding: new Array<number>(3072).fill(0),
        sourceFile: doc.fileName,
        page: 1,
        chunkType: "text",
        documentRef: doc._id,
        propietario: doc.propietario,
      });
    }
  });
}

function comoDuena(t: T) {
  return t.withIdentity({ subject: DUENO });
}

beforeEach(() => {
  nube = new NubeFalsa();
  configurarEspera(0);
  vi.stubGlobal("fetch", nube.fetch);
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-cliente");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "GOCSPX-prueba");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "ms-cliente");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "secreto-ms");
  vi.stubEnv("DRIVE_SYNC_MINUTES", "60");
  vi.stubEnv("DRIVE_DELETE_REMOVED", "true");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("primera sincronización (Google Drive)", () => {
  test("registra el PDF, la exportación del Documento y las notas de la subcarpeta; avisa de lo que no trae sin descargarlo", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const r = conCifras(await sincronizar(t));
    // El valor devuelto dice si la corrida terminó ("ok") o se cortó ("parcial");
    // los avisos por fichero hacen que la FILA de la corrida quede en "error".
    expect(r).toMatchObject({ estado: "ok", nuevos: 3, actualizados: 0, borrados: 0 });

    const docs = await documentos(t);
    expect(docs.map((d) => d.fileName)).toEqual(["guia.pdf", "notas.txt", "Protocolo_p-tau.docx"]);
    for (const d of docs) {
      expect(d).toMatchObject({ propietario: DUENO, origen: "google", status: "processing" });
      expect(d.nubeFicheroId).toBeTruthy();
    }
    expect(await bytesAlmacenados(t, docs[2])).toBe("PK docx exportado");
    expect(await bytesAlmacenados(t, docs[0])).toContain("guía A");

    // Los avisos dicen QUÉ y POR QUÉ, con la ruta dentro de la carpeta.
    expect(r.errores).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Encuesta: es un formato de Google que no se puede exportar/),
        expect.stringMatching(/^acceso\.pdf: es un acceso directo/),
        expect.stringMatching(/^charla\.pptx: es \.pptx, un formato que no se puede indexar/),
        expect.stringMatching(/^atlas\.pdf: 'atlas\.pdf' pesa 20 MB y el máximo/),
      ]),
    );
    expect(r.errores).toHaveLength(4);
    // Ni el enorme ni los omitidos se descargaron: 3 descargas exactas.
    expect(nube.descargas()).toHaveLength(3);
    expect(nube.descargas().some((d) => d.includes("/files/big"))).toBe(false);

    // Una fila por fichero registrado, con la ruta legible y la versión.
    const filas = await ficheros(t);
    expect(filas.map((f) => [f.ficheroId, f.nombre, f.version])).toEqual([
      ["d1", "Protocolo p-tau", "2026-09-01T10:00:00.000Z"],
      ["g1", "guia.pdf", "md5-a1"],
      ["t1", "2026/notas.txt", "md5-t1"],
    ]);
    expect(filas.every((f) => f.carpetaId === "F1" && f.documentId)).toBe(true);

    // La corrida quedó cerrada con las cifras y sin "ahora leyendo".
    const [c] = await corridas(t);
    expect(c).toMatchObject({ estado: "error", ficheros: 7, nuevos: 3, ficherosTotal: 7, ficherosProcesados: 7 });
    expect(c.ficheroActual).toBeUndefined();
  });

  test("pagina el listado de la carpeta", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    nube.tamanoPagina = 2;
    const r = conCifras(await sincronizar(t));
    expect(r.nuevos).toBe(3);
    expect(nube.llamadas.filter((l) => l.includes("pageToken=")).length).toBeGreaterThan(0);
  });
});

describe("segunda sincronización", () => {
  test("sin cambios no descarga nada ni toca documentos", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const antes = await documentos(t);
    nube.llamadas = [];
    const r = conCifras(await sincronizar(t));
    expect(r).toMatchObject({ nuevos: 0, actualizados: 0, borrados: 0 });
    expect(nube.descargas()).toEqual([]);
    expect((await documentos(t)).map((d) => [d._id, d.ingestadoEn])).toEqual(antes.map((d) => [d._id, d.ingestadoEn]));
  });

  test("con versión nueva y contenido cambiado reutiliza la MISMA fila del documento", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await marcarListo(t, guia._id);
    nube.fichero("g1", "guia.pdf", "F1", PDF_A2, { mime: "application/pdf", version: "md5-a2" });
    const r = conCifras(await sincronizar(t));
    expect(r).toMatchObject({ nuevos: 0, actualizados: 1 });
    const despues = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    expect(despues._id).toBe(guia._id);
    expect(despues.status).toBe("processing");
    expect(despues.sha256).not.toBe(guia.sha256);
    expect(await bytesAlmacenados(t, despues)).toContain("segunda versión");
    expect((await ficheros(t)).find((f) => f.ficheroId === "g1")!.version).toBe("md5-a2");
  });

  test("versión nueva pero mismos bytes (un renombrado): no se reingiere y el nombre del documento se conserva", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await marcarListo(t, guia._id);
    nube.fichero("g1", "guia-renombrada.pdf", "F1", PDF_A, { mime: "application/pdf", version: "md5-a1-bis" });
    const r = conCifras(await sincronizar(t));
    expect(r).toMatchObject({ nuevos: 0, actualizados: 0 });
    const despues = (await documentos(t)).find((d) => d._id === guia._id)!;
    expect(despues.fileName).toBe("guia.pdf");
    expect(despues.status).toBe("ready");
    expect(nube.descargas().filter((d) => d.includes("/files/g1"))).toHaveLength(2);
  });

  test("si su dueña borra a mano el documento, se vuelve a traer aunque el fichero no cambie", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await t.run((ctx) => ctx.db.delete(guia._id));
    const r = conCifras(await sincronizar(t));
    expect(r.nuevos).toBe(1);
    expect((await documentos(t)).some((d) => d.fileName === "guia.pdf")).toBe(true);
  });
});

describe("ficheros que desaparecen", () => {
  test("quitar la guía de la carpeta borra su documento con sus fragmentos, su fichero y su fila", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await marcarListo(t, guia._id);
    await insertarChunks(t, guia, 5);
    nube.ficheros.delete("g1");
    const r = conCifras(await sincronizar(t));
    expect(r.borrados).toBe(1);
    expect((await documentos(t)).map((d) => d.fileName)).toEqual(["notas.txt", "Protocolo_p-tau.docx"]);
    expect(await t.run((ctx) => ctx.db.query("chunks").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.system.get(guia.storageId!))).toBeNull();
    expect((await ficheros(t)).some((f) => f.ficheroId === "g1")).toBe(false);
  });

  test("ADVERSARIAL: un fichero que se MUEVE a otra carpeta elegida no se borra ni se vuelve a descargar", async () => {
    const t = await nuevaBase("google", [CARPETA, { id: "F9", nombre: "Archivo", ruta: "Mi unidad / Archivo" }]);
    carpetaInicial();
    nube.carpeta("F9", "Archivo");
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await marcarListo(t, guia._id);
    nube.ficheros.get("g1")!.padre = "F9";
    nube.llamadas = [];
    const r = conCifras(await sincronizar(t));
    expect(r).toMatchObject({ nuevos: 0, actualizados: 0, borrados: 0 });
    expect(nube.descargas()).toEqual([]);
    expect((await documentos(t)).find((d) => d._id === guia._id)).toBeTruthy();
    expect((await ficheros(t)).find((f) => f.ficheroId === "g1")!.carpetaId).toBe("F9");
  });

  test("ADVERSARIAL: una carpeta que no se pudo recorrer entera (demasiado anidada) no retira nada", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    // Una cadena de carpetas más honda que el tope: el recorrido se corta,
    // avisa, y el listado deja de ser completo.
    let padre = "F1";
    for (let i = 0; i <= MAX_PROFUNDIDAD; i++) {
      nube.carpeta(`h${i}`, `nivel${i}`, padre);
      padre = `h${i}`;
    }
    nube.ficheros.delete("g1");
    const r = conCifras(await sincronizar(t));
    expect(r.borrados).toBe(0);
    expect(r.errores.some((e) => /demasiado anidada/.test(e))).toBe(true);
    expect((await documentos(t)).some((d) => d.fileName === "guia.pdf")).toBe(true);
  });

  test("con DRIVE_DELETE_REMOVED=false se conserva el documento y la fila queda marcada", async () => {
    vi.stubEnv("DRIVE_DELETE_REMOVED", "false");
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    nube.ficheros.delete("g1");
    const r = conCifras(await sincronizar(t));
    expect(r.borrados).toBe(0);
    expect((await documentos(t)).some((d) => d.fileName === "guia.pdf")).toBe(true);
    expect((await ficheros(t)).find((f) => f.ficheroId === "g1")!.error).toBe("retirado");
  });

  test("un documento que su dueña reclamó como subida manual NO se borra al quitar el fichero", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    conCifras(await sincronizar(t));
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await t.run((ctx) => ctx.db.patch(guia._id, { origen: "subida", nubeFicheroId: undefined }));
    nube.ficheros.delete("g1");
    const r = conCifras(await sincronizar(t));
    expect(r.borrados).toBe(0);
    expect((await documentos(t)).find((d) => d._id === guia._id)).toBeTruthy();
  });
});

describe("duplicados y nombres", () => {
  test("el mismo contenido en dos ficheros se indexa una vez; el segundo queda anotado sin documento", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    nube.fichero("g2", "copia-de-guia.pdf", "F2", PDF_A, { mime: "application/pdf", version: "md5-a1" });
    const r = conCifras(await sincronizar(t));
    expect(r.nuevos).toBe(3);
    expect((await documentos(t)).map((d) => d.fileName)).toEqual(["guia.pdf", "notas.txt", "Protocolo_p-tau.docx"]);
    const copia = (await ficheros(t)).find((f) => f.ficheroId === "g2")!;
    expect(copia.documentId).toBeUndefined();
    expect(copia.error).toBeUndefined();
    // Y en la siguiente corrida no se vuelve a descargar.
    nube.llamadas = [];
    conCifras(await sincronizar(t));
    expect(nube.descargas()).toEqual([]);
  });

  test("mismo nombre con contenido distinto en dos carpetas: el segundo lleva un sufijo del fichero", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    nube.fichero("g2xyz12345", "guia.pdf", "F2", PDF_B, { mime: "application/pdf", version: "md5-b" });
    conCifras(await sincronizar(t));
    const nombres = (await documentos(t)).map((d) => d.fileName);
    expect(nombres).toContain("guia.pdf");
    expect(nombres).toContain("guia-xyz12345.pdf");
  });

  test("un nombre ocupado por una subida manual no se pisa", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO, fileName: "guia.pdf", sha256: "c".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: 1, origen: "subida",
      }),
    );
    conCifras(await sincronizar(t));
    const docs = await documentos(t);
    expect(docs.filter((d) => d.fileName === "guia.pdf")).toHaveLength(1);
    expect(docs.find((d) => d.fileName === "guia.pdf")!.origen).toBe("subida");
    expect(docs.some((d) => d.fileName.startsWith("guia-") && d.origen === "google")).toBe(true);
  });
});

describe("tokens durante la corrida", () => {
  test("un token que caduca a mitad se renueva UNA vez y la corrida sigue con el nuevo", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    nube.expulsarUnaVez = true;
    const r = conCifras(await sincronizar(t));
    expect(r.nuevos).toBe(3);
    expect(nube.renovaciones()).toBe(1);
    const [c] = await t.run((ctx) => ctx.db.query("nubeConexion").collect());
    expect(c.accessToken).toBe(TOKEN2);
  });

  test("con poco margen se renueva ANTES de empezar, sin esperar al 401", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    await t.run(async (ctx) => {
      const [c] = await ctx.db.query("nubeConexion").collect();
      await ctx.db.patch(c._id, { expiraEn: Date.now() + 10 * 60_000 });
    });
    conCifras(await sincronizar(t));
    expect(nube.renovaciones()).toBe(1);
    expect(nube.llamadas.findIndex((l) => l.includes("/token")) < nube.llamadas.findIndex((l) => l.includes("/drive/v3/files"))).toBe(true);
  });

  test("ADVERSARIAL: permiso revocado: la corrida cierra con un motivo en llano, la conexión queda marcada, la periódica se salta y la manual reintenta", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    nube.refreshTokens.clear();
    await t.run(async (ctx) => {
      const [c] = await ctx.db.query("nubeConexion").collect();
      await ctx.db.patch(c._id, { expiraEn: Date.now() - 1 });
    });
    const r = conCifras(await sincronizar(t));
    expect(r.estado).toBe("error");
    const ultimo = r.errores[r.errores.length - 1];
    expect(ultimo).toMatch(/Volver a conectar/);
    expect(ultimo).not.toMatch(/token|grant/i);
    const [c] = await t.run((ctx) => ctx.db.query("nubeConexion").collect());
    expect(c.necesitaReconexion).toBe(true);
    expect(await documentos(t)).toEqual([]);
    expect(await sincronizar(t, "google", false)).toEqual({ estado: "apagado" });
    // La manual lo intenta: si el permiso volvió (reconectó), funciona.
    nube.refreshTokens.add(REFRESH);
    const r2 = conCifras(await sincronizar(t, "google", true));
    expect(r2.nuevos).toBe(3);
    expect((await t.run((ctx) => ctx.db.query("nubeConexion").collect()))[0].necesitaReconexion).toBeUndefined();
  });
});

describe("autoexclusión y aislamiento", () => {
  test("sin carpetas elegidas: apagada, sin corrida registrada", async () => {
    const t = await nuevaBase("google", []);
    expect(await sincronizar(t)).toEqual({ estado: "apagado" });
    expect(await corridas(t)).toEqual([]);
  });

  test("DRIVE_SYNC_MINUTES=0 apaga la periódica pero no la manual; la periódica se salta si la última es reciente", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    vi.stubEnv("DRIVE_SYNC_MINUTES", "0");
    expect(await sincronizar(t, "google", false)).toEqual({ estado: "apagado" });
    conCifras(await sincronizar(t, "google", true));
    vi.stubEnv("DRIVE_SYNC_MINUTES", "60");
    expect(await sincronizar(t, "google", false)).toEqual({ estado: "reciente" });
  });

  test("una corrida running reciente bloquea; una muerta se cierra y se sigue", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const viva = await t.run((ctx) =>
      ctx.db.insert("nubeSincronizaciones", {
        propietario: DUENO, proveedor: "google", empezadoEn: Date.now(),
        ficheros: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [], estado: "running",
      }),
    );
    expect(await sincronizar(t)).toEqual({ estado: "en_curso" });
    await t.run((ctx) => ctx.db.patch(viva, { empezadoEn: Date.now() - 40 * 60_000 }));
    expect(await sincronizar(t)).toMatchObject({ nuevos: 3 });
    expect((await corridas(t)).find((c) => c._id === viva)).toMatchObject({ estado: "error" });
  });

  test("la sincronización de una persona no ve ni toca la nube de otra, ni la otra nube de la misma persona", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const otra = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        email: "otra@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      });
      await ctx.db.insert("documents", {
        propietario: id, fileName: "guia.pdf", sha256: "d".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: 1, origen: "google", nubeFicheroId: "g1",
      });
      await ctx.db.insert("nubeFicheros", {
        propietario: id, proveedor: "google", carpetaId: "F1", ficheroId: "g1", nombre: "guia.pdf", version: "md5-a1", sincronizadoEn: 1,
      });
      // Y la MISMA dueña con OneDrive: otra conexión, otro rastro.
      await ctx.db.insert("nubeFicheros", {
        propietario: DUENO, proveedor: "onedrive", carpetaId: "F1", ficheroId: "g1", nombre: "guia.pdf", version: "otra", sincronizadoEn: 1,
      });
      return id;
    });
    const r = conCifras(await sincronizar(t));
    // El "guia.pdf" de la otra persona no cuenta como conocido: se trae el propio.
    expect(r.nuevos).toBe(3);
    const docs = await documentos(t);
    expect(docs.filter((d) => d.propietario === otra)).toHaveLength(1);
    expect(docs.filter((d) => d.propietario === DUENO && d.fileName === "guia.pdf")).toHaveLength(1);
    const filas = await ficheros(t);
    expect(filas.find((f) => f.propietario === DUENO && f.proveedor === "onedrive")!.version).toBe("otra");
  });
});

describe("corrida parcial", () => {
  test("ADVERSARIAL: cortada por el reloj tras avanzar, se cierra con la verdad y se reagenda en un minuto", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => (nube.descargas().length > 0 ? real() + 30 * 60_000 : real()));
    try {
      const r = await sincronizar(t);
      if (r.estado !== "parcial") throw new Error(`esperaba parcial, fue ${r.estado}`);
      expect(r.errores).toContain("sincronización parcial, continuará en unos minutos");
      const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const reanudacion = trabajos.filter((j) => j.name.includes("sincronizar"));
      expect(reanudacion.length).toBeGreaterThanOrEqual(1);
      expect(reanudacion[0].args[0]).toMatchObject({ propietario: DUENO, proveedor: "google", forzar: true });
      // Nada se retiró: la carpeta no se recorrió entera.
      expect(r.borrados).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("OneDrive", () => {
  test("recorre la carpeta por Graph, baja por /content, omite el cuaderno de OneNote y sigue el cTag", async () => {
    const t = await nuevaBase("onedrive");
    carpetaInicial("onedrive");
    const r = conCifras(await sincronizar(t, "onedrive"));
    expect(r).toMatchObject({ nuevos: 2 });
    expect((await documentos(t)).map((d) => [d.fileName, d.origen])).toEqual([["guia.pdf", "onedrive"], ["notas.txt", "onedrive"]]);
    expect(r.errores).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Cuaderno: es un cuaderno de OneNote/),
        expect.stringMatching(/^charla\.pptx: es \.pptx/),
        expect.stringMatching(/^atlas\.pdf: 'atlas\.pdf' pesa 20 MB/),
      ]),
    );
    expect(nube.descargas().every((d) => /\/me\/drive\/items\/[^/]+\/content$/.test(d))).toBe(true);

    // cTag nuevo: se vuelve a traer; mismo cTag: no.
    const guia = (await documentos(t)).find((d) => d.fileName === "guia.pdf")!;
    await marcarListo(t, guia._id);
    nube.ficheros.get("g1")!.bytes = PDF_A2;
    nube.ficheros.get("g1")!.version = "c-2";
    const r2 = conCifras(await sincronizar(t, "onedrive"));
    expect(r2.actualizados).toBe(1);
    expect((await documentos(t)).find((d) => d._id === guia._id)!.status).toBe("processing");
  });

  test("una carpeta compartida por otra persona (id compuesto) se recorre y se descarga en SU unidad", async () => {
    const t = await nuevaBase("onedrive", [{ id: "drive:DRIVE-COLEGA:X1", nombre: "De la colega", ruta: "Compartido conmigo / De la colega" }]);
    nube.carpeta("X1", "De la colega", null, "DRIVE-COLEGA");
    nube.fichero("x-pdf", "consenso.pdf", "X1", PDF_B, { mime: "application/pdf", version: "c-x", driveId: "DRIVE-COLEGA" });
    const r = conCifras(await sincronizar(t, "onedrive"));
    expect(r.nuevos).toBe(1);
    expect(nube.llamadas.some((l) => l.startsWith("GET /v1.0/drives/DRIVE-COLEGA/items/X1/children"))).toBe(true);
    expect(nube.descargas()).toEqual(["GET /v1.0/drives/DRIVE-COLEGA/items/x-pdf/content"]);
    expect((await ficheros(t))[0].ficheroId).toBe("drive:DRIVE-COLEGA:x-pdf");
  });
});

describe("el panel de cada persona", () => {
  test("sincronizarAhora exige conexión con carpetas y rechaza una corrida encima de otra viva", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const yo = comoDuena(t);
    expect(await yo.mutation(api.nube.admin.sincronizarAhora, { proveedor: "google" })).toEqual({ ok: true });
    await t.run((ctx) =>
      ctx.db.insert("nubeSincronizaciones", {
        propietario: DUENO, proveedor: "google", empezadoEn: Date.now(),
        ficheros: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [], estado: "running",
      }),
    );
    await expect(yo.mutation(api.nube.admin.sincronizarAhora, { proveedor: "google" })).rejects.toThrow();
    await expect(yo.mutation(api.nube.admin.sincronizarAhora, { proveedor: "onedrive" })).rejects.toThrow(/conectar con OneDrive/);
  });

  test("estado enseña el avance en vivo con vivaHasta y, al cerrar, las cifras", async () => {
    const t = await nuevaBase();
    carpetaInicial();
    const yo = comoDuena(t);
    let visto: unknown = null;
    nube.antesDeDescargar = async () => {
      if (visto === null) visto = await yo.query(api.nube.admin.estado, { proveedor: "google" });
    };
    conCifras(await sincronizar(t));
    const enCurso = (visto as { enCurso: { ficherosTotal: number; ficheroActual: string; vivaHasta: number } }).enCurso;
    expect(enCurso.ficherosTotal).toBe(7);
    expect(typeof enCurso.ficheroActual).toBe("string");
    expect(enCurso.vivaHasta).toBeGreaterThan(Date.now());
    const final = await yo.query(api.nube.admin.estado, { proveedor: "google" });
    expect(final.enCurso).toBeNull();
    expect(final.ultimas[0]).toMatchObject({ estado: "error", ficheros: 7, nuevos: 3 });
    expect(final.documentos).toBe(3);
    expect(final.ficheros).toBe(3);
  });
});
