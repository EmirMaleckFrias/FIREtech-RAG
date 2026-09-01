"""Evaluación A NIVEL DE RESPUESTA con juez LLM (complementa evals/run_eval.py).

Mientras run_eval.py mide si el retrieval TRAE el chunk correcto, este runner
mide si la RESPUESTA FINAL del agente (run_agent) es correcta: exactitud
factual, citas, advertencias de precio, honestidad y completitud, juzgadas por
`gpt-5.4-mini` en JSON mode contra una referencia factual verificada.

Uso (desde backend/ como cwd):
    .venv\\Scripts\\python.exe -X utf8 evals\\judge_answers.py [--n 18] [--all] [--solo-real-world]
    .venv\\Scripts\\python.exe -X utf8 evals\\judge_answers.py --agregacion

Selección de casos:
  - Los 7 casos de regresión de evals/gold_real_world.json SIEMPRE se corren
    (fallos reales de producción, hechos verificados por auditoría).
  - Más una muestra estratificada por tipo de `--n` (default 18) preguntas del
    gold set de retrieval (evals/gold_set.json). Para éstas la referencia
    factual es el TEXTO del chunk gold recuperado de Qdrant vía
    accept_ids/accept_skus.
  - `--all` usa las 60 del gold set; `--solo-real-world` omite la muestra.
  - `--agregacion` corre EN EXCLUSIVA los 10 casos de evals/gold_agregacion.json
    (orden/conteos/agrupaciones exactos); no toca los 7+18 del flujo normal y
    escribe su propio informe en docs/EVAL_AGREGACION.md.

Los casos se ejecutan SECUENCIALMENTE (cada uno es una corrida real del agente
con el modelo de producción); errores 429/transitorios se reintentan con
backoff. Escribe docs/EVAL_RESPUESTAS.md y un JSON de resultados en el tempdir.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

GOLD_RETRIEVAL = BACKEND_DIR / "evals" / "gold_set.json"
GOLD_REAL_WORLD = BACKEND_DIR / "evals" / "gold_real_world.json"
GOLD_AGREGACION = BACKEND_DIR / "evals" / "gold_agregacion.json"
DEFAULT_REPORT = PROJECT_DIR / "docs" / "EVAL_RESPUESTAS.md"
AGREGACION_REPORT = PROJECT_DIR / "docs" / "EVAL_AGREGACION.md"
RESULTS_DIR = Path(tempfile.gettempdir()) / "rag_eval_answers"

# Etiquetas de grupo: (sigla para la tabla por caso, nombre para los agregados).
GROUP_LABELS = {
    "real_world": ("RW", "Regresión real-world"),
    "muestra_retrieval": ("GS", "Muestra retrieval"),
    "agregacion": ("AG", "Agregación"),
}

JUDGE_MODEL = "gpt-5.4-mini"
DEFAULT_SEED = 20260831

CRITERIA = ("exactitud_factual", "citas", "advertencias", "honestidad", "completitud")
CRIT_SHORT = {"exactitud_factual": "a", "citas": "b", "advertencias": "c",
              "honestidad": "d", "completitud": "e"}

# Tarifas ASUMIDAS (USD por 1M tokens, input/output) solo para estimar costo.
# No hay tarifa oficial en el repo: ajustar si se conoce la real.
ASSUMED_PRICES = {
    "gpt-5.4": (1.25, 10.00),
    "gpt-5.4-mini": (0.25, 2.00),
}

# --- Captura de uso de tokens (parche sobre el cliente OpenAI) ----------------
# run_agent crea su propio AsyncOpenAI y streamea sin usage; parcheamos
# AsyncCompletions.create para (1) pedir usage en streams y (2) acumular el
# usage de TODAS las llamadas chat (agente, reranker y juez), por modelo.

class _UsageBook:
    def __init__(self) -> None:
        self.by_model: dict[str, dict[str, int]] = {}
        self._active: str | None = None  # componente actual ("agente"/"juez")
        self.by_component: dict[str, dict[str, float]] = {}

    def set_component(self, name: str | None) -> None:
        self._active = name

    def add(self, model: str, usage) -> None:
        row = self.by_model.setdefault(
            model, {"calls": 0, "prompt": 0, "completion": 0, "cached": 0}
        )
        row["calls"] += 1
        row["prompt"] += getattr(usage, "prompt_tokens", 0) or 0
        row["completion"] += getattr(usage, "completion_tokens", 0) or 0
        details = getattr(usage, "prompt_tokens_details", None)
        row["cached"] += getattr(details, "cached_tokens", 0) or 0
        if self._active:
            comp = self.by_component.setdefault(
                self._active, {"prompt": 0, "completion": 0, "calls": 0}
            )
            comp["calls"] += 1
            comp["prompt"] += getattr(usage, "prompt_tokens", 0) or 0
            comp["completion"] += getattr(usage, "completion_tokens", 0) or 0

    def cost_estimate(self) -> tuple[float, list[str]]:
        total = 0.0
        detail: list[str] = []
        for model, row in sorted(self.by_model.items()):
            rate = ASSUMED_PRICES.get(model)
            if rate is None:
                base = model.split(":")[0]
                rate = next(
                    (v for k, v in ASSUMED_PRICES.items() if base.startswith(k)),
                    (1.25, 10.0),
                )
            cost = row["prompt"] / 1e6 * rate[0] + row["completion"] / 1e6 * rate[1]
            total += cost
            detail.append(
                f"{model}: {row['calls']} llamadas, {row['prompt']:,} in "
                f"({row['cached']:,} cacheados) + {row['completion']:,} out "
                f"~= {cost:.2f} USD (a {rate[0]}/{rate[1]} USD/M asumidos)"
            )
        return total, detail


USAGE = _UsageBook()


class _CapturingStream:
    """Envuelve un AsyncStream de chat para capturar el chunk final de usage."""

    def __init__(self, inner, model: str) -> None:
        self._inner = inner
        self._model = model

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        async for chunk in self._inner:
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                USAGE.add(self._model, usage)
            yield chunk


def install_usage_capture() -> None:
    try:
        from openai.resources.chat.completions import AsyncCompletions
    except ImportError:  # layouts nuevos del SDK
        from openai.resources.chat.completions.completions import AsyncCompletions

    orig = AsyncCompletions.create

    async def patched(self, *args, **kwargs):
        model = str(kwargs.get("model") or "?")
        is_stream = bool(kwargs.get("stream"))
        if is_stream and "stream_options" not in kwargs:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            result = await orig(self, *args, **kwargs)
        except Exception as exc:
            if "stream_options" in str(exc):
                kwargs.pop("stream_options", None)
                result = await orig(self, *args, **kwargs)
            else:
                raise
        if is_stream:
            return _CapturingStream(result, model)
        if getattr(result, "usage", None) is not None:
            USAGE.add(model, result.usage)
        return result

    AsyncCompletions.create = patched


# --- Reintentos de errores transitorios ---------------------------------------

async def _with_retries(fn, attempts: int = 4, what: str = ""):
    for attempt in range(attempts):
        try:
            return await fn()
        except Exception as exc:
            msg = str(exc).lower()
            transient = any(
                s in msg
                for s in ("429", "rate limit", "rate_limit", "timeout",
                          "connection", "temporarily", "503", "500", "502")
            )
            if attempt == attempts - 1 or not transient:
                raise
            wait = 3.0 * (2 ** attempt) + random.random()
            print(f"    ... {what or 'llamada'} transitorio ({str(exc)[:80]}); "
                  f"reintento en {wait:.0f}s", flush=True)
            await asyncio.sleep(wait)
    raise RuntimeError("unreachable")


# --- Construcción de la referencia factual -------------------------------------

_CHUNK_CHARS = 1400
_MAX_REF_CHUNKS = 4


def _chunks_by_ids(ids: list[str]) -> list:
    from app.services.qdrant import _point_to_chunk, get_client
    from app.config import get_settings

    if not ids:
        return []
    points = get_client().retrieve(
        collection_name=get_settings().qdrant_collection,
        ids=ids,
        with_payload=True,
    )
    return [_point_to_chunk(p) for p in points]


def _format_ref_chunks(chunks: list, label: str) -> str:
    parts = [label]
    for ch in chunks[:_MAX_REF_CHUNKS]:
        parts.append(
            f"--- [{ch.source_file}, pág. {ch.page}] (marca: {ch.brand}; "
            f"SKUs: {', '.join(ch.skus[:6]) or '-'})\n{ch.text[:_CHUNK_CHARS]}"
        )
    return "\n\n".join(parts)


REF_HEADER_AUDIT = "HECHOS ESPERADOS (verificados por auditoría contra el catálogo):"
REF_HEADER_ENGINE = (
    "HECHOS ESPERADOS (calculados con el MOTOR EXACTO del catálogo -- "
    "scan_by_price/group_values/index_inventory sobre Qdrant -- y congelados; "
    "los SKUs, precios, páginas y conteos de abajo son los valores reales del "
    "índice, no una interpretación):"
)


def build_reference_real_world(case: dict, header: str = REF_HEADER_AUDIT) -> str:
    from app.services.qdrant import find_by_skus, index_inventory

    parts = [header, case["expected"]]
    if case.get("augment_with_live_inventory"):
        inv = index_inventory()
        arch = ", ".join(a["valor"] for a in inv["archivos"])
        supl = ", ".join(f"{s['valor']} ({s['chunks']} chunks)" for s in inv["suplidores"])
        parts.append(
            "INVENTARIO VIVO DEL ÍNDICE (verdad de referencia en este momento):\n"
            f"- Archivos indexados ({len(inv['archivos'])}): {arch}\n"
            f"- Suplidores ({len(inv['suplidores'])}): {supl}\n"
            f"- Chunks totales: {inv['total_chunks']} | Productos: {inv['productos']}"
        )
    skus = case.get("ref_skus") or []
    if skus:
        chunks = []
        for sku in skus:
            chunks.extend(find_by_skus([sku], 2))
        seen: set[str] = set()
        uniq = [c for c in chunks if not (c.id in seen or seen.add(c.id))]
        if uniq:
            parts.append(_format_ref_chunks(
                uniq, "TEXTO REAL DEL CATÁLOGO para los productos de referencia:"
            ))
    return "\n\n".join(parts)


def build_reference_gold(case: dict) -> str:
    from app.services.qdrant import find_by_skus

    chunks = _chunks_by_ids(case.get("accept_ids") or [])
    if not chunks and case.get("accept_skus"):
        chunks = find_by_skus(list(case["accept_skus"]), _MAX_REF_CHUNKS)
    header = (
        "PRODUCTO GOLD (el retrieval correcto para esta pregunta):\n"
        f"- Producto: {case.get('ref_product')}\n"
        f"- SKU de referencia: {case.get('ref_sku')} "
        f"(también aceptables: {', '.join(case.get('accept_skus') or [])})\n"
        f"- Fuente correcta: [{case.get('source_file')}, pág. {case.get('ref_page')}]\n"
        "Nota: si la respuesta presenta una variante hermana real de la misma "
        "familia (mismo catálogo) con datos correctos y citados, no es un dato "
        "inventado; júzgala por fidelidad al texto de referencia."
    )
    body = _format_ref_chunks(
        chunks, "TEXTO DEL CHUNK GOLD (referencia factual, extraído del índice):"
    ) if chunks else "ADVERTENCIA: no se pudo recuperar el chunk gold del índice."
    return header + "\n\n" + body


# --- Corrida del agente ---------------------------------------------------------

async def run_agent_case(question: str) -> dict:
    from app.services.agent import run_agent

    async def _run() -> dict:
        final = None
        async for ev in run_agent(question, []):
            if ev.type == "final":
                final = ev.data
        if final is None:
            raise RuntimeError("run_agent terminó sin evento 'final'")
        return final

    t0 = time.time()
    final = await _with_retries(_run, what="agente")
    return {
        "content": final.get("content") or "",
        "sources": final.get("sources") or [],
        "hops": final.get("hops") or [],
        "agent_s": round(time.time() - t0, 1),
    }


# --- Juez -----------------------------------------------------------------------

JUDGE_SYSTEM = """\
Eres un JUEZ estricto de calidad de respuestas de un asistente RAG de catálogos \
de protección contra incendios. Recibes la pregunta del usuario, la respuesta \
del agente y una REFERENCIA FACTUAL verificada (hechos esperados y/o texto real \
del catálogo). Evalúa SOLO contra la referencia y lo que la propia respuesta \
afirma; no uses conocimiento externo. Sé exigente pero justo: no inventes \
fallos que la referencia no permita verificar. Devuelve SOLO el JSON pedido."""

JUDGE_RUBRIC = """\
Evalúa estos 5 criterios, cada uno con "pass" (true/false) y "nota" (1-2 frases, en español):

(a) exactitud_factual: los precios, SKUs y especificaciones que la respuesta \
afirma y que la referencia cubre coinciden EXACTAMENTE con la referencia; no hay \
datos inventados ni contradicciones con la referencia. Datos de productos reales \
no cubiertos por la referencia no se penalizan salvo contradicción.

(b) citas: TODA afirmación factual (modelo, SKU, precio, dimensión, aprobación...) \
lleva cita con formato [archivo, pág. X] o [inventario del índice], y las citas \
apuntan al ARCHIVO correcto según la referencia (para los datos que la referencia \
cubre). Un dato factual sin cita = fail.

(c) advertencias: SI la respuesta incluye precios, cada precio tiene moneda \
explícita y la respuesta incluye el aviso de que son precios de catálogo que \
pueden variar / estar desactualizados (o su vigencia). Si la respuesta no \
contiene ningún precio, marca pass.

(d) honestidad: lo que no está en los resultados/la referencia se declara como \
no encontrado (sin rellenar huecos); no hay superlativos absolutos injustificados \
("el más barato", "el mejor precio") cuando el método/los datos no lo respaldan o \
la referencia lo contradice; no aparenta certeza sin datos.

(e) completitud: responde TODAS las partes de lo que se preguntó (todos los \
productos, ambos datos pedidos, etc.), o declara explícitamente qué parte no \
pudo responder y por qué.

Devuelve EXACTAMENTE este JSON (sin texto extra):
{
  "exactitud_factual": {"pass": true, "nota": "..."},
  "citas": {"pass": true, "nota": "..."},
  "advertencias": {"pass": true, "nota": "..."},
  "honestidad": {"pass": true, "nota": "..."},
  "completitud": {"pass": true, "nota": "..."},
  "veredicto_global": "PASS"
}
"veredicto_global" es "PASS" si (a), (b) y (d) pasan y como máximo UNO de (c)/(e) falla; si no, "FAIL"."""


async def judge_case(client, question: str, answer: str, reference: str) -> dict:
    user = (
        f"PREGUNTA DEL USUARIO:\n{question}\n\n"
        f"RESPUESTA DEL AGENTE:\n{answer or '(respuesta vacía)'}\n\n"
        f"REFERENCIA FACTUAL:\n{reference}\n\n"
        f"{JUDGE_RUBRIC}"
    )

    async def _call() -> dict:
        resp = await client.chat.completions.create(
            model=JUDGE_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": user},
            ],
        )
        return json.loads(resp.choices[0].message.content)

    t0 = time.time()
    last_exc: Exception | None = None
    for _ in range(2):  # el JSON roto se reintenta una vez además de los 429
        try:
            data = await _with_retries(_call, what="juez")
            break
        except json.JSONDecodeError as exc:
            last_exc = exc
            data = None
    if data is None:
        raise RuntimeError(f"El juez no devolvió JSON válido: {last_exc}")

    crits = {}
    for name in CRITERIA:
        entry = data.get(name) or {}
        crits[name] = {
            "pass": bool(entry.get("pass")),
            "nota": str(entry.get("nota") or "").strip(),
        }
    # Veredicto DETERMINISTA desde los criterios (la regla del enunciado); el
    # del juez se guarda solo para detectar discrepancias.
    core_ok = all(crits[c]["pass"] for c in ("exactitud_factual", "citas", "honestidad"))
    soft_fails = sum(1 for c in ("advertencias", "completitud") if not crits[c]["pass"])
    verdict = "PASS" if core_ok and soft_fails <= 1 else "FAIL"
    return {
        "criteria": crits,
        "verdict": verdict,
        "judge_verdict_raw": str(data.get("veredicto_global") or ""),
        "judge_s": round(time.time() - t0, 1),
    }


# --- Selección de casos ---------------------------------------------------------

def stratified_sample(questions: list[dict], n: int, seed: int) -> list[dict]:
    if n >= len(questions):
        return list(questions)
    by_type: dict[str, list[dict]] = {}
    for q in questions:
        by_type.setdefault(q["type"], []).append(q)
    total = len(questions)
    quotas: dict[str, int] = {}
    fracs: list[tuple[float, str]] = []
    for t, qs in sorted(by_type.items()):
        exact = n * len(qs) / total
        quotas[t] = int(exact)
        fracs.append((exact - int(exact), t))
    fracs.sort(reverse=True)
    i = 0
    while sum(quotas.values()) < n:
        quotas[fracs[i % len(fracs)][1]] += 1
        i += 1
    rng = random.Random(seed)
    out: list[dict] = []
    for t, qs in sorted(by_type.items()):
        out.extend(rng.sample(qs, min(quotas[t], len(qs))))
    out.sort(key=lambda q: q["qid"])
    return out


# --- Reporte ---------------------------------------------------------------------

def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _crit_flags(res: dict) -> str:
    return " ".join(
        (CRIT_SHORT[c] if res["criteria"][c]["pass"] else CRIT_SHORT[c].upper() + "!")
        for c in CRITERIA
    )


def _agg(cases: list[dict]) -> dict:
    n = len(cases) or 1
    out = {
        "n": len(cases),
        "pass": sum(c["verdict"] == "PASS" for c in cases) / n,
    }
    for crit in CRITERIA:
        out[crit] = sum(c["criteria"][crit]["pass"] for c in cases) / n
    return out


def write_report(payload: dict, report_path: Path) -> None:
    cases = payload["cases"]
    rw = [c for c in cases if c["group"] == "real_world"]
    sm = [c for c in cases if c["group"] == "muestra_retrieval"]
    ag = [c for c in cases if c["group"] == "agregacion"]
    solo_ag = bool(ag) and not rw and not sm
    lines: list[str] = []
    add = lines.append

    if solo_ag:
        add("# Evaluación de AGREGACIÓN (juez LLM) — RAG de catálogos")
    else:
        add("# Evaluación de respuestas (juez LLM) — RAG de catálogos")
    add("")
    if solo_ag:
        idx = payload.get("index_state") or {}
        add(
            f"Fecha: {payload['started_at'][:10]} · Agente: `{payload['agent_model']}` "
            f"(pipeline completo `run_agent`, {payload['max_hops']} hops máx.) · "
            f"Juez: `{JUDGE_MODEL}` (JSON mode) · Casos: {len(ag)} de la categoría "
            f"AGREGACIÓN (`evals/gold_agregacion.json`) · Índice: "
            f"{idx.get('total_chunks', '?')} chunks / {idx.get('archivos', '?')} archivos / "
            f"{idx.get('suplidores', '?')} suplidores / {idx.get('marcas', '?')} marcas · "
            f"Duración total: {payload['elapsed_s']:.0f}s."
        )
    else:
        add(
            f"Fecha: {payload['started_at'][:10]} · Agente: `{payload['agent_model']}` "
            f"(pipeline completo `run_agent`, {payload['max_hops']} hops máx.) · "
            f"Juez: `{JUDGE_MODEL}` (JSON mode) · Casos: {len(rw)} de regresión real-world "
            f"+ {len(sm)} muestreados del gold set de retrieval (semilla {payload['seed']}) · "
            f"Duración total: {payload['elapsed_s']:.0f}s."
        )
    add("")
    if payload.get("aborted"):
        add(f"> **{payload['aborted']}** El informe cubre solo los casos ejecutados.")
        add("")
    add("## Metodología")
    add("")
    add("- **Qué mide**: la calidad de la RESPUESTA FINAL del agente (no del retrieval, "
        "eso lo cubre `docs/EVAL_RETRIEVAL.md`). Cada caso ejecuta `run_agent(pregunta, [])` "
        "en proceso y acumula el evento `final` (content + sources + hops); los casos corren "
        "secuencialmente y los errores transitorios (429...) se reintentan con backoff.")
    if rw:
        add("- **Casos real-world** (`evals/gold_real_world.json`): 7 regresiones de los fallos "
            "reales de producción auditados en `docs/audit_conversaciones_jefes.md`; el `expected` "
            "son hechos verificados por auditoría, complementados en runtime con el texto real de "
            "los chunks del catálogo (`ref_skus`) y, donde aplica, el inventario vivo del índice.")
    if sm:
        add("- **Casos muestreados** (`evals/gold_set.json`, CONGELADO): muestra estratificada "
            "por tipo; la referencia factual es el texto del chunk gold recuperado de Qdrant vía "
            "`accept_ids`/`accept_skus`.")
    if ag:
        add("- **Casos de agregación** (`evals/gold_agregacion.json`): preguntas de orden, "
            "conteo y agrupación, la familia que la tool general `consultar_catalogo` resuelve "
            "de forma exacta (`_execute_catalog_query` → `scan_by_price`/`group_values`). Seis "
            "son preguntas TEXTUALES del uso real (con sus faltas de ortografía) y cuatro son "
            "composicionales nuevas. **La verdad de referencia NO sale de los PDFs ni de un LLM**: "
            "se calculó en proceso con ese mismo motor exacto sobre el índice vivo y se congeló "
            "en el JSON (SKUs, precios, páginas y conteos reales), así que el juez compara la "
            "respuesta contra el resultado aritmético del catálogo, no contra una paráfrasis. "
            "Los hechos congelados **dependen del estado del índice**: si se reingesta, hay que "
            "recalcularlos con el motor.")
    add("- **Juez**: una llamada a `" + JUDGE_MODEL + "` por caso con pregunta, respuesta, "
        "referencia y rubric de 5 criterios pass/fail: **(a) exactitud_factual** (precios/SKUs/"
        "specs coinciden con la referencia, sin datos inventados), **(b) citas** (toda afirmación "
        "factual con `[archivo, pág. X]` o `[inventario del índice]` y archivo correcto), "
        "**(c) advertencias** (precios con moneda + aviso de vigencia/desactualización), "
        "**(d) honestidad** (lo no encontrado se declara; sin superlativos injustificados), "
        "**(e) completitud** (todas las partes de la pregunta).")
    add("- **Veredicto global por caso** (calculado determinísticamente desde los criterios): "
        "PASS si (a), (b) y (d) pasan y como máximo uno de (c)/(e) falla.")
    add("")
    add("## Resultados globales")
    add("")
    add("| Grupo | n | PASS global | (a) exactitud | (b) citas | (c) advertencias | (d) honestidad | (e) completitud |")
    add("|---|---|---|---|---|---|---|---|")
    groups_row = [("Regresión real-world", rw), ("Muestra retrieval", sm), ("Agregación", ag)]
    if not solo_ag:  # con un solo grupo la fila Total sería un duplicado
        groups_row.append(("**Total**", cases))
    for label, group in groups_row:
        if not group:
            continue
        g = _agg(group)
        add(
            f"| {label} | {g['n']} | {_pct(g['pass'])} | {_pct(g['exactitud_factual'])} | "
            f"{_pct(g['citas'])} | {_pct(g['advertencias'])} | {_pct(g['honestidad'])} | "
            f"{_pct(g['completitud'])} |"
        )
    add("")
    add("## Resultados por tipo")
    add("")
    add("| Tipo | n | PASS | (a) | (b) | (c) | (d) | (e) |")
    add("|---|---|---|---|---|---|---|---|")
    by_type: dict[str, list[dict]] = {}
    for c in cases:
        by_type.setdefault(c["type"], []).append(c)
    for t, group in sorted(by_type.items()):
        g = _agg(group)
        add(
            f"| {t} | {g['n']} | {_pct(g['pass'])} | {_pct(g['exactitud_factual'])} | "
            f"{_pct(g['citas'])} | {_pct(g['advertencias'])} | {_pct(g['honestidad'])} | "
            f"{_pct(g['completitud'])} |"
        )
    add("")
    add("## Tabla por caso")
    add("")
    add("Criterios: minúscula = pass, MAYÚSCULA! = fail (a=exactitud, b=citas, "
        "c=advertencias, d=honestidad, e=completitud).")
    add("")
    if solo_ag:
        add("| Caso | Origen | Tipo | Pregunta | Criterios | Veredicto | Hops | s agente | s juez |")
        add("|---|---|---|---|---|---|---|---|---|")
        for c in cases:
            verdict = c["verdict"] if c["verdict"] == "PASS" else "**FAIL**"
            add(
                f"| {c['qid']} | {c.get('origen', '-')} | {c['type']} | "
                f"{c['question']} | `{_crit_flags(c)}` | {verdict} | {c['n_hops']} | "
                f"{c['agent_s']} | {c['judge_s']} |"
            )
    else:
        add("| Caso | Grupo | Tipo | Criterios | Veredicto | Hops | s agente | s juez |")
        add("|---|---|---|---|---|---|---|---|")
        for c in cases:
            verdict = c["verdict"] if c["verdict"] == "PASS" else "**FAIL**"
            add(
                f"| {c['qid']} | {GROUP_LABELS.get(c['group'], ('GS', ''))[0]} | {c['type']} | "
                f"`{_crit_flags(c)}` | {verdict} | {c['n_hops']} | {c['agent_s']} | {c['judge_s']} |"
            )
    add("")

    if rw:
        rw_fails = [c for c in rw if c["verdict"] != "PASS"]
        add("## Estado de las 7 regresiones real-world")
        add("")
        if rw_fails:
            add(f"**ATENCIÓN: {len(rw_fails)} de {len(rw)} casos de regresión FALLAN** "
                "(los fallos de producción auditados siguen, total o parcialmente, sin resolver):")
            for c in rw_fails:
                add(f"- **{c['qid']} ({c['type']}) FALLA**: “{c['question']}”")
        else:
            add(f"Los {len(rw)} casos de regresión pasan: los fallos de producción auditados "
                "quedan cubiertos por el comportamiento actual del agente.")
        add("")

    if ag:
        reales = [c for c in ag if str(c.get("origen", "")).startswith("uso real")]
        nuevas = [c for c in ag if not str(c.get("origen", "")).startswith("uso real")]
        add("## Estado de las preguntas del uso real")
        add("")
        add(f"De los {len(ag)} casos, **{len(reales)} son preguntas textuales que los usuarios "
            f"escribieron en producción** (varias fallaban) y {len(nuevas)} son composicionales "
            "nuevas que ninguna regla del pipeline programó explícitamente.")
        add("")
        add("| Caso | Pregunta del uso real | Veredicto |")
        add("|---|---|---|")
        for c in reales:
            add(f"| {c['qid']} | {c['question']} | "
                f"{c['verdict'] if c['verdict'] == 'PASS' else '**FAIL**'} |")
        add("")
        r_fail = [c for c in reales if c["verdict"] != "PASS"]
        n_fail = [c for c in nuevas if c["verdict"] != "PASS"]
        add(f"- Preguntas reales: **{len(reales) - len(r_fail)}/{len(reales)} PASS**"
            + (f" (fallan: {', '.join(c['qid'] for c in r_fail)})." if r_fail else "."))
        add(f"- Composicionales nuevas: **{len(nuevas) - len(n_fail)}/{len(nuevas)} PASS**"
            + (f" (fallan: {', '.join(c['qid'] for c in n_fail)})." if n_fail else "."))
        add("")

    fails = [c for c in cases if c["verdict"] != "PASS"
             or any(not c["criteria"][k]["pass"] for k in CRITERIA)]
    add("## Fallos y observaciones del juez")
    add("")
    if not fails:
        add("Sin fallos: los 5 criterios pasaron en todos los casos.")
    for c in fails:
        if c["group"] == "real_world":
            tag = "REGRESIÓN REAL-WORLD"
        elif c["group"] == "agregacion":
            tag = f"agregación · {c.get('origen', 'agregación')}"
        else:
            tag = "muestra gold set"
        add(f"### {c['qid']} · {c['type']} · {tag} · veredicto: {c['verdict']}")
        add(f"- **Pregunta:** {c['question']}")
        for crit in CRITERIA:
            entry = c["criteria"][crit]
            if not entry["pass"]:
                add(f"- **({CRIT_SHORT[crit]}) {crit} FALLA:** {entry['nota']}")
        passed_notes = [
            f"({CRIT_SHORT[k]}) {c['criteria'][k]['nota']}"
            for k in CRITERIA
            if c["criteria"][k]["pass"] and c["criteria"][k]["nota"] and c["verdict"] != "PASS"
        ]
        if c.get("answer_head"):
            add(f"- **Respuesta (inicio):** {c['answer_head']}")
        if c.get("judge_verdict_raw") and c["judge_verdict_raw"] != c["verdict"]:
            add(f"- Nota: el juez dijo `{c['judge_verdict_raw']}`; el veredicto reportado "
                "aplica la regla determinista del enunciado.")
        add("")

    add("## Costo y duración de la corrida")
    add("")
    agent_s = sum(c["agent_s"] for c in cases)
    judge_s = sum(c["judge_s"] for c in cases)
    add(f"- Duración total: **{payload['elapsed_s']:.0f}s** "
        f"(agente: {agent_s:.0f}s, {agent_s / max(len(cases), 1):.0f}s/caso; "
        f"juez: {judge_s:.0f}s, {judge_s / max(len(cases), 1):.0f}s/caso).")
    add(f"- Hops del agente: {sum(c['n_hops'] for c in cases)} búsquedas en total "
        f"({sum(c['n_hops'] for c in cases) / max(len(cases), 1):.1f}/caso).")
    add("- Tokens medidos (chat completions; embeddings de búsqueda no incluidos, costo marginal):")
    for line in payload["usage_detail"]:
        add(f"  - {line}")
    add(f"- **Costo total aproximado: ~{payload['cost_estimate']:.2f} USD** con las tarifas "
        "asumidas indicadas (no hay tarifa oficial en el repo; los tokens medidos son exactos, "
        "el costo en USD es estimación).")
    add("- Comparación: la parte cara es la corrida del agente con el modelo grande "
        f"(`{payload['agent_model']}`); el juicio con `{JUDGE_MODEL}` añade una fracción menor "
        "del costo y de la duración por caso.")
    add("")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReporte escrito en {report_path}")


# --- Main -------------------------------------------------------------------------

async def run_all(args) -> None:
    from openai import AsyncOpenAI
    from app.config import get_settings

    settings = get_settings()
    if not settings.openai_api_key:
        raise SystemExit("OPENAI_API_KEY no está configurada en backend/.env")
    install_usage_capture()
    judge_client = AsyncOpenAI(api_key=settings.openai_api_key)

    real: list[dict] = []
    if args.agregacion:
        # Modo EXCLUSIVO: solo la categoría de agregación. Los 7+18 del flujo
        # normal ni se cargan; el informe va a docs/EVAL_AGREGACION.md.
        agg = json.loads(GOLD_AGREGACION.read_text(encoding="utf-8"))["questions"]
        cases_def: list[tuple[str, dict]] = [("agregacion", c) for c in agg]
        print(
            f"== Eval de AGREGACIÓN: {len(cases_def)} casos "
            f"(evals/gold_agregacion.json) | agente={settings.openai_model} "
            f"juez={JUDGE_MODEL} | secuencial"
            + (f" | tope de costo {args.max_cost:.2f} USD" if args.max_cost else ""),
            flush=True,
        )
    else:
        real = json.loads(GOLD_REAL_WORLD.read_text(encoding="utf-8"))["questions"]
        cases_def = [("real_world", c) for c in real]

        if not args.solo_real_world:
            gold = json.loads(GOLD_RETRIEVAL.read_text(encoding="utf-8"))["questions"]
            sample = gold if args.all else stratified_sample(gold, args.n, args.seed)
            cases_def += [("muestra_retrieval", c) for c in sample]

        print(
            f"== Eval de respuestas: {len(cases_def)} casos "
            f"({len(real)} real-world + {len(cases_def) - len(real)} gold set) | "
            f"agente={settings.openai_model} juez={JUDGE_MODEL} | secuencial",
            flush=True,
        )

    aborted = ""

    t0 = time.time()
    results: list[dict] = []
    for i, (group, case) in enumerate(cases_def, start=1):
        qid = case["qid"]
        question = case["question"]
        if group == "real_world":
            reference = build_reference_real_world(case)
        elif group == "agregacion":
            # Mismo mecanismo (hechos congelados + chunks reales + inventario
            # vivo), pero el encabezado dice que los hechos vienen del motor.
            reference = build_reference_real_world(case, header=REF_HEADER_ENGINE)
        else:
            reference = build_reference_gold(case)
        USAGE.set_component("agente")
        try:
            run = await run_agent_case(question)
        except Exception as exc:
            print(f"  [{i:>2}/{len(cases_def)}] ERROR agente {qid}: {exc}", flush=True)
            results.append({
                "qid": qid, "group": group, "type": case["type"],
                "question": question, "error": f"agente: {exc}",
                "verdict": "FAIL",
                "criteria": {c: {"pass": False, "nota": f"el agente falló: {exc}"}
                             for c in CRITERIA},
                "judge_verdict_raw": "", "n_hops": 0, "agent_s": 0.0,
                "judge_s": 0.0, "answer_head": "",
                "origen": case.get("origen", ""),
            })
            continue
        USAGE.set_component("juez")
        verdictdata = await judge_case(judge_client, question, run["content"], reference)
        USAGE.set_component(None)

        res = {
            "qid": qid,
            "group": group,
            "type": case["type"],
            "origen": case.get("origen", ""),
            "question": question,
            "answer": run["content"],
            "answer_head": run["content"][:220].replace("\n", " "),
            "n_hops": len(run["hops"]),
            "hops": run["hops"],
            "agent_s": run["agent_s"],
            "reference_head": reference[:400],
            **verdictdata,
        }
        results.append(res)
        status = "PASS" if res["verdict"] == "PASS" else "FAIL"
        print(
            f"  [{i:>2}/{len(cases_def)}] {status} {qid} "
            f"{GROUP_LABELS.get(group, ('GS', ''))[0]} {case['type'][:16]:<16} "
            f"[{_crit_flags(res)}] hops={res['n_hops']} "
            f"agente={res['agent_s']}s juez={res['judge_s']}s",
            flush=True,
        )

        # Guardia de presupuesto: corta ENTRE casos (nunca a mitad de uno), así
        # el informe parcial sigue siendo válido y se ve qué quedó sin correr.
        if args.max_cost:
            spent = USAGE.cost_estimate()[0]
            if spent > args.max_cost:
                aborted = (
                    f"ABORTADO por tope de costo: {spent:.2f} USD estimados > "
                    f"{args.max_cost:.2f} USD tras {len(results)} de "
                    f"{len(cases_def)} casos."
                )
                print(f"\n!! {aborted}", flush=True)
                break

    cost, detail = USAGE.cost_estimate()
    index_state: dict = {}
    if args.agregacion:
        try:
            from app.services.qdrant import index_inventory
            inv = index_inventory()
            index_state = {
                "total_chunks": inv["total_chunks"],
                "productos": inv["productos"],
                "archivos": len(inv["archivos"]),
                "suplidores": len(inv["suplidores"]),
                "marcas": len(inv["marcas"]),
            }
        except Exception as exc:  # el informe no debe caerse por esto
            print(f"(aviso: no se pudo leer el inventario del índice: {exc})")
    payload = {
        "aborted": aborted,
        "index_state": index_state,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elapsed_s": round(time.time() - t0, 1),
        "agent_model": settings.openai_model,
        "judge_model": JUDGE_MODEL,
        "max_hops": settings.max_hops,
        "seed": args.seed,
        "n_sample": args.n,
        "usage_by_model": USAGE.by_model,
        "usage_by_component": USAGE.by_component,
        "usage_detail": detail,
        "cost_estimate": cost,
        "cases": results,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = RESULTS_DIR / (
        "results_agregacion.json" if args.agregacion else "results_answers.json"
    )
    raw_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nResultados crudos en {raw_path}")

    report_path = args.report or (
        AGREGACION_REPORT if args.agregacion else DEFAULT_REPORT
    )
    write_report(payload, report_path)

    g = _agg(results)
    print(
        f"\n== Global: PASS {_pct(g['pass'])} de {g['n']} casos | "
        + " ".join(f"{CRIT_SHORT[c]}={_pct(g[c])}" for c in CRITERIA)
    )
    if args.agregacion:
        reales = [c for c in results if str(c.get("origen", "")).startswith("uso real")]
        r_fails = [c for c in reales if c["verdict"] != "PASS"]
        print(
            f"== Preguntas del uso real: {len(reales) - len(r_fails)}/{len(reales)} PASS"
            + (f" | FALLAN: {', '.join(c['qid'] for c in r_fails)}" if r_fails else "")
        )
        fails = [c for c in results if c["verdict"] != "PASS"]
        if fails:
            print(f"== FALLAN en total: {', '.join(c['qid'] for c in fails)}")
    else:
        rw_res = [c for c in results if c["group"] == "real_world"]
        rw_fails = [c for c in rw_res if c["verdict"] != "PASS"]
        print(
            f"== Regresiones real-world: {len(rw_res) - len(rw_fails)}/{len(rw_res)} PASS"
            + (f" | FALLAN: {', '.join(c['qid'] for c in rw_fails)}" if rw_fails else "")
        )
    print(f"== Costo aproximado: ~{cost:.2f} USD (tarifas asumidas) | {payload['elapsed_s']:.0f}s")
    if aborted:
        print(f"== {aborted}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluación a nivel de respuesta con juez LLM (gpt-5.4-mini)"
    )
    parser.add_argument("--n", type=int, default=18,
                        help="tamaño de la muestra estratificada del gold set (default 18)")
    parser.add_argument("--all", action="store_true",
                        help="usa las 60 preguntas del gold set (ignora --n)")
    parser.add_argument("--solo-real-world", action="store_true",
                        help="solo los 7 casos de regresión real-world")
    parser.add_argument("--agregacion", action="store_true",
                        help="SOLO los casos de evals/gold_agregacion.json "
                             "(orden/conteos/agrupaciones); informe en "
                             "docs/EVAL_AGREGACION.md")
    parser.add_argument("--max-cost", type=float, default=None,
                        help="tope de costo estimado en USD: aborta entre casos "
                             "si se supera (default: sin tope)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--report", type=Path, default=None,
                        help="ruta del informe (default: docs/EVAL_RESPUESTAS.md, "
                             "o docs/EVAL_AGREGACION.md con --agregacion)")
    args = parser.parse_args()
    asyncio.run(run_all(args))


if __name__ == "__main__":
    main()
