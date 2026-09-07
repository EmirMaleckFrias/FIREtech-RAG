/// <reference types="vite/client" />
// La conexión con Google Drive y OneDrive por OAuth de punta a punta sobre
// convex-test: el botón (`iniciar`), la vuelta por HTTP (`/google/callback`,
// `/onedrive/callback`), la renovación de tokens, la lista de carpetas, la
// elección, la desconexión y los permisos. Los proveedores están simulados
// parcheando `fetch` (nubeFalsa.test-util.ts): nada sale a la red.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { NubeFalsa, REFRESH, REFRESH2, TOKEN, TOKEN2 } from "./nubeFalsa.test-util";
import { MAX_CARPETAS, STATE_VIDA_MS, tokenVigente } from "./oauth";
import { configurarEspera, type Proveedor } from "./proveedores";

vi.mock("../ingesta/pipeline", async () => {
  const { internalAction } = await import("../_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

const SITIO_CONVEX = "https://gregarious-pony-327.convex.site";
const SITIO_APP = "https://asistente.example";

let nube: NubeFalsa;

function nuevaBase(): T {
  return convexTest(schema, modules);
}

async function alta(t: T, email: string, rol: "admin" | "lector" = "lector") {
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
    if (e instanceof Error) return e.message;
    throw e;
  }
  return "";
}

async function estados(t: T): Promise<Doc<"nubeEstadosOauth">[]> {
  return await t.run((ctx) => ctx.db.query("nubeEstadosOauth").collect());
}

async function conexiones(t: T): Promise<Doc<"nubeConexion">[]> {
  return await t.run((ctx) => ctx.db.query("nubeConexion").collect());
}

/** Inserta una conexión ya hecha, como si el callback hubiera pasado. */
async function conectar(t: T, userId: Id<"users">, proveedor: Proveedor, extra: Partial<Doc<"nubeConexion">> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("nubeConexion", {
      proveedor,
      accessToken: TOKEN,
      refreshToken: REFRESH,
      expiraEn: Date.now() + 3600_000,
      cuentaId: "perm-1",
      cuentaNombre: "Dra. Neuro",
      conectadoPor: userId,
      conectadoEn: Date.now(),
      carpetas: [],
      ...extra,
    }),
  );
}

async function iniciarComo(como: ReturnType<T["withIdentity"]>, proveedor: Proveedor) {
  const { url } = await como.mutation(api.nube.oauth.iniciar, { proveedor, origen: `${SITIO_APP}/` });
  return new URL(url);
}

async function callback(t: T, proveedor: Proveedor, query: string): Promise<Response> {
  return await t.fetch(`/${proveedor}/callback${query}`, { method: "GET" });
}

function destino(res: Response): URL {
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location") ?? "");
}

beforeEach(() => {
  nube = new NubeFalsa();
  configurarEspera(0);
  vi.stubGlobal("fetch", nube.fetch);
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-cliente.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "GOCSPX-prueba");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "11111111-2222-3333-4444-555555555555");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "secreto-ms-prueba");
  vi.stubEnv("CONVEX_SITE_URL", SITIO_CONVEX);
  vi.stubEnv("SITE_URL", SITIO_APP);
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
  test("Google: URL de Google con permiso de solo lectura, acceso sin conexión y state de 10 minutos", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    const antes = Date.now();
    const url = await iniciarComo(como, "google");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-cliente.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITIO_CONVEX}/google/callback`);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
    // Sin esto Google no devuelve refresh token y la conexión moriría en una hora.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const [fila] = await estados(t);
    expect(fila).toMatchObject({ state, proveedor: "google", userId: id, origen: SITIO_APP });
    expect(fila.expiraEn - antes).toBeGreaterThanOrEqual(STATE_VIDA_MS - 50);
  });

  test("OneDrive: URL de Microsoft con offline_access y lectura de ficheros", async () => {
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const url = await iniciarComo(como, "onedrive");
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITIO_CONVEX}/onedrive/callback`);
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("offline_access");
    expect(scope).toContain("Files.Read.All");
    expect(scope).not.toMatch(/ReadWrite/);
    expect((await estados(t))[0].proveedor).toBe("onedrive");
  });

  test("cada proveedor se habilita por su cuenta, y el mensaje va en llano sin nombrar variables", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const msg = await mensajeDe(como.mutation(api.nube.oauth.iniciar, { proveedor: "google" }));
    expect(msg).toBe("La conexión con Google Drive aún no está habilitada por el equipo técnico.");
    expect(msg).not.toMatch(/GOOGLE_|CLIENT|variable/i);
    // OneDrive sigue funcionando.
    await iniciarComo(como, "onedrive");
    expect(await estados(t)).toHaveLength(1);
  });

  test("dos clics dan dos states distintos y se limpian los caducados", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await t.run((ctx) =>
      ctx.db.insert("nubeEstadosOauth", {
        state: "viejo", proveedor: "google", userId: id, creadoEn: 1, expiraEn: Date.now() - 1,
      }),
    );
    const a = (await iniciarComo(como, "google")).searchParams.get("state");
    const b = (await iniciarComo(como, "google")).searchParams.get("state");
    expect(a).not.toBe(b);
    expect((await estados(t)).map((e) => e.state).sort()).toEqual([a, b].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Callback
// ---------------------------------------------------------------------------
describe("callback", () => {
  test("Google: canjea el código (formulario con secreto y redirect_uri), lee la cuenta, guarda tokens y vuelve conectado", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    const state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    const antes = Date.now();
    const res = await callback(t, "google", `?code=cod-1&state=${state}`);
    const u = destino(res);
    expect(u.origin).toBe(SITIO_APP);
    expect(u.searchParams.get("nube")).toBe("google");
    expect(u.searchParams.get("resultado")).toBe("conectado");

    const [form] = nube.peticionesToken;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("cod-1");
    expect(form.get("redirect_uri")).toBe(`${SITIO_CONVEX}/google/callback`);
    expect(form.get("client_secret")).toBe("GOCSPX-prueba");

    const [c] = await conexiones(t);
    expect(c).toMatchObject({
      proveedor: "google",
      accessToken: TOKEN,
      refreshToken: REFRESH,
      cuentaId: "perm-1",
      cuentaNombre: "Dra. Neuro",
      cuentaCorreo: "neuro@clinica.example",
      cuentaImagen: "https://img.example/foto.png",
      conectadoPor: id,
      carpetas: [],
    });
    expect(c.expiraEn - antes).toBeGreaterThanOrEqual(3600_000 - 1000);
    expect(await estados(t)).toEqual([]);
  });

  test("OneDrive: el canje lleva el scope, la cuenta sale de /me", async () => {
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const state = (await iniciarComo(como, "onedrive")).searchParams.get("state")!;
    destino(await callback(t, "onedrive", `?code=cod-2&state=${state}`));
    const [form] = nube.peticionesToken;
    expect(form.get("scope")).toContain("offline_access");
    const [c] = await conexiones(t);
    expect(c).toMatchObject({ proveedor: "onedrive", cuentaId: "ms-user-1", cuentaNombre: "Dra. Neuro" });
    expect(c.cuentaImagen).toBeUndefined();
  });

  test("ADVERSARIAL: un state de Google no vale en el callback de OneDrive, y se consume igual", async () => {
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    const u = destino(await callback(t, "onedrive", `?code=cod-1&state=${state}`));
    expect(u.searchParams.get("resultado")).toBe("error");
    expect(u.searchParams.get("motivo")).toBe("estado");
    expect(nube.peticionesToken).toHaveLength(0);
    expect(await estados(t)).toEqual([]);
    // Y ya no sirve tampoco para Google.
    const u2 = destino(await callback(t, "google", `?code=cod-1&state=${state}`));
    expect(u2.searchParams.get("motivo")).toBe("estado");
    expect(await conexiones(t)).toEqual([]);
  });

  test("state desconocido, ausente o caducado: error y ninguna llamada al proveedor", async () => {
    const t = nuevaBase();
    const { id } = await alta(t, "ana@airobotix.net");
    expect(destino(await callback(t, "google", "?code=x&state=nadie")).searchParams.get("motivo")).toBe("estado");
    expect(destino(await callback(t, "google", "?code=x")).searchParams.get("motivo")).toBe("estado");
    await t.run((ctx) =>
      ctx.db.insert("nubeEstadosOauth", {
        state: "caduco", proveedor: "google", userId: id, creadoEn: 1, expiraEn: Date.now() - 1,
      }),
    );
    expect(destino(await callback(t, "google", "?code=x&state=caduco")).searchParams.get("motivo")).toBe("estado");
    expect(nube.peticionesToken).toHaveLength(0);
  });

  test("la usuaria cancela (access_denied): vuelve con resultado=cancelado", async () => {
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const state = (await iniciarComo(como, "onedrive")).searchParams.get("state")!;
    const u = destino(await callback(t, "onedrive", `?error=access_denied&state=${state}`));
    expect(u.searchParams.get("resultado")).toBe("cancelado");
    expect(await conexiones(t)).toEqual([]);
  });

  test("si el proveedor rechaza el canje: error con código corto y sin conexión guardada", async () => {
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    nube.canje = 400;
    const state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    const u = destino(await callback(t, "google", `?code=malo&state=${state}`));
    expect(u.searchParams.get("motivo")).toBe("intercambio");
    expect(await conexiones(t)).toEqual([]);
  });

  test("reconectar la MISMA cuenta conserva las carpetas y el refresh token si Google no manda otro; otra cuenta las olvida", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google", { carpetas: [{ id: "F1", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" }] });
    // Google no repite el refresh token en un segundo consentimiento.
    nube.canje = { access_token: TOKEN2, expires_in: 3600 };
    nube.tokens.add(TOKEN2);
    let state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    destino(await callback(t, "google", `?code=c&state=${state}`));
    let [c] = await conexiones(t);
    expect(c.carpetas.map((x) => x.id)).toEqual(["F1"]);
    expect(c.refreshToken).toBe(REFRESH);
    expect(c.accessToken).toBe(TOKEN2);

    nube.cuenta = { nombre: "Otra", correo: "otra@example.org" };
    // La cuenta se identifica por permissionId, que el simulador fija: se
    // cambia la respuesta de /about con otro id.
    const original = nube.fetch;
    vi.stubGlobal("fetch", async (e: RequestInfo | URL, i?: RequestInit) => {
      const res = await original(e, i);
      const url = typeof e === "string" ? e : e instanceof URL ? e.href : e.url;
      if (url.includes("/drive/v3/about")) {
        return new Response(JSON.stringify({ user: { displayName: "Otra", emailAddress: "otra@example.org", permissionId: "perm-2" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    });
    state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    destino(await callback(t, "google", `?code=c&state=${state}`));
    [c] = await conexiones(t);
    expect(c.cuentaId).toBe("perm-2");
    expect(c.carpetas).toEqual([]);
    expect(await conexiones(t)).toHaveLength(1);
  });

  test("sin SITE_URL vuelve al origen desde el que se pulsó; sin ninguno, una página que dice que vuelva", async () => {
    vi.stubEnv("SITE_URL", "");
    const t = nuevaBase();
    const { como } = await alta(t, "ana@airobotix.net");
    const state = (await iniciarComo(como, "google")).searchParams.get("state")!;
    expect(destino(await callback(t, "google", `?code=c&state=${state}`)).origin).toBe(SITIO_APP);
    const res = await callback(t, "google", "?code=c&state=nadie");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Vuelve a la aplicación/);
  });
});

// ---------------------------------------------------------------------------
// 3. Tokens que caducan
// ---------------------------------------------------------------------------
describe("tokenVigente", () => {
  async function conCtx<R>(t: T, f: (ctx: Parameters<typeof tokenVigente>[0]) => Promise<R>): Promise<R> {
    // `tokenVigente` necesita un ActionCtx; el de una acción interna vale.
    return await t.run(async () => {
      throw new Error("no se usa");
    }).catch(async () => {
      // convex-test no expone un ActionCtx suelto: se pasa por una acción
      // real que lo llame. Ver `listarCarpetas`, que es la que lo usa.
      return await f(null as never);
    });
  }
  void conCtx;

  test("con el token fresco no se habla con el punto de token", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google");
    await como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" });
    expect(nube.renovaciones()).toBe(0);
  });

  test("a punto de caducar: se renueva, se guarda el nuevo y Google conserva el refresh token", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google", { expiraEn: Date.now() + 30_000 });
    await como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" });
    expect(nube.renovaciones()).toBe(1);
    const [c] = await conexiones(t);
    expect(c.accessToken).toBe(TOKEN2);
    expect(c.refreshToken).toBe(REFRESH);
    expect(c.expiraEn).toBeGreaterThan(Date.now() + 3000_000);
    // Y la lista se pidió ya con el nuevo.
    expect(nube.llamadas.some((l) => l.includes("/drive/v3/files"))).toBe(true);
  });

  test("Microsoft rota el refresh token: se guarda el nuevo y el viejo deja de usarse", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    nube.rotarRefresh = true;
    await conectar(t, id, "onedrive", { expiraEn: Date.now() - 1 });
    await como.action(api.nube.oauth.listarCarpetas, { proveedor: "onedrive" });
    const [c] = await conexiones(t);
    expect(c.refreshToken).toBe(REFRESH2);
    // Segunda renovación forzada con el token rotado: funciona.
    await t.run((ctx) => ctx.db.patch(c._id, { expiraEn: Date.now() - 1 }));
    await como.action(api.nube.oauth.listarCarpetas, { proveedor: "onedrive" });
    expect(nube.renovaciones()).toBe(2);
    expect(nube.peticionesToken[1].get("refresh_token")).toBe(REFRESH2);
  });

  test("ADVERSARIAL: renovación rechazada (permiso revocado) marca la conexión y lo dice en llano; no borra nada", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    nube.refreshTokens.clear();
    await conectar(t, id, "google", {
      expiraEn: Date.now() - 1,
      carpetas: [{ id: "F1", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" }],
    });
    const msg = await mensajeDe(como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" }));
    expect(msg).toMatch(/Vuelve a conectar/);
    expect(msg).not.toMatch(/token|refresh|grant/i);
    const [c] = await conexiones(t);
    expect(c.necesitaReconexion).toBe(true);
    expect(c.carpetas).toHaveLength(1);
    const estado = await como.query(api.nube.admin.estado, { proveedor: "google" });
    expect(estado.conexion?.necesitaReconexion).toBe(true);
    // Un fallo TRANSITORIO del punto de token (5xx) no marca nada.
    await t.run((ctx) => ctx.db.patch(c._id, { necesitaReconexion: undefined }));
    const original = nube.fetch;
    vi.stubGlobal("fetch", async (e: RequestInfo | URL, i?: RequestInit) => {
      const url = typeof e === "string" ? e : e instanceof URL ? e.href : e.url;
      if (url.includes("oauth2.googleapis.com/token")) return new Response("caído", { status: 503 });
      return await original(e, i);
    });
    await mensajeDe(como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" }));
    expect((await conexiones(t))[0].necesitaReconexion).toBeUndefined();
  });

  test("sin refresh token guardado no hay renovación posible: reconexión", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google", { expiraEn: Date.now() - 1, refreshToken: undefined });
    await mensajeDe(como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" }));
    expect((await conexiones(t))[0].necesitaReconexion).toBe(true);
    expect(nube.renovaciones()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Carpetas
// ---------------------------------------------------------------------------
describe("listarCarpetas", () => {
  test("Google: Mi unidad, las unidades compartidas y las carpetas con su ruta, ordenadas", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google");
    nube.carpeta("F1", "Clínica");
    nube.carpeta("F2", "Protocolos", "F1");
    nube.carpeta("F3", "Suelta", "desconocida");
    nube.unidadesCompartidas.push({ id: "D1", nombre: "Neurología" });
    const lista = await como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" });
    expect(lista).toEqual([
      { id: "root", nombre: "Mi unidad", ruta: "Mi unidad" },
      { id: "F1", nombre: "Clínica", ruta: "Mi unidad / Clínica" },
      { id: "F2", nombre: "Protocolos", ruta: "Mi unidad / Clínica / Protocolos" },
      // Compartida suelta: su padre no está en la lista, la ruta empieza en ella.
      { id: "F3", nombre: "Suelta", ruta: "Suelta" },
      { id: "D1", nombre: "Unidad compartida: Neurología", ruta: "Unidad compartida: Neurología" },
    ]);
  });

  test("OneDrive: la raíz, hasta tres niveles, y lo compartido conmigo con id compuesto de su unidad", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "onedrive");
    nube.carpeta("A", "Clínica");
    nube.carpeta("B", "Protocolos", "A");
    nube.carpeta("C", "2026", "B");
    nube.carpeta("D", "Muy hondo", "C");
    nube.compartidasConmigo.push({ id: "X1", nombre: "De la colega", padre: null, driveId: "DRIVE-COLEGA" });
    const lista = await como.action(api.nube.oauth.listarCarpetas, { proveedor: "onedrive" });
    expect(lista).toEqual([
      { id: "root", nombre: "Todo mi OneDrive", ruta: "Mi OneDrive" },
      { id: "A", nombre: "Clínica", ruta: "Mi OneDrive / Clínica" },
      { id: "B", nombre: "Protocolos", ruta: "Mi OneDrive / Clínica / Protocolos" },
      { id: "C", nombre: "2026", ruta: "Mi OneDrive / Clínica / Protocolos / 2026" },
      { id: "drive:DRIVE-COLEGA:X1", nombre: "De la colega", ruta: "Compartido conmigo / De la colega" },
    ]);
  });

  test("sin conexión avisa en llano; con el proveedor caído, un mensaje llano", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    expect(await mensajeDe(como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" }))).toBe(
      "Google Drive no está conectado todavía.",
    );
    await conectar(t, id, "google");
    vi.stubGlobal("fetch", async () => new Response("caído", { status: 503 }));
    configurarEspera(0);
    const msg = await mensajeDe(como.action(api.nube.oauth.listarCarpetas, { proveedor: "google" }));
    expect(msg).toMatch(/No se pudo leer la lista de carpetas de Google Drive/);
  });
});

describe("elegirCarpetas y desconectar", () => {
  test("acepta la URL de la carpeta de Google pegada tal cual, colapsa duplicados y guarda la ruta", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google");
    await como.mutation(api.nube.oauth.elegirCarpetas, {
      proveedor: "google",
      carpetas: [
        { id: "https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" },
        { id: "1AbCdEfGhIjKlMnOpQrStUv", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" },
        { id: "root", nombre: "Mi unidad" },
      ],
    });
    const [c] = await conexiones(t);
    expect(c.carpetas).toEqual([
      { id: "1AbCdEfGhIjKlMnOpQrStUv", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" },
      { id: "root", nombre: "Mi unidad", ruta: "Mi unidad" },
    ]);
  });

  test("reemplaza la selección entera; demasiadas o una irreconocible: invalido sin guardar nada", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "onedrive", { carpetas: [{ id: "A", nombre: "A", ruta: "A" }] });
    await como.mutation(api.nube.oauth.elegirCarpetas, { proveedor: "onedrive", carpetas: [{ id: "B", nombre: "B" }] });
    expect((await conexiones(t))[0].carpetas.map((c) => c.id)).toEqual(["B"]);
    const muchas = Array.from({ length: MAX_CARPETAS + 1 }, (_, i) => ({ id: `c${i}`, nombre: `c${i}` }));
    expect(await codigoDe(como.mutation(api.nube.oauth.elegirCarpetas, { proveedor: "onedrive", carpetas: muchas }))).toBe("invalido");
    expect(await codigoDe(como.mutation(api.nube.oauth.elegirCarpetas, { proveedor: "onedrive", carpetas: [{ id: "con espacio", nombre: "x" }] }))).toBe("invalido");
    expect(await codigoDe(como.mutation(api.nube.oauth.elegirCarpetas, { proveedor: "google", carpetas: [{ id: "root", nombre: "x" }] }))).toBe("invalido");
    expect((await conexiones(t))[0].carpetas.map((c) => c.id)).toEqual(["B"]);
  });

  test("desconectar borra SOLO la conexión de ese proveedor y sus states; el corpus y el otro proveedor se conservan", async () => {
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google");
    await conectar(t, id, "onedrive");
    await iniciarComo(como, "google");
    await iniciarComo(como, "onedrive");
    await t.run((ctx) =>
      ctx.db.insert("documents", {
        propietario: id, fileName: "guia.pdf", sha256: "a".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: Date.now(), origen: "google", nubeFicheroId: "f1",
      }),
    );
    await como.mutation(api.nube.oauth.desconectar, { proveedor: "google" });
    expect((await conexiones(t)).map((c) => c.proveedor)).toEqual(["onedrive"]);
    expect((await estados(t)).map((e) => e.proveedor)).toEqual(["onedrive"]);
    expect(await t.run((ctx) => ctx.db.query("documents").collect())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Permisos y estado
// ---------------------------------------------------------------------------
describe("permisos", () => {
  test("nadie ve ni toca la conexión de otra persona, ni un administrador; sin sesión, no_autenticado", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const admin = await alta(t, "admin@airobotix.net", "admin");
    await conectar(t, ana.id, "google", { carpetas: [{ id: "F1", nombre: "P", ruta: "P" }] });
    const suyo = await admin.como.query(api.nube.admin.estado, { proveedor: "google" });
    expect(suyo.conexion).toBeNull();
    expect(suyo.carpetas).toEqual([]);
    await admin.como.mutation(api.nube.oauth.desconectar, { proveedor: "google" });
    expect(await conexiones(t)).toHaveLength(1);
    expect(await codigoDe(admin.como.mutation(api.nube.oauth.elegirCarpetas, { proveedor: "google", carpetas: [{ id: "x", nombre: "x" }] }))).toBe("invalido");
    expect(await codigoDe(t.mutation(api.nube.oauth.iniciar, { proveedor: "google" }))).toBe("no_autenticado");
    expect(await codigoDe(t.query(api.nube.admin.estado, { proveedor: "google" }))).toBe("no_autenticado");
  });
});

describe("estado", () => {
  test("no revela tokens, distingue los dos proveedores y resume lo suyo", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");
    const t = nuevaBase();
    const { id, como } = await alta(t, "ana@airobotix.net");
    await conectar(t, id, "google", { carpetas: [{ id: "F1", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" }] });
    await t.run(async (ctx) => {
      await ctx.db.insert("nubeFicheros", {
        propietario: id, proveedor: "google", carpetaId: "F1", ficheroId: "f1", nombre: "guia.pdf", version: "v", sincronizadoEn: 1,
      });
      await ctx.db.insert("nubeFicheros", {
        propietario: id, proveedor: "google", carpetaId: "F1", ficheroId: "f2", nombre: "rota.pdf", version: "v", sincronizadoEn: 1, error: "x",
      });
      await ctx.db.insert("documents", {
        propietario: id, fileName: "guia.pdf", sha256: "a".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: 1, origen: "google", nubeFicheroId: "f1",
      });
      await ctx.db.insert("documents", {
        propietario: id, fileName: "otra.pdf", sha256: "b".repeat(64), pages: 1, chunks: 1, status: "ready",
        ingestadoEn: 1, origen: "notion", notionPageId: "p",
      });
    });
    const g = await como.query(api.nube.admin.estado, { proveedor: "google" });
    expect(g).toMatchObject({
      habilitada: true,
      conexion: { cuentaNombre: "Dra. Neuro", necesitaReconexion: false },
      carpetas: [{ id: "F1", nombre: "Protocolos", ruta: "Mi unidad / Protocolos" }],
      ficheros: 2,
      ficherosConError: 1,
      documentos: 1,
      enCurso: null,
      ultimas: [],
    });
    expect(JSON.stringify(g)).not.toContain(TOKEN);
    expect(JSON.stringify(g)).not.toContain(REFRESH);
    const o = await como.query(api.nube.admin.estado, { proveedor: "onedrive" });
    expect(o).toMatchObject({ habilitada: false, conexion: null, documentos: 0, ficheros: 0 });
  });

  test("el cron reparte una corrida por conexión con carpetas, de Notion y de las nubes", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const bea = await alta(t, "bea@airobotix.net");
    await conectar(t, ana.id, "google", { carpetas: [{ id: "F1", nombre: "P", ruta: "P" }] });
    await conectar(t, ana.id, "onedrive", { carpetas: [] });
    await conectar(t, bea.id, "onedrive", { carpetas: [{ id: "A", nombre: "A", ruta: "A" }], necesitaReconexion: true });
    expect(await t.mutation(internal.crons.repartirSincronizaciones, {})).toEqual({ agendadas: 2 });
    const trabajos = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const args = trabajos.map((j) => j.args[0] as { proveedor?: string }).map((a) => a.proveedor).sort();
    expect(args).toEqual(["google", "onedrive"]);
  });
});
