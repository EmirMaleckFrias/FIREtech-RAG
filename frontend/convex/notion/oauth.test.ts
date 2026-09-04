/// <reference types="vite/client" />
// La conexión con Notion por OAuth de punta a punta sobre convex-test: el
// botón (`iniciar`), la vuelta de Notion por HTTP (`/notion/callback`), el
// desplegable de bases, la elección, la desconexión, y que la sincronización
// lee la conexión antes que las variables y escribe su avance página a
// página. Notion está simulado parcheando `fetch`: nada sale a la red.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { configurarPausa, type BloqueNotion, type PaginaNotion } from "./api";
import { MENSAJE_NO_HABILITADA, STATE_VIDA_MS } from "./oauth";

vi.mock("../ingesta/pipeline", async () => {
  const { internalAction } = await import("../_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

// Patrón absoluto desde la raíz: ver la nota en ingesta/pipeline.test.ts.
const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const CLIENT_SECRET = "secret_cliente_de_prueba";
const SITIO_CONVEX = "https://gregarious-pony-327.convex.site";
const SITIO_APP = "https://asistente.example";
const TOKEN_OAUTH = "ntn_token_oauth";
const TOKEN_ENTORNO = "secret_entorno";
const DB = "0123456789abcdef0123456789abcdef";
const DB_CON_GUIONES = "01234567-89ab-cdef-0123-456789abcdef";

const TEXTO_LARGO =
  "Este protocolo describe la determinación de p-tau217 en plasma con un ensayo de " +
  "inmunoprecipitación seguido de espectrometría de masas, incluida la preparación de " +
  "muestras, los controles de calidad y los criterios de aceptación de cada lote.";

function t(texto: string) {
  return { type: "text", plain_text: texto, href: null };
}

// ---------------------------------------------------------------------------
// Notion simulado
// ---------------------------------------------------------------------------
interface BaseFalsa {
  id: string;
  titulo: string;
  archived?: boolean;
}

class NotionFalso {
  /** Tokens que acepta la API (Bearer). */
  tokens = new Set<string>([TOKEN_OAUTH]);
  bases: BaseFalsa[] = [];
  paginas = new Map<string, { pagina: PaginaNotion; bloques: BloqueNotion[] }>();
  tamanoPagina = 100;
  llamadas: Array<{ metodo: string; ruta: string; cabeceras: Headers; cuerpo: unknown }> = [];
  /** Respuesta del canje de código, o un status de error. */
  canje: Record<string, unknown> | number = {
    access_token: TOKEN_OAUTH,
    bot_id: "bot-1",
    workspace_id: "ws-1",
    workspace_name: "Clínica Neuro",
    workspace_icon: "https://img.example/icono.png",
    owner: { type: "user", user: { id: "u1" } },
  };
  /** Gancho antes de servir los bloques de una página (para frenar la corrida). */
  antesDeBloques: ((pageId: string) => Promise<void>) | null = null;

  pagina(id: string, titulo: string, bloques: BloqueNotion[] = [parrafo(TEXTO_LARGO)]) {
    this.paginas.set(id, {
      pagina: {
        id,
        last_edited_time: "2026-09-01T10:00:00.000Z",
        archived: false,
        properties: { Nombre: { type: "title", title: [t(titulo)] } },
      },
      bloques,
    });
  }

  private json(cuerpo: unknown, status = 200) {
    return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
  }

  fetch = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const u = new URL(url);
    const metodo = init?.method ?? "GET";
    const cabeceras = new Headers(init?.headers);
    const cuerpo = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    this.llamadas.push({ metodo, ruta: u.pathname, cabeceras, cuerpo });
    if (u.hostname !== "api.notion.com") return new Response("no existe", { status: 404 });

    if (u.pathname === "/v1/oauth/token") {
      if (typeof this.canje === "number") {
        return this.json({ error: "invalid_grant", error_description: "código malo" }, this.canje);
      }
      return this.json(this.canje);
    }

    const bearer = cabeceras.get("Authorization") ?? "";
    if (!bearer.startsWith("Bearer ") || !this.tokens.has(bearer.slice(7))) {
      return this.json({ code: "unauthorized", message: "API token is invalid." }, 401);
    }

    if (u.pathname === "/v1/search") {
      const c = (cuerpo ?? {}) as { start_cursor?: string; filter?: { value?: string } };
      if (c.filter?.value !== "database") return this.json({ code: "invalid_request", message: "filter" }, 400);
      const desde = Number(c.start_cursor ?? "0");
      const trozo = this.bases.slice(desde, desde + this.tamanoPagina);
      const hayMas = desde + this.tamanoPagina < this.bases.length;
      return this.json({
        results: trozo.map((b) => ({
          object: "database",
          id: b.id,
          title: b.titulo ? [t(b.titulo)] : [],
          last_edited_time: "2026-09-02T08:00:00.000Z",
          archived: b.archived ?? false,
        })),
        has_more: hayMas,
        next_cursor: hayMas ? String(desde + this.tamanoPagina) : null,
      });
    }

    const m = u.pathname.match(/^\/v1\/(databases|blocks|pages)\/([^/]+)(?:\/(query|children))?$/);
    if (!m) return this.json({ code: "object_not_found", message: u.pathname }, 404);
    const [, recurso, id, accion] = m;
    if (recurso === "databases" && accion === "query") {
      if (id !== DB_CON_GUIONES) return this.json({ code: "object_not_found", message: "db" }, 404);
      const todas = [...this.paginas.values()].map((p) => p.pagina);
      return this.json({ results: todas, has_more: false, next_cursor: null });
    }
    if (recurso === "pages") {
      const p = this.paginas.get(id);
      return p ? this.json(p.pagina) : this.json({ code: "object_not_found", message: "page" }, 404);
    }
    if (recurso === "blocks" && accion === "children") {
      if (this.antesDeBloques) await this.antesDeBloques(id);
      const p = this.paginas.get(id);
      if (!p) return this.json({ results: [], has_more: false, next_cursor: null });
      return this.json({ results: p.bloques, has_more: false, next_cursor: null });
    }
    return this.json({ code: "object_not_found", message: u.pathname }, 404);
  };
}

let contadorBloques = 0;
function parrafo(texto: string): BloqueNotion {
  contadorBloques += 1;
  return {
    id: `b${String(contadorBloques).padStart(31, "0")}`,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [t(texto)] },
  };
}

// ---------------------------------------------------------------------------
// Arnés
// ---------------------------------------------------------------------------
let notion: NotionFalso;

function nuevaBase(): T {
  return convexTest(schema, modules);
}

async function alta(t: T, email: string, rol: "admin" | "lector") {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", { email, rol, bloqueado: false, creadoEn: Date.now(), ultimoAccesoEn: Date.now() }),
  );
  return { id, como: t.withIdentity({ subject: id }) };
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

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (e) {
    const data = (e as { data?: { mensaje?: unknown } } | null)?.data;
    if (data && typeof data.mensaje === "string") return data.mensaje;
    throw e;
  }
  return "";
}

async function estados(t: T): Promise<Doc<"notionEstadosOauth">[]> {
  return await t.run((ctx) => ctx.db.query("notionEstadosOauth").collect());
}

async function conexiones(t: T): Promise<Doc<"notionConexion">[]> {
  return await t.run((ctx) => ctx.db.query("notionConexion").collect());
}

async function corridas(t: T): Promise<Doc<"notionSincronizaciones">[]> {
  return await t.run((ctx) => ctx.db.query("notionSincronizaciones").order("desc").collect());
}

/** Inserta una conexión ya hecha, como si el callback hubiera pasado. */
async function conectar(t: T, userId: Id<"users">, extra: Partial<Doc<"notionConexion">> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("notionConexion", {
      accessToken: TOKEN_OAUTH,
      botId: "bot-1",
      workspaceId: "ws-1",
      workspaceName: "Clínica Neuro",
      conectadoPor: userId,
      conectadoEn: Date.now(),
      ...extra,
    }),
  );
}

/** Pulsa "Conectar" como admin y devuelve el `state` que quedó guardado. */
async function iniciarComo(admin: ReturnType<T["withIdentity"]>) {
  const { url } = await admin.mutation(api.notion.oauth.iniciar, { origen: `${SITIO_APP}/` });
  return new URL(url).searchParams.get("state")!;
}

async function callback(t: T, query: string): Promise<Response> {
  return await t.fetch(`/notion/callback${query}`, { method: "GET" });
}

function destino(res: Response): string {
  expect(res.status).toBe(302);
  return res.headers.get("Location") ?? "";
}

function llamadasAlCanje() {
  return notion.llamadas.filter((l) => l.ruta === "/v1/oauth/token");
}

beforeEach(() => {
  notion = new NotionFalso();
  configurarPausa(0);
  vi.stubGlobal("fetch", notion.fetch);
  vi.stubEnv("NOTION_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("NOTION_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("CONVEX_SITE_URL", SITIO_CONVEX);
  vi.stubEnv("SITE_URL", SITIO_APP);
  vi.stubEnv("NOTION_TOKEN", "");
  vi.stubEnv("NOTION_DATABASE_ID", "");
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
// 1. Iniciar
// ---------------------------------------------------------------------------
describe("iniciar", () => {
  test("crea un state de 10 minutos y devuelve la URL de autorización de Notion", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const antes = Date.now();
    const { url } = await admin.mutation(api.notion.oauth.iniciar, { origen: `${SITIO_APP}/?x=1` });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("owner")).toBe("user");
    expect(u.searchParams.get("redirect_uri")).toBe(`${SITIO_CONVEX}/notion/callback`);
    const state = u.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // El secreto no viaja en la URL.
    expect(url).not.toContain(CLIENT_SECRET);

    const [fila] = await estados(t);
    expect(fila).toMatchObject({ state, userId: id, origen: SITIO_APP });
    expect(fila.expiraEn - fila.creadoEn).toBe(STATE_VIDA_MS);
    expect(fila.creadoEn).toBeGreaterThanOrEqual(antes);
  });

  test("dos clics dan dos states distintos", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const a = await iniciarComo(admin);
    const b = await iniciarComo(admin);
    expect(a).not.toBe(b);
    expect(await estados(t)).toHaveLength(2);
  });

  test("limpia los states caducados al crear uno nuevo", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await t.run((ctx) =>
      ctx.db.insert("notionEstadosOauth", {
        state: "viejo",
        userId: id,
        creadoEn: Date.now() - 2 * STATE_VIDA_MS,
        expiraEn: Date.now() - STATE_VIDA_MS,
      }),
    );
    const nuevo = await iniciarComo(admin);
    expect((await estados(t)).map((e) => e.state)).toEqual([nuevo]);
  });

  test("sin la integración registrada explica en llano que no está habilitada, sin nombrar variables", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    vi.stubEnv("NOTION_CLIENT_SECRET", "");
    const p = admin.mutation(api.notion.oauth.iniciar, {});
    expect(await codigoDe(p)).toBe("invalido");
    const msg = await mensajeDe(admin.mutation(api.notion.oauth.iniciar, {}));
    expect(msg).toBe(MENSAJE_NO_HABILITADA);
    expect(msg).not.toMatch(/NOTION_|token|variable/i);
    expect(await estados(t)).toEqual([]);
  });

  test("un origen que no sea http(s) no se guarda", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await admin.mutation(api.notion.oauth.iniciar, { origen: "javascript:alert(1)" });
    expect((await estados(t))[0].origen).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Callback
// ---------------------------------------------------------------------------
describe("callback", () => {
  test("con state válido canjea el código, guarda la conexión, consume el state y vuelve con ?notion=conectado", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const state = await iniciarComo(admin);

    const res = await callback(t, `?code=codigo-123&state=${state}`);
    expect(destino(res)).toBe(`${SITIO_APP}/?notion=conectado`);

    // El canje fue como documenta Notion: Basic con id:secreto y el body JSON.
    const [canje] = llamadasAlCanje();
    expect(canje.metodo).toBe("POST");
    expect(canje.cabeceras.get("Authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(canje.cuerpo).toEqual({
      grant_type: "authorization_code",
      code: "codigo-123",
      redirect_uri: `${SITIO_CONVEX}/notion/callback`,
    });

    const [c] = await conexiones(t);
    expect(c).toMatchObject({
      accessToken: TOKEN_OAUTH,
      botId: "bot-1",
      workspaceId: "ws-1",
      workspaceName: "Clínica Neuro",
      workspaceIcon: "https://img.example/icono.png",
      conectadoPor: id,
    });
    expect(c.databaseId).toBeUndefined();
    expect(await estados(t)).toEqual([]);
  });

  test("el mismo state dos veces: la segunda va a error sin hablar con Notion", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const state = await iniciarComo(admin);
    await callback(t, `?code=c1&state=${state}`);
    expect(llamadasAlCanje()).toHaveLength(1);

    const res = await callback(t, `?code=c2&state=${state}`);
    expect(destino(res)).toBe(`${SITIO_APP}/?notion=error&motivo=estado`);
    expect(llamadasAlCanje()).toHaveLength(1);
    expect(await conexiones(t)).toHaveLength(1);
  });

  test("state desconocido, ausente o caducado: error y ninguna llamada a Notion", async () => {
    const t = nuevaBase();
    const { id } = await alta(t, "admin@airobotix.net", "admin");
    expect(destino(await callback(t, "?code=c&state=inventado"))).toBe(`${SITIO_APP}/?notion=error&motivo=estado`);
    expect(destino(await callback(t, "?code=c"))).toBe(`${SITIO_APP}/?notion=error&motivo=estado`);

    await t.run((ctx) =>
      ctx.db.insert("notionEstadosOauth", {
        state: "caducado",
        userId: id,
        creadoEn: Date.now() - 2 * STATE_VIDA_MS,
        expiraEn: Date.now() - 1,
      }),
    );
    expect(destino(await callback(t, "?code=c&state=caducado"))).toBe(`${SITIO_APP}/?notion=error&motivo=estado`);
    // Y el caducado se consumió igual: ya no se puede volver a probar.
    expect(await estados(t)).toEqual([]);
    expect(notion.llamadas).toEqual([]);
    expect(await conexiones(t)).toEqual([]);
  });

  test("la usuaria cancela en Notion (access_denied): vuelve con ?notion=cancelado", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const state = await iniciarComo(admin);
    const res = await callback(t, `?error=access_denied&state=${state}`);
    expect(destino(res)).toBe(`${SITIO_APP}/?notion=cancelado`);
    expect(notion.llamadas).toEqual([]);
    expect(await estados(t)).toEqual([]);
    expect(await conexiones(t)).toEqual([]);
  });

  test("si Notion rechaza el canje, error con un código corto y sin conexión guardada", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const state = await iniciarComo(admin);
    notion.canje = 400;
    const res = await callback(t, `?code=malo&state=${state}`);
    const loc = destino(res);
    expect(loc).toBe(`${SITIO_APP}/?notion=error&motivo=intercambio`);
    // Ni el detalle técnico ni el secreto viajan al navegador.
    expect(loc).not.toMatch(/invalid_grant|código malo/);
    expect(await conexiones(t)).toEqual([]);
  });

  test("una respuesta sin access_token no se guarda", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    const state = await iniciarComo(admin);
    notion.canje = { bot_id: "x", workspace_id: "ws" };
    expect(destino(await callback(t, `?code=c&state=${state}`))).toBe(`${SITIO_APP}/?notion=error&motivo=respuesta`);
    expect(await conexiones(t)).toEqual([]);
  });

  test("conectar de nuevo reemplaza la fila: conserva la base si es el mismo espacio y la olvida si es otro", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id, { accessToken: "viejo", databaseId: DB, databaseTitulo: "Protocolos" });

    let state = await iniciarComo(admin);
    await callback(t, `?code=c&state=${state}`);
    let filas = await conexiones(t);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ accessToken: TOKEN_OAUTH, databaseId: DB, databaseTitulo: "Protocolos" });

    notion.canje = { ...(notion.canje as Record<string, unknown>), workspace_id: "ws-otro", workspace_name: "Otro" };
    state = await iniciarComo(admin);
    await callback(t, `?code=c&state=${state}`);
    filas = await conexiones(t);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ workspaceId: "ws-otro", workspaceName: "Otro" });
    expect(filas[0].databaseId).toBeUndefined();
  });

  test("sin SITE_URL vuelve al origen desde el que se pulsó; sin ninguno, una página que dice que vuelva", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    vi.stubEnv("SITE_URL", "");
    const state = await iniciarComo(admin);
    expect(destino(await callback(t, `?code=c&state=${state}`))).toBe(`${SITIO_APP}/?notion=conectado`);

    const { url } = await admin.mutation(api.notion.oauth.iniciar, {});
    const sinOrigen = new URL(url).searchParams.get("state")!;
    const res = await callback(t, `?code=c&state=${sinOrigen}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("volver a la aplicación");
  });

  test("un nombre de espacio vacío recibe un texto con sentido y un icono ausente no se guarda", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    notion.canje = { access_token: TOKEN_OAUTH, bot_id: "b", workspace_id: "ws", workspace_name: null, workspace_icon: null };
    const state = await iniciarComo(admin);
    await callback(t, `?code=c&state=${state}`);
    const [c] = await conexiones(t);
    expect(c.workspaceName).toBe("tu espacio de Notion");
    expect(c.workspaceIcon).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Bases, elección, desconexión
// ---------------------------------------------------------------------------
describe("listarBases", () => {
  test("pagina la búsqueda, devuelve título e id normalizado y salta las archivadas", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id);
    notion.bases = [
      { id: DB_CON_GUIONES, titulo: "Protocolos clínicos" },
      { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", titulo: "" },
      { id: "ffffffff-0000-1111-2222-333333333333", titulo: "Archivada", archived: true },
      { id: "12345678-1234-1234-1234-123456789abc", titulo: "Guías" },
    ];
    notion.tamanoPagina = 2;

    const bases = await admin.action(api.notion.oauth.listarBases, {});
    expect(bases).toEqual([
      { id: DB, titulo: "Protocolos clínicos", ultimaEdicion: "2026-09-02T08:00:00.000Z" },
      { id: "aaaaaaaabbbbccccddddeeeeeeeeeeee", titulo: "Sin título", ultimaEdicion: "2026-09-02T08:00:00.000Z" },
      { id: "12345678123412341234123456789abc", titulo: "Guías", ultimaEdicion: "2026-09-02T08:00:00.000Z" },
    ]);
    const busquedas = notion.llamadas.filter((l) => l.ruta === "/v1/search");
    expect(busquedas).toHaveLength(2);
    expect(busquedas[0].cabeceras.get("Authorization")).toBe(`Bearer ${TOKEN_OAUTH}`);
    expect((busquedas[0].cuerpo as { filter: unknown }).filter).toEqual({ value: "database", property: "object" });
  });

  test("sin conexión avisa; con Notion caído, un mensaje llano", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    expect(await codigoDe(admin.action(api.notion.oauth.listarBases, {}))).toBe("invalido");
    await conectar(t, id, { accessToken: "revocado" });
    const msg = await mensajeDe(admin.action(api.notion.oauth.listarBases, {}));
    expect(msg).toMatch(/No se pudo leer la lista/);
    expect(msg).not.toMatch(/401|token/i);
  });
});

describe("elegirBase y desconectar", () => {
  test("elegirBase guarda el id normalizado y el título; acepta la URL pegada", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id);
    await admin.mutation(api.notion.oauth.elegirBase, {
      databaseId: `https://www.notion.so/equipo/Protocolos-${DB}?v=1`,
      titulo: "  Protocolos clínicos ",
    });
    expect((await conexiones(t))[0]).toMatchObject({ databaseId: DB, databaseTitulo: "Protocolos clínicos" });
  });

  test("elegirBase sin conexión o con un id que no lo es: invalido", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    expect(await codigoDe(admin.mutation(api.notion.oauth.elegirBase, { databaseId: DB, titulo: "x" }))).toBe("invalido");
    await conectar(t, id);
    expect(await codigoDe(admin.mutation(api.notion.oauth.elegirBase, { databaseId: "no-es-un-id", titulo: "x" }))).toBe("invalido");
    expect((await conexiones(t))[0].databaseId).toBeUndefined();
  });

  test("desconectar borra la conexión y los states pendientes, y conserva el corpus", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id, { databaseId: DB });
    await iniciarComo(admin);
    await t.run((ctx) =>
      ctx.db.insert("documents", {
        fileName: "notion-x.md", sha256: "a".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: Date.now(), origen: "notion", notionPageId: "p1",
      }),
    );
    expect(await admin.mutation(api.notion.oauth.desconectar, {})).toEqual({ ok: true });
    expect(await conexiones(t)).toEqual([]);
    expect(await estados(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("documents").collect())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Permisos
// ---------------------------------------------------------------------------
describe("permisos", () => {
  test("un lector recibe solo_admin en todas las funciones de administración", async () => {
    const t = nuevaBase();
    const { id } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id, { databaseId: DB });
    const { como: lector } = await alta(t, "lector@airobotix.net", "lector");
    expect(await codigoDe(lector.mutation(api.notion.oauth.iniciar, {}))).toBe("solo_admin");
    expect(await codigoDe(lector.action(api.notion.oauth.listarBases, {}))).toBe("solo_admin");
    expect(await codigoDe(lector.mutation(api.notion.oauth.elegirBase, { databaseId: DB, titulo: "x" }))).toBe("solo_admin");
    expect(await codigoDe(lector.mutation(api.notion.oauth.desconectar, {}))).toBe("solo_admin");
    expect(await codigoDe(lector.mutation(api.notion.admin.sincronizarAhora, {}))).toBe("solo_admin");
    expect(await codigoDe(lector.query(api.notion.admin.estado, {}))).toBe("solo_admin");
    // Nada cambió por intentarlo.
    expect(await conexiones(t)).toHaveLength(1);
    expect(await estados(t)).toEqual([]);
    expect(notion.llamadas).toEqual([]);
  });

  test("sin sesión: no_autenticado", async () => {
    const t = nuevaBase();
    expect(await codigoDe(t.mutation(api.notion.oauth.iniciar, {}))).toBe("no_autenticado");
    expect(await codigoDe(t.query(api.notion.admin.estado, {}))).toBe("no_autenticado");
  });
});

// ---------------------------------------------------------------------------
// 5. Sincronización: credenciales y progreso
// ---------------------------------------------------------------------------
describe("sincronizar con la conexión", () => {
  test("lee el token de la conexión antes que el de las variables", async () => {
    const t = nuevaBase();
    const { id } = await alta(t, "admin@airobotix.net", "admin");
    // Las variables llevan un token que Notion NO acepta: si la corrida sale
    // bien es porque usó el de la conexión.
    vi.stubEnv("NOTION_TOKEN", TOKEN_ENTORNO);
    vi.stubEnv("NOTION_DATABASE_ID", "ffffffffffffffffffffffffffffffff");
    await conectar(t, id, { databaseId: DB });
    notion.pagina("p1", "Protocolo uno");

    const r = await t.action(internal.notion.sync.sincronizar, { forzar: true });
    expect(r).toMatchObject({ estado: "ok", paginas: 1, nuevos: 1 });
    const bearers = notion.llamadas.map((l) => l.cabeceras.get("Authorization"));
    expect(bearers.every((b) => b === `Bearer ${TOKEN_OAUTH}`)).toBe(true);
  });

  test("con conexión pero sin base elegida usa la base de la variable; sin ninguna, apagada", async () => {
    const t = nuevaBase();
    const { id } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id);
    notion.pagina("p1", "Protocolo uno");
    expect(await t.action(internal.notion.sync.sincronizar, { forzar: true })).toEqual({ estado: "apagado" });
    expect(await corridas(t)).toEqual([]);

    vi.stubEnv("NOTION_DATABASE_ID", DB);
    expect(await t.action(internal.notion.sync.sincronizar, { forzar: true })).toMatchObject({ estado: "ok", paginas: 1 });
  });

  test("sin conexión sigue funcionando con las variables (compatibilidad)", async () => {
    const t = nuevaBase();
    vi.stubEnv("NOTION_TOKEN", TOKEN_ENTORNO);
    vi.stubEnv("NOTION_DATABASE_ID", DB);
    notion.tokens.add(TOKEN_ENTORNO);
    notion.pagina("p1", "Protocolo uno");
    expect(await t.action(internal.notion.sync.sincronizar, { forzar: true })).toMatchObject({ estado: "ok", paginas: 1 });
  });

  test("escribe el avance página a página en la fila running y lo limpia al cerrar", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, id, { databaseId: DB, databaseTitulo: "Protocolos" });
    notion.pagina("p1", "Protocolo uno");
    notion.pagina("p2", "Protocolo dos");
    notion.pagina("p3", "Protocolo tres");

    // Notion "tarda" en servir los bloques de la segunda página: mientras
    // espera, se mira la fila running como la vería la UI.
    let abrir!: () => void;
    const puerta = new Promise<void>((r) => (abrir = r));
    let avisar!: () => void;
    const llegada = new Promise<void>((r) => (avisar = r));
    notion.antesDeBloques = async (pageId) => {
      if (pageId !== "p2") return;
      avisar();
      await puerta;
    };

    const corriendo = t.action(internal.notion.sync.sincronizar, { forzar: true });
    await llegada;
    const [enCurso] = await corridas(t);
    expect(enCurso).toMatchObject({
      estado: "running",
      paginasTotal: 3,
      paginasProcesadas: 1,
      paginaActual: "Protocolo dos",
      // `paginas` cuenta también la que se está mirando; `nuevos` solo lo
      // ya registrado (la primera).
      paginas: 2,
      nuevos: 1,
    });
    // Y `estado` se lo cuenta a la UI tal cual, sin el token.
    const e = await admin.query(api.notion.admin.estado, {});
    expect(e.enCurso).toMatchObject({ paginasTotal: 3, paginasProcesadas: 1, paginaActual: "Protocolo dos", nuevos: 1 });
    expect(e.conexion).toMatchObject({ workspaceName: "Clínica Neuro" });
    expect(e.base).toEqual({ id: DB, titulo: "Protocolos", elegidaEnApp: true });
    expect(JSON.stringify(e)).not.toContain(TOKEN_OAUTH);

    abrir();
    expect(await corriendo).toMatchObject({ estado: "ok", paginas: 3, nuevos: 3 });
    const [cerrada] = await corridas(t);
    expect(cerrada).toMatchObject({ estado: "ok", paginasTotal: 3, paginasProcesadas: 2, nuevos: 3 });
    expect(cerrada.paginaActual).toBeUndefined();
    expect((await admin.query(api.notion.admin.estado, {})).enCurso).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Estado y sincronizarAhora
// ---------------------------------------------------------------------------
describe("estado", () => {
  test("sin integración ni conexión: no habilitada, sin conexión ni base", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    vi.stubEnv("NOTION_CLIENT_ID", "");
    const e = await admin.query(api.notion.admin.estado, {});
    expect(e).toMatchObject({ habilitada: false, conexion: null, base: null, porEntorno: false, enCurso: null, documentos: 0 });
    expect(JSON.stringify(e)).not.toContain(CLIENT_SECRET);
  });

  test("habilitada sin conexión; conectada sin base; con base por variable preseleccionada", async () => {
    const t = nuevaBase();
    const { id, como: admin } = await alta(t, "admin@airobotix.net", "admin");
    expect(await admin.query(api.notion.admin.estado, {})).toMatchObject({ habilitada: true, conexion: null, base: null });

    await conectar(t, id, { workspaceIcon: "https://img.example/i.png" });
    let e = await admin.query(api.notion.admin.estado, {});
    expect(e.conexion).toMatchObject({ workspaceName: "Clínica Neuro", workspaceIcon: "https://img.example/i.png" });
    expect(e.base).toBeNull();
    expect(await codigoDe(admin.mutation(api.notion.admin.sincronizarAhora, {}))).toBe("invalido");

    vi.stubEnv("NOTION_DATABASE_ID", DB);
    e = await admin.query(api.notion.admin.estado, {});
    expect(e.base).toEqual({ id: DB, titulo: null, elegidaEnApp: false });
    expect(e.porEntorno).toBe(false);
    expect(await admin.mutation(api.notion.admin.sincronizarAhora, {})).toEqual({ ok: true });
  });

  test("solo variables (primera versión): porEntorno", async () => {
    const t = nuevaBase();
    const { como: admin } = await alta(t, "admin@airobotix.net", "admin");
    vi.stubEnv("NOTION_TOKEN", TOKEN_ENTORNO);
    vi.stubEnv("NOTION_DATABASE_ID", DB);
    const e = await admin.query(api.notion.admin.estado, {});
    expect(e).toMatchObject({ conexion: null, porEntorno: true, base: { id: DB, elegidaEnApp: false } });
    expect(JSON.stringify(e)).not.toContain(TOKEN_ENTORNO);
  });
});
