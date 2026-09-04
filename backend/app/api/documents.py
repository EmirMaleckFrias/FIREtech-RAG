"""Gestión de documentos: subir / listar / borrar con indexación dinámica.

Contrato: SPEC.md, sección "Gestión de documentos (indexación dinámica)".
- GET    /api/documents            → registro (Supabase o memoria).
- POST   /api/documents/upload     → 202 + ingesta en background
                                     (parse → embed → Qdrant).
- DELETE /api/documents/{file_name}→ borra puntos de Qdrant + registro.

Autenticación (SPEC.md § "Autenticación multiusuario"): los documentos son
compartidos (cualquier usuario autenticado los ve y los consulta), pero
subirlos y borrarlos es exclusivo de `admin` (403 para el rol de consulta).
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
import logging
import os
import re
import tempfile
from pathlib import Path

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.config import PROJECT_DIR
from app.ingest.generic import parse_generic
from app.services import supabase_db
from app.services.auth import AuthUser, current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"}
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
# Minutos tras los que un documento en `processing` se considera abandonado y
# se puede reintentar. Existe porque hay una forma de quedarse en `processing`
# PARA SIEMPRE: si la función de Vercel muere por el corte de 300 s a mitad de
# ingesta no hay excepción de Python, así que el `except` de `_ingest_uploaded`
# nunca corre y nadie marca `failed`. Y entonces los dos caminos de
# recuperación se bloqueaban entre sí: /upload responde 409 porque el nombre
# existe, y /reindex responde 409 porque está "procesando". La única salida
# era borrar y resubir. El tope de la función son 300 s, así que 10 minutos es
# holgado: nada legítimo sigue vivo pasado ese punto.
PROCESSING_STALE_MINUTES = 10
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


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _doc_row(row: dict) -> dict:
    """Normaliza una fila del registro al contrato de GET /documents."""
    return {
        "id": row.get("id") or row.get("file_name"),
        "file_name": row.get("file_name") or "",
        "pages": int(row.get("pages") or 0),
        "chunks": int(row.get("chunks") or 0),
        "status": row.get("status") or "ready",
        "error": row.get("error"),
        "ingested_at": row.get("ingested_at"),
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


def _ingest_uploaded(
    path: Path,
    file_name: str,
    document_id: str | None = None,
    project_id: str | None = None,
) -> str:
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
            delete_old_versions,
            ensure_collection,
            upsert_chunks,
        )

        chunks, pages = parse_generic(path, file_name)
        version = _sha256_path(path)
        for chunk in chunks:
            chunk["document_id"] = document_id
            chunk["project_id"] = project_id
            chunk["document_version"] = version
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
        upserted = upsert_chunks(chunks)
        delete_old_versions(file_name, version)

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
async def list_documents(user: AuthUser = Depends(current_user)) -> dict:
    """Abierto a cualquier usuario autenticado (documentos compartidos)."""
    rows = await run_in_threadpool(supabase_db.list_documents)
    return {"documents": [_doc_row(r) for r in rows]}


@router.post("/documents/upload", status_code=202)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: AuthUser = Depends(require_admin),
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
            status="processing",
            uploaded_by=user.id,
        )
    )

    # Modo serverless: la ingesta corre INLINE antes de responder (los
    # BackgroundTasks de Vercel mueren tras la respuesta). 200 con el status
    # final; el frontend ya tolera "ready"/"failed" inmediatos (simplemente
    # no arranca el polling).
    if IS_SERVERLESS:
        status = await run_in_threadpool(
            _ingest_uploaded, dest, file_name, doc_id, None
        )
        return JSONResponse(
            status_code=200,
            content={
                "id": doc_id or file_name,
                "file_name": file_name,
                "status": status,
            },
        )

    background_tasks.add_task(_ingest_uploaded, dest, file_name, doc_id, None)
    return {"id": doc_id or file_name, "file_name": file_name, "status": "processing"}


def _processing_rancio(row: dict) -> bool:
    """¿Este `processing` lleva tanto tiempo que ya no puede estar vivo?

    Sin fecha utilizable se responde True: un registro en `processing` sin
    marca de tiempo es indistinguible de uno abandonado, y bloquear el
    reintento para siempre es peor que permitir uno de más (que como mucho
    reingiere algo que ya estaba bien).
    """
    crudo = row.get("ingested_at")
    if not crudo:
        return True
    try:
        marca = datetime.fromisoformat(str(crudo).replace("Z", "+00:00"))
    except ValueError:
        return True
    if marca.tzinfo is None:
        marca = marca.replace(tzinfo=timezone.utc)
    edad = datetime.now(timezone.utc) - marca
    return edad > timedelta(minutes=PROCESSING_STALE_MINUTES)


@router.post("/documents/{file_name}/reindex")
async def reindex_document(
    file_name: str,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(require_admin),
) -> JSONResponse:
    """Reintenta la ingesta de un documento a partir del archivo ya subido.

    Existe porque una ingesta falla casi siempre por algo transitorio -un
    timeout de OpenAI, un corte con Qdrant- y sin esto la única salida era
    borrar el registro y volver a buscar el archivo a mano. `POST /upload`
    responde 409 si el nombre ya existe, así que reintentar por ahí no era
    posible.

    OJO con el límite real, y es el motivo de que este endpoint pueda decir
    que no: el archivo NO se guarda de forma permanente. En local vive en
    data/uploads y el reintento funciona siempre; en Vercel va a /tmp, que es
    efímero, así que solo está si la misma instancia sigue caliente. Cuando no
    está se responde 409 con la cabecera `X-Reindex-Code: file_not_stored`
    para que la interfaz pida la resubida en vez de mentir con un error
    genérico. Va en una cabecera y no en el cuerpo porque el cuerpo de una
    HTTPException es solo `{"detail": ...}`; el frontend la lee sin CORS
    porque `/api/*` es una reescritura al mismo dominio (vercel.json).
    """
    safe_name = _sanitize_file_name(file_name)
    rows = await run_in_threadpool(supabase_db.list_documents)
    row = next((r for r in rows if r.get("file_name") == file_name), None)
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"'{file_name}' no está registrado"
        )
    if row.get("status") == "processing" and not _processing_rancio(row):
        # Reingerir en paralelo duplicaría chunks y pelearía por el registro.
        # Pero solo se rechaza si de verdad SIGUE procesándose: ver
        # PROCESSING_STALE_MINUTES.
        raise HTTPException(
            status_code=409,
            detail=f"'{file_name}' ya se está procesando",
        )

    stored = UPLOADS_DIR / safe_name if safe_name else None
    if stored is None or not stored.is_file():
        raise HTTPException(
            status_code=409,
            detail=(
                f"El archivo de '{file_name}' ya no está en el servidor: "
                f"vuelve a subirlo para reintentar la indexación."
            ),
            headers={"X-Reindex-Code": "file_not_stored"},
        )

    # A 'processing' ANTES de encolar, igual que en upload: así el listado
    # refleja el reintento al instante y el frontend puede hacer polling.
    #
    # Se renueva `ingested_at`, y no es cosmético: es el campo con el que
    # `_processing_rancio` mide la antigüedad. Sin renovarlo, el reintento
    # heredaba la fecha vieja, se consideraba abandonado de inmediato y un
    # segundo reindex concurrente pasaba el guarda: dos ingestas a la vez
    # duplicando fragmentos. La guarda se saltaba a sí misma.
    await run_in_threadpool(
        lambda: supabase_db.upsert_document_status(
            file_name,
            "processing",
            None,
            ingested_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    document_id = row.get("id")

    if IS_SERVERLESS:
        status = await run_in_threadpool(
            _ingest_uploaded, stored, file_name, document_id, None
        )
        return JSONResponse(
            status_code=200,
            content={"file_name": file_name, "status": status},
        )

    background_tasks.add_task(
        _ingest_uploaded, stored, file_name, document_id, None
    )
    return JSONResponse(
        status_code=202,
        content={"file_name": file_name, "status": "processing"},
    )


@router.delete("/documents/{file_name}")
async def delete_document(
    file_name: str, user: AuthUser = Depends(require_admin)
) -> dict:
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
