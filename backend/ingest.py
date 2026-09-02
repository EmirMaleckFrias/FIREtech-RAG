"""CLI de ingesta de documentos.

Uso (desde backend/, con el venv activo):
    python ingest.py --dry-run ../documentos
    python ingest.py --environment local ../documentos --proyecto alzheimer
    python ingest.py --environment local doc1.pdf doc2.docx --max-usd 0.05

Acepta carpetas (recorridas hacia dentro) y archivos sueltos. Los formatos
soportados los decide app/ingest/generic.py; lo demás se ignora en silencio.

--dry-run   descubre y parsea SIN llamar a OpenAI, Qdrant ni Supabase, e
            imprime cuántos chunks salen y CUÁNTO COSTARÍA embeberlos. Es lo
            que hay que correr siempre antes de gastar.
--environment
            OBLIGATORIO para la ingesta real (el dry-run puede omitirlo).
            Etiqueta las filas de `documents` en Supabase (prod y local
            comparten la tabla pero tienen Qdrants distintos). Se fija en la
            variable ENVIRONMENT antes de cargar la configuración; si esa
            variable ya existe con otro valor, el comando aborta con exit 2.
            NO elige el Qdrant: ese sale de QDRANT_URL (.env) y el preflight
            imprime el host para que lo confirmes.
--proyecto  etiqueta todos los chunks de esta corrida con ese project_id, para
            poder acotar después las búsquedas a ese conjunto de documentos.
--max-usd   tope de gasto: si el coste estimado de los embeddings lo supera,
            aborta con exit 2 sin embeber nada.
--force     reingiere aunque el archivo no haya cambiado (mismo sha256).
--sin-recursion
            no entra en las subcarpetas.
--reset     borra y recrea la colección Qdrant antes de ingestar. Exige --yes.
--yes       confirma la operación destructiva de --reset.

Antes de embeber nada, la ingesta real imprime un preflight (entorno, host y
colección Qdrant con sus puntos, documentos registrados) y solo entonces gasta
tokens. Exit codes: 0 ok, 1 fallo, 2 abortado por una guarda.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

ENVIRONMENTS = ("local", "production")


def main() -> int:
    # Consola Windows (cp1252) no imprime acentos: forzar UTF-8 en stdout/err.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(
        description="Ingesta de documentos hacia Qdrant"
    )
    parser.add_argument(
        "rutas", nargs="+", metavar="RUTA",
        help="carpetas o archivos a ingerir",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="parsea e informa del coste estimado, sin OpenAI/Qdrant/Supabase",
    )
    parser.add_argument(
        "--environment", choices=ENVIRONMENTS, default=None,
        help="entorno que etiqueta las filas de documents en Supabase; "
             "obligatorio para la ingesta real (no para --dry-run)",
    )
    parser.add_argument(
        "--proyecto", metavar="ID", default=None,
        help="project_id con el que se etiquetan los chunks de esta corrida",
    )
    parser.add_argument(
        "--max-usd", type=float, default=None, metavar="USD",
        help="aborta si el coste estimado de los embeddings supera este tope",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="reingiere aunque el archivo no haya cambiado (mismo sha256)",
    )
    parser.add_argument(
        "--sin-recursion", action="store_true",
        help="no entra en las subcarpetas",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="borra y recrea la colección antes de ingestar (exige --yes)",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="confirma la operación destructiva de --reset",
    )
    args = parser.parse_args()

    # Guardas baratas ANTES de importar la app: ninguna toca red ni disco.
    if args.reset and not args.yes:
        print(
            "ABORTADO: --reset borra la colección Qdrant completa y exige "
            "confirmación explícita. Repite el comando añadiendo --yes.",
            file=sys.stderr,
        )
        return 2

    if not args.dry_run and not args.environment:
        parser.error(
            "--environment {local,production} es obligatorio para la ingesta "
            "real (solo --dry-run puede omitirlo)."
        )

    if args.environment:
        # La configuración (app.config.Settings) lee ENVIRONMENT del entorno
        # con prioridad sobre .env, así que fijarla aquí, antes de cualquier
        # import de app.*, garantiza que get_settings().environment sea la
        # pedida. Si ya venía con otro valor no la pisamos en silencio.
        current = os.environ.get("ENVIRONMENT")
        if current is not None and current.strip() and current != args.environment:
            print(
                f"ABORTADO: la variable ENVIRONMENT ya está definida en el "
                f"entorno con el valor {current!r}, distinto de --environment "
                f"{args.environment!r}. Quita la variable o pide el mismo "
                f"entorno; no se ingesta con dos entornos en conflicto.",
                file=sys.stderr,
            )
            return 2
        os.environ["ENVIRONMENT"] = args.environment

    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )

    from app.ingest.pipeline import run_ingest

    return run_ingest(
        targets=[Path(r) for r in args.rutas],
        dry_run=args.dry_run,
        reset=args.reset,
        environment=args.environment,
        project_id=args.proyecto,
        force=args.force,
        recursive=not args.sin_recursion,
        max_usd=args.max_usd,
    )


if __name__ == "__main__":
    sys.exit(main())
