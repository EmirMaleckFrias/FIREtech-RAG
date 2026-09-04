// Arnés de pruebas de punta a punta contra el despliegue real. Solo funciones
// INTERNAS: no se pueden llamar desde el navegador, solo con `npx convex run`.
//
// Sirve para lanzar una pregunta al agente sin pasar por la interfaz ni por el
// login (crea un usuario de pruebas, una conversación y los dos mensajes, y
// agenda el bucle), y para leer después el mensaje del asistente con su
// telemetría. Es el equivalente del `preguntar.py` y del script de estrés del
// backend anterior.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

const CORREO_PRUEBAS = "pruebas@airobotix.net";

export const prepararPregunta = internalMutation({
  args: { texto: v.string(), modo: v.string(), sessionId: v.optional(v.id("sessions")) },
  handler: async (ctx, args) => {
    let usuario = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", CORREO_PRUEBAS))
      .unique();
    const ahora = Date.now();
    const userId =
      usuario?._id ??
      (await ctx.db.insert("users", {
        email: CORREO_PRUEBAS,
        rol: "lector",
        bloqueado: false,
        creadoEn: ahora,
        ultimoAccesoEn: ahora,
      }));

    const sessionId =
      args.sessionId ??
      (await ctx.db.insert("sessions", {
        titulo: args.texto.slice(0, 60),
        userId,
        creadoEn: ahora,
      }));

    // Historial: turnos completos previos de la conversación, como hace
    // `mensajes.enviar`.
    const previos = await ctx.db
      .query("messages")
      .withIndex("porSesion", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .collect();
    const historial = previos
      .filter((m) => m.content && (m.role === "user" || m.estado === "listo"))
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    await ctx.db.insert("messages", {
      sessionId,
      userId,
      role: "user",
      content: args.texto,
      creadoEn: ahora,
    });
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      userId,
      role: "assistant",
      content: "",
      estado: "pensando",
      creadoEn: ahora + 1,
    });
    await ctx.scheduler.runAfter(0, internal.agente.bucle.correr, {
      messageId,
      sessionId,
      userId,
      texto: args.texto,
      modo: args.modo,
      historial,
    });
    await ctx.scheduler.runAfter(630_000, internal.mensajes.marcarColgado, { messageId });
    return { sessionId, messageId };
  },
});

export const leerRespuesta = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.messageId);
    if (!m) return null;
    const metrics = (m.metrics ?? {}) as Record<string, any>;
    const verif = (m.verificacion ?? null) as Record<string, any> | null;
    const veredictos: Record<string, number> = {};
    for (const a of verif?.afirmaciones ?? []) {
      veredictos[a.veredicto] = (veredictos[a.veredicto] ?? 0) + 1;
    }
    return {
      estado: m.estado,
      error: m.error ?? null,
      plan: (m.plan ?? []) as unknown[],
      hops: (m.hops ?? []) as unknown[],
      fuentes: Array.isArray(m.sources) ? m.sources.length : 0,
      afirmaciones: verif?.afirmaciones?.length ?? 0,
      veredictos,
      fidelidad: verif?.fidelidad ?? null,
      cobertura: (verif?.cobertura ?? []).map((c: any) => `${c.id}:${c.estado}`),
      citas_sin_resolver: verif?.citas_sin_resolver ?? [],
      nota: verif?.nota ?? "",
      ms_total: metrics.ms_total ?? null,
      tokens: metrics.tokens ?? null,
      cost_usd: metrics.cost_usd ?? null,
      counters: metrics.counters ?? {},
      meta: metrics.meta ?? {},
      content: m.content,
    };
  },
});

// --- Ingesta de prueba -------------------------------------------------------
//
// El camino público de subida exige un administrador autenticado (mutaciones
// `documentos.urlDeSubida` y `documentos.registrar`). Desde la CLI no hay
// identidad, así que estas dos funciones internas hacen lo mismo sin auth para
// poder indexar un corpus de prueba con `npx convex run`.

export const urlDeSubidaDePrueba = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const registrarDePrueba = internalMutation({
  args: { storageId: v.id("_storage"), fileName: v.string(), sha256: v.string() },
  handler: async (ctx, args) => {
    const previo = await ctx.db
      .query("documents")
      .withIndex("porNombre", (q) => q.eq("fileName", args.fileName))
      .unique();
    const ahora = Date.now();
    const campos = {
      fileName: args.fileName,
      sha256: args.sha256,
      pages: 0,
      chunks: 0,
      status: "processing" as const,
      error: undefined,
      ingestadoEn: ahora,
      storageId: args.storageId,
    };
    let documentId;
    if (previo) {
      await ctx.db.patch(previo._id, campos);
      documentId = previo._id;
    } else {
      documentId = await ctx.db.insert("documents", campos);
    }
    await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.ingestar, { documentId });
    return { documentId };
  },
});

export const leerDocumento = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.documentId);
    if (!d) return null;
    const muestra = await ctx.db
      .query("chunks")
      .withIndex("porDocumento", (q) => q.eq("documentRef", d._id))
      .take(3);
    return {
      fileName: d.fileName,
      status: d.status,
      error: d.error ?? null,
      pages: d.pages,
      chunks: d.chunks,
      titulo: d.titulo ?? null,
      citation: d.citation ?? null,
      doi: d.doi ?? null,
      language: d.language ?? null,
      documentType: d.documentType ?? null,
      muestra: muestra.map((c) => ({
        page: c.page,
        section: c.section ?? null,
        chunkType: c.chunkType,
        texto: c.text.slice(0, 220),
      })),
    };
  },
});

/** Los últimos N turnos del asistente con su desglose de tiempo por
 *  componente, para saber dónde se va el reloj en una pregunta larga. */
export const ultimosTurnos = internalQuery({
  args: { n: v.number() },
  handler: async (ctx, args) => {
    const filas = await ctx.db.query("messages").order("desc").take(Math.min(60, args.n * 2));
    return filas
      .filter((m) => m.role === "assistant")
      .slice(0, args.n)
      .map((m) => {
        const met = (m.metrics ?? {}) as Record<string, any>;
        const porComp = (met.por_componente ?? {}) as Record<string, any>;
        return {
          messageId: m._id,
          estado: m.estado,
          ms_total: met.ms_total ?? null,
          plan: Array.isArray(m.plan) ? m.plan.length : 0,
          hops: Array.isArray(m.hops) ? m.hops.length : 0,
          por_componente: Object.fromEntries(
            Object.entries(porComp).map(([k, c]: [string, any]) => [
              k, { rondas: c.rondas, ms: Math.round(c.ms), prompt: c.prompt, completion: c.completion, reasoning: c.reasoning },
            ]),
          ),
          counters: met.counters ?? {},
          barrera: ((met.meta ?? {}) as any).barrera?.motivo ?? null,
          contenido: (m.content ?? "").slice(0, 80),
        };
      });
  },
});

/** Reindexa TODOS los documentos que conservan su fichero: pone `processing`
 *  y agenda la ingesta. Para cuando cambia el parser y hay que rehacer
 *  secciones, citas o troceado sin volver a subir nada. */
export const reindexarTodo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("documents").collect();
    let agendados = 0;
    for (const d of docs) {
      if (!d.storageId) continue;
      await ctx.db.patch(d._id, { status: "processing", error: undefined, ingestadoEn: Date.now() });
      await ctx.scheduler.runAfter(0, internal.ingesta.pipeline.ingestar, { documentId: d._id });
      agendados += 1;
    }
    return { agendados, total: docs.length };
  },
});

/** Borra un documento del corpus de prueba con sus fragmentos y su fichero,
 *  en lotes (una mutación no debe tocar cientos de fragmentos de 25 KB). Se
 *  reagenda a sí misma hasta que no quedan fragmentos. Para retirar los
 *  documentos sintéticos con cifras inventadas antes de que el índice lo use
 *  una médica. */
export const borrarDocumentoDePrueba = internalMutation({
  args: { fileName: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("documents")
      .withIndex("porNombre", (q) => q.eq("fileName", args.fileName))
      .first();
    if (!doc) return { estado: "no_existe" };
    const lote = await ctx.db
      .query("chunks")
      .withIndex("porDocumento", (q) => q.eq("documentRef", doc._id))
      .take(200);
    for (const c of lote) await ctx.db.delete(c._id);
    if (lote.length === 200) {
      await ctx.scheduler.runAfter(0, internal.pruebas.borrarDocumentoDePrueba, { fileName: args.fileName });
      return { estado: "borrando", borrados: lote.length };
    }
    if (doc.storageId) {
      try {
        await ctx.storage.delete(doc.storageId);
      } catch {
        /* ya no existe */
      }
    }
    await ctx.db.delete(doc._id);
    return { estado: "borrado", fragmentos: lote.length };
  },
});

/** Retira el usuario de pruebas con sus conversaciones, para que el panel de
 *  administración no muestre las decenas de preguntas de la sesión de estrés
 *  como si fueran uso real. Los mensajes se borran por lotes con la mutación
 *  interna de `mensajes`. */
export const borrarUsuarioDePrueba = internalMutation({
  args: {},
  handler: async (ctx) => {
    const usuario = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", CORREO_PRUEBAS))
      .first();
    if (!usuario) return { estado: "no_existe" };
    const sesiones = await ctx.db
      .query("sessions")
      .withIndex("porUsuario", (q) => q.eq("userId", usuario._id))
      .collect();
    for (const s of sesiones) await ctx.db.delete(s._id);
    const votos = await ctx.db
      .query("feedback")
      .withIndex("porUsuarioYMensaje", (q) => q.eq("userId", usuario._id))
      .collect();
    for (const f of votos) await ctx.db.delete(f._id);
    await ctx.scheduler.runAfter(0, internal.mensajes.borrarRestantes, { userId: usuario._id });
    await ctx.db.delete(usuario._id);
    return { estado: "borrado", sesiones: sesiones.length, votos: votos.length };
  },
});
