"""Runner de evaluación de retrieval (A/B del fast-path de SKU).

Uso (desde backend/ como cwd):
    .venv\\Scripts\\python.exe -X utf8 evals\\run_eval.py
        : corre ambos modos (SKU_FASTPATH=1 y 0) en subprocesos separados
          (get_settings() tiene lru_cache) con retrieval híbrido y deja
          results.json + report.md en evals/results/<fecha>-retrieval/.

    ... run_eval.py --retrieval dense
        : lo mismo forzando búsqueda densa (sin BM25) en los subprocesos.

    ... run_eval.py --repeat 2
        : repite cada modo 2 veces y reporta media y desviación de hit@8 y
          MRR@8 entre repeticiones (cada repetición guarda su payload).

    ... run_eval.py --write-docs
        : además del results dir, sobreescribe docs/EVAL_RETRIEVAL.md (única
          forma de tocar docs/; el documento se valida sin guión largo). Solo
          con una corrida completa: si aborta o es --dry-run se ignora.

    ... run_eval.py --min-hit 0.85 --results-dir DIR
        : umbral de hit@8 para el exit code y carpeta de resultados fija.

    ... run_eval.py --dry-run
        : recorre toda la tubería (gold, subprocesos, payloads, informe) SIN
          llamar a OpenAI ni a Qdrant; sirve para probar el runner sin gasto.

    ... run_eval.py --mode on|off --out resultados.json [--retrieval ...]
        : corre UN modo en este proceso (SKU_FASTPATH ya fijado en el entorno).

    ... run_eval.py --report-only --results-dir DIR
        : regenera report.md desde payloads ya guardados en DIR.

Métricas por pregunta:
  - hit@30 pre-rerank : ¿algún chunk aceptable en hybrid_search(q, sin filtros, 30)?
  - hit@8 / MRR@8     : sobre _execute_search(q, None, None), el pipeline
                        completo del agente (fast-path de SKU + rerank LLM).

Gold: evals/gold_set.json (60 preguntas congeladas). Con el juez de respuestas
(judge_answers.py --all) el conjunto completo son 67 casos: 60 + 7 real-world.

Exit codes: 0 ok; 1 hit@8 medio por debajo de --min-hit en algún modo;
2 error de infraestructura o cuota de OpenAI (se guardan parciales);
3 el documento a escribir contenía un guión largo.
"""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

from evals.common import (  # noqa: E402
    EXIT_ERROR,
    EXIT_FAIL,
    EXIT_OK,
    RETRIEVAL_MODES,
    GoldItem,
    fingerprint_index,
    force_retrieval_mode,
    is_quota_error,
    load_gold_file,
    mean_std,
    now_iso,
    results_dir,
    run_metadata,
    sanitize,
    write_doc,
    write_json,
)

DEFAULT_GOLD = BACKEND_DIR / "evals" / "gold_set.json"
DEFAULT_REPORT = PROJECT_DIR / "docs" / "EVAL_RETRIEVAL.md"

CONCURRENCY = 3
MODES = ("on", "off")
DEFAULT_MIN_HIT = 0.9

# --- Captura de fallbacks del reranker (para no ensuciar la medición) --------

_QID: contextvars.ContextVar[str | None] = contextvars.ContextVar("eval_qid", default=None)


class _RerankFallbackCapture(logging.Handler):
    """Registra qué preguntas sufrieron fallback del reranker (429, JSON roto...)."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.qids: set[str] = set()

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover
        qid = _QID.get()
        if qid and "Reranker LLM" in record.getMessage():
            self.qids.add(qid)


class QuotaAbort(RuntimeError):
    """Error de cuota/facturación de OpenAI: se corta la corrida sin reintentar."""


async def _with_retries(fn, attempts: int = 4):
    """Reintenta errores transitorios de OpenAI/red con backoff exponencial.
    Un error de cuota no se reintenta: sube como QuotaAbort."""
    for attempt in range(attempts):
        try:
            return await fn()
        except QuotaAbort:
            raise
        except Exception as exc:
            if is_quota_error(exc):
                raise QuotaAbort(str(exc)) from exc
            msg = str(exc).lower()
            transient = (
                "429" in msg
                or "rate limit" in msg
                or "rate_limit" in msg
                or "timeout" in msg
                or "connection" in msg
                or "temporarily" in msg
                or "503" in msg
                or "500" in msg
            )
            if attempt == attempts - 1 or not transient:
                raise
            await asyncio.sleep(2.0 * (2**attempt) + random.random())
    raise RuntimeError("unreachable")


# --- Evaluación de un modo (proceso hijo) -------------------------------------

def _chunk_brief(ch) -> dict:
    return {
        "id": ch.id,
        "source_file": ch.source_file,
        "page": ch.page,
        "chunk_type": ch.chunk_type,
        "skus": ch.skus[:4],
        "score": round(float(ch.score), 4),
        "head": ch.text[:110].replace("\n", " "),
    }


def _case_shell(item: GoldItem) -> dict:
    """Campos fijos de un caso (los mismos en medición real y en dry-run)."""
    raw = item.raw
    return {
        "id": item.id,
        "qid": item.id,
        "type": item.type,
        "source_file": raw.get("source_file", ""),
        "question": item.question,
        "reference": item.reference(),
        "ref_sku": raw.get("ref_sku"),
        "ref_product": raw.get("ref_product"),
        "ref_page": raw.get("ref_page"),
        "fastpath_eligible": raw.get("fastpath_eligible", False),
    }


async def _eval_question(
    item: GoldItem,
    capture: _RerankFallbackCapture,
    sem: asyncio.Semaphore,
    stop: asyncio.Event,
    meta: dict,
) -> dict | None:
    """Mide un caso. Devuelve None si `stop` ya estaba puesto al obtener la
    plaza del semáforo: todos los workers arrancan a la vez y pasan el primer
    chequeo antes de que ninguna llamada pueda fallar, así que la cuota
    agotada solo se ve aquí, justo antes de tocar OpenAI.

    Cada caso arranca su propia telemetría (`telemetry.start` dentro de la
    tarea del worker: el ContextVar queda aislado por tarea) para que
    embeddings y reranker anoten su `usage` y el caso lleve `telemetry`."""
    from app.models import SearchFilters
    from app.services import telemetry
    from app.services.agent import _execute_search, _extract_sku_candidates
    from app.services.qdrant import find_by_skus, hybrid_search

    qid = item.id
    question = item.question
    accept_ids = set(item.accept_ids)
    accept_skus = {s.upper() for s in item.accept_skus}

    def is_hit(ch) -> bool:
        return ch.id in accept_ids or bool(accept_skus & {s.upper() for s in ch.skus})

    async with sem:
        if stop.is_set():
            return None
        tel = telemetry.start(case_id=qid, **meta)
        token = _QID.set(qid)
        try:
            # 1) hit@30 pre-rerank: búsqueda híbrida cruda, sin filtros.
            pre = await _with_retries(lambda: hybrid_search(question, SearchFilters(), 30))
            rank30 = next((i + 1 for i, ch in enumerate(pre) if is_hit(ch)), None)

            # 2) Diagnóstico del fast-path (solo Qdrant local, sin costo API).
            tokens = _extract_sku_candidates(question)
            fp_chunks = (
                await asyncio.to_thread(find_by_skus, tokens, 8) if tokens else []
            )
            fastpath_found = any(is_hit(ch) for ch in fp_chunks)

            # 3) Pipeline completo del agente. Si el reranker cayó a fallback
            #    (429/JSON), se reintenta para que la medición sea del reranker
            #    real y no del orden de Qdrant.
            post = []
            rerank_fallback = False
            for attempt in range(3):
                capture.qids.discard(qid)
                post = await _with_retries(lambda: _execute_search(question, None, None))
                rerank_fallback = qid in capture.qids
                if not rerank_fallback:
                    break
                await asyncio.sleep(3.0 * (attempt + 1))
            rank8 = next((i + 1 for i, ch in enumerate(post) if is_hit(ch)), None)
        finally:
            _QID.reset(token)

    return {
        **_case_shell(item),
        "fastpath_tokens": tokens,
        "fastpath_found": fastpath_found,
        "hit30": rank30 is not None,
        "rank30": rank30,
        "hit": rank8 is not None,
        "rank": rank8,
        "hit8": rank8 is not None,
        "rank8": rank8,
        "rr8": (1.0 / rank8) if rank8 else 0.0,
        "rerank_fallback": rerank_fallback,
        "returned_ids": [ch.id for ch in post],
        "top8": [_chunk_brief(ch) for ch in post],
        "pre_top5": [_chunk_brief(ch) for ch in pre[:5]],
        "telemetry": tel.summary(),
    }


def _dry_result(item: GoldItem) -> dict:
    """Resultado sintético de --dry-run: nada medido, todo vacío y marcado."""
    from app.services.agent import _extract_sku_candidates  # regex puro, sin red

    return {
        **_case_shell(item),
        "fastpath_tokens": _extract_sku_candidates(item.question),
        "fastpath_found": False,
        "hit30": False,
        "rank30": None,
        "hit": False,
        "rank": None,
        "hit8": False,
        "rank8": None,
        "rr8": 0.0,
        "rerank_fallback": False,
        "returned_ids": [],
        "top8": [],
        "pre_top5": [],
        "telemetry": {},
        "dry_run": True,
    }


async def _eval_all(items: list[GoldItem], meta: dict) -> tuple[list[dict], str]:
    """Evalúa todos los casos. Devuelve (resultados, motivo_de_aborto).

    Ante un error de cuota los casos pendientes no arrancan (cada worker
    vuelve a mirar `stop` al obtener su plaza del semáforo, antes de la
    primera llamada a OpenAI), se conservan los ya terminados y `aborted`
    explica el corte; cualquier otro error persistente también aborta (como
    antes) pero guardando parciales. `meta` va a la telemetría de cada caso
    (retrieval efectivo, prompt_version).
    """
    capture = _RerankFallbackCapture()
    logging.getLogger("app.services.reranker").addHandler(capture)
    sem = asyncio.Semaphore(CONCURRENCY)
    done = 0
    results: list[dict] = []
    stop = asyncio.Event()
    aborted = ""

    async def worker(item: GoldItem) -> None:
        nonlocal done, aborted
        if stop.is_set():
            return
        try:
            res = await _eval_question(item, capture, sem, stop, meta)
        except QuotaAbort as exc:
            if not stop.is_set():
                aborted = f"ABORTADO por cuota de OpenAI (sin reintentos): {str(exc)[:200]}"
                stop.set()
            return
        except Exception as exc:
            if not stop.is_set():
                aborted = f"ABORTADO por error en {item.id}: {type(exc).__name__}: {str(exc)[:200]}"
                stop.set()
            return
        if res is None:  # la corrida ya estaba abortada: caso no arrancado
            return
        results.append(res)
        done += 1
        status = "OK " if res["hit8"] else "MISS"
        print(
            f"  [{done:>2}/{len(items)}] {status} {res['qid']} {res['type'][:12]:<12} "
            f"rank30={res['rank30']} rank8={res['rank8']}"
            + (" (rerank_fallback!)" if res["rerank_fallback"] else ""),
            flush=True,
        )

    await asyncio.gather(*(worker(it) for it in items))
    return sorted(results, key=lambda r: r["qid"]), aborted


def run_mode(mode: str, gold_path: Path, out_path: Path, retrieval: str, dry_run: bool) -> int:
    """Proceso hijo: un modo de fast-path. Devuelve el exit code."""
    # SKU_FASTPATH debe estar puesto ANTES de importar/instanciar settings.
    os.environ["SKU_FASTPATH"] = "1" if mode == "on" else "0"
    from app.config import get_settings

    settings = get_settings()
    if settings.sku_fastpath != (mode == "on"):
        raise RuntimeError(
            f"sku_fastpath={settings.sku_fastpath} no coincide con --mode {mode}; "
            "corre este modo en un proceso nuevo con SKU_FASTPATH en el entorno."
        )

    gold_meta, items = load_gold_file(gold_path)
    effective = force_retrieval_mode(retrieval)
    metadata = run_metadata()
    print(
        f"== Modo fastpath={mode} | retrieval={effective} | {len(items)} preguntas | "
        f"search_top_k={settings.search_top_k} rerank_top_k={settings.rerank_top_k} "
        f"rerank_model={settings.rerank_model_resolved} prompt={settings.prompt_version}"
        + (" | DRY-RUN (sin OpenAI ni Qdrant)" if dry_run else ""),
        flush=True,
    )
    fingerprint: dict | None = None
    if not dry_run:
        try:
            fingerprint = fingerprint_index()
        except Exception as exc:
            print(f"ERROR: no se pudo leer el índice Qdrant: {exc}", file=sys.stderr, flush=True)
            return EXIT_ERROR

    t0 = time.time()
    if dry_run:
        results, aborted = [_dry_result(it) for it in items], ""
    else:
        tel_meta = {"retrieval": effective, "prompt_version": settings.prompt_version}
        results, aborted = asyncio.run(_eval_all(items, tel_meta))
    payload = {
        "mode": mode,
        "sku_fastpath": settings.sku_fastpath,
        "retrieval_requested": retrieval,
        "retrieval": effective,
        "dry_run": dry_run,
        "aborted": aborted,
        "started_at": metadata["started_at"],
        "finished_at": now_iso(),
        "elapsed_s": round(time.time() - t0, 1),
        "run_metadata": metadata,
        "fingerprint": fingerprint,
        "gold": {"path": str(gold_path), "meta": gold_meta, "n": len(items)},
        "settings": {
            "search_top_k": settings.search_top_k,
            "rerank_top_k": settings.rerank_top_k,
            "rerank_model": settings.rerank_model_resolved,
            "embedding_model": settings.embedding_model,
        },
        "results": results,
    }
    write_json(out_path, payload)
    g = _globals(results)
    print(
        f"== Modo {mode} {'ABORTADO' if aborted else 'listo'} en {payload['elapsed_s']}s: "
        f"n={g['n']} hit@30={g['hit30']:.3f} hit@8={g['hit8']:.3f} MRR@8={g['mrr8']:.3f}",
        flush=True,
    )
    if aborted:
        print(f"!! {aborted}", file=sys.stderr, flush=True)
        return EXIT_ERROR
    return EXIT_OK


# --- Agregación y reporte ------------------------------------------------------

def _globals(results: list[dict]) -> dict:
    n = len(results) or 1
    return {
        "n": len(results),
        "hit30": sum(r["hit30"] for r in results) / n,
        "hit8": sum(r["hit8"] for r in results) / n,
        "mrr8": sum(r["rr8"] for r in results) / n,
        "rerank_fallbacks": sum(r["rerank_fallback"] for r in results),
    }


def _group(results: list[dict], key: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in results:
        out.setdefault(r[key], []).append(r)
    return out


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _cause(r: dict, mode: str) -> str:
    if r["hit30"] and not r["hit8"]:
        return (
            f"el retrieval SÍ lo traía (rank {r['rank30']} en el top-30) pero el "
            "rerank/corte a 8 lo dejó fuera"
        )
    if not r["hit30"] and r["fastpath_found"] and mode == "off":
        return "solo el fast-path de SKU lo encuentra; sin él es invisible al retrieval híbrido"
    if not r["hit30"] and r["fastpath_found"] and mode == "on":
        return (
            "el fast-path lo inyectó a los candidatos pero el reranker lo descartó "
            "(y no estaba en el top-30 híbrido)"
        )
    if not r["hit30"]:
        return "no aparece en el top-30 del retrieval (gap semántico/léxico)"
    return "causa no clasificada"


def _stability(runs_by_mode: dict[str, list[dict]]) -> dict:
    """Media y desviación de hit@30, hit@8 y MRR@8 entre repeticiones por modo,
    más los casos cuyo hit@8 cambió de una repetición a otra."""
    out: dict = {"repeat": 0, "by_mode": {}, "flaky_cases": {}}
    for mode, runs in runs_by_mode.items():
        gs = [_globals(p["results"]) for p in runs]
        out["repeat"] = max(out["repeat"], len(runs))
        stats: dict = {"n_runs": len(runs)}
        for metric in ("hit30", "hit8", "mrr8"):
            mean, std = mean_std(g[metric] for g in gs)
            stats[metric] = {"mean": round(mean, 4), "std": round(std, 4),
                             "values": [round(g[metric], 4) for g in gs]}
        out["by_mode"][mode] = stats
        if len(runs) > 1:
            per_case: dict[str, list[bool]] = {}
            for p in runs:
                for r in p["results"]:
                    per_case.setdefault(r["qid"], []).append(bool(r["hit8"]))
            out["flaky_cases"][mode] = sorted(
                qid for qid, hits in per_case.items() if len(set(hits)) > 1
            )
    return out


def build_report(combined: dict) -> str:
    """Informe Markdown a partir del payload combinado (results.json)."""
    runs = combined["runs"]
    on_p, off_p = runs["on"][0], runs["off"][0]
    on, off = on_p["results"], off_p["results"]
    g_on, g_off = _globals(on), _globals(off)
    settings = on_p["settings"]
    gold_meta = combined["gold"]["meta"]
    fp = combined.get("fingerprint") or {}
    meta = combined.get("run_metadata") or {}
    stability = combined.get("stability") or {}
    repeat = int(stability.get("repeat") or 1)
    off_by_qid = {r["qid"]: r for r in off}

    lines: list[str] = []
    add = lines.append
    add("# Evaluación de retrieval: RAG de catálogos")
    add("")
    if combined.get("dry_run"):
        add("> **DRY-RUN:** ningún valor de esta página es una medición; el runner se "
            "ejecutó sin OpenAI ni Qdrant para probar la tubería.")
        add("")
    for mode in MODES:
        for p in runs[mode]:
            if p.get("aborted"):
                add(f"> **{p['aborted']}** (modo {mode}). El informe cubre solo los casos ejecutados.")
                add("")
    add(
        f"Fecha: {combined['started_at'][:10]} · "
        f"Gold set: {gold_meta.get('total', combined['gold']['n'])} preguntas "
        f"(generado {str(gold_meta.get('generated_at', '?'))[:10]}, semilla {gold_meta.get('seed', '?')}, "
        f"parafraseo con `{gold_meta.get('paraphrase_model', '?')}`) · "
        f"Embeddings: `{settings['embedding_model']}` · "
        f"Reranker: `{settings['rerank_model']}` · "
        f"Retrieval: **{combined['retrieval']}** (pedido: {combined['retrieval_requested']}) · "
        f"top-30 retrieval, top-8 post-rerank · "
        f"Repeticiones por modo: {repeat}."
    )
    add("")
    add("## Condiciones de la medición")
    add("")
    add(f"- Prompt del agente: `{meta.get('prompt_version', '?')}` · modelo del agente: "
        f"`{meta.get('openai_model', '?')}` · reranker: `{meta.get('rerank_model_resolved', '?')}` · "
        f"max_hops={meta.get('max_hops', '?')} · search_top_k={meta.get('search_top_k', '?')} · "
        f"rerank_top_k={meta.get('rerank_top_k', '?')} · Python {meta.get('python', '?')} · "
        f"commit `{meta.get('git_commit') or 'n/d'}`.")
    if fp:
        by_file = fp.get("by_source_file") or {}
        add(f"- Índice Qdrant: colección `{fp.get('collection')}` en `{fp.get('qdrant_host')}` "
            f"(Qdrant {fp.get('qdrant_version') or 'n/d'}): {fp.get('total_points')} puntos, "
            f"{fp.get('products')} productos en {len(by_file)} archivos; huella tomada "
            f"{fp.get('taken_at')}.")
        if by_file:
            add("  - Productos por archivo: " + ", ".join(
                f"`{f}` {n}" for f, n in sorted(by_file.items())))
    else:
        add("- Índice Qdrant: huella no disponible (dry-run o sin conexión).")
    add("- Dos corridas solo son comparables si coinciden prompt, modelos, modo de retrieval "
        "y huella del índice.")
    add("")
    add("Métricas: **hit@30** = algún chunk aceptable en `hybrid_search(q, sin filtros, 30)` "
        "(pre-rerank); **hit@8 / MRR@8** = sobre `_execute_search(q)` (pipeline completo del "
        "agente: fast-path de SKU + retrieval + rerank LLM). A/B del fast-path vía `SKU_FASTPATH`.")
    add("")
    add("## Resultados globales")
    add("")
    add("| Modo | n | hit@30 (pre-rerank) | hit@8 (pipeline) | MRR@8 | fallbacks rerank |")
    add("|---|---|---|---|---|---|")
    for mode, g in (("fast-path ON", g_on), ("fast-path OFF", g_off)):
        add(
            f"| {mode} | {g['n']} | {_pct(g['hit30'])} | {_pct(g['hit8'])} | "
            f"{g['mrr8']:.3f} | {g['rerank_fallbacks']} |"
        )
    if repeat > 1:
        add("")
        add("(Tabla de la repetición 1; las demás secciones de detalle también.)")
    add("")
    if repeat > 1:
        add("## Estabilidad entre repeticiones")
        add("")
        add(f"Cada modo se corrió {repeat} veces sobre el mismo índice. Media y desviación "
            "típica muestral entre repeticiones:")
        add("")
        add("| Modo | repeticiones | hit@30 media (std) | hit@8 media (std) | MRR@8 media (std) | casos con hit@8 inestable |")
        add("|---|---|---|---|---|---|")
        for mode, label in (("on", "fast-path ON"), ("off", "fast-path OFF")):
            s = stability["by_mode"][mode]
            flaky = stability.get("flaky_cases", {}).get(mode, [])
            add(
                f"| {label} | {s['n_runs']} | {_pct(s['hit30']['mean'])} ({_pct(s['hit30']['std'])}) | "
                f"{_pct(s['hit8']['mean'])} ({_pct(s['hit8']['std'])}) | "
                f"{s['mrr8']['mean']:.3f} ({s['mrr8']['std']:.3f}) | "
                f"{len(flaky)}" + (": " + ", ".join(flaky) if flaky else "") + " |"
            )
        add("")
    add("## Desglose por tipo de pregunta")
    add("")
    add("| Tipo | n | hit@30 | hit@8 ON | MRR@8 ON | hit@8 OFF | MRR@8 OFF |")
    add("|---|---|---|---|---|---|---|")
    for t, rs_on in sorted(_group(on, "type").items()):
        rs_off = _group(off, "type").get(t, [])
        a, b = _globals(rs_on), _globals(rs_off)
        add(
            f"| {t} | {a['n']} | {_pct(a['hit30'])} | {_pct(a['hit8'])} | {a['mrr8']:.3f} "
            f"| {_pct(b['hit8'])} | {b['mrr8']:.3f} |"
        )
    add("")
    add("## Desglose por archivo fuente")
    add("")
    add("| Archivo | n | hit@30 | hit@8 ON | MRR@8 ON | hit@8 OFF | MRR@8 OFF |")
    add("|---|---|---|---|---|---|---|")
    for f, rs_on in sorted(_group(on, "source_file").items()):
        rs_off = _group(off, "source_file").get(f, [])
        a, b = _globals(rs_on), _globals(rs_off)
        add(
            f"| {f} | {a['n']} | {_pct(a['hit30'])} | {_pct(a['hit8'])} | {a['mrr8']:.3f} "
            f"| {_pct(b['hit8'])} | {b['mrr8']:.3f} |"
        )

    add("")
    add("## Efecto del reranker (hit@8 vs hit@30)")
    add("")
    for mode, rs in (("ON", on), ("OFF", off)):
        lost = [r for r in rs if r["hit30"] and not r["hit8"]]
        gained = [r for r in rs if not r["hit30"] and r["hit8"]]
        add(f"**Fast-path {mode}:**")
        add(f"- Aciertos que el retrieval traía en el top-30 y el rerank/corte a 8 perdió: "
            f"**{len(lost)}**"
            + (
                ": " + ", ".join(f"{r['qid']} (rank30={r['rank30']})" for r in lost)
                if lost else ""
            ))
        add(f"- Aciertos que NO estaban en el top-30 y el pipeline igual acertó "
            f"(rescatados por el fast-path): **{len(gained)}**"
            + (": " + ", ".join(r["qid"] for r in gained) if gained else ""))
        add("")

    diff = [
        (r, off_by_qid[r["qid"]])
        for r in on
        if r["qid"] in off_by_qid and r["hit8"] != off_by_qid[r["qid"]]["hit8"]
    ]
    add(f"Preguntas donde ON y OFF difieren en hit@8: **{len(diff)}**")
    for r_on, r_off in diff:
        winner = "ON" if r_on["hit8"] else "OFF"
        add(
            f"- `{r_on['qid']}` [{r_on['type']}] gana **{winner}**: \"{r_on['question']}\" "
            f"(rank8 ON={r_on['rank8']}, OFF={r_off['rank8']}, rank30={r_on['rank30']})"
        )

    add("")
    add("## Fallos concretos (modo fast-path ON)")
    add("")
    fails = [r for r in on if not r["hit8"]]
    if not fails:
        add("Sin fallos de hit@8 en modo ON.")
    for r in fails:
        r_off = off_by_qid.get(r["qid"])
        add(f"### {r['qid']} · {r['type']} · {r['source_file']} p.{r['ref_page']}")
        add(f"- **Pregunta:** {r['question']}")
        add(
            f"- **Se esperaba:** {r['ref_product']} (SKU ref `{r['ref_sku']}`, "
            f"{r['source_file']} p.{r['ref_page']})"
        )
        got = r["top8"][:3]
        if got:
            add("- **Salió (top-3):** " + " · ".join(
                f"[{c['source_file']} p.{c['page']}] {','.join(c['skus'][:2]) or c['chunk_type']}"
                for c in got
            ))
        add(
            f"- **Diagnóstico:** rank30={r['rank30']}, rank8=None, "
            f"fastpath_tokens={r['fastpath_tokens']}, fastpath_found={r['fastpath_found']}"
            + (f", OFF rank8={r_off['rank8']}" if r_off else "")
        )
        add(f"- **Hipótesis:** {_cause(r, 'on')}.")
        add("")

    add("## Conclusiones accionables")
    add("")
    add("<!-- CONCLUSIONES -->")
    add("")
    return "\n".join(lines)


# --- Orquestación ----------------------------------------------------------------

def _child_out(out_dir: Path, mode: str, rep: int) -> Path:
    return out_dir / f"results_fastpath_{mode}_rep{rep}.json"


def _rep_of(path: Path) -> int:
    """Número de repetición de un payload por su nombre (0 si no lo trae):
    el orden lexicográfico del glob pondría rep10 antes que rep2."""
    m = re.search(r"_rep(\d+)\.json$", path.name)
    return int(m.group(1)) if m else 0


def _collect_runs(out_dir: Path, repeat: int, report_only: bool) -> dict[str, list[dict]]:
    """Payloads por modo. En una corrida real solo los rep 1..repeat que este
    proceso acaba de escribir (una carpeta reutilizada con --results-dir puede
    guardar repeticiones de corridas anteriores, con otro índice o commit);
    con --report-only, todo lo que haya en la carpeta, ordenado por rep."""
    runs: dict[str, list[dict]] = {m: [] for m in MODES}
    for mode in MODES:
        if report_only:
            paths = sorted(out_dir.glob(f"results_fastpath_{mode}_rep*.json"), key=_rep_of)
        else:
            paths = [_child_out(out_dir, mode, rep) for rep in range(1, repeat + 1)]
        for path in paths:
            if path.exists():
                runs[mode].append(json.loads(path.read_text(encoding="utf-8")))
    return runs


def _launch_child(mode: str, rep: int, gold_path: Path, out_dir: Path, args) -> int:
    out = _child_out(out_dir, mode, rep)
    env = {
        **os.environ,
        "SKU_FASTPATH": "1" if mode == "on" else "0",
        "PYTHONPATH": str(BACKEND_DIR),
        "PYTHONIOENCODING": "utf-8",
    }
    cmd = [
        sys.executable, "-X", "utf8", str(Path(__file__).resolve()),
        "--mode", mode,
        "--gold", str(gold_path),
        "--out", str(out),
        "--retrieval", args.retrieval,
    ]
    if args.dry_run:
        cmd.append("--dry-run")
    print(f"\n### Lanzando subproceso modo {mode} (repetición {rep}/{args.repeat}) ...", flush=True)
    proc = subprocess.run(cmd, cwd=str(BACKEND_DIR), env=env)
    return proc.returncode


def orchestrate(args) -> int:
    gold_path: Path = args.gold
    if not gold_path.exists():
        print(
            f"No existe {gold_path}. Genera el gold set primero:\n"
            "  python -X utf8 evals/build_gold_set.py",
            file=sys.stderr,
        )
        return EXIT_ERROR
    out_dir = results_dir("retrieval", forced=args.results_dir)
    print(f"Carpeta de resultados: {out_dir}", flush=True)
    gold_meta, items = load_gold_file(gold_path)

    exit_code = EXIT_OK
    if not args.report_only:
        # Los payloads que esta corrida va a escribir se retiran antes: si un
        # hijo muere sin escribir, no se leería el de una corrida anterior.
        for rep in range(1, args.repeat + 1):
            for mode in MODES:
                _child_out(out_dir, mode, rep).unlink(missing_ok=True)
        for rep in range(1, args.repeat + 1):
            for mode in MODES:
                rc = _launch_child(mode, rep, gold_path, out_dir, args)
                if rc != 0:
                    print(f"El modo {mode} (repetición {rep}) terminó con exit {rc}.", file=sys.stderr)
                    exit_code = EXIT_ERROR
                    break
            if exit_code != EXIT_OK:
                break

    # Se recogen los payloads que existan (parciales incluidos) y se informa.
    runs = _collect_runs(out_dir, args.repeat, args.report_only)
    if not runs["on"] or not runs["off"]:
        print(
            f"Faltan payloads de ambos modos en {out_dir}; no se puede informar "
            f"(on={len(runs['on'])}, off={len(runs['off'])}).",
            file=sys.stderr,
        )
        return EXIT_ERROR if exit_code == EXIT_OK else exit_code

    first = runs["on"][0]
    stability = _stability(runs)
    combined = {
        "started_at": first["started_at"],
        "finished_at": now_iso(),
        "dry_run": bool(first.get("dry_run")),
        "retrieval_requested": args.retrieval,
        "retrieval": first["retrieval"],
        "repeat": args.repeat,
        "min_hit": args.min_hit,
        "run_metadata": first["run_metadata"],
        "fingerprint": first.get("fingerprint"),
        "gold": {"path": str(gold_path), "meta": gold_meta, "n": len(items)},
        "aborted": [p["aborted"] for m in MODES for p in runs[m] if p.get("aborted")],
        "stability": stability,
        "runs": runs,
    }
    write_json(out_dir / "results.json", combined)
    # Las preguntas y los textos de chunks vienen de fuera (gold, PDFs): se
    # sanean antes de escribir; write_doc sigue vigilando el texto propio.
    report = sanitize(build_report(combined))
    write_doc(out_dir / "report.md", report, force=True)
    print(f"Informe escrito en {out_dir / 'report.md'}")
    if args.write_docs:
        # El documento de referencia solo se pisa con una medición completa:
        # ni parciales de una corrida abortada ni valores sintéticos de dry-run.
        if combined["aborted"] or combined["dry_run"]:
            motivo = "dry-run" if combined["dry_run"] else "corrida abortada"
            print(f"--write-docs ignorado ({motivo}): {args.report} no se actualiza.",
                  file=sys.stderr)
        else:
            write_doc(args.report, report, force=True)
            print(f"Documento actualizado: {args.report}")

    for mode in MODES:
        s = stability["by_mode"][mode]
        print(
            f"[fastpath {mode}] n={_globals(runs[mode][0]['results'])['n']} "
            f"hit@30={_pct(s['hit30']['mean'])} hit@8={_pct(s['hit8']['mean'])}"
            + (f" (std {_pct(s['hit8']['std'])})" if s["n_runs"] > 1 else "")
            + f" MRR@8={s['mrr8']['mean']:.3f} retrieval={runs[mode][0]['retrieval']}"
        )

    if exit_code != EXIT_OK or combined["aborted"]:
        return EXIT_ERROR
    if combined["dry_run"]:
        print("DRY-RUN: sin medición, el umbral --min-hit no aplica.")
        return EXIT_OK
    below = [m for m in MODES if stability["by_mode"][m]["hit8"]["mean"] < args.min_hit]
    if below:
        print(f"FAIL: hit@8 medio por debajo de {args.min_hit:.2f} en modo(s): {', '.join(below)}")
        return EXIT_FAIL
    return EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluación de retrieval (A/B fast-path SKU)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ejemplos:\n"
            "  python -X utf8 evals/run_eval.py\n"
            "  python -X utf8 evals/run_eval.py --retrieval dense\n"
            "  python -X utf8 evals/run_eval.py --repeat 2\n"
            "  python -X utf8 evals/run_eval.py --write-docs\n"
            "  python -X utf8 evals/run_eval.py --dry-run\n"
            "Exit codes: 0 ok, 1 bajo umbral, 2 error/cuota, 3 documento con guión largo."
        ),
    )
    parser.add_argument("--mode", choices=MODES, help="corre un solo modo en este proceso")
    parser.add_argument("--out", type=Path, help="(con --mode) JSON de resultados de salida")
    parser.add_argument("--gold", type=Path, default=DEFAULT_GOLD)
    parser.add_argument("--retrieval", choices=RETRIEVAL_MODES, default="hybrid",
                        help="híbrido (dense+BM25, default) o denso puro; se propaga a los subprocesos")
    parser.add_argument("--repeat", type=int, default=1,
                        help="repeticiones de cada modo; se reporta media y desviación (default 1)")
    parser.add_argument("--min-hit", type=float, default=DEFAULT_MIN_HIT,
                        help=f"umbral de hit@8 medio para exit 1 (default {DEFAULT_MIN_HIT})")
    parser.add_argument("--results-dir", type=Path, default=None,
                        help="carpeta de resultados fija (default evals/results/<fecha>-retrieval/)")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT,
                        help="documento de docs/ a sobreescribir con --write-docs")
    parser.add_argument("--write-docs", action="store_true",
                        help="además de report.md en resultados, sobreescribe docs/EVAL_RETRIEVAL.md")
    parser.add_argument("--report-only", action="store_true",
                        help="regenera el informe desde los payloads de --results-dir")
    parser.add_argument("--dry-run", action="store_true",
                        help="recorre la tubería sin OpenAI ni Qdrant (resultados sintéticos)")
    args = parser.parse_args()

    if args.repeat < 1:
        parser.error("--repeat debe ser >= 1")
    if args.report_only and args.results_dir is None:
        parser.error("--report-only requiere --results-dir")

    if args.mode:
        if not args.out:
            parser.error("--mode requiere --out")
        return run_mode(args.mode, args.gold, args.out, args.retrieval, args.dry_run)
    return orchestrate(args)


if __name__ == "__main__":
    sys.exit(main())
