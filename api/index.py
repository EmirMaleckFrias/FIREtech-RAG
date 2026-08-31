"""Entrypoint serverless para Vercel.

El runtime Python de Vercel detecta la variable módulo-level `app` (ASGI) y
sirve la aplicación FastAPI completa — incluido el streaming SSE de /api/chat.

El código real vive en backend/app/, así que se añade backend/ al sys.path
(relativo a este archivo: en el bundle de Vercel la raíz del repo se preserva,
con api/ y backend/ como hermanos, igual que en local).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# Señal explícita de modo serverless para el backend (Vercel ya define VERCEL=1;
# esto solo garantiza el flag si el entrypoint se usa en otro runtime similar).
os.environ.setdefault("VERCEL", "1")

from app.main import app  # noqa: E402,F401  (Vercel busca `app`)
