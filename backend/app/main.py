"""FastAPI app: CORS + router /api + setup de Qdrant al arrancar.

La autenticación ya no es un middleware global: cada endpoint declara
`Depends(current_user)` (o `require_admin`) — ver app/services/auth.py.
`GET /api/health` es el único endpoint público.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from app.api.documents import router as documents_router
from app.api.routes import router
from app.config import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from app.services.qdrant import ensure_collection

    try:
        await run_in_threadpool(ensure_collection)
    except Exception as exc:
        logger.warning(
            "Qdrant no disponible al arrancar (%s). La app arranca igual; "
            "la búsqueda fallará hasta que Qdrant esté accesible.",
            exc,
        )
    yield


app = FastAPI(title="RAG Productos", lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")
app.include_router(documents_router, prefix="/api")
