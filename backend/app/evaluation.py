"""Evaluación determinista del RAG contra casos revisados por especialistas.

Este módulo no llama a modelos. Comprueba propiedades que pueden verificarse
sin un juez probabilístico: cobertura de las evidencias esperadas, resolución
de citas, conceptos cubiertos por los hops, contenido obligatorio/prohibido y
abstención. Mantener esta capa determinista evita que un LLM juez esconda una
regresión crítica detrás de una puntuación subjetiva.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class ExpectedSource(BaseModel):
    """Una ubicación aceptable para demostrar una evidencia."""

    file: str
    pages: list[int] = Field(default_factory=list)
    section_patterns: list[str] = Field(default_factory=list)
    locator_patterns: list[str] = Field(default_factory=list)


class EvidenceRequirement(BaseModel):
    """Pieza de evidencia que debe aparecer en la recuperación."""

    id: str
    description: str
    # Cualquiera de estas fuentes satisface el requisito.
    sources: list[ExpectedSource] = Field(min_length=1)


class EvalCase(BaseModel):
    """Caso del benchmark, escrito y revisado por el equipo investigador."""

    id: str
    question: str
    mode: Literal["normal", "extendido"] = "extendido"
    category: str = "single_hop"
    critical: bool = True
    min_hops: int = Field(default=1, ge=0)
    evidence: list[EvidenceRequirement] = Field(default_factory=list)
    hop_patterns: list[str] = Field(default_factory=list)
    answer_must_contain: list[str] = Field(default_factory=list)
    answer_must_not_contain: list[str] = Field(default_factory=list)
    expect_abstention: bool = False
    # Fidelidad de atribución mínima exigida a este caso (0..1), o None para no
    # exigir ninguna. La MIDE el verificador en runtime
    # (app/services/verificador.py) y viaja en el resumen de telemetría; aquí
    # solo se lee. Es deliberado: el juicio afirmación-por-afirmación es una
    # función del producto, no del benchmark, así que este módulo sigue siendo
    # 100% determinista y no introduce un LLM juez que pueda esconder fallos.
    min_faithfulness: float | None = Field(default=None, ge=0.0, le=1.0)
    notes: str = ""

    @model_validator(mode="after")
    def _coherent(self) -> "EvalCase":
        if self.expect_abstention and self.evidence:
            raise ValueError("un caso de abstención no puede exigir evidencias")
        if not self.expect_abstention and not self.evidence:
            raise ValueError("un caso factual debe declarar al menos una evidencia")
        return self


# Público a propósito: `app.services.verificador` usa EXACTAMENTE este
# patrón para trocear la respuesta en caliente. Si la verificación de
# runtime y la medición offline contaran citas distintas, el benchmark
# dejaría de describir lo que hace producción.
CITATION_RE = re.compile(
    r"\[[^\[\]\n]+,\s*(?:p[aá]g\.?|secci[oó]n:|fila|tabla|fragmento)\s*[^\[\]\n]+\]",
    re.IGNORECASE,
)
# Público a propósito, igual que CITATION_RE: `app.services.verificador`
# usa EXACTAMENTE estos patrones para distinguir una abstención legítima
# (que no lleva citas por definición) de una respuesta factual que no citó
# nada, que es el peor caso posible. Si runtime y benchmark discreparan en
# qué cuenta como abstención, medirían cosas distintas.
ABSTENTION_PATTERNS = (
    r"no (?:lo |la )?encuentro",
    r"no (?:aparece|figura|consta)",
    r"no hay (?:evidencia|informaci[oó]n|datos)",
    r"los documentos no (?:indican|mencionan|contienen|permiten)",
)


def load_cases(path: Path) -> list[EvalCase]:
    """Carga JSONL con errores que señalan exactamente archivo y línea."""
    cases: list[EvalCase] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            try:
                case = EvalCase.model_validate(json.loads(line))
            except Exception as exc:
                raise ValueError(f"{path}:{lineno}: {exc}") from exc
            if case.id in seen:
                raise ValueError(f"{path}:{lineno}: id duplicado: {case.id}")
            seen.add(case.id)
            cases.append(case)
    if not cases:
        raise ValueError(f"{path}: el benchmark no contiene casos")
    return cases


def _matches(pattern: str, text: str) -> bool:
    try:
        return re.search(pattern, text, re.IGNORECASE | re.DOTALL) is not None
    except re.error as exc:
        raise ValueError(f"regex inválida {pattern!r}: {exc}") from exc


def _source_citation(source: dict[str, Any]) -> str:
    name = str(source.get("citation") or source.get("source_file") or "").strip()
    locator = str(source.get("locator") or "").strip()
    if not locator:
        page = source.get("page")
        locator = f"pág. {page}" if page else ""
    return f"[{name}, {locator}]" if name and locator else ""


def _source_matches(expected: ExpectedSource, source: dict[str, Any]) -> bool:
    actual_file = Path(str(source.get("source_file") or "")).name.casefold()
    if actual_file != Path(expected.file).name.casefold():
        return False

    if expected.pages:
        actual_pages = set(source.get("source_pages") or [])
        if source.get("page") is not None:
            actual_pages.add(source["page"])
        if not actual_pages.intersection(expected.pages):
            return False

    section = str(source.get("section") or "")
    if expected.section_patterns and not any(
        _matches(pattern, section) for pattern in expected.section_patterns
    ):
        return False

    locator = str(source.get("locator") or "")
    if expected.locator_patterns and not any(
        _matches(pattern, locator) for pattern in expected.locator_patterns
    ):
        return False
    return True


def score_case(case: EvalCase, result: dict[str, Any]) -> dict[str, Any]:
    """Puntúa una respuesta capturada del stream de ``POST /api/chat``."""
    answer = str(result.get("answer") or result.get("respuesta") or "")
    sources = result.get("sources") or result.get("fuentes") or []
    hops = result.get("hops") or []
    error = result.get("error")
    failures: list[str] = []

    evidence_rows: list[dict[str, Any]] = []
    for requirement in case.evidence:
        matched = [
            str(source.get("source_file") or "")
            for source in sources
            if any(_source_matches(option, source) for option in requirement.sources)
        ]
        ok = bool(matched)
        evidence_rows.append(
            {
                "id": requirement.id,
                "description": requirement.description,
                "found": ok,
                "matched_sources": sorted(set(matched)),
            }
        )
        if not ok:
            failures.append(f"evidencia no recuperada: {requirement.id}")

    evidence_recall = (
        sum(1 for row in evidence_rows if row["found"]) / len(evidence_rows)
        if evidence_rows
        else 1.0
    )

    hop_text = "\n".join(str(hop.get("query") or "") for hop in hops)
    missing_hop_patterns = [p for p in case.hop_patterns if not _matches(p, hop_text)]
    if len(hops) < case.min_hops:
        failures.append(f"hops insuficientes: {len(hops)} < {case.min_hops}")
    if missing_hop_patterns:
        failures.append("conceptos ausentes en búsquedas: " + ", ".join(missing_hop_patterns))

    missing_answer_patterns = [
        pattern for pattern in case.answer_must_contain if not _matches(pattern, answer)
    ]
    forbidden_answer_patterns = [
        pattern for pattern in case.answer_must_not_contain if _matches(pattern, answer)
    ]
    if missing_answer_patterns:
        failures.append("respuesta incompleta: " + ", ".join(missing_answer_patterns))
    if forbidden_answer_patterns:
        failures.append("contenido prohibido: " + ", ".join(forbidden_answer_patterns))

    abstained = any(_matches(pattern, answer) for pattern in ABSTENTION_PATTERNS)
    if case.expect_abstention and not abstained:
        failures.append("debía abstenerse y no lo hizo")
    if not case.expect_abstention and abstained:
        failures.append("se abstuvo en un caso con evidencia esperada")

    citation_tokens = CITATION_RE.findall(answer)
    resolvable = {_source_citation(source).casefold() for source in sources}
    unresolved_citations = [
        token for token in citation_tokens if token.casefold() not in resolvable
    ]
    citation_precision = (
        (len(citation_tokens) - len(unresolved_citations)) / len(citation_tokens)
        if citation_tokens
        else (1.0 if case.expect_abstention else 0.0)
    )
    if unresolved_citations:
        failures.append("citas no resolubles: " + ", ".join(unresolved_citations))
    if not case.expect_abstention and not citation_tokens:
        failures.append("respuesta factual sin citas")
    if error:
        failures.append(f"error de ejecución: {error}")

    # Fidelidad de atribución, tal como la dictaminó el verificador durante la
    # corrida. Ausente = la verificación estaba apagada: entonces no se mide y
    # tampoco se penaliza, pero queda visible como None en vez de como 1.0.
    verificacion = ((result.get("metrics") or {}).get("meta") or {}).get("verificacion") or {}
    faithfulness = verificacion.get("fidelidad")
    no_sostenidas = int(verificacion.get("no_sostenidas") or 0)
    sin_verificar = int(verificacion.get("sin_verificar") or 0)
    if no_sostenidas:
        # Una atribución que su propio fragmento no sostiene es un fallo duro,
        # no un punto menos de nota: quien investiga no puede usar ese dato.
        failures.append(
            f"{no_sostenidas} afirmación(es) que su fragmento citado no sostiene"
        )
    if case.min_faithfulness is not None:
        if faithfulness is None:
            failures.append(
                "el caso exige fidelidad mínima pero la verificación no la midió"
            )
        elif faithfulness < case.min_faithfulness:
            failures.append(
                f"fidelidad {faithfulness:.2f} por debajo del mínimo "
                f"{case.min_faithfulness:.2f}"
            )

    return {
        "id": case.id,
        "passed": not failures,
        "critical": case.critical,
        "category": case.category,
        "failures": failures,
        "evidence": evidence_rows,
        "metrics": {
            "evidence_recall": round(evidence_recall, 4),
            "citation_precision": round(citation_precision, 4),
            "hops": len(hops),
            "hop_pattern_coverage": round(
                1 - len(missing_hop_patterns) / len(case.hop_patterns), 4
            ) if case.hop_patterns else 1.0,
            "answer_pattern_coverage": round(
                1 - len(missing_answer_patterns) / len(case.answer_must_contain), 4
            ) if case.answer_must_contain else 1.0,
            "abstained": abstained,
            # None cuando no se verificó: 0.0 diría "todo mal" y sería mentira.
            "faithfulness": round(faithfulness, 4) if faithfulness is not None else None,
            "unsupported_claims": no_sostenidas,
            "unverified_claims": sin_verificar,
        },
    }


def summarize(scored: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    """Agrega sin esconder fallos críticos detrás de un promedio."""
    if not scored:
        raise ValueError("no hay resultados que resumir")
    n = len(scored)
    critical_failures = [row["id"] for row in scored if row["critical"] and not row["passed"]]
    costs = [float((r.get("metrics") or {}).get("cost_usd") or r.get("coste_usd") or 0) for r in results]
    latencies = [float((r.get("metrics") or {}).get("ms_total") or 0) for r in results]
    by_category: dict[str, dict[str, int]] = {}
    for row in scored:
        bucket = by_category.setdefault(row["category"], {"total": 0, "passed": 0})
        bucket["total"] += 1
        bucket["passed"] += int(row["passed"])
    return {
        "cases": n,
        "passed": sum(int(row["passed"]) for row in scored),
        "pass_rate": round(sum(int(row["passed"]) for row in scored) / n, 4),
        "critical_failures": critical_failures,
        "release_gate_passed": not critical_failures and all(row["passed"] for row in scored),
        "mean_evidence_recall": round(
            sum(row["metrics"]["evidence_recall"] for row in scored) / n, 4
        ),
        "mean_citation_precision": round(
            sum(row["metrics"]["citation_precision"] for row in scored) / n, 4
        ),
        # Promedio SOLO sobre los casos donde se midió. Meter los no medidos
        # como 0 hundiría la media y como 1 la maquillaría; ambas mentirían, y
        # el conteo de al lado dice sobre cuántos casos se está promediando.
        "mean_faithfulness": (
            round(
                sum(
                    row["metrics"]["faithfulness"]
                    for row in scored
                    if row["metrics"].get("faithfulness") is not None
                )
                / sum(
                    1 for row in scored if row["metrics"].get("faithfulness") is not None
                ),
                4,
            )
            if any(row["metrics"].get("faithfulness") is not None for row in scored)
            else None
        ),
        "faithfulness_measured_cases": sum(
            1 for row in scored if row["metrics"].get("faithfulness") is not None
        ),
        "unsupported_claims_total": sum(
            row["metrics"].get("unsupported_claims") or 0 for row in scored
        ),
        "total_cost_usd": round(sum(costs), 6),
        "mean_latency_ms": round(sum(latencies) / n, 1),
        "by_category": by_category,
    }
