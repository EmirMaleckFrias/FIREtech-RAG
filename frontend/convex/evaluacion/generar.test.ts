/// <reference types="vite/client" />
// La generación de preguntas de control (generar.ts): las utilidades puras sin
// base, y la cadena entera con convex-test, el gateway parcheado sobre su
// módulo (nunca se llama al real) y la búsqueda léxica REAL de la base en
// memoria, que es la que decide si un caso de ausencia se descarta.
//
// Lo que se intenta romper: que una clave copiada del fragmento en inglés
// haga fallar una respuesta correcta en español; que un término de ausencia en
// español no encuentre lo que el corpus dice en inglés; que la cadena haga más
// de una llamada por acción o siga girando contra un gateway caído; que un
// paso no deje latido en los contadores; y que un paso rezagado escriba sobre
// una generación ya cerrada.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import * as gateway from "../lib/gateway";
import schema from "../schema";
import { generacionColgada } from "./datos";
import { validarCaso } from "./puntuar";
import {
  CANDIDATOS_POR_CASO,
  CONTEXTO_AUSENCIA,
  INTENTOS_AUSENCIA,
  LLAMADA_MAX_MS,
  LOTE_PROMPT,
  MAX_FALLOS_SEGUIDOS,
  PROMPT_AUSENCIA,
  PROMPT_ENTIDAD,
  PROMPT_TABLA,
  PROMPT_UN_DOCUMENTO,
  PROMPT_VARIOS_DOCUMENTOS,
  azarDe,
  claveLibre,
  claveValida,
  configurarPresupuesto,
  espaciados,
  fuenteDe,
  intercalar,
  paresRelacionados,
  patronDeClave,
  patronesDe,
  patronesDeClave,
  planificar,
  repartirCuotas,
  siguienteClave,
  type MuestraDocumento,
} from "./generar";

const modules = import.meta.glob("/convex/**/*.*s");
type T = TestConvex<typeof schema>;

/** Casa como lo hace puntuar.ts: `new RegExp(p, "is")`. */
const casa = (patron: string, texto: string) => new RegExp(patron, "is").test(texto);

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------
describe("repartirCuotas", () => {
  test("suma exactamente el objetivo y respeta el reparto aproximado", () => {
    const c = repartirCuotas(20, { multiHop: true, tabla: true });
    expect(c).toEqual({ single_hop: 8, multi_hop: 5, tabla: 3, abstencion: 2, entidad: 2 });
    for (const n of [1, 2, 3, 7, 13, 60]) {
      const cuotas = repartirCuotas(n, { multiHop: true, tabla: true });
      expect(Object.values(cuotas).reduce((a, b) => a + b, 0)).toBe(n);
      expect(Object.values(cuotas).every((x) => x >= 0)).toBe(true);
    }
  });

  test("lo que el corpus no permite pasa a single_hop en vez de perderse", () => {
    const c = repartirCuotas(20, { multiHop: false, tabla: false });
    expect(c).toEqual({ single_hop: 16, multi_hop: 0, tabla: 0, abstencion: 2, entidad: 2 });
    expect(repartirCuotas(1, { multiHop: false, tabla: false })).toEqual({ single_hop: 1, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 });
  });
});

describe("claves y patrones", () => {
  test("patronDeClave escapa, tolera el separador decimal y el espaciado", () => {
    expect(casa(patronDeClave("0.94"), "el AUC fue 0,94")).toBe(true);
    expect(casa(patronDeClave("0,94"), "AUC 0.94")).toBe(true);
    expect(casa(patronDeClave("p-tau217 (plasma)"), "P-TAU217   (plasma)")).toBe(true);
    expect(casa(patronDeClave("42%"), "un 42% de")).toBe(true);
    // Escapado de verdad: el punto no es comodín.
    expect(casa(patronDeClave("v1.2"), "v1x2")).toBe(false);
    // Y es una regex válida para validarCaso.
    expect(() => validarCaso({ id: "x", question: "q", answer_must_contain: [patronDeClave("a+b (c)")], evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] })).not.toThrow();
  });

  test("ADVERSARIAL: una clave que no está en el fragmento, o demasiado corta o genérica, no vale", () => {
    const texto = "The AUC of plasma p-tau217 was 0.94 (95% CI 0.90-0.97) in the cohort.";
    expect(claveValida("0.94", texto)).toBe(true);
    expect(claveValida("p-tau217", texto)).toBe(true);
    expect(claveValida("0.97", texto)).toBe(true);
    expect(claveValida("0.99", texto)).toBe(false);
    expect(claveValida("lecanemab", texto)).toBe(false);
    expect(claveValida("in", texto)).toBe(false);
    expect(claveValida("AUC", texto)).toBe(false);
    expect(claveValida("", texto)).toBe(false);
    expect(claveValida("x".repeat(81), texto + "x".repeat(81))).toBe(false);
  });

  const FRAGMENTO_MMSE =
    "Participants completed the MMSE at baseline and at 24 months. The mean MMSE score declined from 27.1 " +
    "to 25.4 points in the amyloid positive group, and amyloid PET remained positive. Cerebrospinal fluid " +
    "was collected in a subset. Lecanemab was not administered.";
  const ESPANOL = "¿Cuánto bajó la puntuación media del MMSE a los 24 meses? Bajó de 27,1 a 25,4 puntos en el grupo amiloide positivo.";
  const RESPUESTA_CORRECTA = "La puntuación media del MMSE bajó de 27,1 a 25,4 puntos a los 24 meses en el grupo amiloide positivo [biomarcadores.pdf, pág. 5].";

  test("ADVERSARIAL: una clave copiada del fragmento en inglés casa con la respuesta correcta en español", () => {
    // Antes: "25.4 points" y "24 months" iban literales y una respuesta que
    // dice "25,4 puntos" y "24 meses" fallaba en cada corrida.
    const p1 = patronesDeClave("25.4 points", FRAGMENTO_MMSE, ESPANOL);
    expect(p1).toHaveLength(1);
    expect(casa(p1[0], RESPUESTA_CORRECTA)).toBe(true);
    expect(casa(p1[0], "bajó a 125,4 puntos")).toBe(false);
    expect(casa(p1[0], "bajó a 25,45 puntos")).toBe(false);
    // Y el número puede terminar frase.
    expect(casa(p1[0], "La media fue 25,4.")).toBe(true);

    const p2 = patronesDeClave("24 months", FRAGMENTO_MMSE, ESPANOL);
    expect(p2).toHaveLength(1);
    expect(casa(p2[0], RESPUESTA_CORRECTA)).toBe(true);
    expect(casa(p2[0], "publicado en 2024")).toBe(false);
    expect(casa(p2[0], "a los 124 meses")).toBe(false);

    // Una unidad pegada o con guion también se queda en la cifra.
    expect(patronesDeClave("24-month", "over a 24-month period", ESPANOL)).toEqual(p2);

    // El rango da dos cifras, las dos obligatorias; el porcentaje pierde el signo.
    const rango = patronesDeClave("95% CI 0.90-0.97", "AUC 0.94 (95% CI 0.90-0.97)", "IC del 95 %: 0,90 a 0,97");
    expect(rango).toHaveLength(3);
    expect(rango.every((p) => casa(p, "un AUC de 0,94 (IC 95 %: 0,90 a 0,97)"))).toBe(true);
  });

  test("ADVERSARIAL: las palabras que la traducción cambia se descartan; las siglas, los nombres con dígitos y lo que el modelo escribió en español se quedan, uno por patrón", () => {
    // "amyloid PET" es "PET amiloide": ni el orden ni la palabra sobreviven.
    expect(patronesDeClave("amyloid PET", FRAGMENTO_MMSE, ESPANOL)).toEqual([]);
    expect(patronesDeClave("Cerebrospinal fluid", FRAGMENTO_MMSE, ESPANOL)).toEqual([]);
    expect(patronesDeClave("amyloid positive group", FRAGMENTO_MMSE, ESPANOL)).toEqual([]);
    // Sigla: se escribe igual. "mean" y "score" caen.
    expect(patronesDeClave("mean MMSE score", FRAGMENTO_MMSE, ESPANOL)).toEqual(["MMSE"]);
    expect(casa("MMSE", RESPUESTA_CORRECTA)).toBe(true);
    // Un nombre con dígitos es invariante aunque no salga en el texto en español.
    expect(patronesDeClave("p-tau217", "plasma p-tau217 levels", "¿Qué biomarcador tuvo mejor AUC? El de plasma.")).toEqual(["p-tau217"]);
    // Una palabra llana solo vale si el modelo la escribió también en español.
    expect(patronesDeClave("Lecanemab", FRAGMENTO_MMSE, ESPANOL)).toEqual([]);
    expect(patronesDeClave("Lecanemab", FRAGMENTO_MMSE, "¿Se administró lecanemab? No se administró lecanemab.")).toEqual(["Lecanemab"]);
    expect(casa("Lecanemab", "no se administró lecanemab")).toBe(true);
    // Lo que no está en el fragmento sigue sin valer, esté como esté escrito.
    expect(patronesDeClave("0.99", FRAGMENTO_MMSE, ESPANOL)).toEqual([]);
    // Un solo dígito no comprueba nada.
    expect(patronesDeClave("5 mg", "a 5 mg dose", "5 mg")).toEqual([]);
    // Varias claves: sin repetir y acotadas; todas son regex válidas para validarCaso.
    const patrones = patronesDe(["25.4 points", "24 months", "mean MMSE score", "MMSE"], FRAGMENTO_MMSE, ESPANOL, 3);
    expect(patrones).toHaveLength(3);
    expect(new Set(patrones).size).toBe(3);
    expect(() => validarCaso({ id: "x", question: "q", answer_must_contain: patrones, evidence: [{ id: "e", description: "d", sources: [{ file: "a.pdf" }] }] })).not.toThrow();
    expect(patrones.every((p) => casa(p, RESPUESTA_CORRECTA))).toBe(true);
  });

  test("las claves son estables, correlativas y no chocan con las existentes", () => {
    expect(siguienteClave("single_hop-007")).toBe("single_hop-008");
    expect(siguienteClave("multi_hop-099")).toBe("multi_hop-100");
    expect(siguienteClave("rara")).toBe("rara-001");
    expect(claveLibre("tabla", new Set())).toBe("tabla-001");
    expect(claveLibre("tabla", new Set(["tabla-001", "tabla-002", "tabla-004"]))).toBe("tabla-003");
  });
});

function fragmento(extra: Record<string, unknown> = {}) {
  return {
    _id: String(extra._id ?? "c1"),
    text: String(extra.text ?? "x".repeat(300)),
    sourceFile: String(extra.sourceFile ?? "a.pdf"),
    page: typeof extra.page === "number" ? extra.page : 3,
    chunkType: String(extra.chunkType ?? "text"),
    ...extra,
  };
}

describe("muestreo", () => {
  test("espaciados reparte a lo largo de la lista, con el primero y el último", () => {
    const lista = Array.from({ length: 11 }, (_, i) => i);
    expect(espaciados(lista, 3)).toEqual([0, 5, 10]);
    expect(espaciados(lista, 1)).toEqual([0]);
    expect(espaciados([1, 2], 6)).toEqual([1, 2]);
    expect(espaciados(lista, 0)).toEqual([]);
  });

  test("intercalar alterna documentos para que uno largo no se lleve el lote", () => {
    const a = { documento: "a.pdf", textos: [fragmento({ _id: "a1" }), fragmento({ _id: "a2" }), fragmento({ _id: "a3" })], tablas: [] };
    const b = { documento: "b.pdf", textos: [fragmento({ _id: "b1" })], tablas: [] };
    expect(intercalar([a, b], "textos").map((m) => m.fragmento._id)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  test("fuenteDe toma el fichero y las páginas del fragmento, y la sección escapada solo si la hay", () => {
    expect(fuenteDe(fragmento({ page: 3, sourcePages: [3, 4], section: "Results (main)" }))).toEqual({
      file: "a.pdf", pages: [3, 4], section_patterns: ["Results \\(main\\)"],
    });
    expect(fuenteDe(fragmento({ page: 0, section: "  " }))).toEqual({ file: "a.pdf", pages: [], section_patterns: [] });
  });

  test("paresRelacionados empareja fragmentos de documentos DISTINTOS que comparten términos discriminantes", () => {
    const a = {
      documento: "a.pdf",
      textos: [
        fragmento({ _id: "a1", text: "Plasma p-tau217 showed an AUC of 0.94 for amyloid PET positivity in the BioFINDER cohort." }),
        fragmento({ _id: "a2", text: "Participants completed the MMSE and the MoCA at baseline and at 24 months." }),
      ],
      tablas: [],
    };
    const b = {
      documento: "b.pdf",
      textos: [
        fragmento({ _id: "b1", text: "In this cohort, MMSE and MoCA scores declined over 24 months of follow-up." }),
        fragmento({ _id: "b2", text: "Plasma p-tau217 discriminated amyloid PET status with an AUC of 0.91." }),
      ],
      tablas: [],
    };
    const mismoDoc = { documento: "a.pdf", textos: [fragmento({ _id: "a3", text: "Plasma p-tau217 and amyloid PET again, AUC 0.93." })], tablas: [] };
    const pares = paresRelacionados([a, b, mismoDoc]);
    expect(pares.length).toBeGreaterThanOrEqual(2);
    for (const [x, y] of pares) expect(x.documento).not.toBe(y.documento);
    const ids = pares.map(([x, y]) => [x.fragmento._id, y.fragmento._id].sort().join("+"));
    expect(ids).toContain("a1+b2");
    expect(ids).toContain("a2+b1");
    // Sin ningún término común, se recurre a documentos consecutivos y decide el modelo.
    const sueltos = paresRelacionados([
      { documento: "x.pdf", textos: [fragmento({ _id: "x1", text: "alpha beta gamma delta" })], tablas: [] },
      { documento: "y.pdf", textos: [fragmento({ _id: "y1", text: "uno dos tres cuatro" })], tablas: [] },
    ]);
    expect(sueltos.map(([x, y]) => [x.fragmento._id, y.fragmento._id])).toEqual([["x1", "y1"]]);
  });
});

describe("planificar", () => {
  /** 30 documentos con 6 textos y 3 tablas cada uno, como el muestreo real. */
  function corpusGrande(): MuestraDocumento[] {
    return Array.from({ length: 30 }, (_, d) => ({
      documento: `doc${d}.pdf`,
      textos: Array.from({ length: 6 }, (_, i) => fragmento({ _id: `d${d}t${i}`, text: `Plasma p-tau217 and MMSE in cohort ${d} fragment ${i} ` + "x".repeat(200) })),
      tablas: Array.from({ length: 3 }, (_, i) => fragmento({ _id: `d${d}b${i}`, chunkType: "table", text: `| ${d} | ${i} |` })),
    }));
  }

  test("ADVERSARIAL: el número de llamadas queda acotado por el objetivo aunque el corpus sea grande", () => {
    // Antes, single_hop recorría el pool entero (180 fragmentos, 36 llamadas)
    // si el modelo devolvía pocos casos por lote; con tabla, multi_hop y
    // entidad detrás, más de 70 llamadas en una sola acción de 600 s.
    const cuotas = repartirCuotas(20, { multiHop: true, tabla: true });
    const tareas = planificar(corpusGrande(), cuotas, azarDe("semilla"));
    const por = (c: string) => tareas.filter((t) => t.categoria === c);
    expect(por("single_hop")).toHaveLength(Math.ceil((cuotas.single_hop * CANDIDATOS_POR_CASO) / LOTE_PROMPT));
    expect(por("tabla")).toHaveLength(Math.ceil((cuotas.tabla * CANDIDATOS_POR_CASO) / LOTE_PROMPT));
    expect(por("multi_hop")).toHaveLength(cuotas.multi_hop * CANDIDATOS_POR_CASO);
    expect(por("abstencion")).toHaveLength(INTENTOS_AUSENCIA);
    expect(por("entidad")).toHaveLength(cuotas.entidad * CANDIDATOS_POR_CASO);
    expect(tareas).toHaveLength(31);
    // Con 60, el máximo permitido: 87 llamadas, no cientos.
    expect(planificar(corpusGrande(), repartirCuotas(60, { multiHop: true, tabla: true }), azarDe("s"))).toHaveLength(87);
    // Cada tarea lleva lo suyo: lotes de 5 como mucho, parejas de documentos
    // distintos, el contexto de ausencia acotado y un fragmento por trampa.
    for (const t of por("single_hop")) expect(t.fragmentos.length).toBeLessThanOrEqual(LOTE_PROMPT);
    for (const t of por("tabla")) expect(t.fragmentos.every((f) => f.chunkId.includes("b"))).toBe(true);
    for (const t of por("multi_hop")) {
      expect(t.fragmentos).toHaveLength(2);
      expect(t.fragmentos[0].documento).not.toBe(t.fragmentos[1].documento);
    }
    for (const t of por("abstencion")) expect(t.fragmentos).toHaveLength(CONTEXTO_AUSENCIA);
    for (const t of por("entidad")) expect(t.fragmentos).toHaveLength(1);
    // Determinista: la misma semilla, el mismo plan.
    expect(planificar(corpusGrande(), cuotas, azarDe("semilla"))).toEqual(tareas);
  });

  test("sin cuota no hay tareas de esa categoría, y un solo documento no da parejas", () => {
    const uno = corpusGrande().slice(0, 1);
    const tareas = planificar(uno, repartirCuotas(10, { multiHop: false, tabla: true }), azarDe("s"));
    expect(tareas.some((t) => t.categoria === "multi_hop")).toBe(false);
    // 6 textos y cuota 7: los 6 en dos lotes.
    expect(tareas.filter((t) => t.categoria === "single_hop").map((t) => t.fragmentos.length)).toEqual([5, 1]);
    expect(planificar(uno, { single_hop: 1, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 }, azarDe("s")).map((t) => t.categoria)).toEqual(["single_hop"]);
  });
});

// ---------------------------------------------------------------------------
// La cadena, con base en memoria
// ---------------------------------------------------------------------------
const VECTOR = new Array<number>(3072).fill(0);

const TEXTO_AUC =
  "In the validation cohort, plasma p-tau217 discriminated amyloid PET positivity with an AUC of 0.94 " +
  "(95% CI 0.90 to 0.97), outperforming p-tau231 and neurofilament light. Sensitivity was 0.89 and " +
  "specificity 0.88 at the prespecified cutoff. These results were consistent across APOE genotypes.";
const TEXTO_MMSE =
  "Participants completed the MMSE at baseline and at 24 months. The mean MMSE score declined from 27.1 " +
  "to 25.4 points in the amyloid positive group and remained stable in the amyloid negative group. " +
  "Cognitive decline correlated with baseline plasma p-tau217 levels in this longitudinal analysis.";
const TABLA = "| Biomarker | AUC | Sensitivity |\n| p-tau217 | 0.94 | 0.89 |\n| p-tau231 | 0.86 | 0.80 |";

/** Una cuenta con un documento listo y unos fragmentos que hablan de
 *  p-tau217 y del MMSE (y ni una palabra de donanemab ni de p-tau181). */
async function corpus(t: T, email = "ana@alzheimerproject.com"): Promise<{ propietario: Id<"users">; documentId: Id<"documents"> }> {
  return await t.run(async (ctx) => {
    const propietario = await ctx.db.insert("users", { email, rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 });
    const documentId = await ctx.db.insert("documents", {
      fileName: "biomarcadores.pdf", sha256: "x", pages: 12, chunks: 4, status: "ready", propietario, ingestadoEn: 1, documentType: "pdf",
    });
    const base = { embedding: VECTOR, sourceFile: "biomarcadores.pdf", documentRef: documentId, documentId: String(documentId), propietario, documentType: "pdf" };
    await ctx.db.insert("chunks", { ...base, text: TEXTO_AUC, page: 3, sourcePages: [3], section: "Results", chunkType: "text" });
    await ctx.db.insert("chunks", { ...base, text: TEXTO_MMSE, page: 5, section: "Results", chunkType: "text" });
    await ctx.db.insert("chunks", { ...base, text: TABLA, page: 4, section: "Table 2", chunkType: "table" });
    // Bibliografía: repite los términos y NUNCA debe servir de fuente.
    await ctx.db.insert("chunks", { ...base, text: "1. Palmqvist S, et al. Plasma p-tau217 ... 2. Janelidze S, et al. MMSE ... ".padEnd(300, "."), page: 11, section: "References", chunkType: "text" });
    return { propietario, documentId };
  });
}

async function generacion(t: T, propietario: Id<"users">, objetivo: number) {
  return await t.run((ctx) =>
    ctx.db.insert("evaluacionGeneraciones", { propietario, empezadoEn: Date.now(), estado: "running", objetivo, generados: 0, descartados: 0 }),
  );
}

/** Lanza el primer eslabón y deja correr la cadena entera. */
async function generarTodo(t: T, args: { propietario: Id<"users">; generacionId: Id<"evaluacionGeneraciones">; objetivo: number }) {
  await t.action(internal.evaluacion.generar.generar, args);
  await t.finishAllScheduledFunctions(() => {}, 300);
}

type Respuestas = Partial<Record<"unDocumento" | "tabla" | "varios" | "ausencia" | "entidad", (usuario: string) => unknown>>;

/** El gateway parcheado: responde según el prompt de sistema con lo que el
 *  test decida. Lo que no se especifica devuelve "nada que proponer". */
function gatewayFalso(respuestas: Respuestas) {
  const llamadas: Array<{ sistema: string; usuario: string }> = [];
  vi.spyOn(gateway, "completionJson").mockImplementation(async (kwargs) => {
    const mensajes = kwargs.messages as Array<{ role: string; content: string }>;
    const sistema = mensajes[0].content;
    const usuario = mensajes[1].content;
    llamadas.push({ sistema, usuario });
    let datos: unknown = { casos: [] };
    if (sistema === PROMPT_UN_DOCUMENTO) datos = respuestas.unDocumento?.(usuario) ?? { casos: [] };
    else if (sistema === PROMPT_TABLA) datos = respuestas.tabla?.(usuario) ?? { casos: [] };
    else if (sistema === PROMPT_VARIOS_DOCUMENTOS) datos = respuestas.varios?.(usuario) ?? { pregunta: null };
    else if (sistema === PROMPT_AUSENCIA) datos = respuestas.ausencia?.(usuario) ?? { casos: [] };
    else if (sistema === PROMPT_ENTIDAD) datos = respuestas.entidad?.(usuario) ?? { pregunta: null };
    return { datos, usage: { prompt: 10, cached: 0, completion: 5, reasoning: 0 }, modelo: "openai/gpt-5.4", finishReason: "stop", razonamientoRechazado: false };
  });
  return llamadas;
}

async function casosDe(t: T, propietario: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db.query("evaluacionCasos").withIndex("porPropietarioYEstado", (q) => q.eq("propietario", propietario)).collect(),
  );
}

/** El número del fragmento que contiene `marca` en el texto que vio el modelo. */
function numeroDe(usuario: string, marca: string): number {
  return usuario.split("### Fragmento").findIndex((s) => s.includes(marca));
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "vck_de_prueba");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  configurarPresupuesto({ llamadaMs: LLAMADA_MAX_MS });
});

describe("generar", () => {
  test("ADVERSARIAL: descarta un caso de ausencia cuya entidad SÍ está en el corpus y guarda el que de verdad falta", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    gatewayFalso({
      ausencia: () => ({
        casos: [
          // p-tau217 está en el corpus: la búsqueda léxica lo encuentra y el caso se descarta.
          { pregunta: "¿Qué AUC tiene p-tau217?", terminos: ["p-tau217"] },
          // "ensayo" está en cualquier corpus; "TRAILBLAZER" no: el término, como conjunto, está ausente.
          { pregunta: "¿Qué dosis de donanemab se usó en el ensayo TRAILBLAZER?", terminos: ["donanemab", "ensayo TRAILBLAZER"] },
        ],
      }),
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const casos = await casosDe(t, propietario);
    const ausencias = casos.filter((c) => c.categoria === "abstencion");
    expect(ausencias).toHaveLength(1);
    expect(ausencias[0].pregunta).toContain("donanemab");
    expect(ausencias[0]).toMatchObject({ clave: "abstencion-001", estado: "propuesto", origen: "generado", modo: "normal", critico: true });
    expect(ausencias[0].definicion).toMatchObject({ id: "abstencion-001", expect_abstention: true, evidence: [], category: "abstencion" });
    expect(() => validarCaso(ausencias[0].definicion)).not.toThrow();
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    expect(g).toMatchObject({ estado: "ok", generados: 1 });
    expect(g!.descartados).toBeGreaterThanOrEqual(1);
    expect(g!.paso).toBeUndefined();
    expect(g!.terminadoEn).toBeTypeOf("number");
  });

  test("ADVERSARIAL: un término de ausencia en español no basta; el mismo dato en inglés en el corpus descarta el caso", async () => {
    const t = convexTest(schema, modules);
    const { propietario, documentId } = await corpus(t);
    // El corpus habla del líquido cefalorraquídeo, en inglés.
    await t.run((ctx) =>
      ctx.db.insert("chunks", {
        embedding: VECTOR, sourceFile: "biomarcadores.pdf", documentRef: documentId, documentId: String(documentId), propietario,
        text: "Cerebrospinal fluid (CSF) samples were collected by lumbar puncture in a subset of participants and analysed for " +
          "amyloid beta 42 and total tau with the Elecsys platform, following the standard operating procedures of the cohort.",
        page: 6, section: "Methods", chunkType: "text",
      }),
    );
    const generacionId = await generacion(t, propietario, 10);
    const llamadas = gatewayFalso({
      ausencia: () => ({
        casos: [
          // Solo en español: la búsqueda no lo encuentra y el caso PASARÍA. Es lo que
          // el prompt evita pidiendo también el inglés y las siglas...
          { pregunta: "¿Qué concentración de neurogranina se midió en líquido cefalorraquídeo?", terminos: ["líquido cefalorraquídeo", "cerebrospinal fluid", "CSF"] },
          // ...y una entidad que de verdad no está pasa aunque venga en los dos idiomas.
          { pregunta: "¿Qué dosis de donanemab se usó?", terminos: ["donanemab", "donanemab (Kisunla)"] },
        ],
      }),
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const ausencias = (await casosDe(t, propietario)).filter((c) => c.categoria === "abstencion");
    expect(ausencias.map((c) => c.pregunta)).toEqual(["¿Qué dosis de donanemab se usó?"]);
    // El prompt pide los dos idiomas y las siglas, con un ejemplo.
    const prompt = llamadas.find((l) => l.sistema === PROMPT_AUSENCIA)!.sistema;
    expect(prompt).toMatch(/en español, en inglés/);
    expect(prompt).toMatch(/siglas/);
    expect(PROMPT_ENTIDAD).toMatch(/en español, en inglés/);
  });

  test("propone casos de un documento con el fichero y las páginas REALES del fragmento, y solo con claves que sobreviven al español", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    const llamadas = gatewayFalso({
      unDocumento: (usuario) => {
        // El modelo ve fragmentos numerados; la bibliografía nunca llega al lote.
        expect(usuario).not.toContain("Palmqvist");
        const n = numeroDe(usuario, "0.94");
        return {
          casos: [
            { n, pregunta: "¿Qué AUC tuvo p-tau217 en plasma para la positividad amiloide?", respuesta_esperada: "Un AUC de 0,94.", claves: ["0.94", "p-tau217", "0.99 inventado"] },
            { n: 99, pregunta: "fragmento que no existe", respuesta_esperada: "x", claves: ["0.94"] },
            { n, pregunta: "sin claves verificables", respuesta_esperada: "x", claves: ["lecanemab"] },
          ],
        };
      },
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const casos = await casosDe(t, propietario);
    const single = casos.filter((c) => c.categoria === "single_hop");
    expect(single).toHaveLength(1);
    expect(single[0].definicion).toMatchObject({
      question: "¿Qué AUC tuvo p-tau217 en plasma para la positividad amiloide?",
      mode: "normal",
      min_hops: 1,
      answer_must_contain: ["(?<!\\d)0[.,]94(?!\\d)", "p-tau217"],
      evidence: [{ id: "ev-1", sources: [{ file: "biomarcadores.pdf", pages: [3], section_patterns: ["Results"] }] }],
      expect_abstention: false,
    });
    expect(single[0].respuestaEsperada).toBe("Un AUC de 0,94.");
    // Con un solo documento no hay multi_hop: ni una llamada con ese prompt.
    expect(llamadas.some((l) => l.sistema === PROMPT_VARIOS_DOCUMENTOS)).toBe(false);
    // Y sí se pidieron preguntas de tabla (hay un fragmento de tabla).
    expect(llamadas.some((l) => l.sistema === PROMPT_TABLA && l.usuario.includes("| p-tau217 | 0.94 |"))).toBe(true);
    // El prompt avisa de que la respuesta se evalúa en español.
    expect(PROMPT_UN_DOCUMENTO).toMatch(/EN ESPAÑOL/);
    expect(PROMPT_TABLA).toMatch(/EN ESPAÑOL/);
    expect(PROMPT_VARIOS_DOCUMENTOS).toMatch(/EN ESPAÑOL/);
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    expect(g).toMatchObject({ estado: "ok", generados: 1 });
    expect(g!.descartados).toBeGreaterThanOrEqual(2);
  });

  test("ADVERSARIAL: el caso guardado puntúa bien una respuesta correcta en español aunque las claves vinieran del inglés", async () => {
    // El escenario del revisor: el fragmento dice "declined from 27.1 to 25.4
    // points over 24 months", el modelo propone claves literales y el
    // asistente contesta en español. Antes el caso fallaba en cada corrida.
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    gatewayFalso({
      unDocumento: (usuario) => {
        const n = numeroDe(usuario, "25.4");
        return {
          casos: [
            {
              n,
              pregunta: "¿Cuánto bajó la puntuación media del MMSE a los 24 meses en el grupo amiloide positivo?",
              respuesta_esperada: "Bajó de 27,1 a 25,4 puntos a los 24 meses.",
              claves: ["25.4 points", "24 months", "amyloid positive group"],
            },
            // Solo palabras que la traducción cambia: no queda nada comprobable y se descarta.
            { n, pregunta: "¿Qué grupo se mantuvo estable?", respuesta_esperada: "El grupo amiloide negativo.", claves: ["amyloid negative group", "remained stable"] },
          ],
        };
      },
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const single = (await casosDe(t, propietario)).filter((c) => c.categoria === "single_hop");
    expect(single).toHaveLength(1);
    const patrones = single[0].definicion.answer_must_contain as string[];
    expect(patrones).toHaveLength(2);
    const respuestaCorrecta = "La puntuación media del MMSE bajó de 27,1 a 25,4 puntos a los 24 meses en el grupo amiloide positivo [biomarcadores.pdf, pág. 5].";
    expect(patrones.every((p) => casa(p, respuestaCorrecta))).toBe(true);
    // Y NO casan con una respuesta que se equivoca de cifra.
    expect(patrones.every((p) => casa(p, "bajó de 27,1 a 26,4 puntos a los 12 meses"))).toBe(false);
    expect(patrones.some((p) => /points|months|amyloid/.test(p))).toBe(false);
  });

  test("la trampa de entidad se guarda solo si la otra entidad no está en el corpus", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    let vez = 0;
    gatewayFalso({
      entidad: () => {
        vez += 1;
        // Primera propuesta: la entidad "ausente" es el MMSE, que sí está. Se descarta.
        if (vez === 1) return { entidad_presente: "p-tau217", entidad_ausente: "MMSE", terminos: ["MMSE", "Mini-Mental"], pregunta: "¿Qué AUC tiene el MMSE?" };
        return { entidad_presente: "p-tau217", entidad_ausente: "p-tau181", terminos: ["p-tau181", "tau fosforilada 181", "phosphorylated tau 181"], pregunta: "¿Qué AUC tiene p-tau181 en plasma?" };
      },
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const entidad = (await casosDe(t, propietario)).filter((c) => c.categoria === "entidad");
    expect(entidad).toHaveLength(1);
    expect(entidad[0].pregunta).toContain("p-tau181");
    expect(entidad[0].respuestaEsperada).toContain("p-tau181");
    expect(entidad[0].respuestaEsperada).toContain("p-tau217");
    expect(entidad[0].definicion).toMatchObject({ expect_abstention: true, category: "entidad", evidence: [] });
  });

  test("las claves no chocan con las que la cuenta ya tenía, y cada cuenta empieza por la suya", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    await t.run((ctx) =>
      ctx.db.insert("evaluacionCasos", {
        propietario, clave: "abstencion-001", pregunta: "previa", modo: "normal", categoria: "abstencion", critico: true,
        respuestaEsperada: "x", definicion: {}, estado: "aprobado", origen: "manual", creadoEn: 1,
      }),
    );
    const generacionId = await generacion(t, propietario, 10);
    gatewayFalso({ ausencia: () => ({ casos: [{ pregunta: "¿Dosis de donanemab?", terminos: ["donanemab"] }] }) });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const claves = (await casosDe(t, propietario)).filter((c) => c.categoria === "abstencion").map((c) => c.clave).sort();
    expect(claves).toEqual(["abstencion-001", "abstencion-002"]);
  });

  test("sin documentos listos, o sin clave del gateway, termina en error con una frase para la usuaria", async () => {
    const t = convexTest(schema, modules);
    const sinDocs = await t.run((ctx) => ctx.db.insert("users", { email: "b@alzheimerproject.com", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 }));
    const g1 = await generacion(t, sinDocs, 5);
    const espia = gatewayFalso({});
    await generarTodo(t, { propietario: sinDocs, generacionId: g1, objetivo: 5 });
    expect(await t.run((ctx) => ctx.db.get(g1))).toMatchObject({ estado: "error", error: "No hay documentos listos sobre los que proponer preguntas.", generados: 0 });
    expect(espia).toHaveLength(0);

    vi.stubEnv("OPENAI_API_KEY", "");
    const { propietario } = await corpus(t);
    const g2 = await generacion(t, propietario, 5);
    await generarTodo(t, { propietario, generacionId: g2, objetivo: 5 });
    const g = await t.run((ctx) => ctx.db.get(g2));
    expect(g?.estado).toBe("error");
    expect(g?.error).toBe("El asistente no está configurado para proponer preguntas. Avisa a quien administra la aplicación.");
    expect(g?.error).not.toMatch(/OPENAI|API_KEY|token/i);
    expect(espia).toHaveLength(0);
  });

  test("ADVERSARIAL: si el modelo falla en todas las llamadas, la generación acaba en error tras pocos fallos seguidos, no en un 'ok' con cero preguntas ni girando hasta agotar el plan", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 6);
    const espia = vi.spyOn(gateway, "completionJson").mockRejectedValue(new Error("gateway caído"));
    await generarTodo(t, { propietario, generacionId, objetivo: 6 });
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    expect(g).toMatchObject({ estado: "error", generados: 0 });
    expect(g!.descartados).toBeGreaterThan(0);
    expect(g?.error).not.toContain("gateway caído");
    expect(g?.error).toBe("No se pudieron proponer preguntas por un fallo del asistente. Vuelve a intentarlo en unos minutos.");
    // El cortacircuito: tres fallos seguidos y se para, aunque el plan tuviera más tareas.
    expect(espia).toHaveBeenCalledTimes(MAX_FALLOS_SEGUIDOS);
    expect(await casosDe(t, propietario)).toEqual([]);
  });

  test("ADVERSARIAL: una llamada que no vuelve se corta con el presupuesto, cuenta como fallo y la cadena no se queda colgada", async () => {
    // Contra un gateway caído, `peticion` reintenta cinco veces con 120 s de
    // espera: 680 s, más que los 600 s de la acción. Sin el tope, la acción
    // moría sin pasar por `cerrar` y la barra se quedaba congelada.
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 6);
    configurarPresupuesto({ llamadaMs: 20 });
    const espia = vi.spyOn(gateway, "completionJson").mockImplementation(() => new Promise(() => {}));
    const inicio = Date.now();
    await generarTodo(t, { propietario, generacionId, objetivo: 6 });
    expect(Date.now() - inicio).toBeLessThan(5_000);
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    expect(g).toMatchObject({ estado: "error", generados: 0 });
    expect(g!.paso).toBeUndefined();
    expect(espia).toHaveBeenCalledTimes(MAX_FALLOS_SEGUIDOS);
    expect(await casosDe(t, propietario)).toEqual([]);
  });

  test("si el modelo deja de responder a mitad, lo ya propuesto se conserva y el mensaje lo dice", async () => {
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    let vez = 0;
    vi.spyOn(gateway, "completionJson").mockImplementation(async (kwargs) => {
      vez += 1;
      const sistema = (kwargs.messages as Array<{ content: string }>)[0].content;
      if (vez === 1 && sistema === PROMPT_UN_DOCUMENTO) {
        const usuario = (kwargs.messages as Array<{ content: string }>)[1].content;
        return {
          datos: { casos: [{ n: numeroDe(usuario, "0.94"), pregunta: "¿Qué AUC tuvo p-tau217?", respuesta_esperada: "0,94.", claves: ["0.94"] }] },
          usage: { prompt: 1, cached: 0, completion: 1, reasoning: 0 }, modelo: "m", finishReason: "stop", razonamientoRechazado: false,
        };
      }
      throw new Error("gateway caído");
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    expect(g).toMatchObject({ estado: "error", generados: 1, error: "El asistente dejó de responder a mitad. Las preguntas ya propuestas se han guardado." });
    expect((await casosDe(t, propietario)).map((c) => c.clave)).toEqual(["single_hop-001"]);
  });

  test("ADVERSARIAL: cada paso es UNA llamada al modelo y deja latido: los contadores suben entre una llamada y la siguiente", async () => {
    // Es la propiedad de la que depende `datos.generacionColgada`: sin fecha de
    // última escritura, una generación viva se reconoce porque
    // `generados + descartados` crece en cada paso. Si un paso pudiera no
    // sumar nada, una generación sana parecería muerta.
    const t = convexTest(schema, modules);
    const { propietario } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    const latidos: number[] = [];
    const pasosVistos: string[] = [];
    vi.spyOn(gateway, "completionJson").mockImplementation(async () => {
      const g = (await t.run((ctx) => ctx.db.get(generacionId)))!;
      latidos.push(g.generados + g.descartados);
      pasosVistos.push(g.paso ?? "");
      expect(generacionColgada(g, Date.now())).toBe(false);
      // El modelo no propone nada nunca: el peor caso para el latido.
      return { datos: { casos: [], pregunta: null }, usage: { prompt: 1, cached: 0, completion: 1, reasoning: 0 }, modelo: "m", finishReason: "stop", razonamientoRechazado: false };
    });
    await generarTodo(t, { propietario, generacionId, objetivo: 10 });
    // 7 tareas para este corpus (1 lote de texto, 1 de tabla, 3 intentos de
    // ausencia, 2 trampas), una llamada cada una, y ninguna sin latido.
    expect(latidos).toHaveLength(7);
    for (let i = 1; i < latidos.length; i++) expect(latidos[i]).toBeGreaterThan(latidos[i - 1]);
    // Una acción por tarea más la que cierra: el primer eslabón (`generar`) no
    // llama al modelo y cada `paso` se agenda aparte.
    const agendadas = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(agendadas.filter((f) => f.name === "evaluacion/generar:paso")).toHaveLength(8);
    expect(agendadas.every((f) => f.state.kind === "success")).toBe(true);
    // El avance en llano acompaña a cada paso.
    expect(pasosVistos[0]).toBe("Proponiendo preguntas sobre un documento (0 de 7)");
    expect(pasosVistos.some((p) => p.startsWith("Proponiendo preguntas cuya respuesta no está en tus documentos"))).toBe(true);
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    // Sin fallos del modelo, "ok" con cero propuestas y todos los candidatos gastados.
    expect(g).toMatchObject({ estado: "ok", generados: 0 });
    expect(g!.descartados).toBe(latidos[latidos.length - 1] + 1);
  });

  test("ADVERSARIAL: un paso rezagado sobre una generación ya cerrada no llama al modelo ni guarda nada", async () => {
    const t = convexTest(schema, modules);
    const { propietario, documentId } = await corpus(t);
    const chunkId = (await t.run((ctx) => ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).first()))!._id;
    const generacionId = await t.run((ctx) =>
      ctx.db.insert("evaluacionGeneraciones", { propietario, empezadoEn: 1, terminadoEn: 2, estado: "error", error: "La propuesta anterior no terminó.", objetivo: 5, generados: 1, descartados: 0 }),
    );
    const espia = gatewayFalso({ unDocumento: () => ({ casos: [{ n: 1, pregunta: "x", respuesta_esperada: "0,94", claves: ["0.94"] }] }) });
    await t.action(internal.evaluacion.generar.paso, {
      propietario, generacionId,
      cuotas: { single_hop: 5, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 },
      hechos: { single_hop: 0, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 },
      claves: { single_hop: "single_hop-001", multi_hop: "multi_hop-001", tabla: "tabla-001", abstencion: "abstencion-001", entidad: "entidad-001" },
      tareas: [{ categoria: "single_hop", fragmentos: [{ chunkId, documento: "biomarcadores.pdf" }] }],
      indice: 0, fallosSeguidos: 0, huboFallo: false,
    });
    await t.finishAllScheduledFunctions(() => {}, 50);
    expect(espia).toHaveLength(0);
    expect(await casosDe(t, propietario)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(generacionId))).toMatchObject({ estado: "error", generados: 1, descartados: 0 });
  });

  test("ADVERSARIAL: un fragmento borrado entre el plan y su paso (documento reindexado) se descarta y la cadena sigue", async () => {
    const t = convexTest(schema, modules);
    const { propietario, documentId } = await corpus(t);
    const generacionId = await generacion(t, propietario, 10);
    const chunks = await t.run((ctx) => ctx.db.query("chunks").withIndex("porDocumento", (q) => q.eq("documentRef", documentId)).collect());
    const auc = chunks.find((c) => c.text === TEXTO_AUC)!._id;
    const mmse = chunks.find((c) => c.text === TEXTO_MMSE)!._id;
    // El plan se armó con los dos fragmentos; antes del paso, el documento se
    // reindexa y el del MMSE desaparece.
    await t.run((ctx) => ctx.db.delete(mmse));
    const espia = gatewayFalso({
      unDocumento: (usuario) => {
        expect(usuario).not.toContain("MMSE");
        return { casos: [{ n: numeroDe(usuario, "0.94"), pregunta: "¿Qué AUC tuvo p-tau217?", respuesta_esperada: "Un AUC de 0,94.", claves: ["0.94"] }] };
      },
    });
    const ceros = { single_hop: 0, multi_hop: 0, tabla: 0, abstencion: 0, entidad: 0 };
    await t.action(internal.evaluacion.generar.paso, {
      propietario, generacionId,
      cuotas: { ...ceros, single_hop: 2, entidad: 1 },
      hechos: ceros,
      claves: { single_hop: "single_hop-001", multi_hop: "multi_hop-001", tabla: "tabla-001", abstencion: "abstencion-001", entidad: "entidad-001" },
      tareas: [
        { categoria: "single_hop", fragmentos: [{ chunkId: auc, documento: "biomarcadores.pdf" }, { chunkId: mmse, documento: "biomarcadores.pdf" }] },
        // La trampa sobre el fragmento borrado no tiene sobre qué preguntar: se descarta sin llamada.
        { categoria: "entidad", fragmentos: [{ chunkId: mmse, documento: "biomarcadores.pdf" }] },
      ],
      indice: 0, fallosSeguidos: 0, huboFallo: false,
    });
    await t.finishAllScheduledFunctions(() => {}, 50);
    expect(espia.map((l) => l.sistema)).toEqual([PROMPT_UN_DOCUMENTO]);
    const g = await t.run((ctx) => ctx.db.get(generacionId));
    // El del AUC dio su pregunta; el borrado cuenta como descartado en el lote y otra vez en la trampa.
    expect(g).toMatchObject({ estado: "ok", generados: 1, descartados: 2 });
    expect((await casosDe(t, propietario)).map((c) => c.clave)).toEqual(["single_hop-001"]);
  });

  test("ADVERSARIAL: el muestreo no lee fragmentos de otra cuenta aunque compartan documento por error", async () => {
    const t = convexTest(schema, modules);
    const { propietario, documentId } = await corpus(t);
    const otra = await t.run((ctx) => ctx.db.insert("users", { email: "otra@alzheimerproject.com", rol: "lector", bloqueado: false, creadoEn: 1, ultimoAccesoEn: 1 }));
    // Un fragmento colgado del MISMO documento pero de otra propietaria (un
    // borrado a medias, un fallo de escritura): no debe llegar al modelo.
    const ajeno = await t.run((ctx) =>
      ctx.db.insert("chunks", {
        embedding: VECTOR, sourceFile: "biomarcadores.pdf", documentRef: documentId, documentId: String(documentId),
        propietario: otra, text: "SECRETO de otra cuenta ".repeat(20), page: 9, chunkType: "text",
      }),
    );
    const lote = await t.query(internal.evaluacion.generar.fragmentosDe, { propietario, documentId, n: 40 });
    expect(lote.fragmentos.some((f) => f.text.includes("SECRETO"))).toBe(false);
    // Y la bibliografía tampoco pasa el filtro.
    expect(lote.fragmentos.some((f) => f.section === "References")).toBe(false);
    expect(lote.fragmentos.map((f) => f.page).sort()).toEqual([3, 4, 5]);
    expect(lote.fragmentos.every((f) => !("embedding" in f))).toBe(true);
    // La relectura por id de un paso tampoco: el ajeno vuelve como null, y el propio sin vector.
    const propio = lote.fragmentos[0]._id as Id<"chunks">;
    const releidos = await t.query(internal.evaluacion.generar.leerFragmentos, { propietario, ids: [ajeno, propio] });
    expect(releidos[0]).toBeNull();
    expect(releidos[1]).toMatchObject({ _id: propio });
    expect(releidos[1] && "embedding" in releidos[1]).toBe(false);
  });
});
