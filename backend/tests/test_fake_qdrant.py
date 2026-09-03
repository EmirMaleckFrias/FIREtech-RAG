"""El espía de Qdrant sustituye al cliente real en todo `app.services.qdrant`."""
from __future__ import annotations

import types

import pytest

from app.config import get_settings
from app.models import SearchFilters
from app.services import qdrant


def test_el_espia_recibe_las_llamadas_del_modulo(settings_override, fake_qdrant):
    assert qdrant.get_client() is fake_qdrant
    fake_qdrant.set_response("count", types.SimpleNamespace(count=42))

    assert qdrant.collection_count() == 42

    metodo, kwargs = fake_qdrant.calls[-1]
    assert metodo == "count"
    assert kwargs["collection_name"] == settings_override.qdrant_collection
    assert kwargs["exact"] is True


def test_respuestas_configurables_y_callables(settings_override, fake_qdrant):
    fake_qdrant.set_response(
        "facet",
        lambda kw: types.SimpleNamespace(
            hits=[
                types.SimpleNamespace(value=f"{kw['key']}-A", count=3),
                types.SimpleNamespace(value="", count=9),  # se descarta: vacío
                types.SimpleNamespace(value=f"{kw['key']}-B", count=1),
            ]
        ),
    )
    fake_qdrant.set_response("count", types.SimpleNamespace(count=7))

    inv = qdrant.index_inventory()

    assert inv["total_chunks"] == 7
    # El valor vacío se descarta: son los huecos, no un valor real del campo.
    assert inv["archivos"] == [
        {"valor": "source_file-A", "chunks": 3},
        {"valor": "source_file-B", "chunks": 1},
    ]
    assert inv["idiomas"] == [
        {"valor": "language-A", "chunks": 3},
        {"valor": "language-B", "chunks": 1},
    ]
    claves = [kw["key"] for kw in fake_qdrant.calls_to("facet")]
    assert claves == ["source_file", "document_type", "language", "project_id"]


def test_info_y_excepciones(settings_override, fake_qdrant):
    assert qdrant.server_version() == "test"
    assert fake_qdrant.calls_to("info") == [{}]

    fake_qdrant.set_response("count", ConnectionError("sin red"))
    assert qdrant.collection_count() is None  # el módulo traga el error


def test_defaults_describen_una_coleccion_vacia(settings_override, fake_qdrant):
    assert fake_qdrant.collection_exists(collection_name="x") is True
    assert fake_qdrant.count(collection_name="x").count == 0
    assert fake_qdrant.scroll(collection_name="x") == ([], None)
    assert fake_qdrant.query_points(collection_name="x").points == []
    assert fake_qdrant.facet(collection_name="x", key="k").hits == []
    assert fake_qdrant.get_collection(collection_name="x").points_count == 0
    assert fake_qdrant.create_payload_index(collection_name="x", field_name="f") is None
    assert [m for m, _ in fake_qdrant.calls] == [
        "collection_exists", "count", "scroll", "query_points", "facet",
        "get_collection", "create_payload_index",
    ]


def test_retrieval_mode_fuerza_la_carga_de_bm25(settings_override, monkeypatch):
    # Antes decía 'hybrid' con solo tener fastembed importable, aunque la carga
    # del modelo fallara después: ahora la fuerza y refleja lo que hará hybrid_search.
    monkeypatch.setattr(qdrant, "_bm25_model", None)
    monkeypatch.setattr(qdrant, "_bm25_failed", False)
    monkeypatch.setenv("QDRANT_BM25_BACKEND", "fastembed")
    get_settings.cache_clear()

    def _falla():
        raise RuntimeError("modelo no descargable")

    monkeypatch.setattr(qdrant, "_make_bm25", _falla)
    assert qdrant.retrieval_mode() == "dense-only"
    assert qdrant._bm25_failed is True
    assert qdrant.bm25_backend() == "none"

    monkeypatch.setattr(qdrant, "_bm25_failed", False)
    monkeypatch.setattr(qdrant, "_make_bm25", lambda: object())
    assert qdrant.retrieval_mode() == "hybrid"
    assert qdrant.bm25_backend() == "fastembed"

    monkeypatch.setattr(qdrant, "_bm25_model", None)
    monkeypatch.setattr(qdrant, "_make_bm25", None)
    assert qdrant.retrieval_mode() == "dense-only"


def test_bm25_nativo_se_verifica_y_se_usa_al_ingerir(
    settings_override, fake_qdrant, monkeypatch
):
    monkeypatch.setenv("QDRANT_BM25_BACKEND", "server")
    get_settings.cache_clear()
    monkeypatch.setattr(qdrant, "_server_bm25_checked", False)
    monkeypatch.setattr(qdrant, "_server_bm25_failed", False)

    assert qdrant.retrieval_mode() == "hybrid"
    assert qdrant.bm25_backend() == "qdrant-server"

    qdrant.upsert_chunks([{
        "id": "1", "dense": [0.1, 0.2], "text": "beta amiloide",
        "source_file": "a.pdf", "page": 1,
    }])
    point = fake_qdrant.calls_to("upsert")[0]["points"][0]
    sparse = point.vector["bm25"]
    assert sparse.text == "beta amiloide"
    assert sparse.model == "qdrant/bm25"


@pytest.mark.asyncio
async def test_busqueda_nativa_fusiona_dense_y_bm25(
    settings_override, fake_qdrant, monkeypatch
):
    monkeypatch.setenv("QDRANT_BM25_BACKEND", "server")
    get_settings.cache_clear()
    monkeypatch.setattr(qdrant, "_server_bm25_checked", True)
    monkeypatch.setattr(qdrant, "_server_bm25_failed", False)

    async def _dense(_query):
        return [0.1, 0.2]

    monkeypatch.setattr(qdrant, "embed_query", _dense)
    await qdrant.hybrid_search("APOE4", SearchFilters(), top_k=8)

    call = fake_qdrant.calls_to("query_points")[-1]
    assert len(call["prefetch"]) == 2
    assert call["prefetch"][1].query.text == "APOE4"
    assert call["prefetch"][1].query.model == "qdrant/bm25"


def test_el_payload_es_una_lista_blanca(settings_override, fake_qdrant):
    """Lo que el parser no declare en _PAYLOAD_KEYS no llega a Qdrant.

    Es la garantía de que un campo nuevo en la ingesta no se filtra al índice
    por accidente, y con documentos ajenos eso importa.
    """
    qdrant.upsert_chunks(
        [
            {
                "id": "1",
                "dense": [0.1, 0.2],
                "text": "hola",
                "source_file": "a.pdf",
                "page": 3,
                "campo_no_declarado": "no debe viajar",
            }
        ]
    )

    punto = fake_qdrant.calls_to("upsert")[0]["points"][0]
    assert set(punto.payload) == set(qdrant._PAYLOAD_KEYS)
    assert punto.payload["text"] == "hola"
    assert punto.payload["page"] == 3
    assert punto.payload["language"] is None  # no lo puso el parser


def test_swap_de_version_borra_solo_los_puntos_anteriores(
    settings_override, fake_qdrant
):
    qdrant.delete_old_versions("paper.pdf", "sha-nuevo")

    call = fake_qdrant.calls_to("delete")[0]
    selector = call["points_selector"]
    assert selector.filter.must[0].key == "source_file"
    assert selector.filter.must[0].match.value == "paper.pdf"
    assert selector.filter.must_not[0].key == "document_version"
    assert selector.filter.must_not[0].match.value == "sha-nuevo"
    assert call["wait"] is True


# ---------------------------------------------------------------------------
# Reconciliación de índices de payload en una colección que YA existe
# ---------------------------------------------------------------------------
def test_una_coleccion_existente_recibe_los_indices_que_le_falten(
    settings_override, fake_qdrant, monkeypatch
):
    """Regresión de un fallo que llegó a producción.

    `ensure_collection` volvía de inmediato al ver que la colección existía,
    suponiendo que ya tenía todos sus índices "porque se crean junto con
    ella". Al añadir `document_version` a PAYLOAD_INDEXES, la colección de
    producción se quedó con 6 de 7, y como Qdrant Cloud trae strict mode
    (`unindexed_filtering_update: false`) filtrar por esa clave devolvía 400.
    El usuario veía cada subida terminar en "Error" sin motivo.
    """
    from app.services import qdrant

    # la colección existe pero le faltan document_version y chunk_type
    presentes = {
        f: object() for f, _ in qdrant.PAYLOAD_INDEXES
        if f not in {"document_version", "chunk_type"}
    }
    fake_qdrant.set_response(
        "get_collection",
        types.SimpleNamespace(points_count=10, status="green", payload_schema=presentes),
    )
    qdrant._collection_checked = False

    qdrant.ensure_collection()

    creados = {kw["field_name"] for kw in fake_qdrant.calls_to("create_payload_index")}
    assert creados == {"document_version", "chunk_type"}
    # y NO se recrea la colección: eso borraría el índice entero
    assert fake_qdrant.calls_to("create_collection") == []


def test_no_se_repite_la_comprobacion_en_el_mismo_proceso(
    settings_override, fake_qdrant
):
    """El early-return existía por una razón buena: en serverless cada cold
    start pagaba la llamada. Se conserva, pero recordando el resultado en vez
    de suponerlo."""
    from app.services import qdrant

    qdrant._collection_checked = False
    qdrant.ensure_collection()
    llamadas = len(fake_qdrant.calls_to("get_collection"))
    qdrant.ensure_collection()
    qdrant.ensure_collection()

    assert len(fake_qdrant.calls_to("get_collection")) == llamadas


def test_si_no_hay_indices_que_falten_no_se_crea_ninguno(settings_override, fake_qdrant):
    from app.services import qdrant

    fake_qdrant.set_response(
        "get_collection",
        types.SimpleNamespace(
            points_count=10, status="green",
            payload_schema={f: object() for f, _ in qdrant.PAYLOAD_INDEXES},
        ),
    )
    qdrant._collection_checked = False

    qdrant.ensure_collection()

    assert fake_qdrant.calls_to("create_payload_index") == []
