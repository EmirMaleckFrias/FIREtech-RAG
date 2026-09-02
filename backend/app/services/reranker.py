"""Reranking listwise con LLM: un solo request JSON reordena los candidatos.

Ante cualquier fallo (API caída, JSON inválido, ranking malformado) se
mantiene el orden original de Qdrant, cortado a top_k.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from app.config import get_settings
from app.models import Chunk
from app.services import telemetry
from app.services.openai_client import get_async_client, openai_slot

logger = logging.getLogger(__name__)


async def _json_completion(messages: list[dict], note: str) -> dict:
    """Una llamada JSON al modelo de rerank, bajo el semáforo y con usage
    registrado en la telemetría del request (componente `reranker`)."""
    settings = get_settings()
    model = settings.rerank_model_resolved
    tel = telemetry.current()
    t0 = time.perf_counter()
    try:
        async with openai_slot():
            resp = await get_async_client().chat.completions.create(
                model=model,
                response_format={"type": "json_object"},
                messages=messages,
            )
    except Exception as exc:
        tel.record(
            "reranker", model, None, ms=(time.perf_counter() - t0) * 1000.0,
            ok=False, note=f"{note}: {str(exc)[:120]}",
        )
        raise
    choice = resp.choices[0] if resp.choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    tel.record(
        "reranker", getattr(resp, "model", None) or model, getattr(resp, "usage", None),
        ms=(time.perf_counter() - t0) * 1000.0, ok=bool(content),
        finish_reason=getattr(choice, "finish_reason", None),
        note=note if content else f"{note}: respuesta sin contenido",
    )
    if not content:
        # Sin choices o content None (refusal, content_filter): antes devolvía
        # {} en silencio y el caller creía que el modelo había respondido.
        # Al lanzar, rerank/filter_relevant caen a su fallback con log.
        raise ValueError("respuesta sin contenido")
    return json.loads(content)

_TRUNCATE_CHARS = 600

_SYSTEM_PROMPT = (
    "Eres un reranker de fragmentos de documentos. Recibes una consulta y una "
    "lista de fragmentos numerados. Devuelve SOLO un objeto JSON con la forma "
    '{"ranking": [índices]} donde "ranking" contiene los índices de TODOS '
    "los fragmentos ordenados de mayor a menor relevancia respecto de la "
    "consulta. Ordena por cuánta evidencia aporta el fragmento para responder "
    "la consulta, no por parecido de palabras. No incluyas texto adicional ni "
    "explicaciones."
)

_FILTER_SYSTEM_PROMPT = (
    "Decides qué fragmentos de documentos sirven de evidencia para una "
    "consulta. Recibes la consulta y una lista de fragmentos numerados. "
    'Devuelve SOLO un objeto JSON {"relevantes": [índices]} con los índices '
    "de los fragmentos que contienen información que ayuda a responder la "
    "consulta, aunque sea parcialmente. Incluye el fragmento si aporta un "
    "dato, una definición, una cifra, un método o un resultado sobre el tema "
    "preguntado. Excluye solo los que hablan de otro tema, los que son "
    "índices, portadas, bibliografías o encabezados sin contenido, y los que "
    "se limitan a mencionar el tema de pasada sin decir nada de él. Si "
    "NINGUNO sirve, devuelve la lista vacía: es una respuesta legítima y "
    "necesaria, porque quien pregunta debe poder saber que el índice no tiene "
    "esa información. Ante la duda sobre un fragmento que parece aportar "
    "algo, inclúyelo."
)

_FILTER_TRUNCATE_CHARS = 450


@dataclass(frozen=True)
class RelevanceOutcome:
    """Resultado del filtro de relevancia, con tres estados distinguibles.

    - `kept` con elementos y `verificado=True`: esos fragmentos sirven.
    - `kept` vacío y `verificado=True`: el modelo dijo que NINGUNO sirve. Es
      información real y hay que pasarla al agente para que responda que no
      encuentra nada, en vez de entregarle fragmentos de otro tema.
    - `verificado=False`: el filtro no se pudo aplicar (API caída, JSON roto).
      `kept` trae los fragmentos sin filtrar y nadie debe concluir nada de
      que no se hayan descartado.
    """

    kept: list[Chunk]
    verificado: bool
    motivo: str


async def filter_relevant(query: str, chunks: list[Chunk]) -> RelevanceOutcome:
    """Filtro binario de relevancia por fragmento.

    A diferencia del ranking listwise, clasificar sí/no por ítem es fiable
    con listas grandes y PRESERVA el orden de entrada en la salida.
    """
    if not chunks:
        return RelevanceOutcome([], True, "sin candidatos")
    if len(chunks) == 1:
        # Con un solo candidato no vale la pena una llamada, pero tampoco se
        # puede afirmar que sea relevante: queda sin verificar.
        return RelevanceOutcome(list(chunks), False, "un solo candidato, no se filtra")

    numbered = "\n".join(
        f"[{i}] {c.text[:_FILTER_TRUNCATE_CHARS]}" for i, c in enumerate(chunks)
    )
    try:
        data = await _json_completion(
            [
                {"role": "system", "content": _FILTER_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"Consulta: {query}\n\nFragmentos:\n{numbered}",
                },
            ],
            note=f"filter_relevant n={len(chunks)}",
        )
        raw = data.get("relevantes")
        if not isinstance(raw, list):
            raise ValueError("respuesta sin lista 'relevantes'")
        keep: set[int] = set()
        for r in raw:
            if isinstance(r, bool):
                continue
            try:
                idx = int(r)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(chunks):
                keep.add(idx)
        return RelevanceOutcome(
            [c for i, c in enumerate(chunks) if i in keep],
            True,
            f"{len(keep)} de {len(chunks)} fragmentos aportan evidencia",
        )
    except Exception as exc:
        logger.warning("filter_relevant falló (%s); se continúa sin filtrar.", exc)
        return RelevanceOutcome(list(chunks), False, f"filtro no aplicado: {exc}")


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

        data = await _json_completion(
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            note=f"rerank n={len(chunks)} top_k={top_k}",
        )
        reordered = _apply_ranking(data.get("ranking"), chunks)
        return reordered[:top_k]
    except Exception as exc:
        logger.warning(
            "Reranker LLM falló (%s); se mantiene el orden de Qdrant.", exc
        )
        return chunks[:top_k]
