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


async def test_una_respuesta_larga_se_verifica_EN_LOTES_sin_dejar_nada_fuera(
    settings_override, fake_openai, monkeypatch
):
    """El tope acota el tamaño de cada petición, no cuánto se verifica.

    Antes recortaba: lo que excedía el tope quedaba `sin_verificar`, y eso
    convertía el límite en un agujero silencioso justo en las respuestas
    largas, que son las que más afirman. Una sesión de estrés midió 34 y 36
    afirmaciones con 10 y 12 sin juzgar. Se sigue acotando el request porque
    pedir una lista muy larga de veredictos en un solo JSON degrada el
    dictamen, pero ahora se manda en varias.
    """
    monkeypatch.setenv("VERIFIER_MAX_CLAIMS", "2")
    get_settings.cache_clear()

    chunks = [_chunk(f"c{i}", f"Dato {i}.", f"doc_{i}.pdf", i + 1) for i in range(4)]
    respuesta = " ".join(f"Afirmación {i} {c.cite()}." for i, c in enumerate(chunks))
    # dos lotes de dos: el indice `i` de cada respuesta es LOCAL a su lote
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                {"i": 1, "veredicto": "no_sostenida", "motivo": "no consta"},
            ]}
        ),
        make_json_completion(
            {"veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                {"i": 1, "veredicto": "parcial", "motivo": "a medias"},
            ]}
        ),
    )

    informe = await verificar(respuesta, chunks)

    # las CUATRO juzgadas, y cada veredicto en su afirmación correcta
    assert _veredictos(informe) == [SOSTENIDA, NO_SOSTENIDA, SOSTENIDA, PARCIAL]
    assert SIN_VERIFICAR not in _veredictos(informe)
    assert informe.fidelidad == pytest.approx(0.5)
    assert len(fake_openai.calls) == 2  # dos peticiones, no una gigante


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


# ---------------------------------------------------------------------------
# Regresiones encontradas en revisión: la fidelidad reportada era una
# garantía falsa por dos vías distintas
# ---------------------------------------------------------------------------
async def test_una_lista_con_una_sola_cita_audita_todas_sus_vinetas(
    settings_override, fake_openai
):
    """El prompt del agente empuja a citar UNA vez por lista ("no repitas la
    misma cita en cada punto si todos salen del mismo sitio"), y antes solo se
    auditaba la última frase del tramo: cinco viñetas factuales producían una
    afirmación y un informe de "fidelidad 1.0". Las otras cuatro no salían ni
    como sostenidas ni como sin verificar: desaparecían.
    """
    ch = _chunk("c1", "Datos del estudio.", "estudio.pdf", 3)
    respuesta = (
        "Los hallazgos principales son:\n"
        "- La conversion fue del 31.6%.\n"
        "- El AUC de p-tau217 fue 0.94.\n"
        f"- La cohorte incluyo 412 pacientes {ch.cite()}."
    )
    fake_openai.queue(
        make_json_completion(
            {
                "veredictos": [
                    {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                    {"i": 1, "veredicto": "no_sostenida", "motivo": "no consta"},
                    {"i": 2, "veredicto": "sostenida", "motivo": "ok"},
                ]
            }
        )
    )

    informe = await verificar(respuesta, [ch])

    # las tres viñetas, no solo la última
    assert len(informe.afirmaciones) == 3
    assert [a.veredicto for a in informe.afirmaciones] == [
        SOSTENIDA, NO_SOSTENIDA, SOSTENIDA,
    ]
    # y la fidelidad ya no miente: 2 de 3, no 1.0
    assert informe.fidelidad == pytest.approx(2 / 3)
    # el encabezado "Los hallazgos principales son:" no es una afirmación
    assert all("hallazgos principales" not in a.texto for a in informe.afirmaciones)


async def test_el_punto_suelto_tras_una_cita_no_es_una_afirmacion(
    settings_override, fake_openai
):
    """Al trocear por citas, tras cada una queda el punto de la frase anterior.
    Sin filtro de contenido se colaba como una afirmación cuyo texto era "."."""
    a = _chunk("c1", "Primero.", "a.pdf", 1)
    b = _chunk("c2", "Segundo.", "b.pdf", 2)
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

    informe = await verificar(f"Uno {a.cite()}. Dos {b.cite()}.", [a, b])

    assert len(informe.afirmaciones) == 2
    assert all(a.texto.strip() not in {".", ""} for a in informe.afirmaciones)


async def test_una_cita_compartida_por_varios_fragmentos_los_manda_todos(
    settings_override, fake_openai
):
    """`cite()` no es única: su localizador es la página, y con fragmentos de
    ~400 tokens una página de paper produce dos o tres con la MISMA cita.

    Antes el índice era un dict de un fragmento por cita y se quedaba con el
    último, así que una afirmación sacada del primero se dictaminaba contra el
    texto del otro: producía `no_sostenida` falsos y, peor, `sostenida` falsos
    cuando el hermano decía algo parecido.
    """
    a = Chunk(id="c1", text="La conversion fue del 31.6%.", source_file="e.pdf",
              page=4, document_type="pdf", citation="Allegri et al., 2023")
    b = Chunk(id="c2", text="El AUC fue 0.94.", source_file="e.pdf",
              page=4, document_type="pdf", citation="Allegri et al., 2023")
    assert a.cite() == b.cite()  # la premisa del bug

    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "consta"}]}
        )
    )

    informe = await verificar(f"La conversion fue del 31.6% {a.cite()}.", [a, b])

    assert [x.veredicto for x in informe.afirmaciones] == [SOSTENIDA]
    # los DOS textos viajan al modelo: si solo fuera el ultimo, la afirmacion
    # se juzgaria contra "El AUC fue 0.94." y saldria no sostenida
    enviado = fake_openai.calls[0]["messages"][-1]["content"]
    assert "La conversion fue del 31.6%." in enviado
    assert "El AUC fue 0.94." in enviado
    assert "FRAGMENTO 1 DE 2" in enviado


async def test_una_respuesta_de_inventario_no_es_una_afirmacion_sin_cita(
    settings_override, fake_openai
):
    """Regresión de una sesión de estrés.

    La herramienta de inventario le indica al modelo citar el catálogo como
    `[inventario del índice]`, que a propósito NO casa con CITATION_RE: no
    apunta a un fragmento, apunta a un conteo exacto de Qdrant. Al no
    reconocerla, "tienes 12 documentos indexados y son estos" se leía como una
    respuesta que afirma sin citar nada -el peor veredicto posible- cuando en
    realidad citó la única fuente que existe para ese dato.
    """
    informe = await verificar(
        "Hay 12 documentos indexados y 173 fragmentos en total "
        "[inventario del índice].",
        [],
    )

    assert informe.ok is True
    assert informe.afirmaciones == []
    assert informe.fidelidad is None
    assert "inventario del índice" in informe.nota
    assert fake_openai.calls == []


async def test_la_cita_de_inventario_se_reconoce_sin_tilde_ni_mayusculas(
    settings_override, fake_openai
):
    """El modelo copia la cita, pero no se puede confiar en que respete la
    tilde: fallar por eso devolvería el falso positivo por la puerta de atrás."""
    for variante in (
        "Hay 3 documentos [inventario del indice].",
        "Hay 3 documentos [Inventario del Índice].",
    ):
        informe = await verificar(variante, [])
        assert informe.ok is True, variante
        assert informe.afirmaciones == [], variante


async def test_citar_el_inventario_no_blanquea_una_respuesta_de_contenido(
    settings_override, fake_openai
):
    """Lo que NO puede pasar: que mencionar el inventario sirva de comodín. Si
    la respuesta trae citas de fragmentos, esas se auditan igual."""
    ch = _chunk("c1", "La conversion fue del 31.6%.", "e.pdf", 3)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "no consta"}]}
        )
    )

    informe = await verificar(
        f"Hay 3 documentos [inventario del índice]. El AUC fue 0.99 {ch.cite()}.",
        [ch],
    )

    assert [a.veredicto for a in informe.afirmaciones] == [NO_SOSTENIDA]
    assert informe.fidelidad == 0.0


async def test_una_afirmacion_despues_de_la_ultima_cita_no_desaparece(
    settings_override, fake_openai
):
    ch = _chunk("c1", "El AUC fue 0.94.", "e.pdf", 3)
    fake_openai.queue(
        make_json_completion({
            "veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "coincide"}
            ]
        })
    )

    informe = await verificar(
        f"El AUC fue 0.94 {ch.cite()}. La cohorte tuvo 900 pacientes.",
        [ch],
    )

    assert [a.veredicto for a in informe.afirmaciones] == [SOSTENIDA, SIN_CITA]
    assert informe.ok is False


# ---------------------------------------------------------------------------
# Declaraciones de ausencia: no son afirmaciones sobre una fuente
# ---------------------------------------------------------------------------
async def test_una_frase_de_abstencion_pegada_a_una_cita_no_se_audita(
    settings_override, fake_openai
):
    """Regresión de la sesión de estrés. "No encuentro la mortalidad a 90 días
    en los documentos" iba delante de una frase citada, quedaba adosada a esa
    cita, el juez la dictaminaba no_sostenida (el fragmento no habla de
    mortalidad, claro), y ese bloqueante tumbaba la respuesta en abstención
    segura. Es la conducta que el prompt del agente PIDE, castigada."""
    ch = _chunk("c1", "La conversion fue del 31.6%.", "e.pdf", 3)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "consta"}]}
        )
    )

    informe = await verificar(
        "No encuentro la mortalidad a 90 dias en los documentos. "
        f"La conversion fue del 31.6% {ch.cite()}.",
        [ch],
    )

    assert [a.texto for a in informe.afirmaciones] == ["La conversion fue del 31.6%"]
    assert _veredictos(informe) == [SOSTENIDA]
    assert informe.ok is True
    # y la declaracion no viajo al juez
    enviado = fake_openai.calls[0]["messages"][-1]["content"]
    assert "mortalidad" not in enviado


async def test_una_frase_de_abstencion_tras_la_ultima_cita_no_es_sin_cita(
    settings_override, fake_openai
):
    ch = _chunk("c1", "El AUC fue 0.94.", "e.pdf", 3)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "coincide"}]}
        )
    )

    informe = await verificar(
        f"El AUC fue 0.94 {ch.cite()}. Los documentos no mencionan la "
        "especificidad.",
        [ch],
    )

    assert _veredictos(informe) == [SOSTENIDA]
    assert informe.ok is True


async def test_una_frase_de_abstencion_con_su_propia_cita_es_una_abstencion(
    settings_override, fake_openai
):
    """Con cita al lado tampoco se audita: declarar ausencia no es atribuir.
    Si es lo unico que hay, la respuesta entera es una abstencion."""
    ch = _chunk("c1", "El AUC fue 0.94.", "e.pdf", 3)

    informe = await verificar(
        f"No encuentro la especificidad en los documentos {ch.cite()}.", [ch]
    )

    assert informe.afirmaciones == []
    assert informe.ok is True
    assert "se abstiene" in informe.nota
    assert fake_openai.calls == []


async def test_una_abstencion_no_blanquea_la_afirmacion_sin_cita_que_la_sigue(
    settings_override, fake_openai
):
    """Lo que NO puede pasar: que meter una frase de abstencion en medio sirva
    de comodin para colar una cifra sin fuente detras de la ultima cita."""
    ch = _chunk("c1", "El AUC fue 0.94.", "e.pdf", 3)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "coincide"}]}
        )
    )

    informe = await verificar(
        f"El AUC fue 0.94 {ch.cite()}. No encuentro la especificidad en los "
        "documentos. La cohorte tuvo 900 pacientes.",
        [ch],
    )

    assert _veredictos(informe) == [SOSTENIDA, SIN_CITA]
    assert informe.afirmaciones[1].texto == "La cohorte tuvo 900 pacientes."
    assert informe.ok is False


# ---------------------------------------------------------------------------
# Trazabilidad por fragmento y cobertura por punto del plan
# ---------------------------------------------------------------------------
def _hermanos() -> tuple[Chunk, Chunk]:
    a = Chunk(id="c1", text="La conversion fue del 31.6%.", source_file="e.pdf",
              page=4, document_type="pdf", citation="Allegri et al., 2023")
    b = Chunk(id="c2", text="El AUC fue 0.94.", source_file="e.pdf",
              page=4, document_type="pdf", citation="Allegri et al., 2023")
    return a, b


async def test_fragmentos_lleva_todos_los_hermanos_y_sobrevive_al_veredicto(
    settings_override, fake_openai
):
    a, b = _hermanos()
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "parcial", "motivo": "generaliza"}]}
        )
    )

    informe = await verificar(f"La conversion fue del 31.6% {a.cite()}.", [a, b])

    af = informe.afirmaciones[0]
    assert af.veredicto == PARCIAL
    assert af.fragmentos == ["c1", "c2"]
    assert af.fragmento_id == a.cite()  # compatibilidad


def _plan_de_cuatro():
    """e1 cubierto, e2 parcial, e3 evidencia sin usar, e4 sin resultados."""
    c1 = _chunk("c1", "Dato uno.", "uno.pdf", 1)
    c2 = _chunk("c2", "Dato dos.", "dos.pdf", 2)
    c3 = _chunk("c3", "Dato tres.", "tres.pdf", 3)
    c3b = _chunk("c3b", "Dato tres bis.", "tres_bis.pdf", 7)
    evidencia = {
        "e0": "respuesta directa a la pregunta tal como la formulo quien pregunta",
        "e1": "la conversion",
        "e2": "el AUC",
        "e3": "la mortalidad",
        "e4": "los efectos adversos",
    }
    mapa = {"c1": {"e1"}, "c2": {"e2"}, "c3": {"e3"}, "c3b": {"e3"}}
    return [c1, c2, c3, c3b], evidencia, mapa


async def test_cobertura_distingue_los_cuatro_estados_y_excluye_e0(
    settings_override, fake_openai
):
    import json

    chunks, evidencia, mapa = _plan_de_cuatro()
    c1, c2, c3, _ = chunks
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                {"i": 1, "veredicto": "parcial", "motivo": "generaliza"},
            ]}
        )
    )

    informe = await verificar(
        f"Uno {c1.cite()}. Dos {c2.cite()}.", chunks, evidencia, mapa_plan=mapa
    )

    assert [c["id"] for c in informe.cobertura] == ["e1", "e2", "e3", "e4"]
    por_id = {c["id"]: c for c in informe.cobertura}
    assert por_id["e1"]["estado"] == "cubierto"
    assert por_id["e1"]["afirmaciones"] == [0]
    assert por_id["e1"]["documentos"] == ["uno.pdf"]
    assert por_id["e2"]["estado"] == "parcial"
    assert por_id["e2"]["afirmaciones"] == [1]
    assert por_id["e3"]["estado"] == "evidencia_no_usada"
    assert por_id["e3"]["n_fragmentos"] == 2
    assert por_id["e3"]["documentos"] == ["tres.pdf", "tres_bis.pdf"]
    assert por_id["e3"]["afirmaciones"] == []
    assert por_id["e4"]["estado"] == "sin_resultados"
    assert por_id["e4"]["n_fragmentos"] == 0
    assert por_id["e4"]["documentos"] == []
    assert por_id["e1"]["evidence_needed"] == "la conversion"
    # sin_cubrir = SOLO los evidencia_no_usada: un punto sin resultados en el
    # indice no es un fallo del redactor, y ponerlo aqui llevaria a rellenarlo
    assert informe.evidencia_sin_cubrir == ["e3"]
    # y viaja por SSE
    plano = json.loads(json.dumps(informe.to_payload()))
    assert plano["cobertura"][3]["estado"] == "sin_resultados"


async def test_sobrecobertura_ambigua_cubre_ambos_puntos(settings_override, fake_openai):
    """Un fragmento traido por e1 y e3 cubre los dos. Se acepta antes que un
    falso "sin cubrir", que mandaria al redactor a rellenar lo ya respondido."""
    c1 = _chunk("c1", "Dato.", "uno.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "ok"}]}
        )
    )

    informe = await verificar(
        f"Dato {c1.cite()}.", [c1],
        {"e0": "pregunta", "e1": "a", "e3": "b"},
        mapa_plan={"c1": {"e1", "e3"}},
    )

    assert [(c["id"], c["estado"]) for c in informe.cobertura] == [
        ("e1", "cubierto"), ("e3", "cubierto"),
    ]
    assert informe.evidencia_sin_cubrir == []


async def test_una_afirmacion_no_sostenida_no_cubre_su_punto(
    settings_override, fake_openai
):
    """Citar el fragmento del punto diciendo algo que no dice no es usar la
    evidencia: el punto queda evidencia_no_usada para que la critica pida
    incorporarlo bien o descartarlo explicitamente."""
    c1 = _chunk("c1", "El AUC fue 0.94.", "uno.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "no_sostenida", "motivo": "dice 0.94"}]}
        )
    )

    informe = await verificar(
        f"El AUC fue 0.99 {c1.cite()}.", [c1],
        {"e0": "pregunta", "e1": "el AUC"}, mapa_plan={"c1": {"e1"}},
    )

    assert informe.cobertura[0]["estado"] == "evidencia_no_usada"
    assert informe.cobertura[0]["afirmaciones"] == [0]
    assert informe.evidencia_sin_cubrir == ["e1"]


async def test_una_afirmacion_sin_verificar_deja_su_punto_en_parcial(
    settings_override, fake_openai
):
    """Si el juez no llego, la respuesta SI uso esa evidencia (esta citada y es
    trazable); decir "no la usa" seria falso y mandaria al redactor a
    incorporar lo que ya esta. Parcial es el estado que dice "usada, no
    confirmada", y no entra en evidencia_sin_cubrir."""
    c1 = _chunk("c1", "Dato.", "uno.pdf", 1)
    fake_openai.queue(RuntimeError("API caida"))

    informe = await verificar(
        f"Dato {c1.cite()}.", [c1],
        {"e0": "pregunta", "e1": "a"}, mapa_plan={"c1": {"e1"}},
    )

    assert _veredictos(informe) == [SIN_VERIFICAR]
    assert informe.cobertura[0]["estado"] == "parcial"
    assert informe.evidencia_sin_cubrir == []


async def test_una_abstencion_completa_con_mapa_devuelve_cobertura(
    settings_override, fake_openai
):
    """Cuando el sistema se abstiene la medica tiene que ver igual que puntos
    tenian evidencia recuperada y cuales no."""
    chunks, evidencia, mapa = _plan_de_cuatro()

    informe = await verificar(
        "No encuentro esa informacion en los documentos.", chunks, evidencia,
        mapa_plan=mapa,
    )

    assert informe.ok is True
    assert [(c["id"], c["estado"]) for c in informe.cobertura] == [
        ("e1", "evidencia_no_usada"), ("e2", "evidencia_no_usada"),
        ("e3", "evidencia_no_usada"), ("e4", "sin_resultados"),
    ]
    assert informe.evidencia_sin_cubrir == ["e1", "e2", "e3"]
    assert fake_openai.calls == []


async def test_una_respuesta_sin_citas_con_mapa_usa_la_cobertura_por_punto(
    settings_override, fake_openai
):
    """Con mapa, el sin_cubrir de la respuesta sin citas ya no es "todo el
    plan": e0 queda fuera y un punto sin resultados no se le reprocha."""
    chunks, evidencia, mapa = _plan_de_cuatro()

    informe = await verificar(
        "Los tres estudios coinciden.", chunks, evidencia, mapa_plan=mapa
    )

    assert _veredictos(informe) == [SIN_CITA]
    assert informe.evidencia_sin_cubrir == ["e1", "e2", "e3"]
    assert informe.cobertura[-1]["estado"] == "sin_resultados"


async def test_sin_mapa_se_conserva_el_todo_o_nada(settings_override, fake_openai):
    """Compatibilidad: quien no pasa mapa recibe lo de siempre, sin cobertura."""
    c1 = _chunk("c1", "Dato.", "uno.pdf", 1)
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "ok"}]}
        )
    )

    informe = await verificar(
        f"Dato {c1.cite()}.", [c1], {"e0": "pregunta", "e1": "a", "e2": "b"}
    )

    assert informe.cobertura == []
    assert informe.evidencia_sin_cubrir == []


def test_cobertura_es_pura_y_no_necesita_modelo():
    """La funcion se puede llamar sin settings ni cliente: es codigo."""
    c1 = _chunk("c1", "Dato.", "uno.pdf", 1)
    afs = [
        verificador.Afirmacion(
            texto="Dato", cita=c1.cite(), veredicto=SOSTENIDA, fragmentos=["c1"]
        )
    ]
    cob = verificador._cobertura(
        {"e0": "x", "e1": "a", "e2": "b"}, {"c1": {"e1"}}, afs, {"c1": c1}
    )
    assert [(c["id"], c["estado"]) for c in cob] == [
        ("e1", "cubierto"), ("e2", "sin_resultados"),
    ]


# ---------------------------------------------------------------------------
# Lotes en paralelo: uno caido no tira el resto; todos caidos = sin señal
# ---------------------------------------------------------------------------
async def test_un_lote_caido_conserva_los_veredictos_de_los_demas(
    settings_override, fake_openai, monkeypatch
):
    """Antes una sola excepcion vaciaba `fallos`: todo sin_verificar, o sea
    sin señal, o sea abstencion segura por un 500 en UN lote."""
    monkeypatch.setenv("VERIFIER_MAX_CLAIMS", "2")
    get_settings.cache_clear()
    chunks = [_chunk(f"c{i}", f"Dato {i}.", f"doc_{i}.pdf", i + 1) for i in range(4)]
    respuesta = " ".join(f"Afirmación {i} {c.cite()}." for i, c in enumerate(chunks))
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [
                {"i": 0, "veredicto": "sostenida", "motivo": "ok"},
                {"i": 1, "veredicto": "no_sostenida", "motivo": "no consta"},
            ]}
        ),
        RuntimeError("500 en el segundo lote"),
    )

    informe = await verificar(respuesta, chunks)

    assert _veredictos(informe) == [SOSTENIDA, NO_SOSTENIDA, SIN_VERIFICAR, SIN_VERIFICAR]
    assert informe.fidelidad == pytest.approx(0.5)
    # no es "sin señal": hay veredictos con los que corregir
    assert informe.ok is True
    assert "1 de 2 lotes" in informe.nota
    assert "afirmaciones 2-3" in informe.nota
    assert "500 en el segundo lote" in informe.nota
    assert len(fake_openai.calls) == 2


async def test_todos_los_lotes_caidos_es_sin_senal(
    settings_override, fake_openai, monkeypatch
):
    from app.services import revisor

    monkeypatch.setenv("VERIFIER_MAX_CLAIMS", "1")
    get_settings.cache_clear()
    a = _chunk("c1", "Uno.", "a.pdf", 1)
    b = _chunk("c2", "Dos.", "b.pdf", 2)
    fake_openai.queue(RuntimeError("caido 1"), RuntimeError("caido 2"))

    informe = await verificar(f"Uno {a.cite()}. Dos {b.cite()}.", [a, b])

    assert _veredictos(informe) == [SIN_VERIFICAR, SIN_VERIFICAR]
    assert informe.ok is False
    assert "no pudo dictaminar" in informe.nota
    assert revisor.sin_senal(informe) is True


async def test_los_lotes_se_ejecutan_en_paralelo(
    settings_override, fake_openai, monkeypatch
):
    """Prueba directa de concurrencia: cada lote espera a que el OTRO tambien
    este en vuelo. Si fueran secuenciales, el primero se quedaria esperando
    solo, la barrera venceria por timeout y los dos lotes "caerian"."""
    import asyncio

    monkeypatch.setenv("VERIFIER_MAX_CLAIMS", "1")
    get_settings.cache_clear()
    barrera = asyncio.Barrier(2)

    async def dictaminar_con_barrera(pendientes):
        await asyncio.wait_for(barrera.wait(), timeout=1.0)
        return {0: ("sostenida", "ok")}

    monkeypatch.setattr(verificador, "_dictaminar", dictaminar_con_barrera)
    a = _chunk("c1", "Uno.", "a.pdf", 1)
    b = _chunk("c2", "Dos.", "b.pdf", 2)

    informe = await verificar(f"Uno {a.cite()}. Dos {b.cite()}.", [a, b])

    assert _veredictos(informe) == [SOSTENIDA, SOSTENIDA]
    assert informe.nota == ""


async def test_el_juez_recibe_razonamiento_y_cabecera_por_fragmento(
    settings_override, fake_openai
):
    from app.services import openai_client

    openai_client._reset_razonamiento()
    tabla = Chunk(
        id="t1", text="Fila: AUC 0.94", source_file="tab.xlsx", page=3,
        document_type="xlsx", chunk_type="table", section="Resultados",
        citation="Allegri et al., 2023",
    )
    fake_openai.queue(
        make_json_completion(
            {"veredictos": [{"i": 0, "veredicto": "sostenida", "motivo": "ok"}]}
        )
    )

    await verificar(f"El AUC fue 0.94 {tabla.cite()}.", [tabla])

    llamada = fake_openai.calls[0]
    assert llamada["reasoning_effort"] == settings_override.verifier_reasoning_effort
    assert llamada["temperature"] == settings_override.llm_temperature
    enviado = llamada["messages"][-1]["content"]
    assert "fuente: Allegri et al., 2023" in enviado
    assert "sección: Resultados" in enviado
    assert "tipo: tabla" in enviado
    assert "FRAGMENTO 1 DE 1" in enviado
