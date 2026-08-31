"""FastAPI app: gate de acceso + CORS + router /api + setup de Qdrant al arrancar."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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


# ---------------------------------------------------------------------------
# Gate de acceso por clave (env APP_ACCESS_KEY).
#
# - Sin APP_ACCESS_KEY (o vacía): no se exige nada — flujo dev local intacto.
# - Con APP_ACCESS_KEY: todo /api/* excepto /api/health exige el header
#   X-App-Key exacto; si falta o no coincide → 401 {"detail": ...}.
# - OPTIONS queda exento: los preflight CORS nunca llevan headers custom.
#
# Registrado ANTES que CORSMiddleware a propósito: en Starlette el último
# middleware añadido es el más externo, así CORS envuelve al gate y los 401
# salen con cabeceras CORS (legibles por el navegador en despliegues
# cross-origin vía CORS_ORIGINS).
# ---------------------------------------------------------------------------
@app.middleware("http")
async def access_gate(request: Request, call_next):
    required = get_settings().app_access_key
    if required and request.method != "OPTIONS":
        path = request.url.path.rstrip("/") or "/"
        if path.startswith("/api") and path != "/api/health":
            if request.headers.get("x-app-key") != required:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Clave de acceso requerida"},
                )
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")
app.include_router(documents_router, prefix="/api")
