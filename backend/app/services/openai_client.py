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
import logging
import threading
import time
from typing import Any, AsyncIterator

from openai import AsyncOpenAI, BadRequestError, OpenAI

from app.config import get_settings

logger = logging.getLogger(__name__)

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

# Endpoint por defecto, explícito a propósito. Con `base_url=None` el SDK lee
# OPENAI_BASE_URL del entorno por su cuenta Y acepta la cadena vacía como URL
# (medido: `OPENAI_BASE_URL=` deja base_url='' y entonces TODA llamada falla).
# Pasándolo explícito, el endpoint depende solo de settings.openai_base_url,
# que es una sola puerta y se ve en /api/health.
_DEFAULT_BASE_URL = "https://api.openai.com/v1"


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
            base_url=settings.openai_base_url or _DEFAULT_BASE_URL,
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
                base_url=settings.openai_base_url or _DEFAULT_BASE_URL,
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


# --- Razonamiento -----------------------------------------------------------
#
# Hasta el 4 sep 2026 el backend mandaba CERO tokens de razonamiento: una
# nota del 2 sep decía que gpt-5.4 rechazaba `reasoning_effort` junto a
# function tools en /v1/chat/completions, y se apagó en todos los modos. Se
# volvió a medir contra el gateway de Vercel con los kwargs exactos del bucle
# y funciona (ver app/services/modos.py). Pero como ya rompió el modo
# extendido una vez, el parámetro no se manda a ciegas: si la API lo rechaza
# con un 400 que lo nombra, `crear_completion` reintenta sin él y lo deja
# apagado un rato, así el peor caso es volver a la conducta anterior y no
# perder la respuesta.
_razonamiento_rechazado_hasta: float = 0.0
_RAZONAMIENTO_REINTENTO_S = 600.0


def razonamiento(esfuerzo: str | None) -> dict[str, Any]:
    """kwargs de razonamiento para `chat.completions.create`.

    Vacío si el componente no lo pide ("", None o "none") o si la API lo
    rechazó hace menos de `_RAZONAMIENTO_REINTENTO_S` segundos.
    """
    if not esfuerzo or str(esfuerzo).strip().lower() == "none":
        return {}
    if time.monotonic() < _razonamiento_rechazado_hasta:
        return {}
    return {"reasoning_effort": str(esfuerzo).strip().lower()}


def _es_rechazo_de_razonamiento(exc: BaseException) -> bool:
    return isinstance(exc, BadRequestError) and "reasoning" in str(exc).lower()


def razonamiento_rechazado() -> bool:
    """Si el razonamiento está apagado por un rechazo reciente de la API."""
    return time.monotonic() < _razonamiento_rechazado_hasta


def _reset_razonamiento() -> None:
    """Solo tests."""
    global _razonamiento_rechazado_hasta
    _razonamiento_rechazado_hasta = 0.0


async def crear_completion(client: Any, kwargs: dict[str, Any]) -> Any:
    """`client.chat.completions.create(**kwargs)` con el fallback de razonamiento.

    Si la petición lleva `reasoning_effort` y la API la rechaza con un 400
    que lo nombra, se anota el rechazo, se reintenta UNA vez sin el parámetro
    y se cuenta en telemetría (`razonamiento_rechazado`). Cualquier otro
    error sube tal cual. No ocupa plaza del semáforo: eso lo hace el llamador,
    que sabe si la plaza debe durar todo el stream o solo la petición.
    """
    try:
        return await client.chat.completions.create(**kwargs)
    except BadRequestError as exc:
        if "reasoning_effort" not in kwargs or not _es_rechazo_de_razonamiento(exc):
            raise
        global _razonamiento_rechazado_hasta
        _razonamiento_rechazado_hasta = time.monotonic() + _RAZONAMIENTO_REINTENTO_S
        logger.warning(
            "La API rechazó reasoning_effort=%r (%s); se reintenta sin él y "
            "queda apagado %d s.",
            kwargs.get("reasoning_effort"), str(exc)[:160], int(_RAZONAMIENTO_REINTENTO_S),
        )
        # Import tardío: telemetry no depende de este módulo, pero se evita
        # crear un ciclo si algún día lo hace.
        from app.services import telemetry

        telemetry.current().incr("razonamiento_rechazado")
        sin = {k: v for k, v in kwargs.items() if k != "reasoning_effort"}
        return await client.chat.completions.create(**sin)
