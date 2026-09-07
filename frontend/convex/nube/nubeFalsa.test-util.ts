// Google Drive y OneDrive simulados en memoria para las pruebas de convex/nube:
// los puntos de token de los dos proveedores, la API de Drive (v3) y Graph
// (v1.0) en lo que usa el cliente, parcheando `fetch`. Nada sale a la red.
//
// Un solo modelo de carpetas y ficheros que se sirve con la forma de cada
// API: así una misma prueba de sincronización se puede correr contra las dos.

export const TOKEN = "acceso-1";
export const TOKEN2 = "acceso-2";
export const REFRESH = "refresco-1";
export const REFRESH2 = "refresco-2";
export const DRIVE_PROPIO = "DRIVEME";

export interface CarpetaFalsa {
  id: string;
  nombre: string;
  padre: string | null;
  /** OneDrive: la unidad en la que vive; ausente = la propia. */
  driveId?: string;
}

export interface FicheroFalso {
  id: string;
  nombre: string;
  padre: string;
  mime: string;
  bytes: Uint8Array;
  /** md5 (Drive binario) / cTag (OneDrive); para un nativo de Google, la fecha. */
  version: string;
  /** Tamaño anunciado, si difiere de los bytes (para simular uno enorme). */
  tamano?: number;
  /** Google: bytes de la exportación de un formato nativo. */
  exportado?: Uint8Array;
  accesoDirecto?: boolean;
  /** OneDrive: un cuaderno de OneNote (paquete). */
  paquete?: boolean;
  driveId?: string;
}

export class NubeFalsa {
  tokens = new Set<string>([TOKEN]);
  refreshTokens = new Set<string>([REFRESH]);
  /** Respuesta del canje de código, o un status de error. */
  canje: Record<string, unknown> | number = {
    access_token: TOKEN,
    refresh_token: REFRESH,
    expires_in: 3600,
    token_type: "Bearer",
  };
  /** Microsoft rota el refresh token al renovar; Google devuelve el mismo. */
  rotarRefresh = false;
  carpetas = new Map<string, CarpetaFalsa>();
  ficheros = new Map<string, FicheroFalso>();
  unidadesCompartidas: Array<{ id: string; nombre: string }> = [];
  compartidasConmigo: CarpetaFalsa[] = [];
  cuenta = { nombre: "Dra. Neuro", correo: "neuro@clinica.example" };
  tamanoPagina = 1000;
  /** La siguiente llamada a la API responde 401 y el token actual deja de
   *  valer: simula un token caducado a mitad de corrida. */
  expulsarUnaVez = false;
  /** Gancho antes de servir los bytes de un fichero (para frenar o cortar). */
  antesDeDescargar: ((id: string) => Promise<void>) | null = null;
  llamadas: string[] = [];
  /** Cuerpos recibidos en el punto de token, para comprobar qué se mandó. */
  peticionesToken: URLSearchParams[] = [];

  constructor() {
    this.carpetas.set("root", { id: "root", nombre: "root", padre: null });
  }

  carpeta(id: string, nombre: string, padre: string | null = "root", driveId?: string) {
    this.carpetas.set(id, { id, nombre, padre, driveId });
  }

  fichero(
    id: string,
    nombre: string,
    padre: string,
    bytes: Uint8Array,
    extra: Partial<FicheroFalso> = {},
  ) {
    this.ficheros.set(id, {
      id,
      nombre,
      padre,
      mime: extra.mime ?? "application/octet-stream",
      bytes,
      version: extra.version ?? `v-${id}-1`,
      ...extra,
    });
  }

  descargas(): string[] {
    return this.llamadas.filter((l) => /alt=media|\/export\?|\/content$/.test(l));
  }

  renovaciones(): number {
    return this.peticionesToken.filter((p) => p.get("grant_type") === "refresh_token").length;
  }

  private json(cuerpo: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(cuerpo), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  private hijosDe(padre: string) {
    const carpetas = [...this.carpetas.values()].filter((c) => c.padre === padre);
    const ficheros = [...this.ficheros.values()].filter((f) => f.padre === padre);
    return { carpetas, ficheros };
  }

  private token(init: RequestInit | undefined): Response {
    const form = new URLSearchParams(String(init?.body ?? ""));
    this.peticionesToken.push(form);
    if (!form.get("client_id") || !form.get("client_secret")) {
      return this.json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      if (!form.get("code") || !form.get("redirect_uri")) return this.json({ error: "invalid_request" }, 400);
      if (typeof this.canje === "number") {
        return this.json({ error: "invalid_grant", error_description: "código malo" }, this.canje);
      }
      return this.json(this.canje);
    }
    if (form.get("grant_type") === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      if (!this.refreshTokens.has(rt)) {
        return this.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      }
      this.tokens.add(TOKEN2);
      const cuerpo: Record<string, unknown> = { access_token: TOKEN2, expires_in: 3600, token_type: "Bearer" };
      if (this.rotarRefresh) {
        this.refreshTokens.delete(rt);
        this.refreshTokens.add(REFRESH2);
        cuerpo.refresh_token = REFRESH2;
      }
      return this.json(cuerpo);
    }
    return this.json({ error: "unsupported_grant_type" }, 400);
  }

  private autorizado(init: RequestInit | undefined): Response | null {
    if (this.expulsarUnaVez) {
      this.expulsarUnaVez = false;
      this.tokens.clear();
      return this.json({ error: { code: "401", message: "Invalid Credentials" } }, 401);
    }
    const bearer = new Headers(init?.headers).get("Authorization") ?? "";
    if (!bearer.startsWith("Bearer ") || !this.tokens.has(bearer.slice(7))) {
      return this.json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
    }
    return null;
  }

  // ---- Google Drive -------------------------------------------------------
  private ficheroDrive(f: FicheroFalso) {
    const nativo = f.mime.startsWith("application/vnd.google-apps.");
    return {
      id: f.id,
      name: f.nombre,
      mimeType: f.accesoDirecto ? "application/vnd.google-apps.shortcut" : f.mime,
      modifiedTime: nativo ? f.version : "2026-09-01T10:00:00.000Z",
      ...(nativo ? {} : { md5Checksum: f.version, size: String(f.tamano ?? f.bytes.length) }),
    };
  }

  private drive(u: URL, init: RequestInit | undefined): Response {
    const ruta = u.pathname.replace(/^\/drive\/v3/, "");
    if (ruta === "/about") {
      return this.json({
        user: {
          displayName: this.cuenta.nombre,
          emailAddress: this.cuenta.correo,
          permissionId: "perm-1",
          photoLink: "https://img.example/foto.png",
        },
      });
    }
    if (ruta === "/drives") return this.json({ drives: this.unidadesCompartidas.map((d) => ({ id: d.id, name: d.nombre })) });
    if (ruta === "/files/root") return this.json({ id: "root" });
    if (ruta === "/files") {
      const q = u.searchParams.get("q") ?? "";
      const desde = Number(u.searchParams.get("pageToken") ?? "0");
      let filas: unknown[];
      if (/mimeType='application\/vnd\.google-apps\.folder'/.test(q)) {
        filas = [...this.carpetas.values()]
          .filter((c) => c.id !== "root")
          .map((c) => ({
            id: c.id,
            name: c.nombre,
            mimeType: "application/vnd.google-apps.folder",
            parents: c.padre ? [c.padre] : [],
          }));
      } else {
        const m = q.match(/^'([^']+)' in parents/);
        if (!m) return this.json({ error: { code: 400, message: "q" } }, 400);
        if (!this.carpetas.has(m[1]) && ![...this.carpetas.values()].some((c) => c.id === m[1])) {
          return this.json({ error: { code: 404, message: "File not found" } }, 404);
        }
        const { carpetas, ficheros } = this.hijosDe(m[1]);
        filas = [
          ...carpetas.map((c) => ({ id: c.id, name: c.nombre, mimeType: "application/vnd.google-apps.folder" })),
          ...ficheros.map((f) => this.ficheroDrive(f)),
        ];
      }
      const trozo = filas.slice(desde, desde + this.tamanoPagina);
      const hayMas = desde + this.tamanoPagina < filas.length;
      return this.json({ files: trozo, ...(hayMas ? { nextPageToken: String(desde + this.tamanoPagina) } : {}) });
    }
    const m = ruta.match(/^\/files\/([^/]+)(\/export)?$/);
    if (m) {
      const f = this.ficheros.get(decodeURIComponent(m[1]));
      if (!f) return this.json({ error: { code: 404, message: "File not found" } }, 404);
      if (m[2]) {
        if (!f.exportado) return this.json({ error: { code: 400, message: "Export only supports Docs Editors files" } }, 400);
        return new Response(f.exportado as BodyInit, { status: 200 });
      }
      if (u.searchParams.get("alt") !== "media") return this.json(this.ficheroDrive(f));
      return new Response(f.bytes as BodyInit, { status: 200 });
    }
    void init;
    return this.json({ error: { code: 404, message: ruta } }, 404);
  }

  // ---- OneDrive (Graph) --------------------------------------------------
  private itemGraph(x: CarpetaFalsa | FicheroFalso) {
    const driveId = x.driveId ?? DRIVE_PROPIO;
    if ("bytes" in x) {
      if (x.paquete) return { id: x.id, name: x.nombre, package: { type: "oneNote" }, parentReference: { driveId } };
      return {
        id: x.id,
        name: x.nombre,
        size: x.tamano ?? x.bytes.length,
        cTag: x.version,
        eTag: `${x.version}-e`,
        lastModifiedDateTime: "2026-09-01T10:00:00Z",
        file: { mimeType: x.mime },
        parentReference: { driveId },
      };
    }
    return { id: x.id, name: x.nombre, folder: { childCount: 0 }, parentReference: { driveId } };
  }

  private graph(u: URL, init: RequestInit | undefined): Response {
    const ruta = u.pathname.replace(/^\/v1\.0/, "");
    if (ruta === "/me") return this.json({ id: "ms-user-1", displayName: this.cuenta.nombre, mail: this.cuenta.correo });
    if (ruta === "/me/drive") return this.json({ id: DRIVE_PROPIO });
    if (ruta === "/me/drive/sharedWithMe") {
      return this.json({
        value: this.compartidasConmigo.map((c) => ({
          id: `remoto-${c.id}`,
          name: c.nombre,
          remoteItem: { id: c.id, name: c.nombre, folder: { childCount: 0 }, parentReference: { driveId: c.driveId } },
        })),
      });
    }
    const m = ruta.match(/^\/(?:me\/drive\/(root|items\/([^/]+))|drives\/([^/]+)\/items\/([^/]+))(\/children|\/content)?$/);
    if (!m) return this.json({ error: { code: "itemNotFound", message: ruta } }, 404);
    const id = m[1] === "root" ? "root" : decodeURIComponent(m[2] ?? m[4]);
    const accion = m[5];
    if (accion === "/children") {
      if (!this.carpetas.has(id)) return this.json({ error: { code: "itemNotFound", message: id } }, 404);
      const { carpetas, ficheros } = this.hijosDe(id);
      const filas = [...carpetas, ...ficheros].map((x) => this.itemGraph(x));
      const desde = Number(u.searchParams.get("$skiptoken") ?? "0");
      const trozo = filas.slice(desde, desde + this.tamanoPagina);
      const hayMas = desde + this.tamanoPagina < filas.length;
      return this.json({
        value: trozo,
        ...(hayMas
          ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0${ruta}?$top=200&$skiptoken=${desde + this.tamanoPagina}` }
          : {}),
      });
    }
    if (accion === "/content") {
      const f = this.ficheros.get(id);
      if (!f) return this.json({ error: { code: "itemNotFound", message: id } }, 404);
      return new Response(f.bytes as BodyInit, { status: 200 });
    }
    void init;
    return this.json({ error: { code: "itemNotFound", message: ruta } }, 404);
  }

  fetch = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const u = new URL(url);
    this.llamadas.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);

    if (u.hostname === "oauth2.googleapis.com" || u.hostname === "login.microsoftonline.com") {
      return this.token(init);
    }
    if (u.hostname === "www.googleapis.com" || u.hostname === "graph.microsoft.com") {
      const rechazo = this.autorizado(init);
      if (rechazo) return rechazo;
      const esDescarga = /alt=media|\/export\?|\/content$/.test(`${u.pathname}${u.search}`);
      if (esDescarga && this.antesDeDescargar) {
        const id = decodeURIComponent(u.pathname.split("/").filter((s) => s && s !== "content" && s !== "export").pop() ?? "");
        await this.antesDeDescargar(id);
      }
      return u.hostname === "www.googleapis.com" ? this.drive(u, init) : this.graph(u, init);
    }
    return new Response("no existe", { status: 404 });
  };
}
