"""Embeddings: reintentos con backoff en la ingesta (sync) y telemetría en
la consulta (async). Sin red y sin dormir."""
from __future__ import annotations

import httpx
import openai
import pytest

from app.services import embeddings, telemetry
from app.services.embeddings import _ATTEMPTS, _backoff, _no_retry, embed_query, embed_texts
from tests.conftest import FakeSyncOpenAI, make_embeddings_response


def _api_error(cls, status: int, body: dict | None = None, message: str = "error"):
    """Construye un error del SDK de OpenAI con el status y cuerpo dados."""
    response = httpx.Response(status, request=httpx.Request("POST", "http://openai.test"))
    return cls(message, response=response, body=body)


@pytest.fixture
def fake_sync_openai(settings_override, monkeypatch):
    """Cliente síncrono falso inyectado en `embed_texts` vía get_sync_client."""
    fake = FakeSyncOpenAI()
    monkeypatch.setattr(embeddings, "get_sync_client", lambda: fake)
    return fake


@pytest.fixture
def sin_dormir(monkeypatch):
    """`time.sleep` del módulo de embeddings no duerme: registra las pausas."""
    pausas: list[float] = []
    monkeypatch.setattr(embeddings.time, "sleep", lambda s: pausas.append(s))
    return pausas


# --- embed_texts (sync, ingesta) ---------------------------------------------
def test_embed_texts_reintenta_tras_un_fallo(settings_override, fake_sync_openai, sin_dormir):
    textos = ["uno", "dos", "tres"]
    fake_sync_openai.queue_embeddings(
        RuntimeError("429 rate limited"),
        make_embeddings_response(len(textos), dims=4, prompt_tokens=30),
    )
    tel = telemetry.start()

    out = embed_texts(textos)

    assert len(out) == 3 and all(len(v) == 4 for v in out)
    assert len(fake_sync_openai.embedding_calls) == 2
    for llamada in fake_sync_openai.embedding_calls:
        assert llamada["model"] == settings_override.embedding_model
        assert llamada["input"] == textos
    assert sin_dormir == [_backoff(0)]

    rondas = [r for r in tel.rounds if r.component == "embeddings"]
    assert [r.ok for r in rondas] == [False, True]
    assert "429" in rondas[0].note
    assert rondas[1].prompt == 30
    assert all(r.model == settings_override.embedding_model for r in rondas)


def test_embed_texts_agota_los_reintentos_y_lanza(settings_override, fake_sync_openai, sin_dormir):
    fake_sync_openai.queue_embeddings(*[RuntimeError("caído")] * _ATTEMPTS)
    with pytest.raises(RuntimeError):
        embed_texts(["x"])
    assert len(fake_sync_openai.embedding_calls) == _ATTEMPTS
    assert sin_dormir == [_backoff(i) for i in range(_ATTEMPTS - 1)]


def test_embed_texts_no_reintenta_error_de_autenticacion(settings_override, fake_sync_openai, sin_dormir):
    fake_sync_openai.queue_embeddings(_api_error(openai.AuthenticationError, 401, message="clave inválida"))
    tel = telemetry.start()
    with pytest.raises(openai.AuthenticationError):
        embed_texts(["x"])
    assert len(fake_sync_openai.embedding_calls) == 1  # ni un reintento
    assert sin_dormir == []
    assert [r.ok for r in tel.rounds] == [False]


def test_embed_texts_no_reintenta_429_de_cuota(settings_override, fake_sync_openai, sin_dormir):
    cuerpo = {"error": {"code": "insufficient_quota", "message": "You exceeded your current quota"}}
    fake_sync_openai.queue_embeddings(_api_error(openai.RateLimitError, 429, body=cuerpo))
    with pytest.raises(openai.RateLimitError):
        embed_texts(["x"])
    assert len(fake_sync_openai.embedding_calls) == 1
    assert sin_dormir == []


def test_embed_texts_si_reintenta_429_puntual(settings_override, fake_sync_openai, sin_dormir):
    cuerpo = {"error": {"code": "rate_limit_exceeded", "message": "Rate limit reached"}}
    fake_sync_openai.queue_embeddings(
        _api_error(openai.RateLimitError, 429, body=cuerpo),
        make_embeddings_response(1, dims=4),
    )
    out = embed_texts(["x"])
    assert len(out) == 1
    assert len(fake_sync_openai.embedding_calls) == 2
    assert sin_dormir == [_backoff(0)]


def test_no_retry_clasifica_por_tipo_y_status():
    assert _no_retry(_api_error(openai.AuthenticationError, 401)) is True
    assert _no_retry(_api_error(openai.BadRequestError, 400)) is True
    assert _no_retry(_api_error(openai.NotFoundError, 404)) is True
    assert _no_retry(_api_error(openai.InternalServerError, 500)) is False
    assert _no_retry(RuntimeError("timeout")) is False
    assert _no_retry(_api_error(openai.RateLimitError, 429, body={"error": {"code": "x"}})) is False
    assert _no_retry(_api_error(openai.RateLimitError, 429, message="billing hard limit")) is True


def test_embed_texts_prepara_los_textos(settings_override, fake_sync_openai, sin_dormir):
    embed_texts(["con\nsalto", ""])
    entrada = fake_sync_openai.embedding_calls[0]["input"]
    assert entrada == ["con salto", " "]  # saltos a espacio; vacío a un espacio
    assert sin_dormir == []


def test_embed_texts_vacio_no_llama(settings_override, fake_sync_openai):
    assert embed_texts([]) == []
    assert fake_sync_openai.embedding_calls == []


# --- embed_query (async, consulta) -----------------------------------------
async def test_embed_query_usa_el_fake_async_y_registra_telemetria(settings_override, fake_openai):
    tel = telemetry.start()

    vec = await embed_query("válvula de\ncompuerta")

    assert vec == [0.0, 0.0, 0.0, 0.0]
    assert len(fake_openai.embedding_calls) == 1
    llamada = fake_openai.embedding_calls[0]
    assert llamada["model"] == settings_override.embedding_model
    assert llamada["input"] == ["válvula de compuerta"]

    rondas = [r for r in tel.rounds if r.component == "embeddings"]
    assert len(rondas) == 1
    assert rondas[0].ok is True
    assert rondas[0].model == settings_override.embedding_model
    assert rondas[0].prompt == 8  # usage.prompt_tokens de la respuesta falsa
    assert tel.by_component()["embeddings"]["rounds"] == 1


async def test_embed_query_reintenta_sin_dormir(settings_override, fake_openai, monkeypatch):
    # Backoff a cero para no parchear asyncio.sleep del loop del propio test.
    monkeypatch.setattr(embeddings, "_backoff", lambda attempt: 0.0)
    fake_openai.queue_embeddings(RuntimeError("timeout"))
    tel = telemetry.start()

    vec = await embed_query("x")

    assert len(vec) == 4
    assert len(fake_openai.embedding_calls) == 2
    assert [r.ok for r in tel.rounds] == [False, True]
    assert "timeout" in tel.rounds[0].note


async def test_embed_query_no_reintenta_error_de_autenticacion(settings_override, fake_openai, monkeypatch):
    pausas: list[float] = []
    monkeypatch.setattr(embeddings, "_backoff", lambda attempt: pausas.append(attempt) or 0.0)
    fake_openai.queue_embeddings(_api_error(openai.AuthenticationError, 401, message="clave revocada"))
    tel = telemetry.start()

    with pytest.raises(openai.AuthenticationError):
        await embed_query("x")

    assert len(fake_openai.embedding_calls) == 1
    assert pausas == []  # nunca llegó al backoff
    assert [r.ok for r in tel.rounds] == [False]
