"""Ejecuta el benchmark médico contra la API real y genera un reporte JSON.

Uso:
  .venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --dry-run
  .venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --token TOKEN
  RAG_PASSWORD=... .venv/bin/python evaluar.py --dataset ... --login correo@airobotix.net
  .venv/bin/python evaluar.py --dataset evals/alzheimer.jsonl --repeticiones 3

Repeticiones: la misma pregunta corrida 5 veces dio fidelidad entre 0.33 y
1.00, entre 6 y 10 hops y entre 5 y 15 afirmaciones (2026-09-03). Con una sola
pasada, cualquier "mejoró" o "empeoró" tras un cambio es ruido, así que
`--repeticiones N` corre cada caso N veces y el reporte trae, por caso, el
agregado (`score`/`result`: mediana de lo numérico, mayoría de lo booleano y
la dispersión, ver `app.evaluation.aggregate_runs`) MÁS las N corridas crudas
en `runs`, para poder ir a mirar la corrida que se salió. El resumen y el gate
de release se calculan sobre el agregado: un caso cuenta una vez, no N.

Formato del reporte (schema_version 2):
  {"summary": ..., "repetitions": N, "interrupted": null | {...},
   "cases": [{"definition", "score", "result", "runs": [{"result", "score"}, ...]}]}

`score` es el agregado del caso y con N = 1 coincide con el `score_case` de la
única corrida salvo por las claves aditivas (`runs`, `passed_rate`,
`dispersion`, `found_rate`). `result`, en cambio, NO es la corrida: es un
agregado mínimo con `id`, `question`, `mode`, `runs`, los `errors` vistos y
`metrics`/`dispersion` de coste y latencia (lo único que leen `summarize` y el
tope de coste). La respuesta, las fuentes, los hops y el error de cada corrida
viven enteros en `cases[i].runs[j].result`, también con N = 1.

`interrupted` no es null cuando el reporte es PARCIAL: el bucle se cayó (o se
interrumpió con Ctrl-C) y se escribió lo ya medido en vez de tirarlo; entonces
el gate no se abre aunque lo evaluado pase.
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

from app.evaluation import EvalCase, aggregate_runs, load_cases, score_case, summarize
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


def _run_once(case: EvalCase, base: str, token: str | None) -> dict[str, Any]:
    """Una corrida del caso; CUALQUIER fallo se registra como resultado con
    `error`, no como excepción, para que puntúe (y falle) como las demás.

    Antes solo se atrapaba `httpx.HTTPError`, y cualquier otra cosa (un evento
    SSE con una forma inesperada -> KeyError o TypeError) tumbaba `main()` sin
    escribir el reporte: se perdían todas las corridas ya hechas y ya pagadas,
    que es justo lo que el tope por corrida existe para no desperdiciar. El
    nombre de la excepción va dentro del mensaje porque `str(KeyError("text"))`
    es solo `'text'` y no se entiende sin él.
    """
    try:
        return run_case(case, base, token)
    except Exception as exc:  # noqa: BLE001
        return {
            "id": case.id,
            "question": case.question,
            "mode": case.mode,
            "answer": "",
            "sources": [],
            "hops": [],
            "metrics": {},
            "error": f"{type(exc).__name__}: {exc}",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evalúa fidelidad y recuperación del RAG")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--token")
    parser.add_argument("--login", metavar="CORREO")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-usd", type=float)
    # Default 1 para no cambiar lo que mide una corrida normal (ni lo que
    # cuesta): con 1 el agregado es la propia corrida.
    parser.add_argument(
        "--repeticiones",
        type=int,
        default=1,
        metavar="N",
        help="corridas por caso; el reporte agrega (mediana/mayoría) y conserva las N crudas",
    )
    parser.add_argument("--dry-run", action="store_true", help="solo valida el dataset")
    args = parser.parse_args()
    if args.repeticiones < 1:
        parser.error("--repeticiones debe ser >= 1")

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

    # Por caso: (definición, score agregado, result agregado, corridas crudas).
    evaluated: list[tuple[EvalCase, dict[str, Any], dict[str, Any], list[dict[str, Any]]]] = []
    spent = 0.0
    # Interrupción imprevista del bucle. No se propaga: el reporte se escribe
    # con las corridas que ya se hicieron (y ya se pagaron) y el código de
    # salida es distinto de 0. Perderlas todas por un fallo en el caso 9 de 10
    # es exactamente lo que el tope por corrida intenta evitar.
    interrupted: BaseException | None = None
    try:
        budget_hit = False
        for index, case in enumerate(cases, start=1):
            runs: list[dict[str, Any]] = []
            for repetition in range(1, args.repeticiones + 1):
                # El tope se mira antes de CADA corrida, no solo antes de cada
                # caso: con N repeticiones un caso multiplica el gasto por N.
                if args.max_usd is not None and spent >= args.max_usd:
                    budget_hit = True
                    break
                label = f"[{index}/{len(cases)}] {case.id}"
                if args.repeticiones > 1:
                    label += f" ({repetition}/{args.repeticiones})"
                print(f"{label}: {case.question}", flush=True)
                result = _run_once(case, args.base, token)
                score = score_case(case, result)
                runs.append({"result": result, "score": score})
                spent += float((result.get("metrics") or {}).get("cost_usd") or 0)
                print("  PASS" if score["passed"] else "  FAIL: " + "; ".join(score["failures"]))
            if not runs:
                print(f"Tope de coste alcanzado antes del caso {case.id}")
                break
            # Si el tope cortó a medias, se agrega lo que hay (k < N corridas)
            # en vez de tirar el gasto ya hecho; `score["runs"]` dice cuántas.
            score, result = aggregate_runs(
                [run["score"] for run in runs], [run["result"] for run in runs]
            )
            evaluated.append((case, score, result, runs))
            if args.repeticiones > 1:
                passed_runs = round(score["passed_rate"] * score["runs"])
                verdict = "PASS" if score["passed"] else "FAIL"
                line = f"  => {verdict} {passed_runs}/{score['runs']} corridas"
                if score["failures"]:
                    line += ": " + "; ".join(score["failures"])
                print(line)
            if budget_hit:
                print(
                    f"Tope de coste alcanzado: {case.id} se agregó con "
                    f"{len(runs)} de {args.repeticiones} corridas"
                )
                break
    except (Exception, KeyboardInterrupt) as exc:  # noqa: BLE001
        # KeyboardInterrupt incluido a propósito: un Ctrl-C a mitad de un
        # benchmark de una hora tampoco debe tirar lo ya medido.
        interrupted = exc
        print(
            f"Benchmark interrumpido tras {len(evaluated)} de {len(cases)} casos: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )

    if not evaluated:
        # Sin ningún caso agregado no hay nada que resumir: `summarize([])`
        # levantaba ValueError('no hay resultados que resumir') y el proceso
        # moría con un traceback y sin reporte. Pasa con `--max-usd 0` (tope
        # agotado antes de la primera corrida) o si el bucle se cae en el
        # primer caso.
        if interrupted is not None:
            motivo = f"interrumpido ({type(interrupted).__name__})"
        elif args.max_usd is not None:
            motivo = "tope de coste agotado antes de la primera corrida"
        else:
            motivo = "el bucle no llegó a agregar ningún caso"
        print(f"No se evaluó ningún caso ({motivo}): no hay nada que reportar.")
        return 1

    scored = [score for _, score, _, _ in evaluated]
    results = [result for _, _, result, _ in evaluated]
    summary = summarize(scored, results)
    report = {
        "schema_version": 2,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dataset": str(args.dataset),
        "repetitions": args.repeticiones,
        # Reporte parcial: se escribió igual, pero dice por qué le faltan casos
        # para que nadie lo compare con uno completo creyéndolo completo.
        "interrupted": (
            None
            if interrupted is None
            else {
                "error": f"{type(interrupted).__name__}: {interrupted}",
                "cases_evaluated": len(evaluated),
                "cases_total": len(cases),
            }
        ),
        "summary": summary,
        "cases": [
            {"definition": case.model_dump(), "score": score, "result": result, "runs": runs}
            for case, score, result, runs in evaluated
        ],
    }
    output = args.output or Path("evals/results") / (
        dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Reporte: {output}")
    # Un benchmark interrumpido no abre el gate ni aunque lo medido pasara: no
    # se comprobaron todos los casos.
    return 0 if summary["release_gate_passed"] and interrupted is None else 1


if __name__ == "__main__":
    sys.exit(main())
