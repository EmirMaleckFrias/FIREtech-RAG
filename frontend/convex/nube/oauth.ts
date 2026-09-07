// Conexión con Google Drive y con OneDrive desde la app, por OAuth. Es el
// mismo flujo que el de Notion (notion/oauth.ts) con dos diferencias: hay un
// `proveedor` en todo, y los tokens CADUCAN y se renuevan.
//
// Lo que fija el DESARROLLADOR una sola vez:
// - Google: un cliente OAuth de tipo "aplicación web" en Google Cloud, con la
//   API de Google Drive activada y la URI de redirección
//   `${CONVEX_SITE_URL}/google/callback`; sus credenciales van en
//   GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.
// - Microsoft: un registro de aplicación en Microsoft Entra (cuentas de
//   cualquier organización y personales), con la URI de redirección
//   `${CONVEX_SITE_URL}/onedrive/callback` de tipo "Web" y un secreto de
//   cliente; van en MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET.
// Sin ellas, el bloque correspondiente dice que la conexión "aún no está
// habilitada por el equipo técnico". Esas credenciales identifican a la
// APLICACIÓN: cada persona conecta su propia cuenta con su propia sesión.
//
// **Una conexión POR PERSONA Y PROVEEDOR.** Su Google Drive y su OneDrive son
// dos conexiones. Conectar de nuevo reemplaza la suya y no toca la de nadie
// más; desconectar tampoco. Los documentos ya traídos se conservan.
//
// Seguridad, igual que en Notion: `state` aleatorio de 10 minutos que se
// consume una sola vez; los tokens solo los leen funciones internas; todo lo
// que hace algo exige sesión y actúa sobre la conexión de quien llama.
//
// Tokens: el de acceso vale una hora. `tokenVigente` lo renueva con el refresh
// token si le queda menos del margen pedido, y guarda el nuevo (Microsoft rota
// también el refresh token; Google devuelve el mismo). Si el proveedor rechaza
// la renovación (permiso revocado), la conexión queda marcada con
// `necesitaReconexion` y la UI ofrece volver a conectar.
import { ConvexError, v } from "convex/values";
import type { PublicHttpAction } from "convex/server";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes, type Ajustes } from "../lib/config";
import { proveedorNube } from "../schema";
import { errorDatos, usuario } from "../usuarios";
import { cuentaGoogle, normalizarIdCarpetaGoogle, ClienteGoogleDrive } from "./google";
import { cuentaOneDrive, ClienteOneDrive } from "./onedrive";
import {
  ErrorNube,
  ErrorReconexion,
  NOMBRE,
  tokenFijo,
  type CarpetaNube,
  type ClienteNube,
  type CuentaNube,
  type Proveedor,
  type Tokens,
} from "./proveedores";

export const STATE_VIDA_MS = 10 * 60_000;

/** Cuántas carpetas puede sincronizar una persona por proveedor. Cada
 *  carpeta se recorre entera en cada corrida y la corrida tiene 20 minutos. */
export const MAX_CARPETAS = 20;

/** Con qué margen se renueva el token antes de una corrida: una corrida puede
 *  durar 20 minutos y el token vale 60, así que se pide uno fresco si al
 *  actual le quedan menos de 25. Las llamadas cortas usan un margen menor. */
export const MARGEN_CORRIDA_MS = 25 * 60_000;
export const MARGEN_CORTO_MS = 2 * 60_000;

interface PuntosOauth {
  autorizar: string;
  token: string;
  scope: string;
  /** Parámetros propios de cada proveedor en la URL de autorización. */
  extra: Record<string, string>;
}

/** Los puntos de OAuth de cada proveedor. Google necesita `access_type=offline`
 *  y `prompt=consent` para devolver un refresh token; Microsoft, el ámbito
 *  `offline_access`. `Files.Read.All` y `drive.readonly` son de SOLO LECTURA:
 *  la aplicación no escribe nada en la nube de nadie. */
export const OAUTH: Record<Proveedor, PuntosOauth> = {
  google: {
    autorizar: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  onedrive: {
    autorizar: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access Files.Read.All User.Read",
    extra: { response_mode: "query", prompt: "select_account" },
  },
};

export function credencialesApp(a: Ajustes, p: Proveedor): { clientId: string; clientSecret: string } {
  return p === "google"
    ? { clientId: a.googleClientId, clientSecret: a.googleClientSecret }
    : { clientId: a.microsoftClientId, clientSecret: a.microsoftClientSecret };
}

/** ¿Está registrada la aplicación en ese proveedor? Hace falta el id Y el
 *  secreto: con solo el id el botón llevaría al proveedor y el canje fallaría. */
export function oauthHabilitado(a: Ajustes, p: Proveedor): boolean {
  const c = credencialesApp(a, p);
  return Boolean(c.clientId && c.clientSecret);
}

/** La URI de redirección que hay que registrar en el proveedor, tal cual. */
export function redirectUri(a: Ajustes, p: Proveedor): string {
  return `${a.convexSiteUrl}/${p}/callback`;
}

export function mensajeNoHabilitada(p: Proveedor): string {
  return `La conexión con ${NOMBRE[p]} aún no está habilitada por el equipo técnico.`;
}

export function clienteDe(p: Proveedor, tokens: Tokens): ClienteNube {
  return p === "google" ? new ClienteGoogleDrive(tokens) : new ClienteOneDrive(tokens);
}

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------
export async function conexionActual(
  ctx: QueryCtx | MutationCtx,
  propietario: Id<"users">,
  proveedor: Proveedor,
): Promise<Doc<"nubeConexion"> | null> {
  return await ctx.db
    .query("nubeConexion")
    .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", propietario).eq("proveedor", proveedor))
    .first();
}

/** La identidad de quien llama, para las acciones: una acción no tiene
 *  `ctx.db`, así que resuelve la cuenta con una query interna que hereda su
 *  sesión. Nunca la de otra persona. */
export const propioId = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users">> => (await usuario(ctx))._id,
});

// ---------------------------------------------------------------------------
// 1. Iniciar: el botón "Conectar con Google Drive" / "Conectar con OneDrive"
// ---------------------------------------------------------------------------
function stateAleatorio(): string {
  if (typeof crypto.randomUUID === "function") {
    return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function origenValido(crudo: string | undefined): string | undefined {
  if (!crudo) return undefined;
  try {
    const u = new URL(crudo);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

export const iniciar = mutation({
  args: { proveedor: proveedorNube, origen: v.optional(v.string()) },
  handler: async (ctx, { proveedor, origen }) => {
    const u = await usuario(ctx);
    const a = ajustes();
    if (!oauthHabilitado(a, proveedor)) throw errorDatos("invalido", mensajeNoHabilitada(proveedor));
    if (!a.convexSiteUrl) {
      throw errorDatos("invalido", `Este despliegue no puede recibir la respuesta de ${NOMBRE[proveedor]}.`);
    }

    // Limpieza de estados caducados al crear uno nuevo, por índice y acotada.
    const ahora = Date.now();
    const caducados = await ctx.db
      .query("nubeEstadosOauth")
      .withIndex("porExpira", (q) => q.lte("expiraEn", ahora))
      .take(50);
    for (const e of caducados) await ctx.db.delete(e._id);

    const state = stateAleatorio();
    await ctx.db.insert("nubeEstadosOauth", {
      state,
      proveedor,
      userId: u._id,
      origen: origenValido(origen),
      creadoEn: ahora,
      expiraEn: ahora + STATE_VIDA_MS,
    });

    const puntos = OAUTH[proveedor];
    const url = new URL(puntos.autorizar);
    url.searchParams.set("client_id", credencialesApp(a, proveedor).clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri(a, proveedor));
    url.searchParams.set("scope", puntos.scope);
    url.searchParams.set("state", state);
    for (const [k, valor] of Object.entries(puntos.extra)) url.searchParams.set(k, valor);
    return { url: url.toString() };
  },
});

// ---------------------------------------------------------------------------
// 2. Callback: el proveedor devuelve a la usuaria con `code` y `state`
// ---------------------------------------------------------------------------
export const consumirState = internalMutation({
  args: { state: v.string(), proveedor: proveedorNube },
  handler: async (ctx, { state, proveedor }) => {
    const fila = await ctx.db
      .query("nubeEstadosOauth")
      .withIndex("porState", (q) => q.eq("state", state))
      .unique();
    if (!fila) return null;
    await ctx.db.delete(fila._id);
    // Un state de Google no vale para el callback de OneDrive: se consume
    // igual (ya no sirve) pero no se acepta.
    if (fila.proveedor !== proveedor) return null;
    return {
      userId: fila.userId,
      origen: fila.origen ?? null,
      caducado: fila.expiraEn <= Date.now(),
    };
  },
});

/** Guarda la conexión DE ESA PERSONA con ese proveedor, reemplazando la suya
 *  anterior. Las carpetas elegidas se conservan solo si es la MISMA cuenta:
 *  con otra cuenta no existen o no son accesibles. */
export const guardarConexion = internalMutation({
  args: {
    proveedor: proveedorNube,
    userId: v.id("users"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiraEn: v.number(),
    cuentaId: v.string(),
    cuentaNombre: v.string(),
    cuentaCorreo: v.optional(v.string()),
    cuentaImagen: v.optional(v.string()),
  },
  handler: async (ctx, { userId, ...datos }) => {
    const previas = await ctx.db
      .query("nubeConexion")
      .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", userId).eq("proveedor", datos.proveedor))
      .collect();
    const mismaCuenta = previas.find((p) => p.cuentaId === datos.cuentaId);
    // Si el proveedor no devolvió refresh token nuevo (Google no lo repite si
    // ya lo había dado), se conserva el anterior de la misma cuenta.
    const refreshToken = datos.refreshToken ?? mismaCuenta?.refreshToken;
    for (const p of previas) await ctx.db.delete(p._id);
    return await ctx.db.insert("nubeConexion", {
      ...datos,
      refreshToken,
      conectadoPor: userId,
      conectadoEn: Date.now(),
      carpetas: mismaCuenta?.carpetas ?? [],
    });
  },
});

interface RespuestaToken {
  accessToken: string;
  refreshToken?: string;
  expiraEn: number;
}

/** Lo que se lee de la respuesta del punto de token. Viene de fuera: se
 *  valida campo a campo. */
export function leerRespuestaToken(datos: unknown, ahora = Date.now()): RespuestaToken | null {
  if (typeof datos !== "object" || datos === null) return null;
  const d = datos as Record<string, unknown>;
  if (typeof d.access_token !== "string" || d.access_token === "") return null;
  const segundos = typeof d.expires_in === "number" ? d.expires_in : Number(d.expires_in);
  // Sin `expires_in` utilizable se asume la hora habitual, menos margen.
  const vida = Number.isFinite(segundos) && segundos > 0 ? segundos : 3000;
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" && d.refresh_token !== "" ? d.refresh_token : undefined,
    expiraEn: ahora + vida * 1000,
  };
}

/** Canje o renovación contra el punto de token del proveedor, con el cuerpo
 *  en formulario como piden los dos. Devuelve los datos o el error del
 *  proveedor (`error` corto) para que el llamador decida. */
async function pedirToken(
  proveedor: Proveedor,
  a: Ajustes,
  cuerpo: Record<string, string>,
): Promise<{ ok: true; token: RespuestaToken } | { ok: false; status: number; error: string }> {
  const c = credencialesApp(a, proveedor);
  const form = new URLSearchParams({ ...cuerpo, client_id: c.clientId, client_secret: c.clientSecret });
  if (proveedor === "onedrive") form.set("scope", OAUTH.onedrive.scope);
  const res = await fetch(OAUTH[proveedor].token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  let datos: unknown = null;
  try {
    datos = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  if (!res.ok) {
    const d = (datos ?? {}) as { error?: string; error_description?: string };
    return { ok: false, status: res.status, error: `${d.error ?? ""} ${d.error_description ?? ""}`.trim() };
  }
  const token = leerRespuestaToken(datos);
  if (!token) return { ok: false, status: res.status, error: "la respuesta no trae access_token" };
  return { ok: true, token };
}

async function cuentaDe(proveedor: Proveedor, token: string): Promise<CuentaNube> {
  return proveedor === "google" ? await cuentaGoogle(tokenFijo(token)) : await cuentaOneDrive(tokenFijo(token));
}

/** Devuelve a la usuaria al frontend con el resultado en la query
 *  (`?nube=google&resultado=conectado|cancelado|error&motivo=…`). El motivo
 *  es un código corto, nunca el detalle técnico: ese va al log. */
function volver(proveedor: Proveedor, destino: string | null, resultado: string, motivo?: string): Response {
  if (!destino) {
    const ok = resultado === "conectado";
    const nombre = NOMBRE[proveedor];
    const cuerpo =
      `<!doctype html><meta charset="utf-8"><title>${nombre}</title>` +
      `<p style="font:15px system-ui;margin:40px">` +
      (ok
        ? `${nombre} quedó conectado. Ya puedes volver a la aplicación.`
        : `No se completó la conexión con ${nombre}. Vuelve a la aplicación e inténtalo de nuevo.`) +
      `</p>`;
    return new Response(cuerpo, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const u = new URL(destino);
  u.searchParams.set("nube", proveedor);
  u.searchParams.set("resultado", resultado);
  if (motivo) u.searchParams.set("motivo", motivo);
  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), "Cache-Control": "no-store" },
  });
}

interface Consumo {
  userId: Id<"users">;
  origen: string | null;
  caducado: boolean;
}

/** El callback de un proveedor. Es una fábrica porque los dos son idénticos
 *  salvo por el proveedor, y Convex necesita una `httpAction` exportada por
 *  ruta. El tipo de retorno va explícito (y el de `consumo`) porque si no el
 *  tipo de la API interna se referencia a sí mismo a través de esta función
 *  y TypeScript deja TODA la API en `any`, incluida la de Notion. */
function callbackDe(proveedor: Proveedor): PublicHttpAction {
  return httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const a = ajustes();
    const etiqueta = `${proveedor} oauth`;

    // El state va PRIMERO y se consume siempre que venga: si no es nuestro,
    // no se habla con el proveedor.
    const consumo: Consumo | null = state
      ? await ctx.runMutation(internal.nube.oauth.consumirState, { state, proveedor })
      : null;
    const destino: string | null = a.siteUrl || consumo?.origen || null;

    if (!consumo || consumo.caducado) {
      console.warn(`${etiqueta}: state ${!consumo ? "desconocido o ya usado" : "caducado"}`);
      return volver(proveedor, destino, "error", "estado");
    }
    if (error === "access_denied" || error === "consent_required") return volver(proveedor, destino, "cancelado");
    if (error) {
      console.warn(`${etiqueta}: el proveedor devolvió error=${error}`);
      return volver(proveedor, destino, "error", "proveedor");
    }
    if (!code) return volver(proveedor, destino, "error", "codigo");
    if (!oauthHabilitado(a, proveedor)) return volver(proveedor, destino, "error", "no_habilitada");

    let canje: Awaited<ReturnType<typeof pedirToken>>;
    try {
      canje = await pedirToken(proveedor, a, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(a, proveedor),
      });
    } catch (exc) {
      console.error(`${etiqueta}: no se pudo llegar al proveedor: ${exc instanceof Error ? exc.message : String(exc)}`);
      return volver(proveedor, destino, "error", "red");
    }
    if (!canje.ok) {
      console.error(`${etiqueta}: el canje respondió ${canje.status} ${canje.error}`.trim());
      return volver(proveedor, destino, "error", "intercambio");
    }

    // La cuenta con la que se autorizó: para "Conectado como …" y para
    // reconocer la misma cuenta al reconectar. Si no se puede leer, se guarda
    // igual con un nombre genérico: la conexión funciona sin ella.
    let cuenta: CuentaNube;
    try {
      cuenta = await cuentaDe(proveedor, canje.token.accessToken);
    } catch (exc) {
      console.warn(`${etiqueta}: no se pudo leer la cuenta: ${exc instanceof Error ? exc.message : String(exc)}`);
      cuenta = { id: `sin-cuenta-${Date.now()}`, nombre: `tu cuenta de ${NOMBRE[proveedor]}`, correo: null, imagen: null };
    }

    try {
      await ctx.runMutation(internal.nube.oauth.guardarConexion, {
        proveedor,
        userId: consumo.userId,
        accessToken: canje.token.accessToken,
        refreshToken: canje.token.refreshToken,
        expiraEn: canje.token.expiraEn,
        cuentaId: cuenta.id,
        cuentaNombre: cuenta.nombre,
        cuentaCorreo: cuenta.correo ?? undefined,
        cuentaImagen: cuenta.imagen ?? undefined,
      });
    } catch (exc) {
      console.error(`${etiqueta}: no se pudo guardar la conexión: ${String(exc).slice(0, 200)}`);
      return volver(proveedor, destino, "error", "guardar");
    }
    console.log(`${etiqueta}: conectado como '${cuenta.nombre}'`);
    return volver(proveedor, destino, "conectado");
  });
}

export const callbackGoogle = callbackDe("google");
export const callbackOnedrive = callbackDe("onedrive");

// ---------------------------------------------------------------------------
// Tokens vigentes
// ---------------------------------------------------------------------------
/**
 * El token de acceso de la conexión de esa persona, renovado si le queda
 * menos de `margenMs` (o si se pide `forzar`, tras un 401). Guarda el nuevo.
 *
 * Si el proveedor rechaza la renovación (`invalid_grant`: permiso revocado,
 * contraseña cambiada, refresh token caducado por inactividad) la conexión se
 * marca con `necesitaReconexion` y se lanza `ErrorReconexion`: la corrida
 * cierra con ese motivo y la UI ofrece volver a conectar. Un fallo de red o
 * un 5xx NO marca nada: es transitorio.
 */
export async function tokenVigente(
  ctx: ActionCtx,
  propietario: Id<"users">,
  proveedor: Proveedor,
  opciones: { margenMs?: number; forzar?: boolean } = {},
): Promise<{ token: string; conexionId: Id<"nubeConexion"> }> {
  const c = await ctx.runQuery(internal.nube.datos.conexion, { propietario, proveedor });
  if (!c) throw errorDatos("invalido", `${NOMBRE[proveedor]} no está conectado todavía.`);
  const margen = opciones.margenMs ?? MARGEN_CORTO_MS;
  if (!opciones.forzar && c.expiraEn - Date.now() > margen) {
    return { token: c.accessToken, conexionId: c._id };
  }
  if (!c.refreshToken) {
    await ctx.runMutation(internal.nube.datos.marcarReconexion, { conexionId: c._id });
    throw new ErrorReconexion(proveedor);
  }
  const r = await pedirToken(proveedor, ajustes(), { grant_type: "refresh_token", refresh_token: c.refreshToken });
  if (!r.ok) {
    // 400 y 401 en el punto de token son el refresh token rechazado
    // (`invalid_grant`, `invalid_client`): no se arregla reintentando.
    if (r.status === 400 || r.status === 401) {
      console.warn(`${proveedor} oauth: renovación rechazada (${r.status} ${r.error}); hace falta reconectar`);
      await ctx.runMutation(internal.nube.datos.marcarReconexion, { conexionId: c._id });
      throw new ErrorReconexion(proveedor);
    }
    throw new ErrorNube(`${NOMBRE[proveedor]} no renovó el permiso (${r.status})`, r.status);
  }
  await ctx.runMutation(internal.nube.datos.actualizarToken, {
    conexionId: c._id,
    accessToken: r.token.accessToken,
    refreshToken: r.token.refreshToken,
    expiraEn: r.token.expiraEn,
  });
  return { token: r.token.accessToken, conexionId: c._id };
}

/** Los tokens para un cliente que puede correr mucho rato: el de arranque y
 *  la renovación al vuelo si la API responde 401. */
export function tokensRenovables(
  ctx: ActionCtx,
  propietario: Id<"users">,
  proveedor: Proveedor,
  inicial: string,
): Tokens {
  let actual = inicial;
  return {
    actual: () => actual,
    renovar: async () => {
      actual = (await tokenVigente(ctx, propietario, proveedor, { forzar: true })).token;
      return actual;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Tras conectar: elegir carpetas, desconectar
// ---------------------------------------------------------------------------
/** Las carpetas que la persona puede ver en esa nube, para la lista. */
export const listarCarpetas = action({
  args: { proveedor: proveedorNube },
  handler: async (ctx, { proveedor }): Promise<CarpetaNube[]> => {
    const propietario: Id<"users"> = await ctx.runQuery(internal.nube.oauth.propioId, {});
    try {
      // La renovación del token va DENTRO del try: si el proveedor ya no
      // acepta el permiso, el mensaje tiene que ser el llano de abajo y no el
      // técnico de la excepción.
      const { token } = await tokenVigente(ctx, propietario, proveedor);
      return await clienteDe(proveedor, tokensRenovables(ctx, propietario, proveedor, token)).listarCarpetas();
    } catch (exc) {
      if (exc instanceof ConvexError) throw exc;
      if (exc instanceof ErrorReconexion) {
        throw errorDatos("invalido", `${NOMBRE[proveedor]} ya no acepta el permiso de esta conexión. Vuelve a conectar.`);
      }
      console.error(`${proveedor}: no se pudieron listar las carpetas: ${exc instanceof Error ? exc.message : String(exc)}`);
      throw errorDatos(
        "invalido",
        `No se pudo leer la lista de carpetas de ${NOMBRE[proveedor]}. Vuelve a intentarlo o conecta de nuevo.`,
      );
    }
  },
});

/** Fija QUÉ carpetas sincroniza: la selección completa, que reemplaza la
 *  anterior. Quitar una carpeta deja de traer sus cambios pero NO borra lo ya
 *  traído. En Google se acepta también la URL de la carpeta pegada tal cual. */
export const elegirCarpetas = mutation({
  args: {
    proveedor: proveedorNube,
    carpetas: v.array(v.object({ id: v.string(), nombre: v.string(), ruta: v.optional(v.string()) })),
  },
  handler: async (ctx, { proveedor, carpetas }) => {
    const u = await usuario(ctx);
    const conexion = await conexionActual(ctx, u._id, proveedor);
    if (!conexion) throw errorDatos("invalido", `Primero conecta con ${NOMBRE[proveedor]}.`);
    if (carpetas.length > MAX_CARPETAS) {
      throw errorDatos("invalido", `Son demasiadas carpetas a la vez (máximo ${MAX_CARPETAS}).`);
    }
    const vistas = new Set<string>();
    const limpias: Array<{ id: string; nombre: string; ruta: string }> = [];
    for (const c of carpetas) {
      const id = proveedor === "google" ? normalizarIdCarpetaGoogle(c.id) : c.id.trim();
      if (id === "" || id.length > 400 || /\s/.test(id)) {
        throw errorDatos("invalido", "Una de las carpetas no se reconoce.");
      }
      if (vistas.has(id)) continue;
      vistas.add(id);
      const nombre = c.nombre.trim() || "Sin nombre";
      limpias.push({ id, nombre, ruta: (c.ruta ?? "").trim() || nombre });
    }
    await ctx.db.patch(conexion._id, { carpetas: limpias });
    return { ok: true as const };
  },
});

/** Borra la conexión de quien llama con ese proveedor y sus states
 *  pendientes. Sus documentos ya sincronizados se conservan. */
export const desconectar = mutation({
  args: { proveedor: proveedorNube },
  handler: async (ctx, { proveedor }) => {
    const u = await usuario(ctx);
    const suyas = await ctx.db
      .query("nubeConexion")
      .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", u._id).eq("proveedor", proveedor))
      .collect();
    for (const c of suyas) await ctx.db.delete(c._id);
    const pendientes = await ctx.db
      .query("nubeEstadosOauth")
      .withIndex("porUsuario", (q) => q.eq("userId", u._id))
      .take(100);
    for (const e of pendientes) if (e.proveedor === proveedor) await ctx.db.delete(e._id);
    return { ok: true as const };
  },
});
