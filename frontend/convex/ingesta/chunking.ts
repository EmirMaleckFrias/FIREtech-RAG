// Troceo con conciencia de párrafo. Port de los helpers de
// `backend/app/ingest/generic.py`: estimación de tokens, subdivisión de
// párrafos largos, el ÚNICO empaquetador con solape, la agrupación por
// sección y el prefijo de contexto.
//
// Sin "use node": lo importan los parsers y se prueba directo.
import type { ChunkParseado, MetaObra } from "./tipos";

/** Tope duro por documento (error claro si se excede). */
export const MAX_CHUNKS = 4000;
/** Tamaño objetivo de chunk (aprox.). */
export const TARGET_TOKENS = 400;
/** 15 % de 400. */
export const OVERLAP_TOKENS = 60;
/** Párrafos más largos se subdividen por oraciones. */
export const MAX_PARA_TOKENS = 500;
/** Límite duro de texto por chunk (= truncado de embeddings). */
export const MAX_CHUNK_CHARS = 8000;

/** Estimación barata de tokens (~4 chars/token para es/en). */
export function estTokens(texto: string): number {
  return Math.max(1, Math.floor(texto.length / 4));
}

/** Extensión en minúsculas y sin punto, o "unknown". */
export function tipoDeDocumento(nombre: string): string {
  const m = /\.([^./\\]+)$/.exec(nombre);
  return (m ? m[1].toLowerCase() : "") || "unknown";
}

/** Chunk con TODAS las claves del payload, como `generic._base_chunk`.
 *
 *  `meta` es la identidad del trabajo cuando el documento es un artículo: lo
 *  que permite citar "Allegri et al., 2023" en vez del nombre del archivo. Se
 *  repite en cada fragmento a propósito, para que una cita no necesite ir a
 *  buscar nada más. `language` queda vacío hasta que se detecte. */
export function chunkBase(
  nombre: string,
  texto: string,
  page: number,
  sourcePages: number[],
  chunkType: "text" | "table",
  opciones: { section?: string; sourceRow?: number; meta?: MetaObra; citation?: string } = {},
): ChunkParseado {
  const chunk: ChunkParseado = {
    text: texto.slice(0, MAX_CHUNK_CHARS),
    page,
    sourcePages,
    section: opciones.section ?? "",
    chunkType,
    documentType: tipoDeDocumento(nombre),
    titulo: opciones.meta?.titulo ?? "",
    citation: opciones.citation ?? "",
    doi: opciones.meta?.doi ?? "",
    language: "",
  };
  if (opciones.sourceRow !== undefined) chunk.metadata = { source_row: opciones.sourceRow };
  return chunk;
}

/** Subdivide párrafos que exceden MAX_PARA_TOKENS: por oraciones y, si una
 *  "oración" sigue siendo enorme (texto sin puntuación), por palabras. */
export function partirParrafoLargo(para: string): string[] {
  if (estTokens(para) <= MAX_PARA_TOKENS) return [para];

  const oraciones: string[] = [];
  for (const cruda of para.split(/(?<=[.!?;:])\s+/)) {
    const frase = cruda.trim();
    if (!frase) continue;
    if (estTokens(frase) <= MAX_PARA_TOKENS) {
      oraciones.push(frase);
      continue;
    }
    // Sin puntuación: corte duro por palabras.
    let actual: string[] = [];
    let largo = 0;
    for (const palabra of frase.split(/\s+/)) {
      actual.push(palabra);
      largo += palabra.length + 1;
      if (Math.floor(largo / 4) >= TARGET_TOKENS) {
        oraciones.push(actual.join(" "));
        actual = [];
        largo = 0;
      }
    }
    if (actual.length) oraciones.push(actual.join(" "));
  }

  // Empaqueta oraciones en piezas de ~TARGET_TOKENS.
  const piezas: string[] = [];
  let cur: string[] = [];
  let curTok = 0;
  for (const frase of oraciones) {
    const tok = estTokens(frase);
    if (cur.length && curTok + tok > TARGET_TOKENS) {
      piezas.push(cur.join(" "));
      cur = [];
      curTok = 0;
    }
    cur.push(frase);
    curTok += tok;
  }
  if (cur.length) piezas.push(cur.join(" "));
  return piezas;
}

/** Párrafos por líneas en blanco; los muy largos se subdividen. */
export function partirParrafos(texto: string): string[] {
  const salida: string[] = [];
  for (const cruda of texto.split(/\n\s*\n/)) {
    const para = cruda.trim();
    if (para) salida.push(...partirParrafoLargo(para));
  }
  return salida;
}

/** Agrupa (párrafo, localizador) en chunks de ~TARGET_TOKENS con solape de
 *  ~OVERLAP_TOKENS tomado de los párrafos finales del chunk anterior.
 *
 *  Es el ÚNICO empaquetador del módulo, y PDF, DOCX y TXT pasan por él. Hasta
 *  sep 2026 solo lo usaba TXT: PDF y DOCX tenían bucles propios sin solape,
 *  contradiciendo el contrato del módulo, y una oración que caía en la
 *  frontera de dos chunks no estaba entera en ninguno. El localizador viaja
 *  opaco: solo el texto cuenta tokens. */
export function empaquetar<L>(paras: Array<[string, L]>): Array<Array<[string, L]>> {
  const chunks: Array<Array<[string, L]>> = [];
  let cur: Array<[string, L]> = [];
  let curTok = 0;
  for (const par of paras) {
    const ptok = estTokens(par[0]);
    if (cur.length && curTok + ptok > TARGET_TOKENS) {
      chunks.push(cur);
      // Solape: párrafos finales hasta cubrir ~OVERLAP_TOKENS.
      const cola: Array<[string, L]> = [];
      let ttok = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const t = estTokens(cur[i][0]);
        if (cola.length && ttok + t > OVERLAP_TOKENS) break;
        cola.unshift(cur[i]);
        ttok += t;
        if (ttok >= OVERLAP_TOKENS) break;
      }
      // Si el solape fuese el chunk entero no aporta nada (y duplicaría todo
      // el texto): se descarta.
      cur = cola.length === cur.length ? [] : cola.slice();
      curTok = cur.reduce((acc, [p]) => acc + estTokens(p), 0);
    }
    cur.push(par);
    curTok += ptok;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Tramos consecutivos de una misma sección: [(sección, [(texto, loc)])].
 *
 *  Se empaqueta tramo a tramo, sin mezclar secciones, para que la cita de un
 *  fragmento apunte a una sección de verdad y no a la frontera entre dos. El
 *  solape tampoco cruza secciones a propósito: un dato de Resultados no debe
 *  aparecer "de cola" en el primer chunk de Discusión, donde se leería como
 *  interpretación del autor. */
export function agruparPorSeccion<L>(
  paras: Array<[string, L, string]>,
): Array<[string, Array<[string, L]>]> {
  const grupos: Array<[string, Array<[string, L]>]> = [];
  for (const [texto, loc, sec] of paras) {
    const ultimo = grupos[grupos.length - 1];
    if (!ultimo || ultimo[0] !== sec) grupos.push([sec, []]);
    grupos[grupos.length - 1][1].push([texto, loc]);
  }
  return grupos;
}

/** Antepone al texto de un chunk sus líneas de contexto (título, sección).
 *
 *  Por qué: el embedding se calcula SOLO sobre `text`. Un fragmento de
 *  Resultados que dice "the mean was 542 pg/mL in the impaired group" no
 *  contiene ni la palabra Results ni de qué estudio sale; frente a la consulta
 *  "amyloid levels in early Alzheimer disease" puntúa peor que el mismo texto
 *  con "Cerebrospinal fluid biomarkers in early Alzheimer disease / Results"
 *  delante. Y cuando el LLM lee el fragmento sabe si está ante evidencia
 *  (Resultados) o interpretación (Discusión) sin mirar el payload.
 *
 *  No se repite lo que ya está: si dos líneas de contexto coinciden (la
 *  portada de un PDF, donde el título se detecta como encabezado por formato y
 *  pasa a ser la sección) o si el cuerpo ya arranca con esa línea (Word indexa
 *  el encabezado como bloque propio del primer chunk), se deja una sola vez. */
export function conContexto(cuerpo: string, ...contexto: string[]): string {
  const primera = cuerpo.split("\n", 1)[0].replace(/\s+/g, " ").trim().toLowerCase();
  const lineas: string[] = [];
  for (const cruda of contexto) {
    const linea = (cruda ?? "").replace(/\s+/g, " ").trim();
    if (!linea || linea.toLowerCase() === primera) continue;
    if (lineas.some((previa) => previa.toLowerCase() === linea.toLowerCase())) continue;
    lineas.push(linea);
  }
  if (!lineas.length) return cuerpo;
  return lineas.join("\n") + "\n\n" + cuerpo;
}
