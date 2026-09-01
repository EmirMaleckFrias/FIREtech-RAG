"""Endpoints REST + SSE del backend (contrato SPEC.md, sección "API Backend")."""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.config import get_settings
from app.models import SearchFilters
from app.services import supabase_db
from app.services.agent import run_agent
from app.services.auth import AuthUser, current_user, require_admin
from app.services.qdrant import (
    collection_count,
    hybrid_search,
    index_inventory,
    retrieval_mode,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_TITLE_LEN = 60
_SESSION_404 = "Conversación no encontrada"
# Mensajes de contexto que viajan con cada pregunta (8 = 4 turnos).
_HISTORY_MAX_MESSAGES = 8


def _json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def _save_partial_message(
    session_id: str,
    content: str,
    sources: list,
    hops: list,
    user_id: str,
    is_admin: bool,
) -> None:
    """save_message best-effort para el guardado fire-and-forget tras un abort."""
    try:
        supabase_db.save_message(
            session_id, "assistant", content, sources, hops, user_id, is_admin
        )
    except Exception:
        logger.exception(
            "No se pudo guardar la respuesta parcial (session %s)", session_id
        )


# ---------------------------------------------------------------------------
# Modelos de request
# ---------------------------------------------------------------------------
class SearchRequest(BaseModel):
    query: str
    top_k: int = Field(8, ge=1, le=100)
    brand: str | None = None
    category: str | None = None


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str


class FeedbackRequest(BaseModel):
    message_id: uuid.UUID  # pydantic valida → 422 si no es UUID
    rating: Literal[1, -1]
    comment: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/health")
async def health() -> dict:
    """Público (sin token): lo usa el frontend antes de autenticarse."""
    from app.api.documents import UPLOAD_LIMIT_MB

    count = await run_in_threadpool(collection_count)
    return {
        "status": "ok",
        "qdrant": count is not None,
        "collection_points": count if count is not None else 0,
        "upload_limit_mb": UPLOAD_LIMIT_MB,
        "retrieval": retrieval_mode(),
    }


@router.get("/me")
async def me(user: AuthUser = Depends(current_user)) -> dict:
    return {"id": user.id, "email": user.email, "role": user.role}


class UserUpdate(BaseModel):
    """Cambio de rol y/o de estado de bloqueo. Ambos campos son opcionales."""

    role: Literal["admin", "vendedor"] | None = None
    blocked: bool | None = None


@router.get("/users")
async def list_users(admin: AuthUser = Depends(require_admin)) -> dict:
    """Cuentas registradas con último acceso y contadores. Solo administradores."""
    rows = await run_in_threadpool(supabase_db.list_users)
    return {"users": rows}


@router.get("/stats")
async def stats(admin: AuthUser = Depends(require_admin)) -> dict:
    """Estado del índice, actividad agregada y configuración. Solo administradores.

    Nunca devuelve contenido de conversaciones: las cifras de actividad son
    agregados, no texto de nadie.
    """
    from app.api.documents import UPLOAD_LIMIT_MB  # import local: evita ciclo

    settings = get_settings()
    try:
        inv = await asyncio.to_thread(index_inventory)
        index = {
            "products": inv["productos"],
            "chunks": inv["total_chunks"],
            "files": len(inv["archivos"]),
            "suppliers": [s["valor"] for s in inv["suplidores"]],
        }
    except Exception as exc:
        logger.warning("Inventario del índice no disponible: %s", exc)
        index = {"products": 0, "chunks": 0, "files": 0, "suppliers": []}

    activity = await run_in_threadpool(supabase_db.activity_stats)
    return {
        "index": index,
        "activity": activity,
        "config": {
            "model": settings.openai_model,
            "embedding_model": settings.embedding_model,
            "max_hops": settings.max_hops,
            "upload_limit_mb": UPLOAD_LIMIT_MB,
            "retrieval": retrieval_mode(),
        },
    }


@router.patch("/users/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    admin: AuthUser = Depends(require_admin),
) -> dict:
    """Promueve, degrada, bloquea o desbloquea otra cuenta. Solo administradores.

    Nadie puede cambiarse a sí mismo: evita que el último administrador se
    degrade o se bloquee y deje el sistema sin quien lo gestione.
    """
    if str(user_id) == str(admin.id):
        raise HTTPException(
            status_code=403, detail="No puedes cambiar tu propia cuenta"
        )
    if body.role is None and body.blocked is None:
        raise HTTPException(status_code=400, detail="Nada que cambiar")
    try:
        return await run_in_threadpool(
            supabase_db.update_user, str(user_id), body.role, body.blocked
        )
    except supabase_db.UserNotFound:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: uuid.UUID, admin: AuthUser = Depends(require_admin)
) -> dict:
    """Borra una cuenta y sus conversaciones. Solo administradores."""
    if str(user_id) == str(admin.id):
        raise HTTPException(
            status_code=403, detail="No puedes borrar tu propia cuenta"
        )
    try:
        await run_in_threadpool(supabase_db.delete_user, str(user_id))
    except supabase_db.UserNotFound:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"ok": True}


@router.post("/search")
async def search(
    body: SearchRequest, user: AuthUser = Depends(current_user)
) -> dict:
    filters = SearchFilters(brand=body.brand, category=body.category)
    chunks = await hybrid_search(body.query, filters, body.top_k)
    return {
        "results": [
            {
                "text": ch.text,
                "score": ch.score,
                "source_file": ch.source_file,
                "page": ch.page,
                "brand": ch.brand,
                "category": ch.category,
                "skus": ch.skus,
            }
            for ch in chunks
        ]
    }


@router.post("/chat")
async def chat(
    body: ChatRequest, user: AuthUser = Depends(current_user)
) -> EventSourceResponse:
    """Chat con el agente multi-hop. Respuesta SSE (text/event-stream).

    Eventos: session → (hop | sources | token)* → done, o error ante excepción.
    """
    # La pertenencia de la sesión se verifica ANTES de abrir el stream: así un
    # session_id ajeno devuelve un 404 JSON normal en vez de un 200 con un
    # evento de error dentro del SSE.
    if body.session_id is not None:
        try:
            await run_in_threadpool(
                supabase_db.assert_session_access,
                body.session_id,
                user.id,
                user.is_admin,
            )
        except supabase_db.SessionNotFound:
            raise HTTPException(status_code=404, detail=_SESSION_404)

    async def event_generator():
        # Acumulador de la respuesta parcial: si el cliente aborta a mitad de
        # stream, se persiste lo emitido hasta el momento para que el user
        # message no quede huérfano en el historial (dos "user" seguidos
        # contaminarían el history enviado a OpenAI en el siguiente turno).
        session_id: str | None = body.session_id
        user_saved = False
        assistant_saved = False
        partial_tokens: list[str] = []
        partial_sources: list = []
        partial_hops: list = []
        try:
            # 1. Sesión (crear si session_id es null; título = primeros 60 chars).
            if session_id is None:
                title = body.message.strip()[:_TITLE_LEN]
                session = await run_in_threadpool(
                    supabase_db.create_session, title, user.id
                )
                session_id = session["id"]
            yield {"event": "session", "data": _json({"session_id": session_id})}

            # 2. Historial previo (antes de guardar el mensaje actual).
            rows = await run_in_threadpool(
                supabase_db.get_messages, session_id, user.id, user.is_admin
            )
            history = [
                {"role": r["role"], "content": r["content"]}
                for r in rows
                if r.get("role") in ("user", "assistant") and r.get("content")
            ]
            # Solo los últimos turnos: suficiente para las repreguntas
            # ("y el precio de ese?") sin que una conversación larga
            # arrastre temas viejos a preguntas nuevas ni infle el costo
            # de entrada de cada llamada a OpenAI.
            history = history[-_HISTORY_MAX_MESSAGES:]

            # 3. Guardar el mensaje del usuario.
            await run_in_threadpool(
                supabase_db.save_message,
                session_id,
                "user",
                body.message,
                [],
                [],
                user.id,
                user.is_admin,
            )
            user_saved = True

            # 4. Agente multi-hop con streaming.
            final: dict | None = None
            async for ev in run_agent(body.message, history):
                if ev.type == "final":
                    final = ev.data
                else:  # hop | sources | token → passthrough al contrato SSE
                    if ev.type == "token":
                        partial_tokens.append(ev.data.get("text") or "")
                    elif ev.type == "sources":
                        partial_sources = ev.data.get("sources") or []
                    elif ev.type == "hop":
                        partial_hops.append(ev.data)
                    yield {"event": ev.type, "data": _json(ev.data)}

            if final is None:
                raise RuntimeError("El agente terminó sin producir respuesta final")

            # 5. Guardar mensaje assistant (con sources y hops) y emitir done.
            # En su propio try/except: si el guardado falla tras streamear la
            # respuesta completa, NO se emite error (el usuario ya la vio);
            # se emite done con message_id vacío.
            message_id = ""
            try:
                saved = await run_in_threadpool(
                    supabase_db.save_message,
                    session_id,
                    "assistant",
                    final["content"],
                    final["sources"],
                    final["hops"],
                    user.id,
                    user.is_admin,
                )
                assistant_saved = True
                message_id = saved["id"]
            except Exception:
                logger.exception(
                    "No se pudo guardar el mensaje assistant (session %s); "
                    "la respuesta ya fue streameada, se emite done sin id.",
                    session_id,
                )
            yield {"event": "done", "data": _json({"message_id": message_id})}
        except asyncio.CancelledError:
            # El cliente abortó el stream. Si el user message ya se guardó y el
            # assistant no, persistimos la respuesta parcial en un hilo
            # fire-and-forget (la cancelación no espera awaits).
            if user_saved and not assistant_saved and session_id:
                content = "".join(partial_tokens).strip()
                if content:
                    content += "\n\n*(Respuesta interrumpida por el usuario)*"
                else:
                    content = "*(Respuesta interrumpida)*"
                logger.info(
                    "Stream de /api/chat cancelado (session %s): se guarda la "
                    "respuesta parcial (%d chars).",
                    session_id, len(content),
                )
                asyncio.get_running_loop().run_in_executor(
                    None,
                    functools.partial(
                        _save_partial_message,
                        session_id,
                        content,
                        partial_sources,
                        partial_hops,
                        user.id,
                        user.is_admin,
                    ),
                )
            raise
        except Exception as exc:
            logger.exception("Error en /api/chat")
            # RuntimeError = mensajes nuestros user-friendly (p. ej. falta
            # OPENAI_API_KEY). Cualquier otra excepción no expone detalles
            # técnicos (SQL, stack traces) al cliente.
            if isinstance(exc, RuntimeError):
                detail = str(exc)
            else:
                detail = (
                    "Ocurrió un error procesando tu solicitud. "
                    "Inténtalo de nuevo."
                )
            yield {"event": "error", "data": _json({"detail": detail})}

    return EventSourceResponse(event_generator())


@router.get("/sessions")
async def sessions(user: AuthUser = Depends(current_user)) -> dict:
    rows = await run_in_threadpool(
        supabase_db.list_sessions, user.id, user.is_admin
    )
    return {
        "sessions": [
            {"id": r["id"], "title": r["title"], "created_at": r["created_at"]}
            for r in rows
        ]
    }


@router.get("/sessions/{session_id}/messages")
async def session_messages(
    session_id: uuid.UUID, user: AuthUser = Depends(current_user)
) -> dict:
    try:
        rows = await run_in_threadpool(
            supabase_db.get_messages, str(session_id), user.id, user.is_admin
        )
    except supabase_db.SessionNotFound:
        # 404 también cuando la sesión existe pero es de otro usuario.
        raise HTTPException(status_code=404, detail=_SESSION_404)
    return {
        "messages": [
            {
                "id": r["id"],
                "role": r["role"],
                "content": r["content"],
                "sources": r.get("sources") or [],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


@router.post("/feedback")
async def feedback(
    body: FeedbackRequest, user: AuthUser = Depends(current_user)
) -> dict:
    try:
        await run_in_threadpool(
            supabase_db.save_feedback,
            str(body.message_id),
            body.rating,
            body.comment,
            user.id,
            user.is_admin,
        )
    except supabase_db.SessionNotFound:
        # El mensaje no existe o su conversación es de otro usuario: 404 en
        # ambos casos (no se revela cuál).
        raise HTTPException(status_code=404, detail="message_id no encontrado")
    except Exception:
        # Violación de FK: el message_id (UUID válido) no existe en chat_messages.
        logger.exception("save_feedback falló para message_id=%s", body.message_id)
        raise HTTPException(status_code=404, detail="message_id no encontrado")
    return {"ok": True}
