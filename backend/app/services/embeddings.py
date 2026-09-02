"""Embeddings OpenAI con batching, reintentos y telemetría."""
from __future__ import annotations

import asyncio
import logging
import time

from app.config import get_settings
from app.services import telemetry
from app.services.openai_client import get_async_client, get_sync_client, openai_slot

logger = logging.getLogger(__name__)

_BATCH = 96  # margen bajo el límite de inputs por request
_ATTEMPTS = 5


def _prepare(text: str) -> str:
    return text.replace("\n", " ")[:8000] or " "


def _backoff(attempt: int) -> float:
    # Backoff exponencial largo: tras una ingesta masiva la cuenta puede quedar
    # rate-limited (429) durante ~1 min y los reintentos cortos no alcanzan.
    return min(2**attempt * 2.0, 20.0)


def _no_retry(exc: BaseException) -> bool:
    """True si reintentar no puede arreglar el error: se propaga de inmediato.

    Sin reintento: autenticación (clave inválida o revocada), 429 de cuota o
    facturación (`insufficient_quota`/`billing` en código, cuerpo o mensaje)
    y cualquier otro 4xx (petición mal formada, modelo inexistente...). Sí se
    reintenta el 429 puntual por RPM/TPM, los 5xx y los errores de red.
    """
    try:
        import openai
    except ImportError:  # sin SDK no hay cómo clasificar: reintentar
        return False
    if isinstance(exc, openai.AuthenticationError):
        return True
    if not isinstance(exc, openai.APIStatusError):
        return False  # red, timeout: transitorios
    status = getattr(exc, "status_code", None) or 0
    if status == 429:
        blob = " ".join(
            str(x) for x in (exc, getattr(exc, "code", ""), getattr(exc, "body", ""))
        ).lower()
        return "insufficient_quota" in blob or "billing" in blob
    return 400 <= status < 500


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embeddings síncronos para la ingesta (batch), con los mismos
    reintentos que `embed_query`: antes un 429 a mitad de archivo tumbaba la
    ingesta entera. Los errores no transitorios (`_no_retry`) se propagan al
    primer intento."""
    settings = get_settings()
    client = get_sync_client()
    tel = telemetry.current()
    out: list[list[float]] = []
    for i in range(0, len(texts), _BATCH):
        batch = [_prepare(t) for t in texts[i : i + _BATCH]]
        for attempt in range(_ATTEMPTS):
            t0 = time.perf_counter()
            try:
                resp = client.embeddings.create(model=settings.embedding_model, input=batch)
            except Exception as exc:
                tel.record(
                    "embeddings", settings.embedding_model, None,
                    ms=(time.perf_counter() - t0) * 1000.0, ok=False, note=str(exc)[:120],
                )
                if attempt == _ATTEMPTS - 1 or _no_retry(exc):
                    raise
                wait = _backoff(attempt)
                logger.warning(
                    "embed_texts lote %d falló (%s); reintento %d/%d en %.0fs",
                    i // _BATCH, exc, attempt + 1, _ATTEMPTS - 1, wait,
                )
                time.sleep(wait)
                continue
            tel.record(
                "embeddings", settings.embedding_model, getattr(resp, "usage", None),
                ms=(time.perf_counter() - t0) * 1000.0,
            )
            out.extend(d.embedding for d in resp.data)
            break
    return out


async def embed_query(text: str) -> list[float]:
    """Embedding de una consulta, con backoff para errores transitorios; los
    no transitorios (`_no_retry`) se propagan al primer intento."""
    settings = get_settings()
    client = get_async_client()
    tel = telemetry.current()
    for attempt in range(_ATTEMPTS):
        t0 = time.perf_counter()
        try:
            async with openai_slot():
                resp = await client.embeddings.create(
                    model=settings.embedding_model, input=[_prepare(text)]
                )
        except Exception as exc:
            tel.record(
                "embeddings", settings.embedding_model, None,
                ms=(time.perf_counter() - t0) * 1000.0, ok=False, note=str(exc)[:120],
            )
            if attempt == _ATTEMPTS - 1 or _no_retry(exc):
                raise
            await asyncio.sleep(_backoff(attempt))
            continue
        tel.record(
            "embeddings", settings.embedding_model, getattr(resp, "usage", None),
            ms=(time.perf_counter() - t0) * 1000.0,
        )
        return resp.data[0].embedding
    raise RuntimeError("unreachable")
