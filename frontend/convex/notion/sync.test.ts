/// <reference types="vite/client" />
// La sincronización con Notion de punta a punta sobre convex-test, con Notion
// simulado parcheando `fetch` (nada sale a la red) y la ingesta sustituida
// por una acción inerte: aquí se prueba qué se registra, qué se reutiliza y
// qué se borra, no el parseo.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "../ingesta/hash";
import { configurarPausa, type BloqueNotion, type PaginaNotion } from "./api";

vi.mock("../ingesta/pipeline", async () => {
  const { internalAction } = await import("../_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

// Patrón absoluto desde la raíz: ver la nota en ingesta/pipeline.test.ts.
const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

const DB = "0123456789abcdef0123456789abcdef";
const TOKEN = "secret_prueba";

// ---------------------------------------------------------------------------
// Notion simulado
// ---------------------------------------------------------------------------
interface PaginaFalsa {
  pagina: PaginaNotion;
  bloques: BloqueNotion[];
  /** Base a la que pertenece (id sin guiones). Por defecto, DB. */
  db: string;
}

/** Una segunda base, para las pruebas con varias. */
const DB2 = "fedcba9876543210fedcba9876543210";
const conGuiones = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

function t(texto: string) {
  return { type: "text", plain_text: texto, href: null };
}

let contadorBloques = 0;
function bloque(type: string, datos: Record<string, unknown> = {}, children?: BloqueNotion[]): BloqueNotion {
  contadorBloques += 1;
  return {
    id: `b${String(contadorBloques).padStart(31, "0")}`,
    type,
    has_children: Boolean(children && children.length > 0),
    // Los hijos se guardan aparte para servirlos por /blocks/{id}/children,
    // como hace la API; el cliente los tiene que pedir.
    children,
    [type]: datos,
  };
}

function parrafo(texto: string) {
  return bloque("paragraph", { rich_text: [t(texto)] });
}

const TEXTO_LARGO =
  "Este protocolo describe la determinación de p-tau217 en plasma con un ensayo de " +
  "inmunoprecipitación seguido de espectrometría de masas, incluida la preparación de " +
  "muestras, los controles de calidad y los criterios de aceptación de cada lote.";

/** Un Notion en memoria que responde a lo que usa el cliente. */
class NotionFalso {
  paginas = new Map<string, PaginaFalsa>();
  ficheros = new Map<string, Uint8Array>();
  /** URL cuya primera descarga responde 403 (firma caducada). */
  caducadas = new Set<string>();
  /** Páginas cuyos bloques responden 404. */
  bloquesRotos = new Set<string>();
  llamadas: string[] = [];
  tamanoPagina = 100;

  pagina(id: string, titulo: string, opciones: {
    lastEdited?: string;
    archived?: boolean;
    estado?: string;
    adjuntos?: Array<{ name: string; url: string }>;
    bloques?: BloqueNotion[];
    enBase?: string;
  } = {}) {
    const properties: PaginaNotion["properties"] = {
      Nombre: { type: "title", title: [t(titulo)] },
    };
    if (opciones.estado) properties.Estado = { type: "select", select: { name: opciones.estado } };
    if (opciones.adjuntos) {
      properties.Adjuntos = {
        type: "files",
        files: opciones.adjuntos.map((a) => ({ name: a.name, type: "file", file: { url: a.url } })),
      };
    }
    this.paginas.set(id, {
      pagina: {
        id,
        last_edited_time: opciones.lastEdited ?? "2026-09-01T10:00:00.000Z",
        archived: opciones.archived ?? false,
        properties,
      },
      bloques: opciones.bloques ?? [],
      db: opciones.enBase ?? DB,
    });
  }

  fichero(url: string, bytes: Uint8Array) {
    this.ficheros.set(url, bytes);
  }

  private buscarBloque(lista: BloqueNotion[], id: string): BloqueNotion | null {
    for (const b of lista) {
      if (b.id === id) return b;
      const hijo = b.children ? this.buscarBloque(b.children, id) : null;
      if (hijo) return hijo;
    }
    return null;
  }

  private json(cuerpo: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(cuerpo), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  fetch = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const u = new URL(url);
    this.llamadas.push(`${init?.method ?? "GET"} ${u.pathname}`);

    if (u.hostname === "api.notion.com") {
      const cabeceras = new Headers(init?.headers);
      if (cabeceras.get("Authorization") !== `Bearer ${TOKEN}`) {
        return this.json({ code: "unauthorized", message: "API token is invalid." }, 401);
      }
      if (cabeceras.get("Notion-Version") !== "2022-06-28") {
        return this.json({ code: "invalid_request", message: "Notion-Version" }, 400);
      }
      const m = u.pathname.match(/^\/v1\/(databases|blocks|pages)\/([^/]+)(?:\/(query|children))?$/);
      if (!m) return this.json({ code: "object_not_found", message: u.pathname }, 404);
      const [, recurso, id, accion] = m;

      if (recurso === "databases" && accion === "query") {
        // La API documenta el formato con guiones; el cliente lo manda así.
        const conocidas = new Map([[conGuiones(DB), DB], [conGuiones(DB2), DB2]]);
        const db = conocidas.get(id);
        if (!db) return this.json({ code: "object_not_found", message: "db" }, 404);
        const cuerpo = init?.body ? (JSON.parse(String(init.body)) as { start_cursor?: string }) : {};
        const desde = Number(cuerpo.start_cursor ?? "0");
        const todas = [...this.paginas.values()].filter((p) => p.db === db).map((p) => p.pagina);
        const trozo = todas.slice(desde, desde + this.tamanoPagina);
        const hayMas = desde + this.tamanoPagina < todas.length;
        return this.json({
          results: trozo,
          has_more: hayMas,
          next_cursor: hayMas ? String(desde + this.tamanoPagina) : null,
        });
      }
      if (recurso === "pages") {
        const p = this.paginas.get(id);
        return p ? this.json(p.pagina) : this.json({ code: "object_not_found", message: "page" }, 404);
      }
      if (recurso === "blocks" && accion === "children") {
        if (this.bloquesRotos.has(id)) return this.json({ code: "object_not_found", message: "bloques" }, 404);
        const p = this.paginas.get(id);
        let hijos: BloqueNotion[] | undefined;
        if (p) hijos = p.bloques;
        else {
          for (const pf of this.paginas.values()) {
            const b = this.buscarBloque(pf.bloques, id);
            if (b) {
              hijos = b.children ?? [];
              break;
            }
          }
        }
        if (!hijos) return this.json({ code: "object_not_found", message: "block" }, 404);
        // Sin `children` en la respuesta: la API no los incluye, hay que pedirlos.
        const sinHijos = hijos.map(({ children: _c, ...resto }) => resto);
        return this.json({ results: sinHijos, has_more: false, next_cursor: null });
      }
      return this.json({ code: "object_not_found", message: u.pathname }, 404);
    }

    // Descarga de adjuntos (URL firmadas).
    if (this.caducadas.has(url)) {
      this.caducadas.delete(url);
      return new Response("expired", { status: 403 });
    }
    const bytes = this.ficheros.get(url);
    if (!bytes) return new Response("no existe", { status: 404 });
    return new Response(bytes as BodyInit, { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// Arnés
// ---------------------------------------------------------------------------
let notion: NotionFalso;

const PDF_A = new TextEncoder().encode("%PDF-1.4 contenido de la guía A");
const PDF_B = new TextEncoder().encode("%PDF-1.4 otro contenido distinto");
const URL_PDF_A = "https://s3.notion.example/guia.pdf?X-Amz-Signature=aaa";

/** Las tres páginas de partida: A con texto y PDF, B con texto corto, C archivada. */
function baseInicial() {
  notion.pagina("a1", "Guía A de p-tau217", {
    adjuntos: [{ name: "guia.pdf", url: URL_PDF_A }],
    bloques: [
      bloque("heading_1", { rich_text: [t("Método")] }),
      parrafo(TEXTO_LARGO),
      bloque("bulleted_list_item", { rich_text: [t("uno")] }),
      bloque("table", { has_column_header: true }, [
        bloque("table_row", { cells: [[t("Marcador")], [t("AUC")]] }),
        bloque("table_row", { cells: [[t("p-tau217")], [t("0,94")]] }),
      ]),
    ],
  });
  notion.fichero(URL_PDF_A, PDF_A);
  notion.pagina("b2", "Ficha corta", { bloques: [parrafo("Solo dos líneas.")] });
  notion.pagina("c3", "Archivada", { archived: true, bloques: [parrafo(TEXTO_LARGO)] });
}

/** La cuenta que conectó Notion en la prueba en curso. Cada persona conecta
 *  su propio Notion y sincroniza a su propio corpus (ver `propietario` en
 *  schema.ts), así que la sincronización siempre es de alguien: `nuevaBase`
 *  crea la cuenta y su fila de conexión, y lo deja aquí. */
let DUENO: Id<"users">;

async function nuevaBase(): Promise<T> {
  const t = convexTest(schema, modules);
  DUENO = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "duena@airobotix.net",
      rol: "lector",
      bloqueado: false,
      creadoEn: 1,
      ultimoAccesoEn: 1,
    });
    await ctx.db.insert("notionConexion", {
      accessToken: TOKEN,
      botId: "bot",
      workspaceId: "ws",
      workspaceName: "Espacio de prueba",
      conectadoPor: userId,
      conectadoEn: 1,
      bases: [{ id: DB, titulo: "Protocolos" }],
    });
    return userId;
  });
  return t;
}

async function sincronizar(t: T, forzar = true) {
  return await t.action(internal.notion.sync.sincronizar, { propietario: DUENO, forzar });
}

/** El resultado de una corrida que llegó a abrirse (con cifras), o falla. */
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

async function paginas(t: T): Promise<Doc<"notionPaginas">[]> {
  return await t.run((ctx) => ctx.db.query("notionPaginas").collect());
}

async function corridas(t: T): Promise<Doc<"notionSincronizaciones">[]> {
  return await t.run((ctx) => ctx.db.query("notionSincronizaciones").order("desc").collect());
}

async function textoAlmacenado(t: T, doc: Doc<"documents">): Promise<string> {
  // Se lee dentro de `run`: un Blob no es un valor de Convex y no puede salir.
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

/** La dueña de la conexión, con su identidad, para llamar a las funciones
 *  públicas como ella. */
function comoDuena(t: T) {
  return t.withIdentity({ subject: DUENO });
}

async function alta(t: T, email: string, rol: "admin" | "lector") {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", { email, rol, bloqueado: false, creadoEn: Date.now(), ultimoAccesoEn: Date.now() }),
  );
  return t.withIdentity({ subject: id });
}

async function codigoDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (e) {
    const data = (e as { data?: { codigo?: unknown } } | null)?.data;
    if (data && typeof data.codigo === "string") return data.codigo;
    throw e;
  }
  return "ok";
}

beforeEach(() => {
  notion = new NotionFalso();
  configurarPausa(0);
  vi.stubGlobal("fetch", notion.fetch);
  // Ni NOTION_TOKEN ni NOTION_DATABASE_ID: las credenciales salen de la fila
  // de conexión que crea `nuevaBase`.
  vi.stubEnv("NOTION_SYNC_MINUTES", "60");
  vi.stubEnv("NOTION_DELETE_ARCHIVED", "true");
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
// Pruebas
// ---------------------------------------------------------------------------
describe("primera sincronización", () => {
  test("registra el texto largo y el PDF de A, nada de B (corta) ni de C (archivada)", async () => {
    const t = await nuevaBase();
    baseInicial();
    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", paginas: 2, nuevos: 2, actualizados: 0, borrados: 0, errores: [] });

    const docs = await documentos(t);
    expect(docs.map((d) => d.fileName)).toEqual(["guia.pdf", "notion-guia-a-de-p-tau217.md"]);
    for (const d of docs) {
      expect(d.origen).toBe("notion");
      expect(d.notionPageId).toBe("a1");
      expect(d.status).toBe("processing");
      expect(d.storageId).toBeDefined();
    }
    expect(docs[0].sha256).toBe(await sha256Hex(PDF_A));

    // El Markdown que se guardó: título, encabezado, lista y tabla.
    const md = await textoAlmacenado(t, docs[1]);
    expect(md).toContain("# Guía A de p-tau217\n\n## Método\n\n");
    expect(md).toContain("- uno\n\n| Marcador | AUC |\n| --- | --- |\n| p-tau217 | 0,94 |");

    const filas = await paginas(t);
    expect(filas.map((p) => p.pageId).sort()).toEqual(["a1", "b2"]);
    const a = filas.find((p) => p.pageId === "a1")!;
    expect(a.documentIds).toHaveLength(2);
    expect(a.documentoTextoId).toBe(docs[1]._id);
    expect(a.lastEdited).toBe("2026-09-01T10:00:00.000Z");
    expect(filas.find((p) => p.pageId === "b2")!.documentIds).toEqual([]);

    const [corrida] = await corridas(t);
    expect(corrida).toMatchObject({ estado: "ok", paginas: 2, nuevos: 2, terminadoEn: expect.any(Number) });
  });

  test("pagina la base siguiendo next_cursor", async () => {
    const t = await nuevaBase();
    baseInicial();
    notion.tamanoPagina = 1;
    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", paginas: 2 });
    expect(notion.llamadas.filter((l) => l.endsWith("/query"))).toHaveLength(3);
  });
});

describe("segunda sincronización", () => {
  test("sin cambios no lee bloques ni toca documentos", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const antes = await documentos(t);
    notion.llamadas = [];

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", paginas: 2, nuevos: 0, actualizados: 0, borrados: 0 });
    expect(notion.llamadas.some((l) => l.includes("/blocks/"))).toBe(false);
    expect(await documentos(t)).toEqual(antes);
  });

  test("con lastEdited nuevo y texto cambiado reutiliza la MISMA fila del .md", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const [pdfAntes, mdAntes] = await documentos(t);
    await marcarListo(t, mdAntes._id);
    await marcarListo(t, pdfAntes._id);

    const p = notion.paginas.get("a1")!;
    p.pagina.last_edited_time = "2026-09-02T10:00:00.000Z";
    p.bloques = [parrafo(TEXTO_LARGO + " Versión revisada con un párrafo más.")];

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", nuevos: 0, actualizados: 1, borrados: 0 });
    const [pdf, md] = await documentos(t);
    expect(md._id).toBe(mdAntes._id);
    expect(md.fileName).toBe(mdAntes.fileName);
    expect(md.status).toBe("processing");
    expect(md.sha256).not.toBe(mdAntes.sha256);
    expect(md.storageId).not.toBe(mdAntes.storageId);
    // El fichero viejo se retiró del almacenamiento.
    expect(await t.run((ctx) => ctx.db.system.get(mdAntes.storageId!))).toBeNull();
    // El PDF no cambió: mismo sha, no se vuelve a ingerir.
    expect(pdf).toMatchObject({ _id: pdfAntes._id, status: "ready" });
    expect((await paginas(t)).find((x) => x.pageId === "a1")!.lastEdited).toBe("2026-09-02T10:00:00.000Z");
  });

  test("si su dueña borra a mano un documento de Notion, se vuelve a traer aunque la página no cambie", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const [pdf, md] = await documentos(t);
    // Lo borra ELLA: un administrador no puede tocar el corpus de otra
    // persona, y de hecho recibiría `no_encontrado`.
    const admin = await alta(t, "admin@airobotix.net", "admin");
    expect(await codigoDe(admin.mutation(api.documentos.borrar, { documentId: pdf._id }))).toBe("no_encontrado");
    await comoDuena(t).mutation(api.documentos.borrar, { documentId: pdf._id });
    expect(await documentos(t)).toHaveLength(1);

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", nuevos: 1, actualizados: 0 });
    const despues = await documentos(t);
    expect(despues.map((d) => d.fileName)).toEqual(["guia.pdf", md.fileName]);
    // El .md no se tocó: mismo sha, misma fila.
    expect(despues[1]).toMatchObject({ _id: md._id, storageId: md.storageId });
    expect((await paginas(t)).find((p) => p.pageId === "a1")!.documentIds).toHaveLength(2);
  });

  test("lastEdited nuevo pero mismo texto: no se reingiere", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const [, mdAntes] = await documentos(t);
    await marcarListo(t, mdAntes._id);
    notion.paginas.get("a1")!.pagina.last_edited_time = "2026-09-03T10:00:00.000Z";

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", nuevos: 0, actualizados: 0 });
    const [, md] = await documentos(t);
    expect(md).toMatchObject({ _id: mdAntes._id, status: "ready", storageId: mdAntes.storageId });
  });

  test("un texto que baja del mínimo retira el .md; un adjunto quitado retira su documento", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const p = notion.paginas.get("a1")!;
    p.pagina.last_edited_time = "2026-09-04T10:00:00.000Z";
    p.bloques = [parrafo("Ahora casi vacía.")];
    p.pagina.properties.Adjuntos = { type: "files", files: [] };

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", borrados: 2 });
    expect(await documentos(t)).toEqual([]);
    const a = (await paginas(t)).find((x) => x.pageId === "a1")!;
    expect(a.documentIds).toEqual([]);
    expect(a.documentoTextoId).toBeUndefined();
  });
});

describe("adjuntos", () => {
  test("dedupe por sha256: el mismo PDF en otra página no se registra dos veces ni se reclama", async () => {
    const t = await nuevaBase();
    baseInicial();
    notion.pagina("d4", "Duplicada", { adjuntos: [{ name: "copia.pdf", url: "https://s3.notion.example/copia.pdf?s=1" }] });
    notion.fichero("https://s3.notion.example/copia.pdf?s=1", PDF_A);

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", paginas: 3, nuevos: 2 });
    expect((await documentos(t)).map((d) => d.fileName)).toEqual(["guia.pdf", "notion-guia-a-de-p-tau217.md"]);
    expect((await paginas(t)).find((p) => p.pageId === "d4")!.documentIds).toEqual([]);
  });

  test("mismo nombre con contenido distinto: el segundo lleva el slug de su página", async () => {
    const t = await nuevaBase();
    baseInicial();
    // Una subida manual ocupa "otra.pdf" con otro contenido.
    await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO,
        fileName: "otra.pdf",
        sha256: "f".repeat(64),
        pages: 1,
        chunks: 1,
        status: "ready",
        ingestadoEn: Date.now(),
        origen: "subida",
      }),
    );
    notion.pagina("e5", "Segunda guía", { adjuntos: [{ name: "otra.pdf", url: "https://s3.notion.example/otra.pdf?s=2" }] });
    notion.fichero("https://s3.notion.example/otra.pdf?s=2", PDF_B);

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", nuevos: 3 });
    const nombres = (await documentos(t)).map((d) => d.fileName);
    expect(nombres).toContain("otra-segunda-guia.pdf");
    // La subida manual sigue intacta.
    const manual = (await documentos(t)).find((d) => d.fileName === "otra.pdf")!;
    expect(manual).toMatchObject({ status: "ready", origen: "subida" });
  });

  test("una URL firmada caducada se refresca releyendo la página", async () => {
    const t = await nuevaBase();
    baseInicial();
    notion.caducadas.add(URL_PDF_A);
    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", nuevos: 2, errores: [] });
    expect(notion.llamadas.filter((l) => l === "GET /v1/pages/a1")).toHaveLength(1);
  });

  test("extensiones no soportadas no se descargan, y SE DICE en los avisos (antes era un console.log y el adjunto quedaba fuera para siempre sin señal)", async () => {
    const t = await nuevaBase();
    baseInicial();
    notion.pagina("f6", "Con vídeo", { adjuntos: [{ name: "charla.mp4", url: "https://s3.notion.example/charla.mp4" }] });
    notion.fichero("https://s3.notion.example/charla.mp4", new Uint8Array([1, 2, 3]));
    const r = await sincronizar(t);
    if (!("errores" in r)) throw new Error(`esperaba una corrida, fue ${r.estado}`);
    expect(r.errores).toEqual([expect.stringMatching(/Con vídeo: el adjunto 'charla.mp4' es \.mp4.*no se puede indexar/)]);
    expect((await documentos(t)).map((d) => d.fileName)).not.toContain("charla.mp4");
    expect(notion.llamadas).not.toContain("GET /charla.mp4");
    // Y la página no queda marcada con error: en la siguiente corrida sigue
    // intacta y no se vuelve a descargar nada.
    const paginas = await t.run((ctx) => ctx.db.query("notionPaginas").collect());
    expect(paginas.find((p) => p.titulo === "Con vídeo")?.error).toBeUndefined();
  });

  test("ADVERSARIAL: un adjunto que pasa del tope se rechaza con un aviso claro y la sincronización sigue con lo demás", async () => {
    const { MAX_ADJUNTO_BYTES } = await import("./api");
    const t = await nuevaBase();
    baseInicial();
    notion.pagina("g7", "Con escaneo enorme", { adjuntos: [{ name: "escaneo.pdf", url: "https://s3.notion.example/escaneo.pdf" }] });
    // Sin Content-Length (el simulador no lo pone): se corta contando lo leído.
    notion.fichero("https://s3.notion.example/escaneo.pdf", new Uint8Array(MAX_ADJUNTO_BYTES + 1024));
    const r = await sincronizar(t);
    if (!("errores" in r)) throw new Error(`esperaba una corrida, fue ${r.estado}`);
    expect(r.errores).toEqual([expect.stringMatching(/escaneo\.pdf.*máximo desde Notion son 20 MB/)]);
    const [corrida] = await corridas(t);
    expect(corrida.estado).toBe("error");
    // Los demás documentos de la base sí entraron.
    expect((await documentos(t)).length).toBeGreaterThan(0);
    expect((await documentos(t)).map((d) => d.fileName)).not.toContain("escaneo.pdf");
    // La página queda marcada con el error y se reintentará, no se cuelga.
    const paginas = await t.run((ctx) => ctx.db.query("notionPaginas").collect());
    expect(paginas.find((p) => p.titulo === "Con escaneo enorme")?.error).toMatch(/máximo desde Notion/);
  }, 30_000);

  test("una imagen adjunta SÍ se trae: se indexa por OCR en la ingesta", async () => {
    // Antes las imágenes se ignoraban como formato no soportado. Una foto de
    // un protocolo pegada en Notion es corpus desde que hay OCR.
    const t = await nuevaBase();
    baseInicial();
    notion.pagina("f6", "Con imagen", { adjuntos: [{ name: "foto.png", url: "https://s3.notion.example/foto.png" }] });
    notion.fichero("https://s3.notion.example/foto.png", new Uint8Array([1, 2, 3]));
    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", errores: [] });
    expect((await documentos(t)).map((d) => d.fileName)).toContain("foto.png");
  });
});

describe("páginas que desaparecen", () => {
  test("archivar A borra sus documentos con sus fragmentos, su fichero y su fila", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const [pdf, md] = await documentos(t);
    await insertarChunks(t, md, 5);
    notion.paginas.get("a1")!.pagina.archived = true;

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", paginas: 1, borrados: 2 });
    expect(await documentos(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("chunks").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.system.get(md.storageId!))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get(pdf.storageId!))).toBeNull();
    expect((await paginas(t)).map((p) => p.pageId)).toEqual(["b2"]);
  });

  test("marcar Estado = Excluir equivale a sacarla de la base", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    notion.paginas.get("a1")!.pagina.properties.Estado = { type: "select", select: { name: "Excluir" } };
    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", borrados: 2 });
    expect(await documentos(t)).toEqual([]);
  });

  test("un documento que un admin reclamó como subida manual NO se borra al archivar la página", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const [pdf] = await documentos(t);
    // El admin borró guia.pdf y volvió a subirlo a mano: misma fila (como hace
    // `registrar` con un failed) pero ya de origen `subida`.
    await t.run((ctx) => ctx.db.patch(pdf._id, { origen: "subida", notionPageId: undefined, status: "ready" }));
    notion.paginas.get("a1")!.pagina.archived = true;

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", borrados: 1 });
    expect((await documentos(t)).map((d) => d.fileName)).toEqual(["guia.pdf"]);
  });

  test("con NOTION_DELETE_ARCHIVED=false se conservan los documentos y la fila queda marcada", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    vi.stubEnv("NOTION_DELETE_ARCHIVED", "false");
    notion.paginas.delete("a1");

    const r = await sincronizar(t);
    expect(r).toMatchObject({ estado: "ok", borrados: 0 });
    expect(await documentos(t)).toHaveLength(2);
    expect((await paginas(t)).find((p) => p.pageId === "a1")).toMatchObject({ error: "archivada" });
  });
});

describe("errores", () => {
  test("un fallo en una página no para las demás y queda anotado", async () => {
    const t = await nuevaBase();
    baseInicial();
    notion.pagina("g7", "Rota", { bloques: [parrafo(TEXTO_LARGO)] });
    notion.bloquesRotos.add("g7");

    const r = conCifras(await sincronizar(t));
    expect(r.estado).toBe("ok");
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatch(/^Rota: .*404/);
    expect(r.nuevos).toBe(2);
    const rota = (await paginas(t)).find((p) => p.pageId === "g7")!;
    expect(rota.error).toMatch(/404/);
    const [corrida] = await corridas(t);
    expect(corrida.estado).toBe("error");
    expect(corrida.errores).toHaveLength(1);

    // Arreglada, se reintenta aunque lastEdited no cambie.
    notion.bloquesRotos.delete("g7");
    const r2 = await sincronizar(t);
    expect(r2).toMatchObject({ estado: "ok", nuevos: 1, errores: [] });
    expect((await paginas(t)).find((p) => p.pageId === "g7")!.error).toBeUndefined();
  });

  test("un token rechazado cierra la corrida como error con el motivo", async () => {
    const t = await nuevaBase();
    baseInicial();
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("notionConexion").first())!;
      await ctx.db.patch(c._id, { accessToken: "secret_mala" });
    });
    const r = conCifras(await sincronizar(t));
    expect(r.estado).toBe("error");
    expect(r.errores[0]).toMatch(/401/);
    const [corrida] = await corridas(t);
    expect(corrida).toMatchObject({ estado: "error", terminadoEn: expect.any(Number) });
  });
});

describe("autoexclusión", () => {
  test("sin conexión o sin base elegida: apagada, sin corrida registrada", async () => {
    const t = await nuevaBase();
    baseInicial();
    // Conectada pero sin base: no hay nada que traer.
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("notionConexion").first())!;
      await ctx.db.patch(c._id, { bases: [] });
    });
    expect(await sincronizar(t)).toEqual({ estado: "apagado" });
    // Y sin conexión ninguna: tampoco. Ya no hay respaldo por variables de
    // entorno, porque un token del despliegue no tendría dueño.
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("notionConexion").collect()) await ctx.db.delete(c._id);
    });
    expect(await sincronizar(t, true)).toEqual({ estado: "apagado" });
    expect(await corridas(t)).toEqual([]);
    expect(notion.llamadas).toEqual([]);
  });

  test("la sincronización de una persona no ve ni toca el Notion de otra", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    expect(await documentos(t)).toHaveLength(2);

    // Otra cuenta, con su propia conexión al MISMO espacio de Notion y la
    // misma base: sus documentos son suyos, no reutiliza los de la primera.
    const otra = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "otra@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      });
      await ctx.db.insert("notionConexion", {
        accessToken: TOKEN, botId: "bot2", workspaceId: "ws", workspaceName: "Otro",
        conectadoPor: userId, conectadoEn: 1, bases: [{ id: DB, titulo: "Protocolos" }],
      });
      return userId;
    });
    const r = await t.action(internal.notion.sync.sincronizar, { propietario: otra, forzar: true });
    // Dos documentos NUEVOS para ella: el dedupe por sha256 es por corpus.
    expect(r).toMatchObject({ estado: "ok", paginas: 2, nuevos: 2, borrados: 0 });
    const todos = await documentos(t);
    expect(todos).toHaveLength(4);
    expect(todos.filter((d) => d.propietario === DUENO)).toHaveLength(2);
    expect(todos.filter((d) => d.propietario === otra)).toHaveLength(2);
    // Y cada una tiene sus propias filas de página y de corrida.
    const filas = await paginas(t);
    expect(filas.filter((p) => p.propietario === DUENO)).toHaveLength(2);
    expect(filas.filter((p) => p.propietario === otra)).toHaveLength(2);
    expect((await corridas(t)).map((c) => c.propietario).sort()).toEqual([DUENO, otra].sort());
  });

  test("NOTION_SYNC_MINUTES=0 apaga la periódica pero no la manual", async () => {
    const t = await nuevaBase();
    baseInicial();
    vi.stubEnv("NOTION_SYNC_MINUTES", "0");
    expect(await sincronizar(t, false)).toEqual({ estado: "apagado" });
    expect(await corridas(t)).toEqual([]);
    expect(await sincronizar(t, true)).toMatchObject({ estado: "ok" });
  });

  test("la periódica se salta si la última corrida es reciente; la forzada no", async () => {
    const t = await nuevaBase();
    baseInicial();
    expect(await sincronizar(t, false)).toMatchObject({ estado: "ok" });
    expect(await sincronizar(t, false)).toEqual({ estado: "reciente" });
    expect(await sincronizar(t, true)).toMatchObject({ estado: "ok" });
    expect(await corridas(t)).toHaveLength(2);
  });

  test("una corrida running reciente bloquea; una muerta se cierra y se sigue", async () => {
    const t = await nuevaBase();
    baseInicial();
    const viva = await t.run((ctx) =>
      ctx.db.insert("notionSincronizaciones", {
        propietario: DUENO,
        empezadoEn: Date.now(), paginas: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [], estado: "running",
      }),
    );
    expect(await sincronizar(t)).toEqual({ estado: "en_curso" });
    await t.run((ctx) => ctx.db.patch(viva, { empezadoEn: Date.now() - 40 * 60_000 }));
    expect(await sincronizar(t)).toMatchObject({ estado: "ok" });
    const todas = await corridas(t);
    expect(todas).toHaveLength(2);
    expect(todas.find((c) => c._id === viva)).toMatchObject({ estado: "error" });
  });
});

describe("dos bases a la vez", () => {
  async function conDosBases(t: T) {
    await t.run(async (ctx) => {
      const c = await ctx.db.query("notionConexion").first();
      await ctx.db.patch(c!._id, { bases: [{ id: DB, titulo: "Protocolos" }, { id: DB2, titulo: "Tareas" }] });
    });
  }

  test("ADVERSARIAL: terminar la base A no retira nada de la base B, y archivar en A solo borra lo de A", async () => {
    const t = await nuevaBase();
    await conDosBases(t);
    baseInicial();
    notion.pagina("t1", "Tarea larga", { bloques: [parrafo(TEXTO_LARGO)], enBase: DB2 });
    notion.pagina("t2", "Otra tarea", { bloques: [parrafo(`${TEXTO_LARGO} Segunda parte.`)], enBase: DB2 });

    const r1 = conCifras(await sincronizar(t));
    expect(r1.errores).toEqual([]);
    // Los .md se nombran con el título en minúsculas y guiones.
    const nombres1 = (await documentos(t)).map((d) => d.fileName);
    expect(nombres1).toContain("guia.pdf");
    expect(nombres1).toContain("notion-tarea-larga.md");
    expect(nombres1).toContain("notion-otra-tarea.md");
    const paginas = await t.run((ctx) => ctx.db.query("notionPaginas").collect());
    expect(paginas.filter((p) => p.databaseId === DB2).map((p) => p.pageId).sort()).toEqual(["t1", "t2"]);

    // Se archiva la guía de A: sus documentos se van; los de B, intactos.
    notion.paginas.delete("a1");
    const r2 = conCifras(await sincronizar(t));
    expect(r2.borrados).toBeGreaterThan(0);
    const nombres2 = (await documentos(t)).map((d) => d.fileName);
    expect(nombres2).not.toContain("guia.pdf");
    expect(nombres2).not.toContain("notion-guia-a-de-p-tau217.md");
    expect(nombres2).toContain("notion-tarea-larga.md");
    expect(nombres2).toContain("notion-otra-tarea.md");
  });

  test("una base que deja de compartirse (404) no borra nada de ninguna base", async () => {
    const t = await nuevaBase();
    await conDosBases(t);
    baseInicial();
    notion.pagina("t1", "Tarea larga", { bloques: [parrafo(TEXTO_LARGO)], enBase: DB2 });
    conCifras(await sincronizar(t));
    const antes = (await documentos(t)).length;
    expect(antes).toBeGreaterThan(1);

    // La base B desaparece para la integración: Notion responde 404.
    await t.run(async (ctx) => {
      const c = await ctx.db.query("notionConexion").first();
      await ctx.db.patch(c!._id, {
        bases: [{ id: DB, titulo: "Protocolos" }, { id: "00000000000000000000000000000000", titulo: "Perdida" }],
      });
    });
    const r = await sincronizar(t);
    expect(r.estado).not.toBe("ok");
    expect((await documentos(t)).length).toBe(antes);
  });
});

describe("corrida parcial", () => {
  test("ADVERSARIAL: cortada por el reloj tras avanzar se cierra con la verdad y se reagenda en un minuto, sin esperar al cron", async () => {
    const t = await nuevaBase();
    baseInicial();
    // El reloj salta 30 minutos en cuanto se ha leído el cuerpo de la primera
    // página: esa se termina, y la comprobación de tiempo de la siguiente
    // corta la corrida con `procesadas > 0`.
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() =>
      notion.llamadas.some((l) => l.startsWith("GET /v1/blocks/")) ? real() + 30 * 60_000 : real(),
    );
    try {
      const r = await sincronizar(t);
      if (r.estado !== "parcial") throw new Error(`esperaba parcial, fue ${r.estado}`);
      expect(r.errores).toContain("sincronización parcial, continuará en unos minutos");
      const fallosDePagina = r.errores.filter((e: string) => !/^sincronización parcial/.test(e));
      const [corrida] = await corridas(t);
      // El aviso de "parcial" no cuenta como fallo: sin errores de página la
      // corrida es "ok"; con ellos, "error" (antes era "ok" siempre).
      expect(corrida.estado).toBe(fallosDePagina.length > 0 ? "error" : "ok");
      // Reagendada con `forzar`, no a la espera del cron.
      const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const reanudacion = trabajos.filter((j) => j.name.includes("sincronizar"));
      expect(reanudacion.length).toBeGreaterThanOrEqual(1);
      expect(reanudacion[0].args[0]).toMatchObject({ propietario: DUENO, forzar: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("ADVERSARIAL: cortada SIN haber avanzado ninguna página no se reagenda (evita un bucle con una base que no progresa)", async () => {
    const t = await nuevaBase();
    baseInicial();
    // Cada lectura del reloj avanza 25 minutos: la primera comprobación del
    // bucle ya pasa de LIMITE_CORRIDA_MS, antes de procesar ninguna página.
    const real = Date.now();
    let llamadas = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real + (llamadas += 1) * 25 * 60_000);
    try {
      const r = await sincronizar(t);
      if (r.estado !== "parcial") throw new Error(`esperaba parcial, fue ${r.estado}`);
      const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(trabajos.filter((j) => j.name.includes("sincronizar"))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("el panel de cada persona", () => {
  test("sincronizarAhora es de cualquier cuenta CONECTADA, no de los administradores", async () => {
    const t = await nuevaBase();
    // Un administrador sin conexión propia no puede sincronizar nada: no
    // tiene Notion conectado, y el de otra persona no es suyo.
    const admin = await alta(t, "admin@airobotix.net", "admin");
    expect(await codigoDe(admin.mutation(api.notion.admin.sincronizarAhora, {}))).toBe("invalido");
    // La dueña, que es una lectora, sí.
    expect(await comoDuena(t).mutation(api.notion.admin.sincronizarAhora, {})).toEqual({ ok: true });
  });

  test("una corrida en curso de OTRA persona no bloquea la propia", async () => {
    const t = await nuevaBase();
    const otra = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "otra@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("notionSincronizaciones", {
        propietario: otra,
        empezadoEn: Date.now(), paginas: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [], estado: "running",
      }),
    );
    expect(await comoDuena(t).mutation(api.notion.admin.sincronizarAhora, {})).toEqual({ ok: true });

    // La suya sí la bloquea.
    await t.run((ctx) =>
      ctx.db.insert("notionSincronizaciones", {
        propietario: DUENO,
        empezadoEn: Date.now(), paginas: 0, nuevos: 0, actualizados: 0, borrados: 0, errores: [], estado: "running",
      }),
    );
    expect(await codigoDe(comoDuena(t).mutation(api.notion.admin.sincronizarAhora, {}))).toBe("conflicto");
  });

  test("estado no revela el token y solo resume LO SUYO", async () => {
    const t = await nuevaBase();
    baseInicial();
    await sincronizar(t);
    const e = await comoDuena(t).query(api.notion.admin.estado, {});
    expect(e).toMatchObject({
      bases: [{ id: DB, titulo: "Protocolos" }],
      conexion: { workspaceName: "Espacio de prueba" },
      periodicaMinutos: 60,
      paginas: 2,
      paginasConError: 0,
      documentos: 2,
      enCurso: null,
    });
    expect(e.ultimas).toHaveLength(1);
    expect(e.ultimas[0]).toMatchObject({ estado: "ok", paginas: 2, nuevos: 2 });
    expect(JSON.stringify(e)).not.toContain(TOKEN);

    // Un administrador sin conexión ve su propio estado vacío, no el de ella.
    const admin = await alta(t, "admin@airobotix.net", "admin");
    const suyo = await admin.query(api.notion.admin.estado, {});
    expect(suyo).toMatchObject({ conexion: null, bases: [], paginas: 0, documentos: 0, ultimas: [] });
  });

  test("el cron reparte UNA sincronización por cuenta conectada", async () => {
    const t = await nuevaBase();
    // Otra con conexión y base, y una tercera conectada pero sin base: esa no
    // se agenda, porque no hay nada que traer.
    await t.run(async (ctx) => {
      const conBase = await ctx.db.insert("users", {
        email: "otra@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      });
      await ctx.db.insert("notionConexion", {
        accessToken: TOKEN, botId: "b2", workspaceId: "w2", workspaceName: "Otro",
        conectadoPor: conBase, conectadoEn: 1, bases: [{ id: DB, titulo: "Protocolos" }],
      });
      const sinBase = await ctx.db.insert("users", {
        email: "sinbase@airobotix.net", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1,
      });
      await ctx.db.insert("notionConexion", {
        accessToken: TOKEN, botId: "b3", workspaceId: "w3", workspaceName: "Tercero",
        conectadoPor: sinBase, conectadoEn: 1, bases: [],
      });
    });

    expect(await t.mutation(internal.crons.repartirSincronizaciones, {})).toEqual({ agendadas: 2 });
  });
});

describe("registrarDesdeOrigen", () => {
  test("no reutiliza la fila de otra página con el mismo nombre: conflicto", async () => {
    const t = await nuevaBase();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([PDF_B as BlobPart])));
    await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO,
        fileName: "x.pdf", sha256: "a".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: Date.now(), origen: "notion", notionPageId: "otra",
      }),
    );
    const sha = await sha256Hex(PDF_B);
    expect(
      await codigoDe(
        t.mutation(internal.documentos.registrarDesdeOrigen, {
          propietario: DUENO,
          storageId, fileName: "x.pdf", sha256: sha, origen: "notion", notionPageId: "esta",
        }),
      ),
    ).toBe("conflicto");
    // Y la misma validación que la subida: extensión y sha.
    expect(
      await codigoDe(
        t.mutation(internal.documentos.registrarDesdeOrigen, {
          propietario: DUENO,
          storageId, fileName: "x.exe", sha256: sha, origen: "notion",
        }),
      ),
    ).toBe("invalido");
  });

  test("tampoco reutiliza la fila FAILED de otra página: seguiría en la lista de esa página", async () => {
    const t = await nuevaBase();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([PDF_B as BlobPart])));
    const ajena = await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO,
        fileName: "x.pdf", sha256: "a".repeat(64), pages: 0, chunks: 0, status: "failed",
        ingestadoEn: Date.now(), origen: "notion", notionPageId: "otra",
      }),
    );
    expect(
      await codigoDe(
        t.mutation(internal.documentos.registrarDesdeOrigen, {
          propietario: DUENO,
          storageId, fileName: "x.pdf", sha256: await sha256Hex(PDF_B), origen: "notion", notionPageId: "esta",
        }),
      ),
    ).toBe("conflicto");
    expect(await t.run((ctx) => ctx.db.get(ajena))).toMatchObject({ status: "failed", notionPageId: "otra" });
  });

  test("sí reutiliza una subida manual fallida, como hace registrar", async () => {
    const t = await nuevaBase();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([PDF_B as BlobPart])));
    const fallida = await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO,
        fileName: "x.pdf", sha256: "a".repeat(64), pages: 0, chunks: 0, status: "failed",
        ingestadoEn: Date.now(), origen: "subida",
      }),
    );
    const id = await t.mutation(internal.documentos.registrarDesdeOrigen, {
      propietario: DUENO,
      storageId, fileName: "x.pdf", sha256: await sha256Hex(PDF_B), origen: "notion", notionPageId: "esta",
    });
    expect(id).toBe(fallida);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "processing", origen: "notion", notionPageId: "esta" });
    expect(await t.run((ctx) => ctx.db.query("documents").collect())).toHaveLength(1);
  });

  test("la misma página reutiliza su propia fila aunque esté lista: es la versión nueva del fichero", async () => {
    const t = await nuevaBase();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([PDF_B as BlobPart])));
    const propia = await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: DUENO,
        fileName: "x.pdf", sha256: "a".repeat(64), pages: 3, chunks: 9, status: "ready",
        ingestadoEn: Date.now(), origen: "notion", notionPageId: "esta",
      }),
    );
    const id = await t.mutation(internal.documentos.registrarDesdeOrigen, {
      propietario: DUENO,
      storageId, fileName: "x.pdf", sha256: await sha256Hex(PDF_B), origen: "notion", notionPageId: "esta",
    });
    expect(id).toBe(propia);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "processing", pages: 0, chunks: 0, storageId });
  });
});
