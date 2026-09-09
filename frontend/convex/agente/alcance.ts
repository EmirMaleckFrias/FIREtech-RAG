// Alcance de una pregunta: a qué documento pide limitarse.
//
// Medido con pruebas externas el 8 sep 2026: la pregunta "Usando únicamente el
// PDF indexado, analiza este escenario" se buscaba en todo el corpus, igual que
// cualquier otra, y la respuesta podía traer fragmentos de otros documentos
// sin que nada lo dijera. El clasificador ya devuelve la PISTA del documento
// (lo que escribió quien pregunta: "el PDF indexado", "el PDF M6U1", "el
// documento de Allegri"); aquí se resuelve contra los documentos de la persona
// y el bucle convierte el resultado en un filtro `documentId` de la búsqueda.
//
// Reglas, de la más a la menos exigente:
//
// 1. Con palabras que identifican ("M6U1", "Allegri", "guia_hta"): el
//    documento cuyo nombre de fichero o título contiene TODAS es el elegido.
//    Si más de uno las contiene todas, no se elige ninguno: adivinar entre dos
//    documentos parecidos es peor que buscar en los dos y decirlo.
// 2. Sin palabras que identifiquen ("el PDF", "el documento indexado"): la
//    pista solo dice el formato. Si hay UN solo documento de ese formato, es
//    ese (el caso medido: una cuenta con un PDF). Si hay varios, es ambiguo,
//    y el bucle busca en todos pero obliga a la respuesta a decir de cuál
//    sale cada dato.
// 3. Con palabras que identifican y ningún documento que las lleve:
//    desconocido. Se busca en todos y se avisa.
//
// Sin llamadas al modelo: es comparación de texto normalizado, determinista y
// probada tal cual.
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Lo que se sabe de un documento para reconocerlo por su nombre. */
export interface DocumentoNombrado {
  id: Id<"documents">;
  fileName: string;
  titulo?: string;
}

export type Alcance =
  | { tipo: "sin_pista" }
  /** Un solo documento encaja: la búsqueda se limita a él. `porContenido`
   *  cuando no encajó por nombre y se resolvió por el tema del documento. */
  | { tipo: "elegido"; id: Id<"documents">; nombre: string; generico: boolean; porContenido?: boolean }
  /** Varios encajan (o la pista es genérica y hay varios de ese formato). */
  | { tipo: "ambiguo"; candidatos: number; generico: boolean }
  /** La pista nombra algo que no está entre los documentos. */
  | { tipo: "desconocido" };

/** Palabras que no identifican un documento: artículos, preposiciones y los
 *  nombres genéricos de un documento en los dos idiomas. */
const GENERICAS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "en", "al", "y", "o", "que", "con", "este", "esta", "ese", "esa", "mi", "su",
  "the", "a", "an", "of", "in", "this", "that", "my",
  "documento", "documentos", "archivo", "fichero", "articulo", "paper", "texto", "informe", "guia", "manual", "libro", "capitulo", "pagina",
  "document", "file", "article", "text", "report", "guide", "book", "chapter",
  "indexado", "indexada", "subido", "subida", "cargado", "cargada", "adjunto", "adjunta", "indexed", "uploaded", "attached",
  "unicamente", "solo", "solamente", "exclusivamente", "only", "using", "usando",
  // Formatos: dicen qué tipo de documento, no cuál.
  "pdf", "word", "docx", "doc", "excel", "xlsx", "csv", "markdown", "md", "txt", "pptx", "powerpoint", "notion",
]);

/** Formato al que apunta una pista genérica, por las extensiones que le
 *  corresponden. Vacío: cualquier documento. */
const FORMATOS: Array<[palabras: string[], extensiones: string[]]> = [
  [["pdf"], ["pdf"]],
  [["word", "docx", "doc"], ["docx", "doc"]],
  [["excel", "xlsx", "csv"], ["xlsx", "xls", "csv"]],
  [["markdown", "md"], ["md", "markdown"]],
  [["txt"], ["txt"]],
  [["pptx", "powerpoint"], ["pptx", "ppt"]],
];

/** Minúsculas, sin acentos, solo letras y números separados por un espacio. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** El nombre de fichero sin la extensión. */
function sinExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, "");
}

function extensionDe(fileName: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(fileName);
  return m ? m[1].toLowerCase() : "";
}

/** Las palabras de la pista que pueden identificar un documento. */
export function palabrasQueIdentifican(pista: string): string[] {
  return normalizar(pista)
    .split(" ")
    .filter((p) => p !== "" && !GENERICAS.has(p) && (p.length >= 2 || /\d/.test(p)));
}

/** Extensiones a las que apunta la pista por su formato; vacío si a cualquiera. */
function extensionesDe(pista: string): string[] {
  const palabras = new Set(normalizar(pista).split(" "));
  for (const [nombres, extensiones] of FORMATOS) {
    if (nombres.some((n) => palabras.has(n))) return extensiones;
  }
  return [];
}

/** Texto por el que se reconoce un documento: fichero sin extensión y título. */
function textoDe(d: DocumentoNombrado): string {
  return normalizar(`${sinExtension(d.fileName)} ${d.titulo ?? ""}`);
}

function nombreDe(d: DocumentoNombrado): string {
  const titulo = (d.titulo ?? "").trim();
  return titulo !== "" ? titulo : d.fileName;
}

/** Resuelve la pista contra los documentos listos de la persona. */
export function elegirDocumento(pista: string, documentos: DocumentoNombrado[]): Alcance {
  const limpia = pista.trim();
  if (limpia === "" || documentos.length === 0) return { tipo: "sin_pista" };
  const palabras = palabrasQueIdentifican(limpia);

  if (palabras.length === 0) {
    // Pista genérica: el formato es lo único que dice.
    const extensiones = extensionesDe(limpia);
    const candidatos = extensiones.length
      ? documentos.filter((d) => extensiones.includes(extensionDe(d.fileName)))
      : documentos;
    if (candidatos.length === 1) return { tipo: "elegido", id: candidatos[0].id, nombre: nombreDe(candidatos[0]), generico: true };
    if (candidatos.length === 0) return { tipo: "desconocido" };
    return { tipo: "ambiguo", candidatos: candidatos.length, generico: true };
  }

  // Con palabras que identifican: TODAS tienen que estar en el nombre. Cada
  // palabra se busca como palabra entera del nombre normalizado o como
  // principio de una ("allegri" encuentra "allegri2023"), nunca como trozo
  // interior ("tau" no debe encontrar "restaurante").
  const encajan = documentos.filter((d) => {
    const partes = textoDe(d).split(" ");
    return palabras.every((p) => partes.some((q) => q === p || q.startsWith(p)));
  });
  // Dos filas del mismo fichero (un duplicado tolerado) cuentan como uno.
  const nombres = new Set(encajan.map((d) => normalizar(d.fileName)));
  if (encajan.length >= 1 && nombres.size === 1) {
    return { tipo: "elegido", id: encajan[0].id, nombre: nombreDe(encajan[0]), generico: false };
  }
  if (encajan.length > 1) return { tipo: "ambiguo", candidatos: nombres.size, generico: false };
  return { tipo: "desconocido" };
}

/** Cuántos fragmentos de la muestra léxica se miran para resolver una pista
 *  por su contenido. */
export const MUESTRA_CONTENIDO = 60;
/** Aciertos mínimos para afirmar algo: con dos o tres fragmentos sueltos no
 *  se elige un documento. */
export const ACIERTOS_MINIMOS = 8;
/** Parte de la muestra que tiene que estar en el mismo documento. */
export const DOMINIO_MINIMO = 0.6;

/** Aciertos léxicos de la pista, por documento, de más a menos. */
export interface AciertosDocumento {
  documentId: string;
  aciertos: number;
}

/** El documento que DOMINA la muestra, o null si no hay uno claro.
 *
 *  Es el desempate de las pistas que describen el documento por su tema en
 *  vez de nombrarlo ("el PDF de sistemas eléctricos y electrónicos de
 *  aeronaves", medido el 9 sep 2026 en el despliegue: el fichero se llama
 *  `--M6U1_PDF.pdf` y no tiene título, así que por nombre no encajaba nada y
 *  la pregunta se buscaba en todo el corpus con un aviso confuso).
 *
 *  Exige mayoría Y el doble que el siguiente: si los aciertos están
 *  repartidos, la pista no identifica un documento y es mejor buscar en todos
 *  y decirlo que acotar al equivocado, que produciría una abstención
 *  indistinguible de "el documento no lo dice". */
export function dominante(conteos: AciertosDocumento[]): string | null {
  if (!conteos.length) return null;
  const total = conteos.reduce((n, c) => n + c.aciertos, 0);
  if (total < ACIERTOS_MINIMOS) return null;
  const [primero, segundo] = conteos;
  if (primero.aciertos / total < DOMINIO_MINIMO) return null;
  if (segundo && primero.aciertos < 2 * segundo.aciertos) return null;
  return primero.documentId;
}

/** Aciertos de la pista por documento, con el índice léxico de los
 *  fragmentos: el mismo que usa la búsqueda, sin llamar a ningún modelo.
 *  Solo el corpus de quien pregunta. */
export const documentosPorContenido = internalQuery({
  args: { propietario: v.id("users"), pista: v.string() },
  handler: async (ctx, { propietario, pista }): Promise<AciertosDocumento[]> => {
    const consulta = palabrasQueIdentifican(pista).join(" ");
    if (consulta === "") return [];
    const filas = await ctx.db
      .query("chunks")
      .withSearchIndex("porTexto", (q) => q.search("text", consulta).eq("propietario", propietario))
      .take(MUESTRA_CONTENIDO);
    const porDocumento = new Map<string, number>();
    for (const f of filas) {
      const id = (f.documentId ?? "").trim();
      if (id === "") continue;
      porDocumento.set(id, (porDocumento.get(id) ?? 0) + 1);
    }
    return [...porDocumento]
      .map(([documentId, aciertos]) => ({ documentId, aciertos }))
      // Empate: por id, para que dos corridas de la misma pregunta resuelvan
      // el alcance igual.
      .sort((a, b) => b.aciertos - a.aciertos || a.documentId.localeCompare(b.documentId));
  },
});

/** Los documentos listos de la persona, con lo justo para reconocerlos por
 *  su nombre. Solo su corpus: el alcance de una pregunta no puede resolverse
 *  a un documento ajeno, que para ella no existe. */
export const documentosDe = internalQuery({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }): Promise<DocumentoNombrado[]> => {
    const listos = await ctx.db
      .query("documents")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", propietario).eq("status", "ready"))
      .collect();
    return listos.map((d) => ({ id: d._id, fileName: d.fileName, ...(d.titulo ? { titulo: d.titulo } : {}) }));
  },
});
