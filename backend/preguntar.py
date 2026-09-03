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
import os
import sys
from pathlib import Path

import httpx

BASE = "http://localhost:8000"

# Raíz del repositorio, para leer frontend/.env sin depender del cwd.
RAIZ = Path(__file__).resolve().parent.parent


def _leer_env(ruta: Path) -> dict[str, str]:
    valores: dict[str, str] = {}
    if not ruta.is_file():
        return valores
    for linea in io.open(ruta, encoding="utf-8", errors="replace"):
        linea = linea.strip()
        if "=" in linea and not linea.startswith("#"):
            clave, valor = linea.split("=", 1)
            valores[clave.strip()] = valor.strip().strip('"').strip("'")
    return valores


def obtener_token(correo: str, password: str) -> str:
    """Access token de Supabase para hablar con una API con autenticación.

    Usa el mismo camino que el navegador (grant de contraseña con la anon key,
    que es pública por diseño), así que no hace falta la service key ni ningún
    permiso especial: basta una cuenta de verdad.
    """
    env = _leer_env(RAIZ / "frontend" / ".env")
    url = os.environ.get("SUPABASE_URL") or env.get("VITE_SUPABASE_URL", "")
    anon = os.environ.get("SUPABASE_ANON_KEY") or env.get("VITE_SUPABASE_ANON_KEY", "")
    if not url or not anon:
        raise SystemExit(
            "Falta la URL o la anon key de Supabase. Rellena frontend/.env "
            "(VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY) o exporta "
            "SUPABASE_URL y SUPABASE_ANON_KEY."
        )
    resp = httpx.post(
        f"{url.rstrip('/')}/auth/v1/token",
        params={"grant_type": "password"},
        headers={"apikey": anon, "Content-Type": "application/json"},
        json={"email": correo, "password": password},
        timeout=30,
    )
    if resp.status_code != 200:
        raise SystemExit(
            f"No se pudo iniciar sesión como {correo}: {resp.status_code} "
            f"{resp.text[:200]}"
        )
    token = resp.json().get("access_token")
    if not token:
        raise SystemExit("Supabase no devolvió access_token.")
    return token


def ask(question: str, base: str, token: str | None) -> dict:
    """Una pregunta contra /api/chat. Devuelve lo que llegó por el stream."""
    print("=" * 88)
    print(f"PREGUNTA: {question}\n")
    hops: list[dict] = []
    verificacion: dict | None = None
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
                if event == "plan":
                    print("  PLAN DE EVIDENCIA:")
                    for it in data.get("items") or []:
                        print(f"    {it.get('id')}: {it.get('evidence_needed')}")
                elif event == "hop":
                    hops.append(data)
                    print(f"  hop {data.get('n')}: {data.get('query')}")
                elif event == "verificacion":
                    verificacion = data
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

    # Informe de atribución. Se imprime lo que FALLA en primer plano: en una
    # comprobación puntual, lo útil no es saber que 3 de 3 están bien, es que
    # una cita no resuelve.
    if verificacion:
        afirmaciones = verificacion.get("afirmaciones") or []
        fidelidad = verificacion.get("fidelidad")
        sin_resolver = verificacion.get("citas_sin_resolver") or []
        etiqueta = "n/d" if fidelidad is None else f"{fidelidad:.0%}"
        print(f"\nVERIFICACION DE ATRIBUCION (fidelidad {etiqueta}):")
        if not verificacion.get("ok", True):
            print(f"  AVISO: {verificacion.get('nota')}")
        if sin_resolver:
            print(f"  CITAS SIN FUENTE RECUPERADA: {', '.join(sin_resolver)}")
        for a in afirmaciones:
            if a.get("veredicto") == "sostenida":
                continue
            print(f"  [{a.get('veredicto')}] {str(a.get('texto'))[:90]}")
            print(f"      cita: {a.get('cita')}")
            if a.get("motivo"):
                print(f"      motivo: {a.get('motivo')}")
        sostenidas = sum(1 for a in afirmaciones if a.get("veredicto") == "sostenida")
        print(f"  {sostenidas}/{len(afirmaciones)} afirmaciones sostenidas por su fuente")

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
        # El informe completo, para que --json quede auditable: en
        # investigación la atribución de cada afirmación es parte del
        # resultado, no un detalle de la consola.
        "verificacion": verificacion,
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
        "--login", metavar="CORREO", default=None,
        help="inicia sesión en Supabase y usa ese token (pide la contraseña por "
             "la variable RAG_PASSWORD, para no dejarla en el historial)",
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

    token = args.token
    if args.login:
        password = os.environ.get("RAG_PASSWORD")
        if not password:
            raise SystemExit(
                "Define la contraseña en la variable RAG_PASSWORD antes de usar "
                "--login, para que no quede escrita en el historial de la consola."
            )
        token = obtener_token(args.login, password)
        print(f"Sesión iniciada como {args.login}.")

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
            resultado = ask(pregunta, args.base, token)
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
