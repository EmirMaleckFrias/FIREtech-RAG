"""Telemetría por pregunta: normalización de usage, coste estimado, tarifas
por snapshot, sumidero nulo y aislamiento entre tareas."""
from __future__ import annotations

import asyncio
import json
import types

import pytest

from app.services import telemetry
from app.services.telemetry import (
    ASSUMED_PRICES,
    PRICING_LABEL,
    cost_estimate,
    price_for,
    usage_to_dict,
)
from tests.conftest import make_usage


@pytest.fixture(autouse=True)
def _sin_telemetria_previa():
    telemetry.clear()
    yield
    telemetry.clear()


# --- usage_to_dict --------------------------------------------------------
def test_usage_to_dict_con_objeto_del_sdk():
    u = make_usage(prompt=120, completion=30, cached=50, reasoning=7)
    assert usage_to_dict(u) == {
        "prompt": 120, "cached": 50, "completion": 30, "reasoning": 7,
    }


def test_usage_to_dict_con_dict():
    u = {
        "prompt_tokens": 10,
        "completion_tokens": 4,
        "prompt_tokens_details": {"cached_tokens": 3},
        "completion_tokens_details": {"reasoning_tokens": 1},
    }
    assert usage_to_dict(u) == {"prompt": 10, "cached": 3, "completion": 4, "reasoning": 1}


def test_usage_to_dict_sin_detalles_ni_none():
    assert usage_to_dict(None) == {"prompt": 0, "cached": 0, "completion": 0, "reasoning": 0}
    # Embeddings: solo prompt_tokens, sin detalles.
    u = types.SimpleNamespace(prompt_tokens=9, total_tokens=9)
    assert usage_to_dict(u) == {"prompt": 9, "cached": 0, "completion": 0, "reasoning": 0}
    # Detalles presentes pero con None dentro.
    u = types.SimpleNamespace(
        prompt_tokens=5, completion_tokens=None,
        prompt_tokens_details=types.SimpleNamespace(cached_tokens=None),
        completion_tokens_details=None,
    )
    assert usage_to_dict(u) == {"prompt": 5, "cached": 0, "completion": 0, "reasoning": 0}


def test_usage_to_dict_recorta_cached_a_prompt():
    u = make_usage(prompt=10, completion=1, cached=50)
    assert usage_to_dict(u)["cached"] == 10


# --- cost_estimate --------------------------------------------------------
def test_cost_estimate_sigue_la_formula():
    p_in, p_cached, p_out = ASSUMED_PRICES["gpt-5.4"]
    prompt, cached, completion = 1000, 200, 100
    esperado = ((prompt - cached) * p_in + cached * p_cached + completion * p_out) / 1e6
    got = cost_estimate({"gpt-5.4": {"prompt": prompt, "cached": cached, "completion": completion}})
    assert got == pytest.approx(esperado)


def test_cost_estimate_tolera_cached_mayor_que_prompt():
    p_in, p_cached, p_out = ASSUMED_PRICES["gpt-5.4-mini"]
    # cached se recorta a prompt: toda la entrada se cobra como cacheada.
    esperado = (1000 * p_cached + 10 * p_out) / 1e6
    got = cost_estimate({"gpt-5.4-mini": {"prompt": 1000, "cached": 5000, "completion": 10}})
    assert got == pytest.approx(esperado)
    assert got >= 0


def test_cost_estimate_suma_modelos_e_ignora_desconocidos():
    solo_a = cost_estimate({"gpt-5.4": {"prompt": 100, "cached": 0, "completion": 10}})
    solo_b = cost_estimate({"gpt-5.4-mini": {"prompt": 100, "cached": 0, "completion": 10}})
    ambos = cost_estimate({
        "gpt-5.4": {"prompt": 100, "cached": 0, "completion": 10},
        "gpt-5.4-mini": {"prompt": 100, "cached": 0, "completion": 10},
        "modelo-inventado": {"prompt": 10_000_000, "cached": 0, "completion": 10_000_000},
    })
    assert ambos == pytest.approx(solo_a + solo_b)
    assert cost_estimate({}) == 0.0


def test_pricing_label_declara_la_estimacion():
    assert "estimado" in PRICING_LABEL
    assert "asumidas" in PRICING_LABEL


# --- price_for --------------------------------------------------------------
def test_price_for_snapshots_eligen_el_prefijo_mas_largo():
    assert price_for("gpt-5.4-mini-2026-01-01") == ASSUMED_PRICES["gpt-5.4-mini"]
    assert price_for("gpt-5.4-2026-01-01") == ASSUMED_PRICES["gpt-5.4"]
    assert price_for("gpt-5.4-2026-01-01") != ASSUMED_PRICES["gpt-5.4-mini"]
    assert price_for("gpt-5.4") == ASSUMED_PRICES["gpt-5.4"]
    assert price_for("gpt-5.4-mini") == ASSUMED_PRICES["gpt-5.4-mini"]


def test_price_for_desconocido_es_none():
    assert price_for("modelo-inventado") is None
    # Un prefijo sin separador no cuenta como snapshot.
    assert price_for("gpt-5.4x") is None


# --- contexto ---------------------------------------------------------------
def test_current_sin_start_es_un_sumidero_que_no_acumula():
    assert telemetry.active() is None
    tel = telemetry.current()
    assert tel is not None
    tel.record("agente", "gpt-5.4", make_usage(100, 10), ms=12.0)
    tel.incr("hops")
    tel.mark("fin")
    tel.set_meta(x=1)
    assert tel.rounds == []
    assert tel.counters == {}
    assert tel.marks == {}
    assert tel.meta == {}
    assert tel.summary()["rounds_total"] == 0
    assert tel.summary()["cost_usd"] == 0
    # Sigue sin haber telemetría activa.
    assert telemetry.active() is None


def test_start_fija_y_clear_borra():
    tel = telemetry.start(prompt_version="v1")
    assert telemetry.active() is tel
    assert telemetry.current() is tel
    assert tel.meta == {"prompt_version": "v1"}
    tel.set_meta(prompt_version="v2", model="m")  # no pisa lo ya fijado
    assert tel.meta == {"prompt_version": "v1", "model": "m"}
    telemetry.clear()
    assert telemetry.active() is None


async def test_dos_tareas_no_mezclan_su_telemetria():
    resultados: dict[str, telemetry.Telemetry] = {}
    barrera = asyncio.Event()

    async def pregunta(nombre: str, prompt: int) -> None:
        tel = telemetry.start(nombre=nombre)
        await asyncio.sleep(0)  # deja correr a la otra tarea
        telemetry.current().record("agente", "gpt-5.4", make_usage(prompt, 1))
        telemetry.current().incr("hops")
        await barrera.wait()  # las dos registran antes de que nadie termine
        telemetry.current().record("reranker", "gpt-5.4-mini", make_usage(prompt * 2, 1))
        resultados[nombre] = telemetry.current()
        assert telemetry.current() is tel

    t1 = asyncio.create_task(pregunta("a", 100))
    t2 = asyncio.create_task(pregunta("b", 300))
    await asyncio.sleep(0.01)
    barrera.set()
    await asyncio.gather(t1, t2)

    a, b = resultados["a"], resultados["b"]
    assert a is not b
    assert a.meta == {"nombre": "a"} and b.meta == {"nombre": "b"}
    assert [r.prompt for r in a.rounds] == [100, 200]
    assert [r.prompt for r in b.rounds] == [300, 600]
    assert a.counters == {"hops": 1} and b.counters == {"hops": 1}
    # El start() dentro de cada tarea no se filtra al contexto de quien las creó.
    assert telemetry.active() is None


def test_summary_es_serializable_y_coherente():
    tel = telemetry.start(prompt_version="v1", model="gpt-5.4")
    tel.record("agente", "gpt-5.4", make_usage(1000, 100, cached=200, reasoning=20), ms=50.0,
               finish_reason="tool_calls", note="tool_calls=1")
    tel.record("agente", "gpt-5.4", make_usage(500, 50), ms=30.0, finish_reason="stop")
    tel.record("reranker", "gpt-5.4-mini", make_usage(2000, 20), ms=20.0)
    tel.record("embeddings", "text-embedding-3-large", {"prompt_tokens": 40}, ms=5.0)
    tel.record("embeddings", "text-embedding-3-large", None, ms=1.0, ok=False, note="timeout")
    tel.incr("hops")
    tel.incr("hops")
    tel.mark("primer_token", 123.456)

    s = tel.summary()
    texto = json.dumps(s, ensure_ascii=False)
    assert isinstance(texto, str) and len(texto) > 0

    assert s["rounds_total"] == 5
    assert s["agent_rounds"] == 2
    assert s["tokens"] == {"prompt": 3540, "cached": 200, "completion": 170, "reasoning": 20}
    assert s["cached_ratio"] == pytest.approx(200 / 3540, abs=1e-4)
    assert s["by_component"]["agente"]["rounds"] == 2
    assert s["by_component"]["embeddings"]["errors"] == 1
    assert s["by_model"]["gpt-5.4"]["prompt"] == 1500
    assert s["cost_usd"] == pytest.approx(cost_estimate(tel.by_model()), abs=1e-6)
    assert s["cost_label"] == PRICING_LABEL
    assert s["unknown_models"] == []
    assert s["counters"] == {"hops": 2}
    assert s["marks"] == {"primer_token": 123.5}
    assert s["meta"] == {"prompt_version": "v1", "model": "gpt-5.4"}
    assert len(s["rounds"]) == 5 and s["rounds"][0]["finish_reason"] == "tool_calls"


# ---------------------------------------------------------------------------
# Precios con los nombres del AI Gateway de Vercel
# ---------------------------------------------------------------------------
def test_el_prefijo_de_proveedor_no_rompe_la_tarifa():
    """Regresión de una sesión de estrés donde las diez preguntas reportaron
    `usd=0.0`.

    El AI Gateway de Vercel nombra los modelos `openai/gpt-5.4`, y con eso
    ninguna clave de la tabla casaba: el coste salía 0.00 siempre y con él
    dejaban de frenar `--max-usd` de la ingesta y el `cost_usd` de los evals.
    """
    from app.services.telemetry import price_for

    assert price_for("openai/gpt-5.4") == price_for("gpt-5.4")
    assert price_for("openai/gpt-5.4-mini") == price_for("gpt-5.4-mini")
    assert price_for("openai/text-embedding-3-large") == price_for("text-embedding-3-large")


def test_sigue_ganando_la_clave_mas_larga_con_prefijo():
    """El desempate por clave más larga tiene que sobrevivir al prefijo: si no,
    `openai/gpt-5.4-mini` cobraría la tarifa del modelo grande."""
    from app.services.telemetry import price_for

    assert price_for("openai/gpt-5.4-mini") != price_for("openai/gpt-5.4")


def test_un_snapshot_con_prefijo_tambien_resuelve():
    from app.services.telemetry import price_for

    assert price_for("openai/gpt-5.4-2026-03-01") == price_for("gpt-5.4")


def test_un_modelo_desconocido_sigue_sin_tarifa():
    """Devolver None es lo que hace que aparezca en `unknown_models`: inventar
    una tarifa sería peor que no tenerla."""
    from app.services.telemetry import price_for

    assert price_for("anthropic/claude-x") is None
    assert price_for("modelo-inventado") is None


def test_el_coste_de_una_ronda_por_el_gateway_no_es_cero():
    """La prueba de extremo a extremo del fallo: una ronda real con el nombre
    prefijado tenía que dejar de costar 0."""
    from app.services import telemetry

    tel = telemetry.Telemetry()
    tel.record(
        "agente", "openai/gpt-5.4",
        types.SimpleNamespace(prompt_tokens=1000, completion_tokens=500, total_tokens=1500),
    )
    resumen = tel.summary()
    assert resumen["cost_usd"] > 0
    assert resumen["unknown_models"] == []
