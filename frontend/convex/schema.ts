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

/** Avisos de una ingesta, ver `ingesta/tipos.ts` (`AvisosIngesta`). */
export const avisosIngesta = v.object({
  sinLeer: v.number(),
  omitidas: v.number(),
  recortados: v.number(),
  motivo: v.optional(v.string()),
});

/** De dónde salió un documento: subida manual, o una de las sincronizaciones
 *  (Notion, Google Drive, OneDrive). Compartido con `documentos.ts` y con los
 *  módulos de sincronización para que un origen nuevo se añada en un sitio. */
export const origenDocumento = v.union(
  v.literal("subida"),
  v.literal("notion"),
  v.literal("google"),
  v.literal("onedrive"),
);

/** Las nubes de ficheros con las que se puede conectar (convex/nube/). */
export const proveedorNube = v.union(v.literal("google"), v.literal("onedrive"));

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
  }).index("porUsuarioYCreacion", ["userId", "creadoEn"]),

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
        // La usuaria lo detuvo (`mensajes.detener`). Estado FINAL: el turno
        // no publica texto, conserva lo que llevara buscado, y ninguna
        // escritura posterior del agente lo puede pisar (ver
        // `mensajes.actualizarTurno`).
        v.literal("cancelado"),
      ),
    ),
    error: v.optional(v.string()),
    creadoEn: v.number(),
  })
    .index("porSesionYCreacion", ["sessionId", "creadoEn"])
    .index("porUsuarioYCreacion", ["userId", "creadoEn"])
    // Para el barrido de turnos colgados (`mensajes.cerrarColgados`): los
    // que siguen en un estado no final pasado el presupuesto, leídos por
    // estado y antigüedad sin recorrer la tabla, que cada respuesta arrastra
    // sus fuentes y sus hops.
    .index("porEstadoYCreacion", ["estado", "creadoEn"]),

  // Contadores agregados, uno por clave (ver convex/contadores.ts). Existen
  // porque Convex no tiene agregados y contar preguntas recorriendo
  // `messages` leía cada respuesta con sus fuentes y sus hops: aguantaba unos
  // cientos de respuestas dentro de los 16 MiB de una transacción y después
  // Ajustes > Sistema y Ajustes > Usuarios fallaban. Se actualizan en la misma
  // transacción que escribe o borra lo que cuentan, y se pueden reconstruir
  // desde las tablas (`contadores.reconstruir`).
  contadores: defineTable({
    clave: v.string(),
    valor: v.number(),
  }).index("porClave", ["clave"]),

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
    // De quién es este documento. Es una FRONTERA, no un dato informativo:
    // cada persona tiene su propio corpus y una búsqueda solo puede ver los
    // documentos de quien pregunta. Antes había un `subidoPor` opcional, que
    // solo servía para saber quién lo había subido y que al borrar la cuenta
    // se ponía a vacío; aquí el documento pertenece a alguien y si esa cuenta
    // se borra, sus documentos se van con ella.
    propietario: v.id("users"),
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
    // Con `google` u `onedrive`, `nubeFicheroId` es el id del fichero en esa
    // nube y quien lo gestiona es `convex/nube/sync.ts`: si el fichero sale
    // de la carpeta elegida, el documento se va.
    origen: v.optional(origenDocumento),
    notionPageId: v.optional(v.string()),
    nubeFicheroId: v.optional(v.string()),
    // Lo que la ingesta no pudo leer del todo: páginas escaneadas cuyo OCR
    // falló, imágenes omitidas por el tope, fragmentos recortados. Un
    // documento "listo" con avisos se consulta igual, pero la ficha lo dice y
    // ofrece reintentar. Antes esto solo quedaba en `ingestionRuns`, que no
    // lee nadie, y un escaneo con 39 de 40 páginas sin leer se veía perfecto.
    avisos: v.optional(avisosIngesta),
    // La corrida de ingesta que POSEE el documento ahora mismo (ver
    // ingesta/escritura.ts `reclamarDocumento`). Es lo que impide que dos
    // ingestas del mismo documento escriban a la vez: cada escritura de
    // fragmentos comprueba que la corrida sigue siendo la dueña, y la más
    // reciente siempre gana. `reindexar` la consulta para saber si hay una
    // ingesta viva de verdad (con latido), en vez de adivinarlo por la fecha.
    ingestaRunId: v.optional(v.id("ingestionRuns")),
  })
    // El nombre de archivo identifica el documento DENTRO DEL CORPUS DE UNA
    // PERSONA, no del despliegue: dos usuarias pueden tener cada una su
    // "guia.pdf" sin chocar. Todos los índices empiezan por `propietario`
    // porque no hay ni una lectura legítima que cruce corpus.
    .index("porPropietarioYNombre", ["propietario", "fileName"])
    .index("porPropietario", ["propietario"])
    .index("porPropietarioYEstado", ["propietario", "status"])
    // Para el dedupe de adjuntos de Notion: el mismo fichero, venga de otra
    // página o de una subida manual, no se indexa dos veces. Antes esto
    // recorría TODOS los documentos de la persona una vez por adjunto, o sea
    // cuadrático sobre el tamaño del corpus; con miles de documentos y muchos
    // adjuntos era el primer sitio que se atragantaba.
    .index("porPropietarioYSha256", ["propietario", "sha256"]),

  // Una fila por página de la base de Notion que se ha sincronizado. Es la
  // memoria que permite saltar páginas sin cambios (`lastEdited` es el
  // `last_edited_time` que devuelve Notion, tal cual, como cadena ISO: se
  // compara por igualdad, no por orden) y saber qué documentos borrar cuando
  // la página desaparece.
  notionPaginas: defineTable({
    // De quién es esta sincronización: cada persona conecta su propio Notion.
    propietario: v.id("users"),
    // De qué base salió. Es necesario, no informativo: al terminar de recorrer
    // una base se retira del índice lo que ya no está en ELLA, y sin este
    // campo las páginas de las otras bases parecerían desaparecidas y se
    // borraría su corpus. Ver `notion/sync.ts`.
    databaseId: v.string(),
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
  })
    .index("porPropietarioYPageId", ["propietario", "pageId"])
    .index("porPropietarioYBase", ["propietario", "databaseId"]),

  // Corridas de la sincronización con Notion, para el bloque de estado que ve
  // el administrador. Se conservan solo las últimas 20 (ver notion/datos.ts).
  notionSincronizaciones: defineTable({
    propietario: v.id("users"),
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
  }).index("porPropietario", ["propietario"]),

  // La conexión con Notion hecha desde la app (OAuth público). UNA fila POR
  // PERSONA: conectar de nuevo reemplaza la suya y no toca la de nadie más.
  // El `accessToken` NUNCA sale al cliente: solo lo leen la acción de
  // sincronización y la que lista las bases, a través de funciones internas.
  // Los tokens de Notion no caducan, así que no hay refresco.
  //
  // Ya no hay respaldo por variables de entorno (NOTION_TOKEN /
  // NOTION_DATABASE_ID): con un corpus por persona, un token del despliegue
  // no tendría dueño y sus documentos no serían de nadie.
  notionConexion: defineTable({
    accessToken: v.string(),
    botId: v.string(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceIcon: v.optional(v.string()),
    conectadoPor: v.id("users"),
    conectadoEn: v.number(),
    // Las bases de datos que ha elegido sincronizar. VARIAS a propósito: una
    // persona puede tener sus guías en una base y sus protocolos en otra
    // (`Docs` y `Tasks`, por ejemplo), y obligarla a elegir una sola era una
    // limitación de esta aplicación, no de Notion. Lista vacía = conectada
    // pero sin nada que sincronizar todavía.
    //
    // Va como array y no como tabla aparte porque son un puñado por persona y
    // siempre se leen y se reemplazan juntas (el desplegable manda la
    // selección completa).
    bases: v.array(v.object({ id: v.string(), titulo: v.string() })),
  }).index("porUsuario", ["conectadoPor"]),

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
  })
    .index("porState", ["state"])
    // Para limpiar los caducados y los de una cuenta sin recorrer la tabla.
    .index("porExpira", ["expiraEn"])
    .index("porUsuario", ["userId"]),

  // ---------------------------------------------------------------------
  // Nubes de ficheros: Google Drive y OneDrive (convex/nube/). Mismo modelo
  // que Notion, generalizado a un `proveedor`: UNA conexión por persona y
  // proveedor, las carpetas que eligió sincronizar, una fila por fichero
  // conocido y el histórico de corridas. Todo lleva `propietario` porque
  // cada persona sincroniza a su propio corpus.
  // ---------------------------------------------------------------------

  // La conexión OAuth con una nube. A diferencia de Notion, estos tokens
  // CADUCAN (una hora) y se renuevan con `refreshToken`; `expiraEn` dice
  // hasta cuándo vale el de acceso. Ninguno de los dos sale al cliente.
  // `necesitaReconexion` se pone cuando el proveedor rechaza la renovación
  // (la persona revocó el permiso, cambió la contraseña): la UI ofrece
  // entonces "Volver a conectar" en vez de fallar cada hora en silencio.
  nubeConexion: defineTable({
    proveedor: proveedorNube,
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiraEn: v.number(),
    // La cuenta del proveedor con la que se conectó, para enseñar "Conectado
    // como …" y para conservar las carpetas elegidas si vuelve a conectar la
    // MISMA cuenta.
    cuentaId: v.string(),
    cuentaNombre: v.string(),
    cuentaCorreo: v.optional(v.string()),
    cuentaImagen: v.optional(v.string()),
    conectadoPor: v.id("users"),
    conectadoEn: v.number(),
    // Las carpetas que sincroniza, con su ruta legible para la UI. Vacía =
    // conectada pero sin nada que sincronizar todavía.
    carpetas: v.array(v.object({ id: v.string(), nombre: v.string(), ruta: v.string() })),
    necesitaReconexion: v.optional(v.boolean()),
  }).index("porUsuarioYProveedor", ["conectadoPor", "proveedor"]),

  // Un fichero conocido de una carpeta sincronizada: la memoria que permite
  // saltar los que no cambiaron (`version` es lo que el proveedor da para
  // detectar cambios: el md5 o la fecha en Google Drive, el cTag en OneDrive;
  // se compara por igualdad) y saber qué documento retirar cuando el fichero
  // desaparece. `documentId` ausente = fichero visto pero sin documento
  // propio (era un duplicado exacto de algo ya indexado).
  nubeFicheros: defineTable({
    propietario: v.id("users"),
    proveedor: proveedorNube,
    // La carpeta ELEGIDA bajo la que se vio (no la subcarpeta inmediata):
    // el cálculo de "qué ha desaparecido" es por carpeta elegida.
    carpetaId: v.string(),
    ficheroId: v.string(),
    // Ruta relativa dentro de la carpeta, para los avisos y el progreso.
    nombre: v.string(),
    version: v.string(),
    documentId: v.optional(v.id("documents")),
    sincronizadoEn: v.number(),
    error: v.optional(v.string()),
  })
    .index("porPropietarioYFichero", ["propietario", "proveedor", "ficheroId"])
    .index("porPropietarioYCarpeta", ["propietario", "proveedor", "carpetaId"]),

  // Corridas de la sincronización con una nube, con el mismo progreso en vivo
  // que las de Notion. Se conservan las últimas 20 por persona y proveedor.
  nubeSincronizaciones: defineTable({
    propietario: v.id("users"),
    proveedor: proveedorNube,
    empezadoEn: v.number(),
    terminadoEn: v.optional(v.number()),
    ficheros: v.number(),
    nuevos: v.number(),
    actualizados: v.number(),
    borrados: v.number(),
    errores: v.array(v.string()),
    estado: v.union(v.literal("running"), v.literal("ok"), v.literal("error")),
    ficherosTotal: v.optional(v.number()),
    ficherosProcesados: v.optional(v.number()),
    ficheroActual: v.optional(v.string()),
  }).index("porPropietarioYProveedor", ["propietario", "proveedor"]),

  // Estados pendientes del OAuth con una nube: uno por clic en "Conectar".
  // Mismas reglas que los de Notion: se consumen una sola vez y caducan.
  nubeEstadosOauth: defineTable({
    state: v.string(),
    proveedor: proveedorNube,
    userId: v.id("users"),
    origen: v.optional(v.string()),
    creadoEn: v.number(),
    expiraEn: v.number(),
  })
    .index("porState", ["state"])
    .index("porExpira", ["expiraEn"])
    .index("porUsuario", ["userId"]),

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
    // Copiado del documento al insertar (ver ingesta/escritura.ts). Está
    // duplicado aquí a propósito: los dos índices de búsqueda filtran sobre
    // campos de la propia fila, y resolver el propietario mirando el
    // documento exigiría una lectura por candidato, justo lo que la búsqueda
    // no puede permitirse. Es el campo que aísla los corpus.
    propietario: v.id("users"),
  })
    // Los siete campos que en Qdrant eran índices de payload, más el
    // propietario. El índice vectorial admite 16 campos de filtro y el de
    // búsqueda otros 16, así que ocho van sobrados.
    .vectorIndex("porEmbedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: [
        "propietario",
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
        "propietario",
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
    .index("porPropietarioYArchivo", ["propietario", "sourceFile"]),

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

  // Caché del OCR: texto reconocido por imagen, con la imagen identificada por
  // el sha256 de los BYTES que se mandaron al modelo (la imagen ya reducida),
  // más el modelo y la versión del prompt. Reindexar un PDF escaneado de 60
  // páginas volvía a pedir 60 lecturas al modelo para obtener el mismo texto;
  // con la caché, ninguna. Compartida entre cuentas a propósito: el texto de
  // una imagen es función de la imagen, y dos personas con el mismo escaneo
  // no revelan nada por compartir su transcripción, que solo se sirve a quien
  // tiene los bytes exactos para calcular la clave.
  ocrCache: defineTable({
    clave: v.string(),
    texto: v.string(),
    modelo: v.string(),
    creadoEn: v.number(),
  }).index("porClave", ["clave"]),

  // Corridas de ingesta, como la tabla `ingestion_runs`.
  ingestionRuns: defineTable({
    empezadoEn: v.number(),
    terminadoEn: v.optional(v.number()),
    // Última escritura de la corrida. Una corrida `running` sin latido
    // reciente está muerta (la acción cayó sin cerrarla) y otra puede
    // reclamar su documento; una con latido reciente está viva aunque lleve
    // más de diez minutos desde que se registró el documento.
    latidoEn: v.optional(v.number()),
    documentId: v.optional(v.id("documents")),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    stats: v.optional(v.any()),
    error: v.optional(v.string()),
  }).index("porEstado", ["status"]),
});
