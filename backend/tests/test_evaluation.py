from __future__ import annotations

import json

import pytest

from app.evaluation import EvalCase, load_cases, score_case, summarize


def _case(**overrides) -> EvalCase:
    raw = {
        "id": "mh-1",
        "question": "compara A y B",
        "mode": "extendido",
        "category": "multi_hop",
        "min_hops": 2,
        "evidence": [
            {
                "id": "a",
                "description": "resultado A",
                "sources": [{"file": "a.pdf", "pages": [3]}],
            },
            {
                "id": "b",
                "description": "resultado B",
                "sources": [{"file": "b.pdf", "section_patterns": ["results|resultados"]}],
            },
        ],
        "hop_patterns": ["cohorte A", "cohorte B"],
        "answer_must_contain": ["42%"],
        "answer_must_not_contain": ["100%"],
    }
    raw.update(overrides)
    return EvalCase.model_validate(raw)


def _result() -> dict:
    return {
        "answer": "La cohorte tuvo 42% [a.pdf, pág. 3]. El segundo estudio coincide [Autor et al., sección: Resultados].",
        "sources": [
            {
                "source_file": "a.pdf", "page": 3, "source_pages": [3, 4],
                "locator": "pág. 3", "citation": "",
            },
            {
                "source_file": "b.pdf", "page": 0, "source_pages": [],
                "section": "Resultados", "locator": "sección: Resultados",
                "citation": "Autor et al.",
            },
        ],
        "hops": [{"query": "cohorte A biomarcador"}, {"query": "cohorte B biomarcador"}],
        "metrics": {"cost_usd": 0.02, "ms_total": 1200},
        "error": None,
    }


def test_caso_completo_pasa_y_mide_cobertura():
    score = score_case(_case(), _result())

    assert score["passed"] is True
    assert score["metrics"]["evidence_recall"] == 1.0
    assert score["metrics"]["citation_precision"] == 1.0
    assert score["metrics"]["hop_pattern_coverage"] == 1.0


def test_una_evidencia_faltante_hace_fallar_el_caso():
    result = _result()
    result["sources"] = result["sources"][:1]

    score = score_case(_case(), result)

    assert score["passed"] is False
    assert score["metrics"]["evidence_recall"] == 0.5
    assert "evidencia no recuperada: b" in score["failures"]


def test_cita_inventada_no_se_considera_fiel():
    result = _result()
    result["answer"] += " Dato extra [fantasma.pdf, pág. 9]."

    score = score_case(_case(), result)

    assert score["passed"] is False
    assert score["metrics"]["citation_precision"] < 1
    assert any("fantasma.pdf" in failure for failure in score["failures"])


def test_abstencion_correcta_pasa_sin_citas():
    case = EvalCase.model_validate({
        "id": "neg-1", "question": "algo ausente", "category": "abstention",
        "min_hops": 1, "evidence": [], "expect_abstention": True,
    })
    result = {"answer": "No encuentro esa información en los documentos.", "sources": [], "hops": [{}]}

    score = score_case(case, result)

    assert score["passed"] is True
    assert score["metrics"]["citation_precision"] == 1.0


def test_dataset_rechaza_ids_duplicados(tmp_path):
    row = _case().model_dump()
    path = tmp_path / "cases.jsonl"
    path.write_text(json.dumps(row) + "\n" + json.dumps(row) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="id duplicado"):
        load_cases(path)


def test_resumen_no_oculta_un_fallo_critico():
    ok = score_case(_case(id="ok"), _result())
    bad_result = _result()
    bad_result["sources"] = []
    bad = score_case(_case(id="bad"), bad_result)

    summary = summarize([ok, bad], [_result(), bad_result])

    assert summary["pass_rate"] == 0.5
    assert summary["release_gate_passed"] is False
    assert summary["critical_failures"] == ["bad"]


# ---------------------------------------------------------------------------
# Fidelidad de atribución: la mide el verificador en runtime, aquí SOLO se lee
# ---------------------------------------------------------------------------
def _con_verificacion(**campos) -> dict:
    """Un result con el informe del verificador dentro del resumen de telemetría,
    tal como lo emite el evento `metrics`."""
    result = _result()
    result["metrics"] = {
        **result["metrics"],
        "meta": {"verificacion": {"fidelidad": 1.0, "no_sostenidas": 0,
                                  "sin_verificar": 0, **campos}},
    }
    return result


def test_sin_verificacion_la_fidelidad_es_none_y_no_penaliza():
    """La verificación apagada es una decisión de despliegue, no un fallo del
    caso: no se mide, pero se ve que no se midió."""
    scored = score_case(_case(), _result())

    assert scored["metrics"]["faithfulness"] is None
    assert scored["passed"] is True


def test_una_afirmacion_no_sostenida_es_un_fallo_duro():
    scored = score_case(_case(), _con_verificacion(fidelidad=0.5, no_sostenidas=1))

    assert scored["passed"] is False
    assert any("no sostiene" in f for f in scored["failures"])
    assert scored["metrics"]["unsupported_claims"] == 1
    assert scored["metrics"]["faithfulness"] == 0.5


def test_el_umbral_de_fidelidad_del_caso_se_respeta():
    caso = _case(min_faithfulness=0.9)

    ok = score_case(caso, _con_verificacion(fidelidad=1.0))
    bajo = score_case(caso, _con_verificacion(fidelidad=0.8))

    assert ok["passed"] is True
    assert bajo["passed"] is False
    assert any("por debajo del mínimo" in f for f in bajo["failures"])


def test_exigir_fidelidad_sin_medirla_es_un_fallo():
    """Si el caso la exige y la verificación estaba apagada, el caso no puede
    darse por bueno: se estaría aprobando sin comprobar."""
    scored = score_case(_case(min_faithfulness=0.9), _result())

    assert scored["passed"] is False
    assert any("no la midió" in f for f in scored["failures"])


def test_el_umbral_fuera_de_rango_se_rechaza_al_cargar():
    with pytest.raises(Exception):
        _case(min_faithfulness=1.5)


def test_la_media_de_fidelidad_promedia_solo_lo_medido():
    """Contar los no medidos como 0 hundiría la media y como 1 la maquillaría."""
    caso = _case()
    medido = score_case(caso, _con_verificacion(fidelidad=0.5))
    sin_medir = score_case(caso, _result())

    resumen = summarize([medido, sin_medir], [_result(), _result()])

    assert resumen["mean_faithfulness"] == 0.5
    assert resumen["faithfulness_measured_cases"] == 1


def test_el_resumen_suma_las_afirmaciones_no_sostenidas():
    caso = _case()
    a = score_case(caso, _con_verificacion(fidelidad=0.5, no_sostenidas=2))
    b = score_case(caso, _con_verificacion(fidelidad=0.0, no_sostenidas=3))

    resumen = summarize([a, b], [_result(), _result()])

    assert resumen["unsupported_claims_total"] == 5
    assert resumen["release_gate_passed"] is False


def test_la_plantilla_del_benchmark_sigue_validando(tmp_path):
    """El contrato del .jsonl no se rompe al añadir min_faithfulness: es
    opcional, así que los casos que ya existen cargan igual."""
    from pathlib import Path

    plantilla = Path("evals/alzheimer.template.jsonl")
    casos = load_cases(plantilla)

    assert casos
    assert all(c.min_faithfulness is None for c in casos)
