"""CLI de ingesta del RAG de productos.

Uso (desde backend/, con el venv activo):
    python ingest.py --dry-run [--only <archivo>] [--source pdf|xlsx]
    python ingest.py --environment local|production [--only <archivo>]
                     [--source pdf|xlsx] [--reset --yes [--include-uploads]]

--dry-run   parse + chunk + validaciones SIN llamadas a OpenAI/Qdrant/Supabase;
            imprime stats por archivo; exit code 1 si alguna validación falla.
--environment
            OBLIGATORIO para la ingesta real (el dry-run puede omitirlo).
            Etiqueta las filas de `documents` en Supabase (prod y local
            comparten la tabla pero tienen Qdrants distintos). Se fija en la
            variable ENVIRONMENT antes de cargar la configuración; si esa
            variable ya existe en el entorno con OTRO valor, el comando aborta
            con exit 2. NO elige el Qdrant: ese sigue saliendo de QDRANT_URL
            (.env); el preflight imprime el host para que lo confirmes.
--reset     borra y recrea la colección Qdrant antes de ingestar. Exige --yes
            (si no, aborta con exit 2 sin tocar nada). Además, si la colección
            contiene chunks de documentos subidos por usuarios (chunk_type
            doc_text/doc_row), se niega salvo que se pase --include-uploads:
            esos documentos se perderían y habría que volver a subirlos.
--yes       confirma la operación destructiva de --reset.
--include-uploads
            junto con --reset: acepta perder los chunks de documentos subidos.
--only      procesa un solo archivo (p. ej. --only Catalogo_Aleum.pdf o
            --only Catalogo_Aleum.xlsx).
--source    'xlsx' toma los valores de los Excel originales (data/raw_xlsx,
            fuente de verdad) y cruza las páginas de cita desde el PDF por
            número de fila; 'pdf' parsea los renders PDF (data/raw).
            Default: xlsx si data/raw_xlsx existe y está completa, si no pdf.

Antes de embeber nada, la ingesta real imprime un preflight (entorno, host y
colección Qdrant con sus puntos, filas de `documents` del entorno) y solo
entonces gasta tokens. Exit codes: 0 ok, 1 fallo, 2 abortado por una guarda.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

ENVIRONMENTS = ("local", "production")


def main() -> int:
    # Consola Windows (cp1252) no imprime ■/á/°: forzar UTF-8 en stdout/err.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Ingesta de catálogos → Qdrant")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="parse + chunk + validaciones, sin OpenAI/Qdrant/Supabase",
    )
    parser.add_argument(
        "--environment", choices=ENVIRONMENTS, default=None,
        help="entorno que etiqueta las filas de documents en Supabase; "
             "obligatorio para la ingesta real (no para --dry-run). Fija la "
             "variable ENVIRONMENT antes de cargar la configuración.",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="borra y recrea la colección antes de ingestar (exige --yes; se "
             "niega si hay chunks de documentos subidos salvo --include-uploads)",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="confirma la operación destructiva de --reset",
    )
    parser.add_argument(
        "--include-uploads", action="store_true",
        help="con --reset: acepta perder los chunks de documentos subidos por "
             "usuarios (chunk_type doc_text/doc_row) que haya en la colección",
    )
    parser.add_argument(
        "--only", metavar="ARCHIVO", default=None,
        help="procesa solo ese archivo (p. ej. Catalogo_Croker__2.pdf "
             "o Catalogo_Croker__2.xlsx)",
    )
    parser.add_argument(
        "--source", choices=("pdf", "xlsx"), default=None,
        help="fuente de los valores: 'xlsx' = Excel originales (data/raw_xlsx,"
             " fuente de verdad; páginas de cita cruzadas desde el PDF por"
             " fila), 'pdf' = renders PDF (data/raw). Default: xlsx si"
             " data/raw_xlsx está completa, si no pdf.",
    )
    args = parser.parse_args()

    # Guardas baratas ANTES de importar la app: ninguna toca red ni disco.
    if args.reset and not args.yes:
        print(
            "ABORTADO: --reset borra la colección Qdrant completa y exige "
            "confirmación explícita. Repite el comando añadiendo --yes "
            "(y --include-uploads si aceptas perder documentos subidos).",
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
        only=args.only,
        dry_run=args.dry_run,
        reset=args.reset,
        source=args.source,
        environment=args.environment,
        include_uploads=args.include_uploads,
    )


if __name__ == "__main__":
    sys.exit(main())
