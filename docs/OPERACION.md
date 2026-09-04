# Operación del asistente

Guía para quien opera el sistema día a día: cuentas, documentos, telemetría, presupuestos y
qué hacer cuando algo se apaga. El contrato funcional está en [SPEC.md](../SPEC.md); el
panorama y el arranque, en el [README](../README.md).

Convenciones: los comandos se ejecutan desde `frontend/`. La CLI de Convex (`npx convex ...`)
actúa sobre el despliegue configurado en `frontend/.env.local`; comprueba a cuál apuntas antes
de tocar variables o datos, porque dev y producción son despliegues distintos con bases
distintas. El panel de Convex (dashboard) sirve para lo mismo con interfaz: pestañas Data,
Functions, Logs y Settings > Environment Variables.

---

## 1. Despliegues, variables y secretos

- Las variables del agente viven en el despliegue de Convex, no en Vercel ni en ficheros. Se
  fijan con `npx convex env set NOMBRE valor`, se listan con `npx convex env list` y se quitan
  con `npx convex env remove NOMBRE`. `config.ts` las lee en cada invocación, así que un cambio
  aplica a la siguiente pregunta sin redesplegar.
- Vercel solo necesita `CONVEX_DEPLOY_KEY` (clave de despliegue de producción) para el build.
- Local: `frontend/.env.local` con `CONVEX_DEPLOY_KEY` y `VITE_CONVEX_URL`. No se versiona.
- Secretos: la clave del gateway (`vck_...`), las claves de despliegue y las de Convex Auth
  (`JWT_PRIVATE_KEY`, `JWKS`) no se pegan en chats, issues ni ficheros del repositorio, que es
  público. La URL del despliegue (`VITE_CONVEX_URL`) sí es pública por diseño: quien protege
  los datos son las funciones, que comprueban quién pregunta.
- El proveedor de modelos es el AI Gateway de Vercel. Si en algún sitio aparece una clave
  `sk-proj-...` de OpenAI, no se usa: en septiembre de 2026 esa cuenta se quedó sin saldo y
  tumbó chat y embeddings a la vez.

Comprobación mínima de un despliegue nuevo:

```bash
npx convex env list                        # OPENAI_API_KEY, JWT_PRIVATE_KEY y JWKS presentes
npx convex run semilla:sembrarAdmins       # {insertados, total}
npx convex run pruebas:prepararPregunta '{"texto":"¿Cuántos documentos hay indexados?","modo":"normal"}'
```

## 2. Cuentas

### Sembrar administradores

```bash
npx convex run semilla:sembrarAdmins
```

Inserta en `adminsPreasignados` los correos de `semilla.ts` (`ADMINS_INICIALES`). Es
idempotente. Quien se dé de alta con uno de esos correos nace `admin`; el resto nace `lector`.
Para añadir otro correo a la lista sin tocar código: pestaña Data del panel, tabla
`adminsPreasignados`, fila nueva con `email` (en minúsculas) y `anadidoEn`.

### Ascender a administrador

Tres caminos, del más habitual al de emergencia:

1. Un administrador, en Ajustes > Usuarios, pulsa la fila y asciende (es
   `usuarios.actualizar` con `rol: "admin"`).
2. Quien se dio de alta **antes** de sembrar la lista entró como lector aunque su correo esté
   en ella. La mutación pública `semilla.ascenderSiPreasignado` lo corrige: solo puede
   ascender a quien la llama, y solo si la lista ya lo dice. Se puede lanzar desde el
   ejecutor de funciones del panel actuando como ese usuario.
3. Si no hay ningún administrador en el despliegue: pestaña Data, tabla `users`, editar el
   campo `rol` de la cuenta a `"admin"`.

Degradar es la misma mutación con `rol: "lector"`. Nadie puede cambiar su propia cuenta: la
mutación responde `invalido`, para que el último administrador no se degrade a sí mismo.

### Bloquear, desbloquear y borrar

- **Bloquear** (`usuarios.actualizar` con `bloqueado: true`, desde Ajustes > Usuarios): la
  cuenta deja de servir en la siguiente llamada, aunque tenga sesión abierta, porque el bloqueo
  se comprueba en cada función. La interfaz del bloqueado recibe `acceso_revocado`, cierra la
  sesión y explica el motivo. Se conservan la cuenta y sus conversaciones. Reversible con
  `bloqueado: false`.
- **Borrar** (`usuarios.borrar`): permanente. Borra sus conversaciones y valoraciones en la
  misma transacción, agenda el borrado de sus mensajes por lotes de 100, deja sin autor los
  documentos que subió (los documentos se conservan) y elimina sus filas de Convex Auth para
  que un alta posterior con el mismo correo no choque. Nunca sobre uno mismo.

### Dominio permitido

`DOMINIO_PERMITIDO` (default `airobotix.net`). Se comprueba en el alta y en cada entrada, así que
cambiarlo deja fuera a las cuentas antiguas de otro dominio. Las cuentas de pruebas del arnés
(`pruebas@airobotix.net`) las crea `pruebas.ts` directamente en la tabla, sin contraseña, y
no pueden entrar por la interfaz.

## 3. Documentos

### Subir

Desde la interfaz, panel Documentos, como administrador. El navegador calcula el sha256, pide
una URL firmada (`documentos.urlDeSubida`), sube el fichero directo al almacenamiento y lo
registra (`documentos.registrar`), que lo deja en `processing` y agenda la ingesta. El listado
está suscrito: el documento pasa a `ready` o a `failed` con su mensaje sin recargar.

Reglas: extensiones `pdf docx xlsx csv txt md`; tamaño hasta `UPLOAD_LIMIT_MB` (18 MB por
defecto); nombre saneado a `[A-Za-z0-9._-]`; un nombre ya indexado responde `conflicto` y hay
que borrarlo antes, salvo que el existente esté en `failed`, en cuyo caso se reutiliza su fila.

### Reindexar

Botón en el panel (`documentos.reindexar`). Reingesta desde el fichero guardado, sin volver a
subirlo, y sirve para reintentar un `failed` transitorio (timeout del gateway, corte) o para
reprocesar con un parser nuevo. La versión anterior sigue consultable hasta que la nueva está
escrita entera; luego se retira.

Guarda: si el documento sigue en `processing` hace menos de **10 minutos**
(`MINUTOS_PROCESSING_RANCIO`), responde `conflicto` para no correr dos ingestas del mismo
documento a la vez. Pasados 10 minutos se considera abandonado (la acción murió a mitad) y se
puede reintentar. Un documento sin fichero guardado no se puede reindexar: bórralo y súbelo.

### Borrar

Botón en el panel (`documentos.borrar`). La fila y el fichero desaparecen ya; los fragmentos
se borran en lotes de 300, el primero en la misma mutación y el resto agendado, así que durante
unos instantes una búsqueda puede seguir devolviendo alguno.

### Leer el estado de un documento

Panel de Convex, tabla `documents` (`status`, `error`, `pages`, `chunks`, `titulo`, `citation`,
`language`, `documentType`) y tabla `ingestionRuns` (`stats` con `pages`, `chunks`,
`tokens_embedding`, `chunks_retirados`, `ms` y `telemetria`). Por CLI, para un documento:

```bash
npx convex run pruebas:leerDocumento '{"documentId":"<id>"}'
```

Devuelve estado, metadatos y una muestra de tres fragmentos con su página, sección y tipo,
que es la forma rápida de ver si el parser leyó bien un fichero.

### Indexar un corpus de prueba por CLI

El camino público exige un administrador autenticado. Para un despliegue de dev hay dos
funciones internas sin autenticación:

```bash
URL=$(npx convex run pruebas:urlDeSubidaDePrueba | tr -d '"')
STORAGE_ID=$(curl -s -X POST "$URL" -H "Content-Type: application/pdf" --data-binary @estudio.pdf | sed 's/.*"storageId":"\([^"]*\)".*/\1/')
SHA=$(shasum -a 256 estudio.pdf | cut -d' ' -f1)
npx convex run pruebas:registrarDePrueba "{\"storageId\":\"$STORAGE_ID\",\"fileName\":\"estudio.pdf\",\"sha256\":\"$SHA\"}"
```

`registrarDePrueba` reutiliza la fila si el nombre ya existe y no comprueba el límite de
tamaño ni la extensión: es para pruebas, no un sustituto de la subida real.

## 4. Leer la telemetría de un mensaje

Cada mensaje del asistente guarda en su fila `metrics`, `verificacion`, `hops`, `plan` y
`sources`. Dos formas de leerlo:

- Panel de Convex, tabla `messages`, la fila del mensaje.
- Por CLI, un resumen legible:

```bash
npx convex run pruebas:leerRespuesta '{"messageId":"<id>"}'
```

Qué mirar y qué significa:

| Campo | Qué dice |
|---|---|
| `estado`, `error` | `listo` o `error` con su mensaje. Un turno que se quedó en `pensando` o `buscando` es una acción que murió sin llegar al `catch`. |
| `metrics.ms_total` | Duración de la pregunta. Si roza `PRESUPUESTO_TOTAL_S`, la respuesta se recortó por tiempo. |
| `metrics.tokens` | `prompt`, `cached`, `completion`, `reasoning`, `total`, medidos del `usage` real. `reasoning` en cero con razonamiento configurado es señal de que el gateway lo rechazó (sección 6). |
| `metrics.por_componente` | Rondas, tokens, ms y errores de `clasificador`, `planner`, `embeddings`, `grader`, `agente`, `verificador`, `revisor`. `errores` > 0 dice qué componente falló. |
| `metrics.cost_usd`, `pricing` | Coste **estimado con tarifas asumidas**, siempre etiquetado así. No es un criterio de decisión. |
| `metrics.counters` | `hops_plan`, `hops_extra`, `puntos_sin_resultados`, `llamadas_repetidas`, `forced_final` (el bucle forzó la respuesta), `razonamiento_rechazado`, `respuestas_revisadas`, `abstenciones_seguras`, `puntos_no_usados`, `hops_con_error`, `recuperacion_<modo>`, `lado_denso_caido`, `lado_lexico_caido`, `carga_fragmentos_caida`, `plan_cache_hits`, `embeddings_en_cache`, `calificaciones_en_cache` (aciertos de las tres cachés), `frases_eliminadas` (recorte quirúrgico de la barrera), `extras_rechazadas_por_tope`, `verificacion_fallida`. |
| `metrics.meta` | `modo`, `clase` (documental o no), `model`, `prompt_version`, `huella_evidencia` (sha256 de los ids de fragmentos entregados al redactor) y `evidencia_ids`/`evidencia_grados` para comparar corridas. La PRIMERA corrida de una pregunta siembra tres cachés (plan, vectores de consulta y veredictos del calificador; tablas `planes`, `consultasEmbebidas` y `calificaciones`); las siguientes las reutilizan y la evidencia debe coincidir. Medido antes de las cachés: el solape entre corridas era del 45 al 75 %, con la calidad publicada estable (fidelidad 1,00). Para medirlo: `pruebas:prepararPregunta` N veces y comparar `evidencia_ids` (índice de Jaccard), no solo la huella, `verificacion` (recuento por veredicto, fidelidad, revisiones, abstención) y, si hubo abstención segura, `barrera`. |
| `metrics.meta.barrera` | Solo en abstenciones seguras. `motivo`: `borrador_vacio`, `sin_senal` (el juez no dictaminó nada), `rechazada_tras_correccion` (quedaban bloqueantes tras las rondas de corrección y el recorte no pudo aplicarse), `timeout` (venció el tope de la revisión) o `error`. `informe_borrador`: las afirmaciones del borrador rechazado con veredicto, cita y motivo, más `citas_sin_resolver`, `fidelidad`, `ok`, `nota` y `cobertura`. Es lo que dice POR QUÉ no se publicó: sin esto, el informe que viaja con el mensaje es el de la propia abstención, con cero afirmaciones. |
| `verificacion.afirmaciones` | Cada afirmación con su cita, veredicto y motivo. Lo grave: `no_sostenida`, `cita_no_resuelve`, `sin_cita`. |
| `verificacion.cobertura` | Por punto del plan: `cubierto`, `parcial`, `evidencia_no_usada`, `sin_resultados`. |
| `hops` | Cada búsqueda: `origen` (`plan` o `extra`), `recuperacion` (`hibrida`, `densa`, `lexica`, `error`), `relevancia_verificada`, `documentos`, `ms`. Muchos `densa` o `lexica` seguidos apuntan a un lado caído; `error` es fallo de búsqueda, no ausencia. |

Un cambio en el prompt o en la arquitectura del agente debe subir `VERSION_PROMPT` en
`agente/prompt.ts` (y `PROMPT_VERSION` en el despliegue, que es lo que muestra Ajustes >
Sistema): dos mediciones solo se comparan si usaron el mismo.

## 5. Presupuestos y razonamiento

Todo por variables del despliegue (`npx convex env set`). La tabla completa con defaults está
en el README; aquí, qué mover para qué.

| Quiero | Variable | Notas |
|---|---|---|
| Acortar o alargar el tiempo total de una pregunta | `PRESUPUESTO_TOTAL_S` (540) | La acción muere a los 600 s. Este reloj arranca antes del planificador y la revisión recibe lo que quede; nunca por encima de 600. |
| Limitar las búsquedas extra del modelo | `MAX_HOPS` (0 = manda el modo: 1 normal, 2 extendido) | Solo aprieta. |
| Cortar antes el bucle de redacción | `AGENT_BUDGET_S` (0 = manda el modo: 60 / 240) | Solo aprieta. |
| Parar antes cuando las búsquedas no traen nada nuevo | `AGENT_MAX_HOPS_SIN_AVANCE` (3) | El modo normal ya para a las 2. |
| Acotar la recuperación paralela del plan | `EVIDENCE_PREFETCH_TIMEOUT_S` (45) | Un punto que no llega queda "no se pudo comprobar". |
| Calificar más o menos candidatos por punto | `EVIDENCE_CANDIDATES_PER_ITEM` (30) | Con `0` manda el modo (20 normal, 30 extendido). |
| Más o menos subpreguntas en extendido | `PLANNER_MAX_QUERIES` (5) | Además del ancla `e0`. |
| Dar más tiempo a la barrera | `PRE_RESPONSE_REVIEW_TIMEOUT_S` (150) | Recortado siempre a lo que quede del reloj total. Era 90 y subió a 150 tras la primera sesión de estrés sobre Convex. |
| Permitir más rondas de corrección | `PRE_RESPONSE_REVIEW_MAX_REVISIONS` (1) | Cada ronda es una llamada al modelo grande más una verificación. |
| Lotes del juez más pequeños | `VERIFIER_MAX_CLAIMS` (24) | Acota el tamaño de cada petición, no cuánto se verifica; los lotes van en paralelo. |
| Cambiar el razonamiento de un componente | `AGENT_REASONING_EFFORT`, `PLANNER_REASONING_EFFORT` (high), `RERANK_REASONING_EFFORT` (medium; calificador y clasificador), `VERIFIER_REASONING_EFFORT` (medium), `REVISOR_REASONING_EFFORT` (high) | `AGENT_REASONING_EFFORT` vacío deja el del modo (`medium` / `high`). |

### Interruptor de emergencia del razonamiento

```bash
npx convex env set AGENT_REASONING_EFFORT none
```

Apaga `reasoning_effort` en el redactor en los dos modos. Es lo que hay que hacer si el modo
extendido empieza a fallar por el parámetro de razonamiento y no se quiere esperar al
auto-apagado (sección 6). El efecto medido de apagarlo: ante una pregunta comparativa, sin
razonamiento el modelo pedía una búsqueda y con esfuerzo alto pedía tres. Para volver:
`npx convex env remove AGENT_REASONING_EFFORT`.

### Rollbacks con `ENABLE_*`

| Variable | En `false` | Cuándo |
|---|---|---|
| `ENABLE_PRE_RESPONSE_REVIEW` | El borrador se publica sin esperar la barrera; el verificador sigue anotando y el informe llega igual al frontend. | La barrera se abstiene demasiado o tarda demasiado y hay que seguir sirviendo respuestas mientras se investiga. Lo que pierdes: la garantía de que no sale una atribución falsa. |
| `ENABLE_ANSWER_VERIFICATION` | Ni verificador ni barrera: la respuesta sale sin informe. | El juez está caído y anotar todo como `sin_verificar` no aporta. Última opción. |
| `ENABLE_QUERY_PLANNING` | El modo extendido deja de descomponer: plan = solo `e0`. | El planificador produce planes malos o el gateway lo rechaza. |
| `ENABLE_EVIDENCE_PIPELINE` | Sin efecto hoy: se lee pero ningún módulo la consulta. | No es un rollback real; el pipeline es el único camino. |

Después de un rollback, anótalo con la fecha en algún sitio visible del equipo y vuelve a
`true` cuando esté resuelto: una barrera apagada que nadie recuerda es peor que ninguna.

## 6. Si el gateway rechaza el razonamiento

`lib/gateway.ts`: cuando una petición con `reasoning_effort` recibe un **400 que nombra
`reasoning`**, se reintenta una vez sin el parámetro y el razonamiento queda apagado
**10 minutos** en ese proceso para todos los componentes. La respuesta no se pierde; se
degrada a la conducta sin razonamiento. Cada vez que ocurre se cuenta en
`metrics.counters.razonamiento_rechazado`.

Qué hacer:

1. Confirmar en `metrics` de varias preguntas seguidas: `razonamiento_rechazado` > 0 y
   `tokens.reasoning` en cero.
2. Mirar los Logs del panel: el cuerpo del 400 dice qué combinación rechazó (el 2 de septiembre
   de 2026 fue `reasoning_effort` junto a function tools; el 4 se volvió a medir y funcionaba).
3. Si es persistente, apagarlo de forma explícita mientras dure
   (`AGENT_REASONING_EFFORT=none`, y el `*_REASONING_EFFORT` del componente afectado), en vez de
   depender del auto-apagado, que se reactiva cada 10 minutos y vuelve a pagar el 400.
4. Al resolverse, quitar las variables.

Errores relacionados que **no** se reintentan a propósito: 429 con `insufficient_quota`,
`credit_balance` o `billing` (saldo agotado, no se arregla esperando), 401 y 403. Los 429 de
límite de ritmo, 408, 409, 5xx y cortes de red sí se reintentan (hasta 5 intentos, espera
exponencial con tope de 20 s).

## 7. Límites conocidos

- **Las estadísticas recorren `messages`.** `estadisticas.sistema` cuenta preguntas leyendo
  todos los mensajes, y `usuarios.listar` lee los de cada usuario para contar. Cada respuesta
  del asistente arrastra `sources` y `hops` (decenas de KB) y una transacción puede leer
  16 MiB, así que aguanta unos cientos de respuestas en total. Más allá, Ajustes > Sistema y
  Ajustes > Usuarios fallarán. **Pendiente: una tabla de contadores.**
- **Dos ingestas concurrentes del mismo documento.** La única guarda es el `processing` de
  menos de 10 minutos. Si dos reindexados entran a la vez pasados los 10 minutos, o una
  ingesta legítima dura más de 10 minutos y alguien reindexa, pueden correr dos a la vez y
  duplicar fragmentos de la misma versión. Si pasa: borrar el documento y subirlo de nuevo.
- **PDFs a dos columnas.** Las líneas se reconstruyen agrupando los items de pdf.js por
  altura, y en una página a dos columnas eso fundía cada línea de la izquierda con la de la
  derecha (medido el 4 de septiembre de 2026 con cinco artículos reales: los encabezados no
  se reconocían y en uno ninguna línea del cuerpo llegaba a párrafo). Desde entonces
  `pdf.ts` busca el canal vertical que ninguna línea cruza y lee columna a columna. Lo que
  queda: el canal solo se acepta con evidencia clara de texto a dos columnas (para no partir
  una tabla por la mitad), así que una maqueta poco habitual puede quedarse sin separar; y
  una fila de tabla a todo el ancho que no pise el canal se parte en dos mitades, cada una
  con sus celdas (se degrada la estructura, no se pierde el dato). Revisa con
  `pruebas:leerDocumento` la muestra de fragmentos de un artículo nuevo antes de darlo por
  bien indexado.
- **Sin OCR.** Un PDF escaneado no tiene texto extraíble y la ingesta lo rechaza diciéndolo.
- **Tablas de PDF.** Se reconocen las filas por geometría y se marcan como `table`, pero no se
  reconstruye la estructura de columnas con cabecera como en Word o Excel.
- **Filtros en la búsqueda vectorial.** Solo se aplica el filtro más selectivo en el lado
  denso (Convex no admite AND entre campos ahí); con varios filtros muy selectivos el lado
  denso puede devolver menos candidatos válidos que el léxico.
- **Los fragmentos que no caben en el primer lote de un borrado** siguen visibles unos
  instantes hasta que los lotes agendados terminan.
- **Google como proveedor** existe en `auth.ts` si el despliegue tiene `AUTH_GOOGLE_ID` y
  `AUTH_GOOGLE_SECRET`, pero el frontend aún no puede saberlo y no muestra el botón.
- **Turnos colgados.** Si la acción muere sin pasar por su `catch` (despliegue a mitad,
  600 s), la fila queda en un estado no final. El frontend lo pinta como error de tiempo a
  los 630 s; la fila no se corrige sola.

## 8. Arnés de pruebas interno

`frontend/convex/pruebas.ts`: funciones internas, solo por CLI, para lanzar preguntas al agente
sin interfaz ni login y leer el resultado con su telemetría. Es el sustituto del `preguntar.py`
y del script de estrés del backend anterior.

```bash
# Lanza la pregunta (crea el usuario pruebas@airobotix.net y una conversación si hace falta)
npx convex run pruebas:prepararPregunta '{"texto":"¿Cuál es la sensibilidad de p-tau217 en plasma?","modo":"extendido"}'
# -> {"sessionId":"...","messageId":"..."}

# Espera a que termine y lee el resumen
npx convex run pruebas:leerRespuesta '{"messageId":"<messageId>"}'

# Repregunta en la misma conversación (historial incluido)
npx convex run pruebas:prepararPregunta '{"texto":"¿Y en LCR?","modo":"extendido","sessionId":"<sessionId>"}'
```

`leerRespuesta` devuelve `estado`, `error`, `plan`, `hops`, número de `fuentes`, número de
`afirmaciones` y recuento por `veredictos`, `fidelidad`, `cobertura` (`e1:cubierto`, ...),
`citas_sin_resolver`, `nota`, `ms_total`, `tokens`, `cost_usd`, `counters`, `meta` y el
`content`. Mientras `estado` no sea `listo` o `error`, el agente sigue trabajando.

Cómo estresar el sistema con esto: una batería de preguntas con verdad conocida, en los dos
modos, mirando no solo la respuesta sino los hops, la cobertura y las afirmaciones. Lo que
encontró la primera batería de 10 preguntas (2 de septiembre de 2026) da idea de qué buscar:
un modo entero caído por un parámetro de la API nunca probado contra la API; una sección
equivocada arrastrada desde el parser hasta el texto; una cita ilegible que rompía el enlace
con el panel de fuentes; una pregunta sobre el índice contestada como si fuera sobre el
asistente. Ninguno se ve mirando una respuesta suelta. Y no concluyas con muestras de cinco:
midiendo determinismo, n=5 dio el resultado contrario que n=10.

Cada corrida gasta tokens reales del gateway. El coste estimado queda en `metrics.cost_usd`.

## 9. Pruebas automáticas

```bash
cd frontend
npm test              # vitest + convex-test, en memoria, sin red
npm run typecheck     # tsc del frontend y de convex/
```

Los tests no llaman al gateway ni a la red. Si uno lo necesita, está mal escrito. Para el
modelo se parchea `crearCompletion` / `completionJson` / `streamCompletion` con `vi.spyOn`
sobre el módulo `lib/gateway`, importado como módulo (`import * as gateway`), nunca con
desestructuración. Antes de dar por bueno un cambio, escribe el test que intenta romperlo, no
el que confirma que funciona.

## 10. Qué NO hay todavía

- **Evaluación automática contra Convex.** `backend/evaluar.py` sigue apuntando a la API
  antigua; ver [MIGRACION_CONVEX.md](MIGRACION_CONVEX.md).
- **Tabla de contadores** para estadísticas y listado de usuarios.
- **Botón de Google** en la pantalla de acceso.
- **OCR** para PDFs escaneados.
- **Ingesta por carpeta desde la CLI** (el `ingest.py` anterior). Hoy se sube por la interfaz o
  con las funciones de prueba de la sección 3.
