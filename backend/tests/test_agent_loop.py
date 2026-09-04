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


@pytest.fixture(autouse=True)
def pipeline_apagado(settings_override, monkeypatch):
    """Los tests de este módulo prueban la MECÁNICA del bucle antiguo (rondas,
    kwargs, repeticiones, topes) y son el contrato del rollback operativo:
    con `enable_evidence_pipeline=false` todo esto debe seguir igual. Los
    tests del pipeline (más abajo) lo encienden explícitamente."""
    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


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


# ---------------------------------------------------------------------------
# Pipeline de evidencia (enable_evidence_pipeline=true)
# ---------------------------------------------------------------------------
from app.models import Chunk  # noqa: E402
from app.services import evidencia, planner, revisor  # noqa: E402


def _chunk_de(item_id: str, n: int, doc: str = "a.pdf") -> Chunk:
    return Chunk(
        id=f"{item_id}-c{n}", text=f"evidencia {item_id} {n}", source_file=doc,
        page=n, document_type="pdf", section="Results",
    )


def _punto(
    item: planner.PlanItem, chunks: list[Chunk], relevancia: bool = True
) -> evidencia.PuntoEvidencia:
    return evidencia.PuntoEvidencia(
        id=item.id, query=item.query, query_en=item.query_en,
        evidence_needed=item.evidence_needed, fragmentos=list(chunks),
        documentos_revisados=[c.fuente() for c in chunks] or ["revisado.pdf"],
        estado="cubierto" if chunks else "sin_resultados",
        relevancia_verificada=relevancia, recuperacion="hybrid", ms=1.5,
        grados={c.id: "directa" for c in chunks}, n_candidatos=len(chunks) or 3,
    )


def _evidencia_de(puntos: list[evidencia.PuntoEvidencia]) -> evidencia.EvidenciaPlan:
    ev = evidencia.EvidenciaPlan(puntos=puntos)
    for p in puntos:
        for c in p.fragmentos:
            ev.mapa.setdefault(c.id, set()).add(p.id)
            ev.acumulado.setdefault(c.id, c)
            ev.grados.setdefault(c.id, p.grados.get(c.id, ""))
    return ev


@pytest.fixture
def pipeline_encendido(settings_override, monkeypatch):
    """Enciende el pipeline y sustituye sus dos entradas a Qdrant por falsos
    controlables: `ejecutar_plan` fabrica un punto por item del plan (por
    defecto, un fragmento cada uno; `estado["sin"]` deja ids sin resultados)
    y `buscar_y_calificar` registra las búsquedas extra."""
    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", "true")
    get_settings.cache_clear()
    estado: dict = {"planes": [], "sin": set(), "extra": [], "extra_chunks": [], "deadlines": []}

    async def _ejecutar_plan(plan, perfil, filtros, deadline_monotonic=None):
        estado["planes"].append(list(plan))
        estado["deadlines"].append(deadline_monotonic)
        puntos = [
            _punto(it, [] if it.id in estado["sin"] else [_chunk_de(it.id, i + 1)])
            for i, it in enumerate(plan)
        ]
        return _evidencia_de(puntos)

    async def _buscar_y_calificar(query, evidence_needed, punto, perfil, filtros=None):
        estado["extra"].append({"query": query, "punto": punto, "evidence_needed": evidence_needed})
        item = planner.PlanItem(punto or evidencia.EXTRA, query, evidence_needed)
        return _punto(item, list(estado["extra_chunks"]))

    monkeypatch.setattr(evidencia, "ejecutar_plan", _ejecutar_plan)
    monkeypatch.setattr(evidencia, "buscar_y_calificar", _buscar_y_calificar)
    return estado


def _plan_json(*pares: tuple[str, str]) -> dict:
    return {
        "items": [
            {"query": q, "query_en": f"{q} en", "evidence_needed": e} for q, e in pares
        ]
    }


async def test_con_pipeline_los_hops_son_el_plan_mas_extras_acotadas(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    """La medida contra la variación: el plan lo ejecuta código y el modelo
    solo puede añadir `max_hops_extra` búsquedas (2 en extendido). El modelo
    de este test insiste en buscar y se le corta con tool_choice none."""
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    fake_openai.queue(
        make_json_completion(_plan_json(("auc p-tau217", "el AUC"), ("cohorte", "la cohorte"))),
        make_tool_call_stream(TOOL, {"semantico": "extra uno", "punto": "e1"}, call_id="x1", usage=make_usage(80, 8)),
        make_tool_call_stream(TOOL, {"semantico": "extra dos"}, call_id="x2", usage=make_usage(80, 8)),
        # Tercera petición de búsqueda: no llega a existir, la ronda ya va forzada.
        make_text_stream("Respuesta [a.pdf, pág. 2].", usage=make_usage(90, 9)),
    )
    tel = telemetry.start()

    eventos = await _correr("compara p-tau217 entre cohortes", modo="extendido")

    tipos = _tipos(eventos)
    assert tipos[0] == "plan"
    assert tipos.count("hop") == 3 + modos_extra("extendido")
    assert eventos[-1].type == "final"
    # El planificador usa el modelo grande con razonamiento alto y JSON.
    planificador = fake_openai.calls[0]
    assert planificador["model"] == settings_override.openai_model
    assert planificador["reasoning_effort"] == settings_override.planner_reasoning_effort
    assert planificador["response_format"] == {"type": "json_object"}
    # Rondas del agente: dos con herramienta libre, la tercera forzada.
    assert [c["tool_choice"] for c in fake_openai.calls[1:]] == ["auto", "auto", "none"]
    assert "tope de 2 búsquedas extra" in fake_openai.calls[3]["messages"][-1]["content"]
    # La herramienta lleva el parámetro `punto` y se describe como excepción.
    tool = fake_openai.calls[1]["tools"][0]["function"]
    assert "punto" in tool["parameters"]["properties"]
    assert "EXTRA" in tool["description"]
    # Contadores: plan y extra por separado.
    assert tel.counters["hops_plan"] == 3
    assert tel.counters["hops_extra"] == 2
    assert tel.counters["hops"] == 5
    assert len(tel.meta["huella_evidencia"]) == 64
    # La extra que dice rellenar e1 queda trazada a e1; la otra, a "extra".
    assert [x["punto"] for x in pipeline_encendido["extra"]] == ["e1", ""]
    assert pipeline_encendido["extra"][0]["evidence_needed"] == "el AUC"
    assert pipeline_encendido["extra"][1]["evidence_needed"] == "extra dos"


def modos_extra(nombre: str) -> int:
    from app.services import modos

    return modos.resolver(nombre, get_settings()).max_hops_extra


async def test_el_evento_plan_va_antes_del_primer_hop_y_los_hops_traen_el_contrato(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    pipeline_encendido["sin"] = {"e2"}
    fake_openai.queue(
        make_json_completion(_plan_json(("uno", "dato uno"), ("dos", "dato dos"))),
        make_text_stream("Listo.", usage=make_usage(10, 1)),
    )

    eventos = await _correr("pregunta", modo="extendido")

    plan = eventos[0]
    assert plan.type == "plan"
    assert plan.data["items"] == [
        {"id": "e0", "query": "pregunta", "query_en": "",
         "evidence_needed": planner.ANCLA_EVIDENCE_NEEDED},
        {"id": "e1", "query": "uno", "query_en": "uno en", "evidence_needed": "dato uno"},
        {"id": "e2", "query": "dos", "query_en": "dos en", "evidence_needed": "dato dos"},
    ]
    hops = [ev.data for ev in eventos if ev.type == "hop"]
    assert [h["n"] for h in hops] == [1, 2, 3]
    assert set(hops[0]) >= {
        "n", "query", "origen", "plan_item", "evidence_needed", "resultados",
        "documentos", "estado", "recuperacion", "relevancia_verificada", "ms",
    }
    assert [h["origen"] for h in hops] == ["plan"] * 3
    assert [h["plan_item"] for h in hops] == ["e0", "e1", "e2"]
    assert hops[1] == {
        "n": 2, "query": "uno", "origen": "plan", "plan_item": "e1",
        "evidence_needed": "dato uno", "resultados": 1, "documentos": ["a.pdf"],
        "estado": "cubierto", "recuperacion": "hybrid", "relevancia_verificada": True,
        "ms": 1.5,
        # enriquecido en el final (mismo objeto): sin verificación, nadie citó
        "estado_final": "evidencia_no_usada", "usado_en_respuesta": False,
    }
    assert hops[2]["estado"] == "sin_resultados"
    assert hops[2]["documentos"] == ["revisado.pdf"]
    assert hops[2]["resultados"] == 0
    # El orden de los eventos: plan, hops del plan, y solo después la ronda.
    assert _tipos(eventos)[:4] == ["plan", "hop", "hop", "hop"]


async def test_el_final_enriquece_los_hops_del_plan_con_cobertura(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    """Los hops se persisten como JSON con el mensaje: `estado_final` y
    `usado_en_respuesta` permiten reconstruir la cobertura de un mensaje
    antiguo sin migración. Sin verificador, "usado" es que la cita literal
    del fragmento aparece en la respuesta."""
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    pipeline_encendido["sin"] = {"e2"}
    fake_openai.queue(
        make_json_completion(_plan_json(("uno", "dato uno"), ("dos", "dato dos"))),
        # cita el fragmento de e1 (página 2) y no el de e0 (página 1)
        make_text_stream("El dato es 0.94 [a.pdf, pág. 2].", usage=make_usage(10, 1)),
    )
    tel = telemetry.start()

    eventos = await _correr("pregunta", modo="extendido")

    final = eventos[-1].data
    por_id = {h["plan_item"]: h for h in final["hops"]}
    assert (por_id["e0"]["estado_final"], por_id["e0"]["usado_en_respuesta"]) == ("evidencia_no_usada", False)
    assert (por_id["e1"]["estado_final"], por_id["e1"]["usado_en_respuesta"]) == ("cubierto", True)
    assert (por_id["e2"]["estado_final"], por_id["e2"]["usado_en_respuesta"]) == ("sin_resultados", False)
    assert tel.counters["puntos_sin_resultados"] == 1
    assert tel.counters["puntos_no_usados"] == 1
    assert tel.meta["cobertura"] == []  # sin verificador no hay informe
    # Las fuentes llevan su punto y su grado.
    fuentes = {f["snippet"]: f for f in final["sources"]}
    assert fuentes["evidencia e1 2"]["plan_items"] == ["e1"]
    assert fuentes["evidencia e1 2"]["grado"] == "directa"


async def test_con_verificador_la_cobertura_manda_sobre_la_heuristica(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    """Cuando el informe trae `cobertura` (contrato D), el estado final de
    cada hop sale de ahí, y una afirmación sostenida marca sus fragmentos
    como usados aunque el texto haya sido corregido."""
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    get_settings.cache_clear()
    from app.services import verificador

    capturado: dict = {}

    async def _verificar(answer, chunks, evidencia_requerida=None, mapa_plan=None):
        capturado["mapa_plan"] = mapa_plan
        capturado["requerida"] = evidencia_requerida
        return verificador.Verificacion(
            afirmaciones=[
                verificador.Afirmacion(
                    texto="x", cita="[a.pdf, pág. 1]", veredicto=verificador.SOSTENIDA,
                    fragmento_id="[a.pdf, pág. 1]", fragmentos=["e0-c1"],
                )
            ],
            cobertura=[
                {"id": "e1", "evidence_needed": "dato uno", "estado": "parcial",
                 "n_fragmentos": 1, "documentos": ["a.pdf"], "afirmaciones": [0]},
            ],
        )

    monkeypatch.setattr(verificador, "verificar", _verificar)
    fake_openai.queue(
        make_json_completion(_plan_json(("uno", "dato uno"))),
        make_text_stream("Texto sin citas literales.", usage=make_usage(10, 1)),
    )
    tel = telemetry.start()

    eventos = await _correr("pregunta", modo="extendido")

    assert capturado["mapa_plan"] == {"e0-c1": {"e0"}, "e1-c2": {"e1"}}
    assert set(capturado["requerida"]) == {"e0", "e1"}
    por_id = {h["plan_item"]: h for h in eventos[-1].data["hops"]}
    assert por_id["e1"]["estado_final"] == "parcial"
    assert por_id["e1"]["usado_en_respuesta"] is True
    # e0 no está en cobertura (el contrato lo excluye): se reconstruye desde
    # las afirmaciones sostenidas, que sí citan su fragmento.
    assert por_id["e0"]["estado_final"] == "cubierto"
    assert por_id["e0"]["usado_en_respuesta"] is True
    assert tel.meta["cobertura"][0]["id"] == "e1"


async def test_el_modo_normal_ejecuta_e0_sin_llamar_al_planner(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    fake_openai.queue(make_text_stream("Respondo.", usage=make_usage(10, 1)))

    eventos = await _correr("algo directo", modo="normal")

    assert len(fake_openai.calls) == 1  # ni una llamada al planificador
    assert eventos[0].type == "plan"
    assert [it["id"] for it in eventos[0].data["items"]] == ["e0"]
    assert eventos[0].data["items"][0]["query"] == "algo directo"
    assert _tipos(eventos).count("hop") == 1
    assert [it.id for it in pipeline_encendido["planes"][0]] == ["e0"]
    # La evidencia entra como una tool call sintética tras el usuario, sin
    # mensaje de estructura (un solo punto no tiene partes).
    mensajes = fake_openai.calls[0]["messages"]
    assert mensajes[2] == {"role": "user", "content": "algo directo"}
    assert mensajes[3]["role"] == "assistant"
    assert mensajes[3]["tool_calls"][0]["id"] == "call_plan_e0"
    assert mensajes[4]["role"] == "tool" and mensajes[4]["tool_call_id"] == "call_plan_e0"
    assert mensajes[4]["content"].startswith("PUNTO e0 (")
    assert len(mensajes) == 5


async def test_planner_caido_deja_el_plan_en_e0_sin_checklist_obligatorio(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    fake_openai.queue(
        RuntimeError("planner caído"),
        make_text_stream("Respondo.", usage=make_usage(10, 1)),
    )
    tel = telemetry.start()

    eventos = await _correr("compara ambos", modo="extendido")

    assert [it["id"] for it in eventos[0].data["items"]] == ["e0"]
    assert _tipos(eventos).count("hop") == 1
    todo = json.dumps(fake_openai.calls[1]["messages"], ensure_ascii=False)
    assert "PLAN DE EVIDENCIA OBLIGATORIO" not in todo
    assert "ESTRUCTURA DE LA RESPUESTA" not in todo
    assert "call_plan_e0" in todo
    fallo = [r for r in tel.rounds if r.component == "planner"]
    assert len(fallo) == 1 and fallo[0].ok is False


async def test_con_plan_de_varios_puntos_va_la_estructura_tras_la_evidencia(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    get_settings.cache_clear()
    fake_openai.queue(
        make_json_completion(_plan_json(("uno", "dato uno"), ("dos", "dato dos"))),
        make_text_stream("Respondo.", usage=make_usage(10, 1)),
    )

    await _correr("pregunta", modo="extendido")

    mensajes = fake_openai.calls[1]["messages"]
    roles = [m["role"] for m in mensajes]
    assert roles == ["system", "system", "user", "assistant", "tool", "tool", "tool", "system"]
    estructura = mensajes[-1]["content"]
    assert estructura.startswith("ESTRUCTURA DE LA RESPUESTA")
    assert "- dato uno" in estructura and "- dato dos" in estructura
    assert "e0" not in estructura and "PLAN DE EVIDENCIA OBLIGATORIO" not in estructura
    # El historial le llega al planificador para las repreguntas.
    fake_openai.calls.clear()
    fake_openai.queue(
        make_json_completion(_plan_json(("otra", "dato"))),
        make_text_stream("Respondo.", usage=make_usage(10, 1)),
    )
    await _correr(
        "y en la otra cohorte?", history=[
            {"role": "user", "content": "AUC de p-tau217"},
            {"role": "assistant", "content": "0.94 en la cohorte clínica"},
        ], modo="extendido",
    )
    peticion = fake_openai.calls[0]["messages"][-1]["content"]
    assert "Historial reciente" in peticion
    assert "AUC de p-tau217" in peticion and "y en la otra cohorte?" in peticion


async def test_repetir_una_consulta_del_plan_no_gasta_una_extra(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    """Las consultas del plan cuentan como ya ejecutadas: si el modelo pide la
    misma con la herramienta (aunque añada `punto`), recibe el aviso de
    repetición y no consume su presupuesto de extras."""
    fake_openai.queue(
        make_tool_call_stream(TOOL, {"semantico": "algo directo", "punto": "e0"}, call_id="r1", usage=make_usage(80, 8)),
        make_tool_call_stream(TOOL, {"semantico": "otra cosa"}, call_id="r2", usage=make_usage(80, 8)),
        make_text_stream("Respondo.", usage=make_usage(10, 1)),
    )
    tel = telemetry.start()

    eventos = await _correr("algo directo", modo="normal")

    assert tel.counters.get("llamadas_repetidas") == 1
    assert tel.counters.get("hops_extra") == 1
    assert _tipos(eventos).count("hop") == 2  # e0 + la extra real
    assert [x["query"] for x in pipeline_encendido["extra"]] == ["otra cosa"]
    tools_ronda3 = _mensajes_tool(fake_openai.calls[2])
    assert "IDÉNTICA" in tools_ronda3[-2]["content"]
    assert tools_ronda3[-1]["content"].startswith("BÚSQUEDA EXTRA (otra cosa): sin resultados")
    # Y tras agotar la única extra del modo normal, la siguiente ronda va forzada.
    assert fake_openai.calls[2]["tool_choice"] == "none"


async def test_la_extra_que_trae_evidencia_queda_trazada_y_en_las_fuentes(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    pipeline_encendido["extra_chunks"] = [_chunk_de("x", 7, doc="b.pdf")]
    fake_openai.queue(
        make_tool_call_stream(TOOL, {"semantico": "b", "punto": "e0"}, call_id="r1", usage=make_usage(80, 8)),
        make_text_stream("Respondo [b.pdf, pág. 7].", usage=make_usage(10, 1)),
    )

    eventos = await _correr("pregunta", modo="normal")

    hops = [ev.data for ev in eventos if ev.type == "hop"]
    extra = hops[1]
    assert extra["origen"] == "extra" and extra["plan_item"] == "e0"
    assert extra["resultados"] == 1 and extra["documentos"] == ["b.pdf"]
    assert extra["estado"] == "cubierto" and extra["nuevos"] == 1
    assert "estado_final" not in extra  # solo los hops del plan se enriquecen
    fuentes = {f["source_file"]: f for f in eventos[-1].data["sources"]}
    assert fuentes["b.pdf"]["plan_items"] == ["e0"]
    assert fuentes["b.pdf"]["grado"] == "directa"
    # e0 se da por usado porque la respuesta cita evidencia trazada a e0.
    assert hops[0]["usado_en_respuesta"] is True


async def test_la_revision_recibe_el_mapa_y_el_tiempo_que_queda(
    settings_override, fake_openai, pipeline_encendido, monkeypatch
):
    """Contrato G: un reloj por pregunta. La revisión recibe (budget_s +
    margen) - transcurrido, nunca más de 270 s en total."""
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    monkeypatch.setenv("ENABLE_PRE_RESPONSE_REVIEW", "true")
    get_settings.cache_clear()
    from app.services import verificador

    capturado: dict = {}

    async def _revisar(pregunta, borrador, mensajes, chunks, evidencia_requerida=None,
                       mapa_plan=None, tiempo_disponible_s=None):
        capturado.update(mapa_plan=mapa_plan, tiempo=tiempo_disponible_s, requerida=evidencia_requerida)
        return revisor.ResultadoRevision(borrador, verificador.Verificacion())

    monkeypatch.setattr(revisor, "revisar_antes_de_publicar", _revisar)
    fake_openai.queue(make_text_stream("Borrador.", usage=make_usage(10, 1)))

    await _correr("pregunta", modo="normal")

    assert capturado["mapa_plan"] == {"e0-c1": {"e0"}}
    assert capturado["requerida"] == {"e0": planner.ANCLA_EVIDENCE_NEEDED}
    s = get_settings()
    from app.services import modos

    tope = modos.NORMAL.budget_s + s.pre_response_review_timeout_s
    assert tope - 5 < capturado["tiempo"] <= tope
    assert capturado["tiempo"] <= 270.0
    # Y el pipeline recibió un deadline del mismo reloj.
    assert pipeline_encendido["deadlines"][0] is not None


async def test_con_el_pipeline_apagado_no_se_ejecuta_ningun_plan(
    settings_override, fake_openai, catalogo_falso, monkeypatch
):
    """El rollback: con el interruptor en false ni se llama a `ejecutar_plan`
    ni cambia el prompt. El resto de este módulo (arriba) es la prueba de que
    el bucle antiguo sigue igual."""
    llamado = []

    async def _no(*a, **k):
        llamado.append(True)
        raise AssertionError("no debía ejecutarse")

    monkeypatch.setattr(evidencia, "ejecutar_plan", _no)
    fake_openai.queue(make_text_stream("ok", usage=make_usage(10, 1)))

    eventos = await _correr("hola", modo="normal")

    assert llamado == []
    assert _tipos(eventos) == ["sources", "token", "final"]
    assert fake_openai.calls[0]["messages"][0]["content"] == agent.SYSTEM_PROMPT_LEGACY
    assert "punto" not in fake_openai.calls[0]["tools"][0]["function"]["parameters"]["properties"]


# ---------------------------------------------------------------------------
# Planificador (post-proceso determinista)
# ---------------------------------------------------------------------------
async def test_el_planner_deduplica_renumera_y_acota(settings_override, fake_openai):
    fake_openai.queue(
        make_json_completion({
            "items": [
                {"id": "e7", "query": "AUC p-tau217", "query_en": "AUC p-tau217", "evidence_needed": "el AUC"},
                {"id": "e1", "query": "auc  P-TAU217", "evidence_needed": "repetida"},
                {"query": "", "evidence_needed": "sin consulta"},
                "basura",
                {"query": "cohorte", "query_en": "cohort", "evidence_needed": ""},
                {"query": "una pregunta literal", "evidence_needed": "igual que e0"},
                {"query": "sobra", "evidence_needed": "por el tope"},
            ]
        })
    )
    items = await planner.plan_question("una pregunta literal", max_items=3)

    # El tope cuenta items VÁLIDOS (los repetidos, vacíos o iguales a la
    # pregunta no gastan hueco), y los ids salen por posición, no del modelo.
    assert [(it.id, it.query, it.query_en) for it in items] == [
        ("e1", "AUC p-tau217", ""),  # query_en igual a query se vacía
        ("e2", "cohorte", "cohort"),
        ("e3", "sobra", ""),
    ]
    assert items[1].evidence_needed == "evidencia para esta subpregunta"

    fake_openai.queue(
        make_json_completion({"items": [{"query": f"q{i}", "evidence_needed": "d"} for i in range(6)]})
    )
    assert [it.id for it in await planner.plan_question("p", max_items=4)] == ["e1", "e2", "e3", "e4"]


async def test_el_planner_falla_a_lista_vacia_y_con_ancla_pone_e0(settings_override, fake_openai):
    fake_openai.queue(make_json_completion({"items": "no es lista"}))
    assert await planner.plan_question("p") == []
    fake_openai.queue(make_json_completion({"items": []}))
    assert await planner.plan_question("p") == []
    fake_openai.queue(RuntimeError("caído"))
    assert await planner.plan_question("p") == []

    plan = planner.con_ancla("  Pregunta literal ", [])
    assert [(it.id, it.query) for it in plan] == [("e0", "Pregunta literal")]
    assert plan[0].evidence_needed == planner.ANCLA_EVIDENCE_NEEDED

    # Un item equivalente al ancla se descarta y el resto se renumera.
    items = [
        planner.PlanItem("e1", "pregunta  LITERAL", "dup"),
        planner.PlanItem("e2", "otra", "d2", query_en="other"),
        planner.PlanItem("e3", "otra", "d3"),
    ]
    plan = planner.con_ancla("Pregunta literal", items)
    assert [(it.id, it.query, it.query_en) for it in plan] == [
        ("e0", "Pregunta literal", ""), ("e1", "otra", "other"),
    ]
    assert planner.format_checklist(plan[:1]) == ""
    assert "- d2" in planner.format_checklist(plan)


# ---------------------------------------------------------------------------
# De punta a punta: agente + planner + evidencia + verificador reales, con
# Qdrant y OpenAI falsos. Es la prueba de que las piezas encajan entre sí, no
# solo con sus dobles.
# ---------------------------------------------------------------------------
async def test_punta_a_punta_con_el_pipeline_real_y_los_falsos(
    settings_override, fake_openai, fake_qdrant, monkeypatch
):
    import types

    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", "true")
    monkeypatch.setenv("ENABLE_QUERY_PLANNING", "true")
    monkeypatch.setenv("ENABLE_ANSWER_VERIFICATION", "true")
    monkeypatch.setenv("ENABLE_PRE_RESPONSE_REVIEW", "true")
    get_settings.cache_clear()

    def _point(id, doc, page, text, section="Results"):
        return types.SimpleNamespace(
            id=id, score=0.5,
            payload={"text": text, "source_file": doc, "page": page, "section": section,
                     "document_type": "pdf", "chunk_type": "text"},
        )

    puntos = [
        _point("c1", "a.pdf", 3, "El AUC de p-tau217 fue 0.94 en la cohorte clínica."),
        _point("c2", "b.pdf", 5, "El AUC fue 0.91 en la cohorte de validación."),
        _point("c3", "a.pdf", 9, "Smith J, et al. 2021.", section="References"),
    ]
    fake_qdrant.set_response("query_points", lambda kw: types.SimpleNamespace(points=list(puntos)))

    respuesta = "El AUC fue 0.94 [a.pdf, pág. 3]."
    fake_openai.queue(
        # planner (1 item con query_en -> e1 lanza dos búsquedas)
        make_json_completion(_plan_json(("AUC en la validación", "AUC de validación"))),
        # calificador pointwise (reranker.calificar_evidencia), una llamada por
        # punto, en paralelo: dos candidatos tras podar la bibliografía
        make_json_completion({"fragmentos": [{"i": 0, "grado": "directa"}, {"i": 1, "grado": "parcial"}]}),
        make_json_completion({"fragmentos": [{"i": 0, "grado": "directa"}, {"i": 1, "grado": "parcial"}]}),
        # redactor
        make_text_stream(respuesta, usage=make_usage(300, 30)),
        # verificador: una afirmación, sostenida
        make_json_completion({"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "ok"}]}),
    )
    tel = telemetry.start()

    eventos = await _correr("¿Cuál es el AUC de p-tau217?", modo="extendido")

    tipos = _tipos(eventos)
    assert tipos[:3] == ["plan", "hop", "hop"]
    assert tipos[-1] == "final"
    assert "verificacion" in tipos and tipos.index("verificacion") < tipos.index("final")
    assert fake_openai.pending == 0  # se consumió exactamente lo previsto

    final = eventos[-1].data
    assert final["content"] == respuesta
    # Dos documentos en las fuentes, la bibliografía fuera, cada fuente con
    # sus puntos (los dos puntos recuperaron lo mismo) y su grado.
    fuentes = {f["source_file"]: f for f in final["sources"]}
    assert set(fuentes) == {"a.pdf", "b.pdf"}
    assert fuentes["a.pdf"]["plan_items"] == ["e0", "e1"]
    assert fuentes["a.pdf"]["grado"] == "directa"
    assert fuentes["b.pdf"]["grado"] == "parcial"
    # Hops del plan enriquecidos: la respuesta citó a.pdf pág. 3 (c1), que
    # ambos puntos trajeron, así que ambos quedan cubiertos y usados.
    for hop in final["hops"]:
        assert hop["origen"] == "plan"
        assert hop["estado"] == "cubierto"
        assert hop["recuperacion"] == "dense"  # BM25 desactivado en tests
        assert hop["relevancia_verificada"] is True
        assert hop["estado_final"] == "cubierto" and hop["usado_en_respuesta"] is True
    # 3 búsquedas a Qdrant: e0 una, e1 dos (query y query_en).
    assert len(fake_qdrant.calls_to("query_points")) == 3
    # El mensaje del punto que vio el redactor lleva la cabecera y las citas.
    tools = _mensajes_tool(fake_openai.calls[3])
    assert tools[0]["content"].startswith("PUNTO e0 (")
    assert "cubierto, 2 fragmentos de: a.pdf; b.pdf" in tools[0]["content"]
    assert "cita: [a.pdf, pág. 3]" in tools[0]["content"]
    assert "Smith J" not in tools[0]["content"]
    # Telemetría de la pregunta.
    assert tel.counters["hops_plan"] == 2 and "hops_extra" not in tel.counters
    assert len(tel.meta["huella_evidencia"]) == 64
    assert tel.meta["verificacion"]["sostenidas"] == 1
    assert tel.meta["verificacion"]["revision_previa"] is True
