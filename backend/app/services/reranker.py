"""Reranking listwise con LLM: un solo request JSON reordena los candidatos.

Ante cualquier fallo (API caída, JSON inválido, ranking malformado) se
mantiene el orden original de Qdrant, cortado a top_k.
"""
from __future__ import annotations

import json
import logging

from openai import AsyncOpenAI

from app.config import get_settings
from app.models import Chunk

logger = logging.getLogger(__name__)

_TRUNCATE_CHARS = 600

_SYSTEM_PROMPT = (
    "Eres un reranker de fragmentos de catálogos de productos de protección "
    "contra incendios. Recibes una consulta y una lista de fragmentos "
    "numerados. Devuelve SOLO un objeto JSON con la forma "
    '{"ranking": [índices]} donde "ranking" contiene los índices de TODOS '
    "los fragmentos ordenados de mayor a menor relevancia respecto de la "
    "consulta. No incluyas texto adicional ni explicaciones."
)


def _apply_ranking(ranking: object, chunks: list[Chunk]) -> list[Chunk]:
    """Reordena según `ranking`; índices inválidos o duplicados se ignoran y
    los que falten se anexan al final en su orden original."""
    ordered: list[int] = []
    seen: set[int] = set()
    if isinstance(ranking, list):
        for raw in ranking:
            if isinstance(raw, bool):
                continue
            try:
                idx = int(raw)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(chunks) and idx not in seen:
                seen.add(idx)
                ordered.append(idx)
    ordered.extend(i for i in range(len(chunks)) if i not in seen)
    return [chunks[i] for i in ordered]


async def rerank(query: str, chunks: list[Chunk], top_k: int) -> list[Chunk]:
    """Reordena `chunks` por relevancia frente a `query` y corta a `top_k`.

    Un solo request listwise en JSON mode. Si hay top_k o menos candidatos,
    devuelve directo sin llamar al LLM.
    """
    if len(chunks) <= top_k:
        return chunks

    try:
        settings = get_settings()
        client = AsyncOpenAI(api_key=settings.openai_api_key)

        numbered = "\n\n".join(
            f"[{i}] {chunk.text[:_TRUNCATE_CHARS]}"
            for i, chunk in enumerate(chunks)
        )
        user_prompt = (
            f"Consulta: {query}\n\n"
            f"Fragmentos candidatos ({len(chunks)}):\n{numbered}\n\n"
            'Responde con el JSON {"ranking": [índices en orden de '
            "relevancia descendente]}."
        )

        response = await client.chat.completions.create(
            model=settings.rerank_model_resolved,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
        data = json.loads(response.choices[0].message.content or "")
        reordered = _apply_ranking(data.get("ranking"), chunks)
        return reordered[:top_k]
    except Exception as exc:
        logger.warning(
            "Reranker LLM falló (%s); se mantiene el orden de Qdrant.", exc
        )
        return chunks[:top_k]
