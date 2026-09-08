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
import { anotarPregunta, borrarDeUsuario, claveVotos, sumar } from "./contadores";
import { LOTE_CHUNKS } from "./documentos";
import type { Doc } from "./_generated/dataModel";
import { ajustes } from "./lib/config";

const CORREO_PRUEBAS = "pruebas@airobotix.net";

export const prepararPregunta = internalMutation({
  args: {
    texto: v.string(),
    modo: v.string(),
    sessionId: v.optional(v.id("sessions")),
    // Desde quién se pregunta. Importa: cada persona tiene su propio corpus
    // (ver `propietario` en schema.ts), así que la misma pregunta desde dos
    // cuentas distintas busca en índices distintos. Sin correo se usa la
    // cuenta de pruebas, que no tiene documentos.
    correo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const correo = args.correo ?? CORREO_PRUEBAS;
    let usuario = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", correo))
      .unique();
    const ahora = Date.now();
    const userId =
      usuario?._id ??
      (await ctx.db.insert("users", {
        email: correo,
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
      .withIndex("porSesionYCreacion", (q) => q.eq("sessionId", sessionId))
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
    await anotarPregunta(ctx, userId, ahora, { sesionNueva: args.sessionId === undefined });
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
  args: {
    // A qué corpus entra. Se da por correo y no por id para poder llamarlo
    // desde la CLI sin mirar la tabla de cuentas antes.
    correo: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    const dueno = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.correo))
      .first();
    if (!dueno) throw new Error(`no existe la cuenta ${args.correo}`);
    const previo = await ctx.db
      .query("documents")
      .withIndex("porPropietarioYNombre", (q) =>
        q.eq("propietario", dueno._id).eq("fileName", args.fileName),
      )
      .unique();
    const ahora = Date.now();
    const campos = {
      fileName: args.fileName,
      sha256: args.sha256,
      propietario: dueno._id,
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
  args: { fileName: v.optional(v.string()), correo: v.optional(v.string()), documentId: v.optional(v.id("documents")) },
  handler: async (ctx, args) => {
    // El documento se resuelve UNA vez (por nombre y, si se da, por dueña) y
    // las vueltas siguientes van por id. Antes la reagenda volvía a buscar
    // por nombre y sin correo, y con dos cuentas que tenían un fichero del
    // mismo nombre la segunda vuelta borraba el de la otra cuenta.
    let doc = args.documentId ? await ctx.db.get(args.documentId) : null;
    if (!doc && args.fileName) {
      const dueno = args.correo
        ? await ctx.db.query("users").withIndex("email", (q) => q.eq("email", args.correo!)).first()
        : null;
      if (args.correo && !dueno) return { estado: "no_existe" };
      doc = dueno
        ? await ctx.db
            .query("documents")
            .withIndex("porPropietarioYNombre", (q) => q.eq("propietario", dueno._id).eq("fileName", args.fileName!))
            .first()
        : // Sin correo: el primero con ese nombre, de quien sea. Solo para
          // limpiar restos desde la CLI, donde no hay identidad.
          (await ctx.db.query("documents").collect()).find((d) => d.fileName === args.fileName) ?? null;
    }
    if (!doc) return { estado: "no_existe" };
    const lote = await ctx.db
      .query("chunks")
      .withIndex("porDocumento", (q) => q.eq("documentRef", doc._id))
      .take(LOTE_CHUNKS);
    for (const c of lote) await ctx.db.delete(c._id);
    if (lote.length === LOTE_CHUNKS) {
      await ctx.scheduler.runAfter(0, internal.pruebas.borrarDocumentoDePrueba, { documentId: doc._id });
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
  args: { email: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const correo = args.email ?? CORREO_PRUEBAS;
    const usuario = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", correo))
      .first();
    if (!usuario) return { estado: "no_existe" };
    const sesiones = await ctx.db
      .query("sessions")
      .withIndex("porUsuarioYCreacion", (q) => q.eq("userId", usuario._id))
      .collect();
    for (const s of sesiones) await ctx.db.delete(s._id);
    const votos = await ctx.db
      .query("feedback")
      .withIndex("porUsuarioYMensaje", (q) => q.eq("userId", usuario._id))
      .collect();
    for (const f of votos) {
      await sumar(ctx, claveVotos(f.rating), -1);
      await ctx.db.delete(f._id);
    }
    await borrarDeUsuario(ctx, usuario._id);
    await ctx.scheduler.runAfter(0, internal.mensajes.borrarRestantes, { userId: usuario._id });
    // Y su corpus, igual que `usuarios.borrar`: sin esto quedaban documentos
    // con un propietario que ya no existe, invisibles para todo el mundo y
    // ocupando almacenamiento. Pasó en producción con una cuenta de prueba.
    await ctx.scheduler.runAfter(0, internal.documentos.borrarCorpusDeUsuario, {
      userId: usuario._id,
    });
    // Y sus conexiones (Notion, Google Drive, OneDrive) con su rastro, como
    // hace `usuarios.borrar`: un token de una cuenta que ya no existe no debe
    // quedarse en la base.
    const notion = await ctx.db
      .query("notionConexion")
      .withIndex("porUsuario", (q) => q.eq("conectadoPor", usuario._id))
      .collect();
    for (const c of notion) await ctx.db.delete(c._id);
    await ctx.scheduler.runAfter(0, internal.notion.datos.borrarRastroDeUsuario, { propietario: usuario._id });
    const nubes = await ctx.db
      .query("nubeConexion")
      .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", usuario._id))
      .collect();
    for (const c of nubes) await ctx.db.delete(c._id);
    await ctx.scheduler.runAfter(0, internal.nube.datos.borrarRastroDeUsuario, { propietario: usuario._id });

    // Credenciales y sesiones de Convex Auth. Las tablas son diminutas, así
    // que se filtran recorriéndolas; el orden importa: los refresh tokens
    // cuelgan de la sesión.
    const cuentas = await ctx.db
      .query("authAccounts")
      .filter((q) => q.eq(q.field("userId"), usuario._id))
      .collect();
    for (const c of cuentas) await ctx.db.delete(c._id);
    const abiertas = await ctx.db
      .query("authSessions")
      .filter((q) => q.eq(q.field("userId"), usuario._id))
      .collect();
    for (const s of abiertas) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .filter((q) => q.eq(q.field("sessionId"), s._id))
        .collect();
      for (const t of tokens) await ctx.db.delete(t._id);
      await ctx.db.delete(s._id);
    }

    await ctx.db.delete(usuario._id);
    return {
      estado: "borrado",
      correo,
      sesiones: sesiones.length,
      votos: votos.length,
      cuentas: cuentas.length,
      sesionesAbiertas: abiertas.length,
    };
  },
});

/** Comprueba en el runtime real que una mutación puede generar aleatoriedad
 *  (Convex la ofrece de forma determinista por transacción). El flujo OAuth de
 *  Notion depende de ello para el `state`. */
export const probarAleatorio = internalMutation({
  args: {},
  handler: async () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return { uuid: crypto.randomUUID(), bytes: Array.from(bytes) };
  },
});

/** Asciende (o degrada) una cuenta por correo. Solo para comprobaciones E2E
 *  con una cuenta de prueba; el camino real es `usuarios.actualizar`. */
export const hacerAdminDePrueba = internalMutation({
  args: { email: v.string(), admin: v.boolean() },
  handler: async (ctx, args) => {
    const u = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", args.email)).first();
    if (!u) return { estado: "no_existe" };
    await ctx.db.patch(u._id, { rol: args.admin ? "admin" : "lector" });
    return { estado: "ok", rol: args.admin ? "admin" : "lector" };
  },
});

/** Diagnóstico del flujo OAuth de Notion: qué credenciales ve el despliegue,
 *  qué redirect URI hay que registrar en Notion y si el sitio de las rutas
 *  HTTP (`CONVEX_SITE_URL`, que la pone la plataforma) llega de verdad. Sin
 *  esto, un `iniciar` fallaba con "este despliegue no puede recibir la
 *  respuesta de Notion" sin decir por qué. No devuelve ningún secreto: solo
 *  si está o no, y su longitud. */
export const diagnosticoNotion = internalQuery({
  args: {},
  handler: async () => {
    const a = ajustes();
    return {
      clientId: a.notionClientId ? `presente (${a.notionClientId.length} car.)` : "FALTA",
      clientSecret: a.notionClientSecret ? `presente (${a.notionClientSecret.length} car.)` : "FALTA",
      convexSiteUrl: a.convexSiteUrl || "FALTA",
      siteUrl: a.siteUrl || "FALTA",
      redirectUriARegistrar: a.convexSiteUrl ? `${a.convexSiteUrl}/notion/callback` : "no se puede calcular",
      habilitada: Boolean(a.notionClientId && a.notionClientSecret),
    };
  },
});

/** Lo mismo para las nubes de ficheros: qué credenciales de aplicación ve el
 *  despliegue y qué URI de redirección hay que registrar en Google Cloud y en
 *  Microsoft Entra. Sin secretos: solo si están y su longitud. */
export const diagnosticoNube = internalQuery({
  args: {},
  handler: async () => {
    const a = ajustes();
    const presente = (valor: string) => (valor ? `presente (${valor.length} car.)` : "FALTA");
    return {
      convexSiteUrl: a.convexSiteUrl || "FALTA",
      siteUrl: a.siteUrl || "FALTA",
      google: {
        clientId: presente(a.googleClientId),
        clientSecret: presente(a.googleClientSecret),
        redirectUriARegistrar: a.convexSiteUrl ? `${a.convexSiteUrl}/google/callback` : "no se puede calcular",
        habilitada: Boolean(a.googleClientId && a.googleClientSecret),
      },
      onedrive: {
        clientId: presente(a.microsoftClientId),
        clientSecret: presente(a.microsoftClientSecret),
        redirectUriARegistrar: a.convexSiteUrl ? `${a.convexSiteUrl}/onedrive/callback` : "no se puede calcular",
        habilitada: Boolean(a.microsoftClientId && a.microsoftClientSecret),
      },
      periodicaMinutos: a.nubeSyncMinutes,
    };
  },
});

/** Siembra una conexión con una nube en una cuenta de prueba, con tokens que
 *  NO valen: para revisar el bloque conectado del panel (cuenta, carpetas,
 *  "Volver a conectar" cuando el proveedor rechaza la renovación) sin pasar
 *  por el consentimiento real. Solo para E2E; se limpia con
 *  `borrarUsuarioDePrueba`. */
export const sembrarConexionNubeDePrueba = internalMutation({
  args: {
    email: v.string(),
    proveedor: v.union(v.literal("google"), v.literal("onedrive")),
    necesitaReconexion: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const u = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", args.email)).first();
    if (!u) return { estado: "no_existe" };
    const previas = await ctx.db
      .query("nubeConexion")
      .withIndex("porUsuarioYProveedor", (q) => q.eq("conectadoPor", u._id).eq("proveedor", args.proveedor))
      .collect();
    for (const p of previas) await ctx.db.delete(p._id);
    const id = await ctx.db.insert("nubeConexion", {
      proveedor: args.proveedor,
      accessToken: "token-de-prueba-que-no-vale",
      refreshToken: "refresco-de-prueba-que-no-vale",
      expiraEn: Date.now() - 1,
      cuentaId: "cuenta-de-prueba",
      cuentaNombre: "Dra. de Prueba",
      cuentaCorreo: args.email,
      conectadoPor: u._id,
      conectadoEn: Date.now(),
      carpetas: [
        { id: "carpeta-prueba-1", nombre: "Protocolos", ruta: "Mi unidad / Clínica / Protocolos" },
        { id: "carpeta-prueba-2", nombre: "Guías 2026", ruta: "Mi unidad / Guías 2026" },
      ],
      necesitaReconexion: args.necesitaReconexion,
    });
    return { estado: "ok", id };
  },
});

/** Siembra documentos VARIADOS en el corpus de una cuenta, sin ingesta: para
 *  revisar el diseño de la sección de documentos con datos que se parezcan a
 *  los de verdad (papers con su cita, una hoja sin título, una imagen, uno
 *  indexándose y uno que falló) sin gastar embeddings ni esperar dos minutos.
 *
 *  No escribe ni un fragmento, así que estos documentos NO responden nada: es
 *  para mirar la pantalla, no para preguntar. */
export const sembrarDocumentosDePrueba = internalMutation({
  args: { correo: v.string() },
  handler: async (ctx, { correo }) => {
    const dueno = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", correo))
      .first();
    if (!dueno) throw new Error(`no existe la cuenta ${correo}`);
    const dia = 86_400_000;
    const ahora = Date.now();
    const muestras: Array<Partial<Doc<"documents">> & { fileName: string }> = [
      { fileName: "PMC13390017.pdf", chunks: 52, pages: 12, titulo: "Prognostic value of plasma %p-tau217 in cognitively unimpaired older adults", citation: "Silva-Rodríguez et al., 2026", ingestadoEn: ahora - 300_000 },
      { fileName: "PMC13382852.pdf", chunks: 57, pages: 15, titulo: "Performance of Alzheimer Disease Plasma Biomarkers in Patients With Prion Diseases", citation: "Coysh et al., 2026", ingestadoEn: ahora - dia },
      { fileName: "PMC12777541.pdf", chunks: 5, pages: 3, titulo: "Head to head comparison of plasma phosphorylated tau 217 assays in real life memory clinic in Thailand", citation: "Luechaipanit et al., 2025", ingestadoEn: ahora - dia * 2 },
      { fileName: "PMC12739034.pdf", chunks: 3, pages: 3, titulo: "Diagnostic and discriminative accuracy of plasma phosphorylated tau 217 for symptomatic Alzheimer's disease in a Chinese cohort", citation: "Che et al., 2025", ingestadoEn: ahora - dia * 2 },
      { fileName: "guia_dcl_biomarcadores.docx", chunks: 18, pages: 18, titulo: "Guía de práctica clínica: biomarcadores plasmáticos en deterioro cognitivo leve", ingestadoEn: ahora - dia * 4 },
      { fileName: "biomarcadores_plasma.xlsx", chunks: 5, pages: 5, ingestadoEn: ahora - dia * 6 },
      { fileName: "protocolo-extraccion.png", chunks: 2, pages: 1, titulo: "Protocolo de extracción y procesamiento de muestras", ingestadoEn: ahora - dia * 9 },
      { fileName: "notion-la-literatura.md", chunks: 2, pages: 2, origen: "notion" as const, notionPageId: "p1", ingestadoEn: ahora - dia * 11 },
      { fileName: "notion-brand-guidelines.md", chunks: 1, pages: 1, origen: "notion" as const, notionPageId: "p2", ingestadoEn: ahora - dia * 11 },
      { fileName: "10_influenza_extenso.pdf", chunks: 20, pages: 11, citation: "Epidemiology et al., 2024", ingestadoEn: ahora - dia * 40 },
      { fileName: "consenso-2025.pdf", chunks: 0, pages: 0, status: "processing" as const, ingestadoEn: ahora - 20_000 },
      { fileName: "escaneo-ilegible.pdf", chunks: 0, pages: 0, status: "failed" as const, error: "'escaneo-ilegible.pdf' no contiene texto legible: ni texto propio ni texto reconocible en sus imágenes.", ingestadoEn: ahora - dia * 3 },
    ];
    let creados = 0;
    for (const m of muestras) {
      const previo = await ctx.db
        .query("documents")
        .withIndex("porPropietarioYNombre", (q) =>
          q.eq("propietario", dueno._id).eq("fileName", m.fileName),
        )
        .first();
      if (previo) continue;
      await ctx.db.insert("documents", {
        sha256: `${"0".repeat(60)}${String(creados).padStart(4, "0")}`,
        pages: 0,
        chunks: 0,
        status: "ready",
        propietario: dueno._id,
        ingestadoEn: ahora,
        origen: "subida",
        ...m,
      });
      creados += 1;
    }
    return { creados };
  },
});
