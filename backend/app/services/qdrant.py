"""Cliente Qdrant: setup, filtros y búsqueda híbrida dense + BM25 con RRF.

El camino principal usa BM25 nativo del servidor Qdrant. Así producción no
depende de fastembed/onnxruntime dentro de Vercel. FastEmbed queda disponible
como backend explícito de compatibilidad.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from qdrant_client import QdrantClient, models

from app.config import get_settings
from app.models import Chunk, SearchFilters
from app.services.embeddings import embed_query

logger = logging.getLogger(__name__)

# --- fastembed es opcional: nada debe romper si no está instalado -----------
_make_bm25: Callable[[], Any] | None
try:
    from fastembed import SparseTextEmbedding as _SparseTextEmbedding

    def _make_bm25() -> Any:
        return _SparseTextEmbedding(model_name="Qdrant/bm25")

except Exception:  # ImportError u otros fallos de carga del paquete
    try:
        from fastembed.sparse.bm25 import Bm25 as _Bm25

        def _make_bm25() -> Any:
            return _Bm25(model_name="Qdrant/bm25")

    except Exception:
        _make_bm25 = None
        logger.info(
            "fastembed no disponible: la búsqueda será dense-only (sin BM25)."
        )

_UPSERT_BATCH = 64

# Índices de payload que la colección necesita: los campos por los que se
# filtra. `project_id` y `document_id` son los que sostienen el aislamiento,
# así que sin su índice una búsqueda filtrada sería un escaneo.
PAYLOAD_INDEXES: tuple[tuple[str, models.PayloadSchemaType], ...] = (
    ("project_id", models.PayloadSchemaType.KEYWORD),
    ("document_id", models.PayloadSchemaType.KEYWORD),
    ("document_version", models.PayloadSchemaType.KEYWORD),
    ("document_type", models.PayloadSchemaType.KEYWORD),
    ("language", models.PayloadSchemaType.KEYWORD),
    ("source_file", models.PayloadSchemaType.KEYWORD),
    ("chunk_type", models.PayloadSchemaType.KEYWORD),
)

# Singletons módulo-level, inicializados de forma lazy para que importar este
# módulo no requiera Qdrant corriendo ni descargar el modelo BM25.
_client: QdrantClient | None = None
_bm25_model: Any | None = None
# La colección ya se verificó en ESTE proceso (incluidos sus índices de
# payload). Evita repetir la llamada en cada petición sin volver al error
# de suponer que una colección existente está al día.
_collection_checked = False
_bm25_failed = False
_server_bm25_checked = False
_server_bm25_failed = False


def _configured_bm25_backend() -> str:
    value = get_settings().qdrant_bm25_backend.strip().lower()
    if value not in {"server", "fastembed", "auto", "disabled"}:
        logger.warning("QDRANT_BM25_BACKEND=%r no es válido; se desactiva BM25.", value)
        return "disabled"
    return value


def get_client() -> QdrantClient:
    """Cliente Qdrant singleton (lazy)."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = QdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key or None,
            timeout=30,
            cloud_inference=_configured_bm25_backend() in {"server", "auto"},
        )
    return _client


def _get_bm25() -> Any | None:
    """Modelo BM25 singleton (lazy). None si fastembed no está disponible."""
    global _bm25_model, _bm25_failed
    if _make_bm25 is None or _bm25_failed:
        return None
    if _bm25_model is None:
        try:
            _bm25_model = _make_bm25()
        except Exception as exc:
            _bm25_failed = True
            logger.warning(
                "No se pudo inicializar el modelo BM25 (%s); "
                "se continúa en modo dense-only.",
                exc,
            )
            return None
    return _bm25_model


def ensure_collection() -> None:
    """Crea la colección + índices de payload si no existen (idempotente).

    La colección siempre se crea con ambos vectores nombrados (`dense` y
    `bm25`), haya o no fastembed: el sparse simplemente queda vacío si no se
    puede calcular.

    Sobre una colección que YA existe se reconcilian los índices de payload
    que falten, y esto no es paranoia: antes se volvía aquí de inmediato
    suponiendo que una colección existente ya tenía todos sus índices "porque
    se crean junto con ella". Esa suposición se rompe en cuanto alguien añade
    un campo a PAYLOAD_INDEXES, que es exactamente lo que pasó con
    `document_version`: la colección de producción se quedó con 6 de los 7
    índices, y como Qdrant Cloud viene con strict mode (`strict_mode_config`:
    `unindexed_filtering_update: false`), filtrar por una clave sin índice no
    devuelve resultados de más, devuelve un 400. El síntoma que llegaba al
    usuario era que cada subida terminaba en "Error" sin explicación.

    El coste sigue siendo UNA llamada HTTP en el camino feliz: se pide
    `get_collection` (que además trae el payload_schema) en vez de
    `collection_exists`, y el resultado se recuerda por proceso.
    """
    global _collection_checked
    if _collection_checked:
        return

    settings = get_settings()
    client = get_client()
    name = settings.qdrant_collection

    info = None
    try:
        info = client.get_collection(collection_name=name)
    except Exception:
        # Puede ser "no existe" (lo normal) o un fallo real: se distingue
        # preguntando, y solo en este camino se paga la segunda llamada.
        if client.collection_exists(collection_name=name):
            raise

    if info is not None:
        existentes = set((info.payload_schema or {}).keys())
        faltan = [(f, sch) for f, sch in PAYLOAD_INDEXES if f not in existentes]
        for field, schema in faltan:
            logger.info(
                "Falta el índice de payload '%s' en '%s': se crea ahora.",
                field, name,
            )
            client.create_payload_index(
                collection_name=name, field_name=field, field_schema=schema
            )
        _collection_checked = True
        return

    client.create_collection(
        collection_name=name,
        vectors_config={
            "dense": models.VectorParams(
                size=settings.embedding_dims,
                distance=models.Distance.COSINE,
            ),
        },
        sparse_vectors_config={
            "bm25": models.SparseVectorParams(modifier=models.Modifier.IDF),
        },
    )
    logger.info("Colección '%s' creada.", name)

    for field, schema in PAYLOAD_INDEXES:
        try:
            client.create_payload_index(
                collection_name=name, field_name=field, field_schema=schema
            )
        except Exception:
            # El índice ya existe (o versión de Qdrant que no lo tolera): ok.
            logger.debug("Índice de payload '%s' ya existente.", field)

    _collection_checked = True


def _server_bm25_available() -> bool:
    """Comprueba una vez que el cluster acepta inferencia BM25 nativa."""
    global _server_bm25_checked, _server_bm25_failed
    if _server_bm25_checked:
        return not _server_bm25_failed
    _server_bm25_checked = True
    settings = get_settings()
    try:
        get_client().query_points(
            collection_name=settings.qdrant_collection,
            query=models.Document(text="bm25 health probe", model="qdrant/bm25"),
            using="bm25",
            limit=1,
            with_payload=False,
        )
        return True
    except Exception as exc:
        _server_bm25_failed = True
        logger.warning("BM25 nativo de Qdrant no disponible (%s).", exc)
        return False


def _active_bm25_backend() -> str:
    configured = _configured_bm25_backend()
    if configured == "disabled":
        return "none"
    if configured in {"server", "auto"} and _server_bm25_available():
        return "qdrant-server"
    if configured in {"fastembed", "auto"} and _get_bm25() is not None:
        return "fastembed"
    return "none"


def retrieval_mode() -> str:
    """Modo efectivo, después de verificar el backend sparse configurado."""
    return "hybrid" if _active_bm25_backend() != "none" else "dense-only"


def bm25_backend() -> str:
    """Implementación sparse efectiva: qdrant-server, fastembed o none."""
    return _active_bm25_backend()


_server_version: str | None = None


def server_version() -> str | None:
    """Versión del servidor Qdrant (`GET /` via `client.info()`), o None si
    no responde. Se cachea en un global tras la primera respuesta válida:
    la versión no cambia mientras vive el proceso. Nunca lanza."""
    global _server_version
    if _server_version is None:
        try:
            _server_version = get_client().info().version or None
        except Exception as exc:
            logger.debug("Qdrant no responde a info(): %s", exc)
            return None
    return _server_version


def collection_count() -> int | None:
    """Cantidad de puntos en la colección, o None si Qdrant no responde."""
    settings = get_settings()
    try:
        return get_client().count(
            collection_name=settings.qdrant_collection, exact=True
        ).count
    except Exception as exc:
        logger.warning("Qdrant no responde al count: %s", exc)
        return None


def _sparse_vectors_for(
    texts: list[str],
) -> list[models.SparseVector | models.Document | None]:
    """Representaciones BM25 locales o documentos para inferencia en Qdrant."""
    backend = _active_bm25_backend()
    if backend == "qdrant-server":
        return [models.Document(text=text, model="qdrant/bm25") for text in texts]
    if backend != "fastembed":
        return [None] * len(texts)
    model = _get_bm25()
    if model is None:
        return [None] * len(texts)
    try:
        return [
            models.SparseVector(
                indices=list(emb.indices), values=list(emb.values)
            )
            for emb in model.embed(texts)
        ]
    except Exception as exc:
        logger.warning(
            "Fallo calculando embeddings BM25 (%s); se upsertea sin sparse.", exc
        )
        return [None] * len(texts)


# Lo único que se guarda en el payload. Es una lista blanca a propósito: lo
# que el parser no ponga aquí no llega nunca a Qdrant, así que un campo nuevo
# en la ingesta no se filtra al índice por accidente.
_PAYLOAD_KEYS = (
    "text",
    "source_file",
    "page",
    "project_id",
    "document_id",
    "document_version",
    "section",
    "language",
    "document_type",
    "source_pages",
    "metadata",
    "chunk_type",
    "title",
    "citation",
    "doi",
)


def upsert_chunks(chunks: list[dict]) -> int:
    """Upserta chunks (con vector denso precalculado en `chunk["dense"]`).

    El vector BM25 se calcula en Qdrant o con FastEmbed, según configuración.
    Si BM25 está habilitado y la ingesta sparse falla, la operación falla:
    nunca se degrada silenciosamente un documento nuevo a dense-only.
    """
    if not chunks:
        return 0
    settings = get_settings()
    client = get_client()

    sparse = _sparse_vectors_for([c.get("text", "") for c in chunks])

    points: list[models.PointStruct] = []
    for chunk, sv in zip(chunks, sparse):
        vector: dict[str, Any] = {"dense": chunk["dense"]}
        if isinstance(sv, models.Document) or (
            sv is not None and len(sv.indices) > 0
        ):
            vector["bm25"] = sv
        payload = {key: chunk.get(key) for key in _PAYLOAD_KEYS}
        points.append(
            models.PointStruct(id=chunk["id"], vector=vector, payload=payload)
        )

    for i in range(0, len(points), _UPSERT_BATCH):
        client.upsert(
            collection_name=settings.qdrant_collection,
            points=points[i : i + _UPSERT_BATCH],
            wait=True,
        )
    return len(points)


def delete_by_file(source_file: str) -> None:
    """Borra todos los puntos provenientes de un archivo fuente."""
    settings = get_settings()
    get_client().delete(
        collection_name=settings.qdrant_collection,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="source_file",
                        match=models.MatchValue(value=source_file),
                    )
                ]
            )
        ),
        wait=True,
    )


def delete_old_versions(source_file: str, keep_version: str) -> None:
    """Borra versiones anteriores después de insertar la nueva.

    El orden es deliberado: primero se confirma el upsert de la nueva versión
    y solo entonces se retira la antigua. Un fallo de embeddings o Qdrant no
    deja al documento sin ninguna versión consultable.
    """
    settings = get_settings()
    get_client().delete(
        collection_name=settings.qdrant_collection,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="source_file",
                        match=models.MatchValue(value=source_file),
                    )
                ],
                must_not=[
                    models.FieldCondition(
                        key="document_version",
                        match=models.MatchValue(value=keep_version),
                    )
                ],
            )
        ),
        wait=True,
    )


def _build_filter(filters: SearchFilters) -> models.Filter | None:
    must: list[models.FieldCondition] = []
    if filters.project_id:
        must.append(
            models.FieldCondition(
                key="project_id", match=models.MatchValue(value=filters.project_id)
            )
        )
    if filters.document_id:
        must.append(
            models.FieldCondition(
                key="document_id", match=models.MatchValue(value=filters.document_id)
            )
        )
    if filters.document_type:
        must.append(
            models.FieldCondition(
                key="document_type", match=models.MatchValue(value=filters.document_type)
            )
        )
    if filters.language:
        must.append(
            models.FieldCondition(
                key="language", match=models.MatchValue(value=filters.language)
            )
        )
    return models.Filter(must=must) if must else None


def index_inventory() -> dict:
    """Inventario EN VIVO del índice: totales y valores reales de cada campo.

    Todo sale de facets y counts de Qdrant en el momento de la llamada, así que
    refleja los documentos subidos hace un segundo y no hay nada hardcodeado.
    """
    settings = get_settings()
    client = get_client()
    name = settings.qdrant_collection

    def _facet(key: str) -> list[dict]:
        res = client.facet(collection_name=name, key=key, limit=200, exact=True)
        # count > 0: el facet devuelve "lápidas" de valores cuyos puntos ya
        # fueron borrados (documentos eliminados) con conteo cero.
        return [
            {"valor": str(h.value), "chunks": h.count}
            for h in res.hits
            if str(h.value).strip() and h.count > 0
        ]

    return {
        "total_chunks": client.count(collection_name=name, exact=True).count,
        "archivos": _facet("source_file"),
        "tipos": _facet("document_type"),
        "idiomas": _facet("language"),
        "proyectos": _facet("project_id"),
    }


def _point_to_chunk(point: Any) -> Chunk:
    payload = point.payload or {}
    return Chunk(
        id=str(point.id),
        text=payload.get("text") or "",
        source_file=payload.get("source_file") or "",
        page=int(payload.get("page") or 0),
        project_id=payload.get("project_id"),
        document_id=payload.get("document_id"),
        section=payload.get("section") or "",
        language=payload.get("language") or "",
        document_type=payload.get("document_type") or "",
        source_pages=payload.get("source_pages") or [],
        metadata=payload.get("metadata") or {},
        chunk_type=payload.get("chunk_type") or "text",
        title=payload.get("title") or "",
        citation=payload.get("citation") or "",
        doi=payload.get("doi") or "",
        # Los Records de scroll() no traen score (solo los de query_points).
        score=float(getattr(point, "score", 0.0) or 0.0),
    )


async def hybrid_search(
    query: str, filters: SearchFilters, top_k: int
) -> list[Chunk]:
    """Búsqueda híbrida: dense + BM25 fusionados con RRF (Query API de Qdrant).

    El embedding denso de la query es async (`embed_query`); las llamadas al
    cliente síncrono de Qdrant se ejecutan en un thread con
    `asyncio.to_thread`. Si el backend sparse falla durante una consulta, se
    registra la degradación y esa consulta se reintenta dense-only.
    """
    settings = get_settings()
    dense = await embed_query(query)
    qfilter = _build_filter(filters)

    def _search() -> list[Any]:
        client = get_client()
        name = settings.qdrant_collection
        prefetch_limit = max(top_k * 2, 20)

        backend = _active_bm25_backend()
        sparse_query: models.SparseVector | models.Document | None = None
        if backend == "qdrant-server":
            sparse_query = models.Document(text=query, model="qdrant/bm25")
        elif backend == "fastembed":
            model = _get_bm25()
            try:
                emb = next(iter(model.query_embed(query))) if model is not None else None
                if emb is not None and len(emb.indices) > 0:
                    sparse_query = models.SparseVector(
                        indices=list(emb.indices), values=list(emb.values)
                    )
            except Exception as exc:
                logger.warning(
                    "Fallo el embedding BM25 de la query (%s); dense-only.", exc
                )

        if sparse_query is None:
            response = client.query_points(
                collection_name=name,
                query=dense,
                using="dense",
                query_filter=qfilter,
                limit=top_k,
                with_payload=True,
            )
            return response.points

        try:
            response = client.query_points(
                collection_name=name,
                prefetch=[
                    models.Prefetch(
                        query=dense,
                        using="dense",
                        filter=qfilter,
                        limit=prefetch_limit,
                    ),
                    models.Prefetch(
                        query=sparse_query,
                        using="bm25",
                        filter=qfilter,
                        limit=prefetch_limit,
                    ),
                ],
                query=models.FusionQuery(fusion=models.Fusion.RRF),
                limit=top_k,
                with_payload=True,
            )
            return response.points
        except Exception as exc:
            global _server_bm25_failed
            if backend == "qdrant-server":
                _server_bm25_failed = True
            logger.warning("Búsqueda híbrida falló (%s); reintento dense-only.", exc)
            response = client.query_points(
                collection_name=name,
                query=dense,
                using="dense",
                query_filter=qfilter,
                limit=top_k,
                with_payload=True,
            )
            return response.points

    points = await asyncio.to_thread(_search)
    return [_point_to_chunk(p) for p in points]
