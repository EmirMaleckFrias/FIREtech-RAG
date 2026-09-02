"""FastAPI app: CORS + router /api + setup de Qdrant al arrancar.

La autenticación ya no es un middleware global: cada endpoint declara
`Depends(current_user)` (o `require_admin`): ver app/services/auth.py.
`GET /api/health` es el único endpoint público.
"""
from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.documents import router as documents_router
from app.api.routes import router
from app.config import get_settings
from app.services.auth import BlockedAccount

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from app.services.qdrant import (
        bm25_backend,
        ensure_collection,
        retrieval_mode,
        server_version,
    )

    try:
        await run_in_threadpool(ensure_collection)
    except Exception as exc:
        logger.warning(
            "Qdrant no disponible al arrancar (%s). La app arranca igual; "
            "la búsqueda fallará hasta que Qdrant esté accesible.",
            exc,
        )
    # La configuración EFECTIVA, no la deseada: el mismo dato que devuelven
    # /api/health y /api/stats, para comparar local y producción desde el log.
    # retrieval_mode() fuerza la carga de BM25 (puede tardar): fuera del loop.
    settings = get_settings()
    retrieval = await run_in_threadpool(retrieval_mode)
    logger.info(
        "Arranque: retrieval=%s bm25_backend=%s qdrant=%s modelo=%s "
        "rerank=%s prompt_version=%s python=%s environment=%s",
        retrieval,
        bm25_backend(),
        await run_in_threadpool(server_version) or "no disponible",
        settings.openai_model,
        settings.rerank_model_resolved,
        settings.prompt_version,
        sys.version.split()[0],
        settings.environment,
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

@app.exception_handler(BlockedAccount)
async def blocked_account_handler(_request: Request, _exc: BlockedAccount) -> JSONResponse:
    """Cuenta con el acceso revocado por un administrador.

    El `code` permite al frontend distinguir esto de un 403 por rol y cerrar
    la sesión al instante, sin esperar a que caduque el token.
    """
    return JSONResponse(
        status_code=403,
        content={"detail": "Tu acceso ha sido revocado", "code": "blocked"},
    )


app.include_router(router, prefix="/api")
app.include_router(documents_router, prefix="/api")
