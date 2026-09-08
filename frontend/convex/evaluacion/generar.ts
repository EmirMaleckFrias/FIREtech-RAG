// Propone preguntas de control sobre el corpus de UNA persona, para que ella
// las revise en Ajustes > Calidad y la corrida periódica (correr.ts) las use.
//
// Por qué las propone un modelo y no las escribe alguien: el benchmark
// (`evals/alzheimer.template.jsonl`) lleva desde el primer día esperando a que
// "los investigadores" rellenen los casos, y nadie lo hizo, porque escribir un
// caso exige mirar el documento, apuntar el fichero y la página y redactar un
// patrón. Aquí el modelo lee fragmentos reales del corpus y propone la
// pregunta, la respuesta esperada en llano y las cifras o términos que una
// respuesta correcta tiene que contener; la usuaria solo dice "correcta" o
// "descartar". El fichero y las páginas de la evidencia NO los inventa el
// modelo: salen del fragmento del que se partió.
//
// Cinco categorías, con reparto fijo: un documento (single_hop), varios
// documentos (multi_hop), tabla o cifra (tabla), ausencia (abstencion: algo
// plausible que NO está en el corpus) y trampa de entidad (entidad: preguntar
// por X cuando el corpus habla de Y, de la misma clase). Las dos últimas se
// COMPRUEBAN con la búsqueda léxica antes de guardarse: si algún término de
// la entidad supuestamente ausente devuelve fragmentos, el caso se descarta.
// Sin esa comprobación, un caso de ausencia sobre algo que sí está penaliza
// justo al asistente que acierta.
//
// El idioma, medido: el corpus suele estar en inglés y el asistente responde
// en español. Una clave copiada literalmente del fragmento ("25.4 points",
// "amyloid PET") no aparece en una respuesta correcta ("25,4 puntos", "PET
// amiloide") y el caso fallaba en cada corrida. Y al revés: un término de
// ausencia escrito en español ("líquido cefalorraquídeo") no encuentra nada en
// un índice en inglés aunque el corpus hable de CSF, y el caso se guardaba
// como ausencia de algo que sí está. Por eso los patrones se quedan solo con lo
// que sobrevive a la traducción (`patronesDeClave`) y los términos de ausencia
// se piden en los dos idiomas y con sus siglas.
//
// Cómo se encadena y por qué así: UNA llamada al modelo por acción. Una acción
// de Convex muere a los 600 s, una llamada al modelo grande con razonamiento
// tarda entre 15 y 40 s, y una generación de 20 preguntas son entre 11 y 30
// llamadas (60 preguntas, hasta 90). Hacerlas todas en una acción la mataba a
// mitad sin pasar por `cerrar`, con la barra de progreso congelada. Ahora
// `generar` lee los documentos y arma el PLAN (la lista de tareas, cada una con
// los fragmentos que necesita) y `paso` ejecuta una tarea y se reagenda para la
// siguiente; el estado viaja en los argumentos y los fragmentos se vuelven a
// leer por su id en cada paso, no viajan. Además, cada paso suma al menos 1 a
// `generados + descartados`: es el latido que `datos.generacionColgada` usa para
// distinguir una generación viva de una muerta sin un campo de fecha.
//
// Todo lo que se guarda pasa por `validarCaso` (puntuar.ts): un caso que no
// valide aquí fallaría en cada corrida con un error de formato.
//
// SIN "use node": la acción solo habla con el gateway y con la base.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ajustes, exigirClave, type Ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import { localizador, type Fragmento } from "../lib/citas";
import { aFragmento } from "../search/hybrid";
import { terminosDeBusqueda } from "../search/terminos";
import { seccionPodada } from "../agente/evidencia";
import { validarCaso } from "./puntuar";

// ---------------------------------------------------------------------------
// Categorías y reparto
// ---------------------------------------------------------------------------
export const CATEGORIAS = ["single_hop", "multi_hop", "tabla", "abstencion", "entidad"] as const;
export type Categoria = (typeof CATEGORIAS)[number];
export type PorCategoria<T> = Record<Categoria, T>;

/** Reparto aproximado del objetivo entre categorías. */
export const REPARTO: PorCategoria<number> = {
  single_hop: 0.4,
  multi_hop: 0.25,
  tabla: 0.15,
  abstencion: 0.1,
  entidad: 0.1,
};

/** Cuántos casos de cada categoría para un objetivo dado (resto mayor, para
 *  que sumen exactamente el objetivo). Lo que el corpus no permite (una sola
 *  obra no da para multi_hop; sin tablas no hay categoría tabla) pasa a
 *  single_hop en vez de perderse. */
export function repartirCuotas(
  objetivo: number,
  disponible: { multiHop: boolean; tabla: boolean },
): PorCategoria<number> {
  const n = Math.max(1, Math.floor(objetivo));
  const crudas = CATEGORIAS.map((c) => ({ c, exacta: n * REPARTO[c] }));
  const cuotas = Object.fromEntries(crudas.map(({ c, exacta }) => [c, Math.floor(exacta)])) as PorCategoria<number>;
  let restantes = n - CATEGORIAS.reduce((s, c) => s + cuotas[c], 0);
  for (const { c } of crudas.slice().sort((x, y) => (y.exacta - Math.floor(y.exacta)) - (x.exacta - Math.floor(x.exacta)))) {
    if (restantes <= 0) break;
    cuotas[c] += 1;
    restantes -= 1;
  }
  if (!disponible.multiHop) {
    cuotas.single_hop += cuotas.multi_hop;
    cuotas.multi_hop = 0;
  }
  if (!disponible.tabla) {
    cuotas.single_hop += cuotas.tabla;
    cuotas.tabla = 0;
  }
  return cuotas;
}

const categoriaValidator = v.union(
  v.literal("single_hop"),
  v.literal("multi_hop"),
  v.literal("tabla"),
  v.literal("abstencion"),
  v.literal("entidad"),
);
const cuotasValidator = v.object({
  single_hop: v.number(),
  multi_hop: v.number(),
  tabla: v.number(),
  abstencion: v.number(),
  entidad: v.number(),
});
const clavesValidator = v.object({
  single_hop: v.string(),
  multi_hop: v.string(),
  tabla: v.string(),
  abstencion: v.string(),
  entidad: v.string(),
});

// ---------------------------------------------------------------------------
// Topes
// ---------------------------------------------------------------------------
/** Documentos listos que se consideran (filas pequeñas). */
const MAX_DOCUMENTOS_LEIDOS = 500;
/** De cuántos documentos se toman fragmentos en una generación. */
export const MAX_DOCUMENTOS_MUESTREADOS = 30;
/** Fragmentos por consulta. Cada fila de `chunks` lleva su vector (Convex la
 *  contabiliza a ~56 KB, medido en documentos.test.ts), y una transacción lee
 *  16 MiB: 40 son ~2,2 MB, con margen de sobra. */
export const LOTE_FRAGMENTOS = 40;
/** Fragmentos que se leen como mucho de un documento (tres lotes). */
const MAX_FRAGMENTOS_POR_DOCUMENTO = 120;
/** Fragmentos de texto y de tabla que se conservan por documento, repartidos
 *  a lo largo de lo leído para no preguntar solo por la introducción. */
export const POR_DOCUMENTO = 6;
export const TABLAS_POR_DOCUMENTO = 3;
/** Un fragmento de texto más corto que esto no da para una pregunta. */
const MIN_TEXTO = 200;
const MIN_TABLA = 40;
/** Cuánto texto de cada fragmento ve el modelo. */
const TEXTO_MAX_PROMPT = 1_600;
/** Fragmentos por llamada al modelo en single_hop y tabla. */
export const LOTE_PROMPT = 5;
/** Claves ya usadas que se leen para no colisionar. */
const MAX_CLAVES_LEIDAS = 2_000;
/** Candidatos (fragmentos, parejas) que se dedican como mucho a cada caso
 *  pedido en una categoría. Si de tres candidatos no sale una pregunta,
 *  seguir gastando llamadas tampoco la va a sacar; y acota el número de pasos
 *  de la cadena, que es lo que acota cuánto puede durar una generación. */
export const CANDIDATOS_POR_CASO = 3;
/** Llamadas que se dedican a las preguntas de ausencia. */
export const INTENTOS_AUSENCIA = 3;
/** Fragmentos de muestra que ve el modelo al proponer ausencias. */
export const CONTEXTO_AUSENCIA = 8;
/** Fragmentos que se vuelven a leer en un paso (el mayor es el contexto de
 *  ausencia): 10 filas con vector son ~560 KB. */
const MAX_FRAGMENTOS_POR_TAREA = 10;
/** Formas de nombrar a la entidad ausente que se comprueban. */
export const MAX_TERMINOS_ENTIDAD = 6;
/** Cuánto se espera a UNA llamada al modelo. El gateway reintenta hasta cinco
 *  veces con 120 s de espera cada una (lib/gateway.ts): contra un gateway
 *  caído una sola llamada dura 680 s, más que los 600 s que vive la acción, y
 *  la mataría sin pasar por `cerrar`. Con 480 s se corta antes, se cuenta como
 *  fallo y la cadena sigue o se cierra en error. */
export const LLAMADA_MAX_MS = 480_000;
/** Fallos seguidos del modelo tras los que la generación se cierra en error
 *  en vez de seguir gastando pasos (y minutos) contra un servicio caído. */
export const MAX_FALLOS_SEGUIDOS = 3;

/** Presupuesto de la llamada al modelo. Configurable SOLO para los tests, que
 *  no pueden esperar 480 s a una llamada que no vuelve. */
let presupuesto = { llamadaMs: LLAMADA_MAX_MS };
export function configurarPresupuesto(nuevo: Partial<typeof presupuesto>): void {
  presupuesto = { ...presupuesto, ...nuevo };
}

// ---------------------------------------------------------------------------
// Lecturas y escrituras (funciones internas que usa la cadena)
// ---------------------------------------------------------------------------
export const documentosListos = internalQuery({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }) => {
    const docs = await ctx.db
      .query("documents")
      .withIndex("porPropietarioYEstado", (q) => q.eq("propietario", propietario).eq("status", "ready"))
      .take(MAX_DOCUMENTOS_LEIDOS);
    return docs.map((d) => ({ _id: d._id, fileName: d.fileName, chunks: d.chunks }));
  },
});

/** Si una fila de `chunks` puede ser fuente de una pregunta: es de esta
 *  persona (la frontera del corpus, como en `hybrid.cargar`: el documento es
 *  suyo, pero se comprueba igual en cada fila), no está en una sección que
 *  nunca es evidencia (bibliografía, agradecimientos...) y tiene texto. */
function fragmentoUtil(fila: Doc<"chunks">, propietario: Id<"users">): boolean {
  if (fila.propietario !== propietario) return false;
  if (seccionPodada(fila.section)) return false;
  const minimo = fila.chunkType === "table" ? MIN_TABLA : MIN_TEXTO;
  return fila.text.trim().length >= minimo;
}

/** Un lote de fragmentos de un documento a partir de `desde` (la
 *  `_creationTime` del último leído), SIN el vector y ya filtrado. `ultimo` es
 *  el cursor para el lote siguiente y `agotado` dice si el documento se
 *  terminó. */
export const fragmentosDe = internalQuery({
  args: {
    propietario: v.id("users"),
    documentId: v.id("documents"),
    desde: v.optional(v.number()),
    n: v.number(),
  },
  handler: async (ctx, args): Promise<{ fragmentos: Fragmento[]; ultimo: number | null; agotado: boolean }> => {
    const n = Math.max(1, Math.min(LOTE_FRAGMENTOS, Math.floor(args.n)));
    const desde = args.desde ?? 0;
    const filas = await ctx.db
      .query("chunks")
      .withIndex("porDocumento", (q) => q.eq("documentRef", args.documentId).gt("_creationTime", desde))
      .order("asc")
      .take(n);
    return {
      fragmentos: filas.filter((f) => fragmentoUtil(f, args.propietario)).map(aFragmento),
      ultimo: filas.length ? filas[filas.length - 1]._creationTime : null,
      agotado: filas.length < n,
    };
  },
});

/** Los fragmentos de una tarea, por su id y en el mismo orden, SIN vector.
 *  `null` donde el fragmento ya no sirve: se borró (un documento reindexado a
 *  mitad de la generación), cambió de dueño o no pasa el filtro. */
export const leerFragmentos = internalQuery({
  args: { propietario: v.id("users"), ids: v.array(v.id("chunks")) },
  handler: async (ctx, args): Promise<Array<Fragmento | null>> => {
    const salida: Array<Fragmento | null> = [];
    for (const id of args.ids.slice(0, MAX_FRAGMENTOS_POR_TAREA)) {
      const fila = await ctx.db.get(id);
      salida.push(fila && fragmentoUtil(fila, args.propietario) ? aFragmento(fila) : null);
    }
    return salida;
  },
});

export const clavesDe = internalQuery({
  args: { propietario: v.id("users") },
  handler: async (ctx, { propietario }): Promise<string[]> => {
    const filas = await ctx.db
      .query("evaluacionCasos")
      .withIndex("porPropietarioYClave", (q) => q.eq("propietario", propietario))
      .take(MAX_CLAVES_LEIDAS);
    return filas.map((c) => c.clave);
  },
});

export const leerGeneracion = internalQuery({
  args: { generacionId: v.id("evaluacionGeneraciones") },
  handler: async (ctx, { generacionId }): Promise<Doc<"evaluacionGeneraciones"> | null> => await ctx.db.get(generacionId),
});

export const avanzar = internalMutation({
  args: {
    generacionId: v.id("evaluacionGeneraciones"),
    generados: v.optional(v.number()),
    descartados: v.optional(v.number()),
    paso: v.optional(v.string()),
  },
  handler: async (ctx, { generacionId, ...cambios }): Promise<void> => {
    const g = await ctx.db.get(generacionId);
    if (!g || g.estado !== "running") return;
    const parche = Object.fromEntries(Object.entries(cambios).filter(([, x]) => x !== undefined));
    if (Object.keys(parche).length) await ctx.db.patch(generacionId, parche);
  },
});

export const cerrar = internalMutation({
  args: {
    generacionId: v.id("evaluacionGeneraciones"),
    estado: v.union(v.literal("ok"), v.literal("error")),
    error: v.optional(v.string()),
    generados: v.number(),
    descartados: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const g = await ctx.db.get(args.generacionId);
    if (!g || g.estado !== "running") return;
    await ctx.db.patch(args.generacionId, {
      estado: args.estado,
      error: args.error,
      generados: args.generados,
      descartados: args.descartados,
      terminadoEn: Date.now(),
      paso: undefined,
    });
  },
});

/** Guarda un caso como `propuesto`. La clave se comprueba contra el índice
 *  dentro de la transacción y, si está tomada (una generación anterior que
 *  terminó entre medias), se avanza el número: dos casos de la misma cuenta
 *  nunca comparten clave. Devuelve la clave definitiva. */
export const guardarCaso = internalMutation({
  args: {
    propietario: v.id("users"),
    categoria: v.string(),
    clave: v.string(),
    pregunta: v.string(),
    modo: v.union(v.literal("normal"), v.literal("extendido")),
    critico: v.boolean(),
    respuestaEsperada: v.string(),
    definicion: v.any(),
  },
  handler: async (ctx, args): Promise<string> => {
    let clave = args.clave;
    for (let intento = 0; intento < 100; intento++) {
      const previa = await ctx.db
        .query("evaluacionCasos")
        .withIndex("porPropietarioYClave", (q) => q.eq("propietario", args.propietario).eq("clave", clave))
        .unique();
      if (!previa) break;
      clave = siguienteClave(clave);
    }
    const definicion = { ...(args.definicion as Record<string, unknown>), id: clave };
    // Última barrera: lo que se guarda tiene que puntuar sin errores de
    // formato en cada corrida.
    validarCaso(definicion);
    await ctx.db.insert("evaluacionCasos", {
      propietario: args.propietario,
      clave,
      pregunta: args.pregunta,
      modo: args.modo,
      categoria: args.categoria,
      critico: args.critico,
      respuestaEsperada: args.respuestaEsperada,
      definicion,
      estado: "propuesto",
      origen: "generado",
      creadoEn: Date.now(),
    });
    return clave;
  },
});

/** "single_hop-007" -> "single_hop-008". */
export function siguienteClave(clave: string): string {
  const m = /^(.*)-(\d+)$/.exec(clave);
  if (!m) return `${clave}-001`;
  return `${m[1]}-${String(Number(m[2]) + 1).padStart(3, "0")}`;
}

/** La primera clave `<categoria>-<nnn>` libre, a partir de 001. */
export function claveLibre(categoria: string, usadas: Set<string>): string {
  let n = 1;
  for (;;) {
    const clave = `${categoria}-${String(n).padStart(3, "0")}`;
    if (!usadas.has(clave)) return clave;
    n += 1;
  }
}

// ---------------------------------------------------------------------------
// Utilidades puras (exportadas para probarlas sin base)
// ---------------------------------------------------------------------------
export function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** El patrón de una cadena literal: escapado, tolerante con el separador
 *  decimal (el fragmento dice 0.94 y la respuesta puede decir 0,94) y con el
 *  espaciado. */
export function patronDeClave(clave: string): string {
  const limpia = clave.trim().replace(/\s+/g, " ");
  return escaparRegex(limpia)
    .replace(/(\d)\\\.(\d)/g, "$1[.,]$2")
    .replace(/(\d),(\d)/g, "$1[.,]$2")
    .replace(/ /g, "\\s+");
}

/** Una clave sirve si es corta, no es una palabra suelta y genérica, y
 *  aparece de verdad en el fragmento: el modelo a veces "recuerda" una cifra
 *  de otro sitio, y una clave que no está en el fragmento no se puede
 *  verificar leyéndolo. */
export function claveValida(clave: string, textoFragmento: string): boolean {
  const limpia = clave.trim();
  if (limpia.length < 2 || limpia.length > 80) return false;
  if (!/\d/.test(limpia) && limpia.length < 4) return false;
  try {
    return new RegExp(patronDeClave(limpia), "i").test(textoFragmento);
  } catch {
    return false;
  }
}

const PUNTUACION_EXTERIOR = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const NUMEROS = /\d+(?:[.,]\d+)?/g;
/** Una cifra con una unidad pegada o con guion ("24-month", "10mL", "5mg"):
 *  empieza por dígito y termina en letras. */
const CIFRA_CON_UNIDAD = /^\d[\d.,]*-?\p{L}+$/u;

/** Los patrones `answer_must_contain` que salen de UNA clave copiada del
 *  fragmento. La clave está en el idioma del fragmento (casi siempre inglés) y
 *  la respuesta que se puntúa va en español, así que solo vale lo que
 *  sobrevive a la traducción, token a token:
 *
 *  - una cifra ("25.4 points", "24 months", "42%", "0.90-0.97") se queda en el
 *    número, sin unidad, con guardas para que "24" no case con "2024" y con la
 *    coma o el punto decimal indistintos ("25,4 puntos" casa con "25.4");
 *  - un token con dígitos ("p-tau217", "Aβ42") o con mayúsculas dentro
 *    ("MMSE", "BioFINDER", "MoCA") es un nombre o una sigla y se escribe igual;
 *  - cualquier otra palabra ("amyloid", "months", "lecanemab") solo vale si el
 *    modelo la escribió también en la pregunta o en la respuesta esperada, que
 *    van en español: si está ahí, es una palabra que la traducción no toca;
 *  - lo que no pasa se descarta, y cada token que pasa es un patrón aparte,
 *    porque el orden de las palabras tampoco sobrevive ("amyloid PET" es "PET
 *    amiloide").
 *
 *  Medido antes del cambio: "25.4 points", "24 months" y "amyloid PET" no
 *  casaban con una respuesta correcta en español y el caso fallaba siempre. */
export function patronesDeClave(clave: string, textoFragmento: string, textoEnEspanol: string): string[] {
  const limpia = clave.trim().replace(/\s+/g, " ");
  if (!claveValida(limpia, textoFragmento)) return [];
  // Palabras enteras del texto en español, en minúsculas. Se compara por
  // palabra y no por subcadena: "stable" está dentro de "estable" y no por
  // eso sobrevive a la traducción.
  const palabrasEnEspanol = new Set((textoEnEspanol.toLowerCase().match(/[\p{L}\p{N}]+(?:[-‐‑][\p{L}\p{N}]+)*/gu) ?? []));
  const patrones: string[] = [];
  for (const crudo of limpia.split(" ")) {
    const token = crudo.replace(PUNTUACION_EXTERIOR, "");
    if (!token) continue;
    if (!/\p{L}/u.test(token) || CIFRA_CON_UNIDAD.test(token)) {
      for (const numero of token.match(NUMEROS) ?? []) {
        // Un solo dígito no comprueba nada.
        if (numero.replace(/\D/g, "").length < 2) continue;
        patrones.push(`(?<!\\d)${patronDeClave(numero)}(?!\\d)`);
      }
      continue;
    }
    const conDigitos = /\p{N}/u.test(token);
    const invariante = conDigitos || /\p{Lu}/u.test(token.slice(1)) || palabrasEnEspanol.has(token.toLowerCase());
    if (!invariante) continue;
    if (!conDigitos && token.length < 4) continue;
    patrones.push(patronDeClave(token));
  }
  return [...new Set(patrones)];
}

/** Los patrones de una lista de claves, sin repetir y acotados. */
export function patronesDe(claves: string[], textoFragmento: string, textoEnEspanol: string, max: number): string[] {
  return [...new Set(claves.flatMap((k) => patronesDeClave(k, textoFragmento, textoEnEspanol)))].slice(0, max);
}

/** `n` elementos repartidos a lo largo de la lista (el primero, el último y
 *  los intermedios a paso fijo). */
export function espaciados<T>(lista: T[], n: number): T[] {
  if (n <= 0 || !lista.length) return [];
  if (lista.length <= n) return lista.slice();
  if (n === 1) return [lista[0]];
  const salida: T[] = [];
  for (let i = 0; i < n; i++) salida.push(lista[Math.round((i * (lista.length - 1)) / (n - 1))]);
  return salida;
}

/** Generador determinista (mulberry32) sembrado con un texto: la misma
 *  generación repite el mismo muestreo, lo que hace reproducible una prueba. */
export function azarDe(semilla: string): () => number {
  let h = 2166136261;
  for (const c of semilla) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let estado = h >>> 0;
  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function barajar<T>(lista: T[], azar: () => number): T[] {
  const copia = lista.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

export interface Muestra {
  documento: string;
  fragmento: Fragmento;
}

export interface MuestraDocumento {
  documento: string;
  textos: Fragmento[];
  tablas: Fragmento[];
}

/** Fragmentos de texto de todos los documentos, intercalados por documento
 *  (el primero de cada uno, luego el segundo...): así el lote que ve el
 *  modelo mezcla obras y un documento largo no se lleva todas las preguntas. */
export function intercalar(muestras: MuestraDocumento[], que: "textos" | "tablas"): Muestra[] {
  const salida: Muestra[] = [];
  const max = Math.max(0, ...muestras.map((m) => m[que].length));
  for (let i = 0; i < max; i++) {
    for (const m of muestras) {
      const f = m[que][i];
      if (f) salida.push({ documento: m.documento, fragmento: f });
    }
  }
  return salida;
}

/** Parejas de fragmentos de documentos DISTINTOS que comparten términos
 *  discriminantes (biomarcadores, escalas, cohortes: lo que `terminosDeBusqueda`
 *  prioriza), de más a menos solape y sin repetir fragmento. Sin ninguna
 *  pareja con solape suficiente, se emparejan documentos consecutivos y es
 *  el modelo quien decide si hay una pregunta que los combine. */
export function paresRelacionados(muestras: MuestraDocumento[], minimoComun = 2): Array<[Muestra, Muestra]> {
  const todas = intercalar(muestras, "textos");
  const terminos = todas.map((m) => new Set(terminosDeBusqueda(m.fragmento.text, 16).map((t) => t.toLowerCase())));
  const candidatas: Array<{ i: number; j: number; comun: number }> = [];
  for (let i = 0; i < todas.length; i++) {
    for (let j = i + 1; j < todas.length; j++) {
      if (todas[i].documento === todas[j].documento) continue;
      let comun = 0;
      for (const t of terminos[i]) if (terminos[j].has(t)) comun += 1;
      if (comun >= minimoComun) candidatas.push({ i, j, comun });
    }
  }
  candidatas.sort((a, b) => b.comun - a.comun || a.i - b.i || a.j - b.j);
  const usados = new Set<number>();
  const pares: Array<[Muestra, Muestra]> = [];
  for (const c of candidatas) {
    if (usados.has(c.i) || usados.has(c.j)) continue;
    usados.add(c.i);
    usados.add(c.j);
    pares.push([todas[c.i], todas[c.j]]);
  }
  if (!pares.length) {
    for (let k = 0; k + 1 < muestras.length; k += 2) {
      const a = muestras[k].textos[0];
      const b = muestras[k + 1].textos[0];
      if (a && b) pares.push([{ documento: muestras[k].documento, fragmento: a }, { documento: muestras[k + 1].documento, fragmento: b }]);
    }
  }
  return pares;
}

// ---------------------------------------------------------------------------
// El plan: la lista de tareas de una generación
// ---------------------------------------------------------------------------
/** Una tarea es UNA llamada al modelo: un lote de fragmentos (single_hop,
 *  tabla), una pareja (multi_hop), un intento con los fragmentos de contexto
 *  (abstencion) o un fragmento (entidad). Solo viajan los ids: los fragmentos
 *  se vuelven a leer en el paso que los usa. */
export interface Tarea {
  categoria: Categoria;
  fragmentos: Array<{ chunkId: Id<"chunks">; documento: string }>;
}

const tareaValidator = v.object({
  categoria: categoriaValidator,
  fragmentos: v.array(v.object({ chunkId: v.id("chunks"), documento: v.string() })),
});

/** Las tareas de una generación, en el orden en que se ejecutan. Por
 *  categoría se dedican como mucho `CANDIDATOS_POR_CASO` candidatos por caso
 *  pedido, así que el número de pasos (y de llamadas) queda acotado por el
 *  objetivo: con 20 preguntas son 31 llamadas como mucho; con 60, 87. */
export function planificar(muestras: MuestraDocumento[], cuotas: PorCategoria<number>, azar: () => number): Tarea[] {
  const tareas: Tarea[] = [];
  const ref = (m: Muestra) => ({ chunkId: m.fragmento._id as Id<"chunks">, documento: m.documento });
  const lotes = (pool: Muestra[], categoria: "single_hop" | "tabla") => {
    const candidatos = pool.slice(0, Math.max(0, cuotas[categoria]) * CANDIDATOS_POR_CASO);
    for (let i = 0; i < candidatos.length; i += LOTE_PROMPT) {
      tareas.push({ categoria, fragmentos: candidatos.slice(i, i + LOTE_PROMPT).map(ref) });
    }
  };
  const textos = intercalar(muestras, "textos");
  lotes(textos, "single_hop");
  lotes(intercalar(muestras, "tablas"), "tabla");
  if (cuotas.multi_hop > 0 && muestras.filter((m) => m.textos.length).length >= 2) {
    for (const [a, b] of paresRelacionados(muestras).slice(0, cuotas.multi_hop * CANDIDATOS_POR_CASO)) {
      tareas.push({ categoria: "multi_hop", fragmentos: [ref(a), ref(b)] });
    }
  }
  if (cuotas.abstencion > 0) {
    // Una muestra corta de varios documentos para que el modelo sepa de qué va
    // el corpus y proponga ausencias del mismo dominio, no de otro campo.
    const contexto = textos.slice(0, CONTEXTO_AUSENCIA).map(ref);
    if (contexto.length) {
      for (let i = 0; i < INTENTOS_AUSENCIA; i++) tareas.push({ categoria: "abstencion", fragmentos: contexto });
    }
  }
  if (cuotas.entidad > 0) {
    for (const m of barajar(textos, azar).slice(0, cuotas.entidad * CANDIDATOS_POR_CASO)) {
      tareas.push({ categoria: "entidad", fragmentos: [ref(m)] });
    }
  }
  return tareas;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const REGLAS_COMUNES =
  "Escribe SIEMPRE en español, aunque los fragmentos estén en inglés. No " +
  "inventes nada que no esté en los fragmentos. No preguntes por autores, " +
  "referencias, agradecimientos ni por la estructura del documento. Las " +
  "preguntas deben ser las que haría una médica investigadora: concretas, " +
  "verificables leyendo el documento y con una sola respuesta correcta. " +
  "Responde SOLO con el JSON pedido.";

/** La respuesta se puntúa en español: las claves tienen que sobrevivir a la
 *  traducción. Se le dice al modelo para que no proponga "25.4 points" y
 *  descartemos menos. */
const REGLA_CLAVES =
  "La respuesta que se evaluará estará EN ESPAÑOL, así que cada clave tiene " +
  "que escribirse igual en los dos idiomas: una cifra SIN unidad (0.94, 25.4, " +
  "1200) o un nombre propio o sigla (p-tau217, MMSE, lecanemab, BioFINDER). " +
  'Nunca palabras comunes en inglés ("points", "months", "amyloid"). La ' +
  "respuesta esperada debe mencionar esas mismas claves. ";

/** Los términos se comprueban contra el índice del corpus, que está en el
 *  idioma de los artículos: si solo vinieran en español no encontrarían nada
 *  y una ausencia falsa pasaría por buena. */
const REGLA_TERMINOS =
  '"terminos": entre 2 y 5 formas de nombrar a la entidad ausente, en español, ' +
  "en inglés (el idioma habitual de los artículos) y con sus siglas o " +
  'abreviaturas si las tiene (por ejemplo ["tau fosforilada 181", ' +
  '"phosphorylated tau 181", "p-tau181"]), sin palabras genéricas como ' +
  '"estudio" o "pacientes". ';

export const PROMPT_UN_DOCUMENTO =
  "Eres quien redacta preguntas de control para comprobar si un asistente " +
  "documental responde bien sobre un corpus clínico. Recibes fragmentos " +
  "numerados. Para CADA fragmento útil escribe UNA pregunta que se responda " +
  "solo con ese fragmento, la respuesta esperada en una o dos frases en " +
  "llano (con la cifra o el término clave), y entre 1 y 3 \"claves\": cadenas " +
  "cortas copiadas LITERALMENTE del fragmento que una respuesta correcta " +
  "tendría que contener. " +
  REGLA_CLAVES +
  "Si un fragmento no da para una pregunta útil, omítelo. " +
  REGLAS_COMUNES +
  ' Formato: {"casos":[{"n":1,"pregunta":"...","respuesta_esperada":"...","claves":["..."]}]}';

export const PROMPT_TABLA =
  "Eres quien redacta preguntas de control para comprobar si un asistente " +
  "documental lee bien las TABLAS y CIFRAS de un corpus clínico. Recibes " +
  "fragmentos numerados que son filas o bloques de tablas. Para CADA fragmento " +
  "útil escribe UNA pregunta que pida una cifra concreta (un valor, un " +
  "porcentaje, un tamaño de muestra) que esté en ese fragmento, la " +
  "respuesta esperada en llano y entre 1 y 3 \"claves\": la cifra o cifras " +
  "copiadas LITERALMENTE del fragmento que la respuesta correcta tendría que " +
  "contener. " +
  REGLA_CLAVES +
  "Si el fragmento no tiene una cifra clara, omítelo. " +
  REGLAS_COMUNES +
  ' Formato: {"casos":[{"n":1,"pregunta":"...","respuesta_esperada":"...","claves":["..."]}]}';

export const PROMPT_VARIOS_DOCUMENTOS =
  "Eres quien redacta preguntas de control para comprobar si un asistente " +
  "documental sabe COMBINAR dos documentos. Recibes dos fragmentos de " +
  "documentos distintos. Si hablan de lo mismo (misma entidad, mismo " +
  "biomarcador, misma medida) escribe UNA pregunta que exija usar los dos " +
  "(comparar, contrastar, sumar), que no se pueda contestar con uno solo; la " +
  "respuesta esperada en llano; \"claves_a\": 1 o 2 cadenas copiadas " +
  "LITERALMENTE del fragmento 1 y \"claves_b\": 1 o 2 copiadas LITERALMENTE " +
  "del fragmento 2, que una respuesta correcta tendría que contener. " +
  REGLA_CLAVES +
  'Si no hay relación real, devuelve {"pregunta":null}. ' +
  REGLAS_COMUNES +
  ' Formato: {"pregunta":"...","respuesta_esperada":"...","claves_a":["..."],"claves_b":["..."]}';

export const PROMPT_AUSENCIA =
  "Eres quien redacta preguntas de control para comprobar que un asistente " +
  "documental reconoce lo que NO está en su corpus. Recibes fragmentos de " +
  "muestra que enseñan de qué trata el corpus. Propón el número pedido de " +
  "preguntas plausibles en ese mismo dominio sobre fármacos, biomarcadores, " +
  "escalas, ensayos o poblaciones concretos que NO aparecen en los fragmentos " +
  "y que con toda probabilidad no están en el corpus. Para cada una da " +
  REGLA_TERMINOS +
  REGLAS_COMUNES +
  ' Formato: {"casos":[{"pregunta":"...","terminos":["..."]}]}';

export const PROMPT_ENTIDAD =
  "Eres quien redacta preguntas TRAMPA para comprobar que un asistente " +
  "documental no atribuye a una entidad lo que el corpus dice de otra. Recibes " +
  "un fragmento que habla de una entidad concreta (un fármaco, un biomarcador, " +
  "una cohorte, una escala). Identifica esa entidad en \"entidad_presente\"; " +
  "elige una \"entidad_ausente\" de la MISMA clase (otro fármaco de la misma " +
  "familia, otro biomarcador del mismo tipo) que no aparezca en el fragmento; " +
  "y escribe una \"pregunta\" sobre la entidad ausente paralela al dato del " +
  "fragmento, de modo que quien confunda las dos entidades responda con el " +
  "dato del fragmento. Da " +
  REGLA_TERMINOS +
  "Si el fragmento no habla de ninguna entidad concreta, " +
  'devuelve {"pregunta":null}. ' +
  REGLAS_COMUNES +
  ' Formato: {"entidad_presente":"...","entidad_ausente":"...","terminos":["..."],"pregunta":"..."}';

// ---------------------------------------------------------------------------
// Ayudantes de la cadena
// ---------------------------------------------------------------------------
/** Un fallo con un mensaje que puede leer la usuaria. Cualquier otra
 *  excepción se registra en los logs y se le enseña una frase genérica. */
class ErrorLegible extends Error {}

const MENSAJE_FALLO_GENERICO =
  "No se pudieron proponer preguntas por un fallo del asistente. Vuelve a intentarlo en unos minutos.";
const MENSAJE_FALLO_A_MITAD = "El asistente dejó de responder a mitad. Las preguntas ya propuestas se han guardado.";

/** El estado de un paso mientras se ejecuta. `hechos` y `claves` vuelven a
 *  los argumentos del paso siguiente; `avance` va a la fila. */
interface Paso {
  ctx: ActionCtx;
  a: Ajustes;
  propietario: Id<"users">;
  generacionId: Id<"evaluacionGeneraciones">;
  cuotas: PorCategoria<number>;
  hechos: PorCategoria<number>;
  claves: PorCategoria<string>;
  avance: { generados: number; descartados: number };
  fallosSeguidos: number;
  huboFallo: boolean;
}

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function textoDe(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

function listaDeTextos(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean) : [];
}

function recortarTexto(texto: string, max: number): string {
  return texto.length <= max ? texto : `${texto.slice(0, max)} [...]`;
}

/** Cómo ve el modelo un fragmento: documento, lugar y texto. */
export function textoDeFragmento(n: number, m: Muestra): string {
  const f = m.fragmento;
  const titulo = f.titulo ? ` (${f.titulo})` : "";
  const seccion = f.section?.trim() ? `, sección "${f.section.trim()}"` : "";
  return `### Fragmento ${n}\nDocumento: ${m.documento}${titulo}\nLugar: ${localizador(f)}${seccion}\nTexto:\n${recortarTexto(f.text, TEXTO_MAX_PROMPT)}\n`;
}

/** La fuente esperada de un fragmento: fichero real, sus páginas (la
 *  principal y las de origen) y la sección literal si la tiene. */
export function fuenteDe(f: Fragmento): { file: string; pages: number[]; section_patterns: string[] } {
  const pages = [...new Set([f.page, ...(f.sourcePages ?? [])])].filter((p) => Number.isInteger(p) && p > 0);
  const seccion = f.section?.trim() ?? "";
  return { file: f.sourceFile, pages, section_patterns: seccion ? [escaparRegex(seccion)] : [] };
}

/** Escribe el avance en la fila. Un fallo aquí no para la generación: es
 *  información para la pestaña, no estado de la cadena. */
async function escribirAvance(
  ctx: ActionCtx,
  generacionId: Id<"evaluacionGeneraciones">,
  cambios: { paso?: string; generados?: number; descartados?: number },
): Promise<void> {
  try {
    await ctx.runMutation(internal.evaluacion.generar.avanzar, { generacionId, ...cambios });
  } catch (exc) {
    console.warn("no se pudo escribir el avance de la generación", String(exc).slice(0, 120));
  }
}

async function informar(p: Paso, paso: string): Promise<void> {
  await escribirAvance(p.ctx, p.generacionId, { paso, generados: p.avance.generados, descartados: p.avance.descartados });
}

/** La promesa, o un error si no resuelve en `ms`. La petición de fondo queda
 *  abandonada: cuando la acción termina, Convex la desecha. */
function conTope<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error(`el modelo no respondió en ${Math.round(ms / 1000)} s`)), ms);
    promesa.then(
      (x) => {
        clearTimeout(reloj);
        resolver(x);
      },
      (exc) => {
        clearTimeout(reloj);
        rechazar(exc);
      },
    );
  });
}

async function pedirJson(p: Paso, sistema: string, usuario: string): Promise<Record<string, unknown>> {
  const r = await conTope(
    gateway.completionJson(
      {
        model: p.a.modelo,
        temperature: p.a.temperatura,
        messages: [
          { role: "system", content: sistema },
          { role: "user", content: usuario },
        ],
        ...gateway.razonamiento(p.a.razonamientoPlanner),
      },
      p.a,
    ),
    presupuesto.llamadaMs,
  );
  p.fallosSeguidos = 0;
  return esObjeto(r.datos) ? r.datos : {};
}

function descartar(p: Paso, cuantos = 1): void {
  if (cuantos > 0) p.avance.descartados += cuantos;
}

function anotarFallo(p: Paso, exc: unknown): void {
  p.fallosSeguidos += 1;
  p.huboFallo = true;
  console.warn("generación de casos: una llamada al modelo falló", (exc instanceof Error ? exc.message : String(exc)).slice(0, 200));
}

/** Valida y guarda un caso propuesto. Devuelve si se guardó. */
async function guardar(
  p: Paso,
  categoria: Categoria,
  campos: { pregunta: string; modo: "normal" | "extendido"; respuestaEsperada: string; definicion: Record<string, unknown> },
): Promise<boolean> {
  const clave = p.claves[categoria];
  try {
    validarCaso({ ...campos.definicion, id: clave });
  } catch (exc) {
    console.warn("caso propuesto inválido, descartado", String(exc).slice(0, 200));
    descartar(p);
    return false;
  }
  const definitiva = await p.ctx.runMutation(internal.evaluacion.generar.guardarCaso, {
    propietario: p.propietario,
    categoria,
    clave,
    pregunta: campos.pregunta,
    modo: campos.modo,
    critico: true,
    respuestaEsperada: campos.respuestaEsperada.slice(0, 2000),
    definicion: campos.definicion,
  });
  p.claves[categoria] = siguienteClave(definitiva);
  p.avance.generados += 1;
  p.hechos[categoria] += 1;
  return true;
}

/** Si la entidad está en el corpus, según la búsqueda léxica: un término
 *  cuenta como presente cuando TODAS sus palabras con contenido (las que deja
 *  `terminosDeBusqueda`: sin palabras vacías, con el guion interno respetado,
 *  de 3 o más caracteres) devuelven algún fragmento; basta un término presente
 *  para descartar el caso. Se exige que estén todas las palabras y no alguna
 *  porque "ensayo CLARITY" tiene "ensayo" en cualquier corpus clínico y eso
 *  no dice nada de CLARITY. Los términos llegan en español y en inglés (ver
 *  REGLA_TERMINOS): el índice está en el idioma de los artículos. */
async function algunTerminoPresente(p: Paso, terminos: string[]): Promise<boolean> {
  for (const termino of terminos) {
    const palabras = terminosDeBusqueda(termino).filter((w) => Array.from(w).length >= 3);
    if (!palabras.length) continue;
    let todas = true;
    for (const palabra of palabras) {
      const ids = await p.ctx.runQuery(internal.search.hybrid.lexica, {
        propietario: p.propietario,
        terminos: palabra,
        n: 1,
        filtros: {},
      });
      if (!ids.length) {
        todas = false;
        break;
      }
    }
    if (todas) return true;
  }
  return false;
}

/** Los fragmentos de la tarea, releídos por id y en su orden; `null` donde ya
 *  no sirven. */
async function leerMuestras(p: Paso, tarea: Tarea): Promise<Array<Muestra | null>> {
  const fragmentos = await p.ctx.runQuery(internal.evaluacion.generar.leerFragmentos, {
    propietario: p.propietario,
    ids: tarea.fragmentos.map((f) => f.chunkId),
  });
  return tarea.fragmentos.map((ref, i) => {
    const f = fragmentos[i];
    return f ? { documento: ref.documento, fragmento: f } : null;
  });
}

function presentes(muestras: Array<Muestra | null>): Muestra[] {
  return muestras.filter((m): m is Muestra => m !== null);
}

async function muestrearDocumento(
  ctx: ActionCtx,
  propietario: Id<"users">,
  d: { _id: Id<"documents">; fileName: string },
): Promise<MuestraDocumento> {
  const leidos: Fragmento[] = [];
  let desde: number | undefined;
  for (let vuelta = 0; vuelta < Math.ceil(MAX_FRAGMENTOS_POR_DOCUMENTO / LOTE_FRAGMENTOS); vuelta++) {
    const r = await ctx.runQuery(internal.evaluacion.generar.fragmentosDe, {
      propietario,
      documentId: d._id,
      desde,
      n: LOTE_FRAGMENTOS,
    });
    leidos.push(...r.fragmentos);
    if (r.agotado || r.ultimo === null) break;
    desde = r.ultimo;
  }
  return {
    documento: d.fileName,
    textos: espaciados(leidos.filter((f) => f.chunkType !== "table"), POR_DOCUMENTO),
    tablas: espaciados(leidos.filter((f) => f.chunkType === "table"), TABLAS_POR_DOCUMENTO),
  };
}

// ---------------------------------------------------------------------------
// Las tareas
// ---------------------------------------------------------------------------
/** single_hop y tabla: un lote de fragmentos, una pregunta por fragmento. Los
 *  fragmentos del lote para los que el modelo no propone nada cuentan como
 *  descartados: son candidatos gastados, y así el avance sube en cada paso
 *  aunque el modelo no encuentre nada que preguntar. */
async function pasoDeFragmentos(p: Paso, tarea: Tarea, categoria: "single_hop" | "tabla"): Promise<void> {
  const etiqueta = categoria === "tabla" ? "sobre tablas y cifras" : "sobre un documento";
  await informar(p, `Proponiendo preguntas ${etiqueta} (${p.hechos[categoria]} de ${p.cuotas[categoria]})`);
  const lote = presentes(await leerMuestras(p, tarea));
  descartar(p, tarea.fragmentos.length - lote.length);
  if (!lote.length) return;
  let datos: Record<string, unknown>;
  try {
    datos = await pedirJson(
      p,
      categoria === "tabla" ? PROMPT_TABLA : PROMPT_UN_DOCUMENTO,
      lote.map((m, i) => textoDeFragmento(i + 1, m)).join("\n"),
    );
  } catch (exc) {
    anotarFallo(p, exc);
    descartar(p, lote.length);
    return;
  }
  const casos = Array.isArray(datos.casos) ? datos.casos.filter(esObjeto) : [];
  const conPropuesta = new Set(casos.map((c) => Number(c.n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= lote.length));
  for (const c of casos) {
    if (p.hechos[categoria] >= p.cuotas[categoria]) break;
    const m = lote[Number(c.n) - 1];
    const pregunta = textoDe(c.pregunta);
    const respuesta = textoDe(c.respuesta_esperada);
    const patrones = m ? patronesDe(listaDeTextos(c.claves), m.fragmento.text, `${pregunta} ${respuesta}`, 3) : [];
    if (!m || !pregunta || !respuesta || !patrones.length) {
      descartar(p);
      continue;
    }
    const f = m.fragmento;
    const definicion = {
      question: pregunta,
      mode: "normal",
      category: categoria,
      critical: true,
      min_hops: 1,
      evidence: [
        {
          id: "ev-1",
          description: `Dato de ${m.documento}, ${localizador(f)}`,
          sources: [fuenteDe(f)],
        },
      ],
      hop_patterns: [],
      answer_must_contain: patrones,
      answer_must_not_contain: [],
      expect_abstention: false,
      notes: `Propuesta automáticamente a partir de ${m.documento} (${localizador(f)}).`,
    };
    await guardar(p, categoria, { pregunta, modo: "normal", respuestaEsperada: respuesta, definicion });
  }
  descartar(p, lote.length - conPropuesta.size);
}

async function pasoMultiHop(p: Paso, tarea: Tarea): Promise<void> {
  await informar(p, `Proponiendo preguntas que combinan dos documentos (${p.hechos.multi_hop} de ${p.cuotas.multi_hop})`);
  const [a, b] = await leerMuestras(p, tarea);
  if (!a || !b) {
    descartar(p);
    return;
  }
  let datos: Record<string, unknown>;
  try {
    datos = await pedirJson(p, PROMPT_VARIOS_DOCUMENTOS, textoDeFragmento(1, a) + "\n" + textoDeFragmento(2, b));
  } catch (exc) {
    anotarFallo(p, exc);
    descartar(p);
    return;
  }
  const pregunta = textoDe(datos.pregunta);
  const respuesta = textoDe(datos.respuesta_esperada);
  const espanol = `${pregunta} ${respuesta}`;
  const patronesA = patronesDe(listaDeTextos(datos.claves_a), a.fragmento.text, espanol, 2);
  const patronesB = patronesDe(listaDeTextos(datos.claves_b), b.fragmento.text, espanol, 2);
  if (!pregunta || !respuesta || !patronesA.length || !patronesB.length) {
    descartar(p);
    return;
  }
  const definicion = {
    question: pregunta,
    mode: "extendido",
    category: "multi_hop",
    critical: true,
    min_hops: 2,
    evidence: [
      { id: "doc-a", description: `Dato de ${a.documento}, ${localizador(a.fragmento)}`, sources: [fuenteDe(a.fragmento)] },
      { id: "doc-b", description: `Dato de ${b.documento}, ${localizador(b.fragmento)}`, sources: [fuenteDe(b.fragmento)] },
    ],
    hop_patterns: [],
    answer_must_contain: [...new Set([...patronesA, ...patronesB])],
    answer_must_not_contain: [],
    expect_abstention: false,
    notes: `Propuesta automáticamente combinando ${a.documento} y ${b.documento}.`,
  };
  await guardar(p, "multi_hop", { pregunta, modo: "extendido", respuestaEsperada: respuesta, definicion });
}

const RESPUESTA_AUSENCIA = "Debe decir que esa información no está en tus documentos, sin inventar una respuesta.";

async function pasoAbstencion(p: Paso, tarea: Tarea): Promise<void> {
  await informar(p, `Proponiendo preguntas cuya respuesta no está en tus documentos (${p.hechos.abstencion} de ${p.cuotas.abstencion})`);
  const muestras = presentes(await leerMuestras(p, tarea));
  if (!muestras.length) {
    descartar(p);
    return;
  }
  const contexto = muestras
    .map((m, i) => `### Fragmento ${i + 1}\nDocumento: ${m.documento}\n${recortarTexto(m.fragmento.text, 500)}\n`)
    .join("\n");
  const pendientes = p.cuotas.abstencion - p.hechos.abstencion;
  let datos: Record<string, unknown>;
  try {
    datos = await pedirJson(p, PROMPT_AUSENCIA, `Número de preguntas: ${pendientes + 2}\n\n${contexto}`);
  } catch (exc) {
    anotarFallo(p, exc);
    descartar(p, pendientes);
    return;
  }
  const casos = Array.isArray(datos.casos) ? datos.casos.filter(esObjeto) : [];
  if (!casos.length) descartar(p);
  for (const c of casos) {
    if (p.hechos.abstencion >= p.cuotas.abstencion) break;
    const pregunta = textoDe(c.pregunta);
    const terminos = listaDeTextos(c.terminos).slice(0, MAX_TERMINOS_ENTIDAD);
    if (!pregunta || !terminos.length) {
      descartar(p);
      continue;
    }
    await informar(p, "Comprobando que la respuesta no está en tus documentos");
    if (await algunTerminoPresente(p, terminos)) {
      descartar(p);
      continue;
    }
    const definicion = {
      question: pregunta,
      mode: "normal",
      category: "abstencion",
      critical: true,
      min_hops: 1,
      evidence: [],
      hop_patterns: [],
      answer_must_contain: [],
      answer_must_not_contain: [],
      expect_abstention: true,
      notes: `Entidad ausente comprobada con la búsqueda: ${terminos.join(", ")}.`,
    };
    await guardar(p, "abstencion", { pregunta, modo: "normal", respuestaEsperada: RESPUESTA_AUSENCIA, definicion });
  }
}

async function pasoEntidad(p: Paso, tarea: Tarea): Promise<void> {
  await informar(p, `Proponiendo preguntas trampa sobre otra entidad (${p.hechos.entidad} de ${p.cuotas.entidad})`);
  const [m] = await leerMuestras(p, tarea);
  if (!m) {
    descartar(p);
    return;
  }
  let datos: Record<string, unknown>;
  try {
    datos = await pedirJson(p, PROMPT_ENTIDAD, textoDeFragmento(1, m));
  } catch (exc) {
    anotarFallo(p, exc);
    descartar(p);
    return;
  }
  const pregunta = textoDe(datos.pregunta);
  const presente = textoDe(datos.entidad_presente);
  const ausente = textoDe(datos.entidad_ausente);
  const terminos = listaDeTextos(datos.terminos).slice(0, MAX_TERMINOS_ENTIDAD);
  if (ausente && !terminos.length) terminos.push(ausente);
  if (!pregunta || !ausente || !terminos.length) {
    descartar(p);
    return;
  }
  await informar(p, "Comprobando que la otra entidad no está en tus documentos");
  if (await algunTerminoPresente(p, terminos)) {
    descartar(p);
    return;
  }
  const definicion = {
    question: pregunta,
    mode: "normal",
    category: "entidad",
    critical: true,
    min_hops: 1,
    evidence: [],
    hop_patterns: [],
    answer_must_contain: [],
    answer_must_not_contain: [],
    expect_abstention: true,
    notes: `Trampa: el corpus habla de ${presente || "otra entidad"} (${m.documento}); se pregunta por ${ausente}, comprobada ausente.`,
  };
  const respuesta =
    `Debe decir que no encuentra información sobre ${ausente} en tus documentos` +
    (presente ? `, sin atribuirle lo que dicen de ${presente}.` : ".");
  await guardar(p, "entidad", { pregunta, modo: "normal", respuestaEsperada: respuesta, definicion });
}

async function ejecutar(p: Paso, tarea: Tarea): Promise<void> {
  switch (tarea.categoria) {
    case "single_hop":
    case "tabla":
      return await pasoDeFragmentos(p, tarea, tarea.categoria);
    case "multi_hop":
      return await pasoMultiHop(p, tarea);
    case "abstencion":
      return await pasoAbstencion(p, tarea);
    case "entidad":
      return await pasoEntidad(p, tarea);
  }
}

// ---------------------------------------------------------------------------
// La cadena
// ---------------------------------------------------------------------------
const CEROS: PorCategoria<number> = { single_hop: 0, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 };

/** El primer eslabón: lee los documentos, muestrea, reparte las cuotas y arma
 *  el plan; no llama al modelo. Termina agendando el primer `paso`. */
export const generar = internalAction({
  args: {
    propietario: v.id("users"),
    generacionId: v.id("evaluacionGeneraciones"),
    objetivo: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const a = ajustes();
    const objetivo = Math.max(1, Math.min(60, Math.floor(args.objetivo) || 1));
    try {
      try {
        exigirClave(a);
      } catch (exc) {
        console.error(exc);
        throw new ErrorLegible("El asistente no está configurado para proponer preguntas. Avisa a quien administra la aplicación.");
      }
      await escribirAvance(ctx, args.generacionId, { paso: "Leyendo tus documentos" });
      const docs = await ctx.runQuery(internal.evaluacion.generar.documentosListos, { propietario: args.propietario });
      if (!docs.length) throw new ErrorLegible("No hay documentos listos sobre los que proponer preguntas.");
      const azar = azarDe(String(args.generacionId));
      const elegidos = barajar(docs, azar).slice(0, MAX_DOCUMENTOS_MUESTREADOS);
      const muestras: MuestraDocumento[] = [];
      for (const [i, d] of elegidos.entries()) {
        await escribirAvance(ctx, args.generacionId, { paso: `Leyendo ${d.fileName} (${i + 1} de ${elegidos.length})` });
        const m = await muestrearDocumento(ctx, args.propietario, d);
        if (m.textos.length || m.tablas.length) muestras.push(m);
      }
      if (!muestras.length) {
        throw new ErrorLegible("Los documentos listos no tienen texto suficiente para proponer preguntas.");
      }
      const usadas = new Set(await ctx.runQuery(internal.evaluacion.generar.clavesDe, { propietario: args.propietario }));
      const claves = Object.fromEntries(CATEGORIAS.map((c) => [c, claveLibre(c, usadas)])) as PorCategoria<string>;
      const cuotas = repartirCuotas(objetivo, {
        multiHop: muestras.filter((m) => m.textos.length).length >= 2,
        tabla: muestras.some((m) => m.tablas.length > 0),
      });
      const tareas = planificar(muestras, cuotas, azar);
      await escribirAvance(ctx, args.generacionId, { paso: "Preparando las preguntas" });
      await ctx.scheduler.runAfter(0, internal.evaluacion.generar.paso, {
        propietario: args.propietario,
        generacionId: args.generacionId,
        cuotas,
        hechos: CEROS,
        claves,
        tareas,
        indice: 0,
        fallosSeguidos: 0,
        huboFallo: false,
      });
    } catch (exc) {
      console.error("La generación de preguntas de control falló", args.generacionId, exc);
      await ctx.runMutation(internal.evaluacion.generar.cerrar, {
        generacionId: args.generacionId,
        estado: "error",
        error: exc instanceof ErrorLegible ? exc.message : MENSAJE_FALLO_GENERICO,
        generados: 0,
        descartados: 0,
      });
    }
  },
});

/** Un eslabón: ejecuta la tarea `indice` (una llamada al modelo) y se
 *  reagenda para la siguiente; sin tareas pendientes, cierra. Las tareas de
 *  una categoría que ya cubrió su cuota se saltan aquí mismo, sin llamada ni
 *  paso aparte. Cualquier excepción de la maquinaria cierra la generación en
 *  `error`: nada se queda `running` por un fallo que hayamos visto. */
export const paso = internalAction({
  args: {
    propietario: v.id("users"),
    generacionId: v.id("evaluacionGeneraciones"),
    cuotas: cuotasValidator,
    hechos: cuotasValidator,
    claves: clavesValidator,
    tareas: v.array(tareaValidator),
    indice: v.number(),
    fallosSeguidos: v.number(),
    huboFallo: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const g = await ctx.runQuery(internal.evaluacion.generar.leerGeneracion, { generacionId: args.generacionId });
    // Cerrada por `datos.generar` al darla por muerta, o borrada con la
    // cuenta: la cadena se detiene aquí sin escribir nada.
    if (!g || g.estado !== "running" || g.propietario !== args.propietario) return;
    const p: Paso = {
      ctx,
      a: ajustes(),
      propietario: args.propietario,
      generacionId: args.generacionId,
      cuotas: { ...args.cuotas },
      hechos: { ...args.hechos },
      claves: { ...args.claves },
      avance: { generados: g.generados, descartados: g.descartados },
      fallosSeguidos: args.fallosSeguidos,
      huboFallo: args.huboFallo,
    };
    try {
      let i = args.indice;
      while (i < args.tareas.length && p.hechos[args.tareas[i].categoria] >= p.cuotas[args.tareas[i].categoria]) i += 1;
      if (i >= args.tareas.length) {
        // Sin ninguna pregunta guardada y con fallos del modelo por el camino,
        // la generación no fue bien aunque no reventara: se dice.
        const fallo = p.avance.generados === 0 && p.huboFallo;
        await ctx.runMutation(internal.evaluacion.generar.cerrar, {
          generacionId: args.generacionId,
          estado: fallo ? "error" : "ok",
          error: fallo ? MENSAJE_FALLO_GENERICO : undefined,
          generados: p.avance.generados,
          descartados: p.avance.descartados,
        });
        return;
      }
      await ejecutar(p, args.tareas[i]);
      // El avance se escribe ANTES de agendar el siguiente paso: es lo que
      // lee el paso siguiente, y el latido que `datos.generacionColgada` mira.
      await ctx.runMutation(internal.evaluacion.generar.avanzar, {
        generacionId: args.generacionId,
        generados: p.avance.generados,
        descartados: p.avance.descartados,
      });
      if (p.fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
        await ctx.runMutation(internal.evaluacion.generar.cerrar, {
          generacionId: args.generacionId,
          estado: "error",
          error: p.avance.generados > 0 ? MENSAJE_FALLO_A_MITAD : MENSAJE_FALLO_GENERICO,
          generados: p.avance.generados,
          descartados: p.avance.descartados,
        });
        return;
      }
      await ctx.scheduler.runAfter(0, internal.evaluacion.generar.paso, {
        ...args,
        hechos: p.hechos,
        claves: p.claves,
        indice: i + 1,
        fallosSeguidos: p.fallosSeguidos,
        huboFallo: p.huboFallo,
      });
    } catch (exc) {
      console.error("La generación de preguntas de control falló", args.generacionId, exc);
      await ctx.runMutation(internal.evaluacion.generar.cerrar, {
        generacionId: args.generacionId,
        estado: "error",
        error: exc instanceof ErrorLegible ? exc.message : MENSAJE_FALLO_GENERICO,
        generados: p.avance.generados,
        descartados: p.avance.descartados,
      });
    }
  },
});
