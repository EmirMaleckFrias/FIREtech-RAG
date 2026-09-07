// Conexión con Notion desde la app, por OAuth público. Existe porque la
// usuaria final es una médica, no una programadora: la primera versión se
// configuraba con un token y un id de base de datos en el despliegue, y en la
// pantalla ella veía "falta NOTION_TOKEN" y ningún botón. Aquí el flujo es un
// botón, la pantalla de Notion donde elige qué compartir, y de vuelta un
// desplegable con sus bases. Nunca ve un token, una variable ni un id.
//
// Lo que fija el DESARROLLADOR una sola vez: una integración PÚBLICA en
// Notion con redirect URI `${CONVEX_SITE_URL}/notion/callback`, y sus
// NOTION_CLIENT_ID y NOTION_CLIENT_SECRET en el despliegue. Sin ellas la UI
// dice que la conexión "aún no está habilitada por el equipo técnico". Esas
// credenciales identifican a la APLICACIÓN, no a una cuenta ni a un espacio de
// trabajo: cada persona que entra vincula su propio Notion con su propia
// sesión de Notion, como en cualquier integración.
//
// **Una conexión POR PERSONA.** Cada usuaria tiene su propio corpus (ver
// `propietario` en schema.ts), así que su conexión, sus páginas y sus corridas
// de sincronización son suyas: conectar de nuevo reemplaza la suya y no toca
// la de nadie más, y desconectar tampoco. Ya no hay respaldo por
// NOTION_TOKEN/NOTION_DATABASE_ID, porque un token del despliegue no tendría
// dueño y sus documentos no serían de nadie.
//
// Seguridad, en tres reglas:
// - El `state` es aleatorio, vive 10 minutos, se busca por índice y se BORRA
//   al usarse: un state repetido, caducado o desconocido no llega a Notion.
// - El `accessToken` solo lo leen funciones internas (la acción de
//   sincronización y la que lista las bases). Ninguna query pública lo
//   devuelve; `estado` dice a qué espacio se está conectado, no con qué.
// - Todo lo que hace algo exige una sesión iniciada (`usuario()`) y actúa
//   SOLO sobre la conexión de quien llama; ya no hace falta ser
//   administrador, porque conectar su propio Notion es parte del uso normal
//   de cualquier cuenta. El callback, que llega sin sesión, se apoya en el
//   `state` para saber de quién es la conexión que se está creando.
//
// Los tokens de Notion no caducan, así que no hay refresco. Conectar de nuevo
// reemplaza la fila de esa persona en `notionConexion`.
import { v } from "convex/values";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes, type Ajustes } from "../lib/config";
import { errorDatos, usuario } from "../usuarios";
import { ClienteNotion, normalizarId, type BaseNotion } from "./api";

/** Cuánto vale un `state` desde que se pulsa "Conectar" hasta que Notion
 *  devuelve a la usuaria. Diez minutos sobran para leer la pantalla de
 *  permisos y elegir páginas; más sería dejar estados vivos sin motivo. */
export const STATE_VIDA_MS = 10 * 60_000;

const URL_AUTORIZAR = "https://api.notion.com/v1/oauth/authorize";
const URL_TOKEN = "https://api.notion.com/v1/oauth/token";

/** El texto que ve la administradora cuando faltan las credenciales de la
 *  integración: en lenguaje llano, sin nombres de variables. */
export const MENSAJE_NO_HABILITADA =
  "La conexión con Notion aún no está habilitada por el equipo técnico.";

/** ¿Está registrada la integración pública? Hace falta el id Y el secreto:
 *  con solo el id el botón llevaría a Notion y el callback fallaría al
 *  canjear el código, que es peor que no tener el botón. */
export function oauthHabilitado(a: Ajustes): boolean {
  return Boolean(a.notionClientId && a.notionClientSecret);
}

/** La redirect URI que hay que registrar en Notion, tal cual. */
export function redirectUri(a: Ajustes): string {
  return `${a.convexSiteUrl}/notion/callback`;
}

// ---------------------------------------------------------------------------
// Credenciales efectivas
// ---------------------------------------------------------------------------
export interface Credenciales {
  token: string;
  databaseId: string;
}

/** La conexión de esa persona, si la hay. */
export async function conexionActual(
  ctx: QueryCtx | MutationCtx,
  propietario: Id<"users">,
): Promise<Doc<"notionConexion"> | null> {
  return await ctx.db
    .query("notionConexion")
    .withIndex("porUsuario", (q) => q.eq("conectadoPor", propietario))
    .first();
}

/** Con qué token y sobre qué base sincroniza esa persona. `null` = no hay
 *  nada que sincronizar: no ha conectado, o conectó y aún no eligió base. */
export async function credencialesDe(
  ctx: QueryCtx | MutationCtx,
  propietario: Id<"users">,
): Promise<Credenciales | null> {
  const conexion = await conexionActual(ctx, propietario);
  if (!conexion || !conexion.databaseId) return null;
  return { token: conexion.accessToken, databaseId: conexion.databaseId };
}

/** Para la acción de sincronización. Interna: el token no sale al cliente. */
export const credenciales = internalQuery({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }) => await credencialesDe(ctx, propietario),
});

/** Quiénes tienen hoy una conexión con base elegida, para que el cron lance
 *  una sincronización por persona en vez de una sola global. Interna y sin
 *  tokens: devuelve solo ids de cuenta. */
export const propietariosConectados = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users">[]> => {
    const todas = await ctx.db.query("notionConexion").collect();
    return todas.filter((c) => Boolean(c.databaseId)).map((c) => c.conectadoPor);
  },
});

/** El token de la conexión de quien llama, para la acción que lista las
 *  bases. Interna, y resuelve la identidad ella misma: la acción pública que
 *  la llama hereda la sesión de quien pulsa, así que aquí se decide de quién
 *  es el token que se va a usar. Nunca el de otra persona. */
export const tokenPropio = internalQuery({
  args: {},
  handler: async (ctx): Promise<string> => {
    const u = await usuario(ctx);
    const conexion = await conexionActual(ctx, u._id);
    if (!conexion) throw errorDatos("invalido", "Notion no está conectado todavía.");
    return conexion.accessToken;
  },
});

// ---------------------------------------------------------------------------
// 1. Iniciar: el botón "Conectar con Notion"
// ---------------------------------------------------------------------------
/** 64 caracteres hex aleatorios. `randomUUID` da 122 bits por llamada; dos
 *  llamadas sobran. El respaldo con `getRandomValues` es por si el runtime
 *  no trae `randomUUID`. */
function stateAleatorio(): string {
  if (typeof crypto.randomUUID === "function") {
    return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Solo el origen (`https://host`) de una URL http(s); cualquier otra cosa
 *  se descarta. Es adonde se devuelve a la usuaria si el despliegue no tiene
 *  SITE_URL, y guardar solo el origen evita que se cuele una ruta rara. */
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
  args: { origen: v.optional(v.string()) },
  handler: async (ctx, { origen }) => {
    const u = await usuario(ctx);
    const a = ajustes();
    if (!oauthHabilitado(a)) throw errorDatos("invalido", MENSAJE_NO_HABILITADA);
    if (!a.convexSiteUrl) {
      throw errorDatos("invalido", "Este despliegue no puede recibir la respuesta de Notion.");
    }

    // Limpieza de estados caducados al crear uno nuevo: así la tabla no
    // acumula clics abandonados y no hace falta un cron para ella.
    const ahora = Date.now();
    const pendientes = await ctx.db.query("notionEstadosOauth").collect();
    for (const e of pendientes) if (e.expiraEn <= ahora) await ctx.db.delete(e._id);

    const state = stateAleatorio();
    await ctx.db.insert("notionEstadosOauth", {
      state,
      userId: u._id,
      origen: origenValido(origen),
      creadoEn: ahora,
      expiraEn: ahora + STATE_VIDA_MS,
    });

    // `owner=user`: la que autoriza es una persona, que en la pantalla de
    // Notion elige qué páginas y bases comparte con la integración.
    const url = new URL(URL_AUTORIZAR);
    url.searchParams.set("client_id", a.notionClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", redirectUri(a));
    url.searchParams.set("state", state);
    return { url: url.toString() };
  },
});

// ---------------------------------------------------------------------------
// 2. Callback: Notion devuelve a la usuaria con `code` y `state`
// ---------------------------------------------------------------------------
/** Busca el state y lo borra en la misma transacción: la segunda vez que
 *  llegue ya no existe. Devuelve a quién pertenecía, o si estaba caducado. */
export const consumirState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const fila = await ctx.db
      .query("notionEstadosOauth")
      .withIndex("porState", (q) => q.eq("state", state))
      .unique();
    if (!fila) return null;
    await ctx.db.delete(fila._id);
    return {
      userId: fila.userId,
      origen: fila.origen ?? null,
      caducado: fila.expiraEn <= Date.now(),
    };
  },
});

/** Guarda la conexión DE ESA PERSONA, reemplazando la suya anterior si la
 *  había y sin tocar las de las demás. La base elegida se conserva solo si es
 *  el MISMO espacio de trabajo: con otro espacio, la base anterior no existe
 *  o no es accesible, y dejarla preseleccionada haría fallar la primera
 *  sincronización con un motivo confuso. */
export const guardarConexion = internalMutation({
  args: {
    accessToken: v.string(),
    botId: v.string(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceIcon: v.optional(v.string()),
    userId: v.id("users"),
  },
  handler: async (ctx, { userId, ...datos }) => {
    const previas = await ctx.db
      .query("notionConexion")
      .withIndex("porUsuario", (q) => q.eq("conectadoPor", userId))
      .collect();
    const mismoEspacio = previas.find((p) => p.workspaceId === datos.workspaceId);
    for (const p of previas) await ctx.db.delete(p._id);
    return await ctx.db.insert("notionConexion", {
      ...datos,
      conectadoPor: userId,
      conectadoEn: Date.now(),
      databaseId: mismoEspacio?.databaseId,
      databaseTitulo: mismoEspacio?.databaseTitulo,
    });
  },
});

/** Lo que se lee de la respuesta de `POST /oauth/token`. Se valida campo a
 *  campo: viene de fuera y un `access_token` que no sea texto no se guarda. */
interface RespuestaToken {
  accessToken: string;
  botId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
}

function leerRespuestaToken(datos: unknown): RespuestaToken | null {
  if (typeof datos !== "object" || datos === null) return null;
  const d = datos as Record<string, unknown>;
  if (typeof d.access_token !== "string" || d.access_token === "") return null;
  if (typeof d.workspace_id !== "string" || d.workspace_id === "") return null;
  return {
    accessToken: d.access_token,
    botId: typeof d.bot_id === "string" ? d.bot_id : "",
    workspaceId: d.workspace_id,
    // Notion puede devolver null en el nombre: se enseña algo con sentido.
    workspaceName:
      typeof d.workspace_name === "string" && d.workspace_name.trim() !== ""
        ? d.workspace_name.trim()
        : "tu espacio de Notion",
    // Puede ser una URL o un emoji; la UI decide cómo pintarlo.
    workspaceIcon: typeof d.workspace_icon === "string" && d.workspace_icon !== "" ? d.workspace_icon : undefined,
  };
}

/** Respuesta que devuelve a la usuaria al frontend con el resultado en la
 *  query (`?notion=conectado|cancelado|error&motivo=…`). El motivo es un
 *  código corto, nunca el detalle técnico: ese va al log. Sin ningún destino
 *  conocido (ni SITE_URL ni origen guardado), una página mínima que dice que
 *  vuelva a la aplicación; es un caso de despliegue a medias, no de uso. */
function volver(destino: string | null, params: Record<string, string>): Response {
  if (!destino) {
    const ok = params.notion === "conectado";
    const cuerpo =
      `<!doctype html><meta charset="utf-8"><title>Notion</title>` +
      `<p style="font:15px system-ui;margin:40px">` +
      (ok ? "Notion quedó conectado. Ya puedes volver a la aplicación." : "No se completó la conexión con Notion. Vuelve a la aplicación e inténtalo de nuevo.") +
      `</p>`;
    return new Response(cuerpo, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const u = new URL(destino);
  for (const [k, valor] of Object.entries(params)) u.searchParams.set(k, valor);
  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), "Cache-Control": "no-store" },
  });
}

export const callback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const a = ajustes();

  // El state va PRIMERO y se consume siempre que venga, pase lo que pase
  // después: si no es nuestro, no se habla con Notion.
  const consumo = state ? await ctx.runMutation(internal.notion.oauth.consumirState, { state }) : null;
  const destino = a.siteUrl || consumo?.origen || null;

  if (!consumo || consumo.caducado) {
    console.warn(`notion oauth: state ${!consumo ? "desconocido o ya usado" : "caducado"}`);
    return volver(destino, { notion: "error", motivo: "estado" });
  }
  // La usuaria pulsó "Cancelar" en la pantalla de Notion: no es un error.
  if (error === "access_denied") return volver(destino, { notion: "cancelado" });
  if (error) {
    console.warn(`notion oauth: Notion devolvió error=${error}`);
    return volver(destino, { notion: "error", motivo: "notion" });
  }
  if (!code) return volver(destino, { notion: "error", motivo: "codigo" });
  if (!oauthHabilitado(a)) return volver(destino, { notion: "error", motivo: "no_habilitada" });

  // Canje del código por el token. Autenticación básica con las credenciales
  // de la integración, como documenta Notion; la redirect_uri tiene que ser
  // la misma que se mandó al autorizar.
  let res: Response;
  try {
    res = await fetch(URL_TOKEN, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${a.notionClientId}:${a.notionClientSecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri(a) }),
    });
  } catch (exc) {
    console.error(`notion oauth: no se pudo llegar a Notion: ${exc instanceof Error ? exc.message : String(exc)}`);
    return volver(destino, { notion: "error", motivo: "red" });
  }

  let datos: unknown = null;
  try {
    datos = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  if (!res.ok) {
    const d = (datos ?? {}) as { error?: string; error_description?: string };
    console.error(`notion oauth: el canje respondió ${res.status} ${d.error ?? ""} ${d.error_description ?? ""}`.trim());
    return volver(destino, { notion: "error", motivo: "intercambio" });
  }
  const conexion = leerRespuestaToken(datos);
  if (!conexion) {
    console.error("notion oauth: la respuesta del canje no trae access_token o workspace_id");
    return volver(destino, { notion: "error", motivo: "respuesta" });
  }

  await ctx.runMutation(internal.notion.oauth.guardarConexion, { ...conexion, userId: consumo.userId });
  console.log(`notion oauth: conectado al espacio '${conexion.workspaceName}'`);
  return volver(destino, { notion: "conectado" });
});

// ---------------------------------------------------------------------------
// 3. Tras conectar: elegir la base, desconectar
// ---------------------------------------------------------------------------
/** Las bases que la integración puede ver, para el desplegable. Acción
 *  porque habla con Notion; el permiso y el token los da `tokenParaAdmin`. */
export const listarBases = action({
  args: {},
  handler: async (ctx): Promise<BaseNotion[]> => {
    const token: string = await ctx.runQuery(internal.notion.oauth.tokenPropio, {});
    try {
      return await new ClienteNotion(token).buscarBases();
    } catch (exc) {
      console.error(`notion oauth: no se pudieron listar las bases: ${exc instanceof Error ? exc.message : String(exc)}`);
      throw errorDatos(
        "invalido",
        "No se pudo leer la lista de bases de datos de Notion. Vuelve a intentarlo o conecta de nuevo.",
      );
    }
  },
});

export const elegirBase = mutation({
  args: { databaseId: v.string(), titulo: v.string() },
  handler: async (ctx, { databaseId, titulo }) => {
    const u = await usuario(ctx);
    const conexion = await conexionActual(ctx, u._id);
    if (!conexion) throw errorDatos("invalido", "Primero conecta con Notion.");
    const id = normalizarId(databaseId);
    if (!/^[0-9a-f]{32}$/.test(id)) throw errorDatos("invalido", "Esa base de datos no se reconoce.");
    await ctx.db.patch(conexion._id, { databaseId: id, databaseTitulo: titulo.trim() || "Sin título" });
    return { ok: true as const };
  },
});

/** Borra la conexión de quien llama y sus states pendientes. Sus documentos
 *  ya sincronizados se conservan: desconectar es dejar de traer cambios, no
 *  vaciar el corpus. No toca nada de ninguna otra cuenta. */
export const desconectar = mutation({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const suyas = await ctx.db
      .query("notionConexion")
      .withIndex("porUsuario", (q) => q.eq("conectadoPor", u._id))
      .collect();
    for (const c of suyas) await ctx.db.delete(c._id);
    for (const e of await ctx.db.query("notionEstadosOauth").collect()) {
      if (e.userId === u._id) await ctx.db.delete(e._id);
    }
    return { ok: true as const };
  },
});

