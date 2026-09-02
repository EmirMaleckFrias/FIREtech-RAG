"""Cliente OpenAI único para todo el backend.

Antes cada servicio (agente, reranker, embeddings) construía su propio
`AsyncOpenAI` en cada llamada: sin pool HTTP compartido, sin timeout común y
sin ningún tope de concurrencia. Aquí vive un solo cliente por proceso (y por
event loop, que es lo que exige httpx) más un semáforo que acota las llamadas
concurrentes al API para no disparar 429 en ráfagas.

Uso:
    from app.services.openai_client import get_async_client, openai_slot

    async with openai_slot():
        resp = await get_async_client().chat.completions.create(...)

Los tests sustituyen el cliente con `set_async_client_for_tests(fake)`; el
semáforo sigue funcionando igual con el falso.
"""
from __future__ import annotations

import asyncio
import contextlib
import threading
from typing import AsyncIterator

from openai import AsyncOpenAI, OpenAI

from app.config import get_settings

# Un cliente por event loop: el pool de httpx queda ligado al loop que lo
# creó y reutilizarlo desde otro (tests, scripts) rompe con "Event loop is
# closed". En el servidor hay un solo loop, así que en la práctica es uno.
_async_clients: dict[int, AsyncOpenAI] = {}
_async_override: AsyncOpenAI | None = None
_sync_client: OpenAI | None = None
_sync_lock = threading.Lock()

# Semáforo por loop por la misma razón: asyncio.Semaphore se liga al loop la
# primera vez que alguien espera en él.
_semaphores: dict[int, asyncio.Semaphore] = {}


def _loop_key() -> int:
    try:
        return id(asyncio.get_running_loop())
    except RuntimeError:
        return 0


def get_async_client() -> AsyncOpenAI:
    """Cliente asíncrono compartido (timeout y reintentos desde settings)."""
    if _async_override is not None:
        return _async_override
    key = _loop_key()
    client = _async_clients.get(key)
    if client is None:
        settings = get_settings()
        client = AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_s,
            max_retries=settings.openai_max_retries,
        )
        _async_clients[key] = client
    return client


def get_sync_client() -> OpenAI:
    """Cliente síncrono compartido (ingesta, scripts)."""
    global _sync_client
    with _sync_lock:
        if _sync_client is None:
            settings = get_settings()
            _sync_client = OpenAI(
                api_key=settings.openai_api_key,
                timeout=settings.openai_timeout_s,
                max_retries=settings.openai_max_retries,
            )
        return _sync_client


def openai_semaphore() -> asyncio.Semaphore:
    """Semáforo que limita las llamadas concurrentes al API en este loop."""
    key = _loop_key()
    sem = _semaphores.get(key)
    if sem is None:
        sem = asyncio.Semaphore(max(1, get_settings().openai_concurrency))
        _semaphores[key] = sem
    return sem


@contextlib.asynccontextmanager
async def openai_slot() -> AsyncIterator[None]:
    """`async with openai_slot():` ocupa una plaza del semáforo."""
    sem = openai_semaphore()
    async with sem:
        yield


def set_async_client_for_tests(client: AsyncOpenAI | None) -> None:
    """Inyecta un cliente falso (None restaura el real). Solo tests."""
    global _async_override
    _async_override = client


def reset_clients() -> None:
    """Olvida los clientes y semáforos cacheados (tests, cambio de settings)."""
    global _sync_client, _async_override
    _async_clients.clear()
    _semaphores.clear()
    _async_override = None
    with _sync_lock:
        _sync_client = None
