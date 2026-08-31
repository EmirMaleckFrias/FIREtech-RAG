# RAG de Productos — Protección Contra Incendios

Sistema RAG sobre 6 catálogos de productos (Notifier, Reliable, Croker, Aleum) con:

- **Búsqueda híbrida** (dense OpenAI `text-embedding-3-large` + sparse BM25) con fusión RRF en **Qdrant**
- **Reranking** listwise con LLM sobre los top-30 candidatos
- **Agente multi-hop** (tool calling, hasta 4 búsquedas por pregunta) con **GPT** (`OPENAI_MODEL`)
- **Fidelidad**: respuestas solo con contenido recuperado, citas `[archivo, pág. X]` obligatorias, rechazo explícito cuando la información no está en los catálogos
- **Frontend React** (Vite + TS) con streaming SSE, panel de fuentes, hops en vivo y feedback
- **Supabase** para sesiones, mensajes, registro de ingesta y feedback

## Arquitectura

```
PDFs (data/raw) ─► ingest.py ─► parse → chunk → embed (OpenAI) ─► Qdrant (dense + bm25)
                                                                      │
Usuario ─► React (5173) ─► FastAPI (8000) ─► Agente GPT multi-hop ────┤
                              │                  │ tool: buscar_productos
                              ▼                  ▼
                          Supabase        hybrid search (RRF) → rerank LLM → top 8
```

## Requisitos

- Python 3.12+ · Node 20+ · Docker (para Qdrant local)
- Claves: `OPENAI_API_KEY` (obligatoria), Supabase URL + service key (opcional: sin ellas la
  persistencia es en memoria)

## Puesta en marcha

```powershell
# 1. Qdrant
docker compose -f infra/docker-compose.yml up -d

# 2. Backend
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env    # rellenar OPENAI_API_KEY (y Supabase si se tiene)

# 3. Supabase (opcional): ejecutar supabase/migrations/001_schema.sql en el SQL Editor

# 4. Ingesta de los 6 catálogos
.venv\Scripts\python ingest.py            # --reset para reindexar desde cero
# Fuente auto-detectada: usa los .xlsx originales (data/raw_xlsx) si están,
# si no los PDFs (data/raw). Forzar con --source pdf|xlsx. --dry-run valida
# sin tocar OpenAI/Qdrant (conteos exactos + gate de costos confidenciales).

# 5. API
.venv\Scripts\uvicorn app.main:app --reload --port 8000

# 6. Frontend (otra terminal)
cd frontend
npm install
npm run dev                                # http://localhost:5173
```

## Decisiones de diseño

Ver [SPEC.md](SPEC.md) (contrato completo de API, colección Qdrant e interfaces) y
[docs/ANALISIS_CATALOGOS.md](docs/ANALISIS_CATALOGOS.md) (análisis de los 6 PDFs y
estrategia de chunking derivada).
