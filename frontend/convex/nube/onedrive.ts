// Cliente mínimo de Microsoft Graph para OneDrive, sin SDK: solo `fetch`.
// Cubre lo que necesita la sincronización: listar carpetas para elegir,
// recorrer una carpeta con sus subcarpetas y descargar un fichero. Vale para
// OneDrive personal y para el de trabajo (SharePoint por debajo): la API es
// la misma, `/me/drive`.
//
// Lo particular de Graph (learn.microsoft.com/graph/api/resources/onedrive):
// - **Los elementos compartidos conmigo viven en OTRA unidad**, y se piden
//   por `/drives/{driveId}/items/{id}`. Para que una carpeta que una colega
//   compartió se pueda elegir igual que una propia, los ids de fuera de la
//   unidad propia van compuestos: `drive:<driveId>:<itemId>`. El cliente los
//   deshace al construir la ruta de la petición.
// - **Detección de cambios**: `cTag` cambia cuando cambia el CONTENIDO (no al
//   renombrar ni mover), que es justo lo que interesa; `eTag` de respaldo.
// - **La descarga** va por `/content`, que responde 302 a una URL
//   preautorizada; `fetch` la sigue. Así no hay que guardar la URL corta que
//   trae el listado y que caduca en una hora.
// - **Los cuadernos de OneNote** son paquetes (`package`), no ficheros: se
//   omiten y se dice.
import {
  MAX_CARPETAS_LISTADAS,
  MAX_FICHEROS_POR_CARPETA,
  MAX_PROFUNDIDAD,
  MAX_FICHERO_BYTES,
  TIMEOUT_DESCARGA_MS,
  demasiadoGrande,
  ErrorNube,
  leerAcotado,
  nombreDeRegistro,
  peticion,
  peticionJson,
  unirRuta,
  type CarpetaNube,
  type ClienteNube,
  type CuentaNube,
  type FicheroNube,
  type ListadoCarpeta,
  type Tokens,
} from "./proveedores";

const API = "https://graph.microsoft.com/v1.0";

/** Hasta qué nivel se ofrecen carpetas en la lista para elegir. Más hondo
 *  siempre se puede sincronizar eligiendo la carpeta de arriba. */
const PROFUNDIDAD_LISTA = 3;

interface ItemCrudo {
  id: string;
  name: string;
  size?: number;
  cTag?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  package?: { type?: string };
  parentReference?: { driveId?: string };
  remoteItem?: { id: string; name?: string; folder?: unknown; parentReference?: { driveId?: string } };
}

interface Paginado<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** Id compuesto para un elemento de otra unidad. */
export function idCompuesto(driveId: string, itemId: string): string {
  return `drive:${driveId}:${itemId}`;
}

/** La ruta de Graph de un elemento: la raíz, uno de la unidad propia, o uno
 *  de otra unidad por su id compuesto. */
export function rutaDeItem(id: string): string {
  if (id === "root") return "/me/drive/root";
  const m = id.match(/^drive:([^:]+):(.+)$/);
  if (m) return `/drives/${encodeURIComponent(m[1])}/items/${encodeURIComponent(m[2])}`;
  return `/me/drive/items/${encodeURIComponent(id)}`;
}

export class ClienteOneDrive implements ClienteNube {
  private idUnidadPropia: string | null = null;

  constructor(private readonly tokens: Tokens) {}

  private async json<T>(url: string): Promise<T> {
    return await peticionJson<T>("onedrive", this.tokens, url.startsWith("https://") ? url : `${API}${url}`);
  }

  private async unidadPropia(): Promise<string> {
    if (this.idUnidadPropia === null) {
      const d = await this.json<{ id: string }>("/me/drive?$select=id");
      this.idUnidadPropia = d.id;
    }
    return this.idUnidadPropia;
  }

  /** El id con el que se seguirá hablando de este elemento: simple si es de
   *  la unidad propia, compuesto si es de otra. */
  private async idDe(item: ItemCrudo): Promise<string> {
    const driveId = item.parentReference?.driveId;
    if (!driveId || driveId === (await this.unidadPropia())) return item.id;
    return idCompuesto(driveId, item.id);
  }

  /** Los hijos de una carpeta, siguiendo `@odata.nextLink`, hasta `tope`. */
  private async hijos(id: string, tope: number): Promise<{ items: ItemCrudo[]; completo: boolean }> {
    const items: ItemCrudo[] = [];
    let url: string | undefined = `${rutaDeItem(id)}/children?$top=200`;
    while (url) {
      const r: Paginado<ItemCrudo> = await this.json<Paginado<ItemCrudo>>(url);
      items.push(...r.value);
      if (items.length >= tope) return { items: items.slice(0, tope), completo: false };
      url = r["@odata.nextLink"];
    }
    return { items, completo: true };
  }

  /** Las carpetas de los primeros niveles de la unidad propia, más las que
   *  otras personas compartieron con ella, con "Todo mi OneDrive" como raíz. */
  async listarCarpetas(): Promise<CarpetaNube[]> {
    const carpetas: CarpetaNube[] = [{ id: "root", nombre: "Todo mi OneDrive", ruta: "Mi OneDrive" }];
    const cola: Array<{ id: string; ruta: string; nivel: number }> = [{ id: "root", ruta: "Mi OneDrive", nivel: 0 }];
    while (cola.length > 0 && carpetas.length < MAX_CARPETAS_LISTADAS) {
      const { id, ruta, nivel } = cola.shift()!;
      const { items } = await this.hijos(id, 500);
      for (const it of items) {
        if (!it.folder) continue;
        const idHijo = await this.idDe(it);
        const rutaHijo = `${ruta} / ${it.name}`;
        carpetas.push({ id: idHijo, nombre: it.name, ruta: rutaHijo });
        if (nivel + 1 < PROFUNDIDAD_LISTA) cola.push({ id: idHijo, ruta: rutaHijo, nivel: nivel + 1 });
      }
    }
    try {
      const r = await this.json<Paginado<ItemCrudo>>("/me/drive/sharedWithMe");
      for (const it of r.value) {
        const remoto = it.remoteItem;
        const driveId = remoto?.parentReference?.driveId;
        if (!remoto || !remoto.folder || !driveId) continue;
        const nombre = remoto.name ?? it.name;
        carpetas.push({ id: idCompuesto(driveId, remoto.id), nombre, ruta: `Compartido conmigo / ${nombre}` });
      }
    } catch {
      // Una cuenta sin nada compartido, o un inquilino que lo prohíbe: la
      // lista propia vale igual.
    }
    return carpetas;
  }

  async ficherosDeCarpeta(carpetaId: string): Promise<ListadoCarpeta> {
    const salida: FicheroNube[] = [];
    const avisos: string[] = [];
    let completo = true;
    const cola: Array<{ id: string; ruta: string; nivel: number }> = [{ id: carpetaId, ruta: "", nivel: 0 }];
    while (cola.length > 0) {
      const { id, ruta, nivel } = cola.shift()!;
      const { items, completo: paginaCompleta } = await this.hijos(id, MAX_FICHEROS_POR_CARPETA);
      if (!paginaCompleta) {
        completo = false;
        avisos.push(`la carpeta '${ruta || "elegida"}' tiene más de ${MAX_FICHEROS_POR_CARPETA} elementos; solo se miran los primeros`);
      }
      for (const it of items) {
        if (it.folder) {
          if (nivel + 1 > MAX_PROFUNDIDAD) {
            completo = false;
            avisos.push(`la carpeta '${unirRuta(ruta, it.name)}' está demasiado anidada y no se recorre`);
            continue;
          }
          cola.push({ id: await this.idDe(it), ruta: unirRuta(ruta, it.name), nivel: nivel + 1 });
          continue;
        }
        salida.push(aFichero(it, await this.idDe(it), ruta));
        if (salida.length >= MAX_FICHEROS_POR_CARPETA) {
          completo = false;
          avisos.push(`la carpeta elegida tiene más de ${MAX_FICHEROS_POR_CARPETA} ficheros; solo se sincronizan los primeros`);
          return { ficheros: salida, completo, avisos };
        }
      }
    }
    return { ficheros: salida, completo, avisos };
  }

  async descargar(f: FicheroNube): Promise<Uint8Array> {
    if (f.tamano !== null && f.tamano > MAX_FICHERO_BYTES) {
      throw new ErrorNube(demasiadoGrande(f.nombre, f.tamano), 413);
    }
    const res = await peticion("onedrive", this.tokens, `${API}${rutaDeItem(f.id)}/content`, {
      signal: AbortSignal.timeout(TIMEOUT_DESCARGA_MS),
      redirect: "follow",
    });
    return await leerAcotado(res, f.nombre);
  }
}

/** La decisión sobre un elemento de OneDrive que no es carpeta. */
export function aFichero(it: ItemCrudo, id: string, ruta: string): FicheroNube {
  let omitir: string | null = null;
  if (it.package) omitir = `es un ${it.package.type === "oneNote" ? "cuaderno de OneNote" : "paquete"}, no un fichero`;
  else if (!it.file) omitir = "no es un fichero";
  return {
    id,
    nombre: nombreDeRegistro(it.name, null),
    ruta: unirRuta(ruta, it.name),
    version: it.cTag ?? it.eTag ?? it.lastModifiedDateTime ?? "",
    tamano: typeof it.size === "number" ? it.size : null,
    mime: it.file?.mimeType ?? "",
    exportar: null,
    omitir,
  };
}

export async function cuentaOneDrive(tokens: Tokens): Promise<CuentaNube> {
  const u = await peticionJson<{ id?: string; displayName?: string; mail?: string | null; userPrincipalName?: string }>(
    "onedrive",
    tokens,
    `${API}/me?$select=id,displayName,mail,userPrincipalName`,
  );
  const correo = (u.mail ?? u.userPrincipalName ?? "").trim() || null;
  return {
    id: u.id || correo || "onedrive",
    nombre: (u.displayName ?? "").trim() || correo || "tu cuenta de Microsoft",
    correo,
    imagen: null,
  };
}
