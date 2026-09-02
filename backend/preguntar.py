"""Lanza preguntas contra el agente por la API y muestra respuesta, citas y coste.

Es la forma de probar el sistema de punta a punta sin abrir el navegador: sirve para
comprobar un cambio con las mismas preguntas de siempre y para ver, pregunta por pregunta,
cuántos tokens y cuánto dinero cuesta.

Uso (con el backend corriendo en :8000):
    .venv\\Scripts\\python.exe -X utf8 preguntar.py "¿qué dicen los documentos sobre X?"
    .venv\\Scripts\\python.exe -X utf8 preguntar.py --archivo preguntas.txt
    .venv\\Scripts\\python.exe -X utf8 preguntar.py --archivo preguntas.txt --json salida.json

Con `--archivo`, una pregunta por línea; las vacías y las que empiezan por # se ignoran.

OJO: cada pregunta gasta saldo de OpenAI de verdad (embedding, reranker y agente). El
resumen final suma el coste estimado de la corrida, y `--max-usd` la detiene si se pasa.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import httpx

BASE = "http://localhost:8000"


def ask(question: str, base: str, token: str | None) -> dict:
    """Una pregunta contra /api/chat. Devuelve lo que llegó por el stream."""
    print("=" * 88)
    print(f"PREGUNTA: {question}\n")
    hops: list[dict] = []
    sources: list[dict] = []
    answer: list[str] = []
    metrics: dict = {}
    error: str | None = None

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.stream(
        "POST",
        f"{base}/api/chat",
        json={"session_id": None, "message": question},
        headers=headers,
        timeout=330,
    ) as resp:
        resp.raise_for_status()
        event = ""
        for line in resp.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                try:
                    data = json.loads(line.split(":", 1)[1].strip())
                except json.JSONDecodeError:
                    continue
                if event == "hop":
                    hops.append(data)
                    print(f"  hop {data.get('n')}: {data.get('query')}")
                elif event == "sources":
                    sources = data.get("sources", [])
                elif event == "token":
                    answer.append(data.get("text", ""))
                elif event == "metrics":
                    metrics = data
                elif event == "error":
                    error = data.get("detail")
                    print(f"  ERROR: {error}")

    texto = "".join(answer)
    print(f"\nRESPUESTA ({len(hops)} hops, {len(sources)} fuentes):\n")
    print(texto)

    if sources:
        print("\nFUENTES:")
        for s in sources:
            # El localizador depende del formato: la fuente ya trae lo que existe.
            pagina = s.get("page")
            seccion = s.get("section") or ""
            donde = seccion or (f"pág. {pagina}" if pagina else "")
            print(
                f"  - {s.get('source_file')}"
                + (f" · {donde}" if donde else "")
                + f" · score={s.get('score') or 0:.3f}"
            )

    coste = float(metrics.get("cost_usd") or 0.0)
    if metrics:
        tokens = metrics.get("tokens") or {}
        print(
            f"\nCOSTE: {coste:.5f} USD ({metrics.get('cost_label', 'estimado')})"
            f" | tokens entrada {tokens.get('prompt', 0)}"
            f" (cacheados {tokens.get('cached', 0)}), salida {tokens.get('completion', 0)}"
            f" | {metrics.get('ms_total', 0):.0f} ms"
        )
    print()

    return {
        "pregunta": question,
        "respuesta": texto,
        "hops": hops,
        "fuentes": sources,
        "metrics": metrics,
        "coste_usd": coste,
        "error": error,
    }


def cargar_preguntas(ruta: Path) -> list[str]:
    out: list[str] = []
    for linea in io.open(ruta, encoding="utf-8"):
        linea = linea.strip()
        if linea and not linea.startswith("#"):
            out.append(linea)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Pregunta al agente por la API y muestra respuesta, citas y coste"
    )
    parser.add_argument("pregunta", nargs="*", help="la pregunta, entre comillas")
    parser.add_argument(
        "--archivo", type=Path, default=None,
        help="archivo con una pregunta por línea",
    )
    parser.add_argument("--base", default=BASE, help=f"URL de la API (default {BASE})")
    parser.add_argument(
        "--token", default=None,
        help="access token de Supabase si el backend tiene autenticación activa",
    )
    parser.add_argument(
        "--json", type=Path, default=None, metavar="RUTA",
        help="guarda todo el detalle en un JSON",
    )
    parser.add_argument(
        "--max-usd", type=float, default=None, metavar="USD",
        help="detiene la corrida cuando el coste acumulado supera el tope",
    )
    args = parser.parse_args()

    if args.archivo:
        preguntas = cargar_preguntas(args.archivo)
    elif args.pregunta:
        preguntas = [" ".join(args.pregunta)]
    else:
        parser.error("dime una pregunta, o pásame un --archivo con varias")

    resultados: list[dict] = []
    acumulado = 0.0
    for i, pregunta in enumerate(preguntas, start=1):
        if args.max_usd is not None and acumulado > args.max_usd:
            print(
                f"DETENIDO en la pregunta {i} de {len(preguntas)}: el coste acumulado "
                f"({acumulado:.5f} USD) supera el tope de {args.max_usd:.5f} USD."
            )
            break
        try:
            resultado = ask(pregunta, args.base, args.token)
        except httpx.HTTPError as exc:
            print(f"  FALLO de red o del servidor: {exc}")
            resultados.append({"pregunta": pregunta, "error": str(exc)})
            continue
        resultados.append(resultado)
        acumulado += resultado["coste_usd"]

    print("=" * 88)
    fallidas = sum(1 for r in resultados if r.get("error"))
    print(
        f"{len(resultados)} preguntas, {fallidas} con error. "
        f"Coste total: {acumulado:.5f} USD (estimado, tarifas asumidas)."
    )

    if args.json:
        args.json.write_text(
            json.dumps(
                {"resultados": resultados, "coste_total_usd": acumulado},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Detalle en {args.json}")

    return 1 if fallidas else 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())
