"""Telemetría por pregunta: tokens, tiempos y coste estimado por componente.

Un objeto `Telemetry` se fija UNA vez por request (`start()`), viaja en un
ContextVar y lo leen todos los servicios que llaman a OpenAI (agente,
reranker, embeddings) para anotar cada ronda con el `usage` real que devuelve
el API. `asyncio.to_thread` copia el contexto, así que dentro de un hilo solo
se llaman métodos del objeto; nunca `set()`.

El resumen (`summary()`) sale por SSE como evento `metrics` antes de `done`,
lo consumen los evals y, cuando exista la migración 009, se persistirá con el
mensaje.

Toda cifra en USD que sale de aquí es una ESTIMACIÓN con tarifas asumidas
(`ASSUMED_PRICES`), y así hay que etiquetarla siempre.
"""
from __future__ import annotations

import contextvars
import time
from dataclasses import asdict, dataclass, field
from typing import Any

# (entrada, entrada cacheada, salida) en USD por millón de tokens.
# Tarifas ASUMIDAS a 1 de septiembre de 2026; la entrada cacheada se asume al
# 10 % de la entrada normal. Sustituir por las oficiales cuando se confirmen.
ASSUMED_PRICES: dict[str, tuple[float, float, float]] = {
    "gpt-5.4": (1.25, 0.125, 10.00),
    "gpt-5.4-mini": (0.25, 0.025, 2.00),
    "text-embedding-3-large": (0.13, 0.13, 0.0),
}

PRICING_LABEL = "estimado, tarifas asumidas"

COMPONENTS = ("agente", "reranker", "embeddings", "juez")


def price_for(model: str) -> tuple[float, float, float] | None:
    """Tarifa del modelo (acepta snapshots tipo 'gpt-5.4-2026-03-01'):
    gana la clave más larga que sea prefijo del nombre."""
    best: str | None = None
    for key in ASSUMED_PRICES:
        if model == key or model.startswith(key + "-"):
            if best is None or len(key) > len(best):
                best = key
    return ASSUMED_PRICES[best] if best else None


def cost_estimate(by_model: dict[str, dict[str, int]]) -> float:
    """USD estimados a partir de {modelo: {prompt, cached, completion}}.

    Coste = (prompt - cached) * entrada + cached * entrada_cacheada +
            completion * salida, todo / 1e6. `completion` ya incluye los
    tokens de razonamiento (así los reporta el API). Modelos sin tarifa
    conocida suman 0 y quedan listados en `unknown_models` del resumen.
    """
    total = 0.0
    for model, t in by_model.items():
        price = price_for(model)
        if price is None:
            continue
        p_in, p_cached, p_out = price
        prompt = int(t.get("prompt", 0))
        cached = min(int(t.get("cached", 0)), prompt)
        completion = int(t.get("completion", 0))
        total += (prompt - cached) * p_in + cached * p_cached + completion * p_out
    return total / 1_000_000


def usage_to_dict(usage: Any) -> dict[str, int]:
    """Normaliza el `usage` del SDK (o un dict) a prompt/cached/completion/
    reasoning. Tolera None y campos ausentes (chunks sin usage, embeddings)."""
    if usage is None:
        return {"prompt": 0, "cached": 0, "completion": 0, "reasoning": 0}

    def _get(obj: Any, name: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(name)
        return getattr(obj, name, None)

    prompt = int(_get(usage, "prompt_tokens") or 0)
    completion = int(_get(usage, "completion_tokens") or 0)
    p_details = _get(usage, "prompt_tokens_details")
    c_details = _get(usage, "completion_tokens_details")
    cached = int(_get(p_details, "cached_tokens") or 0) if p_details else 0
    reasoning = int(_get(c_details, "reasoning_tokens") or 0) if c_details else 0
    return {
        "prompt": prompt,
        "cached": min(cached, prompt),
        "completion": completion,
        "reasoning": reasoning,
    }


@dataclass
class LLMRound:
    """Una llamada al API (una ronda del agente, un rerank, un embed)."""

    component: str
    model: str
    prompt: int = 0
    cached: int = 0
    completion: int = 0
    reasoning: int = 0
    ms: float = 0.0
    ok: bool = True
    finish_reason: str | None = None
    note: str = ""


@dataclass
class Telemetry:
    """Acumulador mutable de una pregunta. Fijar con `start()`, leer con
    `current()`; los servicios llaman `record(...)`, `incr(...)`, `mark(...)`."""

    rounds: list[LLMRound] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=dict)
    marks: dict[str, float] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    started_at: float = field(default_factory=time.perf_counter)

    # -- registro -----------------------------------------------------------
    def record(
        self,
        component: str,
        model: str,
        usage: Any = None,
        ms: float = 0.0,
        ok: bool = True,
        finish_reason: str | None = None,
        note: str = "",
    ) -> LLMRound:
        u = usage_to_dict(usage)
        rnd = LLMRound(
            component=component,
            model=model,
            prompt=u["prompt"],
            cached=u["cached"],
            completion=u["completion"],
            reasoning=u["reasoning"],
            ms=round(ms, 1),
            ok=ok,
            finish_reason=finish_reason,
            note=note,
        )
        self.rounds.append(rnd)
        return rnd

    def incr(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n

    def mark(self, name: str, value: float | None = None) -> None:
        """Marca temporal en ms desde el inicio (o un valor explícito)."""
        if value is None:
            value = (time.perf_counter() - self.started_at) * 1000.0
        self.marks[name] = round(value, 1)

    def set_meta(self, **kw: Any) -> None:
        """Datos de contexto (prompt_version, modelo, modo de retrieval...);
        no pisa claves ya fijadas por quien llamó `start()`."""
        for k, v in kw.items():
            self.meta.setdefault(k, v)

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self.started_at) * 1000.0, 1)

    # -- agregados ----------------------------------------------------------
    def by_component(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for r in self.rounds:
            agg = out.setdefault(
                r.component,
                {"rounds": 0, "prompt": 0, "cached": 0, "completion": 0,
                 "reasoning": 0, "ms": 0.0, "errors": 0},
            )
            agg["rounds"] += 1
            agg["prompt"] += r.prompt
            agg["cached"] += r.cached
            agg["completion"] += r.completion
            agg["reasoning"] += r.reasoning
            agg["ms"] = round(agg["ms"] + r.ms, 1)
            if not r.ok:
                agg["errors"] += 1
        return out

    def by_model(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for r in self.rounds:
            agg = out.setdefault(
                r.model, {"prompt": 0, "cached": 0, "completion": 0, "reasoning": 0}
            )
            agg["prompt"] += r.prompt
            agg["cached"] += r.cached
            agg["completion"] += r.completion
            agg["reasoning"] += r.reasoning
        return out

    def totals(self) -> dict[str, int]:
        t = {"prompt": 0, "cached": 0, "completion": 0, "reasoning": 0}
        for r in self.rounds:
            t["prompt"] += r.prompt
            t["cached"] += r.cached
            t["completion"] += r.completion
            t["reasoning"] += r.reasoning
        return t

    def cost_estimate(self) -> float:
        return cost_estimate(self.by_model())

    def summary(self) -> dict[str, Any]:
        """Payload serializable (evento SSE `metrics`, evals, futura columna
        `chat_messages.metrics`)."""
        by_model = self.by_model()
        totals = self.totals()
        agent_rounds = [r for r in self.rounds if r.component == "agente"]
        cached_ratio = (
            round(totals["cached"] / totals["prompt"], 4) if totals["prompt"] else 0.0
        )
        return {
            "ms_total": self.elapsed_ms(),
            "rounds_total": len(self.rounds),
            "agent_rounds": len(agent_rounds),
            "tokens": totals,
            "cached_ratio": cached_ratio,
            "by_component": self.by_component(),
            "by_model": by_model,
            "cost_usd": round(cost_estimate(by_model), 6),
            "cost_label": PRICING_LABEL,
            "unknown_models": sorted(m for m in by_model if price_for(m) is None),
            "counters": dict(self.counters),
            "marks": dict(self.marks),
            "meta": dict(self.meta),
            "rounds": [asdict(r) for r in self.rounds],
        }


class _NullTelemetry(Telemetry):
    """Sumidero cuando nadie llamó `start()` (scripts, tests sin contexto):
    acepta llamadas y no guarda nada, así los servicios no necesitan ifs."""

    def record(self, *args: Any, **kwargs: Any) -> LLMRound:  # type: ignore[override]
        return LLMRound(component="", model="")

    def incr(self, name: str, n: int = 1) -> None:
        return None

    def mark(self, name: str, value: float | None = None) -> None:
        return None

    def set_meta(self, **kw: Any) -> None:
        return None


_NULL = _NullTelemetry()

_current: contextvars.ContextVar[Telemetry | None] = contextvars.ContextVar(
    "telemetry", default=None
)


def start(**meta: Any) -> Telemetry:
    """Crea y fija la telemetría del request actual. Llamar una sola vez por
    pregunta, en la corrutina raíz (el handler o el runner de evals)."""
    tel = Telemetry(meta=dict(meta))
    _current.set(tel)
    return tel


def current() -> Telemetry:
    """Telemetría del contexto actual, o un sumidero si no hay ninguna.
    Nunca devuelve None: los servicios llaman métodos directamente."""
    tel = _current.get()
    return tel if tel is not None else _NULL


def active() -> Telemetry | None:
    """Como `current()` pero devuelve None si no hay telemetría fijada."""
    return _current.get()


def clear() -> None:
    _current.set(None)


class timer:
    """`with timer() as t: ...; t.ms` mide un bloque en milisegundos."""

    def __enter__(self) -> "timer":
        self._t0 = time.perf_counter()
        self.ms = 0.0
        return self

    def __exit__(self, *exc: Any) -> None:
        self.ms = (time.perf_counter() - self._t0) * 1000.0
