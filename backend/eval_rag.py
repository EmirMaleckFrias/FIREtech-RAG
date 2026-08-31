"""Evaluación end-to-end del RAG: lanza preguntas multi-hop reales contra /api/chat.

Uso (backend corriendo en :8000):
    .venv\\Scripts\\python.exe eval_rag.py            # 5 preguntas multi-hop del análisis
    .venv\\Scripts\\python.exe eval_rag.py "pregunta"  # una pregunta puntual
"""
from __future__ import annotations

import json
import sys

import httpx

BASE = "http://localhost:8000"

# Preguntas multi-hop derivadas del análisis de los catálogos
# (docs/sintesis_esquema.json → multihop_examples).
QUESTIONS = [
    "Necesito un rociador colgante Reliable F1FR56 K5.6 cromado de 1/2\" y un conector "
    "flexible trenzado de 24\": dame SKU y precio de ambos y dime si están aprobados UL/FM.",
    "Para un ramal de 2\" con TESTanDRAIN de AGF ranurado, ¿qué acoplamiento rígido de 2\" "
    "es más barato, el de Aleum o el RASCO de Reliable, y de cuándo es cada precio?",
    "Voy a supervisar una válvula mariposa ranurada de 4\" con doble supervisory switch "
    "desde un panel NFS-320: cotiza válvula y panel con sus aprobaciones.",
    "¿Quién da más barata una mechanical tee ranurada de 2\" x 1\", Aleum o Reliable? "
    "¿Y la versión roscada de cada uno?",
    "¿Cuánto cuesta el panel Notifier NFS-320 y qué costo interno tiene para nosotros?",
    # ↑ la última es una trampa deliberada: el costo interno es confidencial y NO está
    #   indexado en el texto — el agente debe decir que no lo encuentra.
]


def ask(question: str) -> None:
    print("=" * 88)
    print(f"PREGUNTA: {question}\n")
    hops: list[str] = []
    sources: list[dict] = []
    answer: list[str] = []

    with httpx.stream(
        "POST",
        f"{BASE}/api/chat",
        json={"session_id": None, "message": question},
        timeout=300,
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
                    hops.append(data.get("query", ""))
                    print(f"  hop {data.get('n')}: {data.get('query')}")
                elif event == "sources":
                    sources = data.get("sources", [])
                elif event == "token":
                    answer.append(data.get("text", ""))
                elif event == "error":
                    print(f"  ERROR: {data.get('detail')}")

    print(f"\nRESPUESTA ({len(hops)} hops, {len(sources)} fuentes):\n")
    print("".join(answer))
    print("\nFUENTES:")
    for s in sources:
        print(f"  - {s.get('source_file')} pág. {s.get('page')} ({s.get('brand')})"
              f" score={s.get('score', 0):.3f}")
    print()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        ask(" ".join(sys.argv[1:]))
    else:
        for q in QUESTIONS:
            ask(q)
