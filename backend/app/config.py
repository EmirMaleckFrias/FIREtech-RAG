from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
DATA_RAW_DIR = PROJECT_DIR / "data" / "raw"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    openai_api_key: str = ""
    # Endpoint del API. Vacío = api.openai.com, el default del SDK. Sirve para
    # apuntar a cualquier endpoint compatible con OpenAI; el caso vigente es el
    # AI Gateway de Vercel ("https://ai-gateway.vercel.sh/v1"), que factura por
    # Vercel y nombra los modelos con el proveedor por delante. OJO: si se usa
    # el gateway, los tres modelos de abajo llevan prefijo ("openai/gpt-5.4"),
    # porque el nombre viaja tal cual en cada petición.
    openai_base_url: str = ""
    openai_model: str = "gpt-5.4"
    embedding_model: str = "text-embedding-3-large"
    embedding_dims: int = 3072
    # Modelo del reranker y del filtro de relevancia. Default explícito al
    # modelo pequeño: antes heredaba openai_model y un despliegue sin
    # RERANK_MODEL rerankeaba con gpt-5.4 (unas 5 veces más caro por token).
    # Vacío = usa openai_model (comportamiento antiguo, hay que pedirlo).
    rerank_model: str = "gpt-5.4-mini"

    # Temperatura de TODAS las llamadas a modelo. 0.0 a propósito: esto es una
    # herramienta de investigación y la consistencia vale más que la variedad
    # de redacción. Sin fijarla se usaba el default de la API (1.0) en las
    # cinco llamadas de la cadena -planner, agente, reranker, filtro de
    # relevancia y verificador-, y eran cinco fuentes de azar independientes
    # que se multiplicaban: medido, la misma pregunta daba entre 6 y 10
    # búsquedas y una fidelidad entre 0.33 y 1.00.
    #
    # Medido también su efecto real, con 10 repeticiones de una ordenación:
    # el default daba 4 salidas distintas de 10 y con 0.0 bajan a 2. Ayuda
    # claramente, pero NO da determinismo: la familia gpt-5 conserva
    # aleatoriedad residual y `seed` no cambió nada (2/10 con y sin él). Para
    # eliminar la variación de verdad hay que sacar decisiones de manos del
    # modelo, no bajar la temperatura. Esa medida es el pipeline de evidencia
    # (`enable_evidence_pipeline`, app/services/evidencia.py): las búsquedas
    # las decide el plan y las ejecuta código determinista, y el modelo solo
    # lee la evidencia y redacta. La temperatura se queda en 0.0 para lo que
    # sigue en manos del modelo (planner, calificador, redacción).
    llm_temperature: float = 0.0

    # Cliente OpenAI único (app/services/openai_client.py): timeout por
    # request, reintentos del SDK y llamadas concurrentes máximas al API.
    # 60 y no 120: en serverless una sola llamada colgada se comía la mitad
    # del presupuesto de la pregunta. Una ronda del agente con razonamiento
    # alto y respuesta larga se midió en 11-12 s; 60 deja margen de sobra.
    openai_timeout_s: float = 60.0
    openai_max_retries: int = 2
    # 6 y no 3: el pipeline de evidencia lanza las consultas del plan en
    # paralelo (embedding + calificación por punto) y con 3 plazas el
    # "paralelo" era nominal: cinco puntos hacían cola de a tres. Cada
    # petición serverless es un proceso aparte, así que esto es concurrencia
    # por pregunta, no global.
    openai_concurrency: int = 6

    # Esfuerzo de razonamiento (`reasoning_effort`) por componente. Hasta el
    # 4 sep 2026 NADIE razonaba: una nota decía que la API lo rechazaba junto
    # a tools y se apagó en todo el backend; medido de nuevo contra el
    # gateway, funciona (ver app/services/modos.py y
    # openai_client.crear_completion, que además reintenta sin él si un día
    # vuelve a rechazarlo). Valores: none | low | medium | high.
    #
    # El del agente lo decide el MODO (normal medium, extendido high); este
    # ajuste solo existe como techo del operador: vacío = manda el modo,
    # "none" lo apaga en los dos.
    agent_reasoning_effort: str = ""
    # El planner es UNA llamada por pregunta y de su descomposición depende
    # toda la evidencia: high.
    planner_reasoning_effort: str = "high"
    # El calificador corre una vez por punto del plan, en paralelo: medium
    # equilibra juicio y latencia.
    rerank_reasoning_effort: str = "medium"
    # El verificador es el juez de la barrera; sus falsos positivos abstienen
    # y sus falsos negativos dejan pasar atribuciones falsas. medium, porque
    # va en lotes de hasta 24 afirmaciones y high sobre listas largas tarda
    # más de lo que la revisión puede esperar.
    verifier_reasoning_effort: str = "medium"
    # El revisor redacta la corrección con toda la evidencia delante: high.
    revisor_reasoning_effort: str = "high"

    # Versión del prompt del agente. Viaja en /api/health, /api/stats, en la
    # telemetría de cada respuesta y en los resultados de evals para que dos
    # mediciones solo se comparen si usaron el mismo prompt.
    # v4: la evidencia llega ya recuperada por el pipeline y el prompt le
    # pide al modelo leerla y redactar con una estructura fija (respuesta
    # directa, evidencia por punto con su sección, contradicciones, ausencias
    # con la fórmula literal que reconoce el verificador).
    prompt_version: str = "v4"

    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str = ""
    # Colección de documentos. La colección del proyecto anterior se queda
    # intacta en su Qdrant: este backend ya no la mira.
    qdrant_collection: str = "documentos"
    # "server" usa el BM25 nativo de Qdrant y cabe en Vercel sin
    # fastembed/onnxruntime. "fastembed" conserva el backend local antiguo;
    # "auto" prueba servidor y luego fastembed; "disabled" fuerza dense-only.
    # Cambiar de implementación requiere reindexar el corpus.
    qdrant_bm25_backend: str = "server"

    supabase_url: str = ""
    supabase_service_key: str = ""

    # Entorno de despliegue (env ENVIRONMENT; en Vercel está seteada a
    # "production"). Prod y local comparten la tabla `documents` pero tienen
    # Qdrants distintos: el registro de documentos se filtra/escribe por
    # entorno (columna `environment`, migración 003).
    environment: str = "local"

    # Topes del DESPLIEGUE, que se aplican encima del perfil del modo
    # (app/services/modos.py) y solo pueden apretarlo, nunca soltarlo. 0 = sin
    # tope propio, o sea que manda el modo. Existen para que quien opera pueda
    # frenar el gasto sin tocar el código.
    max_hops: int = 0
    # Segundos de reloj para el bucle completo antes de forzar la respuesta
    # final. Existe porque la función de Vercel muere a los 300 s: sin esto,
    # una pregunta larga no se corta, se pierde entera. 0 = sin límite.
    agent_budget_s: float = 240.0
    # Búsquedas seguidas sin traer ni un fragmento nuevo antes de rendirse.
    # Buscar más de lo mismo no acerca a la respuesta, solo gasta.
    agent_max_hops_sin_avance: int = 3
    # El modo extendido descompone la pregunta y ejecuta estas búsquedas antes
    # de redactar. Se puede apagar como rollback operativo sin cambiar código.
    enable_query_planning: bool = True
    planner_max_queries: int = 5
    # Pipeline de evidencia (app/services/evidencia.py). Antes el agente
    # decidía libremente cuántas búsquedas hacía (medido: 6-10 para la misma
    # pregunta), el plan solo se le SUGERÍA como texto, ningún fragmento sabía
    # qué punto del plan lo había traído y un paper largo podía ocupar los 12
    # huecos. Resultado medido: misma pregunta, fidelidad 0.33-1.00 entre
    # corridas. Con el pipeline la evidencia es una función determinista de
    # (pregunta, índice): el plan se ejecuta por código, en paralelo, con
    # calificación por punto y cuotas por documento, y el modelo la recibe ya
    # recuperada. Apagarlo devuelve el bucle anterior tal cual (rollback).
    enable_evidence_pipeline: bool = True
    # Candidatos por punto del plan que pasan al calificador tras fusionar,
    # podar y deduplicar. 30 y no 60: el calificador lee el texto COMPLETO de
    # cada fragmento y con 60 la petición se hacía demasiado larga para un
    # dictamen fiable; 30 con cuota por documento cubre varios papers.
    evidence_candidates_per_item: int = 30
    # Tope de reloj para recuperar y calificar TODOS los puntos del plan (van
    # en paralelo). Un punto que no llega a tiempo queda "sin_resultados" con
    # recuperación "error"; el resto sigue.
    evidence_prefetch_timeout_s: float = 45.0
    # Verificación de la respuesta final, afirmación por afirmación, contra los
    # fragmentos recuperados (app/services/verificador.py). Es el requisito
    # central del proyecto: una respuesta fluida con una cita que no sostiene
    # lo dicho es un fallo grave en investigación médica. Se puede apagar como
    # rollback operativo; entonces el sistema se comporta como antes.
    enable_answer_verification: bool = True
    # Si esta activo, el texto del agente se mantiene privado hasta que el
    # verificador lo aprueba. Los fallos vuelven al redactor para corregirse y
    # solo entonces comienza el stream visible. Es la barrera de fidelidad del
    # flujo medico; se puede apagar como rollback para recuperar el streaming
    # optimista anterior.
    enable_pre_response_review: bool = True
    pre_response_review_max_revisions: int = 1
    # Presupuesto total de critico + correcciones. Debe dejar margen dentro del
    # limite de la funcion serverless aun cuando la busqueda use casi todo su
    # propio presupuesto.
    # 90 y no 45: con razonamiento en el verificador y el revisor, verificar +
    # corregir + volver a verificar no cabe en 45 s y la barrera acababa en
    # abstención segura por reloj, no por fidelidad. Cabe porque el bucle del
    # modo extendido bajó a 180 s (modos.py) y el reloj es UNO por pregunta:
    # el agente recorta este tope al tiempo que de verdad quede.
    pre_response_review_timeout_s: float = 90.0
    # Modelo del verificador. Vacío = hereda rerank_model_resolved.
    verifier_model: str = ""
    # Afirmaciones por PETICIÓN al verificador. No es un recorte: si la
    # respuesta trae más, se verifican en varios lotes (ver
    # app/services/verificador.py). Acota el tamaño de cada request porque
    # pedir una lista muy larga de veredictos en un solo JSON degrada el
    # dictamen y arriesga respuestas truncadas.
    verifier_max_claims: int = 24
    # Fragmentos que llegan al modelo por búsqueda, y candidatos que salen de
    # Qdrant antes de reordenar.
    rerank_top_k: int = 12
    search_top_k: int = 60
    cors_origins: str = "http://localhost:5173"

    @property
    def rerank_model_resolved(self) -> str:
        return self.rerank_model or self.openai_model

    @property
    def verifier_model_resolved(self) -> str:
        return self.verifier_model or self.rerank_model_resolved

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
