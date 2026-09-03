"""Ejecuta el benchmark médico contra la API real y genera un reporte JSON.

Uso:
  .venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --dry-run
  .venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --token TOKEN
  RAG_PASSWORD=... .venv/bin/python evaluar.py --dataset ... --login correo@airobotix.net
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

from app.evaluation import EvalCase, load_cases, score_case, summarize
from preguntar import obtener_token


def run_case(case: EvalCase, base: str, token: str | None) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    answer: list[str] = []
    sources: list[dict] = []
    hops: list[dict] = []
    metrics: dict = {}
    error: str | None = None

    with httpx.stream(
        "POST",
        f"{base.rstrip('/')}/api/chat",
        json={"session_id": None, "message": case.question, "modo": case.mode},
        headers=headers,
        timeout=330,
    ) as response:
        response.raise_for_status()
        event = ""
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
                continue
            if not line.startswith("data:"):
                continue
            try:
                data = json.loads(line.split(":", 1)[1].strip())
            except json.JSONDecodeError:
                continue
            if event == "token":
                answer.append(str(data.get("text") or ""))
            elif event == "sources":
                sources = data.get("sources") or []
            elif event == "hop":
                hops.append(data)
            elif event == "metrics":
                metrics = data
            elif event == "error":
                error = str(data.get("detail") or "error desconocido")

    return {
        "id": case.id,
        "question": case.question,
        "mode": case.mode,
        "answer": "".join(answer),
        "sources": sources,
        "hops": hops,
        "metrics": metrics,
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evalúa fidelidad y recuperación del RAG")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--token")
    parser.add_argument("--login", metavar="CORREO")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-usd", type=float)
    parser.add_argument("--dry-run", action="store_true", help="solo valida el dataset")
    args = parser.parse_args()

    try:
        cases = load_cases(args.dataset)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(f"Benchmark válido: {len(cases)} casos en {args.dataset}")
    if args.dry_run:
        return 0

    token = args.token
    if args.login:
        password = os.environ.get("RAG_PASSWORD")
        if not password:
            parser.error("define RAG_PASSWORD para usar --login")
        token = obtener_token(args.login, password)

    results: list[dict[str, Any]] = []
    scored: list[dict[str, Any]] = []
    spent = 0.0
    for index, case in enumerate(cases, start=1):
        if args.max_usd is not None and spent >= args.max_usd:
            print(f"Tope de coste alcanzado antes del caso {case.id}")
            break
        print(f"[{index}/{len(cases)}] {case.id}: {case.question}", flush=True)
        try:
            result = run_case(case, args.base, token)
        except httpx.HTTPError as exc:
            result = {
                "id": case.id,
                "question": case.question,
                "mode": case.mode,
                "answer": "",
                "sources": [],
                "hops": [],
                "metrics": {},
                "error": str(exc),
            }
        score = score_case(case, result)
        results.append(result)
        scored.append(score)
        spent += float((result.get("metrics") or {}).get("cost_usd") or 0)
        print("  PASS" if score["passed"] else "  FAIL: " + "; ".join(score["failures"]))

    summary = summarize(scored, results)
    report = {
        "schema_version": 1,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dataset": str(args.dataset),
        "summary": summary,
        "cases": [
            {"definition": case.model_dump(), "result": result, "score": score}
            for case, result, score in zip(cases, results, scored)
        ],
    }
    output = args.output or Path("evals/results") / (
        dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Reporte: {output}")
    return 0 if summary["release_gate_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
