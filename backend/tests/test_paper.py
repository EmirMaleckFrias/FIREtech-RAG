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


def test_un_rango_de_vigencia_no_se_convierte_en_ano_de_publicacion():
    texto = "Updated Global Action Plan on AMR 2026-2036"

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.anio == ""
    assert meta.referencia == ""


def test_un_ano_futuro_no_se_acepta_como_publicacion():
    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), "Plan estrategico 2036")

    assert meta.anio == ""
    assert meta.referencia == ""


def test_sin_doi_no_toma_un_ano_del_cuerpo_o_las_referencias():
    texto = (
        "Abstract\n"
        "The cohort was recruited between 2019 and 2024.\n"
        "References\n"
        "Smith J. Previous study. 2025.\n"
    )

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.anio == ""
    assert meta.referencia == ""


def test_una_organizacion_no_se_convierte_en_autor_et_al():
    pagina = [
        ("Diabetes mellitus tipo 2: diagnostico y control", 16.0, 50.0),
        ("Organizacion Mundial de la Salud, 2026", 11.0, 80.0),
        ("Resumen", 12.0, 110.0),
        ("Documento de sintesis para profesionales sanitarios.", 10.0, 130.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "OMS 2026\nResumen")

    assert meta.autor == ""
    assert meta.referencia == ""


def test_un_subtitulo_no_se_convierte_en_apellido():
    pagina = [
        ("Resistencia a los antimicrobianos", 16.0, 50.0),
        ("Documentos base principales", 11.0, 80.0),
        ("Vigilancia y uso responsable con enfoque One Health", 11.0, 100.0),
        ("Resumen", 12.0, 130.0),
        ("Sintesis de multiples fuentes internacionales.", 10.0, 150.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "Plan 2026-2036\nResumen")

    assert meta.autor == ""
    assert meta.referencia == ""


def test_la_referencia_es_autor_y_anio_cuando_se_puede():
    texto = "doi:10.1000/xyz 2024"

    meta = paper.extraer_metadatos(_chars(PRIMERA_PAGINA), texto)

    assert meta.referencia == "Allegri et al., 2024"


def test_sin_autor_no_se_cita_por_titulo():
    """Medido en produccion: usar el titulo como cita era peor que el archivo.

    Un titulo de 70 caracteres recortado con puntos suspensivos se repetia en
    cada punto de una lista, hacia la respuesta ilegible y rompia el enlace de
    la cita con su fuente en el panel. Sin autor y ano, la referencia queda
    vacia y quien cita usa el nombre del archivo, que es corto y enlazable.
    """
    pagina = [
        ("Guia clinica de manejo del deterioro cognitivo", 16.0, 40.0),
        ("Resumen", 12.0, 80.0),
        ("Documento de consenso para el manejo inicial en atencion primaria.", 10.0, 100.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "sin anio ni doi")

    assert meta.autor == ""
    assert meta.titulo == "Guia clinica de manejo del deterioro cognitivo"
    assert meta.referencia == ""


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


# --- cabeceras numeradas con barra (Wiley) -----------------------------------
def test_reconoce_las_cabeceras_numeradas_con_barra_de_wiley():
    """Medido el 3 sep 2026 sobre Alzheimer's & Dementia, el corpus central.

    "2 | METHODS" daba None porque la barra no contaba como separador, asi
    que `canonica` nunca llegaba a "referencias" y la bibliografia entera se
    embebia. Tambien se aceptan el punto medio y los guiones tipograficos, y
    la barra sin espacios, que es como a veces la extrae pdfplumber.
    """
    casos = {
        "1 | INTRODUCTION": "introduccion",
        "2 | METHODS": "metodos",
        "3 | RESULTS": "resultados",
        "4 | DISCUSSION": "discusion",
        "5 | REFERENCES": "referencias",
        "2|METHODS": "metodos",
        "2 · Methods": "metodos",
        "2 – Methods": "metodos",
        "2 — Methods": "metodos",
        "X | Discussion": "discusion",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea


def test_una_subseccion_con_nombre_propio_sigue_sin_ser_seccion_conocida():
    """"2.1 | Participants" no es una seccion canonica: la decide la maqueta."""
    assert paper.detectar_seccion("2.1 | Participants") is None


def test_un_numero_de_pagina_pegado_no_esconde_la_cabecera():
    """El folio comparte linea con el encabezado que abre la pagina."""
    casos = {
        "3 RESULTS 5": "resultados",
        "3 | RESULTS 5": "resultados",
        "References 12": "referencias",
        "Discussion 1123": "discusion",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea
    # Y un numero solo, o una cifra que no es un folio, no se toca.
    assert paper.detectar_seccion("3") is None
    assert paper.detectar_seccion("2 3") is None
    assert paper.detectar_seccion("Table 1") is None
    assert paper.detectar_seccion("Section 3") is None


def test_quitar_la_numeracion_no_se_come_la_inicial_de_la_seccion():
    """El test adversarial del arreglo: si el espacio tras el numero fuera
    opcional, la rama romana quitaria la "I" de Introduction o la "C" de
    Conclusions y esas secciones dejarian de reconocerse."""
    casos = {
        "Introduction": "introduccion",
        "Introduccion": "introduccion",
        "Conclusions": "conclusiones",
        "Conclusion": "conclusiones",
        "Limitations": "limitaciones",
        "Literature cited": "referencias",
        "Conflict of interest": "agradecimientos",
        "I Introduction": "introduccion",
        "I. Introduction": "introduccion",
        "V Results": "resultados",
        "XI. Conclusions": "conclusiones",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea


def test_la_numeracion_romana_solo_cuenta_en_mayusculas_y_bien_formada():
    """Con re.IGNORECASE, "ivxlc Results" pasaba por cabecera numerada."""
    assert paper.detectar_seccion("IV Results") == "resultados"
    assert paper.detectar_seccion("III. Results") == "resultados"
    assert paper.detectar_seccion("iv Results") is None
    assert paper.detectar_seccion("ivxlc Results") is None
    assert paper.detectar_seccion("IVXLC Results") is None


def test_dos_secciones_en_una_cabecera_toman_la_primera_salvo_el_resumen():
    """Antes se llamaba "toman la primera", a secas, y el criterio estaba mal.

    Cambia por el caso medido el 4 sep 2026: "Summary and Conclusions" es una
    seccion de CIERRE y "manda la primera" la etiquetaba "resumen", la misma
    etiqueta que el abstract. La seccion es justo lo que dice a quien lee la
    respuesta cuanto peso dar al fragmento, asi que marcar el veredicto final
    de los autores como resumen preliminar cambia la lectura. Cuando la
    primera parte es el resumen manda la otra, que es la especifica.
    """
    casos = {
        "Results and Discussion": "resultados",
        "RESULTS AND DISCUSSION": "resultados",
        "Resultados y Discusion": "resultados",
        "Subjects and Methods": "metodos",
        "Study Design and Methods": "metodos",
        "Discussion/Conclusion": "discusion",
        "Strengths and Limitations": "limitaciones",
        "Conclusions and Relevance": "conclusiones",
        "Conflict of Interest Statement": "agradecimientos",
        "Data Availability Statement": "agradecimientos",
        "3 | RESULTS AND DISCUSSION 12": "resultados",
        # La excepcion: el resumen no manda sobre la seccion especifica.
        "Summary and Conclusions": "conclusiones",
        "Resumen y Conclusiones": "conclusiones",
        "Abstract and Introduction": "introduccion",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea


def test_una_linea_corta_que_empieza_por_una_seccion_no_es_cabecera():
    """Empezar por "Results" no basta: un renglon de prosa partido o un
    titulillo corrido pasarian por cabecera, y como el titulo se corta en la
    primera seccion detectada, el articulo se quedaria sin titulo ni autores.
    """
    prosa = [
        "Results were compared against",
        "Methods used in this",
        "Summary of Product Characteristics",
        "Results Are Shown Below",
        "Results of the Survey",
        "Results and Discussion of the Cohort",
        "Results and",
        "https://doi.org/10.1002/alz",
        "Neurology 2019",
    ]
    for linea in prosa:
        assert paper.detectar_seccion(linea) is None, linea


# --- firma Vancouver, particulas y apellidos compuestos -----------------------
def _autor_de(linea_autores: str) -> str:
    pagina = [
        ("Plasma p-tau217 as a marker of amyloid pathology", 16.0, 50.0),
        (linea_autores, 11.0, 80.0),
        ("Abstract", 12.0, 110.0),
        ("Plasma p-tau217 separated amyloid positive from negative cases.", 10.0, 130.0),
    ]
    return paper.extraer_metadatos(_chars(pagina), "texto").autor


def test_la_firma_vancouver_no_anula_la_cita():
    """Medido el 3 sep 2026: "Apellido AB," es el estilo de Neurology,
    Alzheimer's & Dementia, Lancet Neurol y JAMA Neurol, y daba autor vacio
    porque "WM" pasaba el filtro de longitud, se tomaba como apellido y se
    rechazaba por corto. Todos esos trabajos se citaban por nombre de archivo.
    """
    casos = {
        "van der Flier WM, Scheltens P, Jack CR Jr": "van der Flier",
        "Allegri RF, Colome M, Sarasola D": "Allegri",
        "Jack CR Jr, Bennett DA": "Jack",
        "Li X, Wang Y": "Li",
        "Sperling RA": "Sperling",
        "Garcia Ribas MJ, Fortea J": "Garcia Ribas",
        "de la Torre JC, Perez J": "de la Torre",
        "Allegri RF1,2, Colome M3": "Allegri",
        "Allegri R.F., Colome M.": "Allegri",
        "RF Allegri, M Colome": "Allegri",
        "Mendez-Sanchez R, Lopez J": "Mendez-Sanchez",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_las_particulas_forman_parte_del_apellido():
    """"Flier et al." o "Torre et al." no los reconoce nadie."""
    casos = {
        "Wiesje M. van der Flier, Philip Scheltens": "van der Flier",
        "Maria de la Torre, Juan Perez": "de la Torre",
        "Emma L. van den Berg, Piet Smit": "van den Berg",
        "Bart De Strooper, Lucia Chavez": "De Strooper",
        "Christine Van Broeckhoven, Kristel Sleegers": "Van Broeckhoven",
        "van der Flier, W. M., Scheltens, P.": "van der Flier",
        "Prof Wiesje M van der Flier PhD, Philip Scheltens": "van der Flier",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_una_particula_capitalizada_que_abre_el_nombre_es_nombre_de_pila():
    """"Le" es partícula en "Le Guen" pero nombre de pila en "Le Wang"."""
    assert _autor_de("Le Wang, Yu Chen") == "Wang"


def test_el_apellido_compuesto_espanol_se_conserva_cuando_es_inequivoco():
    casos = {
        "Maria Jose Garcia Ribas, Juan Fortea": "Garcia Ribas",
        "Maria J. Garcia Ribas, Juan Fortea": "Garcia Ribas",
        "Jose Antonio Garcia-Ribas, Ana Ruiz": "Garcia-Ribas",
        # Con una inicial entre los dos ultimos tokens no hay compuesto.
        "Ricardo F. Allegri, Manuel Colome": "Allegri",
        "John R. R. Tolkien, Clive S. Lewis": "Tolkien",
        # Con tres tokens es indistinguible de "Ricardo Francisco Allegri".
        "Maria Fernanda Rosario, Pedro Nunez": "Rosario",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_los_sufijos_y_grados_no_se_toman_por_apellido():
    casos = {
        "Clifford R. Jack Jr, David A. Bennett": "Jack",
        "Ricardo F. Allegri PhD, Manuel Colome MD": "Allegri",
        "Ricardo F. Allegri MD, Manuel Colome": "Allegri",
        "Sean O'Brien, Mary Walsh": "O'Brien",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_la_rama_vancouver_no_fabrica_autores_con_terminos_y_siglas():
    """Lo que la nueva rama podria romper: cualquier "Palabras SIGLA" tiene
    la misma forma que "Apellido AB". Un termino de tres palabras, una
    palabra en minuscula o una sola letra sin mas autores no son firmas."""
    no_autores = [
        "Figure A",
        "Jack C",
        "Alzheimer disease AD, mild cognitive impairment MCI",
        "Mild Cognitive Impairment MCI, Alzheimer Disease AD",
        "Documentos base principales",
        "WM",
        "Ana Li",
    ]
    for linea in no_autores:
        assert _autor_de(linea) == "", linea


def test_la_referencia_lleva_el_apellido_con_particulas():
    meta = paper.PaperMeta(autor="van der Flier", anio="2023")

    assert meta.referencia == "van der Flier et al., 2023"


# --- de punta a punta: un articulo maquetado como Wiley ------------------------
PAGINA_WILEY_1 = [
    ("Plasma p-tau217 as a marker of amyloid pathology", 17.0),
    ("van der Flier WM, Scheltens P, Jack CR Jr", 11.0),
    ("Department of Neurology, Amsterdam UMC", 8.5),
    ("doi:10.1002/alz.12345  Alzheimers Dement 2023", 8.0),
    ("Abstract", 10.0),
    ("Plasma p-tau217 separated amyloid positive from negative participants.", 10.0),
    ("1 | INTRODUCTION", 10.0),
    ("Earlier reports suggested that plasma markers could track pathology.", 10.0),
    ("2 | METHODS", 10.0),
    ("We recruited 240 participants from two memory clinics in Amsterdam.", 10.0),
    ("3 | RESULTS", 10.0),
    ("Plasma p-tau217 reached an area under the curve of 0.93 overall.", 10.0),
]

PAGINA_WILEY_2 = [
    ("4 | DISCUSSION", 10.0),
    ("These results may indicate that plasma markers can replace PET scans.", 10.0),
    ("5 | REFERENCES", 10.0),
    ("1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 10.0),
    ("2. Garcia L. Tau propagation across cortical networks. Neuron 2021.", 10.0),
]


def test_un_articulo_wiley_con_cabeceras_al_cuerpo_de_letra_se_secciona(tmp_path):
    """El fallo medido en el corpus de Alzheimer's & Dementia.

    Las cabeceras "2 | METHODS" van al mismo cuerpo que el texto, asi que la
    maqueta no las delata: solo el nombre. Antes salia UN chunk con
    Introduccion+Metodos+Resultados+bibliografia etiquetado con el titulo, y
    la cita caia al nombre de archivo por la firma Vancouver.
    """
    from pathlib import Path

    from app.ingest.generic import parse_generic
    from tests.pdf_falso import escribir_pdf

    pdf = escribir_pdf(
        Path(tmp_path) / "wiley.pdf", [PAGINA_WILEY_1, PAGINA_WILEY_2]
    )

    chunks, _ = parse_generic(pdf, pdf.name)

    def seccion_de(fragmento: str) -> str:
        for c in chunks:
            if fragmento in c["text"]:
                return c["section"]
        raise AssertionError(f"no se indexo el fragmento {fragmento!r}")

    assert seccion_de("240 participants") == "2 | METHODS"
    assert seccion_de("0.93 overall") == "3 | RESULTS"
    assert seccion_de("replace PET scans") == "4 | DISCUSSION"
    # El dato de Resultados no viaja en el chunk de Discusion.
    assert "0.93" not in next(c["text"] for c in chunks if "PET scans" in c["text"])
    # La bibliografia no se indexa...
    texto_completo = "\n".join(c["text"] for c in chunks)
    assert "Smith J" not in texto_completo
    assert "Tau propagation" not in texto_completo
    # ...y ningun fragmento lleva el titulo como seccion.
    titulo = "Plasma p-tau217 as a marker of amyloid pathology"
    assert all(c["section"] != titulo for c in chunks)
    # Y la cita es la del trabajo, no el archivo.
    assert all(c["citation"] == "van der Flier et al., 2023" for c in chunks)
    assert chunks[0]["title"] == titulo


# --- las tres suposiciones nuevas fabricaban citas (revision adversarial) ----
def test_la_segunda_linea_de_un_titulo_partido_no_es_una_cabecera():
    """Medido el 4 sep 2026 sobre 100 primeras paginas.

    Bastaba con que UNA parte de "X and Y" fuera nombre de seccion, asi que
    la segunda mitad de un titulo partido pasaba por cabecera: de "Blood
    biomarkers for Alzheimer disease: Limitations and Opportunities" salia
    "limitaciones", y de "Findings and Implications", "resultados". Como el
    titulo se corta en la primera seccion detectada, el trabajo se quedaba
    sin titulo y sin autor. Ahora todas las partes tienen que ser nombre de
    seccion o calificador conocido.
    """
    no_cabeceras = [
        "Limitations and Opportunities",
        "Findings and Implications",
        "Results and Perspectives",
        "Discussion and Outlook",
        "Methods and Challenges",
        "Conclusions and Opportunities",
    ]
    for linea in no_cabeceras:
        assert paper.detectar_seccion(linea) is None, linea


def test_la_exigencia_no_se_come_las_cabeceras_compuestas_reales():
    """Adversarial de la guarda anterior: no puede rechazar de mas.

    Las cabeceras reales de revista ponen el calificador DELANTE de la
    seccion ("Subjects and Methods", "Strengths and Limitations") o juntan
    dos secciones, y esas tienen que seguir reconociendose: si se perdieran,
    la bibliografia volveria al indice y los fragmentos arrastrarian la
    seccion anterior.
    """
    casos = {
        "Subjects and Methods": "metodos",
        "Patients and Methods": "metodos",
        "Study Design and Methods": "metodos",
        "Strengths and Limitations": "limitaciones",
        "Materials and Methods": "metodos",
        "Results and Discussion": "resultados",
        "Discussion and Conclusions": "discusion",
        "3 | RESULTS AND DISCUSSION": "resultados",
    }
    for linea, esperado in casos.items():
        assert paper.detectar_seccion(linea) == esperado, linea


def test_una_cabecera_compuesta_no_corta_el_titulo_dentro_de_su_bloque():
    """Segunda barrera del mismo fallo: la maqueta manda sobre el nombre.

    Aqui las DOS mitades de la segunda linea del titulo son nombres de
    seccion ("Methods and Limitations"), asi que la lista cerrada de
    calificadores no la rechaza. La descarta el cuerpo de letra: va al mismo
    tamano grande que la linea anterior, o sea dentro del bloque del titulo,
    y ahi una cabecera compuesta es un titulo partido. Sin la guarda el
    titulo se queda en su primera mitad y el autor se pierde con el.
    """
    pagina = [
        ("Plasma biomarkers in memory clinics:", 17.0, 60.0),
        ("Methods and Limitations", 17.0, 85.0),
        ("Wiesje M. van der Flier, Philip Scheltens", 11.0, 115.0),
        ("Abstract", 12.0, 150.0),
        ("Plasma markers were compared against amyloid PET in 240 cases.", 10.0, 170.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "texto")

    assert meta.titulo == "Plasma biomarkers in memory clinics: Methods and Limitations"
    assert meta.autor == "van der Flier"


def test_una_cabecera_compuesta_fuera_del_bloque_del_titulo_si_lo_corta():
    """Adversarial de la guarda por maqueta: no puede apagar la deteccion.

    Aqui "Results and Discussion" va tambien en letra grande, pero DESPUES de
    los autores, o sea fuera del bloque del titulo: la linea de encima tiene
    otro cuerpo. Tiene que seguir cortando la cabecera. Si la guarda valiera
    siempre, el titulo se tragaria la cabecera ("Amyloid load and hippocampal
    atrophy Results and Discussion") y esa cadena viajaria como titulo del
    trabajo en cada fragmento.
    """
    pagina = [
        ("Amyloid load and hippocampal atrophy", 17.0, 60.0),
        ("Ricardo F. Allegri, Manuel Colome", 11.0, 95.0),
        ("Results and Discussion", 17.0, 130.0),
        ("Cortical thinning was measured in 84 participants over two years.", 10.0, 155.0),
    ]

    meta = paper.extraer_metadatos(_chars(pagina), "texto")

    assert meta.titulo == "Amyloid load and hippocampal atrophy"
    assert meta.autor == "Allegri"
    assert paper.detectar_seccion("Results and Discussion") == "resultados"


def test_un_nombre_de_pila_compuesto_hispano_no_se_parte():
    """La regla de apellido doble (>=4 tokens) rompia los nombres hispanos.

    Medido el 4 sep 2026: "Maria del Carmen Garcia" daba "Carmen Garcia" y
    "Jose de Jesus Ramirez" daba "Jesus Ramirez", citas que no reconoce
    nadie. Una particula ANTES de los dos ultimos tokens delata que lo
    compuesto es el nombre de pila, no el apellido.
    """
    casos = {
        "Maria del Carmen Garcia, Juan Perez": "Garcia",
        "Jose de Jesus Ramirez, Ana Ruiz": "Ramirez",
        "Maria de los Angeles Ruiz, Luis Diaz": "Ruiz",
        "Juan de Dios Lopez, Ana Gil": "Lopez",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_la_guarda_del_nombre_compuesto_no_anula_el_apellido_doble():
    """Adversarial: la particula solo cuenta si va ANTES de los dos ultimos.

    Si bastara con que hubiera una particula en cualquier sitio, se perderian
    los apellidos dobles y las particulas que son el arreglo anterior de este
    mismo modulo.
    """
    casos = {
        "Maria Jose Garcia Ribas, Juan Fortea": "Garcia Ribas",
        "Wiesje M. van der Flier, Philip Scheltens": "van der Flier",
        "Maria de la Torre, Juan Perez": "de la Torre",
        "Bart De Strooper, Lucia Chavez": "De Strooper",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_los_tratamientos_delante_del_nombre_se_descartan():
    """"Prof Dr Ricardo Allegri" daba "Ricardo Allegri": con los dos
    tratamientos la firma llega a cuatro tokens y se disparaba la regla de
    apellido doble sobre el nombre de pila."""
    casos = {
        "Prof Dr Ricardo Allegri, Manuel Colome": "Allegri",
        "Dr. Ricardo Allegri, Manuel Colome": "Allegri",
        "Dra Maria Rosario, Pedro Nunez": "Rosario",
        "Prof Wiesje M van der Flier PhD, Philip Scheltens": "van der Flier",
        "Ricardo Allegri MD, Manuel Colome": "Allegri",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_una_linea_de_direccion_no_se_convierte_en_autor():
    """La forma "Palabra, SIGLA" de una direccion se colaba como autoria.

    Medido el 4 sep 2026: al ampliar la sigla a [A-Z]{1,3}, y como el formato
    bibliografico desactiva la exigencia de dos palabras propias, la linea de
    afiliacion que sigue a los autores daba autor. La cita salia "Boston et
    al., 2023", que atribuye el trabajo a una ciudad.
    """
    direcciones = [
        "Boston, MA 02115, USA",
        "Amsterdam, NL",
        "Rochester, MN 55905",
        "Barcelona, ES",
        "Corresponding author: Wiesje van der Flier, Amsterdam",
    ]
    for linea in direcciones:
        assert _autor_de(linea) == "", linea


def test_la_guarda_de_direccion_no_anula_el_formato_bibliografico():
    """Adversarial: la guarda no puede servir de comodin para descartar
    autorias reales. Varias parejas "Apellido, Iniciales" en la misma linea
    son una lista bibliografica aunque una sigla coincida con un codigo de
    estado ("CA" de Catherine A. y de California)."""
    casos = {
        "Allegri, R., Colome, M., Guilbe, J.": "Allegri",
        "van der Flier, W. M., Scheltens, P.": "van der Flier",
        "Ryan, CA, Smith, JB": "Ryan",
        "Sperling, RA, Johnson KA": "Sperling",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_dos_lugares_en_una_linea_no_se_leen_como_lista_de_autores():
    """Adversarial de la salida anterior: enumerar dos ciudades no puede
    desactivar la guarda. Con solo contar parejas, "Amsterdam, NL, Rotterdam,
    NL" volvia a dar "Amsterdam"; ahora se exige que alguna sigla NO sea un
    codigo de lugar."""
    assert _autor_de("Amsterdam, NL, Rotterdam, NL") == ""


def test_los_autores_separados_por_barra_dan_el_primero():
    """Alzheimer's & Dementia (Wiley) es el corpus central y separa autores
    con "|". Sin partir por la barra la linea entera era un solo autor y se
    tomaba el ULTIMO apellido: "Frederik Barkhof et al." en vez de "van der
    Flier et al.", un autor real del trabajo pero no el primero."""
    casos = {
        "Wiesje M. van der Flier1 | Philip Scheltens1 | Frederik Barkhof2":
            "van der Flier",
        "van der Flier WM1 | Scheltens P1 | Barkhof F3": "van der Flier",
        "Ricardo F. Allegri | Manuel Colome": "Allegri",
        "Ricardo F. Allegri · Manuel Colome": "Allegri",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_un_pie_de_tabla_con_barra_no_es_una_linea_de_autores():
    """Adversarial de la barra: Wiley tambien la usa en los pies de tabla
    ("TABLE 1 | Baseline characteristics"), y partir por ella no puede
    convertir el primer trozo en un apellido."""
    for linea in ["Table 1 | Baseline characteristics",
                  "FIGURE 2 | Study flow diagram"]:
        assert _autor_de(linea) == "", linea


def test_un_termino_con_su_sigla_no_es_una_firma_vancouver():
    """"Termino SIGLA" tiene la forma exacta de "Apellido AB".

    La rama Vancouver solo rechazaba terminos de TRES palabras propias, asi
    que con una o dos seguia fabricando autores y la cita salia
    "Cerebrospinal Fluid et al., 2023". Se rechaza por palabra de la lista de
    maquetacion y dominio, por sigla de tres letras, y cuando la sigla son
    las iniciales de las palabras anteriores.
    """
    no_autores = [
        "Cerebrospinal Fluid CSF",
        "Amyloid PET",
        "Open Access CC BY",
        "Corresponding Author RF",
        "Original Article OA",
        "Alzheimer Disease AD",
        "Supplementary Material SM",
        "Review Article RA",
    ]
    for linea in no_autores:
        assert _autor_de(linea) == "", linea


def test_la_lista_de_terminos_no_descarta_firmas_vancouver_reales():
    """Adversarial: la lista de terminos no puede tragarse los apellidos.

    Son las firmas dominantes del corpus; si cayeran, todos esos trabajos
    volverian a citarse por nombre de archivo.
    """
    casos = {
        "van der Flier WM, Scheltens P": "van der Flier",
        "Allegri RF, Colome M": "Allegri",
        "Jack CR Jr, Bennett DA": "Jack",
        "Sperling RA": "Sperling",
        "Garcia Ribas MJ, Fortea J": "Garcia Ribas",
        "Mendez-Sanchez R, Lopez J": "Mendez-Sanchez",
        "de la Torre JC, Perez J": "de la Torre",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_un_apellido_corto_en_mayusculas_no_es_un_bloque_de_iniciales():
    """"Xin LI" daba "Xin": el apellido en caja alta pasaba por iniciales y
    quedaba el nombre de pila como autor, o sea "Xin et al.". El sufijo en
    posicion no final ("Jack Jr CR") dejaba "Jack Jr" por el mismo camino."""
    casos = {
        "Xin LI, Jian WU": "Li",
        "Jian WU, Xin LI": "Wu",
        "Jack Jr CR, Bennett DA": "Jack",
        "Clifford R. Jack Jr, David A. Bennett": "Jack",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


def test_el_apellido_en_mayusculas_solo_gana_con_evidencia():
    """Adversarial: "Nombre APELLIDO" y "Apellido INICIALES" son la misma
    forma, y la lectura Vancouver es la mayoritaria del corpus. Solo se
    cambia cuando el bloque es un apellido de la lista cerrada; si no, el
    apellido sigue siendo el token de delante."""
    casos = {
        "Sperling RA, Johnson K": "Sperling",
        "Jack CR, Bennett D": "Jack",
        "Knopman DS, Petersen R": "Knopman",
        "Xin QQ, Jian PP": "Xin",
        "Li X, Wang Y": "Li",
    }
    for linea, esperado in casos.items():
        assert _autor_de(linea) == esperado, linea


# --- de punta a punta: portada de Alzheimer's & Dementia -----------------------
PORTADA_WILEY = [
    ("Blood biomarkers for Alzheimer disease:", 17.0),
    ("Limitations and Opportunities", 17.0),
    ("Wiesje M. van der Flier1 | Philip Scheltens1 | Frederik Barkhof2", 11.0),
    ("Boston, MA 02115, USA", 8.5),
    ("doi:10.1002/alz.12345  Alzheimers Dement 2023", 8.0),
    ("Abstract", 10.0),
    ("Blood markers separated amyloid positive from negative participants.", 10.0),
    ("1 | INTRODUCTION", 10.0),
    ("Earlier reports suggested that plasma markers could track pathology.", 10.0),
    ("5 | REFERENCES", 10.0),
    ("1. Smith J, Brown K. Amyloid imaging in preclinical disease. 2019.", 10.0),
]


def test_una_portada_wiley_con_titulo_partido_se_cita_por_su_primer_autor(tmp_path):
    """Los tres fallos juntos, como llegan en el corpus central.

    El titulo va en dos lineas y la segunda es "Limitations and
    Opportunities"; los autores van separados por barras; y debajo hay una
    direccion postal. Antes salia: titulo cortado en su primera mitad,
    seccion "limitaciones" desde la portada, y cita "Barkhof et al." o
    "Boston et al." segun cual de las dos lineas se reconociera primero.
    """
    from pathlib import Path

    from app.ingest.generic import parse_generic
    from tests.pdf_falso import escribir_pdf

    pdf = escribir_pdf(Path(tmp_path) / "portada.pdf", [PORTADA_WILEY])

    chunks, _ = parse_generic(pdf, pdf.name)

    titulo = "Blood biomarkers for Alzheimer disease: Limitations and Opportunities"
    assert chunks[0]["title"] == titulo
    assert all(c["citation"] == "van der Flier et al., 2023" for c in chunks)
    # La bibliografia sigue fuera del indice.
    assert "Amyloid imaging in preclinical" not in "\n".join(c["text"] for c in chunks)
