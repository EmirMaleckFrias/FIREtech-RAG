# Migración a Convex

El 4 de septiembre de 2026 el backend pasó de "FastAPI en Python sobre una función de Vercel,
con Supabase (Postgres y Auth) y Qdrant Cloud" a "Convex (TypeScript) con Convex Auth", con el
mismo frontend React + Vite. Este documento dice por qué, qué se retiró, qué cambió de
contrato, qué no se migró y qué queda pendiente. El contrato de interfaces que guió el port
está en `frontend/convex/CONTRATO.md`.

## 1. Por qué

1. **300 segundos frente a 600.** La función de Vercel moría a los 300 s y perdía la respuesta
   entera en vez de acortarla. Por eso el modo extendido estaba recortado a 180 s y competía
   por el mismo reloj con la barrera de revisión. Una acción de Convex dura 600 s: el modo
   extendido vuelve a los 240 s que quería, el presupuesto total de una pregunta es de 540 s
   y sobra margen para revisar.
2. **Streaming por base de datos, no por SSE.** Con SSE el agente corría dentro de la petición
   HTTP: si el cliente cerraba, había que guardar respuestas parciales; si el servidor fallaba,
   quedaban preguntas sin respuesta. `routes.py` tenía dos caminos de guardado parcial solo
   por eso. En Convex el agente escribe su avance en la fila del mensaje y el cliente está
   suscrito: la respuesta sobrevive a cerrar el navegador y desaparece esa clase de fallos.
3. **Sin acceso al proyecto de Supabase.** Nadie del equipo podía aplicar migraciones. La 009
   (telemetría junto al mensaje) y la 010 (rol `lector`) nunca llegaron a producción, y la
   regla de negocio más delicada (dominio de correo y administradores preasignados) vivía en un
   trigger plpgsql `security definer` colgado de `auth.users`, redefinido tres veces y que
   llegaba al frontend como un texto en inglés que había que reconocer por comparación de
   cadenas.
4. **Un solo sitio.** Tablas, autenticación, índice vectorial, índice de texto, almacenamiento
   de ficheros y funciones en un despliegue. Local y producción tienen bases distintas, así que
   desaparece la columna `environment` y con ella un filtro que se podía olvidar y dejaba las
   búsquedas a cero en silencio (que es exactamente lo que pasó con el filtro de idioma en
   Qdrant).

Otras cosas que se ganan por el camino: el fichero original queda guardado, así que reindexar
no exige volver a subirlo (en Vercel el disco era efímero y el reintento respondía 409
`file_not_stored`); el límite de subida pasa de 4 MB (tope de 4,5 MB por petición en Vercel) a
100 MB (la URL firmada de Convex no limita el tamaño; el techo es la ingesta) y el fichero va directo al almacenamiento; ya no hay
que vigilar el tamaño del bundle Python ni el runtime de `.python-version`; ni levantar Qdrant
en Docker para desarrollar.

## 2. Qué reemplaza a qué

| Antes | Ahora |
|---|---|
| Supabase Postgres (tablas, `jsonb`, migraciones SQL) | Tablas de Convex en `schema.ts` |
| Supabase Auth + trigger `handle_new_user()` | Convex Auth (`auth.ts`): `createOrUpdateUser` impone dominio y admins preasignados |
| Tabla `profiles` (rol, bloqueo) | Campos `rol` y `bloqueado` en `users` |
| Tabla `admin_preasignados` + trigger | Tabla `adminsPreasignados` + `semilla.ts` |
| Qdrant: vector denso + BM25 + RRF en servidor, facets | `chunks` con `vectorIndex` y `searchIndex`; RRF en `search/hybrid.ts`; inventario desde `documents` |
| FastAPI (`/api/*`) con Bearer de Supabase | Funciones de Convex con identidad de Convex Auth; `permisos.ts` |
| `POST /api/chat` con SSE | `mensajes.enviar` + acción `agente.bucle.correr` que escribe `estado`, `plan`, `hops`, `sources`, `content`, `verificacion`, `metrics` |
| Sondeo de `GET /api/health` | Estado de la conexión WebSocket |
| `data/uploads` y `/tmp` | Almacenamiento de ficheros de Convex (`documents.storageId`) |
| `ingest.py` (ingesta por carpeta) | Subida por la interfaz; `pruebas.ts` para corpus de prueba |
| `preguntar.py`, script de estrés | `pruebas:prepararPregunta` y `pruebas:leerRespuesta` |
| SDK de OpenAI (`openai_client.py`) | `lib/gateway.ts` con `fetch` contra el AI Gateway de Vercel |
| Rerank listwise + filtro binario (450 caracteres) | Calificador por fragmento sobre el texto completo (`agente/calificador.ts`) |
| pdfplumber, python-docx, openpyxl | `unpdf` (pdf.js), `jszip` + `fast-xml-parser` |
| pytest offline | vitest + convex-test en `edge-runtime` |

## 3. Qué se retiró

- El backend Python entero como componente en ejecución: `backend/app/`, `api/index.py`, sus
  `requirements*.txt`, `.python-version`. Se conservan en el repositorio como referencia del
  port hasta que la migración esté verificada; `.vercelignore` los excluye del despliegue.
- Supabase: Postgres, Auth y las migraciones `supabase/migrations/001..010`. Se conservan como
  histórico del esquema.
- Qdrant Cloud y el Qdrant local (`infra/docker-compose.yml`), incluidos el backend BM25
  (`QDRANT_BM25_BACKEND`), `fastembed` y la lista blanca `_PAYLOAD_KEYS`.
- El streaming SSE y los eventos `session`, `hop`, `sources`, `token`, `metrics`, `done`,
  `error`.
- `GET /api/health`, `GET /api/stats` como HTTP, `POST /api/search` (búsqueda cruda de
  depuración; sin equivalente hoy).
- La ingesta por carpeta (`ingest.py`, con `--dry-run`, `--environment`, `--max-usd`,
  `--reset`).
- El rerank listwise y el filtro binario de relevancia: el pipeline de evidencia es el único
  camino.
- Las variables `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `QDRANT_*`, `OPENAI_TIMEOUT_S`,
  `OPENAI_MAX_RETRIES`, `OPENAI_CONCURRENCY`, `CORS_ORIGINS`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`. La concurrencia hacia el gateway es ahora una plaza de 8 por acción
  (`lib/gateway.ts`), con 5 intentos y espera exponencial.
- En el frontend: `api.ts`, `lib/session.ts`, `lib/sse.ts`, `lib/supabase.ts`, el proxy `/api`
  de Vite y las quince traducciones de mensajes de error de GoTrue por comparación de cadenas.

## 4. Qué cambió de contrato

- **Rol `vendedor` pasa a `lector`.** El identificador que el producto quería y que la
  migración 010 nunca pudo aplicar. El frontend ya mostraba "Lector".
- **No hay campo `environment`** en documentos ni en fragmentos.
- **Ids de Convex** (`_id`) en vez de `uuid` de Postgres, en sesiones, mensajes, documentos y
  usuarios. Las mutaciones de documentos reciben `documentId`, no `file_name`, aunque el
  nombre de archivo sigue identificando al documento dentro del despliegue.
- **Errores estructurados**: `ConvexError` con `{codigo, mensaje}` (`no_autenticado`,
  `acceso_revocado`, `no_encontrado`, `solo_admin`, `conflicto`, `invalido`) en vez de
  401/403/404/409 con `detail`.
- **Estado del turno en la fila del mensaje**: `estado` (`pensando`, `buscando`, `redactando`,
  `revisando`, `listo`, `error`) y `content` vacío hasta `listo`. `metrics` y `verificacion`
  pasan a ser columnas propias del mensaje (era lo que pretendía la migración 009); `plan`
  también se guarda.
- **Las formas de `sources`, `hops` y `verificacion` se conservan en snake_case**, con
  añadidos: `sources` gana `plan_items` y `grado`; `hops` gana `origen`, `plan_item`,
  `evidence_needed`, `resultados`, `documentos`, `estado`, `recuperacion`,
  `relevancia_verificada`, `ms`, `estado_final`, `usado_en_respuesta`; `verificacion` gana
  `cobertura`. Los valores de `recuperacion` van en español (`hibrida`, `densa`, `lexica`,
  `error`); el frontend acepta también `hybrid` y `dense` por compatibilidad de lectura.
- **Los campos de las tablas van en camelCase y en español** (`fileName`, `ingestadoEn`,
  `creadoEn`).
- **Subida en dos pasos**: URL firmada, POST del fichero, `registrar`. Límite 100 MB por defecto (`UPLOAD_LIMIT_MB`).
- **Feedback**: un voto por usuario y mensaje; repetir reemplaza (en Postgres se acumulaban).
- **Borrar conversación** existe como operación (`sesiones.borrar`); el backend anterior no lo
  tenía como endpoint.
- **Bloqueo sin baneo en Auth**: como cada función lee `bloqueado`, el token vigente deja de
  servir en el acto y no hace falta tocar las sesiones de Convex Auth.
- **Clasificación antes de buscar**: saludos y preguntas sobre el asistente no ejecutan el
  pipeline ni reciben la orden de declarar ausencia.
- **`PROMPT_VERSION` pasa a `v4`.**
- Presupuestos: `PRESUPUESTO_TOTAL_S` (540) es nuevo; el modo extendido vuelve a 240 s; el
  tope de la revisión pasa de 45 a 150 s; `AGENT_BUDGET_S` y `MAX_HOPS` pasan a `0` por defecto
  (manda el modo); `maxHopsSinAvance` del modo normal pasa de 1 a 2.

## 5. Qué NO se migró

- **Cuentas.** Las contraseñas de Supabase Auth no se pueden exportar. Todo el mundo se da de
  alta de nuevo; los correos de `semilla.ts` nacen administradores. El primer día el primer
  intento de entrar falló justo por esto, con un mensaje que no lo decía; ahora lo dice.
- **Documentos.** Los indexados en Qdrant eran de prueba. Hay que subirlos de nuevo por la
  interfaz; la ingesta los reprocesa con el parser nuevo.
- **Conversaciones, mensajes y valoraciones.** Se quedan en la base de Supabase, sin acceso por
  la aplicación.
- **El evaluador offline** (sección 6).

## 6. Qué queda pendiente

| Pendiente | Estado y qué implica |
|---|---|
| **Evaluador offline** | `backend/evaluar.py` y `backend/app/evaluation.py` siguen en Python y llaman a `POST /api/chat` por SSE en `http://localhost:8000`, que ya no existe. La lógica determinista (cobertura de evidencias, resolución de citas, patrones de hops, contenido obligatorio y prohibido, abstención, `min_faithfulness` leído del verificador) sigue siendo válida. Portarla como script que use `pruebas:prepararPregunta` y `pruebas:leerRespuesta`, o como acción interna de Convex. Los patrones de cita y abstención ya son idénticos a `lib/citas.ts`. |
| **Tabla de contadores** | `estadisticas.sistema` y `usuarios.listar` recorren `messages`; aguantan unos cientos de respuestas dentro de los 16 MiB por transacción. Hace falta un cambio de esquema con contadores por usuario y globales, actualizados en `enviar` y en los borrados. |
| **Google OAuth** | `auth.ts` ofrece Google si existen `AUTH_GOOGLE_ID` y `AUTH_GOOGLE_SECRET`, pero el frontend no tiene forma de saberlo: `useGoogleDisponible()` devuelve `false`. Falta una query `usuarios.googleDisponible` que publique `googleDisponible()` y las variables en el despliegue. |
| **Despliegue de producción frente a dev** | Confirmar qué despliegue de Convex es producción, poner su clave de despliegue como `CONVEX_DEPLOY_KEY` en Vercel y sus variables (`OPENAI_API_KEY`, Convex Auth, presupuestos) en ese despliegue. `frontend/.env.example` apunta al despliegue usado durante la migración (`gregarious-pony-327`). Sembrar administradores en cada despliegue. |
| **Retirar el histórico** | Borrar `backend/`, `api/`, `supabase/`, `infra/`, `data/` y `.python-version` cuando la migración esté verificada y el evaluador portado. |
| **Dos ingestas concurrentes** | La guarda de 10 minutos de `processing` no cubre todos los casos; ver OPERACION.md. |
| **PDFs a dos columnas** | Resuelto en lo esencial el 4 de septiembre de 2026 (`pdf.ts` detecta el canal vertical y lee columna a columna, medido con cinco artículos reales). Quedan los casos límite de OPERACION.md: maquetas poco habituales sin separar y filas de tabla a todo el ancho partidas en dos mitades. |
| **Ingesta por carpeta** | No hay sustituto del `ingest.py` para cargar un corpus grande de una vez; hoy es la interfaz o las funciones de prueba una a una. |

## 7. Correcciones de diseño que entraron con el port

Las encontraron revisores adversariales sobre la implementación Python del mismo diseño, el 4 de
septiembre de 2026, y el port las cierra desde el principio (detalle en `CONTRATO.md`):

- El verificador auditaba de menos: una frase de abstención con cita no se juzgaba, así que un
  hallazgo negativo colgado de una fuente que decía lo contrario pasaba, y una cita inventada
  al lado de esa frase nunca llegaba a `citas_sin_resolver`. Ahora la frase dueña de la cita
  se audita siempre y solo se salta la ausencia pura sin dígitos.
- El calificador daba `verificado=true` con cero grados. Ahora sin ningún grado es
  `verificado=false`.
- El prompt decía "ya se buscó en inglés" y era falso para el ancla `e0`. Ahora el planificador
  devuelve `pregunta_en` y la cabecera de cada punto dice la verdad sobre los idiomas.
- "¿Qué eres?" y "hola" ejecutaban el pipeline y recibían la orden de declarar ausencia. Ahora
  se clasifican antes de buscar.
- Un punto con la búsqueda en error se leía como ausencia. Ahora es "no se pudo comprobar" en
  el prompt, en la cobertura y en la interfaz.
- Las secciones del PDF por nombre no bastaban (una guía quedó entera como "Introducción");
  las filas de tabla por densidad de cifras fallaban en tablas sin números; el des-guionado
  perdía términos ("hippocam-" + "pal"). Todo pasa a geometría y formato.
- Las páginas a dos columnas se fundían línea a línea, también con pdfplumber en el Python
  original. Ahora se detecta el canal vertical y se lee columna a columna.

## 8. Cómo verificar la migración

```bash
cd frontend
npm test && npm run typecheck
npx convex dev --once                      # empuja esquema y funciones al despliegue de .env.local
npx convex run semilla:sembrarAdmins
npx convex run pruebas:prepararPregunta '{"texto":"¿Cuántos documentos hay indexados?","modo":"normal"}'
npx convex run pruebas:leerRespuesta '{"messageId":"<id>"}'
```

Después, en la interfaz: alta con un correo del dominio, subida de un PDF, pregunta en los dos
modos, panel de fuentes, tabla de cobertura e informe de atribución, y Ajustes > Sistema con
el índice y la configuración vigente.
