# Alzheimer Project: asistente de investigación clínica

Asistente de investigación para una médica investigadora que trabaja con literatura clínica
sobre Alzheimer. Responde en español y solo con lo que recupera de los documentos indexados,
**cita de dónde sale cada afirmación** y, antes de mostrar una respuesta, comprueba cada
afirmación contra el fragmento que cita. Si algo no está en los documentos, lo dice en vez de
rellenarlo.

El acceso es con cuenta propia y correo del dominio de la empresa (`airobotix.net` por
defecto). Los documentos son compartidos: todos los usuarios consultan el mismo índice y solo
un administrador lo gestiona. Las conversaciones son privadas, también para los administradores.

Este README explica qué es el sistema y cómo arrancarlo. El contrato funcional (modos, pipeline
de evidencia, barrera de fidelidad, formas de los datos) está en [SPEC.md](SPEC.md); la
operación diaria (cuentas, documentos, telemetría, variables) en
[docs/OPERACION.md](docs/OPERACION.md); y el porqué y el alcance del cambio de arquitectura en
[docs/MIGRACION_CONVEX.md](docs/MIGRACION_CONVEX.md).

---

## 1. Qué hace

- **Responde solo con los documentos y cita cada dato.** Cada fragmento que llega al modelo
  trae su cita ya montada (`[Allegri et al., 2023, pág. 4]`) y el prompt le exige copiarla
  literal. Lo que no está en los documentos se declara con una fórmula fija ("No encuentro X
  en los documentos") y lo que no se pudo comprobar, con otra ("No pude comprobar X en los
  documentos"). Cualquier otra redacción se audita como una afirmación sin cita.
- **Dos modos que elige quien pregunta.** *Pensamiento normal*: la pregunta se busca tal cual
  y se responde directo, con una búsqueda extra como máximo. *Pensamiento extendido*: la
  pregunta se descompone en un plan de puntos, cada punto recupera su evidencia por separado y
  se contrastan documentos. Cambia cuánto se busca y se delibera, nunca cuánta verdad se exige.
- **La evidencia la recupera código, no el modelo.** El plan se ejecuta en paralelo, en español
  y en inglés, con búsqueda híbrida (vector de 3072 dimensiones + texto BM25, fusión por rango
  recíproco), poda de secciones que no son evidencia (bibliografía, agradecimientos,
  financiación), cuota mínima por documento y un calificador que lee cada candidato completo y
  lo gradúa como evidencia directa, parcial o no. La misma pregunta sobre el mismo índice
  recupera la misma evidencia, y la telemetría guarda una huella para medirlo.
- **Barrera de fidelidad antes de publicar.** El borrador se redacta en privado; un verificador
  resuelve cada cita contra los fragmentos recuperados y un juez dictamina si el fragmento
  sostiene la afirmación. Una cita que no resuelve, una afirmación no sostenida o una respuesta
  factual sin citas devuelven el borrador al redactor con la crítica, hasta dos rondas (la
  segunda ordena borrar lo que siga sin respaldo). Si aun así queda alguna frase sin sostener,
  se **elimina esa frase** y se publica el resto, verificado de nuevo y con una nota que dice
  cuántas se quitaron; la abstención segura queda para cuando no sobrevive nada verificable, el
  verificador no pudo dictaminar o se agotó el tiempo. Una frase con varias citas se juzga contra
  la unión de sus fragmentos. El navegador solo ve texto aprobado.
- **Cobertura por punto.** Al terminar, la interfaz muestra por cada parte de la pregunta si se
  respondió con evidencia, parcialmente, si había evidencia que la respuesta no usó, si no
  está en los documentos, o si no se pudo comprobar (la búsqueda falló). Los dos últimos no
  son lo mismo y se pintan distinto.
- **Citas honestas por formato.** `pág. N` en un PDF, `sección: X` en un Word con encabezados,
  `fila N` en una hoja de cálculo, `tabla N` en una tabla de Word y `fragmento N` como último
  recurso. En un artículo científico la fuente es la referencia corta ("Allegri et al.,
  2023"), extraída con heurísticas deterministas; si no se puede extraer con confianza se cita
  el nombre del archivo, nunca se fabrica.
- **Conciencia de sección.** La sección de la que sale cada fragmento (Métodos, Resultados,
  Discusión...) viaja con él, pesa en el orden de la evidencia y está en el prompt: un dato en
  Resultados es evidencia del estudio; el mismo enunciado en Discusión es interpretación de
  sus autores.
- **Progreso persistente, sin stream.** El agente escribe su avance en la fila del mensaje
  (`pensando`, `buscando`, `redactando`, `revisando`, `listo` o `error`) y el navegador está
  suscrito a la conversación. Una respuesta sobrevive a que se cierre la pestaña.
- **Cuentas y roles.** Alta con correo y contraseña del dominio permitido. Roles `admin` y
  `lector`. Un administrador gestiona documentos y cuentas (ascender, degradar, bloquear,
  borrar), pero no ve conversaciones ajenas. Nadie puede cambiarse, bloquearse ni borrarse a
  sí mismo.
- **Telemetría por pregunta.** Tokens medidos del `usage` real por componente y coste
  estimado con tarifas asumidas (etiquetado siempre así), guardados con el mensaje.

## 2. Arquitectura

```
  Navegador (React + Vite, PWA instalable)
    |  WebSocket con Convex: suscripciones (useQuery) y mutaciones (useMutation)
    |  Convex Auth: correo y contraseña (Google solo si el despliegue tiene credenciales)
    |  Subida de ficheros: POST directo a una URL firmada del almacenamiento
    v
  Convex (TypeScript). Un despliegue por entorno: dev y prod tienen bases distintas
    +-- Tablas: users (+ rol, bloqueado), adminsPreasignados, sessions, messages,
    |           feedback, documents, chunks, ingestionRuns, y las de Convex Auth
    +-- chunks: indice vectorial de 3072 dimensiones (porEmbedding)
    |           + indice de texto BM25 (porTexto), con siete campos de filtro
    +-- Funciones publicas: sesiones, mensajes, documentos, usuarios, estadisticas
    |     (todas empiezan comprobando quien pregunta: permisos.ts)
    +-- Acciones internas: agente/bucle.ts (una accion por pregunta, hasta 600 s)
    |                      ingesta/pipeline.ts (parsear, trocear, embeber, indexar)
    +-- Almacenamiento de ficheros: el original de cada documento (documents.storageId)
    +-- Variables de entorno del despliegue (npx convex env set ...)
              |
              v  fetch, sin SDK
  AI Gateway de Vercel (https://ai-gateway.vercel.sh/v1)
      openai/gpt-5.4                 redactor, planificador y revisor
      openai/gpt-5.4-mini            clasificador, calificador y verificador
      openai/text-embedding-3-large  embeddings de 3072 dimensiones

  Vercel: solo sirve el frontend estatico (frontend/dist). Su buildCommand
  despliega ademas las funciones de Convex y fija VITE_CONVEX_URL en el bundle.
```

Una pregunta recorre este camino:

1. `mensajes.enviar` (mutación corta) guarda la pregunta, crea el mensaje del asistente en
   `pensando` y agenda la acción `agente.bucle.correr`.
2. El bucle clasifica la pregunta con el modelo pequeño. Saludos y preguntas sobre el propio
   asistente se responden sin buscar y sin barrera. Solo lo `documental` sigue.
3. Plan de evidencia: `e0` es siempre la pregunta literal; en modo extendido el planificador
   añade `e1..eN` con su versión en inglés y el dato concreto que hace falta.
4. Cada punto del plan lanza su búsqueda híbrida en paralelo, se podan y deduplican
   candidatos, se califican y se entregan los mejores al modelo como resultados de búsqueda.
5. El redactor escribe el borrador; puede pedir búsquedas extra acotadas por el modo.
6. La barrera verifica cada afirmación contra su cita; corrige o se abstiene.
7. Se publica: `content`, `sources`, `hops`, `verificacion` y `metrics` en la fila del mensaje.

El proveedor de modelos es **siempre el AI Gateway de Vercel**, nunca la API de OpenAI directa,
y los modelos van con el proveedor por delante (`openai/gpt-5.4`). El coste por token no es
criterio de decisión en este proyecto; el límite real es el tiempo.

## 3. Puesta en marcha local

Requisitos: Node.js con npm, y acceso al despliegue de Convex del proyecto (clave de
despliegue). No hace falta Python, Docker ni ningún servicio local: la base, los índices y las
funciones viven en Convex.

```bash
cd frontend
npm install
```

Crea `frontend/.env.local` (no se versiona; `frontend/.env.example` es la plantilla y solo las
claves `VITE_*` llegan al navegador):

```
CONVEX_DEPLOY_KEY=...                              # clave del despliegue al que se conecta la CLI
VITE_CONVEX_URL=https://<despliegue>.convex.cloud  # URL publica del mismo despliegue
```

Dos terminales:

```bash
npm run convex   # convex dev: empuja esquema y funciones, y sigue empujando cada cambio
npm run dev      # Vite en http://localhost:5173
```

La primera vez sobre un despliegue nuevo, además:

```bash
npx convex env set OPENAI_API_KEY vck_...     # clave del AI Gateway de Vercel, NO de OpenAI
npx @convex-dev/auth                          # genera JWT_PRIVATE_KEY y JWKS en el despliegue
npx convex run semilla:sembrarAdmins          # correos que nacen administradores (idempotente)
```

Después, crea tu cuenta en la pantalla de acceso con el correo de la empresa. Si tu correo está
en la lista de administradores preasignados entras como `admin`; si no, como `lector`. Las
cuentas de la versión anterior (Supabase) no se migraron: todo el mundo se da de alta de nuevo.

El resto de variables tienen valores por defecto razonables (sección 6). Se cambian con
`npx convex env set NOMBRE valor` y se leen en cada invocación, así que aplican a la siguiente
pregunta sin redesplegar.

## 4. Pruebas

```bash
cd frontend
npm test              # vitest + convex-test: esquema y funciones en memoria, sin red
npm run typecheck     # tsc del frontend y de convex/
```

Los tests no llaman al gateway ni a ningún servicio: el modelo se parchea con `vi.spyOn` sobre
el módulo `lib/gateway`, y `convex-test` da una base en memoria con el esquema real. El entorno
de vitest es `edge-runtime` a propósito, porque se parece al runtime por defecto de Convex:
una función que use una API de Node falla aquí igual que fallaría desplegada. Los ficheros de
prueba son los `*.test.ts` de `frontend/convex/` y `frontend/src/`.

Para lanzar una pregunta real contra el despliegue sin abrir el navegador está el arnés
interno `pruebas.ts` (ver [docs/OPERACION.md](docs/OPERACION.md)).

## 5. Despliegue

La aplicación vive en **https://rag-ai-robotix.vercel.app** (los enlaces antiguos
`firetech-rag.vercel.app` y `rag-productos.vercel.app` redirigen ahí). Vercel sirve el
frontend estático y, en el propio build, empuja las funciones a Convex; el proyecto de Vercel
ya tiene `CONVEX_DEPLOY_KEY` configurada y su panel alineado con `vercel.json`.

Todo el despliegue vive en `vercel.json`:

- `installCommand`: `cd frontend && npm install`.
- `buildCommand`: `cd frontend && npx convex deploy --cmd 'npm run build'`. Empuja esquema y
  funciones al despliegue de Convex indicado por la clave y, con `VITE_CONVEX_URL` ya fijada,
  construye el frontend.
- `outputDirectory`: `frontend/dist`. Un solo rewrite lleva todo a `index.html` (SPA).
- El build necesita **`CONVEX_DEPLOY_KEY`** (clave de despliegue de PRODUCCIÓN) en las
  variables de entorno del proyecto de Vercel. Es la única variable que Vercel necesita: las
  del agente, el gateway y la autenticación viven en el despliegue de Convex.
- `.vercelignore` deja fuera `backend/`, `api/`, `supabase/`, `docs/`, `data/`, `infra/`, los
  binarios y cualquier `.env*`.

Ya no hay función serverless, ni límite de 300 s, ni límite de 4,5 MB por petición que vigilar
en Vercel: el trabajo pesado corre en acciones de Convex.

## 6. Variables de entorno del despliegue de Convex

Las lee `frontend/convex/lib/config.ts` en cada invocación. Se fijan con
`npx convex env set NOMBRE valor` en cada despliegue (dev y prod por separado), nunca en un
fichero del repositorio. Booleanos: `1`, `true`, `si`, `sí` o `yes` valen verdadero; cualquier
otro texto vale falso; vacío deja el default.

| Variable | Default | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | vacío, **obligatoria** | Clave del AI Gateway de Vercel (`vck_...`). Sin ella el agente falla con un error que dice dónde ponerla. |
| `OPENAI_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | URL del gateway. |
| `OPENAI_MODEL` | `openai/gpt-5.4` | Redactor, planificador y ronda de corrección del revisor. |
| `RERANK_MODEL` | `openai/gpt-5.4-mini` | Calificador de evidencia y clasificador de la pregunta. Vacío = hereda `OPENAI_MODEL`. |
| `VERIFIER_MODEL` | vacío | Verificador de atribución. Vacío = hereda `RERANK_MODEL`. |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-large` | Embeddings. Cambiarlo obliga a reindexar. |
| `EMBEDDING_DIMS` | `3072` | Dimensiones que el gateway debe devolver; el índice vectorial está declarado con 3072. |
| `LLM_TEMPERATURE` | `0` | Temperatura de todas las llamadas. |
| `AGENT_REASONING_EFFORT` | vacío | Techo del razonamiento del redactor. Vacío = manda el modo (`medium` normal, `high` extendido); `none` lo apaga; otro valor sustituye al del modo. |
| `PLANNER_REASONING_EFFORT` | `high` | Razonamiento del planificador. |
| `RERANK_REASONING_EFFORT` | `medium` | Razonamiento del calificador y del clasificador. |
| `VERIFIER_REASONING_EFFORT` | `medium` | Razonamiento del verificador. |
| `REVISOR_REASONING_EFFORT` | `high` | Razonamiento de la ronda de corrección. |
| `MAX_HOPS` | `0` | Techo de búsquedas extra del modelo. `0` = manda el modo (1 normal, 2 extendido). Solo aprieta, nunca afloja. |
| `AGENT_BUDGET_S` | `0` | Techo de segundos del bucle de redacción. `0` = manda el modo (60 normal, 240 extendido). |
| `AGENT_MAX_HOPS_SIN_AVANCE` | `3` | Búsquedas extra seguidas sin nada nuevo antes de forzar la respuesta. El modo normal ya tiene 2. |
| `PRESUPUESTO_TOTAL_S` | `540` | Reloj único de la pregunta (clasificar, planificar, evidencia, redacción y revisión). La acción muere a los 600 s; este corte acorta la respuesta en vez de perderla. |
| `ENABLE_QUERY_PLANNING` | `true` | Plan de evidencia en modo extendido. Puede apagarlo, nunca encenderlo en modo normal. |
| `PLANNER_MAX_QUERIES` | `5` | Máximo de subpreguntas del plan, además del ancla `e0`. |
| `ENABLE_ANSWER_VERIFICATION` | `true` | Verificador de atribución. |
| `ENABLE_PRE_RESPONSE_REVIEW` | `true` | Barrera previa: el borrador no se publica sin aprobación. En `false` se publica y solo se anota. |
| `PRE_RESPONSE_REVIEW_MAX_REVISIONS` | `2` | Rondas de corrección; la última ordena borrar lo que siga sin respaldo. Después, recorte quirúrgico de esas frases antes de abstener. |
| `PRE_RESPONSE_REVIEW_TIMEOUT_S` | `150` | Tope de la revisión, recortado a lo que quede del reloj total. Subió de 90 a 150 porque con razonamiento en verificador y revisor había preguntas que llegaban a la barrera tras 120 a 180 s y salían en abstención segura. |
| `VERIFIER_MAX_CLAIMS` | `24` | Afirmaciones por petición al juez; los lotes van en paralelo. |
| `ENABLE_EVIDENCE_PIPELINE` | `true` | Se lee, pero hoy ningún módulo la consulta: el pipeline de evidencia es el único camino. |
| `EVIDENCE_CANDIDATES_PER_ITEM` | `30` | Candidatos que se califican por punto. Como no es `0`, manda sobre el valor del modo (20 normal, 30 extendido); en `0` manda el modo. |
| `EVIDENCE_PREFETCH_TIMEOUT_S` | `45` | Tope de la recuperación paralela del plan. Un punto que no llega queda "no se pudo comprobar". |
| `RERANK_TOP_K` | `12` | Se lee, pero hoy ningún módulo la consulta (los fragmentos por punto los fija el modo: 8 y 12). |
| `SEARCH_TOP_K` | `60` | Candidatos por consulta en cada lado de la búsqueda híbrida. |
| `ENVIRONMENT` | `production` | Etiqueta del entorno. Se lee, pero hoy ningún módulo la consulta. |
| `PROMPT_VERSION` | `v4` | Se muestra en Ajustes > Sistema. La telemetría del mensaje lleva la constante `VERSION_PROMPT` de `agente/prompt.ts`. |
| `DOMINIO_PERMITIDO` | `airobotix.net` | Dominio de correo exigido para darse de alta y para entrar. |
| `UPLOAD_LIMIT_MB` | `18` | Tope por fichero. 20 MB es el tope de una petición HTTP de Convex; se deja margen para el sobre. |

Variables de Convex Auth, también en el despliegue:

| Variable | Para qué |
|---|---|
| `JWT_PRIVATE_KEY`, `JWKS` | Claves del emisor de tokens. Las genera `npx @convex-dev/auth`. Nunca en el repositorio. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Opcionales. Si las dos existen, `auth.ts` ofrece Google como proveedor. Sin ellas no aparece el botón (pendiente exponerlo al navegador, ver MIGRACION_CONVEX.md). |
| `CONVEX_SITE_URL` | La pone Convex; `auth.config.ts` la usa como dominio emisor. |

## 7. Roles y acceso

- **Alta y entrada** con correo y contraseña (mínimo 8 caracteres, el del proveedor
  `Password` de Convex Auth). El dominio se comprueba en el alta y en cada entrada: si mañana
  cambia `DOMINIO_PERMITIDO`, una cuenta antigua fuera de él deja de poder entrar. La
  comprobación es sobre el sufijo `@dominio`, no un `includes`.
- **Rol al nacer**: `admin` si el correo está en la tabla `adminsPreasignados` (se siembra
  con `semilla:sembrarAdmins`); `lector` en cualquier otro caso.
- **Lector**: pregunta, ve y borra sus conversaciones, valora respuestas, ve el listado de
  documentos. En Ajustes solo tiene la pestaña "Mi cuenta".
- **Administrador**: además sube, reindexa y borra documentos; lista cuentas con contadores de
  uso; asciende, degrada, bloquea, desbloquea y borra cuentas; ve Ajustes > Sistema (índice,
  actividad, configuración). **No ve conversaciones de nadie.**
- **Bloqueo**: se comprueba en cada llamada, así que echa a quien ya está dentro. Es
  reversible; la cuenta y sus conversaciones se conservan. **Borrar** es permanente y borra en
  cascada sus conversaciones, mensajes, valoraciones y filas de Convex Auth; los documentos
  que subió se conservan sin autor.
- **Ninguna tabla se lee desde el navegador**: todo pasa por funciones que empiezan
  comprobando quién pregunta. Una conversación ajena responde "no encontrada", nunca
  "prohibida", para no confirmar que existe.

## 8. Documentos: formatos y límites

| | |
|---|---|
| Formatos | `.pdf`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.md`. `.doc` (Word 97-2003) se rechaza con un mensaje que dice cómo convertirlo. |
| Tamaño | `UPLOAD_LIMIT_MB`, 18 MB por defecto (20 MB es el tope de una petición HTTP de Convex). El fichero va directo al almacenamiento, no por una función. |
| Fragmentos por documento | Máximo 4000 (`MAX_CHUNKS`); por encima, la ingesta falla pidiendo dividir el archivo. Fragmentos de unos 400 tokens con solape de 60; texto por fragmento recortado a 8000 caracteres. |
| PDF | Se leen las páginas a dos columnas en orden de lectura. Se descarta la bibliografía por defecto, las marcas de descarga y las cabeceras y pies repetidos. Se extraen título, primer autor, año y DOI para citar como "Autor et al., año". Un PDF escaneado sin texto extraíble se rechaza: no hay OCR. |
| Word | Párrafos agrupados por sección (encabezado vigente) y una tabla por fragmento, con celdas combinadas resueltas. Sin páginas: se cita por sección o por número de fragmento. |
| Excel y CSV | Detección de fila de encabezado y un fragmento por fila ("Campo: valor"), citado por número de fila. |
| Texto y Markdown | Párrafos empaquetados con solape; se cita por número de fragmento. |
| Idioma | Detectado sobre el documento entero (`es`, `en`, `pt`, `fr`); si no está claro, vacío. |
| Duplicados | El nombre de archivo identifica al documento en el despliegue. Un nombre ya indexado responde `conflicto`; hay que borrarlo primero. |
| Versiones | El sha256 del fichero es la versión de sus fragmentos. Al reindexar, la versión anterior sigue consultable hasta que la nueva está escrita entera. |

## 9. Estructura de carpetas

```
FIREtech-RAG/
├── frontend/
│   ├── convex/                  # backend: Convex (TypeScript)
│   │   ├── schema.ts            # tablas e indices (vectorial 3072 + texto BM25)
│   │   ├── auth.ts              # Convex Auth: dominio permitido y admins preasignados
│   │   ├── auth.config.ts       # emisor de tokens
│   │   ├── http.ts              # rutas HTTP de Convex Auth
│   │   ├── permisos.ts          # quien puede hacer que
│   │   ├── sesiones.ts          # conversaciones
│   │   ├── mensajes.ts          # preguntas, turno del asistente, feedback
│   │   ├── documentos.ts        # listar, subir, reindexar, borrar
│   │   ├── usuarios.ts          # cuentas, roles, bloqueo, borrado en cascada
│   │   ├── estadisticas.ts      # Ajustes > Sistema (solo admin)
│   │   ├── semilla.ts           # administradores preasignados
│   │   ├── pruebas.ts           # arnes interno (npx convex run)
│   │   ├── agente/              # bucle, prompt, planner, evidencia, calificador,
│   │   │                        # verificador, revisor
│   │   ├── search/              # hybrid (RRF), terminos, inventario
│   │   ├── ingesta/             # pipeline, parsear, pdf, docx, tabular, texto,
│   │   │                        # chunking, paper, lineas, idioma, escritura
│   │   ├── lib/                 # config, gateway, citas, modos, telemetry
│   │   └── CONTRATO.md          # interfaces fijadas durante el port
│   ├── src/                     # React + Vite (componentes, lib/, types.ts)
│   ├── public/                  # PWA: manifest, service worker, iconos
│   ├── package.json             # dev, build, test, typecheck, convex
│   ├── vitest.config.ts         # edge-runtime + convex-test
│   └── .env.example             # VITE_CONVEX_URL
├── docs/
│   ├── OPERACION.md
│   └── MIGRACION_CONVEX.md
├── vercel.json                  # build del frontend + convex deploy
├── .vercelignore
├── SPEC.md
└── README.md
```

## 10. Histórico

- `backend/` y `api/` son el backend Python anterior (FastAPI sobre una función de Vercel, con
  Supabase y Qdrant). Se conservan como referencia del port hasta su retirada; no se
  despliegan (`.vercelignore`) y su documentación es la de los commits anteriores a la
  migración. `backend/evaluar.py` y `backend/app/evaluation.py` son el evaluador offline, que
  sigue en Python y apunta a la API antigua (pendiente de portar).
- `supabase/migrations/` son las migraciones de la base anterior (Postgres). Las 009 y 010
  nunca se pudieron aplicar por falta de acceso al proyecto; el esquema de Convex nace ya con
  lo que pretendían.
- `infra/docker-compose.yml` levantaba el Qdrant local; `data/` era la carpeta de ingesta por
  CLI. Ninguno se usa ya.
