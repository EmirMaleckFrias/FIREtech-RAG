"""Verificación de atribución: troceo, resolución de citas y veredictos.

Lo que se protege aquí es el contrato que hace útil al verificador en
investigación médica: que NUNCA apruebe por omisión. Un verificador que ante
un fallo del modelo, un JSON roto o un tope alcanzado deja las afirmaciones
como "sostenidas" produce una garantía falsa, que es peor que no tener
verificación.
"""
from __future__ import annotations

import pytest

from app.config import get_settings
from app.models import Chunk
from app.services import verificador
from app.services.verificador import (
    CITA_NO_RESUELVE,
    SIN_CITA,
    NO_SOSTENIDA,
    PARCIAL,
    SIN_VERIFICAR,
    SOSTENIDA,
    verificar,
)
from tests.conftest import make_json_completion, make_usage


def _chunk(id_: str, texto: str, archivo: str, pagina: int) -> Chunk:
    return Chunk(id=id_, text=texto, source_file=archivo, page=pagina)


def _veredictos(informe) -> list[str]:
    return [a.veredicto for a in informe.afirmaciones]


# ---------------------------------------------------------------------------
# Troceo y resolución de citas: deterministas, sin modelo
# ---------------------------------------------------------------------------
async def test_una_abstencion_sin_citas_es_correcta(settings_override, fake_openai):
    """No citar es lo correcto cuando la respuesta declara que no hay datos.
    Es el único caso en que la ausencia de citas no es un fallo."""
    informe = await verificar("No encuentro ese dato en los documentos.", [])

    assert informe.afirmaciones == []
    assert informe.fidelidad is None
    assert informe.ok is True
    assert "se abstiene" in informe.nota
    assert fake_openai.calls == []  # no se gasta una llamada en esto


async def test_una_respuesta_factual_sin_citas_es_el_peor_caso(
    settings_override, fake_openai
):
    """Regresión de una permisividad que se colaba.

    Antes, CUALQUIER respuesta sin citas devolvía ok=True con "nada que
    atribuir": no había citas que comprobar, luego nada que reprochar. El
    razonamiento estaba al revés. Una respuesta que afirma cifras y no
    respalda ninguna es lo más grave que puede pasar aquí, porque quien
    investiga no puede rastrear nada hasta su fuente.
    """
    informe = await verificar(
        "El AUC de p-tau217 fue 0.94 en una cohorte de 412 pacientes.", []
    )

    assert informe.ok is False
    assert [a.veredicto for a in informe.afirmaciones] == [SIN_CITA]
    # 0.0 y no None: aquí sí se midió, y nada está respaldado
    assert informe.fidelidad == 0.0
    assert "sin una sola cita" in informe.nota
    assert fake_openai.calls == []


async def test_sin_citas_y_sin_abstencion_reporta_el_plan_entero_sin_cubrir(
    settings_override, fake_openai
):
    informe = await verificar(
        "Los tres estudios coinciden en el desenlace.", [], {"e1": "la cifra", "e2": "la cohorte"}
    )

    assert informe.ok is False
    assert informe.evidencia_sin_cubrir == ["e1", "e2"]


async def test_una_cita_que_no_resuelve_se_marca_sin_llamar_al_modelo(
    settings_override, fake_openai
):
    """El fallo más grave de trazabilidad: la respuesta apunta a una fuente que
    no se recuperó. Es determinista, así que no cuesta una llamada."""
    chunks = [_chunk("c1", "El AUC fue 0.94.", "estudio_a.pdf", 3)]
    respuesta = "El AUC fue 0.94 [inventado.pdf, pág. 9]."

    informe = await verificar(respuesta, chunks)

    assert _veredictos(informe) == [CITA_NO_RESUELVE]
    assert informe.citas_sin_resolver == ["[inventado.pdf, pág. 9]"]
    assert informe.fidelidad is None  # ninguna llegó a juicio del modelo
    assert fake_openai.calls == []


async def test_la_cita_resuelve_aunque_cambien_los_espacios(settings_override, fake_openai):
    """Estricto en contenido, laxo en forma: un espacio de más no es una cita
    inventada, y tratarlo como tal sería un falso positivo constante."""
    ch = _chunk("c1", "La conversión fue del 31.6%.", "estudio_a.pdf", 3)
    locator = ch.cite()
    # se reinyecta la misma cita con espaciado alterado
    alterada = locator.replace(", ", ",  ")
    assert alterada != locator
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "coincide"}]},
            usage=make_usage(50, 5),
        )
    )

    informe = await verificar(f"La conversión fue del 31.6% {alterada}.", [ch])

    assert _veredictos(informe) == [SOSTENIDA]
    assert informe.citas_sin_resolver == []


# ---------------------------------------------------------------------------
# Veredictos del modelo
# ---------------------------------------------------------------------------
async def test_reparte_veredictos_y_calcula_fidelidad(settings_override, fake_openai):
    a = _chunk("c1", "La conversión a demencia fue del 31.6%.", "a.pdf", 2)
    b = _chunk("c2", "El AUC de p-tau217 fue 0.94.", "b.pdf", 5)
    c = _chunk("c3", "La cohorte incluyó 412 pacientes.", "c.pdf", 1)
    respuesta = (
        f"La conversión fue del 31.6% {a.cite()}. "
        f"El AUC alcanzó 0.99 {b.cite()}. "
        f"Participaron 412 pacientes, todos varones {c.cite()}."
    )
    fake_openai.queue(
        make_json_completion(
            {
                "veredictos": [
                    {"i": 0, "veredicto": "sostenida", "motivo": "cifra idéntica"},
                    {"i": 1, "veredicto": "no_sostenida", "motivo": "el fragmento dice 0.94"},
                    {"i": 2, "veredicto": "parcial", "motivo": "el sexo no consta"},
                ]
            },
            usage=make_usage(120, 12),
        )
    )

    informe = await verificar(respuesta, [a, b, c])

    assert _veredictos(informe) == [SOSTENIDA, NO_SOSTENIDA, PARCIAL]
    assert informe.fidelidad == pytest.approx(1 / 3)
    assert informe.ok is True
    # una sola llamada para las tres afirmaciones
    assert len(fake_openai.calls) == 1
    # el fragmento citado viaja en el prompt: sin su texto no hay verificación
    enviado = fake_openai.calls[0]["messages"][-1]["content"]
    assert "El AUC de p-tau217 fue 0.94." in enviado


async def test_el_motivo_del_modelo_llega_al_informe(settings_override, fake_openai):
    ch = _chunk("c1", "El seguimiento fue de 36 meses.", "a.pdf", 4)
    fake_openai.queue(
        make_json_completion(
            {
                "veredictos": [
                    {"i": 0, "veredicto": "no_sostenida", "motivo": "el fragmento dice 36, no 60"}
                ]
            }
        )
    )

    informe = await verificar(f"El seguimiento fue de 60 meses {ch.cite()}.", [ch])

    assert informe.afirmaciones[0].motivo == "el fragmento dice 36, no 60"
    assert informe.afirmaciones[0].fragmento_id == ch.cite()


# ---------------------------------------------------------------------------
# El contrato que importa: nunca aprobar por omisión
# ---------------------------------------------------------------------------
async def test_si_el_modelo_falla_nada_queda_sostenido(settings_override, fake_openai):
    """La API caída no puede convertirse en un visto bueno."""
    ch = _chunk("c1", "La conversión fue del 31.6%.", "a.pdf", 2)
    fake_openai.queue(RuntimeError("API caída"))

    informe = await verificar(f"Cualquier cosa {ch.cite()}.", [ch])

    assert _veredictos(informe) == [SIN_VERIFICAR]
    assert informe.ok is False
    assert informe.fidelidad is None
    assert "no pudo dictaminar" in informe.nota


async def test_un_json_malformado_no_sostiene_nada(settings_override, fake_openai):
    ch = _chunk("c1", "Texto.", "a.pdf", 1)
    fake_openai.queue(make_json_completion({"otra_cosa": []}))

    informe = await verificar(f"Afirmación {ch.cite()}.", [ch])

    assert _veredictos(informe) == [SIN_VERIFICAR]
    assert informe.ok is False


async def test_un_veredicto_inventado_se_descarta(settings_override, fake_openai):
    """Solo se aceptan los tres veredictos del contrato. Uno inventado por el
    modelo no se propaga al informe como si fuera válido."""
    ch = _chunk("c1", "Texto.", "a.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "excelente", "motivo": "muy bien"}]}
        )
    )

    informe = await verificar(f"Afirmación {ch.cite()}.", [ch])

    assert _veredictos(informe) == [SIN_VERIFICAR]
    assert informe.fidelidad is None


async def test_un_indice_fuera_de_rango_no_contamina(settings_override, fake_openai):
    ch = _chunk("c1", "Texto.", "a.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {
                "veredictos": [
                    {"i": 7, "veredicto": "sostenida", "motivo": "no existe esa afirmación"}
                ]
            }
        )
    )

    informe = await verificar(f"Afirmación {ch.cite()}.", [ch])

    assert _veredictos(informe) == [SIN_VERIFICAR]


async def test_el_tope_de_afirmaciones_deja_las_sobrantes_sin_verificar(
    settings_override, fake_openai, monkeypatch
):
    """Una respuesta larguísima no puede disparar el reloj, pero recortar no
    puede significar aprobar: lo que no se juzga queda declarado como tal."""
    monkeypatch.setenv("VERIFIER_MAX_CLAIMS", "2")
    get_settings.cache_clear()

    chunks = [_chunk(f"c{i}", f"Dato {i}.", f"doc_{i}.pdf", i + 1) for i in range(4)]
    respuesta = " ".join(f"Afirmación {i} {c.cite()}." for i, c in enumerate(chunks))
    fake_openai.queue(
        make_json_completion(
            {
                "veredictos": [
                    {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                    {"i": 1, "veredicto": "sostenida", "motivo": "ok"},
                ]
            }
        )
    )

    informe = await verificar(respuesta, chunks)

    assert _veredictos(informe) == [SOSTENIDA, SOSTENIDA, SIN_VERIFICAR, SIN_VERIFICAR]
    # la fidelidad se calcula solo sobre lo juzgado, no sobre el total
    assert informe.fidelidad == pytest.approx(1.0)
    assert "tope de 2" in informe.afirmaciones[2].motivo


async def test_sin_afirmaciones_sostenidas_el_plan_queda_sin_cubrir(
    settings_override, fake_openai
):
    ch = _chunk("c1", "Texto.", "a.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "no lo dice"}]}
        )
    )

    informe = await verificar(
        f"Afirmación {ch.cite()}.", [ch], {"e1": "la cifra", "e2": "la cohorte"}
    )

    assert informe.evidencia_sin_cubrir == ["e1", "e2"]


async def test_el_payload_es_serializable(settings_override, fake_openai):
    """El informe viaja por SSE: si no serializa, el evento reventaría en
    producción y no en los tests."""
    import json

    ch = _chunk("c1", "Texto.", "a.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "ok"}]}
        )
    )

    informe = await verificar(f"Afirmación {ch.cite()}.", [ch])
    plano = json.loads(json.dumps(informe.to_payload()))

    assert plano["fidelidad"] == 1.0
    assert plano["afirmaciones"][0]["veredicto"] == SOSTENIDA
    assert plano["afirmaciones"][0]["cita"] == ch.cite()
