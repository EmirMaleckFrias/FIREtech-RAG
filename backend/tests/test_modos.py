"""Los dos modos de pensamiento.

Lo que se prueba no es solo que cada modo tenga sus numeros, sino la promesa
que los separa: cambian cuanto se BUSCA y se DELIBERA, nunca cuanta verdad se
exige. Un modo rapido que ademas mienta no sirve de nada.
"""
from __future__ import annotations

import pytest

from app.config import get_settings
from app.services import agent, evidencia, modos, telemetry
from app.services.agent import AgentEvent, run_agent
from tests.conftest import make_text_stream, make_tool_call_stream, make_usage

TOOL = "buscar_documentos"


@pytest.fixture(autouse=True)
def pipeline_apagado(settings_override, monkeypatch):
    """Estos tests fijan la conducta de los modos en el bucle antiguo (el
    rollback): topes de búsquedas, fragmentos por búsqueda, razonamiento. El
    pipeline de evidencia se prueba en test_agent_loop.py y test_evidencia.py;
    aquí se apaga para que la secuencia de llamadas en cola siga siendo la de
    siempre. Los tests que comparan los dos bucles lo encienden a mano."""
    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def busqueda_falsa(monkeypatch):
    """Sustituye la busqueda y registra con cuantos fragmentos se la llamo."""
    llamadas: list[dict] = []

    async def _stub(args: dict, fragmentos: int | None = None):
        llamadas.append({"args": dict(args), "fragmentos": fragmentos})
        return [], "sin resultados"

    monkeypatch.setattr(agent, "_execute_document_search", _stub)
    return llamadas


async def _correr(mensaje: str, modo: str | None) -> list[AgentEvent]:
    return [ev async for ev in run_agent(mensaje, [], modo)]


# --- resolucion del modo ----------------------------------------------------
def test_el_default_es_normal():
    assert modos.resolver(None) is modos.NORMAL
    assert modos.resolver("") is modos.NORMAL


def test_un_modo_desconocido_cae_al_normal_sin_romper():
    """Un nombre invalido no debe tumbar la pregunta del usuario."""
    assert modos.resolver("turbo") is modos.NORMAL
    assert modos.resolver("EXTENDIDO") is modos.EXTENDIDO
    assert modos.resolver(" extendido ") is modos.EXTENDIDO


def test_el_extendido_busca_mas_y_delibera_mas():
    assert modos.EXTENDIDO.max_hops == 0  # sin tope (bucle antiguo)
    assert modos.NORMAL.max_hops > 0
    assert modos.EXTENDIDO.budget_s > modos.NORMAL.budget_s
    assert modos.EXTENDIDO.fragmentos > modos.NORMAL.fragmentos


def test_las_busquedas_extra_del_pipeline_son_un_tope_duro_por_modo():
    """Con el pipeline la evidencia del plan ya está; lo que el modelo puede
    pedir ADEMÁS es una en normal y dos en extendido. Medido antes de acotar:
    6-10 búsquedas para la misma pregunta y fidelidad 0.33-1.00."""
    assert modos.NORMAL.max_hops_extra == 1
    assert modos.EXTENDIDO.max_hops_extra == 2
    assert "UNA búsqueda extra" in modos.NORMAL.instruccion
    assert "hasta dos búsquedas extra" in modos.EXTENDIDO.instruccion
    # La coda del bucle antiguo sigue hablando de decidir qué buscar.
    assert "dos como máximo" in modos.NORMAL.instruccion_legacy
    assert "no hay tope de búsquedas" in modos.EXTENDIDO.instruccion_legacy


def test_el_techo_del_operador_tambien_acota_las_busquedas_extra():
    class _Topes:
        max_hops = 1
        agent_budget_s = 0.0
        agent_max_hops_sin_avance = 0

    assert modos.resolver("extendido", _Topes()).max_hops_extra == 1
    assert modos.resolver("normal", _Topes()).max_hops_extra == 1

    class _Sueltos:
        max_hops = 99
        agent_budget_s = 0.0
        agent_max_hops_sin_avance = 0

    # Solo aprieta: 99 no convierte una extra en 99.
    assert modos.resolver("normal", _Sueltos()).max_hops_extra == 1
    assert modos.resolver("extendido", _Sueltos()).max_hops_extra == 2

    class _SinTope:
        max_hops = 0
        agent_budget_s = 0.0
        agent_max_hops_sin_avance = 0

    assert modos.resolver("extendido", _SinTope()).max_hops_extra == 2


# --- lo que NO cambia entre modos -------------------------------------------
@pytest.mark.parametrize("pipeline", ["true", "false"])
async def test_las_reglas_de_fidelidad_son_las_mismas_en_los_dos(
    settings_override, fake_openai, busqueda_falsa, monkeypatch, pipeline
):
    """La promesa del diseno: el modo rapido no es un modo laxo.

    Los dos parten del MISMO system prompt; el modo solo anade su instruccion
    de cuanto trabajar. Vale para los dos bucles: con el pipeline encendido
    el prompt es v4 (`SYSTEM_PROMPT`) y con el rollback es el v3
    (`SYSTEM_PROMPT_LEGACY`); en ninguno de los dos el modo toca el prefijo.
    """
    monkeypatch.setenv("ENABLE_EVIDENCE_PIPELINE", pipeline)
    get_settings.cache_clear()
    if pipeline == "true":
        # El pipeline ejecuta e0 antes de la primera ronda: sin índice, el
        # punto queda sin resultados y no hace falta Qdrant.
        async def _vacio(query, filters, top_k):
            return []

        monkeypatch.setattr(evidencia, "hybrid_search", _vacio)

    async def _prompts(modo: str) -> list[dict]:
        fake_openai.queue(make_text_stream("Respuesta.", usage=make_usage(10, 2)))
        await _correr("una pregunta", modo)
        return fake_openai.calls[-1]["messages"]

    normales = await _prompts("normal")
    extendidos = await _prompts("extendido")

    assert normales[0] == extendidos[0]  # mismo prompt base, palabra por palabra
    esperado = agent.SYSTEM_PROMPT if pipeline == "true" else agent.SYSTEM_PROMPT_LEGACY
    assert normales[0]["content"] == esperado
    # Y el prompt base es el que exige citar y no inventar.
    assert "TODA afirmación factual debe llevar su cita" in normales[0]["content"]
    # La instruccion del modo va aparte, para no romper la cache del prefijo.
    assert normales[1]["content"] != extendidos[1]["content"]
    assert "pensamiento normal" in normales[1]["content"]
    assert "pensamiento extendido" in extendidos[1]["content"]
    if pipeline == "true":
        assert normales[1]["content"] == modos.NORMAL.instruccion
    else:
        assert normales[1]["content"] == modos.NORMAL.instruccion_legacy


# --- comportamiento del bucle ------------------------------------------------
async def test_el_normal_se_planta_en_dos_busquedas(
    settings_override, fake_openai, busqueda_falsa, monkeypatch
):
    monkeypatch.setenv("MAX_HOPS", "0")  # el modo manda sobre la variable
    get_settings.cache_clear()

    for i in range(5):
        fake_openai.queue(
            make_tool_call_stream(TOOL, {"semantico": f"q{i}"}, usage=make_usage(80, 8))
        )
    fake_openai.queue(make_text_stream("Con lo que hay.", usage=make_usage(90, 9)))

    eventos = await _correr("pregunta directa", "normal")

    # Dos como maximo: en normal se responde, no se explora.
    assert [ev.type for ev in eventos].count("hop") <= modos.NORMAL.max_hops
    assert eventos[-1].type == "final"


async def test_el_extendido_no_para_por_una_cuenta_sino_por_falta_de_avance(
    settings_override, fake_openai, busqueda_falsa, monkeypatch
):
    """Sin tope de despliegue, al extendido lo frena no encontrar nada nuevo."""
    monkeypatch.setenv("MAX_HOPS", "0")
    get_settings.cache_clear()

    for i in range(8):
        fake_openai.queue(
            make_tool_call_stream(TOOL, {"semantico": f"q{i}"}, usage=make_usage(80, 8))
        )
    fake_openai.queue(make_text_stream("Respuesta larga.", usage=make_usage(90, 9)))

    eventos = await _correr("pregunta compleja", "extendido")

    assert [ev.type for ev in eventos].count("hop") == modos.EXTENDIDO.max_hops_sin_avance


async def test_el_tope_del_despliegue_aprieta_pero_no_suelta(settings_override):
    """Las variables de entorno son el techo de quien opera: solo pueden
    apretar el perfil del modo, nunca aflojarlo.

    Sin esto, un MAX_HOPS alto convertiria el modo normal en extendido sin que
    nadie lo pidiera, y el usuario que eligio "normal" pagaria de mas.
    """
    class _Topes:
        max_hops = 1
        agent_budget_s = 30.0
        agent_max_hops_sin_avance = 0

    apretado = modos.resolver("extendido", _Topes())
    assert apretado.max_hops == 1  # el 0 del modo (sin limite) cede ante el techo
    assert apretado.budget_s == 30.0
    assert apretado.max_hops_sin_avance == modos.EXTENDIDO.max_hops_sin_avance

    class _Sueltos:
        max_hops = 99
        agent_budget_s = 9999.0
        agent_max_hops_sin_avance = 99

    normal = modos.resolver("normal", _Sueltos())
    assert normal.max_hops == modos.NORMAL.max_hops
    assert normal.budget_s == modos.NORMAL.budget_s


async def test_cada_modo_pide_sus_fragmentos_por_busqueda(
    settings_override, fake_openai, busqueda_falsa
):
    for modo, esperado in (("normal", modos.NORMAL), ("extendido", modos.EXTENDIDO)):
        fake_openai.queue(
            make_tool_call_stream(TOOL, {"semantico": "x"}, usage=make_usage(80, 8)),
            make_text_stream("Listo.", usage=make_usage(90, 9)),
        )
        await _correr("pregunta", modo)
        assert busqueda_falsa[-1]["fragmentos"] == esperado.fragmentos


async def test_cada_modo_manda_su_esfuerzo_de_razonamiento(
    settings_override, fake_openai, busqueda_falsa
):
    """Hasta el 4 sep 2026 ningún modo razonaba: una nota del 2 sep decía que
    la API rechazaba reasoning_effort junto a tools y se apagó. Medido de
    nuevo contra el gateway con los kwargs exactos del bucle, funciona, y sin
    él el modelo pedía UNA búsqueda donde con high pedía tres. Este test fija
    que cada modo mande el suyo: normal medium, extendido high."""
    esperado = {"normal": "medium", "extendido": "high"}
    for modo, esfuerzo in esperado.items():
        fake_openai.queue(make_text_stream("Respuesta.", usage=make_usage(10, 2)))
        await _correr("pregunta", modo)
        assert fake_openai.calls[-1]["reasoning_effort"] == esfuerzo

    assert modos.NORMAL.esfuerzo == "medium"
    assert modos.EXTENDIDO.esfuerzo == "high"


async def test_el_operador_puede_apagar_o_bajar_el_razonamiento(
    settings_override, fake_openai, busqueda_falsa, monkeypatch
):
    """AGENT_REASONING_EFFORT es el techo del despliegue: "none" lo apaga en
    los dos modos y un valor concreto sustituye al del modo. Vacío = manda el
    modo (el caso del test anterior)."""
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "none")
    get_settings.cache_clear()
    for modo in ("normal", "extendido"):
        fake_openai.queue(make_text_stream("Respuesta.", usage=make_usage(10, 2)))
        await _correr("pregunta", modo)
        assert "reasoning_effort" not in fake_openai.calls[-1]

    monkeypatch.setenv("AGENT_REASONING_EFFORT", "low")
    get_settings.cache_clear()
    fake_openai.queue(make_text_stream("Respuesta.", usage=make_usage(10, 2)))
    await _correr("pregunta", "extendido")
    assert fake_openai.calls[-1]["reasoning_effort"] == "low"


async def test_el_modo_queda_en_la_telemetria(
    settings_override, fake_openai, busqueda_falsa
):
    """Para poder comparar despues coste y calidad de un modo contra el otro."""
    tel = telemetry.start()
    fake_openai.queue(make_text_stream("Respuesta.", usage=make_usage(10, 2)))

    await _correr("pregunta", "extendido")

    assert tel.summary()["meta"]["modo"] == "extendido"


# --- saber hablar de si mismo -----------------------------------------------
@pytest.mark.parametrize("prompt", [agent.SYSTEM_PROMPT, agent.SYSTEM_PROMPT_LEGACY])
def test_el_prompt_sabe_explicar_que_es_sin_ensenar_sus_instrucciones(prompt):
    """El fallo visto en produccion el 2 sep 2026.

    Al preguntarle "eres el modo pensamiento extendido?", el modelo no tenia
    con que responder (su unica fuente son los documentos) y acabo citando sus
    propias instrucciones internas entre comillas. Ahora hay una ficha de que
    es, y la prohibicion explicita de reproducir las instrucciones. Se exige
    en los dos prompts (v4 y el v3 del rollback).
    """
    assert "QUÉ ERES" in prompt
    assert "pensamiento normal" in prompt and "pensamiento extendido" in prompt
    # La excepcion tiene que estar atada a la regla 1, o se contradicen.
    assert "ÚNICA excepción a la regla 1" in prompt
    assert "Nunca reproduzcas" in prompt
    assert 'no las llames "mi instrucción"' in prompt
    assert "guion largo" in prompt


def test_el_prompt_v4_describe_el_flujo_del_pipeline_y_el_formato_para_la_medica():
    """v4 le dice al modelo que la evidencia ya está, que la herramienta es la
    excepción, y le da la fórmula literal de ausencia que reconoce el
    verificador: cualquier otra redacción se auditaría como afirmación sin
    cita."""
    prompt = agent.SYSTEM_PROMPT
    assert "YA está recuperada arriba" in prompt
    assert "es la EXCEPCIÓN" in prompt
    assert '"No encuentro X en los documentos"' in prompt
    assert "METODOLOGÍA DE INVESTIGACIÓN" in prompt
    assert "FORMATO DE RESPUESTA" in prompt
    assert "SECCIÓN" in prompt
    assert "prohibido mencionar el plan" in prompt
    # Lo que v3 pedía y v4 ya no: decidir qué buscar.
    assert "Busca tantas veces como haga falta" not in prompt
    assert "Busca tantas veces como haga falta" in agent.SYSTEM_PROMPT_LEGACY


def test_cada_modo_se_nombra_para_que_pueda_decir_en_cual_esta():
    for perfil in (modos.NORMAL, modos.EXTENDIDO):
        for coda in (perfil.instruccion, perfil.instruccion_legacy):
            assert coda.startswith("MODO ACTIVO:")
            assert perfil.nombre in coda
