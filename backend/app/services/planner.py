"""Planificador de evidencia para preguntas complejas.

No responde la pregunta ni aporta conocimiento: solo transforma la petición
del usuario en búsquedas autónomas y en una lista de evidencias que la
respuesta final debe cubrir o declarar ausentes.

El plan ya no es una sugerencia que el agente puede seguir o no: lo ejecuta
código (app/services/evidencia.py), en paralelo y de forma determinista. Por
eso el post-proceso de aquí es estricto: ids por posición, sin consultas
equivalentes y con el ancla `e0` siempre igual a la pregunta literal, para
que la misma pregunta produzca el mismo plan de búsquedas.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from app.config import get_settings
from app.services import telemetry
from app.services.openai_client import (
    crear_completion,
    get_async_client,
    openai_slot,
    razonamiento,
)

logger = logging.getLogger(__name__)

_SYSTEM = """Eres un planificador de recuperación documental científica (literatura
clínica y biomédica). No respondas la pregunta y no inventes hechos. Descompón
la petición en el conjunto mínimo de búsquedas autónomas necesarias para
contestarla por completo. La pregunta literal ya se busca aparte: no la
repitas; aporta las subpreguntas que ella sola no cubre.

Por cada búsqueda devuelve:
- "query": la consulta en el idioma de la pregunta, autosuficiente (sin
  "eso", "ese estudio": nombra el objeto).
- "query_en": la misma consulta con los términos técnicos en inglés (nombre
  del biomarcador, la escala, el fármaco, la población). El corpus es
  mayoritariamente inglés y la coincidencia de palabras no traduce; si la
  pregunta ya está en inglés, repite la query.
- "evidence_needed": el dato concreto que debe encontrarse, con población y
  desenlace cuando aplique (por ejemplo "AUC de p-tau217 plasmático para
  distinguir Alzheimer de otras demencias en la cohorte clínica").

Cuando la pregunta compara estudios, poblaciones, intervenciones o cifras,
busca cada término por separado y añade UNA búsqueda de contradicciones o
matices entre documentos. Si el historial muestra que la pregunta es una
repregunta ("y en la otra cohorte?"), resuelve la referencia con el historial
y escribe consultas completas.

Devuelve solo JSON con esta forma:
{"items":[{"query":"...","query_en":"...","evidence_needed":"..."}]}
Usa entre 1 y el máximo indicado. No incluyas dos consultas equivalentes."""

# Cuántos mensajes del historial se le enseñan al planificador. Bastan para
# resolver una repregunta; más arrastraría temas viejos a preguntas nuevas.
_HISTORIAL_MAX = 4
_HISTORIAL_CHARS = 600

ANCLA_ID = "e0"
ANCLA_EVIDENCE_NEEDED = (
    "respuesta directa a la pregunta tal como la formuló quien pregunta"
)


@dataclass(frozen=True)
class PlanItem:
    id: str
    query: str
    evidence_needed: str
    # Consulta con los términos técnicos en inglés. Vacía = no hay versión
    # distinta (el ancla e0, o una pregunta que ya está en inglés).
    query_en: str = ""


def _clave(texto: str) -> str:
    """Forma normalizada de una consulta para detectar equivalentes."""
    return " ".join(texto.casefold().split())


def _renumerar(items: list[PlanItem]) -> list[PlanItem]:
    """Ids por posición (e1..eN). El id que devuelve el modelo se ignora: dos
    planes con las mismas consultas deben tener los mismos ids."""
    return [
        PlanItem(
            id=f"e{i}",
            query=it.query,
            evidence_needed=it.evidence_needed,
            query_en=it.query_en,
        )
        for i, it in enumerate(items, start=1)
    ]


def _historial_para_prompt(history: list[dict] | None) -> str:
    if not history:
        return ""
    ultimos = [m for m in history if m.get("role") in ("user", "assistant")]
    ultimos = ultimos[-_HISTORIAL_MAX:]
    if not ultimos:
        return ""
    lineas = []
    for m in ultimos:
        quien = "Usuario" if m["role"] == "user" else "Asistente"
        contenido = " ".join(str(m.get("content") or "").split())[:_HISTORIAL_CHARS]
        lineas.append(f"{quien}: {contenido}")
    return "Historial reciente (solo contexto):\n" + "\n".join(lineas) + "\n\n"


async def plan_question(
    question: str, max_items: int = 5, history: list[dict] | None = None
) -> list[PlanItem]:
    """Subpreguntas del plan, SIN el ancla: el llamador la pone con `con_ancla`.

    Ante cualquier fallo (API caída, JSON roto, lista vacía) devuelve `[]`:
    el plan mínimo es la pregunta literal y esa no depende del planificador.
    Usa el modelo grande con razonamiento alto porque es UNA llamada por
    pregunta y de su descomposición depende toda la evidencia.
    """
    settings = get_settings()
    model = settings.openai_model
    tel = telemetry.current()
    started = time.perf_counter()
    max_items = max(1, int(max_items))
    try:
        async with openai_slot():
            response = await crear_completion(
                get_async_client(),
                {
                    "model": model,
                    "temperature": settings.llm_temperature,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": _SYSTEM},
                        {
                            "role": "user",
                            "content": (
                                f"{_historial_para_prompt(history)}"
                                f"Máximo: {max_items}\nPregunta: {question}"
                            ),
                        },
                    ],
                    **razonamiento(settings.planner_reasoning_effort),
                },
            )
        choice = response.choices[0] if response.choices else None
        content = getattr(getattr(choice, "message", None), "content", None)
        data = json.loads(content or "{}")
        raw_items = data.get("items")
        if not isinstance(raw_items, list):
            raise ValueError("respuesta sin lista items")
        # El registro va DESPUÉS de parsear, no antes. Estaba antes con
        # `ok=bool(content)`, así que un JSON malformado dejaba anotada una
        # ronda "ok" y el `except` anotaba otra en fallo: la telemetría
        # mostraba dos rondas contradictorias para una sola llamada, y el
        # análisis de cuánto falla el planificador quedaba inflado en verde.
        tel.record(
            "planner",
            getattr(response, "model", None) or model,
            getattr(response, "usage", None),
            ms=(time.perf_counter() - started) * 1000,
            ok=True,
            finish_reason=getattr(choice, "finish_reason", None),
            note=f"max_items={max_items}",
        )

        items: list[PlanItem] = []
        seen: set[str] = {_clave(question)}
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            query = str(raw.get("query") or "").strip()
            needed = str(raw.get("evidence_needed") or "").strip()
            query_en = str(raw.get("query_en") or "").strip()
            key = _clave(query)
            if not query or key in seen:
                continue
            seen.add(key)
            if _clave(query_en) == key:
                query_en = ""
            items.append(
                PlanItem(
                    id="",
                    query=query,
                    evidence_needed=needed or "evidencia para esta subpregunta",
                    query_en=query_en,
                )
            )
            if len(items) >= max_items:
                break
        return _renumerar(items)
    except Exception as exc:
        # El fallo del planificador no tumba la pregunta: el llamador se queda
        # con el ancla (la pregunta literal) y el fallo queda en telemetría.
        if not any(r.component == "planner" and not r.ok for r in tel.rounds[-1:]):
            tel.record(
                "planner", model, None,
                ms=(time.perf_counter() - started) * 1000,
                ok=False, note=str(exc)[:160],
            )
        logger.warning("Planificador no disponible (%s); se usa la pregunta directa.", exc)
        return []


def con_ancla(question: str, items: list[PlanItem]) -> list[PlanItem]:
    """`[e0] + items`, con e0 = la pregunta literal y los demás renumerados.

    El ancla existe para que la evidencia mínima de cualquier pregunta sea la
    misma con y sin planificador: la búsqueda de la pregunta tal como la
    formuló quien pregunta. Un item equivalente a e0 se descarta.
    """
    ancla = PlanItem(ANCLA_ID, question.strip(), ANCLA_EVIDENCE_NEEDED)
    clave_ancla = _clave(question)
    seen = {clave_ancla}
    resto: list[PlanItem] = []
    for it in items:
        key = _clave(it.query)
        if not key or key in seen:
            continue
        seen.add(key)
        resto.append(it)
    return [ancla] + _renumerar(resto)


def format_checklist(items: list[PlanItem]) -> str:
    """Estructura que debe tener la respuesta: un apartado por punto.

    Ya no es una obligación de buscar (eso lo hace el pipeline): describe qué
    partes debe tener la respuesta para que el modelo redacte por puntos y
    declare los que quedaron sin evidencia. El ancla e0 no se lista porque es
    la pregunta entera, no una parte de ella.
    """
    partes = [it for it in items if it.id != ANCLA_ID]
    if not partes:
        return ""
    rows = "\n".join(f"- {it.evidence_needed}" for it in partes)
    return (
        "ESTRUCTURA DE LA RESPUESTA (los resultados de búsqueda de arriba ya "
        "cubren estos puntos, cada uno con su estado):\n"
        f"{rows}\n"
        "Da el hallazgo de cada punto con su cita; el que esté sin resultados "
        "se declara con la fórmula \"No encuentro X en los documentos\". No "
        "menciones esta lista ni sus identificadores."
    )
