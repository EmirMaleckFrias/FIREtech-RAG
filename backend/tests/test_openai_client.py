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
