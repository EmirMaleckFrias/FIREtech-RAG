"""Persistencia de chat en Supabase, con fallback en memoria.

Todas las funciones son síncronas (desde endpoints async se llaman con
fastapi.concurrency.run_in_threadpool). Si SUPABASE_URL o SUPABASE_SERVICE_KEY
están vacías, se usa un fallback en memoria con contratos idénticos (incluido
el aislamiento por usuario; en ese modo `auth.current_user` devuelve siempre el
mismo admin ficticio, así que en la práctica todo pertenece a ese usuario).

Aislamiento por usuario (migración 004): `chat_sessions.user_id` es el dueño de
la conversación. Cada usuario ve y escribe solo en las suyas; las sesiones
históricas (`user_id` nulo) solo las ven los admin. Si una sesión existe pero es
de otro usuario, las funciones lanzan `SessionNotFound` → los endpoints
responden 404 (no 403) para no filtrar su existencia.
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


class SessionNotFound(Exception):
    """La sesión no existe o pertenece a otro usuario.

    Los endpoints la traducen a 404 (nunca 403): un 403 confirmaría que la
    conversación existe, lo que ya sería una fuga de información.
    """


# ---------------------------------------------------------------------------
# Sesiones y mensajes
# ---------------------------------------------------------------------------
def _session_owner_row(session_id: str) -> dict | None:
    """Fila {id, user_id} de la sesión, o None si no existe."""
    client = _get_client()
    if client is not None:
        try:
            resp = (
                client.table("chat_sessions")
                .select("id, user_id")
                .eq("id", session_id)
                .limit(1)
                .execute()
            )
        except Exception:
            # session_id con formato inválido (no-uuid) u otro error de la
            # consulta: se trata como "no existe".
            logger.warning("Consulta de pertenencia fallida para %s", session_id)
            return None
        rows = resp.data or []
        return rows[0] if rows else None
    return _mem_sessions.get(session_id)


def assert_session_access(
    session_id: str, user_id: str | None, is_admin: bool = False
) -> None:
    """Verifica que la sesión exista y sea accesible por el usuario.

    Accesible = es suya, o es una sesión histórica (`user_id` nulo) y el
    usuario es admin. En cualquier otro caso → SessionNotFound.
    """
    row = _session_owner_row(session_id)
    if row is None:
        raise SessionNotFound(session_id)
    owner = row.get("user_id")
    if owner is None:
        if not is_admin:
            raise SessionNotFound(session_id)
        return
    if user_id is None or str(owner) != str(user_id):
        raise SessionNotFound(session_id)


def create_session(title: str, user_id: str | None = None) -> dict:
    """Crea una sesión de chat propiedad de `user_id`.

    Devuelve {"id", "title", "created_at"}.
    """
    client = _get_client()
    if client is not None:
        payload: dict[str, Any] = {"title": title, "user_id": user_id}
        resp = client.table("chat_sessions").insert(payload).execute()
        row = resp.data[0]
        return {"id": row["id"], "title": row["title"], "created_at": row["created_at"]}
    row = {
        "id": str(uuid.uuid4()),
        "title": title,
        "created_at": _now_iso(),
        "user_id": user_id,
    }
    _mem_sessions[row["id"]] = row
    return row


def list_sessions(user_id: str | None = None, is_admin: bool = False) -> list[dict]:
    """Sesiones visibles para el usuario (las suyas; el admin ve además las
    históricas con `user_id` nulo)."""
    client = _get_client()
    if client is not None:
        query = (
            client.table("chat_sessions")
            .select("id, title, created_at")
            .order("created_at", desc=True)
        )
        if is_admin:
            # Propias + históricas sin dueño (migración 004).
            if user_id:
                query = query.or_(f"user_id.eq.{user_id},user_id.is.null")
            else:
                query = query.is_("user_id", "null")
        elif user_id:
            query = query.eq("user_id", user_id)
        else:
            # Sin usuario y sin ser admin: no hay nada que se pueda mostrar.
            return []
        return list(query.execute().data or [])

    def _visible(row: dict) -> bool:
        owner = row.get("user_id")
        if owner is None:
            return is_admin
        return user_id is not None and str(owner) == str(user_id)

    return sorted(
        (
            {"id": r["id"], "title": r["title"], "created_at": r["created_at"]}
            for r in _mem_sessions.values()
            if _visible(r)
        ),
        key=lambda r: r["created_at"],
        reverse=True,
    )


def get_messages(
    session_id: str, user_id: str | None = None, is_admin: bool = False
) -> list[dict]:
    """Mensajes de una sesión, verificando antes su pertenencia."""
    assert_session_access(session_id, user_id, is_admin)
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
    session_id: str,
    role: str,
    content: str,
    sources: list,
    hops: list,
    user_id: str | None = None,
    is_admin: bool = False,
) -> dict:
    """Guarda un mensaje (verificando pertenencia). Devuelve la fila insertada."""
    assert_session_access(session_id, user_id, is_admin)
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


def _message_session_id(message_id: str) -> str | None:
    """session_id del mensaje, o None si el mensaje no existe."""
    client = _get_client()
    if client is not None:
        try:
            resp = (
                client.table("chat_messages")
                .select("session_id")
                .eq("id", message_id)
                .limit(1)
                .execute()
            )
        except Exception:
            logger.warning("Consulta de mensaje fallida para %s", message_id)
            return None
        rows = resp.data or []
        return rows[0].get("session_id") if rows else None
    for session_id, rows in _mem_messages.items():
        if any(r.get("id") == message_id for r in rows):
            return session_id
    return None


def save_feedback(
    message_id: str,
    rating: int,
    comment: str | None,
    user_id: str | None = None,
    is_admin: bool = False,
) -> None:
    """Guarda feedback de un mensaje de una conversación del propio usuario.

    Si el mensaje no existe o su sesión es de otro usuario → SessionNotFound
    (el endpoint responde 404).
    """
    session_id = _message_session_id(message_id)
    if session_id is None:
        raise SessionNotFound(message_id)
    assert_session_access(str(session_id), user_id, is_admin)

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
    uploaded_by: str | None = None,
) -> str | None:
    """Crea/actualiza el registro de un documento. Devuelve su id (o None).

    `uploaded_by` = id del admin que lo subió (migración 004); None para la
    ingesta por lotes (script `ingest.py`, sin usuario).
    """
    payload = {
        "file_name": file_name,
        "sha256": sha256,
        "pages": pages,
        "chunks": chunks,
        "brand": brand,
        "status": status,
        "error": error,
        "environment": get_settings().environment,
        "uploaded_by": uploaded_by,
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
            # Migraciones 002/003/004 (status/error/environment/uploaded_by)
            # aún no aplicadas: registra sin esas columnas para no romper la
            # ingesta existente.
            logger.warning(
                "Upsert de documents con status/error/environment/uploaded_by "
                "falló; reintento sin esas columnas (¿faltan aplicar "
                "002_document_status.sql / 003_document_environment.sql / "
                "004_auth_multiusuario.sql?)."
            )
            payload.pop("status", None)
            payload.pop("error", None)
            payload.pop("environment", None)
            payload.pop("uploaded_by", None)
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
