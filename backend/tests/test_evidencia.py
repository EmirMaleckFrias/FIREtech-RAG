"""Pipeline de evidencia (app/services/evidencia.py).

Lo que se prueba es la promesa del módulo: la evidencia es una función
DETERMINISTA de (plan, índice). Cada test intenta romper una de las
suposiciones que introduce: que la fusión no depende de qué búsqueda respondió
antes, que la cuota por documento no expulsa a los mejores, que las tablas no
se recortan, que dos fragmentos contiguos no se funden, que un calificador
caído degrada sin mentir y que un punto que no llega no tumba a los demás.
"""
from __future__ import annotations

import asyncio
import types

import pytest

from app.config import get_settings
from app.models import Chunk, SearchFilters
from app.services import evidencia, modos, reranker
from app.services.planner import PlanItem
from app.services.reranker import Calificacion


# ---------------------------------------------------------------------------
# utilidades
# ---------------------------------------------------------------------------
def _chunk(
    id: str,
    doc: str = "a.pdf",
    page: int = 1,
    text: str | None = None,
    section: str = "",
    chunk_type: str = "text",
) -> Chunk:
    return Chunk(
        id=id,
        text=text if text is not None else f"texto de {id}",
        source_file=doc,
        page=page,
        document_type="pdf",
        section=section,
        chunk_type=chunk_type,
    )


class _Perfil:
    def __init__(self, fragmentos: int) -> None:
        self.fragmentos = fragmentos


@pytest.fixture
def busqueda(monkeypatch):
    """Sustituye `hybrid_search` por un diccionario consulta -> lista de chunks
    y registra cada consulta lanzada."""
    estado: dict = {"por_consulta": {}, "llamadas": [], "por_defecto": []}

    async def _hybrid(query, filters, top_k):
        estado["llamadas"].append(query)
        valor = estado["por_consulta"].get(query, estado["por_defecto"])
        if isinstance(valor, BaseException):
            raise valor
        if callable(valor):
            return await valor()
        return list(valor)

    monkeypatch.setattr(evidencia, "hybrid_search", _hybrid)
    return estado


@pytest.fixture
def calificador(monkeypatch):
    """Calificador determinista: el grado sale de `estado["grados"]` por id de
    chunk (default "directa"). Registra qué candidatos vio."""
    estado: dict = {"grados": {}, "vistos": [], "fallo": None, "verificado": True}

    async def _calificar(query, evidence_needed, chunks):
        estado["vistos"].append([c.id for c in chunks])
        if estado["fallo"] is not None:
            raise estado["fallo"]
        grados = {
            i: estado["grados"].get(c.id, "directa") for i, c in enumerate(chunks)
        }
        return Calificacion(grados, estado["verificado"], "falso")

    monkeypatch.setattr(reranker, "calificar_evidencia", _calificar)
    return estado


async def _punto(item: PlanItem, perfil, filtros=None) -> evidencia.PuntoEvidencia:
    ev = await evidencia.ejecutar_plan([item], perfil, filtros or SearchFilters())
    return ev.puntos[0]


# ---------------------------------------------------------------------------
# determinismo de punta a punta, con el Qdrant espía
# ---------------------------------------------------------------------------
def _point(id: str, doc: str, page: int, text: str, section: str = "Results", score: float = 0.5):
    return types.SimpleNamespace(
        id=id,
        score=score,
        payload={
            "text": text, "source_file": doc, "page": page, "section": section,
            "document_type": "pdf", "chunk_type": "text",
        },
    )


async def test_misma_entrada_mismos_ids_y_misma_huella(
    settings_override, fake_openai, fake_qdrant, calificador
):
    """La propiedad que justifica el módulo: mismo plan y mismo índice, mismos
    ids y misma huella, de punta a punta (embedding falso, Qdrant espía,
    calificador falso). El espía devuelve lo mismo en cada llamada, que es lo
    que hace un índice que no cambió; lo que aquí se prueba es que NADA del
    camino (fusión en paralelo, poda, cuota, calificación, orden final) añade
    azar propio."""
    puntos = [
        _point("c1", "a.pdf", 3, "p-tau217 AUC 0.94 en la cohorte clínica"),
        _point("c2", "b.pdf", 5, "AUC de 0.91 en la cohorte de validación"),
        _point("c3", "a.pdf", 7, "otro hallazgo del mismo estudio", "Discussion"),
        _point("c4", "c.pdf", 2, "la referencia 12 habla de p-tau217", "References"),
    ]
    fake_qdrant.set_response(
        "query_points", lambda kw: types.SimpleNamespace(points=list(puntos))
    )
    plan = [
        PlanItem("e0", "AUC de p-tau217", "el AUC"),
        PlanItem("e1", "cohorte de validación", "la cohorte", query_en="validation cohort"),
    ]

    a = await evidencia.ejecutar_plan(plan, _Perfil(8), SearchFilters())
    b = await evidencia.ejecutar_plan(plan, _Perfil(8), SearchFilters())

    assert [[c.id for c in p.fragmentos] for p in a.puntos] == [
        [c.id for c in p.fragmentos] for p in b.puntos
    ]
    assert evidencia.huella(a) == evidencia.huella(b)
    assert len(evidencia.huella(a)) == 64
    # e1 lanzó DOS búsquedas (query y query_en), e0 una: tres en total por plan.
    assert len(fake_qdrant.calls_to("query_points")) == 6
    # La bibliografía no llegó ni al calificador.
    assert all("c4" not in vistos for vistos in calificador["vistos"])
    # Y la huella SÍ cambia cuando cambia la evidencia: no es una constante.
    fake_qdrant.set_response(
        "query_points", lambda kw: types.SimpleNamespace(points=puntos[:1])
    )
    c = await evidencia.ejecutar_plan(plan, _Perfil(8), SearchFilters())
    assert evidencia.huella(c) != evidencia.huella(a)
    # Trazabilidad: cada fragmento sabe qué puntos lo trajeron.
    assert a.mapa["c1"] == {"e0", "e1"}
    assert a.grados["c1"] == "directa"


# ---------------------------------------------------------------------------
# fusión RRF
# ---------------------------------------------------------------------------
def test_rrf_premia_coincidir_en_las_dos_listas_y_desempata_con_orden_total():
    x = _chunk("x", doc="b.pdf", page=9)
    y = _chunk("y", doc="a.pdf", page=2)
    z = _chunk("z", doc="a.pdf", page=1)
    # x es 2º en las dos listas (2/62) y gana a cualquier primer puesto suelto
    # (1/61). y y z son 1º en una lista cada uno: empate exacto, y el
    # desempate es por (source_file, page, id), no por el orden de llegada.
    fusion = evidencia.fusionar_rrf([[y, x], [z, x]])
    assert [c.id for c in fusion] == ["x", "z", "y"]
    # Cambiar el orden de las listas (la otra búsqueda respondió antes) no
    # cambia nada.
    assert [c.id for c in evidencia.fusionar_rrf([[z, x], [y, x]])] == ["x", "z", "y"]
    # Y sin empate manda la suma RRF, no el documento: y (1º) antes que z (2º).
    assert [c.id for c in evidencia.fusionar_rrf([[y, z]])] == ["y", "z"]


async def test_query_en_lanza_una_segunda_busqueda_solo_si_difiere(
    settings_override, busqueda, calificador
):
    await _punto(PlanItem("e1", "tau en plasma", "dato", query_en="plasma tau"), _Perfil(4))
    assert busqueda["llamadas"] == ["tau en plasma", "plasma tau"]

    busqueda["llamadas"].clear()
    await _punto(PlanItem("e1", "Plasma tau", "dato", query_en="plasma  tau"), _Perfil(4))
    assert busqueda["llamadas"] == ["Plasma tau"]

    busqueda["llamadas"].clear()
    await _punto(PlanItem("e0", "pregunta literal", "dato"), _Perfil(4))
    assert busqueda["llamadas"] == ["pregunta literal"]


# ---------------------------------------------------------------------------
# poda, dedup
# ---------------------------------------------------------------------------
async def test_poda_bibliografia_y_afines_pero_no_secciones_desconocidas(
    settings_override, busqueda, calificador
):
    busqueda["por_defecto"] = [
        _chunk("r1", section="Results"),
        _chunk("bib", section="Referencias bibliográficas"),
        _chunk("ack", section="Acknowledgements"),
        _chunk("fun", section="Funding"),
        _chunk("coi", section="Conflicts of interest"),
        _chunk("raro", section="Anexo Z"),
        _chunk("sin", section=""),
    ]
    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(10))

    assert calificador["vistos"] == [["r1", "raro", "sin"]]
    assert [c.id for c in p.fragmentos] == ["r1", "raro", "sin"]


async def test_no_se_funden_fragmentos_contiguos_que_comparten_un_parrafo(
    settings_override, busqueda, calificador
):
    """Dos fragmentos contiguos comparten el solape (unos 60 de 400 tokens) y
    son dos evidencias distintas. Solo el texto IDÉNTICO es un duplicado."""
    solape = "La cohorte incluyó 312 participantes con deterioro cognitivo leve. "
    a = _chunk("a", text="Métodos. " + solape + "Se midió p-tau217 en plasma.")
    b = _chunk("b", text=solape + "El AUC fue 0.94 frente a 0.81 del p-tau181.")
    identico = _chunk("b-bis", text=b.text.upper())  # mismo texto, otra forma
    mismo_id = _chunk("a", text="otro texto con el mismo id")
    busqueda["por_defecto"] = [a, b, identico, mismo_id]

    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(10))

    assert [c.id for c in p.fragmentos] == ["a", "b"]


# ---------------------------------------------------------------------------
# cuota por documento y tablas
# ---------------------------------------------------------------------------
async def test_la_cuota_mete_al_segundo_documento_sin_expulsar_a_los_mejores(
    settings_override, busqueda, calificador
):
    """El fallo medido: un paper largo ocupaba los 12 huecos. La cuota mete al
    segundo documento, pero desplaza a los ÚLTIMOS del primero, no a sus
    mejores fragmentos."""
    a = [_chunk(f"a{i}", doc="a.pdf", page=i) for i in range(1, 11)]
    b = [_chunk(f"b{i}", doc="b.pdf", page=i) for i in range(1, 3)]
    busqueda["por_defecto"] = a + b

    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(4))

    assert [c.id for c in p.fragmentos] == ["a1", "a2", "b1", "b2"]
    assert p.estado == "cubierto"


async def test_la_cuota_es_un_suelo_no_un_tope(settings_override, busqueda, calificador):
    """Con un solo documento, o con un segundo documento sin nada relevante,
    la cuota no toca el ranking: el primer documento se queda sus huecos."""
    a = [_chunk(f"a{i}", doc="a.pdf", page=i) for i in range(1, 8)]
    b = [_chunk("b1", doc="b.pdf", page=1)]
    busqueda["por_defecto"] = a + b
    calificador["grados"] = {"b1": "no"}

    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(4))

    assert [c.id for c in p.fragmentos] == ["a1", "a2", "a3", "a4"]


def test_las_tablas_nunca_se_recortan_por_documento():
    """Una fila con la cifra es justo lo que se busca y suele quedar abajo del
    ranking porque tiene poco texto: la cuota desplaza texto, no tablas."""
    ordenados = [
        _chunk("a1", doc="a.pdf", page=1),
        _chunk("a2", doc="a.pdf", page=2),
        _chunk("t1", doc="a.pdf", page=3, chunk_type="table"),
        _chunk("a4", doc="a.pdf", page=4),
        _chunk("b1", doc="b.pdf", page=1),
        _chunk("b2", doc="b.pdf", page=2),
    ]
    sel = evidencia.seleccionar_con_cuota(ordenados, tope=4, cuota=2)
    assert [c.id for c in sel] == ["a1", "t1", "b1", "b2"]
    # Y el tope se respeta aunque solo queden tablas por desplazar: la cuota
    # cede antes que recortar una tabla o pasarse de fragmentos.
    solo_tablas = [
        _chunk("t1", doc="a.pdf", page=1, chunk_type="table"),
        _chunk("t2", doc="a.pdf", page=2, chunk_type="table"),
        _chunk("t3", doc="a.pdf", page=3, chunk_type="table"),
        _chunk("b1", doc="b.pdf", page=1),
    ]
    sel = evidencia.seleccionar_con_cuota(solo_tablas, tope=3, cuota=2)
    assert [c.id for c in sel] == ["t1", "t2", "t3"]


async def test_la_preseleccion_de_candidatos_tambien_reparte_por_documento(
    settings_override, busqueda, calificador, monkeypatch
):
    """Antes del calificador ya se garantiza que un segundo documento llegue a
    ser leído: si no, el calificador nunca lo ve y la cuota final no tiene
    con qué trabajar."""
    monkeypatch.setenv("EVIDENCE_CANDIDATES_PER_ITEM", "6")
    get_settings.cache_clear()
    a = [_chunk(f"a{i}", doc="a.pdf", page=i) for i in range(1, 21)]
    b = [_chunk(f"b{i}", doc="b.pdf", page=i) for i in range(1, 4)]
    busqueda["por_defecto"] = a + b

    await _punto(PlanItem("e1", "q", "dato"), _Perfil(4))

    vistos = calificador["vistos"][0]
    assert len(vistos) == 6
    assert vistos == ["a1", "a2", "a3", "b1", "b2", "b3"]


# ---------------------------------------------------------------------------
# orden final: grado > sección > RRF > id
# ---------------------------------------------------------------------------
async def test_orden_final_grado_luego_seccion_luego_rrf(
    settings_override, busqueda, calificador
):
    busqueda["por_defecto"] = [
        _chunk("disc-parcial", section="Discussion"),
        _chunk("intro-directa", section="Introduction"),
        _chunk("res-directa", section="Results"),
        _chunk("no", section="Results"),
        _chunk("rara-directa", section="Sección desconocida"),
        _chunk("disc-directa", section="Discusión"),
    ]
    calificador["grados"] = {"disc-parcial": "parcial", "no": "no"}

    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(10))

    assert [c.id for c in p.fragmentos] == [
        "res-directa",        # directa, Resultados (3)
        "disc-directa",       # directa, Discusión (1.5)
        "intro-directa",      # directa, neutro (1), RRF 2º
        "rara-directa",       # directa, neutro (1), RRF 5º
        "disc-parcial",       # parcial va detrás de toda directa
    ]
    assert p.grados == {
        "res-directa": "directa", "disc-directa": "directa",
        "intro-directa": "directa", "rara-directa": "directa",
        "disc-parcial": "parcial",
    }
    assert p.relevancia_verificada is True


async def test_un_grado_ausente_con_verificado_true_no_descarta_el_fragmento(
    settings_override, busqueda, calificador, monkeypatch
):
    """El calificador real puede omitir un índice y aun así decir
    verificado=True. Tratarlo como "no" perdía evidencia en silencio; se
    ordena como parcial y se entrega SIN grado, para que nadie lo lea como
    juzgado."""
    busqueda["por_defecto"] = [_chunk("omitido", section="Results"), _chunk("directo"), _chunk("no")]

    async def _parcialmente(query, evidence_needed, chunks):
        return Calificacion({1: "directa", 2: "no"}, True, "el modelo omitió el 0")

    monkeypatch.setattr(reranker, "calificar_evidencia", _parcialmente)
    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(4))

    assert [c.id for c in p.fragmentos] == ["directo", "omitido"]
    assert p.grados == {"directo": "directa"}  # el omitido va sin grado
    assert p.relevancia_verificada is True
    texto = evidencia.texto_de_punto(p)
    assert texto.count("(evidencia directa para este punto)") == 1


def test_peso_de_seccion_desconocida_es_neutro_y_nunca_descarta():
    assert evidencia.peso_seccion("Results") == 3.0
    assert evidencia.peso_seccion("Resultados y discusión") == 3.0
    assert evidencia.peso_seccion("Métodos") == 2.0
    assert evidencia.peso_seccion("Abstract") == 2.0
    assert evidencia.peso_seccion("Conclusiones") == 1.5
    assert evidencia.peso_seccion("Introduction") == 1.0
    assert evidencia.peso_seccion("") == 1.0
    assert evidencia.peso_seccion("Cualquier cosa") == 1.0
    assert not evidencia.seccion_podada("Cualquier cosa")
    assert evidencia.seccion_podada("BIBLIOGRAFÍA")


# ---------------------------------------------------------------------------
# calificador caído, punto vacío, búsqueda caída, timeout
# ---------------------------------------------------------------------------
async def test_calificador_caido_entrega_orden_rrf_sin_marcar_relevancia(
    settings_override, busqueda, calificador
):
    busqueda["por_defecto"] = [
        _chunk("c1", section="Discussion"),
        _chunk("c2", section="Results"),
        _chunk("c3"),
    ]
    calificador["fallo"] = RuntimeError("api caída")

    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(2))

    # Orden RRF, no por sección: sin grados no hay orden "final" que aplicar.
    assert [c.id for c in p.fragmentos] == ["c1", "c2"]
    assert p.relevancia_verificada is False
    assert p.grados == {}
    assert p.estado == "cubierto"
    assert evidencia.AVISO_SIN_VERIFICAR in evidencia.texto_de_punto(p)

    # verificado=False sin excepción es el mismo caso.
    calificador["fallo"] = None
    calificador["verificado"] = False
    p2 = await _punto(PlanItem("e1", "q", "dato"), _Perfil(2))
    assert p2.relevancia_verificada is False
    assert [c.id for c in p2.fragmentos] == ["c1", "c2"]


async def test_punto_sin_candidatos_relevantes_dice_que_documentos_reviso(
    settings_override, busqueda, calificador
):
    busqueda["por_defecto"] = [
        _chunk(f"c{i}", doc=f"doc{i}.pdf") for i in range(7)
    ]
    calificador["grados"] = {f"c{i}": "no" for i in range(7)}

    p = await _punto(PlanItem("e1", "q", "el AUC en la cohorte"), _Perfil(4))

    assert p.estado == "sin_resultados"
    assert p.fragmentos == []
    assert p.documentos_revisados == [f"doc{i}.pdf" for i in range(5)]  # máx 5
    assert p.n_candidatos == 7
    texto = evidencia.texto_de_punto(p)
    assert texto.startswith("PUNTO e1 (el AUC en la cohorte): sin resultados")
    assert "se revisaron 7 fragmentos de doc0.pdf; doc1.pdf" in texto
    assert "ninguno aporta evidencia" in texto


async def test_indice_vacio_no_llama_al_calificador(settings_override, busqueda, calificador):
    p = await _punto(PlanItem("e1", "q", "dato"), _Perfil(4))
    assert p.estado == "sin_resultados"
    assert p.recuperacion == "dense"  # la búsqueda sí funcionó
    assert calificador["vistos"] == []
    assert "el índice no devolvió ningún fragmento" in evidencia.texto_de_punto(p)


async def test_busqueda_caida_marca_error_y_no_tumba_el_plan(
    settings_override, busqueda, calificador
):
    busqueda["por_consulta"] = {
        "rota": ConnectionError("qdrant caído"),
        "sana": [_chunk("ok")],
    }
    ev = await evidencia.ejecutar_plan(
        [PlanItem("e0", "rota", "d0"), PlanItem("e1", "sana", "d1")],
        _Perfil(4), SearchFilters(),
    )
    rota, sana = ev.puntos
    assert rota.estado == "sin_resultados" and rota.recuperacion == "error"
    assert "la búsqueda falló" in evidencia.texto_de_punto(rota)
    assert sana.estado == "cubierto" and [c.id for c in sana.fragmentos] == ["ok"]
    assert list(ev.acumulado) == ["ok"]


async def test_si_solo_falla_la_busqueda_en_ingles_se_sigue_con_la_otra(
    settings_override, busqueda, calificador
):
    busqueda["por_consulta"] = {
        "tau": [_chunk("t1")],
        "tau en": ConnectionError("una de las dos"),
    }
    p = await _punto(PlanItem("e1", "tau", "d", query_en="tau en"), _Perfil(4))
    assert p.estado == "cubierto"
    assert [c.id for c in p.fragmentos] == ["t1"]
    assert p.recuperacion == "dense"


async def test_un_punto_que_no_llega_a_tiempo_no_retrasa_a_los_demas(
    settings_override, busqueda, calificador, monkeypatch
):
    monkeypatch.setenv("EVIDENCE_PREFETCH_TIMEOUT_S", "0.05")
    get_settings.cache_clear()

    async def _cuelga():
        await asyncio.sleep(5)
        return [_chunk("tarde")]

    busqueda["por_consulta"] = {"lenta": _cuelga, "rapida": [_chunk("r")]}

    ev = await evidencia.ejecutar_plan(
        [PlanItem("e0", "lenta", "d0"), PlanItem("e1", "rapida", "d1")],
        _Perfil(4), SearchFilters(),
    )
    lenta, rapida = ev.puntos
    assert lenta.estado == "sin_resultados" and lenta.recuperacion == "error"
    assert rapida.estado == "cubierto"
    assert "no llegó a tiempo" in evidencia.texto_de_punto(lenta)
    assert "tarde" not in ev.acumulado


async def test_el_deadline_del_reloj_unico_recorta_el_timeout(
    settings_override, busqueda, calificador
):
    """Contrato G: un reloj por pregunta. Si al pipeline le quedan 0.05 s de
    presupuesto, no se toma los 45 s propios."""
    import time

    async def _cuelga():
        await asyncio.sleep(5)
        return []

    busqueda["por_consulta"] = {"lenta": _cuelga}
    t0 = time.perf_counter()
    ev = await evidencia.ejecutar_plan(
        [PlanItem("e0", "lenta", "d0")], _Perfil(4), SearchFilters(),
        deadline_monotonic=time.monotonic() + 0.05,
    )
    assert time.perf_counter() - t0 < 2.0
    assert ev.puntos[0].recuperacion == "error"


# ---------------------------------------------------------------------------
# mensajes sintéticos y búsqueda extra
# ---------------------------------------------------------------------------
async def test_mensajes_sinteticos_un_assistant_con_tool_calls_y_un_tool_por_punto(
    settings_override, busqueda, calificador
):
    import json

    busqueda["por_consulta"] = {
        "q0": [_chunk("c0", doc="a.pdf", page=1, section="Results")],
        "q1": [],
    }
    ev = await evidencia.ejecutar_plan(
        [PlanItem("e0", "q0", "respuesta directa"), PlanItem("e1", "q1", "la cohorte")],
        _Perfil(4), SearchFilters(),
    )
    mensajes = evidencia.mensajes_sinteticos(ev)

    assert [m["role"] for m in mensajes] == ["assistant", "tool", "tool"]
    llamadas = mensajes[0]["tool_calls"]
    assert [tc["id"] for tc in llamadas] == ["call_plan_e0", "call_plan_e1"]
    assert all(tc["function"]["name"] == "buscar_documentos" for tc in llamadas)
    assert json.loads(llamadas[1]["function"]["arguments"]) == {"semantico": "q1", "punto": "e1"}
    assert mensajes[0]["content"] is None
    assert [m["tool_call_id"] for m in mensajes[1:]] == ["call_plan_e0", "call_plan_e1"]
    # Cabecera de estado + el formato de resultados de siempre.
    t0 = mensajes[1]["content"]
    assert t0.startswith("PUNTO e0 (respuesta directa): cubierto, 1 fragmentos de: a.pdf")
    assert "--- Resultado 1 ---" in t0 and "cita: [a.pdf, pág. 1]" in t0
    assert "(sección del documento: Results)" in t0
    assert "(evidencia directa para este punto)" in t0
    assert mensajes[2]["content"].startswith("PUNTO e1 (la cohorte): sin resultados")
    assert evidencia.mensajes_sinteticos(evidencia.EvidenciaPlan()) == []


async def test_buscar_y_calificar_es_el_mismo_camino_para_una_consulta(
    settings_override, busqueda, calificador
):
    busqueda["por_defecto"] = [_chunk("x", section="References"), _chunk("y")]

    extra = await evidencia.buscar_y_calificar("q", "", "", _Perfil(4), None)
    assert extra.id == "extra"
    assert [c.id for c in extra.fragmentos] == ["y"]  # podado igual que el plan
    assert extra.evidence_needed == "q"
    assert evidencia.texto_de_punto(extra).startswith("BÚSQUEDA EXTRA (q): cubierto")

    con_punto = await evidencia.buscar_y_calificar("q", "el dato", "e2", _Perfil(4))
    assert con_punto.id == "e2"
    assert evidencia.texto_de_punto(con_punto).startswith("PUNTO e2 (el dato)")


def test_formatear_resultados_es_el_formato_de_siempre():
    """El verificador resuelve las citas por `Chunk.cite()`: la línea "cita:"
    tiene que seguir ahí, literal, y la sección en su propia línea."""
    texto = evidencia.formatear_resultados([_chunk("c", doc="p.pdf", page=3, section="Métodos")])
    assert texto == (
        "--- Resultado 1 ---\ncita: [p.pdf, pág. 3]\n"
        "(sección del documento: Métodos)\ntexto de c"
    )
    assert evidencia.formatear_resultados([]).startswith("Sin resultados")


async def test_acumulado_conserva_el_orden_del_plan_y_los_grados_no_vacios_ganan(
    settings_override, busqueda, calificador
):
    """Un mismo fragmento traído por dos puntos: aparece una vez, en el orden
    del primer punto que lo trajo, y con el grado del punto que sí lo
    calificó aunque otro lo entregara sin verificar."""
    comun = _chunk("comun")
    busqueda["por_consulta"] = {"q0": [comun, _chunk("solo0")], "q1": [_chunk("solo1"), comun]}
    ev = await evidencia.ejecutar_plan(
        [PlanItem("e0", "q0", "d0"), PlanItem("e1", "q1", "d1")], _Perfil(4), SearchFilters()
    )
    assert list(ev.acumulado) == ["comun", "solo0", "solo1"]
    assert ev.mapa == {"comun": {"e0", "e1"}, "solo0": {"e0"}, "solo1": {"e1"}}
    assert ev.grados["comun"] == "directa"
    assert modos.NORMAL.fragmentos >= 4  # el perfil real cabe en estas pruebas
