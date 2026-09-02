"""Evaluación A NIVEL DE RESPUESTA con juez LLM (complementa evals/run_eval.py).

Mientras run_eval.py mide si el retrieval TRAE el chunk correcto, este runner
mide si la RESPUESTA FINAL del agente (run_agent) es correcta: exactitud
factual, citas, advertencias de precio, honestidad y completitud, juzgadas por
`gpt-5.4-mini` en JSON mode contra una referencia factual verificada.

Uso (desde backend/ como cwd):
    .venv\\Scripts\\python.exe -X utf8 evals\\judge_answers.py [--n 18]
        : 7 real-world + muestra de 18 del gold set, retrieval híbrido; deja
          results.json + report.md en evals/results/<fecha>-answers/.
    ... judge_answers.py --all
        : los 67 casos (60 del gold set + 7 real-world).
    ... judge_answers.py --solo-real-world
        : solo los 7 de regresión.
    ... judge_answers.py --agregacion
        : EN EXCLUSIVA los 10 casos de evals/gold_agregacion.json.
    ... judge_answers.py --retrieval dense
        : fuerza búsqueda densa (sin BM25) en el agente.
    ... judge_answers.py --repeat 2
        : repite el conjunto 2 veces; reporta PASS medio y varianza por caso.
    ... judge_answers.py --write-docs
        : además del results dir, sobreescribe docs/EVAL_RESPUESTAS.md (o
          docs/EVAL_AGREGACION.md con --agregacion) validando que no haya
          guión largo. Solo con una corrida completa: si aborta se ignora.
    ... judge_answers.py --max-cost 1.50 --min-pass 0.8 --results-dir DIR
        : al superar el tope se corta ENTRE casos, se guardan los parciales y
          se sale con exit 2.

Selección de casos:
  - Los 7 casos de regresión de evals/gold_real_world.json SIEMPRE se corren
    (fallos reales de producción, hechos verificados por auditoría).
  - Más una muestra estratificada por tipo de `--n` (default 18) preguntas del
    gold set de retrieval (evals/gold_set.json). Para éstas la referencia
    factual es el TEXTO del chunk gold recuperado de Qdrant vía
    accept_ids/accept_skus.
  - `--all` usa las 60 del gold set (67 casos en total); `--solo-real-world`
    omite la muestra.
  - `--agregacion` corre EN EXCLUSIVA los 10 casos de evals/gold_agregacion.json
    (orden/conteos/agrupaciones exactos); no toca los 7+18 del flujo normal.

Los casos se ejecutan SECUENCIALMENTE (cada uno es una corrida real del agente
con el modelo de producción). Cada caso arranca su propia telemetría
(`telemetry.start`) antes de `run_agent`: agente, reranker, embeddings y juez
quedan medidos por componente con el `usage` real del API, y el coste (USD,
estimado con tarifas asumidas) se acumula para `--max-cost`. Los errores
transitorios (429 puntuales, red) se reintentan con backoff; al primer error
de cuota/facturación se corta sin reintentar, se guardan los parciales y se
sale con exit 2.

Exit codes: 0 todos PASS o sin umbral; 1 PASS rate < --min-pass (default 0.0,
informativo); 2 error de infraestructura, cuota o corrida abortada por
--max-cost; 3 documento con guión largo.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.services import telemetry  # noqa: E402
from app.services.telemetry import PRICING_LABEL, cost_estimate  # noqa: E402
from evals.common import (  # noqa: E402
    EXIT_ERROR,
    EXIT_FAIL,
    EXIT_OK,
    RETRIEVAL_MODES,
    GoldItem,
    fingerprint_index,
    force_retrieval_mode,
    is_quota_error,
    load_gold,
    mean_std,
    now_iso,
    results_dir,
    run_metadata,
    sanitize,
    write_doc,
    write_json,
)

GOLD_RETRIEVAL = BACKEND_DIR / "evals" / "gold_set.json"
GOLD_REAL_WORLD = BACKEND_DIR / "evals" / "gold_real_world.json"
GOLD_AGREGACION = BACKEND_DIR / "evals" / "gold_agregacion.json"
DEFAULT_REPORT = PROJECT_DIR / "docs" / "EVAL_RESPUESTAS.md"
AGREGACION_REPORT = PROJECT_DIR / "docs" / "EVAL_AGREGACION.md"

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

TOKEN_KEYS = ("prompt", "cached", "completion", "reasoning")


class QuotaAbort(RuntimeError):
    """Error de cuota/facturación de OpenAI: se corta la corrida sin reintentar."""


# --- Reintentos de errores transitorios ---------------------------------------

async def _with_retries(fn, attempts: int = 4, what: str = ""):
    """Reintenta transitorios con backoff; la cuota sube como QuotaAbort."""
    for attempt in range(attempts):
        try:
            return await fn()
        except QuotaAbort:
            raise
        except Exception as exc:
            if is_quota_error(exc):
                raise QuotaAbort(str(exc)) from exc
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


def build_reference_real_world(item: GoldItem, header: str = REF_HEADER_AUDIT) -> str:
    """Referencia de los casos con `expected` (real-world y agregación): hechos
    congelados + texto real de los `ref_skus` + inventario vivo si se pide."""
    from app.services.qdrant import find_by_skus, index_inventory

    case = item.raw
    parts = [header, item.expected or ""]
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


def build_reference_gold(item: GoldItem) -> str:
    """Referencia de los casos del gold de retrieval: el texto del chunk gold."""
    from app.services.qdrant import find_by_skus

    case = item.raw
    chunks = _chunks_by_ids(item.accept_ids)
    if not chunks and item.accept_skus:
        chunks = find_by_skus(list(item.accept_skus), _MAX_REF_CHUNKS)
    header = (
        "PRODUCTO GOLD (el retrieval correcto para esta pregunta):\n"
        f"- Producto: {case.get('ref_product')}\n"
        f"- SKU de referencia: {case.get('ref_sku')} "
        f"(también aceptables: {', '.join(item.accept_skus)})\n"
        f"- Fuente correcta: [{case.get('source_file')}, pág. {case.get('ref_page')}]\n"
        "Nota: si la respuesta presenta una variante hermana real de la misma "
        "familia (mismo catálogo) con datos correctos y citados, no es un dato "
        "inventado; júzgala por fidelidad al texto de referencia."
    )
    body = _format_ref_chunks(
        chunks, "TEXTO DEL CHUNK GOLD (referencia factual, extraído del índice):"
    ) if chunks else "ADVERTENCIA: no se pudo recuperar el chunk gold del índice."
    return header + "\n\n" + body


def build_reference(group: str, item: GoldItem) -> str:
    if group == "real_world":
        return build_reference_real_world(item)
    if group == "agregacion":
        # Mismo mecanismo (hechos congelados + chunks reales + inventario
        # vivo), pero el encabezado dice que los hechos vienen del motor.
        return build_reference_real_world(item, header=REF_HEADER_ENGINE)
    return build_reference_gold(item)


# --- Corrida del agente ---------------------------------------------------------

async def run_agent_case(question: str, history: list[dict]) -> dict:
    from app.services.agent import run_agent

    async def _run() -> dict:
        final = None
        async for ev in run_agent(question, history):
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


async def judge_case(question: str, answer: str, reference: str) -> dict:
    """Una llamada al juez. Usa el cliente compartido bajo el semáforo y anota
    su `usage` en la telemetría del caso (componente "juez"), así el coste del
    caso incluye al juez separado del agente."""
    from app.services.openai_client import get_async_client, openai_slot

    tel = telemetry.current()
    user = (
        f"PREGUNTA DEL USUARIO:\n{question}\n\n"
        f"RESPUESTA DEL AGENTE:\n{answer or '(respuesta vacía)'}\n\n"
        f"REFERENCIA FACTUAL:\n{reference}\n\n"
        f"{JUDGE_RUBRIC}"
    )

    async def _call() -> dict:
        t_call = time.perf_counter()
        try:
            async with openai_slot():
                resp = await get_async_client().chat.completions.create(
                    model=JUDGE_MODEL,
                    response_format={"type": "json_object"},
                    messages=[
                        {"role": "system", "content": JUDGE_SYSTEM},
                        {"role": "user", "content": user},
                    ],
                )
        except Exception as exc:
            tel.record("juez", JUDGE_MODEL, None, (time.perf_counter() - t_call) * 1000.0,
                       ok=False, note=type(exc).__name__)
            raise
        choice = resp.choices[0] if resp.choices else None
        content = getattr(getattr(choice, "message", None), "content", None)
        tel.record(
            "juez", JUDGE_MODEL, resp.usage, (time.perf_counter() - t_call) * 1000.0,
            ok=bool(content), finish_reason=getattr(choice, "finish_reason", None),
            note="" if content else "respuesta sin contenido",
        )
        if not content:
            # content None (refusal, content_filter, length sin texto) haría
            # que json.loads lanzara TypeError y saltara el reintento de abajo.
            raise json.JSONDecodeError("respuesta sin contenido", "", 0)
        return json.loads(content)

    t0 = time.time()
    last_exc: Exception | None = None
    data = None
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

def stratified_sample(items: list[GoldItem], n: int, seed: int) -> list[GoldItem]:
    if n >= len(items):
        return list(items)
    by_type: dict[str, list[GoldItem]] = {}
    for q in items:
        by_type.setdefault(q.type, []).append(q)
    total = len(items)
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
    out: list[GoldItem] = []
    for t, qs in sorted(by_type.items()):
        out.extend(rng.sample(qs, min(quotas[t], len(qs))))
    out.sort(key=lambda q: q.id)
    return out


def select_cases(args) -> list[tuple[str, GoldItem]]:
    """(grupo, caso) en el orden de ejecución."""
    if args.agregacion:
        # Modo EXCLUSIVO: solo la categoría de agregación. Los 7+18 del flujo
        # normal ni se cargan.
        return [("agregacion", it) for it in load_gold(GOLD_AGREGACION)]
    cases = [("real_world", it) for it in load_gold(GOLD_REAL_WORLD)]
    if not args.solo_real_world:
        gold = load_gold(GOLD_RETRIEVAL)
        sample = gold if args.all else stratified_sample(gold, args.n, args.seed)
        cases += [("muestra_retrieval", it) for it in sample]
    return cases


# --- Un caso completo (agente + juez) con su telemetría -------------------------

def _tokens_of(summary: dict) -> dict:
    return {k: int(summary.get("tokens", {}).get(k, 0)) for k in TOKEN_KEYS}


def _error_case(group: str, item: GoldItem, rep: int, stage: str, exc: BaseException,
                tel: telemetry.Telemetry, agent_s: float = 0.0) -> dict:
    summary = tel.summary()
    return {
        "qid": item.id, "group": group, "type": item.type, "repetition": rep,
        "origen": item.raw.get("origen", ""), "question": item.question,
        "error": f"{stage}: {type(exc).__name__}: {str(exc)[:300]}",
        "verdict": "ERROR",
        "criteria": {c: {"pass": False, "nota": f"no evaluado: falló el {stage}"}
                     for c in CRITERIA},
        "judge_verdict_raw": "", "n_hops": 0, "hops": [], "agent_s": agent_s,
        "judge_s": 0.0, "answer": "", "answer_head": "", "reference_head": "",
        "telemetry": summary,
        "tokens": _tokens_of(summary),
        "cost_usd": summary["cost_usd"],
    }


async def run_case(group: str, item: GoldItem, rep: int, retrieval: str, settings) -> dict:
    """Ejecuta un caso dentro de SU tarea: la telemetría se fija aquí (el
    ContextVar queda aislado por tarea) antes de run_agent, y el juez anota en
    la misma. Un error de cuota sube como QuotaAbort para cortar la corrida."""
    tel = telemetry.start(
        case_id=item.id, group=group, repetition=rep, retrieval=retrieval,
        prompt_version=settings.prompt_version,
    )
    try:
        reference = await asyncio.to_thread(build_reference, group, item)
    except Exception as exc:
        if is_quota_error(exc):
            raise QuotaAbort(str(exc)) from exc
        return _error_case(group, item, rep, "armado de la referencia", exc, tel)

    try:
        run = await run_agent_case(item.question, item.history)
    except QuotaAbort:
        raise
    except Exception as exc:
        return _error_case(group, item, rep, "agente", exc, tel)
    tel.mark("agente_fin")

    try:
        verdictdata = await judge_case(item.question, run["content"], reference)
    except QuotaAbort:
        raise
    except Exception as exc:
        return _error_case(group, item, rep, "juez", exc, tel, agent_s=run["agent_s"])
    tel.mark("juez_fin")

    summary = tel.summary()
    return {
        "qid": item.id,
        "group": group,
        "type": item.type,
        "repetition": rep,
        "origen": item.raw.get("origen", ""),
        "question": item.question,
        "reference": item.reference(),
        "answer": run["content"],
        "answer_head": run["content"][:220].replace("\n", " "),
        "n_hops": len(run["hops"]),
        "hops": run["hops"],
        "agent_s": run["agent_s"],
        "reference_head": reference[:400],
        "telemetry": summary,
        "tokens": _tokens_of(summary),
        "cost_usd": summary["cost_usd"],
        **verdictdata,
    }


# --- Agregados y reporte -----------------------------------------------------------

def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _usd(x: float) -> str:
    return f"{x:.4f} USD"


def _verdict_cell(c: dict) -> str:
    if c["verdict"] == "PASS":
        return "PASS"
    return f"**{c['verdict']}**"


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
        "errors": sum(c["verdict"] == "ERROR" for c in cases),
    }
    for crit in CRITERIA:
        out[crit] = sum(c["criteria"][crit]["pass"] for c in cases) / n
    return out


def _sum_tokens(cases: list[dict]) -> dict:
    tot = {k: 0 for k in TOKEN_KEYS}
    for c in cases:
        for k in TOKEN_KEYS:
            tot[k] += int(c.get("tokens", {}).get(k, 0))
    return tot


def _component_rollup(cases: list[dict]) -> dict[str, dict]:
    """Tokens, rondas, ms y coste (estimado) por componente, sumando las rondas
    de la telemetría de cada caso; el coste sale de tarifa(modelo) por ronda."""
    out: dict[str, dict] = {}
    for c in cases:
        for r in c.get("telemetry", {}).get("rounds", []):
            agg = out.setdefault(r["component"], {
                "rounds": 0, "errors": 0, "ms": 0.0, "cost_usd": 0.0,
                **{k: 0 for k in TOKEN_KEYS},
            })
            agg["rounds"] += 1
            agg["errors"] += 0 if r.get("ok", True) else 1
            agg["ms"] = round(agg["ms"] + float(r.get("ms", 0.0)), 1)
            for k in TOKEN_KEYS:
                agg[k] += int(r.get(k, 0))
            agg["cost_usd"] += cost_estimate({r["model"]: {
                "prompt": r.get("prompt", 0), "cached": r.get("cached", 0),
                "completion": r.get("completion", 0),
            }})
    for agg in out.values():
        agg["cost_usd"] = round(agg["cost_usd"], 6)
    return out


def _model_rollup(cases: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for c in cases:
        for model, t in c.get("telemetry", {}).get("by_model", {}).items():
            agg = out.setdefault(model, {k: 0 for k in TOKEN_KEYS})
            for k in TOKEN_KEYS:
                agg[k] += int(t.get(k, 0))
    for model, agg in out.items():
        agg["cost_usd"] = round(cost_estimate({model: agg}), 6)
    return out


def _stability(repetitions: list[list[dict]]) -> dict:
    """PASS medio y varianza por caso entre repeticiones, y PASS global
    medio con desviación entre repeticiones."""
    per_case: dict[str, list[int]] = {}
    for cases in repetitions:
        for c in cases:
            per_case[c["qid"]] = per_case.get(c["qid"], []) + [1 if c["verdict"] == "PASS" else 0]
    cases_stats = {}
    for qid, vals in per_case.items():
        mean, std = mean_std(vals)
        cases_stats[qid] = {
            "n": len(vals), "pass_rate": round(mean, 4), "variance": round(std * std, 4),
            "verdicts": vals,
        }
    globals_ = [_agg(cases)["pass"] for cases in repetitions if cases]
    g_mean, g_std = mean_std(globals_)
    return {
        "repeat": len(repetitions),
        "pass_global": {"mean": round(g_mean, 4), "std": round(g_std, 4),
                        "values": [round(v, 4) for v in globals_]},
        "cases": cases_stats,
        "unstable": sorted(q for q, s in cases_stats.items() if len(set(s["verdicts"])) > 1),
    }


def build_report(payload: dict) -> str:
    cases = payload["cases"]
    rw = [c for c in cases if c["group"] == "real_world"]
    sm = [c for c in cases if c["group"] == "muestra_retrieval"]
    ag = [c for c in cases if c["group"] == "agregacion"]
    solo_ag = bool(ag) and not rw and not sm
    meta = payload.get("run_metadata") or {}
    fp = payload.get("fingerprint") or {}
    repeat = int(payload.get("repeat") or 1)
    stability = payload.get("stability") or {}
    lines: list[str] = []
    add = lines.append

    if solo_ag:
        add("# Evaluación de AGREGACIÓN (juez LLM): RAG de catálogos")
    else:
        add("# Evaluación de respuestas (juez LLM): RAG de catálogos")
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
            f"Retrieval: **{payload['retrieval']}** · "
            f"Duración total: {payload['elapsed_s']:.0f}s."
        )
    else:
        add(
            f"Fecha: {payload['started_at'][:10]} · Agente: `{payload['agent_model']}` "
            f"(pipeline completo `run_agent`, {payload['max_hops']} hops máx.) · "
            f"Juez: `{JUDGE_MODEL}` (JSON mode) · Casos: {len(rw)} de regresión real-world "
            f"+ {len(sm)} muestreados del gold set de retrieval (semilla {payload['seed']}) · "
            f"Retrieval: **{payload['retrieval']}** · "
            f"Duración total: {payload['elapsed_s']:.0f}s."
        )
    add("")
    if payload.get("aborted"):
        add(f"> **{payload['aborted']}** El informe cubre solo los casos ejecutados.")
        add("")
    add("## Condiciones de la medición")
    add("")
    add(f"- Prompt del agente: `{meta.get('prompt_version', '?')}` · modelo: "
        f"`{meta.get('openai_model', '?')}` · reranker: `{meta.get('rerank_model_resolved', '?')}` · "
        f"embeddings: `{meta.get('embedding_model', '?')}` · max_hops={meta.get('max_hops', '?')} · "
        f"search_top_k={meta.get('search_top_k', '?')} · rerank_top_k={meta.get('rerank_top_k', '?')} · "
        f"Python {meta.get('python', '?')} · commit `{meta.get('git_commit') or 'n/d'}`.")
    add(f"- Retrieval efectivo: **{payload['retrieval']}** (pedido: {payload.get('retrieval_requested', '?')}). "
        f"Repeticiones del conjunto: {repeat}.")
    if fp:
        by_file = fp.get("by_source_file") or {}
        add(f"- Índice Qdrant: colección `{fp.get('collection')}` en `{fp.get('qdrant_host')}` "
            f"(Qdrant {fp.get('qdrant_version') or 'n/d'}): {fp.get('total_points')} puntos, "
            f"{fp.get('products')} productos en {len(by_file)} archivos; huella tomada "
            f"{fp.get('taken_at')}.")
    else:
        add("- Índice Qdrant: huella no disponible.")
    add("- Dos corridas solo son comparables si coinciden prompt, modelos, modo de retrieval "
        "y huella del índice.")
    add("")
    add("## Metodología")
    add("")
    add("- **Qué mide**: la calidad de la RESPUESTA FINAL del agente (no del retrieval, "
        "eso lo cubre `docs/EVAL_RETRIEVAL.md`). Cada caso ejecuta `run_agent(pregunta, historial)` "
        "en proceso y acumula el evento `final` (content + sources + hops); los casos corren "
        "secuencialmente y los errores transitorios (429...) se reintentan con backoff. Un error "
        "de cuota corta la corrida sin reintentar y se informa arriba.")
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
            "de forma exacta (`_execute_catalog_query`, `scan_by_price`/`group_values`). Seis "
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
        "PASS si (a), (b) y (d) pasan y como máximo uno de (c)/(e) falla. `ERROR` = el caso no "
        "pudo evaluarse (falló el agente o el juez) y cuenta como no-PASS.")
    add("- **Telemetría**: cada caso arranca `telemetry.start()` antes de `run_agent`; agente, "
        "reranker, embeddings y juez anotan el `usage` real del API por ronda. Los tokens son "
        f"medidos; toda cifra en USD es {PRICING_LABEL}.")
    add("")
    add("## Resultados globales")
    add("")
    add("| Grupo | n | PASS global | errores | (a) exactitud | (b) citas | (c) advertencias | (d) honestidad | (e) completitud |")
    add("|---|---|---|---|---|---|---|---|---|")
    groups_row = [("Regresión real-world", rw), ("Muestra retrieval", sm), ("Agregación", ag)]
    if not solo_ag:  # con un solo grupo la fila Total sería un duplicado
        groups_row.append(("**Total**", cases))
    for label, group in groups_row:
        if not group:
            continue
        g = _agg(group)
        add(
            f"| {label} | {g['n']} | {_pct(g['pass'])} | {g['errors']} | {_pct(g['exactitud_factual'])} | "
            f"{_pct(g['citas'])} | {_pct(g['advertencias'])} | {_pct(g['honestidad'])} | "
            f"{_pct(g['completitud'])} |"
        )
    if repeat > 1:
        add("")
        add("(Tabla de la repetición 1; las secciones de detalle también.)")
    add("")
    if repeat > 1 and stability:
        pg = stability["pass_global"]
        add("## Estabilidad entre repeticiones")
        add("")
        add(f"El conjunto se corrió {stability['repeat']} veces. PASS global medio: "
            f"**{_pct(pg['mean'])}** (desviación típica muestral {_pct(pg['std'])}; valores: "
            + ", ".join(_pct(v) for v in pg["values"]) + ").")
        add("")
        add("| Caso | repeticiones | PASS medio | varianza | veredictos (1=PASS) |")
        add("|---|---|---|---|---|")
        for qid, s in sorted(stability["cases"].items()):
            add(f"| {qid} | {s['n']} | {_pct(s['pass_rate'])} | {s['variance']:.3f} | "
                f"{''.join(str(v) for v in s['verdicts'])} |")
        add("")
        unstable = stability.get("unstable") or []
        add(f"Casos con veredicto inestable: **{len(unstable)}**"
            + (": " + ", ".join(unstable) if unstable else "."))
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
            add(
                f"| {c['qid']} | {c.get('origen', '-')} | {c['type']} | "
                f"{c['question']} | `{_crit_flags(c)}` | {_verdict_cell(c)} | {c['n_hops']} | "
                f"{c['agent_s']} | {c['judge_s']} |"
            )
    else:
        add("| Caso | Grupo | Tipo | Criterios | Veredicto | Hops | s agente | s juez |")
        add("|---|---|---|---|---|---|---|---|")
        for c in cases:
            add(
                f"| {c['qid']} | {GROUP_LABELS.get(c['group'], ('GS', ''))[0]} | {c['type']} | "
                f"`{_crit_flags(c)}` | {_verdict_cell(c)} | {c['n_hops']} | {c['agent_s']} | {c['judge_s']} |"
            )
    add("")

    if rw:
        rw_fails = [c for c in rw if c["verdict"] != "PASS"]
        add(f"## Estado de las {len(rw)} regresiones real-world")
        add("")
        if rw_fails:
            add(f"**ATENCIÓN: {len(rw_fails)} de {len(rw)} casos de regresión no pasan** "
                "(los fallos de producción auditados siguen, total o parcialmente, sin resolver):")
            for c in rw_fails:
                add(f"- **{c['qid']} ({c['type']}) {c['verdict']}**: \"{c['question']}\"")
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
            add(f"| {c['qid']} | {c['question']} | {_verdict_cell(c)} |")
        add("")
        r_fail = [c for c in reales if c["verdict"] != "PASS"]
        n_fail = [c for c in nuevas if c["verdict"] != "PASS"]
        add(f"- Preguntas reales: **{len(reales) - len(r_fail)}/{len(reales)} PASS**"
            + (f" (no pasan: {', '.join(c['qid'] for c in r_fail)})." if r_fail else "."))
        add(f"- Composicionales nuevas: **{len(nuevas) - len(n_fail)}/{len(nuevas)} PASS**"
            + (f" (no pasan: {', '.join(c['qid'] for c in n_fail)})." if n_fail else "."))
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
        if c.get("error"):
            add(f"- **Error:** {c['error']}")
        for crit in CRITERIA:
            entry = c["criteria"][crit]
            if not entry["pass"]:
                add(f"- **({CRIT_SHORT[crit]}) {crit} FALLA:** {entry['nota']}")
        if c.get("answer_head"):
            add(f"- **Respuesta (inicio):** {c['answer_head']}")
        if c.get("judge_verdict_raw") and c["judge_verdict_raw"] != c["verdict"]:
            add(f"- Nota: el juez dijo `{c['judge_verdict_raw']}`; el veredicto reportado "
                "aplica la regla determinista del enunciado.")
        add("")

    # --- Coste y tokens: todo lo medido por la telemetría, USD siempre etiquetado.
    all_cases = [c for rep_cases in payload.get("repetitions", [cases]) for c in rep_cases]
    comp = _component_rollup(all_cases)
    models = _model_rollup(all_cases)
    tot = _sum_tokens(all_cases)
    total_cost = float(payload.get("cost_estimate", 0.0))
    agent_s = sum(c["agent_s"] for c in all_cases)
    judge_s = sum(c["judge_s"] for c in all_cases)
    n_all = max(len(all_cases), 1)
    add("## Costo, tokens y duración de la corrida")
    add("")
    add(f"Cubre las {len(all_cases)} ejecuciones de caso de la corrida"
        + (f" ({repeat} repeticiones)" if repeat > 1 else "") + ". Los tokens son los "
        f"`usage` reales del API (embeddings incluidos); **toda cifra en USD es {PRICING_LABEL}**.")
    add("")
    add(f"- Duración total: **{payload['elapsed_s']:.0f}s** "
        f"(agente: {agent_s:.0f}s, {agent_s / n_all:.0f}s/caso; "
        f"juez: {judge_s:.0f}s, {judge_s / n_all:.0f}s/caso).")
    add(f"- Hops del agente: {sum(c['n_hops'] for c in all_cases)} búsquedas en total "
        f"({sum(c['n_hops'] for c in all_cases) / n_all:.1f}/caso).")
    add(f"- Tokens totales: prompt {tot['prompt']:,} (cacheados {tot['cached']:,}), "
        f"completion {tot['completion']:,} (razonamiento {tot['reasoning']:,}).")
    add(f"- **Costo total: {_usd(total_cost)} ({PRICING_LABEL})**; "
        f"{_usd(total_cost / n_all)} por caso ({PRICING_LABEL}).")
    add("")
    add(f"### Por componente (USD: {PRICING_LABEL})")
    add("")
    add("| Componente | rondas | errores | prompt | cached | completion | reasoning | ms | USD |")
    add("|---|---|---|---|---|---|---|---|---|")
    for name, a in sorted(comp.items()):
        add(f"| {name} | {a['rounds']} | {a['errors']} | {a['prompt']:,} | {a['cached']:,} | "
            f"{a['completion']:,} | {a['reasoning']:,} | {a['ms']:.0f} | {_usd(a['cost_usd'])} |")
    add("")
    add(f"### Por modelo (USD: {PRICING_LABEL})")
    add("")
    add("| Modelo | prompt | cached | completion | reasoning | USD |")
    add("|---|---|---|---|---|---|")
    for model, a in sorted(models.items()):
        add(f"| `{model}` | {a['prompt']:,} | {a['cached']:,} | {a['completion']:,} | "
            f"{a['reasoning']:,} | {_usd(a['cost_usd'])} |")
    unknown = sorted({m for c in all_cases for m in c.get("telemetry", {}).get("unknown_models", [])})
    if unknown:
        add("")
        add(f"Modelos sin tarifa asumida (suman 0 USD): {', '.join(f'`{m}`' for m in unknown)}.")
    add("")
    add(f"### Por caso (USD: {PRICING_LABEL})")
    add("")
    add("| Caso | rep | veredicto | rondas agente | prompt | cached | completion | reasoning | ms | USD |")
    add("|---|---|---|---|---|---|---|---|---|---|")
    for c in all_cases:
        t = c.get("tokens", {})
        tel = c.get("telemetry", {})
        add(f"| {c['qid']} | {c.get('repetition', 1)} | {c['verdict']} | {tel.get('agent_rounds', 0)} | "
            f"{t.get('prompt', 0):,} | {t.get('cached', 0):,} | {t.get('completion', 0):,} | "
            f"{t.get('reasoning', 0):,} | {tel.get('ms_total', 0):.0f} | {_usd(c.get('cost_usd', 0.0))} |")
    add(f"| **Total** | | | | {tot['prompt']:,} | {tot['cached']:,} | {tot['completion']:,} | "
        f"{tot['reasoning']:,} | | **{_usd(total_cost)}** |")
    add("")
    add("- Comparación: la parte cara es la corrida del agente con el modelo grande "
        f"(`{payload['agent_model']}`); el juicio con `{JUDGE_MODEL}` añade una fracción menor "
        "del costo y de la duración por caso.")
    add("")
    return "\n".join(lines)


# --- Main -------------------------------------------------------------------------

async def run_all(args) -> int:
    from app.config import get_settings

    settings = get_settings()
    if not settings.openai_api_key:
        print("OPENAI_API_KEY no está configurada en backend/.env", file=sys.stderr)
        return EXIT_ERROR

    retrieval = force_retrieval_mode(args.retrieval)
    metadata = run_metadata()
    label = "agregacion" if args.agregacion else "answers"
    out_dir = results_dir(label, forced=args.results_dir)
    print(f"Carpeta de resultados: {out_dir}", flush=True)

    try:
        cases_def = select_cases(args)
    except Exception as exc:
        print(f"ERROR cargando los gold sets: {exc}", file=sys.stderr)
        return EXIT_ERROR
    n_real = sum(1 for g, _ in cases_def if g == "real_world")
    if args.agregacion:
        print(
            f"== Eval de AGREGACIÓN: {len(cases_def)} casos "
            f"(evals/gold_agregacion.json) | agente={settings.openai_model} "
            f"juez={JUDGE_MODEL} | retrieval={retrieval} | secuencial | repeat={args.repeat}"
            + (f" | tope de costo {args.max_cost:.2f} USD ({PRICING_LABEL})" if args.max_cost else ""),
            flush=True,
        )
    else:
        print(
            f"== Eval de respuestas: {len(cases_def)} casos "
            f"({n_real} real-world + {len(cases_def) - n_real} gold set) | "
            f"agente={settings.openai_model} juez={JUDGE_MODEL} | retrieval={retrieval} | "
            f"secuencial | repeat={args.repeat}"
            + (f" | tope de costo {args.max_cost:.2f} USD ({PRICING_LABEL})" if args.max_cost else ""),
            flush=True,
        )

    fingerprint: dict | None = None
    try:
        fingerprint = fingerprint_index()
    except Exception as exc:
        print(f"ERROR: no se pudo leer el índice Qdrant: {exc}", file=sys.stderr)
        return EXIT_ERROR

    aborted = ""
    exit_code = EXIT_OK
    spent = 0.0
    t0 = time.time()
    repetitions: list[list[dict]] = []
    total = len(cases_def) * args.repeat
    done = 0
    for rep in range(1, args.repeat + 1):
        results: list[dict] = []
        repetitions.append(results)
        if args.repeat > 1:
            print(f"\n### Repetición {rep}/{args.repeat}", flush=True)
        for group, item in cases_def:
            done += 1
            # Cada caso corre en su propia tarea: telemetry.start() dentro de
            # ella fija un ContextVar aislado (asyncio copia el contexto).
            try:
                res = await asyncio.create_task(run_case(group, item, rep, retrieval, settings))
            except QuotaAbort as exc:
                aborted = (
                    f"ABORTADO por cuota de OpenAI (sin reintentos) en {item.id}: "
                    f"{str(exc)[:200]}. {done - 1} de {total} ejecuciones completadas."
                )
                print(f"\n!! {aborted}", flush=True)
                exit_code = EXIT_ERROR
                break
            results.append(res)
            spent += float(res.get("cost_usd", 0.0))
            status = res["verdict"]
            print(
                f"  [{done:>2}/{total}] {status:<5} {item.id} "
                f"{GROUP_LABELS.get(group, ('GS', ''))[0]} {item.type[:16]:<16} "
                f"[{_crit_flags(res)}] hops={res['n_hops']} "
                f"agente={res['agent_s']}s juez={res['judge_s']}s "
                f"coste={res.get('cost_usd', 0.0):.4f} USD acumulado={spent:.4f} USD ({PRICING_LABEL})",
                flush=True,
            )
            if res.get("error"):
                print(f"      error: {res['error']}", flush=True)

            # Guardia de presupuesto: corta ENTRE casos (nunca a mitad de uno), así
            # el informe parcial sigue siendo válido y se ve qué quedó sin correr.
            if args.max_cost and spent > args.max_cost:
                aborted = (
                    f"ABORTADO por tope de costo: {spent:.4f} USD estimados ({PRICING_LABEL}) > "
                    f"{args.max_cost:.2f} USD tras {done} de {total} ejecuciones."
                )
                print(f"\n!! {aborted}", flush=True)
                exit_code = EXIT_ERROR
                break
        if aborted:
            break

    first = repetitions[0] if repetitions else []
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
    all_cases = [c for rep_cases in repetitions for c in rep_cases]
    payload = {
        "aborted": aborted,
        "index_state": index_state,
        "fingerprint": fingerprint,
        "run_metadata": metadata,
        "retrieval_requested": args.retrieval,
        "retrieval": retrieval,
        "repeat": args.repeat,
        "min_pass": args.min_pass,
        "max_cost": args.max_cost,
        "started_at": metadata["started_at"],
        "finished_at": now_iso(),
        "elapsed_s": round(time.time() - t0, 1),
        "agent_model": settings.openai_model,
        "judge_model": JUDGE_MODEL,
        "max_hops": settings.max_hops,
        "seed": args.seed,
        "n_sample": args.n,
        "tokens_total": _sum_tokens(all_cases),
        "usage_by_component": _component_rollup(all_cases),
        "usage_by_model": _model_rollup(all_cases),
        "cost_estimate": round(spent, 6),
        "cost_label": PRICING_LABEL,
        "stability": _stability(repetitions) if args.repeat > 1 else {},
        "cases": first,
        "repetitions": repetitions,
    }
    write_json(out_dir / "results.json", payload)
    print(f"\nResultados en {out_dir / 'results.json'}")

    if not first:
        print("Ningún caso completado: no hay informe que escribir.", file=sys.stderr)
        return EXIT_ERROR

    # Respuestas y notas del juez vienen de un LLM: se sanean antes de
    # escribir; write_doc sigue vigilando el texto propio del informe.
    report = sanitize(build_report(payload))
    write_doc(out_dir / "report.md", report, force=True)
    print(f"Informe escrito en {out_dir / 'report.md'}")
    if args.write_docs:
        doc_path = args.report or (AGREGACION_REPORT if args.agregacion else DEFAULT_REPORT)
        if aborted:
            # Un informe parcial no debe reemplazar el documento del repo.
            print(f"--write-docs ignorado (corrida abortada): {doc_path} no se actualiza.",
                  file=sys.stderr)
        else:
            write_doc(doc_path, report, force=True)
            print(f"Documento actualizado: {doc_path}")

    g = _agg(first)
    print(
        f"\n== Global (repetición 1): PASS {_pct(g['pass'])} de {g['n']} casos | "
        + " ".join(f"{CRIT_SHORT[c]}={_pct(g[c])}" for c in CRITERIA)
        + (f" | errores={g['errors']}" if g["errors"] else "")
    )
    if args.repeat > 1 and payload["stability"]:
        pg = payload["stability"]["pass_global"]
        print(f"== PASS medio en {args.repeat} repeticiones: {_pct(pg['mean'])} (std {_pct(pg['std'])}); "
              f"casos inestables: {', '.join(payload['stability']['unstable']) or 'ninguno'}")
    if args.agregacion:
        reales = [c for c in first if str(c.get("origen", "")).startswith("uso real")]
        r_fails = [c for c in reales if c["verdict"] != "PASS"]
        print(
            f"== Preguntas del uso real: {len(reales) - len(r_fails)}/{len(reales)} PASS"
            + (f" | NO PASAN: {', '.join(c['qid'] for c in r_fails)}" if r_fails else "")
        )
        fails = [c for c in first if c["verdict"] != "PASS"]
        if fails:
            print(f"== NO PASAN en total: {', '.join(c['qid'] for c in fails)}")
    else:
        rw_res = [c for c in first if c["group"] == "real_world"]
        rw_fails = [c for c in rw_res if c["verdict"] != "PASS"]
        print(
            f"== Regresiones real-world: {len(rw_res) - len(rw_fails)}/{len(rw_res)} PASS"
            + (f" | NO PASAN: {', '.join(c['qid'] for c in rw_fails)}" if rw_fails else "")
        )
    print(f"== Costo: {spent:.4f} USD ({PRICING_LABEL}) | {payload['elapsed_s']:.0f}s")
    if aborted:
        print(f"== {aborted}")

    if exit_code != EXIT_OK:
        return exit_code
    pass_rate = payload["stability"]["pass_global"]["mean"] if payload["stability"] else g["pass"]
    if args.min_pass > 0.0 and pass_rate < args.min_pass:
        print(f"FAIL: PASS rate {_pct(pass_rate)} < umbral {_pct(args.min_pass)}")
        return EXIT_FAIL
    return EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluación a nivel de respuesta con juez LLM (gpt-5.4-mini)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ejemplos:\n"
            "  python -X utf8 evals/judge_answers.py\n"
            "  python -X utf8 evals/judge_answers.py --all --retrieval dense\n"
            "  python -X utf8 evals/judge_answers.py --agregacion --repeat 2\n"
            "  python -X utf8 evals/judge_answers.py --solo-real-world --write-docs\n"
            "Exit codes: 0 ok, 1 PASS rate bajo --min-pass, 2 error/cuota, 3 documento con guión largo."
        ),
    )
    parser.add_argument("--n", type=int, default=18,
                        help="tamaño de la muestra estratificada del gold set (default 18)")
    parser.add_argument("--all", action="store_true",
                        help="usa las 60 preguntas del gold set: 67 casos con los 7 real-world (ignora --n)")
    parser.add_argument("--solo-real-world", action="store_true",
                        help="solo los 7 casos de regresión real-world")
    parser.add_argument("--agregacion", action="store_true",
                        help="SOLO los casos de evals/gold_agregacion.json "
                             "(orden/conteos/agrupaciones); documento docs/EVAL_AGREGACION.md")
    parser.add_argument("--retrieval", choices=RETRIEVAL_MODES, default="hybrid",
                        help="híbrido (dense+BM25, default) o denso puro en el agente")
    parser.add_argument("--repeat", type=int, default=1,
                        help="repite el conjunto N veces; PASS medio y varianza por caso (default 1)")
    parser.add_argument("--max-cost", type=float, default=None,
                        help=f"tope de costo estimado en USD ({PRICING_LABEL}): aborta entre casos "
                             "si se supera (default: sin tope)")
    parser.add_argument("--min-pass", type=float, default=0.0,
                        help="PASS rate mínimo para exit 0 (default 0.0: solo informativo)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--results-dir", type=Path, default=None,
                        help="carpeta de resultados fija (default evals/results/<fecha>-answers/)")
    parser.add_argument("--report", type=Path, default=None,
                        help="documento de docs/ a sobreescribir con --write-docs (default: "
                             "docs/EVAL_RESPUESTAS.md, o docs/EVAL_AGREGACION.md con --agregacion)")
    parser.add_argument("--write-docs", action="store_true",
                        help="además de report.md en resultados, sobreescribe el documento de docs/")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat debe ser >= 1")
    if not 0.0 <= args.min_pass <= 1.0:
        parser.error("--min-pass debe estar entre 0 y 1")
    return asyncio.run(run_all(args))


if __name__ == "__main__":
    sys.exit(main())
