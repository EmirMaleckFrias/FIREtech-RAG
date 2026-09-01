# RAG de catálogos FIREtech (protección contra incendios)

Asistente de consulta sobre los 6 catálogos de producto de FIREtech (Notifier by Honeywell,
Reliable/RASCO x3, Croker + AGF, ALEUM CO.): unas **3,483 filas de producto** indexadas en
**3,569 chunks** (incluye ~86 resúmenes de familia). Responde en español, solo con lo que
recupera del índice, y **cita siempre `[archivo, pág. X]`**. Si algo no está en los catálogos,
lo dice en vez de inventarlo.

**Producción:** https://firetech-rag.vercel.app
El acceso requiere cuenta propia con correo `@airobotix.net`; el dominio lo impone un trigger
de Postgres sobre `auth.users`, así que un registro con otro dominio falla incluso llamando a
la API de Supabase directamente.

El contrato completo (endpoints, payload de Qdrant, reglas de negocio) vive en
[SPEC.md](SPEC.md). Este README es solo para entender el sistema y arrancarlo.

---

## 1. Qué hace, con sus asteriscos

- **Recuperación híbrida dense + BM25 con fusión RRF en Qdrant... en local.**
  En **producción es dense-only**. `fastembed` arrastra `onnxruntime` (~200 MB) y no cabe en el
  límite de 250 MB de la función de Vercel, así que se excluyó del bundle serverless
  (ver `api/requirements.txt`). Los vectores sparse existen en el índice, pero producción no
  los consulta. El modo vigente se expone como `retrieval` en `GET /api/health` y en el bloque
  `config` de `GET /api/stats`, para que la degradación sea visible y no folclore.
- **Reranking listwise con LLM**: top-30 de Qdrant, una sola llamada JSON, corte a top-8.
  Si el JSON falla, se conserva el orden de Qdrant.
- **Agente multi-hop** (tool calling, hasta `MAX_HOPS` búsquedas por pregunta) con 3 herramientas:
  - `buscar_productos`: híbrida (o dense-only) + rerank.
  - `buscar_por_precio`: ordena por el **precio real del payload**, no por lo que parece decir el
    texto. Existe porque un superlativo de precio respondido "a ojo" cotizaba 13,615 USD cuando
    el catálogo tenía el mismo tipo de detector a 3,088.89 USD.
  - `inventario_del_indice`: totales, archivos, suplidores y marcas calculados **en vivo** con
    facets/counts de Qdrant, sin nada hardcodeado.
- **Autenticación multiusuario (Supabase Auth) con roles** `admin` y `vendedor`. Un admin puede
  promover, degradar, **bloquear** (revoca acceso sin borrar nada) o **eliminar** cuentas.
  Nadie puede cambiarse, bloquearse ni borrarse a sí mismo.
- **Conversaciones estrictamente privadas**: ningún usuario ve las de otro, **tampoco un admin**.
- **Documentos compartidos**: todos consultan el índice completo; solo un admin sube o borra
  (`.pdf .xlsx .csv .txt .md`). La ingesta de lo subido corre sola y el documento aparece con
  estado `processing` / `ready` / `failed`.
- **Sección de Ajustes** (slide-over, bottom sheet en móvil) con pestañas: **Usuarios** (admin),
  **Sistema** (admin: estado del índice, actividad agregada y configuración vigente, solo lectura)
  y **Mi cuenta** (todos: identidad, cambio de contraseña, cerrar sesión).
- **Frontend React + Vite** con streaming SSE, panel de fuentes con badges de citado, hops del
  agente en vivo, feedback por mensaje y **PWA instalable**.
- **Confidencialidad**: `COSTO FIRETECH` (Notifier) y `Unit Cost` (Croker) son margen del
  distribuidor. Nunca entran al texto embebido ni a las respuestas, para ningún rol.

## 2. Arquitectura

```
  Navegador  (React + Vite, PWA)
      |  login  -> Supabase Auth  ->  access_token (JWT)
      |  fetch /api/*  con  Authorization: Bearer <token>
      v
  FastAPI          prod: función serverless en Vercel (api/index.py)
                   local: uvicorn app.main:app --port 8000
      |
      +--> OpenAI            embeddings (text-embedding-3-large, 3072d),
      |                      agente, reranker y juez de evals
      |
      +--> Supabase Postgres perfiles y roles, sesiones y mensajes,
      |                      registro de documentos, feedback
      |                      (service key: solo el backend habla con las tablas)
      |
      +--> Qdrant            prod: Qdrant Cloud   local: Docker :6333
                             colección "productos": vector dense 3072
                             + vector sparse bm25 (consultado solo en local)

  Ingesta (offline, desde una máquina local):
  data/raw_xlsx/*.xlsx  (o data/raw/*.pdf)
      -> ingest.py -> parse -> chunk -> embed (OpenAI) -> upsert a Qdrant
```

## 3. Puesta en marcha local

### Requisitos

- Python 3.12+ (probado en 3.14; `fastembed` solo se instala en < 3.15, y sin él la búsqueda
  local también cae a dense-only)
- Node 20+
- Docker (para Qdrant local)
- Una `OPENAI_API_KEY` y un proyecto de Supabase

> **Aviso sobre los datos.** Los catálogos (`data/`) contienen costos internos confidenciales y
> **no están versionados**. Sin ellos **la ingesta no corre**, pero **la aplicación sí**: basta
> apuntar `QDRANT_URL` a un índice ya poblado (por ejemplo el de Qdrant Cloud) y saltarse el
> paso 5.

### 1. Qdrant

```powershell
docker compose -f infra/docker-compose.yml up -d      # expone 6333 y 6334
```

### 2. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

### 3. Rellenar `backend/.env`

| Variable | Para qué |
|---|---|
| `OPENAI_API_KEY` | **Obligatoria.** Embeddings, agente, reranker. |
| `OPENAI_MODEL` | Modelo del agente (default `gpt-5.4`). |
| `EMBEDDING_MODEL` | `text-embedding-3-large` (3072 dims). Cambiarlo obliga a reindexar. |
| `RERANK_MODEL` | Vacío = usa `OPENAI_MODEL`. |
| `QDRANT_URL` / `QDRANT_API_KEY` | `http://localhost:6333` y clave vacía en local. |
| `QDRANT_COLLECTION` | `productos`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | **Obligatorias para autenticación real.** Son las que sostienen el login, los roles y toda la persistencia. La service key vive solo en el backend. |
| `MAX_HOPS` | Tope de búsquedas por pregunta. El código trae 4; el entorno actual usa **8** (el agente necesita inventario + una búsqueda de precio por marca). |
| `RERANK_TOP_K` / `SEARCH_TOP_K` | 8 y 30. |
| `CORS_ORIGINS` | `http://localhost:5173` en desarrollo. |

Dos variables que `config.py` lee pero **no** están en `.env.example`:

- `ENVIRONMENT` (`local` por defecto, `production` en Vercel): producción y local comparten la
  tabla `documents` pero tienen **Qdrants distintos**, así que el registro se filtra y se escribe
  por entorno.
- `SKU_FASTPATH` (`true`): match exacto de SKUs detectados en la consulta.

**Modo dev sin Supabase.** Si `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` quedan vacías, el backend
arranca igual: no hay autenticación real y todo corre con un usuario ficticio
`dev@local` con rol `admin`, con persistencia en memoria. Sirve para probar la API con `curl`
o correr los evals sin credenciales. **No sirve para usar la web**: el frontend siempre pide
login contra Supabase antes de hacer cualquier llamada.

### 4. Migraciones de Supabase (en orden, en el SQL Editor)

| Archivo | Qué hace |
|---|---|
| `001_schema.sql` | Tablas base: `chat_sessions`, `chat_messages`, `documents`, `ingestion_runs`, `message_feedback`. RLS habilitado y cerrado. |
| `002_document_status.sql` | `documents.status` (`processing`/`ready`/`failed`) y `documents.error`. |
| `003_document_environment.sql` | `documents.environment` para separar el registro de local y producción. |
| `004_auth_multiusuario.sql` | `profiles(id, email, role)`, trigger que rechaza correos fuera de `@airobotix.net` y crea el perfil, `chat_sessions.user_id`, `documents.uploaded_by`. |
| `005_bloqueo_cuentas.sql` | `profiles.blocked` (revocar acceso sin borrar). |
| `006_documentos_por_entorno.sql` | Unicidad por `(file_name, environment)` y alta de los 6 catálogos base del entorno `production`. |
| `007_revocar_acceso_directo.sql` | Revoca privilegios de `anon` y `authenticated` sobre `public`: a las tablas solo entra el backend con la service key. |

El primer usuario `emir.malek@airobotix.net` nace `admin`; el resto nace `vendedor`.

### 5. Ingesta de los catálogos

```powershell
.venv\Scripts\python ingest.py                 # fuente auto-detectada
.venv\Scripts\python ingest.py --dry-run       # parse + chunk + validaciones, sin OpenAI/Qdrant
.venv\Scripts\python ingest.py --reset         # borra y recrea la colección
.venv\Scripts\python ingest.py --only Catalogo_Croker__2.xlsx
.venv\Scripts\python ingest.py --source xlsx   # o pdf, para forzar la fuente
```

La fuente por defecto es `xlsx` si `data/raw_xlsx` está completa, y `pdf` si no. Las páginas de
las citas salen siempre del PDF, cruzadas fila a fila. `--dry-run` incluye el gate que verifica
que ningún costo interno se haya colado en el texto embebido.

### 6. API y frontend

```powershell
# terminal 1 (desde backend/)
.venv\Scripts\uvicorn app.main:app --reload --port 8000

# terminal 2
cd frontend
copy .env.example .env      # VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
npm install
npm run dev                 # http://localhost:5173, con proxy /api -> :8000
```

La anon key del frontend es pública por diseño: quien protege los datos es el backend, que
valida el token, más las policies de Supabase. La service key **nunca** sale del backend.

## 4. Calidad: qué se midió y qué salió

- **Retrieval** ([docs/EVAL_RETRIEVAL.md](docs/EVAL_RETRIEVAL.md)): gold set congelado de 60
  preguntas (SKU directo, parafraseo natural y rango de familia). `hit@30` = 100%,
  `hit@8` = 96.7%, `MRR@8` = 0.942; los 2 fallos de `hit@8` son artefactos del generador del
  gold set, no del sistema. Se corre con `evals\run_eval.py` desde `backend/`.
- **Respuestas** ([docs/EVAL_RESPUESTAS.md](docs/EVAL_RESPUESTAS.md)): juez LLM sobre 25 casos
  (7 regresiones de fallos reales de producción + 18 muestreados) con 5 criterios pass/fail:
  exactitud factual, citas, advertencias de precio, honestidad y completitud. PASS global 84%
  en esa corrida, ~0.39 USD. Los 2 fallos que el informe deja abiertos se cerraron después
  (camino de precios determinista, commit `4db0807`). Se corre con `evals\judge_answers.py`.
- **Fidelidad de la fuente** ([docs/DIFF_XLSX_VS_PDF.md](docs/DIFF_XLSX_VS_PDF.md)): los 6 PDFs
  son renders de Excel; se compararon **39,716 celdas** campo a campo entre ambas rutas con
  **100.000% de coincidencia** y chunks idénticos. El parser de PDF resultó ser una conversión
  sin pérdida.
- **Bugs**: cacería adversarial previa al primer commit con **16 bugs confirmados y corregidos**,
  más la auditoría de conversaciones reales de producción
  ([docs/audit_conversaciones_jefes.md](docs/audit_conversaciones_jefes.md)), de donde salieron
  las herramientas de precio y de inventario.

Contexto de los catálogos y la estrategia de chunking:
[docs/ANALISIS_CATALOGOS.md](docs/ANALISIS_CATALOGOS.md).

## 5. Despliegue

**Vercel** (proyecto `rag-productos`). Todo el despliegue vive en `vercel.json`:

- El frontend se construye con `cd frontend && npm run build` y se sirve desde `frontend/dist`.
- El backend es una única función Python: `api/index.py` añade `backend/` al `sys.path` y expone
  la app ASGI de FastAPI, streaming SSE incluido (`maxDuration` 300 s, 1024 MB).
- Rewrites: `/api/*` a la función y todo lo demás a `index.html` (SPA).
- `api/requirements.txt` es el de backend **sin `uvicorn`** (el runtime sirve la app ASGI) y
  **sin `fastembed`** (no cabe en la función; de ahí el dense-only).
- `.vercelignore` mantiene el bundle pequeño y evita que datos o secretos suban.

Variables de entorno en Vercel: `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_MODEL`,
`RERANK_MODEL`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `MAX_HOPS`, `ENVIRONMENT=production`, y para el build del frontend
`VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.

**Qdrant Cloud** guarda el índice de producción. Se puebla ejecutando `ingest.py` desde una
máquina local con `QDRANT_URL` y `QDRANT_API_KEY` apuntando al cluster; en la función serverless
no hay catálogos ni forma de ingerirlos a gran escala.

**Supabase**: las 7 migraciones aplicadas en orden. En serverless, la ingesta de un documento
subido corre **inline** antes de responder (los `BackgroundTasks` de Vercel mueren al enviar la
respuesta) y el archivo se guarda en `/tmp`, que es efímero: la verdad persistente es el índice
de Qdrant más el registro en Supabase.

## 6. Decisiones y limitaciones conocidas

- **Producción es dense-only.** Es la limitación grande y es permanente mientras el backend viva
  en una función de Vercel. Local sí usa híbrida con RRF, de modo que **las métricas de
  `docs/EVAL_RETRIEVAL.md` se midieron con el pipeline local**, no con el de producción.
- **Subida de documentos: 4 MB en producción, 25 MB en local.** Vercel corta cualquier body
  mayor a 4.5 MB con un 413 antes de invocar la función. El límite vigente se expone en
  `GET /api/health` (`upload_limit_mb`) y el frontend anuncia el valor real.
- **Vigencias de precio heterogéneas**: Croker **2023-07-15** (tres años), Aleum 2025-04-28,
  Reliable 2026-03-12, Notifier 2026-07. El agente cita la vigencia y advierte que el precio
  puede estar desactualizado, pero no puede arreglar la fuente.
- **La moneda es USD presunta**: ningún archivo declara la divisa.
- **Precio neto y precio de lista no son comparables** sin etiquetar: Aleum y Reliable dan
  net/net, Croker y Notifier dan lista. Las respuestas indican cuál es cuál.
- **Costos internos nunca se exponen**, a ningún rol. Viven en el payload marcados como internos
  y hay un test de ingesta que lo garantiza.
- **Datos sucios del origen** manejados con flags, no ocultados: SKUs duplicados contradictorios
  en Aleum, 102 part numbers repetidos en Notifier (fusionados a la fila más completa), typos y
  unidades mal escritas, marcas mal etiquetadas (hay VESDA marcados como Fire-Lite, razón por la
  que el filtro de marca es post-filtro tolerante y no filtro duro de payload).
- **Las conversaciones históricas sin dueño** (anteriores a la autenticación) quedan archivadas
  en la base y no las ve nadie por la API, ni un admin.
- **Los 6 catálogos base no se pueden borrar** desde la gestión de documentos (403).
