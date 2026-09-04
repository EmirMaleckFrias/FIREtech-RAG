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
import statistics
from collections import Counter
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
    """Puntúa una respuesta capturada del stream de ``POST /api/chat``.

    Cada fallo sale dos veces: como mensaje legible en ``failures`` (lo que
    imprime `evaluar.py` y lee quien abre el reporte) y como ``{"type",
    "detail"}`` en ``failure_types``, misma posición y misma longitud. El
    desdoble no es adorno: `aggregate_runs` cuenta la frecuencia de cada fallo
    en N corridas y por cadena literal contaba mal, porque cinco de los trece
    fallos llevan una medición de la corrida dentro del mensaje ("hops
    insuficientes: 0 < 2" vs "1 < 2"). El ``type`` es lo estable entre corridas
    (incluido lo que identifica QUÉ falló: el id de la evidencia, el umbral
    exigido) y el ``detail``, solo lo que varía.
    """
    answer = str(result.get("answer") or result.get("respuesta") or "")
    sources = result.get("sources") or result.get("fuentes") or []
    hops = result.get("hops") or []
    error = result.get("error")
    # (tipo, mensaje, detalle variable de esta corrida).
    fallos: list[tuple[str, str, str]] = []

    def anotar(tipo: str, mensaje: str | None = None, detalle: str = "") -> None:
        """Anota un fallo. Sin `mensaje`, el tipo ES el mensaje (fallos de texto
        fijo, que no llevan nada de la corrida y agrupan solos)."""
        fallos.append((tipo, mensaje if mensaje is not None else tipo, detalle))

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
            # El id viaja en el TIPO, no en el detalle: dos evidencias distintas
            # que faltan son dos hallazgos distintos y cada uno necesita su
            # propia frecuencia al agregar N corridas.
            anotar(f"evidencia no recuperada: {requirement.id}")

    evidence_recall = (
        sum(1 for row in evidence_rows if row["found"]) / len(evidence_rows)
        if evidence_rows
        else 1.0
    )

    hop_text = "\n".join(str(hop.get("query") or "") for hop in hops)
    missing_hop_patterns = [p for p in case.hop_patterns if not _matches(p, hop_text)]
    if len(hops) < case.min_hops:
        anotar(
            "hops insuficientes",
            f"hops insuficientes: {len(hops)} < {case.min_hops}",
            f"{len(hops)} < {case.min_hops}",
        )
    if missing_hop_patterns:
        # El conjunto de patrones que faltan va en el tipo: "faltó A y B" y
        # "faltó solo B" son diagnósticos distintos, no dos medidas del mismo.
        anotar("conceptos ausentes en búsquedas: " + ", ".join(missing_hop_patterns))

    missing_answer_patterns = [
        pattern for pattern in case.answer_must_contain if not _matches(pattern, answer)
    ]
    forbidden_answer_patterns = [
        pattern for pattern in case.answer_must_not_contain if _matches(pattern, answer)
    ]
    if missing_answer_patterns:
        anotar("respuesta incompleta: " + ", ".join(missing_answer_patterns))
    if forbidden_answer_patterns:
        anotar("contenido prohibido: " + ", ".join(forbidden_answer_patterns))

    abstained = any(_matches(pattern, answer) for pattern in ABSTENTION_PATTERNS)
    if case.expect_abstention and not abstained:
        anotar("debía abstenerse y no lo hizo")
    if not case.expect_abstention and abstained:
        anotar("se abstuvo en un caso con evidencia esperada")

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
        # Aquí sí es detalle: qué cita se inventó el modelo cambia en cada
        # corrida, y lo que hay que contar es cuántas corridas citaron humo.
        anotar(
            "citas no resolubles",
            "citas no resolubles: " + ", ".join(unresolved_citations),
            ", ".join(unresolved_citations),
        )
    if not case.expect_abstention and not citation_tokens:
        anotar("respuesta factual sin citas")
    if error:
        anotar("error de ejecución", f"error de ejecución: {error}", str(error))

    # Fidelidad de atribución, tal como la dictaminó el verificador durante la
    # corrida. Ausente = la verificación estaba apagada: entonces no se mide y
    # tampoco se penaliza, pero queda visible como None en vez de como 1.0.
    verificacion = ((result.get("metrics") or {}).get("meta") or {}).get("verificacion") or {}
    faithfulness = verificacion.get("fidelidad")
    no_sostenidas = int(verificacion.get("no_sostenidas") or 0)
    sin_verificar = int(verificacion.get("sin_verificar") or 0)
    if no_sostenidas:
        # Una atribución que su propio fragmento no sostiene es un fallo duro,
        # no un punto menos de nota: quien investiga no puede usar ese dato. El
        # cuánto va en el detalle: el número cambia de corrida en corrida (5 a
        # 15 afirmaciones en la misma pregunta, medido el 2026-09-03).
        anotar(
            "afirmaciones que su fragmento citado no sostiene",
            f"{no_sostenidas} afirmación(es) que su fragmento citado no sostiene",
            str(no_sostenidas),
        )
    if case.min_faithfulness is not None:
        if faithfulness is None:
            anotar("el caso exige fidelidad mínima pero la verificación no la midió")
        elif faithfulness < case.min_faithfulness:
            # El umbral lo fija el caso (es estable) y por eso va en el tipo; la
            # fidelidad medida es lo que varía y va en el detalle.
            anotar(
                f"fidelidad por debajo del mínimo {case.min_faithfulness:.2f}",
                f"fidelidad {faithfulness:.2f} por debajo del mínimo "
                f"{case.min_faithfulness:.2f}",
                f"{faithfulness:.2f}",
            )

    return {
        "id": case.id,
        "passed": not fallos,
        "critical": case.critical,
        "category": case.category,
        "failures": [mensaje for _, mensaje, _ in fallos],
        "failure_types": [
            {"type": tipo, "detail": detalle} for tipo, _, detalle in fallos
        ],
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


def _strict_majority(flags: list[bool]) -> bool:
    """k > N/2. Un empate (1 de 2, 2 de 4) NO es mayoría: un caso que falla la
    mitad de las veces no es fiable y no debe abrir el gate de release."""
    return sum(1 for flag in flags if flag) * 2 > len(flags)


def _median(values: list[float], digits: int) -> float | None:
    """Mediana redondeada, o None si no hay nada medido. Con N impar devuelve
    el valor real de una corrida (6 hops, no 6.333); con N par, el punto medio
    (6 y 10 hops -> 8.0), que es lo honesto: ninguna corrida fue "la típica"."""
    return round(statistics.median(values), digits) if values else None


def _failure_entries(score: dict[str, Any]) -> list[tuple[str, str]]:
    """(tipo, detalle) de cada fallo de una corrida.

    `score_case` los emite en `failure_types`, paralelo a `failures`. Si esa
    clave falta o no cuadra en longitud (una fila de un reporte viejo, o
    construida a mano), se degrada a agrupar por el mensaje literal: es lo que
    se hacía antes, sigue siendo legible y no revienta el agregado.
    """
    entries = score.get("failure_types")
    messages = list(score.get("failures") or [])
    if isinstance(entries, list) and len(entries) == len(messages):
        return [
            (str(entry.get("type") or ""), str(entry.get("detail") or ""))
            for entry in entries
        ]
    return [(message, "") for message in messages]


def _group_failures(scores: list[dict[str, Any]], n: int) -> tuple[list[str], list[dict[str, Any]]]:
    """Agrupa los fallos de N corridas por TIPO, no por mensaje literal.

    Por qué no por mensaje: cinco de los trece fallos de `score_case` llevan una
    medición de la corrida dentro del texto. Con N = 3 y hops 0, 1, 0 el mismo
    fallo salía troceado como "hops insuficientes: 0 < 2 (2/3 corridas)" +
    "hops insuficientes: 1 < 2 (1/3 corridas)", y el "los más frecuentes
    primero" que promete `aggregate_runs` quedaba falseado justo en los fallos
    que más varían. Agrupado sale "hops insuficientes (3/3 corridas): 0 < 2,
    1 < 2": un fallo que ocurrió SIEMPRE se lee como tal.

    Un tipo cuenta UNA vez por corrida aunque aparezca varias, y los detalles se
    deduplican conservando el orden en que se vieron.
    """
    counts: Counter[str] = Counter()
    details: dict[str, list[str]] = {}
    first_seen: dict[str, int] = {}
    for run in scores:
        seen: set[str] = set()
        for kind, detail in _failure_entries(run):
            first_seen.setdefault(kind, len(first_seen))
            variants = details.setdefault(kind, [])
            if detail and detail not in variants:
                variants.append(detail)
            if kind not in seen:
                seen.add(kind)
                counts[kind] += 1

    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
    messages: list[str] = []
    types: list[dict[str, Any]] = []
    for kind, k in ordered:
        variants = details[kind]
        detail = ", ".join(variants)
        messages.append(f"{kind} ({k}/{n} corridas)" + (f": {detail}" if detail else ""))
        types.append({"type": kind, "detail": detail, "runs": k})
    return messages, types


def aggregate_runs(
    scores: list[dict[str, Any]], results: list[dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Reduce N corridas del MISMO caso a un único score y un único result.

    Por qué existe: la misma pregunta corrida 5 veces dio fidelidad entre 0.33
    y 1.00, entre 6 y 10 hops y entre 5 y 15 afirmaciones (medido el
    2026-09-03). Con una sola pasada por caso, cualquier "mejoró" o "empeoró"
    tras un cambio es ruido; esta función es lo que hace comparables dos
    corridas del benchmark.

    Reglas, en el mismo orden en que se aplican:

    - Métricas numéricas: MEDIANA, no media. Con N pequeño (3 o 5) un solo
      valor atípico arrastra la media: fidelidades 1.00, 1.00, 0.33 dan media
      0.78 y mediana 1.00, y lo que describe la corrida que verá casi siempre
      quien investiga es la mediana. La fidelidad se mediana SOLO sobre las
      corridas donde se midió (None = verificación apagada, no 0).
    - Booleanos (`passed`, `abstained`, `found` de cada evidencia): MAYORÍA
      ESTRICTA, ver `_strict_majority`. Además se reporta la tasa (`passed_rate`
      = k/N, `found_rate`) porque un caso que pasa 2 de 3 es información (está
      inestable, hay que mirarlo), no ruido a esconder tras un booleano.
    - Dispersión: `dispersion[metrica]` guarda min, max, cuántas corridas la
      midieron y el valor de cada corrida. Es la señal de inestabilidad a
      vigilar: una mediana de 1.00 con min 0.33 dice algo muy distinto que una
      con min 1.00, y la mediana sola lo taparía. `dispersion["passed"]` lleva
      el veredicto de cada corrida por el mismo motivo (ver abajo).
    - `failures`: la unión de los fallos vistos en cualquier corrida, AGRUPADOS
      POR TIPO (`failure_types` de `score_case`), con su frecuencia y los
      valores de cada corrida como variantes:
      "hops insuficientes (3/3 corridas): 0 < 2, 1 < 2". Agrupar por el mensaje
      literal contaba mal, porque cinco de los trece fallos llevan una medición
      dentro del texto; ver `_group_failures`. Los más frecuentes, primero.
      Para N > 1 se rompe a propósito la invariante `passed == not failures` de
      `score_case`: un caso puede pasar por mayoría y aun así listar el fallo de
      la corrida minoritaria, porque es exactamente lo que hay que investigar.

    `passed` es el VEREDICTO y `metrics` son DESCRIPTIVAS, y con N par pueden
    discrepar: umbral de fidelidad 0.80 con corridas 1.00 y 0.60 da mediana
    0.80, que cumple el umbral, mientras `passed` es False porque un empate no
    es mayoría. Es deliberado: `passed` de una corrida es la conjunción de las
    trece comprobaciones (varias no tienen métrica que medianar, como un error
    de ejecución), así que recalcularlo desde las medianas mediría otra cosa.
    Para que nadie lo lea al revés, quien mire solo el bloque de métricas
    encuentra `dispersion["passed"]` con la tasa y el veredicto por corrida, y
    `failures` lista el fallo de la corrida minoritaria con su "(1/2 corridas)".

    Con N = 1 devuelve el score de `score_case` INTACTO (misma nota, mismos
    fallos y tipos, mismas métricas) más las claves aditivas `runs`,
    `passed_rate`, `dispersion` y `found_rate`; así `evaluar.py` sin
    `--repeticiones` mide lo mismo que antes. El result agregado es mínimo a
    propósito: solo `id`, `question`, `mode`, `runs`, los errores de ejecución
    vistos y `metrics`/`dispersion` de coste y latencia (mediana más la suma de
    las N corridas), que es lo que leen `summarize` y el tope de coste. NO trae
    `answer`, `sources`, `hops` ni `error`: cada corrida los conserva enteros en
    `cases[i].runs[j].result` del reporte.
    """
    if not scores or len(scores) != len(results):
        raise ValueError("aggregate_runs necesita N >= 1 scores y sus N results")
    ids = sorted({str(row["id"]) for row in scores})
    if len(ids) != 1:
        raise ValueError(f"aggregate_runs mezcla casos distintos: {ids}")
    # Misma barrera para los `results`: sin ella se aceptaban corridas de OTRO
    # caso y el result agregado se quedaba con la `question` y el `mode` del
    # primero, así que el reporte enseñaba una pregunta con el coste, la
    # latencia y los errores de otra. Los results sintéticos (y los de un
    # reporte viejo) pueden no traer `id`: lo que no se puede aceptar es un id
    # que CONTRADIGA al de los scores.
    result_ids = sorted(
        {str(r["id"]) for r in results if isinstance(r, dict) and r.get("id") is not None}
    )
    if any(result_id != ids[0] for result_id in result_ids):
        raise ValueError(
            f"aggregate_runs mezcla casos distintos: scores {ids} con results {result_ids}"
        )
    # Agregar agregados sería una mediana de medianas sin los valores crudos, y
    # los fallos saldrían con la frecuencia anotada dos veces.
    if any("runs" in row for row in scores):
        raise ValueError(f"{ids[0]}: las filas ya están agregadas; pasa las corridas crudas")

    n = len(scores)
    first = scores[0]

    metrics: dict[str, Any] = {}
    dispersion: dict[str, Any] = {}
    for key in first["metrics"]:
        raw = [row["metrics"].get(key) for row in scores]
        measured = [value for value in raw if value is not None]
        if measured and all(isinstance(value, bool) for value in measured):
            positives = sum(1 for value in measured if value)
            metrics[key] = _strict_majority(measured)
            dispersion[key] = {"rate": round(positives / len(measured), 4), "values": raw}
        else:
            metrics[key] = _median(measured, 4)
            dispersion[key] = {
                "min": min(measured) if measured else None,
                "max": max(measured) if measured else None,
                "n": len(measured),
                "values": raw,
            }

    # Evidencias por id, no por posición: `score_case` las emite en el orden
    # del caso, pero casarlas por id no cuesta nada y aguanta un reordenado.
    evidence_by_run = [{row["id"]: row for row in run["evidence"]} for run in scores]
    evidence_rows: list[dict[str, Any]] = []
    for row in first["evidence"]:
        found = [bool((run.get(row["id"]) or {}).get("found")) for run in evidence_by_run]
        matched = sorted(
            {
                source
                for run in evidence_by_run
                for source in (run.get(row["id"]) or {}).get("matched_sources", [])
            }
        )
        evidence_rows.append(
            {
                **row,
                "found": _strict_majority(found),
                "found_rate": round(sum(found) / n, 4),
                "matched_sources": matched,
            }
        )

    if n == 1:
        # Literal, sin anotar frecuencias: "(1/1 corridas)" sería ruido y
        # rompería la promesa de que N = 1 es idéntico a `score_case`.
        failures = list(first["failures"])
        failure_types = [dict(entry) for entry in (first.get("failure_types") or [])]
    else:
        failures, failure_types = _group_failures(scores, n)

    passed_flags = [bool(row["passed"]) for row in scores]
    passed_runs = sum(1 for flag in passed_flags if flag)
    # `passed` es el veredicto (mayoría estricta) y `metrics` son medianas
    # descriptivas: con N par pueden discrepar y hay que verlo sin cruzar
    # claves. Ej. real: umbral 0.80 y fidelidades 1.00 y 0.60 -> la mediana es
    # 0.80 y CUMPLE el umbral, pero `passed` es False porque 1 de 2 corridas
    # falló y un empate no es mayoría. Por eso la tasa por corrida viaja también
    # aquí, al lado de la dispersión de las métricas que se está leyendo.
    dispersion["passed"] = {"rate": round(passed_runs / n, 4), "values": passed_flags}
    score = {
        "id": first["id"],
        "passed": _strict_majority(passed_flags),
        "critical": first["critical"],
        "category": first["category"],
        "failures": failures,
        "failure_types": failure_types,
        "evidence": evidence_rows,
        "metrics": metrics,
        "runs": n,
        "passed_rate": round(passed_runs / n, 4),
        "dispersion": dispersion,
    }

    # Mismas lecturas que hace `summarize` sobre un result crudo, para que el
    # agregado le sirva sin cambiar cómo lee coste y latencia.
    costs = [
        float((r.get("metrics") or {}).get("cost_usd") or r.get("coste_usd") or 0)
        for r in results
    ]
    latencies = [float((r.get("metrics") or {}).get("ms_total") or 0) for r in results]
    result = {
        "id": first["id"],
        "question": results[0].get("question"),
        "mode": results[0].get("mode"),
        "runs": n,
        "errors": [str(r.get("error")) for r in results if r.get("error")],
        "metrics": {
            "cost_usd": _median(costs, 6),
            "ms_total": _median(latencies, 1),
            # Lo gastado de verdad: N corridas cuestan N veces, y `--max-usd`
            # y la contabilidad necesitan la suma, no la mediana.
            "cost_usd_all_runs": round(sum(costs), 6),
            "ms_total_all_runs": round(sum(latencies), 1),
        },
        "dispersion": {
            "cost_usd": {"min": min(costs), "max": max(costs), "n": n, "values": costs},
            "ms_total": {"min": min(latencies), "max": max(latencies), "n": n, "values": latencies},
        },
    }
    return score, result


def summarize(scored: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    """Agrega sin esconder fallos críticos detrás de un promedio.

    Acepta indistintamente filas de `score_case` (una pasada) y de
    `aggregate_runs` (N pasadas ya reducidas a mediana/mayoría): en ambos
    casos UNA fila es UN caso, y `release_gate_passed` se decide sobre lo que
    trae la fila, es decir sobre el agregado cuando hubo repeticiones. Las
    claves `runs`/`passed_rate` faltan en las filas de una pasada y se leen
    como 1 y 0/1, así que un reporte sin `--repeticiones` sale idéntico.
    """
    if not scored:
        raise ValueError("no hay resultados que resumir")
    # Una fila = un caso. Si llegaran N filas crudas del mismo id (repeticiones
    # sin agregar), `cases` diría N y el gate juzgaría corridas sueltas en vez
    # del agregado por mayoría: justo el ruido que las repeticiones venían a
    # quitar. Mejor romper aquí que resumir mal en silencio.
    repeated = sorted(id_ for id_, k in Counter(row["id"] for row in scored).items() if k > 1)
    if repeated:
        raise ValueError(
            f"ids repetidos en el resumen: {repeated}; agrega las repeticiones "
            "con aggregate_runs antes de resumir"
        )
    n = len(scored)
    runs = [int(row.get("runs") or 1) for row in scored]
    # Corridas aprobadas por caso. `passed_rate` viaja redondeada a 4 decimales
    # (0.6667 * 3 = 2.0001), de ahí el round para recuperar el entero k.
    passed_runs = [
        round(float(row.get("passed_rate", int(row["passed"]))) * total)
        for row, total in zip(scored, runs)
    ]
    critical_failures = [row["id"] for row in scored if row["critical"] and not row["passed"]]
    costs = [float((r.get("metrics") or {}).get("cost_usd") or r.get("coste_usd") or 0) for r in results]
    # Lo gastado de verdad. Un result agregado trae la suma de sus N corridas;
    # uno crudo no, y entonces gastado == coste.
    spent = [
        float((r.get("metrics") or {}).get("cost_usd_all_runs") or cost)
        for r, cost in zip(results, costs)
    ]
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
        # Sobre corridas, no sobre casos: con repeticiones separa "pasa siempre"
        # (1.0) de "pasa por mayoría justa" (0.6); sin ellas coincide con
        # pass_rate.
        "runs_total": sum(runs),
        "run_pass_rate": round(sum(passed_runs) / sum(runs), 4),
        # Casos que pasaron en unas corridas y fallaron en otras. Es la lista de
        # inestabilidad que hay que vigilar antes de creerse un "mejoró".
        "unstable_cases": [
            row["id"] for row, k, total in zip(scored, passed_runs, runs) if 0 < k < total
        ],
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
        # Coste de UNA pasada típica del benchmark (con repeticiones, la mediana
        # por caso): es lo comparable entre dos corridas con distinto N. Lo
        # gastado de verdad, que crece con N, va en la clave de al lado.
        "total_cost_usd": round(sum(costs), 6),
        "total_cost_usd_all_runs": round(sum(spent), 6),
        "mean_latency_ms": round(sum(latencies) / n, 1),
        "by_category": by_category,
    }
