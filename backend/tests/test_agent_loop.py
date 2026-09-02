"""Loop del agente (run_agent) con OpenAI falso y la tool de catálogo
parcheada: orden de eventos, kwargs de cada ronda, telemetría, repeticiones
idénticas y final forzado por MAX_HOPS."""
from __future__ import annotations

import json

import pytest

from app.config import get_settings
from app.services import agent, telemetry
from app.services.agent import AgentEvent, run_agent
from tests.conftest import FakeStream, make_text_stream, make_tool_call_stream, make_usage

TOOL = "buscar_documentos"
SIN_RESULTADOS = "sin resultados"


@pytest.fixture
def catalogo_falso(monkeypatch):
    """Sustituye `_execute_document_search` por un stub que registra los args
    y no devuelve chunks."""
    llamadas: list[dict] = []

    async def _stub(args: dict):
        llamadas.append(dict(args))
        return [], SIN_RESULTADOS

    monkeypatch.setattr(agent, "_execute_document_search", _stub)
    return llamadas


async def _correr(mensaje: str, history: list[dict] | None = None) -> list[AgentEvent]:
    return [ev async for ev in run_agent(mensaje, history or [])]


def _tipos(eventos: list[AgentEvent]) -> list[str]:
    return [ev.type for ev in eventos]


def _mensajes_tool(kwargs: dict) -> list[dict]:
    return [m for m in kwargs["messages"] if m.get("role") == "tool"]


# ---------------------------------------------------------------------------
# (a) un hop y respuesta final
# ---------------------------------------------------------------------------
async def test_un_hop_y_final(settings_override, fake_openai, catalogo_falso):
    fake_openai.queue(
        make_tool_call_stream(
            TOOL, {"semantico": "valvulas"}, call_id="call_1",
            usage=make_usage(prompt=100, completion=20, cached=40, reasoning=5),
        ),
        make_text_stream(
            "Hay tres válvulas listadas.",
            usage=make_usage(prompt=150, completion=30),
        ),
    )
    tel = telemetry.start(prueba="a")

    eventos = await _correr("¿qué válvulas hay?")

    # Orden: hop, sources, uno o más token, final.
    tipos = _tipos(eventos)
    assert tipos[0] == "hop"
    assert tipos[1] == "sources"
    assert tipos[-1] == "final"
    assert tipos[2:-1] and set(tipos[2:-1]) == {"token"}

    final = eventos[-1].data
    assert final["content"] == "Hay tres válvulas listadas."
    assert "".join(ev.data["text"] for ev in eventos if ev.type == "token") == final["content"]
    assert final["sources"] == []

    # La tool se ejecutó una vez con los args del modelo (JSON reensamblado).
    assert catalogo_falso == [{"semantico": "valvulas"}]

    # kwargs de ambas rondas.
    assert len(fake_openai.calls) == 2
    for kwargs in fake_openai.calls:
        assert kwargs["stream"] is True
        assert kwargs["stream_options"] == {"include_usage": True}
        assert [t["function"]["name"] for t in kwargs["tools"]] == [TOOL]
        assert kwargs["model"] == settings_override.openai_model
        assert kwargs["tool_choice"] == "auto"
        assert kwargs["parallel_tool_calls"] is False
    # La segunda ronda ya ve la tool call del asistente y el resultado.
    ronda2 = fake_openai.calls[1]["messages"]
    assert ronda2[-2]["role"] == "assistant"
    assert ronda2[-2]["tool_calls"][0]["id"] == "call_1"
    assert json.loads(ronda2[-2]["tool_calls"][0]["function"]["arguments"]) == {"semantico": "valvulas"}
    assert ronda2[-1] == {"role": "tool", "tool_call_id": "call_1", "content": SIN_RESULTADOS}

    # Telemetría: 2 rondas del agente con los usage falsos.
    rondas = [r for r in tel.rounds if r.component == "agente"]
    assert len(rondas) == 2
    assert [r.prompt for r in rondas] == [100, 150]
    assert [r.completion for r in rondas] == [20, 30]
    assert [r.cached for r in rondas] == [40, 0]
    assert [r.reasoning for r in rondas] == [5, 0]
    assert [r.finish_reason for r in rondas] == ["tool_calls", "stop"]
    assert all(r.ok for r in rondas)
    assert all(r.model == settings_override.openai_model for r in rondas)
    assert tel.counters.get("hops") == 1
    assert "llamadas_repetidas" not in tel.counters
    assert "forced_final" not in tel.counters
    assert "rounds_sin_usage" not in tel.counters
    assert tel.meta["prompt_version"] == settings_override.prompt_version
    assert tel.meta["model"] == settings_override.openai_model

    # El hop dict se muta in place tras ejecutar: el evento y final["hops"]
    # son el mismo objeto.
    hop = eventos[0].data
    assert set(hop) >= {"n", "query", "ms", "resultados", "chars"}
    assert hop["n"] == 1
    assert hop["query"] == "valvulas"
    assert hop["resultados"] == 0
    assert hop["chars"] == len(SIN_RESULTADOS)
    assert isinstance(hop["ms"], float)
    assert final["hops"] == [hop]


# ---------------------------------------------------------------------------
# (b) repetición idéntica de la misma tool call
# ---------------------------------------------------------------------------
async def test_llamada_repetida_no_se_ejecuta(settings_override, fake_openai, catalogo_falso):
    args = {"semantico": "detector de humo", "ordenar": "precio_asc"}
    fake_openai.queue(
        make_tool_call_stream(TOOL, args, call_id="call_1", usage=make_usage(100, 10)),
        make_tool_call_stream(TOOL, args, call_id="call_2", usage=make_usage(120, 10)),
        make_text_stream("Listo.", usage=make_usage(140, 5)),
    )
    tel = telemetry.start()

    eventos = await _correr("detector más barato")

    assert _tipos(eventos).count("hop") == 1
    assert eventos[-1].type == "final"
    assert eventos[-1].data["content"] == "Listo."

    # Solo la primera ejecuta; la repetición no consume hop.
    assert len(catalogo_falso) == 1
    assert tel.counters.get("hops") == 1
    assert tel.counters.get("llamadas_repetidas") == 1
    assert len(fake_openai.calls) == 3

    # El mensaje tool de la repetición avisa al modelo.
    tools_ronda3 = _mensajes_tool(fake_openai.calls[2])
    assert [m["tool_call_id"] for m in tools_ronda3] == ["call_1", "call_2"]
    assert tools_ronda3[0]["content"] == SIN_RESULTADOS
    assert "IDÉNTICA" in tools_ronda3[1]["content"]
    # Y en la ronda 2 todavía no existía.
    assert len(_mensajes_tool(fake_openai.calls[1])) == 1


# ---------------------------------------------------------------------------
# (c) MAX_HOPS agotado: final forzado con tool_choice="none"
# ---------------------------------------------------------------------------
async def test_max_hops_fuerza_el_final(settings_override, fake_openai, catalogo_falso, monkeypatch):
    monkeypatch.setenv("MAX_HOPS", "1")
    get_settings.cache_clear()
    assert get_settings().max_hops == 1

    fake_openai.queue(
        make_tool_call_stream(TOOL, {"semantico": "rociadores"}, usage=make_usage(80, 8)),
        make_text_stream("Respuesta con lo que hay.", usage=make_usage(90, 9)),
    )
    tel = telemetry.start()

    eventos = await _correr("rociadores")

    assert _tipos(eventos).count("hop") == 1
    assert eventos[-1].type == "final"
    assert len(catalogo_falso) == 1
    assert len(fake_openai.calls) == 2

    primera, segunda = fake_openai.calls
    assert primera["tool_choice"] == "auto"
    assert segunda["tool_choice"] == "none"
    assert "parallel_tool_calls" not in segunda
    assert segunda["stream_options"] == {"include_usage": True}

    assert tel.counters.get("forced_final") == 1
    assert tel.counters.get("hops") == 1
    rondas = [r for r in tel.rounds if r.component == "agente"]
    assert len(rondas) == 2
    assert rondas[1].note == "final forzado"


# ---------------------------------------------------------------------------
# extras del contrato
# ---------------------------------------------------------------------------
async def test_sin_api_key_falla_antes_de_llamar(settings_override, fake_openai, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError):
        await _correr("hola")
    assert fake_openai.calls == []


async def test_el_historial_se_antepone_al_mensaje(settings_override, fake_openai, catalogo_falso):
    fake_openai.queue(make_text_stream("ok", usage=make_usage(10, 1)))
    history = [
        {"role": "user", "content": "antes"},
        {"role": "assistant", "content": "respuesta previa"},
    ]
    eventos = await _correr("ahora", history)
    assert _tipos(eventos) == ["sources", "token", "final"]
    mensajes = fake_openai.calls[0]["messages"]
    assert mensajes[0]["role"] == "system"
    assert mensajes[1:3] == history
    assert mensajes[3] == {"role": "user", "content": "ahora"}
    assert catalogo_falso == []


class _StreamQueSeCorta(FakeStream):
    """Stream que entrega `n_ok` chunks y luego falla, como una desconexión
    a mitad de la respuesta."""

    def __init__(self, chunks, n_ok: int, exc: Exception):
        super().__init__(chunks)
        self._n_ok = n_ok
        self._exc = exc

    async def __anext__(self):
        if len(self.consumed) >= self._n_ok:
            raise self._exc
        return await super().__anext__()


async def test_fallo_a_mitad_del_stream_queda_en_telemetria(settings_override, fake_openai, catalogo_falso):
    # Antes solo se medía el fallo de `create`; un corte durante el `async for`
    # salía del generador sin ronda registrada y el semáforo se soltaba igual.
    base = make_text_stream("uno dos tres", usage=make_usage(10, 3))
    fake_openai.queue(_StreamQueSeCorta(base._chunks, n_ok=1, exc=ConnectionError("conexión cortada")))
    tel = telemetry.start()

    with pytest.raises(ConnectionError):
        await _correr("hola")

    rondas = [r for r in tel.rounds if r.component == "agente"]
    assert len(rondas) == 1
    assert rondas[0].ok is False
    assert "conexión cortada" in rondas[0].note
    # La plaza del semáforo se liberó: una segunda corrida arranca sin bloquear.
    fake_openai.queue(make_text_stream("ok", usage=make_usage(10, 1)))
    assert _tipos(await _correr("otra")) == ["sources", "token", "final"]
