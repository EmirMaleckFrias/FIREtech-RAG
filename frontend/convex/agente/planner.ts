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
import { normalizarPregunta } from "./cachePlan";
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
  /** Reformulaciones en inglés de la misma búsqueda con sinónimos, siglas o
   *  nombres alternativos ("MCI" y "mild cognitive impairment"; el nombre
   *  comercial y el principio activo). Se buscan junto a `query` y `queryEn`
   *  y se fusionan por RRF: la coincidencia de palabras no sabe que dos
   *  nombres son la misma cosa, y el vector denso los acerca pero no siempre
   *  lo bastante. Como mucho MAX_VARIANTES. Opcional: los planes anteriores a
   *  la marca no lo llevan. */
  variantes?: string[];
}

/** Reformulaciones por búsqueda. Dos: medido en la literatura de 2026 como
 *  el punto en que la ganancia de recall deja de compensar el ruido que cada
 *  lista extra mete en la fusión; y cada una es una búsqueda más. */
export const MAX_VARIANTES = 2;
/** Una reformulación más larga que esto no es una consulta. */
const MAX_VARIANTE_CHARS = 300;

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
- "variantes": hasta dos reformulaciones en inglés de la misma búsqueda con
  los sinónimos, siglas o nombres alternativos que los documentos puedan
  usar ("MCI" y "mild cognitive impairment"; "p-tau217" y "phosphorylated tau
  217"; el nombre comercial y el principio activo; "elderly" y "older
  adults"). Lista vacía si no hay sinónimos que aporten. Nunca repitas
  query_en ni cambies el sentido.
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
inglés, repítela. Y "variantes_pregunta": hasta dos reformulaciones en inglés
de la pregunta entera con sinónimos o siglas, con las mismas reglas que las
variantes de cada búsqueda.

Devuelve solo JSON con esta forma:
{"pregunta_en":"...","variantes_pregunta":["..."],"items":[{"query":"...","query_en":"...","variantes":["..."],"evidence_needed":"..."}]}
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

Devuelve además "consulta": el último mensaje reescrito para que se entienda
SOLO, sin el historial, y sirva para buscar en los documentos. Resuelve lo que
se refiera a la conversación ("eso", "lo anterior", "hazme un diagrama de lo
que dijiste", "¿y en la otra cohorte?", "hazme un mapa mental") con el tema y
los datos concretos del historial, en una o dos frases que lleven las palabras
clave del tema (la enfermedad, el biomarcador, la población, la cifra). Si el
mensaje ya se entiende solo, cópialo tal cual. NUNCA añadas un tema que no
esté en la conversación; si no hay historial, copia el mensaje.
Y "consulta_en": esa misma consulta traducida al inglés con los términos
técnicos en inglés (el biomarcador, la escala, el fármaco, la población),
porque los documentos suelen estar en inglés y la coincidencia de palabras no
traduce. Si la consulta ya está en inglés, cópiala.
Y "documento": SOLO si el mensaje pide expresamente LIMITAR la respuesta a un
documento ("únicamente con el PDF M6U1", "solo en el documento de Allegri
2023", "usando únicamente el PDF indexado", "según el archivo guia_hta.pdf, y
nada más"): copia cómo se refiere a él, tal como aparece en el mensaje, aunque
no lo nombre ("el PDF indexado" también vale: dice que es uno y de qué
formato). Nombrar un documento sin pedir limitarse a él ("¿qué dice Allegri
de esto?" puede compararse con otros) NO cuenta: deja "". Si no pide
limitarse a ninguno, "".
Y "partes": SOLO si el mensaje junta varias preguntas DISTINTAS, que necesitan
información distinta para responderse ("¿cuántos contactores lleva? ¿y qué
dice de la corrosión? ¿y cómo era el sistema antiguo de 28 V?" son tres),
devuelve cada una como una consulta corta que se entienda sola, con su versión
en inglés, hasta cuatro. Una pregunta con matices o condiciones sigue siendo
UNA pregunta ("¿el AUC de p-tau217 en pacientes con APOE4?" es una parte, no
dos): si no hay varias preguntas de verdad, devuelve una lista vacía.
Devuelve solo JSON: {"clase":"documental"|"sobre_el_asistente"|"conversacional","consulta":"...","consulta_en":"...","documento":"","partes":[{"consulta":"...","consulta_en":"..."}]}`;

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

/** Las reformulaciones que devuelve el modelo, limpias: solo textos, sin
 *  vacías, sin las que repiten alguna de `excluidas` (la consulta y su
 *  inglés) ni entre sí, ninguna más larga que una consulta, y como mucho
 *  MAX_VARIANTES. El orden del modelo se conserva. */
export function variantesDe(crudo: unknown, excluidas: string[]): string[] {
  if (!Array.isArray(crudo)) return [];
  const vistas = new Set(excluidas.map(clave).filter(Boolean));
  const salida: string[] = [];
  for (const item of crudo) {
    const texto = textoDe(item).replace(/\s+/g, " ");
    const key = clave(texto);
    if (!texto || texto.length > MAX_VARIANTE_CHARS || vistas.has(key)) continue;
    vistas.add(key);
    salida.push(texto);
    if (salida.length >= MAX_VARIANTES) break;
  }
  return salida;
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
): Promise<{ items: PuntoPlan[]; preguntaEn: string; variantesPregunta?: string[] }> {
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
      { perfil: "chat", tel },
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
    const variantesPregunta = variantesDe(r.datos?.variantes_pregunta, [pregunta, preguntaEn]);

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
      const variantes = variantesDe(obj.variantes, [query, queryEn]);
      items.push({
        id: "",
        query,
        queryEn,
        evidenceNeeded: textoDe(obj.evidence_needed) || EVIDENCE_NEEDED_POR_DEFECTO,
        ...(variantes.length ? { variantes } : {}),
      });
      if (items.length >= tope) break;
    }
    return { items: renumerar(items), preguntaEn, variantesPregunta };
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
  variantesPregunta: string[] = [],
): PuntoPlan[] {
  const q = pregunta.trim();
  const claveAncla = clave(q);
  let en = (preguntaEn ?? "").trim();
  if (clave(en) === claveAncla) en = "";
  const variantes = variantesDe(variantesPregunta, [q, en]);
  const ancla: PuntoPlan = {
    id: ANCLA_ID,
    query: q,
    queryEn: en,
    evidenceNeeded: ANCLA_EVIDENCE_NEEDED,
    ...(variantes.length ? { variantes } : {}),
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

/** Lo que el clasificador dice de una pregunta: su clase y la consulta con la
 *  que buscarla. */
export interface Clasificacion {
  clase: Clase;
  /** La pregunta reescrita para entenderse sin el historial. Es lo que se
   *  BUSCA (el ancla del plan); lo que se responde sigue siendo el texto
   *  literal de quien pregunta. Igual al texto literal cuando no hay
   *  historial o cuando la pregunta ya se entiende sola. */
  consulta: string;
  /** La consulta en inglés, para que el ancla e0 se busque también así
   *  cuando NO corre el planificador (modo normal). Medido el 8 sep 2026:
   *  en modo normal el ancla se buscaba una sola vez, en español, contra un
   *  corpus en inglés, porque solo el planificador traducía y en normal no
   *  hay planificador. Vacía si es igual a la consulta o no llegó. Opcional
   *  por los llamadores que aún no la leen. */
  consultaEn?: string;
  /** Nombre o título del documento al que el mensaje pide LIMITARSE, tal
   *  como lo escribió quien pregunta ("el PDF M6U1"). Vacío si no pide
   *  limitarse a ninguno. Lo resuelve `agente/alcance.ts` contra los
   *  documentos de la persona; aquí solo se recoge la pista. Medido con
   *  pruebas externas el 8 sep 2026: "únicamente con el PDF X" se buscaba en
   *  todo el corpus y la respuesta mezclaba otros documentos. */
  documento?: string;
  /** Las preguntas distintas que el mensaje junta, si junta varias; vacío si
   *  es una sola. En modo normal cada una tiene su propia búsqueda (ver
   *  `partesComoPlan`). Medido el 9 sep 2026: una pregunta descuidada con
   *  cuatro dudas tenía UNA búsqueda en modo normal, diez fragmentos se
   *  repartían entre las cuatro y una se quedaba sin sus páginas, con lo que el
   *  modelo declaraba ausente lo que el documento sí trataba. */
  partes?: ParteDePregunta[];
}

/** Una de las preguntas de un mensaje compuesto, en español y en inglés. */
export interface ParteDePregunta {
  consulta: string;
  consultaEn: string;
}

/** Tope de partes: más de cuatro dudas en un mensaje no es una pregunta, es
 *  un cuestionario, y cada parte es una búsqueda con su calificador. */
export const MAX_PARTES = 4;

/** Las partes que devolvió el clasificador, ya limpias: cada una con tamaño
 *  de consulta, sin repetir, sin la pregunta entera disfrazada de parte, y
 *  solo si quedan al menos dos (una sola parte ES la pregunta). */
export function partesDe(crudo: unknown, consulta: string): ParteDePregunta[] {
  if (!Array.isArray(crudo)) return [];
  // La misma pregunta sin los signos de interrogación o sin acentos es la
  // misma pregunta: se compara con el normalizador de la caché, que los quita
  // (`clave` no, y "cual es el auc" pasaba por una parte distinta de "¿cuál
  // es el AUC?"; lo cazó el test adversarial).
  const misma = (t: string) => normalizarPregunta(t);
  const vistas = new Set<string>([misma(consulta)]);
  const salida: ParteDePregunta[] = [];
  for (const item of crudo) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const texto = textoDe(o.consulta).replace(/\s+/g, " ").trim();
    if (texto === "" || texto.length > MAX_CONSULTA) continue;
    const k = misma(texto);
    if (!k || vistas.has(k)) continue;
    vistas.add(k);
    const en = textoDe(o.consulta_en).replace(/\s+/g, " ").trim();
    salida.push({ consulta: texto, consultaEn: en !== "" && en.length <= MAX_CONSULTA && misma(en) !== k ? en : "" });
    if (salida.length >= MAX_PARTES) break;
  }
  return salida.length >= 2 ? salida : [];
}

/** Las partes como puntos del plan, para `conAncla`: cada parte es lo que se
 *  busca y lo que se necesita. `conAncla` las renumera y quita la que
 *  coincida con el ancla. */
export function partesComoPlan(partes: ParteDePregunta[]): PuntoPlan[] {
  return partes.map((p, i) => ({ id: `p${i + 1}`, query: p.consulta, queryEn: p.consultaEn, evidenceNeeded: p.consulta }));
}

/** Tope de la consulta reformulada: más largo que esto no es una consulta,
 *  es el modelo inventando. */
const MAX_CONSULTA = 600;
/** Tope de la pista del documento: un nombre de fichero o un título. */
const MAX_PISTA_DOCUMENTO = 200;

/** Clase de la pregunta, ANTES de buscar, y la consulta autónoma con la que
 *  buscarla. Solo `documental` entra al pipeline.
 *
 *  Por qué la reformulación va aquí: medido el 7 sep 2026 en el despliegue,
 *  "hazme un mapa mental o un diagrama visual" tras una respuesta sobre
 *  hipertensión se buscaba con ese texto literal, recuperaba un documento de
 *  Notion sobre diseño web ("Visual Language", "Timeline") y el agente
 *  contestaba que no encontraba hipertensión en los documentos. El modo
 *  normal no tiene planificador que resuelva la referencia, y esta es la
 *  única llamada que va delante de cada pregunta con el historial a la
 *  vista: pedirle la consulta aquí no añade ninguna llamada.
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
): Promise<Clasificacion> {
  const a = ajustes();
  const modelo = modeloRerankResuelto(a);
  const t0 = Date.now();
  const literal = pregunta.trim();
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
      { perfil: "chat", tel },
    );
    // Tolerante con la forma ("sobre el asistente", mayúsculas), estricto con
    // el contenido: lo que no sea una de las tres clases es documental.
    const cruda = textoDe(r.datos?.clase).toLowerCase().replace(/[\s-]+/g, "_");
    const clase: Clase = (CLASES as readonly string[]).includes(cruda)
      ? (cruda as Clase)
      : "documental";
    // La consulta reformulada solo se acepta con historial (sin él no hay
    // nada que resolver, y una paráfrasis cambiaría la clave de la caché del
    // plan), si trae algo y si tiene un tamaño de consulta. Lo demás es el
    // texto literal, que es lo que se buscaba hasta ahora.
    const propuesta = textoDe(r.datos?.consulta).replace(/\s+/g, " ").trim();
    const consulta =
      historial.length > 0 && propuesta !== "" && propuesta.length <= MAX_CONSULTA ? propuesta : literal;
    const reformulada = clave(consulta) !== clave(literal);
    if (reformulada) tel?.incr("consultas_reformuladas");
    // La versión inglesa se acepta con o sin historial: no cambia lo que se
    // busca, añade una segunda búsqueda de lo mismo en el idioma del corpus.
    // Igual a la consulta (ya estaba en inglés) o desmesurada: vacía.
    // ... salvo si la `consulta` del modelo se RECHAZÓ (una paráfrasis sin
    // historial): entonces su inglés es la traducción de algo que no se busca.
    const propuestaRechazada = propuesta !== "" && clave(propuesta) !== clave(consulta);
    const propuestaEn = textoDe(r.datos?.consulta_en).replace(/\s+/g, " ").trim();
    const consultaEn =
      !propuestaRechazada && propuestaEn !== "" && propuestaEn.length <= MAX_CONSULTA && clave(propuestaEn) !== clave(consulta)
        ? propuestaEn
        : "";
    tel?.anota("clasificador", r.modelo || modelo, r.usage, {
      ms: Date.now() - t0,
      ok: true,
      finishReason: r.finishReason,
      nota:
        `clase=${clase}${cruda === clase ? "" : ` (respuesta: ${cruda || "vacía"})`}` +
        (reformulada ? `; consulta reformulada: ${consulta.slice(0, 120)}` : ""),
    });
    if (r.razonamientoRechazado) tel?.incr("razonamiento_rechazado");
    // La pista del documento se acepta si tiene tamaño de nombre. Que exista
    // o no entre los documentos lo decide el bucle, que es quien los conoce.
    const pista = textoDe(r.datos?.documento).replace(/\s+/g, " ").trim();
    const documento = pista !== "" && pista.length <= MAX_PISTA_DOCUMENTO ? pista : "";
    if (documento) tel?.incr("alcance_pedido");
    const partes = partesDe(r.datos?.partes, consulta);
    if (partes.length) tel?.incr("preguntas_compuestas");
    return { clase, consulta, consultaEn, documento, partes };
  } catch (exc) {
    tel?.anota("clasificador", modelo, null, {
      ms: Date.now() - t0,
      ok: false,
      nota: String(exc).slice(0, 160),
    });
    console.warn(
      `Clasificador no disponible (${String(exc).slice(0, 160)}); se trata como documental.`,
    );
    return { clase: "documental", consulta: literal, consultaEn: "" };
  }
}
