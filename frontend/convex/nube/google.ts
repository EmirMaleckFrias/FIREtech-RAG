// Cliente mínimo de la API de Google Drive (v3), sin SDK: solo `fetch`. Cubre
// lo que necesita la sincronización: listar las carpetas que la persona puede
// ver (para elegir cuáles sincronizar), recorrer una carpeta con sus
// subcarpetas y descargar o exportar un fichero.
//
// Lo particular de Drive (developers.google.com/drive/api):
// - **Los formatos nativos no tienen bytes.** Un Documento, una Hoja o una
//   Presentación de Google solo existen como exportación; se piden en el
//   formato que la ingesta ya sabe leer (docx, xlsx, pdf). Lo que no se
//   puede exportar a nada útil (formularios, mapas, sitios) se omite y se dice.
// - **Un fichero puede estar en varias carpetas** y los accesos directos
//   apuntan a otro fichero. Los accesos directos se omiten: traer el destino
//   duplicaría lo que ya llega por su propia carpeta.
// - **Las unidades compartidas** hacen falta para un equipo: se listan como
//   raíces elegibles y las peticiones llevan `supportsAllDrives`.
// - **Detección de cambios**: `md5Checksum` para los ficheros binarios, y
//   `modifiedTime` para los nativos, que no tienen hash.
import {
  MAX_CARPETAS_LISTADAS,
  MAX_FICHEROS_POR_CARPETA,
  MAX_PROFUNDIDAD,
  TIMEOUT_DESCARGA_MS,
  demasiadoGrande,
  ErrorNube,
  leerAcotado,
  nombreDeRegistro,
  peticion,
  peticionJson,
  unirRuta,
  MAX_FICHERO_BYTES,
  type CarpetaNube,
  type ClienteNube,
  type CuentaNube,
  type FicheroNube,
  type ListadoCarpeta,
  type Tokens,
} from "./proveedores";

const API = "https://www.googleapis.com/drive/v3";

export const MIME_CARPETA = "application/vnd.google-apps.folder";
const MIME_ACCESO_DIRECTO = "application/vnd.google-apps.shortcut";

/** Qué exportación se pide para cada formato nativo. Los que no están aquí
 *  y son `application/vnd.google-apps.*` se omiten con aviso. */
export const EXPORTACIONES: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: "pdf" },
};

/** Ids de Drive: letras, cifras, `-` y `_`, de bastante longitud. `root` es la
 *  raíz de Mi unidad. */
const ID_DRIVE = /^[A-Za-z0-9_-]{10,}$/;

/** El id de una carpeta a partir de lo que la gente pega: el id tal cual, o
 *  la URL de la carpeta (`drive.google.com/drive/folders/<id>`, con o sin
 *  `/u/0/` y con lo que venga detrás de `?`). Vacío si no se reconoce. */
export function normalizarIdCarpetaGoogle(crudo: string): string {
  const t = crudo.trim();
  if (t === "root") return t;
  if (ID_DRIVE.test(t)) return t;
  const m = t.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : "";
}

interface FicheroCrudo {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  parents?: string[];
}

interface Paginado<T> {
  files?: T[];
  drives?: T[];
  nextPageToken?: string;
}

const CAMPOS_FICHERO = "id,name,mimeType,modifiedTime,md5Checksum,size";
const CAMPOS_CARPETA = "id,name,parents";

/** Los parámetros que hacen que Drive incluya las unidades compartidas. */
const TODAS_LAS_UNIDADES = "supportsAllDrives=true&includeItemsFromAllDrives=true";

export class ClienteGoogleDrive implements ClienteNube {
  constructor(private readonly tokens: Tokens) {}

  private async json<T>(ruta: string): Promise<T> {
    return await peticionJson<T>("google", this.tokens, `${API}${ruta}`);
  }

  /** Una consulta `files.list` paginada, hasta `tope` resultados. */
  private async listar(q: string, campos: string, tope: number): Promise<{ ficheros: FicheroCrudo[]; completo: boolean }> {
    const ficheros: FicheroCrudo[] = [];
    let token: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${campos})`,
        pageSize: "1000",
        orderBy: "name",
      });
      if (token) params.set("pageToken", token);
      const r = await this.json<Paginado<FicheroCrudo>>(`/files?${params}&${TODAS_LAS_UNIDADES}`);
      ficheros.push(...(r.files ?? []));
      if (ficheros.length >= tope) return { ficheros: ficheros.slice(0, tope), completo: false };
      if (!r.nextPageToken) return { ficheros, completo: true };
      token = r.nextPageToken;
    }
  }

  /** Las carpetas que la persona puede ver, con su ruta reconstruida a partir
   *  de `parents`, más "Mi unidad" y sus unidades compartidas como raíces.
   *  Una carpeta cuyo padre no está en la lista (compartida con ella suelta)
   *  empieza su ruta en sí misma. */
  async listarCarpetas(): Promise<CarpetaNube[]> {
    const { ficheros } = await this.listar(
      `mimeType='${MIME_CARPETA}' and trashed=false`,
      CAMPOS_CARPETA,
      MAX_CARPETAS_LISTADAS,
    );
    const porId = new Map(ficheros.map((f) => [f.id, f]));
    const raices = new Map<string, string>([["root", "Mi unidad"]]);
    try {
      const r = await this.json<Paginado<{ id: string; name: string }>>("/drives?pageSize=100");
      for (const d of r.drives ?? []) raices.set(d.id, `Unidad compartida: ${d.name}`);
    } catch {
      // Una cuenta personal no tiene unidades compartidas y la API puede
      // negarse: no es un fallo de la lista.
    }
    // "Mi unidad" es la raíz de la cuenta y su id real no es "root" en las
    // respuestas de `parents`, así que se resuelve una vez.
    let idRaiz = "root";
    try {
      const raiz = await this.json<{ id: string }>("/files/root?fields=id");
      idRaiz = raiz.id;
    } catch {
      /* se sigue con "root" */
    }
    const rutaDe = (id: string, vistos: Set<string>): string => {
      const f = porId.get(id);
      if (!f) return raices.get(id) ?? (id === idRaiz ? "Mi unidad" : "");
      const padre = f.parents?.[0];
      if (!padre || vistos.has(padre)) return f.name;
      vistos.add(padre);
      const arriba = rutaDe(padre, vistos);
      return arriba === "" ? f.name : `${arriba} / ${f.name}`;
    };
    const carpetas: CarpetaNube[] = [{ id: "root", nombre: "Mi unidad", ruta: "Mi unidad" }];
    for (const [id, nombre] of raices) if (id !== "root") carpetas.push({ id, nombre, ruta: nombre });
    for (const f of ficheros) carpetas.push({ id: f.id, nombre: f.name, ruta: rutaDe(f.id, new Set([f.id])) });
    return carpetas.sort((a, b) => a.ruta.localeCompare(b.ruta, "es"));
  }

  /** Recorre la carpeta y sus subcarpetas (en anchura, con topes) y devuelve
   *  los ficheros con la decisión tomada sobre cada uno. */
  async ficherosDeCarpeta(carpetaId: string): Promise<ListadoCarpeta> {
    const salida: FicheroNube[] = [];
    const avisos: string[] = [];
    let completo = true;
    const cola: Array<{ id: string; ruta: string; nivel: number }> = [{ id: carpetaId, ruta: "", nivel: 0 }];
    while (cola.length > 0) {
      const { id, ruta, nivel } = cola.shift()!;
      const { ficheros, completo: paginaCompleta } = await this.listar(
        `'${id}' in parents and trashed=false`,
        CAMPOS_FICHERO,
        MAX_FICHEROS_POR_CARPETA,
      );
      if (!paginaCompleta) {
        completo = false;
        avisos.push(`la carpeta '${ruta || "elegida"}' tiene más de ${MAX_FICHEROS_POR_CARPETA} elementos; solo se miran los primeros`);
      }
      for (const f of ficheros) {
        if (f.mimeType === MIME_CARPETA) {
          if (nivel + 1 > MAX_PROFUNDIDAD) {
            completo = false;
            avisos.push(`la carpeta '${unirRuta(ruta, f.name)}' está demasiado anidada y no se recorre`);
            continue;
          }
          cola.push({ id: f.id, ruta: unirRuta(ruta, f.name), nivel: nivel + 1 });
          continue;
        }
        salida.push(aFichero(f, ruta));
        if (salida.length >= MAX_FICHEROS_POR_CARPETA) {
          completo = false;
          avisos.push(`la carpeta elegida tiene más de ${MAX_FICHEROS_POR_CARPETA} ficheros; solo se sincronizan los primeros`);
          return { ficheros: salida, completo, avisos };
        }
      }
    }
    return { ficheros: salida, completo, avisos };
  }

  /** Los bytes: la exportación para un formato nativo, o el contenido tal
   *  cual. Acotado en tamaño y en tiempo. */
  async descargar(f: FicheroNube): Promise<Uint8Array> {
    if (f.tamano !== null && f.tamano > MAX_FICHERO_BYTES) {
      throw new ErrorNube(demasiadoGrande(f.nombre, f.tamano), 413);
    }
    const ruta = f.exportar
      ? `/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(f.exportar.mime)}`
      : `/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
    const res = await peticion("google", this.tokens, `${API}${ruta}`, {
      signal: AbortSignal.timeout(TIMEOUT_DESCARGA_MS),
    });
    return await leerAcotado(res, f.nombre);
  }
}

/** La decisión sobre un fichero de Drive: cómo se llama, cómo se detecta un
 *  cambio, si se exporta y si se omite. */
export function aFichero(f: FicheroCrudo, ruta: string): FicheroNube {
  const exportar = EXPORTACIONES[f.mimeType] ?? null;
  const nativo = f.mimeType.startsWith("application/vnd.google-apps.");
  let omitir: string | null = null;
  if (f.mimeType === MIME_ACCESO_DIRECTO) omitir = "es un acceso directo a otro fichero";
  else if (nativo && !exportar) omitir = "es un formato de Google que no se puede exportar a documento";
  const tamano = f.size === undefined ? null : Number(f.size);
  return {
    id: f.id,
    nombre: nombreDeRegistro(f.name, exportar?.ext ?? null),
    ruta: unirRuta(ruta, f.name),
    version: f.md5Checksum ?? f.modifiedTime ?? "",
    tamano: tamano !== null && Number.isFinite(tamano) ? tamano : null,
    mime: f.mimeType,
    exportar,
    omitir,
  };
}

/** La cuenta con la que se autorizó, para "Conectado como …". */
export async function cuentaGoogle(tokens: Tokens): Promise<CuentaNube> {
  const r = await peticionJson<{
    user?: { displayName?: string; emailAddress?: string; photoLink?: string; permissionId?: string };
  }>("google", tokens, `${API}/about?fields=user`);
  const u = r.user ?? {};
  const correo = typeof u.emailAddress === "string" && u.emailAddress !== "" ? u.emailAddress : null;
  return {
    id: u.permissionId || correo || "google",
    nombre: (u.displayName ?? "").trim() || correo || "tu cuenta de Google",
    correo,
    imagen: typeof u.photoLink === "string" && /^https:\/\//.test(u.photoLink) ? u.photoLink : null,
  };
}
