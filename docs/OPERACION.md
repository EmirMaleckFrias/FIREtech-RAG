# Operación del RAG de documentos

Guía práctica para quien opera el sistema: qué rotar, qué configurar, cómo ingerir y cómo
desplegar. El contrato técnico vive en [SPEC.md](../SPEC.md); el panorama general, en el
[README](../README.md). Aquí solo hay comandos y decisiones operativas.

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
variables del proyecto en Vercel en producción.

| Variable | Default en código | Dónde vive | Notas |
|---|---|---|---|
| `OPENAI_API_KEY` | vacío | local `.env` y Vercel | Obligatoria. Sin ella el chat responde con error controlado |
| `OPENAI_MODEL` | `gpt-5.4` | local `.env` y Vercel | Modelo del agente |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | local `.env` y Vercel | Cambiarlo obliga a reindexar |
| `EMBEDDING_DIMS` | `3072` | normalmente no se toca | Debe coincidir con el vector `dense` de la colección |
| `RERANK_MODEL` | `gpt-5.4-mini` | local `.env` y Vercel | Reranker y filtro de relevancia. Recomendación explícita: fijar `RERANK_MODEL=gpt-5.4-mini` en Vercel. Vacío = hereda `OPENAI_MODEL`, unas 5 veces más caro por token |
| `OPENAI_TIMEOUT_S` | `120` | local `.env` y Vercel | Timeout por request del cliente OpenAI único |
| `OPENAI_MAX_RETRIES` | `2` | local `.env` y Vercel | Reintentos del SDK ante 429 o 5xx |
| `OPENAI_CONCURRENCY` | `3` | local `.env` y Vercel | Semáforo de llamadas concurrentes a OpenAI por proceso |
| `PROMPT_VERSION` | `v3` | local `.env` y Vercel | Etiqueta del prompt del agente; viaja en health, stats y telemetría |
| `QDRANT_URL` | `http://localhost:6333` | local `.env` y Vercel | En Vercel apunta al cluster de Qdrant Cloud |
| `QDRANT_API_KEY` | vacío | Vercel (local vacío) | Clave del cluster |
| `QDRANT_COLLECTION` | `documentos` | local `.env` y Vercel | La colección `productos` del proyecto anterior sigue en su Qdrant y este backend ya no la mira |
| `SUPABASE_URL` | vacío | local `.env` y Vercel | Vacía en local = modo dev sin autenticación, persistencia en memoria |
| `SUPABASE_SERVICE_KEY` | vacío | local `.env` y Vercel | Solo en el backend, jamás en el frontend |
| `MAX_HOPS` | `0` | local `.env` y Vercel | Techo de búsquedas del despliegue. **0 = manda el perfil del modo** (normal 2, extendido sin tope). Estas tres variables son el techo de quien opera: solo pueden APRETAR el modo, nunca aflojarlo, para que un valor alto no convierta el modo normal en extendido sin que nadie lo pida |
| `AGENT_BUDGET_S` | `240` | local `.env` y Vercel | Segundos de reloj antes de forzar la respuesta final. No es un capricho: la función de Vercel muere a los 300 s y sin este corte la respuesta no se acorta, se pierde entera. 0 = sin límite, solo sensato fuera de serverless |
| `AGENT_MAX_HOPS_SIN_AVANCE` | `3` | local `.env` y Vercel | Búsquedas seguidas sin traer ni un fragmento nuevo antes de responder con lo que hay. Buscar más de lo mismo no acerca a la respuesta. 0 = desactivado |
| `RERANK_TOP_K` | `12` | local `.env` y Vercel | Fragmentos que llegan al agente tras el rerank |
| `SEARCH_TOP_K` | `60` | local `.env` y Vercel | Candidatos que salen de Qdrant antes del rerank |
| `ENVIRONMENT` | `local` | local `.env` (`local`) y Vercel (`production`) | Separa el registro de `documents` por entorno; también lo exige `ingest.py` |
| `CORS_ORIGINS` | `http://localhost:5173` | local `.env` | En Vercel no hace falta: frontend y API comparten dominio |
| `VITE_SUPABASE_URL` | | `frontend/.env` y Vercel (build) | Frontend |
| `VITE_SUPABASE_ANON_KEY` | | `frontend/.env` y Vercel (build) | Pública por diseño |

Después de cambiar una variable en Vercel hace falta un redeploy: las funciones leen el entorno
al arrancar. `GET /api/health` y el bloque `config` de `GET /api/stats` muestran los valores
vigentes, así que la forma de confirmar un cambio es mirarlos ahí, no suponerlo.

## 3. Ingesta

El mismo parser (`app/ingest/generic.py`) alimenta los dos caminos: la subida por la web y el
CLI. Formatos: `.pdf .docx .xlsx .csv .txt .md`.

```powershell
# Descubre, parsea e informa del coste. No llama a OpenAI, Qdrant ni Supabase.
.venv\Scripts\python -X utf8 ingest.py --dry-run ..\documentos

# Ingesta real al Qdrant local (QDRANT_URL de backend/.env).
.venv\Scripts\python -X utf8 ingest.py --environment local ..\documentos

# Etiquetando el conjunto, para poder acotar las búsquedas después.
.venv\Scripts\python -X utf8 ingest.py --environment local ..\documentos --proyecto tesis

# Con tope de gasto: aborta con exit 2 si el estimado lo supera, sin embeber nada.
.venv\Scripts\python -X utf8 ingest.py --environment local ..\documentos --max-usd 0.05

# Ingesta real a producción: QDRANT_URL y QDRANT_API_KEY deben apuntar al cluster
# de Qdrant Cloud (por .env o por variables de entorno de la sesión).
.venv\Scripts\python -X utf8 ingest.py --environment production ..\documentos

# Reset: borra y recrea la colección antes de ingerir. Pide confirmación explícita.
.venv\Scripts\python -X utf8 ingest.py --environment local ..\documentos --reset --yes
```

Lo que hay que tener claro:

- **Siempre `--dry-run` primero.** Es lo único que dice cuánto va a costar antes de costarlo,
  y no puede gastar: los imports de servicios están diferidos. La cifra es un estimado con
  tarifa asumida, y así se etiqueta.
- **`--environment` es obligatorio** en toda ingesta real. Etiqueta las filas de `documents`
  (local y producción comparten la tabla y tienen Qdrants distintos). No elige el Qdrant: ese
  sale de `QDRANT_URL`, y el preflight imprime el host para que lo confirmes.
- **El preflight no escribe nada**: imprime entorno, host de Qdrant sin credenciales, versión
  del servidor, colección y sus puntos, y cuántos documentos hay registrados. Si Qdrant no
  responde, aborta antes de embeber.
- **Idempotencia por sha256**: un archivo que no cambió se salta. `--force` lo reingesta igual.
  Reingerir uno modificado borra sus fragmentos viejos antes de insertar los nuevos, así que
  no quedan huérfanos de la versión anterior.
- **`--reset` borra la colección entera**, incluidos los documentos que se subieron por la web
  y no estén en la carpeta de esta ingesta. Exige `--yes`.
- Exit codes: 0 correcto, 1 fallo, 2 abortado por una guarda (nada se tocó).
- Un archivo que no se puede parsear (PDF de imágenes sin OCR, `.doc` antiguo, archivo
  corrupto) no tumba la corrida: se informa y se sigue con los demás.

## 4. Despliegue

Vercel construye el frontend y sirve el backend como una única función Python (`api/index.py`).
Lo que conviene saber al desplegar:

- `.python-version` en la raíz del repo dice `3.12`: Vercel lo lee para elegir el runtime de la
  función. El venv local sigue en 3.14; el código tiene que funcionar en ambos.
- `api/requirements.txt` es el de `backend/` sin `uvicorn` ni `fastembed`. Hoy usa rangos
  (`>=`); los pins exactos están pendientes de confirmar con un deploy de preview antes de
  fijarlos, para no romper producción con una versión que no se probó.
- `fastembed` queda fuera del bundle a propósito: arrastra `onnxruntime` (unos 200 MB) y no cabe
  en la función. Por eso producción es dense-only. `retrieval` en `/api/health` lo dice tal
  cual: `hybrid` solo si BM25 funciona, si no `dense-only`.
- Variables de entorno: las de la tabla de la sección 2. Tras cambiarlas, redeploy.
- Comprobación mínima después de cada deploy: `GET /api/health` responde `qdrant: true`, y el
  `python`, `retrieval` y `prompt_version` que esperabas.

## 5. Tests

```powershell
pip install -r backend/requirements-dev.txt
cd backend
python -m pytest -q
```

Los tests no llaman a OpenAI, ni a Qdrant, ni a la red: usan `set_async_client_for_tests` del
cliente único, un cliente espía de Qdrant y `get_settings.cache_clear()` para aislar la
configuración. Si un test necesita red, está mal escrito.

## 6. Los dos modos de pensamiento

El usuario elige antes de preguntar, y la elección viaja en el cuerpo de `POST /api/chat`
(`modo`: `normal` o `extendido`). Un valor desconocido no es un error: se responde en
normal. El perfil de cada uno vive en `backend/app/services/modos.py` y el efectivo, ya
con el techo del despliegue aplicado, se ve en `GET /api/health` bajo `modos`.

| | Normal | Extendido |
|---|---|---|
| Búsquedas | 2 como máximo | sin tope |
| Tiempo | 60 s | 240 s |
| Sin avance | 1 búsqueda | 3 búsquedas |
| Fragmentos por búsqueda | 8 | 12 |
| `reasoning_effort` | no se envía | `high` |

Lo que NO cambia entre modos: el prompt de fidelidad, las citas, el reranker y el filtro
de relevancia. La diferencia es cuánto se le deja trabajar, no cuánta verdad se le exige.

Coste: el extendido cuesta bastante más por pregunta (más búsquedas, más fragmentos en
contexto y razonamiento alto). Cuando haya que medirlo, `backend/preguntar.py` imprime el
coste real de cada pregunta y el modo queda en la telemetría de cada respuesta.

## 7. Qué NO hay todavía

Para que nadie lo busque en vano:

- **No hay evaluación automática.** El gold set y los runners del proyecto anterior se
  eliminaron con el cambio de dominio. Medir la fidelidad de las respuestas de este corpus
  exige preguntas reales de quien lo usa.
- **No hay OCR**, así que un PDF escaneado se rechaza al ingerir.
- **No hay detección de idioma**: el campo `language` existe y se puede filtrar, pero la
  ingesta lo deja vacío.
- **No hay script de verificación del índice**. `GET /api/stats` da el inventario en vivo
  (fragmentos, archivos, tipos, idiomas) y para lo demás está la consola de Qdrant.
