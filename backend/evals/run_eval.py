"""Runner de evaluación de retrieval (A/B del fast-path de SKU).

Uso (desde backend/ como cwd):
    .venv\\Scripts\\python.exe -X utf8 evals\\run_eval.py
        → orquesta: corre ambos modos (SKU_FASTPATH=1 y 0) en subprocesos
          separados (get_settings() tiene lru_cache) y escribe
          docs/EVAL_RETRIEVAL.md.

    ... run_eval.py --mode on|off --out resultados.json
        → corre UN modo en este proceso (SKU_FASTPATH ya fijado en el entorno).

    ... run_eval.py --report-only --results-dir DIR
        → regenera el reporte desde resultados ya guardados.

Métricas por pregunta:
  - hit@30 pre-rerank : ¿algún chunk aceptable en hybrid_search(q, sin filtros, 30)?
  - hit@8 / MRR@8     : sobre _execute_search(q, None, None) — el pipeline
                        completo del agente (fast-path de SKU + rerank LLM).
"""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import json
import logging
import os
import random
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

DEFAULT_GOLD = BACKEND_DIR / "evals" / "gold_set.json"
DEFAULT_REPORT = PROJECT_DIR / "docs" / "EVAL_RETRIEVAL.md"
DEFAULT_RESULTS_DIR = Path(tempfile.gettempdir()) / "rag_eval_results"

CONCURRENCY = 3
MODES = ("on", "off")

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


async def _with_retries(fn, attempts: int = 4):
    """Reintenta errores transitorios de OpenAI/red con backoff exponencial."""
    for attempt in range(attempts):
        try:
            return await fn()
        except Exception as exc:
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


async def _eval_question(item: dict, capture: _RerankFallbackCapture, sem: asyncio.Semaphore) -> dict:
    from app.models import SearchFilters
    from app.services.agent import _execute_search, _extract_sku_candidates
    from app.services.qdrant import find_by_skus, hybrid_search

    qid = item["qid"]
    question = item["question"]
    accept_ids = set(item["accept_ids"])
    accept_skus = {s.upper() for s in item["accept_skus"]}

    def is_hit(ch) -> bool:
        return ch.id in accept_ids or bool(accept_skus & {s.upper() for s in ch.skus})

    async with sem:
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
        "qid": qid,
        "type": item["type"],
        "source_file": item["source_file"],
        "question": question,
        "ref_sku": item.get("ref_sku"),
        "ref_product": item.get("ref_product"),
        "ref_page": item.get("ref_page"),
        "fastpath_eligible": item.get("fastpath_eligible", False),
        "fastpath_tokens": tokens,
        "fastpath_found": fastpath_found,
        "hit30": rank30 is not None,
        "rank30": rank30,
        "hit8": rank8 is not None,
        "rank8": rank8,
        "rr8": (1.0 / rank8) if rank8 else 0.0,
        "rerank_fallback": rerank_fallback,
        "top8": [_chunk_brief(ch) for ch in post],
        "pre_top5": [_chunk_brief(ch) for ch in pre[:5]],
    }


async def _eval_all(questions: list[dict]) -> list[dict]:
    capture = _RerankFallbackCapture()
    logging.getLogger("app.services.reranker").addHandler(capture)
    sem = asyncio.Semaphore(CONCURRENCY)
    done = 0
    results: list[dict] = []

    async def worker(item: dict) -> dict:
        nonlocal done
        res = await _eval_question(item, capture, sem)
        done += 1
        status = "OK " if res["hit8"] else "MISS"
        print(
            f"  [{done:>2}/{len(questions)}] {status} {res['qid']} {res['type'][:12]:<12} "
            f"rank30={res['rank30']} rank8={res['rank8']}"
            + (" (rerank_fallback!)" if res["rerank_fallback"] else ""),
            flush=True,
        )
        return res

    results = await asyncio.gather(*(worker(it) for it in questions))
    return sorted(results, key=lambda r: r["qid"])


def run_mode(mode: str, gold_path: Path, out_path: Path) -> None:
    # SKU_FASTPATH debe estar puesto ANTES de importar/instanciar settings.
    os.environ["SKU_FASTPATH"] = "1" if mode == "on" else "0"
    from app.config import get_settings

    settings = get_settings()
    if settings.sku_fastpath != (mode == "on"):
        raise RuntimeError(
            f"sku_fastpath={settings.sku_fastpath} no coincide con --mode {mode}; "
            "corre este modo en un proceso nuevo con SKU_FASTPATH en el entorno."
        )

    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    questions = gold["questions"]
    print(
        f"== Modo fastpath={mode} | {len(questions)} preguntas | "
        f"search_top_k={settings.search_top_k} rerank_top_k={settings.rerank_top_k} "
        f"rerank_model={settings.rerank_model_resolved}",
        flush=True,
    )
    t0 = time.time()
    results = asyncio.run(_eval_all(questions))
    payload = {
        "mode": mode,
        "sku_fastpath": settings.sku_fastpath,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elapsed_s": round(time.time() - t0, 1),
        "settings": {
            "search_top_k": settings.search_top_k,
            "rerank_top_k": settings.rerank_top_k,
            "rerank_model": settings.rerank_model_resolved,
            "embedding_model": settings.embedding_model,
        },
        "results": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    g = _globals(results)
    print(
        f"== Modo {mode} listo en {payload['elapsed_s']}s: "
        f"hit@30={g['hit30']:.3f} hit@8={g['hit8']:.3f} MRR@8={g['mrr8']:.3f}",
        flush=True,
    )


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
        return "no aparece en el top-30 del retrieval híbrido (gap semántico/léxico)"
    return "causa no clasificada"


def write_report(res_by_mode: dict[str, dict], gold_meta: dict, report_path: Path) -> None:
    on = res_by_mode["on"]["results"]
    off = res_by_mode["off"]["results"]
    g_on, g_off = _globals(on), _globals(off)
    settings = res_by_mode["on"]["settings"]
    off_by_qid = {r["qid"]: r for r in off}

    lines: list[str] = []
    add = lines.append
    add("# Evaluación de retrieval — RAG de catálogos")
    add("")
    add(
        f"Fecha: {datetime.now(timezone.utc).date().isoformat()} · "
        f"Gold set: {gold_meta['total']} preguntas "
        f"(generado {gold_meta['generated_at'][:10]}, semilla {gold_meta['seed']}, "
        f"parafraseo con `{gold_meta['paraphrase_model']}`) · "
        f"Embeddings: `{settings['embedding_model']}` · "
        f"Reranker: `{settings['rerank_model']}` · "
        f"top-30 retrieval → top-8 post-rerank."
    )
    add("")
    add("Métricas: **hit@30** = algún chunk aceptable en `hybrid_search(q, sin filtros, 30)` "
        "(pre-rerank); **hit@8 / MRR@8** = sobre `_execute_search(q)` (pipeline completo del "
        "agente: fast-path de SKU + híbrida + rerank LLM). A/B del fast-path vía `SKU_FASTPATH`.")
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
                " → " + ", ".join(f"{r['qid']} (rank30={r['rank30']})" for r in lost)
                if lost else ""
            ))
        add(f"- Aciertos que NO estaban en el top-30 híbrido y el pipeline igual acertó "
            f"(rescatados por el fast-path): **{len(gained)}**"
            + (" → " + ", ".join(r["qid"] for r in gained) if gained else ""))
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
            f"- `{r_on['qid']}` [{r_on['type']}] gana **{winner}** — “{r_on['question']}” "
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

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Reporte escrito en {report_path}")


# --- Orquestación ----------------------------------------------------------------

def orchestrate(gold_path: Path, results_dir: Path, report_path: Path, report_only: bool) -> None:
    if not gold_path.exists():
        raise SystemExit(
            f"No existe {gold_path}. Genera el gold set primero:\n"
            "  python -X utf8 evals/build_gold_set.py"
        )
    results_dir.mkdir(parents=True, exist_ok=True)
    gold_meta = json.loads(gold_path.read_text(encoding="utf-8"))["meta"]

    if not report_only:
        for mode in MODES:
            out = results_dir / f"results_fastpath_{mode}.json"
            env = {
                **os.environ,
                "SKU_FASTPATH": "1" if mode == "on" else "0",
                "PYTHONPATH": str(BACKEND_DIR),
                "PYTHONIOENCODING": "utf-8",
            }
            cmd = [
                sys.executable,
                "-X",
                "utf8",
                str(Path(__file__).resolve()),
                "--mode",
                mode,
                "--gold",
                str(gold_path),
                "--out",
                str(out),
            ]
            print(f"\n### Lanzando subproceso modo {mode} ...", flush=True)
            proc = subprocess.run(cmd, cwd=str(BACKEND_DIR), env=env)
            if proc.returncode != 0:
                raise SystemExit(f"El modo {mode} falló (exit {proc.returncode}).")

    res_by_mode = {}
    for mode in MODES:
        path = results_dir / f"results_fastpath_{mode}.json"
        if not path.exists():
            raise SystemExit(f"Falta {path}; corre la evaluación completa primero.")
        res_by_mode[mode] = json.loads(path.read_text(encoding="utf-8"))

    write_report(res_by_mode, gold_meta, report_path)
    for mode in MODES:
        g = _globals(res_by_mode[mode]["results"])
        print(
            f"[fastpath {mode}] n={g['n']} hit@30={_pct(g['hit30'])} "
            f"hit@8={_pct(g['hit8'])} MRR@8={g['mrr8']:.3f} "
            f"(fallbacks rerank persistentes: {g['rerank_fallbacks']})"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluación de retrieval (A/B fast-path SKU)")
    parser.add_argument("--mode", choices=MODES, help="corre un solo modo en este proceso")
    parser.add_argument("--out", type=Path, help="(con --mode) JSON de resultados de salida")
    parser.add_argument("--gold", type=Path, default=DEFAULT_GOLD)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args()

    if args.mode:
        if not args.out:
            parser.error("--mode requiere --out")
        run_mode(args.mode, args.gold, args.out)
    else:
        orchestrate(args.gold, args.results_dir, args.report, args.report_only)


if __name__ == "__main__":
    main()
