"""Loop del agente (run_agent) con OpenAI falso y la tool de catálogo
parcheada: orden de eventos, kwargs de cada ronda, telemetría, repeticiones
idénticas y final forzado por MAX_HOPS."""
from __future__ import annotations

import json
import time

import pytest

from app.config import get_settings
from app.services import agent, telemetry
from app.services.agent import AgentEvent, run_agent
from tests.conftest import (
    FakeStream,
    make_json_completion,
    make_text_completion,
    make_text_stream,
    make_tool_call_stream,
    make_usage,
)

TOOL = "buscar_documentos"
INVENTARIO = "listar_documentos"
SIN_RESULTADOS = "sin resultados"


@pytest.fixture
def catalogo_falso(monkeypatch):
    """Sustituye `_execute_document_search` por un stub que registra los args
    y no devuelve chunks."""
    llamadas: list[dict] = []

    async def _stub(args: dict, fragmentos: int | None = None):
        llamadas.append(dict(args))
        return [], SIN_RESULTADOS

    monkeypatch.setattr(agent, "_execute_document_search", _stub)
    return llamadas


async def _correr(
    mensaje: str, history: list[dict] | None = None, modo: str | None = "extendido"
) -> list[AgentEvent]:
    """Corre el bucle. Por defecto en extendido: aqui se prueba la mecanica, y
    el modo normal esta acotado a proposito (ver test_modos.py)."""
    return [ev async for ev in run_agent(mensaje, history or [], modo)]


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
        assert [t["function"]["name"] for t in kwargs["tools"]] == [TOOL, INVENTARIO]
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
    # La nota dice POR QUE se paro, que es lo que hace falta para diagnosticar.
    assert rondas[1].note == "final forzado: tope de 1 búsquedas"

    # Y el modelo se entera de que se acabo el presupuesto, para que responda
    # con lo que tiene en vez de creer que decidio parar el.
    aviso = segunda["messages"][-1]
    assert aviso["role"] == "system"
    assert "presupuesto de búsquedas" in aviso["content"].lower()


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
    # Dos de sistema: el prompt base y la instruccion del modo.
    assert [m["role"] for m in mensajes[:2]] == ["system", "system"]
    assert mensajes[2:4] == history
    assert mensajes[4] == {"role": "user", "content": "ahora"}
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


async def test_sin_tope_de_hops_el_modelo_busca_lo_que_quiera(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """MAX_HOPS=0 significa sin limite de cuenta: 12 busquedas son 12.

    Cada busqueda devuelve un fragmento NUEVO, o sea que hay avance: sin eso
    cortaria el otro freno, que es exactamente lo que debe hacer.
    """
    monkeypatch.setenv("MAX_HOPS", "0")
    get_settings.cache_clear()
    assert get_settings().max_hops == 0

    from app.models import Chunk

    contador = {"n": 0}

    async def _con_avance(args: dict, fragmentos: int | None = None):
        contador["n"] += 1
        nuevo = Chunk(
            id=f"c{contador['n']}", text="algo nuevo", source_file="d.pdf",
            page=contador["n"], document_type="pdf",
        )
        catalogo_falso.append(dict(args))
        return [nuevo], "un fragmento"

    monkeypatch.setattr(agent, "_execute_document_search", _con_avance)

    # Cada busqueda con argumentos distintos, para que no la frene el dedup.
    for i in range(12):
        fake_openai.queue(
            make_tool_call_stream(TOOL, {"semantico": f"consulta {i}"}, usage=make_usage(80, 8))
        )
    fake_openai.queue(make_text_stream("Respuesta final.", usage=make_usage(90, 9)))

    eventos = await _correr("una pregunta larga", modo="extendido")

    assert _tipos(eventos).count("hop") == 12
    assert len(catalogo_falso) == 12
    assert eventos[-1].type == "final"


async def test_se_para_cuando_deja_de_encontrar_cosas_nuevas(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El freno que sustituye al tope arbitrario: buscar mas de lo mismo no
    acerca a la respuesta, asi que tras N busquedas sin nada nuevo se responde.

    El stub no devuelve chunks nunca, o sea cero fragmentos nuevos siempre.
    """
    monkeypatch.setenv("MAX_HOPS", "0")
    monkeypatch.setenv("AGENT_MAX_HOPS_SIN_AVANCE", "2")
    get_settings.cache_clear()

    for i in range(6):
        fake_openai.queue(
            make_tool_call_stream(TOOL, {"semantico": f"otra {i}"}, usage=make_usage(80, 8))
        )
    fake_openai.queue(make_text_stream("Lo que tengo.", usage=make_usage(90, 9)))
    tel = telemetry.start()

    eventos = await _correr("algo que no esta", modo="extendido")

    assert _tipos(eventos).count("hop") == 2
    assert eventos[-1].type == "final"
    rondas = [r for r in tel.rounds if r.component == "agente"]
    assert "sin encontrar nada nuevo" in rondas[-1].note


class _RelojDePasos:
    """Reloj falso que avanza un paso fijo en cada lectura.

    Existe para que el corte por presupuesto se pueda probar sin depender del
    reloj real. Delega en el modulo `time` cualquier otro atributo, de modo
    que sustituirlo en el agente no rompa otros usos.
    """

    def __init__(self, paso_s: float) -> None:
        self._paso_s = paso_s
        self._lecturas = 0

    def perf_counter(self) -> float:
        valor = self._lecturas * self._paso_s
        self._lecturas += 1
        return valor

    def __getattr__(self, nombre: str):
        return getattr(time, nombre)


async def test_el_reloj_corta_antes_de_que_muera_la_funcion(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El corte por tiempo evita perder la respuesta entera cuando Vercel mata
    la funcion a los 300 s. La PRIMERA ronda siempre ocurre: el presupuesto
    limita cuanto se busca, no si se responde.

    El reloj se controla a mano. Con un presupuesto real de 0.0001 s, que el
    corte saltara o no dependia de lo calientes que estuvieran las caches: el
    test pasaba aislado y fallaba al correr despues de otros, porque la ronda
    se completaba en menos de 100 us. Con PASO_S por lectura, la cuenta es
    fija: la lectura de `inicio` marca 0, la comprobacion de la primera ronda
    lee 1 x PASO_S (por debajo del presupuesto, asi que busca), y la de la
    segunda lee 3 x PASO_S o mas -- el agente cronometra cada ronda, asi que
    entre una comprobacion y la siguiente hay al menos dos lecturas mas.
    """
    PASO_S = 1.0
    PRESUPUESTO_S = 1.5  # entre 1 x PASO_S y 3 x PASO_S

    monkeypatch.setattr(agent, "time", _RelojDePasos(PASO_S))
    monkeypatch.setenv("MAX_HOPS", "0")
    monkeypatch.setenv("AGENT_BUDGET_S", str(PRESUPUESTO_S))
    get_settings.cache_clear()

    fake_openai.queue(
        make_tool_call_stream(TOOL, {"semantico": "algo"}, usage=make_usage(80, 8)),
        make_text_stream("Respondo con lo que alcance.", usage=make_usage(90, 9)),
    )
    tel = telemetry.start()

    eventos = await _correr("cualquier cosa", modo="extendido")

    assert _tipos(eventos).count("hop") == 1
    assert fake_openai.calls[0]["tool_choice"] == "auto"
    assert fake_openai.calls[1]["tool_choice"] == "none"
    rondas = [r for r in tel.rounds if r.component == "agente"]
    assert "tiempo agotado" in rondas[-1].note


# ---------------------------------------------------------------------------
# Plan de evidencia y verificación de atribución (cableados al bucle)
# ---------------------------------------------------------------------------
async def test_el_modo_extendido_planifica_y_emite_el_plan(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El plan entra como mensaje de sistema DESPUÉS del turno del usuario, para
    que el modelo lo lea como la agenda de esta pregunta."""
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()

    fake_openai.queue(
        make_json_completion(
            {
                "items": [
                    {"id": "e1", "query": "auc p-tau217", "evidence_needed": "el AUC"},
                    {"id": "e2", "query": "cohorte tamaño", "evidence_needed": "la cohorte"},
                ]
            }
        ),
        make_text_stream("Respondo.", usage=make_usage(50, 5)),
    )

    eventos = await _correr("compara ambos", modo="extendido")

    tipos = _tipos(eventos)
    assert tipos[0] == "plan"
    plan = eventos[0].data["items"]
    assert [it["id"] for it in plan] == ["e1", "e2"]
    # el checklist viaja como system, tras el mensaje del usuario
    mensajes = fake_openai.calls[1]["messages"]
    roles = [m["role"] for m in mensajes]
    assert roles[-1] == "system"
    assert "PLAN DE EVIDENCIA OBLIGATORIO" in mensajes[-1]["content"]
    assert mensajes[-2]["role"] == "user"


async def test_el_modo_normal_no_planifica(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """Normal tiene dos búsquedas y el plan le gastaría una: el perfil manda."""
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    fake_openai.queue(make_text_stream("Respondo.", usage=make_usage(50, 5)))

    eventos = await _correr("algo directo", modo="normal")

    assert "plan" not in _tipos(eventos)
    assert len(fake_openai.calls) == 1  # ni una llamada al planificador


async def test_la_verificacion_se_emite_antes_del_final(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El orden importa: los tokens ya se streamearon, así que verificar no
    retrasa nada visible, y `final` cierra después de la anotación."""
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    get_settings.cache_clear()

    fake_openai.queue(
        make_text_stream("No encuentro ese dato.", usage=make_usage(40, 4)),
    )

    eventos = await _correr("algo que no esta", modo="normal")

    tipos = _tipos(eventos)
    assert "verificacion" in tipos
    assert tipos.index("verificacion") < tipos.index("final")
    # sin citas no se gasta llamada al verificador: solo la del agente
    assert len(fake_openai.calls) == 1


async def test_revision_previa_oculta_el_borrador_y_publica_solo_la_correccion(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    monkeypatch.setenv("ENABLE_PRE_RESPONSE_REVIEW", "true")
    get_settings.cache_clear()
    borrador = "El AUC fue 0.99 sin ninguna fuente."
    correccion = "No encuentro ese dato en los documentos recuperados."
    fake_openai.queue(
        make_text_stream(borrador, usage=make_usage(40, 4)),
        make_text_completion(correccion, usage=make_usage(50, 7)),
    )
    tel = telemetry.start()

    eventos = await _correr("dame el AUC", modo="normal")

    visible = "".join(
        ev.data["text"] for ev in eventos if ev.type == "token"
    )
    assert visible == correccion
    assert borrador not in visible
    assert eventos[-1].data["content"] == correccion
    tipos = _tipos(eventos)
    assert tipos.index("sources") < tipos.index("token")
    assert tipos.index("verificacion") < tipos.index("final")
    assert fake_openai.calls[0]["stream"] is True
    assert "stream" not in fake_openai.calls[1]
    meta = tel.summary()["meta"]["verificacion"]
    assert meta["revision_previa"] is True
    assert meta["revisiones"] == 1


async def test_una_cita_inventada_queda_registrada_en_la_telemetria(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El fallo grave: la respuesta apunta a una fuente que no se recuperó. Debe
    llegar a `metrics`, que es por donde se persiste y se audita."""
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    get_settings.cache_clear()

    fake_openai.queue(
        make_text_stream(
            "El AUC fue 0.94 [fantasma.pdf, pág. 7].", usage=make_usage(40, 4)
        ),
    )
    tel = telemetry.start()

    eventos = await _correr("dame el auc", modo="normal")

    informe = next(ev for ev in eventos if ev.type == "verificacion").data
    assert informe["citas_sin_resolver"] == ["[fantasma.pdf, pág. 7]"]
    assert informe["afirmaciones"][0]["veredicto"] == "cita_no_resuelve"
    # y queda en el resumen que viaja a metrics / evals / BD
    meta = tel.summary()["meta"]["verificacion"]
    assert meta["citas_sin_resolver"] == ["[fantasma.pdf, pág. 7]"]
    assert meta["afirmaciones"] == 1


async def test_el_inventario_no_gasta_el_freno_de_busquedas_sin_avance(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """Regresión encontrada en revisión.

    `listar_documentos` devuelve `chunks=[]` por diseño: lista los documentos,
    no recupera fragmentos. Al contarlo como "búsqueda sin avance", en modo
    normal (max_hops_sin_avance=1) preguntar "¿qué documentos tienes y qué
    dicen sobre X?" gastaba el freno con el inventario y forzaba la respuesta
    final SIN haber buscado nada: el modelo tenía que responder con cero
    evidencia sobre un corpus que sí la tenía.
    """
    monkeypatch.setattr(
        agent,
        "index_inventory",
        lambda: {
            "chunks": 8, "documentos": 1,
            "archivos": [{"valor": "e.pdf", "chunks": 8}],
            "tipos": [{"valor": "pdf", "chunks": 8}],
            "idiomas": [{"valor": "es", "chunks": 8}],
        },
    )
    fake_openai.queue(
        make_tool_call_stream(INVENTARIO, {}, usage=make_usage(40, 4)),
        make_tool_call_stream(TOOL, {"semantico": "tau"}, usage=make_usage(50, 5)),
        make_text_stream("Respondo con evidencia.", usage=make_usage(60, 6)),
    )

    eventos = await _correr("que documentos tienes y que dicen de tau", modo="normal")

    # el inventario y DESPUÉS la búsqueda: dos hops, no uno cortado a medias
    assert _tipos(eventos).count("hop") == 2
    # y la búsqueda real llegó a ejecutarse con tool_choice libre
    assert fake_openai.calls[1]["tool_choice"] == "auto"
