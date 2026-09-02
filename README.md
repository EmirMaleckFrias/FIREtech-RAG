# RAG de documentos

Asistente de consulta sobre un corpus de documentos propios. Responde en español, solo con
lo que recupera del índice, y **cita siempre de dónde sale cada afirmación**. Si algo no está
en los documentos, lo dice en vez de inventarlo.

El sistema no sabe nada del dominio de los documentos: lo que entra es una carpeta de
archivos (PDF, Word, Excel, CSV, texto) y lo que sale son respuestas con su cita.

El acceso requiere cuenta propia con correo `@airobotix.net`; el dominio lo impone un trigger
de Postgres sobre `auth.users`, así que un registro con otro dominio falla incluso llamando a
la API de Supabase directamente.

El contrato completo (endpoints, payload de Qdrant, interfaces internas) vive en
[SPEC.md](SPEC.md); la guía de operación (credenciales, variables, ingesta, despliegue) en
[docs/OPERACION.md](docs/OPERACION.md). Este README es solo para entender el sistema y
arrancarlo.

---

## 1. Qué hace, con sus asteriscos

- **Recuperación híbrida dense + BM25 con fusión RRF en Qdrant... en local.**
  En **producción es dense-only**. `fastembed` arrastra `onnxruntime` (unos 200 MB) y no cabe
  en el límite de 250 MB de la función de Vercel, así que se excluyó del bundle serverless
  (ver `api/requirements.txt`). Los vectores sparse existen en el índice, pero producción no
  los consulta. El modo vigente se expone como `retrieval` en `GET /api/health` y en el
  bloque `config` de `GET /api/stats`, para que la degradación sea visible y no folclore.
- **Reranking listwise con LLM**: top-30 de Qdrant, una sola llamada JSON, corte a top-8.
  Si el JSON falla, se conserva el orden de Qdrant.
- **Filtro de relevancia con tres estados**, que es lo que permite responder "no encuentro
  esto". Tras el rerank, una clasificación binaria decide qué fragmentos aportan evidencia de
  verdad, y distingue tres situaciones que el agente recibe por separado: hay evidencia,
  **ninguno de los fragmentos sirve** (y entonces se le dice que el índice no cubre el tema,
  no que falló la búsqueda), o la relevancia **no se pudo verificar** (y se avisa). Sin esa
  distinción, la herramienta devuelve siempre los ocho fragmentos más parecidos aunque hablen
  de otra cosa, y el modelo no tiene forma de saber si eso es "lo que hay" o "lo más parecido
  que hay".
- **Dos modos de pensamiento**, que es lo que elige el usuario antes de preguntar.
  **Pensamiento normal**: una o dos búsquedas y respuesta, para la pregunta directa.
  **Pensamiento extendido**: sin tope de búsquedas, más tiempo, más fragmentos por
  búsqueda y esfuerzo de razonamiento alto, para la pregunta que hay que descomponer y
  contrastar entre documentos. Lo que cambia entre los dos es **cuánto se busca y se
  delibera, nunca cuánta verdad se exige**: los dos parten del mismo prompt de fidelidad,
  citan igual y dicen igual cuando algo no está. Un modo rápido que además mienta no
  sirve de nada. El modo viaja en la telemetría, así que se puede comparar después qué
  cuesta y qué rinde cada uno.
- **Agente multi-hop sin tope arbitrario de búsquedas**, con **una sola herramienta,
  `buscar_documentos`**: consulta en lenguaje natural más filtros opcionales por proyecto,
  documento, tipo de archivo e idioma. `MAX_HOPS=0` deja que busque tantas veces como
  necesite; lo que lo detiene no es una cuenta sino dos señales honestas: que **deje de
  encontrar fragmentos nuevos** (buscar más de lo mismo no acerca a la respuesta) o que se
  **acabe el tiempo** de la petición. Ese segundo corte existe porque la función de Vercel
  muere a los 300 segundos: sin él la respuesta no se acorta, se pierde entera. Cuando se
  fuerza el final, el modelo recibe un aviso para que responda con lo que tiene y diga qué
  quedó sin cubrir.
- **Citas honestas por formato.** No todo documento tiene páginas: un `.docx` las calcula el
  visor al renderizar y un `.txt` no tiene ninguna. El localizador de cada cita es lo que de
  verdad existe en ese archivo: `pág. 12` en un PDF, `sección: Métodos` en un Word con
  encabezados, `fila 30` en una hoja de cálculo, `tabla 2` en una tabla de Word. La
  herramienta entrega la cita ya montada y el prompt prohíbe inventarse números de página.
- **Conciencia de artículo científico**, todo con heurísticas deterministas y sin coste de
  modelo. En un PDF se extraen el título, el apellido del primer autor, el año y el DOI, y la
  cita pasa a ser **"Allegri et al., 2021"** en vez del nombre del archivo, que es lo que
  identifica una fuente para quien investiga. Se detecta la **sección** de la que sale cada
  fragmento (Métodos, Resultados, Discusión...) y el prompt le dice al modelo que la use para
  pesar la evidencia: un dato en Resultados es del estudio, el mismo enunciado en Discusión es
  interpretación de sus autores. Se descartan la **bibliografía** (títulos ajenos que matchean
  con todo sin ser evidencia, y que se pagan al embeberse: 30% menos tokens en un artículo de
  prueba), las marcas de agua de descarga y las cabeceras y pies repetidos en cada página.
  Cuando algo no se puede extraer con confianza queda vacío y se cita el archivo: nunca se
  fabrica una referencia.
- **Autenticación multiusuario (Supabase Auth) con roles** `admin` y `vendedor`. Un admin puede
  promover, degradar, **bloquear** (revoca acceso sin borrar nada) o **eliminar** cuentas.
  Nadie puede cambiarse, bloquearse ni borrarse a sí mismo.
- **Conversaciones estrictamente privadas**: ningún usuario ve las de otro, **tampoco un admin**.
- **Documentos compartidos**: todos consultan el índice completo; solo un admin sube o borra
  (`.pdf .docx .xlsx .csv .txt .md`). La ingesta de lo subido corre sola y el documento
  aparece con estado `processing` / `ready` / `failed`.
- **Sección de Ajustes** (slide-over, bottom sheet en móvil) con pestañas: **Usuarios** (admin),
  **Sistema** (admin: estado del índice, actividad agregada y configuración vigente, solo lectura)
  y **Mi cuenta** (todos: identidad, cambio de contraseña, cerrar sesión).
- **Frontend React + Vite** con streaming SSE, panel de fuentes con badges de citado, hops del
  agente en vivo, feedback por mensaje y **PWA instalable**.
- **Telemetría por pregunta**: tokens medidos del `usage` real por componente (agente,
  reranker, embeddings) y coste **estimado** con tarifas asumidas, siempre etiquetado como
  tal. Sale como evento SSE `metrics`.

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
      |                      agente y reranker
      |
      +--> Supabase Postgres perfiles y roles, sesiones y mensajes,
      |                      registro de documentos, feedback
      |                      (service key: solo el backend habla con las tablas)
      |
      +--> Qdrant            prod: Qdrant Cloud   local: Docker :6333
                             colección "documentos": vector dense 3072
                             + vector sparse bm25 (consultado solo en local)

  Ingesta (dos caminos, el mismo parser en los dos):
  subida por la web  -> app/api/documents.py -> generic.py -> embed -> Qdrant
  carpeta por CLI    -> ingest.py -> pipeline.py -> generic.py -> embed -> Qdrant
```

## 3. Puesta en marcha local

### Requisitos

- Python 3.12+ (probado en 3.14; `fastembed` solo se instala en < 3.15, y sin él la búsqueda
  local también cae a dense-only)
- Node 20+
- Docker (para Qdrant local)
- Una `OPENAI_API_KEY` y un proyecto de Supabase

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
| `RERANK_MODEL` | Reranker y filtro de relevancia. Default `gpt-5.4-mini`; vacío = hereda `OPENAI_MODEL` (más caro). |
| `OPENAI_TIMEOUT_S` / `OPENAI_MAX_RETRIES` / `OPENAI_CONCURRENCY` | Cliente OpenAI único: 120 s, 2 reintentos, 3 llamadas concurrentes. |
| `PROMPT_VERSION` | Etiqueta del prompt del agente (`v1`); viaja en health, stats y telemetría. |
| `QDRANT_URL` / `QDRANT_API_KEY` | `http://localhost:6333` y clave vacía en local. |
| `QDRANT_COLLECTION` | `documentos`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | **Obligatorias para autenticación real.** Son las que sostienen el login, los roles y toda la persistencia. La service key vive solo en el backend. |
| `MAX_HOPS` | Techo de búsquedas del despliegue; `0` = manda el modo (normal 2, extendido sin tope). Solo puede apretar el perfil, nunca aflojarlo. |
| `AGENT_BUDGET_S` / `AGENT_MAX_HOPS_SIN_AVANCE` | Los otros dos techos: 240 s de reloj y 3 búsquedas sin nada nuevo. |
| `RERANK_TOP_K` / `SEARCH_TOP_K` | 12 y 60. |
| `ENVIRONMENT` | `local` o `production`. Los dos entornos comparten la tabla `documents` pero tienen **Qdrants distintos**, así que el registro se filtra y se escribe por entorno. `ingest.py` lo exige en toda ingesta real. |
| `CORS_ORIGINS` | `http://localhost:5173` en desarrollo. |

La tabla completa, con defaults y dónde vive cada variable (local o Vercel), está en
[docs/OPERACION.md](docs/OPERACION.md).

**Modo dev sin Supabase.** Si `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` quedan vacías, el backend
arranca igual: no hay autenticación real y todo corre con un usuario ficticio
`dev@local` con rol `admin`, con persistencia en memoria. Sirve para probar la API con `curl`.
**No sirve para usar la web**: el frontend siempre pide login contra Supabase antes de hacer
cualquier llamada.

### 4. Migraciones de Supabase (en orden, en el SQL Editor)

| Archivo | Qué hace |
|---|---|
| `001_schema.sql` | Tablas base: `chat_sessions`, `chat_messages`, `documents`, `ingestion_runs`, `message_feedback`. RLS habilitado y cerrado. |
| `002_document_status.sql` | `documents.status` (`processing`/`ready`/`failed`) y `documents.error`. |
| `003_document_environment.sql` | `documents.environment` para separar el registro de local y producción. |
| `004_auth_multiusuario.sql` | `profiles(id, email, role)`, trigger que rechaza correos fuera de `@airobotix.net` y crea el perfil, `chat_sessions.user_id`, `documents.uploaded_by`. |
| `005_bloqueo_cuentas.sql` | `profiles.blocked` (revocar acceso sin borrar). |
| `006_documentos_por_entorno.sql` | Unicidad por `(file_name, environment)`. |
| `007_revocar_acceso_directo.sql` | Revoca privilegios de `anon` y `authenticated` sobre `public`: a las tablas solo entra el backend con la service key. |

El primer usuario `emir.malek@airobotix.net` nace `admin`; el resto nace `vendedor`.

### 5. Ingesta de documentos

```powershell
.venv\Scripts\python ingest.py --dry-run ..\documentos              # parsea e informa del coste, sin gastar
.venv\Scripts\python ingest.py --environment local ..\documentos    # ingesta real al Qdrant local
.venv\Scripts\python ingest.py --environment local ..\documentos --proyecto tesis
.venv\Scripts\python ingest.py --environment local doc.pdf --max-usd 0.05
.venv\Scripts\python ingest.py --environment production ..\documentos   # QDRANT_URL/API_KEY al cluster
.venv\Scripts\python ingest.py --environment local ..\documentos --reset --yes
```

Acepta carpetas (recorridas hacia dentro) y archivos sueltos; lo que no sea un formato
soportado se ignora en silencio, igual que los ocultos y los temporales de Office.

**Empieza siempre por `--dry-run`**: parsea de verdad y dice cuántos fragmentos salen y
**cuánto costaría embeberlos**, sin llamar a OpenAI, Qdrant ni Supabase. `--max-usd` aborta
antes de gastar si el estimado supera el tope. `--environment` es obligatorio en toda ingesta
real; antes de embeber, el preflight imprime el host de Qdrant, la colección, sus puntos y los
documentos registrados del entorno. Un archivo cuyo sha256 no cambió se salta (`--force` lo
reingesta igual), y reingerir uno modificado borra sus fragmentos viejos antes de insertar,
así que nunca quedan huérfanos de la versión anterior. `--reset` exige `--yes` y borra la
colección entera, incluidos los documentos subidos por la web que no estén en la carpeta.

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

### 7. Tests

```powershell
pip install -r backend/requirements-dev.txt
cd backend
python -m pytest -q
```

Los tests no llaman a OpenAI, ni a Qdrant, ni a la red: usan clientes falsos y archivos
temporales. Cubren el contrato de honestidad del buscador, el parseo de cada formato, los
localizadores de cita, la lista blanca del payload, el bucle del agente, la telemetría y la
ingesta por carpetas (incluido que el dry-run no pueda tocar servicios externos).

## 4. Despliegue

**Vercel.** Todo el despliegue vive en `vercel.json`:

- El frontend se construye con `cd frontend && npm run build` y se sirve desde `frontend/dist`.
- El backend es una única función Python: `api/index.py` añade `backend/` al `sys.path` y expone
  la app ASGI de FastAPI, streaming SSE incluido (`maxDuration` 300 s, 1024 MB).
- Rewrites: `/api/*` a la función y todo lo demás a `index.html` (SPA).
- `api/requirements.txt` es el de backend **sin `uvicorn`** (el runtime sirve la app ASGI) y
  **sin `fastembed`** (no cabe en la función; de ahí el dense-only). Los pins exactos están
  pendientes de confirmar con un deploy de preview.
- `.python-version` en la raíz fija el runtime de la función en **3.12**; el venv local sigue
  en 3.14.
- `.vercelignore` mantiene el bundle pequeño y evita que datos o secretos suban.

Variables de entorno en Vercel: `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_MODEL`,
`RERANK_MODEL` (recomendado `gpt-5.4-mini`), `OPENAI_TIMEOUT_S`, `OPENAI_MAX_RETRIES`,
`OPENAI_CONCURRENCY`, `PROMPT_VERSION`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MAX_HOPS`, `ENVIRONMENT=production`, y para el build
del frontend `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. Tras cambiar una, redeploy; el
valor vigente se comprueba en `GET /api/health`.

**Qdrant Cloud** guarda el índice de producción. Se puebla ejecutando `ingest.py` desde una
máquina local con `QDRANT_URL` y `QDRANT_API_KEY` apuntando al cluster: en la función
serverless no hay archivos ni forma de ingerirlos a gran escala.

**Supabase**: las 7 migraciones aplicadas en orden. En serverless, la ingesta de un documento
subido corre **inline** antes de responder (los `BackgroundTasks` de Vercel mueren al enviar la
respuesta) y el archivo se guarda en `/tmp`, que es efímero: la verdad persistente es el índice
de Qdrant más el registro en Supabase.

## 5. Decisiones y limitaciones conocidas

- **Producción es dense-only.** Es la limitación grande y es permanente mientras el backend viva
  en una función de Vercel. Local sí usa híbrida con RRF, así que cualquier métrica de
  recuperación medida en local no describe producción.
- **Subida de documentos: 4 MB en producción, 25 MB en local.** Vercel corta cualquier body
  mayor a 4.5 MB con un 413 antes de invocar la función. El límite vigente se expone en
  `GET /api/health` (`upload_limit_mb`) y el frontend anuncia el valor real.
- **PDF escaneado: no hay OCR.** Un PDF de imágenes no tiene texto extraíble y la ingesta lo
  rechaza con un error que lo dice. Convertirlo antes o añadir OCR es trabajo pendiente.
- **Las tablas de un PDF salen como texto corrido.** `extract_text` de pdfplumber no conserva
  la estructura de filas y columnas, así que una tabla de resultados se indexa como el texto
  que sea que salga de ella. En un Word sí se conserva la tabla.
- **`.doc` (Word 97-2003) no se lee**, solo `.docx`. El error explica cómo convertirlo.
- **Las tablas de Word van al final del documento.** `python-docx` no da la posición de una
  tabla respecto de los párrafos sin bajar al XML, así que se indexan aparte, numeradas. El
  texto de la tabla se conserva entero; lo que se pierde es en qué punto del documento estaba.
- **El idioma no se detecta todavía**: el campo `language` existe en el payload y se puede
  filtrar, pero la ingesta lo deja vacío.
- **No hay evaluación automática.** El gold set y los runners del proyecto anterior se
  eliminaron con el cambio de dominio; medir la fidelidad de las respuestas de este corpus
  exige preguntas reales suyas, y está pendiente.
- **Todo el texto de los documentos viaja a OpenAI** (embeddings en la ingesta, fragmentos
  recuperados en cada pregunta). Si el corpus tiene información sensible, esa es la decisión
  que hay que tomar con los ojos abiertos.
- **Las conversaciones históricas sin dueño** (anteriores a la autenticación) quedan archivadas
  en la base y no las ve nadie por la API, ni un admin.
