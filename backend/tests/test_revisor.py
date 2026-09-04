"""La barrera previa nunca publica un borrador que el critico rechazo."""
from __future__ import annotations

from app.config import get_settings
from app.models import Chunk
from app.services import revisor, telemetry, verificador
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


# ---------------------------------------------------------------------------
# Cobertura por punto: informacion y critica, nunca motivo de abstencion
# ---------------------------------------------------------------------------
def _informe(**kw) -> verificador.Verificacion:
    return verificador.Verificacion(**kw)


def _sostenida(texto: str = "Dato", frags=("c1",)) -> verificador.Afirmacion:
    return verificador.Afirmacion(
        texto=texto, cita="[a.pdf, pág. 1]", veredicto=verificador.SOSTENIDA,
        fragmentos=list(frags),
    )


def test_aprobada_no_bloquea_por_evidencia_no_usada():
    """Regresion medida: con cobertura por punto, bloquear por
    evidencia_sin_cubrir habria mandado a abstencion segura CUALQUIER
    pregunta con un punto cuya evidencia el redactor decidio no usar, tras
    gastar los 280 s de presupuesto."""
    informe = _informe(
        afirmaciones=[_sostenida()],
        evidencia_sin_cubrir=["e2"],
        cobertura=[
            {"id": "e1", "evidence_needed": "a", "estado": "cubierto",
             "n_fragmentos": 1, "documentos": ["a.pdf"], "afirmaciones": [0]},
            {"id": "e2", "evidence_needed": "b", "estado": "evidencia_no_usada",
             "n_fragmentos": 2, "documentos": ["b.pdf"], "afirmaciones": []},
            {"id": "e3", "evidence_needed": "c", "estado": "sin_resultados",
             "n_fragmentos": 0, "documentos": [], "afirmaciones": []},
        ],
        fidelidad=1.0,
    )
    assert revisor.aprobada(informe) is True


def test_aprobada_sigue_bloqueando_la_atribucion_falsa():
    """Lo que no se relaja: una cita que no resuelve, una no sostenida o una
    respuesta factual sin citas nunca salen."""
    base = dict(afirmaciones=[_sostenida()], fidelidad=1.0)
    assert revisor.aprobada(_informe(**base, citas_sin_resolver=["[x, pág. 9]"])) is False
    con_no_resuelve = _informe(
        afirmaciones=[
            _sostenida(),
            verificador.Afirmacion(
                texto="Otro", cita="[x, pág. 9]", veredicto=verificador.CITA_NO_RESUELVE
            ),
        ],
        citas_sin_resolver=["[x, pág. 9]"],
    )
    assert revisor.aprobada(con_no_resuelve) is False
    con_no_sostenida = _informe(
        afirmaciones=[
            _sostenida(),
            verificador.Afirmacion(
                texto="Otro", cita="[a.pdf, pág. 1]", veredicto=verificador.NO_SOSTENIDA
            ),
        ],
    )
    assert revisor.aprobada(con_no_sostenida) is False
    sin_senal = _informe(
        afirmaciones=[
            verificador.Afirmacion(texto="x", cita="[a.pdf, pág. 1]")
        ],
        ok=False,
    )
    assert revisor.aprobada(sin_senal) is False


def test_la_critica_dice_punto_por_punto_que_hacer():
    informe = _informe(
        afirmaciones=[
            verificador.Afirmacion(
                texto="El AUC fue 0.99", cita="[a.pdf, pág. 1]",
                veredicto=verificador.NO_SOSTENIDA, motivo="dice 0.94",
                fragmentos=["c1"],
            )
        ],
        evidencia_sin_cubrir=["e2"],
        cobertura=[
            {"id": "e1", "evidence_needed": "el AUC", "estado": "evidencia_no_usada",
             "n_fragmentos": 1, "documentos": ["a.pdf"], "afirmaciones": [0]},
            {"id": "e2", "evidence_needed": "la mortalidad", "estado": "evidencia_no_usada",
             "n_fragmentos": 3, "documentos": ["Allegri et al., 2023", "b.pdf"],
             "afirmaciones": []},
            {"id": "e3", "evidence_needed": "los efectos adversos",
             "estado": "sin_resultados", "n_fragmentos": 0, "documentos": [],
             "afirmaciones": []},
            {"id": "e4", "evidence_needed": "la cohorte", "estado": "cubierto",
             "n_fragmentos": 1, "documentos": ["c.pdf"], "afirmaciones": []},
        ],
    )

    critica = revisor._critica(informe)

    assert "- no_sostenida: 'El AUC fue 0.99'" in critica
    assert (
        "- Punto e2 (la mortalidad): se recuperaron 3 fragmentos de "
        "Allegri et al., 2023, b.pdf y la respuesta no los usa ni los descarta"
    ) in critica
    assert "incorporalos con su cita o di explicitamente por que no responden" in critica
    assert (
        "- Punto e3 (los efectos adversos): el indice no tiene evidencia; "
        "declaralo con la formula 'No encuentro ... en los documentos', no lo rellenes"
    ) in critica
    # el punto cubierto no genera linea, y la lectura antigua no se duplica
    assert "Punto e4" not in critica
    assert "Evidencia requerida sin cubrir" not in critica


def test_la_critica_sin_mapa_conserva_la_lectura_antigua():
    informe = _informe(afirmaciones=[_sostenida()], evidencia_sin_cubrir=["e1", "e2"])
    critica = revisor._critica(informe)
    assert "- Evidencia requerida sin cubrir: e1" in critica
    assert "- Evidencia requerida sin cubrir: e2" in critica


def test_la_critica_anota_el_lote_caido_aunque_ok_siga_en_true():
    informe = _informe(
        afirmaciones=[
            _sostenida(),
            verificador.Afirmacion(texto="Otro", cita="[a.pdf, pág. 1]"),
        ],
        ok=True,
        nota="el verificador no pudo dictaminar 1 de 2 lotes; ...",
    )
    assert "no fue concluyente: el verificador no pudo dictaminar 1 de 2 lotes" in (
        revisor._critica(informe)
    )


async def test_un_punto_ausente_del_corpus_no_fuerza_la_abstencion(
    settings_override, fake_openai
):
    """Camino completo con mapa: la respuesta cubre e1, e2 no tenia nada en el
    indice. Antes: evidencia_sin_cubrir no vacio -> no aprobada -> ronda de
    correccion -> sigue sin cubrir -> abstencion segura. Ahora sale a la
    primera y el informe lleva la cobertura para la medica."""
    ch = _chunk()
    fake_openai.queue(
        make_json_completion({
            "veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "coincide"}]
        }),
    )

    resultado = await revisor.revisar_antes_de_publicar(
        "AUC y mortalidad",
        f"El AUC fue 0.94 {ch.cite()}. No encuentro la mortalidad en los documentos.",
        [{"role": "user", "content": "AUC y mortalidad"}],
        [ch],
        evidencia_requerida={"e0": "pregunta", "e1": "el AUC", "e2": "la mortalidad"},
        mapa_plan={"c1": {"e1"}},
    )

    assert resultado.uso_abstencion_segura is False
    assert resultado.revisiones == 0
    assert len(fake_openai.calls) == 1
    assert [(c["id"], c["estado"]) for c in resultado.informe.cobertura] == [
        ("e1", "cubierto"), ("e2", "sin_resultados"),
    ]
    assert resultado.informe.evidencia_sin_cubrir == []


async def test_la_correccion_recibe_la_cobertura_y_manda_razonamiento(
    settings_override, fake_openai, monkeypatch
):
    """Camino completo: un bloqueante obliga a corregir; la critica que llega
    al redactor nombra el punto con evidencia sin usar y el ausente, y la
    peticion lleva temperatura y razonamiento alto por crear_completion."""
    from app.services import openai_client

    openai_client._reset_razonamiento()
    monkeypatch.setenv("PRE_RESPONSE_REVIEW_MAX_REVISIONS", "1")
    get_settings.cache_clear()
    ch = _chunk()
    otro = Chunk(
        id="c2", text="La conversion fue del 31.6%.", source_file="otro.pdf",
        page=5, document_type="pdf", citation="Allegri et al., 2023",
    )
    falsa = f"El AUC fue 0.99 {ch.cite()}."
    corregida = (
        f"El AUC fue 0.94 {ch.cite()}. La conversion fue del 31.6% {otro.cite()}. "
        "No encuentro los efectos adversos en los documentos."
    )
    fake_openai.queue(
        make_json_completion({
            "veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "dice 0.94"}]
        }),
        make_text_completion(corregida, usage=make_usage(80, 12)),
        make_json_completion({
            "veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "coincide"},
                {"i": 1, "veredicto": "sostenida", "motivo": "coincide"},
            ]
        }),
    )
    telemetry.start()

    resultado = await revisor.revisar_antes_de_publicar(
        "AUC, conversion y efectos adversos",
        falsa,
        [{"role": "user", "content": "AUC, conversion y efectos adversos"}],
        [ch, otro],
        evidencia_requerida={
            "e0": "pregunta", "e1": "el AUC", "e2": "la conversion",
            "e3": "los efectos adversos",
        },
        mapa_plan={"c1": {"e1"}, "c2": {"e2"}},
    )

    assert resultado.contenido == corregida
    assert resultado.revisiones == 1
    assert resultado.uso_abstencion_segura is False
    correccion = fake_openai.calls[1]
    assert correccion["model"] == settings_override.openai_model
    assert correccion["temperature"] == settings_override.llm_temperature
    assert correccion["reasoning_effort"] == settings_override.revisor_reasoning_effort
    critica = correccion["messages"][-1]["content"]
    assert "Punto e2 (la conversion): se recuperaron 1 fragmentos de Allegri et al., 2023" in critica
    assert "Punto e3 (los efectos adversos): el indice no tiene evidencia" in critica
    # e1 tiene un bloqueante propio Y ademas figura como evidencia no usada:
    # una cita que no dice lo que la afirmacion dice no es usar la evidencia,
    # y tras corregir el bloqueante el punto quedaria sin cubrir. Al redactor
    # se le dicen las dos cosas para que corrija la cifra en vez de borrarla.
    assert "no_sostenida: 'El AUC fue 0.99'" in critica
    assert "Punto e1 (el AUC): se recuperaron 1 fragmentos de estudio.pdf" in critica
    # la cobertura final refleja la respuesta corregida
    assert [(c["id"], c["estado"]) for c in resultado.informe.cobertura] == [
        ("e1", "cubierto"), ("e2", "cubierto"), ("e3", "sin_resultados"),
    ]


async def test_la_abstencion_segura_lleva_cobertura_cuando_hay_mapa(
    settings_override, fake_openai
):
    ch = _chunk()
    fake_openai.queue(RuntimeError("gateway no disponible"))

    resultado = await revisor.revisar_antes_de_publicar(
        "cual fue el AUC",
        f"El AUC fue 0.94 {ch.cite()}.",
        [{"role": "user", "content": "cual fue el AUC"}],
        [ch],
        evidencia_requerida={"e0": "pregunta", "e1": "el AUC", "e2": "la mortalidad"},
        mapa_plan={"c1": {"e1"}},
    )

    assert resultado.contenido == revisor.ABSTENCION_SEGURA
    assert resultado.uso_abstencion_segura is True
    assert [(c["id"], c["estado"]) for c in resultado.informe.cobertura] == [
        ("e1", "evidencia_no_usada"), ("e2", "sin_resultados"),
    ]
    # y sigue aprobada: la cobertura no bloquea ni siquiera aqui
    assert revisor.aprobada(resultado.informe)


async def test_la_abstencion_segura_sin_mapa_no_inventa_cobertura(
    settings_override, fake_openai
):
    """Sin mapa no se le pasa el plan a la abstencion: produciria la lectura
    antigua "todo sin cubrir" sobre un texto que por definicion no cubre nada."""
    ch = _chunk()
    fake_openai.queue(RuntimeError("gateway no disponible"))

    resultado = await revisor.revisar_antes_de_publicar(
        "cual fue el AUC",
        f"El AUC fue 0.94 {ch.cite()}.",
        [{"role": "user", "content": "cual fue el AUC"}],
        [ch],
        evidencia_requerida={"e0": "pregunta", "e1": "el AUC"},
    )

    assert resultado.informe.cobertura == []
    assert resultado.informe.evidencia_sin_cubrir == []
