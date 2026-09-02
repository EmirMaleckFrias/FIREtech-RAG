# SPEC: RAG de Productos (Protección Contra Incendios)

Contrato de arquitectura. Cualquier código del proyecto debe respetar estas interfaces.

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
Rag - Productos/
├── data/raw/                  # los 6 PDFs fuente
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   ├── ingest.py              # CLI: python ingest.py --environment local|production
│   │                          #      [--dry-run] [--reset --yes [--include-uploads]] [--only ...] [--source ...]
│   ├── check_index.py         # solo lectura: estado real del índice (ver docs/OPERACION.md)
│   └── app/
│       ├── main.py            # FastAPI app + CORS
│       ├── config.py          # pydantic-settings, lee .env
│       ├── api/routes.py      # endpoints REST + SSE
│       ├── services/
│       │   ├── qdrant.py      # cliente, setup colección, hybrid search
│       │   ├── embeddings.py  # OpenAI embeddings con batching
│       │   ├── reranker.py    # reranking LLM listwise
│       │   ├── agent.py       # agente multi-hop con tool calling
│       │   └── supabase_db.py # persistencia chat
│       └── ingest/
│           ├── parse.py       # parseo PDF por archivo (estructura específica)
│           ├── chunk.py       # chunking según SPEC de síntesis
│           └── pipeline.py    # orquesta: parse → chunk → embed → upsert
├── frontend/                  # Vite + React + TS
├── supabase/migrations/       # 001..007, aplicar EN ORDEN (esquema, estados de
│                              # documentos, entornos, auth, bloqueo, revocaciones)
├── infra/docker-compose.yml   # Qdrant local
└── README.md
```

## Colección Qdrant
- Nombre: `productos` (env `QDRANT_COLLECTION`)
- Vectores nombrados:
  - `dense`: 3072 dims, coseno (OpenAI text-embedding-3-large)
  - `bm25`: sparse vector (BM25 vía fastembed). Si fastembed no está disponible la búsqueda
    cae a dense-only sin romper. IMPORTANTE: ese es el estado PERMANENTE de producción
    serverless (fastembed/onnxruntime no cabe en la función de Vercel), así que producción
    consulta dense-only aunque los vectores sparse existan en el índice. El modo vigente se
    expone como `retrieval` en `GET /api/health` y en el bloque config de `/api/stats`.
- Payload por punto (chunk):
  ```json
  {
    "text": "texto completo del chunk (lo que ve el LLM)",
    "source_file": "Catalogo_Reliable_1.pdf",
    "page": 3,
    "brand": "Reliable",
    "category": "sprinklers",
    "skus": ["RA1414", "..."],
    "product_names": ["..."],
    "has_price": true,
    "supplier": "RELIABLE",
    "price_usd": 123.45,
    "price_status": "numeric | call | discontinued | missing",
    "chunk_type": "product | family_summary | doc_text | doc_row"
  }
  ```
  `product` y `family_summary` salen de los 6 catálogos; `doc_text` y `doc_row` de los
  documentos subidos por la API (ver "Parseo genérico"). El payload completo (campos ricos del
  esquema canónico, costo interno incluido) es `_PAYLOAD_KEYS` en `app/services/qdrant.py`
  más `price_usd`, que `upsert_chunks` deriva al indexar (`price_net_usd` si existe, si no
  `price_list_usd`; None sin precio numérico); `_point_to_chunk` no expone los internos.
- Índices de payload (9): `brand`, `category`, `source_file`, `has_price` (bool), `skus`,
  `supplier`, `chunk_type` (keyword), `price_usd` (float, lo usa el orden por precio) y
  `price_status` (keyword). La lista vive en `qdrant.PAYLOAD_INDEXES` (los crea
  `ensure_collection` con la colección) y, duplicada a propósito, en
  `check_index.EXPECTED_INDEXES`; `check_index.py` compara los existentes con ella y
  `--apply-indexes` crea los que falten en una colección ya existente.

## API Backend (contrato para el frontend)
Base: `http://localhost:8000`

### `GET /api/health`
→ `{ "status": "ok", "qdrant": true, "collection_points": 1234, "upload_limit_mb": 4,
     "retrieval": "hybrid" | "dense-only", "bm25_backend": str, "qdrant_version": str,
     "model": str, "rerank_model": str, "max_hops": int, "prompt_version": str,
     "python": str, "environment": "local" | "production" }`
`retrieval` es honesto: `hybrid` solo si el codificador BM25 está cargado en ese proceso; si no,
`dense-only` (el estado permanente de producción).

### `POST /api/search`
Body: `{ "query": str, "top_k": int = 8, "brand": str|null, "category": str|null }`
→ `{ "results": [{ "text", "score", "source_file", "page", "brand", "category", "skus" }] }`

### `POST /api/chat`  (SSE stream)
Body: `{ "session_id": str|null, "message": str }`
Respuesta: `text/event-stream`, eventos:
- `event: session` → `data: {"session_id": "uuid"}` (primero, siempre)
- `event: hop` → `data: {"n": 1, "query": "resumen legible de la llamada a consultar_catalogo"}`
  (una por llamada a la herramienta). El mismo dict, ya persistido en `chat_messages.hops`,
  lleva además `ms` (duración), `resultados` (chunks devueltos) y `chars` (tamaño del texto
  que volvió al modelo): el agente lo muta in place tras ejecutar la llamada.
- `event: sources` → `data: {"sources": [{"source_file", "page", "brand", "snippet", "score"}]}` (antes de los tokens; puede re-emitirse durante el stream: el frontend usa el ÚLTIMO evento recibido)
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
- Roles en `profiles.role`: `admin` y `vendedor`. `emir.malek@airobotix.net` nace admin;
  el resto nace vendedor.
- **Conversaciones privadas**: cada usuario ve solo las suyas (`chat_sessions.user_id`).
  Las sesiones históricas con `user_id` nulo solo las ven los admin.
- **Documentos compartidos**: todos los usuarios ven y consultan todos los documentos.
  Subir y borrar es exclusivo de `admin` (403 para vendedor).
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
{ "index": {"products", "chunks", "files", "suppliers": []},
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
  "sessions_count", "messages_count" }] }` ordenados por fecha de alta. 403 para vendedor.
- `PATCH /api/users/{user_id}` body con `role` y/o `blocked`:
  `{ "role": "admin" | "vendedor" }` y/o `{ "blocked": true | false }` → devuelve la fila
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
- Si el rol es `vendedor`: el panel de Documentos muestra la lista completa pero sin
  dropzone ni botones de borrar, con una nota de que solo un administrador puede
  gestionarlos.

### Gestión de documentos (indexación dinámica)

#### `GET /api/documents`
→ `{ "documents": [{ "id", "file_name", "pages": int, "chunks": int, "brand": str, "status": "processing"|"ready"|"failed", "error": str|null, "ingested_at" }] }`
Incluye los 6 catálogos originales (status "ready") y todo documento subido después.

#### `POST /api/documents/upload`  (multipart/form-data, campo `file`)
Extensiones permitidas: .pdf .xlsx .csv .txt .md · máx 25 MB · nombre saneado (sin rutas).
Rechazos → 400 con `{ "detail" }`. Duplicado de un archivo ya indexado → 409 (usar DELETE primero).
→ 202 `{ "id", "file_name", "status": "processing" }` y la ingesta corre en background
(FastAPI BackgroundTasks): parseo genérico → chunking → embeddings → upsert a Qdrant →
registro con status "ready" (o "failed" + error). El archivo se guarda en `data/uploads/`.

#### `DELETE /api/documents/{file_name}`
Borra los puntos de Qdrant (`delete_by_file`) + el registro. Los 6 catálogos base NO se
pueden borrar por esta vía (403). → `{ "ok": true }`

**Parseo genérico** (`app/ingest/generic.py`, para documentos que no son los 6 catálogos):
- PDF → texto por página (pdfplumber), chunks por párrafos ~400 tokens con overlap 15%,
  `page` = primera página del chunk, `source_pages` = todas, `chunk_type` = "doc_text".
- XLSX/CSV → detección de fila de encabezado, un chunk por fila ("Campo: valor"),
  `chunk_type` = "doc_row", `page` = número de fila.
- TXT/MD → chunks por párrafos, `page` = índice de chunk (1-based).
- Payload: mismas claves de `_PAYLOAD_KEYS` (brand/category "", has_price false, skus =
  tokens tipo SKU detectados en el chunk para el fast-path). Citas: `[archivo, pág. X]`.
- La tabla `documents` gana columnas `status text default 'ready'` y `error text`
  (migración `002_document_status.sql`).

### `GET /api/sessions` → `{ "sessions": [{ "id", "title", "created_at" }] }`
### `GET /api/sessions/{id}/messages` → `{ "messages": [{ "id", "role", "content", "sources", "created_at" }] }`
### `POST /api/feedback` Body: `{ "message_id": str, "rating": 1|-1, "comment": str|null }` → `{ "ok": true }`

## Agente multi-hop
- Loop de tool calling con OpenAI. UNA sola tool general, `consultar_catalogo`, que
  expone el álgebra de consulta del catálogo estructurado (el enrutamiento vive en el
  MOTOR, no en reglas del prompt por tipo de pregunta):
  `{ semantico?, suplidor?, marca?, precio_min?, precio_max?,
     ordenar?: precio_asc|precio_desc, agrupar_por?: suplidor|marca|archivo,
     limite?, por_grupo? }`
  - Solo `semantico` → híbrida/dense + fast-path de SKU + reranker (top 8).
  - `ordenar` sin `semantico` → scroll de Qdrant ordenado por el payload `price_usd`
    (neto si existe, si no lista; lo escribe `upsert_chunks` en cada ingesta y en las
    colecciones actuales llegó por backfill sin re-embeber), EXACTO y sin LLM.
  - `ordenar` + `semantico` → pool híbrido + clasificación binaria de relevancia +
    orden por precio real.
  - `agrupar_por` con `ordenar` → un scroll exacto por grupo ("el más barato de cada
    suplidor" = UNA llamada). `agrupar_por` solo → conteos reales por facets
    ("¿cuántas marcas hay?").
  - `suplidor` filtra en Qdrant por el payload `supplier` (exacto y confiable);
    `marca` es post-filtro por término, tolerante a los errores de etiquetado del
    origen. Pool vacío se reporta vacío: sin fallbacks silenciosos.
- Guard de deduplicación: una llamada idéntica repetida no se re-ejecuta ni consume
  presupuesto. Máximo `MAX_HOPS` llamadas por pregunta (con la tool compuesta, las
  preguntas de agregación resuelven en 1).
- Cliente OpenAI único por loop (`app/services/openai_client.py`) con semáforo
  (`OPENAI_CONCURRENCY`), timeout y reintentos de settings. Cada ronda se pide con
  `stream_options: {include_usage: true}` y se registra en `app/services/telemetry.py`
  (componente `agente`); el reranker y los embeddings registran los suyos. El resumen sale
  como evento SSE `metrics`.
- **Fidelidad**: system prompt exige responder SOLO con lo recuperado, citar `[archivo, pág. X]`
  en cada afirmación factual, y decir explícitamente cuando algo no está en los catálogos.
  Precios siempre con moneda y con la advertencia de que provienen del catálogo (pueden estar desactualizados).
- Respuesta final en streaming.

## Reranker
- Listwise LLM: un solo request con query + candidatos numerados → JSON `{"ranking": [idx...], "scores": {...}}`.
- Modelo: `RERANK_MODEL` (default `gpt-5.4-mini`; vacío = hereda `OPENAI_MODEL`). Corta a
  `RERANK_TOP_K=8`. También lo usa el filtro binario de relevancia del camino de precios.
- Fallback: si el JSON falla, mantener orden de Qdrant.

## Supabase (tablas)
- `chat_sessions(id uuid pk, title text, created_at)`
- `chat_messages(id uuid pk, session_id fk, role text, content text, sources jsonb, hops jsonb, created_at)`
- `documents(id uuid pk, file_name text unique, sha256 text, pages int, chunks int, brand text, ingested_at)`
- `ingestion_runs(id uuid pk, started_at, finished_at, status text, stats jsonb, error text)`
- `message_feedback(id uuid pk, message_id fk, rating int, comment text, created_at)`
- El frontend NUNCA habla con Supabase directo: todo pasa por el backend (service key solo en backend).

## Variables de entorno (backend/.env)
```
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4
EMBEDDING_MODEL=text-embedding-3-large
RERANK_MODEL=gpt-5.4-mini   # default en código; vacío = hereda OPENAI_MODEL
OPENAI_TIMEOUT_S=120        # timeout por request del cliente único
OPENAI_MAX_RETRIES=2        # reintentos del SDK
OPENAI_CONCURRENCY=3        # semáforo de llamadas concurrentes a OpenAI
PROMPT_VERSION=v1           # etiqueta del prompt; viaja en health, stats, metrics y evals
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=          # vacío para local
QDRANT_COLLECTION=productos
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
MAX_HOPS=4
RERANK_TOP_K=8
SEARCH_TOP_K=30
SKU_FASTPATH=true
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
    # cada dict: {"id": str(uuid), "text", "source_file", "page", "brand", "category",
    #             "skus", "product_names", "has_price", "chunk_type", "dense": list[float]}
    # calcula bm25 internamente si fastembed está disponible
def delete_by_file(source_file: str) -> None
async def hybrid_search(query: str, filters: SearchFilters, top_k: int) -> list[Chunk]
    # dense (embed_query) + bm25 con fusión RRF vía Query API de Qdrant; fallback dense-only sin fastembed
```

`app/services/reranker.py`:
```python
async def rerank(query: str, chunks: list[Chunk], top_k: int) -> list[Chunk]
    # listwise LLM (JSON mode). Ante cualquier fallo devuelve chunks[:top_k] con warning en log.
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
    # consultar_catalogo (_CATALOG_TOOL), parámetros: semantico, suplidor, marca,
    # precio_min, precio_max, ordenar (precio_asc|precio_desc),
    # agrupar_por (suplidor|marca|archivo), limite (default 8, máx 20),
    # por_grupo (default 3, máx 5). Cada llamada la resuelve _execute_catalog_query:
    #   - agrupar_por sin ordenar ni semantico → conteos reales por facets;
    #   - agrupar_por + ordenar → scan_by_price por grupo (scroll ordenado por price_usd);
    #   - ordenar solo → scan_by_price sobre el payload, exacto y sin LLM;
    #   - ordenar + semantico → _execute_price_search: pool híbrido (120) filtrado por
    #     suplidor en Qdrant o por marca como post-filtro, orden por price_usd del payload
    #     y filtro binario de relevancia (filter_relevant) que preserva el orden;
    #   - semantico solo → _execute_search: hybrid_search(top SEARCH_TOP_K) + fast-path
    #     de SKU + rerank(→ RERANK_TOP_K).
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
def register_document(file_name: str, sha256: str, pages: int, chunks: int, brand: str) -> None
def start_run() -> str | None; def finish_run(run_id, status, stats, error=None) -> None
# Si SUPABASE_URL está vacío → fallback en memoria (dicts módulo-level) con los mismos contratos.
```

## Frontend (requisitos)
- Chat con streaming SSE (fetch + ReadableStream, parsear eventos del contrato de arriba).
- Panel lateral de fuentes: badges `archivo · pág. X · marca`, snippet expandible, score.
- Indicador de hops del agente ("🔍 buscando: rociadores k-factor...") mientras piensa.
- Lista de sesiones (GET /api/sessions), crear nueva, continuar existente.
- Feedback 👍/👎 por mensaje → POST /api/feedback.
- Español, tema oscuro/claro según sistema, sin librerías UI pesadas (CSS propio está bien).
