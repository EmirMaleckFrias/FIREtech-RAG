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
    rerank_model: str = ""  # vacío = usa openai_model

    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "productos"

    supabase_url: str = ""
    supabase_service_key: str = ""

    # Entorno de despliegue (env ENVIRONMENT; en Vercel está seteada a
    # "production"). Prod y local comparten la tabla `documents` pero tienen
    # Qdrants distintos: el registro de documentos se filtra/escribe por
    # entorno (columna `environment`, migración 003).
    environment: str = "local"

    # Clave de acceso de la app desplegada. Vacía (default) = sin gate: el
    # backend no exige nada (flujo dev local intacto). Definida y no vacía =
    # todo /api/* excepto /api/health exige el header X-App-Key con este valor.
    app_access_key: str = ""

    max_hops: int = 4
    rerank_top_k: int = 8
    search_top_k: int = 30
    sku_fastpath: bool = True  # match exacto de SKUs detectados en la consulta
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
