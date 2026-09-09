// La barrera previa nunca publica un borrador que el crítico rechazó.
//
// Sin red: el juez (`gateway.completionJson`) y el redactor
// (`gateway.crearCompletion`) se parchean sobre el módulo importado como
// namespace. Como `completionJson` va parcheado entero, `crearCompletion` solo
// ve las llamadas de corrección.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as gateway from "../lib/gateway";
import { ajustes } from "../lib/config";
import { Telemetria } from "../lib/telemetry";
import { cita, type Fragmento } from "../lib/citas";
import * as revisor from "./revisor";
import * as verificador from "./verificador";
import type { Afirmacion, Verificacion } from "./verificador";

/** Juez determinista por contenido: condena las afirmaciones cuyo texto cumple
 *  `condena` y sostiene las demás, sea cual sea el texto que se verifica. Hace
 *  falta porque la política quirúrgica verifica varias versiones del texto
 *  (borrador, correcciones, recorte) y las respuestas en cola no bastan. */
function juezPorContenido(condena: (texto: string) => boolean, omite: (texto: string) => boolean = () => false) {
  return async (kwargs: Record<string, unknown>) => {
    const payload = ultimoMensaje(kwargs).content;
    const veredictos = [...payload.matchAll(/^\[(\d+)\] AFIRMACIÓN[^:]*: (.*)$/gm)]
      .filter((m) => !omite(m[2]))
      .map((m) => ({
        i: Number(m[1]),
        veredicto: condena(m[2]) ? "no_sostenida" : "sostenida",
        motivo: condena(m[2]) ? "el fragmento dice otra cosa" : "coincide",
      }));
    return respuestaJson({ veredictos });
  };
}

/** El borrador tal como viaja al redactor: dentro del último mensaje de
 *  usuario, entre sus delimitadores, como texto de OTRO redactor. */
function borradorEnviado(kwargs: Record<string, unknown>): string {
  const contenido = ultimoMensaje(kwargs).content;
  const inicio = contenido.indexOf(revisor.MARCA_BORRADOR);
  const fin = contenido.indexOf(revisor.FIN_BORRADOR);
  if (inicio < 0 || fin < 0) return "";
  return contenido.slice(inicio + revisor.MARCA_BORRADOR.length, fin).trim();
}

/** Redactor que devuelve el borrador tal cual: no arregla nada. */
function redactorQueNoCorrige() {
  return async (kwargs: Record<string, unknown>) => respuestaTexto(borradorEnviado(kwargs));
}

// --- Utilidades --------------------------------------------------------------

function frag(extra: Partial<Fragmento> = {}): Fragmento {
  return {
    _id: "c1",
    text: "El AUC de p-tau217 fue 0.94.",
    sourceFile: "estudio.pdf",
    page: 3,
    chunkType: "text",
    documentType: "pdf",
    ...extra,
  };
}

type RespuestaJson = Awaited<ReturnType<typeof gateway.completionJson>>;
type RespuestaTexto = Awaited<ReturnType<typeof gateway.crearCompletion>>;

function respuestaJson(datos: unknown): RespuestaJson {
  return {
    datos,
    usage: { prompt: 50, cached: 0, completion: 5, reasoning: 0 },
    modelo: "openai/gpt-5.4-mini",
    finishReason: "stop",
    razonamientoRechazado: false,
  };
}

function respuestaTexto(texto: string | null, usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 80, completion_tokens: 12 }): RespuestaTexto {
  return {
    datos: {
      model: "openai/gpt-5.4",
      choices: [{ message: { role: "assistant", content: texto }, finish_reason: "stop" }],
      usage,
    },
    razonamientoRechazado: false,
  };
}

function veredictoJson(veredicto: string, motivo: string, i = 0): RespuestaJson {
  return respuestaJson({ veredictos: [{ i, veredicto, motivo }] });
}

function informe(campos: Partial<Verificacion> = {}): Verificacion {
  return {
    afirmaciones: [],
    evidencia_sin_cubrir: [],
    cobertura: [],
    citas_sin_resolver: [],
    fidelidad: null,
    ok: true,
    nota: "",
    ...campos,
  };
}

function afirmacion(campos: Partial<Afirmacion> & { texto: string }): Afirmacion {
  return { cita: "", veredicto: verificador.SIN_VERIFICAR, motivo: "", fragmento_id: "", fragmentos: [], ...campos };
}

function sostenida(texto = "Dato", frags = ["c1"]): Afirmacion {
  return afirmacion({ texto, cita: "[a.pdf, pág. 1]", veredicto: verificador.SOSTENIDA, fragmentos: frags });
}

function ultimoMensaje(kwargs: Record<string, unknown>): { role: string; content: string } {
  const mensajes = kwargs.messages as Array<{ role: string; content: string }>;
  return mensajes[mensajes.length - 1];
}

const ENV_TOCADO = [
  "PRE_RESPONSE_REVIEW_MAX_REVISIONS",
  "PRE_RESPONSE_REVIEW_TIMEOUT_S",
  "VERIFIER_MAX_CLAIMS",
  "REVISOR_REASONING_EFFORT",
  "LLM_TEMPERATURE",
  "OPENAI_MODEL",
];

// Los tipos de los espías se derivan de funciones y no del genérico de
// `vi.spyOn`, que en vitest 2.1 no admite instanciación explícita.
const espiarJuez = () => vi.spyOn(gateway, "completionJson");
const espiarRedactor = () => vi.spyOn(gateway, "crearCompletion");
let juez: ReturnType<typeof espiarJuez>;
let redactor: ReturnType<typeof espiarRedactor>;

beforeEach(() => {
  for (const k of ENV_TOCADO) delete process.env[k];
  gateway._reiniciarRazonamiento();
  juez = espiarJuez().mockRejectedValue(new Error("juez no programado"));
  redactor = espiarRedactor().mockRejectedValue(new Error("redactor no programado"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ENV_TOCADO) delete process.env[k];
});

// ---------------------------------------------------------------------------
// El camino completo: verificar, corregir, volver a verificar
// ---------------------------------------------------------------------------
describe("revisarAntesDePublicar", () => {
  test("el crítico rechaza y el redactor corrige antes de publicar", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "1";
    const ch = frag();
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    const corregida = `El AUC fue 0.94 ${cita(ch)}.`;
    juez
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "el fragmento dice 0.94"))
      .mockResolvedValueOnce(veredictoJson("sostenida", "coincide"));
    redactor.mockResolvedValueOnce(respuestaTexto(corregida));
    const tel = new Telemetria();
    const conEvidencia = [{ role: "user", content: "cuál fue el AUC" }];

    const resultado = await revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      falsa,
      conEvidencia,
      [ch],
      null,
      null,
      null,
      tel,
    );

    expect(resultado.contenido).toBe(corregida);
    expect(resultado.revisiones).toBe(1);
    // los mensajes con evidencia del llamador no se mutan al montar la corrección
    expect(conEvidencia).toEqual([{ role: "user", content: "cuál fue el AUC" }]);
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    // la corrección va al modelo grande, sin herramientas, con la crítica al final
    const kwargs = redactor.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(ajustes().modelo);
    expect(kwargs.model).toBe("openai/gpt-5.4");
    expect(kwargs).not.toHaveProperty("tools");
    const mensajes = kwargs.messages as Array<{ role: string; content: string }>;
    expect(mensajes[0]).toEqual({ role: "user", content: "cuál fue el AUC" });
    expect(mensajes[mensajes.length - 2].role).toBe("system");
    // El borrador NO va como turno `assistant` del propio modelo: va como texto
    // de otro redactor dentro del mensaje del usuario (ver `_corregir`).
    expect(mensajes.some((m) => m.role === "assistant")).toBe(false);
    expect(borradorEnviado(kwargs)).toBe(falsa);
    expect(ultimoMensaje(kwargs).content).toContain("CRÍTICA DEL BORRADOR");
    expect(ultimoMensaje(kwargs).content).toContain("Pregunta original: cuál fue el AUC");
    // telemetría: verificador, revisor, verificador, en ese orden
    expect(tel.rondas.map((r) => r.componente)).toEqual(["verificador", "revisor", "verificador"]);
    expect(tel.rondas[1]).toMatchObject({ ok: true, modelo: "openai/gpt-5.4", prompt: 80, completion: 12 });
  });

  test("si el crítico falla se publica la abstención segura", async () => {
    const ch = frag();
    juez.mockRejectedValueOnce(new Error("gateway no disponible"));

    const resultado = await revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      `El AUC fue 0.94 ${cita(ch)}.`,
      [{ role: "user", content: "cuál fue el AUC" }],
      [ch],
    );

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    expect(juez).toHaveBeenCalledTimes(1);
    expect(redactor).not.toHaveBeenCalled();
  });

  test("con dos rondas, la segunda corrección parte de la primera y cuenta como 2", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    const ch = frag();
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    const aMedias = `El AUC fue 0.95 ${cita(ch)}.`;
    const corregida = `El AUC fue 0.94 ${cita(ch)}.`;
    juez
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "dice 0.94"))
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "sigue sin ser 0.94"))
      .mockResolvedValueOnce(veredictoJson("sostenida", "coincide"));
    redactor.mockResolvedValueOnce(respuestaTexto(aMedias)).mockResolvedValueOnce(respuestaTexto(corregida));

    const resultado = await revisor.revisarAntesDePublicar("q", falsa, [], [ch]);

    expect(resultado.contenido).toBe(corregida);
    expect(resultado.revisiones).toBe(2);
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(redactor).toHaveBeenCalledTimes(2);
    // la segunda ronda corrige la PRIMERA corrección, no el borrador original
    expect(borradorEnviado(redactor.mock.calls[1][0] as Record<string, unknown>)).toBe(aMedias);
    const critica2 = ultimoMensaje(redactor.mock.calls[1][0] as Record<string, unknown>).content;
    expect(critica2).toContain("sigue sin ser 0.94");
    // la primera ronda pide corregir; la última ordena borrar lo que siga sin sostenerse
    expect(ultimoMensaje(redactor.mock.calls[0][0] as Record<string, unknown>).content).not.toContain("bórralas");
    expect(critica2).toContain(
      "no se pueden sostener con la evidencia: bórralas, ajusta la redacción alrededor y no las sustituyas por otras afirmaciones",
    );
    expect(critica2).toContain(`"El AUC fue 0.95"`);
    expect(resultado.frasesEliminadas).toEqual([]);
  });

  test("si la corrección sigue mal y no queda nada que salvar, no se filtra al usuario", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "1";
    const ch = frag();
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    juez
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "mal"))
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "sigue mal"));
    redactor.mockResolvedValueOnce(respuestaTexto(falsa));

    const resultado = await revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      falsa,
      [{ role: "user", content: "cuál fue el AUC" }],
      [ch],
    );

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(resultado.contenido).not.toContain("0.99");
    expect(resultado.revisiones).toBe(1);
    expect(resultado.motivoAbstencion).toBe("rechazada_tras_correccion");
    expect(resultado.frasesEliminadas).toEqual([]);
    // Una sola consulta al juez: la "corrección" devolvió la misma frase con
    // la misma cita, así que su veredicto se reutiliza; y el recorte deja el
    // texto vacío, así que tampoco se gasta una verificación en él.
    expect(juez).toHaveBeenCalledTimes(1);
    expect(resultado.informeBorrador?.afirmaciones.map((a) => a.veredicto)).toEqual([verificador.NO_SOSTENIDA]);
  });

  test("si el redactor falla o responde vacío se abstiene, sin publicar el borrador", async () => {
    const ch = frag();
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    juez.mockResolvedValue(veredictoJson("no_sostenida", "mal"));
    redactor.mockResolvedValueOnce(respuestaTexto("   "));
    const tel = new Telemetria();

    const resultado = await revisor.revisarAntesDePublicar("q", falsa, [], [ch], null, null, null, tel);

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(tel.rondas.find((r) => r.componente === "revisor")?.ok).toBe(false);
  });

  test("un borrador vacío se sustituye sin gastar llamadas", async () => {
    const ch = frag();
    const resultado = await revisor.revisarAntesDePublicar("q", "   ", [], [ch], { e0: "p", e1: "el AUC" }, { c1: ["e1"] });

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(resultado.revisiones).toBe(0);
    expect(resultado.motivoAbstencion).toBe("borrador_vacio");
    expect(resultado.frasesEliminadas).toEqual([]);
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([["e1", "evidencia_no_usada"]]);
    expect(juez).not.toHaveBeenCalled();
    expect(redactor).not.toHaveBeenCalled();
  });

  test("con cero revisiones permitidas no se corrige: se abstiene directamente", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "0";
    const ch = frag();
    juez.mockResolvedValueOnce(veredictoJson("no_sostenida", "mal"));

    const resultado = await revisor.revisarAntesDePublicar("q", `El AUC fue 0.99 ${cita(ch)}.`, [], [ch]);

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.revisiones).toBe(0);
    expect(resultado.motivoAbstencion).toBe("rechazada_tras_correccion");
    expect(redactor).not.toHaveBeenCalled();
    expect(juez).toHaveBeenCalledTimes(1);
  });

  test("si el crítico no dictamina nada no se corrige a ciegas: abstención segura", async () => {
    // Sin señal no hay crítica con la que corregir. Pero la abstención segura
    // se verifica sin modelo, así que sale aprobada aunque el gateway siga caído.
    const ch = frag();
    juez.mockRejectedValue(new Error("gateway caído"));

    const resultado = await revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch]);

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(redactor).not.toHaveBeenCalled();
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    expect(resultado.informe.afirmaciones).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cobertura por punto: información y crítica, nunca motivo de abstención
// ---------------------------------------------------------------------------
describe("aprobada, bloqueantes y sinSenal", () => {
  test("aprobada no bloquea por evidencia_no_usada", () => {
    // Regresión medida: con cobertura por punto, bloquear por
    // evidencia_sin_cubrir habría mandado a abstención segura CUALQUIER
    // pregunta con un punto cuya evidencia el redactor decidió no usar, tras
    // gastar los 280 s de presupuesto.
    const inf = informe({
      afirmaciones: [sostenida()],
      evidencia_sin_cubrir: ["e2"],
      cobertura: [
        { id: "e1", evidence_needed: "a", estado: "cubierto", n_fragmentos: 1, documentos: ["a.pdf"], afirmaciones: [0] },
        { id: "e2", evidence_needed: "b", estado: "evidencia_no_usada", n_fragmentos: 2, documentos: ["b.pdf"], afirmaciones: [] },
        { id: "e3", evidence_needed: "c", estado: "sin_resultados", n_fragmentos: 0, documentos: [], afirmaciones: [] },
      ],
      fidelidad: 1.0,
    });
    expect(revisor.aprobada(inf)).toBe(true);
  });

  test("parcial y sin_verificar tampoco bloquean mientras haya señal", () => {
    const inf = informe({
      afirmaciones: [
        sostenida(),
        afirmacion({ texto: "Matiz", cita: "[a.pdf, pág. 1]", veredicto: verificador.PARCIAL }),
        afirmacion({ texto: "Sin juzgar", cita: "[a.pdf, pág. 1]" }),
      ],
      fidelidad: 0.5,
    });
    expect(revisor.aprobada(inf)).toBe(true);
    expect(revisor.bloqueantes(inf)).toEqual([]);
  });

  test("aprobada sigue bloqueando la atribución falsa", () => {
    // Lo que no se relaja: una cita que no resuelve, una no sostenida, una
    // respuesta factual sin citas, o un informe sin ninguna señal.
    expect(revisor.aprobada(informe({ afirmaciones: [sostenida()], fidelidad: 1, citas_sin_resolver: ["[x, pág. 9]"] }))).toBe(false);

    const conNoResuelve = informe({
      afirmaciones: [sostenida(), afirmacion({ texto: "Otro", cita: "[x, pág. 9]", veredicto: verificador.CITA_NO_RESUELVE })],
      citas_sin_resolver: ["[x, pág. 9]"],
    });
    expect(revisor.aprobada(conNoResuelve)).toBe(false);
    expect(revisor.bloqueantes(conNoResuelve).map((a) => a.texto)).toEqual(["Otro"]);

    const conNoSostenida = informe({
      afirmaciones: [sostenida(), afirmacion({ texto: "Otro", cita: "[a.pdf, pág. 1]", veredicto: verificador.NO_SOSTENIDA })],
    });
    expect(revisor.aprobada(conNoSostenida)).toBe(false);

    const conSinCita = informe({
      afirmaciones: [sostenida(), afirmacion({ texto: "Sin fuente", veredicto: verificador.SIN_CITA })],
      ok: false,
    });
    expect(revisor.aprobada(conSinCita)).toBe(false);

    const sinSenal = informe({ afirmaciones: [afirmacion({ texto: "x", cita: "[a.pdf, pág. 1]" })], ok: false });
    expect(revisor.aprobada(sinSenal)).toBe(false);
  });

  test("sinSenal distingue 'nada juzgado' de 'alguna sin juzgar'", () => {
    expect(revisor.sinSenal(informe())).toBe(false);
    expect(revisor.sinSenal(informe({ afirmaciones: [afirmacion({ texto: "x" }), afirmacion({ texto: "y" })] }))).toBe(true);
    expect(revisor.sinSenal(informe({ afirmaciones: [afirmacion({ texto: "x" }), sostenida()] }))).toBe(false);
    // una cita que no resuelve es señal determinista, no ausencia de juicio
    expect(
      revisor.sinSenal(informe({ afirmaciones: [afirmacion({ texto: "x", veredicto: verificador.CITA_NO_RESUELVE })] })),
    ).toBe(false);
  });

  test("una abstención sin afirmaciones está aprobada", () => {
    expect(revisor.aprobada(informe({ nota: "la respuesta se abstiene y no cita: correcto, nada que atribuir" }))).toBe(true);
  });
});

describe("_critica", () => {
  test("dice punto por punto qué hacer", () => {
    const inf = informe({
      afirmaciones: [
        afirmacion({
          texto: "El AUC fue 0.99",
          cita: "[a.pdf, pág. 1]",
          veredicto: verificador.NO_SOSTENIDA,
          motivo: "dice 0.94",
          fragmentos: ["c1"],
        }),
      ],
      evidencia_sin_cubrir: ["e2"],
      cobertura: [
        { id: "e1", evidence_needed: "el AUC", estado: "evidencia_no_usada", n_fragmentos: 1, documentos: ["a.pdf"], afirmaciones: [0] },
        {
          id: "e2",
          evidence_needed: "la mortalidad",
          estado: "evidencia_no_usada",
          n_fragmentos: 3,
          documentos: ["Allegri et al., 2023", "b.pdf"],
          afirmaciones: [],
        },
        { id: "e3", evidence_needed: "los efectos adversos", estado: "sin_resultados", n_fragmentos: 0, documentos: [], afirmaciones: [] },
        { id: "e4", evidence_needed: "la cohorte", estado: "cubierto", n_fragmentos: 1, documentos: ["c.pdf"], afirmaciones: [] },
      ],
    });

    const critica = revisor._critica(inf);

    expect(critica).toContain("- no_sostenida: 'El AUC fue 0.99' ([a.pdf, pág. 1]); dice 0.94");
    expect(critica).toContain(
      "- Punto e2 (la mortalidad): se recuperaron 3 fragmentos de Allegri et al., 2023, b.pdf y la respuesta no los usa ni los descarta",
    );
    expect(critica).toContain("incorpóralos con su cita o di explícitamente por qué no responden");
    expect(critica).toContain(
      "- Punto e3 (los efectos adversos): el índice no tiene evidencia; decláralo con la fórmula 'No encuentro ... en los documentos', no lo rellenes",
    );
    // el punto cubierto no genera línea, y la lectura antigua no se duplica
    expect(critica).not.toContain("Punto e4");
    expect(critica).not.toContain("Evidencia requerida sin cubrir");
    // y siempre cierra con la instrucción de eliminar lo que no se respalde
    expect(critica).toContain("ELIMÍNALO de la respuesta");
  });

  test("sin mapa conserva la lectura antigua", () => {
    const critica = revisor._critica(informe({ afirmaciones: [sostenida()], evidencia_sin_cubrir: ["e1", "e2"] }));
    expect(critica).toContain("- Evidencia requerida sin cubrir: e1");
    expect(critica).toContain("- Evidencia requerida sin cubrir: e2");
  });

  test("anota el lote caído aunque ok siga en true", () => {
    const inf = informe({
      afirmaciones: [sostenida(), afirmacion({ texto: "Otro", cita: "[a.pdf, pág. 1]" })],
      ok: true,
      nota: "el verificador no pudo dictaminar 1 de 2 lotes; ...",
    });
    expect(revisor._critica(inf)).toContain("no fue concluyente: el verificador no pudo dictaminar 1 de 2 lotes");
    expect(revisor._critica(inf)).toContain("- sin_verificar: 'Otro' ([a.pdf, pág. 1]); no quedó respaldada");
  });

  test("una nota sin afirmaciones sin verificar y con ok no se muestra", () => {
    const inf = informe({ afirmaciones: [sostenida()], ok: true, nota: "algo" });
    expect(revisor._critica(inf)).not.toContain("no fue concluyente");
  });

  test("sin nada que decir, al menos dice que no superó la barrera", () => {
    expect(revisor._critica(informe({ afirmaciones: [sostenida()] }))).toContain("El borrador no superó la barrera de fidelidad.");
  });

  test("sin_cita se etiqueta como 'sin cita' y sin_resultados sin documentos no rompe", () => {
    const inf = informe({
      afirmaciones: [afirmacion({ texto: "La cohorte tuvo 900 pacientes.", veredicto: verificador.SIN_CITA })],
      cobertura: [{ id: "e1", evidence_needed: "x", estado: "evidencia_no_usada", n_fragmentos: 1, documentos: [], afirmaciones: [] }],
    });
    const critica = revisor._critica(inf);
    expect(critica).toContain("- sin_cita: 'La cohorte tuvo 900 pacientes.' (sin cita); no quedó respaldada");
    expect(critica).toContain("1 fragmentos de los documentos recuperados");
  });
});

// ---------------------------------------------------------------------------
// Camino completo con mapa: la cobertura viaja, informa y critica, y no bloquea
// ---------------------------------------------------------------------------
describe("cobertura en el camino completo", () => {
  test("un punto ausente del corpus no fuerza la abstención", async () => {
    // Antes: evidencia_sin_cubrir no vacío -> no aprobada -> corrección ->
    // sigue sin cubrir -> abstención segura. Ahora sale a la primera y el
    // informe lleva la cobertura para la médica.
    const ch = frag();
    juez.mockResolvedValueOnce(veredictoJson("sostenida", "coincide"));

    const resultado = await revisor.revisarAntesDePublicar(
      "AUC y mortalidad",
      `El AUC fue 0.94 ${cita(ch)}. No encuentro la mortalidad en los documentos.`,
      [{ role: "user", content: "AUC y mortalidad" }],
      [ch],
      { e0: "pregunta", e1: "el AUC", e2: "la mortalidad" },
      { c1: ["e1"] },
    );

    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.revisiones).toBe(0);
    expect(juez).toHaveBeenCalledTimes(1);
    expect(redactor).not.toHaveBeenCalled();
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "cubierto"],
      ["e2", "sin_resultados"],
    ]);
    expect(resultado.informe.evidencia_sin_cubrir).toEqual([]);
  });

  test("la corrección recibe la cobertura y manda temperatura y razonamiento", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "1";
    const ch = frag();
    const otro = frag({ _id: "c2", text: "La conversión fue del 31.6%.", sourceFile: "otro.pdf", page: 5, citation: "Allegri et al., 2023" });
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    const corregida =
      `El AUC fue 0.94 ${cita(ch)}. La conversión fue del 31.6% ${cita(otro)}. ` +
      "No encuentro los efectos adversos en los documentos.";
    juez.mockResolvedValueOnce(veredictoJson("no_sostenida", "dice 0.94")).mockResolvedValueOnce(
      respuestaJson({
        veredictos: [
          { i: 0, veredicto: "sostenida", motivo: "coincide" },
          { i: 1, veredicto: "sostenida", motivo: "coincide" },
        ],
      }),
    );
    redactor.mockResolvedValueOnce(respuestaTexto(corregida));

    const resultado = await revisor.revisarAntesDePublicar(
      "AUC, conversión y efectos adversos",
      falsa,
      [{ role: "user", content: "AUC, conversión y efectos adversos" }],
      [ch, otro],
      { e0: "pregunta", e1: "el AUC", e2: "la conversión", e3: "los efectos adversos" },
      { c1: ["e1"], c2: ["e2"] },
    );

    expect(resultado.contenido).toBe(corregida);
    expect(resultado.revisiones).toBe(1);
    expect(resultado.usoAbstencionSegura).toBe(false);
    const a = ajustes();
    const kwargs = redactor.mock.calls[0][0] as Record<string, unknown>;
    expect(kwargs.model).toBe(a.modelo);
    expect(kwargs.temperature).toBe(a.temperatura);
    expect(kwargs.reasoning_effort).toBe(a.razonamientoRevisor);
    expect(kwargs.reasoning_effort).toBe("high");
    const critica = ultimoMensaje(kwargs).content;
    expect(critica).toContain("Punto e2 (la conversión): se recuperaron 1 fragmentos de Allegri et al., 2023");
    expect(critica).toContain("Punto e3 (los efectos adversos): el índice no tiene evidencia");
    // e1 tiene un bloqueante propio Y además figura como evidencia no usada:
    // una cita que no dice lo que la afirmación dice no es usar la evidencia.
    // Al redactor se le dicen las dos cosas para que corrija la cifra en vez
    // de borrarla.
    expect(critica).toContain("no_sostenida: 'El AUC fue 0.99'");
    expect(critica).toContain("Punto e1 (el AUC): se recuperaron 1 fragmentos de estudio.pdf");
    // la cobertura final refleja la respuesta corregida
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "cubierto"],
      ["e2", "cubierto"],
      ["e3", "sin_resultados"],
    ]);
  });

  test("la abstención segura lleva cobertura cuando hay mapa", async () => {
    const ch = frag();
    juez.mockRejectedValueOnce(new Error("gateway no disponible"));

    const resultado = await revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      `El AUC fue 0.94 ${cita(ch)}.`,
      [{ role: "user", content: "cuál fue el AUC" }],
      [ch],
      { e0: "pregunta", e1: "el AUC", e2: "la mortalidad" },
      { c1: ["e1"] },
    );

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "evidencia_no_usada"],
      ["e2", "sin_resultados"],
    ]);
    // y sigue aprobada: la cobertura no bloquea ni siquiera aquí
    expect(revisor.aprobada(resultado.informe)).toBe(true);
  });

  test("la abstención segura sin mapa no inventa cobertura", async () => {
    // Sin mapa no se le pasa el plan a la abstención: produciría la lectura
    // antigua "todo sin cubrir" sobre un texto que por definición no cubre nada.
    const ch = frag();
    juez.mockRejectedValueOnce(new Error("gateway no disponible"));

    const resultado = await revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      `El AUC fue 0.94 ${cita(ch)}.`,
      [{ role: "user", content: "cuál fue el AUC" }],
      [ch],
      { e0: "pregunta", e1: "el AUC" },
    );

    expect(resultado.informe.cobertura).toEqual([]);
    expect(resultado.informe.evidencia_sin_cubrir).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// El reloj: la revisión no puede gastar más que lo que queda de la pregunta
// ---------------------------------------------------------------------------
describe("tope de tiempo", () => {
  test("si el juez no responde a tiempo, abstención segura con cobertura", async () => {
    vi.useFakeTimers();
    const ch = frag();
    // El juez nunca responde: simula un gateway colgado.
    juez.mockImplementation(() => new Promise<never>(() => undefined));
    const tel = new Telemetria();

    const pendiente = revisor.revisarAntesDePublicar(
      "cuál fue el AUC",
      `El AUC fue 0.94 ${cita(ch)}.`,
      [{ role: "user", content: "cuál fue el AUC" }],
      [ch],
      { e0: "pregunta", e1: "el AUC", e2: "la mortalidad" },
      { c1: ["e1"] },
      // quedan 2 s del reloj de la pregunta aunque el tope propio sea 90 s
      2,
      tel,
    );
    // Todavía no venció: no se ha resuelto nada.
    let resuelto = false;
    void pendiente.then(() => (resuelto = true));
    await vi.advanceTimersByTimeAsync(1900);
    expect(resuelto).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    const resultado = await pendiente;
    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([
      ["e1", "evidencia_no_usada"],
      ["e2", "sin_resultados"],
    ]);
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    expect(redactor).not.toHaveBeenCalled();
  });

  test("el tope propio también manda cuando la pregunta tiene tiempo de sobra", async () => {
    vi.useFakeTimers();
    process.env.PRE_RESPONSE_REVIEW_TIMEOUT_S = "3";
    const ch = frag();
    juez.mockImplementation(() => new Promise<never>(() => undefined));

    const pendiente = revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch], null, null, 500);
    await vi.advanceTimersByTimeAsync(3000);

    const resultado = await pendiente;
    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
  });

  test("el trabajo que pierde la carrera no altera el resultado ni deja un rechazo sin manejar", async () => {
    vi.useFakeTimers();
    const ch = frag();
    let rechazarJuez!: (e: Error) => void;
    juez.mockImplementation(() => new Promise<never>((_, rej) => (rechazarJuez = rej)));

    const pendiente = revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch], null, null, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const resultado = await pendiente;
    expect(resultado.usoAbstencionSegura).toBe(true);

    // El juez colgado acaba fallando después: no puede tumbar el proceso.
    rechazarJuez(new Error("tarde y mal"));
    await vi.advanceTimersByTimeAsync(10);
    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
  });

  test("un tiempo disponible agotado o negativo aún concede el segundo mínimo", async () => {
    vi.useFakeTimers();
    const ch = frag();
    // El juez responde en 500 ms: dentro del segundo mínimo, así que se aprueba.
    juez.mockImplementation(
      () => new Promise<RespuestaJson>((res) => setTimeout(() => res(veredictoJson("sostenida", "ok")), 500)),
    );

    const pendiente = revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch], null, null, -5);
    await vi.advanceTimersByTimeAsync(600);

    const resultado = await pendiente;
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.contenido).toBe(`El AUC fue 0.94 ${cita(ch)}.`);
  });
});

// ---------------------------------------------------------------------------
// Política quirúrgica: lo que no se sostiene se quita, el resto se publica
// ---------------------------------------------------------------------------
describe("publicación quirúrgica", () => {
  const ch = frag();
  const buenas = Array.from({ length: 20 }, (_, i) => `El dato número ${i} consta en la cohorte ${cita(ch)}.`);
  const mala = `El AUC fue 0.99 ${cita(ch)}.`;

  test("(1) 20 sostenidas y 1 no_sostenida que la corrección no arregla: la última ronda ordena borrarla y, si no, la quita el código", async () => {
    // Dato medido: 22 sostenidas, 4 no sostenidas, fidelidad 0.85, y la médica
    // recibió "no puedo ofrecer una respuesta verificable".
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    const borrador = [...buenas.slice(0, 10), mala, ...buenas.slice(10)].join(" ");
    juez.mockImplementation(juezPorContenido((t) => t.includes("0.99")));
    redactor.mockImplementation(redactorQueNoCorrige());
    const tel = new Telemetria();

    const resultado = await revisor.revisarAntesDePublicar("q", borrador, [], [ch], null, null, null, tel);

    // publicada, sin la frase y sin su cita huérfana, con el resto intacto
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.motivoAbstencion).toBeNull();
    expect(resultado.contenido).not.toContain("0.99");
    for (const b of buenas) expect(resultado.contenido).toContain(b);
    expect(resultado.contenido.split(cita(ch)).length - 1).toBe(20);
    expect(resultado.contenido).toBe(buenas.join(" "));
    expect(resultado.frasesEliminadas).toEqual(["El AUC fue 0.99"]);
    expect(resultado.informe.nota).toContain("se eliminó 1 frase por no poder sostenerse con la evidencia");
    expect(resultado.informe.afirmaciones).toHaveLength(20);
    expect(resultado.informe.fidelidad).toBe(1);
    expect(resultado.revisiones).toBe(2);
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    // dos rondas de corrección, pero UNA sola consulta al juez: el redactor
    // devolvió el mismo texto, así que las dos correcciones y el recorte
    // reutilizan los veredictos del borrador en vez de volver a juzgar las 21
    // afirmaciones cada vez (antes eran cuatro verificaciones completas).
    expect(redactor).toHaveBeenCalledTimes(2);
    expect(juez).toHaveBeenCalledTimes(1);
    expect(tel.contadores.veredictos_reutilizados).toBe(21 + 21 + 20);
    const critica1 = ultimoMensaje(redactor.mock.calls[0][0] as Record<string, unknown>).content;
    const critica2 = ultimoMensaje(redactor.mock.calls[1][0] as Record<string, unknown>).content;
    expect(critica1).toContain("no_sostenida: 'El AUC fue 0.99'");
    expect(critica1).not.toContain("bórralas");
    expect(critica2).toContain("ÚLTIMA RONDA");
    expect(critica2).toContain(`"El AUC fue 0.99" (${cita(ch)})`);
    expect(critica2).toContain("no las sustituyas por otras afirmaciones");
    expect(tel.contadores.frases_eliminadas).toBe(1);
  });

  test("(2) si la frase bloqueante no se localiza en el texto, abstención segura con motivo rechazada_tras_correccion", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "0";
    const fabricado = informe({
      afirmaciones: [
        afirmacion({ texto: "Una frase que no está en el texto", cita: "[a.pdf, pág. 1]", veredicto: verificador.NO_SOSTENIDA, motivo: "x" }),
      ],
      fidelidad: 0,
    });
    const verificar = vi.spyOn(verificador, "verificar").mockResolvedValue(fabricado);

    const resultado = await revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch]);

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.usoAbstencionSegura).toBe(true);
    expect(resultado.motivoAbstencion).toBe("rechazada_tras_correccion");
    expect(resultado.frasesEliminadas).toEqual([]);
    expect(resultado.informeBorrador).toBe(fabricado);
    // borrador y abstención: el recorte fallido no gasta verificación
    expect(verificar).toHaveBeenCalledTimes(2);
  });

  test("(3) todo bloqueante y nada que salvar: abstención", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "0";
    juez.mockImplementation(juezPorContenido(() => true));

    const resultado = await revisor.revisarAntesDePublicar(
      "q",
      `El AUC fue 0.99 ${cita(ch)}. La cohorte tuvo 900 pacientes ${cita(ch)}.`,
      [],
      [ch],
    );

    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.motivoAbstencion).toBe("rechazada_tras_correccion");
    expect(resultado.frasesEliminadas).toEqual([]);
    expect(juez).toHaveBeenCalledTimes(1);
  });

  test("una cita inventada pegada a una frase sostenida se quita sola y el resto se publica", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "0";
    juez.mockImplementation(juezPorContenido(() => false));

    const resultado = await revisor.revisarAntesDePublicar(
      "q",
      `El AUC fue 0.94 ${cita(ch)} [inventado.pdf, pág. 9].`,
      [],
      [ch],
    );

    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.contenido).toBe(`El AUC fue 0.94 ${cita(ch)}.`);
    expect(resultado.frasesEliminadas).toEqual([]);
    expect(resultado.informe.nota).toContain("se quitó 1 cita que no correspondían a ningún fragmento recuperado");
    expect(resultado.informe.citas_sin_resolver).toEqual([]);
    expect(resultado.revisiones).toBe(0);
    expect(juez).toHaveBeenCalledTimes(2);
  });

  test("(c) parcial y sin_verificar sobreviven al recorte y se publican", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "0";
    juez.mockImplementation(async (kwargs: Record<string, unknown>) => {
      const payload = ultimoMensaje(kwargs).content;
      const veredictos = [...payload.matchAll(/^\[(\d+)\] AFIRMACIÓN[^:]*: (.*)$/gm)].flatMap((m) => {
        const [, i, texto] = m;
        if (texto.includes("0.99")) return [{ i: Number(i), veredicto: "no_sostenida", motivo: "mal" }];
        if (texto.includes("generaliza")) return [{ i: Number(i), veredicto: "parcial", motivo: "generaliza" }];
        return []; // sin juzgar
      });
      return respuestaJson({ veredictos });
    });

    const resultado = await revisor.revisarAntesDePublicar(
      "q",
      `Esto generaliza un poco ${cita(ch)}. Esto no lo juzgó nadie ${cita(ch)}. El AUC fue 0.99 ${cita(ch)}.`,
      [],
      [ch],
    );

    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.contenido).toBe(`Esto generaliza un poco ${cita(ch)}. Esto no lo juzgó nadie ${cita(ch)}.`);
    expect(resultado.informe.afirmaciones.map((a) => a.veredicto)).toEqual([verificador.PARCIAL, verificador.SIN_VERIFICAR]);
    expect(resultado.frasesEliminadas).toEqual(["El AUC fue 0.99"]);
  });

  test("ADVERSARIAL: si el reloj vence tras verificar el borrador, se publica ESE borrador recortado, no la abstención", async () => {
    // El caso medido en el despliegue: la corrección tarda más que el tope y
    // antes se tiraba un borrador ya juzgado con evidencia en todos los puntos.
    vi.useFakeTimers();
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    juez.mockImplementation(juezPorContenido((t) => t.includes("0.99")));
    redactor.mockImplementation(() => new Promise<never>(() => undefined)); // la corrección se cuelga
    const tel = new Telemetria();

    const pendiente = revisor.revisarAntesDePublicar(
      "q", `${buenas[0]} ${mala} ${buenas[1]}`, [], [ch], { e0: "pregunta", e1: "el AUC" }, { [ch._id]: ["e1"] }, 1, tel,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const resultado = await pendiente;

    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.publicadaTrasTope).toBe(true);
    expect(resultado.motivoAbstencion).toBeNull();
    expect(resultado.contenido).toBe(`${buenas[0]} ${buenas[1]}`);
    expect(resultado.frasesEliminadas).toEqual(["El AUC fue 0.99"]);
    // El informe es el de las frases que quedan: dos sostenidas, fidelidad 1,
    // cobertura recalculada, y una nota que dice qué pasó.
    expect(resultado.informe.afirmaciones.map((a) => a.veredicto)).toEqual([verificador.SOSTENIDA, verificador.SOSTENIDA]);
    expect(resultado.informe.fidelidad).toBe(1);
    expect(resultado.informe.citas_sin_resolver).toEqual([]);
    expect(resultado.informe.cobertura.map((c) => [c.id, c.estado])).toEqual([["e1", "cubierto"]]);
    expect(resultado.informe.nota).toMatch(/no terminó dentro del tiempo/);
    expect(resultado.informe.nota).toMatch(/se eliminó 1 frase/);
    expect(revisor.aprobada(resultado.informe)).toBe(true);
    expect(tel.contadores.publicadas_tras_tope).toBe(1);
    expect(tel.contadores.frases_eliminadas).toBe(1);
  });

  test("ADVERSARIAL: vencido el tope, una cita inventada que no se puede quitar sigue siendo abstención", async () => {
    vi.useFakeTimers();
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    // Informe fabricado: una frase sostenida cuya cita_sin_resolver no aparece
    // literalmente en el texto (el recorte no la encontrará para quitarla).
    const fabricado = informe({
      afirmaciones: [afirmacion({ texto: buenas[0].replace(` ${cita(ch)}.`, ""), cita: cita(ch), veredicto: verificador.SOSTENIDA })],
      citas_sin_resolver: ["[fantasma.pdf, pág. 9]"],
      fidelidad: 1,
    });
    vi.spyOn(verificador, "verificar").mockResolvedValue(fabricado);
    redactor.mockImplementation(() => new Promise<never>(() => undefined));

    const pendiente = revisor.revisarAntesDePublicar("q", `${buenas[0]} [fantasma.pdf, pág. 9]`, [], [ch], null, null, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const resultado = await pendiente;
    // Aquí `_recortar` SÍ quita la cita fantasma (está en el texto): se publica sin ella.
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(resultado.contenido).not.toContain("fantasma");
    expect(resultado.informe.citas_sin_resolver).toEqual([]);
  });

  test("ADVERSARIAL: vencido el tope con un informe SIN señal (todos sin_verificar) no se publica nada", async () => {
    vi.useFakeTimers();
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    const sinSenal = informe({
      afirmaciones: [afirmacion({ texto: "El AUC fue 0.94", cita: cita(ch), veredicto: verificador.SIN_VERIFICAR })],
    });
    vi.spyOn(verificador, "verificar").mockResolvedValue(sinSenal);
    redactor.mockImplementation(() => new Promise<never>(() => undefined));

    const pendiente = revisor.revisarAntesDePublicar("q", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch], null, null, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const resultado = await pendiente;
    // `sinSenal` corta antes con su propio motivo: no hay con qué publicar.
    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.publicadaTrasTope).toBe(false);
  });

  test("si el tope vence DURANTE la primera verificación no hay candidato: abstención por timeout, como siempre", async () => {
    vi.useFakeTimers();
    juez.mockImplementation(() => new Promise<never>(() => undefined));
    const pendiente = revisor.revisarAntesDePublicar("q", `${buenas[0]} ${mala}`, [], [ch], null, null, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const resultado = await pendiente;
    expect(resultado.contenido).toBe(revisor.ABSTENCION_SEGURA);
    expect(resultado.motivoAbstencion).toBe("timeout");
    expect(resultado.publicadaTrasTope).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// El recorte determinista, pieza a pieza
// ---------------------------------------------------------------------------
describe("_recortar", () => {
  const A = "[a.pdf, pág. 1]";
  const B = "[b.pdf, pág. 2]";
  const C = "[c.pdf, pág. 3]";
  const bloqueante = (texto: string, cita = B) =>
    afirmacion({ texto, cita, veredicto: verificador.NO_SOSTENIDA, motivo: "mal", fragmentos: ["c2"] });

  test("(4) la frase eliminada se lleva su cita y no rompe las vecinas", () => {
    const r = revisor._recortar(`Uno ${A}. Dos ${B}. Tres ${C}.`, informe({ afirmaciones: [bloqueante("Dos")] }));
    expect(r?.texto).toBe(`Uno ${A}. Tres ${C}.`);
    expect(r?.eliminadas).toEqual(["Dos"]);
    expect(r?.texto).not.toContain(B);
  });

  test("en una lista, la viñeta vacía desaparece", () => {
    const r = revisor._recortar(`- Uno ${A}.\n- Dos ${B}.\n- Tres ${C}.`, informe({ afirmaciones: [bloqueante("Dos")] }));
    expect(r?.texto).toBe(`- Uno ${A}.\n- Tres ${C}.`);
  });

  test("un encabezado que se queda sin contenido se quita", () => {
    const r = revisor._recortar(
      `Intro ${A}.\n\n**Lo que no está**\n- Dos ${B}.\n\n**Lo que sí**\n- Tres ${C}.`,
      informe({ afirmaciones: [bloqueante("Dos")] }),
    );
    expect(r?.texto).toBe(`Intro ${A}.\n\n**Lo que sí**\n- Tres ${C}.`);
    const alFinal = revisor._recortar(`Intro ${A}.\n\n**Lo que no está**\n- Dos ${B}.`, informe({ afirmaciones: [bloqueante("Dos")] }));
    expect(alFinal?.texto).toBe(`Intro ${A}.`);
  });

  test("si otras frases del tramo se apoyaban en la cita, la cita se conserva y se recoloca", () => {
    // "- V1.\n- V2.\n- V3 [A]." con V3 bloqueante: V1 y V2 fueron juzgadas
    // contra [A] (la cita de cierre respalda el tramo), así que [A] se queda.
    const r = revisor._recortar(`- V1.\n- V2.\n- V3 ${A}.`, informe({ afirmaciones: [bloqueante("V3", A)] }));
    expect(r?.texto).toBe(`- V1.\n- V2. ${A}`);
    // y el verificador vuelve a leerlo como dos frases respaldadas por [A]
    expect(verificador._trocear(r!.texto).trozos.map((t) => [t.texto, t.cita])).toEqual([
      ["- V1.", A],
      ["- V2.", A],
    ]);
  });

  test("si lo que precede en el tramo es una abstención pura, la cita se va con la frase", () => {
    const r = revisor._recortar(`No encuentro la mortalidad en los documentos. V3 ${A}.`, informe({ afirmaciones: [bloqueante("V3", A)] }));
    expect(r?.texto).toBe("No encuentro la mortalidad en los documentos.");
  });

  test("la costura con coma y con punto queda bien", () => {
    expect(revisor._recortar(`X ${A}, Dos ${B}. Tres ${C}.`, informe({ afirmaciones: [bloqueante("Dos")] }))?.texto).toBe(
      `X ${A}. Tres ${C}.`,
    );
    expect(revisor._recortar(`Uno ${A}. Dos ${B}.`, informe({ afirmaciones: [bloqueante("Dos")] }))?.texto).toBe(`Uno ${A}.`);
    expect(revisor._recortar(`Dos ${B}. Uno ${A}.`, informe({ afirmaciones: [bloqueante("Dos")] }))?.texto).toBe(`Uno ${A}.`);
  });

  test("una frase sin cita al final (sin_cita) se quita con su punto", () => {
    const sinCita = afirmacion({ texto: "La cohorte tuvo 900 pacientes.", veredicto: verificador.SIN_CITA });
    const r = revisor._recortar(`Uno ${A}. La cohorte tuvo 900 pacientes.`, informe({ afirmaciones: [sinCita], ok: false }));
    expect(r?.texto).toBe(`Uno ${A}.`);
  });

  test("con el mismo texto dos veces se quita la ocurrencia que lleva la cita condenada", () => {
    const r = revisor._recortar(`El AUC fue 0.94 ${A}. El AUC fue 0.94 ${B}.`, informe({ afirmaciones: [bloqueante("El AUC fue 0.94", B)] }));
    expect(r?.texto).toBe(`El AUC fue 0.94 ${A}.`);
  });

  test("tolera el espaciado: el texto con dobles espacios o salto de línea se localiza igual", () => {
    const r = revisor._recortar(`Uno ${A}. El  AUC\nfue 0.99 ${B}. Tres ${C}.`, informe({ afirmaciones: [bloqueante("El AUC fue 0.99")] }));
    expect(r?.texto).toBe(`Uno ${A}. Tres ${C}.`);
  });

  test("una cita inventada suelta se quita sin tocar la frase", () => {
    const r = revisor._recortar(`Uno ${A} [inv.pdf, pág. 9]. Dos ${C}.`, informe({ citas_sin_resolver: ["[inv.pdf, pág. 9]"] }));
    expect(r?.texto).toBe(`Uno ${A}. Dos ${C}.`);
    expect(r?.citasQuitadas).toEqual(["[inv.pdf, pág. 9]"]);
    expect(r?.eliminadas).toEqual([]);
  });

  test("si una frase no se localiza, devuelve null: no se puede garantizar el recorte", () => {
    expect(revisor._recortar(`Uno ${A}.`, informe({ afirmaciones: [bloqueante("No estoy")] }))).toBeNull();
    expect(revisor._recortar(`Uno ${A}.`, informe({ afirmaciones: [bloqueante("   ")] }))).toBeNull();
  });

  test("varias frases bloqueantes seguidas se quitan todas y el texto queda limpio", () => {
    const r = revisor._recortar(
      `Resumen:\n- Uno ${A}.\n- Dos ${B}.\n- Tres ${B}.\n\nCierre ${C}.`,
      informe({ afirmaciones: [bloqueante("Dos"), bloqueante("Tres")] }),
    );
    expect(r?.texto).toBe(`Resumen:\n- Uno ${A}.\n\nCierre ${C}.`);
    expect(r?.eliminadas).toEqual(["Dos", "Tres"]);
  });
});

describe("_critica en la última ronda", () => {
  test("ordena borrar las frases bloqueantes entre comillas y no reescribirlas", () => {
    const inf = informe({
      afirmaciones: [
        sostenida(),
        afirmacion({ texto: "El AUC fue 0.99", cita: "[a.pdf, pág. 1]", veredicto: verificador.NO_SOSTENIDA, motivo: "dice 0.94" }),
        afirmacion({ texto: "Matiz", cita: "[a.pdf, pág. 1]", veredicto: verificador.PARCIAL, motivo: "generaliza" }),
      ],
      citas_sin_resolver: ["[x.pdf, pág. 9]"],
      fidelidad: 0.5,
    });

    const critica = revisor._critica(inf, { ordenarBorrado: true });

    expect(critica).toContain(
      "Estas frases no se pueden sostener con la evidencia: bórralas, ajusta la redacción alrededor y no las sustituyas por otras afirmaciones",
    );
    expect(critica).toContain(`  "El AUC fue 0.99" ([a.pdf, pág. 1])`);
    // la parcial no se ordena borrar: no bloquea
    expect(critica).not.toContain(`"Matiz"`);
    expect(critica).toContain("quita del texto estas citas, que no corresponden a ningún fragmento recuperado: [x.pdf, pág. 9]");
    expect(critica).toContain("No reescribas las frases listadas: bórralas.");
    expect(critica).not.toContain("Corrige lo que puedas");
  });

  test("en la ronda normal, una cita inventada suelta se lista para que el redactor la quite", () => {
    const inf = informe({ afirmaciones: [sostenida()], citas_sin_resolver: ["[x.pdf, pág. 9]"] });
    const critica = revisor._critica(inf);
    expect(critica).toContain("- cita_no_resuelve: la cita [x.pdf, pág. 9] no corresponde a ningún fragmento recuperado; quítala del texto");
    expect(critica).toContain("Corrige lo que puedas");
    // y no se duplica cuando la afirmación entera ya es cita_no_resuelve
    const conAfirmacion = informe({
      afirmaciones: [afirmacion({ texto: "Otro", cita: "[x.pdf, pág. 9]", veredicto: verificador.CITA_NO_RESUELVE })],
      citas_sin_resolver: ["[x.pdf, pág. 9]"],
    });
    expect(revisor._critica(conAfirmacion).match(/x\.pdf, pág\. 9/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Entidad: la crítica dice de quién es el dato y la pregunta llega al juez
// ---------------------------------------------------------------------------
describe("atribución a otra entidad", () => {
  test("la crítica pide atribuir explícitamente o quitar, en vez de 'no_sostenida' a secas", () => {
    const inf = informe({
      afirmaciones: [
        afirmacion({
          texto: "Redujo la mortalidad un 30 %",
          cita: "[trial.pdf, pág. 4]",
          veredicto: verificador.NO_SOSTENIDA,
          motivo: "el fragmento habla de rivastigmina, no de donepezilo",
          entidad_distinta: true,
          fragmentos: ["r1"],
        }),
        afirmacion({ texto: "El AUC fue 0.99", cita: "[a.pdf, pág. 1]", veredicto: verificador.NO_SOSTENIDA, motivo: "dice 0.94" }),
      ],
    });
    const critica = revisor._critica(inf);
    expect(critica).toContain("- atribución a otra entidad: 'Redujo la mortalidad un 30 %' ([trial.pdf, pág. 4]); el fragmento habla de rivastigmina, no de donepezilo.");
    expect(critica).toContain("nombrándola en la misma frase");
    expect(critica).not.toContain("- no_sostenida: 'Redujo la mortalidad");
    // La otra no sostenida sigue como siempre, y la marca de entidad no la contamina.
    expect(critica).toContain("- no_sostenida: 'El AUC fue 0.99' ([a.pdf, pág. 1]); dice 0.94");
  });

  test("la pregunta viaja al juez en cada verificación de la barrera", async () => {
    const ch = frag();
    const recibidos: string[] = [];
    juez.mockImplementation(async (kwargs: Record<string, unknown>) => {
      recibidos.push(ultimoMensaje(kwargs).content);
      return veredictoJson("sostenida", "coincide");
    });
    const resultado = await revisor.revisarAntesDePublicar("¿cuál fue el AUC de p-tau217?", `El AUC fue 0.94 ${cita(ch)}.`, [], [ch]);
    expect(resultado.usoAbstencionSegura).toBe(false);
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0].startsWith("PREGUNTA DE QUIEN CONSULTA: ¿cuál fue el AUC de p-tau217?")).toBe(true);
  });
});

describe("veredictos iniciales", () => {
  test("una frase ya juzgada antes de la barrera no se vuelve a mandar al juez; la cola sí", async () => {
    const ch = frag();
    const conocida = `El AUC fue 0.94 ${cita(ch)}.`;
    const borrador = `${conocida} La cohorte tuvo 412 pacientes ${cita(ch)}.`;
    const iniciales = verificador.veredictosDe(
      informe({
        afirmaciones: [afirmacion({ texto: "El AUC fue 0.94", cita: cita(ch), veredicto: verificador.SOSTENIDA, motivo: "coincide", fragmentos: [ch._id] })],
      }),
    );
    const pedidas: string[] = [];
    juez.mockImplementation(async (kwargs: Record<string, unknown>) => {
      const lineas = [...ultimoMensaje(kwargs).content.matchAll(/^\[(\d+)\] AFIRMACIÓN[^:]*: (.*)$/gm)];
      for (const l of lineas) pedidas.push(l[2]);
      return respuestaJson({ veredictos: lineas.map((l) => ({ i: Number(l[1]), veredicto: "sostenida", motivo: "ok" })) });
    });
    const r = await revisor.revisarAntesDePublicar("q", borrador, [], [ch], null, null, null, undefined, { veredictosIniciales: iniciales });
    expect(r.contenido).toBe(borrador);
    expect(pedidas).toEqual(["La cohorte tuvo 412 pacientes"]);
    expect(r.informe.afirmaciones.map((a) => a.veredicto)).toEqual([verificador.SOSTENIDA, verificador.SOSTENIDA]);
  });
});

describe("aviso de avance de la barrera (alAvanzar)", () => {
  test("reenvía el avance del verificador y anuncia cada ronda de corrección con sus fallos", async () => {
    process.env.PRE_RESPONSE_REVIEW_MAX_REVISIONS = "2";
    const ch = frag();
    const falsa = `El AUC fue 0.99 ${cita(ch)}.`;
    const corregida = `El AUC fue 0.94 ${cita(ch)}.`;
    juez
      .mockResolvedValueOnce(veredictoJson("no_sostenida", "dice 0.94"))
      .mockResolvedValueOnce(veredictoJson("sostenida", "coincide"));
    redactor.mockResolvedValueOnce(respuestaTexto(corregida));
    const eventos: revisor.EventoRevision[] = [];

    const resultado = await revisor.revisarAntesDePublicar("q", falsa, [], [ch], null, null, null, undefined, {
      alAvanzar: (e) => eventos.push(e),
    });

    expect(resultado.contenido).toBe(corregida);
    // Verificación del borrador (0 de 1, 1 de 1), la ronda con UN fallo, y la
    // verificación de la corrección (la frase cambió: se juzga de nuevo).
    expect(eventos).toEqual([
      { fase: "verificando", hechas: 0, total: 1 },
      { fase: "verificando", hechas: 1, total: 1 },
      { fase: "corrigiendo", ronda: 1, rondas: 2, fallos: 1 },
      { fase: "verificando", hechas: 0, total: 1 },
      { fase: "verificando", hechas: 1, total: 1 },
    ]);
  });
});
