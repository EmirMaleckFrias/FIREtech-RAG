"""La herramienta del agente: qué texto recibe el modelo en cada situación.

Lo que se prueba aquí no es el formato sino el contrato de honestidad: el
modelo tiene que poder distinguir "esto es lo que hay", "no hay nada sobre
esto" y "no se pudo verificar", porque de eso depende que la respuesta diga
"no encuentro X" en vez de citar fragmentos de otro tema.
"""
from __future__ import annotations

import pytest

from app.models import Chunk
from app.services import agent
from app.services.reranker import RelevanceOutcome


def _chunks(n: int, prefijo: str = "f") -> list[Chunk]:
    return [
        Chunk(
            id=f"{prefijo}{i}",
            text=f"fragmento {i}",
            source_file="paper.pdf",
            page=i + 1,
            document_type="pdf",
        )
        for i in range(n)
    ]


@pytest.fixture
def buscador(monkeypatch):
    """Sustituye Qdrant y el reranker; deja configurable lo que devuelven."""
    estado: dict = {"candidatos": _chunks(5), "ranked": None, "outcome": None}

    async def _hybrid(query, filters, top_k):
        estado["query"] = query
        estado["filters"] = filters
        return estado["candidatos"]

    async def _rerank(query, chunks, top_k):
        return estado["ranked"] if estado["ranked"] is not None else chunks[:top_k]

    async def _filter(query, chunks):
        return estado["outcome"] or RelevanceOutcome(list(chunks), True, "ok")

    monkeypatch.setattr(agent, "hybrid_search", _hybrid)
    monkeypatch.setattr(agent, "rerank", _rerank)
    monkeypatch.setattr(agent, "filter_relevant", _filter)
    return estado


async def test_sin_consulta_no_busca(settings_override, buscador):
    chunks, texto = await agent._execute_document_search({"semantico": "   "})

    assert chunks == []
    assert "Falta una consulta" in texto


async def test_indice_vacio_lo_dice(settings_override, buscador):
    buscador["candidatos"] = []

    chunks, texto = await agent._execute_document_search({"semantico": "amiloide"})

    assert chunks == []
    assert "no devolvió ningún fragmento" in texto


async def test_ninguno_relevante_se_reporta_como_ausencia_no_como_fallo(
    settings_override, buscador
):
    """El caso que hace honesta a la respuesta: hay fragmentos parecidos, pero
    ninguno habla del tema. El modelo debe recibirlo como un hecho del índice."""
    buscador["ranked"] = _chunks(4)
    buscador["outcome"] = RelevanceOutcome([], True, "0 de 4")

    chunks, texto = await agent._execute_document_search({"semantico": "dosis"})

    assert chunks == []
    assert "ninguno contiene información sobre esto" in texto
    assert "sin presentarlo como un fallo de búsqueda" in texto


async def test_filtrado_parcial_declara_cuantos_se_descartaron(
    settings_override, buscador
):
    ranked = _chunks(5)
    buscador["ranked"] = ranked
    buscador["outcome"] = RelevanceOutcome(ranked[:2], True, "2 de 5")

    chunks, texto = await agent._execute_document_search({"semantico": "tau"})

    assert [c.id for c in chunks] == ["f0", "f1"]
    assert "2 aportan evidencia y 3 hablaban de otra cosa" in texto
    assert "[paper.pdf, pág. 1]" in texto


async def test_sin_verificar_avisa_en_vez_de_callar(settings_override, buscador):
    ranked = _chunks(3)
    buscador["ranked"] = ranked
    buscador["outcome"] = RelevanceOutcome(ranked, False, "api caída")

    chunks, texto = await agent._execute_document_search({"semantico": "tau"})

    assert len(chunks) == 3
    assert texto.startswith("AVISO: no se pudo verificar")


async def test_el_limite_se_acota_al_rango_permitido(
    settings_override, buscador, monkeypatch
):
    vistos: list[int] = []

    async def _rerank(query, chunks, top_k):
        vistos.append(top_k)
        return chunks[:top_k]

    monkeypatch.setattr(agent, "rerank", _rerank)

    await agent._execute_document_search({"semantico": "x", "limit": 99})
    await agent._execute_document_search({"semantico": "x", "limit": 0})
    await agent._execute_document_search({"semantico": "x"})

    assert vistos[0] == 50  # techo
    # limit 0 es falsy: cae al default de settings, igual que si no viniera
    assert vistos[1] == settings_override.rerank_top_k
    assert vistos[2] == settings_override.rerank_top_k


async def test_las_fuentes_llevan_la_cita_ya_montada(settings_override):
    """SourceRef es lo que ve el frontend: cita, localizador y contexto.

    El localizador va resuelto para que la UI muestre la misma cita que usa el
    modelo, en vez de reconstruirla a su manera y decir "pág. 3" de un Word.
    """
    payload = agent._sources_payload({"a": _chunks(1)[0]})

    assert set(payload[0]) == {
        "source_file", "page", "project_id", "document_id", "section",
        "language", "document_type", "source_pages", "snippet", "score",
        "chunk_type", "title", "citation", "doi", "locator",
    }
    assert payload[0]["locator"] == "pág. 1"


async def test_un_filtro_que_no_casa_no_deja_la_busqueda_a_cero(
    settings_override, buscador, monkeypatch
):
    """El fallo medido en produccion el 2 sep 2026.

    El modelo filtro por `idioma: es` de buena fe, el payload tenia `language`
    vacio en todos los puntos, el filtro exacto no caso con nada y el agente
    concluyo que el documento no existia. Ahora la busqueda se repite sin
    filtros y el modelo se entera de que esos valores no existen.
    """
    llamadas: list[dict] = []
    encontrados = _chunks(3)

    async def _hybrid(query, filters, top_k):
        aplicados = filters.model_dump(exclude_none=True)
        llamadas.append(aplicados)
        return [] if aplicados else encontrados

    monkeypatch.setattr(agent, "hybrid_search", _hybrid)

    chunks, texto = await agent._execute_document_search(
        {"semantico": "guia del gigante noble", "language": "es"}
    )

    assert [c.id for c in chunks] == ["f0", "f1", "f2"]
    assert llamadas == [{"language": "es"}, {}]
    assert "AVISO" in texto
    assert "language='es'" in texto
    assert "no vuelvas a usarlos" in texto


async def test_sin_resultados_ni_con_filtros_ni_sin_ellos(
    settings_override, buscador, monkeypatch
):
    async def _hybrid(query, filters, top_k):
        return []

    monkeypatch.setattr(agent, "hybrid_search", _hybrid)

    chunks, texto = await agent._execute_document_search(
        {"semantico": "algo", "language": "es"}
    )

    assert chunks == []
    assert "ni con los filtros" in texto


async def test_al_descartar_todo_se_dice_de_que_documentos_venian(
    settings_override, buscador
):
    """Negar la existencia de algo es una afirmacion fuerte: el modelo debe ver
    de que documentos salian los fragmentos que se descartaron."""
    buscador["ranked"] = _chunks(3)
    buscador["outcome"] = RelevanceOutcome([], True, "0 de 3")

    chunks, texto = await agent._execute_document_search({"semantico": "x"})

    assert chunks == []
    assert "paper.pdf" in texto
    assert "vuelve a buscar con sus propias palabras" in texto
