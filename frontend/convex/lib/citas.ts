// Cómo se nombra y se localiza un fragmento, y cómo se reconoce una cita o una
// abstención en un texto. Es la pieza más pequeña del sistema y la que más
// cosas comparten, así que vive sola y sin dependencias: la importan la
// búsqueda, el agente, el verificador, el revisor y el evaluador.
//
// Port de `backend/app/models.py` (Chunk.fuente/locator/cite) y de las dos
// constantes públicas de `backend/app/evaluation.py`. Las expresiones son las
// mismas salvo el patrón de "no pude comprobar", añadido aquí: este módulo
// es ahora la única fuente de verdad (el evaluador Python quedó como
// referencia histórica).
// Este módulo NO importa `_generated`, a propósito: es lógica pura y así se
// puede comprobar y probar sin que exista un despliegue de Convex. El tipo del
// fragmento se declara estructuralmente y la fila real de la tabla `chunks`
// encaja con él.

/** Un fragmento recuperado. Es la fila de `chunks` sin el vector, que no hace
 *  falta para nada después de la búsqueda y pesa 3072 números. */
export interface Fragmento {
  _id: string;
  text: string;
  sourceFile: string;
  page: number;
  sourcePages?: number[];
  section?: string;
  chunkType: string;
  projectId?: string;
  documentId?: string;
  documentVersion?: string;
  documentType?: string;
  language?: string;
  titulo?: string;
  citation?: string;
  doi?: string;
  metadata?: unknown;
  environment?: string;
  /** Puntuación de la búsqueda que lo trajo. */
  score?: number;
}

/** Cómo nombrar el documento en una cita: la referencia corta si la hay.
 *
 *  `citation` vacía significa que no se pudo determinar la obra, y entonces se
 *  cita por nombre de archivo. */
export function fuente(ch: {
  citation?: string | null;
  sourceFile: string;
}): string {
  return ch.citation || ch.sourceFile;
}

/** Cómo encontrar este fragmento dentro de su documento.
 *
 *  No todo documento tiene páginas: un .docx las calcula el visor al
 *  renderizar y un .txt no tiene ninguna, así que decir "pág. 3" de un Word
 *  sería inventarse un número que nadie puede comprobar. Se cita lo que de
 *  verdad existe en cada formato: la página en un PDF, la fila en una tabla, y
 *  la sección o el número de fragmento en el resto. */
export function localizador(ch: {
  documentType?: string | null;
  page: number;
  chunkType: string;
  section?: string | null;
}): string {
  if (ch.documentType === "pdf" && ch.page) return `pág. ${ch.page}`;
  if (ch.chunkType === "table") {
    // En una hoja de cálculo cada fragmento ES una fila; en Word es una tabla
    // entera, y llamarla fila engañaría a quien la busque.
    if (ch.documentType === "docx") return `tabla ${ch.page}`;
    return `fila ${ch.page}`;
  }
  if (ch.section) return `sección: ${ch.section}`;
  return `fragmento ${ch.page}`;
}

/** La cita literal que el modelo debe copiar, con sus corchetes. */
export function cita(ch: {
  citation?: string | null;
  sourceFile: string;
  documentType?: string | null;
  page: number;
  chunkType: string;
  section?: string | null;
}): string {
  return `[${fuente(ch)}, ${localizador(ch)}]`;
}

/** Forma de una cita dentro de una respuesta.
 *
 *  Acepta los cinco localizadores que produce `localizador`, con y sin tilde y
 *  con y sin punto en "pág.", porque el modelo copia de lo que se le dio y una
 *  diferencia de acento no debería contar como cita inventada. La `g` va aquí
 *  para poder iterar coincidencias; ojo con `lastIndex` si se reutiliza el
 *  objeto (usa `nuevaRegexCitas()` cuando necesites una limpia). */
export const PATRON_CITA =
  /\[[^[\]\n]+,\s*(?:p[aá]g\.?|secci[oó]n:|fila|tabla|fragmento)\s*[^[\]\n]+\]/gi;

/** Una copia nueva del patrón, sin estado de iteración compartido. */
export function nuevaRegexCitas(): RegExp {
  return new RegExp(PATRON_CITA.source, "gi");
}

/** Frases con las que una respuesta declara que NO encontró la información.
 *
 *  Es la línea que separa "no hay nada que atribuir", que es correcto, de
 *  "afirmó sin respaldo", que es el peor caso posible. El prompt del agente
 *  pide exactamente estas fórmulas justo por esto: cualquier otra redacción se
 *  auditaría como una afirmación sin cita. */
export const PATRONES_ABSTENCION: readonly string[] = [
  "no (?:lo |la )?encuentro",
  "no (?:aparece|figura|consta)",
  "no hay (?:evidencia|informaci[oó]n|datos)",
  "los documentos no (?:indican|mencionan|contienen|permiten)",
  // Añadido en Convex: la fórmula para un punto cuya BÚSQUEDA falló ("No pude
  // comprobar X en los documentos") es una declaración, no una afirmación
  // sobre una fuente. Sin este patrón, el verificador la trataba como
  // afirmación sin cita, que es bloqueante, y cualquier respuesta con un
  // punto en error acababa rechazada. Lo cazó la revisión adversarial del
  // bucle antes de que llegara a una médica.
  "no (?:pude|se pudo|fue posible) comprobar",
];

const _ABSTENCION = PATRONES_ABSTENCION.map((p) => new RegExp(p, "i"));

/** Si el texto declara ausencia de evidencia. */
export function pareceAbstencion(texto: string): boolean {
  return _ABSTENCION.some((r) => r.test(texto));
}

/** Cómo se cita el catálogo del índice.
 *
 *  No casa con `PATRON_CITA`, y con razón: no apunta a un fragmento, apunta a
 *  un conteo exacto. Pero hay que reconocerla, porque si no una respuesta de
 *  inventario ("tienes 12 documentos y son estos") se leía como una respuesta
 *  que afirma sin citar nada, o sea el peor veredicto posible, cuando en
 *  realidad citó la única fuente que existe para ese dato. */
export const CITA_INVENTARIO = /\[inventario del [ií]ndice\]/i;

/** Clave de agrupación de una cita: minúsculas y espacios normalizados.
 *
 *  Laxa en forma y estricta en contenido: el modelo copia la cita literal,
 *  pero un espacio de diferencia no debería contar como cita inventada. */
export function claveCita(texto: string): string {
  return texto.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}
