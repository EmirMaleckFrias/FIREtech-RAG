"""CLI de ingesta del RAG de productos.

Uso (desde backend/, con el venv activo):
    python ingest.py [--dry-run] [--reset] [--only <archivo>] [--source pdf|xlsx]

--dry-run  parse + chunk + validaciones SIN llamadas a OpenAI/Qdrant/Supabase;
           imprime stats por archivo; exit code 1 si alguna validación falla.
--reset    borra y recrea la colección Qdrant antes de ingestar.
--only     procesa un solo archivo (p. ej. --only Catalogo_Aleum.pdf o
           --only Catalogo_Aleum.xlsx).
--source   'xlsx' toma los valores de los Excel originales (data/raw_xlsx,
           fuente de verdad) y cruza las páginas de cita desde el PDF por
           número de fila; 'pdf' parsea los renders PDF (data/raw).
           Default: xlsx si data/raw_xlsx existe y está completa, si no pdf.
"""
from __future__ import annotations

import argparse
import logging
import sys


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
        "--reset", action="store_true",
        help="borra y recrea la colección antes de ingestar",
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

    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )

    from app.ingest.pipeline import run_ingest

    return run_ingest(only=args.only, dry_run=args.dry_run, reset=args.reset,
                      source=args.source)


if __name__ == "__main__":
    sys.exit(main())
