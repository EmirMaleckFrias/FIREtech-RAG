"""Detección de idioma: acierta lo evidente y calla cuando no está claro.

Callar importa tanto como acertar: la etiqueta se convierte en un filtro
exacto, y una etiqueta equivocada deja fuera al documento para siempre.
"""
from __future__ import annotations

from app.ingest.idioma import detectar_idioma

ES = (
    "La concentracion de amiloide beta 42 disminuye en las fases mas tempranas "
    "de la enfermedad, mientras que la proteina tau total y la fosforilada "
    "aumentan de forma progresiva con el paso de los anos en los pacientes que "
    "fueron seguidos durante el estudio en los tres centros participantes."
)
EN = (
    "The concentration of amyloid beta 42 decreases in the earliest stages of "
    "the disease, while total tau and phosphorylated tau increase progressively "
    "over time in the patients who were followed during the study at the three "
    "participating centres that took part in this work."
)
PT = (
    "A concentracao de amiloide beta 42 diminui nas fases mais precoces da "
    "doenca, enquanto a proteina tau total e a fosforilada aumentam de forma "
    "progressiva ao longo do tempo nos doentes que foram seguidos durante o "
    "estudo nos tres centros que participaram neste trabalho."
)


def test_reconoce_espanol_ingles_y_portugues():
    assert detectar_idioma(ES) == "es"
    assert detectar_idioma(EN) == "en"
    assert detectar_idioma(PT) == "pt"


def test_con_acentos_tambien():
    assert detectar_idioma(
        "La concentración de amiloide beta también disminuye según el estudio, "
        "y la proteína tau aumenta de forma progresiva en los pacientes que "
        "fueron evaluados durante los años de seguimiento del ensayo clínico."
    ) == "es"


def test_texto_corto_no_se_arriesga():
    assert detectar_idioma("Resultados") == ""
    assert detectar_idioma("") == ""


def test_texto_sin_palabras_funcionales_no_se_arriesga():
    """Una tabla de valores no tiene idioma que valga la pena afirmar."""
    assert detectar_idioma("534 912 0.93 0.81 0.68 145 160 91 17 2021 " * 6) == ""


def test_lista_de_terminos_tecnicos_no_se_arriesga():
    assert detectar_idioma(
        "amyloid tau biomarker cohort hippocampus atrophy neurofilament "
        "phosphorylation cerebrospinal dementia cognition apolipoprotein "
        "positron tomography magnetic resonance imaging volumetry cortex "
        "entorhinal precuneus amygdala"
    ) == ""
