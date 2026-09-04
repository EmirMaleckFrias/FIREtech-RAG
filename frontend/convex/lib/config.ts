// Ajustes del despliegue. Port de `backend/app/config.py`.
//
// En Convex las variables de entorno se fijan con `npx convex env set` y viven
// en el despliegue, no en un fichero. Aquí se leen UNA vez por invocación y se
// validan en el borde, para que un valor mal puesto se vea en el arranque y no
// como un fallo raro tres capas más abajo.
//
// La regla de siempre: **el proveedor es el AI Gateway de Vercel**, nunca la
// API de OpenAI directa, y los tres modelos van con el proveedor por delante
// (`openai/gpt-5.4`). El coste por token NO es criterio de decisión en este
// proyecto; el límite real es el tiempo.

function texto(nombre: string, porDefecto = ""): string {
  const v = process.env[nombre];
  // Una variable puesta pero vacía (OPENAI_MODEL="") cuenta como ausente,
  // igual que en `numero` y `booleano`; si no, el modelo quedaba en "" y la
  // petición fallaba con un error que no decía cuál era la variable.
  const t = v === undefined || v === null ? "" : String(v).trim();
  return t === "" ? porDefecto : t;
}

function numero(nombre: string, porDefecto: number): number {
  const v = process.env[nombre];
  if (v === undefined || v === null || String(v).trim() === "") return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

function booleano(nombre: string, porDefecto: boolean): boolean {
  const v = texto(nombre).toLowerCase();
  if (!v) return porDefecto;
  return v === "1" || v === "true" || v === "si" || v === "sí" || v === "yes";
}

export interface Ajustes {
  gatewayApiKey: string;
  gatewayBaseUrl: string;
  modelo: string;
  modeloRerank: string;
  modeloVerificador: string;
  modeloEmbedding: string;
  dimensiones: number;
  temperatura: number;
  // Esfuerzo de razonamiento por componente. "" = manda el valor del modo o el
  // del componente; "none" lo apaga.
  razonamientoAgente: string;
  razonamientoPlanner: string;
  razonamientoCalificador: string;
  razonamientoVerificador: string;
  razonamientoRevisor: string;
  // Topes del operador. 0 = sin tope propio, o sea que manda el modo.
  maxHops: number;
  presupuestoAgenteS: number;
  maxHopsSinAvance: number;
  // Presupuesto TOTAL de una pregunta. Una acción de Convex dura 600 s, así
  // que hay muchísimo más margen que en Vercel, donde la función moría a los
  // 300 y por eso el modo extendido estaba recortado. Se deja en 540 para que
  // el corte lo dé este reloj y no el de la plataforma, que pierde la
  // respuesta entera en vez de acortarla.
  presupuestoTotalS: number;
  habilitarPlan: boolean;
  maxConsultasPlan: number;
  habilitarVerificacion: boolean;
  habilitarRevisionPrevia: boolean;
  maxRevisiones: number;
  revisionTimeoutS: number;
  maxAfirmacionesPorLote: number;
  candidatosPorPunto: number;
  prefetchTimeoutS: number;
  searchTopK: number;
  // Dominio de correo permitido para darse de alta.
  dominioPermitido: string;
  limiteSubidaMb: number;
  // Sincronización con Notion (convex/notion/). Notion es la fuente de verdad
  // del corpus: sin token o sin base de datos la función existe pero está
  // apagada, y `notionSyncMinutes` en 0 apaga la periódica (la manual del
  // administrador sigue funcionando).
  notionToken: string;
  notionDatabaseId: string;
  notionSyncMinutes: number;
  notionBorrarArchivados: boolean;
  // Integración PÚBLICA de Notion (OAuth), la que permite que una
  // administradora conecte su espacio desde la app con un botón y sin ver
  // nunca un token. Las fija el desarrollador una sola vez; sin ellas la UI
  // dice que la conexión "aún no está habilitada por el equipo técnico".
  notionClientId: string;
  notionClientSecret: string;
  // URL pública de las rutas HTTP del despliegue (`*.convex.site`). La pone
  // la plataforma; es la base de la redirect URI que se registra en Notion.
  convexSiteUrl: string;
  // URL del frontend (la misma que usa Convex Auth para volver tras un OAuth).
  // Es adonde se devuelve a la administradora al terminar de conectar Notion.
  siteUrl: string;
}

export function ajustes(): Ajustes {
  return {
    gatewayApiKey: texto("OPENAI_API_KEY"),
    gatewayBaseUrl:
      texto("OPENAI_BASE_URL") || "https://ai-gateway.vercel.sh/v1",
    modelo: texto("OPENAI_MODEL", "openai/gpt-5.4"),
    // Default explícito al modelo pequeño para el reranker y el calificador.
    modeloRerank: texto("RERANK_MODEL", "openai/gpt-5.4-mini"),
    // Vacío = hereda el de rerank.
    modeloVerificador: texto("VERIFIER_MODEL"),
    modeloEmbedding: texto("EMBEDDING_MODEL", "openai/text-embedding-3-large"),
    dimensiones: numero("EMBEDDING_DIMS", 3072),
    // 0 a propósito: esto es una herramienta de investigación y la
    // consistencia vale más que la variedad de redacción. Medido en el
    // backend anterior: el default de la API daba 4 salidas distintas de 10 y
    // con 0 bajan a 2. Ayuda, pero NO da determinismo, y `seed` no cambió
    // nada. La variación se elimina sacando decisiones del modelo, que es lo
    // que hace el pipeline de evidencia.
    temperatura: numero("LLM_TEMPERATURE", 0),
    razonamientoAgente: texto("AGENT_REASONING_EFFORT"),
    // medium y no high: el planner tardaba 33-47 s con high y, medido con una
    // pregunta comparativa, medium descompone en los mismos puntos.
    razonamientoPlanner: texto("PLANNER_REASONING_EFFORT", "medium"),
    razonamientoCalificador: texto("RERANK_REASONING_EFFORT", "medium"),
    razonamientoVerificador: texto("VERIFIER_REASONING_EFFORT", "medium"),
    razonamientoRevisor: texto("REVISOR_REASONING_EFFORT", "high"),
    maxHops: numero("MAX_HOPS", 0),
    presupuestoAgenteS: numero("AGENT_BUDGET_S", 0),
    maxHopsSinAvance: numero("AGENT_MAX_HOPS_SIN_AVANCE", 3),
    // 0 o negativo caen al default: aquí 0 no puede significar "sin límite"
    // porque la acción muere a los 600 s de todas formas.
    presupuestoTotalS: numero("PRESUPUESTO_TOTAL_S", 540) > 0 ? numero("PRESUPUESTO_TOTAL_S", 540) : 540,
    habilitarPlan: booleano("ENABLE_QUERY_PLANNING", true),
    maxConsultasPlan: numero("PLANNER_MAX_QUERIES", 5),
    habilitarVerificacion: booleano("ENABLE_ANSWER_VERIFICATION", true),
    habilitarRevisionPrevia: booleano("ENABLE_PRE_RESPONSE_REVIEW", true),
    // 2 y no 1: la primera ronda corrige; la segunda ordena BORRAR lo que
    // siga sin respaldo. Medido con papers reales: con una sola ronda, una
    // respuesta con 22 afirmaciones sostenidas y 4 sin respaldo acababa
    // entera en abstención segura.
    maxRevisiones: numero("PRE_RESPONSE_REVIEW_MAX_REVISIONS", 2),
    // 150 y no 90: con razonamiento en el verificador y el revisor, la
    // primera sesión de estrés sobre Convex mostró preguntas que llegaban a
    // la barrera tras 120-180 s de búsqueda y redacción y salían en
    // abstención segura; la acción dura 600 s y el reloj único de la pregunta
    // (presupuestoTotalS) sigue mandando por encima de este tope.
    revisionTimeoutS: numero("PRE_RESPONSE_REVIEW_TIMEOUT_S", 150),
    maxAfirmacionesPorLote: numero("VERIFIER_MAX_CLAIMS", 24),
    // 0 = manda el modo (normal 20, extendido 30). Un default fijo aquí
    // pisaba siempre al del modo.
    candidatosPorPunto: numero("EVIDENCE_CANDIDATES_PER_ITEM", 0),
    prefetchTimeoutS: numero("EVIDENCE_PREFETCH_TIMEOUT_S", 45),
    // 60 candidatos por consulta, como en Qdrant. El índice de búsqueda de
    // Convex recorre hasta 1024, así que hay margen de sobra.
    searchTopK: numero("SEARCH_TOP_K", 60),
    dominioPermitido: texto("DOMINIO_PERMITIDO", "airobotix.net"),
    // 100 MB. La subida va por URL firmada de Convex, que NO limita el tamaño
    // del fichero (documentado el 4 sep 2026: "the file size is not limited");
    // lo que la acota es que el POST de subida tiene 2 minutos de tiempo, así
    // que a 1 MB/s caben unos 120 MB. El techo de verdad es la INGESTA: la
    // acción de Node dispone de 512 MiB y 10 minutos, carga el fichero entero
    // en memoria y pdf.js necesita varias veces su tamaño para extraer el
    // texto. 100 MB deja margen para cualquier artículo o guía; subir de ahí
    // exigiría partir la ingesta en varias acciones, no cambiar este número.
    // (Antes 18 MB por confundir la subida con el tope de 20 MB de una
    // petición HTTP de Convex, que no interviene en este camino.)
    limiteSubidaMb: numero("UPLOAD_LIMIT_MB", 100),
    notionToken: texto("NOTION_TOKEN"),
    // Se acepta el id con o sin guiones y también la URL de la base pegada
    // tal cual: `notion/api.ts` lo normaliza. Aquí solo se lee.
    notionDatabaseId: texto("NOTION_DATABASE_ID"),
    // 60 por defecto: el cron de convex/crons.ts corre cada hora y la acción
    // se autoexcluye si la última corrida terminó hace menos de esto. Un
    // valor negativo cuenta como 0 (apagado).
    notionSyncMinutes: Math.max(0, numero("NOTION_SYNC_MINUTES", 60)),
    // Una página archivada o retirada de la base deja de ser corpus: si Notion
    // es la fuente de verdad, lo que sale de Notion sale del índice. En false
    // la fila queda marcada y los documentos se conservan.
    notionBorrarArchivados: booleano("NOTION_DELETE_ARCHIVED", true),
    notionClientId: texto("NOTION_CLIENT_ID"),
    notionClientSecret: texto("NOTION_CLIENT_SECRET"),
    convexSiteUrl: texto("CONVEX_SITE_URL").replace(/\/$/, ""),
    siteUrl: texto("SITE_URL").replace(/\/$/, ""),
  };
}

/** Modelo del reranker y del calificador, resuelto. */
export function modeloRerankResuelto(a: Ajustes): string {
  return a.modeloRerank || a.modelo;
}

/** Modelo del verificador, resuelto. Vacío hereda el de rerank. */
export function modeloVerificadorResuelto(a: Ajustes): string {
  return a.modeloVerificador || modeloRerankResuelto(a);
}

/** Falla temprano y con un mensaje que dice qué falta y dónde ponerlo. */
export function exigirClave(a: Ajustes): string {
  if (!a.gatewayApiKey) {
    throw new Error(
      "OPENAI_API_KEY no está configurada en el despliegue. Ponla con " +
        "`npx convex env set OPENAI_API_KEY vck_...` (clave del AI Gateway " +
        "de Vercel, no de la API de OpenAI).",
    );
  }
  return a.gatewayApiKey;
}
