"""La herramienta de inventario: que documentos hay, con conteo exacto.

Existe por un fallo medido: a "cuantos documentos tienes indexados y de que
trata cada uno" el agente respondia sin buscar y hablando de si mismo, porque
esa pregunta no se puede contestar buscando texto (una busqueda devuelve los
fragmentos que se parecen a la consulta, nunca el catalogo completo).
"""
from __future__ import annotations

import types

import pytest

from app.services import agent


@pytest.fixture
def inventario(monkeypatch):
    datos = {
        "total_chunks": 8,
        "archivos": [
            {"valor": "estudio_cohorte.pdf", "chunks": 6},
            {"valor": "folleto.pdf", "chunks": 2},
        ],
        "tipos": [{"valor": "pdf", "chunks": 8}],
        "idiomas": [{"valor": "es", "chunks": 2}],
    }
    monkeypatch.setattr(agent, "index_inventory", lambda: datos)
    return datos


async def test_da_el_catalogo_con_conteo_exacto(settings_override, inventario):
    chunks, texto = await agent._execute_inventory()

    assert chunks == []  # no son fragmentos citables: es el catalogo
    assert "Hay 2 documentos indexados y 8 fragmentos" in texto
    assert "estudio_cohorte.pdf: 6 fragmentos" in texto
    assert "folleto.pdf: 2 fragmentos" in texto


async def test_declara_que_el_conteo_es_exacto_y_como_citarlo(
    settings_override, inventario
):
    """La diferencia con una busqueda: esto SI es un total, y puede darse como
    tal. Sin decirlo, el modelo lo presenta con la misma cautela que un
    resultado parcial, o al reves, presenta un parcial como total."""
    _, texto = await agent._execute_inventory()

    assert "exacto" in texto
    assert "[inventario del índice]" in texto


async def test_avisa_de_lo_que_el_inventario_NO_dice(settings_override, inventario):
    """Saber que archivos hay no es saber de que tratan: si no se dice, el
    modelo resume los documentos a partir del nombre del archivo."""
    _, texto = await agent._execute_inventory()

    assert "no de qué tratan" in texto


async def test_indice_vacio_se_dice_sin_rodeos(settings_override, monkeypatch):
    monkeypatch.setattr(
        agent,
        "index_inventory",
        lambda: {"total_chunks": 0, "archivos": [], "tipos": [], "idiomas": []},
    )

    chunks, texto = await agent._execute_inventory()

    assert chunks == []
    assert "vacío" in texto


async def test_idiomas_sin_detectar_no_se_ocultan(settings_override, monkeypatch):
    monkeypatch.setattr(
        agent,
        "index_inventory",
        lambda: {
            "total_chunks": 3,
            "archivos": [{"valor": "a.pdf", "chunks": 3}],
            "tipos": [{"valor": "pdf", "chunks": 3}],
            "idiomas": [],
        },
    )

    _, texto = await agent._execute_inventory()

    assert "sin detectar" in texto
