// Pipeline de evidencia. Lo que se prueba es la promesa del módulo: la
// evidencia es una función DETERMINISTA de (plan, índice). Cada test intenta
// romper una de las suposiciones que introduce: que la fusión no depende de qué
// búsqueda respondió antes, que la cuota por documento no expulsa a los
// mejores, que las tablas no se recortan, que dos fragmentos contiguos no se
// funden, que un calificador caído (o mudo) degrada sin mentir y que un punto
// que no llega no tumba a los demás. Sin red: la búsqueda híbrida y el
// calificador van parcheados sobre sus módulos.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import * as hybrid from "../search/hybrid";
import type { ModoRecuperacion } from "../search/hybrid";
import * as calificador from "./calificador";
import type { Fragmento } from "../lib/citas";
import { ajustes } from "../lib/config";
import { NORMAL, type Modo } from "../lib/modos";
import { Telemetria } from "../lib/telemetry";
import * as evidencia from "./evidencia";
import type { PuntoPlan } from "./planner";

const ctx = {} as unknown as ActionCtx;
const filtros = {};

function modo(fragmentos: number, candidatosPorPunto = 30): Modo {
  return { ...NORMAL, fragmentos, candidatosPorPunto };
}

function frag(id: string, extra: Partial<Fragmento> = {}): Fragmento {
  return {
    _id: id,
    text: `texto de ${id}`,
    sourceFile: "a.pdf",
    page: 1,
    documentType: "pdf",
    chunkType: "text",
    ...extra,
  };
}

function item(id: string, query: string, evidenceNeeded: string, queryEn = ""): PuntoPlan {
  return { id, query, queryEn, evidenceNeeded };
}

type Resultado = { fragmentos: Fragmento[]; recuperacion: ModoRecuperacion };
type Valor = Fragmento[] | Error | (() => Promise<Fragmento[]>) | Resultado;

/** Búsqueda falsa: consulta -> lista de chunks, Error (esa consulta viene en
 *  "error"), función (para retrasar) o resultado completo. Registra las
 *  consultas de cada llamada. */
let busqueda: {
  porConsulta: Record<string, Valor>;
  porDefecto: Fragmento[];
  llamadas: string[][];
  recuperacion: ModoRecuperacion;
  lanzar: Error | null;
  topK: number[];
  filtros: unknown[];
};
/** Calificador determinista: el grado sale de `grados` por id (default
 *  "directa"). Registra qué candidatos vio. */
let grader: {
  grados: Record<string, string>;
  vistos: string[][];
  fallo: Error | null;
  verificado: boolean;
};

beforeEach(() => {
  busqueda = {
    porConsulta: {},
    porDefecto: [],
    llamadas: [],
    recuperacion: "hibrida",
    lanzar: null,
    topK: [],
    filtros: [],
  };
  vi.spyOn(hybrid, "buscarHibridoVarias").mockImplementation(
    async (_ctx, consultas, f, topK) => {
      busqueda.llamadas.push([...consultas]);
      busqueda.topK.push(topK);
      busqueda.filtros.push(f);
      if (busqueda.lanzar) throw busqueda.lanzar;
      return Promise.all(
        consultas.map(async (q): Promise<Resultado> => {
          const valor = busqueda.porConsulta[q] ?? busqueda.porDefecto;
          if (valor instanceof Error) return { fragmentos: [], recuperacion: "error" };
          if (typeof valor === "function") {
            return { fragmentos: await valor(), recuperacion: busqueda.recuperacion };
          }
          if (!Array.isArray(valor)) return valor;
          return { fragmentos: [...valor], recuperacion: busqueda.recuperacion };
        }),
      );
    },
  );
  grader = { grados: {}, vistos: [], fallo: null, verificado: true };
  vi.spyOn(calificador, "calificarEvidencia").mockImplementation(async (_q, _e, chunks) => {
    grader.vistos.push(chunks.map((c) => c._id));
    if (grader.fallo) throw grader.fallo;
    const grados = Object.fromEntries(
      chunks.map((c, i) => [i, (grader.grados[c._id] ?? "directa") as calificador.Grado]),
    );
    return { grados, verificado: grader.verificado, motivo: "falso" };
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function punto(it: PuntoPlan, m: Modo, limiteMs = 5000): Promise<evidencia.PuntoEvidencia> {
  const ev = await evidencia.ejecutarPlan(ctx, [it], m, filtros, new Telemetria(), limiteMs);
  return ev.puntos[0];
}

const ids = (chunks: Fragmento[]) => chunks.map((c) => c._id);

// ---------------------------------------------------------------------------
// determinismo de punta a punta
// ---------------------------------------------------------------------------
describe("determinismo", () => {
  test("misma entrada, mismos ids y misma huella, de punta a punta", async () => {
    // La búsqueda falsa devuelve lo mismo en cada llamada, que es lo que hace un
    // índice que no cambió; lo que aquí se prueba es que NADA del camino
    // (fusión en paralelo, poda, cuota, calificación, orden final) añade azar.
    busqueda.porDefecto = [
      frag("c1", { page: 3, text: "p-tau217 AUC 0.94 en la cohorte clínica", section: "Results" }),
      frag("c2", { sourceFile: "b.pdf", page: 5, text: "AUC de 0.91 en la cohorte de validación", section: "Results" }),
      frag("c3", { page: 7, text: "otro hallazgo del mismo estudio", section: "Discussion" }),
      frag("c4", { sourceFile: "c.pdf", page: 2, text: "la referencia 12 habla de p-tau217", section: "References" }),
    ];
    const plan = [
      item("e0", "AUC de p-tau217", "el AUC"),
      item("e1", "cohorte de validación", "la cohorte", "validation cohort"),
    ];

    const a = await evidencia.ejecutarPlan(ctx, plan, modo(8), filtros, new Telemetria(), 5000);
    const b = await evidencia.ejecutarPlan(ctx, plan, modo(8), filtros, new Telemetria(), 5000);

    expect(a.puntos.map((p) => ids(p.fragmentos))).toEqual(b.puntos.map((p) => ids(p.fragmentos)));
    expect(a.puntos.map((p) => ids(p.fragmentos))).toEqual([["c1", "c2", "c3"], ["c1", "c2", "c3"]]);
    expect(a.huella).toBe(b.huella);
    expect(a.huella).toHaveLength(64);
    // e0 lanzó UNA consulta y e1 DOS (query y queryEn), cada punto en UNA
    // llamada: dos llamadas por plan, cuatro en total.
    expect(busqueda.llamadas).toEqual([
      ["AUC de p-tau217"],
      ["cohorte de validación", "validation cohort"],
      ["AUC de p-tau217"],
      ["cohorte de validación", "validation cohort"],
    ]);
    expect(busqueda.topK.every((k) => k === ajustes().searchTopK)).toBe(true);
    expect(busqueda.filtros.every((f) => f === filtros)).toBe(true);
    // La bibliografía no llegó ni al calificador.
    expect(grader.vistos.every((v) => !v.includes("c4"))).toBe(true);
    // Trazabilidad: cada fragmento sabe qué puntos lo trajeron.
    expect(a.mapa["c1"]).toEqual(["e0", "e1"]);
    expect(a.grados["c1"]).toBe("directa");
    expect([...a.acumulado.keys()]).toEqual(["c1", "c2", "c3"]);
    // Y la huella SÍ cambia cuando cambia la evidencia: no es una constante.
    busqueda.porDefecto = busqueda.porDefecto.slice(0, 1);
    const c = await evidencia.ejecutarPlan(ctx, plan, modo(8), filtros, new Telemetria(), 5000);
    expect(c.huella).not.toBe(a.huella);
  });

  test("un plan vacío devuelve una evidencia vacía sin buscar", async () => {
    const ev = await evidencia.ejecutarPlan(ctx, [], modo(4), filtros, new Telemetria(), 5000);
    expect(ev.puntos).toEqual([]);
    expect(ev.acumulado.size).toBe(0);
    expect(ev.huella).toBe(evidencia.huellaDe([]));
    expect(busqueda.llamadas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fusión RRF y las dos consultas
// ---------------------------------------------------------------------------
describe("fusión", () => {
  test("RRF premia coincidir en las dos listas y desempata con orden total", () => {
    const x = frag("x", { sourceFile: "b.pdf", page: 9 });
    const y = frag("y", { sourceFile: "a.pdf", page: 2 });
    const z = frag("z", { sourceFile: "a.pdf", page: 1 });
    // x es 2º en las dos listas (2/62) y gana a cualquier primer puesto suelto
    // (1/61). y y z son 1º en una lista cada uno: empate exacto, y el
    // desempate es por (sourceFile, page, _id), no por el orden de llegada.
    expect(ids(evidencia.fusionarRrf([[y, x], [z, x]]))).toEqual(["x", "z", "y"]);
    // Cambiar el orden de las listas (la otra búsqueda respondió antes) no
    // cambia nada.
    expect(ids(evidencia.fusionarRrf([[z, x], [y, x]]))).toEqual(["x", "z", "y"]);
    // Y sin empate manda la suma RRF, no el documento: y (1º) antes que z (2º).
    expect(ids(evidencia.fusionarRrf([[y, z]]))).toEqual(["y", "z"]);
  });

  test("la queryEn lanza una segunda consulta solo si difiere, y va en la misma llamada", async () => {
    await punto(item("e1", "tau en plasma", "dato", "plasma tau"), modo(4));
    expect(busqueda.llamadas).toEqual([["tau en plasma", "plasma tau"]]);

    busqueda.llamadas.length = 0;
    await punto(item("e1", "Plasma tau", "dato", "plasma  tau"), modo(4));
    expect(busqueda.llamadas).toEqual([["Plasma tau"]]);

    // e0 sin preguntaEn (modo normal): UNA búsqueda. Con ella: DOS.
    busqueda.llamadas.length = 0;
    await punto(item("e0", "pregunta literal", "dato"), modo(4));
    expect(busqueda.llamadas).toEqual([["pregunta literal"]]);
    busqueda.llamadas.length = 0;
    await punto(item("e0", "pregunta literal", "dato", "literal question"), modo(4));
    expect(busqueda.llamadas).toEqual([["pregunta literal", "literal question"]]);
  });

  test("si solo falla la búsqueda en inglés se sigue con la otra", async () => {
    busqueda.porConsulta = { tau: [frag("t1")], "tau en": new Error("una de las dos") };
    const p = await punto(item("e1", "tau", "d", "tau en"), modo(4));
    expect(p.estado).toBe("cubierto");
    expect(ids(p.fragmentos)).toEqual(["t1"]);
    expect(p.recuperacion).toBe("hibrida");
  });

  test("la recuperación del punto es la más degradada de las que respondieron", async () => {
    busqueda.porConsulta = {
      q: { fragmentos: [frag("a")], recuperacion: "hibrida" },
      "q en": { fragmentos: [frag("b")], recuperacion: "densa" },
    };
    const p = await punto(item("e1", "q", "d", "q en"), modo(4));
    expect(p.recuperacion).toBe("densa");
    expect(ids(p.fragmentos)).toEqual(["a", "b"]);
    busqueda.recuperacion = "lexica";
    expect((await punto(item("e1", "solo", "d"), modo(4))).recuperacion).toBe("lexica");
  });
});

// ---------------------------------------------------------------------------
// poda, dedup
// ---------------------------------------------------------------------------
describe("poda y dedup", () => {
  test("poda bibliografía y afines pero no secciones desconocidas", async () => {
    busqueda.porDefecto = [
      frag("r1", { section: "Results" }),
      frag("bib", { section: "Referencias bibliográficas" }),
      frag("ack", { section: "Acknowledgements" }),
      frag("fun", { section: "Funding" }),
      frag("coi", { section: "Conflicts of interest" }),
      frag("dec", { section: "Declaration of interests" }),
      frag("raro", { section: "Anexo Z" }),
      frag("sin", { section: "" }),
      frag("nada"),
    ];
    const p = await punto(item("e1", "q", "dato"), modo(10));
    expect(grader.vistos).toEqual([["r1", "raro", "sin", "nada"]]);
    expect(ids(p.fragmentos)).toEqual(["r1", "raro", "sin", "nada"]);
  });

  test("no se funden fragmentos contiguos que comparten un párrafo", async () => {
    // Dos fragmentos contiguos comparten el solape (unos 60 de 400 tokens) y
    // son dos evidencias distintas. Solo el texto IDÉNTICO es un duplicado.
    const solape = "La cohorte incluyó 312 participantes con deterioro cognitivo leve. ";
    const a = frag("a", { text: "Métodos. " + solape + "Se midió p-tau217 en plasma." });
    const b = frag("b", { text: solape + "El AUC fue 0.94 frente a 0.81 del p-tau181." });
    const identico = frag("b-bis", { text: b.text.toUpperCase() }); // mismo texto, otra forma
    const conAcentos = frag("b-tris", { text: b.text.replace("AUC", "ÁÚC") }); // solo acentos
    const mismoId = frag("a", { text: "otro texto con el mismo id" });
    busqueda.porDefecto = [a, b, identico, conAcentos, mismoId];

    const p = await punto(item("e1", "q", "dato"), modo(10));
    expect(ids(p.fragmentos)).toEqual(["a", "b"]);
  });

  test("peso de sección desconocida es neutro y la poda solo casa sus claves", () => {
    expect(evidencia.pesoSeccion("Results")).toBe(3.0);
    expect(evidencia.pesoSeccion("Resultados y discusión")).toBe(3.0);
    expect(evidencia.pesoSeccion("Métodos")).toBe(2.0);
    expect(evidencia.pesoSeccion("Abstract")).toBe(2.0);
    expect(evidencia.pesoSeccion("Conclusiones")).toBe(1.5);
    expect(evidencia.pesoSeccion("Introduction")).toBe(1.0);
    expect(evidencia.pesoSeccion("")).toBe(1.0);
    expect(evidencia.pesoSeccion(undefined)).toBe(1.0);
    expect(evidencia.pesoSeccion("Cualquier cosa")).toBe(1.0);
    expect(evidencia.seccionPodada("Cualquier cosa")).toBe(false);
    expect(evidencia.seccionPodada("BIBLIOGRAFÍA")).toBe(true);
    expect(evidencia.seccionPodada(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cuota por documento y tablas
// ---------------------------------------------------------------------------
describe("cuota", () => {
  test("la cuota mete al segundo documento sin expulsar a los mejores", async () => {
    // El fallo medido: un paper largo ocupaba los 12 huecos. La cuota mete al
    // segundo documento, pero desplaza a los ÚLTIMOS del primero, no a sus
    // mejores fragmentos.
    const a = Array.from({ length: 10 }, (_, i) => frag(`a${i + 1}`, { page: i + 1 }));
    const b = Array.from({ length: 2 }, (_, i) => frag(`b${i + 1}`, { sourceFile: "b.pdf", page: i + 1 }));
    busqueda.porDefecto = [...a, ...b];

    const p = await punto(item("e1", "q", "dato"), modo(4));
    expect(ids(p.fragmentos)).toEqual(["a1", "a2", "b1", "b2"]);
    expect(p.estado).toBe("cubierto");
  });

  test("la cuota es un suelo, no un tope", async () => {
    // Con un segundo documento sin nada relevante la cuota no toca el ranking:
    // el primer documento se queda sus huecos.
    const a = Array.from({ length: 7 }, (_, i) => frag(`a${i + 1}`, { page: i + 1 }));
    busqueda.porDefecto = [...a, frag("b1", { sourceFile: "b.pdf" })];
    grader.grados = { b1: "no" };

    const p = await punto(item("e1", "q", "dato"), modo(4));
    expect(ids(p.fragmentos)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("las tablas nunca se recortan por documento", () => {
    // Una fila con la cifra es justo lo que se busca y suele quedar abajo del
    // ranking porque tiene poco texto: la cuota desplaza texto, no tablas.
    const ordenados = [
      frag("a1", { page: 1 }),
      frag("a2", { page: 2 }),
      frag("t1", { page: 3, chunkType: "table" }),
      frag("a4", { page: 4 }),
      frag("b1", { sourceFile: "b.pdf", page: 1 }),
      frag("b2", { sourceFile: "b.pdf", page: 2 }),
    ];
    expect(ids(evidencia.seleccionarConCuota(ordenados, 4, 2))).toEqual(["a1", "t1", "b1", "b2"]);
    // Y el tope se respeta aunque solo queden tablas por desplazar: la cuota
    // cede antes que recortar una tabla o pasarse de fragmentos.
    const soloTablas = [
      frag("t1", { page: 1, chunkType: "table" }),
      frag("t2", { page: 2, chunkType: "table" }),
      frag("t3", { page: 3, chunkType: "table" }),
      frag("b1", { sourceFile: "b.pdf", page: 1 }),
    ];
    expect(ids(evidencia.seleccionarConCuota(soloTablas, 3, 2))).toEqual(["t1", "t2", "t3"]);
    // Casos borde: tope 0, y menos candidatos que tope (se devuelven todos).
    expect(evidencia.seleccionarConCuota(ordenados, 0, 2)).toEqual([]);
    expect(ids(evidencia.seleccionarConCuota(ordenados.slice(0, 3), 4, 2))).toEqual(["a1", "a2", "t1"]);
  });

  test("la preselección de candidatos también reparte por documento", async () => {
    // Antes del calificador ya se garantiza que un segundo documento llegue a
    // ser leído: si no, el calificador nunca lo ve y la cuota final no tiene
    // con qué trabajar.
    const a = Array.from({ length: 20 }, (_, i) => frag(`a${i + 1}`, { page: i + 1 }));
    const b = Array.from({ length: 3 }, (_, i) => frag(`b${i + 1}`, { sourceFile: "b.pdf", page: i + 1 }));
    busqueda.porDefecto = [...a, ...b];

    await punto(item("e1", "q", "dato"), modo(4, 6));
    expect(grader.vistos[0]).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
  });
});

// ---------------------------------------------------------------------------
// orden final: grado > sección > RRF > id
// ---------------------------------------------------------------------------
describe("orden final", () => {
  test("grado, luego sección, luego RRF", async () => {
    busqueda.porDefecto = [
      frag("disc-parcial", { section: "Discussion" }),
      frag("intro-directa", { section: "Introduction" }),
      frag("res-directa", { section: "Results" }),
      frag("no", { section: "Results" }),
      frag("rara-directa", { section: "Sección desconocida" }),
      frag("disc-directa", { section: "Discusión" }),
    ];
    grader.grados = { "disc-parcial": "parcial", no: "no" };

    const p = await punto(item("e1", "q", "dato"), modo(10));
    expect(ids(p.fragmentos)).toEqual([
      "res-directa", // directa, Resultados (3)
      "disc-directa", // directa, Discusión (1.5)
      "intro-directa", // directa, neutro (1), RRF 2º
      "rara-directa", // directa, neutro (1), RRF 5º
      "disc-parcial", // parcial va detrás de toda directa
    ]);
    expect(p.grados).toEqual({
      "res-directa": "directa",
      "disc-directa": "directa",
      "intro-directa": "directa",
      "rara-directa": "directa",
      "disc-parcial": "parcial",
    });
    expect(p.relevanciaVerificada).toBe(true);
    expect(p.nCandidatos).toBe(6);
  });

  test("un grado ausente con verificado=true no descarta el fragmento", async () => {
    // El calificador real puede omitir un índice y aun así decir
    // verificado=true. Tratarlo como "no" perdía evidencia en silencio; se
    // ordena como parcial y se entrega SIN grado, para que nadie lo lea como
    // juzgado.
    busqueda.porDefecto = [frag("omitido", { section: "Results" }), frag("directo"), frag("no")];
    vi.mocked(calificador.calificarEvidencia).mockResolvedValue({
      grados: { 1: "directa", 2: "no" },
      verificado: true,
      motivo: "el modelo omitió el 0",
    });

    const p = await punto(item("e1", "q", "dato"), modo(4));
    expect(ids(p.fragmentos)).toEqual(["directo", "omitido"]);
    expect(p.grados).toEqual({ directo: "directa" }); // el omitido va sin grado
    expect(p.relevanciaVerificada).toBe(true);
    const texto = evidencia.textoDePunto(p);
    expect(texto.split("(evidencia directa para este punto)").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// calificador caído o mudo, punto vacío, búsqueda caída, timeout
// ---------------------------------------------------------------------------
describe("degradaciones", () => {
  test("calificador caído entrega orden RRF sin marcar relevancia", async () => {
    busqueda.porDefecto = [frag("c1", { section: "Discussion" }), frag("c2", { section: "Results" }), frag("c3")];
    grader.fallo = new Error("api caída");

    const p = await punto(item("e1", "q", "dato"), modo(2));
    // Orden RRF, no por sección: sin grados no hay orden "final" que aplicar.
    expect(ids(p.fragmentos)).toEqual(["c1", "c2"]);
    expect(p.relevanciaVerificada).toBe(false);
    expect(p.grados).toEqual({});
    expect(p.estado).toBe("cubierto");
    expect(evidencia.textoDePunto(p)).toContain(evidencia.AVISO_SIN_VERIFICAR);

    // verificado=false sin excepción es el mismo caso.
    grader.fallo = null;
    grader.verificado = false;
    const p2 = await punto(item("e1", "q", "dato"), modo(2));
    expect(p2.relevanciaVerificada).toBe(false);
    expect(ids(p2.fragmentos)).toEqual(["c1", "c2"]);
  });

  test("TRAMPA: calificador con verificado=true y cero grados degrada igual que caído", async () => {
    busqueda.porDefecto = [frag("c1", { section: "Discussion" }), frag("c2", { section: "Results" }), frag("c3")];
    vi.mocked(calificador.calificarEvidencia).mockResolvedValue({
      grados: {},
      verificado: true,
      motivo: "mudo",
    });

    const p = await punto(item("e1", "q", "dato"), modo(2));
    expect(ids(p.fragmentos)).toEqual(["c1", "c2"]); // orden RRF, no "todo parcial" reordenado
    expect(p.relevanciaVerificada).toBe(false);
    expect(p.grados).toEqual({});
    expect(evidencia.textoDePunto(p)).toContain(evidencia.AVISO_SIN_VERIFICAR);
  });

  test("punto sin candidatos relevantes dice qué documentos revisó, únicos y como máximo 5", async () => {
    busqueda.porDefecto = Array.from({ length: 7 }, (_, i) => frag(`c${i}`, { sourceFile: `doc${i}.pdf` }));
    grader.grados = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`c${i}`, "no"]));

    const p = await punto(item("e1", "q", "el AUC en la cohorte"), modo(4));
    expect(p.estado).toBe("sin_resultados");
    expect(p.fragmentos).toEqual([]);
    expect(p.documentosRevisados).toEqual(["doc0.pdf", "doc1.pdf", "doc2.pdf", "doc3.pdf", "doc4.pdf"]);
    expect(p.nCandidatos).toBe(7);
    expect(p.relevanciaVerificada).toBe(true);
    const texto = evidencia.textoDePunto(p);
    expect(texto.startsWith("PUNTO e1 (el AUC en la cohorte): sin resultados")).toBe(true);
    expect(texto).toContain("se revisaron 7 fragmentos de doc0.pdf; doc1.pdf");
    expect(texto).toContain("ninguno aporta evidencia");
    // Describe, no ordena: nada de "di que no lo encuentras".
    expect(texto.toLowerCase()).not.toMatch(/\bdi que\b/);
    expect(texto).not.toContain("no se pudo comprobar");

    // Documentos ÚNICOS: siete fragmentos de tres documentos son tres nombres.
    busqueda.porDefecto = Array.from({ length: 7 }, (_, i) => frag(`d${i}`, { sourceFile: `doc${i % 3}.pdf` }));
    grader.grados = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`d${i}`, "no"]));
    const q = await punto(item("e1", "q", "d"), modo(4));
    expect(q.documentosRevisados).toEqual(["doc0.pdf", "doc1.pdf", "doc2.pdf"]);
  });

  test("con la cita corta, los documentos revisados se nombran por ella", async () => {
    busqueda.porDefecto = [
      frag("c0", { citation: "Allegri et al., 2023" }),
      frag("c1", { citation: "Allegri et al., 2023", page: 2 }),
      frag("c2", { sourceFile: "b.pdf" }),
    ];
    grader.grados = { c0: "no", c1: "no", c2: "no" };
    const p = await punto(item("e1", "q", "d"), modo(4));
    expect(p.documentosRevisados).toEqual(["Allegri et al., 2023", "b.pdf"]);
  });

  test("índice vacío no llama al calificador y lo dice sin culpar a nadie", async () => {
    const p = await punto(item("e1", "q", "dato"), modo(4));
    expect(p.estado).toBe("sin_resultados");
    expect(p.recuperacion).toBe("hibrida"); // la búsqueda sí funcionó
    expect(grader.vistos).toEqual([]);
    expect(p.documentosRevisados).toEqual([]);
    const texto = evidencia.textoDePunto(p);
    expect(texto).toContain("el índice no devolvió ningún fragmento");
    expect(texto).toContain("buscado solo con la formulación original");
  });

  test("una búsqueda en error marca el punto y no tumba el plan", async () => {
    busqueda.porConsulta = { rota: new Error("índice caído"), sana: [frag("ok")] };
    const ev = await evidencia.ejecutarPlan(
      ctx,
      [item("e0", "rota", "d0"), item("e1", "sana", "d1")],
      modo(4),
      filtros,
      new Telemetria(),
      5000,
    );
    const [rota, sana] = ev.puntos;
    expect(rota.estado).toBe("sin_resultados");
    expect(rota.recuperacion).toBe("error");
    const texto = evidencia.textoDePunto(rota);
    // Recuperación en error NO es ausencia: "no se pudo comprobar", y sin la
    // fórmula de ausencia que el modelo copiaría.
    expect(texto).toContain("no se pudo comprobar");
    expect(texto).toContain("la búsqueda falló");
    expect(texto).not.toContain("sin resultados");
    expect(texto).not.toContain("no está en los documentos");
    expect(sana.estado).toBe("cubierto");
    expect(ids(sana.fragmentos)).toEqual(["ok"]);
    expect([...ev.acumulado.keys()]).toEqual(["ok"]);

    // Si la llamada entera lanza (los embeddings del lote cayeron), todos los
    // puntos quedan en error y `ejecutarPlan` sigue sin lanzar.
    busqueda.lanzar = new Error("embeddings caídos");
    const ev2 = await evidencia.ejecutarPlan(
      ctx,
      [item("e0", "a", "d0"), item("e1", "b", "d1")],
      modo(4),
      filtros,
      new Telemetria(),
      5000,
    );
    expect(ev2.puntos.map((p) => p.recuperacion)).toEqual(["error", "error"]);
    expect(ev2.puntos.map((p) => p.estado)).toEqual(["sin_resultados", "sin_resultados"]);
  });

  test("un punto que no llega a tiempo no retrasa a los demás", async () => {
    let tardia: Promise<Fragmento[]> | null = null;
    busqueda.porConsulta = {
      lenta: () => {
        tardia = new Promise((r) => setTimeout(() => r([frag("tarde")]), 300));
        return tardia;
      },
      rapida: [frag("r")],
    };

    const t0 = Date.now();
    const ev = await evidencia.ejecutarPlan(
      ctx,
      [item("e0", "lenta", "d0"), item("e1", "rapida", "d1")],
      modo(4),
      filtros,
      new Telemetria(),
      50,
    );
    expect(Date.now() - t0).toBeLessThan(250);
    const [lenta, rapida] = ev.puntos;
    expect(lenta.estado).toBe("sin_resultados");
    expect(lenta.recuperacion).toBe("error");
    expect(rapida.estado).toBe("cubierto");
    const texto = evidencia.textoDePunto(lenta);
    expect(texto).toContain("no se pudo comprobar");
    expect(texto).toContain("no llegó a tiempo");
    expect(ev.acumulado.has("tarde")).toBe(false);
    expect(ev.huella).toBe(evidencia.huellaDe(["r"]));

    // Deja terminar la tarea abandonada dentro de este test, con los espías
    // aún puestos, para que no se cuele en el siguiente.
    await tardia;
    await new Promise((r) => setTimeout(r, 20));
  });

  test("adversarial: el tope del despliegue recorta el limiteMs del bucle, y un limiteMs enorme no vence al instante", async () => {
    // Dos suposiciones nuevas del port. Una: si el bucle pasa el presupuesto
    // entero de la pregunta, `EVIDENCE_PREFETCH_TIMEOUT_S` sigue mandando,
    // como en Python. Dos: Node trata un `setTimeout` mayor que 2^31-1 ms (o
    // Infinity) como 1 ms, y sin el recorte un limiteMs "sin límite" haría
    // vencer todos los puntos al instante.
    const anterior = process.env.EVIDENCE_PREFETCH_TIMEOUT_S;
    const retrasada = (ms: number, lista: Fragmento[]) => () =>
      new Promise<Fragmento[]>((r) => setTimeout(() => r(lista), ms));
    try {
      process.env.EVIDENCE_PREFETCH_TIMEOUT_S = "0.05";
      let tardia: Promise<Fragmento[]> | null = null;
      busqueda.porConsulta = {
        lenta: () => (tardia = retrasada(300, [frag("t")])()),
      };
      const t0 = Date.now();
      const ev = await evidencia.ejecutarPlan(ctx, [item("e0", "lenta", "d")], modo(4), filtros, new Telemetria(), 60_000);
      expect(Date.now() - t0).toBeLessThan(250);
      expect(ev.puntos[0].recuperacion).toBe("error");
      await tardia;
      await new Promise((r) => setTimeout(r, 20));

      // Sin tope propio del despliegue (0) y con limiteMs infinito, una
      // búsqueda de 30 ms tiene que llegar: el reloj no puede ser de 1 ms.
      process.env.EVIDENCE_PREFETCH_TIMEOUT_S = "0";
      busqueda.porConsulta = { q: retrasada(30, [frag("x")]) };
      const ev2 = await evidencia.ejecutarPlan(ctx, [item("e0", "q", "d")], modo(4), filtros, new Telemetria(), Infinity);
      expect(ev2.puntos[0].estado).toBe("cubierto");
      expect(ev2.puntos[0].recuperacion).toBe("hibrida");
      const ev3 = await evidencia.ejecutarPlan(ctx, [item("e0", "q", "d")], modo(4), filtros, new Telemetria(), 2 ** 40);
      expect(ev3.puntos[0].estado).toBe("cubierto");
    } finally {
      if (anterior === undefined) delete process.env.EVIDENCE_PREFETCH_TIMEOUT_S;
      else process.env.EVIDENCE_PREFETCH_TIMEOUT_S = anterior;
    }
  });

  test("sin tiempo (limiteMs <= 0) no se lanza ninguna búsqueda y todo queda en error", async () => {
    busqueda.porDefecto = [frag("x")];
    const ev = await evidencia.ejecutarPlan(ctx, [item("e0", "q", "d")], modo(4), filtros, new Telemetria(), 0);
    expect(ev.puntos[0].recuperacion).toBe("error");
    expect(ev.puntos[0].estado).toBe("sin_resultados");
    expect(busqueda.llamadas).toEqual([]);
    expect(evidencia.textoDePunto(ev.puntos[0])).toContain("no se pudo comprobar");
  });
});

// ---------------------------------------------------------------------------
// lo que lee el modelo
// ---------------------------------------------------------------------------
describe("mensajes", () => {
  test("mensajesSinteticos: un assistant con tool_calls y un tool por punto, en orden", async () => {
    busqueda.porConsulta = {
      q0: [frag("c0", { section: "Results" })],
      q1: [],
    };
    const plan = [item("e0", "q0", "respuesta directa"), item("e1", "q1", "la cohorte", "cohort")];
    const ev = await evidencia.ejecutarPlan(ctx, plan, modo(4), filtros, new Telemetria(), 5000);
    const mensajes = evidencia.mensajesSinteticos(ev, plan);

    expect(mensajes.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    const llamadas = mensajes[0].tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    expect(llamadas.map((tc) => tc.id)).toEqual(["call_plan_e0", "call_plan_e1"]);
    expect(llamadas.every((tc) => tc.type === "function")).toBe(true);
    expect(llamadas.every((tc) => tc.function.name === "buscar_documentos")).toBe(true);
    expect(JSON.parse(llamadas[1].function.arguments)).toEqual({ semantico: "q1", punto: "e1" });
    expect(mensajes[0].content).toBeNull();
    expect(mensajes.slice(1).map((m) => m.tool_call_id)).toEqual(["call_plan_e0", "call_plan_e1"]);
    // Cabecera de estado + el formato de resultados de siempre.
    const t0 = mensajes[1].content as string;
    expect(t0.startsWith("PUNTO e0 (respuesta directa): cubierto, 1 fragmentos de: a.pdf")).toBe(true);
    expect(t0).toContain("buscado solo con la formulación original");
    expect(t0).toContain("--- Resultado 1 ---");
    expect(t0).toContain("cita: [a.pdf, pág. 1]");
    expect(t0).toContain("(sección del documento: Results)");
    expect(t0).toContain("(evidencia directa para este punto)");
    const t1 = mensajes[2].content as string;
    expect(t1.startsWith("PUNTO e1 (la cohorte): sin resultados")).toBe(true);
    expect(t1).toContain("buscado en español e inglés");
    expect(
      evidencia.mensajesSinteticos(
        { puntos: [], mapa: {}, acumulado: new Map(), grados: {}, huella: "" },
        [],
      ),
    ).toEqual([]);
  });

  test("la cabecera dice la verdad sobre el inglés", async () => {
    busqueda.porDefecto = [frag("c1")];
    const con = await punto(item("e0", "q", "d", "q en"), modo(4));
    expect(evidencia.textoDePunto(con)).toContain("buscado en español e inglés");
    const sin = await punto(item("e0", "q", "d"), modo(4));
    const textoSin = evidencia.textoDePunto(sin);
    expect(textoSin).toContain("buscado solo con la formulación original");
    expect(textoSin).not.toContain("inglés");
    // Una queryEn igual a la query (salvo mayúsculas) no es una segunda
    // búsqueda, y la cabecera no la cuenta como tal.
    const igual = await punto(item("e1", "Plasma tau", "d", "plasma  tau"), modo(4));
    expect(evidencia.textoDePunto(igual)).toContain("buscado solo con la formulación original");
  });

  test("formatearResultados es el formato de siempre", () => {
    // El verificador resuelve las citas por `cita(ch)`: la línea "cita:"
    // tiene que seguir ahí, literal, y la sección en su propia línea.
    const texto = evidencia.formatearResultados([frag("c", { sourceFile: "p.pdf", page: 3, section: "Métodos" })]);
    expect(texto).toBe("--- Resultado 1 ---\ncita: [p.pdf, pág. 3]\n(sección del documento: Métodos)\ntexto de c");
    // Un .docx se localiza por sección, y entonces la sección no se repite.
    const docx = evidencia.formatearResultados([
      frag("d", { sourceFile: "n.docx", documentType: "docx", section: "Métodos" }),
    ]);
    expect(docx).toBe("--- Resultado 1 ---\ncita: [n.docx, sección: Métodos]\ntexto de d");
    expect(evidencia.formatearResultados([], { c: "directa" }).startsWith("Sin resultados")).toBe(true);
    expect(evidencia.formatearResultados([frag("c")], { c: "parcial" })).toContain("(evidencia parcial para este punto)");
  });

  test("buscarYCalificar es el mismo camino para una consulta", async () => {
    busqueda.porDefecto = [frag("x", { section: "References" }), frag("y")];

    const extra = await evidencia.buscarYCalificar(ctx, "q", "", "", modo(4), filtros, new Telemetria());
    expect(extra.id).toBe("extra");
    expect(ids(extra.fragmentos)).toEqual(["y"]); // podado igual que el plan
    expect(extra.evidenceNeeded).toBe("q");
    expect(extra.queryEn).toBe("");
    expect(busqueda.llamadas).toEqual([["q"]]);
    expect(evidencia.textoDePunto(extra).startsWith("BÚSQUEDA EXTRA (q): cubierto")).toBe(true);

    const conPunto = await evidencia.buscarYCalificar(ctx, "q", "el dato", "e2", modo(4), filtros, new Telemetria());
    expect(conPunto.id).toBe("e2");
    expect(evidencia.textoDePunto(conPunto).startsWith("PUNTO e2 (el dato)")).toBe(true);
    expect((await evidencia.buscarYCalificar(ctx, "q", "d", "   ", modo(4), filtros, new Telemetria())).id).toBe("extra");
  });

  test("acumulado conserva el orden del plan y los grados presentes ganan", async () => {
    // Un mismo fragmento traído por dos puntos: aparece una vez, en el orden
    // del primer punto que lo trajo, con el mapa de los dos.
    const comun = frag("comun");
    busqueda.porConsulta = { q0: [comun, frag("solo0")], q1: [frag("solo1"), comun] };
    const ev = await evidencia.ejecutarPlan(
      ctx,
      [item("e0", "q0", "d0"), item("e1", "q1", "d1")],
      modo(4),
      filtros,
      new Telemetria(),
      5000,
    );
    expect([...ev.acumulado.keys()]).toEqual(["comun", "solo0", "solo1"]);
    expect(ev.mapa).toEqual({ comun: ["e0", "e1"], solo0: ["e0"], solo1: ["e1"] });
    expect(ev.grados).toEqual({ comun: "directa", solo0: "directa", solo1: "directa" });
    expect(NORMAL.fragmentos).toBeGreaterThanOrEqual(4); // el modo real cabe en estas pruebas
  });
});

// ---------------------------------------------------------------------------
// huella
// ---------------------------------------------------------------------------
describe("huella", () => {
  async function subtle(texto: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("sha256 puro coincide con crypto.subtle en uno y varios bloques", async () => {
    // Vector conocido de FIPS 180-4.
    expect(evidencia.sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Los bordes del relleno: 55 y 56 bytes (cabe / no cabe la longitud en el
    // primer bloque), 63, 64, 65 y un mensaje largo, más texto no ASCII.
    const casos = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "k".repeat(1000), "cañón ✓ ñ"];
    for (const c of casos) {
      expect(evidencia.sha256Hex(new TextEncoder().encode(c))).toBe(await subtle(c));
    }
  });

  test("huellaDe no depende del orden, sí del contenido, y mide 64", async () => {
    expect(evidencia.huellaDe(["b", "a"])).toBe(evidencia.huellaDe(["a", "b"]));
    expect(evidencia.huellaDe(["a", "b"])).not.toBe(evidencia.huellaDe(["a", "c"]));
    expect(evidencia.huellaDe(["a"])).not.toBe(evidencia.huellaDe(["a", "a"]));
    expect(evidencia.huellaDe(["x", "y"])).toHaveLength(64);
    expect(evidencia.huellaDe(["x", "y"])).toBe(await subtle("x\ny"));
  });
});
