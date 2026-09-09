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
7. **Un corpus por persona, y conversaciones privadas.** Los documentos, los fragmentos
   indexados y la conexión con Notion pertenecen a una cuenta, y una búsqueda solo puede ver
   los de quien pregunta: es una frontera de seguridad, no un filtro de conveniencia. Ni un
   administrador ve el corpus ni las conversaciones de otra persona.
8. **Respuestas en español**, sin guion largo (U+2014): se separa con comas, puntos o dos
   puntos. La regla está en el prompt y también rige para el código y la documentación.

## 2. Stack

| Pieza | Qué es |
|---|---|
| Backend | Convex (TypeScript): tablas, índices vectorial y de texto, almacenamiento de ficheros, funciones públicas e internas, acciones de hasta 600 s. |
| Autenticación | Convex Auth (`@convex-dev/auth`) con proveedor `Password`; Google opcional. |
| Modelos | AI Gateway de Vercel, por `fetch` sin SDK. `openai/gpt-5.4` (redactor, planificador, corrección), `openai/gpt-5.4-mini` (clasificador, calificador, verificador), `openai/text-embedding-3-large` (3072 dimensiones). |
| Frontend | React 18 + Vite + TypeScript, PWA. Habla con Convex por WebSocket (`useQuery`, `useMutation`). |
| Parseo | `unpdf` (pdf.js) para PDF; `jszip` + `fast-xml-parser` para `.docx` y `.xlsx`; un modelo de visión por el gateway para el OCR (sección 14). Solo `ingesta/pipeline.ts` y `ingesta/ocr.ts` corren en Node (`"use node"`); el resto, en el runtime por defecto de Convex. |
| Pruebas | vitest + convex-test en entorno `edge-runtime`, sin red. `tsc` para el frontend y para `convex/`. |
| Hospedaje | Vercel sirve `frontend/dist`; `npx convex deploy --cmd 'npm run build'` despliega funciones y construye. |

## 3. Datos

Esquema en `frontend/convex/schema.ts`. Decisiones clave, ya tomadas:

- **Los fragmentos viven en la tabla `chunks`**, con su vector en un índice vectorial
  (`porEmbedding`, 3072 dimensiones) y su texto en un índice de búsqueda (`porTexto`, BM25 más
  proximidad y coincidencias exactas). Los dos índices declaran los mismos ocho campos de
  filtro, y el primero es la frontera: `propietario`, `projectId`, `documentId`,
  `documentVersion`, `documentType`, `language`, `sourceFile`, `chunkType`.
- **Cada documento y cada fragmento tienen `propietario`** (`Id<"users">`), y todos los índices
  de `documents` empiezan por él. No hay ninguna lectura legítima que cruce corpus; la
  búsqueda recibe el propietario como argumento aparte de los filtros y `search.hybrid.cargar`
  lo comprueba en cada fragmento, incondicionalmente, y además descarta los fragmentos cuyo
  documento ya no existe (huérfanos de un borrado a medias no se citan).
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
`chunks`, `ingestionRuns`, las de Notion (`notionConexion`, `notionEstadosOauth`,
`notionPaginas`, `notionSincronizaciones`; sección 17), las cachés de determinismo (`planes`,
`consultasEmbebidas`, `calificaciones`; sección 8) y `ocrCache` (sección 14), más las de
Convex Auth (`authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes`,
`authVerifiers`, `authRateLimits`).

Nombres de índice: llevan todos sus campos (`porUsuarioYCreacion` = `["userId", "creadoEn"]`,
`porSesionYCreacion`, `porPropietarioYNombre`...), como pide la guía de Convex.

Campos de `messages` que escribe el agente: `estado`, `plan`, `hops`, `sources`, `content`,
`verificacion`, `metrics`, `error`. Campos de `documents` tras una ingesta correcta: `sha256`,
`pages`, `chunks`, `status`, `titulo`, `citation`, `doi`, `language`, `documentType`, y
`avisos` si algo quedó sin leer (sección 14). Además `propietario`, `storageId`, `origen`
(`subida` | `notion` | `google` | `onedrive`), `notionPageId` (páginas de Notion) y
`nubeFicheroId` (ficheros de Google Drive u OneDrive).

`documents.ingestaRunId` es la corrida de ingesta que posee el documento (la última que lo
reclamó); `ingestionRuns.latidoEn` su última escritura. La tabla `contadores` (`clave`,
`valor`) guarda las cifras de Ajustes: `preguntas`, `preguntas:dia:AAAA-MM-DD`,
`usuario:<id>:preguntas`, `usuario:<id>:sesiones`, `votos:arriba`, `votos:abajo`; las
actualiza la misma transacción que escribe o borra lo contado y `contadores.reconstruir` las
recalcula desde las tablas. `messages` lleva además el índice `porEstadoYCreacion` para el
barrido de turnos colgados.

Las listas que van al navegador están acotadas: `mensajes.deSesion` devuelve los últimos 200
mensajes de la conversación, `documentos.listar` hasta 5000 documentos y `sesiones.listar`
hasta 1000 conversaciones. Ninguna query lee el reloj (`Date.now()`): el instante lo manda el
cliente como argumento (`estadisticas.sistema`) o la query devuelve la fecha límite y decide
el cliente (`notion.admin.estado.enCurso.vivaHasta`).

## 4. Funciones públicas y permisos

Ninguna tabla se lee desde el navegador. Todas las funciones públicas empiezan por identificar a
quien llama (`permisos.ts`): sin sesión, `no_autenticado`; con la cuenta bloqueada,
`acceso_revocado` (se comprueba en **cada** llamada, no al entrar).

| Función | Tipo | Quién | Qué hace |
|---|---|---|---|
| `sesiones.listar` | query | usuario | `{_id, titulo, creadoEn}[]` propias, la más nueva primero. |
| `sesiones.crear` | mutation `{titulo}` | usuario | Conversación vacía; título recortado a 60 caracteres, "Nueva conversación" si va vacío. |
| `sesiones.borrar` | mutation `{sessionId}` | usuario, propia | Borra la sesión ya; sus mensajes y feedback en lotes de 100 (el primero inline, el resto agendado). |
| `mensajes.deSesion` | query `{sessionId}` | usuario, propia | Los últimos 200 mensajes en orden, filas completas. |
| `mensajes.enviar` | mutation `{sessionId?, texto, modo}` | usuario, propia | Crea la sesión si falta (título = primeros 60 caracteres), guarda la pregunta, crea el mensaje del asistente en `pensando` y agenda `agente.bucle.correr`. Devuelve `{sessionId, messageId}`. Texto vacío o de más de 4000 caracteres: `invalido`. |
| `mensajes.calificar` | mutation `{messageId, rating: 1 \| -1, comentario?}` | usuario, propia | Un voto por usuario y mensaje; repetir reemplaza. |
| `mensajes.detener` | mutation `{messageId}` | usuario, propia | Para el turno en marcha: lo deja en `cancelado`. Ver sección 6. Un turno ya cerrado devuelve `{detenido: false}` sin error; uno ajeno, `no_encontrado`. |
| `documentos.listar` | query | usuario | Su corpus: `{_id, fileName, pages, chunks, status, error, ingestadoEn, titulo, citation, avisos, sha256, origen, notionPageId}[]` en orden de ingesta. Nunca el de otra persona. |
| `documentos.limite` | query | usuario | El límite de subida en MB, para anunciarlo. |
| `documentos.urlDeSubida` | mutation | usuario | URL firmada del almacenamiento. |
| `documentos.registrar` | mutation `{storageId, fileName, sha256}` | usuario | Valida nombre, extensión, sha256, tamaño; registra en `processing` en el corpus de quien llama y agenda la ingesta. Nombre ya indexado en SU corpus: `conflicto`, salvo que el existente esté en `failed`, cuya fila se reutiliza. |
| `documentos.reindexar` | mutation `{documentId}` | usuario, propio | Vuelve a ingerir desde el fichero guardado. `conflicto` si sigue en `processing` hace menos de 10 minutos, o si no hay fichero. Ajeno: `no_encontrado`. |
| `documentos.borrar` | mutation `{documentId}` | usuario, propio | Borra fila y fichero ya; fragmentos en lotes de 100 (el resto agendado). Ajeno: `no_encontrado`. |
| `notion.oauth.iniciar` | mutation `{origen}` | usuario | Crea un `state` ligado a la cuenta y devuelve la URL de autorización de Notion (integración pública, `owner=user`). |
| `notion.oauth.listarBases` | action | usuario, conectada | Las bases de datos que la integración ve en SU Notion. |
| `notion.oauth.elegirBases` | mutation `{bases: {databaseId, titulo}[]}` | usuario, conectada | Reemplaza la selección (hasta 20 bases). |
| `notion.oauth.desconectar` | mutation | usuario | Borra su conexión y sus `state` pendientes; el corpus se conserva. |
| `notion.admin.estado` | query | usuario | Su conexión (sin token), sus bases, cifras y corridas; `enCurso` lleva `vivaHasta`. |
| `notion.admin.sincronizarAhora` | mutation | usuario, conectada | Agenda una corrida forzada. `conflicto` si ya hay una en curso. |
| `nube.oauth.iniciar` | mutation `{proveedor, origen}` | usuario | Crea un `state` ligado a la cuenta y al proveedor (`google` \| `onedrive`) y devuelve la URL de autorización (solo lectura, con refresh token). |
| `nube.oauth.listarCarpetas` | action `{proveedor}` | usuario, conectada | Las carpetas que puede ver en esa nube, con su ruta; renueva el token si hace falta. |
| `nube.oauth.elegirCarpetas` | mutation `{proveedor, carpetas: {id, nombre, ruta?}[]}` | usuario, conectada | Reemplaza la selección (hasta 20 carpetas; en Google acepta la URL pegada). |
| `nube.oauth.desconectar` | mutation `{proveedor}` | usuario | Borra su conexión con ese proveedor y sus `state`; el corpus y el otro proveedor se conservan. |
| `nube.admin.estado` | query `{proveedor}` | usuario | Su conexión (sin tokens: cuenta, `necesitaReconexion`), sus carpetas, cifras y corridas; `enCurso` lleva `vivaHasta`. |
| `nube.admin.sincronizarAhora` | mutation `{proveedor}` | usuario, conectada | Agenda una corrida forzada. `conflicto` si ya hay una en curso. |
| `usuarios.yo` | query | cualquiera | `{_id, email, rol, bloqueado}`, o `null` sin sesión. Bloqueado: `acceso_revocado`. |
| `usuarios.listar` | query | admin | Cuentas con `creadoEn`, `ultimoAccesoEn`, `sesiones` y `mensajes` (preguntas, no turnos). Solo cifras, nunca texto. |
| `usuarios.actualizar` | mutation `{userId, rol?, bloqueado?}` | admin, otro | Asciende, degrada, bloquea o desbloquea. Sobre uno mismo: `invalido`. |
| `usuarios.borrar` | mutation `{userId}` | admin, otro | Cascada a mano: sesiones, feedback y sus contadores ya; mensajes, corpus entero (documentos, fragmentos, ficheros) y rastro de Notion y de las nubes por lotes agendados; filas de Convex Auth; la cuenta. |
| `estadisticas.sistema` | query `{ahora}` | admin | Ver sección 13. `ahora` lo manda el cliente redondeado. |
| `semilla.ascenderSiPreasignado` | mutation | usuario | Si el correo propio está en `adminsPreasignados`, pasa a `admin`. Sin argumentos: solo sobre uno mismo. |

Funciones internas (solo `npx convex run` o el planificador de Convex): `semilla.sembrarAdmins`,
`pruebas.*`, `agente.bucle.correr`, `agente.cachePlan.*`, `agente.cacheCalificaciones.*`,
`ingesta.pipeline.ingestar`, `ingesta.escritura.*`, `mensajes.actualizarTurno`,
`mensajes.borrarRestantes`, `mensajes.marcarColgado`, `documentos.borrarChunksRestantes`,
`documentos.borrarCorpusDeUsuario`, `notion.sync.sincronizar`, `notion.datos.*`,
`notion.oauth.guardarConexion`, `crons.repartirSincronizaciones`, `search.hybrid.lexica`,
`search.hybrid.cargar`, `search.cacheEmbeddings.*`, `search.inventario.inventario`.

### Quién puede entrar

Solo correos de los dominios permitidos (`DOMINIOS_PERMITIDOS`, lista separada por comas; por
defecto `airobotix.net` y `alzheimerproject.com`), comparados como sufijo exacto tras la `@`
y en minúsculas: `x@evil-airobotix.net` y `x@airobotix.net.evil.com` no entran. Toda cuenta
nueva es `lector`, con su espacio completo (corpus, conversaciones, Notion); `admin` solo
añade gestionar cuentas. El frontend repite la lista para el mensaje de la pantalla de
entrada, pero la que decide es la del servidor.

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
| `buscando` | `plan` (ids, consultas, `query_en`, `evidence_needed`); un `hops` marcador por punto y después el hop de CADA punto en cuanto ese punto acaba; `sources` al terminar el plan | plan y recuperación de evidencia |
| `redactando` | `hops` y `sources` se actualizan con cada búsqueda extra; `progreso` con las afirmaciones ya juzgadas sobre la marcha | mientras el modelo escribe |
| `revisando` | `progreso`: "Comprobando N afirmaciones · k de N listas", "Corrigiendo N afirmaciones sin respaldo · ronda r de R" | barrera de fidelidad |
| `listo` | `content`, `sources`, `hops` (con `estado_final` y `usado_en_respuesta` en los del plan), `verificacion`, `metrics` | publicación |
| `error` | `error` (mensaje recortado a 500 caracteres), `metrics` | cualquier excepción |
| `cancelado` | nada: se conserva lo ya escrito | la usuaria pulsó parar (`mensajes.detener`) |

**`content` queda vacío hasta `listo`.** El texto llega de golpe.

**`progreso`** es una frase para la usuaria que dice qué pasa dentro de una fase larga. Medido
con pruebas externas el 8 sep 2026: la fase `revisando` estaba muda hasta dos minutos y el
evaluador la dio por colgada. La escribe el bucle a partir de los avisos del verificador (uno
por lote de afirmaciones que vuelve del juez, `OpcionesVerificacion.alAvanzar`) y del revisor
(`OpcionesRevision.alAvanzar`, un evento por ronda de corrección), solo cuando el texto cambia.
La interfaz lo pinta como detalle del paso en curso y lo ignora cuando el turno es final.

**`alcance`** se escribe si la pregunta pidió limitarse a un documento (sección 7): `{pista,
documento, candidatos?, encontrado}`. La interfaz lo enseña en el paso de buscar ("solo en
«M6U1.pdf»", o por qué no se pudo acotar).

Una pregunta no documental (saludo, pregunta sobre el asistente) pasa de `pensando` a `listo`
con `sources: []`, `hops: []`, `plan: []` y sin `verificacion`.

**Parar.** `mensajes.detener` deja el turno en `cancelado`, que es un estado FINAL. La
cancelación es cooperativa, porque una acción de Convex no se puede abortar desde fuera: lo que
la hace real es que `actualizarTurno` rechace toda escritura sobre un turno cancelado, así que
el borrador que el agente estuviera revisando NUNCA se publica (principio 5) y lo ya escrito
(plan, hops, sources) se conserva, que es lo que quiere ver quien para. El agente lo detecta en
su siguiente escritura, abandona sin gastar más y no marca error. `cancelado` no lleva texto ni
mensaje de error: no es un fallo, es una decisión de quien pregunta.

Un turno que sigue en un estado no final pasados 630 s desde su creación (540 s de presupuesto
más margen) se cierra desde el servidor: `mensajes.enviar` agenda `mensajes.marcarColgado`,
que escribe `estado: "error"` con un mensaje de tiempo y no toca un turno ya `listo` ni ya en
`error`. El frontend, mientras, lo pinta como colgado por reloj sin tocar la base.

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

La misma llamada devuelve la **consulta autónoma**: el mensaje reescrito para que se entienda
sin el historial ("hazme un mapa mental" tras hablar de hipertensión pasa a "mapa mental de la
hipertensión arterial: ..."). Es lo que se BUSCA (el ancla `e0` del plan y la entrada del
planificador); lo que se redacta y se revisa sigue siendo el texto literal de quien pregunta.
Solo se acepta con historial (sin él no hay referencia que resolver y una paráfrasis cambiaría la
clave de la caché del plan), si trae algo y si no pasa de 600 caracteres; en cualquier otro caso
la consulta es el texto literal. Medido: en modo normal, que no tiene planificador, una
repregunta sin palabras del tema recuperaba un documento de Notion sobre diseño web y la
respuesta era "no encuentro hipertensión en los documentos". Contador `consultas_reformuladas`;
`metrics.meta.consulta_reformulada` dice si se usó.

La misma llamada devuelve también **`consulta_en`**, la consulta con los términos técnicos en
inglés. Es la `query_en` del ancla `e0` cuando no corre el planificador (modo normal): antes el
ancla se buscaba una sola vez, en español, contra un corpus en inglés, porque solo el
planificador traducía. Se acepta con o sin historial (no cambia qué se busca, añade el idioma
del corpus); vacía si es igual a la consulta o pasa de 600 caracteres. Se guarda en la caché
del plan como `preguntaEn`, así que la segunda vez que se hace la misma pregunta tampoco hace
falta llamar al clasificador para tenerla.

La misma llamada devuelve también **`documento`**: cómo se refiere el mensaje al documento al
que pide LIMITARSE ("el PDF M6U1", "el documento de Allegri", y también genérico: "el PDF
indexado"), o vacío si no pide limitarse a ninguno. Nombrar un documento sin pedir limitarse a
él no cuenta. Medido con pruebas externas el 8 sep 2026: "Usando únicamente el PDF indexado,
analiza este escenario" se buscaba en todo el corpus y la respuesta podía mezclar otros
documentos sin decirlo. La pista se resuelve sin modelo en `agente/alcance.ts` contra los
documentos listos de quien pregunta (nombre de fichero sin extensión y título, normalizados):

- **Con palabras que identifican** ("m6u1", "allegri"): el documento cuyo nombre las lleva
  TODAS, como palabra entera o principio de una (nunca trozo interior). Si más de uno las lleva,
  no se elige ninguno (`ambiguo`); si ninguno, `desconocido`.
- **Pista genérica** (solo artículos, genéricos y formato): si hay UN solo documento de ese
  formato es ese (el caso medido); si hay varios, `ambiguo`.

Con documento elegido, todas las búsquedas del turno (plan y extras, incluido el reintento que
relaja los filtros del modelo) llevan `documentId`; si la búsqueda acotada no trae nada se
repite sin filtro y el redactor recibe la orden de empezar diciendo que ese documento no lo
trata y de no atribuirle nada. Con `ambiguo` o `desconocido` se busca en todos y el redactor
tiene que decir de qué documento sale cada dato. La pista se guarda en la caché del plan
(`planes.documento`) para que la segunda vez, sin clasificador, el alcance no se pierda.
Telemetría: `meta.alcance_pista`, `meta.alcance` (`elegido` | `ambiguo` | `desconocido` |
`sin_pista`), `meta.alcance_documento`; contadores `alcance_pedido`, `alcance_sin_resultados`.

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
  inglés), `variantes` (hasta dos reformulaciones en inglés con sinónimos, siglas o nombres
  alternativos: "MCI" y "mild cognitive impairment", el nombre comercial y el principio
  activo) y `evidence_needed` (el dato concreto, con población y desenlace), y además
  `pregunta_en`, la pregunta entera en inglés, que pasa a ser la `query_en` de `e0`, y
  `variantes_pregunta`, las reformulaciones de la pregunta entera, que pasan a ser las
  `variantes` de `e0`.
- Post-proceso estricto: ids por posición (`e1..eN`), sin consultas equivalentes (misma clave
  normalizada), un item igual a `e0` se descarta, una `query_en` igual a su `query` queda vacía,
  y las variantes se limpian (sin vacías, sin repetir la consulta ni su inglés ni entre sí,
  ninguna de más de 300 caracteres, dos como mucho). Si el planificador falla, el plan es solo
  `e0` y el fallo queda en telemetría.
- En modo normal no hay planificador: `e0` se busca en español y con la `consulta_en` del
  clasificador (sección 7). Si el clasificador no la dio, se busca una sola vez y la cabecera del
  punto lo dice ("buscado solo con la formulación original"); la búsqueda extra del modelo, con
  los términos en inglés, es el remedio antes de declarar ausencia.

### 8.2 Búsqueda híbrida (`search/hybrid.ts`)

Reemplaza a la fusión que hacía Qdrant en el servidor.

- Las consultas de un punto (original, inglés y reformulaciones) se embeben en **una**
  petición y sus listas se fusionan por RRF: una reformulación es una lista más.
- **Lado denso**: `ctx.vectorSearch` sobre `porEmbedding`, límite
  `min(256, max(20, k * 2))` (`k * 4` si hay filtros residuales). La búsqueda vectorial de
  Convex solo admite `eq` y `or`, no AND entre campos: el filtro del índice es `documentId` si
  se pidió uno, y si no `propietario` (la frontera del corpus, que así deja de ser residual);
  `projectId`, `documentType` y `language` se aplican siempre al cargar.
- **Lado léxico**: dos índices de búsqueda, `porTexto` sobre el texto del fragmento y
  `porContexto` sobre la frase de contexto que se escribe al indexar (sección 14), los dos con
  **todos** los filtros encadenados (AND) y límite `min(1024, max(20, k * 2))`, fusionados
  entre sí por RRF antes de fusionarse con el denso. Un fragmento sin `contexto` (anterior a la
  marca) solo está en el primero y sale igual que antes; si el índice del contexto falla, el
  del texto responde solo y queda en el log. La consulta se reduce a como mucho 16 términos de
  hasta 32 caracteres, sin puntuación ni palabras vacías, priorizando los que llevan dígitos o
  mayúsculas (p-tau217, APOE4, MMSE), que son los que el vector peor distingue.
- La unión de candidatos se carga por lotes de 64 **sin el vector**; ahí se aplican los filtros
  residuales.
- **Fusión RRF** con `k = 60` y orden total: puntuación, `sourceFile`, `page`, `_id`. El
  `score` del fragmento es su suma RRF.
- `k` = `SEARCH_TOP_K` (60) por consulta.
- `recuperacion` por consulta: `hibrida` (los dos lados), `densa` (falló el léxico o la
  consulta no dejó términos), `lexica` (fallaron los embeddings o la vectorial), `error`
  (fallaron los dos o la carga). **`error` no es "no está en los documentos"** y nunca se
  lanza: el llamador lo distingue. **Y una búsqueda parcial (`lexica` o `densa`) sin
  resultados tampoco lo es**: al modelo se le dice que la ausencia no es concluyente y que no
  afirme que los documentos no lo tratan, y el frontend lo pinta como "búsqueda incompleta",
  nunca como "no está en los documentos".
- **Cachés de determinismo.** El plan de una pregunta sin historial se guarda en `planes`
  (clave: versión del prompt, modelo y pregunta normalizada; caduca a los 30 días), los
  vectores de las consultas en `consultasEmbebidas` y los veredictos del calificador en
  `calificaciones` (clave: versión del prompt del calificador, modelo, consulta, evidencia
  necesaria y fragmento; solo se guardan los de una calificación que sí se aplicó). El plan
  cacheado guarda también `preguntaEn` y las `variantes` de la pregunta. Son lo que hace que la misma pregunta recupere la
  misma evidencia. Se leen con `.first()`, nunca `.unique()`: dos filas con la misma clave son
  inofensivas. Contadores: `embeddings_en_cache`, `calificaciones_en_cache`.
- Un filtro con un valor que no existe devuelve cero. En las búsquedas extra del modelo, si
  con filtros no sale nada, el bucle repite sin filtros y avisa al modelo de que esos valores
  no existen.

### 8.3 Ejecución de un punto (`agente/evidencia.ts`)

1. `recuperar`: híbrida de `query`, de `query_en` si difiere y de cada `variante` que difiera
   de las anteriores; las listas se fusionan por RRF. Si alguna falla se sigue con las otras; la
   `recuperacion` del punto es la más degradada de las que respondieron. Si fallan todas, el
   punto queda en `error`.
2. **Poda** de secciones que nunca son evidencia: bibliografía, referencias, agradecimientos,
   financiación, conflictos de interés.
3. **Deduplicación** por `_id` y por texto normalizado idéntico. Nunca por solape parcial: dos
   fragmentos contiguos comparten el párrafo de solape y son dos evidencias. Los 20 primeros de
   esta lista quedan como `candidatos` del punto (fichero, página, páginas, sección y
   localizador) y viajan a `metrics.meta.recuperacion`: es lo que permite distinguir después un
   fallo de recuperación (la evidencia esperada no estaba entre los candidatos) de uno de
   calificación (estaba y no llegó a las fuentes).
4. **Preselección** de `candidatosPorPunto` con cuota mínima de 3 por documento
   (`CUOTA_CANDIDATOS`), para que un paper largo no expulse al resto antes de que nadie los
   lea. Las tablas nunca se desplazan. Los documentos de los que salen los candidatos quedan
   en `documentosRevisados` (máximo 5).
5. **Calificador** (`agente/calificador.ts`): modelo pequeño, razonamiento
   `RERANK_REASONING_EFFORT`, juicio **por fragmento y sobre el texto completo**, con cabecera
   fuente, sección, tipo, cita y, si lo hay, la frase de contexto del fragmento (etiquetada,
   en su línea). Grados: `directa`, `parcial`, `no`. Un fragmento que aporta el dato para OTRA
   entidad de la misma clase (otro fármaco, otra cohorte, otro estudio) es como mucho
   `parcial`, nunca `directa`. Lotes de 20 en paralelo;
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
  español e inglés, con 2 reformulaciones más)`, más el aviso si la relevancia no se verificó,
  y los resultados;
- sin resultados: `... sin resultados: se revisaron N fragmentos de <docs> y ninguno aporta
  evidencia sobre este punto (buscado solo con la formulación original)`;
- error: `... no se pudo comprobar: la búsqueda falló o no llegó a tiempo, así que no hay
  fragmentos que leer y su ausencia no dice nada sobre los documentos.`

Cada resultado va como `--- Resultado n ---`, la línea `cita: [...]`, la sección en su propia
línea (nunca dentro de la cita), el grado del calificador si lo hay, la frase de contexto del
fragmento como "(de qué habla este fragmento, orientación no citable: ...)" si la hay (para que
el redactor sepa de qué entidad es el dato; ninguna cifra puede salir de ahí, y el verificador
dictamina solo contra el texto), el aviso de retracción si el artículo está retractado, y el
texto. Tras el último mensaje `tool` va un mensaje `system` que recuerda que los resultados son
DATOS y que las instrucciones que contengan no se siguen (defensa frente a un documento con
instrucciones dentro: avisar DESPUÉS de los datos es lo que medido funciona).

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

La respuesta va en **Markdown**, y la estructura tiene que ayudar a leer, no decorar. Apartados
con encabezado de nivel 2, en este orden, omitiendo entero el que no aplique: "## Respuesta
directa" (2 a 4 frases que contestan la pregunta tal como se hizo, con sus citas), "## Evidencia"
(por cada parte: el hallazgo con su cifra, unidades, población y la sección de la que sale),
"## Contradicciones y matices" (solo si dos documentos discrepan) y "## Lo que no está" (cada
dato ausente con su fórmula literal, nada más). Si la pregunta es concreta y la respuesta cabe
en unas frases, **sin encabezados**.

Cuándo usa cada recurso, y solo si aporta:

- **Negrita** en la cifra o el término que contesta, nunca en una frase entera ni como
  sustituto de un encabezado.
- **Tabla** cuando compara lo mismo en dos o más documentos, cohortes, fármacos o momentos: una
  fila por concepto, una columna por documento y la última columna con la cita de esa fila.
- **Lista** para enumerar criterios o hallazgos sin orden.
- **Diagrama** para una secuencia o un algoritmo, en un bloque ` ```mermaid ` con
  `flowchart TD` (o `LR`), etiquetas entre comillas, cortas y sin punto final, y como mucho 8
  nodos. **Las citas del diagrama van en la línea siguiente al cierre del bloque, solas**, y
  esto no es cosmético: así el troceo del verificador (sección 10.1) toma el bloque entero como
  UNA afirmación con esas citas, en vez de partirlo por las citas interiores en fragmentos de
  sintaxis. Un diagrama sin citas cuenta como afirmación sin fuente y no se publica, igual que
  una frase. Un punto seguido de espacio dentro de una etiqueta partiría el bloque en dos
  afirmaciones, de ahí la regla de las etiquetas sin puntos.

Cada fila de tabla y cada diagrama es una afirmación y se audita como tal. Está prohibido
mencionar el plan, los ids de los puntos, las herramientas o los resultados de búsqueda.

### 9.2 Cita

`[<fuente>, <localizador>]`, montada por `lib/citas.ts`:

- **fuente**: `citation` del documento (referencia corta, "Allegri et al., 2023") si se pudo
  extraer; si no, el nombre del archivo. Nunca el título. La cita solo se emite si la autoría
  está **corroborada**: hay coautores, la línea tiene formato bibliográfico o iniciales, o el
  DOI de la obra aparece en la portada (la primera página). Un DOI de una referencia citada en
  la página 2 no corrobora nada. El precio es que un artículo de un solo autor sin DOI se cita
  por el nombre del fichero; el beneficio es que nunca se inventa un autor ("Pagina et al.,
  2026" era un pie de página).
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
  fragmento hermano (y su frase de contexto, etiquetada como NO evidencia). El tope acota el
  tamaño de cada petición, no cuánto se verifica. El juez recibe además la **pregunta** de
  quien consulta y, por cada afirmación, el **apartado** (encabezado de la respuesta) bajo el
  que iba, limpio de marcas y sin dos puntos.
- **Entidad.** El juez comprueba de quién es el dato: si la afirmación, por su texto, su
  apartado o la pregunta, lo atribuye a un fármaco, biomarcador, población, estudio o
  desenlace y el fragmento lo dice de OTRO, devuelve `entidad_distinta: true`, y el veredicto
  pasa a `no_sostenida` diga lo que diga el juez de la cifra. Es el fallo que las
  comprobaciones de fidelidad clásicas no ven ("deceptive grounding": la cifra es real, la
  cita resuelve, y el dato no es de quien se dice; medido en 2026 hasta en el 87 % de los
  casos en modelos clínicos). Bloquea la publicación como cualquier `no_sostenida`, la crítica
  al redactor pide atribuir explícitamente a la otra entidad o quitar, y el frontend lo pinta
  como "dato de otra entidad". Contador `entidad_distinta`. Cuando la afirmación misma nombra a
  la otra entidad, la atribución es correcta.
- Un veredicto se reutiliza entre rondas de corrección si la frase, la cita y el apartado son
  los mismos (`claveDeAfirmacion`): mover una frase a otro apartado la vuelve a juzgar.
- **Cifras e identificadores, deterministas.** Antes del juez se extraen las cifras de cada
  afirmación (sin las de sus citas), se normalizan (coma o punto decimal, separadores de
  miles, punto medio; "1.234" admite las dos lecturas) y se comprueba si aparecen en los
  fragmentos citados con límites de número: las que no, van al juez como pista ("cifras que NO
  aparecen literalmente: 30") y él decide si es un redondeo legítimo. Los **identificadores**
  (NCT, DOI, variantes rs, PMID) no admiten redondeo: uno que la frase nombra y ningún fragmento
  citado contiene es `no_sostenida` sin llamar al juez (contador
  `identificadores_sin_respaldo`).
- El contexto del fragmento (escrito por un modelo) puede hacer sospechar de otra entidad pero
  no basta para condenar: `entidad_distinta` exige que la otra entidad conste en el texto o en
  la cabecera del fragmento; si solo la nombra el contexto, el veredicto es `parcial`.
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

**Verificación anticipada.** El bucle verifica el borrador por párrafos según llega por el stream
del redactor (cada vez que hay al menos 700 caracteres nuevos acabados en párrafo completo), con
la misma función y las mismas opciones que la barrera; los veredictos del modelo se acumulan y la
barrera arranca con ellos (`veredictosIniciales`), así que su primera verificación solo juzga la
cola. No cambia ningún dictamen (la misma frase con la misma cita y el mismo apartado se juzga
igual, se juzgue cuando se juzgue); solapa los 40 a 114 s de la primera verificación con los 95
a 106 s de la redacción, medidos en producción el 8 sep 2026. Contador
`verificaciones_anticipadas`, `metrics.meta.veredictos_anticipados`. Antes de entrar en la
barrera se esperan como mucho 15 s a las anticipadas en vuelo; lo que no llegue se juzga otra vez.
Del mismo modo, sin historial el planificador arranca a la vez que el clasificador (la consulta
que planifica es la literal); con historial espera a la consulta autónoma.

El borrador llega al redactor de la corrección como texto de OTRO redactor, dentro del mensaje
del usuario y entre delimitadores, no como un turno `assistant` propio: medido en 2026 sobre
doce combinaciones de modelo y dominio, un modelo corrige mucho más un error que lee como ajeno
que uno que reconoce como suyo (entre 23 y 93 puntos más de correcciones explícitas). La
crítica va detrás, en el mismo mensaje.

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
6. **Tope con un borrador ya verificado.** Si el reloj vence (o la corrección lanza) DESPUÉS
   de que el verificador haya juzgado un borrador, se publica ese último borrador verificado
   recortado de sus frases bloqueantes y de las citas que no resolvían, con el informe de las
   afirmaciones que quedan (recalculados fidelidad y cobertura) y una nota que lo dice; el
   resultado lleva `publicadaTrasTope: true` y el bucle anota
   `metrics.meta.barrera.publicada_recortada`. No hay verificación nueva del texto recortado:
   solo quita frases enteras ya juzgadas. Medido: la misma pregunta que había salido con 52
   afirmaciones comprobadas acabó dos veces en abstención por `timeout` con evidencia en los
   cinco puntos, porque el verificador tardó 167 s en vez de 40.
7. Si el recorte no deja nada verificable, no se localiza alguna frase, vence el tope antes de
   la primera verificación, no hay señal del verificador o algo lanza sin candidato:
   **abstención segura**, verificada también para que traiga cobertura. El resultado lleva
   `motivoAbstencion` (`borrador_vacio`, `sin_senal`, `rechazada_tras_correccion`, `timeout` o
   `error`) y `informeBorrador`, el último informe real del borrador o de su corrección; el
   bucle los guarda en `metrics.meta.barrera` para que una abstención se pueda diagnosticar.

Las rondas **reutilizan los veredictos**: una afirmación cuya frase y cita no cambiaron entre
el borrador y su corrección no se vuelve a mandar al verificador (clave: texto con espacios
colapsados más la cita; solo veredictos del modelo, nunca `sin_verificar`). Es lo que hace que
la segunda y tercera verificación de un turno cuesten solo lo que el redactor tocó. Contador:
`veredictos_reutilizados`.

Abstención segura, literal: "No puedo ofrecer una respuesta verificable con la evidencia
recuperada. No encuentro respaldo suficiente en los documentos para responder con la fidelidad
requerida."

Tras la barrera, la cobertura vuelve a los `hops` del plan (`estado_final`,
`usado_en_respuesta`), que es lo que persiste y con lo que la interfaz reconstruye la tabla al
reabrir una conversación.

## 12. Formas que consume el frontend

Claves en snake_case dentro de estos objetos. Tipos en `frontend/src/types.ts`.

**`plan[]`**: `{id, query, query_en, evidence_needed, variantes?}` (las reformulaciones, solo
cuando las hay). `e0` no se muestra como fila; con plan `[e0]` (modo normal) no hay vista por
puntos.

**`sources[]`** (todo lo entregado al modelo, orden estable):
`source_file, page, project_id, document_id, section, language, document_type, source_pages,
snippet` (240 caracteres), `score, chunk_type, title, citation, doi, locator, fuente,
plan_items[], grado` (`directa` | `parcial` | vacío = sin calificar, que no significa "no"),
`retraccion` (`retractado` | `retirado` | `preocupacion` | vacío).

**`hops[]`**: `n, query, origen` (`plan` | `extra`), `plan_item` (id del plan o vacío),
`evidence_needed, resultados, nuevos?, documentos[]` (nombres únicos), `estado` (`cubierto` |
`sin_resultados`), `recuperacion` (`hibrida` | `densa` | `lexica` | `error`),
`relevancia_verificada, ms`, `en_curso` (la búsqueda sigue en marcha), y en los del plan tras la
barrera `estado_final` (`cubierto` | `parcial` | `evidencia_no_usada` | `sin_resultados`) y
`usado_en_respuesta`.

Los hops **se insertan antes de buscar** como marcadores con `en_curso: true`, y se completan (o
se sustituyen, en los del plan) en cuanto la búsqueda de ESE hop termina, con `en_curso: false`.
Los puntos del plan se buscan en paralelo pero acaban en momentos distintos, así que la interfaz
va marcando cada parte de la pregunta de una en una en vez de pasar de "todo pendiente" a "todo
hecho" cuando acaba el plan entero. `en_curso` es un campo y no una inferencia: antes se deducía
de "recuperación en error, cero resultados y cero ms", y una búsqueda que falla al instante deja
exactamente esos tres valores y se quedaba pintada como "buscando" hasta que cerraba el turno
(cazado con un test adversarial). En un turno ya cerrado un marcador es un fallo real, porque
nadie va a completarlo. Los mensajes anteriores al campo se siguen leyendo con la inferencia
antigua. Un hop extra con `plan_item` actualiza el estado de ese punto. El inventario aparece
como hop extra con `query: "inventario de documentos"`.

**`verificacion`**: `afirmaciones[]` (`texto, cita, veredicto, motivo, fragmento_id,
fragmentos[]`, y opcionales `entidad_distinta` y `encabezado`), `evidencia_sin_cubrir[]`, `cobertura[]` (`id, evidence_needed, estado,
n_fragmentos, documentos[], afirmaciones[]` con índices en `afirmaciones`),
`citas_sin_resolver[]`, `fidelidad` (número o `null`), `ok`, `nota`.

La interfaz pinta la cobertura con el informe si lo hay y, si no, la reconstruye desde los
hops. Además de los cuatro estados del contrato usa tres propios para no afirmar lo que no
sabe: `encontrada` (hubo fragmentos y nadie dijo si se usaron), `no_buscado` (punto del plan
sin hop) y `error_busqueda` (la búsqueda falló). El informe de atribución resume el fallo, no
el acierto, y `sin_verificar` se pinta como aviso, nunca como aprobado.

**`progreso`** (cadena) y **`alcance`** (`{pista, documento, candidatos?, encontrado}`): sección 6.

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
`verificador`, `revisor`. La ingesta guarda su propia telemetría (componentes `embeddings` y
`contexto`) en `ingestionRuns.stats.telemetria`.

Contadores: `hops_plan`, `puntos_sin_resultados`, `hops_extra`, `hops_con_error`,
`llamadas_repetidas`, `forced_final`, `razonamiento_rechazado`, `respuestas_revisadas`,
`abstenciones_seguras`, `puntos_no_usados`, `rondas_sin_usage`, `recuperacion_<modo>`,
`recuperacion_error`, `lado_denso_caido`, `lado_lexico_caido`, `carga_fragmentos_caida`,
`entidad_distinta`, `veredictos_reutilizados`.

`meta`: `prompt_version`, `model`, `modo`, `clase`, `huella_evidencia`, `recuperacion` (por
punto del plan y por búsqueda extra `extra:<n>`, los hasta 20 candidatos fusionados antes del
calificador como `{f, p, sp?, sec?, loc}`: fichero, página, páginas, sección y localizador),
`verificacion` (recuento por veredicto incluido `entidad_distinta`, `citas_sin_resolver`,
`fidelidad`, `ok`, `revision_previa`, `revisiones`, `abstencion_segura`, `cobertura`) y, solo
cuando hubo abstención segura,
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
   legible, error (distinguiendo "imagen sin texto" de "el servicio de lectura falló, vuelve a
   intentarlo"). No hay tope de fragmentos por documento: si tarda, se ve el avance.
3. Los fragmentos se encolan en `fragmentosPendientes` y una cadena de acciones `embeber` los
   contextualiza y embebe: por cada grupo de la cola, primero un modelo pequeño escribe la
   **frase de contexto** de cada fragmento (ver más abajo), y después se embebe `contexto +
   texto` en lotes de 96 (tres lotes en paralelo) y se escribe cada lote en mutaciones de como
   mucho 32 fragmentos (un fragmento lleva 3072 números y los argumentos de una mutación desde
   Node tienen un tope de 5 MiB). Cada acción trabaja unos 7 minutos y pasa el relevo a la
   siguiente con el cursor, así que un documento de cualquier tamaño termina; el avance (fase
   `leyendo` página a página o `embebiendo` fragmento a fragmento, hecho de total, desde
   cuándo) se escribe en `documents.progreso` y la ficha pinta barra y tiempo estimado.
4. Solo después de escribir la versión nueva se retira la anterior. Un fallo de embeddings no
   deja al documento sin versión consultable.
5. Éxito: `ready` con `pages`, `chunks`, `titulo`, `citation`, `doi`, `language`,
   `documentType`, `indiceVersion` (la receta con la que se escribió el índice) y, si algo quedó
   sin leer, `avisos` (`{sinLeer, omitidas, recortados, sinContexto, motivo}`: páginas o
   imágenes cuyo OCR falló, imágenes omitidas por el tope, fragmentos recortados, fragmentos
   sin su frase de contexto); la corrida en `ingestionRuns` como `completed` con `stats`
   (incluido `contextos_fallidos`). Un documento con
   avisos se consulta igual, pero la ficha lo dice en ámbar, enseña el motivo y ofrece
   reintentar. Fallo: `failed` con el mensaje (500 caracteres), sin fragmentos a medias de la
   versión nueva, y la corrida `failed`.

**Recuperación contextual** (`ingesta/contexto.ts`). Por cada fragmento, un modelo pequeño
(`CONTEXT_MODEL`, por defecto el del calificador; razonamiento `CONTEXT_REASONING_EFFORT`,
`low`) escribe una o dos frases que lo sitúan en su documento: de qué estudio, población,
intervención, biomarcador o tabla habla, a qué se refieren sus cifras y pronombres, en qué
sección está, y las siglas y variantes de escritura de sus términos ("Aβ42 (Abeta42, amyloid
beta 42)"). Se contextualiza por grupos de 12 fragmentos consecutivos por llamada, con la ficha
del documento (título, cita, secciones, comienzo) delante, y las llamadas del grupo de embebido
van en paralelo. La frase se guarda en `chunks.contexto`, entra en el embedding (contexto +
texto) y tiene su propio índice de búsqueda `porContexto`; el texto que lee el redactor y contra
el que dictamina el verificador sigue siendo `text`: una frase generada por un modelo no puede
sostener una cifra. Medición publicada de la técnica (Anthropic, 2024): 35 % menos fallos de
recuperación en los 20 primeros, 49 % con el contexto también en el índice léxico, 67 % con
reranking detrás. Si el modelo no puede contextualizar un grupo, sus fragmentos se indexan sin
contexto (como antes de existir), se cuentan en `avisos.sinContexto`, la ficha lo dice
("N fragmentos se buscarán con menos precisión") y reindexar lo reintenta.
`ENABLE_CHUNK_CONTEXT=false` lo apaga.

`VERSION_INDICE` (`ingesta/contexto.ts`) marca la receta del índice; `marcarListo` la escribe
en `documents.indiceVersion`. Cuando la receta cambia, `npx convex run migraciones:reindexarTodo`
recorre los documentos listos con otra versión y con fichero y agenda su ingesta de dos en dos
(la ingesta con contexto son cientos de llamadas por documento grande), esperando entre pasos;
`migraciones:estadoDelIndice` dice cuántos quedan. Cada documento enseña su barra de avance en
la biblioteca mientras se reindexa.

Al nacer, cada fragmento se limpia de lo que el índice de texto no sabe leer (`normalizarTexto`
en `chunking.ts`): ligaduras tipográficas ("ﬁ" en "ﬁnding"), guiones blandos y espacios duros.
No se aplica NFKC entero: convertiría "10²" en "102".

**Retracciones** (`convex/retracciones.ts`). Un artículo con DOI se comprueba en Crossref al
terminar de indexarse y, todos, una vez por semana (cron `comprobar retracciones`): si su
revista lo retractó, lo retiró o publicó una expresión de preocupación (`updated-by` en la API
pública de Crossref, que además incorpora la base de Retraction Watch), queda en
`documents.retraccion` (`tipo`, `fecha`, `avisoDoi`). Nada se borra: la médica puede querer
saber qué decía. Lo que cambia es que cada fragmento suyo llega al redactor y al calificador con
el aviso ("AVISO: este artículo fue RETRACTADO..."), el prompt prohíbe usarlo como evidencia de
un hecho (regla 15) y obliga a decir que está retractado si se menciona, la fuente se pinta en
rojo en el panel de fuentes (`sources[].retraccion`) y la ficha del documento lleva la insignia
"Artículo retractado". La petición a Crossref no lleva ningún correo: se identifica la
aplicación en el User-Agent. Un fallo de red no toca la marca; una comprobación limpia la borra.

Parseo por formato (los comentarios de cada módulo documentan los fallos medidos que motivaron
cada regla):

- **PDF** (`ingesta/pdf.ts`, `lineas.ts`, `paper.ts`): las líneas físicas se reconstruyen desde
  los items de pdf.js por coordenada vertical y, en una página a dos columnas, se separan por
  el canal vertical que ninguna línea cruza y se leen columna a columna (una línea que cruza
  el canal es de ancho completo y cierra la banda, y una fila de tabla a todo el ancho con
  vecinas alineadas no se parte aunque no lo pise); las filas de tabla se reconocen por
  geometría (huecos horizontales grandes, sin celdas de prosa larga), no por densidad de
  cifras, y dos o más seguidas forman una tabla propia: fragmentos `table` con las columnas
  reconstruidas por posición (`filasDeTablaPdf`), la cabecera repetida en cada bloque, la celda
  ausente vacía en su sitio y el rótulo y la sección en el contexto, con `tablaEnBloques`
  compartido con Word (`ingesta/tablas.ts`); una fila suelta sigue siendo un párrafo. Las
  líneas se unen en párrafos recomponiendo palabras cortadas con guion. La sección vigente se detecta por nombre
  (Methods, Resultados...) o por maqueta (línea corta, sin punto final, con más cuerpo o en
  negrita que el texto). Título, primer autor, año y DOI salen de la primera página con
  heurísticas; `citation` solo se rellena con autor y año, nunca con el título. La
  bibliografía se descarta por defecto; también las marcas de descarga y las cabeceras y pies
  que se repiten en el borde de las páginas. **Un fragmento nunca cruza de página**: se
  empaqueta por tramos de sección y de página, y el solape no arrastra la página anterior.
  Medido el 8 sep 2026 con pruebas externas: con fragmentos que cruzaban dos o tres páginas
  y la cita por la primera, el asistente citaba "pág. 32" para un dato de la 33, y el
  verificador le obligaba a citarla así. La única excepción es un párrafo cortado por el salto
  de página, que lleva las dos en `source_pages` y se cita por la primera, donde empieza.
  `page` es la página del fragmento, `source_pages` todas las que toca.
- **DOCX** (`ingesta/docx.ts`): se recorre el XML del paquete en orden de documento; los
  párrafos se agrupan por sección sin mezclar dos secciones en un fragmento; cada tabla es un
  fragmento `table` numerado que hereda la sección y el rótulo que la precede, con celdas
  combinadas (`gridSpan`) resueltas. Sin páginas.
- **XLSX y CSV** (`ingesta/tabular.ts`): fila de encabezado detectada (primera fila con dos o
  más celdas no vacías si al menos el 60 % son textuales); un fragmento por fila, "Campo:
  valor", `chunk_type` `table`, `page` = número de fila.
- **TXT y MD** (`ingesta/texto.ts`): párrafos por líneas en blanco empaquetados con solape;
  `page` = índice de fragmento. Codificaciones probadas: utf-8, windows-1252, iso-8859-1.
- **Imágenes** (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`; `ingesta/imagen.ts`): se leen por
  OCR y el Markdown resultante se trocea como un texto, con el primer encabezado como título.
- **`.doc`** se rechaza con un mensaje que dice cómo convertirlo.

**OCR** (`ingesta/ocr.ts`, `ENABLE_OCR`, `OCR_MODEL` por defecto `openai/gpt-5.4-mini`,
razonamiento `low`): los parsers no leen imágenes, se las entregan a una función `Ocr`
inyectada que devuelve `{texto, estado}` con `estado` en `ok` | `sin_texto` | `fallo` |
`omitida`. Se lee solo lo que no tiene texto: las páginas de un PDF con menos de
`OCR_MIN_TEXTO_PAGINA` (40) caracteres propios, las imágenes de un Word y las imágenes sueltas.
Las imágenes de una página se entregan al OCR según se extraen y la página se limpia después:
los píxeles de un escaneo (26 MB por página a 300 ppp) nunca conviven en memoria. Se admiten
RGB, RGBA, gris de 8 bits, bitonal de un bit por píxel (fax, CCITT) y máscaras de imagen. Una
página cuyo texto pdf.js no puede extraer entra igual por sus imágenes. Los píxeles se reducen
por factor entero hasta 2200 px de lado y se codifican como PNG. Tope `OCR_MAX_IMAGENES` (300)
por documento. Caché en `ocrCache` por sha256 de los bytes enviados, modelo y versión del
prompt: **compartida entre cuentas a propósito** (la clave es el contenido de la imagen, no
quién la subió, y el mismo escaneo no se paga dos veces) y sin caducidad. **Solo se cachean
las lecturas completas** (`finish_reason: stop` con contenido, incluido el "SIN TEXTO"
legítimo); un contenido nulo, un rechazo o un corte por longitud es `fallo`: no se guarda, y
reindexar vuelve a preguntar.

Troceo (`ingesta/chunking.ts`): objetivo 400 tokens, solape 60, párrafos de más de 500 tokens
partidos por oraciones, texto por fragmento recortado a 8000 caracteres **y el recorte se
cuenta** en `avisos.recortados`. Lo que puede evitarse se evita: una celda de hoja de cálculo
larga sale en varios fragmentos de la misma fila, y la cabecera de una tabla de Word que pase
de la mitad del objetivo se reduce a su cola para que el bloque no degenere en "cabecera más
una fila". Cada fragmento repite los metadatos de la obra para que una cita no necesite ir a
buscar nada más.

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
- Informe de atribución plegable, **cerrado siempre** por defecto: con respuestas largas
  abrirlo solo era medio metro de scroll, y la cabecera ya dice qué pasa y en qué color.
- **Botón de parar** en el sitio del de enviar mientras el turno está en marcha
  (`mensajes.detener`). Un turno `cancelado` se pinta con una nota neutra, no como un error, y
  conserva sus pasos.
- Markdown propio, sin dependencias, para todo lo de la sección 9.1. La excepción es el
  diagrama: Mermaid se carga con `import()` dinámico solo cuando una respuesta trae uno (su
  trozo lo cachea el service worker), en `securityLevel: 'strict'` porque el código lo escribe
  un modelo, con el tema del momento, y si no carga o no compila cae a una lista de pasos
  legible en vez de dejar un hueco.
- Lista de conversaciones, crear, continuar, borrar. Feedback por mensaje.
- Documentos: el corpus propio, en un panel y en una vista de todos con búsqueda, filtros y
  orden; subida de archivos y de carpetas enteras (arrastre o botón, con el mismo tope de 500
  por tanda en ambos caminos, dedupe por sha256 excluyendo los `failed`, y cada omisión o
  fichero ilegible dicho en el resumen); progreso real (XMLHttpRequest); reindexar y borrar lo
  propio; el límite anunciado sale de `documentos.limite`. Un documento listo con avisos lleva
  su insignia ámbar. La vista de todos es un diálogo modal con trampa de Tab y deja inerte el
  panel de debajo.
- El foco vuelve al cuadro de texto al terminar cada respuesta si estaba suelto. Un fallo al
  guardar una valoración se dice al lado de los pulgares.
- Ajustes (slide-over, bottom sheet en móvil): Mi cuenta y Calidad (todos), Usuarios y Sistema
  (admin). Sin cambio de contraseña en esta versión.
- Calidad (`components/CalidadTab.tsx`, `lib/calidad.ts`): proponer preguntas de control
  (`evaluacion.datos.generar`, con el avance de la generación), revisar las propuestas
  (pregunta, respuesta esperada editable, documentos esperados, categoría en palabras;
  "Correcta" o "Descartar"), "Evaluar ahora" con el avance de la corrida, e historial de
  corridas con sus cifras y, por corrida, cada pregunta con "Pasa"/"Falla" y los fallos en
  frases. Nada de claves, identificadores ni patrones del evaluador en pantalla (hay un test
  que lo comprueba).
- Errores por código (`ConvexError`), nunca por comparación de cadenas. `acceso_revocado` y
  `no_autenticado` cierran la sesión y explican el motivo.
- Español, tema claro y oscuro, sin librerías de UI pesadas, PWA instalable.

## 16. Evaluación

Política: la evaluación offline es determinista (cobertura de evidencias esperadas, resolución
de citas, conceptos cubiertos por los hops, contenido obligatorio y prohibido, abstención) y
lee la fidelidad que midió el verificador en runtime en vez de introducir un juez propio. Los
casos los propone un modelo a partir del corpus y los revisa quien lo conoce (la médica, en
Ajustes > Calidad); el gate de release exige cero fallos críticos.

**Evaluación continua** (`convex/evaluacion/`). Por cada persona y sobre SU corpus:

- `generar.ts` muestrea fragmentos del corpus (sin bibliografía ni agradecimientos) y pide al
  modelo grande casos de cinco categorías: `single_hop` (un dato de un fragmento), `multi_hop`
  (dos documentos con una entidad o tema común), `tabla` (fragmentos `table`), `abstencion`
  (algo plausible que NO está: se comprueba con la búsqueda léxica que sus términos clave no
  devuelven nada) y `entidad` (la trampa de atribución: dado un fragmento sobre Y, preguntar por
  una X de la misma clase que no está en el corpus, con abstención esperada). Cada caso se
  valida con `puntuar.validarCaso` y queda `propuesto` en `evaluacionCasos` con una
  `respuestaEsperada` en llano y una `clave` estable (`<categoria>-<nnn>`). El avance va en
  `evaluacionGeneraciones`.
- `datos.ts` son las funciones públicas de la pestaña (`casos`, `revisar`, `editarRespuesta`,
  `borrarCaso`, `generar`, `generacionActual`, `evaluarAhora`, `corridas`, `resultadosDe`),
  todas acotadas al propietario.
- `correr.ts` responde los casos `aprobado` con el agente REAL: un caso (y una repetición) por
  acción encadenada, en una conversación **oculta** (`sessions.oculta`) que no se lista, no
  suma a los contadores y se borra al puntuarla; el turno se sondea hasta su estado final o
  570 s; un turno en `error` puntúa como fallo y la corrida sigue. El resultado por caso va a
  `evaluacionResultados` (puntuación agregada con `agregarCorridas` y las corridas crudas
  recortadas) y el `Resumen` a `evaluacionCorridas`. Cron semanal (`repartir`: una corrida
  `programada` por persona con al menos 5 casos aprobados y sin corrida en 6 días) y
  `cerrarColgadas` cada 30 minutos.
- Métricas de recuperación (`puntuar.ts`), a partir de `metrics.meta.recuperacion`:
  `retrieval_mrr`, `retrieval_hit_at_5`, `retrieval_hit_at_20`, `context_precision`,
  `entity_misattributions`, y por evidencia esperada no encontrada la etapa del fallo
  (`retrieval`: no estaba entre los candidatos; `grading`: estaba y no llegó a las fuentes;
  `generation`: llegó a las fuentes y la respuesta no la citó). El resumen agrega medias y
  `failures_by_stage`. Sin `meta.recuperacion` (mensajes antiguos) quedan `null`.

Estado: portado a Convex. La puntuación determinista es `convex/evaluacion/puntuar.ts`
(cobertura de evidencias, resolución de citas, patrones de búsqueda, contenido obligatorio y
prohibido, abstención, fidelidad leída del verificador; agregado de N repeticiones por mediana
y mayoría estricta con dispersión; resumen con gate) y usa los patrones de cita y abstención de
`lib/citas.ts`, los mismos que el verificador en runtime. El runner es
`frontend/scripts/evaluar.ts`: lanza cada caso con `pruebas:prepararPregunta` contra el corpus
de la cuenta indicada (`--correo`), espera el turno final con `pruebas:leerTurno`, borra la
conversación de prueba y escribe el reporte JSON (`schema_version` 3, mismas claves que el
Python) en `frontend/evals/results/`. Contrato de los casos y uso en `frontend/evals/README.md`.
El Python (`backend/evaluar.py`) queda como referencia histórica.

## 17. Notion

- **Integración pública de Notion (OAuth, `owner=user`)**: cada persona conecta SU Notion desde
  un botón; la pantalla de consentimiento va en una ventana emergente que vuelve a
  `/notion/callback` (HTTP en Convex) y avisa a la aplicación por `BroadcastChannel`. El
  `state` se crea ligado a la cuenta, se consume en la misma transacción antes de hablar con
  Notion, y los caducados se limpian por índice al crear uno nuevo. Ningún paso del callback
  termina en un error crudo: todos vuelven con `?notion=error&motivo=...`. El token nunca sale
  al navegador.
- **Varias bases por persona** (hasta 20). `elegirBases` reemplaza la selección entera.
- **Sincronización** (`notion.sync.sincronizar`, por cuenta): un cron horario
  (`crons.repartirSincronizaciones`) agenda una corrida por conexión con bases; "Sincronizar
  ahora" la fuerza. Cada base se lista entera antes de tocar nada; una página cuyo
  `last_edited_time` no cambió y cuyos documentos siguen vivos está intacta y no se descarga.
  El texto de la página se renderiza a Markdown (`notion-<titulo>.md`, solo si supera 200
  caracteres útiles) y sus adjuntos con formato admitido se bajan (tope 20 MB por adjunto,
  con timeout; el formato no admitido o el exceso de tamaño se dicen en los avisos de la
  corrida, sin marcar la página con error). Las páginas de una base que ya no están en ella
  (archivadas, excluidas por una propiedad `Excluir`, borradas) se retiran **solo si la base
  se recorrió entera**; una corrida cortada por el reloj (20 minutos) no retira nada, cierra
  como `parcial` y se reagenda al minuto si avanzó. Una corrida con errores de página cierra
  como `error`, parcial o no. Una corrida `running` sin cerrar se da por muerta a los 31
  minutos.
- **Base deseleccionada**: sus páginas y documentos se CONSERVAN (no se retiran ni se vuelven
  a mirar); la usuaria los borra a mano si quiere. Retirar corpus por dejar de sincronizar una
  base sería destruir lo que ella eligió tener.
- Al borrar la cuenta, su conexión, sus páginas y sus corridas se van por lotes.

## 18. Google Drive y OneDrive

- **Mismo modelo que Notion, generalizado a un `proveedor`** (`convex/nube/`): cada persona
  conecta SU cuenta desde un botón, el consentimiento va en una ventana emergente que vuelve a
  `/google/callback` o `/onedrive/callback` y avisa a la aplicación por `BroadcastChannel`
  (canal y marca propios, distintos de los de Notion). El `state` lleva el proveedor: uno de
  Google no vale en el callback de OneDrive, y se consume igual. Una conexión por persona y
  proveedor.
- **Permisos de solo lectura**: `drive.readonly` en Google; `Files.Read.All offline_access
  User.Read` en Microsoft. La aplicación nunca escribe en la nube de nadie.
- **Los tokens caducan** (una hora). `tokenVigente` renueva con el refresh token cuando quedan
  menos de 25 minutos antes de una corrida (2 minutos para llamadas cortas) y guarda el nuevo;
  Microsoft rota también el refresh token y se sustituye. Un 401 a mitad de corrida renueva
  UNA vez y repite la petición. Si el proveedor rechaza la renovación (400/401 en el punto de
  token: permiso revocado), la conexión queda `necesitaReconexion`, la corrida cierra con un
  motivo en llano, la periódica deja de intentarlo y la UI ofrece "Volver a conectar" (las
  carpetas elegidas se conservan si es la misma cuenta). Un fallo transitorio (5xx, red) no
  marca nada.
- **Carpetas**: hasta 20 por proveedor, con sus subcarpetas (profundidad 12, 2000 ficheros por
  carpeta; al pasar un tope se avisa y el listado queda INCOMPLETO, así que no se retira nada).
  Google ofrece "Mi unidad", las unidades compartidas y las carpetas con su ruta; OneDrive la
  raíz, tres niveles y lo compartido conmigo (ids compuestos `drive:<driveId>:<itemId>` que se
  resuelven a `/drives/{driveId}/items/{id}`).
- **Sincronización** (`nube.sync.sincronizar`, por cuenta y proveedor; el cron horario la
  reparte junto con las de Notion). Todas las carpetas se listan antes de tocar nada. Por
  fichero se compara `version` (md5 o fecha en Drive, cTag en OneDrive) con `nubeFicheros`; sin
  cambio y con su documento vivo, ni una petición. Con cambio se descarga (tope 20 MB, sin
  descargar si el tamaño anunciado ya pasa), se deduplica por sha256 contra todo el corpus y se
  registra por `documentos.registrarDesdeOrigen` con `origen = proveedor` y `nubeFicheroId`,
  reutilizando la fila anterior del mismo fichero (y conservando su nombre aunque se renombre
  en la nube). Los formatos nativos de Google se exportan (Documento → docx, Hoja → xlsx,
  Presentación y Dibujo → pdf; el resto se omite y se dice); los accesos directos, los
  cuadernos de OneNote, las extensiones no indexables y los ficheros que pasan del tope se dicen
  en los avisos de la corrida sin dejar fila. Un fichero que se MUEVE entre dos carpetas
  elegidas cambia de casa sin tocar su documento. Los que ya no están en una carpeta recorrida
  entera (y en ninguna otra elegida) se retiran si `DRIVE_DELETE_REMOVED` está activo
  (`retirado` en la fila si no). Reloj de 20 minutos, `parcial` y reagendado al minuto como en
  Notion.
- **Configuración del desarrollador**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (cliente OAuth
  "aplicación web" en Google Cloud con la API de Drive activada) y
  `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` (registro en Microsoft Entra, cuentas
  personales y de trabajo, redirect de tipo Web), con las URIs de redirección
  `${CONVEX_SITE_URL}/google/callback` y `${CONVEX_SITE_URL}/onedrive/callback`.
  `DRIVE_SYNC_MINUTES` (60) y `DRIVE_DELETE_REMOVED` (true). Sin credenciales, el bloque dice
  que la conexión aún no está habilitada por el equipo técnico.
- Al borrar la cuenta, sus conexiones, ficheros y corridas de las nubes se van por lotes.
