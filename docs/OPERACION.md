# Operación del RAG de catálogos FIREtech

Guía práctica para quien opera el sistema: qué rotar, qué configurar, cómo ingerir,
cómo comprobar el índice, cómo medir y cómo desplegar. El contrato técnico vive en
[SPEC.md](../SPEC.md); el panorama general, en el [README](../README.md). Aquí solo hay
comandos y decisiones operativas.

Convenciones: los comandos se ejecutan desde `backend/` con el venv del proyecto
(`.venv\Scripts\python.exe`, Python 3.14 en local). En PowerShell conviene añadir `-X utf8`
para que la consola no rompa los acentos.

---

## 1. Credenciales a rotar

Durante el desarrollo se expusieron credenciales en terminales, capturas y conversaciones con
agentes. Ninguna aparece en los archivos versionados del repositorio, pero hay que asumir que
están comprometidas y rotarlas. Una línea por clase, sin valores:

| Credencial | Dónde se rota | Qué actualizar después |
|---|---|---|
| Clave de API de OpenAI | Dashboard de OpenAI, sección API keys: crear una nueva y revocar la anterior | `OPENAI_API_KEY` en `backend/.env` local y en las variables de entorno del proyecto en Vercel; redeploy |
| Token de acceso personal de Supabase (prefijo `sbp_`) | Dashboard de Supabase, cuenta, Access Tokens: revocar y generar otro | Solo lo usan herramientas locales (CLI, MCP); la aplicación no lo necesita. Actualizarlo donde se hubiera configurado |
| Service role key de Supabase | Dashboard de Supabase, ajustes del proyecto, API: rotar la clave de servicio | `SUPABASE_SERVICE_KEY` en `backend/.env` local y en Vercel; redeploy. La anon/publishable key del frontend es pública por diseño y no requiere rotación |
| Token de Vercel | Dashboard de Vercel, ajustes de cuenta, Tokens: revocar y crear otro | Solo lo usa la CLI local; la aplicación desplegada no lo consume |
| API key de Qdrant Cloud | Consola de Qdrant Cloud, el cluster, API keys: crear una nueva y borrar la anterior | `QDRANT_API_KEY` en Vercel (producción apunta al cluster) y en `backend/.env` si se ingiere a producción desde local; redeploy |

Orden recomendado: rotar primero, actualizar las variables después, redeploy al final y
comprobar `GET /api/health` en producción (debe responder `qdrant: true`). Si se rota la service
role key sin actualizar Vercel, el login sigue funcionando en el frontend pero toda la API
responde 401 o 500 hasta el redeploy.

Regla permanente: las credenciales no se pegan en chats ni en issues, y `backend/.env` nunca se
versiona (está en `.gitignore` y en `.vercelignore`).

## 2. Variables de entorno

Las lee `backend/app/config.py` (pydantic-settings) desde `backend/.env` en local y desde las
variables del proyecto en Vercel en producción. Las de `backend/.env.example` más las nuevas de
la Fase 0:

| Variable | Default en código | Dónde vive | Notas |
|---|---|---|---|
| `OPENAI_API_KEY` | vacío | local `.env` y Vercel | Obligatoria. Sin ella el chat responde con error controlado |
| `OPENAI_MODEL` | `gpt-5.4` | local `.env` y Vercel | Modelo del agente |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | local `.env` y Vercel | Cambiarlo obliga a reindexar |
| `EMBEDDING_DIMS` | `3072` | normalmente no se toca | Debe coincidir con el vector `dense` de la colección |
| `RERANK_MODEL` | `gpt-5.4-mini` | local `.env` y Vercel | Reranker y filtro de relevancia. Recomendación explícita: fijar `RERANK_MODEL=gpt-5.4-mini` en Vercel. Antes heredaba `OPENAI_MODEL` y un despliegue sin la variable rerankeaba con `gpt-5.4` (unas 5 veces más caro por token). Vacío = hereda `OPENAI_MODEL` |
| `OPENAI_TIMEOUT_S` | `120` | local `.env` y Vercel | Timeout por request del cliente OpenAI único |
| `OPENAI_MAX_RETRIES` | `2` | local `.env` y Vercel | Reintentos del SDK ante 429/5xx |
| `OPENAI_CONCURRENCY` | `3` | local `.env` y Vercel | Semáforo de llamadas concurrentes a OpenAI por proceso |
| `PROMPT_VERSION` | `v1` | local `.env` y Vercel | Etiqueta del prompt del agente; viaja en health, stats, telemetría y evals |
| `QDRANT_URL` | `http://localhost:6333` | local `.env` y Vercel | En Vercel apunta al cluster de Qdrant Cloud |
| `QDRANT_API_KEY` | vacío | Vercel (local vacío) | Clave del cluster |
| `QDRANT_COLLECTION` | `productos` | local `.env` y Vercel | |
| `SUPABASE_URL` | vacío | local `.env` y Vercel | Vacía en local = modo dev sin autenticación, persistencia en memoria |
| `SUPABASE_SERVICE_KEY` | vacío | local `.env` y Vercel | Solo en el backend, jamás en el frontend |
| `MAX_HOPS` | `4` | local `.env` y Vercel | Tope de llamadas a la herramienta por pregunta. Vercel tiene hoy 8, heredado del flujo de tres herramientas; con `consultar_catalogo` las agregaciones resuelven en 1 llamada. Revisar el valor en Vercel con los evals antes de bajarlo |
| `RERANK_TOP_K` | `8` | local `.env` y Vercel | Chunks que llegan al agente tras el rerank |
| `SEARCH_TOP_K` | `30` | local `.env` y Vercel | Candidatos que salen de Qdrant antes del rerank |
| `SKU_FASTPATH` | `true` | local `.env` | Match exacto de SKUs detectados en la consulta |
| `ENVIRONMENT` | `local` | local `.env` (`local`) y Vercel (`production`) | Separa el registro de `documents` por entorno; también lo exige `ingest.py` |
| `CORS_ORIGINS` | `http://localhost:5173` | local `.env` | En Vercel no hace falta: frontend y API comparten dominio |
| `VITE_SUPABASE_URL` | | `frontend/.env` y Vercel (build) | Frontend |
| `VITE_SUPABASE_ANON_KEY` | | `frontend/.env` y Vercel (build) | Pública por diseño |

Después de cambiar una variable en Vercel hace falta un redeploy: las funciones leen el entorno
al arrancar. `GET /api/health` y el bloque `config` de `GET /api/stats` muestran los valores
vigentes (`model`, `rerank_model`, `max_hops`, `prompt_version`, `retrieval`, `bm25_backend`,
`python`, `environment` en ambos; `/api/stats` añade `embedding_model`, `search_top_k`,
`rerank_top_k`, `openai_concurrency`, `upload_limit_mb` y `qdrant_version`), así que la forma
de confirmar un cambio es mirarlos ahí, no suponerlo.

## 3. Ingesta

Los catálogos (`data/raw_xlsx/*.xlsx`, con los PDF de `data/raw/` para las páginas de cita) no
están versionados. `ingest.py` corre desde `backend/`:

```powershell
# Solo parse + chunk + validaciones. No llama a OpenAI, Qdrant ni Supabase.
.venv\Scripts\python.exe -X utf8 ingest.py --dry-run

# Ingesta real al Qdrant local (QDRANT_URL de backend/.env).
.venv\Scripts\python.exe -X utf8 ingest.py --environment local

# Ingesta real a producción: QDRANT_URL y QDRANT_API_KEY deben apuntar al cluster
# de Qdrant Cloud (por .env o por variables de entorno de la sesión).
.venv\Scripts\python.exe -X utf8 ingest.py --environment production

# Un solo archivo, o forzar la fuente.
.venv\Scripts\python.exe -X utf8 ingest.py --environment local --only Catalogo_Croker__2.xlsx
.venv\Scripts\python.exe -X utf8 ingest.py --environment local --source pdf

# Reset: borra y recrea la colección antes de ingerir. Pide confirmación explícita.
.venv\Scripts\python.exe -X utf8 ingest.py --environment local --reset --yes
```

Guardas que hay que conocer:

- `--environment {local,production}` es obligatorio en toda ingesta real. En `--dry-run` no se
  pide, porque no toca ningún servicio.
- Antes de embeber, el preflight imprime el host de Qdrant, la colección, cuántos puntos tiene y
  cuántas filas hay en la tabla `documents` para ese entorno. Léelo: es el momento de abortar si
  el host no es el que esperabas.
- `--reset` exige `--yes`, y se niega si la colección contiene documentos subidos por usuarios
  (`chunk_type` `doc_text` o `doc_row`), porque el reset los borraría y no hay forma de
  regenerarlos desde `data/`. Solo se fuerza con `--include-uploads`, a sabiendas.
- Las validaciones corren siempre, también en `--dry-run`. Si un costo interno (`COSTO
  FIRETECH`, `Unit Cost`) aparece en un texto que se va a embeber, `find_cost_leaks` lo detecta y
  la ingesta aborta con exit code 1 antes de tocar OpenAI o Qdrant.

## 4. Verificar el índice

`backend/check_index.py` es de solo lectura (con una única excepción, `--apply-indexes`) y sirve
para responder "qué hay en la colección" sin abrir la consola de Qdrant:

```powershell
# Informe legible: totales por chunk_type, índices existentes frente a los esperados,
# cobertura por campo, facetas de producto, cardinalidades, min/max de price_usd,
# documentos subidos.
.venv\Scripts\python.exe -X utf8 check_index.py

# Lo mismo en JSON (para guardarlo junto a una medición).
.venv\Scripts\python.exe -X utf8 check_index.py --json

# Solo un archivo (el valor de `source_file` en el payload: los catálogos llevan el nombre del PDF).
.venv\Scripts\python.exe -X utf8 check_index.py --source-file Catalogo_Croker__2.pdf

# Falla (exit 1) si los totales no son los esperados: total,product,family,doc.
.venv\Scripts\python.exe -X utf8 check_index.py --expect 3573,3483,86,4

# Otra colección (por ejemplo, una de prueba).
.venv\Scripts\python.exe -X utf8 check_index.py --collection productos_test

# Única escritura: crea los índices de payload que falten. No toca puntos.
.venv\Scripts\python.exe -X utf8 check_index.py --apply-indexes
```

Exit codes: `0` todo en orden, `1` falló la aserción de facetas o el `--expect`, `2` no se pudo
hablar con Qdrant o la colección no existe. Los índices faltantes solo se informan (no cambian
el exit code); se crean con `--apply-indexes`.

La aserción de facetas es la que más vale: la suma de los conteos por `supplier` debe ser igual
al número de puntos con `chunk_type = product`. Si no cuadra, hay productos sin suplidor o
suplidores duplicados por variantes de escritura, y las agrupaciones del agente saldrán mal.

Instantánea local de referencia (1 de septiembre de 2026):

| Medida | Valor |
|---|---|
| Puntos totales | 3573 |
| `product` | 3483 |
| `family_summary` | 86 |
| `doc_text` | 4 |
| Índices de payload | 9: `brand`, `category`, `source_file`, `has_price`, `skus`, `supplier`, `chunk_type`, `price_usd` (float), `price_status` |

Producción se compara contra su propia instantánea (no tiene por qué tener los mismos
documentos subidos), pero `product` y `family_summary` deben coincidir con local si ambos se
ingirieron desde los mismos catálogos.

## 5. Evals y mediciones

Dos runners, ambos desde `backend/`:

- `evals\run_eval.py`: retrieval sobre el gold set de 60 preguntas (`hit@30`, `hit@8`, `MRR@8`).
- `evals\judge_answers.py`: respuesta final del agente juzgada por LLM (regresiones reales,
  muestra del gold set, y con `--agregacion` los casos de orden/conteo/agrupación).

```powershell
# Retrieval con el pipeline local (híbrido dense + BM25).
.venv\Scripts\python.exe -X utf8 evals\run_eval.py --retrieval hybrid

# Retrieval en el modo REAL de producción (dense-only forzado), tres repeticiones
# para ver la varianza.
.venv\Scripts\python.exe -X utf8 evals\run_eval.py --retrieval dense --repeat 3

# Respuestas, modo producción.
.venv\Scripts\python.exe -X utf8 evals\judge_answers.py --retrieval dense

# Agregación, y además actualizar docs/EVAL_AGREGACION.md.
.venv\Scripts\python.exe -X utf8 evals\judge_answers.py --agregacion --write-docs

# Guardar los resultados en otra carpeta.
.venv\Scripts\python.exe -X utf8 evals\run_eval.py --retrieval dense --results-dir C:\mediciones\run1
```

Dónde queda cada corrida: `backend/evals/results/<timestamp>-<label>/` con `results.json` (dato
crudo, incluye la telemetría por caso) y `report.md` (informe legible). La carpeta está en
`.gitignore`. Los informes públicos `docs/EVAL_*.md` solo se escriben con `--write-docs` y solo
si la corrida fue completa (una corrida abortada por cuota o por `--max-cost`, o un `--dry-run`,
ignora el flag con aviso); sin el flag ningún runner los sobrescribe, así que una corrida
exploratoria nunca pisa la referencia.

Exit codes de ambos runners:

| Código | Significado |
|---|---|
| `0` | Corrida completa y métricas dentro del umbral |
| `1` | Corrida completa pero alguna métrica quedó bajo el umbral |
| `2` | Error de infraestructura, cuota de OpenAI o corrida abortada por `--max-cost`. Al primer `insufficient_quota`/`billing` o error de autenticación el runner se detiene sin reintentar, para no producir una medición a medias; un 429 puntual (límite de RPM/TPM) no es cuota y se reintenta con backoff |
| `3` | El informe generado contiene el guion largo (regla del proyecto: no se publica) |

Regla de honestidad en los costes:

- **Medido** es lo que devuelve el `usage` del API: tokens de entrada, entrada cacheada, salida y
  razonamiento, por ronda y por componente (`agente`, `reranker`, `embeddings`, `juez`). Eso es
  lo que se compara entre corridas.
- **Estimado** es cualquier cifra en USD. Se calcula con `telemetry.ASSUMED_PRICES` (tarifas
  asumidas, no facturación real) y siempre va acompañada de la etiqueta
  `telemetry.PRICING_LABEL` ("estimado, tarifas asumidas"). Un USD sin esa etiqueta no se
  publica, ni en informes ni en el evento `metrics` del chat.
- Dos mediciones solo se comparan si tienen el mismo `prompt_version`, el mismo `retrieval`
  (`hybrid` o `dense-only`) y los mismos modelos; todo eso queda en `meta` de cada resultado.

## 6. Despliegue

Vercel construye el frontend y sirve el backend como una única función Python (`api/index.py`).
Lo que conviene saber al desplegar:

- `.python-version` en la raíz del repo dice `3.12`: Vercel lo lee para elegir el runtime de la
  función. El venv local sigue en 3.14; el código tiene que funcionar en ambos.
- `api/requirements.txt` es el de `backend/` sin `uvicorn` ni `fastembed`. Hoy usa rangos
  (`>=`); los pins exactos están pendientes de confirmar con un deploy de preview antes de
  fijarlos, para no romper producción con una versión que no se probó.
- `fastembed` queda fuera del bundle a propósito: arrastra `onnxruntime` (unos 200 MB) y no cabe
  en la función. Por eso producción es dense-only, y lo seguirá siendo hasta la Fase 4 del plan.
  `retrieval` en `/api/health` lo dice tal cual: `hybrid` solo si BM25 funciona, si no
  `dense-only`.
- Variables de entorno: las de la tabla de la sección 2. Tras cambiarlas, redeploy.
- Comprobación mínima después de cada deploy: `GET /api/health` responde `qdrant: true`,
  `retrieval: dense-only`, y el `python` y `prompt_version` que esperabas.

## 7. Tests

```powershell
pip install -r backend/requirements-dev.txt
cd backend
python -m pytest -q
```

Los tests no llaman a OpenAI ni a Qdrant: usan `set_async_client_for_tests` del cliente único y
`get_settings.cache_clear()` para aislar la configuración. Si un test necesita red, está mal
escrito.
