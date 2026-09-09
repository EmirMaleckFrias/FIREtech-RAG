// Comprobar las declaraciones de ausencia contra el índice.
//
// Por qué existe. Toda la barrera de fidelidad audita afirmaciones POSITIVAS:
// cada frase contra el fragmento que cita. Una declaración de ausencia ("no
// encuentro X en los documentos") no tiene nada contra lo que auditarse, así
// que salía a pantalla con el sello de fidelidad intacto. Medido el 9 sep 2026
// con una pregunta descuidada de varias partes: el asistente respondió "no
// encuentro que esto se describa específicamente para el 737 en los
// documentos" cuando el PDF dedica al Boeing 737 la página 12 ("un ejemplo del
// sistema de distribución de un Boeing 737") y la 14 ("Panel de control
// sistema eléctrico B737"). Preguntado directamente lo dijo bien. Lo que pasó
// es que en modo normal hay UNA búsqueda y cuatro subpreguntas se la
// repartieron: esas páginas nunca se recuperaron, y el modelo confundió "no
// está en lo que me dieron" con "no está en el documento".
//
// Para quien investiga, una ausencia falsa hace el mismo daño que un dato
// inventado: le dice que el documento no trata algo que sí trata, y con eso
// descarta una vía.
//
// Qué comprueba, y por qué solo esto. Una búsqueda que devuelve algo NO
// demuestra que la frase esté: el índice puntúa por parecido y casi cualquier
// consulta trae fragmentos. Lo único que se puede demostrar con certeza es lo
// siguiente: la frase declara ausente una EXPRESIÓN concreta, esa expresión no
// aparece en ningún fragmento que el turno recuperó, y sí aparece literalmente
// (como palabra entera) en algún fragmento del alcance. Entonces la ausencia no
// es una ausencia: es una búsqueda que no llegó. Fuera de ese caso no se dice
// nada, porque acusar a una abstención correcta es peor que no comprobarla:
// bloquearía respuestas honestas.
//
// De ahí las condiciones de las expresiones que se comprueban:
//
//  - Son IDENTIFICADORES, no palabras corrientes: siglas en mayúsculas ("APU",
//    "TRU"), nombres propios ("Boeing", "Airbus"), o tokens con dígitos que no
//    sean un número pequeño suelto ni un año ("737", "P9", "14-2", "A320"
//    sí; "3", "28", "2023" no, porque están en cualquier documento y la
//    frase que los lleva suele ser cierta). "No encuentro cuatro TRU" no se
//    comprueba por "cuatro".
//  - Se comprueban como FRASE CONTIGUA y como palabra entera: "90 KVA" no está
//    en el documento aunque "90" y "KVA" estén por separado, y "737" no
//    encaja dentro de "1737".
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** Fragmentos que se miran por expresión. Alto: es una búsqueda léxica sobre
 *  el corpus de una persona y se hace una vez por turno y expresión. */
const MUESTRA = 120;
/** Tope de expresiones que se comprueban en un turno, para que una respuesta
 *  con cincuenta declaraciones de ausencia no dispare cincuenta búsquedas. */
export const MAX_EXPRESIONES = 12;
/** Tope de expresiones por frase: las primeras son las que la frase declara
 *  ausente; a partir de ahí suele ser contexto. */
const MAX_POR_FRASE = 3;

/** Minúsculas, sin acentos y con los espacios colapsados. No se quita la
 *  puntuación: separa palabras, y "14-2" tiene que sobrevivir como una sola. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras que no identifican nada aunque vayan en mayúsculas: fórmulas de
 *  la propia abstención y siglas demasiado comunes en cualquier corpus. */
const NO_IDENTIFICAN = new Set([
  "no", "encuentro", "aparece", "figura", "consta", "hay", "datos", "informacion", "evidencia",
  "documento", "documentos", "pdf", "pude", "puede", "posible", "comprobar", "indican", "mencionan",
  "contienen", "permiten", "los", "las", "del", "que", "para", "con", "sobre", "una", "uno",
  "ca", "cd", "cc", "ac", "dc",
]);

/** Unidades que, pegadas detrás de un número, forman con él la expresión
 *  ("90 KVA", "28 Vcc"). Solo unidades inequívocas de dos letras o más: "a"
 *  o "m" sueltas son también palabras. */
const UNIDADES = new Set([
  "kva", "kw", "mw", "vcc", "vca", "vdc", "vac", "hz", "khz", "ah", "mah", "ohm", "ohms",
  "kg", "mg", "ml", "mm", "cm", "km", "min", "seg", "segundos", "minutos", "rpm", "psi",
  "amperios", "voltios", "vatios", "grados",
]);

const sinPuntuacion = (token: string) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Un año suelto (1900 a 2099): está en cualquier documento. */
const ES_ANO = /^(?:19|20)\d\d$/;

/** Si el token, tal como se escribió, puede identificar algo. `primero`:
 *  es la primera palabra de la frase, donde la mayúscula inicial no dice
 *  nada de si es un nombre propio. */
function identifica(token: string, primero: boolean): boolean {
  const limpio = sinPuntuacion(token);
  if (limpio.length < 2) return false;
  if (NO_IDENTIFICAN.has(normalizar(limpio))) return false;
  if (/\d/.test(limpio)) {
    // Un número suelto solo identifica con tres dígitos o más y si no es un
    // año: "737" sí, "3", "28" y "2023" no. Con letras dentro siempre
    // ("P9", "A320", "14-2" lleva guion, cuenta como compuesto).
    if (/^\d+$/.test(limpio)) return limpio.length >= 3 && !ES_ANO.test(limpio);
    return true;
  }
  // Sigla en mayúsculas de tres letras o más: APU, TRU, GPU, MMSE.
  if (limpio.length >= 3 && limpio === limpio.toUpperCase() && /\p{Lu}/u.test(limpio)) return true;
  // Nombre propio: mayúscula inicial y cinco letras o más ("Boeing"), salvo
  // al principio de la frase.
  if (!primero && limpio.length >= 5 && /^\p{Lu}\p{Ll}+$/u.test(limpio)) return true;
  return false;
}

/** Si el token es una unidad que se pega al número que lo precede. */
function esUnidad(token: string): boolean {
  return UNIDADES.has(normalizar(sinPuntuacion(token)));
}

/** Las expresiones que una frase declara ausentes: tramos CONTIGUOS de tokens
 *  que identifican algo, tal como aparecen en la frase.
 *
 *  "No encuentro 90 KVA para el generador de la APU" -> ["90 KVA", "APU"]
 *  ("90" solo no identifica, pero con su unidad forma la expresión).
 *  "No encuentro que esto se describa para el 737" -> ["737"].
 *  "No encuentro un plazo de 3 segundos" -> ["3 segundos"]. */
export function expresionesDe(frase: string): string[] {
  const tokens = frase.split(/\s+/).filter(Boolean);
  const salida: string[] = [];
  let actual: string[] = [];
  // Un número pequeño suelto no identifica, pero sí abre un tramo por si le
  // sigue su unidad ("28 Vcc"); si no le sigue nada, el tramo se descarta.
  let soloNumeroPequeno = false;
  const cerrar = () => {
    if (actual.length && !soloNumeroPequeno) {
      const expr = sinPuntuacion(actual.join(" "));
      if (expr.length >= 2 && !salida.some((e) => normalizar(e) === normalizar(expr))) salida.push(expr);
    }
    actual = [];
    soloNumeroPequeno = false;
  };
  // Una coma, un punto y coma o dos puntos cierran el tramo: "APU, TRU" son
  // dos expresiones, "Boeing 737" es una.
  const cierraDetras = (token: string) => /[,;:]$/.test(token);
  tokens.forEach((token, i) => {
    const limpio = sinPuntuacion(token);
    if (identifica(token, i === 0)) {
      actual.push(token);
      soloNumeroPequeno = false;
      if (cierraDetras(token)) cerrar();
      return;
    }
    if (/^\d+$/.test(limpio) && !actual.length) {
      actual.push(token);
      soloNumeroPequeno = true;
      return;
    }
    if (actual.length && esUnidad(token) && /\d/.test(actual.join(""))) {
      actual.push(token);
      soloNumeroPequeno = false;
      if (cierraDetras(token)) cerrar();
      return;
    }
    cerrar();
  });
  cerrar();
  return salida.slice(0, MAX_POR_FRASE);
}

/** Regex que casa la expresión como palabras enteras, con espacios flexibles. */
function patronDe(expresion: string): RegExp {
  const partes = normalizar(expresion).split(" ").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])${partes.join("\\s+")}(?![\\p{L}\\p{N}])`, "u");
}

/** Si la expresión aparece, como palabras enteras, en alguno de estos textos. */
export function apareceEn(expresion: string, textos: string[]): boolean {
  const patron = patronDe(expresion);
  return textos.some((t) => patron.test(normalizar(t)));
}

/** Las expresiones que merece la pena preguntar al índice: las que la
 *  respuesta declara ausentes y que NO están en ningún fragmento recuperado.
 *  Si la expresión sí estaba en la evidencia, la frase no habla de que el
 *  término no exista (habla de una relación entre cosas que sí vio), así que
 *  no hay nada que refutar. */
export function expresionesAComprobar(ausencias: string[], recuperados: string[]): string[] {
  const salida: string[] = [];
  for (const frase of ausencias) {
    for (const expr of expresionesDe(frase)) {
      if (salida.some((e) => normalizar(e) === normalizar(expr))) continue;
      if (apareceEn(expr, recuperados)) continue;
      salida.push(expr);
      if (salida.length >= MAX_EXPRESIONES) return salida;
    }
  }
  return salida;
}

/** Dónde aparece una expresión que se declaró ausente. */
export interface Hallazgo {
  expresion: string;
  sourceFile: string;
  page: number | null;
}

/** Busca cada expresión en el corpus de quien pregunta (y en el documento al
 *  que se acotó el turno, si se acotó) y devuelve dónde aparece como palabra
 *  entera.
 *
 *  El índice léxico se usa solo para traer candidatos; la decisión es una
 *  comprobación exacta sobre el texto del fragmento. Así el resultado no
 *  depende de cómo puntúe el buscador. Solo el corpus de esa persona: una
 *  ausencia no se puede refutar con un documento ajeno, que para ella no
 *  existe. */
export const dondeAparecen = internalQuery({
  args: {
    propietario: v.id("users"),
    documentId: v.optional(v.string()),
    expresiones: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Hallazgo[]> => {
    const salida: Hallazgo[] = [];
    for (const expresion of args.expresiones.slice(0, MAX_EXPRESIONES)) {
      const consulta = expresion.trim();
      if (consulta.length < 2) continue;
      let filas: Doc<"chunks">[] = [];
      try {
        filas = await ctx.db
          .query("chunks")
          .withSearchIndex("porTexto", (q) => {
            const base = q.search("text", consulta).eq("propietario", args.propietario);
            return args.documentId ? base.eq("documentId", args.documentId) : base;
          })
          .take(MUESTRA);
      } catch (exc) {
        console.warn("comprobación de ausencia: la búsqueda falló", String(exc).slice(0, 160));
        continue;
      }
      const encontrado = filas.find((f) => apareceEn(consulta, [f.text]));
      if (encontrado) {
        salida.push({
          expresion,
          sourceFile: encontrado.sourceFile,
          page: typeof encontrado.page === "number" ? encontrado.page : null,
        });
      }
    }
    return salida;
  },
});
