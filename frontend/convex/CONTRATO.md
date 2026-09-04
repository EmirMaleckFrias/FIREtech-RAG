# Contrato de la migración a Convex

Este fichero es la única fuente de verdad de las interfaces mientras se porta
el backend de Python a Convex. Si algo de aquí resulta imposible o equivocado,
**dilo en el informe en vez de cambiarlo por tu cuenta**: hay otras piezas
escribiéndose en paralelo contra estas firmas.

## Qué reemplaza a qué

| Antes | Ahora |
|---|---|
| Supabase (Postgres + Auth) | Convex: `schema.ts`, `auth.ts`, `permisos.ts` |
| Qdrant Cloud (denso + BM25 + RRF en servidor) | tabla `chunks` con índice vectorial y de texto, fusión por rango en `search/hybrid.ts` |
| FastAPI en funciones de Vercel (300 s) | acciones de Convex (600 s) |
| SSE hacia el navegador | el agente escribe el avance en `messages` y el cliente se resuscribe |
| `data/uploads` y `/tmp` efímero | almacenamiento de ficheros de Convex (`storageId` en `documents`) |

El proveedor de modelos es **siempre el AI Gateway de Vercel**, nunca la API de
OpenAI directa, y los modelos van con el proveedor por delante
(`openai/gpt-5.4`). El coste por token **no es criterio de decisión** en este
proyecto: se argumenta por calidad, latencia y capacidad.

## Lo que YA está escrito y probado (no lo toques, impórtalo)

Empujado al despliegue `gregarious-pony-327` y comprobado el 4 sep 2026: el
índice vectorial de 3072 dimensiones y el de texto BM25 fueron aceptados, y el
gateway responde desde `fetch` con razonamiento, embeddings de 3072 y stream.

- **`convex/schema.ts`** — tablas `users` (Convex Auth + `rol` y `bloqueado`),
  `adminsPreasignados`, `sessions`, `messages`, `feedback`, `documents`,
  `chunks`, `ingestionRuns`. `chunks` tiene `vectorIndex("porEmbedding")` y
  `searchIndex("porTexto")`, ambos con los siete campos de filtro que en Qdrant
  eran índices de payload: `projectId`, `documentId`, `documentVersion`,
  `documentType`, `language`, `sourceFile`, `chunkType`.
  **No hay campo `environment`**: cada despliegue de Convex tiene su base.
  El rol es `"admin" | "lector"` (en Supabase seguía siendo `vendedor` porque
  la migración 010 nunca se pudo aplicar).
- **`convex/lib/config.ts`** — `ajustes()` devuelve todos los ajustes leídos
  del entorno, más `modeloRerankResuelto`, `modeloVerificadorResuelto` y
  `exigirClave`.
- **`convex/lib/citas.ts`** — `Fragmento` (tipo estructural, sin `_generated`),
  `fuente`, `localizador`, `cita`, `claveCita`, `PATRON_CITA`,
  `nuevaRegexCitas`, `PATRONES_ABSTENCION`, `pareceAbstencion`,
  `CITA_INVENTARIO`. **Las expresiones son idénticas a las del backend Python:
  no las cambies.**
- **`convex/lib/gateway.ts`** — `razonamiento(esfuerzo)`, `crearCompletion`,
  `completionJson`, `streamCompletion`, `embed`, `embedConsulta`, `usoDe`,
  `ErrorGateway`. `crearCompletion` reintenta sin `reasoning_effort` si la API
  lo rechaza con un 400 que lo nombra, y lo apaga 10 minutos.
- **`convex/lib/telemetry.ts`** — clase `Telemetria` con `anota`, `incr`,
  `fija`, `costeUsd`, `resumen`, `transcurridoS`. **Se pasa explícitamente**,
  no hay estado global.
- **`convex/lib/modos.ts`** — `NORMAL` y `EXTENDIDO`, `resolver(nombre, ajustes)`.
  Campos: `maxHops`, `presupuestoS`, `maxHopsSinAvance`, `fragmentos`,
  `candidatosPorPunto`, `planifica`, `buscaEnIngles`, `maxHopsExtra`,
  `esfuerzo`, `instruccion`.
- **`convex/auth.ts`** — Convex Auth con contraseña (y Google si el despliegue
  tiene credenciales). Impone el dominio de la empresa y los administradores
  preasignados; reemplaza al trigger `handle_new_user()`.
- **`convex/permisos.ts`** — `usuarioActual`, `usuarioActualONulo`, `esAdmin`,
  `exigirAdmin`, `sesionPropia`, `usuarioDeAccion`, y los errores
  `NoAutenticado`, `AccesoRevocado`, `NoEncontrado`, `SoloAdmin`.
  **Ser administrador NO da acceso a conversaciones ajenas**, solo a gestionar
  documentos y cuentas.

## Cómo trabajar

```bash
cd /Users/emirmalek/FIREtech-RAG/frontend
npm test                 # vitest + convex-test, en memoria, sin red
npm run typecheck        # tsc del frontend y de convex/
npx convex dev --once    # empuja esquema y funciones (typecheck incluido)
```

- **Los tests NO llaman a servicios reales.** Nada de gateway, nada de red.
  Para el modelo, parchea `crearCompletion` / `completionJson` /
  `streamCompletion` con `vi.spyOn(gateway, "...")`, y por eso **impórtalos
  como módulo** (`import * as gateway from "../lib/gateway"`), nunca con
  desestructuración, o el espía no tendrá efecto.
- `convex-test` da una base en memoria: `const t = convexTest(schema)`, luego
  `t.run(async (ctx) => ...)`, `t.query(api...)`, `t.mutation(...)`,
  `t.action(...)`, y `t.withIdentity({ subject: userId })` para simular sesión.
- **Toca solo los ficheros de tu frente.** Otros agentes editan otros ficheros
  a la vez.
- Estilo: comentarios en español que explican **el por qué** con la evidencia
  (qué fallaba, cómo se midió). Nada de guion largo. Conserva los comentarios
  ciertos del original al portar.
- **Intenta romper tu propio cambio antes de cerrarlo**: escribe el test
  adversarial, no solo el que confirma. Que la suite pase no basta si el modo
  de fallo nuevo lo acabas de crear tú.
- El Python original está en `/Users/emirmalek/FIREtech-RAG/backend/app/` y es
  la referencia de comportamiento, incluidos sus comentarios, que documentan
  fallos reales ya pagados. **Léelo antes de portar.** Sus tests
  (`backend/tests/`) dicen qué comportamiento hay que conservar.

## Interfaces entre piezas (fijas)

### `convex/search/terminos.ts`
```ts
/** Términos con contenido para el índice de texto.
 *  El índice acepta 16 términos como máximo y de 32 caracteres, mientras que
 *  las consultas del plan son frases naturales más largas. */
export function terminosDeBusqueda(consulta: string, max?: number): string[];
```

### `convex/search/hybrid.ts`
```ts
export interface FiltrosBusqueda {
  projectId?: string; documentId?: string; documentType?: string; language?: string;
}
export type ModoRecuperacion = "hibrida" | "densa" | "lexica" | "error";

/** Denso + léxico fusionados por rango recíproco. Reemplaza a
 *  `qdrant.hybrid_search`. Se llama desde una ACCIÓN (la búsqueda vectorial
 *  solo existe ahí). */
export async function buscarHibrido(
  ctx: ActionCtx, consulta: string, filtros: FiltrosBusqueda,
  topK: number, tel?: Telemetria,
): Promise<{ fragmentos: Fragmento[]; recuperacion: ModoRecuperacion }>;

/** Varias consultas a la vez, con UN solo lote de embeddings. */
export async function buscarHibridoVarias(
  ctx: ActionCtx, consultas: string[], filtros: FiltrosBusqueda,
  topK: number, tel?: Telemetria,
): Promise<Array<{ fragmentos: Fragmento[]; recuperacion: ModoRecuperacion }>>;
```

### `convex/search/inventario.ts`
```ts
/** Catálogo exacto del índice: reemplaza a los facets de Qdrant.
 *  Forma idéntica a la que consumía la herramienta del agente. */
export const inventario = internalQuery({ /* args: {} */ });
// -> { archivos: {valor: string, chunks: number}[], total_chunks: number,
//      tipos: {valor,chunks}[], idiomas: {valor,chunks}[] }
```

### `convex/agente/planner.ts`
```ts
export interface PuntoPlan { id: string; query: string; queryEn: string; evidenceNeeded: string }
/** `{ items: [], preguntaEn: "" }` si falla: el llamador pone el ancla. NO
 *  inyecta ningún checklist. `preguntaEn` es la pregunta entera en inglés,
 *  que el modelo devuelve en el mismo JSON como `pregunta_en`: es lo que
 *  permite que el ancla e0 también se busque en inglés. */
export async function planificar(
  pregunta: string, historial: {role: string; content: string}[],
  maxItems: number, tel?: Telemetria,
): Promise<{ items: PuntoPlan[]; preguntaEn: string }>;
/** Antepone e0 = la pregunta literal (con `preguntaEn` como queryEn, que
 *  puede ir vacía en modo normal), deduplicando contra los demás y
 *  renumerando e1..eN por posición. */
export function conAncla(pregunta: string, preguntaEn: string, items: PuntoPlan[]): PuntoPlan[];
/** Clase de la pregunta, ANTES de buscar. Solo `documental` entra al pipeline. */
export async function clasificar(
  pregunta: string, historial: {role: string; content: string}[], tel?: Telemetria,
): Promise<"documental" | "sobre_el_asistente" | "conversacional">;
```

### `convex/agente/calificador.ts`
```ts
export type Grado = "directa" | "parcial" | "no";
export const GRADOS: readonly Grado[];
export interface Calificacion {
  grados: Record<number, Grado>;  // por índice de la lista de entrada
  verificado: boolean;            // false = no se pudo aplicar; no concluyas nada
  motivo: string;
}
/** Juicio POR fragmento, sobre el texto COMPLETO, con cabecera
 *  fuente/sección/tipo/cita. Sustituye al rerank listwise y al filtro binario
 *  que veía 450 caracteres. */
export async function calificarEvidencia(
  consulta: string, evidenceNeeded: string, fragmentos: Fragmento[], tel?: Telemetria,
): Promise<Calificacion>;
```

### `convex/agente/evidencia.ts`
```ts
export interface PuntoEvidencia {
  id: string; query: string; queryEn: string; evidenceNeeded: string;
  fragmentos: Fragmento[]; documentosRevisados: string[];
  estado: "cubierto" | "sin_resultados";
  relevanciaVerificada: boolean; recuperacion: ModoRecuperacion; ms: number;
}
export interface EvidenciaPlan {
  puntos: PuntoEvidencia[];
  mapa: Record<string, string[]>;      // chunk _id -> ids de puntos ("extra" para hops del modelo)
  acumulado: Map<string, Fragmento>;   // todo lo entregado al modelo, orden estable
  grados: Record<string, Grado>;       // chunk _id -> grado
  huella: string;                      // sha256 de los ids ordenados, para medir determinismo
}
export async function ejecutarPlan(
  ctx: ActionCtx, plan: PuntoPlan[], modo: Modo, filtros: FiltrosBusqueda,
  tel: Telemetria, limiteMs: number,
): Promise<EvidenciaPlan>;
/** Un `assistant` con N tool_calls (ids `call_plan_<id>`, nombre
 *  `buscar_documentos`) y N mensajes `tool`, cada uno con la cabecera de
 *  estado del punto y los fragmentos en el formato que el modelo ya sabe leer.
 *  El gateway acepta ids sintéticos: comprobado el 4 sep 2026, 200. */
export function mensajesSinteticos(ev: EvidenciaPlan, plan: PuntoPlan[]): Record<string, unknown>[];
export async function buscarYCalificar(
  ctx: ActionCtx, consulta: string, evidenceNeeded: string, punto: string,
  modo: Modo, filtros: FiltrosBusqueda, tel: Telemetria,
): Promise<PuntoEvidencia>;
export function huellaDe(ids: string[]): string;
```

### `convex/agente/verificador.ts`
```ts
export const SOSTENIDA = "sostenida", PARCIAL = "parcial", NO_SOSTENIDA = "no_sostenida",
  CITA_NO_RESUELVE = "cita_no_resuelve", SIN_CITA = "sin_cita", SIN_VERIFICAR = "sin_verificar";
export const CUBIERTO = "cubierto", EVIDENCIA_NO_USADA = "evidencia_no_usada",
  SIN_RESULTADOS = "sin_resultados";
export interface Afirmacion {
  texto: string; cita: string; veredicto: string; motivo: string;
  fragmento_id: string; fragmentos: string[];   // ids de TODOS los hermanos de la cita
}
export interface CoberturaPunto {
  id: string; evidence_needed: string;
  estado: "cubierto" | "parcial" | "evidencia_no_usada" | "sin_resultados";
  n_fragmentos: number; documentos: string[]; afirmaciones: number[];
}
export interface Verificacion {
  afirmaciones: Afirmacion[]; evidencia_sin_cubrir: string[];
  cobertura: CoberturaPunto[]; citas_sin_resolver: string[];
  fidelidad: number | null; ok: boolean; nota: string;
}
/** No lanza: informa. `mapaPlan` habilita la cobertura POR PUNTO; sin él se
 *  conserva el todo-o-nada anterior. e0 se EXCLUYE de la cobertura. */
export async function verificar(
  respuesta: string, fragmentos: Fragmento[],
  evidenciaRequerida?: Record<string, string> | null,
  mapaPlan?: Record<string, string[]> | null,
  tel?: Telemetria,
): Promise<Verificacion>;
```
Reglas que no se negocian: una frase que casa con `PATRONES_ABSTENCION` es una
declaración de ausencia y **no se audita** (ni con cita al lado ni sin ella) ni
cuenta como `sin_cita`. Los lotes de `maxAfirmacionesPorLote` van **en
paralelo**; si uno falla se conservan los demás y la nota lo dice; solo si
fallan todos queda `ok=false` sin veredictos. `evidencia_sin_cubrir` son los
puntos con estado `evidencia_no_usada`, **nunca** los `sin_resultados`.

### `convex/agente/revisor.ts`
```ts
export const ABSTENCION_SEGURA: string;
export interface ResultadoRevision {
  contenido: string; informe: Verificacion; revisiones: number; usoAbstencionSegura: boolean;
}
export function bloqueantes(informe: Verificacion): Afirmacion[];
export function sinSenal(informe: Verificacion): boolean;
/** NO bloquea por `evidencia_sin_cubrir`: solo por citas sin resolver,
 *  bloqueantes y falta total de señal. Un punto legítimamente ausente del
 *  corpus no puede convertir la respuesta en una abstención total. */
export function aprobada(informe: Verificacion): boolean;
export async function revisarAntesDePublicar(
  pregunta: string, borrador: string, mensajesConEvidencia: Record<string, unknown>[],
  fragmentos: Fragmento[], evidenciaRequerida?: Record<string, string> | null,
  mapaPlan?: Record<string, string[]> | null, tiempoDisponibleS?: number | null,
  tel?: Telemetria,
): Promise<ResultadoRevision>;
```

### Funciones de datos (`convex/sesiones.ts`, `mensajes.ts`, `documentos.ts`, `usuarios.ts`, `estadisticas.ts`)
Nombres de las exportaciones que consume el frontend:
- `sesiones.listar` (query) → `{_id, titulo, creadoEn}[]` del usuario, la más nueva primero.
- `sesiones.crear` (mutation, `{titulo}`) → `_id`.
- `sesiones.borrar` (mutation, `{sessionId}`) → borra sus mensajes y su feedback.
- `mensajes.deSesion` (query, `{sessionId}`) → mensajes en orden, comprobando propiedad.
- `mensajes.enviar` (mutation, `{sessionId?, texto, modo}`) → crea la sesión si falta,
  inserta el mensaje del usuario y el del asistente en estado `pensando`,
  agenda la acción del agente y devuelve `{sessionId, messageId}`.
- `mensajes.calificar` (mutation, `{messageId, rating, comentario?}`).
- `documentos.listar` (query) → registro completo. `documentos.urlDeSubida` (mutation,
  solo admin) → URL de subida. `documentos.registrar` (mutation, solo admin,
  `{storageId, fileName, sha256}`). `documentos.reindexar` y `documentos.borrar`
  (mutations, solo admin).
- `usuarios.yo` (query) → `{_id, email, rol}`. `usuarios.listar` (query, solo admin) →
  con `sesiones` y `mensajes` contados y `ultimoAccesoEn`. `usuarios.actualizar`
  (mutation, solo admin, `{userId, rol?, bloqueado?}`; **403 si es uno mismo**).
  `usuarios.borrar` (mutation, solo admin; **403 si es uno mismo**; borra en
  cascada a mano: sesiones, mensajes y feedback).
- `estadisticas.sistema` (query, solo admin) → `{index: {chunks, files, types, languages},
  activity: {questions_total, questions_7d, active_users_7d, feedback_up, feedback_down},
  config: {model, embedding_model, prompt_version, upload_limit_mb}}`.

### Estado del turno del asistente
El agente actualiza el mensaje del asistente por `estado`:
`pensando` → `buscando` → `redactando` → `revisando` → `listo` | `error`,
y va escribiendo `plan`, `hops`, `sources`, `content`, `verificacion` y
`metrics` en la misma fila. **El borrador NO se publica hasta que la barrera
lo aprueba**: `content` se queda vacío mientras `estado` no sea `listo`.

Formas que viajan al frontend, **idénticas a las de hoy** para no romper la
interfaz que ya existe: `sources` (con `plan_items` y `grado` añadidos),
`hops` (con `origen`, `plan_item`, `evidence_needed`, `resultados`,
`documentos`, `estado`, `recuperacion`, `relevancia_verificada`, `ms`,
`estado_final`, `usado_en_respuesta`), `verificacion` (con `cobertura`).
Ojo: dentro de estos objetos las claves van en **snake_case**, como hoy, porque
el frontend ya las consume así; los campos de las tablas van en camelCase.

## Trampas YA MEDIDAS en el port de Python: no las repitas

Estas las encontraron revisores adversariales sobre la implementación Python del
mismo diseño, el 4 sep 2026. Son defectos de diseño, no de lenguaje, así que
el port de Convex tiene que cerrarlas desde el principio.

### Verificador: qué frases se auditan
La regla "una frase que casa con los patrones de abstención no se audita" era
**demasiado ancha** y dejaba pasar dos cosas graves: un hallazgo negativo
atribuido a una fuente ("No hay evidencia de que reduzca la mortalidad
[cita]") es una AFIRMACIÓN sobre esa fuente y puede ser exactamente lo
contrario de lo que dice el fragmento; y una cita inventada pegada a una frase
así nunca llegaba a `citas_sin_resolver`. La regla correcta:

1. La cita pertenece a la frase que la contiene (o a la que la precede
   inmediatamente). **Esa frase se audita SIEMPRE**, diga lo que diga, y su
   cita tiene que resolver contra un fragmento recuperado.
2. Las demás frases del mismo tramo se auditan contra la misma cita, salvo
   que sean una declaración PURA de ausencia: casan con
   `PATRONES_ABSTENCION`, **no contienen dígitos** y no llevan cita propia.
   Esas se saltan y no cuentan como `sin_cita`.
3. En la cola tras la última cita se aplica el mismo criterio: "No hay datos
   de X" se salta; "No hay datos de X, pero el AUC fue 0,94" tiene un dígito,
   se audita y queda `sin_cita` (bloqueante), que es lo correcto.
4. `pareceAbstencion` sobre la respuesta ENTERA solo decide el caso en que no
   hay ninguna cita en todo el texto.

### Calificador: `verificado=true` con cero grados
Si el modelo responde `{"fragmentos": []}` o se salta todas las entradas, el
resultado NO es "verificado": la evidencia debe degradarse igual que cuando la
llamada falla (`relevanciaVerificada=false`, aviso en la cabecera del punto,
orden por rango). Regla: **sin ningún grado, `verificado=false`**, con motivo
"el calificador no emitió ningún grado".

### Ancla e0 y el inglés
El prompt decía "los resultados ya se buscaron también en inglés" y era falso
para e0, que no tenía variante inglesa, y en modo normal el plan es solo e0:
una pregunta en español contra un corpus en inglés se buscaba UNA vez, en
español. Reglas:
- `conAncla` recibe también `preguntaEn` (la traducción de la pregunta entera,
  que el planner devuelve en el mismo JSON como `pregunta_en`) y e0 la lleva
  como `queryEn`. En modo normal, sin planner, e0 va sin `queryEn`.
- La cabecera del punto y el prompt dicen la verdad: "buscado en español e
  inglés" solo si hubo `queryEn`; si no, "buscado solo con la formulación
  original", y la búsqueda extra sigue siendo el remedio.

### Preguntas sobre el asistente y saludos
"¿Qué eres?", "hola", "gracias" no deben ejecutar el pipeline ni recibir la
orden "di que no lo encuentras". El bucle decide ANTES de buscar, con una
llamada barata al modelo pequeño (clasificación `documental` | `sobre_el_asistente`
| `conversacional`), y solo la primera clase entra al pipeline. La cabecera de
un punto sin resultados **describe** ("sin resultados: se revisaron N
fragmentos de A; B y ninguno aporta"), no ordena.

### Recuperación en error no es ausencia
Un punto con `recuperacion: "error"` (la búsqueda lanzó o no llegó a tiempo)
NO es "no está en los documentos". Su cabecera dice "no se pudo comprobar" y
el frontend lo pinta distinto de `sin_resultados`.

### Documentos de un hop
`documentos` es una lista de nombres **únicos**, tanto en `cubierto` como en
`sin_resultados`.

### Hops extra que rellenan un punto
Un hop de origen `extra` con `plan_item = "e2"` actualiza el estado de e2 en la
UI y en la cobertura: si trajo fragmentos, e2 deja de estar `sin_resultados`.

### Modo normal en la UI
Con plan `[e0]` no se muestra "Buscando cada parte de la pregunta"; se muestra
la consulta lanzada, como antes. La vista por puntos aparece solo cuando hay
más de un punto.
