"""Autenticación multiusuario con Supabase Auth (SPEC.md § "Autenticación multiusuario").

Sustituye al gate de clave compartida. Cada request a /api/* (excepto
/api/health) debe traer `Authorization: Bearer <access_token de Supabase>`.
El token se valida contra Supabase (`auth.get_user(jwt)`) y el rol se lee de la
tabla `profiles` (migración 004).

Las llamadas del SDK de Supabase son SÍNCRONAS y hacen red: se ejecutan en el
threadpool (`run_in_threadpool`) para no bloquear el event loop.

Caché en memoria token → (AuthUser, expiry) con TTL de 60 s y tope de tamaño,
para no ir a la red en cada request. Es por proceso; al reiniciar se vacía y un
cambio de rol tarda como mucho el TTL en verse.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import Depends, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.config import get_settings

logger = logging.getLogger(__name__)

try:
    from supabase import create_client
except ImportError:  # SDK no instalado → mismo camino que "no configurado"
    create_client = None  # type: ignore[assignment]

# TTL corto: un token revocado o un cambio de rol se propaga en <= 60 s.
CACHE_TTL_SECONDS = 60.0
# Tope duro para que la caché no crezca sin límite (un token por usuario/sesión
# activa; al llegar al tope se purgan los caducados y, si aún hace falta, los
# de expiración más próxima).
CACHE_MAX_ENTRIES = 512

_DEFAULT_ROLE = "vendedor"  # menos privilegio si el perfil aún no existe

# Usuario ficticio para desarrollo local SIN credenciales de Supabase:
# si SUPABASE_URL está vacía no hay a quién validar el token, así que la app
# entera corre con este admin ficticio (mismo comportamiento "sin gate" que
# tenía el flujo dev antes de la autenticación). En producción SUPABASE_URL
# siempre está definida, así que esta rama nunca se activa allí.
DEV_USER_ID = "00000000-0000-0000-0000-000000000000"


class AuthUser(BaseModel):
    id: str
    email: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


DEV_USER = AuthUser(id=DEV_USER_ID, email="dev@local", role="admin")

_cache: dict[str, tuple[AuthUser, float]] = {}
_client: Any = None


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="Sesión no válida o expirada")


def auth_enabled() -> bool:
    """¿Hay Supabase configurado? Si no, se usa el usuario ficticio de dev."""
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_key and create_client)


def _get_client() -> Any:
    """Cliente Supabase lazy singleton (service key: valida cualquier JWT)."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _client


# ---------------------------------------------------------------------------
# Caché token → AuthUser
# ---------------------------------------------------------------------------
def _cache_get(token: str) -> AuthUser | None:
    entry = _cache.get(token)
    if entry is None:
        return None
    user, expiry = entry
    if expiry <= time.monotonic():
        _cache.pop(token, None)
        return None
    return user


def _cache_put(token: str, user: AuthUser) -> None:
    if len(_cache) >= CACHE_MAX_ENTRIES:
        now = time.monotonic()
        for key in [k for k, (_, exp) in _cache.items() if exp <= now]:
            _cache.pop(key, None)
        while len(_cache) >= CACHE_MAX_ENTRIES:
            oldest = min(_cache, key=lambda k: _cache[k][1])
            _cache.pop(oldest, None)
    _cache[token] = (user, time.monotonic() + CACHE_TTL_SECONDS)


def cache_clear() -> None:
    """Vacía la caché (útil en tests o tras cambiar roles a mano)."""
    _cache.clear()


# ---------------------------------------------------------------------------
# Validación del token (síncrona: se llama vía run_in_threadpool)
# ---------------------------------------------------------------------------
def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


def _resolve_token(token: str) -> AuthUser:
    """Valida el JWT contra Supabase y resuelve el rol desde `profiles`.

    Lanza HTTPException(401) si el token no corresponde a ningún usuario.
    """
    client = _get_client()
    resp = client.auth.get_user(token)
    user = getattr(resp, "user", None)
    if user is None or not getattr(user, "id", None):
        raise _unauthorized()

    user_id = str(user.id)
    email = getattr(user, "email", None) or ""
    role = _DEFAULT_ROLE
    try:
        prof = (
            client.table("profiles")
            .select("email, role")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
        rows = prof.data or []
        if rows:
            role = rows[0].get("role") or _DEFAULT_ROLE
            email = rows[0].get("email") or email
        else:
            # El trigger `handle_new_user` crea el perfil en el alta; si falta
            # (usuario creado antes de la migración 004) se asume el rol de
            # menos privilegio en vez de negar el acceso.
            logger.warning("Usuario %s sin fila en profiles; rol por defecto", user_id)
    except Exception:
        logger.exception("No se pudo leer el rol de profiles para %s", user_id)

    return AuthUser(id=user_id, email=email, role=role)


# ---------------------------------------------------------------------------
# Dependencias FastAPI
# ---------------------------------------------------------------------------
async def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    """Usuario del `Authorization: Bearer <jwt>`; 401 si falta o es inválido."""
    if not auth_enabled():
        # Dev local sin credenciales de Supabase: no hay autenticación real.
        return DEV_USER

    token = _bearer_token(authorization)
    if token is None:
        raise _unauthorized()

    cached = _cache_get(token)
    if cached is not None:
        return cached

    try:
        user = await run_in_threadpool(_resolve_token, token)
    except HTTPException:
        raise
    except Exception as exc:
        # Token caducado, firma inválida, proyecto caído... nunca se filtra el
        # detalle técnico al cliente.
        logger.info("Token rechazado: %s", exc)
        raise _unauthorized() from exc

    _cache_put(token, user)
    return user


async def require_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    """Exige rol `admin` (subir y borrar documentos)."""
    if not user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="Solo un administrador puede gestionar los documentos",
        )
    return user
