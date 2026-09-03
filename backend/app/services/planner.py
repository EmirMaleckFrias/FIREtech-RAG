"""Planificador de evidencia para preguntas complejas.

No responde la pregunta ni aporta conocimiento: solo transforma la petición
del usuario en búsquedas autónomas y en una lista de evidencias que la
respuesta final debe cubrir o declarar ausentes.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from app.config import get_settings
from app.services import telemetry
from app.services.openai_client import get_async_client, openai_slot

logger = logging.getLogger(__name__)

_SYSTEM = """Eres un planificador de recuperación documental científica.
No respondas la pregunta y no inventes hechos. Descompón la petición en el
conjunto mínimo de búsquedas autónomas necesarias para contestarla por
completo. Una comparación debe buscar cada estudio, población, intervención o
resultado por separado; añade una búsqueda de contradicciones cuando proceda.
Devuelve solo JSON con esta forma:
{"items":[{"id":"e1","query":"consulta autosuficiente","evidence_needed":"qué dato debe encontrarse"}]}
Usa entre 1 y el máximo indicado. No incluyas dos consultas equivalentes."""


@dataclass(frozen=True)
class PlanItem:
    id: str
    query: str
    evidence_needed: str


async def plan_question(question: str, max_items: int = 5) -> list[PlanItem]:
    settings = get_settings()
    model = settings.rerank_model_resolved
    tel = telemetry.current()
    started = time.perf_counter()
    try:
        async with openai_slot():
            response = await get_async_client().chat.completions.create(
                model=model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {
                        "role": "user",
                        "content": f"Máximo: {max_items}\nPregunta: {question}",
                    },
                ],
            )
        choice = response.choices[0] if response.choices else None
        content = getattr(getattr(choice, "message", None), "content", None)
        tel.record(
            "planner",
            getattr(response, "model", None) or model,
            getattr(response, "usage", None),
            ms=(time.perf_counter() - started) * 1000,
            ok=bool(content),
            finish_reason=getattr(choice, "finish_reason", None),
            note=f"max_items={max_items}",
        )
        data = json.loads(content or "{}")
        raw_items = data.get("items")
        if not isinstance(raw_items, list):
            raise ValueError("respuesta sin lista items")

        items: list[PlanItem] = []
        seen: set[str] = set()
        for index, raw in enumerate(raw_items[:max_items], start=1):
            if not isinstance(raw, dict):
                continue
            query = str(raw.get("query") or "").strip()
            needed = str(raw.get("evidence_needed") or "").strip()
            key = " ".join(query.casefold().split())
            if not query or key in seen:
                continue
            seen.add(key)
            items.append(
                PlanItem(
                    id=str(raw.get("id") or f"e{index}"),
                    query=query,
                    evidence_needed=needed or "evidencia para esta subpregunta",
                )
            )
        if not items:
            raise ValueError("el plan quedó vacío")
        return items
    except Exception as exc:
        # El fallo del planificador no tumba la pregunta. Una búsqueda directa
        # mantiene el comportamiento anterior y queda visible en telemetría.
        if not any(r.component == "planner" and not r.ok for r in tel.rounds[-1:]):
            tel.record(
                "planner", model, None,
                ms=(time.perf_counter() - started) * 1000,
                ok=False, note=str(exc)[:160],
            )
        logger.warning("Planificador no disponible (%s); se usa la pregunta directa.", exc)
        return [PlanItem("e1", question, "evidencia directa para responder la pregunta")]


def format_checklist(items: list[PlanItem]) -> str:
    rows = "\n".join(
        f"- {item.id}: {item.evidence_needed} (búsqueda: {item.query})"
        for item in items
    )
    return (
        "PLAN DE EVIDENCIA OBLIGATORIO:\n"
        f"{rows}\n"
        "Antes de concluir, cubre cada punto con los resultados recuperados. "
        "Si uno no aparece, dilo explícitamente; nunca rellenes el hueco."
    )
