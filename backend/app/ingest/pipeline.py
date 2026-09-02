"""Orquestación de la ingesta: parse → chunk → validaciones → preflight →
embed → upsert.

- Dry-run: parse + chunk + validaciones SIN llamadas a OpenAI ni Qdrant ni
  Supabase (imports de servicios diferidos); imprime stats por archivo y
  devuelve exit code 1 si alguna validación falla.
- Ingesta real: preflight (entorno, Qdrant y Supabase, sin gastar nada) →
  embed_texts (batch) → ensure_collection + delete_by_file + upsert_chunks →
  registro en Supabase (start_run/register_document/finish_run).

Preflight (solo ingesta real, antes de embeber el primer chunk): imprime el
entorno (`environment`, el que etiqueta las filas de `documents`), el host de
Qdrant sin credenciales, si la colección existe y cuántos puntos tiene, y
cuántas filas de `documents` hay para ese entorno. Con `reset`, la colección
se borra SOLO tras pasar la guarda de uploads: si contiene chunks de
documentos subidos por usuarios (chunk_type doc_text/doc_row) aborta con
exit 2 salvo `include_uploads`, porque esos documentos se perderían.

Fuentes (`source`):
- 'xlsx' (default si data/raw_xlsx está completa): los VALORES salen de los
  .xlsx originales (fuente de verdad, cero riesgo de parseo PDF) y las
  páginas de cita (page/source_pages) se cruzan por número de fila con el
  parseo del PDF (los humanos abren el PDF). Filas sin correlato en el PDF
  quedan con page=0 y source_pages=[].
- 'pdf': ruta original, parsea los renders PDF de data/raw.
Las validaciones (conteos exactos, SKU en cada chunk, gate de costos
confidenciales) aplican a ambas rutas; la de mojibake U+FFFD solo a la PDF.

Exit codes de `run_ingest`: 0 ok, 1 fallo (validación o error en la ingesta),
2 abortado por una guarda del preflight (nada se tocó).
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path
from urllib.parse import urlsplit

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

# chunk_type de los documentos subidos por usuarios (contrato de
# app/ingest/generic.py: "doc_text" para PDF/TXT/MD, "doc_row" para XLSX/CSV).
# Los catálogos canónicos usan "product" y "family_summary" (app/ingest/chunk.py).
# Un --reset borra la colección entera, así que estos son los puntos que NO
# se pueden regenerar desde data/raw: la guarda de uploads cuenta exactamente
# estos tipos.
UPLOAD_CHUNK_TYPES = ("doc_text", "doc_row")

# Exit code de las guardas del preflight (nada se tocó).
EXIT_ABORTED = 2


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


# ---------------------------------------------------------------------------
# Preflight de la ingesta real (sin gastar nada: ni OpenAI ni escrituras)
# ---------------------------------------------------------------------------
def _qdrant_host_label(url: str) -> str:
    """Host[:puerto] de la URL de Qdrant, sin credenciales ni query string."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or url
        return f"{host}:{parts.port}" if parts.port else host
    except Exception:
        return "(url no parseable)"


def _count_upload_chunks(client, collection: str) -> int:
    """Puntos de la colección cuyo chunk_type es de documento subido."""
    from qdrant_client import models

    return client.count(
        collection_name=collection,
        exact=True,
        count_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="chunk_type",
                    match=models.MatchAny(any=list(UPLOAD_CHUNK_TYPES)),
                )
            ]
        ),
    ).count


def _preflight(settings, environment: str | None, reset: bool,
               include_uploads: bool) -> int | None:
    """Imprime el estado de Qdrant y Supabase para el entorno y aplica las
    guardas. Devuelve un exit code para abortar o None para continuar.

    Corre tras las validaciones y ANTES de embeber el primer chunk, así una
    colección equivocada o un entorno mal etiquetado se ven sin gastar tokens.
    No escribe nada: solo lecturas (collection_exists/count/select).
    """
    from app.services import supabase_db
    from app.services.qdrant import get_client

    print("\n--- Preflight (solo lecturas, nada se ha tocado todavía) ---")

    # (c) Entorno: el que etiqueta las filas de `documents`. Si lo pidió el
    # CLI, debe coincidir con lo que cargó la configuración; si no coincide
    # es que ENVIRONMENT no llegó a la config (uso programático) y las filas
    # quedarían mal etiquetadas.
    effective_env = settings.environment
    if environment is not None and environment != effective_env:
        print(
            f"ABORTADO: se pidió environment={environment!r} pero la "
            f"configuración cargó {effective_env!r} (ENVIRONMENT). Fija la "
            f"variable ENVIRONMENT antes de importar la app (ingest.py lo hace "
            f"con --environment)."
        )
        return EXIT_ABORTED
    print(f"Entorno: {effective_env}")

    # (a) Qdrant: host sin credenciales, versión del servidor, colección.
    client = get_client()
    collection = settings.qdrant_collection
    host = _qdrant_host_label(settings.qdrant_url)
    api_key_label = "api key configurada" if settings.qdrant_api_key else "sin api key"
    try:
        version = client.info().version
    except Exception:
        version = "desconocida"
    try:
        exists = client.collection_exists(collection)
    except Exception as exc:
        print(f"Qdrant: {host} ({api_key_label}) NO responde: {exc}")
        print("ABORTADO: sin Qdrant no hay dónde upsertear; nada se embebió.")
        return 1
    print(f"Qdrant: {host} ({api_key_label}), versión {version}")
    upload_points = 0
    if exists:
        try:
            points = client.count(collection_name=collection, exact=True).count
        except Exception:
            try:
                points = getattr(client.get_collection(collection), "points_count", None)
            except Exception as exc:
                logger.warning("No se pudo leer la colección: %s", exc)
                points = "desconocidos"
        try:
            upload_points = _count_upload_chunks(client, collection)
        except Exception as exc:
            logger.warning("No se pudieron contar los chunks de uploads: %s", exc)
            upload_points = -1
        uploads_label = (
            f"{upload_points} de documentos subidos" if upload_points >= 0
            else "chunks de documentos subidos: no se pudieron contar"
        )
        print(f"  colección '{collection}': existe, {points} puntos "
              f"({uploads_label}).")
    else:
        print(f"  colección '{collection}': NO existe (se creará).")

    # (b) Supabase: filas de `documents` para este entorno.
    if not supabase_db.db_available():
        print("Supabase: no configurado; el registro de documentos y del run "
              "irá a memoria y se perderá al terminar el proceso.")
    else:
        try:
            rows = supabase_db.list_documents()
            canonical = sum(1 for r in rows if r.get("file_name") in CANONICAL_FILES)
            print(f"Supabase: {len(rows)} filas en documents para "
                  f"'{effective_env}' ({canonical} canónicas, "
                  f"{len(rows) - canonical} subidas).")
        except Exception as exc:
            print(f"Supabase: no se pudo leer documents ({exc}); se continúa.")

    # Guarda de --reset: la colección solo se borra si no arrastra documentos
    # subidos, o si el operador aceptó perderlos explícitamente.
    if reset and exists:
        if upload_points < 0:
            print(
                "ABORTADO: --reset no puede verificar si la colección contiene "
                "documentos subidos (falló el conteo). Revisa Qdrant y repite."
            )
            return EXIT_ABORTED
        if upload_points > 0 and not include_uploads:
            print(
                f"ABORTADO: --reset borraría la colección '{collection}' "
                f"completa y contiene {upload_points} chunks de documentos "
                f"subidos por usuarios (chunk_type "
                f"{'/'.join(UPLOAD_CHUNK_TYPES)}). Esos documentos no están "
                f"en data/raw y se perderían: habría que volver a subirlos "
                f"desde la app. Si eso es lo que quieres, repite con "
                f"--include-uploads."
            )
            return EXIT_ABORTED
        if upload_points > 0:
            print(
                f"AVISO (--include-uploads): se perderán {upload_points} chunks "
                f"de documentos subidos; sus filas en documents quedarán sin "
                f"puntos hasta que se borren o se resuban desde la app."
            )
        print(f"--reset confirmado: la colección '{collection}' se borrará y "
              f"recreará.")
    elif reset:
        print("--reset: la colección no existe, no hay nada que borrar.")
    return None


def run_ingest(only: str | None = None, dry_run: bool = False,
               reset: bool = False, source: str | None = None,
               environment: str | None = None,
               include_uploads: bool = False) -> int:
    """Devuelve el exit code del proceso (0 ok, 1 fallo, 2 abortado por guarda).

    source: 'xlsx' | 'pdf' | None (auto: xlsx si data/raw_xlsx está completa).
    environment: entorno pedido por el CLI ('local' | 'production'); debe
        coincidir con get_settings().environment (ingest.py fija ENVIRONMENT
        antes de importar este módulo). None = no se verifica, se usa el de
        la configuración.
    include_uploads: con reset, acepta borrar los chunks de documentos subidos
        (sin él, el preflight aborta con exit 2 si los hay)."""
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

    # Preflight: estado de Qdrant/Supabase para el entorno + guardas. Va
    # ANTES de start_run y de embeber nada: si aborta, no queda ni un run
    # "running" huérfano ni un token gastado.
    aborted = _preflight(settings, environment, reset, include_uploads)
    if aborted is not None:
        return aborted

    run_id = supabase_db.start_run()
    run_stats: dict = {
        "source": source,
        "environment": settings.environment,
        "files": {name: dict(data["stats"]) for name, data in per_file.items()},
    }
    try:
        if reset:
            # La guarda de uploads ya pasó en el preflight (o se aceptó con
            # include_uploads): aquí solo se ejecuta el borrado.
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
