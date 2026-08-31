"""Persistencia de chat en Supabase, con fallback en memoria.

Todas las funciones son síncronas (desde endpoints async se llaman con
fastapi.concurrency.run_in_threadpool). Si SUPABASE_URL o SUPABASE_SERVICE_KEY
están vacías, se usa un fallback en memoria con contratos idénticos.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)

try:
    from supabase import create_client
except ImportError:  # SDK no instalado → mismo comportamiento que "no configurado"
    create_client = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Fallback en memoria (dicts módulo-level)
# ---------------------------------------------------------------------------
_mem_sessions: dict[str, dict] = {}
_mem_messages: dict[str, list[dict]] = {}  # session_id -> [rows]
_mem_feedback: list[dict] = []
_mem_documents: dict[str, dict] = {}  # file_name -> row
_mem_runs: dict[str, dict] = {}

_client: Any = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _configured() -> bool:
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_key and create_client)


def _get_client() -> Any:
    """Cliente Supabase lazy singleton; None si no está configurado."""
    global _client
    if not _configured():
        return None
    if _client is None:
        settings = get_settings()
        _client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _client


# Warning único al arrancar (el módulo se importa en el startup de la app).
if not _configured():
    logger.warning("Supabase no configurado: persistencia en memoria")


def db_available() -> bool:
    return _get_client() is not None


# ---------------------------------------------------------------------------
# Sesiones y mensajes
# ---------------------------------------------------------------------------
def create_session(title: str) -> dict:
    """Crea una sesión de chat. Devuelve {"id", "title", "created_at"}."""
    client = _get_client()
    if client is not None:
        resp = client.table("chat_sessions").insert({"title": title}).execute()
        row = resp.data[0]
        return {"id": row["id"], "title": row["title"], "created_at": row["created_at"]}
    row = {"id": str(uuid.uuid4()), "title": title, "created_at": _now_iso()}
    _mem_sessions[row["id"]] = row
    return row


def list_sessions() -> list[dict]:
    client = _get_client()
    if client is not None:
        resp = (
            client.table("chat_sessions")
            .select("id, title, created_at")
            .order("created_at", desc=True)
            .execute()
        )
        return list(resp.data or [])
    return sorted(_mem_sessions.values(), key=lambda r: r["created_at"], reverse=True)


def get_messages(session_id: str) -> list[dict]:
    client = _get_client()
    if client is not None:
        resp = (
            client.table("chat_messages")
            .select("id, role, content, sources, hops, created_at")
            .eq("session_id", session_id)
            .order("created_at", desc=False)
            .execute()
        )
        return list(resp.data or [])
    return list(_mem_messages.get(session_id, []))


def save_message(
    session_id: str, role: str, content: str, sources: list, hops: list
) -> dict:
    """Guarda un mensaje. Devuelve la fila insertada (con id)."""
    client = _get_client()
    if client is not None:
        resp = (
            client.table("chat_messages")
            .insert(
                {
                    "session_id": session_id,
                    "role": role,
                    "content": content,
                    "sources": sources,
                    "hops": hops,
                }
            )
            .execute()
        )
        return resp.data[0]
    row = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "role": role,
        "content": content,
        "sources": sources,
        "hops": hops,
        "created_at": _now_iso(),
    }
    _mem_messages.setdefault(session_id, []).append(row)
    return row


def save_feedback(message_id: str, rating: int, comment: str | None) -> None:
    client = _get_client()
    if client is not None:
        client.table("message_feedback").insert(
            {"message_id": message_id, "rating": rating, "comment": comment}
        ).execute()
        return
    _mem_feedback.append(
        {
            "id": str(uuid.uuid4()),
            "message_id": message_id,
            "rating": rating,
            "comment": comment,
            "created_at": _now_iso(),
        }
    )


# ---------------------------------------------------------------------------
# Registro de ingesta
# ---------------------------------------------------------------------------
def register_document(
    file_name: str,
    sha256: str,
    pages: int,
    chunks: int,
    brand: str,
    status: str = "ready",
    error: str | None = None,
) -> str | None:
    """Crea/actualiza el registro de un documento. Devuelve su id (o None)."""
    payload = {
        "file_name": file_name,
        "sha256": sha256,
        "pages": pages,
        "chunks": chunks,
        "brand": brand,
        "status": status,
        "error": error,
        "environment": get_settings().environment,
        "ingested_at": _now_iso(),
    }
    client = _get_client()
    if client is not None:
        try:
            resp = (
                client.table("documents")
                .upsert(payload, on_conflict="file_name")
                .execute()
            )
        except Exception:
            # Migraciones 002/003 (status/error/environment) aún no aplicadas:
            # registra sin esas columnas para no romper la ingesta existente.
            logger.warning(
                "Upsert de documents con status/error/environment falló; "
                "reintento sin esas columnas (¿faltan aplicar "
                "002_document_status.sql / 003_document_environment.sql?)."
            )
            payload.pop("status", None)
            payload.pop("error", None)
            payload.pop("environment", None)
            resp = (
                client.table("documents")
                .upsert(payload, on_conflict="file_name")
                .execute()
            )
        rows = resp.data or []
        return rows[0].get("id") if rows else None
    existing = _mem_documents.get(file_name)
    payload["id"] = existing["id"] if existing else str(uuid.uuid4())
    _mem_documents[file_name] = payload
    return payload["id"]


def list_documents() -> list[dict]:
    """Filas de `documents` del entorno actual (más antiguas primero).

    Prod y local comparten la tabla pero tienen Qdrants distintos: cada
    entorno solo ve/gestiona sus propias filas (columna `environment`).
    """
    client = _get_client()
    if client is not None:
        resp = (
            client.table("documents")
            .select("*")
            .eq("environment", get_settings().environment)
            .order("ingested_at", desc=False)
            .execute()
        )
        return list(resp.data or [])
    return sorted(
        (dict(r) for r in _mem_documents.values()),
        key=lambda r: r.get("ingested_at") or "",
    )


def upsert_document_status(
    file_name: str, status: str, error: str | None = None, **fields: Any
) -> bool:
    """Actualiza status/error (y campos extra: pages, chunks, ...) de un doc.

    NUNCA crea una fila nueva: si el registro no existe (p. ej. fue borrado
    por DELETE /documents mientras se procesaba), devuelve False sin crear
    nada — recrearlo "resucitaría" un documento que el usuario borró.
    Devuelve True solo si el update tocó una fila existente.
    """
    payload: dict[str, Any] = {"status": status, "error": error, **fields}
    client = _get_client()
    if client is not None:
        try:
            resp = (
                client.table("documents")
                .update(payload)
                .eq("file_name", file_name)
                .eq("environment", get_settings().environment)
                .execute()
            )
            return bool(resp.data or [])
        except Exception as exc:
            logger.warning(
                "No se pudo actualizar el status de '%s' a '%s': %s "
                "(¿faltan aplicar 002_document_status.sql / "
                "003_document_environment.sql?)",
                file_name, status, exc,
            )
            return False
    row = _mem_documents.get(file_name)
    if row is None:
        return False
    row.update(payload)
    return True


def delete_document(file_name: str) -> None:
    """Borra el registro de un documento (no toca Qdrant ni el archivo)."""
    client = _get_client()
    if client is not None:
        (
            client.table("documents")
            .delete()
            .eq("file_name", file_name)
            .eq("environment", get_settings().environment)
            .execute()
        )
        return
    _mem_documents.pop(file_name, None)


def start_run() -> str | None:
    """Registra el inicio de una ingesta. Devuelve el id del run (o None si falla)."""
    client = _get_client()
    if client is not None:
        try:
            resp = (
                client.table("ingestion_runs")
                .insert({"started_at": _now_iso(), "status": "running"})
                .execute()
            )
            return resp.data[0]["id"]
        except Exception as exc:
            logger.warning("No se pudo registrar el ingestion_run: %s", exc)
            return None
    run_id = str(uuid.uuid4())
    _mem_runs[run_id] = {
        "id": run_id,
        "started_at": _now_iso(),
        "finished_at": None,
        "status": "running",
        "stats": None,
        "error": None,
    }
    return run_id


def finish_run(run_id: str | None, status: str, stats: dict, error: str | None = None) -> None:
    if not run_id:
        return
    payload = {
        "finished_at": _now_iso(),
        "status": status,
        "stats": stats,
        "error": error,
    }
    client = _get_client()
    if client is not None:
        try:
            client.table("ingestion_runs").update(payload).eq("id", run_id).execute()
        except Exception as exc:
            logger.warning("No se pudo cerrar el ingestion_run %s: %s", run_id, exc)
        return
    if run_id in _mem_runs:
        _mem_runs[run_id].update(payload)
