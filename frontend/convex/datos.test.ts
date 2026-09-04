// Pruebas de las funciones de datos y permisos, con convex-test: base en
// memoria, sin despliegue y sin red. Cubren lo que el backend anterior hacía
// en supabase_db.py, routes.py y documents.py, y sobre todo lo que puede
// romperse: la propiedad de las conversaciones, el bloqueo, los lotes y las
// guardas que ya fallaron una vez en producción.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import type { PaginationResult } from "convex/server";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { HISTORIAL_MAX, LIMITE_TEXTO, LOTE_MENSAJES, historialDe } from "./mensajes";
import {
  LOTE_CHUNKS,
  MINUTOS_PROCESSING_RANCIO,
  extensionDe,
  processingRancio,
  sanearNombre,
} from "./documentos";
import { ADMINS_INICIALES } from "./semilla";

// El agente y la ingesta reales NO corren aquí: estas pruebas comprueban que
// se AGENDAN con los argumentos correctos, no lo que hacen después. Se
// sustituyen por acciones inertes porque, al dejar correr lo agendado, el
// agente real intentaría hablar con el gateway; sin clave falla y escribe
// `error` en el mensaje, y eso convertiría en una carrera cualquier aserción
// sobre `pensando`.
vi.mock("./agente/bucle", async () => {
  const { internalAction } = await import("./_generated/server");
  return { correr: internalAction(async () => {}) };
});
vi.mock("./ingesta/pipeline", async () => {
  const { internalAction } = await import("./_generated/server");
  return { ingestar: internalAction(async () => {}) };
});

// ---------------------------------------------------------------------------
// Arnés
// ---------------------------------------------------------------------------
/** Una base vacía. `limites: true` hace que convex-test imponga los límites
 *  reales de una transacción de Convex (16 MiB leídos, 32 000 documentos...),
 *  que es lo que hay que probar cuando se borra por lotes. */
function nuevaBase(opciones: { limites?: boolean } = {}) {
  return convexTest({ schema, transactionLimits: opciones.limites ?? false });
}
type Base = ReturnType<typeof nuevaBase>;
type Identidad = ReturnType<Base["withIdentity"]>;

interface Cuenta {
  id: Id<"users">;
  como: Identidad;
}

/** Da de alta una cuenta directamente en `users` y devuelve cómo actuar con
 *  ella. `withIdentity({subject})` es lo que lee `getAuthUserId`. */
async function alta(
  t: Base,
  email: string,
  extra: { rol?: "admin" | "lector"; bloqueado?: boolean; creadoEn?: number } = {},
): Promise<Cuenta> {
  const ahora = Date.now();
  const id = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email,
      rol: extra.rol ?? "lector",
      bloqueado: extra.bloqueado ?? false,
      creadoEn: extra.creadoEn ?? ahora,
      ultimoAccesoEn: ahora,
    }),
  );
  return { id, como: t.withIdentity({ subject: id }) };
}

async function nuevaSesion(t: Base, userId: Id<"users">, titulo = "Prueba", creadoEn = Date.now()) {
  return await t.run(async (ctx) => ctx.db.insert("sessions", { titulo, userId, creadoEn }));
}

async function nuevoMensaje(
  t: Base,
  datos: {
    sessionId: Id<"sessions">;
    userId: Id<"users">;
    role: "user" | "assistant";
    content: string;
    creadoEn?: number;
    estado?: Doc<"messages">["estado"];
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      sessionId: datos.sessionId,
      userId: datos.userId,
      role: datos.role,
      content: datos.content,
      estado: datos.estado,
      creadoEn: datos.creadoEn ?? Date.now(),
    }),
  );
}

/** `n` turnos completos (pregunta + respuesta) con contenido. */
async function turnosCompletos(t: Base, sessionId: Id<"sessions">, userId: Id<"users">, n: number, desde = 1000) {
  for (let i = 0; i < n; i++) {
    await nuevoMensaje(t, { sessionId, userId, role: "user", content: `pregunta ${i}`, creadoEn: desde + i * 10 });
    await nuevoMensaje(t, {
      sessionId, userId, role: "assistant", content: `respuesta ${i}`, estado: "listo", creadoEn: desde + i * 10 + 1,
    });
  }
}

async function nuevoDocumento(
  t: Base,
  datos: Partial<Omit<Doc<"documents">, "_id" | "_creationTime">> & { fileName: string },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("documents", {
      sha256: "a".repeat(64),
      pages: 0,
      chunks: 0,
      status: "ready",
      ingestadoEn: Date.now(),
      ...datos,
    }),
  );
}

async function guardarFichero(t: Base, contenido: string | Uint8Array = "%PDF-1.4 falso") {
  return await t.run(async (ctx) => ctx.storage.store(new Blob([contenido])));
}

async function agendadas(t: Base) {
  return await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

/** El código del `ConvexError` con el que falla la promesa. Si falla con
 *  cualquier otra cosa se relanza, para ver el error real y no un "undefined
 *  no es 'no_encontrado'". Si NO falla devuelve "ok". */
async function codigoDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (e) {
    const data = (e as { data?: { codigo?: unknown } } | null)?.data;
    if (data && typeof data.codigo === "string") return data.codigo;
    throw e;
  }
  return "ok";
}

function contar<T extends keyof typeof schema.tables>(t: Base, tabla: T) {
  return t.run(async (ctx) => (await ctx.db.query(tabla).collect()).length);
}

/** Cuenta los fragmentos de un documento por páginas, en varias
 *  transacciones. Con los límites activados, leerlos todos de una vez es
 *  justo lo que no se puede hacer (1200 x 25 KB son 30 MB): es el motivo de
 *  los lotes, y la primera versión de esta prueba se estrelló contra ello. */
async function contarChunksDe(t: Base, documentRef: Id<"documents">): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    // Anotados a mano: el cursor se realimenta desde `pagina` y TypeScript no
    // resuelve la inferencia circular por sí solo.
    const cursorActual: string | null = cursor;
    const pagina: PaginationResult<Doc<"chunks">> = await t.run(async (ctx) =>
      ctx.db
        .query("chunks")
        .withIndex("porDocumento", (q) => q.eq("documentRef", documentRef))
        .paginate({ cursor: cursorActual, numItems: 200 }),
    );
    total += pagina.page.length;
    if (pagina.isDone) return total;
    cursor = pagina.continueCursor;
  }
}

/** Deja correr lo agendado con `runAfter(0, ...)`. Los esqueletos del agente
 *  y de la ingesta solo avisan por consola. */
async function ejecutarAgendadas(t: Base) {
  await t.finishAllScheduledFunctions(() => {}, 200);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Sesiones y propiedad
// ---------------------------------------------------------------------------
describe("sesiones", () => {
  test("listar devuelve solo las propias, la más nueva primero", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const beto = await alta(t, "beto@airobotix.net");
    const vieja = await nuevaSesion(t, ana.id, "Vieja", 1000);
    const nueva = await nuevaSesion(t, ana.id, "Nueva", 2000);
    await nuevaSesion(t, beto.id, "De Beto", 1500);

    const deAna = await ana.como.query(api.sesiones.listar, {});
    expect(deAna.map((s) => s._id)).toEqual([nueva, vieja]);
    expect(deAna[0]).toEqual({ _id: nueva, titulo: "Nueva", creadoEn: 2000 });
    const deBeto = await beto.como.query(api.sesiones.listar, {});
    expect(deBeto.map((s) => s.titulo)).toEqual(["De Beto"]);
  });

  test("una conversación ajena responde no_encontrado, también a un administrador", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const otro = await alta(t, "otro@airobotix.net");
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const sesion = await nuevaSesion(t, ana.id);

    expect(await codigoDe(otro.como.query(api.mensajes.deSesion, { sessionId: sesion }))).toBe("no_encontrado");
    // Ser administrador NO da acceso a conversaciones ajenas: ni leer...
    expect(await codigoDe(admin.como.query(api.mensajes.deSesion, { sessionId: sesion }))).toBe("no_encontrado");
    // ...ni escribir, ni borrar.
    expect(
      await codigoDe(admin.como.mutation(api.mensajes.enviar, { sessionId: sesion, texto: "hola", modo: "normal" })),
    ).toBe("no_encontrado");
    expect(await codigoDe(admin.como.mutation(api.sesiones.borrar, { sessionId: sesion }))).toBe("no_encontrado");
    expect(await contar(t, "sessions")).toBe(1);
    expect(await contar(t, "messages")).toBe(0);
    // El dueño sí.
    expect(await ana.como.query(api.mensajes.deSesion, { sessionId: sesion })).toEqual([]);
  });

  test("una cuenta bloqueada recibe acceso_revocado en cualquier llamada", async () => {
    const t = nuevaBase();
    const bloqueado = await alta(t, "fuera@airobotix.net", { bloqueado: true, rol: "admin" });
    const sesion = await nuevaSesion(t, bloqueado.id);
    // Funciones y no promesas: lanzarlas todas a la vez dejaría rechazos sin
    // manejar mientras se espera a la primera.
    const llamadas: Array<() => Promise<unknown>> = [
      () => bloqueado.como.query(api.sesiones.listar, {}),
      () => bloqueado.como.mutation(api.sesiones.crear, { titulo: "x" }),
      () => bloqueado.como.query(api.mensajes.deSesion, { sessionId: sesion }),
      () => bloqueado.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" }),
      () => bloqueado.como.query(api.documentos.listar, {}),
      () => bloqueado.como.query(api.usuarios.yo, {}),
      // Aunque sea admin: el bloqueo va antes que el rol.
      () => bloqueado.como.query(api.usuarios.listar, {}),
      () => bloqueado.como.query(api.estadisticas.sistema, {}),
      () => bloqueado.como.mutation(api.semilla.ascenderSiPreasignado, {}),
    ];
    for (const llamada of llamadas) {
      expect(await codigoDe(llamada())).toBe("acceso_revocado");
    }
    expect(await contar(t, "messages")).toBe(0);
  });

  test("sin sesión iniciada: no_autenticado, y `yo` devuelve null", async () => {
    const t = nuevaBase();
    expect(await codigoDe(t.query(api.sesiones.listar, {}))).toBe("no_autenticado");
    expect(await codigoDe(t.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" }))).toBe("no_autenticado");
    expect(await codigoDe(t.query(api.documentos.listar, {}))).toBe("no_autenticado");
    expect(await t.query(api.usuarios.yo, {})).toBeNull();
  });

  test("crear recorta el título a 60 caracteres y pone uno por defecto si va vacío", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const largo = "t".repeat(80);
    const id = await ana.como.mutation(api.sesiones.crear, { titulo: largo });
    const vacio = await ana.como.mutation(api.sesiones.crear, { titulo: "   " });
    const lista = await ana.como.query(api.sesiones.listar, {});
    expect(lista.find((s) => s._id === id)?.titulo).toBe("t".repeat(60));
    expect(lista.find((s) => s._id === vacio)?.titulo).toBe("Nueva conversación");
  });

  test("borrar elimina la conversación con sus mensajes y su feedback, y nada más", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { sessionId, messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "¿Qué dice el paper?", modo: "normal" });
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    // Otra conversación suya que debe sobrevivir.
    const otra = await ana.como.mutation(api.mensajes.enviar, { texto: "Otra cosa", modo: "normal" });
    await ana.como.mutation(api.mensajes.calificar, { messageId: otra.messageId, rating: -1 });

    await ana.como.mutation(api.sesiones.borrar, { sessionId });

    expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toBeNull();
    const mensajes = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(mensajes.map((m) => m.sessionId)).toEqual([otra.sessionId, otra.sessionId]);
    const votos = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(votos.map((f) => f.messageId)).toEqual([otra.messageId]);
    await ejecutarAgendadas(t);
  });

  test("una conversación con más de un lote de mensajes se termina de borrar en segundo plano", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const sesion = await nuevaSesion(t, ana.id);
    const total = LOTE_MENSAJES + 50;
    for (let i = 0; i < total; i++) {
      await nuevoMensaje(t, { sessionId: sesion, userId: ana.id, role: "user", content: `m${i}`, creadoEn: i });
    }
    await ana.como.mutation(api.sesiones.borrar, { sessionId: sesion });
    // El primer lote se fue con la mutación; el resto está agendado.
    expect(await contar(t, "messages")).toBe(50);
    expect((await agendadas(t)).some((j) => j.name.includes("borrarRestantes"))).toBe(true);
    await ejecutarAgendadas(t);
    expect(await contar(t, "messages")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------
describe("mensajes.enviar", () => {
  test("crea la conversación, guarda los dos mensajes y agenda al agente", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const texto = "¿Cuál fue el AUC de p-tau217 en la cohorte de validación del estudio sueco de 2023?";
    const { sessionId, messageId } = await ana.como.mutation(api.mensajes.enviar, { texto, modo: "extendido" });

    const sesion = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(sesion?.userId).toBe(ana.id);
    expect(sesion?.titulo).toBe(texto.slice(0, 60));

    const mensajes = await ana.como.query(api.mensajes.deSesion, { sessionId });
    expect(mensajes.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(mensajes[0].content).toBe(texto);
    expect(mensajes[1]._id).toBe(messageId);
    expect(mensajes[1].estado).toBe("pensando");
    // El borrador no se publica: content vacío hasta `listo`.
    expect(mensajes[1].content).toBe("");

    const trabajos = await agendadas(t);
    const agente = trabajos.find((j) => j.name.includes("bucle"));
    expect(agente).toBeDefined();
    const args = agente!.args[0] as Record<string, unknown>;
    expect(args).toMatchObject({ messageId, sessionId, userId: ana.id, texto, modo: "extendido", historial: [] });
    await ejecutarAgendadas(t);
  });

  test("el historial son como mucho 8 mensajes y solo turnos completos", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const sesion = await nuevaSesion(t, ana.id);
    await turnosCompletos(t, sesion, ana.id, 12);
    // Un turno que acabó en error (sin contenido) no deja su pregunta
    // huérfana en el historial: dos `user` seguidos era el fallo documentado.
    await nuevoMensaje(t, { sessionId: sesion, userId: ana.id, role: "user", content: "pregunta fallida", creadoEn: 5000 });
    await nuevoMensaje(t, { sessionId: sesion, userId: ana.id, role: "assistant", content: "", estado: "error", creadoEn: 5001 });

    await ana.como.mutation(api.mensajes.enviar, { sessionId: sesion, texto: "y ahora?", modo: "normal" });
    const agente = (await agendadas(t)).find((j) => j.name.includes("bucle"));
    const historial = (agente!.args[0] as { historial: { role: string; content: string }[] }).historial;

    expect(historial).toHaveLength(HISTORIAL_MAX);
    expect(historial.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(historial[0]).toEqual({ role: "user", content: "pregunta 8" });
    expect(historial[7]).toEqual({ role: "assistant", content: "respuesta 11" });
    expect(historial.some((m) => m.content === "pregunta fallida")).toBe(false);
    await ejecutarAgendadas(t);
  });

  test("valida el texto y no deja nada escrito si falla", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    expect(await codigoDe(ana.como.mutation(api.mensajes.enviar, { texto: "", modo: "normal" }))).toBe("invalido");
    expect(await codigoDe(ana.como.mutation(api.mensajes.enviar, { texto: "   \n ", modo: "normal" }))).toBe("invalido");
    expect(
      await codigoDe(ana.como.mutation(api.mensajes.enviar, { texto: "x".repeat(LIMITE_TEXTO + 1), modo: "normal" })),
    ).toBe("invalido");
    expect(await contar(t, "sessions")).toBe(0);
    expect(await contar(t, "messages")).toBe(0);
    // Justo en el tope entra, y los espacios de los lados no cuentan.
    expect(
      await codigoDe(ana.como.mutation(api.mensajes.enviar, { texto: `  ${"x".repeat(LIMITE_TEXTO)}  `, modo: "normal" })),
    ).toBe("ok");
    await ejecutarAgendadas(t);
  });

  test("un modo desconocido no es un error: viaja tal cual y lo resuelve el agente", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    expect(await codigoDe(ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "turbo" }))).toBe("ok");
    await ejecutarAgendadas(t);
  });
});

describe("historialDe", () => {
  const turno = (i: number) => [
    { role: "user", content: `p${i}` },
    { role: "assistant", content: `r${i}` },
  ];

  test("se queda con los últimos 8 mensajes, que son 4 turnos", () => {
    const todos = Array.from({ length: 12 }, (_, i) => turno(i)).flat();
    const h = historialDe(todos);
    expect(h).toHaveLength(8);
    expect(h[0]).toEqual({ role: "user", content: "p8" });
    expect(h[7]).toEqual({ role: "assistant", content: "r11" });
  });

  test("salta preguntas sin respuesta y respuestas sin pregunta", () => {
    expect(
      historialDe([
        { role: "assistant", content: "cola de una ventana recortada" },
        ...turno(1),
        { role: "user", content: "huérfana" },
        { role: "assistant", content: "   " },
        { role: "user", content: "en marcha" },
      ]),
    ).toEqual(turno(1));
  });

  test("ignora roles que no son user ni assistant", () => {
    expect(historialDe([{ role: "system", content: "x" }, ...turno(2)])).toEqual(turno(2));
  });
});

describe("mensajes.actualizarTurno", () => {
  test("parchea solo lo que llega", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });

    const plan = [{ id: "e0", query: "hola" }];
    const hops = [{ origen: "plan", plan_item: "e0" }];
    expect(await t.mutation(internal.mensajes.actualizarTurno, { messageId, cambios: { estado: "buscando", plan, hops } })).toBe(true);
    await t.mutation(internal.mensajes.actualizarTurno, { messageId, cambios: { estado: "listo", content: "Respuesta [x, pág. 1]" } });

    const m = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(m).toMatchObject({ estado: "listo", content: "Respuesta [x, pág. 1]", plan, hops });
    expect(m?.sources).toBeUndefined();
    expect(m?.error).toBeUndefined();
    await ejecutarAgendadas(t);
  });

  test("no resucita un mensaje borrado ni lanza", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { sessionId, messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    await ana.como.mutation(api.sesiones.borrar, { sessionId });
    expect(await t.mutation(internal.mensajes.actualizarTurno, { messageId, cambios: { estado: "listo", content: "tarde" } })).toBe(false);
    expect(await contar(t, "messages")).toBe(0);
    await ejecutarAgendadas(t);
  });
});

describe("mensajes.calificar", () => {
  test("un voto por usuario y mensaje: repetir reemplaza", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const { messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });

    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: -1, comentario: "  no cita  " });
    const votos = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(votos).toHaveLength(1);
    expect(votos[0]).toMatchObject({ messageId, userId: ana.id, rating: -1, comentario: "no cita" });

    // Volver a votar sin comentario lo quita: el voto es el estado actual.
    await ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 });
    const [voto] = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(voto.rating).toBe(1);
    expect(voto.comentario).toBeUndefined();
    await ejecutarAgendadas(t);
  });

  test("un mensaje ajeno o inexistente responde no_encontrado", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    const otro = await alta(t, "otro@airobotix.net", { rol: "admin" });
    const { sessionId, messageId } = await ana.como.mutation(api.mensajes.enviar, { texto: "hola", modo: "normal" });
    expect(await codigoDe(otro.como.mutation(api.mensajes.calificar, { messageId, rating: 1 }))).toBe("no_encontrado");
    await ana.como.mutation(api.sesiones.borrar, { sessionId });
    expect(await codigoDe(ana.como.mutation(api.mensajes.calificar, { messageId, rating: 1 }))).toBe("no_encontrado");
    expect(await contar(t, "feedback")).toBe(0);
    await ejecutarAgendadas(t);
  });
});

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------
describe("documentos: ayudantes puros", () => {
  test("sanearNombre quita rutas y caracteres raros", () => {
    expect(sanearNombre("carpeta/sub/informe.pdf")).toBe("informe.pdf");
    expect(sanearNombre("C:\\Users\\yo\\informe.pdf")).toBe("informe.pdf");
    expect(sanearNombre("../../etc/passwd")).toBe("passwd");
    expect(sanearNombre(".oculto.pdf")).toBe("oculto.pdf");
    expect(sanearNombre("Informe médico (v2).PDF")).toBe("Informe_m_dico__v2_.PDF");
    expect(sanearNombre("")).toBe("");
    expect(sanearNombre("...")).toBe("");
  });

  test("extensionDe va en minúsculas y sin punto", () => {
    expect(extensionDe("a.PDF")).toBe("pdf");
    expect(extensionDe("archivo.tar.gz")).toBe("gz");
    expect(extensionDe("sinextension")).toBe("");
    expect(extensionDe("pdf")).toBe("");
  });

  test("processingRancio: reciente no, pasado el tope sí, sin fecha sí", () => {
    const ahora = 10_000_000;
    const min = 60_000;
    expect(processingRancio({ ingestadoEn: ahora - 1 * min }, ahora)).toBe(false);
    expect(processingRancio({ ingestadoEn: ahora - MINUTOS_PROCESSING_RANCIO * min }, ahora)).toBe(false);
    expect(processingRancio({ ingestadoEn: ahora - (MINUTOS_PROCESSING_RANCIO + 1) * min }, ahora)).toBe(true);
    expect(processingRancio({ ingestadoEn: Number.NaN }, ahora)).toBe(true);
  });

  test("el lote de fragmentos cabe en lo que una transacción puede leer", () => {
    // 3072 float64 son 24 KB; con texto y metadatos, unos 30 KB en el peor
    // caso. Si alguien sube el lote sin rehacer la cuenta, esto avisa.
    const peorCasoBytes = 3072 * 8 + 6 * 1024;
    expect(LOTE_CHUNKS * peorCasoBytes).toBeLessThan(16 * 1024 * 1024);
    expect(LOTE_MENSAJES * 100 * 1024).toBeLessThan(16 * 1024 * 1024);
  });
});

describe("documentos", () => {
  test("listar lo ve cualquier autenticado con la forma del contrato", async () => {
    const t = nuevaBase();
    const lector = await alta(t, "lector@airobotix.net");
    const id = await nuevoDocumento(t, { fileName: "paper.pdf", pages: 12, chunks: 40, titulo: "Un paper" });
    const [fila] = await lector.como.query(api.documentos.listar, {});
    expect(fila).toEqual({
      _id: id,
      fileName: "paper.pdf",
      pages: 12,
      chunks: 40,
      status: "ready",
      error: null,
      ingestadoEn: expect.any(Number),
      titulo: "Un paper",
      citation: null,
    });
  });

  test("subir, reindexar y borrar son solo para administradores", async () => {
    const t = nuevaBase();
    const lector = await alta(t, "lector@airobotix.net");
    const storageId = await guardarFichero(t);
    const doc = await nuevoDocumento(t, { fileName: "paper.pdf", status: "failed", storageId });
    expect(await codigoDe(lector.como.mutation(api.documentos.urlDeSubida, {}))).toBe("solo_admin");
    expect(
      await codigoDe(lector.como.mutation(api.documentos.registrar, { storageId, fileName: "otro.pdf", sha256: "b".repeat(64) })),
    ).toBe("solo_admin");
    expect(await codigoDe(lector.como.mutation(api.documentos.reindexar, { documentId: doc }))).toBe("solo_admin");
    expect(await codigoDe(lector.como.mutation(api.documentos.borrar, { documentId: doc }))).toBe("solo_admin");
    expect(await contar(t, "documents")).toBe(1);
  });

  test("urlDeSubida devuelve una URL para un administrador", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const url = await admin.como.mutation(api.documentos.urlDeSubida, {});
    expect(url).toMatch(/^https:\/\//);
  });

  test("registrar rechaza extensión mala, nombre con ruta y duplicado", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const storageId = await guardarFichero(t);
    const sha256 = "c".repeat(64);

    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId, fileName: "malware.exe", sha256 }))).toBe("invalido");
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId, fileName: "sinextension", sha256 }))).toBe("invalido");
    // Una ruta nunca llega a registrarse como tal: se queda con el nombre
    // base, y si el base no tiene extensión válida, se rechaza.
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId, fileName: "../../etc/passwd", sha256 }))).toBe("invalido");
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId, fileName: "../.pdf", sha256 }))).toBe("invalido");
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId, fileName: "x.pdf", sha256: "no-es-hex" }))).toBe("invalido");
    expect(await contar(t, "documents")).toBe(0);

    const id = await admin.como.mutation(api.documentos.registrar, { storageId, fileName: "carpeta/sub/informe.pdf", sha256 });
    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc).toMatchObject({ fileName: "informe.pdf", status: "processing", storageId, sha256, subidoPor: admin.id, pages: 0, chunks: 0 });
    expect((await agendadas(t)).some((j) => j.name.includes("ingestar"))).toBe(true);

    // Mismo nombre otra vez: conflicto, aunque sea con otro fichero.
    const otroFichero = await guardarFichero(t, "otro contenido");
    expect(
      await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId: otroFichero, fileName: "informe.pdf", sha256: "d".repeat(64) })),
    ).toBe("conflicto");
    expect(await contar(t, "documents")).toBe(1);
    await ejecutarAgendadas(t);
  });

  test("registrar reutiliza la fila de un intento fallido y suelta su fichero viejo", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const viejo = await guardarFichero(t, "primer intento");
    const fallido = await nuevoDocumento(t, { fileName: "paper.pdf", status: "failed", error: "timeout", storageId: viejo, chunks: 7 });
    const nuevo = await guardarFichero(t, "segundo intento");

    const id = await admin.como.mutation(api.documentos.registrar, { storageId: nuevo, fileName: "paper.pdf", sha256: "e".repeat(64) });
    expect(id).toBe(fallido);
    const doc = await t.run(async (ctx) => ctx.db.get(fallido));
    expect(doc).toMatchObject({ status: "processing", storageId: nuevo, sha256: "e".repeat(64), chunks: 0, pages: 0 });
    expect(doc?.error).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.system.get(viejo))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.system.get(nuevo))).not.toBeNull();
    expect(await contar(t, "documents")).toBe(1);
    await ejecutarAgendadas(t);
  });

  test("registrar rechaza un fichero vacío, uno que no está y uno que supera el límite", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const sha256 = "f".repeat(64);
    const vacio = await guardarFichero(t, "");
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId: vacio, fileName: "vacio.pdf", sha256 }))).toBe("invalido");

    const borrado = await guardarFichero(t);
    await t.run(async (ctx) => ctx.storage.delete(borrado));
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId: borrado, fileName: "ido.pdf", sha256 }))).toBe("invalido");

    vi.stubEnv("UPLOAD_LIMIT_MB", "1");
    const grande = await guardarFichero(t, new Uint8Array(1024 * 1024 + 1));
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId: grande, fileName: "grande.pdf", sha256 }))).toBe("invalido");
    const justo = await guardarFichero(t, new Uint8Array(1024 * 1024));
    expect(await codigoDe(admin.como.mutation(api.documentos.registrar, { storageId: justo, fileName: "justo.pdf", sha256 }))).toBe("ok");
    expect(await contar(t, "documents")).toBe(1);
    await ejecutarAgendadas(t);
  });

  test("reindexar respeta el rancio de 10 minutos y renueva la fecha", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const min = 60_000;
    const storageId = await guardarFichero(t);
    const vivo = await nuevoDocumento(t, { fileName: "vivo.pdf", status: "processing", storageId, ingestadoEn: Date.now() - 1 * min });
    const abandonado = await nuevoDocumento(t, {
      fileName: "abandonado.pdf", status: "processing", storageId, ingestadoEn: Date.now() - (MINUTOS_PROCESSING_RANCIO + 1) * min,
    });
    const fallidoViejo = await nuevoDocumento(t, {
      fileName: "fallido.pdf", status: "failed", error: "x", storageId, ingestadoEn: Date.now() - 3 * 60 * min,
    });

    // Sigue vivo: reingerir en paralelo duplicaría fragmentos.
    expect(await codigoDe(admin.como.mutation(api.documentos.reindexar, { documentId: vivo }))).toBe("conflicto");
    // Abandonado: se puede reintentar.
    const antes = Date.now();
    expect(await admin.como.mutation(api.documentos.reindexar, { documentId: abandonado })).toEqual({ fileName: "abandonado.pdf", status: "processing" });
    const doc = await t.run(async (ctx) => ctx.db.get(abandonado));
    expect(doc?.status).toBe("processing");
    expect(doc!.ingestadoEn).toBeGreaterThanOrEqual(antes);
    // Regresión del fallo que se anulaba solo: sin renovar la fecha, el
    // reintento heredaba la vieja, parecía abandonado de inmediato y un
    // segundo reindex concurrente pasaba la guarda.
    expect(await codigoDe(admin.como.mutation(api.documentos.reindexar, { documentId: abandonado }))).toBe("conflicto");
    // Un `failed` se reintenta aunque su fecha sea antigua, y su error se limpia.
    expect(await codigoDe(admin.como.mutation(api.documentos.reindexar, { documentId: fallidoViejo }))).toBe("ok");
    const reintentado = await t.run(async (ctx) => ctx.db.get(fallidoViejo));
    expect(reintentado?.status).toBe("processing");
    expect(reintentado?.error).toBeUndefined();
    expect((await agendadas(t)).filter((j) => j.name.includes("ingestar"))).toHaveLength(2);
    await ejecutarAgendadas(t);
  });

  test("reindexar sin fichero guardado o sin registro no puede", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const sinFichero = await nuevoDocumento(t, { fileName: "legado.pdf", status: "failed" });
    expect(await codigoDe(admin.como.mutation(api.documentos.reindexar, { documentId: sinFichero }))).toBe("conflicto");
    await t.run(async (ctx) => ctx.db.delete(sinFichero));
    expect(await codigoDe(admin.como.mutation(api.documentos.reindexar, { documentId: sinFichero }))).toBe("no_encontrado");
    expect(await codigoDe(admin.como.mutation(api.documentos.borrar, { documentId: sinFichero }))).toBe("no_encontrado");
  });

  test("borrar un documento con 1200 fragmentos los elimina todos, por lotes y dentro de los límites", async () => {
    // Con los límites reales activados: un solo borrado de 1200 fragmentos de
    // 25 KB (30 MB) reventaría la transacción, que es justo lo que los lotes
    // evitan.
    const t = nuevaBase({ limites: true });
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const storageId = await guardarFichero(t);
    const doc = await nuevoDocumento(t, { fileName: "gordo.pdf", chunks: 1200, storageId });
    const otroDoc = await nuevoDocumento(t, { fileName: "otro.pdf", chunks: 3 });
    const embedding = Array.from({ length: 3072 }, (_, i) => i / 3072);
    const total = 1200;
    for (let desde = 0; desde < total; desde += 100) {
      await t.run(async (ctx) => {
        for (let i = desde; i < desde + 100; i++) {
          await ctx.db.insert("chunks", {
            text: `fragmento ${i}`, embedding, sourceFile: "gordo.pdf", page: i, chunkType: "text", documentRef: doc,
          });
        }
      });
    }
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("chunks", { text: `ajeno ${i}`, embedding, sourceFile: "otro.pdf", page: i, chunkType: "text", documentRef: otroDoc });
      }
    });
    expect(await contarChunksDe(t, doc)).toBe(total);

    await admin.como.mutation(api.documentos.borrar, { documentId: doc });

    // La fila y el fichero se van ya; el primer lote también.
    expect(await t.run(async (ctx) => ctx.db.get(doc))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.system.get(storageId))).toBeNull();
    expect(await contarChunksDe(t, doc)).toBe(total - LOTE_CHUNKS);
    expect((await agendadas(t)).filter((j) => j.name.includes("borrarChunksRestantes"))).toHaveLength(1);

    await ejecutarAgendadas(t);
    expect(await contarChunksDe(t, doc)).toBe(0);
    const restantes = await t.run(async (ctx) => ctx.db.query("chunks").collect());
    expect(restantes.map((c) => c.documentRef)).toEqual([otroDoc, otroDoc, otroDoc]);
    const trabajos = (await agendadas(t)).filter((j) => j.name.includes("borrarChunksRestantes"));
    expect(trabajos.length).toBeGreaterThanOrEqual(Math.ceil((total - LOTE_CHUNKS) / LOTE_CHUNKS));
    expect(trabajos.every((j) => j.state.kind === "success")).toBe(true);
    // El otro documento sigue intacto.
    expect(await t.run(async (ctx) => ctx.db.get(otroDoc))).not.toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
describe("usuarios", () => {
  test("yo devuelve la ficha", async () => {
    const t = nuevaBase();
    const ana = await alta(t, "ana@airobotix.net");
    expect(await ana.como.query(api.usuarios.yo, {})).toEqual({ _id: ana.id, email: "ana@airobotix.net", rol: "lector", bloqueado: false });
  });

  test("listar cuenta conversaciones y preguntas por cuenta, y es solo admin", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin", creadoEn: 1000 });
    const ana = await alta(t, "ana@airobotix.net", { creadoEn: 3000 });
    const beto = await alta(t, "beto@airobotix.net", { creadoEn: 2000, bloqueado: true });
    const s1 = await nuevaSesion(t, ana.id);
    const s2 = await nuevaSesion(t, ana.id);
    await turnosCompletos(t, s1, ana.id, 2);
    await turnosCompletos(t, s2, ana.id, 1);

    expect(await codigoDe(ana.como.query(api.usuarios.listar, {}))).toBe("solo_admin");
    const lista = await admin.como.query(api.usuarios.listar, {});
    expect(lista.map((u) => u.email)).toEqual(["admin@airobotix.net", "beto@airobotix.net", "ana@airobotix.net"]);
    const deAna = lista.find((u) => u._id === ana.id)!;
    expect(deAna).toMatchObject({ rol: "lector", bloqueado: false, sesiones: 2, mensajes: 3, creadoEn: 3000 });
    expect(deAna.ultimoAccesoEn).toEqual(expect.any(Number));
    expect(lista.find((u) => u._id === beto.id)).toMatchObject({ bloqueado: true, sesiones: 0, mensajes: 0 });
    // Solo cifras: ningún texto de conversación viaja aquí.
    expect(JSON.stringify(lista)).not.toContain("pregunta 0");
  });

  test("actualizar rechaza a uno mismo y aplica rol y bloqueo a otros", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const ana = await alta(t, "ana@airobotix.net");

    expect(await codigoDe(admin.como.mutation(api.usuarios.actualizar, { userId: admin.id, rol: "lector" }))).toBe("invalido");
    expect(await codigoDe(admin.como.mutation(api.usuarios.actualizar, { userId: admin.id, bloqueado: true }))).toBe("invalido");
    expect(await codigoDe(admin.como.mutation(api.usuarios.actualizar, { userId: ana.id }))).toBe("invalido");
    expect(await codigoDe(ana.como.mutation(api.usuarios.actualizar, { userId: admin.id, bloqueado: true }))).toBe("solo_admin");
    // Nada cambió con los rechazos.
    expect(await t.run(async (ctx) => ctx.db.get(admin.id))).toMatchObject({ rol: "admin", bloqueado: false });

    expect(await admin.como.mutation(api.usuarios.actualizar, { userId: ana.id, rol: "admin" })).toEqual({
      _id: ana.id, email: "ana@airobotix.net", rol: "admin", bloqueado: false,
    });
    expect(await admin.como.mutation(api.usuarios.actualizar, { userId: ana.id, bloqueado: true })).toMatchObject({ rol: "admin", bloqueado: true });
    // El bloqueo echa en el acto, aunque el token siga siendo válido.
    expect(await codigoDe(ana.como.query(api.sesiones.listar, {}))).toBe("acceso_revocado");
    expect(await admin.como.mutation(api.usuarios.actualizar, { userId: ana.id, bloqueado: false })).toMatchObject({ bloqueado: false });
    expect(await codigoDe(ana.como.query(api.sesiones.listar, {}))).toBe("ok");

    await t.run(async (ctx) => ctx.db.delete(ana.id));
    expect(await codigoDe(admin.como.mutation(api.usuarios.actualizar, { userId: ana.id, rol: "lector" }))).toBe("no_encontrado");
  });

  test("borrar rechaza a uno mismo y deja cero sesiones, mensajes, feedback y filas de auth suyas", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const ana = await alta(t, "ana@airobotix.net");
    const beto = await alta(t, "beto@airobotix.net");

    // Lo de Ana: dos conversaciones con turnos, un voto, un documento subido
    // y sus filas de Convex Auth.
    const s1 = await nuevaSesion(t, ana.id);
    const s2 = await nuevaSesion(t, ana.id);
    await turnosCompletos(t, s1, ana.id, 2);
    await turnosCompletos(t, s2, ana.id, 1);
    const [unMensaje] = await t.run(async (ctx) => ctx.db.query("messages").collect());
    await t.run(async (ctx) => ctx.db.insert("feedback", { messageId: unMensaje._id, userId: ana.id, rating: 1, creadoEn: Date.now() }));
    const documento = await nuevoDocumento(t, { fileName: "de-ana.pdf", subidoPor: ana.id });
    await t.run(async (ctx) => {
      const cuenta = await ctx.db.insert("authAccounts", { userId: ana.id, provider: "password", providerAccountId: "ana@airobotix.net" });
      await ctx.db.insert("authVerificationCodes", { accountId: cuenta, provider: "password", code: "123", expirationTime: Date.now() + 1e6 });
      const sesionAuth = await ctx.db.insert("authSessions", { userId: ana.id, expirationTime: Date.now() + 1e6 });
      await ctx.db.insert("authRefreshTokens", { sessionId: sesionAuth, expirationTime: Date.now() + 1e6 });
    });
    // Lo de Beto, que tiene que sobrevivir intacto.
    const sb = await nuevaSesion(t, beto.id);
    await turnosCompletos(t, sb, beto.id, 1);
    await t.run(async (ctx) => ctx.db.insert("authSessions", { userId: beto.id, expirationTime: Date.now() + 1e6 }));

    expect(await codigoDe(admin.como.mutation(api.usuarios.borrar, { userId: admin.id }))).toBe("invalido");
    expect(await codigoDe(beto.como.mutation(api.usuarios.borrar, { userId: ana.id }))).toBe("solo_admin");
    expect(await contar(t, "users")).toBe(3);

    await admin.como.mutation(api.usuarios.borrar, { userId: ana.id });
    await ejecutarAgendadas(t);

    expect(await t.run(async (ctx) => ctx.db.get(ana.id))).toBeNull();
    const deAna = await t.run(async (ctx) => ({
      sesiones: (await ctx.db.query("sessions").withIndex("porUsuario", (q) => q.eq("userId", ana.id)).collect()).length,
      mensajes: (await ctx.db.query("messages").withIndex("porUsuario", (q) => q.eq("userId", ana.id)).collect()).length,
      feedback: (await ctx.db.query("feedback").withIndex("porUsuarioYMensaje", (q) => q.eq("userId", ana.id)).collect()).length,
      cuentasAuth: (await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", ana.id)).collect()).length,
      sesionesAuth: (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", ana.id)).collect()).length,
      codigos: (await ctx.db.query("authVerificationCodes").collect()).length,
      tokens: (await ctx.db.query("authRefreshTokens").collect()).length,
    }));
    expect(deAna).toEqual({ sesiones: 0, mensajes: 0, feedback: 0, cuentasAuth: 0, sesionesAuth: 0, codigos: 0, tokens: 0 });
    // El documento se conserva, sin dueño.
    const doc = await t.run(async (ctx) => ctx.db.get(documento));
    expect(doc?.fileName).toBe("de-ana.pdf");
    expect(doc?.subidoPor).toBeUndefined();
    // Beto sigue entero.
    expect(await contar(t, "users")).toBe(2);
    expect(await contar(t, "sessions")).toBe(1);
    expect(await contar(t, "messages")).toBe(2);
    expect(await contar(t, "authSessions")).toBe(1);
    expect(await codigoDe(admin.como.mutation(api.usuarios.borrar, { userId: ana.id }))).toBe("no_encontrado");
  });

  test("borrar una cuenta con más de un lote de mensajes acaba con cero", async () => {
    const t = nuevaBase();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const ana = await alta(t, "ana@airobotix.net");
    const s = await nuevaSesion(t, ana.id);
    for (let i = 0; i < 2 * LOTE_MENSAJES + 5; i++) {
      await nuevoMensaje(t, { sessionId: s, userId: ana.id, role: "user", content: `m${i}`, creadoEn: i });
    }
    await admin.como.mutation(api.usuarios.borrar, { userId: ana.id });
    await ejecutarAgendadas(t);
    expect(await contar(t, "messages")).toBe(0);
    expect(await contar(t, "sessions")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Estadísticas
// ---------------------------------------------------------------------------
describe("estadisticas.sistema", () => {
  test("devuelve la forma del contrato con las cifras bien contadas", async () => {
    const t = nuevaBase();
    const dia = 24 * 60 * 60 * 1000;
    const ahora = Date.now();
    const admin = await alta(t, "admin@airobotix.net", { rol: "admin" });
    const ana = await alta(t, "ana@airobotix.net");
    const beto = await alta(t, "beto@airobotix.net");

    await nuevoDocumento(t, { fileName: "a.pdf", chunks: 10, documentType: "pdf", language: "es" });
    await nuevoDocumento(t, { fileName: "b.docx", chunks: 5, documentType: "docx", language: "en" });
    await nuevoDocumento(t, { fileName: "c.pdf", chunks: 7, documentType: "pdf", language: "en" });
    // Ni un `failed` ni un `processing` cuentan en el índice.
    await nuevoDocumento(t, { fileName: "roto.pdf", chunks: 99, status: "failed", documentType: "xlsx", language: "fr" });
    await nuevoDocumento(t, { fileName: "enmarcha.pdf", chunks: 0, status: "processing" });

    const reciente = await nuevaSesion(t, ana.id, "hoy", ahora - 1 * dia);
    const antigua = await nuevaSesion(t, beto.id, "hace un mes", ahora - 30 * dia);
    // Ana: 2 preguntas recientes; Beto: 1 antigua. Las respuestas no cuentan.
    await nuevoMensaje(t, { sessionId: reciente, userId: ana.id, role: "user", content: "p1", creadoEn: ahora - 1 * dia });
    await nuevoMensaje(t, { sessionId: reciente, userId: ana.id, role: "assistant", content: "r1", creadoEn: ahora - 1 * dia + 1 });
    await nuevoMensaje(t, { sessionId: reciente, userId: ana.id, role: "user", content: "p2", creadoEn: ahora - 2 * dia });
    await nuevoMensaje(t, { sessionId: reciente, userId: ana.id, role: "assistant", content: "r2", creadoEn: ahora - 2 * dia + 1 });
    const viejaPregunta = await nuevoMensaje(t, { sessionId: antigua, userId: beto.id, role: "user", content: "p0", creadoEn: ahora - 30 * dia });
    await nuevoMensaje(t, { sessionId: antigua, userId: beto.id, role: "assistant", content: "r0", creadoEn: ahora - 30 * dia + 1 });
    await t.run(async (ctx) => {
      await ctx.db.insert("feedback", { messageId: viejaPregunta, userId: beto.id, rating: 1, creadoEn: ahora });
      await ctx.db.insert("feedback", { messageId: viejaPregunta, userId: ana.id, rating: 1, creadoEn: ahora });
      await ctx.db.insert("feedback", { messageId: viejaPregunta, userId: admin.id, rating: -1, creadoEn: ahora });
    });

    expect(await codigoDe(ana.como.query(api.estadisticas.sistema, {}))).toBe("solo_admin");
    const stats = await admin.como.query(api.estadisticas.sistema, {});
    expect(stats).toEqual({
      index: { chunks: 22, files: 3, types: ["docx", "pdf"], languages: ["en", "es"] },
      activity: { questions_total: 3, questions_7d: 2, active_users_7d: 1, feedback_up: 2, feedback_down: 1 },
      config: {
        model: expect.any(String),
        embedding_model: expect.any(String),
        prompt_version: expect.any(String),
        upload_limit_mb: expect.any(Number),
      },
    });
    // El proveedor va delante del modelo: es el AI Gateway, no la API directa.
    expect(stats.config.model).toMatch(/^openai\//);
    expect(JSON.stringify(stats)).not.toContain("p1");
  });
});

// ---------------------------------------------------------------------------
// Semilla
// ---------------------------------------------------------------------------
describe("semilla", () => {
  test("sembrarAdmins inserta los tres correos y es idempotente", async () => {
    const t = nuevaBase();
    expect(await t.mutation(internal.semilla.sembrarAdmins, {})).toEqual({ insertados: 3, total: 3 });
    expect(await t.mutation(internal.semilla.sembrarAdmins, {})).toEqual({ insertados: 0, total: 3 });
    const filas = await t.run(async (ctx) => ctx.db.query("adminsPreasignados").collect());
    expect(filas.map((f) => f.email).sort()).toEqual([...ADMINS_INICIALES].sort());
    expect(ADMINS_INICIALES.every((e) => e === e.toLowerCase() && e.endsWith("@airobotix.net"))).toBe(true);
  });

  test("ascenderSiPreasignado asciende solo a quien está en la lista", async () => {
    const t = nuevaBase();
    // Se dieron de alta ANTES de sembrar: entraron como lectores.
    const emir = await alta(t, ADMINS_INICIALES[0]);
    const ana = await alta(t, "ana@airobotix.net");
    const yaAdmin = await alta(t, "admin@airobotix.net", { rol: "admin" });

    expect(await emir.como.mutation(api.semilla.ascenderSiPreasignado, {})).toEqual({ rol: "lector", cambiado: false });
    await t.mutation(internal.semilla.sembrarAdmins, {});
    expect(await emir.como.mutation(api.semilla.ascenderSiPreasignado, {})).toEqual({ rol: "admin", cambiado: true });
    expect(await t.run(async (ctx) => ctx.db.get(emir.id))).toMatchObject({ rol: "admin" });
    expect(await emir.como.mutation(api.semilla.ascenderSiPreasignado, {})).toEqual({ rol: "admin", cambiado: false });

    expect(await ana.como.mutation(api.semilla.ascenderSiPreasignado, {})).toEqual({ rol: "lector", cambiado: false });
    expect(await t.run(async (ctx) => ctx.db.get(ana.id))).toMatchObject({ rol: "lector" });
    expect(await yaAdmin.como.mutation(api.semilla.ascenderSiPreasignado, {})).toEqual({ rol: "admin", cambiado: false });
    expect(await codigoDe(t.mutation(api.semilla.ascenderSiPreasignado, {}))).toBe("no_autenticado");
  });
});
