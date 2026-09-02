"""Reranker listwise y filtro binario de relevancia con completions JSON falsas."""
from __future__ import annotations

from app.models import Chunk
from app.services import telemetry
from app.services.reranker import filter_relevant, rerank
from tests.conftest import make_json_completion, make_usage


def _chunks(n: int) -> list[Chunk]:
    return [
        Chunk(id=f"c{i}", text=f"producto {i}", source_file="cat.pdf", page=i + 1)
        for i in range(n)
    ]


def _ids(chunks: list[Chunk]) -> list[str]:
    return [c.id for c in chunks]


# --- filter_relevant --------------------------------------------------------
async def test_filter_relevant_conserva_el_orden(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": [2, 0]}, usage=make_usage(50, 5)))

    out = await filter_relevant("detector", chunks)

    assert _ids(out.kept) == ["c0", "c2"]  # orden de entrada, no el del JSON
    assert out.verificado is True
    assert len(fake_openai.calls) == 1
    kwargs = fake_openai.calls[0]
    assert kwargs["model"] == settings_override.rerank_model_resolved
    assert kwargs["response_format"] == {"type": "json_object"}
    assert "detector" in kwargs["messages"][-1]["content"]
    assert "[2] producto 2" in kwargs["messages"][-1]["content"]


async def test_filter_relevant_respuesta_ilegible_no_se_da_por_verificada(
    settings_override, fake_openai
):
    """JSON sin la lista esperada: se devuelven todos, pero SIN verificar.

    Es la diferencia que importa: nadie puede concluir de aquí que los tres
    fragmentos sirvan, solo que el filtro no se pudo aplicar.
    """
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": "todos"}, usage=make_usage(50, 5)))
    out = await filter_relevant("detector", chunks)
    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False

    fake_openai.queue(make_json_completion({}, usage=make_usage(50, 5)))
    out = await filter_relevant("detector", chunks)
    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False


async def test_filter_relevant_ninguno_relevante_es_una_respuesta_legitima(
    settings_override, fake_openai
):
    """Lista vacía verificada: el índice no cubre el tema, y hay que decirlo."""
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": []}))

    out = await filter_relevant("x", chunks)

    assert out.kept == []
    assert out.verificado is True


async def test_filter_relevant_ignora_indices_invalidos(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"relevantes": [7, -1, "no", True, 1]}))

    out = await filter_relevant("x", chunks)

    assert _ids(out.kept) == ["c1"]
    assert out.verificado is True


async def test_filter_relevant_con_un_solo_chunk_no_llama(settings_override, fake_openai):
    chunks = _chunks(1)

    out = await filter_relevant("x", chunks)

    assert out.kept == chunks
    # No se llamó al modelo, así que no se puede afirmar que sea relevante.
    assert out.verificado is False
    assert fake_openai.calls == []


async def test_filter_relevant_si_el_api_falla_devuelve_todos_sin_verificar(
    settings_override, fake_openai
):
    chunks = _chunks(3)
    fake_openai.queue(RuntimeError("api caída"))
    tel = telemetry.start()

    out = await filter_relevant("x", chunks)

    assert _ids(out.kept) == ["c0", "c1", "c2"]
    assert out.verificado is False
    assert len(tel.rounds) == 1 and tel.rounds[0].ok is False
    assert tel.rounds[0].component == "reranker"


# --- rerank -----------------------------------------------------------------
async def test_rerank_reordena_y_corta_a_top_k(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(make_json_completion({"ranking": [2, 0, 1]}, usage=make_usage(60, 6)))

    out = await rerank("valvula", chunks, top_k=2)

    assert _ids(out) == ["c2", "c0"]
    assert fake_openai.calls[0]["model"] == settings_override.rerank_model_resolved


async def test_rerank_ranking_parcial_anexa_los_que_faltan(settings_override, fake_openai):
    chunks = _chunks(4)
    fake_openai.queue(make_json_completion({"ranking": [3, 3, "x", 1]}))
    # Duplicados e inválidos se ignoran; c0 y c2 se anexan en su orden original.
    out = await rerank("q", chunks, top_k=3)
    assert _ids(out) == ["c3", "c1", "c0"]


async def test_rerank_con_pocos_candidatos_no_llama(settings_override, fake_openai):
    chunks = _chunks(3)
    assert await rerank("q", chunks, top_k=3) == chunks
    assert fake_openai.calls == []


async def test_rerank_si_falla_mantiene_orden_de_qdrant(settings_override, fake_openai):
    chunks = _chunks(4)
    fake_openai.queue(RuntimeError("timeout"))
    assert _ids(await rerank("q", chunks, top_k=2)) == ["c0", "c1"]


async def test_rerank_sin_contenido_cae_al_fallback_con_log(settings_override, fake_openai, caplog):
    # content=None (refusal, content_filter): antes se leía como {} en silencio
    # y la ronda quedaba ok=True aunque el modelo no hubiera rankeado nada.
    chunks = _chunks(4)
    completion = make_json_completion({}, usage=make_usage(40, 0), finish_reason="content_filter")
    completion.choices[0].message.content = None
    fake_openai.queue(completion)
    tel = telemetry.start()

    with caplog.at_level("WARNING"):
        out = await rerank("q", chunks, top_k=2)

    assert _ids(out) == ["c0", "c1"]  # orden de Qdrant intacto
    assert any("Reranker LLM" in r.getMessage() for r in caplog.records)
    assert len(tel.rounds) == 1
    assert tel.rounds[0].ok is False
    assert "sin contenido" in tel.rounds[0].note
    assert tel.rounds[0].prompt == 40  # el usage real se conserva


# --- telemetría -------------------------------------------------------------
async def test_telemetria_registra_componente_reranker(settings_override, fake_openai):
    chunks = _chunks(3)
    fake_openai.queue(
        make_json_completion({"ranking": [1, 0, 2]}, usage=make_usage(300, 12, cached=100)),
        make_json_completion({"relevantes": [0]}, usage=make_usage(200, 4)),
    )
    tel = telemetry.start()

    await rerank("q", chunks, top_k=2)
    await filter_relevant("q", chunks)

    rondas = [r for r in tel.rounds if r.component == "reranker"]
    assert len(rondas) == 2
    assert all(r.model == settings_override.rerank_model_resolved for r in rondas)
    assert [r.prompt for r in rondas] == [300, 200]
    assert [r.completion for r in rondas] == [12, 4]
    assert rondas[0].cached == 100
    assert all(r.ok and r.finish_reason == "stop" for r in rondas)
    assert rondas[0].note.startswith("rerank n=3 top_k=2")
    assert rondas[1].note.startswith("filter_relevant n=3")
    assert tel.by_component()["reranker"]["rounds"] == 2
    # El modelo del completion, si viene, manda sobre el pedido (snapshot).
    fake_openai.queue(
        make_json_completion({"ranking": [0, 1, 2]}, model="gpt-5.4-mini-2026-01-01")
    )
    await rerank("q", chunks, top_k=1)
    assert tel.rounds[-1].model == "gpt-5.4-mini-2026-01-01"
    assert tel.summary()["unknown_models"] == []
