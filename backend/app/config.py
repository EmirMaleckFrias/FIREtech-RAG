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
    openai_model: str = "gpt-5.4"
    embedding_model: str = "text-embedding-3-large"
    embedding_dims: int = 3072
    # Modelo del reranker y del filtro de relevancia. Default explícito al
    # modelo pequeño: antes heredaba openai_model y un despliegue sin
    # RERANK_MODEL rerankeaba con gpt-5.4 (unas 5 veces más caro por token).
    # Vacío = usa openai_model (comportamiento antiguo, hay que pedirlo).
    rerank_model: str = "gpt-5.4-mini"

    # Cliente OpenAI único (app/services/openai_client.py): timeout por
    # request, reintentos del SDK y llamadas concurrentes máximas al API.
    openai_timeout_s: float = 120.0
    openai_max_retries: int = 2
    openai_concurrency: int = 3

    # Versión del prompt del agente. Viaja en /api/health, /api/stats, en la
    # telemetría de cada respuesta y en los resultados de evals para que dos
    # mediciones solo se comparen si usaron el mismo prompt.
    prompt_version: str = "v2"

    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str = ""
    # Colección de documentos. La colección del proyecto anterior se queda
    # intacta en su Qdrant: este backend ya no la mira.
    qdrant_collection: str = "documentos"

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
    # Fragmentos que llegan al modelo por búsqueda, y candidatos que salen de
    # Qdrant antes de reordenar.
    rerank_top_k: int = 12
    search_top_k: int = 60
    cors_origins: str = "http://localhost:5173"

    @property
    def rerank_model_resolved(self) -> str:
        return self.rerank_model or self.openai_model

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
