# SPEC: RAG de documentos

Contrato de arquitectura. Cualquier código del proyecto debe respetar estas interfaces.

El sistema responde preguntas sobre un corpus de documentos propios, citando de dónde sale
cada afirmación. No sabe nada del dominio de esos documentos: lo que entra es una carpeta de
archivos y lo que sale son respuestas con su cita.

## Stack
- **Vector DB**: Qdrant (local vía Docker Compose, o Qdrant Cloud vía env)
- **Embeddings**: OpenAI `text-embedding-3-large` (3072 dims)
- **LLM agente**: OpenAI, modelo configurable vía `OPENAI_MODEL` (default `gpt-5.4`)
- **Backend**: Python + FastAPI (puerto 8000). Venv local en 3.14; en Vercel el runtime lo
  fija `.python-version` (3.12) en la raíz del repo. El código debe correr en ambos.
- **Frontend**: React + Vite + TypeScript (puerto 5173)
- **DB relacional**: Supabase (sesiones de chat, mensajes, registro de ingesta, feedback)

## Estructura del repo
```
proyecto/
├── backend/
│   ├── requirements.txt       # + requirements-dev.txt (pytest)
│   ├── .env.example
│   ├── ingest.py              # CLI: python ingest.py [--dry-run] RUTA...
│   │                          #      [--environment local|production] [--proyecto ID]
│   │                          #      [--max-usd X] [--force] [--reset --yes]
│   ├── tests/                 # pytest offline: sin red, sin OpenAI, sin Qdrant
│   └── app/
│       ├── main.py            # FastAPI app + CORS
│       ├── config.py          # pydantic-settings, lee .env
│       ├── models.py          # Chunk, SearchFilters, SourceRef
│       ├── api/
│       │   ├── routes.py      # endpoints REST + SSE
│       │   └── documents.py   # subir, listar y borrar documentos
│       ├── services/
│       │   ├── qdrant.py      # cliente, setup colección, hybrid search
│       │   ├── embeddings.py  # OpenAI embeddings con batching
│       │   ├── openai_client.py  # cliente único + semáforo de concurrencia
│       │   ├── reranker.py    # reranking listwise + filtro de relevancia
│       │   ├── telemetry.py   # usage y coste estimado por petición
│       │   ├── agent.py       # agente multi-hop con tool calling
│       │   └── supabase_db.py # persistencia chat
│       └── ingest/
│           ├── generic.py     # parseo por formato, produce los chunks
│           └── pipeline.py    # descubrir → parse → embed → upsert
├── frontend/                  # Vite + React + TS
├── supabase/migrations/       # 001..007, aplicar EN ORDEN (esquema, estados de
│                              # documentos, entornos, auth, bloqueo, revocaciones)
├── infra/docker-compose.yml   # Qdrant local
└── README.md
```

## Colección Qdrant
- Nombre: `documentos` (env `QDRANT_COLLECTION`)
- Vectores nombrados:
  - `dense`: 3072 dims, coseno (OpenAI text-embedding-3-large)
  - `bm25`: sparse vector. El backend recomendado es la inferencia BM25 nativa del cluster
    (`QDRANT_BM25_BACKEND=server`), compatible con local y Vercel sin onnxruntime. FastEmbed
    queda como backend alternativo. El modo efectivo se prueba contra el cluster y se expone
    como `retrieval` y `bm25_backend` en health/stats.
- Payload por punto (chunk):
  ```json
  {
    "text": "texto completo del chunk (lo que ve el LLM)",
    "source_file": "estudio_cohorte.pdf",
    "page": 3,
    "project_id": "id del proyecto o null",
    "document_id": "id del documento o null",
    "document_version": "sha256 de esta versión del archivo",
    "section": "Métodos",
    "language": "es",
    "document_type": "pdf | docx | xlsx | csv | txt | md",
    "source_pages": [3, 4],
    "metadata": {},
    "chunk_type": "text | table",
    "title": "título del trabajo, si el documento es un artículo",
    "citation": "Allegri et al., 2021",
    "doi": "10.1016/j.jalz.2021.04.002"
  }
  ```
  La lista es CERRADA: `_PAYLOAD_KEYS` en `app/services/qdrant.py` es una lista blanca, así
  que lo que el parser no declare ahí no llega nunca al índice y un campo nuevo en la
  ingesta no se filtra por accidente.
- Índices de payload (7): `project_id`, `document_id`, `document_version`, `document_type`,
  `language`, `source_file` y `chunk_type`, todos keyword. La lista vive en `qdrant.PAYLOAD_INDEXES` y
  la crea `ensure_collection` junto con la colección. `project_id` y `document_id` son
  además la frontera de acceso: sin su índice, una búsqueda acotada sería un escaneo.

## API Backend (contrato para el frontend)
Base: `http://localhost:8000`

### `GET /api/health`
→ `{ "status": "ok", "qdrant": true, "collection_points": 1234, "upload_limit_mb": 4,
     "retrieval": "hybrid" | "dense-only", "bm25_backend": str, "qdrant_version": str,
     "model": str, "rerank_model": str, "max_hops": int, "prompt_version": str,
     "python": str, "environment": "local" | "production" }`
`retrieval` es honesto: `hybrid` solo si el probe del backend BM25 configurado funciona; si no,
`dense-only`.

### `POST /api/search`
Body: `{ "query": str, "top_k": int = 8, "project_id": str|null, "document_id": str|null,
         "document_type": str|null, "language": str|null }`
→ `{ "results": [{ "text", "score", "source_file", "page", "section", "document_type",
                   "language", "project_id", "document_id" }] }`
Búsqueda cruda, sin agente ni reranker: sirve para depurar el retrieval.

### `POST /api/chat`  (SSE stream)
Body: `{ "session_id": str|null, "message": str, "modo": "normal"|"extendido"|null }`
`modo` elige el presupuesto de búsqueda y deliberación (ver "Modos de pensamiento");
ausente o desconocido = `normal`.
Respuesta: `text/event-stream`, eventos:
- `event: session` → `data: {"session_id": "uuid"}` (primero, siempre)
- `event: hop` → `data: {"n": 1, "query": "resumen legible de la llamada a buscar_documentos"}`
  (una por llamada a la herramienta). El mismo dict, ya persistido en `chat_messages.hops`,
  lleva además `ms` (duración), `resultados` (chunks devueltos) y `chars` (tamaño del texto
  que volvió al modelo): el agente lo muta in place tras ejecutar la llamada.
- `event: sources` → `data: {"sources": [SourceRef...]}` con `source_file`, `page`,
  `section`, `document_type`, `language`, `project_id`, `document_id`, `source_pages`,
  `chunk_type`, `snippet` y `score` (antes de los tokens; puede re-emitirse durante el
  stream: el frontend usa el ÚLTIMO evento recibido)
- `event: token` → `data: {"text": "..."}` (delta de texto de la respuesta)
- `event: metrics` → `data: telemetry.summary()` (aditivo, justo antes de `done`; el frontend
  lo ignora hoy). Payload: `ms_total`, `rounds_total`, `agent_rounds`,
  `tokens {prompt, cached, completion, reasoning}` (medidos, del `usage` real),
  `cached_ratio`, `by_component` (`agente`, `reranker`, `embeddings`), `by_model`,
  `cost_usd` (estimado), `cost_label` (siempre "estimado, tarifas asumidas"),
  `unknown_models`, `counters` (`hops`, `hops_con_error`, `llamadas_repetidas`,
  `forced_final`, `rounds_sin_usage`), `marks`, `meta` (modelo, `prompt_version`,
  `retrieval`...) y `rounds` (una entrada por llamada al LLM).
- `event: done` → `data: {"message_id": "uuid"}`
- `event: error` → `data: {"detail": "..."}`

## Autenticación multiusuario (Supabase Auth)

Sustituye por completo al gate de clave compartida (`APP_ACCESS_KEY` y el header
`X-App-Key` dejan de existir). Migración: `supabase/migrations/004_auth_multiusuario.sql`
(ya aplicada en el proyecto de Supabase).

**Reglas de negocio**
- Alta con correo y contraseña. Solo dominio `@airobotix.net`; lo impone un trigger de
  Postgres sobre `auth.users`, así que un registro con otro dominio falla aunque se llame
  a la API de Supabase directamente.
- Roles en `profiles.role`: `admin` y `lector`. `emir.malek@airobotix.net` nace admin;
  el resto nace lector.
- **Conversaciones privadas**: cada usuario ve solo las suyas (`chat_sessions.user_id`).
  Las sesiones históricas con `user_id` nulo solo las ven los admin.
- **Documentos compartidos**: todos los usuarios ven y consultan todos los documentos.
  Subir y borrar es exclusivo de `admin` (403 para lector).
- **Costos internos siguen ocultos para todos los roles** (sin cambios).

**Contrato HTTP**
- `GET /api/health` sigue siendo público (sin token).
- Todo el resto de `/api/*` exige `Authorization: Bearer <access_token de Supabase>`.
  Sin token o token inválido → `401 {"detail": "Sesión no válida o expirada"}`.
  Rol insuficiente → `403 {"detail": "Solo un administrador puede ..."}`.
- `GET /api/me` → `{ "id", "email", "role" }` del usuario del token.

**Backend** (`app/services/auth.py`, nuevo)
```python
class AuthUser(BaseModel): id: str; email: str; role: str
async def current_user(authorization: str = Header(None)) -> AuthUser  # dependencia FastAPI
async def require_admin(user: AuthUser = Depends(current_user)) -> AuthUser
```
- Valida el token con el SDK de Supabase (`auth.get_user(jwt)`) y lee el rol de `profiles`.
  Caché en memoria por token (TTL 60 s) para no ir a la red en cada request.
- `supabase_db`: `list_sessions(user_id, is_admin)`, `create_session(title, user_id)`,
  `get_messages` y `save_message` verifican que la sesión pertenezca al usuario (o admin).
  `register_document(..., uploaded_by)`.

**Aislamiento estricto de conversaciones (sin excepciones por rol)**
Ningún usuario, ni siquiera un administrador, ve las conversaciones de otro. `list_sessions`
devuelve exclusivamente las del `user_id` del token. Las sesiones históricas con `user_id`
nulo no las ve nadie por la API; quedan archivadas en la base hasta que se les asigne dueño.

**Sección de Ajustes**
Slide-over (bottom sheet en móvil) que se abre desde el pie del sidebar, con pestañas:
- **Usuarios** (solo admin): lista de cuentas con buscador por correo, clic en la fila para
  promover o degradar (confirmación en dos pasos al degradar), y por cuenta: rol, alta,
  último acceso y contadores de uso. Solo cifras: nunca texto de conversaciones ajenas.
- **Sistema** (solo admin): estado del índice, actividad agregada y configuración vigente,
  todo de solo lectura desde `GET /api/stats`.
- **Mi cuenta** (todos los roles): correo, rol, cambio de contraseña con
  `supabase.auth.updateUser` desde el cliente, y cerrar sesión.

`GET /api/stats` (solo admin) →
```json
{ "index": {"chunks", "files", "types": [], "languages": []},
  "activity": {"questions_total", "questions_7d", "active_users_7d", "feedback_up", "feedback_down"},
  "config": {"model", "rerank_model", "embedding_model", "max_hops", "prompt_version",
             "search_top_k", "rerank_top_k", "openai_concurrency",
             "upload_limit_mb", "retrieval", "bm25_backend", "qdrant_version",
             "python", "environment"} }
```
`retrieval` sigue la misma regla que en `/api/health`: `hybrid` solo si BM25 funciona en ese
proceso, si no `dense-only`.

**Gestión de usuarios (solo admin)**
- `GET /api/users` → `{ "users": [{ "id", "email", "role", "created_at", "last_sign_in_at",
  "sessions_count", "messages_count" }] }` ordenados por fecha de alta. 403 para lector.
- `PATCH /api/users/{user_id}` body con `role` y/o `blocked`:
  `{ "role": "admin" | "lector" }` y/o `{ "blocked": true | false }` → devuelve la fila
  actualizada `{ "id", "email", "role", "blocked" }`. Bloquear revoca el acceso sin borrar
  nada: la cuenta y sus conversaciones se conservan y se puede desbloquear.
- `DELETE /api/users/{user_id}` → borra la cuenta de forma permanente junto con sus
  conversaciones. Los documentos que hubiera subido se conservan (pasan a sin autor).
  → `{ "ok": true }`.
- Guardas comunes: 403 si el administrador intenta bloquearse, degradarse o borrarse a sí
  mismo; 404 si la cuenta no existe.
- Efecto del bloqueo: `profiles.blocked` y además baneo en Supabase Auth (no puede volver a
  entrar ni renovar). Toda petición suya responde
  `403 {"detail": "Tu acceso ha sido revocado", "code": "blocked"}`; el frontend, al ver ese
  `code`, cierra su sesión de inmediato aunque su token siga vigente.
  - 400 si el rol no es válido.
  - 403 si el usuario intenta cambiar su propio rol (evita quedarse sin administradores):
    `{"detail": "No puedes cambiar tu propio rol"}`.
  - 404 si el usuario no existe.
- Frontend: entrada "Usuarios" en el pie del sidebar, visible solo para admin, que abre un
  slide-over con el mismo patrón que Documentos (bottom sheet en móvil). Lista de cuentas con
  correo, insignia de rol y acción para promover o degradar, con confirmación en dos pasos
  para degradar. La fila del propio usuario aparece marcada como "Tú" y sin acción.

**Frontend**
- Cliente `@supabase/supabase-js` con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`
  (publishable `sb_publishable_OiC7eo39rLRrnoaR6nHgIA_xRCENub0`).
- `UnlockGate` se sustituye por pantalla de acceso con pestañas Entrar / Crear cuenta:
  correo, contraseña, mensajes de error en español, aviso claro de que solo se permiten
  correos `@airobotix.net`, y aviso de "revisa tu correo" si la confirmación está activa.
- Todas las llamadas (fetch, XHR de subida y el stream del chat) envían
  `Authorization: Bearer <token>`; el token se renueva con `onAuthStateChange` y un 401
  devuelve a la pantalla de acceso.
- Pie del sidebar: correo del usuario, su rol y acceso a Ajustes (cerrar sesión vive dentro,
  en la pestaña Mi cuenta).
- Si el rol es `lector`: el panel de Documentos muestra la lista completa pero sin
  dropzone ni botones de borrar, con una nota de que solo un administrador puede
  gestionarlos.

### Gestión de documentos (indexación dinámica)

#### `GET /api/documents`
→ `{ "documents": [{ "id", "file_name", "pages": int, "chunks": int, "status": "processing"|"ready"|"failed", "error": str|null, "ingested_at" }] }`
Todos los documentos registrados, en orden de ingesta.

#### `POST /api/documents/upload`  (multipart/form-data, campo `file`)
Extensiones permitidas: .pdf .docx .xlsx .csv .txt .md · máx 25 MB en local y 4 MB en
Vercel (`upload_limit_mb` en `/api/health` dice el vigente) · nombre saneado (sin rutas).
Rechazos → 400 con `{ "detail" }`. Duplicado de un archivo ya indexado → 409 (usar DELETE primero).
→ 202 `{ "id", "file_name", "status": "processing" }` y la ingesta corre en background
(FastAPI BackgroundTasks): parseo → chunking → embeddings → upsert a Qdrant → registro con
status "ready" (o "failed" + error). El archivo se guarda en `data/uploads/`.

#### `DELETE /api/documents/{file_name}`
Borra los puntos de Qdrant (`delete_by_file`) + el registro. → `{ "ok": true }`

**Parseo** (`app/ingest/generic.py`, el único camino de ingesta; lo comparten la subida por
la web y el CLI):
- PDF → texto por página (pdfplumber), chunks por párrafos ~400 tokens con overlap 15%,
  `page` = primera página del chunk, `source_pages` = todas, `chunk_type` = "text".
- DOCX → párrafos agrupados por sección (el encabezado vigente, detectado por estilo) sin
  mezclar dos secciones en un chunk, más una tabla por chunk (`chunk_type` = "table",
  numeradas 1..n). Word no tiene páginas: las calcula el visor al renderizar.
- **Conciencia de artículo** (`app/ingest/paper.py`, solo PDF, todo determinista y sin LLM):
  - `section`: el encabezado vigente. Un encabezado se reconoce de dos maneras: por su
    NOMBRE, cuando es una sección de artículo conocida (`3. Methods`, `III. RESULTADOS`), y
    por su MAQUETA cuando no lo es (línea corta, sin punto final, con más cuerpo de letra o
    en negrita que el texto corrido). La segunda es imprescindible fuera de la literatura
    científica: medido en producción, una guía de 4 páginas quedó con "sección: Introducción"
    en TODOS sus fragmentos porque "Composición del mazo" no estaba en el vocabulario y la
    sección anterior seguía vigente; el agente lo repetía en la respuesta. La detección por
    nombre exige que la línea COMPLETA sea el nombre, para que "the methods described by
    Smith et al." no cuente. Un chunk nunca mezcla dos secciones.
  - `title`, `citation` y `doi`: el título sale del bloque de mayor tamaño de fuente de la
    cabecera, exigiendo que sea estrictamente mayor que el cuerpo (si no, no hay título
    maquetado y no se inventa uno); el apellido del primer autor, de la línea siguiente; el
    año, de la vecindad del DOI y descartando las líneas de marca de descarga, porque un PDF
    bajado en 2026 no es un artículo de 2026. `citation` se rellena SOLO con autor y año: el
    título NO sirve de respaldo, porque medido en producción un título largo recortado con
    puntos suspensivos se repetía en cada punto de una lista, hacía la respuesta ilegible y
    rompía el enlace de la cita con su fuente. Sin autor y año la cita es el nombre del
    archivo, que es corto y enlazable: nunca se fabrica una referencia.
  - La **bibliografía se descarta** por defecto (`skip_references=True`): son títulos de
    trabajos ajenos, matchean con casi cualquier consulta, no son evidencia de nada y se pagan
    igual al embeberlos (medido en un artículo de prueba: 30% menos tokens).
  - Se descartan las marcas de agua de revista y las **cabeceras y pies repetidos**, detectados
    por aparecer en el borde de al menos el 60% de las páginas y en 3 o más. Solo se miran las
    dos primeras y dos últimas líneas de cada página: perder contenido por una frase repetida
    sería mucho peor que arrastrar una cabecera.
- XLSX/CSV → detección de fila de encabezado, un chunk por fila ("Campo: valor"),
  `chunk_type` = "table", `page` = número de fila.
- TXT/MD → chunks por párrafos, `page` = índice de chunk (1-based).
- .doc (Word 97-2003) se rechaza con un error que dice cómo convertirlo.
- **Citas honestas**: no todo formato tiene páginas, así que el localizador lo decide
  `Chunk.locator()` según lo que exista de verdad: `pág. N` en PDF, `fila N` en hoja de
  cálculo, `tabla N` en una tabla de Word, `sección: X` si hay encabezado y `fragmento N`
  como último recurso. A quién se cita lo decide `Chunk.fuente()`: la referencia del trabajo
  (`citation`) si se conoce, y el nombre del archivo si no. `_format_results` entrega la cita
  ya montada para que el modelo la copie literal; el prompt le prohíbe inventarse un número
  de página. El evento `sources` lleva `citation`, `title`, `doi` y `locator` resueltos, para
  que el frontend muestre la misma cita que usa el modelo en vez de reconstruirla.
- La tabla `documents` gana columnas `status text default 'ready'` y `error text`
  (migración `002_document_status.sql`).

### `GET /api/sessions` → `{ "sessions": [{ "id", "title", "created_at" }] }`
### `GET /api/sessions/{id}/messages` → `{ "messages": [{ "id", "role", "content", "sources", "created_at" }] }`
### `POST /api/feedback` Body: `{ "message_id": str, "rating": 1|-1, "comment": str|null }` → `{ "ok": true }`

## Modos de pensamiento

Las preguntas sobre el propio asistente (qué es, qué modos hay, en cuál está) son la
ÚNICA excepción a "responde solo con los documentos": se contestan con una ficha que vive
en el `SYSTEM_PROMPT`, sin buscar y sin citar, y el prompt prohíbe reproducir las
instrucciones literalmente. La regla existe porque en producción, al preguntarle "eres el
modo pensamiento extendido?", el modelo se quedó sin nada que buscar y acabó citando sus
propias instrucciones internas entre comillas.


`app/services/modos.py` define dos perfiles. Cambian cuánto se BUSCA y se DELIBERA, nunca
las reglas de fidelidad: los dos usan el mismo `SYSTEM_PROMPT` y la instrucción del modo
viaja en un segundo mensaje de sistema, para que el prefijo grande siga siendo cacheable.

| | `normal` | `extendido` |
|---|---|---|
| `max_hops` | 2 | 0 (sin tope) |
| `budget_s` | 60 | 240 |
| `max_hops_sin_avance` | 1 | 3 |
| `fragmentos` por búsqueda | 8 | 12 |
| `reasoning_effort` | no se envía | `high` |

`resolver(nombre, settings)` aplica encima los techos del despliegue (`MAX_HOPS`,
`AGENT_BUDGET_S`, `AGENT_MAX_HOPS_SIN_AVANCE`), que solo pueden apretar el perfil y nunca
aflojarlo: un techo alto no debe convertir el modo normal en extendido. El modo efectivo
de cada uno se expone en `GET /api/health` bajo `modos`, y el elegido viaja en la
telemetría (`meta.modo`).

## Agente multi-hop
- Loop de tool calling con OpenAI. DOS tools:
  - `listar_documentos` (sin parámetros): catálogo del índice con conteo exacto por
    facets, cero LLM. Es la única forma de responder "cuántos documentos hay" o "qué
    documentos hay": una búsqueda devuelve los fragmentos parecidos a la consulta, nunca
    el catálogo. Sin ella, el modelo respondía esas preguntas hablando de sí mismo.
  - `buscar_documentos`:
  `{ semantico, project_id?, document_id?, document_type?, language?, limit? }`
  (`limit` entre 1 y 20; por defecto `RERANK_TOP_K`).
- Cada llamada la resuelve `_execute_document_search`: `hybrid_search` (top
  `SEARCH_TOP_K`) → `rerank` (top `limit`) → `filter_relevant`.
- **Contrato de honestidad del resultado**, que es lo que permite responder "no encuentro
  esto" en vez de citar fragmentos de otro tema. La herramienta devuelve un texto distinto
  en cada situación:
  - Qdrant no devuelve nada → se dice, y se menciona si había filtros puestos.
  - El filtro verificó que NINGÚN fragmento aporta evidencia → se le dice al modelo que el
    índice no cubre el tema y que no lo presente como un fallo de búsqueda.
  - Filtrado parcial → se declara cuántos aportan evidencia y cuántos se descartaron.
  - El filtro no se pudo aplicar (API caída, JSON roto) → aviso explícito de que la
    relevancia no está verificada, en vez de callarlo.
- Guard de deduplicación: una llamada idéntica repetida no se re-ejecuta ni consume
  presupuesto. Máximo `MAX_HOPS` llamadas por pregunta.
- Cliente OpenAI único por loop (`app/services/openai_client.py`) con semáforo
  (`OPENAI_CONCURRENCY`), timeout y reintentos de settings. Cada ronda se pide con
  `stream_options: {include_usage: true}` y se registra en `app/services/telemetry.py`
  (componente `agente`); el reranker y los embeddings registran los suyos. El resumen sale
  como evento SSE `metrics`.
- **Fidelidad**: el system prompt exige responder SOLO con lo recuperado, copiar LITERAL la
  cita que trae cada resultado en su cabecera, decir explícitamente cuando algo no está en
  los documentos, conservar unidades y nombres tal como aparecen en la fuente, y distinguir
  evidencia directa de interpretación y de ausencia de evidencia.
- Respuesta final en streaming.

## Reranker y filtro de relevancia
- `rerank`: listwise, un solo request con query + candidatos numerados → JSON
  `{"ranking": [idx...]}`. Ordena por evidencia aportada, no por parecido de palabras.
  Si hay `top_k` o menos candidatos no llama al LLM. Fallback: orden de Qdrant.
- `filter_relevant`: clasificación binaria por fragmento que PRESERVA el orden de entrada.
  Devuelve `RelevanceOutcome(kept, verificado, motivo)` con tres estados distinguibles:
  hay relevantes, ninguno es relevante (verificado, y es una respuesta legítima), o no se
  pudo verificar. Esa distinción es la que consume el agente; sin ella no hay forma de
  saber si una lista vacía significa "no hay" o "falló algo".
- Modelo: `RERANK_MODEL` (default `gpt-5.4-mini`; vacío = hereda `OPENAI_MODEL`).

## Supabase (tablas)
- `chat_sessions(id uuid pk, title text, created_at)`
- `chat_messages(id uuid pk, session_id fk, role text, content text, sources jsonb, hops jsonb, created_at)`
- `documents(id uuid pk, file_name text, sha256 text, pages int, chunks int, brand text, environment text, ingested_at)` con unique `(file_name, environment)` desde la migración 006. La columna `brand` es heredada y ya no se usa.
- `ingestion_runs(id uuid pk, started_at, finished_at, status text, stats jsonb, error text)`
- `message_feedback(id uuid pk, message_id fk, rating int, comment text, created_at)`
- El frontend NUNCA habla con Supabase directo: todo pasa por el backend (service key solo en backend).

## Variables de entorno (backend/.env)
```
OPENAI_API_KEY=
OPENAI_BASE_URL=          # vacío = api.openai.com; endpoint compatible (AI Gateway de Vercel) si se pone
OPENAI_MODEL=gpt-5.4
EMBEDDING_MODEL=text-embedding-3-large
RERANK_MODEL=gpt-5.4-mini   # default en código; vacío = hereda OPENAI_MODEL
OPENAI_TIMEOUT_S=120        # timeout por request del cliente único
OPENAI_MAX_RETRIES=2        # reintentos del SDK
OPENAI_CONCURRENCY=3        # semáforo de llamadas concurrentes a OpenAI
PROMPT_VERSION=v3           # etiqueta del prompt; viaja en health, stats, metrics y evals
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=          # vacío para local
QDRANT_COLLECTION=documentos
QDRANT_BM25_BACKEND=server # server | fastembed | auto | disabled; cambiar exige reindexar
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
MAX_HOPS=4
RERANK_TOP_K=8
SEARCH_TOP_K=30
ENVIRONMENT=local        # 'production' en Vercel
CORS_ORIGINS=http://localhost:5173
```
Si `SUPABASE_URL` está vacío, el backend funciona igual (persistencia en memoria, con warning),
para poder probar el RAG sin esperar credenciales. Dónde vive cada variable (local o Vercel) y
las recomendaciones de valores: [docs/OPERACION.md](docs/OPERACION.md).

## Interfaces internas del backend (firmas exactas: los módulos se implementan en paralelo)

Tipos compartidos: `app/models.py` (ya existe: `Chunk`, `SearchFilters`, `SourceRef`).
Config: `from app.config import get_settings` (ya existe). Embeddings: `app/services/embeddings.py` (ya existe:
`embed_texts(texts: list[str]) -> list[list[float]]`, `async embed_query(text: str) -> list[float]`).

`app/services/qdrant.py`:
```python
def get_client() -> qdrant_client.QdrantClient: ...
def ensure_collection() -> None            # crea colección + índices payload si no existen (idempotente)
def collection_count() -> int | None       # None si Qdrant no responde
def upsert_chunks(chunks: list[dict]) -> int
    # cada dict: las claves de _PAYLOAD_KEYS (lista blanca) + "id" + "dense": list[float].
    # Lo que no esté en _PAYLOAD_KEYS se descarta; lo que falte queda en None.
    # Calcula bm25 en el servidor Qdrant o con fastembed, según configuración.
def index_inventory() -> dict
    # inventario en vivo por facets: total_chunks, archivos, tipos, idiomas, proyectos
def delete_by_file(source_file: str) -> None
async def hybrid_search(query: str, filters: SearchFilters, top_k: int) -> list[Chunk]
    # dense + bm25 con RRF; reintento dense-only si el sparse falla durante una consulta
```

`app/services/reranker.py`:
```python
async def rerank(query: str, chunks: list[Chunk], top_k: int) -> list[Chunk]
    # listwise LLM (JSON mode). Ante cualquier fallo devuelve chunks[:top_k] con warning en log.

@dataclass(frozen=True)
class RelevanceOutcome:
    kept: list[Chunk]      # fragmentos que aportan evidencia
    verificado: bool       # False = el filtro no se pudo aplicar, no concluyas nada
    motivo: str

async def filter_relevant(query: str, chunks: list[Chunk]) -> RelevanceOutcome
    # kept=[] con verificado=True significa "ninguno sirve", y es una respuesta legítima.
```

`app/services/agent.py`:
```python
async def run_agent(message: str, history: list[dict]) -> AsyncIterator[AgentEvent]
    # history: [{"role": "user"|"assistant", "content": str}, ...] (mensajes previos de la sesión)
    # AgentEvent = dataclass(type: Literal["hop","sources","token","final"], data: dict)
    #   hop: {"n": int, "query": str} (+ "ms", "resultados", "chars" tras ejecutarse)
    #   sources: {"sources": [SourceRef.model_dump()]}
    #   token: {"text": str} | final: {"content": str, "sources": [...], "hops": [...]}
    # Internamente: loop de tool-calling (máx MAX_HOPS) con UNA sola tool,
    # buscar_documentos (_DOCUMENT_SEARCH_TOOL), parámetros: semantico, project_id,
    # document_id, document_type, language, limit (1..20, default RERANK_TOP_K).
    # Cada llamada la resuelve _execute_document_search:
    #   hybrid_search(top SEARCH_TOP_K) → rerank(top limit) → filter_relevant,
    #   y el texto devuelto declara qué pasó (nada recuperado, ninguno relevante,
    #   filtrado parcial, o relevancia sin verificar). Ver "Agente multi-hop".
    # Una llamada con parámetros idénticos a una ya ejecutada no se repite. Cada ronda
    # del LLM va con stream_options include_usage y se registra en telemetry; la
    # respuesta final se emite en streaming.
```

`app/services/supabase_db.py` (todas síncronas, se llaman con run_in_threadpool desde routes, o async si el SDK lo permite):
```python
def db_available() -> bool
def create_session(title: str) -> dict          # {"id", "title", "created_at"}
def list_sessions() -> list[dict]
def get_messages(session_id: str) -> list[dict]
def save_message(session_id: str, role: str, content: str, sources: list, hops: list) -> dict  # devuelve fila con id
def save_feedback(message_id: str, rating: int, comment: str | None) -> None
def register_document(file_name: str, sha256: str, pages: int, chunks: int, brand: str = "") -> None
def start_run() -> str | None; def finish_run(run_id, status, stats, error=None) -> None
# Si SUPABASE_URL está vacío → fallback en memoria (dicts módulo-level) con los mismos contratos.
```

## Frontend (requisitos)
- Chat con streaming SSE (fetch + ReadableStream, parsear eventos del contrato de arriba).
- Panel lateral de fuentes: badges `archivo · localizador · sección`, snippet expandible,
  score. El localizador es el que traiga la fuente (página, sección, fila o tabla): la UI
  no debe asumir que todo documento tiene páginas.
- Indicador de hops del agente ("buscando: biomarcadores en LCR...") mientras piensa.
- Lista de sesiones (GET /api/sessions), crear nueva, continuar existente.
- Feedback 👍/👎 por mensaje → POST /api/feedback.
- Español, tema oscuro/claro según sistema, sin librerías UI pesadas (CSS propio está bien).
