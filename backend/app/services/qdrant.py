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

# Índices de payload que la colección necesita. `price_usd` (float) lo exige
# `scan_by_price` para el order_by y el rango de precio; `price_status`
# (keyword) lo facetea check_index.py. Misma lista que
# check_index.EXPECTED_INDEXES (ese script no importa este módulo a propósito,
# para no arrastrar embeddings/fastembed): si cambia una, cambiar la otra.
PAYLOAD_INDEXES: tuple[tuple[str, models.PayloadSchemaType], ...] = (
    ("project_id", models.PayloadSchemaType.KEYWORD),
    ("document_id", models.PayloadSchemaType.KEYWORD),
    ("document_type", models.PayloadSchemaType.KEYWORD),
    ("language", models.PayloadSchemaType.KEYWORD),
    ("brand", models.PayloadSchemaType.KEYWORD),
    ("category", models.PayloadSchemaType.KEYWORD),
    ("source_file", models.PayloadSchemaType.KEYWORD),
    ("has_price", models.PayloadSchemaType.BOOL),
    ("skus", models.PayloadSchemaType.KEYWORD),
    ("supplier", models.PayloadSchemaType.KEYWORD),
    ("chunk_type", models.PayloadSchemaType.KEYWORD),
    ("price_usd", models.PayloadSchemaType.FLOAT),
    ("price_status", models.PayloadSchemaType.KEYWORD),
)

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

    for field, schema in PAYLOAD_INDEXES:
        try:
            client.create_payload_index(
                collection_name=name, field_name=field, field_schema=schema
            )
        except Exception:
            # El índice ya existe (o versión de Qdrant que no lo tolera): ok.
            logger.debug("Índice de payload '%s' ya existente.", field)


def retrieval_mode() -> str:
    """'hybrid' si el codificador BM25 está disponible; 'dense-only' si no.

    En producción serverless fastembed no cabe en la función, así que las
    consultas son dense-only aunque los vectores sparse existan en el índice.
    Exponerlo en /api/health y /api/stats hace visible la degradación.

    Fuerza la carga perezosa del modelo (`_get_bm25()`), así que la primera
    llamada puede tardar lo que tarde fastembed en inicializarse; a cambio
    refleja exactamente lo que decidirá `hybrid_search` (antes bastaba con
    tener fastembed instalado para decir 'hybrid', aunque la carga fallara
    después). Sin fastembed (`_make_bm25 is None`) no cuesta nada.
    """
    return "hybrid" if _get_bm25() is not None else "dense-only"


def bm25_backend() -> str:
    """Implementación del codificador sparse en uso: 'fastembed' o 'none'.

    Separado de `retrieval_mode()` para que /health distinga "no hay BM25"
    de "hay BM25 pero con otro backend" (la Fase 4 añadirá 'pure').
    """
    return "fastembed" if retrieval_mode() == "hybrid" else "none"


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
    "project_id",
    "document_id",
    "section",
    "language",
    "document_type",
    "source_pages",
    "metadata",
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


def _price_usd(chunk: dict) -> float | None:
    """Precio unificado del payload: el neto si existe, si no el de lista.

    Es el campo `price_usd` por el que ordena y filtra `scan_by_price` (índice
    float). Se deriva aquí, en el upsert, para que una ingesta desde cero
    produzca lo mismo que el backfill que lo creó en las colecciones actuales;
    los productos sin precio numérico (call, discontinued, missing) y los
    chunks que no son producto quedan en None y fuera del orden.
    """
    net = chunk.get("price_net_usd")
    if net is not None:
        return net
    return chunk.get("price_list_usd")


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
        payload["price_usd"] = _price_usd(chunk)
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
    if filters.supplier:
        must.append(
            models.FieldCondition(
                key="supplier", match=models.MatchValue(value=filters.supplier)
            )
        )
    return models.Filter(must=must) if must else None


# ---------------------------------------------------------------------------
# Consulta estructurada: el álgebra general (filtrar + ordenar + agrupar)
# ejecutada EXACTA sobre el payload. Es lo que hace que "el más barato de
# cada suplidor" o "cuántas marcas hay" funcionen por construcción, sin
# reglas por tipo de pregunta.
# ---------------------------------------------------------------------------
GROUP_FIELDS = {"suplidor": "supplier", "marca": "brand", "archivo": "source_file"}

_MAX_GROUPS = 16  # tope de grupos a recorrer en una agrupación


def _base_filter(
    supplier: str | None = None,
    brand: str | None = None,
    price_min: float | None = None,
    price_max: float | None = None,
    group_field: str | None = None,
    group_value: str | None = None,
    solo_productos: bool = True,
) -> models.Filter:
    must: list[models.Condition] = []
    if solo_productos:
        must.append(
            models.FieldCondition(
                key="chunk_type", match=models.MatchValue(value="product")
            )
        )
    if supplier:
        must.append(
            models.FieldCondition(
                key="supplier", match=models.MatchValue(value=supplier)
            )
        )
    if brand:
        must.append(
            models.FieldCondition(key="brand", match=models.MatchValue(value=brand))
        )
    if price_min is not None or price_max is not None:
        must.append(
            models.FieldCondition(
                key="price_usd",
                range=models.Range(gte=price_min, lte=price_max),
            )
        )
    if group_field and group_value is not None:
        must.append(
            models.FieldCondition(
                key=group_field, match=models.MatchValue(value=group_value)
            )
        )
    return models.Filter(must=must)


def scan_by_price(
    *,
    supplier: str | None = None,
    brand: str | None = None,
    price_min: float | None = None,
    price_max: float | None = None,
    group_field: str | None = None,
    group_value: str | None = None,
    descending: bool = False,
    limit: int = 10,
) -> list[Chunk]:
    """Productos ordenados por el PRECIO real del payload, exacto y sin LLM.

    Requiere el índice float de `price_usd`; los puntos sin precio quedan
    fuera del orden por construcción (se añade el rango >= 0 explícito).
    """
    settings = get_settings()
    flt = _base_filter(
        supplier, brand, price_min if price_min is not None else 0.0, price_max,
        group_field, group_value,
    )
    points, _ = get_client().scroll(
        collection_name=settings.qdrant_collection,
        scroll_filter=flt,
        order_by=models.OrderBy(
            key="price_usd",
            direction=models.Direction.DESC if descending else models.Direction.ASC,
        ),
        limit=limit,
        with_payload=True,
    )
    return [_point_to_chunk(p) for p in points]


def group_values(group_field: str, min_count: int = 1) -> list[dict]:
    """Valores vivos de un campo agrupable con su conteo de chunks."""
    settings = get_settings()
    res = get_client().facet(
        collection_name=settings.qdrant_collection,
        key=group_field,
        limit=60,
        exact=True,
    )
    return [
        {"valor": str(h.value), "chunks": h.count}
        for h in res.hits
        if str(h.value).strip() and h.count >= min_count
    ]


def index_inventory() -> dict:
    """Inventario EN VIVO del índice: totales, archivos, suplidores y marcas.

    Todo sale de facets/counts de Qdrant en el momento de la llamada, así el
    agente responde preguntas sobre el corpus con datos reales (incluidos los
    documentos subidos después de la ingesta inicial), sin nada hardcodeado.
    """
    settings = get_settings()
    client = get_client()
    name = settings.qdrant_collection

    def _facet(key: str) -> list[dict]:
        res = client.facet(collection_name=name, key=key, limit=60, exact=True)
        # count > 0: el facet devuelve "lápidas" de valores cuyos puntos ya
        # fueron borrados (documentos eliminados) con conteo cero.
        return [
            {"valor": str(h.value), "chunks": h.count}
            for h in res.hits
            if str(h.value).strip() and h.count > 0
        ]

    total = client.count(collection_name=name, exact=True).count
    products = client.count(
        collection_name=name,
        exact=True,
        count_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="chunk_type", match=models.MatchValue(value="product")
                )
            ]
        ),
    ).count
    return {
        "total_chunks": total,
        "productos": products,
        "archivos": _facet("source_file"),
        "suplidores": _facet("supplier"),
        "marcas": _facet("brand"),
    }


_KNOWN_SUPPLIERS: list[str] | None = None


def resolve_supplier(nombre: str | None) -> str | None:
    """Mapea un nombre libre al valor EXACTO del payload `supplier`.

    'reliable' → 'RELIABLE', 'notifier' → 'Notifier by Honeywell', 'aleum' →
    'ALEUM CO.'. None si no matchea (entonces se intenta como marca). La
    lista sale del facet en vivo, con caché de proceso.
    """
    global _KNOWN_SUPPLIERS
    if not nombre:
        return None
    if _KNOWN_SUPPLIERS is None:
        try:
            settings = get_settings()
            res = get_client().facet(
                collection_name=settings.qdrant_collection,
                key="supplier",
                limit=50,
            )
            _KNOWN_SUPPLIERS = [str(h.value) for h in res.hits if str(h.value).strip()]
        except Exception as exc:
            logger.warning("No se pudo facetar suppliers (%s).", exc)
            return None
    needle = nombre.strip().lower()
    if not needle:
        return None
    if "rasco" in needle:
        needle = "reliable"
    for known in _KNOWN_SUPPLIERS:
        kl = known.lower()
        if not kl:
            continue
        if needle == kl or needle in kl or kl in needle:
            return known
        # 'notifier' debe matchear 'Notifier by Honeywell' por primera palabra.
        if kl.split()[0] == needle.split()[0] and len(needle.split()[0]) >= 4:
            return known
    return None


_KNOWN_BRANDS: list[str] | None = None


def resolve_brand(marca: str | None) -> str | None:
    """Mapea la marca que escribe el usuario/LLM al valor EXACTO del payload.

    'aleum' → 'ALEUM CO.', 'rasco' → 'Reliable', 'agf' → 'AGF Manufacturing
    Inc.'. Los filtros de Qdrant son case-sensitive y exactos: sin esto, un
    filtro por 'Aleum' devuelve 0 resultados en silencio. None si no matchea
    (mejor sin filtro que con filtro imposible).
    """
    global _KNOWN_BRANDS
    if not marca:
        return None
    if _KNOWN_BRANDS is None:
        try:
            settings = get_settings()
            res = get_client().facet(
                collection_name=settings.qdrant_collection,
                key="brand",
                limit=100,
            )
            _KNOWN_BRANDS = [str(h.value) for h in res.hits]
        except Exception as exc:
            logger.warning("No se pudo facetar brands (%s).", exc)
            return marca  # sin lista: usa el valor tal cual
    needle = marca.strip().lower()
    if not needle:
        return None
    # RASCO es el nombre comercial de Reliable en los catálogos.
    if "rasco" in needle:
        needle = "reliable"
    for known in _KNOWN_BRANDS:
        kl = known.lower()
        if not kl:
            continue  # docs subidos sin marca: '' matchearía cualquier cosa
        if needle == kl or needle in kl or kl in needle:
            return known
    return None


def detect_brand_in_text(text: str) -> str | None:
    """Marca conocida mencionada en un texto libre, o None si hay 0 o varias.

    Determinista y sin LLM: compara contra la lista viva de marcas del índice.
    Se usa para auto-filtrar por payload cuando la consulta nombra una marca
    ('detector VESDA barato' → brand=VESDA) sin depender del clasificador.
    """
    if not text:
        return None
    resolve_brand("x")  # fuerza la carga lazy de _KNOWN_BRANDS
    if not _KNOWN_BRANDS:
        return None
    lowered = f" {text.lower()} "
    matches: list[str] = []
    for known in _KNOWN_BRANDS:
        first_word = known.lower().split()[0] if known.strip() else ""
        if len(first_word) >= 4 and f" {first_word}" in lowered:
            matches.append(known)
        elif "rasco" in lowered and known.lower() == "reliable":
            matches.append(known)
    matches = list(dict.fromkeys(matches))
    return matches[0] if len(matches) == 1 else None


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
        project_id=payload.get("project_id"),
        document_id=payload.get("document_id"),
        section=payload.get("section") or "",
        language=payload.get("language") or "",
        document_type=payload.get("document_type") or "",
        source_pages=payload.get("source_pages") or [],
        metadata=payload.get("metadata") or {},
        brand=payload.get("brand") or "",
        category=payload.get("category") or "",
        skus=payload.get("skus") or [],
        product_names=payload.get("product_names") or [],
        has_price=bool(payload.get("has_price") or False),
        chunk_type=payload.get("chunk_type") or "page",
        # Los Records de scroll() no traen score (solo los de query_points).
        score=float(getattr(point, "score", 0.0) or 0.0),
        price_net_usd=payload.get("price_net_usd"),
        price_list_usd=payload.get("price_list_usd"),
        price_status=payload.get("price_status") or "",
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
