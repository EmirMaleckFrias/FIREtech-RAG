"""Cliente OpenAI único: caché por loop, reset, inyección para tests y
semáforo de concurrencia."""
from __future__ import annotations

import asyncio

import pytest

from openai import AsyncOpenAI, OpenAI

from app.config import get_settings
from app.services import openai_client


async def test_get_async_client_devuelve_la_misma_instancia_en_el_mismo_loop(settings_override):
    a = openai_client.get_async_client()
    b = openai_client.get_async_client()
    assert isinstance(a, AsyncOpenAI)
    assert a is b


async def test_reset_clients_olvida_la_instancia(settings_override):
    a = openai_client.get_async_client()
    openai_client.reset_clients()
    b = openai_client.get_async_client()
    assert a is not b
    assert isinstance(b, AsyncOpenAI)


def test_get_sync_client_es_singleton_y_reset_lo_olvida(settings_override):
    a = openai_client.get_sync_client()
    assert isinstance(a, OpenAI)
    assert openai_client.get_sync_client() is a
    openai_client.reset_clients()
    assert openai_client.get_sync_client() is not a


async def test_base_url_vacia_deja_el_endpoint_por_defecto(settings_override):
    """Sin gateway se habla con api.openai.com, como siempre.

    Vale también como regresión de un footgun medido: con `base_url=None` el
    SDK lee OPENAI_BASE_URL del entorno solo y toma la cadena vacía como URL,
    dejando el cliente apuntando a '' y tumbando toda llamada. El entorno de
    tests fija OPENAI_BASE_URL="" a propósito, así que si alguien vuelve a
    pasar None este test se pone rojo.
    """
    assert str(openai_client.get_async_client().base_url).startswith(
        "https://api.openai.com"
    )
    assert str(openai_client.get_sync_client().base_url).startswith(
        "https://api.openai.com"
    )


async def test_openai_base_url_apunta_los_dos_clientes(settings_override, monkeypatch):
    """Un endpoint compatible (el AI Gateway de Vercel, un proxy) se configura
    con una sola variable y tiene que valer para los DOS clientes: la ingesta
    usa el síncrono y el agente el asíncrono. Si solo uno hiciera caso, media
    aplicación hablaría con el endpoint equivocado y el fallo aparecería tarde,
    en la mitad que nadie probó.
    """
    gateway = "https://ai-gateway.vercel.sh/v1"
    monkeypatch.setenv("OPENAI_BASE_URL", gateway)
    get_settings.cache_clear()
    openai_client.reset_clients()

    assert str(openai_client.get_async_client().base_url).rstrip("/") == gateway
    assert str(openai_client.get_sync_client().base_url).rstrip("/") == gateway


async def test_set_async_client_for_tests_gana_y_none_restaura(settings_override):
    real = openai_client.get_async_client()
    falso = object()
    openai_client.set_async_client_for_tests(falso)  # type: ignore[arg-type]
    try:
        assert openai_client.get_async_client() is falso
    finally:
        openai_client.set_async_client_for_tests(None)
    restaurado = openai_client.get_async_client()
    assert restaurado is not falso
    assert restaurado is real  # el real cacheado sobrevive a la inyección


async def test_reset_clients_tambien_retira_la_inyeccion(settings_override):
    falso = object()
    openai_client.set_async_client_for_tests(falso)  # type: ignore[arg-type]
    openai_client.reset_clients()
    assert openai_client.get_async_client() is not falso


async def test_openai_semaphore_usa_openai_concurrency(settings_override, monkeypatch):
    monkeypatch.setenv("OPENAI_CONCURRENCY", "2")
    get_settings.cache_clear()
    openai_client.reset_clients()
    assert get_settings().openai_concurrency == 2

    sem = openai_client.openai_semaphore()
    assert isinstance(sem, asyncio.Semaphore)
    assert openai_client.openai_semaphore() is sem  # una por loop

    assert not sem.locked()
    await sem.acquire()
    assert not sem.locked()
    await sem.acquire()
    assert sem.locked()  # la tercera plaza no existe
    sem.release()
    sem.release()
    assert not sem.locked()


async def test_openai_slot_ocupa_y_libera_una_plaza(settings_override, monkeypatch):
    monkeypatch.setenv("OPENAI_CONCURRENCY", "1")
    get_settings.cache_clear()
    openai_client.reset_clients()

    sem = openai_client.openai_semaphore()
    async with openai_client.openai_slot():
        assert sem.locked()
    assert not sem.locked()


# ---------------------------------------------------------------------------
# Razonamiento: kwargs y fallback ante un 400 que lo rechace
# ---------------------------------------------------------------------------


def _bad_request(mensaje: str):
    """Un BadRequestError como el que devuelve el SDK, sin red."""
    import httpx
    from openai import BadRequestError

    req = httpx.Request("POST", "https://ai-gateway.vercel.sh/v1/chat/completions")
    resp = httpx.Response(400, request=req, json={"error": {"message": mensaje}})
    return BadRequestError(mensaje, response=resp, body={"error": {"message": mensaje}})


def test_razonamiento_devuelve_kwargs_o_nada(settings_override):
    openai_client._reset_razonamiento()
    assert openai_client.razonamiento("high") == {"reasoning_effort": "high"}
    assert openai_client.razonamiento(" Medium ") == {"reasoning_effort": "medium"}
    assert openai_client.razonamiento("none") == {}
    assert openai_client.razonamiento("") == {}
    assert openai_client.razonamiento(None) == {}


async def test_un_400_por_reasoning_reintenta_sin_el_y_lo_apaga_un_rato(
    settings_override, fake_openai
):
    """El 2 sep 2026 un 400 por reasoning_effort tumbó el modo extendido
    entero. Ahora el mismo 400 cuesta un reintento: la segunda llamada va sin
    el parámetro, y las siguientes ya ni lo intentan hasta que pase el
    plazo."""
    from app.services import telemetry
    from tests.conftest import make_text_completion

    openai_client._reset_razonamiento()
    fake_openai.queue(
        _bad_request(
            "Unsupported parameter: 'reasoning_effort' is not supported with "
            "function tools on this endpoint"
        ),
        make_text_completion("ok"),
    )
    tel = telemetry.start()
    kwargs = {"model": "m", "messages": [], "reasoning_effort": "high"}
    resp = await openai_client.crear_completion(fake_openai, kwargs)
    assert resp.choices[0].message.content == "ok"
    assert len(fake_openai.calls) == 2
    assert fake_openai.calls[0]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in fake_openai.calls[1]
    assert tel.summary()["counters"]["razonamiento_rechazado"] == 1
    # Y mientras dure el rechazo, `razonamiento` deja de proponerlo.
    assert openai_client.razonamiento_rechazado()
    assert openai_client.razonamiento("high") == {}
    openai_client._reset_razonamiento()
    assert openai_client.razonamiento("high") == {"reasoning_effort": "high"}


async def test_un_400_por_otra_cosa_sube_tal_cual(settings_override, fake_openai):
    """El fallback es SOLO para reasoning_effort: un 400 por otro motivo (un
    mensaje mal formado, un modelo inexistente) no debe reintentarse ni, peor,
    apagar el razonamiento."""
    from openai import BadRequestError

    openai_client._reset_razonamiento()
    fake_openai.queue(_bad_request("Invalid 'messages[2].role': 'tool' without tool_calls"))
    with pytest.raises(BadRequestError):
        await openai_client.crear_completion(
            fake_openai, {"model": "m", "messages": [], "reasoning_effort": "high"}
        )
    assert len(fake_openai.calls) == 1
    assert not openai_client.razonamiento_rechazado()


async def test_sin_reasoning_en_los_kwargs_un_400_no_se_reintenta(settings_override, fake_openai):
    from openai import BadRequestError

    fake_openai.queue(_bad_request("reasoning is not supported"))
    with pytest.raises(BadRequestError):
        await openai_client.crear_completion(fake_openai, {"model": "m", "messages": []})
    assert len(fake_openai.calls) == 1
