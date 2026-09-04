// Cliente mínimo de la API de Notion, sin SDK: solo `fetch`, que es lo que
// hay en el runtime por defecto de Convex. Cubre lo que necesita la
// sincronización: paginar una base de datos, leer los bloques de una página
// (recursivamente) y descargar adjuntos.
//
// Dos cosas de la API que condicionan el diseño (developers.notion.com):
//
// - **El límite es de unas 3 peticiones por segundo** por integración, y al
//   pasarse responde 429 con `Retry-After` en segundos. Una base con 200
//   páginas son 200 lecturas de bloques como mínimo, así que el cliente
//   espacia las peticiones por su cuenta (`pausaMs`) en vez de confiar en
//   el 429, que además cuenta contra la cuota, y cuando aun así llega uno
//   espera lo que Notion dice y reintenta.
// - **Las URL de los adjuntos subidos a Notion están firmadas y caducan en
//   una hora.** La sincronización las usa nada más leerlas, pero una página
//   con muchos adjuntos grandes puede tardar, así que `descargar` avisa con
//   `UrlCaducada` (403 o 400) y el llamador vuelve a leer la página para
//   obtener una fresca.
import { extensionDe, sanearNombre } from "../documentos";

export const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1";

/** Pausa mínima entre dos peticiones a Notion. 350 ms deja algo de aire
 *  bajo las 3/s. Ajustable para los tests, que simulan Notion en memoria y no
 *  tienen que esperar. */
let pausaMs = 350;
export function configurarPausa(ms: number): void {
  pausaMs = Math.max(0, ms);
}

export class ErrorNotion extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly codigo?: string,
  ) {
    super(message);
    this.name = "ErrorNotion";
  }
}

/** La URL firmada de un adjunto ya no vale: hay que releer la página. */
export class UrlCaducada extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`la URL del adjunto caducó (${status})`);
    this.name = "UrlCaducada";
  }
}

// ---------------------------------------------------------------------------
// Tipos (solo lo que se lee; la API devuelve mucho más)
// ---------------------------------------------------------------------------
export interface TextoRico {
  type?: string;
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
}

export interface FicheroNotion {
  name?: string;
  type?: "file" | "external";
  file?: { url: string; expiry_time?: string };
  external?: { url: string };
  caption?: TextoRico[];
}

export interface PaginaNotion {
  id: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, PropiedadNotion>;
}

export interface PropiedadNotion {
  id?: string;
  type: string;
  title?: TextoRico[];
  rich_text?: TextoRico[];
  files?: FicheroNotion[];
  select?: { name: string } | null;
  status?: { name: string } | null;
  [k: string]: unknown;
}

/** Un bloque con sus hijos ya resueltos (`children`), para que el render sea
 *  una función pura sin red. */
export interface BloqueNotion {
  id: string;
  type: string;
  has_children?: boolean;
  children?: BloqueNotion[];
  [k: string]: unknown;
}

interface Paginado<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** Un adjunto por descargar, ya con nombre saneado y URL. */
export interface Adjunto {
  nombre: string;
  url: string;
}

/** Una base de datos tal como la devuelve `POST /search` (lo que se lee). */
interface BaseCruda {
  object: string;
  id: string;
  title?: TextoRico[];
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
}

/** Una base de datos que la integración puede ver, para el desplegable de la
 *  administradora. El id va normalizado (32 hex) porque es la clave con la
 *  que se guarda la elección. */
export interface BaseNotion {
  id: string;
  titulo: string;
  ultimaEdicion: string;
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------
function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Id de 32 hex sin guiones: la API acepta las dos formas, pero como clave
 *  de `notionPaginas` hace falta una sola. Acepta también la URL de la base
 *  pegada tal cual, que es lo que la gente copia, en cualquiera de sus formas
 *  (`notion.so/<workspace>/<Titulo>-<id>?v=…` o `app.notion.com/p/<workspace>/<id>?v=…`):
 *  el id de la base es el último tramo de 32 hex del path; lo que va tras `?`
 *  (`v=` es la vista) se descarta. */
export function normalizarId(crudo: string): string {
  const sinQuery = crudo.trim().split("?")[0] ?? "";
  const candidatos = sinQuery.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  const ultimo = candidatos?.[candidatos.length - 1];
  return (ultimo ?? sinQuery).replace(/-/g, "").toLowerCase();
}

/** El id en el formato 8-4-4-4-12 que documenta la API (acepta también el
 *  compacto, pero se manda el canónico para no depender de esa tolerancia). */
export function idConGuiones(crudo: string): string {
  const id = normalizarId(crudo);
  if (id.length !== 32) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export class ClienteNotion {
  private ultimaPeticion = 0;

  constructor(private readonly token: string) {}

  /** Espera hasta que haya pasado `pausaMs` desde la última petición. */
  private async respetarRitmo(): Promise<void> {
    const espera = this.ultimaPeticion + pausaMs - Date.now();
    if (espera > 0) await dormir(espera);
    this.ultimaPeticion = Date.now();
  }

  /** Petición JSON con reintentos: 429 espera `Retry-After` (tope 30 s) y
   *  los 5xx esperan un segundo; hasta 4 intentos en total. Los 4xx que no
   *  son 429 son errores del llamador o de permisos y no se reintentan. */
  private async json<T>(metodo: "GET" | "POST", ruta: string, cuerpo?: unknown): Promise<T> {
    let ultimo: ErrorNotion | null = null;
    for (let intento = 0; intento < 4; intento++) {
      await this.respetarRitmo();
      const res = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
      if (res.ok) return (await res.json()) as T;

      let detalle = "";
      let codigo: string | undefined;
      try {
        const err = (await res.json()) as { message?: string; code?: string };
        detalle = err.message ?? "";
        codigo = err.code;
      } catch {
        /* sin cuerpo JSON */
      }
      ultimo = new ErrorNotion(
        `Notion respondió ${res.status} en ${metodo} ${ruta}${detalle ? `: ${detalle}` : ""}`,
        res.status,
        codigo,
      );
      if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After") ?? "1");
        await dormir(Math.min(30, Number.isFinite(retry) && retry > 0 ? retry : 1) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await dormir(1000);
        continue;
      }
      throw ultimo;
    }
    throw ultimo ?? new ErrorNotion("Notion no respondió", 0);
  }

  /** Todas las páginas de la base, siguiendo `next_cursor`. Devuelve también
   *  las archivadas: la sincronización decide qué hacer con ellas. */
  async paginasDeBase(databaseId: string): Promise<PaginaNotion[]> {
    const paginas: PaginaNotion[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await this.json<Paginado<PaginaNotion>>(
        "POST",
        `/databases/${idConGuiones(databaseId)}/query`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      paginas.push(...r.results);
      if (!r.has_more || !r.next_cursor) return paginas;
      cursor = r.next_cursor;
    }
  }

  /** Las bases de datos que la integración puede ver, siguiendo
   *  `next_cursor`. Con OAuth son exactamente las páginas y bases que la
   *  usuaria marcó al autorizar; una base archivada no se ofrece. Sin título
   *  se llama "Sin título", que es lo que enseña Notion. */
  async buscarBases(): Promise<BaseNotion[]> {
    const bases: BaseNotion[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await this.json<Paginado<BaseCruda>>("POST", "/search", {
        filter: { value: "database", property: "object" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const b of r.results) {
        if (b.object !== "database" || b.archived || b.in_trash) continue;
        bases.push({
          id: normalizarId(b.id),
          titulo: textoPlano(b.title).trim() || "Sin título",
          ultimaEdicion: b.last_edited_time ?? "",
        });
      }
      if (!r.has_more || !r.next_cursor) return bases;
      cursor = r.next_cursor;
    }
  }

  /** Una página por id (para refrescar URL de adjuntos caducadas). */
  async pagina(pageId: string): Promise<PaginaNotion> {
    return await this.json<PaginaNotion>("GET", `/pages/${pageId}`);
  }

  /** Los hijos directos de un bloque (o de una página), paginados. */
  private async hijos(blockId: string): Promise<BloqueNotion[]> {
    const bloques: BloqueNotion[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ page_size: "100" });
      if (cursor) q.set("start_cursor", cursor);
      const r = await this.json<Paginado<BloqueNotion>>("GET", `/blocks/${blockId}/children?${q}`);
      bloques.push(...r.results);
      if (!r.has_more || !r.next_cursor) return bloques;
      cursor = r.next_cursor;
    }
  }

  /** El árbol de bloques de una página, con los hijos resueltos hasta
   *  `profundidadMax` niveles. `child_page` y `child_database` NO se
   *  recorren: son otras páginas, y una base entera colgada de una página
   *  multiplicaría las peticiones sin ser contenido de esa página. */
  async bloquesDePagina(pageId: string, profundidadMax = 6): Promise<BloqueNotion[]> {
    const recorrer = async (id: string, nivel: number): Promise<BloqueNotion[]> => {
      const bloques = await this.hijos(id);
      for (const b of bloques) {
        const esOtraPagina = b.type === "child_page" || b.type === "child_database";
        if (b.has_children && !esOtraPagina && nivel < profundidadMax) {
          b.children = await recorrer(b.id, nivel + 1);
        }
      }
      return bloques;
    };
    return await recorrer(pageId, 0);
  }

  /** Bytes de un adjunto. Las URL de `file` van firmadas y no necesitan la
   *  cabecera de autorización (y mandarla a S3 haría fallar la firma); las
   *  `external` son públicas o no se pueden bajar. */
  async descargar(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (res.status === 403 || res.status === 400) throw new UrlCaducada(url, res.status);
    if (!res.ok) throw new ErrorNotion(`no se pudo descargar el adjunto (${res.status})`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------
// Lectura de propiedades y adjuntos (puro)
// ---------------------------------------------------------------------------
export function textoPlano(rico: TextoRico[] | undefined): string {
  return (rico ?? []).map((t) => t.plain_text ?? "").join("");
}

/** El título: la propiedad de tipo `title`, sea cual sea su nombre. */
export function tituloDe(pagina: PaginaNotion): string {
  for (const prop of Object.values(pagina.properties ?? {})) {
    if (prop?.type === "title") return textoPlano(prop.title).trim();
  }
  return "";
}

const VALOR_EXCLUIR = /^excluir$|^exclude$/i;

/** ¿La página pide quedarse fuera del corpus? Sí si CUALQUIER propiedad
 *  `select` o `status` vale Excluir/Exclude, se llame como se llame la
 *  columna: no se conoce de antemano cómo está montada la base y depender
 *  del nombre de una columna es depender de algo que la gente renombra. Sin
 *  ninguna propiedad así, todas las páginas cuentan: la exclusión es opcional. */
export function estaExcluida(pagina: PaginaNotion): boolean {
  for (const prop of Object.values(pagina.properties ?? {})) {
    const valor = prop?.type === "select" ? prop.select?.name : prop?.type === "status" ? prop.status?.name : undefined;
    if (valor && VALOR_EXCLUIR.test(valor.trim())) return true;
  }
  return false;
}

function urlDe(f: FicheroNotion | undefined): string {
  return f?.file?.url ?? f?.external?.url ?? "";
}

/** Nombre de fichero a partir de lo que trae Notion, o del final de la URL
 *  si no hay nombre o el nombre no lleva extensión (los `pdf` embebidos solo
 *  llevan caption, y "Anexo 2" no dice qué fichero es; la URL sí). Si ni la
 *  URL la tiene y el bloque es `pdf`, se le pone `.pdf`. */
function nombreDe(nombre: string | undefined, url: string, tipo?: string): string {
  const deUrl = (() => {
    try {
      return decodeURIComponent(url.split("?")[0]?.split("/").pop() ?? "");
    } catch {
      return url.split("?")[0]?.split("/").pop() ?? "";
    }
  })();
  const propio = (nombre ?? "").trim();
  let candidato = propio;
  if (!extensionDe(sanearNombre(propio))) {
    if (extensionDe(sanearNombre(deUrl))) candidato = deUrl;
    else if (propio && tipo === "pdf") candidato = `${propio}.pdf`;
    else candidato = propio || deUrl;
  }
  return sanearNombre(candidato);
}

/** Adjuntos de la página: los de las propiedades `files` más los bloques
 *  `file` y `pdf` del cuerpo (a cualquier profundidad). Sin duplicados por
 *  URL sin firma: el mismo fichero puede estar en una propiedad y en el
 *  cuerpo. */
export function adjuntosDe(pagina: PaginaNotion, bloques: BloqueNotion[]): Adjunto[] {
  const vistos = new Set<string>();
  const salida: Adjunto[] = [];
  const anadir = (nombre: string | undefined, url: string, tipo?: string) => {
    if (!url) return;
    const clave = url.split("?")[0] ?? url;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    const n = nombreDe(nombre, url, tipo);
    if (n) salida.push({ nombre: n, url });
  };

  for (const prop of Object.values(pagina.properties ?? {})) {
    if (prop?.type !== "files") continue;
    for (const f of prop.files ?? []) anadir(f.name, urlDe(f));
  }

  const recorrer = (lista: BloqueNotion[]) => {
    for (const b of lista) {
      if (b.type === "file" || b.type === "pdf") {
        const f = b[b.type] as FicheroNotion | undefined;
        const nombre = f?.name || textoPlano(f?.caption);
        anadir(nombre, urlDe(f), b.type);
      }
      if (b.children) recorrer(b.children);
    }
  };
  recorrer(bloques);
  return salida;
}
