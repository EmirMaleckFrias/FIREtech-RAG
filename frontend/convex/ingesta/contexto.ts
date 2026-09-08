// Recuperación contextual: una o dos frases por fragmento, escritas por un
// modelo al indexar, que lo sitúan dentro de su documento.
//
// Por qué existe. El embedding y el índice léxico de un fragmento solo ven su
// texto, y en un artículo el texto de Resultados casi nunca dice de qué está
// hablando: "the mean was 542 pg/mL in the impaired group" no nombra ni el
// biomarcador ni la cohorte ni el estudio. El prefijo de título y sección que
// ya se antepone al parsear (`chunking.conContexto`) ayuda, pero no resuelve
// los pronombres, las siglas ni "the impaired group". La medición publicada
// de esta técnica (Anthropic, "Contextual Retrieval", 2024, sobre su propio
// corpus): anteponer un contexto escrito por el modelo baja un 35 % los
// fallos de recuperación en los 20 primeros; con el mismo contexto también en
// el índice léxico, un 49 %; y con reranking detrás, un 67 %. Aquí el
// reranking ya existe (el calificador), así que esto es la pieza que faltaba.
//
// Tres decisiones:
//
// - **El contexto NO es evidencia.** Se guarda en `chunks.contexto`, entra en
//   el embedding (contexto + texto) y tiene su propio índice de búsqueda, pero
//   el texto que lee el redactor y contra el que dictamina el verificador
//   sigue siendo `text`. Una frase generada por un modelo no puede sostener
//   una cifra en una respuesta médica.
// - **Se contextualiza por GRUPOS de fragmentos consecutivos**, no uno a uno
//   con el documento entero delante, porque un manual de 800 páginas no cabe
//   en ningún prompt y porque doce fragmentos seguidos comparten casi todo su
//   contexto: una llamada por grupo en vez de doce, y el modelo ve lo que va
//   antes y después de cada uno. La ficha del documento (título, cita,
//   secciones, comienzo) va en cada llamada.
// - **Un fallo del modelo no tumba la ingesta.** El fragmento se indexa sin
//   contexto, exactamente como se indexaba antes de existir esto, y se cuenta
//   en `avisos.sinContexto` para que la ficha lo diga y reindexar lo
//   reintente. Degradar a lo de antes es mejor que fallar un documento.
//
// Sin "use node": lo importa el pipeline (Node) y lo prueban los tests sin
// red, con `gateway.completionJson` parcheado.
import * as gateway from "../lib/gateway";
import { ajustes, modeloContextoResuelto, type Ajustes } from "../lib/config";
import type { Telemetria } from "../lib/telemetry";
import { MAX_CHUNK_CHARS } from "./chunking";
import type { ChunkParseado } from "./tipos";

/** Con qué receta se escribió el índice de un documento. Cambia cuando cambia
 *  lo que se embebe o lo que se indexa (no cuando cambia solo el prompt de
 *  redacción): los documentos con otra versión se reindexan en cadena
 *  (convex/migraciones.ts) sin que nadie vuelva a subir nada. */
export const VERSION_INDICE = "2026-09-contexto-paginas-v1";

/** Versión del prompt de contexto, para la telemetría. */
export const VERSION_CONTEXTO = "v1";

/** Fragmentos consecutivos por llamada al modelo. Doce: unas 5000 palabras de
 *  entrada, que el modelo pequeño contextualiza en unos segundos, y bastante
 *  vecindad para resolver a qué se refiere cada uno. */
export const TAMANO_GRUPO = 12;

/** Tope de caracteres de un contexto. Más largo no sitúa mejor y pesa en el
 *  embedding, que recorta a 8000 caracteres el total. */
export const MAX_CONTEXTO_CHARS = 400;

/** Cuánto texto de cada fragmento ve el modelo. Un fragmento normal tiene unos
 *  1600 caracteres; uno de tabla recortado puede tener 8000, y para saber de
 *  qué habla no hace falta entero. */
const MAX_TEXTO_FRAGMENTO = 2500;

/** Secciones distintas que se listan en la ficha del documento. */
const MAX_SECCIONES = 40;

/** Caracteres del comienzo del documento que van en la ficha: la portada, el
 *  resumen o la introducción, que es donde el documento dice de qué va. */
const MAX_INICIO = 1500;

export const PROMPT_CONTEXTO = `Eres un archivero que prepara fragmentos de documentos científicos,
clínicos y administrativos para que un buscador los encuentre. Recibes la
ficha de un documento (nombre, título, cita, secciones, su comienzo) y una
lista de fragmentos CONSECUTIVOS numerados, cada uno con su página y su
sección.

Para CADA fragmento escribe un contexto breve (una o dos frases, como mucho
60 palabras) que lo sitúe dentro del documento para quien busque información.
Empieza SIEMPRE identificando el documento en una frase corta (el título
abreviado o la cita, y qué es: ensayo, cohorte, guía, contrato...), y sigue con:
- de qué trata el fragmento y a qué se refieren sus cifras, siglas y
  pronombres: qué población, cohorte, intervención, fármaco, biomarcador,
  desenlace, tabla o variable (por ejemplo "the impaired group" es la cohorte
  con deterioro cognitivo leve de este estudio);
- en qué sección está, si eso cambia cómo leerlo (Resultados, Discusión, una
  tabla, el resumen);
- las siglas y las variantes de escritura de los términos clave del
  fragmento, para que se encuentre por cualquiera de ellas: "Aβ42 (Abeta42,
  amyloid beta 42)", "APOE ε4 (APOE4)", "MCI (mild cognitive impairment)",
  el nombre comercial y el principio activo de un fármaco.

Escribe el contexto en el idioma del documento. Usa SOLO lo que está en la
ficha y en los fragmentos: no inventes datos, cifras ni nombres, no repitas el
fragmento, no resumas conclusiones ni valores nada. Si un fragmento es
portada, índice, bibliografía o pie de página, dilo en una frase.

Devuelve solo JSON con esta forma, una entrada por fragmento y con el índice
tal como aparece en su cabecera:
{"contextos":[{"i":0,"contexto":"..."}]}`;

/** La ficha del documento que va en cada llamada. */
export interface FichaDocumento {
  fileName: string;
  titulo?: string;
  citation?: string;
  doi?: string;
  language?: string;
  documentType?: string;
  pages?: number;
  /** Secciones del documento en orden de aparición, sin repetir. */
  secciones?: string[];
  /** El comienzo del documento (portada, resumen, introducción). */
  inicio?: string;
}

/** Secciones distintas de los fragmentos, en orden de aparición. */
export function seccionesDe(chunks: ChunkParseado[]): string[] {
  const vistas: string[] = [];
  for (const c of chunks) {
    const s = (c.section ?? "").replace(/\s+/g, " ").trim();
    if (!s || vistas.includes(s)) continue;
    vistas.push(s);
    if (vistas.length >= MAX_SECCIONES) break;
  }
  return vistas;
}

/** El comienzo del documento: el texto de los primeros fragmentos, recortado. */
export function inicioDe(chunks: ChunkParseado[]): string {
  let texto = "";
  for (const c of chunks) {
    if (texto.length >= MAX_INICIO) break;
    texto += (texto ? "\n" : "") + c.text;
  }
  return texto.replace(/\s+/g, " ").trim().slice(0, MAX_INICIO);
}

/** La ficha en texto, para el prompt. Solo lo que se sabe: una línea vacía no
 *  se escribe, y un documento sin título se presenta por su nombre. */
export function fichaEnTexto(f: FichaDocumento): string {
  const lineas = [`Documento: ${f.fileName}`];
  if (f.titulo) lineas.push(`Título: ${f.titulo}`);
  if (f.citation) lineas.push(`Cita: ${f.citation}`);
  if (f.doi) lineas.push(`DOI: ${f.doi}`);
  const rasgos: string[] = [];
  if (f.documentType) rasgos.push(`formato ${f.documentType}`);
  if (f.language) rasgos.push(`idioma ${f.language}`);
  if (f.pages) rasgos.push(`${f.pages} páginas`);
  if (rasgos.length) lineas.push(`Rasgos: ${rasgos.join(", ")}`);
  if (f.secciones?.length) lineas.push(`Secciones: ${f.secciones.join(" | ")}`);
  if (f.inicio) lineas.push(`Comienzo del documento: ${f.inicio}`);
  return lineas.join("\n");
}

/** El mensaje de usuario de un grupo: la ficha y los fragmentos numerados. */
export function mensajeDeGrupo(ficha: FichaDocumento, chunks: ChunkParseado[]): string {
  const fragmentos = chunks
    .map((c, i) => {
      const tipo = c.chunkType === "table" ? "tabla" : "texto";
      const seccion = (c.section ?? "").trim() || "desconocida";
      return `[${i}] página ${c.page} · sección: ${seccion} · tipo: ${tipo}\n${c.text.slice(0, MAX_TEXTO_FRAGMENTO)}`;
    })
    .join("\n\n");
  return (
    `${fichaEnTexto(ficha)}\n\n` +
    `Fragmentos consecutivos (${chunks.length}, índices 0 a ${chunks.length - 1}):\n\n${fragmentos}\n\n` +
    'Responde con el JSON {"contextos": [{"i": índice, "contexto": "..."}]}, una entrada por fragmento.'
  );
}

/** Lee {"contextos": [{"i", "contexto"}]} con tolerancia por entrada, como
 *  `calificador.parsearGrados`: índices fuera de rango, repetidos o no
 *  enteros y contextos vacíos o que no son texto se ignoran uno a uno; solo
 *  la ausencia de la lista es un fallo del grupo. Devuelve una posición por
 *  fragmento; `undefined` = el modelo no dio contexto para ese. */
export function parsearContextos(data: unknown, n: number): Array<string | undefined> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("respuesta JSON que no es un objeto");
  }
  const crudos: unknown = (data as Record<string, unknown>).contextos;
  if (!Array.isArray(crudos)) throw new Error("respuesta sin lista 'contextos'");
  const salida: Array<string | undefined> = new Array(n).fill(undefined);
  for (const item of crudos) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { i, contexto } = item as { i?: unknown; contexto?: unknown };
    if (typeof i === "boolean" || (typeof i !== "number" && typeof i !== "string")) continue;
    // Number("") es 0: una entrada con índice vacío se quedaría el fragmento 0.
    if (typeof i === "string" && !i.trim()) continue;
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || salida[idx] !== undefined) continue;
    if (typeof contexto !== "string") continue;
    const limpio = contexto.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXTO_CHARS);
    if (!limpio) continue;
    salida[idx] = limpio;
  }
  return salida;
}

/** Lo que se embebe: el contexto delante del texto. Sin contexto, el texto
 *  tal cual, que es lo que se embebía antes. */
export function textoParaEmbeber(contexto: string | undefined, text: string): string {
  const c = (contexto ?? "").trim();
  if (!c) return text;
  // El gateway recorta lo que se embebe a MAX_CHUNK_CHARS: si el fragmento ya
  // está en el tope, el contexto delante le quitaría sus últimos caracteres.
  // Se recorta el texto, no el contexto: el contexto es lo que hace que el
  // fragmento se encuentre, y el final de un fragmento al tope ya se cuenta
  // como recortado en los avisos.
  const sitio = Math.max(0, MAX_CHUNK_CHARS - c.length - 2);
  return `${c}\n\n${text.slice(0, sitio)}`;
}

/** La receta del índice con la que se marca un documento al terminar: la de
 *  siempre si el contexto está activo; otra si el operador lo apagó, para que
 *  al volver a encenderlo la migración los reindexe (y para que, apagado, no
 *  los dé por pendientes y los reindexe en bucle). */
export function versionIndiceActual(contextoHabilitado: boolean): string {
  return contextoHabilitado ? VERSION_INDICE : `${VERSION_INDICE}-sin-contexto`;
}

async function contextualizarGrupo(
  ficha: FichaDocumento,
  chunks: ChunkParseado[],
  a: Ajustes,
  tel?: Telemetria,
): Promise<Array<string | undefined>> {
  const modelo = modeloContextoResuelto(a);
  const t0 = Date.now();
  let modeloReal = modelo;
  let usage: gateway.UsoTokens | null = null;
  let finishReason: string | null = null;
  try {
    const r = await gateway.completionJson(
      {
        model: modelo,
        temperature: a.temperatura,
        messages: [
          { role: "system", content: PROMPT_CONTEXTO },
          { role: "user", content: mensajeDeGrupo(ficha, chunks) },
        ],
        ...gateway.razonamiento(a.razonamientoContexto),
      },
      a,
      { perfil: "chat", tel },
    );
    modeloReal = r.modelo || modelo;
    usage = r.usage;
    finishReason = r.finishReason;
    if (r.razonamientoRechazado) tel?.incr("razonamiento_rechazado");
    const contextos = parsearContextos(r.datos, chunks.length);
    // Se anota DESPUÉS de parsear: una respuesta sin la lista es un grupo
    // fallido aunque el gateway haya devuelto 200.
    tel?.anota("contexto", modeloReal, usage, {
      ms: Date.now() - t0,
      ok: true,
      finishReason,
      nota: `contextualizar n=${chunks.length}`,
    });
    return contextos;
  } catch (exc) {
    tel?.anota("contexto", modeloReal, usage, {
      ms: Date.now() - t0,
      ok: false,
      finishReason,
      nota: `contextualizar n=${chunks.length}: ${String(exc).slice(0, 120)}`,
    });
    throw exc;
  }
}

/** Contexto para cada fragmento de la lista, en grupos consecutivos de
 *  `TAMANO_GRUPO` que corren en paralelo (la plaza del gateway acota la
 *  concurrencia real). Nunca lanza: un grupo que falla deja sus fragmentos
 *  sin contexto y se cuenta en `fallidos`, igual que un fragmento que el
 *  modelo se saltó dentro de un grupo que sí respondió. */
export async function contextualizar(
  ficha: FichaDocumento,
  chunks: ChunkParseado[],
  a: Ajustes = ajustes(),
  tel?: Telemetria,
): Promise<{ contextos: Array<string | undefined>; fallidos: number }> {
  const contextos: Array<string | undefined> = new Array(chunks.length).fill(undefined);
  if (!chunks.length) return { contextos, fallidos: 0 };
  const grupos: Array<{ desde: number; lote: ChunkParseado[] }> = [];
  for (let i = 0; i < chunks.length; i += TAMANO_GRUPO) {
    grupos.push({ desde: i, lote: chunks.slice(i, i + TAMANO_GRUPO) });
  }
  const resultados = await Promise.allSettled(
    grupos.map((g) => contextualizarGrupo(ficha, g.lote, a, tel)),
  );
  resultados.forEach((r, k) => {
    if (r.status === "rejected") {
      console.warn(
        `contextualizar: el grupo ${k + 1}/${grupos.length} falló (${String(r.reason).slice(0, 160)}); sus fragmentos van sin contexto.`,
      );
      return;
    }
    r.value.forEach((c, j) => {
      contextos[grupos[k].desde + j] = c;
    });
  });
  const fallidos = contextos.filter((c) => c === undefined).length;
  return { contextos, fallidos };
}
