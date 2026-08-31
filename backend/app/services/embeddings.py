"""Embeddings OpenAI con batching y reintentos."""
from __future__ import annotations

import asyncio

from openai import AsyncOpenAI, OpenAI

from app.config import get_settings

_BATCH = 96  # margen bajo el límite de inputs por request


def _client() -> OpenAI:
    return OpenAI(api_key=get_settings().openai_api_key)


def _aclient() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embeddings síncronos para la ingesta (batch)."""
    settings = get_settings()
    client = _client()
    out: list[list[float]] = []
    for i in range(0, len(texts), _BATCH):
        batch = [t.replace("\n", " ")[:8000] or " " for t in texts[i : i + _BATCH]]
        resp = client.embeddings.create(model=settings.embedding_model, input=batch)
        out.extend(d.embedding for d in resp.data)
    return out


async def embed_query(text: str) -> list[float]:
    # Backoff exponencial largo: tras una ingesta masiva la cuenta puede quedar
    # rate-limited (429) durante ~1 min y los reintentos cortos no alcanzan.
    settings = get_settings()
    client = _aclient()
    attempts = 5
    for attempt in range(attempts):
        try:
            resp = await client.embeddings.create(
                model=settings.embedding_model,
                input=[text.replace("\n", " ")[:8000] or " "],
            )
            return resp.data[0].embedding
        except Exception:
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(min(2**attempt * 2.0, 20.0))
    raise RuntimeError("unreachable")
