// Términos con contenido para el índice de texto de Convex.
//
// El lado léxico de la búsqueda híbrida recibe frases naturales ("¿cuál es la
// sensibilidad de p-tau217 en plasma para detectar Alzheimer?"), pero el índice
// de búsqueda tiene topes documentados (docs.convex.dev/production/state/limits,
// "Full text search"): "Terms per search query: 16" y "Maximum term length:
// 32 B". Además el tokenizador es el `SimpleTokenizer` de Tantivy, que "splits
// on whitespace and punctuation" y pone en minúsculas, y el ÚLTIMO término de
// la consulta casa por prefijo. Este módulo convierte la frase en lo que el
// índice puede usar bien: sin puntuación, sin palabras vacías, sin repetidos y,
// si sobran, quedándose con los términos que más discriminan.
//
// Por qué se prioriza lo que lleva dígitos o mayúsculas: son los términos que
// el vector denso peor distingue (p-tau217 frente a p-tau181, APOE4 frente a
// APOE2, MMSE frente a MoCA), y justo por eso el índice de texto está en la
// búsqueda. Si hay que tirar algo, se tira antes "sensibilidad" que "tau217".
//
// Es lógica pura, sin `_generated`, para poder probarla sin despliegue.

/** Tope del índice: "Terms per search query: 16". */
export const MAX_TERMINOS = 16;
/** Tope del índice: "Maximum term length: 32 B". */
export const MAX_CARACTERES_TERMINO = 32;

// Palabras vacías. Listas cortas y locales a propósito: no hace falta un
// paquete para quitar artículos, preposiciones y verbos auxiliares, y una lista
// que se lee entera es una lista que se puede corregir. Van sin acentos porque
// la comparación se hace sin acentos (así "qué" y "que" caen igual).
const STOPWORDS_ES = [
  "el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del",
  "de", "a", "en", "y", "e", "o", "u", "ni", "que", "como", "cual", "cuales",
  "quien", "quienes", "cuando", "donde", "cuanto", "cuanta", "cuantos",
  "cuantas", "con", "sin", "por", "para", "sobre", "entre", "hasta", "desde",
  "hacia", "durante", "mediante", "segun", "tras", "ante", "bajo", "contra",
  "se", "su", "sus", "si", "no", "es", "son", "ser", "fue", "fueron", "era",
  "eran", "esta", "estan", "estar", "estaba", "hay", "ha", "han", "he",
  "haber", "habia", "le", "les", "me", "te", "nos", "os", "mi", "mis", "tu",
  "tus", "este", "esto", "estos", "estas", "ese", "esa", "eso", "esos", "esas",
  "aquel", "aquella", "aquello", "aquellos", "aquellas", "mas", "pero",
  "tambien", "muy", "ya", "todo", "toda", "todos", "todas", "cada", "otro",
  "otra", "otros", "otras", "porque", "pues", "asi", "aqui", "ahi", "alli",
  "dice", "dicen", "tiene", "tienen", "puede", "pueden", "hace", "hacen",
  "debe", "deben", "hacer", "algo", "alguno", "alguna", "algunos", "algunas",
  "nada", "ninguno", "ninguna", "mismo", "misma", "mismos", "mismas", "tanto",
  "tan", "solo", "bien", "existe", "existen", "respecto", "acerca", "cuyo",
  "cuya", "cuyos", "cuyas",
];
const STOPWORDS_EN = [
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "but",
  "not", "no", "is", "are", "was", "were", "be", "been", "being", "am", "it",
  "its", "this", "that", "these", "those", "with", "without", "by", "from",
  "as", "into", "about", "over", "under", "between", "among", "through",
  "which", "what", "who", "whom", "whose", "how", "why", "when", "where",
  "there", "here", "than", "then", "also", "very", "can", "could", "should",
  "would", "may", "might", "must", "do", "does", "did", "done", "have", "has",
  "had", "having", "will", "shall", "i", "you", "he", "she", "we", "they",
  "them", "their", "his", "her", "our", "your", "my", "me", "us", "him", "if",
  "so", "such", "any", "some", "all", "each", "other", "more", "most", "much",
  "many", "both", "either", "neither", "own", "same", "just", "only", "up",
  "down", "out", "off", "again", "further", "once", "please", "tell", "give",
  "regarding", "according", "versus", "vs", "etc",
];

const STOPWORDS: ReadonlySet<string> = new Set([...STOPWORDS_ES, ...STOPWORDS_EN]);

// Un término es letras, dígitos o marcas (acentos descompuestos), con guiones
// internos permitidos: "p-tau217" y "anti-inflamatorio" son un término, no dos
// y medio. El resto de la puntuación separa. Se admiten los guiones U+2010 y
// U+2011 porque los PDF los traen a veces en lugar del guion ASCII.
const PATRON_TERMINO = /[\p{L}\p{N}\p{M}]+(?:[-‐‑][\p{L}\p{N}\p{M}]+)*/gu;
const GUIONES = /[-‐‑]/g;

/** Minúsculas sin acentos: la forma en la que se compara con las stopwords. */
function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Segmentos que verá el tokenizador del índice ("p-tau217" son dos). */
function segmentos(termino: string): number {
  return termino.split(GUIONES).filter(Boolean).length;
}

/** Bytes UTF-8 de una cadena, sin depender de `Buffer` (el runtime de Convex
 *  no es Node). */
function bytesUtf8(texto: string): number {
  return new TextEncoder().encode(texto).length;
}

/** Recorta a 32 caracteres y, por si el tope es en bytes ("32 B"), también a
 *  32 bytes UTF-8, sin dejar un guion colgando al final. */
function recortar(termino: string): string {
  let t = Array.from(termino).slice(0, MAX_CARACTERES_TERMINO).join("");
  while (t.length > 0 && bytesUtf8(t) > MAX_CARACTERES_TERMINO) {
    t = Array.from(t).slice(0, -1).join("");
  }
  return t.replace(/[-‐‑]+$/u, "");
}

/** Qué tan poco lo va a distinguir el vector denso: dígitos y mayúsculas que
 *  no sean la inicial de la frase pesan más que la longitud. */
function prioridad(termino: string): number {
  let p = 0;
  if (/\p{N}/u.test(termino)) p += 100;
  const resto = termino.slice(1);
  const esSigla = termino.length >= 2 && /\p{L}/u.test(termino) &&
    termino === termino.toUpperCase();
  if (/\p{Lu}/u.test(resto) || esSigla) p += 50;
  return p + termino.length;
}

/** Términos con contenido para el índice de texto.
 *  El índice acepta 16 términos como máximo y de 32 caracteres, mientras que
 *  las consultas del plan son frases naturales más largas.
 *
 *  Reglas, en orden: se quita la puntuación (conservando guiones internos), se
 *  descartan los números sueltos ("0,94", "2023": no son palabras y el
 *  tokenizador los partiría en trozos sin sentido), los términos de un solo
 *  carácter y las palabras vacías en español e inglés; se deduplica sin
 *  distinguir mayúsculas (el índice pone todo en minúsculas); si sobran, se
 *  conservan los de más prioridad; y el resultado va en el orden de la
 *  consulta, porque el índice puntúa también la proximidad entre términos.
 *
 *  El presupuesto de 16 se cuenta en SEGMENTOS, no en cadenas: el
 *  tokenizador del índice "splits on whitespace and punctuation", así que
 *  "p-tau217" son dos términos para él aunque aquí viaje como uno. Contarlo
 *  como uno habría permitido mandar 17 o más y chocar con el tope. */
export function terminosDeBusqueda(consulta: string, max: number = MAX_TERMINOS): string[] {
  // Un `max` no finito (NaN, null forzado) no puede saltarse el tope: con NaN
  // ninguna comparación corta y saldrían todos los candidatos.
  const presupuesto = Number.isFinite(max)
    ? Math.min(MAX_TERMINOS, Math.floor(max))
    : MAX_TERMINOS;
  if (!consulta || presupuesto <= 0) return [];

  const candidatos: Array<{ termino: string; posicion: number; coste: number }> = [];
  const vistos = new Set<string>();
  const crudos = consulta.normalize("NFC").match(PATRON_TERMINO) ?? [];
  crudos.forEach((crudo, posicion) => {
    const termino = recortar(crudo);
    // Sin letras no es una palabra: un número suelto no discrimina nada.
    if (!/\p{L}/u.test(termino)) return;
    // Un solo carácter casa con todo por prefijo si cae al final.
    if (Array.from(termino).length < 2) return;
    if (STOPWORDS.has(sinAcentos(termino))) return;
    const clave = termino.toLowerCase();
    if (vistos.has(clave)) return;
    vistos.add(clave);
    candidatos.push({ termino, posicion, coste: segmentos(termino) });
  });

  // Los que más discriminan primero; a igualdad, los de antes en la frase
  // (el sort de JS es estable, así que el desempate es la posición).
  const porPrioridad = candidatos
    .slice()
    .sort((a, b) => prioridad(b.termino) - prioridad(a.termino));
  let restante = presupuesto;
  const elegidos = new Set<number>();
  for (const c of porPrioridad) {
    if (c.coste > restante) continue;
    elegidos.add(c.posicion);
    restante -= c.coste;
    if (restante === 0) break;
  }
  return candidatos.filter((c) => elegidos.has(c.posicion)).map((c) => c.termino);
}
