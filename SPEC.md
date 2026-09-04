# SPEC: Alzheimer Project (contrato funcional sobre Convex)

Contrato funcional del asistente. Cualquier código del proyecto debe respetar lo que hay aquí;
las firmas de las interfaces internas, fijadas durante el port, están en
`frontend/convex/CONTRATO.md`. Lo operativo (comandos, variables, cuentas) está en
[docs/OPERACION.md](docs/OPERACION.md).

El sistema responde preguntas de una médica investigadora sobre un corpus de literatura clínica
(Alzheimer), citando de dónde sale cada afirmación. No sabe nada que no esté en los documentos
indexados.

## 1. Principios que no se negocian

1. **Solo con los documentos.** Ninguna afirmación factual sale de conocimiento externo. Las
   únicas excepciones son las preguntas sobre el propio asistente (qué es, qué modos tiene) y
   los saludos, que se responden sin buscar y sin citar porque no hay nada que atribuir.
2. **Toda afirmación factual lleva su cita**, copiada literal de la que trae el fragmento. El
   formato está en la sección 9.
3. **La ausencia se declara con una fórmula fija**: "No encuentro X en los documentos". Lo que
   no se pudo comprobar porque la búsqueda falló se declara con otra: "No pude comprobar X en
   los documentos". No son lo mismo y el sistema las distingue en todo el recorrido.
4. **Los dos modos exigen la misma verdad.** Cambian cuánto se busca y se delibera, nunca las
   reglas de fidelidad ni de citas.
5. **Nada sin auditar llega al navegador.** El texto se publica solo cuando la barrera de
   fidelidad lo aprueba, ya sea entero o recortado de las frases que no se pudieron sostener; si
   no sobrevive nada verificable, lo sustituye por la abstención segura.
6. **Ante la duda, el sistema no aprueba.** El veredicto por defecto de una afirmación es
   `sin_verificar`, nunca `sostenida`; una respuesta factual sin ninguna cita es el peor caso y
   se marca como tal.
7. **Conversaciones privadas y documentos compartidos.** Ni un administrador ve conversaciones
   ajenas. Los documentos los consultan todos y los gestiona solo un administrador.
8. **Respuestas en español**, sin guion largo (U+2014): se separa con comas, puntos o dos
   puntos. La regla está en el prompt y también rige para el código y la documentación.

## 2. Stack

| Pieza | Qué es |
|---|---|
| Backend | Convex (TypeScript): tablas, índices vectorial y de texto, almacenamiento de ficheros, funciones públicas e internas, acciones de hasta 600 s. |
| Autenticación | Convex Auth (`@convex-dev/auth`) con proveedor `Password`; Google opcional. |
| Modelos | AI Gateway de Vercel, por `fetch` sin SDK. `openai/gpt-5.4` (redactor, planificador, corrección), `openai/gpt-5.4-mini` (clasificador, calificador, verificador), `openai/text-embedding-3-large` (3072 dimensiones). |
| Frontend | React 18 + Vite + TypeScript, PWA. Habla con Convex por WebSocket (`useQuery`, `useMutation`). |
| Parseo | `unpdf` (pdf.js) para PDF; `jszip` + `fast-xml-parser` para `.docx` y `.xlsx`. Solo `ingesta/pipeline.ts` corre en Node (`"use node"`); el resto, en el runtime por defecto de Convex. |
| Pruebas | vitest + convex-test en entorno `edge-runtime`, sin red. `tsc` para el frontend y para `convex/`. |
| Hospedaje | Vercel sirve `frontend/dist`; `npx convex deploy --cmd 'npm run build'` despliega funciones y construye. |

## 3. Datos

Esquema en `frontend/convex/schema.ts`. Decisiones clave, ya tomadas:

- **Los fragmentos viven en la tabla `chunks`**, con su vector en un índice vectorial
  (`porEmbedding`, 3072 dimensiones) y su texto en un índice de búsqueda (`porTexto`, BM25 más
  proximidad y coincidencias exactas). Los dos índices declaran los mismos siete campos de
  filtro: `projectId`, `documentId`, `documentVersion`, `documentType`, `language`,
  `sourceFile`, `chunkType`.
- **No hay campo `environment`.** Cada despliegue de Convex tiene su base; local y producción
  no comparten nada.
- **El rol es `admin` | `lector`** y vive en `users`, la tabla de Convex Auth, junto con
  `bloqueado`, `creadoEn` y `ultimoAccesoEn`.
- **`sources`, `hops`, `verificacion`, `plan` y `metrics` se guardan en `messages` con la misma
  forma que consume el frontend** (`v.any()`), con claves en **snake_case**. Los campos de las
  tablas van en camelCase y los ids son los `_id` de Convex.
- **El fichero original queda en el almacenamiento** (`documents.storageId`): reindexar no
  exige volver a subirlo.

Tablas: `users`, `adminsPreasignados`, `sessions`, `messages`, `feedback`, `documents`,
`chunks`, `ingestionRuns`, más las de Convex Auth (`authAccounts`, `authSessions`,
`authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, `authRateLimits`).

Campos de `messages` que escribe el agente: `estado`, `plan`, `hops`, `sources`, `content`,
`verificacion`, `metrics`, `error`. Campos de `documents` tras una ingesta correcta: `sha256`,
`pages`, `chunks`, `status`, `titulo`, `citation`, `doi`, `language`, `documentType`.

## 4. Funciones públicas y permisos

Ninguna tabla se lee desde el navegador. Todas las funciones públicas empiezan por identificar a
quien llama (`permisos.ts`): sin sesión, `no_autenticado`; con la cuenta bloqueada,
`acceso_revocado` (se comprueba en **cada** llamada, no al entrar).

| Función | Tipo | Quién | Qué hace |
|---|---|---|---|
| `sesiones.listar` | query | usuario | `{_id, titulo, creadoEn}[]` propias, la más nueva primero. |
| `sesiones.crear` | mutation `{titulo}` | usuario | Conversación vacía; título recortado a 60 caracteres, "Nueva conversación" si va vacío. |
| `sesiones.borrar` | mutation `{sessionId}` | usuario, propia | Borra la sesión ya; sus mensajes y feedback en lotes de 100 (el primero inline, el resto agendado). |
| `mensajes.deSesion` | query `{sessionId}` | usuario, propia | Mensajes en orden, filas completas. |
| `mensajes.enviar` | mutation `{sessionId?, texto, modo}` | usuario, propia | Crea la sesión si falta (título = primeros 60 caracteres), guarda la pregunta, crea el mensaje del asistente en `pensando` y agenda `agente.bucle.correr`. Devuelve `{sessionId, messageId}`. Texto vacío o de más de 4000 caracteres: `invalido`. |
| `mensajes.calificar` | mutation `{messageId, rating: 1 \| -1, comentario?}` | usuario, propia | Un voto por usuario y mensaje; repetir reemplaza. |
| `documentos.listar` | query | usuario | `{_id, fileName, pages, chunks, status, error, ingestadoEn, titulo, citation}[]` en orden de ingesta. |
| `documentos.urlDeSubida` | mutation | admin | URL firmada del almacenamiento. |
| `documentos.registrar` | mutation `{storageId, fileName, sha256}` | admin | Valida nombre, extensión, sha256, tamaño; registra en `processing` y agenda la ingesta. Nombre ya indexado: `conflicto`, salvo que el existente esté en `failed`, cuya fila se reutiliza. |
| `documentos.reindexar` | mutation `{documentId}` | admin | Vuelve a ingerir desde el fichero guardado. `conflicto` si sigue en `processing` hace menos de 10 minutos, o si no hay fichero. |
| `documentos.borrar` | mutation `{documentId}` | admin | Borra fila y fichero ya; fragmentos en lotes de 300 (el resto agendado). |
| `usuarios.yo` | query | cualquiera | `{_id, email, rol, bloqueado}`, o `null` sin sesión. Bloqueado: `acceso_revocado`. |
| `usuarios.listar` | query | admin | Cuentas con `creadoEn`, `ultimoAccesoEn`, `sesiones` y `mensajes` (preguntas, no turnos). Solo cifras, nunca texto. |
| `usuarios.actualizar` | mutation `{userId, rol?, bloqueado?}` | admin, otro | Asciende, degrada, bloquea o desbloquea. Sobre uno mismo: `invalido`. |
| `usuarios.borrar` | mutation `{userId}` | admin, otro | Cascada a mano: sesiones y feedback ya; mensajes por lotes agendados; documentos subidos quedan sin autor; filas de Convex Auth; la cuenta. |
| `estadisticas.sistema` | query | admin | Ver sección 13. |
| `semilla.ascenderSiPreasignado` | mutation | usuario | Si el correo propio está en `adminsPreasignados`, pasa a `admin`. Sin argumentos: solo sobre uno mismo. |

Funciones internas (solo `npx convex run` o el planificador de Convex): `semilla.sembrarAdmins`,
`pruebas.*`, `agente.bucle.correr`, `ingesta.pipeline.ingestar`, `ingesta.escritura.*`,
`mensajes.actualizarTurno`, `mensajes.borrarRestantes`, `documentos.borrarChunksRestantes`,
`search.hybrid.lexica`, `search.hybrid.cargar`, `search.inventario.inventario`.

### Errores

Las funciones lanzan `ConvexError` con `{codigo, mensaje}`; el frontend decide por el código y
muestra el mensaje, ya en español. Códigos: `no_autenticado`, `acceso_revocado`,
`no_encontrado`, `solo_admin`, `conflicto`, `invalido`. Regla heredada: una conversación ajena
responde `no_encontrado`, nunca "prohibida", para no confirmar que existe.

## 5. Modos de pensamiento

`lib/modos.ts`. El usuario elige antes de preguntar; `mensajes.enviar` pasa el nombre tal cual y
`resolver` lo interpreta: un valor desconocido o vacío es `normal`.

| | `normal` | `extendido` |
|---|---|---|
| Etiqueta | Pensamiento normal | Pensamiento extendido |
| `planifica` | no (plan = solo `e0`) | sí |
| `fragmentos` por punto | 8 | 12 |
| `candidatosPorPunto` | 20 | 30 |
| `maxHopsExtra` (búsquedas del modelo) | 1 | 2 |
| `maxHopsSinAvance` | 2 | 3 |
| `presupuestoS` (bucle de redacción) | 60 | 240 |
| `esfuerzo` (`reasoning_effort`) | `medium` | `high` |

Los techos del despliegue (`MAX_HOPS`, `AGENT_BUDGET_S`, `AGENT_MAX_HOPS_SIN_AVANCE`) solo pueden
apretar el modo, nunca soltarlo; `0` es "sin tope propio" en los dos lados.
`AGENT_REASONING_EFFORT` vacío deja el del modo, `none` lo apaga, otro valor lo sustituye.
`ENABLE_QUERY_PLANNING=false` apaga el plan en los dos modos y nunca lo enciende en normal.
`EVIDENCE_CANDIDATES_PER_ITEM` distinto de `0` sustituye a `candidatosPorPunto` en los dos
modos (con el default de 30, el modo normal también califica 30).

Cada modo añade su propia instrucción al prompt del sistema en un segundo mensaje `system`, para
que el prefijo grande siga siendo cacheable.

## 6. El turno del asistente

`mensajes.enviar` crea el mensaje del asistente con `estado: "pensando"` y `content: ""`. La
acción `agente.bucle.correr` va escribiendo en esa misma fila (`mensajes.actualizarTurno`, que
no recrea el mensaje si la conversación se borró mientras tanto):

| `estado` | Qué se escribe | Cuándo |
|---|---|---|
| `pensando` | nada más | al crear el mensaje; durante la clasificación |
| `buscando` | `plan` (ids, consultas, `query_en`, `evidence_needed`); después `hops` y `sources` | plan y recuperación de evidencia |
| `redactando` | `hops` y `sources` se actualizan con cada búsqueda extra | mientras el modelo escribe |
| `revisando` | nada nuevo | barrera de fidelidad |
| `listo` | `content`, `sources`, `hops` (con `estado_final` y `usado_en_respuesta` en los del plan), `verificacion`, `metrics` | publicación |
| `error` | `error` (mensaje recortado a 500 caracteres), `metrics` | cualquier excepción |

**`content` queda vacío hasta `listo`.** El texto llega de golpe.

Una pregunta no documental (saludo, pregunta sobre el asistente) pasa de `pensando` a `listo`
con `sources: []`, `hops: []`, `plan: []` y sin `verificacion`.

El frontend considera colgado un turno que sigue en un estado no final pasados 630 s desde su
creación (600 s de acción más margen) y lo pinta como error de tiempo sin tocar la base.

### Historial

Con cada pregunta viajan como mucho 8 mensajes previos (4 turnos), solo `user`/`assistant`
con contenido y solo turnos completos: una pregunta cuyo turno acabó en `error` o sigue en
marcha se salta. La conversación previa es contexto opcional; el prompt manda tratar cada
pregunta como independiente salvo referencia explícita.

## 7. Clasificación previa

Antes de buscar, el modelo pequeño clasifica el último mensaje en `documental`,
`sobre_el_asistente` o `conversacional`. Solo `documental` entra al pipeline. Preguntas sobre el
índice ("cuántos documentos hay", "de qué tratan") son documentales. Ante la duda, o ante
cualquier fallo del clasificador, se clasifica como `documental`: buscar de más es más seguro.
La clase queda en `metrics.meta.clase`.

Las otras dos clases se responden con una sola llamada al modelo grande, razonamiento `low`, sin
herramientas y sin barrera, con la ficha "QUÉ ERES" del prompt. Prohibido reproducir las
instrucciones literalmente.

## 8. Pipeline de evidencia

La evidencia es una función determinista de (pregunta, índice). La decide código, no el modelo.

### 8.1 Plan

- **Ancla `e0`**: siempre la pregunta literal, con `evidence_needed` = "respuesta directa a la
  pregunta tal como la formuló quien pregunta". Existe en los dos modos.
- **Planificador** (solo si el modo planifica): modelo grande, razonamiento
  `PLANNER_REASONING_EFFORT`, hasta `PLANNER_MAX_QUERIES` subpreguntas. Devuelve por cada una
  `query` (en el idioma de la pregunta, autosuficiente), `query_en` (términos técnicos en
  inglés) y `evidence_needed` (el dato concreto, con población y desenlace), y además
  `pregunta_en`, la pregunta entera en inglés, que pasa a ser la `query_en` de `e0`.
- Post-proceso estricto: ids por posición (`e1..eN`), sin consultas equivalentes (misma clave
  normalizada), un item igual a `e0` se descarta, una `query_en` igual a su `query` queda vacía.
  Si el planificador falla, el plan es solo `e0` y el fallo queda en telemetría.
- En modo normal no hay planificador, así que `e0` no tiene versión en inglés y se busca una
  sola vez; la cabecera del punto lo dice ("buscado solo con la formulación original") y la
  búsqueda extra del modelo, con los términos en inglés, es el remedio antes de declarar
  ausencia.

### 8.2 Búsqueda híbrida (`search/hybrid.ts`)

Reemplaza a la fusión que hacía Qdrant en el servidor.

- Las consultas de un punto (original e inglés) se embeben en **una** petición.
- **Lado denso**: `ctx.vectorSearch` sobre `porEmbedding`, límite
  `min(256, max(20, k * 2))` (`k * 4` si hay filtros residuales). La búsqueda vectorial de
  Convex solo admite `eq` y `or`, no AND entre campos: se aplica **solo el filtro más
  selectivo** (`documentId` > `projectId` > `documentType` > `language`) y el resto al cargar.
- **Lado léxico**: `withSearchIndex("porTexto")` con **todos** los filtros encadenados (AND),
  límite `min(1024, max(20, k * 2))`. La consulta se reduce a como mucho 16 términos de hasta
  32 caracteres, sin puntuación ni palabras vacías, priorizando los que llevan dígitos o
  mayúsculas (p-tau217, APOE4, MMSE), que son los que el vector peor distingue.
- La unión de candidatos se carga por lotes de 64 **sin el vector**; ahí se aplican los filtros
  residuales.
- **Fusión RRF** con `k = 60` y orden total: puntuación, `sourceFile`, `page`, `_id`. El
  `score` del fragmento es su suma RRF.
- `k` = `SEARCH_TOP_K` (60) por consulta.
- `recuperacion` por consulta: `hibrida` (los dos lados), `densa` (falló el léxico o la
  consulta no dejó términos), `lexica` (fallaron los embeddings o la vectorial), `error`
  (fallaron los dos o la carga). **`error` no es "no está en los documentos"** y nunca se
  lanza: el llamador lo distingue.
- Un filtro con un valor que no existe devuelve cero. En las búsquedas extra del modelo, si
  con filtros no sale nada, el bucle repite sin filtros y avisa al modelo de que esos valores
  no existen.

### 8.3 Ejecución de un punto (`agente/evidencia.ts`)

1. `recuperar`: híbrida de `query` y, si difiere, de `query_en`; las listas se fusionan por
   RRF. Si una de las dos falla se sigue con la otra; la `recuperacion` del punto es la más
   degradada de las que respondieron. Si fallan las dos, el punto queda en `error`.
2. **Poda** de secciones que nunca son evidencia: bibliografía, referencias, agradecimientos,
   financiación, conflictos de interés.
3. **Deduplicación** por `_id` y por texto normalizado idéntico. Nunca por solape parcial: dos
   fragmentos contiguos comparten el párrafo de solape y son dos evidencias.
4. **Preselección** de `candidatosPorPunto` con cuota mínima de 3 por documento
   (`CUOTA_CANDIDATOS`), para que un paper largo no expulse al resto antes de que nadie los
   lea. Las tablas nunca se desplazan. Los documentos de los que salen los candidatos quedan
   en `documentosRevisados` (máximo 5).
5. **Calificador** (`agente/calificador.ts`): modelo pequeño, razonamiento
   `RERANK_REASONING_EFFORT`, juicio **por fragmento y sobre el texto completo**, con cabecera
   fuente, sección, tipo y cita. Grados: `directa`, `parcial`, `no`. Lotes de 20 en paralelo;
   un lote caído deja sus índices sin grado y `verificado=false`. **Sin ningún grado,
   `verificado=false`** (motivo "el calificador no emitió ningún grado"). Ante la duda entre
   `parcial` y `no`, `parcial`.
6. **Orden final determinista**: grado > peso de sección > rango RRF > `_id`. Pesos:
   Resultados 3,0; Métodos, Resumen 2,0; Discusión, Conclusiones, Limitaciones 1,5; sección
   desconocida 1,0 (neutro, nunca descarta). Se entregan hasta `fragmentos` del modo, otra vez
   con cuota mínima de 2 por documento (`CUOTA_FINAL`).
7. Si el calificador no se pudo aplicar, se entregan los primeros `fragmentos` en orden RRF con
   `relevanciaVerificada=false` y el aviso "no se pudo verificar la relevancia".
8. `estado`: `cubierto` si queda algún fragmento; `sin_resultados` si no.

Todos los puntos del plan corren **en paralelo** bajo un único reloj:
`min(EVIDENCE_PREFETCH_TIMEOUT_S, lo que quede del presupuesto total)`. El punto que no llega
queda `sin_resultados` con `recuperacion: "error"` y el resto se entrega igual. Con el reloj en
cero no se lanza nada.

Resultado (`EvidenciaPlan`): `puntos`, `mapa` (`_id` del fragmento a ids de los puntos que lo
trajeron), `acumulado` (todo lo entregado, orden estable), `grados`, `huella` (sha256 de los
ids ordenados, para medir determinismo en `metrics.meta.huella_evidencia`).

### 8.4 Cómo lo lee el modelo

La evidencia entra en la conversación como un intercambio de herramientas sintético: un mensaje
`assistant` con N `tool_calls` (`call_plan_<id>`, `buscar_documentos`) y N mensajes `tool`,
uno por punto. Cada mensaje `tool` lleva una **cabecera que describe, no ordena**:

- cubierto: `PUNTO e2 (<evidence_needed>): cubierto, 6 fragmentos de: <docs> (buscado en
  español e inglés)`, más el aviso si la relevancia no se verificó, y los resultados;
- sin resultados: `... sin resultados: se revisaron N fragmentos de <docs> y ninguno aporta
  evidencia sobre este punto (buscado solo con la formulación original)`;
- error: `... no se pudo comprobar: la búsqueda falló o no llegó a tiempo, así que no hay
  fragmentos que leer y su ausencia no dice nada sobre los documentos.`

Cada resultado va como `--- Resultado n ---`, la línea `cita: [...]`, la sección en su propia
línea (nunca dentro de la cita), el grado del calificador si lo hay, y el texto.

### 8.5 Búsquedas extra del modelo

Dos herramientas: `buscar_documentos` (`semantico`, `punto`, `project_id`, `document_id`,
`document_type` en `pdf|docx|xlsx|csv|txt|md`, `language` en `es|en|pt|fr`, `limit` 1 a 50; el
bucle acepta `limit` pero no lo aplica: los fragmentos entregados los fija el modo) y
`listar_documentos` (sin parámetros: catálogo exacto desde la tabla `documents`, solo `ready`;
no cuenta como búsqueda extra ni como "sin avance").

- Cada búsqueda extra pasa por el mismo camino que un punto del plan (`buscarYCalificar`). Si
  declara `punto` con un id del plan, su evidencia se atribuye a ese punto y actualiza su
  estado; si no, se atribuye a `extra`.
- Una llamada idéntica a otra de la misma pregunta (ignorando `punto` y `limit`) no se ejecuta
  ni cuenta: el modelo recibe un aviso.
- El bucle para y fuerza la respuesta (`tool_choice: "none"`) cuando se alcanza `maxHopsExtra`,
  cuando hay `maxHopsSinAvance` búsquedas seguidas sin fragmentos nuevos, cuando se agota
  `presupuestoS`, o cuando quedan menos de 60 s del reloj total (reserva para la barrera). Si
  ya hubo alguna búsqueda extra, se le dice al modelo por qué se acabó, para que responda con
  lo que tiene y diga qué quedó sin cubrir.

## 9. Formato de respuesta y de cita

### 9.1 Formato de respuesta

(1) Respuesta directa, 2 a 4 frases con sus citas. (2) Evidencia por punto: cifra, unidades,
población y sección de la que sale, con su cita. (3) "Contradicciones o matices entre
documentos", solo si existen. (4) Lo que no está, con las fórmulas literales. Prohibido
mencionar el plan, los ids `e0..eN`, las herramientas o los "resultados de búsqueda".

### 9.2 Cita

`[<fuente>, <localizador>]`, montada por `lib/citas.ts`:

- **fuente**: `citation` del documento (referencia corta, "Allegri et al., 2023") si se pudo
  extraer; si no, el nombre del archivo. Nunca el título.
- **localizador**, según lo que exista de verdad en el formato: `pág. N` (PDF con página),
  `tabla N` (tabla de Word), `fila N` (fila de hoja de cálculo o CSV), `sección: X` (si hay
  encabezado), `fragmento N` (último recurso).

Patrón que reconoce una cita en una respuesta (idéntico al del backend anterior y al del
evaluador):

```
/\[[^[\]\n]+,\s*(?:p[aá]g\.?|secci[oó]n:|fila|tabla|fragmento)\s*[^[\]\n]+\]/gi
```

La cita del catálogo es `[inventario del índice]`: no casa con el patrón porque no apunta a un
fragmento, pero se reconoce para no juzgar una respuesta de inventario como "afirma sin citar".

### 9.3 Fórmulas de abstención

Una frase se considera declaración de ausencia si casa con alguno de estos patrones (sin
distinguir mayúsculas):

```
no (?:lo |la )?encuentro
no (?:aparece|figura|consta)
no hay (?:evidencia|informaci[oó]n|datos)
los documentos no (?:indican|mencionan|contienen|permiten)
```

Estas expresiones son las mismas en el verificador y en el evaluador: si divergieran, medirían
cosas distintas.

## 10. Verificación de atribución (`agente/verificador.ts`)

No reescribe ni tumba la pregunta: anota y devuelve un informe. Veredictos posibles de una
afirmación: `sostenida`, `parcial`, `no_sostenida` (los tres del juez), `cita_no_resuelve`,
`sin_cita` (deterministas), `sin_verificar` (por defecto y ante cualquier fallo).

### 10.1 Qué frases se auditan

La respuesta se parte por citas. El tramo asociado a una cita va desde el final de la cita
anterior hasta ella. Dentro del tramo:

1. La **última frase con contenido es la dueña de la cita y se audita siempre**, diga lo que
   diga, incluida una declaración de ausencia con cita ("No hay evidencia de que reduzca la
   mortalidad [cita]" es una afirmación sobre esa fuente). Su cita tiene que resolver.
2. Las **demás frases del tramo se auditan contra la misma cita**, salvo las declaraciones
   **puras** de ausencia: casan con los patrones de abstención y **no contienen dígitos**.
   Esas se saltan y no cuentan como `sin_cita`.
3. Una cita sin frase propia (`dato [a] [b]`) es una segunda cita de la frase anterior; una que
   va delante de todo texto se adosa a la primera frase que la sigue.
4. La **cola** tras la última cita sigue el criterio 2: una ausencia pura se salta; cualquier
   otra frase queda `sin_cita` ("No hay datos de X, pero el AUC fue 0,94" tiene un dígito y se
   audita).
5. Encabezados de lista (terminan en `:`), restos sin letras ni dígitos y frases que ya llevan
   `[inventario del índice]` no se juzgan.

Si la respuesta **no tiene ninguna cita**: si casa con los patrones de abstención, informe
vacío y correcto ("nada que atribuir"); si cita el inventario, correcto; en cualquier otro
caso, **una afirmación `sin_cita` que abarca toda la respuesta, `fidelidad` 0.0 y `ok=false`**.

### 10.2 Resolución y juicio

- Cada cita se resuelve por su texto normalizado (`claveCita`: minúsculas y espacios
  colapsados) contra `cita(fragmento)` de los fragmentos recuperados. Una misma cita puede
  corresponder a varios fragmentos (misma página o sección): todos son hermanos y basta con que
  uno la sostenga. Una cita que no resuelve: `cita_no_resuelve`, y entra en
  `citas_sin_resolver`, sin gastar una llamada.
- Las que resuelven van al juez (`VERIFIER_MODEL`, razonamiento `VERIFIER_REASONING_EFFORT`)
  en **lotes de `VERIFIER_MAX_CLAIMS` en paralelo**, con la cabecera y el texto de cada
  fragmento hermano. El tope acota el tamaño de cada petición, no cuánto se verifica.
- Un lote caído deja sus afirmaciones `sin_verificar` y la `nota` lo dice; solo si caen
  **todos** queda `ok=false` sin veredictos.
- `fidelidad` = sostenidas / juzgadas por el juez; `null` si no se juzgó ninguna.
- `ok` es falso si hay alguna afirmación `sin_cita` o si cayeron todos los lotes del juez;
  una cita que no resuelve no lo pone en falso por sí sola, va en `citas_sin_resolver`.

### 10.3 Cobertura por punto (código, sin modelo)

Con el `mapa` fragmento a punto, para cada punto distinto de `e0`, en el orden del plan:

| Situación | `estado` |
|---|---|
| Ningún fragmento en el mapa | `sin_resultados` |
| Alguna afirmación `sostenida` usa un fragmento suyo | `cubierto` |
| Lo usa alguna `parcial` o alguna `sin_verificar` | `parcial` |
| Hay fragmentos y ninguna afirmación los usa, o solo los usan `no_sostenida` | `evidencia_no_usada` |

`evidencia_sin_cubrir` son los puntos en `evidencia_no_usada`, **nunca** los `sin_resultados`.
La cobertura se calcula también cuando el sistema se abstiene: la médica ve igual qué puntos
tenían evidencia. Sin mapa se conserva la lectura antigua, todo o nada.

Un fragmento traído por dos puntos cubre los dos: se acepta antes que un falso "sin cubrir".

## 11. Barrera de fidelidad (`agente/revisor.ts`)

Se ejecuta si `ENABLE_ANSWER_VERIFICATION` y `ENABLE_PRE_RESPONSE_REVIEW` están activas. Si solo
la primera, el borrador se publica y se anota; si ninguna, se publica sin informe.

**Aprobada** si y solo si: no hay `citas_sin_resolver`, el verificador dictaminó algo (no todas
`sin_verificar`), y no hay bloqueantes.

**Bloquean**: `no_sostenida`, `cita_no_resuelve`, `sin_cita`. Son la atribución falsa: la
respuesta apunta a una fuente que no dice lo que ella dice.

**No bloquean**, y es deliberado: `parcial` (un matiz que le corresponde juzgar a quien
investiga, y viaja a la interfaz en ámbar), `sin_verificar` (nadie lo comprobó, no es un
fallo), y `evidencia_sin_cubrir` (no usar una evidencia es una decisión editorial, no una
atribución falsa; es información para la médica y crítica para el redactor). Con la puerta
antigua, que exigía todo sostenido, medido sobre diez preguntas reales solo pasaban tres.

**Sin señal no se aprueba**: si el verificador cayó entero, no haber bloqueantes no es evidencia
de que no los haya.

Flujo, bajo un tope `min(PRE_RESPONSE_REVIEW_TIMEOUT_S, lo que quede del reloj total)`:

1. Borrador vacío: abstención segura directa.
2. Verificar. Una frase seguida de varias citas es UNA afirmación juzgada contra la unión de
   los fragmentos de todas ellas (evidencia repartida); una cita que no resuelve va a
   `citas_sin_resolver` y la afirmación se juzga contra las que sí. Aprobada: se publica con
   `revisiones: 0`.
3. Sin señal: abstención segura.
4. Hasta `PRE_RESPONSE_REVIEW_MAX_REVISIONS` rondas (2 por defecto): el redactor (modelo
   grande, `REVISOR_REASONING_EFFORT`, sin herramientas) recibe la conversación con la
   evidencia, el borrador y la **crítica**: cada afirmación no sostenida con su motivo; las
   citas inventadas sueltas; por cada punto `evidencia_no_usada`, "incorpóralos con su cita o
   di por qué no responden"; por cada `sin_resultados`, "decláralo con la fórmula, no lo
   rellenes". En la última ronda la crítica lista entre comillas las frases que siguen
   bloqueantes y ordena borrarlas, no reescribirlas. Se vuelve a verificar; aprobada: se
   publica con `revisiones: n`.
5. **Recorte quirúrgico.** Si tras las rondas siguen quedando afirmaciones bloqueantes, se
   eliminan del texto esas frases (con su cita) y las citas inventadas sueltas, se limpian
   viñetas y encabezados que queden vacíos, se verifica el texto recortado y, si se aprueba, se
   publica con `frasesEliminadas` y una `nota` que dice cuántas frases se quitaron. Medido:
   con la política anterior, una respuesta con 22 afirmaciones sostenidas y 4 sin respaldo
   acababa entera en abstención segura. `parcial` y `sin_verificar` no bloquean ni se
   recortan.
6. Si el recorte no deja nada verificable, no se localiza alguna frase, vence el tope, no hay
   señal del verificador o algo lanza: **abstención segura**, verificada también
   para que traiga cobertura. El resultado lleva `motivoAbstencion` (`borrador_vacio`,
   `sin_senal`, `rechazada_tras_correccion`, `timeout` o `error`) y `informeBorrador`, el
   último informe real del borrador o de su corrección; el bucle los guarda en
   `metrics.meta.barrera` para que una abstención se pueda diagnosticar.

Abstención segura, literal: "No puedo ofrecer una respuesta verificable con la evidencia
recuperada. No encuentro respaldo suficiente en los documentos para responder con la fidelidad
requerida."

Tras la barrera, la cobertura vuelve a los `hops` del plan (`estado_final`,
`usado_en_respuesta`), que es lo que persiste y con lo que la interfaz reconstruye la tabla al
reabrir una conversación.

## 12. Formas que consume el frontend

Claves en snake_case dentro de estos objetos. Tipos en `frontend/src/types.ts`.

**`plan[]`**: `{id, query, query_en, evidence_needed}`. `e0` no se muestra como fila; con plan
`[e0]` (modo normal) no hay vista por puntos.

**`sources[]`** (todo lo entregado al modelo, orden estable):
`source_file, page, project_id, document_id, section, language, document_type, source_pages,
snippet` (240 caracteres), `score, chunk_type, title, citation, doi, locator, fuente,
plan_items[], grado` (`directa` | `parcial` | vacío = sin calificar, que no significa "no").

**`hops[]`**: `n, query, origen` (`plan` | `extra`), `plan_item` (id del plan o vacío),
`evidence_needed, resultados, nuevos?, documentos[]` (nombres únicos), `estado` (`cubierto` |
`sin_resultados`), `recuperacion` (`hibrida` | `densa` | `lexica` | `error`),
`relevancia_verificada, ms`, y en los del plan tras la barrera `estado_final`
(`cubierto` | `parcial` | `evidencia_no_usada` | `sin_resultados`) y `usado_en_respuesta`. Un hop
extra se inserta **antes** de buscar como marcador (`recuperacion: "error"`, `resultados: 0`,
`ms: 0`) y se completa al terminar; la interfaz lo pinta "buscando" mientras el turno sigue y
"no se pudo comprobar" si el turno cerró así. Un hop extra con `plan_item` actualiza el estado
de ese punto. El inventario aparece como hop extra con `query: "inventario de documentos"`.

**`verificacion`**: `afirmaciones[]` (`texto, cita, veredicto, motivo, fragmento_id,
fragmentos[]`), `evidencia_sin_cubrir[]`, `cobertura[]` (`id, evidence_needed, estado,
n_fragmentos, documentos[], afirmaciones[]` con índices en `afirmaciones`),
`citas_sin_resolver[]`, `fidelidad` (número o `null`), `ok`, `nota`.

La interfaz pinta la cobertura con el informe si lo hay y, si no, la reconstruye desde los
hops. Además de los cuatro estados del contrato usa tres propios para no afirmar lo que no
sabe: `encontrada` (hubo fragmentos y nadie dijo si se usaron), `no_buscado` (punto del plan
sin hop) y `error_busqueda` (la búsqueda falló). El informe de atribución resume el fallo, no
el acierto, y `sin_verificar` se pinta como aviso, nunca como aprobado.

**`metrics`**: sección 13.

## 13. Telemetría y coste

Una `Telemetria` por acción, pasada explícitamente (sin estado global). `metrics` es su
`resumen()`:

```
ms_total, rondas,
tokens {prompt, cached, completion, reasoning, total},
por_componente {<componente>: {rondas, prompt, cached, completion, reasoning, ms, errores}},
por_modelo {<modelo>: {prompt, cached, completion, reasoning}},
cost_usd, pricing: "estimado, tarifas asumidas",
counters {...}, meta {...}
```

Componentes: `clasificador`, `planner`, `embeddings`, `grader` (calificador), `agente`,
`verificador`, `revisor`. La ingesta guarda su propia telemetría (componente `embeddings`) en
`ingestionRuns.stats.telemetria`.

Contadores: `hops_plan`, `puntos_sin_resultados`, `hops_extra`, `hops_con_error`,
`llamadas_repetidas`, `forced_final`, `razonamiento_rechazado`, `respuestas_revisadas`,
`abstenciones_seguras`, `puntos_no_usados`, `rondas_sin_usage`, `recuperacion_<modo>`,
`recuperacion_error`, `lado_denso_caido`, `lado_lexico_caido`, `carga_fragmentos_caida`.

`meta`: `prompt_version`, `model`, `modo`, `clase`, `huella_evidencia`, `verificacion`
(recuento por veredicto, `citas_sin_resolver`, `fidelidad`, `ok`, `revision_previa`,
`revisiones`, `abstencion_segura`, `cobertura`) y, solo cuando hubo abstención segura,
`barrera` (`motivo` e `informe_borrador` con las afirmaciones del borrador rechazado, sus
veredictos, `citas_sin_resolver`, `fidelidad`, `ok`, `nota` y `cobertura`).

**Coste**: estimación con tarifas **asumidas** en `lib/telemetry.ts`, en USD por millón de
tokens (entrada, entrada cacheada, salida): `gpt-5.4` 1,25 / 0,125 / 10,0; `gpt-5.4-mini`
0,25 / 0,025 / 2,0; `text-embedding-3-large` 0,13 / 0,13 / 0. Se quita el prefijo de proveedor
antes de buscar la tarifa (sin eso el coste salía 0 con el gateway). Fórmula por ronda:
`(prompt - cached) * entrada + cached * cacheada + completion * salida`. Los tokens de
razonamiento se registran aparte y no se suman al coste por separado. Se mide para que se vea,
no para decidir por él.

`estadisticas.sistema` (solo admin) devuelve
`{index: {chunks, files, types[], languages[]}, activity: {questions_total, questions_7d,
active_users_7d, feedback_up, feedback_down}, config: {model, embedding_model, prompt_version,
upload_limit_mb}}`. `index` sale de `documents` en `ready`; `activity` recorre `messages`
(ver límites en OPERACION.md).

## 14. Ingesta

`documentos.registrar` o `documentos.reindexar` dejan el documento en `processing` y agendan
`ingesta.pipeline.ingestar`:

1. Se lee el fichero original del almacenamiento. Su sha256 es la `documentVersion` de sus
   fragmentos.
2. `parsearDocumento` decide por extensión, sanea, detecta el idioma sobre los primeros 40
   fragmentos (`es`, `en`, `pt`, `fr`, o vacío si no está claro) y aplica los topes: sin texto
   extraíble, error; más de 4000 fragmentos, error pidiendo dividir.
3. Se embebe en lotes de 96 y cada lote se escribe en mutaciones de como mucho 32 fragmentos
   (un fragmento lleva 3072 números y los argumentos de una mutación desde Node tienen un tope
   de 5 MiB).
4. Solo después de escribir la versión nueva se retira la anterior. Un fallo de embeddings no
   deja al documento sin versión consultable.
5. Éxito: `ready` con `pages`, `chunks`, `titulo`, `citation`, `doi`, `language`,
   `documentType`, y la corrida en `ingestionRuns` como `completed` con `stats`. Fallo:
   `failed` con el mensaje (500 caracteres), sin fragmentos a medias de la versión nueva, y la
   corrida `failed`.

Parseo por formato (los comentarios de cada módulo documentan los fallos medidos que motivaron
cada regla):

- **PDF** (`ingesta/pdf.ts`, `lineas.ts`, `paper.ts`): las líneas físicas se reconstruyen desde
  los items de pdf.js por coordenada vertical y, en una página a dos columnas, se separan por
  el canal vertical que ninguna línea cruza y se leen columna a columna (una línea que cruza
  el canal es de ancho completo y cierra la banda); las filas de tabla se reconocen por
  geometría (huecos horizontales grandes), no por densidad de cifras; las líneas se unen en párrafos
  recomponiendo palabras cortadas con guion. La sección vigente se detecta por nombre
  (Methods, Resultados...) o por maqueta (línea corta, sin punto final, con más cuerpo o en
  negrita que el texto). Título, primer autor, año y DOI salen de la primera página con
  heurísticas; `citation` solo se rellena con autor y año, nunca con el título. La
  bibliografía se descarta por defecto; también las marcas de descarga y las cabeceras y pies
  que se repiten en el borde de las páginas. `page` es la primera página del fragmento,
  `source_pages` todas.
- **DOCX** (`ingesta/docx.ts`): se recorre el XML del paquete en orden de documento; los
  párrafos se agrupan por sección sin mezclar dos secciones en un fragmento; cada tabla es un
  fragmento `table` numerado que hereda la sección y el rótulo que la precede, con celdas
  combinadas (`gridSpan`) resueltas. Sin páginas.
- **XLSX y CSV** (`ingesta/tabular.ts`): fila de encabezado detectada (primera fila con dos o
  más celdas no vacías si al menos el 60 % son textuales); un fragmento por fila, "Campo:
  valor", `chunk_type` `table`, `page` = número de fila.
- **TXT y MD** (`ingesta/texto.ts`): párrafos por líneas en blanco empaquetados con solape;
  `page` = índice de fragmento. Codificaciones probadas: utf-8, windows-1252, iso-8859-1.
- **`.doc`** se rechaza con un mensaje que dice cómo convertirlo.

Troceo (`ingesta/chunking.ts`): objetivo 400 tokens, solape 60, párrafos de más de 500 tokens
partidos por oraciones, texto por fragmento recortado a 8000 caracteres. Cada fragmento
repite los metadatos de la obra para que una cita no necesite ir a buscar nada más.

Inventario (`search/inventario.ts`): archivos, tipos e idiomas con su número de fragmentos,
desde `documents` en `ready`. Conteo exacto, cero LLM.

## 15. Frontend (requisitos)

- Chat suscrito a `mensajes.deSesion`; el estado del turno se pinta desde `estado` y el texto
  llega entero en `listo`. Selector de modo dentro del cuadro de texto.
- Bloque de razonamiento en vivo: plan por puntos (solo si hay más de un punto), estado de cada
  punto según llegan los hops, búsquedas extra aparte.
- Panel de fuentes con la misma cita que usa el modelo (`fuente` y `locator` resueltos),
  sección, snippet, grado del calificador y puntos del plan que la trajeron. Clic en una cita
  del texto enfoca su fuente.
- Tabla de cobertura al terminar, en lenguaje claro y sin ids internos.
- Informe de atribución plegable, cerrado por defecto salvo que haya algo grave.
- Lista de conversaciones, crear, continuar, borrar. Feedback por mensaje.
- Documentos: listado para todos; subida con progreso real (XMLHttpRequest), reindexar y
  borrar solo para administradores; el límite anunciado sale de `estadisticas.sistema`.
- Ajustes (slide-over, bottom sheet en móvil): Usuarios y Sistema (admin), Mi cuenta (todos;
  sin cambio de contraseña en esta versión).
- Errores por código (`ConvexError`), nunca por comparación de cadenas. `acceso_revocado` y
  `no_autenticado` cierran la sesión y explican el motivo.
- Español, tema claro y oscuro, sin librerías de UI pesadas, PWA instalable.

## 16. Evaluación

Política: la evaluación offline es determinista (cobertura de evidencias esperadas, resolución
de citas, conceptos cubiertos por los hops, contenido obligatorio y prohibido, abstención) y
lee la fidelidad que midió el verificador en runtime en vez de introducir un juez propio. Los
casos los escribe y revisa el equipo investigador; el gate de release exige cero fallos
críticos.

Estado: el evaluador (`backend/evaluar.py`, `backend/app/evaluation.py`, plantilla en
`backend/evals/`) **sigue en Python y apunta a la API antigua** (`POST /api/chat` por SSE en
`http://localhost:8000`). No se puede ejecutar contra Convex hasta portarlo. Los patrones de
cita y de abstención que usa son los mismos que `lib/citas.ts`, a propósito, para que el port
mida lo mismo que mide producción. Mientras tanto, la forma de estresar el sistema es el arnés
interno `pruebas.ts` (OPERACION.md).
