from __future__ import annotations

import json
import sys

import pytest

from app.evaluation import EvalCase, aggregate_runs, load_cases, score_case, summarize


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
    medido = score_case(_case(id="medido"), _con_verificacion(fidelidad=0.5))
    sin_medir = score_case(_case(id="sin-medir"), _result())

    resumen = summarize([medido, sin_medir], [_result(), _result()])

    assert resumen["mean_faithfulness"] == 0.5
    assert resumen["faithfulness_measured_cases"] == 1


def test_el_resumen_suma_las_afirmaciones_no_sostenidas():
    a = score_case(_case(id="a"), _con_verificacion(fidelidad=0.5, no_sostenidas=2))
    b = score_case(_case(id="b"), _con_verificacion(fidelidad=0.0, no_sostenidas=3))

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


# ---------------------------------------------------------------------------
# Repeticiones: la misma pregunta corrida 5 veces dio fidelidad 0.33..1.00,
# 6..10 hops y 5..15 afirmaciones. Sin agregar N corridas por caso, cualquier
# "mejoró" tras un cambio es ruido. Todo aquí es sintético: ni API ni modelos.
# ---------------------------------------------------------------------------
def _corrida(fidelidad, hops=2, ms_total=1200, cost_usd=0.02, no_sostenidas=0) -> dict:
    """Una corrida completa (pasa salvo por lo que diga la fidelidad) con los
    números que luego se agregan fijados a mano."""
    result = _con_verificacion(fidelidad=fidelidad, no_sostenidas=no_sostenidas)
    result["hops"] = result["hops"] + [{"query": f"búsqueda extra {i}"} for i in range(hops - 2)]
    result["metrics"]["ms_total"] = ms_total
    result["metrics"]["cost_usd"] = cost_usd
    return result


def _agregar(caso: EvalCase, results: list[dict]) -> tuple[dict, dict]:
    return aggregate_runs([score_case(caso, r) for r in results], results)


def test_agregar_una_sola_corrida_es_identico_a_score_case():
    """N = 1 es el comportamiento por defecto de evaluar.py: no puede cambiar
    ni la nota, ni los fallos (sin '(1/1 corridas)'), ni las métricas."""
    caso = _case(min_faithfulness=0.9)
    result = _corrida(fidelidad=0.8)  # falla el umbral: los fallos deben ser literales
    unico = score_case(caso, result)

    score, agregado = aggregate_runs([unico], [result])

    aditivas = {"runs", "passed_rate", "dispersion"}
    assert {k: v for k, v in score.items() if k not in aditivas | {"evidence"}} == {
        k: v for k, v in unico.items() if k != "evidence"
    }
    assert [{k: v for k, v in e.items() if k != "found_rate"} for e in score["evidence"]] == (
        unico["evidence"]
    )
    assert score["runs"] == 1
    assert score["passed_rate"] == 0.0
    assert agregado["metrics"]["cost_usd"] == 0.02
    assert agregado["metrics"]["ms_total"] == 1200
    assert agregado["metrics"]["cost_usd_all_runs"] == 0.02


def test_la_mediana_no_se_deja_arrastrar_por_un_valor_atipico():
    """Fidelidades 1.0, 1.0, 0.33: la media diría 0.78 y ninguna corrida vio
    eso; la mediana describe la corrida típica."""
    corridas = [
        _corrida(1.0, hops=6, ms_total=1000, cost_usd=0.02),
        _corrida(1.0, hops=7, ms_total=1100, cost_usd=0.021),
        _corrida(0.33, hops=15, ms_total=9000, cost_usd=0.09),
    ]

    score, agregado = _agregar(_case(), corridas)

    assert score["metrics"]["faithfulness"] == 1.0
    assert score["metrics"]["hops"] == 7
    assert agregado["metrics"]["ms_total"] == 1100
    assert agregado["metrics"]["cost_usd"] == 0.021
    assert agregado["metrics"]["cost_usd_all_runs"] == 0.131
    assert agregado["runs"] == 3


def test_con_n_par_la_mediana_es_el_punto_medio():
    """6 y 10 hops -> 8.0: ninguna corrida fue 'la típica' y se dice así."""
    score, _ = _agregar(_case(), [_corrida(1.0, hops=6), _corrida(1.0, hops=10)])

    assert score["metrics"]["hops"] == 8.0


def test_passed_es_mayoria_estricta_y_se_reporta_la_tasa():
    """El texto esperado del fallo agregado CAMBIÓ: antes se anotaba la
    frecuencia detrás del mensaje literal ("fidelidad 0.33 ... 0.90 (1/3
    corridas)"), y como el 0.33 es un dato de la corrida, dos corridas con
    fidelidades distintas partían el mismo fallo en dos líneas de 1/3. Ahora el
    tipo lleva la frecuencia y los valores medidos van detrás como variantes."""
    caso = _case(min_faithfulness=0.9)

    dos_de_tres, _ = _agregar(caso, [_corrida(1.0), _corrida(1.0), _corrida(0.33)])
    una_de_tres, _ = _agregar(caso, [_corrida(1.0), _corrida(0.33), _corrida(0.33)])

    assert dos_de_tres["passed"] is True
    assert dos_de_tres["passed_rate"] == 0.6667
    assert una_de_tres["passed"] is False
    assert una_de_tres["passed_rate"] == 0.3333
    # El fallo de la corrida minoritaria no desaparece: es lo que hay que mirar.
    assert dos_de_tres["failures"] == [
        "fidelidad por debajo del mínimo 0.90 (1/3 corridas): 0.33"
    ]


def test_un_empate_no_pasa():
    """1 de 2: un caso que falla la mitad de las veces no abre el gate."""
    score, _ = _agregar(_case(min_faithfulness=0.9), [_corrida(1.0), _corrida(0.33)])

    assert score["passed"] is False
    assert score["passed_rate"] == 0.5


def test_con_n_par_la_mediana_puede_cumplir_el_umbral_y_el_caso_fallar():
    """Umbral 0.80 con corridas 1.00 y 0.60: la mediana es 0.80 y CUMPLE, pero
    `passed` es False porque 1 de 2 es empate y no mayoría. Se mantiene el
    criterio (el veredicto de una corrida es la conjunción de las trece
    comprobaciones, no una métrica recalculable) y se hace visible: quien lea
    solo el bloque de métricas encuentra `dispersion['passed']` con el veredicto
    de cada corrida, y el fallo minoritario sigue listado."""
    score, _ = _agregar(_case(min_faithfulness=0.8), [_corrida(1.0), _corrida(0.6)])

    assert score["metrics"]["faithfulness"] == 0.8  # cumple el umbral exigido
    assert score["passed"] is False
    assert score["passed_rate"] == 0.5
    assert score["dispersion"]["passed"] == {"rate": 0.5, "values": [True, False]}
    assert score["failures"] == [
        "fidelidad por debajo del mínimo 0.80 (1/2 corridas): 0.60"
    ]


def test_la_dispersion_de_passed_no_aparece_con_una_sola_corrida_como_metrica():
    """`dispersion` es una clave aditiva, así que con N = 1 puede traer `passed`
    sin romper la promesa de que el score es idéntico a `score_case`: lo que no
    puede es colarse dentro de `metrics`, que sí se compara clave a clave."""
    result = _corrida(1.0)
    score, _ = aggregate_runs([score_case(_case(), result)], [result])

    assert score["dispersion"]["passed"] == {"rate": 1.0, "values": [True]}
    assert "passed" not in score["metrics"]


def test_los_fallos_agregados_van_por_frecuencia():
    """Mismo cambio de formato que en el test anterior: la frecuencia va detrás
    del TIPO y el detalle medido detrás de ella."""
    caso = _case(min_faithfulness=0.9)
    sin_b = _corrida(0.33)
    sin_b["sources"] = sin_b["sources"][:1]  # falla umbral Y evidencia b

    score, _ = _agregar(caso, [_corrida(0.33), sin_b, _corrida(1.0)])

    # Quitar b.pdf también deja sin resolver la cita que apuntaba a él: dos
    # fallos distintos en la misma corrida, cada uno con su propia frecuencia.
    assert score["failures"] == [
        "fidelidad por debajo del mínimo 0.90 (2/3 corridas): 0.33",
        "evidencia no recuperada: b (1/3 corridas)",
        "citas no resolubles (1/3 corridas): [Autor et al., sección: Resultados]",
    ]
    assert score["passed"] is False


def _sin_hops(fidelidad, hops: int) -> dict:
    """Una corrida recortada a `hops` búsquedas: con min_hops=2, hops 0 o 1
    dispara 'hops insuficientes' con un número distinto en cada corrida."""
    result = _corrida(fidelidad)
    result["hops"] = result["hops"][:hops]
    return result


def test_un_fallo_que_ocurre_siempre_no_se_trocea_por_la_medicion_de_cada_corrida():
    """La regresión que arregla `_group_failures`: con hops 0, 1, 0 el MISMO
    fallo salía como 'hops insuficientes: 0 < 2 (2/3 corridas)' +
    'hops insuficientes: 1 < 2 (1/3 corridas)', así que un fallo de 3 de 3
    corridas se leía como dos fallos minoritarios y el orden 'los más
    frecuentes primero' quedaba falseado justo en los fallos que más varían."""
    corridas = [_sin_hops(1.0, 0), _sin_hops(1.0, 1), _sin_hops(1.0, 0)]

    score, _ = _agregar(_case(), corridas)

    assert score["failures"][0] == "hops insuficientes (3/3 corridas): 0 < 2, 1 < 2"
    assert score["failure_types"][0] == {
        "type": "hops insuficientes", "detail": "0 < 2, 1 < 2", "runs": 3,
    }
    # Y el "los más frecuentes primero" vuelve a ser cierto: el fallo de 3/3 va
    # delante del de 2/3 (a la corrida de 1 hop sí le cubre 'cohorte A').
    assert [entrada["runs"] for entrada in score["failure_types"]] == sorted(
        (entrada["runs"] for entrada in score["failure_types"]), reverse=True
    )


def test_agrupar_por_tipo_no_funde_fallos_de_evidencias_distintas():
    """Adversarial de la corrección anterior: agrupar por el prefijo antes de
    los dos puntos habría metido 'evidencia no recuperada: a' y '...: b' en un
    solo fallo de 2/2 corridas, escondiendo que cada evidencia falló una vez y
    que ninguna falla siempre. El id identifica QUÉ falló y va en el tipo."""
    sin_a, sin_b = _corrida(1.0), _corrida(1.0)
    sin_a["sources"] = sin_a["sources"][1:]  # solo b.pdf
    sin_b["sources"] = sin_b["sources"][:1]  # solo a.pdf

    score, _ = _agregar(_case(), [sin_a, sin_b])

    assert "evidencia no recuperada: a (1/2 corridas)" in score["failures"]
    assert "evidencia no recuperada: b (1/2 corridas)" in score["failures"]
    assert not any(
        entrada["type"] == "evidencia no recuperada" for entrada in score["failure_types"]
    )


def test_un_detalle_repetido_no_se_lista_una_vez_por_corrida():
    """Adversarial: si las tres corridas fallan con el MISMO número de hops, el
    detalle no puede salir '0 < 2, 0 < 2, 0 < 2'."""
    score, _ = _agregar(_case(), [_sin_hops(1.0, 0) for _ in range(3)])

    assert "hops insuficientes (3/3 corridas): 0 < 2" in score["failures"]


def test_los_fallos_agregados_siguen_siendo_paralelos_a_sus_tipos():
    """`failures` y `failure_types` se leen por posición: si dejaran de cuadrar,
    `_failure_entries` degradaría a agrupar por mensaje sin avisar."""
    caso = _case(min_faithfulness=0.9)
    corridas = [_sin_hops(0.33, 1), _corrida(1.0), _sin_hops(0.33, 0)]

    crudo = score_case(caso, corridas[0])
    score, _ = _agregar(caso, corridas)

    assert len(crudo["failures"]) == len(crudo["failure_types"])
    assert len(score["failures"]) == len(score["failure_types"])
    for mensaje, entrada in zip(score["failures"], score["failure_types"]):
        assert mensaje.startswith(entrada["type"])


def test_una_fila_sin_failure_types_se_agrupa_por_el_mensaje_literal():
    """Compatibilidad hacia atrás: una fila de un reporte anterior (o hecha a
    mano) no trae `failure_types`. Agrupar por el mensaje es peor, pero es lo
    que se hacía antes y no puede reventar el agregado."""
    caso = _case(min_faithfulness=0.9)
    corridas = [_corrida(0.33), _corrida(0.33)]
    viejas = [score_case(caso, r) for r in corridas]
    for fila in viejas:
        del fila["failure_types"]

    score, _ = aggregate_runs(viejas, corridas)

    assert score["failures"] == [
        "fidelidad 0.33 por debajo del mínimo 0.90 (2/2 corridas)"
    ]

    # Y si los tipos vienen pero no cuadran con los mensajes (una fila tocada a
    # mano), leerlos por posición emparejaría un fallo con el tipo de otro: se
    # degrada igual en vez de mentir.
    descuadradas = [score_case(caso, r) for r in corridas]
    for fila in descuadradas:
        fila["failure_types"] = fila["failure_types"][:-1]

    descuadrado, _ = aggregate_runs(descuadradas, corridas)

    assert descuadrado["failures"] == [
        "fidelidad 0.33 por debajo del mínimo 0.90 (2/2 corridas)"
    ]


def test_el_mismo_tipo_dos_veces_en_una_corrida_cuenta_una_sola_corrida():
    """La frecuencia cuenta CORRIDAS, no apariciones: si una corrida anotara dos
    veces el mismo tipo, '2/1 corridas' sería un absurdo que además rompería el
    orden por frecuencia."""
    caso = _case()
    result = _corrida(1.0)
    fila = score_case(caso, result)
    fila["failures"] = ["error de ejecución: timeout", "error de ejecución: 502"]
    fila["failure_types"] = [
        {"type": "error de ejecución", "detail": "timeout"},
        {"type": "error de ejecución", "detail": "502"},
    ]
    otra = score_case(caso, result)

    score, _ = aggregate_runs([fila, otra], [result, result])

    assert score["failures"] == ["error de ejecución (1/2 corridas): timeout, 502"]


def test_la_dispersion_delata_la_inestabilidad_que_la_mediana_tapa():
    corridas = [
        _corrida(1.0, hops=6, ms_total=1000, cost_usd=0.02),
        _corrida(0.33, hops=10, ms_total=3000, cost_usd=0.05),
        _corrida(1.0, hops=8, ms_total=1200, cost_usd=0.02),
    ]

    score, agregado = _agregar(_case(), corridas)

    assert score["metrics"]["faithfulness"] == 1.0  # la mediana sola diría "perfecto"
    assert score["dispersion"]["faithfulness"] == {
        "min": 0.33, "max": 1.0, "n": 3, "values": [1.0, 0.33, 1.0],
    }
    assert score["dispersion"]["hops"] == {"min": 6, "max": 10, "n": 3, "values": [6, 10, 8]}
    assert score["dispersion"]["abstained"] == {"rate": 0.0, "values": [False, False, False]}
    assert agregado["dispersion"]["ms_total"] == {
        "min": 1000.0, "max": 3000.0, "n": 3, "values": [1000.0, 3000.0, 1200.0],
    }
    assert agregado["dispersion"]["cost_usd"]["max"] == 0.05


def test_la_fidelidad_se_mediana_solo_sobre_las_corridas_que_la_midieron():
    """Una corrida con la verificación apagada no vale 0 ni 1: no cuenta."""
    caso = _case()
    con_hueco = [_result(), _corrida(0.5), _corrida(1.0)]

    score, _ = _agregar(caso, con_hueco)
    ninguna, _ = _agregar(caso, [_result(), _result()])

    assert score["metrics"]["faithfulness"] == 0.75
    assert score["dispersion"]["faithfulness"] == {
        "min": 0.5, "max": 1.0, "n": 2, "values": [None, 0.5, 1.0],
    }
    assert ninguna["metrics"]["faithfulness"] is None
    assert ninguna["dispersion"]["faithfulness"]["n"] == 0


def test_la_evidencia_agregada_va_por_mayoria_y_une_las_fuentes():
    sin_b = _corrida(1.0)
    sin_b["sources"] = sin_b["sources"][:1]

    score, _ = _agregar(_case(), [_corrida(1.0), _corrida(1.0), sin_b])

    fila_b = next(row for row in score["evidence"] if row["id"] == "b")
    assert fila_b["found"] is True
    assert fila_b["found_rate"] == 0.6667
    assert fila_b["matched_sources"] == ["b.pdf"]
    assert score["metrics"]["evidence_recall"] == 1.0  # mediana de 1.0, 1.0, 0.5
    assert score["passed"] is True
    assert score["failures"] == [
        "evidencia no recuperada: b (1/3 corridas)",
        # Formato nuevo: el tipo lleva la frecuencia y las citas concretas,
        # que cambian en cada corrida, van detrás como variantes.
        "citas no resolubles (1/3 corridas): [Autor et al., sección: Resultados]",
    ]


def test_los_errores_de_ejecucion_se_conservan_en_el_agregado():
    """El mensaje del error es dato de la corrida (dos timeouts distintos son el
    mismo fallo), así que va como variante detrás de la frecuencia."""
    roto = _corrida(1.0)
    roto["error"] = "timeout"

    score, agregado = _agregar(_case(), [_corrida(1.0), roto, _corrida(1.0)])

    assert agregado["errors"] == ["timeout"]
    assert score["passed"] is True
    assert score["failures"] == ["error de ejecución (1/3 corridas): timeout"]


def test_dos_errores_distintos_son_el_mismo_fallo_con_dos_variantes():
    """Antes, 'error de ejecución: timeout' y '...: 502' se contaban como dos
    fallos de 1/3 y ninguno decía que TODAS las corridas se cayeron."""
    uno, dos = _corrida(1.0), _corrida(1.0)
    uno["error"], dos["error"] = "timeout", "502 Bad Gateway"

    score, _ = _agregar(_case(), [uno, dos])

    assert score["failures"] == [
        "error de ejecución (2/2 corridas): timeout, 502 Bad Gateway"
    ]
    assert score["passed"] is False


def test_aggregate_runs_rechaza_entradas_incoherentes():
    caso = _case()
    result = _corrida(1.0)
    score = score_case(caso, result)
    otro = score_case(_case(id="otro"), result)

    with pytest.raises(ValueError, match="N >= 1"):
        aggregate_runs([], [])
    with pytest.raises(ValueError, match="N >= 1"):
        aggregate_runs([score, score], [result])
    with pytest.raises(ValueError, match="mezcla casos"):
        aggregate_runs([score, otro], [result, result])
    agregado, _ = aggregate_runs([score], [result])
    with pytest.raises(ValueError, match="ya están agregadas"):
        aggregate_runs([agregado, agregado], [result, result])


def test_aggregate_runs_tambien_rechaza_results_de_otro_caso():
    """Solo se validaban los `scores`: con un result de otro caso el agregado
    se quedaba con la `question` y el `mode` del primero y enseñaba una
    pregunta junto al coste, la latencia y los errores de otra."""
    caso = _case()
    mio = _corrida(1.0)
    mio.update({"id": "mh-1", "question": "compara A y B", "mode": "extendido"})
    ajeno = _corrida(1.0)
    ajeno.update({"id": "otro", "question": "otra pregunta", "mode": "normal"})
    scores = [score_case(caso, mio), score_case(caso, ajeno)]

    with pytest.raises(ValueError, match="mezcla casos distintos"):
        aggregate_runs(scores, [mio, ajeno])

    # Un result sin `id` (sintético, o de un reporte viejo) sigue valiendo: lo
    # que no se acepta es un id que CONTRADIGA al de los scores.
    sin_id = _corrida(1.0)
    score, agregado = aggregate_runs([score_case(caso, mio), score_case(caso, sin_id)],
                                     [mio, sin_id])
    assert agregado["id"] == "mh-1"
    assert agregado["question"] == "compara A y B"


def test_summarize_cuenta_un_caso_con_tres_corridas_como_un_solo_caso():
    caso = _case(min_faithfulness=0.9)
    score, agregado = _agregar(caso, [_corrida(1.0), _corrida(1.0), _corrida(0.33)])

    resumen = summarize([score], [agregado])

    assert resumen["cases"] == 1
    assert resumen["passed"] == 1
    assert resumen["pass_rate"] == 1.0
    assert resumen["runs_total"] == 3
    assert resumen["run_pass_rate"] == 0.6667
    assert resumen["unstable_cases"] == ["mh-1"]
    # El gate se decide sobre el agregado (mayoría), no sobre la corrida mala.
    assert resumen["release_gate_passed"] is True
    assert resumen["critical_failures"] == []
    assert resumen["mean_faithfulness"] == 1.0
    assert resumen["total_cost_usd"] == 0.02  # una pasada típica
    assert resumen["total_cost_usd_all_runs"] == 0.06  # lo gastado de verdad


def test_el_gate_falla_sobre_el_agregado_cuando_la_mayoria_falla():
    caso = _case(min_faithfulness=0.9)
    score, agregado = _agregar(caso, [_corrida(1.0), _corrida(0.33), _corrida(0.33)])

    resumen = summarize([score], [agregado])

    assert resumen["release_gate_passed"] is False
    assert resumen["critical_failures"] == ["mh-1"]
    assert resumen["unstable_cases"] == ["mh-1"]


def test_summarize_no_acepta_corridas_crudas_del_mismo_caso_sin_agregar():
    """Tres filas crudas de 'mh-1' dirían cases=3 y juzgarían el gate corrida a
    corrida: justo el ruido que las repeticiones venían a quitar."""
    caso = _case()
    crudas = [score_case(caso, _corrida(1.0)) for _ in range(3)]

    with pytest.raises(ValueError, match="ids repetidos.*mh-1"):
        summarize(crudas, [_corrida(1.0)] * 3)


def test_summarize_mezcla_casos_agregados_y_de_una_pasada():
    """Un dataset puede tener casos con N corridas y otros con 1 (tope de
    coste a medias): las filas sin `runs` cuentan como una corrida."""
    repetido, agregado = _agregar(
        _case(id="rep", min_faithfulness=0.9), [_corrida(1.0), _corrida(1.0), _corrida(0.33)]
    )
    suelto_result = _corrida(1.0)
    suelto = score_case(_case(id="suelto"), suelto_result)

    resumen = summarize([repetido, suelto], [agregado, suelto_result])

    assert resumen["cases"] == 2
    assert resumen["runs_total"] == 4
    assert resumen["run_pass_rate"] == 0.75
    assert resumen["unstable_cases"] == ["rep"]
    assert resumen["release_gate_passed"] is True
    assert resumen["total_cost_usd_all_runs"] == 0.08


# --- evaluar.py: el bucle de repeticiones, sin tocar la API ---------------
def _falso_run_case(fidelidades: list[float]):
    """Sustituto de evaluar.run_case: devuelve una corrida por llamada con la
    fidelidad siguiente de la lista, en el orden en que se piden."""
    cola = iter(fidelidades)

    def run_case(case, base, token):
        result = _corrida(fidelidad=next(cola))
        result.update({"id": case.id, "question": case.question, "mode": case.mode})
        return result

    return run_case


def _dataset(tmp_path, caso: EvalCase):
    ruta = tmp_path / "casos.jsonl"
    ruta.write_text(json.dumps(caso.model_dump()) + "\n", encoding="utf-8")
    return ruta


def _correr_evaluar(monkeypatch, *argumentos: str) -> int:
    import evaluar

    monkeypatch.setattr(sys, "argv", ["evaluar.py", *argumentos])
    return evaluar.main()


def test_evaluar_repite_cada_caso_y_conserva_las_corridas_crudas(tmp_path, monkeypatch, capsys):
    import evaluar

    dataset = _dataset(tmp_path, _case(min_faithfulness=0.9))
    salida = tmp_path / "reporte.json"
    monkeypatch.setattr(evaluar, "run_case", _falso_run_case([1.0, 0.33, 1.0]))

    codigo = _correr_evaluar(
        monkeypatch, "--dataset", str(dataset), "--repeticiones", "3", "--output", str(salida)
    )

    assert codigo == 0  # 2 de 3 pasan: el gate se abre sobre el agregado
    reporte = json.loads(salida.read_text(encoding="utf-8"))
    assert reporte["schema_version"] == 2
    assert reporte["repetitions"] == 3
    (caso,) = reporte["cases"]
    assert [run["score"]["passed"] for run in caso["runs"]] == [True, False, True]
    assert [
        run["result"]["metrics"]["meta"]["verificacion"]["fidelidad"] for run in caso["runs"]
    ] == [1.0, 0.33, 1.0]
    assert caso["runs"][1]["result"]["answer"].startswith("La cohorte")  # crudo, no resumen
    assert caso["score"]["runs"] == 3
    assert caso["score"]["passed"] is True
    assert caso["score"]["passed_rate"] == 0.6667
    assert caso["score"]["metrics"]["faithfulness"] == 1.0
    assert caso["score"]["dispersion"]["faithfulness"]["min"] == 0.33
    assert caso["result"]["runs"] == 3
    assert reporte["summary"]["cases"] == 1
    assert reporte["summary"]["runs_total"] == 3
    assert reporte["summary"]["unstable_cases"] == ["mh-1"]
    assert "=> PASS 2/3 corridas" in capsys.readouterr().out


def test_evaluar_sin_repeticiones_corre_una_vez_como_antes(tmp_path, monkeypatch, capsys):
    import evaluar

    dataset = _dataset(tmp_path, _case(min_faithfulness=0.9))
    salida = tmp_path / "reporte.json"
    llamadas: list[str] = []
    falso = _falso_run_case([1.0])

    def contado(case, base, token):
        llamadas.append(case.id)
        return falso(case, base, token)

    monkeypatch.setattr(evaluar, "run_case", contado)

    codigo = _correr_evaluar(monkeypatch, "--dataset", str(dataset), "--output", str(salida))

    assert codigo == 0
    assert llamadas == ["mh-1"]
    reporte = json.loads(salida.read_text(encoding="utf-8"))
    assert reporte["repetitions"] == 1
    (caso,) = reporte["cases"]
    assert len(caso["runs"]) == 1
    assert caso["score"]["passed"] is True
    assert caso["score"]["failures"] == []
    assert caso["score"]["metrics"] == caso["runs"][0]["score"]["metrics"]
    assert "=>" not in capsys.readouterr().out  # sin repeticiones no hay veredicto agregado


def test_evaluar_corta_por_tope_a_mitad_de_caso_y_agrega_lo_que_hay(tmp_path, monkeypatch):
    """Cada corrida cuesta 0.02; con tope 0.03 la tercera ya no se lanza. Se
    agregan las 2 hechas (pasa, falla = empate = FAIL) en vez de tirarlas."""
    import evaluar

    dataset = _dataset(tmp_path, _case(min_faithfulness=0.9))
    salida = tmp_path / "reporte.json"
    monkeypatch.setattr(evaluar, "run_case", _falso_run_case([1.0, 0.33, 1.0]))

    codigo = _correr_evaluar(
        monkeypatch,
        "--dataset", str(dataset), "--repeticiones", "3", "--max-usd", "0.03",
        "--output", str(salida),
    )

    assert codigo == 1
    reporte = json.loads(salida.read_text(encoding="utf-8"))
    (caso,) = reporte["cases"]
    assert len(caso["runs"]) == 2
    assert caso["score"]["runs"] == 2
    assert caso["score"]["passed"] is False
    assert caso["score"]["passed_rate"] == 0.5
    assert reporte["summary"]["release_gate_passed"] is False
    assert reporte["summary"]["total_cost_usd_all_runs"] == 0.04


def test_evaluar_rechaza_repeticiones_invalidas(tmp_path, monkeypatch):
    dataset = _dataset(tmp_path, _case())

    with pytest.raises(SystemExit) as salida:
        _correr_evaluar(monkeypatch, "--dataset", str(dataset), "--repeticiones", "0", "--dry-run")

    assert salida.value.code == 2


def test_el_result_del_reporte_no_finge_ser_la_corrida(tmp_path, monkeypatch):
    """El docstring de evaluar.py decía que con N = 1 `result` coincide con la
    única corrida salvo por las claves aditivas, y era falso: el agregado es
    mínimo por diseño y no trae answer/sources/hops/error. Este test fija el
    formato que ahora describe el docstring, para las dos mitades."""
    import evaluar

    dataset = _dataset(tmp_path, _case())
    salida = tmp_path / "reporte.json"
    monkeypatch.setattr(evaluar, "run_case", _falso_run_case([1.0]))

    assert _correr_evaluar(monkeypatch, "--dataset", str(dataset), "--output", str(salida)) == 0

    (caso,) = json.loads(salida.read_text(encoding="utf-8"))["cases"]
    agregado = caso["result"]
    assert set(agregado) == {"id", "question", "mode", "runs", "errors", "metrics", "dispersion"}
    assert set(caso["runs"][0]["result"]) >= {"answer", "sources", "hops", "error"}


def test_evaluar_sin_ninguna_corrida_termina_limpio_y_sin_reporte(tmp_path, monkeypatch, capsys):
    """Con `--max-usd 0` el tope está agotado antes de la primera corrida: no
    hay nada que agregar y `summarize([])` moría con
    ValueError('no hay resultados que resumir') y un traceback. Ahora avisa y
    sale con código distinto de 0."""
    import evaluar

    dataset = _dataset(tmp_path, _case())
    salida = tmp_path / "reporte.json"
    monkeypatch.setattr(evaluar, "run_case", _falso_run_case([]))  # no debe llamarse

    codigo = _correr_evaluar(
        monkeypatch, "--dataset", str(dataset), "--max-usd", "0", "--output", str(salida)
    )

    assert codigo == 1
    assert not salida.exists()
    assert "No se evaluó ningún caso" in capsys.readouterr().out


def test_una_excepcion_inesperada_en_una_corrida_no_tumba_el_benchmark(tmp_path, monkeypatch):
    """`_run_once` solo atrapaba httpx.HTTPError: un evento SSE con otra forma
    (KeyError, TypeError) abortaba main() sin escribir el reporte y tiraba las
    corridas ya hechas y ya pagadas."""
    import evaluar

    dataset = _dataset(tmp_path, _case())
    salida = tmp_path / "reporte.json"
    fidelidades = _falso_run_case([1.0])

    def revienta_la_primera(case, base, token):
        if not getattr(revienta_la_primera, "llamada", False):
            revienta_la_primera.llamada = True
            raise KeyError("text")
        return fidelidades(case, base, token)

    monkeypatch.setattr(evaluar, "run_case", revienta_la_primera)

    codigo = _correr_evaluar(
        monkeypatch, "--dataset", str(dataset), "--repeticiones", "2", "--output", str(salida)
    )

    assert codigo == 1
    reporte = json.loads(salida.read_text(encoding="utf-8"))
    assert reporte["interrupted"] is None  # la corrida falló, el bucle no
    (caso,) = reporte["cases"]
    assert len(caso["runs"]) == 2
    assert caso["runs"][0]["result"]["error"] == "KeyError: 'text'"
    # El tipo de excepción va en el mensaje: str(KeyError("text")) es solo
    # "'text'" y no se entiende sin él.
    assert "error de ejecución (1/2 corridas): KeyError: 'text'" in caso["score"]["failures"]


def test_un_fallo_a_mitad_del_bucle_escribe_el_reporte_con_lo_ya_medido(tmp_path, monkeypatch):
    """Si el bucle se cae en el caso 2 de 2, las corridas del caso 1 ya están
    hechas y pagadas: el reporte se escribe igual, marcado como parcial, y el
    gate no se abre."""
    import evaluar

    ruta = tmp_path / "dos.jsonl"
    ruta.write_text(
        json.dumps(_case(id="uno").model_dump()) + "\n"
        + json.dumps(_case(id="dos").model_dump()) + "\n",
        encoding="utf-8",
    )
    salida = tmp_path / "reporte.json"
    monkeypatch.setattr(evaluar, "run_case", _falso_run_case([1.0, 1.0]))
    real = evaluar.score_case

    def puntua_o_revienta(case, result):
        if case.id == "dos":
            raise TypeError("resumen de telemetría con otra forma")
        return real(case, result)

    monkeypatch.setattr(evaluar, "score_case", puntua_o_revienta)

    codigo = _correr_evaluar(monkeypatch, "--dataset", str(ruta), "--output", str(salida))

    assert codigo == 1  # aunque el caso medido pase: no se comprobaron todos
    reporte = json.loads(salida.read_text(encoding="utf-8"))
    assert [c["definition"]["id"] for c in reporte["cases"]] == ["uno"]
    assert reporte["interrupted"] == {
        "error": "TypeError: resumen de telemetría con otra forma",
        "cases_evaluated": 1,
        "cases_total": 2,
    }
    assert reporte["summary"]["release_gate_passed"] is True  # lo medido pasó...

