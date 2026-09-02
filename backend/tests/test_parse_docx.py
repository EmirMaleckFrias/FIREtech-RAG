"""Parser de Word y localizadores de cita.

Word no tiene páginas, así que lo que se comprueba aquí es que se cite por
sección y que las tablas del documento no se pierdan.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.ingest.generic import parse_generic
from app.models import Chunk


@pytest.fixture
def documento(tmp_path: Path) -> Path:
    docx = pytest.importorskip("docx")

    doc = docx.Document()
    doc.add_heading("Introducción", level=1)
    doc.add_paragraph("La enfermedad se describe por primera vez en 1906.")
    doc.add_paragraph("")  # vacío: se descarta
    doc.add_heading("Métodos", level=2)
    doc.add_paragraph("Se reclutaron 120 participantes de tres centros.")
    doc.add_paragraph("El seguimiento fue de 24 meses.")

    tabla = doc.add_table(rows=2, cols=3)
    tabla.cell(0, 0).text = "Grupo"
    tabla.cell(0, 1).text = "N"
    tabla.cell(0, 2).text = "Edad media"
    tabla.cell(1, 0).text = "Control"
    tabla.cell(1, 1).text = "60"
    tabla.cell(1, 2).text = "71.4"

    destino = tmp_path / "estudio.docx"
    doc.save(destino)
    return destino


def test_agrupa_por_seccion_y_no_mezcla(documento):
    chunks, _ = parse_generic(documento, documento.name)

    texto = [c for c in chunks if c["chunk_type"] == "text"]
    secciones = [c["section"] for c in texto]

    assert "Introducción" in secciones
    assert "Métodos" in secciones
    # Ningún chunk mezcla dos secciones: cada uno cita una sola.
    for chunk in texto:
        if chunk["section"] == "Introducción":
            assert "participantes" not in chunk["text"]
        if chunk["section"] == "Métodos":
            assert "1906" not in chunk["text"]


def test_la_tabla_se_indexa_como_tal(documento):
    chunks, _ = parse_generic(documento, documento.name)

    tablas = [c for c in chunks if c["chunk_type"] == "table"]

    assert len(tablas) == 1
    assert "Grupo | N | Edad media" in tablas[0]["text"]
    assert "Control | 60 | 71.4" in tablas[0]["text"]


def test_document_type_y_paginas_declaradas(documento):
    chunks, pages = parse_generic(documento, documento.name)

    assert pages == len(chunks)
    assert {c["document_type"] for c in chunks} == {"docx"}


def test_doc_antiguo_da_un_error_que_explica_que_hacer(tmp_path):
    viejo = tmp_path / "notas.doc"
    viejo.write_bytes(b"\xd0\xcf\x11\xe0formato binario antiguo")

    with pytest.raises(ValueError, match="guárdalo como .docx"):
        parse_generic(viejo, viejo.name)


def test_docx_vacio_avisa_en_vez_de_indexar_nada(tmp_path):
    docx = pytest.importorskip("docx")
    destino = tmp_path / "vacio.docx"
    docx.Document().save(destino)

    with pytest.raises(ValueError, match="no contiene texto extraíble"):
        parse_generic(destino, destino.name)


# --- localizadores de cita --------------------------------------------------
def _chunk(**kw) -> Chunk:
    base = {"id": "x", "text": "t", "source_file": "a.pdf", "page": 3}
    return Chunk(**{**base, **kw})


def test_el_pdf_se_cita_por_pagina():
    ch = _chunk(document_type="pdf")

    assert ch.locator() == "pág. 3"
    assert ch.cite() == "[a.pdf, pág. 3]"


def test_word_se_cita_por_seccion_no_por_pagina_inventada():
    ch = _chunk(
        source_file="estudio.docx", document_type="docx", section="Métodos"
    )

    assert ch.locator() == "sección: Métodos"
    assert "pág." not in ch.cite()


def test_una_hoja_de_calculo_se_cita_por_fila():
    ch = _chunk(source_file="datos.xlsx", document_type="xlsx", chunk_type="table")

    assert ch.cite() == "[datos.xlsx, fila 3]"


def test_una_tabla_de_word_se_cita_como_tabla_no_como_fila():
    """En Word un chunk de tabla es la tabla entera, no una fila suya."""
    ch = _chunk(source_file="estudio.docx", document_type="docx", chunk_type="table")

    assert ch.cite() == "[estudio.docx, tabla 3]"


def test_sin_pagina_ni_seccion_cae_al_numero_de_fragmento():
    ch = _chunk(source_file="notas.txt", document_type="txt")

    assert ch.locator() == "fragmento 3"
