"""Orquestación de la ingesta: parse → chunk → validaciones → embed → upsert.

- Dry-run: parse + chunk + validaciones SIN llamadas a OpenAI ni Qdrant ni
  Supabase (imports de servicios diferidos); imprime stats por archivo y
  devuelve exit code 1 si alguna validación falla.
- Ingesta real: embed_texts (batch) → ensure_collection + delete_by_file +
  upsert_chunks → registro en Supabase (start_run/register_document/finish_run).

Fuentes (`source`):
- 'xlsx' (default si data/raw_xlsx está completa): los VALORES salen de los
  .xlsx originales (fuente de verdad, cero riesgo de parseo PDF) y las
  páginas de cita (page/source_pages) se cruzan por número de fila con el
  parseo del PDF — los humanos abren el PDF. Filas sin correlato en el PDF
  quedan con page=0 y source_pages=[].
- 'pdf': ruta original, parsea los renders PDF de data/raw.
Las validaciones (conteos exactos, SKU en cada chunk, gate de costos
confidenciales) aplican a ambas rutas; la de mojibake U+FFFD solo a la PDF.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

from app.config import DATA_RAW_DIR
from app.ingest.chunk import SUPPLIERS, build_chunks, find_cost_leaks
from app.ingest.parse import FILE_CONFIGS, parse_pdf
from app.ingest.parse_xlsx import (
    DATA_RAW_XLSX_DIR,
    PDF_TO_XLSX,
    attach_pdf_page_map,
    parse_xlsx,
    xlsx_source_complete,
)

logger = logging.getLogger(__name__)

# Orden canónico de procesamiento (los 6 PDFs de data/raw).
CANONICAL_FILES = [
    "Catalogo_Aleum.pdf",
    "Catalogo_Reliable_1.pdf",
    "Catalogo_Reliable_2.pdf",
    "Catalogo_Reliable_3.pdf",
    "Catalogo_Croker__2.pdf",
    "Notifier_.pdf",
]


# ---------------------------------------------------------------------------
# Validaciones (el dry-run DEBE pasarlas; la ingesta real también las corre
# y aborta antes de tocar OpenAI/Qdrant si fallan)
# ---------------------------------------------------------------------------
def validate(per_file: dict[str, dict], check_mojibake: bool = True) -> list[str]:
    """per_file: {file_name: {"doc":…, "chunks":…, "stats":…}} → errores.

    check_mojibake=False en la ruta xlsx: el U+FFFD es un defecto exclusivo
    de la extracción PDF; los valores del Excel se leen ya decodificados."""
    errors: list[str] = []
    all_chunks: list[dict] = []

    for file_name, data in per_file.items():
        config = FILE_CONFIGS[file_name]
        doc, chunks = data["doc"], data["chunks"]
        all_chunks.extend(chunks)

        # 1. Conteo exacto de bloques '■ Fila N' (= registros del Excel).
        if len(doc.rows) != config.expected_blocks:
            errors.append(
                f"{file_name}: bloques parseados {len(doc.rows)} != "
                f"esperados {config.expected_blocks}"
            )
        row_numbers = [r.source_row for r in doc.rows]
        if row_numbers and (min(row_numbers) != config.first_row
                            or max(row_numbers) != config.last_row):
            errors.append(
                f"{file_name}: rango de filas {min(row_numbers)}.."
                f"{max(row_numbers)} != esperado {config.first_row}.."
                f"{config.last_row}"
            )

        for chunk in chunks:
            text = chunk["text"]
            # 2. 0 mojibake en los textos embebidos (solo ruta PDF).
            if check_mojibake and ("�" in text or "(cid:" in text):
                errors.append(
                    f"{file_name} fila {chunk['source_row']}: mojibake "
                    f"(U+FFFD/cid) en el texto"
                )
            # 3. Todo chunk de producto contiene su SKU en el texto.
            if chunk["chunk_type"] == "product":
                sku = chunk.get("sku") or ""
                if not sku:
                    errors.append(
                        f"{file_name} fila {chunk['source_row']}: sin SKU"
                    )
                elif sku not in text:
                    errors.append(
                        f"{file_name} fila {chunk['source_row']}: SKU '{sku}' "
                        f"no aparece en el texto"
                    )

    # 4. 0 costos internos (COSTO FIRETECH / Unit Cost) en textos.
    errors.extend(find_cost_leaks(all_chunks))
    return errors


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------
def print_stats(per_file: dict[str, dict]) -> None:
    total_products = total_families = 0
    for file_name in CANONICAL_FILES:
        if file_name not in per_file:
            continue
        s = per_file[file_name]["stats"]
        total_products += s["product_chunks"]
        total_families += s["family_chunks"]
        print(f"\n=== {file_name} ===")
        print(f"  paginas PDF:            {s['pages']}")
        print(f"  bloques 'Fila N':       {s['blocks_parsed']} "
              f"(esperados {s['expected_blocks']})")
        print(f"  chunks producto:        {s['product_chunks']}")
        print(f"  chunks family_summary:  {s['family_chunks']}")
        if s.get("rows_without_pdf_page"):
            print(f"  filas sin página PDF:   {s['rows_without_pdf_page']} "
                  f"(page=0, source_pages=[])")
        if s["merged_duplicate_skus"]:
            print(f"  SKUs duplicados fusionados: {s['merged_duplicate_skus']} "
                  f"({s['merged_rows_removed']} filas absorbidas)")
        print(f"  price_status:           {s['price_status']}")
        if s["missing_fields"]:
            print(f"  campos faltantes:       {s['missing_fields']}")
        if s["flags"]:
            print(f"  flags de calidad:       {s['flags']}")
    print(f"\nTOTAL: {total_products} chunks producto + "
          f"{total_families} family_summary = {total_products + total_families}")


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
def _resolve_files(only: str | None, source: str) -> list[tuple[str, Path, Path | None]]:
    """[(nombre canónico .pdf, ruta PDF, ruta xlsx | None)]. --only acepta
    tanto el nombre .pdf como el .xlsx original."""
    files: list[tuple[str, Path, Path | None]] = []
    for name in CANONICAL_FILES:
        if only and only.lower() not in (name.lower(), PDF_TO_XLSX[name].lower()):
            continue
        pdf_path = DATA_RAW_DIR / name
        # El PDF hace falta en ambas rutas: en xlsx aporta el mapa fila→páginas.
        if not pdf_path.exists():
            raise FileNotFoundError(f"No existe {pdf_path}")
        xlsx_path: Path | None = None
        if source == "xlsx":
            xlsx_path = DATA_RAW_XLSX_DIR / PDF_TO_XLSX[name]
            if not xlsx_path.exists():
                raise FileNotFoundError(f"No existe {xlsx_path}")
        files.append((name, pdf_path, xlsx_path))
    if not files:
        raise ValueError(
            f"--only '{only}' no coincide con ningún archivo conocido: "
            f"{', '.join(CANONICAL_FILES)}"
        )
    return files


def run_ingest(only: str | None = None, dry_run: bool = False,
               reset: bool = False, source: str | None = None) -> int:
    """Devuelve el exit code del proceso (0 ok, 1 fallo).

    source: 'xlsx' | 'pdf' | None (auto: xlsx si data/raw_xlsx está completa)."""
    t0 = time.time()

    if source not in (None, "pdf", "xlsx"):
        raise ValueError(f"source inválido: {source!r} (usa 'pdf' o 'xlsx')")
    if source is None:
        source = "xlsx" if xlsx_source_complete() else "pdf"
        print(f"Fuente auto-detectada: {source} "
              f"({'data/raw_xlsx completa' if source == 'xlsx' else 'data/raw_xlsx ausente o incompleta'})")
    else:
        print(f"Fuente: {source}")

    files = _resolve_files(only, source)

    # 1-2. parse + chunk (sin servicios externos)
    per_file: dict[str, dict] = {}
    for name, pdf_path, xlsx_path in files:
        if source == "xlsx":
            print(f"Parseando {xlsx_path.name} (valores) + {name} (páginas) ...",
                  flush=True)
            doc = parse_xlsx(xlsx_path)
            pdf_doc = parse_pdf(pdf_path)
            rows_without_page = attach_pdf_page_map(doc, pdf_doc)
        else:
            print(f"Parseando {name} ...", flush=True)
            doc = parse_pdf(pdf_path)
            rows_without_page = None
        chunks, stats = build_chunks(doc)
        stats["source"] = source
        if rows_without_page is not None:
            stats["rows_without_pdf_page"] = rows_without_page
        per_file[name] = {
            "doc": doc, "chunks": chunks, "stats": stats,
            # path = archivo realmente ingerido (sha256/registro en Supabase)
            "path": xlsx_path if source == "xlsx" else pdf_path,
        }

    # 3. validaciones (siempre; la ingesta real aborta si fallan).
    # El mojibake U+FFFD es exclusivo de la extracción PDF.
    errors = validate(per_file, check_mojibake=(source == "pdf"))
    print_stats(per_file)

    if errors:
        print(f"\nVALIDACIONES: FALLARON ({len(errors)} errores)")
        for err in errors[:50]:
            print(f"  - {err}")
        if len(errors) > 50:
            print(f"  ... y {len(errors) - 50} más")
        return 1
    print("\nVALIDACIONES: OK (conteos de bloques exactos, "
          + ("0 mojibake, " if source == "pdf" else "")
          + "SKU presente en cada chunk producto, 0 costos internos en textos)")

    if dry_run:
        print(f"\nDry-run (source={source}) completado en {time.time() - t0:.1f}s "
              f"(sin llamadas a OpenAI/Qdrant/Supabase).")
        return 0

    # ------------------------------------------------------------------
    # Ingesta real (imports diferidos para que el dry-run no toque nada)
    # ------------------------------------------------------------------
    from app.config import get_settings
    from app.services import supabase_db
    from app.services.embeddings import embed_texts
    from app.services.qdrant import (
        delete_by_file, ensure_collection, get_client, upsert_chunks,
    )

    settings = get_settings()
    run_id = supabase_db.start_run()
    run_stats: dict = {
        "source": source,
        "files": {name: dict(data["stats"]) for name, data in per_file.items()},
    }
    try:
        if reset:
            client = get_client()
            if client.collection_exists(settings.qdrant_collection):
                client.delete_collection(settings.qdrant_collection)
                print(f"Colección '{settings.qdrant_collection}' borrada (--reset).")
        ensure_collection()

        total_points = 0
        for name in CANONICAL_FILES:
            if name not in per_file:
                continue
            data = per_file[name]
            chunks = data["chunks"]
            texts = [c["text"] for c in chunks]
            print(f"Embebiendo {len(texts)} chunks de {name} ...", flush=True)
            vectors = embed_texts(texts)
            if len(vectors) != len(chunks):
                raise RuntimeError(
                    f"{name}: {len(vectors)} embeddings para {len(chunks)} chunks"
                )
            for chunk, vec in zip(chunks, vectors):
                chunk["dense"] = vec

            delete_by_file(name)
            upserted = upsert_chunks(chunks)
            total_points += upserted
            print(f"  upserted {upserted} puntos.")

            sha256 = hashlib.sha256(data["path"].read_bytes()).hexdigest()
            supabase_db.register_document(
                file_name=name,
                sha256=sha256,
                pages=data["doc"].page_count,
                chunks=len(chunks),
                brand=SUPPLIERS[name],
            )
            run_stats["files"][name]["upserted"] = upserted

        run_stats["total_points"] = total_points
        run_stats["elapsed_s"] = round(time.time() - t0, 1)
        supabase_db.finish_run(run_id, "completed", run_stats)
        print(f"\nIngesta completa: {total_points} puntos en "
              f"'{settings.qdrant_collection}' ({run_stats['elapsed_s']}s).")
        return 0
    except Exception as exc:
        logger.exception("Fallo la ingesta")
        run_stats["elapsed_s"] = round(time.time() - t0, 1)
        supabase_db.finish_run(run_id, "failed", run_stats, error=str(exc))
        print(f"\nERROR en la ingesta: {exc}")
        return 1
