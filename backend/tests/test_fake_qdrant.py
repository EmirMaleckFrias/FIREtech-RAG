"""El espía de Qdrant sustituye al cliente real en todo `app.services.qdrant`."""
from __future__ import annotations

import types

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
    assert qdrant.group_values("supplier") == [
        {"valor": "supplier-A", "chunks": 3},
        {"valor": "supplier-B", "chunks": 1},
    ]
    assert fake_qdrant.calls_to("facet")[0]["key"] == "supplier"


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


def test_price_usd_prefiere_el_neto_y_deja_none_sin_precio():
    assert qdrant._price_usd({"price_net_usd": 12.5, "price_list_usd": 20.0}) == 12.5
    assert qdrant._price_usd({"price_net_usd": None, "price_list_usd": 20.0}) == 20.0
    assert qdrant._price_usd({"price_list_usd": 20.0}) == 20.0
    assert qdrant._price_usd({"price_net_usd": None, "price_list_usd": None}) is None
    assert qdrant._price_usd({"chunk_type": "tabla"}) is None
