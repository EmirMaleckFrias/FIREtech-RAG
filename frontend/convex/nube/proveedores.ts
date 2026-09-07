// Lo común a las dos nubes de ficheros con las que se conecta la aplicación,
// Google Drive y OneDrive: sus nombres, la forma que comparten sus clientes
// (listar carpetas, recorrer una carpeta, descargar un fichero) y el cliente
// HTTP con reintentos y renovación del token que usan los dos.
//
// Por qué una abstracción y no dos módulos sueltos: la sincronización
// (nube/sync.ts), el OAuth (nube/oauth.ts) y el bloque del panel son
// EXACTAMENTE iguales para las dos nubes salvo por cómo se habla con cada API.
// Así que lo que cambia vive en google.ts y onedrive.ts detrás de
// `ClienteNube`, y lo que no cambia se escribe una vez.
//
// Dos diferencias con Notion que condicionan el diseño:
// - **Los tokens caducan** (una hora) y se renuevan con un refresh token. El
//   cliente recibe `tokens.renovar()` y lo llama UNA vez cuando la API
//   responde 401 a mitad de una corrida larga; el token de arranque lo
//   renueva la sincronización antes de empezar si le quedaba poco.
// - **Los ficheros son ficheros**, no páginas: no hay nada que renderizar a
//   Markdown, pero hay formatos nativos (un Documento de Google) que solo
//   existen como exportación, y carpetas anidadas que hay que recorrer.
import { extensionDe, sanearNombre } from "../documentos";

export type Proveedor = "google" | "onedrive";

export const PROVEEDORES: readonly Proveedor[] = ["google", "onedrive"];

/** Cómo se llama cada nube para la usuaria. */
export const NOMBRE: Record<Proveedor, string> = {
  google: "Google Drive",
  onedrive: "OneDrive",
};

export function esProveedor(x: unknown): x is Proveedor {
  return x === "google" || x === "onedrive";
}

/** Tope de un fichero traído de la nube. El mismo que el de un adjunto de
 *  Notion, y por la misma razón: la sincronización corre en el runtime por
 *  defecto de Convex, con 64 MiB, y tiene el fichero entero en memoria más
 *  una copia. Lo que pase de aquí se dice en los avisos: súbelo a mano. */
export const MAX_FICHERO_BYTES = 20 * 1024 * 1024;
export const TIMEOUT_DESCARGA_MS = 60_000;

/** Topes del recorrido de una carpeta. Existen para que elegir "toda mi
 *  unidad" con veinte mil fotos no deje la corrida dando vueltas: al llegar
 *  al tope se para de listar, se avisa, y el listado se marca INCOMPLETO
 *  para que no se retire nada por no haberlo visto. */
export const MAX_FICHEROS_POR_CARPETA = 2000;
export const MAX_PROFUNDIDAD = 12;

/** Cuántas carpetas se ofrecen en la lista para elegir. */
export const MAX_CARPETAS_LISTADAS = 500;

// ---------------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------------
/** Un fichero tal como lo ve la sincronización, ya con las decisiones tomadas
 *  por el cliente del proveedor. */
export interface FicheroNube {
  id: string;
  /** Nombre con el que se registra (saneado, con extensión). Para un formato
   *  nativo exportado lleva la extensión de la exportación. */
  nombre: string;
  /** Ruta legible dentro de la carpeta elegida ("Protocolos/2026/guia.pdf"),
   *  para el progreso y los avisos. */
  ruta: string;
  /** Lo que cambia cuando cambia el contenido: se compara por igualdad. */
  version: string;
  /** Bytes anunciados, o null si el proveedor no lo dice (formatos nativos). */
  tamano: number | null;
  mime: string;
  /** Si hay que pedir una exportación en vez de los bytes tal cual. */
  exportar: { mime: string; ext: string } | null;
  /** Por qué no se puede traer (un formulario de Google, un cuaderno de
   *  OneNote, un acceso directo). null = se trae. */
  omitir: string | null;
}

export interface CarpetaNube {
  id: string;
  nombre: string;
  /** Ruta legible desde la raíz ("Mi unidad / Clínica / Protocolos"). */
  ruta: string;
}

export interface ListadoCarpeta {
  ficheros: FicheroNube[];
  /** false si se cortó por un tope: entonces no se retira nada. */
  completo: boolean;
  avisos: string[];
}

/** La cuenta del proveedor con la que se conectó. */
export interface CuentaNube {
  id: string;
  nombre: string;
  correo: string | null;
  imagen: string | null;
}

export interface ClienteNube {
  listarCarpetas(): Promise<CarpetaNube[]>;
  ficherosDeCarpeta(carpetaId: string): Promise<ListadoCarpeta>;
  descargar(f: FicheroNube): Promise<Uint8Array>;
}

/** De dónde saca el cliente el token: el vigente, y cómo pedir otro cuando la
 *  API dice que ya no vale. */
export interface Tokens {
  actual(): string;
  renovar(): Promise<string>;
}

/** Un token fijo, para las llamadas cortas (listar carpetas, leer la cuenta)
 *  donde renovar a mitad no tiene sentido. */
export function tokenFijo(token: string): Tokens {
  return { actual: () => token, renovar: async () => token };
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------
export class ErrorNube extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly codigo?: string,
  ) {
    super(message);
    this.name = "ErrorNube";
  }
}

/** El proveedor no acepta ni el token ni su renovación: hay que volver a
 *  conectar. La sincronización lo distingue para marcar la conexión. */
export class ErrorReconexion extends Error {
  constructor(public readonly proveedor: Proveedor) {
    super(`${NOMBRE[proveedor]} ya no acepta el permiso de esta conexión: vuelve a conectar`);
    this.name = "ErrorReconexion";
  }
}

// ---------------------------------------------------------------------------
// Cliente HTTP común
// ---------------------------------------------------------------------------
function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pausa tras un 429 sin `Retry-After`, y entre reintentos de 5xx. Ajustable
 *  para los tests, que simulan la API en memoria y no tienen que esperar. */
let esperaMs = 1000;
export function configurarEspera(ms: number): void {
  esperaMs = Math.max(0, ms);
}

/**
 * Petición a la API del proveedor con las tres cosas que necesitan las dos:
 * - 401: se renueva el token UNA vez y se repite. Un segundo 401 ya es un
 *   permiso revocado, y se propaga como `ErrorReconexion`.
 * - 429 y 5xx: se espera (`Retry-After`, tope 30 s) y se reintenta, hasta 4
 *   intentos en total. Graph y Drive limitan por usuario y avisan así.
 * - Los demás 4xx son del llamador o de permisos y no se reintentan.
 */
export async function peticion(
  proveedor: Proveedor,
  tokens: Tokens,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let ultimo: ErrorNube | null = null;
  let renovado = false;
  for (let intento = 0; intento < 4; intento++) {
    const cabeceras = new Headers(init.headers);
    cabeceras.set("Authorization", `Bearer ${tokens.actual()}`);
    const res = await fetch(url, { ...init, headers: cabeceras });
    if (res.ok) return res;

    let detalle = "";
    let codigo: string | undefined;
    try {
      const err = (await res.json()) as { error?: { message?: string; code?: string | number } | string };
      if (typeof err.error === "string") detalle = err.error;
      else {
        detalle = err.error?.message ?? "";
        codigo = err.error?.code === undefined ? undefined : String(err.error.code);
      }
    } catch {
      /* sin cuerpo JSON */
    }
    ultimo = new ErrorNube(
      `${NOMBRE[proveedor]} respondió ${res.status}${detalle ? `: ${detalle}` : ""}`,
      res.status,
      codigo,
    );
    if (res.status === 401) {
      if (renovado) throw new ErrorReconexion(proveedor);
      renovado = true;
      await tokens.renovar();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get("Retry-After") ?? "");
      const segundos = Number.isFinite(retry) && retry > 0 ? Math.min(30, retry) : null;
      await dormir(segundos === null ? esperaMs : segundos * 1000);
      continue;
    }
    throw ultimo;
  }
  throw ultimo ?? new ErrorNube(`${NOMBRE[proveedor]} no respondió`, 0);
}

export async function peticionJson<T>(
  proveedor: Proveedor,
  tokens: Tokens,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await peticion(proveedor, tokens, url, init);
  return (await res.json()) as T;
}

/** Lee el cuerpo de una descarga acotando el tamaño ANTES de tener los bytes:
 *  por `Content-Length` si viene y contando lo leído si no. Un fichero de
 *  30 MB mataría la acción por memoria antes de llegar a ningún `catch`, y
 *  la corrida volvería a morir en el mismo fichero cada hora. */
export async function leerAcotado(res: Response, nombre: string): Promise<Uint8Array> {
  const anunciado = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(anunciado) && anunciado > MAX_FICHERO_BYTES) {
    throw new ErrorNube(demasiadoGrande(nombre, anunciado), 413);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const trozos: Uint8Array[] = [];
  let total = 0;
  const lector = res.body.getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FICHERO_BYTES) {
      await lector.cancel().catch(() => undefined);
      throw new ErrorNube(demasiadoGrande(nombre, total), 413);
    }
    trozos.push(value);
  }
  const salida = new Uint8Array(total);
  let o = 0;
  for (const t of trozos) {
    salida.set(t, o);
    o += t.byteLength;
  }
  return salida;
}

export function demasiadoGrande(nombre: string, bytes: number): string {
  const mb = Math.round(bytes / (1024 * 1024));
  return `'${nombre}' pesa ${mb || "más de 20"} MB y el máximo desde la nube son ${MAX_FICHERO_BYTES / (1024 * 1024)} MB; súbelo a mano desde el panel`;
}

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------
/** El nombre con el que se registra un fichero: saneado y, si es una
 *  exportación, con la extensión de la exportación (un Documento de Google
 *  "Protocolo p-tau" pasa a `Protocolo_p-tau.docx`). Si el nombre ya traía
 *  esa extensión no se duplica. */
export function nombreDeRegistro(nombre: string, ext: string | null): string {
  const saneado = sanearNombre(nombre.trim()) || "fichero";
  if (ext === null) return saneado;
  return extensionDe(saneado) === ext ? saneado : `${saneado}.${ext}`;
}

/** Une los tramos de una ruta legible. */
export function unirRuta(base: string, nombre: string): string {
  return base === "" ? nombre : `${base}/${nombre}`;
}
