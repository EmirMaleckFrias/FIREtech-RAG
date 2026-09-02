"""PDF de artículo, de punta a punta: secciones, bibliografía y cita.

Se genera un PDF de verdad y se parsea con el camino real (pdfplumber), que es
la única forma de comprobar que las heurísticas sobreviven a un archivo.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.ingest.generic import parse_generic
from app.models import Chunk
from tests.pdf_falso import escribir_pdf

PAGINA_1 = [
    ("Downloaded from journals.example.org on 12 July 2026", 7.0),
    ("Cerebrospinal fluid biomarkers in early Alzheimer disease", 17.0),
    ("Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11.0),
    ("Department of Neurology, INTEC, Santo Domingo", 8.5),
    ("doi:10.3233/JAD-220123  J Alzheimers Dis 2023", 8.0),
    ("Abstract", 12.0),
    ("Amyloid beta 42 decreases in the earliest stages of the disease, while", 10.0),
    ("total tau and phosphorylated tau increase progressively over time.", 10.0),
    ("Introduction", 12.0),
    ("Previous work by other groups suggested a link that remained unproven", 10.0),
    ("across several independent cohorts studied during the last decade.", 10.0),
    ("Methods", 12.0),
    ("We recruited 120 participants aged between 55 and 85 years from three", 10.0),
    ("memory clinics, with follow up visits scheduled every six months.", 10.0),
    ("Results", 12.0),
    ("Mean amyloid beta 42 was 534 pg per mL in the impaired group and 912", 10.0),
    ("pg per mL in controls, a difference that reached statistical relevance.", 10.0),
]

PAGINA_2 = [
    ("Discussion", 12.0),
    ("These findings may indicate an earlier onset than previously assumed,", 10.0),
    ("although the sample size limits how far the claim can be extended.", 10.0),
    ("References", 12.0),
    ("1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 9.0),
    ("2. Garcia L. Tau propagation across cortical networks. Neuron 2021.", 9.0),
    ("3. Nakamura T. Longitudinal cohorts in dementia research. 2020.", 9.0),
]


@pytest.fixture
def articulo(tmp_path: Path) -> Path:
    return escribir_pdf(tmp_path / "biomarkers.pdf", [PAGINA_1, PAGINA_2])


def _chunk(d: dict) -> Chunk:
    return Chunk(
        id=d["id"], text=d["text"], source_file=d["source_file"], page=d["page"],
        section=d["section"], document_type=d["document_type"],
        chunk_type=d["chunk_type"], title=d["title"], citation=d["citation"],
        doi=d["doi"],
    )


def test_cada_fragmento_sabe_de_que_seccion_sale(articulo):
    chunks, _ = parse_generic(articulo, articulo.name)

    por_seccion = {c["section"]: c["text"] for c in chunks}

    assert "Results" in por_seccion
    assert "534 pg per mL" in por_seccion["Results"]
    assert "Methods" in por_seccion
    assert "120 participants" in por_seccion["Methods"]
    assert "Discussion" in por_seccion
    # Ningún fragmento mezcla dos secciones: el dato de Resultados no puede
    # acabar dentro del chunk de Discusión.
    assert "534 pg" not in por_seccion["Discussion"]


def test_la_bibliografia_no_se_indexa(articulo):
    """Son títulos de trabajos ajenos: matchean con todo y no son evidencia."""
    chunks, _ = parse_generic(articulo, articulo.name)

    texto_completo = "\n".join(c["text"] for c in chunks)

    assert "Smith J" not in texto_completo
    assert "Tau propagation across cortical networks" not in texto_completo
    assert not any(c["section"] == "References" for c in chunks)


def test_se_pueden_conservar_las_referencias_si_se_piden(articulo):
    chunks, _ = parse_generic(articulo, articulo.name, skip_references=False)

    texto_completo = "\n".join(c["text"] for c in chunks)

    assert "Smith J" in texto_completo


def test_la_cita_usa_la_referencia_del_trabajo_no_el_archivo(articulo):
    chunks, _ = parse_generic(articulo, articulo.name)

    ch = _chunk(chunks[0])

    assert ch.citation == "Allegri et al., 2023"
    assert ch.doi == "10.3233/JAD-220123"
    assert ch.title == "Cerebrospinal fluid biomarkers in early Alzheimer disease"
    assert ch.cite().startswith("[Allegri et al., 2023,")
    assert "biomarkers.pdf" not in ch.cite()


def test_los_metadatos_viajan_en_todos_los_fragmentos(articulo):
    """La cita no debe depender de ir a buscar nada: viaja en cada fragmento."""
    chunks, _ = parse_generic(articulo, articulo.name)

    assert all(c["citation"] == "Allegri et al., 2023" for c in chunks)


def test_un_pdf_sin_pinta_de_articulo_cita_por_archivo(tmp_path):
    """Sin título ni autores no se inventa una referencia: se cita el archivo."""
    plano = escribir_pdf(
        tmp_path / "notas.pdf",
        [[("apunte suelto sin estructura de articulo", 10.0)] * 3],
    )

    chunks, _ = parse_generic(plano, plano.name)
    ch = _chunk(chunks[0])

    assert ch.title == ""
    assert ch.citation == ""
    assert ch.cite().startswith("[notas.pdf,")


def test_las_cabeceras_repetidas_de_la_revista_no_entran_al_indice(tmp_path):
    """El nombre de la revista estampado en cada página no es contenido.

    Se detecta por repetirse entre páginas, que es lo que funciona sin conocer
    la maquetación de cada editorial.
    """
    cabecera = ("Alzheimers Dement 2021;17:1145-1157", 7.0)
    cuerpos = [
        "Plasma p-tau217 reached an area under the curve of 0.93 overall.",
        "Sensitivity was 88 percent at the predefined cutoff of 2.4 pg per mL.",
        "Specificity reached 91 percent in the independent validation cohort.",
        "No differences were observed between the two recruiting centres.",
    ]
    paginas = [
        [cabecera, ("Results", 12.0), (cuerpo, 10.0), ("page footer 1", 7.0)]
        for cuerpo in cuerpos
    ]

    pdf = escribir_pdf(tmp_path / "multipagina.pdf", paginas)
    chunks, _ = parse_generic(pdf, pdf.name)

    texto = "\n".join(c["text"] for c in chunks)
    assert "1145-1157" not in texto
    assert "0.93" in texto


def test_la_marca_de_agua_de_descarga_no_entra_al_indice(tmp_path):
    pdf = escribir_pdf(
        tmp_path / "watermark.pdf",
        [[
            ("Downloaded from journals.example.org by a reader on 12 July 2026", 7.0),
            ("Tau load and cognition", 16.0),
            ("Abstract", 12.0),
            ("Higher tau load was associated with faster cognitive decline.", 10.0),
        ]],
    )

    chunks, _ = parse_generic(pdf, pdf.name)

    texto = "\n".join(c["text"] for c in chunks)
    assert "Downloaded from" not in texto
    assert "faster cognitive decline" in texto


def test_una_seccion_no_se_arrastra_por_lo_que_no_describe(tmp_path):
    """El fallo visto en el indice de produccion el 2 sep 2026.

    Una guia de 4 paginas quedo con "seccion: Introduccion" en TODOS sus
    fragmentos, y el agente lo repitio en la respuesta ("se explica en la
    pagina 3, en la seccion Introduccion"). La causa: solo se reconocian los
    encabezados con nombre de articulo cientifico, asi que "Composicion del
    Mazo" no contaba como encabezado y la seccion anterior seguia vigente.

    Ahora un encabezado tambien se reconoce por la maqueta (linea corta, sin
    punto final, con mas cuerpo de letra que el texto), y eso RESETEA la
    seccion aunque su nombre no se conozca.
    """
    pdf = escribir_pdf(
        tmp_path / "guia.pdf",
        [[
            ("Guia estrategica del mazo", 18.0),
            ("Introduccion", 13.0),
            ("Esta guia analiza el mazo y como jugarlo en cada fase.", 10.0),
            ("Composicion del Mazo", 13.0),
            ("El mazo lo forman ocho cartas con roles complementarios.", 10.0),
            ("Estrategia Ofensiva", 13.0),
            ("El empuje principal se arma detras de la unidad tanque.", 10.0),
        ]],
    )

    chunks, _ = parse_generic(pdf, pdf.name)
    por_texto = {c["text"]: c["section"] for c in chunks}

    def seccion_de(fragmento: str) -> str:
        for texto, seccion in por_texto.items():
            if fragmento in texto:
                return seccion
        raise AssertionError(f"no se indexo el fragmento {fragmento!r}")

    assert seccion_de("ocho cartas") == "Composicion del Mazo"
    assert seccion_de("empuje principal") == "Estrategia Ofensiva"
    # Y lo que si esta en la introduccion sigue diciendo que lo esta.
    assert seccion_de("analiza el mazo") == "Introduccion"


def test_sin_encabezados_maquetados_no_se_inventa_seccion(tmp_path):
    """Un documento de un solo tamano de letra no tiene secciones que citar."""
    pdf = escribir_pdf(
        tmp_path / "plano.pdf",
        [[
            ("Primera linea del documento sin ninguna estructura visible.", 10.0),
            ("Segunda linea que continua el mismo parrafo de siempre.", 10.0),
            ("Tercera linea con mas contenido corrido y sin titulares.", 10.0),
        ]],
    )

    chunks, _ = parse_generic(pdf, pdf.name)

    assert all(c["section"] == "" for c in chunks)
