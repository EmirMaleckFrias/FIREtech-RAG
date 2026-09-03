"""Cliente OpenAI único: caché por loop, reset, inyección para tests y
semáforo de concurrencia."""
from __future__ import annotations

import asyncio

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
