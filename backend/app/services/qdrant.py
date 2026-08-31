"""Cliente Qdrant: setup de colección, upsert y búsqueda híbrida (dense + BM25 con RRF).

Si `fastembed` no está instalado (p. ej. Python 3.14 sin wheels), el módulo sigue
funcionando: la colección se crea igual con ambos vectores nombrados, pero el
upsert omite el vector sparse y `hybrid_search` cae a dense-only.
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

# Singletons módulo-level, inicializados de forma lazy para que importar este
# módulo no requiera Qdrant corriendo ni descargar el modelo BM25.
_client: QdrantClient | None = None
_bm25_model: Any | None = None
_bm25_failed = False


def get_client() -> QdrantClient:
    """Cliente Qdrant singleton (lazy)."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = QdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key or None,
            timeout=30,
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
    """
    settings = get_settings()
    client = get_client()
    name = settings.qdrant_collection

    if client.collection_exists(collection_name=name):
        # Colección existente → ya tiene sus índices de payload (se crean
        # junto con ella). Cold start = 1 sola llamada HTTP a Qdrant.
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

    for field, schema in (
        ("brand", models.PayloadSchemaType.KEYWORD),
        ("category", models.PayloadSchemaType.KEYWORD),
        ("source_file", models.PayloadSchemaType.KEYWORD),
        ("has_price", models.PayloadSchemaType.BOOL),
        ("skus", models.PayloadSchemaType.KEYWORD),
    ):
        try:
            client.create_payload_index(
                collection_name=name, field_name=field, field_schema=schema
            )
        except Exception:
            # El índice ya existe (o versión de Qdrant que no lo tolera): ok.
            logger.debug("Índice de payload '%s' ya existente.", field)


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


def _sparse_vectors_for(texts: list[str]) -> list[models.SparseVector | None]:
    """Vectores BM25 para una lista de textos; Nones si no hay fastembed."""
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


_PAYLOAD_KEYS = (
    "text",
    "source_file",
    "page",
    "brand",
    "category",
    "skus",
    "product_names",
    "has_price",
    "chunk_type",
    # Campos ricos del esquema canónico (docs/sintesis_esquema.json). Se
    # almacenan en el payload para filtros/auditoría futuros; _point_to_chunk
    # NO los expone, así que nunca salen por la API pública. En particular
    # cost_internal_usd (margen del distribuidor) vive solo aquí y jamás debe
    # entrar en "text".
    "supplier",
    "category_es",
    "product_type",
    "model_series",
    "size_raw",
    "approvals",
    "box_qty",
    "price_net_usd",
    "price_list_usd",
    "cost_internal_usd",
    "price_status",
    "price_effective_date",
    "currency_assumed",
    "is_active",
    "visibility",
    "data_quality_flags",
    "source_row",
    "source_pages",
)


def upsert_chunks(chunks: list[dict]) -> int:
    """Upserta chunks (con vector denso precalculado en `chunk["dense"]`).

    Calcula el vector BM25 internamente si fastembed está disponible; si no,
    los puntos se indexan solo con el vector denso.
    """
    if not chunks:
        return 0
    settings = get_settings()
    client = get_client()

    sparse = _sparse_vectors_for([c.get("text", "") for c in chunks])

    points: list[models.PointStruct] = []
    for chunk, sv in zip(chunks, sparse):
        vector: dict[str, Any] = {"dense": chunk["dense"]}
        if sv is not None and len(sv.indices) > 0:
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


def _build_filter(filters: SearchFilters) -> models.Filter | None:
    must: list[models.FieldCondition] = []
    if filters.brand:
        must.append(
            models.FieldCondition(
                key="brand", match=models.MatchValue(value=filters.brand)
            )
        )
    if filters.category:
        must.append(
            models.FieldCondition(
                key="category", match=models.MatchValue(value=filters.category)
            )
        )
    return models.Filter(must=must) if must else None


def find_by_skus(skus: list[str], limit: int = 8) -> list[Chunk]:
    """Match exacto por SKU/short-code en el payload (fast-path del agente).

    `skus` es un campo keyword[] en el payload: MatchAny acierta si el punto
    contiene cualquiera de los códigos dados. Devuelve [] ante cualquier fallo.
    """
    if not skus:
        return []
    settings = get_settings()
    try:
        points, _ = get_client().scroll(
            collection_name=settings.qdrant_collection,
            scroll_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="skus", match=models.MatchAny(any=skus)
                    )
                ]
            ),
            limit=limit,
            with_payload=True,
        )
    except Exception as exc:
        logger.warning("find_by_skus falló (%s); se continúa sin fast-path.", exc)
        return []
    return [_point_to_chunk(p) for p in points]


def _point_to_chunk(point: Any) -> Chunk:
    payload = point.payload or {}
    return Chunk(
        id=str(point.id),
        text=payload.get("text") or "",
        source_file=payload.get("source_file") or "",
        page=int(payload.get("page") or 0),
        brand=payload.get("brand") or "",
        category=payload.get("category") or "",
        skus=payload.get("skus") or [],
        product_names=payload.get("product_names") or [],
        has_price=bool(payload.get("has_price") or False),
        chunk_type=payload.get("chunk_type") or "page",
        # Los Records de scroll() no traen score (solo los de query_points).
        score=float(getattr(point, "score", 0.0) or 0.0),
    )


async def hybrid_search(
    query: str, filters: SearchFilters, top_k: int
) -> list[Chunk]:
    """Búsqueda híbrida: dense + BM25 fusionados con RRF (Query API de Qdrant).

    El embedding denso de la query es async (`embed_query`); las llamadas al
    cliente síncrono de Qdrant se ejecutan en un thread con
    `asyncio.to_thread`. Sin fastembed, cae a búsqueda dense-only.
    """
    settings = get_settings()
    dense = await embed_query(query)
    qfilter = _build_filter(filters)

    def _search() -> list[Any]:
        client = get_client()
        name = settings.qdrant_collection
        prefetch_limit = max(top_k * 2, 20)

        sparse_query: models.SparseVector | None = None
        model = _get_bm25()
        if model is not None:
            try:
                emb = next(iter(model.query_embed(query)))
                if len(emb.indices) > 0:
                    sparse_query = models.SparseVector(
                        indices=list(emb.indices), values=list(emb.values)
                    )
            except Exception as exc:
                logger.warning(
                    "Fallo el embedding BM25 de la query (%s); dense-only.", exc
                )

        if sparse_query is not None:
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
        else:
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
