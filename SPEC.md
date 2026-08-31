# SPEC — RAG de Productos (Protección Contra Incendios)

Contrato de arquitectura. Cualquier código del proyecto debe respetar estas interfaces.

## Stack
- **Vector DB**: Qdrant (local vía Docker Compose, o Qdrant Cloud vía env)
- **Embeddings**: OpenAI `text-embedding-3-large` (3072 dims)
- **LLM agente**: OpenAI, modelo configurable vía `OPENAI_MODEL` (default `gpt-5.4`)
- **Backend**: Python 3.14 + FastAPI (puerto 8000)
- **Frontend**: React + Vite + TypeScript (puerto 5173)
- **DB relacional**: Supabase (sesiones de chat, mensajes, registro de ingesta, feedback)

## Estructura del repo
```
Rag - Productos/
├── data/raw/                  # los 6 PDFs fuente
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   ├── ingest.py              # CLI: python ingest.py [--reset]
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
├── supabase/migrations/001_schema.sql
├── infra/docker-compose.yml   # Qdrant local
└── README.md
```

## Colección Qdrant
- Nombre: `productos` (env `QDRANT_COLLECTION`)
- Vectores nombrados:
  - `dense`: 3072 dims, coseno (OpenAI text-embedding-3-large)
  - `bm25`: sparse vector (BM25 vía fastembed) — si fastembed no está disponible, la búsqueda cae a dense-only sin romper
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
    "chunk_type": "product_row | family_section | page"
  }
  ```
- Índices de payload: `brand`, `category`, `source_file`, `has_price` (keyword/bool).

## API Backend (contrato para el frontend)
Base: `http://localhost:8000`

### `GET /api/health`
→ `{ "status": "ok", "qdrant": true, "collection_points": 1234 }`

### `POST /api/search`
Body: `{ "query": str, "top_k": int = 8, "brand": str|null, "category": str|null }`
→ `{ "results": [{ "text", "score", "source_file", "page", "brand", "category", "skus" }] }`

### `POST /api/chat`  (SSE stream)
Body: `{ "session_id": str|null, "message": str }`
Respuesta: `text/event-stream`, eventos:
- `event: session` → `data: {"session_id": "uuid"}` (primero, siempre)
- `event: hop` → `data: {"n": 1, "query": "consulta reformulada del agente"}` (cada búsqueda del agente)
- `event: sources` → `data: {"sources": [{"source_file", "page", "brand", "snippet", "score"}]}` (antes de los tokens; puede re-emitirse durante el stream — el frontend usa el ÚLTIMO evento recibido)
- `event: token` → `data: {"text": "..."}` (delta de texto de la respuesta)
- `event: done` → `data: {"message_id": "uuid"}`
- `event: error` → `data: {"detail": "..."}`

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
- Loop de tool calling con OpenAI. Tool única:
  `buscar_productos(query: str, marca: str|None, categoria: str|None)` →
  hybrid search Qdrant (top 30) → reranker LLM → top 8 chunks con `[archivo p.X]`.
- Máximo `MAX_HOPS=4` llamadas de tool por pregunta; el agente decide cuándo tiene suficiente.
- **Fidelidad**: system prompt exige responder SOLO con lo recuperado, citar `[archivo, pág. X]`
  en cada afirmación factual, y decir explícitamente cuando algo no está en los catálogos.
  Precios siempre con moneda y con la advertencia de que provienen del catálogo (pueden estar desactualizados).
- Respuesta final en streaming.

## Reranker
- Listwise LLM: un solo request con query + candidatos numerados → JSON `{"ranking": [idx...], "scores": {...}}`.
- Modelo: `RERANK_MODEL` (default = `OPENAI_MODEL`). Corta a `RERANK_TOP_K=8`.
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
RERANK_MODEL=            # vacío = usa OPENAI_MODEL
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=          # vacío para local
QDRANT_COLLECTION=productos
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
MAX_HOPS=4
RERANK_TOP_K=8
SEARCH_TOP_K=30
CORS_ORIGINS=http://localhost:5173
```
Si `SUPABASE_URL` está vacío, el backend funciona igual (persistencia en memoria, con warning) —
para poder probar el RAG sin esperar credenciales.

## Interfaces internas del backend (firmas exactas — los módulos se implementan en paralelo)

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
    #   hop: {"n": int, "query": str} | sources: {"sources": [SourceRef.model_dump()]}
    #   token: {"text": str} | final: {"content": str, "sources": [...], "hops": [...]}
    # Internamente: loop de tool-calling (máx MAX_HOPS), tool buscar_productos →
    # hybrid_search(top SEARCH_TOP_K) → rerank(→ RERANK_TOP_K); respuesta final en streaming.
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
