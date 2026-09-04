"""La barrera previa nunca publica un borrador que el critico rechazo."""
from __future__ import annotations

from app.config import get_settings
from app.models import Chunk
from app.services import revisor, telemetry
from tests.conftest import make_json_completion, make_text_completion, make_usage


def _chunk() -> Chunk:
    return Chunk(
        id="c1",
        text="El AUC de p-tau217 fue 0.94.",
        source_file="estudio.pdf",
        page=3,
        document_type="pdf",
    )


async def test_critico_rechaza_y_redactor_corrige_antes_de_publicar(
    settings_override, fake_openai, monkeypatch
):
    monkeypatch.setenv("PRE_RESPONSE_REVIEW_MAX_REVISIONS", "1")
    get_settings.cache_clear()
    ch = _chunk()
    falsa = f"El AUC fue 0.99 {ch.cite()}."
    corregida = f"El AUC fue 0.94 {ch.cite()}."
    fake_openai.queue(
        make_json_completion({
            "veredictos": [{
                "i": 0, "veredicto": "no_sostenida",
                "motivo": "el fragmento dice 0.94",
            }]
        }),
        make_text_completion(corregida, usage=make_usage(80, 12)),
        make_json_completion({
            "veredictos": [{
                "i": 0, "veredicto": "sostenida", "motivo": "coincide",
            }]
        }),
    )
    telemetry.start()

    resultado = await revisor.revisar_antes_de_publicar(
        "cual fue el AUC",
        falsa,
        [{"role": "user", "content": "cual fue el AUC"}],
        [ch],
    )

    assert resultado.contenido == corregida
    assert resultado.revisiones == 1
    assert resultado.uso_abstencion_segura is False
    assert revisor.aprobada(resultado.informe)
    assert fake_openai.calls[1]["model"] == settings_override.openai_model
    assert "tools" not in fake_openai.calls[1]
    assert "CRITICA DEL BORRADOR" in fake_openai.calls[1]["messages"][-1]["content"]
    assert telemetry.current().rounds[-2].component == "revisor"


async def test_si_el_critico_falla_se_publica_abstencion_segura(
    settings_override, fake_openai
):
    ch = _chunk()
    fake_openai.queue(RuntimeError("gateway no disponible"))

    resultado = await revisor.revisar_antes_de_publicar(
        "cual fue el AUC",
        f"El AUC fue 0.94 {ch.cite()}.",
        [{"role": "user", "content": "cual fue el AUC"}],
        [ch],
    )

    assert resultado.contenido == revisor.ABSTENCION_SEGURA
    assert resultado.uso_abstencion_segura is True
    assert revisor.aprobada(resultado.informe)
    assert len(fake_openai.calls) == 1


async def test_si_la_correccion_sigue_mal_no_se_filtra_al_usuario(
    settings_override, fake_openai
):
    ch = _chunk()
    falsa = f"El AUC fue 0.99 {ch.cite()}."
    fake_openai.queue(
        make_json_completion({
            "veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "mal"}]
        }),
        make_text_completion(falsa),
        make_json_completion({
            "veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "sigue mal"}]
        }),
    )

    resultado = await revisor.revisar_antes_de_publicar(
        "cual fue el AUC",
        falsa,
        [{"role": "user", "content": "cual fue el AUC"}],
        [ch],
    )

    assert resultado.contenido == revisor.ABSTENCION_SEGURA
    assert resultado.uso_abstencion_segura is True
    assert "0.99" not in resultado.contenido
