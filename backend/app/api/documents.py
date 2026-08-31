"""Gestión de documentos: subir / listar / borrar con indexación dinámica.

Contrato: SPEC.md, sección "Gestión de documentos (indexación dinámica)".
- GET    /api/documents            → registro (Supabase o memoria) fusionado
                                     con los 6 catálogos canónicos.
- POST   /api/documents/upload     → 202 + ingesta en background
                                     (parse genérico → embed → Qdrant).
- DELETE /api/documents/{file_name}→ borra puntos de Qdrant + registro
                                     (403 para los catálogos canónicos).
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.config import PROJECT_DIR
from app.ingest.chunk import SUPPLIERS
from app.ingest.generic import parse_generic
from app.ingest.pipeline import CANONICAL_FILES
from app.services import supabase_db

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".xlsx", ".csv", ".txt", ".md"}
MAX_UPLOAD_BYTES_LOCAL = 25 * 1024 * 1024

# --- Modo serverless (Vercel define VERCEL=1) -------------------------------
# En Vercel los BackgroundTasks mueren al enviarse la respuesta, así que la
# ingesta corre INLINE (respuesta 200 con status final). Vercel además corta
# cualquier body >4.5 MB con 413 ANTES de invocar la función, así que el
# límite efectivo en serverless es 4 MB (bajo el cap de la plataforma).
# El filesystem es de solo lectura salvo /tmp: los uploads van ahí (efímeros;
# el índice real vive en Qdrant y el registro en Supabase).
IS_SERVERLESS = bool(os.environ.get("VERCEL"))
MAX_UPLOAD_BYTES_SERVERLESS = 4 * 1024 * 1024
MAX_UPLOAD_BYTES = (
    MAX_UPLOAD_BYTES_SERVERLESS if IS_SERVERLESS else MAX_UPLOAD_BYTES_LOCAL
)
# Límite vigente en MB: lo expone GET /api/health como "upload_limit_mb" para
# que el frontend anuncie el valor real (4 en Vercel, 25 en local).
UPLOAD_LIMIT_MB = MAX_UPLOAD_BYTES // (1024 * 1024)
UPLOADS_DIR = (
    Path(tempfile.gettempdir()) / "rag_uploads"
    if IS_SERVERLESS
    else PROJECT_DIR / "data" / "uploads"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _sanitize_file_name(raw: str) -> str:
    """Nombre de archivo saneado: sin rutas, solo [A-Za-z0-9._-]."""
    # Basename defensivo (el cliente puede mandar rutas con \ o /).
    name = Path(raw.replace("\\", "/")).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name.lstrip(".")


def _doc_row(row: dict) -> dict:
    """Normaliza una fila del registro al contrato de GET /documents."""
    return {
        "id": row.get("id") or row.get("file_name"),
        "file_name": row.get("file_name") or "",
        "pages": int(row.get("pages") or 0),
        "chunks": int(row.get("chunks") or 0),
        "brand": row.get("brand") or "",
        "status": row.get("status") or "ready",
        "error": row.get("error"),
        "ingested_at": row.get("ingested_at"),
    }


def _canonical_placeholder(file_name: str) -> dict:
    """Fila sintética para un catálogo base aún no registrado en Supabase."""
    return {
        "id": file_name,
        "file_name": file_name,
        "pages": 0,
        "chunks": 0,
        "brand": SUPPLIERS.get(file_name, ""),
        "status": "ready",
        "error": None,
        "ingested_at": None,
    }


# ---------------------------------------------------------------------------
# Ingesta (en background vía BackgroundTasks, o inline en modo serverless)
# ---------------------------------------------------------------------------
def _registry_row_exists(file_name: str) -> bool:
    """¿Sigue existiendo la fila del documento en el registro?"""
    rows = supabase_db.list_documents()
    return any(r.get("file_name") == file_name for r in rows)


def _cleanup_deleted_during_processing(path: Path, file_name: str) -> None:
    """El doc fue borrado (DELETE) mientras se procesaba: limpiar sin registrar.

    Borra los chunks recién insertados en Qdrant y el archivo físico. NO
    recrea la fila del registro (el borrado del usuario prevalece).
    """
    logger.info(
        "'%s' fue borrado del registro durante el processing; se limpian "
        "chunks y archivo sin registrar nada.",
        file_name,
    )
    try:
        from app.services.qdrant import delete_by_file

        delete_by_file(file_name)
    except Exception:
        logger.exception(
            "No se pudieron limpiar los chunks de '%s' tras su borrado",
            file_name,
        )
    try:
        if path.is_file():
            path.unlink()
    except OSError as exc:
        logger.warning("No se pudo borrar %s: %s", path, exc)


def _ingest_uploaded(path: Path, file_name: str) -> str:
    """parse genérico → embed → ensure_collection + delete_by_file + upsert.

    Todo dentro de try/except: cualquier fallo marca el documento 'failed'
    con el error, y se loguea con traceback. Devuelve el status final
    ("ready" | "failed" | "deleted") para el modo de ingesta inline.

    Si el documento fue borrado (DELETE /documents/{file}) mientras se
    procesaba, NO se re-registra: se limpian los chunks recién insertados y
    el archivo, y el task termina sin tocar el registro.
    """
    try:
        from app.services.embeddings import embed_texts
        from app.services.qdrant import (
            delete_by_file,
            ensure_collection,
            upsert_chunks,
        )

        chunks, pages = parse_generic(path, file_name)
        logger.info(
            "Ingesta de '%s': %d chunks, %d páginas/filas.",
            file_name, len(chunks), pages,
        )

        texts = [c["text"] for c in chunks]
        vectors = embed_texts(texts)
        if len(vectors) != len(chunks):
            raise RuntimeError(
                f"{len(vectors)} embeddings para {len(chunks)} chunks"
            )
        for chunk, vec in zip(chunks, vectors):
            chunk["dense"] = vec

        ensure_collection()
        delete_by_file(file_name)  # re-ingesta idempotente
        upserted = upsert_chunks(chunks)

        # ¿Borraron el documento durante el processing? Entonces limpiar y
        # salir sin registrar nada (el registro nunca resucita).
        if not _registry_row_exists(file_name):
            _cleanup_deleted_during_processing(path, file_name)
            return "deleted"

        supabase_db.upsert_document_status(
            file_name, "ready", error=None, pages=pages, chunks=upserted
        )
        logger.info("Ingesta de '%s' completa: %d puntos.", file_name, upserted)
        return "ready"
    except Exception as exc:
        logger.exception("Fallo la ingesta de '%s'", file_name)
        try:
            if not _registry_row_exists(file_name):
                _cleanup_deleted_during_processing(path, file_name)
                return "deleted"
            supabase_db.upsert_document_status(
                file_name, "failed", error=str(exc)[:2000]
            )
        except Exception:
            logger.exception(
                "No se pudo marcar '%s' como failed en el registro", file_name
            )
        return "failed"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/documents")
async def list_documents() -> dict:
    rows = await run_in_threadpool(supabase_db.list_documents)
    by_name = {r.get("file_name"): r for r in rows}

    documents: list[dict] = []
    # 1. Los 6 catálogos base, siempre presentes y en orden canónico.
    for name in CANONICAL_FILES:
        row = by_name.pop(name, None)
        documents.append(_doc_row(row) if row else _canonical_placeholder(name))
    # 2. El resto (subidos), en orden de ingesta.
    documents.extend(_doc_row(r) for r in by_name.values())

    return {"documents": documents}


@router.post("/documents/upload", status_code=202)
async def upload_document(
    background_tasks: BackgroundTasks, file: UploadFile = File(...)
) -> dict:
    file_name = _sanitize_file_name(file.filename or "")
    if not file_name or not Path(file_name).stem:
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")

    ext = Path(file_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Extensión '{ext or '(ninguna)'}' no permitida. "
                f"Permitidas: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
            ),
        )

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Archivo demasiado grande ({len(data)} bytes; "
                f"máx. {UPLOAD_LIMIT_MB} MB en este despliegue)"
            ),
        )
    if not data:
        raise HTTPException(status_code=400, detail="El archivo está vacío")

    if file_name in CANONICAL_FILES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{file_name}' es un catálogo base y no puede reemplazarse "
                f"por esta vía"
            ),
        )
    existing = await run_in_threadpool(supabase_db.list_documents)
    if any(r.get("file_name") == file_name for r in existing):
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{file_name}' ya está indexado. Bórralo primero "
                f"(DELETE /api/documents/{file_name})"
            ),
        )

    # Guardar en data/uploads/ (creado on-demand).
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS_DIR / file_name
    dest.write_bytes(data)

    # Registrar ANTES de encolar el task: GET /documents refleja "processing"
    # al instante y el frontend puede hacer polling.
    sha256 = hashlib.sha256(data).hexdigest()
    doc_id = await run_in_threadpool(
        lambda: supabase_db.register_document(
            file_name=file_name,
            sha256=sha256,
            pages=0,
            chunks=0,
            brand="",
            status="processing",
        )
    )

    # Modo serverless: la ingesta corre INLINE antes de responder (los
    # BackgroundTasks de Vercel mueren tras la respuesta). 200 con el status
    # final; el frontend ya tolera "ready"/"failed" inmediatos (simplemente
    # no arranca el polling).
    if IS_SERVERLESS:
        status = await run_in_threadpool(_ingest_uploaded, dest, file_name)
        return JSONResponse(
            status_code=200,
            content={
                "id": doc_id or file_name,
                "file_name": file_name,
                "status": status,
            },
        )

    background_tasks.add_task(_ingest_uploaded, dest, file_name)
    return {"id": doc_id or file_name, "file_name": file_name, "status": "processing"}


@router.delete("/documents/{file_name}")
async def delete_document(file_name: str) -> dict:
    if file_name in CANONICAL_FILES:
        raise HTTPException(
            status_code=403,
            detail=f"'{file_name}' es un catálogo base y no puede borrarse",
        )

    safe_name = _sanitize_file_name(file_name)
    rows = await run_in_threadpool(supabase_db.list_documents)
    if not any(r.get("file_name") == file_name for r in rows):
        raise HTTPException(
            status_code=404, detail=f"'{file_name}' no está registrado"
        )

    from app.services.qdrant import delete_by_file

    await run_in_threadpool(delete_by_file, file_name)
    await run_in_threadpool(supabase_db.delete_document, file_name)

    # Borrar el archivo físico si está en uploads (best-effort).
    if safe_name:
        try:
            stored = UPLOADS_DIR / safe_name
            if stored.is_file():
                stored.unlink()
        except OSError as exc:
            logger.warning("No se pudo borrar %s: %s", stored, exc)

    return {"ok": True}
