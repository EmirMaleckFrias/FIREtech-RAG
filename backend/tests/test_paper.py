"""Heurísticas de artículo: detección de secciones y metadatos de la obra.

Nada de esto llama a un modelo: son reglas deterministas, y por eso hay que
probarlas con los casos raros de un PDF de revista de verdad.
"""
from __future__ import annotations

from app.ingest import paper


# --- detección de secciones -------------------------------------------------
def test_reconoce_los_encabezados_habituales():
    casos = {
        "Abstract": "resumen",
        "RESUMEN": "resumen",
        "1. Introduction": "introduccion",
        "Antecedentes": "introduccion",
        "2 Materials and Methods": "metodos",
        "MATERIALES Y MÉTODOS": "metodos",
        "III. Results": "resultados",
        "Discussion": "discusion",
        "Conclusiones": "conclusiones",
        "References": "referencias",
        "Bibliografía": "referencias",
        "Acknowledgements": "agradecimientos",
        "Appendix": "anexos",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea


def test_no_confunde_prosa_con_encabezado():
    """El caso que arruinaría el arrastre de secciones si se hiciera por
    contención de palabras en vez de por línea completa."""
    prosa = [
        "The methods described by Smith et al. were adapted for this cohort.",
        "En la introducción del trabajo previo se afirma lo contrario.",
        "Results were compared against the reference standard.",
        "This section presents our discussion of the findings.",
        "see References for the complete list of included trials.",
    ]
    for linea in prosa:
        assert paper.detectar_seccion(linea) is None, linea


def test_ignora_lineas_vacias_y_demasiado_largas():
    assert paper.detectar_seccion("") is None
    assert paper.detectar_seccion("   ") is None
    assert paper.detectar_seccion("Methods " + "x" * 100) is None


# --- metadatos --------------------------------------------------------------
def _chars(bloques: list[tuple[str, float, float]]) -> list[dict]:
    """Caracteres estilo pdfplumber a partir de (texto, tamaño, top)."""
    out: list[dict] = []
    for texto, size, top in bloques:
        for i, c in enumerate(texto):
            out.append({"text": c, "size": size, "top": top, "x0": float(i)})
    return out


PRIMERA_PAGINA = [
    ("Downloaded from journals.example.org on July 2026", 7.0, 10.0),
    ("Cerebrospinal fluid biomarkers in early Alzheimer disease", 17.0, 60.0),
    ("Ricardo F. Allegri, Manuel Colome, Juan C. Guilbe", 11.0, 95.0),
    ("Department of Neurology, INTEC, Santo Domingo", 8.5, 115.0),
    ("Abstract", 12.0, 150.0),
    ("Background: amyloid beta 42 decreases in early stages.", 10.0, 170.0),
]


def test_extrae_titulo_por_tamano_de_fuente():
    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), "texto")

    assert meta.titulo == "Cerebrospinal fluid biomarkers in early Alzheimer disease"


def test_el_apellido_del_primer_autor_sale_de_la_linea_de_autores():
    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), "texto")

    assert meta.autor == "Allegri"


def test_apellido_en_formato_apellido_coma_inicial():
    """"Allegri, R., Colome, M." tiene que dar el mismo apellido."""
    pagina = [
        ("Biomarkers in Alzheimer disease", 16.0, 50.0),
        ("Allegri, R., Colome, M., Guilbe, J.", 11.0, 80.0),
        ("Abstract", 12.0, 110.0),
        ("We measured biomarker levels in cerebrospinal fluid samples.", 10.0, 130.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "texto")

    assert meta.autor == "Allegri"


def test_ignora_la_afiliacion_como_linea_de_autores():
    pagina = [
        ("Tau phosphorylation and cognitive decline", 16.0, 50.0),
        ("Universidad Nacional, Departamento de Neurologia", 10.0, 80.0),
        ("Maria Fernanda Rosario, Pedro Nunez", 11.0, 100.0),
        ("Abstract", 12.0, 130.0),
        ("Phosphorylated tau was associated with faster decline in memory.", 10.0, 150.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "texto")

    assert meta.autor == "Rosario"


def test_extrae_doi_y_anio_del_texto():
    texto = (
        "J Alzheimers Dis 2023; 91(2): 145-160.\n"
        "https://doi.org/10.3233/JAD-220123 published 2023.\n"
        "Earlier work from 1998 is cited later."
    )

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.doi == "10.3233/JAD-220123"
    assert meta.anio == "2023"


def test_la_fecha_de_descarga_no_se_toma_por_ano_de_publicacion():
    """Un PDF bajado en 2026 de un articulo de 2019 es de 2019."""
    texto = (
        "Downloaded from example.org on 3 March 2026\n"
        "Neurology 2019;92:e1-e9\n"
    )

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.anio == "2019"


def test_la_referencia_es_autor_y_anio_cuando_se_puede():
    texto = "doi:10.1000/xyz 2024"

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.referencia == "Allegri et al., 2024"


def test_sin_autor_la_referencia_cae_al_titulo():
    pagina = [
        ("Guia clinica de manejo del deterioro cognitivo", 16.0, 40.0),
        ("Resumen", 12.0, 80.0),
        ("Documento de consenso para el manejo inicial en atencion primaria.", 10.0, 100.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "sin anio ni doi")

    assert meta.autor == ""
    assert meta.referencia == "Guia clinica de manejo del deterioro cognitivo"


def test_sin_nada_extraible_la_referencia_queda_vacia():
    """Vacía significa "no lo sé": quien llama cita el nombre del archivo.

    Es la garantía de que no se fabrica una referencia que nadie podría
    comprobar.
    """
    meta = paper.extraer_metadatos([], "")

    assert meta.referencia == ""
    assert meta.titulo == ""


def test_el_ruido_de_cabecera_no_se_toma_por_titulo():
    """La línea de "Downloaded from" suele ir arriba; si fuera la más grande
    no debe ganar."""
    pagina = [
        ("Downloaded from journals.example.org", 20.0, 10.0),
        ("Amyloid load and hippocampal atrophy", 15.0, 60.0),
        ("Abstract", 12.0, 100.0),
        ("Cortical thinning was measured in 84 participants over two years.", 10.0, 120.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "texto")

    assert meta.titulo == "Amyloid load and hippocampal atrophy"
