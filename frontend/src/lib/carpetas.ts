// Subida de CARPETAS enteras: recorrer lo que se arrastra o se elige, decidir
// qué archivos se suben con qué nombre y cuáles se omiten, y llevar la cola.
//
// Existe porque la médica no tiene sus documentos de uno en uno: los tiene en
// carpetas (y subcarpetas), y subirlos a mano era exactamente el trabajo que
// esta aplicación tenía que ahorrarle. Lo que hay aquí es lógica pura sobre
// una forma mínima de "entrada del sistema de archivos", para poder probar la
// recursión, los lotes de `readEntries` y los renombres sin un navegador (las
// pruebas corren en `edge-runtime`). La parte que toca el DOM de verdad es
// pequeña y está al final.
//
// Tres decisiones que conviene no re-litigar:
//
// - **Lo que no se puede indexar se omite y se DICE, no se para la cola.** Una
//   carpeta real trae `.DS_Store`, imágenes, `.pptx`, ficheros de más de 100
//   MB. Rechazar la carpeta entera por uno de ellos sería el comportamiento
//   del antiguo formulario de un archivo, que aquí no sirve. Cada omisión
//   lleva su motivo en llano, y al final se enseñan juntas.
//
// - **Dos archivos con el mismo nombre en carpetas distintas son dos archivos.**
//   El nombre identifica al documento dentro del corpus, así que el segundo
//   se renombra anteponiendo su carpeta (`Protocolos-guia.pdf`), y si aun así
//   choca, un número. Lo que NO se sube dos veces es el mismo CONTENIDO: si el
//   sha256 ya está en el corpus (o ya apareció en esta misma carpeta), se
//   omite como "ya estaba", venga con el nombre que venga.
//
// - **`readEntries` se llama hasta que devuelve vacío.** El navegador entrega
//   los hijos de un directorio en lotes (Chrome, 100 por llamada) y una sola
//   llamada parece que funciona con carpetas pequeñas y pierde archivos con
//   las grandes en silencio. Es el error más repetido de esta API.

/** Lo que se sabe de un archivo antes de subirlo. */
export interface ArchivoConRuta {
  file: File;
  /** Carpeta relativa desde donde se soltó, con `/`, sin el nombre del
   *  fichero. "" si venía suelto. */
  carpeta: string;
}

/** Un archivo del plan, ya con el nombre con el que se registrará. */
export interface ArchivoPlaneado {
  file: File;
  carpeta: string;
  /** El nombre final: el propio, o renombrado si chocaba con otro. */
  nombre: string;
  /** Solo si el nombre no es el original: qué pasó, para el resumen. */
  renombradoDesde?: string;
  sha256: string;
}

export type MotivoOmision =
  | 'ya_estaba'
  | 'formato'
  | 'demasiado_grande'
  | 'oculto'
  | 'vacio'
  | 'ilegible';

export interface ArchivoOmitido {
  nombre: string;
  carpeta: string;
  motivo: MotivoOmision;
}

export interface PlanDeSubida {
  aSubir: ArchivoPlaneado[];
  omitidos: ArchivoOmitido[];
}

/** Lo que el corpus ya tiene, para no repetir ni chocar. */
export interface DocumentoExistente {
  fileName: string;
  sha256: string | null;
}

export const EXTENSIONES_ADMITIDAS = [
  'pdf', 'docx', 'xlsx', 'csv', 'txt', 'md',
  // Imágenes: se leen por OCR en el servidor.
  'jpg', 'jpeg', 'png', 'webp', 'gif',
] as const;
const EXT_RE = new RegExp(`\\.(${EXTENSIONES_ADMITIDAS.join('|')})$`, 'i');

/** Tope de archivos por carpeta en una sola tanda. No es un límite del
 *  servidor: es que cada archivo calcula su sha256 en el navegador y se sube
 *  por su URL, y una carpeta con miles de ficheros dejaría la pestaña ocupada
 *  media hora. Con más, se pide subirla por partes. */
export const MAX_ARCHIVOS_POR_TANDA = 500;

/** Subidas simultáneas. Tres: bastantes para que la cola no vaya a paso de
 *  una, pocas para no atragantar la red de la usuaria ni disparar a la vez
 *  cuarenta ingestas contra el gateway de embeddings. */
export const SUBIDAS_A_LA_VEZ = 3;

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------

/** Mismo saneado que `sanearNombre` en convex/documentos.ts, para que lo que
 *  se compara aquí sea lo que el servidor va a guardar. */
export function sanear(crudo: string): string {
  const partes = crudo.replace(/\\/g, '/').split('/');
  const base = partes[partes.length - 1] ?? '';
  return base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
}

/** `Protocolos/2024` → `Protocolos-2024`, saneado. "" si no había carpeta. */
export function prefijoDeCarpeta(carpeta: string): string {
  return carpeta
    .split('/')
    .filter((p) => p !== '')
    .map((p) => p.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, ''))
    .filter((p) => p !== '')
    .join('-');
}

/** Un nombre que no esté en `ocupados`: el original, luego con la carpeta
 *  delante, luego con la carpeta y un número. Añade el elegido a `ocupados`. */
export function nombreLibre(nombre: string, carpeta: string, ocupados: Set<string>): string {
  const limpio = sanear(nombre);
  if (!ocupados.has(limpio)) {
    ocupados.add(limpio);
    return limpio;
  }
  const prefijo = prefijoDeCarpeta(carpeta) || 'copia';
  const conCarpeta = `${prefijo}-${limpio}`;
  if (!ocupados.has(conCarpeta)) {
    ocupados.add(conCarpeta);
    return conCarpeta;
  }
  const punto = limpio.lastIndexOf('.');
  const base = punto > 0 ? limpio.slice(0, punto) : limpio;
  const ext = punto > 0 ? limpio.slice(punto) : '';
  for (let n = 2; ; n += 1) {
    const candidato = `${prefijo}-${n}-${base}${ext}`;
    if (!ocupados.has(candidato)) {
      ocupados.add(candidato);
      return candidato;
    }
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** ¿Es un fichero que el sistema deja en las carpetas y nadie quiere indexar? */
export function esOculto(nombre: string): boolean {
  return nombre.startsWith('.') || nombre === 'Thumbs.db' || nombre === 'desktop.ini';
}

/**
 * Decide qué se sube y qué se omite. El sha256 llega calculado (es asíncrono
 * y de DOM; esto es puro) para que el dedupe por contenido sea comprobable.
 *
 * Orden de las comprobaciones, del más barato al que más informa: oculto,
 * formato, vacío, tamaño, contenido repetido; y al final el nombre, que no
 * omite nunca, solo renombra.
 */
export function planificar(
  archivos: Array<ArchivoConRuta & { sha256: string }>,
  existentes: DocumentoExistente[],
  limiteMb: number,
  /** Omitidos antes de llegar aquí (ficheros que no se pudieron leer del
   *  disco al recorrer la carpeta), para que salgan en el mismo resumen. */
  omitidosPrevios: ArchivoOmitido[] = [],
): PlanDeSubida {
  const aSubir: ArchivoPlaneado[] = [];
  const omitidos: ArchivoOmitido[] = [...omitidosPrevios];
  const nombresOcupados = new Set(existentes.map((d) => sanear(d.fileName)));
  const hashesVistos = new Set(
    existentes.map((d) => d.sha256).filter((h): h is string => typeof h === 'string' && h !== ''),
  );
  const limite = limiteMb * 1024 * 1024;

  for (const a of archivos) {
    const nombre = a.file.name;
    const omitir = (motivo: MotivoOmision) => omitidos.push({ nombre, carpeta: a.carpeta, motivo });
    if (esOculto(nombre)) {
      omitir('oculto');
      continue;
    }
    if (!EXT_RE.test(nombre)) {
      omitir('formato');
      continue;
    }
    if (a.file.size === 0) {
      omitir('vacio');
      continue;
    }
    if (a.file.size > limite) {
      omitir('demasiado_grande');
      continue;
    }
    if (hashesVistos.has(a.sha256)) {
      omitir('ya_estaba');
      continue;
    }
    hashesVistos.add(a.sha256);
    const final = nombreLibre(nombre, a.carpeta, nombresOcupados);
    aSubir.push({
      file: a.file,
      carpeta: a.carpeta,
      nombre: final,
      sha256: a.sha256,
      ...(final !== sanear(nombre) ? { renombradoDesde: nombre } : {}),
    });
  }
  return { aSubir, omitidos };
}

/** Texto en llano del motivo, para el resumen. */
export function textoDeMotivo(motivo: MotivoOmision, limiteMb: number): string {
  switch (motivo) {
    case 'ya_estaba':
      return 'ya estaba en tus documentos (mismo contenido)';
    case 'formato':
      return 'formato no admitido (PDF, Word, Excel, CSV, TXT, MD o imágenes JPG, PNG, WEBP, GIF)';
    case 'demasiado_grande':
      return `pesa más de ${limiteMb} MB`;
    case 'oculto':
      return 'archivo oculto del sistema';
    case 'vacio':
      return 'está vacío';
    case 'ilegible':
      return 'no se pudo leer del disco (¿está descargado y accesible?)';
  }
}

/** "38 subidos · 2 ya estaban · 1 formato no admitido". Cuenta por motivo,
 *  en el orden en que importan. */
export function resumenDeTanda(
  subidos: number,
  fallidos: number,
  omitidos: ArchivoOmitido[],
): string {
  const partes: string[] = [];
  partes.push(subidos === 1 ? '1 archivo subido' : `${subidos} archivos subidos`);
  if (fallidos > 0) partes.push(fallidos === 1 ? '1 falló' : `${fallidos} fallaron`);
  const porMotivo = new Map<MotivoOmision, number>();
  for (const o of omitidos) porMotivo.set(o.motivo, (porMotivo.get(o.motivo) ?? 0) + 1);
  const etiqueta: Record<MotivoOmision, [string, string]> = {
    ya_estaba: ['ya estaba', 'ya estaban'],
    formato: ['formato no admitido', 'con formato no admitido'],
    demasiado_grande: ['demasiado grande', 'demasiado grandes'],
    oculto: ['archivo oculto', 'archivos ocultos'],
    vacio: ['vacío', 'vacíos'],
    ilegible: ['no se pudo leer del disco', 'no se pudieron leer del disco'],
  };
  for (const motivo of ['ya_estaba', 'formato', 'demasiado_grande', 'vacio', 'oculto', 'ilegible'] as const) {
    const n = porMotivo.get(motivo);
    if (!n) continue;
    partes.push(`${n} ${etiqueta[motivo][n === 1 ? 0 : 1]}`);
  }
  return partes.join(' · ');
}

// ---------------------------------------------------------------------------
// Recorrer una carpeta (forma mínima de la API de entradas del navegador)
// ---------------------------------------------------------------------------

/** Lo que se usa de `FileSystemEntry`, para poder recorrer con fakes. */
export interface EntradaFs {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  /** Solo en ficheros. */
  file?: (ok: (f: File) => void, error: (e: unknown) => void) => void;
  /** Solo en directorios. */
  createReader?: () => LectorFs;
}

export interface LectorFs {
  /** Devuelve un lote; vacío cuando no quedan. Hay que llamarlo en bucle. */
  readEntries: (ok: (entradas: EntradaFs[]) => void, error: (e: unknown) => void) => void;
}

function leerTodas(lector: LectorFs): Promise<EntradaFs[]> {
  return new Promise((resolver, rechazar) => {
    const todas: EntradaFs[] = [];
    const siguiente = () =>
      lector.readEntries(
        (lote) => {
          if (lote.length === 0) {
            resolver(todas);
            return;
          }
          todas.push(...lote);
          siguiente();
        },
        rechazar,
      );
    siguiente();
  });
}

function ficheroDe(entrada: EntradaFs): Promise<File> {
  return new Promise((resolver, rechazar) => {
    if (!entrada.file) {
      rechazar(new Error(`la entrada ${entrada.name} no es un fichero`));
      return;
    }
    entrada.file(resolver, rechazar);
  });
}

/**
 * Todos los ficheros bajo una entrada, con su carpeta relativa. Recorre en
 * profundidad y en orden estable (por nombre), para que dos subidas de la
 * misma carpeta produzcan la misma lista y los mismos renombres.
 *
 * Se detiene en `MAX_ARCHIVOS_POR_TANDA`: devuelve `truncado: true` y quien
 * llama avisa en vez de dejar la pestaña ocupada media hora.
 */
export async function recorrer(
  raiz: EntradaFs,
  carpeta = '',
  acumulado: ArchivoConRuta[] = [],
  ilegibles: ArchivoOmitido[] = [],
): Promise<{ archivos: ArchivoConRuta[]; truncado: boolean; ilegibles: ArchivoOmitido[] }> {
  if (acumulado.length >= MAX_ARCHIVOS_POR_TANDA) return { archivos: acumulado, truncado: true, ilegibles };
  if (raiz.isFile) {
    // Un fichero que no se puede leer (un marcador de la nube sin descargar,
    // un permiso, un fichero movido entre soltar y leer) se APUNTA y se
    // sigue: antes rechazaba la promesa entera, se perdía toda la tanda y la
    // zona de arrastre se quedaba como estaba, sin decir nada.
    try {
      acumulado.push({ file: await ficheroDe(raiz), carpeta });
    } catch {
      ilegibles.push({ nombre: raiz.name, carpeta, motivo: 'ilegible' });
    }
    return { archivos: acumulado, truncado: false, ilegibles };
  }
  if (!raiz.isDirectory || !raiz.createReader) return { archivos: acumulado, truncado: false, ilegibles };
  let hijos: EntradaFs[];
  try {
    hijos = (await leerTodas(raiz.createReader())).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    ilegibles.push({ nombre: raiz.name, carpeta, motivo: 'ilegible' });
    return { archivos: acumulado, truncado: false, ilegibles };
  }
  const dentro = carpeta === '' ? raiz.name : `${carpeta}/${raiz.name}`;
  let truncado = false;
  for (const hijo of hijos) {
    const r = await recorrer(hijo, dentro, acumulado, ilegibles);
    if (r.truncado) {
      truncado = true;
      break;
    }
  }
  return { archivos: acumulado, truncado, ilegibles };
}

/** De un `<input type="file" webkitdirectory>`: cada `File` trae su ruta
 *  relativa en `webkitRelativePath` ("Carpeta/sub/fichero.pdf"). El mismo
 *  tope que al arrastrar: antes este camino (el del botón destacado) no lo
 *  aplicaba y una carpeta de 3000 ficheros se hasheaba y subía entera. */
export function desdeInputDeCarpeta(files: ArrayLike<File>): { archivos: ArchivoConRuta[]; truncado: boolean } {
  const todos = Array.from(files).map((file) => {
    const ruta = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const i = ruta.lastIndexOf('/');
    return { file, carpeta: i > 0 ? ruta.slice(0, i) : '' };
  });
  return { archivos: todos.slice(0, MAX_ARCHIVOS_POR_TANDA), truncado: todos.length > MAX_ARCHIVOS_POR_TANDA };
}

/**
 * Lo soltado en la zona de arrastre: carpetas (recorridas) y ficheros sueltos.
 * Si el navegador no expone las entradas (`webkitGetAsEntry`), se cae a la
 * lista plana de `files`, que no trae carpetas pero sí los ficheros sueltos.
 */
export async function desdeDrop(
  dataTransfer: Pick<DataTransfer, 'items' | 'files'>,
): Promise<{ archivos: ArchivoConRuta[]; truncado: boolean; ilegibles: ArchivoOmitido[] }> {
  const entradas: EntradaFs[] = [];
  if (dataTransfer.items) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const entrada = (
        item as DataTransferItem & { webkitGetAsEntry?: () => EntradaFs | null }
      ).webkitGetAsEntry?.();
      if (entrada) entradas.push(entrada);
    }
  }
  if (entradas.length === 0) {
    return {
      archivos: Array.from(dataTransfer.files ?? []).map((file) => ({ file, carpeta: '' })),
      truncado: false,
      ilegibles: [],
    };
  }
  const acumulado: ArchivoConRuta[] = [];
  const ilegibles: ArchivoOmitido[] = [];
  let truncado = false;
  for (const e of entradas) {
    const r = await recorrer(e, '', acumulado, ilegibles);
    if (r.truncado) {
      truncado = true;
      break;
    }
  }
  return { archivos: acumulado, truncado, ilegibles };
}
