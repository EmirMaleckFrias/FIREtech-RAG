// Esquema de la base de datos. Reemplaza a Supabase (supabase/migrations/*.sql)
// y a la colección de Qdrant en un solo sitio.
//
// Decisiones que conviene no re-litigar:
//
// - **Los fragmentos viven aquí, no en una base vectorial aparte.** La tabla
//   `chunks` lleva su vector en `embedding` con un índice vectorial, y su texto
//   con un índice de búsqueda que puntúa por BM25. La búsqueda híbrida que
//   hacía Qdrant (denso + BM25 fusionados por rango) se replica consultando
//   los dos índices y fusionando en la acción; ver convex/search/hybrid.ts.
//   Límites comprobados en la documentación: el índice vectorial admite hasta
//   4096 dimensiones (los 3072 de text-embedding-3-large entran), devuelve
//   como máximo 256 resultados y acepta hasta 16 campos de filtro; el índice
//   de búsqueda exige exactamente un campo de texto y admite 16 de filtro.
//
// - **Los campos de filtro son los siete que en Qdrant eran índices de
//   payload.** Allí faltar uno no daba menos resultados, daba un 400 con el
//   modo estricto activado, y el síntoma que llegaba al usuario era "Error" al
//   subir un documento. Aquí un campo que no esté declarado en el índice
//   simplemente no se puede usar para filtrar, así que la lista tiene que
//   seguir completa.
//
// - **`sources`, `hops`, `verificacion` y `metrics` se guardan con la MISMA
//   forma que ya viaja al frontend.** Eran `jsonb` en Postgres y aquí son
//   `v.any()`: así el panel de fuentes, el informe de atribución y la tabla de
//   cobertura no cambian de contrato por la migración. Lo que sí gana el
//   mensaje es `metrics` y `verificacion` como columnas propias: la migración
//   009 de Supabase, que iba a guardar la telemetría junto al mensaje, nunca se
//   pudo aplicar porque nadie del equipo tenía acceso al proyecto. Aquí no hay
//   ese muro.
//
// - **No hay campo `environment`.** En Supabase existía una columna así porque
//   local y producción compartían una sola base de datos y había que separar lo
//   indexado en cada sitio. En Convex cada despliegue (dev y prod) tiene su
//   propia base, así que la separación es gratis y un filtro que se puede
//   olvidar es un filtro que acaba dando cero resultados en silencio, que es
//   exactamente el fallo que ya pasó con el filtro de idioma en Qdrant.
//
// - **El rol es `admin` | `lector`.** En Supabase el identificador seguía
//   siendo `vendedor` porque el check constraint no se podía cambiar sin
//   aplicar la migración 010, que quedó pendiente por lo mismo. La migración
//   a Convex es la ocasión de dejar el identificador que de verdad se quiere,
//   y el frontend ya mostraba "Lector" al usuario.
//
// - **El rol y el bloqueo van en `users`, la tabla de Convex Auth**, en vez de
//   en una tabla `profiles` aparte. En Supabase `profiles` existía porque
//   `auth.users` es un esquema ajeno que no se puede extender; aquí sí se
//   puede, y una tabla menos es una unión menos en cada comprobación de
//   permisos.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/** Estados de ingesta de un documento. */
export const estadoDocumento = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
);

/** Rol de negocio. Ver la nota de arriba sobre `vendedor` -> `lector`. */
export const rol = v.union(v.literal("admin"), v.literal("lector"));

/** Qué es un fragmento dentro de su documento: texto corrido o fila/bloque
 *  tabular. Sirve para titular la fuente por lo que es y para no recortar
 *  tablas cuando se reparte la evidencia entre documentos. */
export const tipoFragmento = v.union(v.literal("text"), v.literal("table"));

export default defineSchema({
  // Tablas de Convex Auth (users, authAccounts, authSessions, authRefreshTokens,
  // authVerificationCodes, authVerifiers, authRateLimits). `users` se extiende
  // con lo del negocio.
  ...authTables,
  users: defineTable({
    // Campos que escribe Convex Auth.
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Campos del negocio.
    rol: v.optional(rol),
    // Acceso revocado por un administrador. La cuenta y sus conversaciones se
    // conservan: es reversible, al revés que el borrado.
    bloqueado: v.optional(v.boolean()),
    creadoEn: v.optional(v.number()),
    ultimoAccesoEn: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("porRol", ["rol"]),

  // Correos que se convierten en administradores al darse de alta. Era la
  // tabla `admin_preasignados` con su trigger en Postgres; aquí la comprueba
  // el callback de creación de usuario en convex/auth.ts.
  adminsPreasignados: defineTable({
    email: v.string(),
    anadidoEn: v.number(),
  }).index("email", ["email"]),

  sessions: defineTable({
    titulo: v.string(),
    userId: v.id("users"),
    creadoEn: v.number(),
  }).index("porUsuario", ["userId", "creadoEn"]),

  messages: defineTable({
    sessionId: v.id("sessions"),
    // Se guarda también el dueño: listar y comprobar acceso sin ir a `sessions`
    // en cada mensaje, y un borrado de sesión no deja mensajes sin dueño.
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    // Mismas formas que ya consume el frontend (eran jsonb en Postgres).
    sources: v.optional(v.any()),
    hops: v.optional(v.any()),
    verificacion: v.optional(v.any()),
    metrics: v.optional(v.any()),
    // Plan de evidencia de esta pregunta, para que la tabla de cobertura se
    // pueda reconstruir al abrir una conversación antigua.
    plan: v.optional(v.any()),
    // Estado del turno del asistente. Convex no streamea por SSE: el agente
    // escribe aquí y el cliente se resuscribe, así que una respuesta sobrevive
    // a que se cierre el navegador y desaparece la clase de fallos de mensajes
    // a medias que había con el stream cortado.
    estado: v.optional(
      v.union(
        v.literal("pensando"),
        v.literal("buscando"),
        v.literal("redactando"),
        v.literal("revisando"),
        v.literal("listo"),
        v.literal("error"),
      ),
    ),
    error: v.optional(v.string()),
    creadoEn: v.number(),
  })
    .index("porSesion", ["sessionId", "creadoEn"])
    .index("porUsuario", ["userId", "creadoEn"]),

  feedback: defineTable({
    messageId: v.id("messages"),
    userId: v.id("users"),
    // 1 pulgar arriba, -1 abajo.
    rating: v.union(v.literal(1), v.literal(-1)),
    comentario: v.optional(v.string()),
    creadoEn: v.number(),
  })
    .index("porMensaje", ["messageId"])
    .index("porUsuarioYMensaje", ["userId", "messageId"]),

  documents: defineTable({
    fileName: v.string(),
    sha256: v.string(),
    pages: v.number(),
    chunks: v.number(),
    status: estadoDocumento,
    error: v.optional(v.string()),
    subidoPor: v.optional(v.id("users")),
    ingestadoEn: v.number(),
    // El fichero ORIGINAL queda guardado. Es lo que arregla el reindexado: en
    // Vercel el disco era efímero, así que reindexar exigía volver a subir el
    // documento y la respuesta era un 409 con `file_not_stored`.
    storageId: v.optional(v.id("_storage")),
    // Metadatos de la obra cuando el documento es un artículo.
    titulo: v.optional(v.string()),
    citation: v.optional(v.string()),
    doi: v.optional(v.string()),
    // Idioma detectado y formato, a nivel de documento. El inventario del
    // índice (cuántos documentos, de qué tipo, en qué idioma) se responde
    // desde esta tabla, que es pequeña, en vez de recorrer `chunks`: en Qdrant
    // esto eran facets sobre el payload.
    language: v.optional(v.string()),
    documentType: v.optional(v.string()),
    // De dónde salió el fichero. Ausente = subida manual anterior a la
    // sincronización con Notion. Con `notion`, `notionPageId` es la página de
    // la que se bajó (texto renderizado o adjunto) y quien lo gestiona es
    // `convex/notion/sync.ts`: si la página se archiva, el documento se va.
    origen: v.optional(v.union(v.literal("subida"), v.literal("notion"))),
    notionPageId: v.optional(v.string()),
  })
    // El nombre de archivo identifica el documento dentro del despliegue: es
    // el que usaban las rutas de subida, reindexado y borrado.
    .index("porNombre", ["fileName"])
    .index("porEstado", ["status"]),

  // Una fila por página de la base de Notion que se ha sincronizado. Es la
  // memoria que permite saltar páginas sin cambios (`lastEdited` es el
  // `last_edited_time` que devuelve Notion, tal cual, como cadena ISO: se
  // compara por igualdad, no por orden) y saber qué documentos borrar cuando
  // la página desaparece.
  notionPaginas: defineTable({
    pageId: v.string(),
    titulo: v.string(),
    lastEdited: v.string(),
    // Todos los documentos que salieron de esta página: el texto renderizado
    // y los adjuntos. `documentoTextoId` señala cuál es el del texto, para
    // reutilizar su fila al resincronizar sin confundirlo con un adjunto .md.
    documentIds: v.array(v.id("documents")),
    documentoTextoId: v.optional(v.id("documents")),
    sincronizadoEn: v.number(),
    // Último fallo al procesar la página, o "archivada" si NOTION_DELETE_ARCHIVED
    // está apagado y la página ya no está en la base. Una fila con error se
    // reintenta en la siguiente corrida aunque `lastEdited` no cambie.
    error: v.optional(v.string()),
  }).index("porPageId", ["pageId"]),

  // Corridas de la sincronización con Notion, para el bloque de estado que ve
  // el administrador. Se conservan solo las últimas 20 (ver notion/datos.ts).
  notionSincronizaciones: defineTable({
    empezadoEn: v.number(),
    terminadoEn: v.optional(v.number()),
    paginas: v.number(),
    // Contadores PARCIALES mientras la corrida está `running`: la acción los
    // va escribiendo página a página y la UI, suscrita, pinta el avance en
    // vivo. Al cerrar la corrida quedan como cifras finales.
    nuevos: v.number(),
    actualizados: v.number(),
    borrados: v.number(),
    errores: v.array(v.string()),
    estado: v.union(v.literal("running"), v.literal("ok"), v.literal("error")),
    // Progreso en vivo. `paginasTotal` son las páginas activas de la base
    // (sin archivadas ni excluidas), `paginasProcesadas` cuántas se han
    // mirado ya (incluidas las que no cambiaron) y `paginaActual` el título
    // de la que se está leyendo. Se limpian al cerrar.
    paginasTotal: v.optional(v.number()),
    paginasProcesadas: v.optional(v.number()),
    paginaActual: v.optional(v.string()),
  }),

  // La conexión con Notion hecha desde la app (OAuth público). UNA fila como
  // mucho: conectar de nuevo la reemplaza. El `accessToken` NUNCA sale al
  // cliente: solo lo leen la acción de sincronización y la que lista las
  // bases, a través de funciones internas. Los tokens de Notion no caducan,
  // así que no hay refresco. Si no hay fila, la sincronización cae a
  // NOTION_TOKEN / NOTION_DATABASE_ID por compatibilidad.
  notionConexion: defineTable({
    accessToken: v.string(),
    botId: v.string(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceIcon: v.optional(v.string()),
    conectadoPor: v.id("users"),
    conectadoEn: v.number(),
    // La base elegida por la administradora en el desplegable. Sin ella la
    // conexión existe pero no hay nada que sincronizar.
    databaseId: v.optional(v.string()),
    databaseTitulo: v.optional(v.string()),
  }),

  // Estados pendientes del OAuth de Notion: uno por clic en "Conectar con
  // Notion". El callback lo busca, comprueba que no caducó y lo BORRA, así un
  // `state` solo se puede usar una vez. `origen` es la URL del frontend desde
  // la que se pulsó, por si el despliegue no tiene SITE_URL.
  notionEstadosOauth: defineTable({
    state: v.string(),
    userId: v.id("users"),
    origen: v.optional(v.string()),
    creadoEn: v.number(),
    expiraEn: v.number(),
  }).index("porState", ["state"]),

  // Los fragmentos indexados: lo que era la colección de Qdrant.
  chunks: defineTable({
    text: v.string(),
    // 3072 de text-embedding-3-large. El índice vectorial admite hasta 4096.
    embedding: v.array(v.float64()),
    sourceFile: v.string(),
    page: v.number(),
    sourcePages: v.optional(v.array(v.number())),
    section: v.optional(v.string()),
    chunkType: tipoFragmento,
    projectId: v.optional(v.string()),
    documentId: v.optional(v.string()),
    documentVersion: v.optional(v.string()),
    documentType: v.optional(v.string()),
    language: v.optional(v.string()),
    titulo: v.optional(v.string()),
    citation: v.optional(v.string()),
    doi: v.optional(v.string()),
    metadata: v.optional(v.any()),
    // Para borrar o reindexar un documento sin recorrer la tabla entera.
    documentRef: v.id("documents"),
  })
    // Los siete campos que en Qdrant eran índices de payload.
    .vectorIndex("porEmbedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: [
        "projectId",
        "documentId",
        "documentVersion",
        "documentType",
        "language",
        "sourceFile",
        "chunkType",
      ],
    })
    // El lado léxico de la búsqueda híbrida. Puntúa con BM25 más proximidad y
    // coincidencias exactas, que es lo que hacía falta para términos técnicos
    // como p-tau217 o MMSE, donde el vector denso se queda corto.
    .searchIndex("porTexto", {
      searchField: "text",
      filterFields: [
        "projectId",
        "documentId",
        "documentVersion",
        "documentType",
        "language",
        "sourceFile",
        "chunkType",
      ],
    })
    .index("porDocumento", ["documentRef"])
    .index("porArchivo", ["sourceFile"]),

  // Caché del plan de evidencia por pregunta normalizada.
  //
  // El planner es una llamada al modelo y, aun a temperatura 0, redacta las
  // subconsultas distinto en cada corrida; medido el 4 sep 2026 con la misma
  // pregunta cinco veces: mismos tres puntos, pero huellas de evidencia
  // distintas porque cambiaba la redacción de las consultas. Con la caché, la
  // misma pregunta (misma clave: texto normalizado + modelo + versión del
  // prompt) reutiliza el mismo plan y la recuperación pasa a ser una función
  // determinista del índice. La clave lleva la versión del prompt para que un
  // cambio del planner invalide las entradas solas.
  planes: defineTable({
    clave: v.string(),
    pregunta: v.string(),
    modelo: v.string(),
    version: v.string(),
    clase: v.optional(v.string()),
    items: v.any(),
    preguntaEn: v.string(),
    creadoEn: v.number(),
    usos: v.number(),
  }).index("porClave", ["clave"]),

  // Caché de vectores de CONSULTA por texto y modelo.
  //
  // Medido el 4 sep 2026: con el plan ya cacheado, la misma pregunta seguía
  // dando huellas de evidencia distintas en cada corrida. El motivo es que el
  // proveedor de embeddings no devuelve exactamente el mismo vector para el
  // mismo texto (ruido en los últimos decimales), y en los empates cercanos
  // del vecino más próximo eso reordena candidatos. Con el vector cacheado, el
  // lado denso de la búsqueda es determinista de verdad. Sin caducidad: el
  // vector de un texto dado no cambia mientras no cambie el modelo, que forma
  // parte de la clave.
  consultasEmbebidas: defineTable({
    clave: v.string(),
    modelo: v.string(),
    vector: v.array(v.float64()),
    creadoEn: v.number(),
  }).index("porClave", ["clave"]),

  // Caché de veredictos del calificador por (consulta, evidencia necesaria,
  // fragmento, modelo).
  //
  // Es la tercera y última fuente de variación de la recuperación. Medido el
  // 4 sep 2026: con el plan y los vectores de consulta ya cacheados, la misma
  // pregunta seguía dando conjuntos de evidencia con un solape del 45 al 75 %,
  // porque el calificador cambia de opinión en los fragmentos marginales
  // (parcial frente a no) de una corrida a otra. Con el veredicto cacheado,
  // repetir una pregunta reproduce exactamente la misma evidencia, y además
  // se ahorra la llamada. La clave lleva el id del fragmento, así que un
  // reindexado (ids nuevos) invalida las entradas por sí solo.
  calificaciones: defineTable({
    clave: v.string(),
    grado: v.string(),
    creadoEn: v.number(),
  }).index("porClave", ["clave"]),

  // Corridas de ingesta, como la tabla `ingestion_runs`.
  ingestionRuns: defineTable({
    empezadoEn: v.number(),
    terminadoEn: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    stats: v.optional(v.any()),
    error: v.optional(v.string()),
  }).index("porEstado", ["status"]),
});
