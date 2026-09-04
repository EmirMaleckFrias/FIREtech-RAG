"""El fixture `settings_override` aísla los tests del `backend/.env` local."""
from __future__ import annotations

from pathlib import Path

from app.config import Settings, get_settings
from tests.conftest import TEST_ENV


def test_settings_override_aplica_el_entorno_de_tests(settings_override):
    s = settings_override
    assert s is get_settings()  # misma instancia cacheada
    assert s.openai_api_key == "test-key"
    assert s.openai_model == "gpt-5.4"
    assert s.rerank_model == "gpt-5.4-mini"
    assert s.rerank_model_resolved == "gpt-5.4-mini"
    assert s.qdrant_url == TEST_ENV["QDRANT_URL"]
    assert s.qdrant_api_key == ""
    assert s.supabase_url == ""
    assert s.supabase_service_key == ""
    assert s.max_hops == 4
    assert s.environment == "local"


def test_variables_de_entorno_ganan_al_env_file(tmp_path: Path, monkeypatch):
    """pydantic-settings lee `env_file`, pero una variable de entorno con el
    mismo nombre tiene prioridad: es lo que garantiza que el .env local no
    contamine los tests aunque defina las mismas claves."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "QDRANT_URL=http://desde-archivo:6333\n"
        "OPENAI_MODEL=modelo-del-archivo\n"
        "MAX_HOPS=9\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("QDRANT_URL", "http://desde-entorno:6333")
    monkeypatch.setenv("MAX_HOPS", "2")
    monkeypatch.delenv("OPENAI_MODEL", raising=False)

    s = Settings(_env_file=env_file)

    # El archivo se leyó (OPENAI_MODEL solo está ahí)...
    assert s.openai_model == "modelo-del-archivo"
    # ...pero el entorno pisa lo que ambos definen.
    assert s.qdrant_url == "http://desde-entorno:6333"
    assert s.max_hops == 2


def test_cambiar_un_valor_dentro_del_test(settings_override, monkeypatch):
    monkeypatch.setenv("MAX_HOPS", "1")
    get_settings.cache_clear()
    assert get_settings().max_hops == 1


def test_el_pipeline_de_evidencia_viene_encendido_con_sus_topes(settings_override):
    """Defaults del pipeline (app/services/evidencia.py). Encendido por
    defecto: es la medida contra la variación medida entre corridas; apagarlo
    es el rollback operativo. El prompt sube a v4 porque el flujo cambió y dos
    mediciones solo se comparan con el mismo prompt."""
    s = settings_override
    assert s.enable_evidence_pipeline is True
    assert s.evidence_candidates_per_item == 30
    assert s.evidence_prefetch_timeout_s == 45.0
    assert s.prompt_version == "v4"


def test_el_pipeline_se_apaga_por_entorno(settings_override, monkeypatch):
    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", "false")
    get_settings.cache_clear()
    assert get_settings().enable_evidence_pipeline is False
