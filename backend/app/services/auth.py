"""Autenticación multiusuario con Supabase Auth (SPEC.md § "Autenticación multiusuario").

Sustituye al gate de clave compartida. Cada request a /api/* (excepto
/api/health) debe traer `Authorization: Bearer <access_token de Supabase>`.
El token se valida contra Supabase (`auth.get_user(jwt)`) y el rol se lee de la
tabla `profiles` (migración 004).

Las llamadas del SDK de Supabase son SÍNCRONAS y hacen red: se ejecutan en el
threadpool (`run_in_threadpool`) para no bloquear el event loop.

Caché en memoria token → (AuthUser, expiry) con TTL de CACHE_TTL_SECONDS y
tope de tamaño,
para no ir a la red en cada request. Es por proceso; al reiniciar se vacía y un
cambio de rol tarda como mucho el TTL en verse.
"""
from __future__ import annotations

import base64
import binascii
import json
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

# TTL corto: es lo que tarda en surtir efecto un bloqueo o un cambio de rol,
# porque mientras la entrada siga viva no se vuelve a preguntar a Supabase.
# 15 s equilibra las dos cosas: un usuario que conversa reaprovecha la caché en
# ráfagas, y un administrador que revoca un acceso lo ve aplicado en segundos.
CACHE_TTL_SECONDS = 15.0
# Tope duro para que la caché no crezca sin límite (un token por usuario/sesión
# activa; al llegar al tope se purgan los caducados y, si aún hace falta, los
# de expiración más próxima).
CACHE_MAX_ENTRIES = 512
# Ventana en la que una entrada vencida sigue sirviendo SI Supabase no
# responde. Nunca se usa cuando la verificación funciona.
STALE_GRACE_SECONDS = 1800.0

# Identificador almacenado. Sigue siendo "vendedor" hasta que se aplique
# 010_rol_lector.sql; la UI ya lo muestra como "Lector".
_DEFAULT_ROLE = "vendedor"  # menos privilegio si el perfil aún no existe

# Usuario ficticio para desarrollo local SIN credenciales de Supabase:
# si SUPABASE_URL está vacía no hay a quién validar el token, así que la app
# entera corre con este admin ficticio (mismo comportamiento "sin gate" que
# tenía el flujo dev antes de la autenticación). En producción SUPABASE_URL
# siempre está definida, así que esta rama nunca se activa allí.
DEV_USER_ID = "00000000-0000-0000-0000-000000000000"


class BlockedAccount(Exception):
    """La cuenta existe pero un administrador le revocó el acceso.

    Se maneja en `main.py` para devolver el cuerpo exacto que el frontend
    reconoce y usar como señal de cierre de sesión inmediato, aunque el token
    del usuario siga siendo criptográficamente válido.
    """


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


def _unavailable() -> HTTPException:
    """503, no 401: el token puede ser perfectamente válido y el problema es
    nuestro (Supabase lento o caído, red). Un 401 aquí expulsaría al usuario."""
    return HTTPException(
        status_code=503,
        detail="No se pudo verificar la sesión en este momento. Inténtalo de nuevo.",
    )


def _is_auth_error(exc: Exception) -> bool:
    """¿El fallo dice que el TOKEN es malo, o que la verificación no se pudo hacer?

    Solo un rechazo explícito de la API de autenticación (4xx) significa token
    inválido. Timeouts, DNS, conexión rehusada o un 5xx de Supabase NO son
    culpa del usuario y no deben cerrarle la sesión.
    """
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if isinstance(status, int):
        return 400 <= status < 500
    # gotrue lanza AuthApiError/AuthInvalidJwtError para credenciales malas.
    name = type(exc).__name__
    return name.startswith("Auth") and "Retry" not in name


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
def _cache_get(token: str, allow_stale: bool = False) -> AuthUser | None:
    """Usuario cacheado para el token.

    `allow_stale=True` acepta entradas ya vencidas dentro de la ventana de
    gracia: solo se usa cuando Supabase no responde, para no cerrar sesiones
    válidas por un fallo de red.
    """
    entry = _cache.get(token)
    if entry is None:
        return None
    user, expiry = entry
    now = time.monotonic()
    if expiry > now:
        return user
    if allow_stale and now - expiry <= STALE_GRACE_SECONDS:
        return user
    _cache.pop(token, None)
    return None


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


def _unverified_subject(token: str) -> str | None:
    """`sub` del JWT SIN verificar la firma.

    Solo se usa para NEGAR el acceso con un mensaje preciso cuando Supabase ya
    rechazó el token: falsear un `sub` aquí únicamente sirve para que a uno
    mismo lo bloqueen, nunca para entrar.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError, binascii.Error, UnicodeDecodeError):
        return None
    sub = data.get("sub") if isinstance(data, dict) else None
    return str(sub) if sub else None


def _subject_is_blocked(token: str) -> bool:
    """¿El token pertenece a una cuenta con el acceso revocado?

    Supabase invalida el token en cuanto se banea la cuenta, así que sin esto
    el usuario vería un 401 genérico y la app lo dejaría dentro con todo
    fallando, en vez de cerrarle la sesión con un motivo claro.
    """
    user_id = _unverified_subject(token)
    if user_id is None:
        return False
    try:
        rows = (
            _get_client()
            .table("profiles")
            .select("blocked")
            .eq("id", user_id)
            .limit(1)
            .execute()
            .data
            or []
        )
    except Exception:
        return False
    return bool(rows and rows[0].get("blocked"))


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
            .select("email, role, blocked")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
        rows = prof.data or []
        if rows:
            if rows[0].get("blocked"):
                # Acceso revocado: se corta aquí, sin cachear nada.
                raise BlockedAccount(user_id)
            role = rows[0].get("role") or _DEFAULT_ROLE
            email = rows[0].get("email") or email
        else:
            # El trigger `handle_new_user` crea el perfil en el alta; si falta
            # (usuario creado antes de la migración 004) se asume el rol de
            # menos privilegio en vez de negar el acceso.
            logger.warning("Usuario %s sin fila en profiles; rol por defecto", user_id)
    except BlockedAccount:
        raise
    except Exception as exc:
        # 503, NO un usuario válido con el rol por defecto. Antes esto seguía
        # adelante y tenía dos consecuencias malas:
        #
        # 1. `blocked` nunca se evaluaba, así que una cuenta revocada entraba
        #    en cuanto la lectura de `profiles` fallara. El bloqueo se aplica
        #    ahí, y `supabase_db.update_user` acepta que el ban en Supabase
        #    Auth falle confiando en que "el backend lo respeta": si el
        #    backend tampoco lo mira, no lo respeta nadie.
        # 2. Un admin quedaba degradado al rol de consulta Y CACHEADO, así que
        #    durante la vida de la caché recibía 403 al subir o borrar
        #    documentos sin ninguna señal de que el fallo era del servidor.
        #
        # El rol por defecto sigue siendo correcto para "no hay fila" (rama
        # `else` de arriba), que es un caso distinto de "no pude preguntar".
        logger.exception("No se pudo leer el rol de profiles para %s", user_id)
        raise _unavailable() from exc

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
    except (HTTPException, BlockedAccount):
        # Una cuenta bloqueada nunca se sirve desde la caché ni se degrada a
        # 503: el corte de acceso debe ser inmediato.
        _cache.pop(token, None)
        raise
    except Exception as exc:
        if _is_auth_error(exc):
            # El token de verdad no vale (caducado, revocado, firma inválida).
            # Si el rechazo viene de un baneo, se dice con precisión para que
            # el frontend cierre la sesión con su motivo.
            if await run_in_threadpool(_subject_is_blocked, token):
                raise BlockedAccount(token) from exc
            logger.info("Token rechazado: %s", exc)
            raise _unauthorized() from exc
        # Fallo de infraestructura. Si vimos este token hace poco, lo servimos
        # aunque su TTL haya vencido: más vale una sesión que sigue viva que
        # echar al usuario por un tropiezo de red.
        stale = _cache_get(token, allow_stale=True)
        if stale is not None:
            logger.warning(
                "Verificación no disponible (%s); se usa la sesión en caché.", exc
            )
            return stale
        logger.warning("Verificación de sesión no disponible: %s", exc)
        raise _unavailable() from exc

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
