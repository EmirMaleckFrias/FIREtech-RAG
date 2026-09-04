// Planificador de evidencia para preguntas complejas. Port de
// `backend/app/services/planner.py`.
//
// No responde la pregunta ni aporta conocimiento: solo transforma la petición
// del usuario en búsquedas autónomas y en una lista de evidencias que la
// respuesta final debe cubrir o declarar ausentes.
//
// El plan no es una sugerencia que el agente puede seguir o no: lo ejecuta
// código (evidencia.ts), en paralelo y de forma determinista. Por eso el
// post-proceso de aquí es estricto: ids por posición, sin consultas
// equivalentes y con el ancla `e0` siempre igual a la pregunta literal, para
// que la misma pregunta produzca el mismo plan de búsquedas.
//
// Dos cosas que el Python no tenía, las dos por trampas medidas el 4 sep 2026
// (ver CONTRATO.md):
// - El modelo devuelve también `pregunta_en`, la pregunta entera en inglés,
//   para que el ancla e0 se busque en los dos idiomas. Antes e0 no tenía
//   variante inglesa, el prompt decía que "ya se buscó en inglés" y en modo
//   normal (plan = solo e0) una pregunta en español contra un corpus en
//   inglés se buscaba UNA vez, en español.
// - `clasificar` decide ANTES de buscar si la pregunta es documental. Un
//   "¿qué eres?" o un "hola" no debe ejecutar el pipeline ni recibir la
//   orden de decir que no lo encuentra en los documentos.
//
// Nada de aquí inyecta un checklist en la conversación: la estructura de la
// respuesta, si hace falta, la monta el bucle a partir del plan.
import * as gateway from "../lib/gateway";
import { ajustes, modeloRerankResuelto } from "../lib/config";
import type { Telemetria } from "../lib/telemetry";

export interface PuntoPlan {
  id: string;
  query: string;
  /** Consulta con los términos técnicos en inglés. Vacía = no hay versión
   *  distinta (una pregunta que ya está en inglés, o e0 en modo normal). */
  queryEn: string;
  evidenceNeeded: string;
}

export type Clase = "documental" | "sobre_el_asistente" | "conversacional";
export const CLASES: readonly Clase[] = [
  "documental",
  "sobre_el_asistente",
  "conversacional",
];

export const ANCLA_ID = "e0";
export const ANCLA_EVIDENCE_NEEDED =
  "respuesta directa a la pregunta tal como la formuló quien pregunta";
export const EVIDENCE_NEEDED_POR_DEFECTO = "evidencia para esta subpregunta";

// Cuántos mensajes del historial se le enseñan al modelo. Bastan para
// resolver una repregunta; más arrastraría temas viejos a preguntas nuevas.
const HISTORIAL_MAX = 4;
const HISTORIAL_CHARS = 600;

export const PROMPT_PLANNER = `Eres un planificador de recuperación documental científica (literatura
clínica y biomédica). No respondas la pregunta y no inventes hechos. Descompón
la petición en el conjunto mínimo de búsquedas autónomas necesarias para
contestarla por completo. La pregunta literal ya se busca aparte: no la
repitas; aporta las subpreguntas que ella sola no cubre.

Por cada búsqueda devuelve:
- "query": la consulta en el idioma de la pregunta, autosuficiente (sin
  "eso", "ese estudio": nombra el objeto).
- "query_en": la misma consulta con los términos técnicos en inglés (nombre
  del biomarcador, la escala, el fármaco, la población). El corpus es
  mayoritariamente inglés y la coincidencia de palabras no traduce; si la
  pregunta ya está en inglés, repite la query.
- "evidence_needed": el dato concreto que debe encontrarse, con población y
  desenlace cuando aplique (por ejemplo "AUC de p-tau217 plasmático para
  distinguir Alzheimer de otras demencias en la cohorte clínica").

Cuando la pregunta compara estudios, poblaciones, intervenciones o cifras,
busca cada término por separado y añade UNA búsqueda de contradicciones o
matices entre documentos. Si el historial muestra que la pregunta es una
repregunta ("y en la otra cohorte?"), resuelve la referencia con el historial
y escribe consultas completas.

Devuelve además "pregunta_en": la pregunta entera traducida al inglés con los
mismos términos técnicos (si es una repregunta, con la referencia ya
resuelta), para buscarla tal cual en el corpus. Si la pregunta ya está en
inglés, repítela.

Devuelve solo JSON con esta forma:
{"pregunta_en":"...","items":[{"query":"...","query_en":"...","evidence_needed":"..."}]}
Usa entre 1 y el máximo indicado. No incluyas dos consultas equivalentes.`;

export const PROMPT_CLASIFICADOR = `Clasificas el último mensaje de una conversación con un asistente de
investigación que responde SOLO con documentos científicos indexados
(literatura clínica y biomédica). Devuelve una de tres clases:
- "documental": pide información que hay que buscar en los documentos: un
  dato, una cifra, un método, una comparación, un resumen, o qué documentos
  hay en el índice, cuántos son o de qué tratan (eso es una pregunta sobre
  el índice, no sobre el asistente). Las repreguntas cortas que continúan un
  tema del historial ("¿y en la otra cohorte?", "¿y el AUC?") son
  documentales.
- "sobre_el_asistente": pregunta por el asistente mismo: qué es, qué sabe
  hacer, qué modos tiene, en cuál está, cómo funciona, qué reglas sigue.
- "conversacional": saludos, agradecimientos, despedidas o comentarios sin
  petición de información ("hola", "gracias", "vale", "perfecto").
Ante la duda entre "documental" y otra clase, elige "documental": buscar de
más es más seguro que no buscar.
Devuelve solo JSON: {"clase":"documental"|"sobre_el_asistente"|"conversacional"}`;

/** Forma normalizada de una consulta para detectar equivalentes.
 *
 *  `toLowerCase` en vez del `casefold` de Python: difieren en casos como la ß
 *  alemana, irrelevantes para consultas clínicas, y lo que importa es que sea
 *  determinista e independiente del locale. */
export function clave(texto: string): string {
  return texto.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function textoDe(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Ids por posición (e1..eN). El id que devuelve el modelo se ignora: dos
 *  planes con las mismas consultas deben tener los mismos ids. */
function renumerar(items: PuntoPlan[]): PuntoPlan[] {
  return items.map((it, i) => ({ ...it, id: `e${i + 1}` }));
}

function historialParaPrompt(
  historial: { role: string; content: string }[] | null | undefined,
): string {
  if (!historial?.length) return "";
  const ultimos = historial
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-HISTORIAL_MAX);
  if (!ultimos.length) return "";
  const lineas = ultimos.map((m) => {
    const quien = m.role === "user" ? "Usuario" : "Asistente";
    const contenido = String(m.content ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .slice(0, HISTORIAL_CHARS);
    return `${quien}: ${contenido}`;
  });
  return "Historial reciente (solo contexto):\n" + lineas.join("\n") + "\n\n";
}

/** Subpreguntas del plan, SIN el ancla: el llamador la pone con `conAncla`.
 *
 *  Ante cualquier fallo (API caída, JSON roto, respuesta sin lista) devuelve
 *  `{ items: [], preguntaEn: "" }`: el plan mínimo es la pregunta literal y
 *  esa no depende del planificador. Usa el modelo grande con el razonamiento
 *  del planificador porque es UNA llamada por pregunta y de su descomposición
 *  depende toda la evidencia. */
export async function planificar(
  pregunta: string,
  historial: { role: string; content: string }[],
  maxItems: number,
  tel?: Telemetria,
): Promise<{ items: PuntoPlan[]; preguntaEn: string }> {
  const a = ajustes();
  const modelo = a.modelo;
  const t0 = Date.now();
  const tope = Math.max(1, Math.trunc(Number(maxItems) || 1));
  let anotado = false;
  try {
    const r = await gateway.completionJson(
      {
        model: modelo,
        temperature: a.temperatura,
        messages: [
          { role: "system", content: PROMPT_PLANNER },
          {
            role: "user",
            content:
              `${historialParaPrompt(historial)}` +
              `Máximo: ${tope}\nPregunta: ${pregunta}`,
          },
        ],
        ...gateway.razonamiento(a.razonamientoPlanner),
      },
      a,
    );
    const crudos: unknown = r.datos?.items;
    if (!Array.isArray(crudos)) throw new Error("respuesta sin lista items");
    // El registro va DESPUÉS de parsear, no antes. Estaba antes con
    // `ok = hay contenido`, así que un JSON malformado dejaba anotada una
    // ronda "ok" y el manejador de error anotaba otra en fallo: la telemetría
    // mostraba dos rondas contradictorias para una sola llamada.
    tel?.anota("planner", r.modelo || modelo, r.usage, {
      ms: Date.now() - t0,
      ok: true,
      finishReason: r.finishReason,
      nota: `max_items=${tope}`,
    });
    anotado = true;
    if (r.razonamientoRechazado) tel?.incr("razonamiento_rechazado");

    const clavePregunta = clave(pregunta);
    // Igual que con `query_en`: si la "traducción" es la misma pregunta, no
    // hay una segunda búsqueda que hacer y la cabecera del punto no debe
    // decir que se buscó en inglés.
    let preguntaEn = textoDe(r.datos?.pregunta_en);
    if (clave(preguntaEn) === clavePregunta) preguntaEn = "";

    const items: PuntoPlan[] = [];
    const vistas = new Set<string>([clavePregunta]);
    for (const crudo of crudos) {
      if (!crudo || typeof crudo !== "object" || Array.isArray(crudo)) continue;
      const obj = crudo as Record<string, unknown>;
      const query = textoDe(obj.query);
      const key = clave(query);
      if (!query || vistas.has(key)) continue;
      vistas.add(key);
      let queryEn = textoDe(obj.query_en);
      if (clave(queryEn) === key) queryEn = "";
      items.push({
        id: "",
        query,
        queryEn,
        evidenceNeeded: textoDe(obj.evidence_needed) || EVIDENCE_NEEDED_POR_DEFECTO,
      });
      if (items.length >= tope) break;
    }
    return { items: renumerar(items), preguntaEn };
  } catch (exc) {
    // El fallo del planificador no tumba la pregunta: el llamador se queda
    // con el ancla (la pregunta literal) y el fallo queda en telemetría.
    if (!anotado) {
      tel?.anota("planner", modelo, null, {
        ms: Date.now() - t0,
        ok: false,
        nota: String(exc).slice(0, 160),
      });
    }
    console.warn(
      `Planificador no disponible (${String(exc).slice(0, 160)}); se usa la pregunta directa.`,
    );
    return { items: [], preguntaEn: "" };
  }
}

/** `[e0, ...items]`, con e0 = la pregunta literal y los demás renumerados.
 *
 *  El ancla existe para que la evidencia mínima de cualquier pregunta sea la
 *  misma con y sin planificador: la búsqueda de la pregunta tal como la
 *  formuló quien pregunta. `preguntaEn` va como su `queryEn` para que también
 *  se busque en inglés; vacía (modo normal, sin planificador, o planificador
 *  caído) significa que e0 se busca una sola vez, y la cabecera del punto lo
 *  dirá así. Un item equivalente a e0 se descarta. */
export function conAncla(
  pregunta: string,
  preguntaEn: string,
  items: PuntoPlan[],
): PuntoPlan[] {
  const q = pregunta.trim();
  const claveAncla = clave(q);
  let en = (preguntaEn ?? "").trim();
  if (clave(en) === claveAncla) en = "";
  const ancla: PuntoPlan = {
    id: ANCLA_ID,
    query: q,
    queryEn: en,
    evidenceNeeded: ANCLA_EVIDENCE_NEEDED,
  };
  const vistas = new Set<string>([claveAncla]);
  const resto: PuntoPlan[] = [];
  for (const it of items) {
    const key = clave(it.query ?? "");
    if (!key || vistas.has(key)) continue;
    vistas.add(key);
    resto.push(it);
  }
  return [ancla, ...renumerar(resto)];
}

/** Clase de la pregunta, ANTES de buscar. Solo `documental` entra al pipeline.
 *
 *  Modelo pequeño con el esfuerzo de razonamiento del calificador, que es el
 *  valor ya medido con ese mismo modelo. No se usa un valor más bajo "porque
 *  es barato": si la API rechazara ese valor con un 400 que nombre el
 *  razonamiento, `lib/gateway.ts` lo apagaría diez minutos para TODOS los
 *  componentes, y esta es la llamada que va delante de cada pregunta. Ante
 *  cualquier fallo, o ante una clase que no se reconoce, devuelve
 *  `documental`: buscar de más es más seguro que no buscar. */
export async function clasificar(
  pregunta: string,
  historial: { role: string; content: string }[],
  tel?: Telemetria,
): Promise<Clase> {
  const a = ajustes();
  const modelo = modeloRerankResuelto(a);
  const t0 = Date.now();
  try {
    const r = await gateway.completionJson(
      {
        model: modelo,
        temperature: a.temperatura,
        messages: [
          { role: "system", content: PROMPT_CLASIFICADOR },
          {
            role: "user",
            content:
              `${historialParaPrompt(historial)}` +
              `Mensaje a clasificar: ${pregunta}`,
          },
        ],
        ...gateway.razonamiento(a.razonamientoCalificador),
      },
      a,
    );
    // Tolerante con la forma ("sobre el asistente", mayúsculas), estricto con
    // el contenido: lo que no sea una de las tres clases es documental.
    const cruda = textoDe(r.datos?.clase).toLowerCase().replace(/[\s-]+/g, "_");
    const clase: Clase = (CLASES as readonly string[]).includes(cruda)
      ? (cruda as Clase)
      : "documental";
    tel?.anota("clasificador", r.modelo || modelo, r.usage, {
      ms: Date.now() - t0,
      ok: true,
      finishReason: r.finishReason,
      nota: `clase=${clase}${cruda === clase ? "" : ` (respuesta: ${cruda || "vacía"})`}`,
    });
    if (r.razonamientoRechazado) tel?.incr("razonamiento_rechazado");
    return clase;
  } catch (exc) {
    tel?.anota("clasificador", modelo, null, {
      ms: Date.now() - t0,
      ok: false,
      nota: String(exc).slice(0, 160),
    });
    console.warn(
      `Clasificador no disponible (${String(exc).slice(0, 160)}); se trata como documental.`,
    );
    return "documental";
  }
}
