"""Lo que hace falta para tratar un PDF como un artículo científico y no como
un montón de texto: de qué trabajo salió cada fragmento y de qué sección.

Dos cosas que cambian la calidad de una respuesta sobre literatura:

1. **La cita.** Para quien investiga, `estudio_cohorte.pdf, pág. 3` no sirve: la
   referencia real es "Allegri et al., 2023". Se extrae de la primera página con
   heurísticas deterministas (sin LLM, coste cero) y, cuando no se puede extraer
   con confianza, se cae al título y luego al nombre del archivo. Nunca se
   inventa una referencia.

2. **La sección.** El mismo enunciado vale muy distinto según de dónde salga: un
   dato en Resultados es evidencia, en Discusión es interpretación del autor y en
   Introducción suele ser una afirmación sobre el trabajo de otros. Detectar el
   encabezado vigente y llevarlo a la cita permite que quien lee la respuesta
   sepa qué peso darle.

Y una que ahorra dinero y ruido: la bibliografía son títulos ajenos, matchea con
casi cualquier consulta y no es evidencia de nada, así que se puede descartar.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date

# Secciones canónicas de un artículo, con sus formas en inglés y español. La
# clave es el nombre canónico interno; los valores, cómo aparecen escritas.
_SECCIONES: dict[str, tuple[str, ...]] = {
    "resumen": ("abstract", "resumen", "summary", "sumario"),
    "introduccion": ("introduction", "introduccion", "background", "antecedentes"),
    "trabajo relacionado": ("related work", "trabajos relacionados", "estado del arte"),
    "metodos": (
        "methods", "method", "methodology", "materials and methods",
        "material and methods", "patients and methods", "metodos", "metodo",
        "metodologia", "materiales y metodos", "material y metodos",
        "pacientes y metodos", "sujetos y metodos",
    ),
    "resultados": ("results", "findings", "resultados", "hallazgos"),
    "discusion": ("discussion", "discusion"),
    "conclusiones": (
        "conclusion", "conclusions", "concluding remarks", "conclusion",
        "conclusiones",
    ),
    "limitaciones": ("limitations", "limitaciones"),
    "referencias": (
        "references", "reference list", "bibliography", "literature cited",
        "referencias", "referencias bibliograficas", "bibliografia",
    ),
    "agradecimientos": (
        "acknowledgements", "acknowledgments", "agradecimientos", "funding",
        "financiacion", "conflict of interest", "conflicto de intereses",
        "author contributions", "contribucion de los autores",
        "data availability", "disponibilidad de datos",
    ),
    "anexos": (
        "appendix", "appendices", "supplementary material", "supporting information",
        "anexo", "anexos", "material suplementario",
    ),
}

# Sección cuyo contenido son referencias a trabajos ajenos.
REFERENCIAS = "referencias"

# Numeración de encabezado: "3.", "3.1", "III.", "IV -" y la de Wiley "2 | METHODS".
#
# Medido el 3 sep 2026 sobre cabeceras de Alzheimer's & Dementia (maquetación
# Wiley, el corpus central del proyecto): "2 | METHODS", "3 | RESULTS" y
# "5 | REFERENCES" daban None porque la barra no contaba como separador. La
# consecuencia era grave: `canonica` nunca llegaba a "referencias", así que la
# bibliografía ENTERA se embebía, y con las cabeceras al mismo cuerpo de letra
# que el texto salía UN solo chunk con Introducción+Métodos+Resultados+
# bibliografía etiquetado con el título como sección.
#
# Dos cuidados. Tras el número tiene que venir un separador o al menos un
# espacio: si el espacio fuera opcional, la rama romana se comería la "I" de
# "Introduction" o la "C" de "Conclusions" (por eso L y C tampoco están en la
# clase: ningún artículo llega a la sección 50). Y los romanos se exigen bien
# formados y EN MAYÚSCULAS: con re.IGNORECASE, "ivxlc Results" pasaba por
# cabecera numerada.
_PREFIJO_NUMERO = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*|(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3}))"
    r"(?:\s*[.)\-:|\u00b7\u2013\u2014]\s*|\s+)"
)

# Folio pegado a la cabecera que abre la página ("3 RESULTS 5", "References
# 12"): pdfplumber los deja en la misma línea cuando comparten altura.
_PAGINA_FINAL = re.compile(r"\s+\d{1,4}$")

# Conjunción que junta dos secciones en una cabecera ("Results and Discussion",
# "Resultados y Discusión", "Discussion/Conclusion").
_UNION_SECCIONES = re.compile(r"\s+(?:and|y|e|&)\s+|\s*/\s*")

# Colas que algunas revistas añaden al nombre de la sección ("Conflict of
# Interest Statement", "Data Availability Statement").
_COLAS_SECCION = (" statement", " statements", " section")

# Palabras que acompañan legítimamente a un nombre de sección en cabeceras
# reales de revista: "Subjects and Methods", "Strengths and Limitations",
# "Study Design and Methods" y el resumen estructurado de JAMA ("Conclusions
# and Relevance"). La lista es cerrada a propósito: junto a un nombre de
# sección, una palabra DESCONOCIDA delata la segunda línea de un título
# partido y no una cabecera (ver `_seccion_compuesta`).
_CALIFICADORES_CABECERA = frozenset({
    "subjects", "patients", "participants", "materials", "material",
    "study design", "design", "strengths", "relevance", "importance",
    "sujetos", "pacientes", "participantes", "materiales", "diseno",
    "diseno del estudio", "fortalezas", "relevancia", "importancia",
})

# Índice inverso forma escrita -> nombre canónico.
_FORMA_A_CANONICO = {
    forma: canonico
    for canonico, formas in _SECCIONES.items()
    for forma in formas
}

_DOI = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.IGNORECASE)
_ANIO = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")

# Ruido típico de la cabecera de un PDF de revista, que nunca es el título.
_RUIDO_TITULO = (
    "downloaded from", "doi:", "https://", "http://", "www.", "issn",
    "all rights reserved", "creative commons", "licensed under", "open access",
    "received:", "accepted:", "published:", "corresponding author",
    "original research", "research article", "review article", "case report",
    "artículo original", "articulo original", "revista",
)

# Palabras que descartan una línea como línea de autores.
_RUIDO_AUTORES = (
    "university", "universidad", "department", "departamento", "hospital",
    "institute", "instituto", "school", "facultad", "abstract", "resumen",
    "keywords", "palabras clave", "@", "correspondence",
    # Instituciones, guias y encabezados de monografias no son personas. La
    # heuristica anterior tomaba la ultima palabra ("Salud", "Health") y
    # fabricaba citas como "Salud et al.".
    "organization", "organizacion", "world health", "salud mundial",
    "ministry", "ministerio", "association", "asociacion", "society",
    "sociedad", "foundation", "fundacion", "committee", "comite",
    "initiative", "iniciativa", "consortium", "consorcio", "agency",
    "agencia", "guideline", "guia", "documentos base", "fuentes",
    # Pie de la linea de autores: la direccion postal y el aviso de
    # correspondencia. Se buscan como subcadena porque son inequivocos.
    "corresponding author", "e-mail", "email",
)

# Palabras de una linea de direccion o afiliacion, buscadas como PALABRA
# entera y no como subcadena: "usa" aparece dentro de "causa" y "usado", y
# "clinic" dentro de "clinical", asi que como subcadena descartarian lineas
# legitimas. Van aparte de `_RUIDO_AUTORES`, que si es por subcadena.
_RUIDO_DIRECCION = frozenset({
    "center", "centers", "centre", "centres", "centro", "centros",
    "clinic", "clinica", "laboratory", "laboratorio", "college", "campus",
    "street", "avenue", "road", "box", "zip", "postal",
    "usa", "netherlands", "spain", "france", "germany", "italy", "canada",
    "australia", "china", "japan", "brazil", "mexico", "argentina", "chile",
    "colombia", "sweden", "denmark", "norway", "finland", "belgium",
    "austria", "poland", "greece", "ireland", "switzerland", "portugal",
    "espana", "francia", "alemania", "italia", "brasil", "suiza",
})

# Siglas institucionales frecuentes en el corpus medico. Aunque una de ellas
# sea autora real de un informe, no se le puede aplicar "et al.": esa forma es
# exclusiva de autorias personales. Sin metadatos bibliograficos estructurados
# es mas fiel caer al nombre del archivo que inventar una autoria.
_SIGLAS_INSTITUCIONALES = {
    "oms", "who", "gina", "gold", "kdigo", "cdc", "nih", "niddk",
    "aha", "esc", "fao", "unep", "woah",
}


# Marcas de agua y avisos legales que las revistas estampan en cada página. No
# son contenido del trabajo: si entran al índice, se pagan al embeberlos y
# aparecen como resultado de búsquedas que no tienen nada que ver.
_RUIDO_PAGINA = (
    "downloaded from", "descargado de", "all rights reserved",
    "todos los derechos reservados", "this article is protected by copyright",
    "creative commons", "licensed under", "terms and conditions",
    "see the terms and conditions", "wiley online library",
    "unauthorized reproduction", "reproduccion no autorizada",
)


def es_ruido_de_pagina(linea: str) -> bool:
    """¿La línea es marca de agua o aviso legal de la revista?"""
    bajo = _sin_acentos(linea).lower()
    return any(r in bajo for r in _RUIDO_PAGINA)


# Cuántas líneas de cada borde de la página pueden ser cabecera o pie.
BORDE_PAGINA = 2


def lineas_repetidas(por_pagina: list[list[str]], minimo_paginas: int = 3) -> set[str]:
    """Líneas que se repiten en el borde de casi todas las páginas.

    En un artículo son el nombre de la revista, el DOI y el número de página,
    estampados en cada hoja. Se detectan por repetición y no por maquetación,
    que es lo que funciona sin conocer la plantilla de cada editorial.

    Solo se miran las primeras y últimas líneas de cada página: sin esa
    restricción, una frase legítima que aparezca en varias páginas (el pie de
    una tabla que se repite, una definición citada dos veces) se borraría del
    índice, y perder contenido es mucho peor que arrastrar una cabecera.

    Devuelve las líneas ya normalizadas, para comparar contra `normalizar`.
    """
    total = len(por_pagina)
    if total < minimo_paginas:
        return set()
    conteo: dict[str, int] = {}
    for lineas in por_pagina:
        utiles = [l for l in lineas if l.strip()]
        bordes = utiles[:BORDE_PAGINA] + utiles[-BORDE_PAGINA:]
        for normal in {normalizar(l) for l in bordes}:
            # Una cabecera es corta; un párrafo largo repetido es contenido.
            if not normal or len(normal) > 90:
                continue
            conteo[normal] = conteo.get(normal, 0) + 1
    umbral = max(minimo_paginas, int(total * 0.6))
    return {normal for normal, veces in conteo.items() if veces >= umbral}


def en_borde(indice: int, total_lineas: int) -> bool:
    """¿La línea está en el borde de su página (cabecera o pie)?"""
    return indice < BORDE_PAGINA or indice >= total_lineas - BORDE_PAGINA


def _sin_acentos(texto: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", texto)
        if unicodedata.category(c) != "Mn"
    )


def normalizar(texto: str) -> str:
    """Minúsculas, sin acentos, sin puntuación de borde y sin espacios dobles."""
    limpio = _sin_acentos(texto).lower().strip()
    # Los guiones tipográficos van como escape a propósito: el guion largo no
    # debe aparecer literalmente en ningún archivo del proyecto.
    limpio = limpio.strip(" .:-_*#" + "\t\u2013\u2014")
    return re.sub(r"\s+", " ", limpio)


def detectar_seccion(linea: str, *, permitir_compuesta: bool = True) -> str | None:
    """Nombre canónico de la sección si la línea es un encabezado, o None.

    Exige que la línea sea corta y que, quitada la numeración, coincida con un
    nombre de sección conocido. Así "Methods" es encabezado pero "the methods
    described by Smith et al. were adapted" no lo es.

    `permitir_compuesta=False` apaga el reconocimiento de cabeceras de dos
    secciones ("Results and Discussion"). Lo usa `_cabecera` dentro del bloque
    del título, donde esa forma es casi siempre la segunda línea de un título
    partido y aceptarla cuesta el título, el autor y la cita.
    """
    bruto = linea.strip()
    if not bruto or len(bruto) > 80:
        return None
    # Una línea con punto final es prosa, no un encabezado.
    if bruto.endswith((".", ";", ",")) and not re.fullmatch(r"[\dIVXLC.\s]+", bruto):
        return None

    canonico = _seccion_por_nombre(bruto)
    if canonico:
        return canonico

    # Segundo intento: sin el número de página pegado ("3 RESULTS 5").
    sin_pagina = _PAGINA_FINAL.sub("", bruto)
    if sin_pagina != bruto:
        canonico = _seccion_por_nombre(sin_pagina)
        if canonico:
            return canonico

    # Tercer intento: dos secciones en una cabecera, o una cola de revista.
    if not permitir_compuesta:
        return None
    return _seccion_compuesta(sin_pagina)


def _seccion_por_nombre(bruto: str) -> str | None:
    """Coincidencia exacta con un nombre de sección, quitada la numeración."""
    normal = normalizar(_PREFIJO_NUMERO.sub("", bruto))
    if not normal or len(normal) > 60:
        return None
    return _FORMA_A_CANONICO.get(normal)


def _seccion_compuesta(bruto: str) -> str | None:
    """Cabecera corta que junta dos secciones o añade una cola.

    "Results and Discussion", "Subjects and Methods", "Discussion/Conclusion",
    "Conflict of Interest Statement".

    Se limita a líneas de hasta 4 palabras y se exige una conjunción o una
    cola conocida, NO basta con que la línea empiece por el nombre de una
    sección. Sin esa exigencia, un renglón de prosa partido ("Results were
    compared against") o un titulillo corrido ("Summary of Product
    Characteristics") pasarían por cabecera, y como `_cabecera` corta el
    título en la primera sección detectada, el artículo se quedaría sin
    título y sin autores.

    Con conjunción se exige que TODAS las partes sean reconocibles: nombre de
    sección, o calificador de `_CALIFICADORES_CABECERA`. Medido el 4 sep 2026
    sobre 100 primeras páginas, bastaba con que UNA parte fuera sección, y eso
    convertía en cabecera la segunda línea de un título partido: "Blood
    biomarkers for Alzheimer disease: Limitations and Opportunities" daba
    "limitaciones" en su segunda mitad, y "Findings and Implications" daba
    "resultados". El título se cortaba ahí, y sin título no hay autor: la cita
    caía al nombre del archivo o, peor, salía del pie de la página.

    El precio es perder cabeceras reales con cola libre ("Limitations and
    Future Directions", que tiene exactamente la misma forma). Se asume a
    propósito: no etiquetar una sección solo deja el fragmento con la sección
    anterior, mientras que partir el título destruye la cita del trabajo
    entero.
    """
    normal = normalizar(_PREFIJO_NUMERO.sub("", bruto))
    if not normal or len(normal.split()) > 4:
        return None
    for cola in _COLAS_SECCION:
        if normal.endswith(cola):
            canonico = _FORMA_A_CANONICO.get(normal[: -len(cola)].strip())
            if canonico:
                return canonico
    partes = [p for p in _UNION_SECCIONES.split(normal) if p]
    if len(partes) != 2:
        return None
    canonicos = [_FORMA_A_CANONICO.get(parte) for parte in partes]
    todas_reconocibles = all(
        canonico or parte in _CALIFICADORES_CABECERA
        for parte, canonico in zip(partes, canonicos)
    )
    secciones = [c for c in canonicos if c]
    if not todas_reconocibles or not secciones:
        return None
    # Con dos secciones manda la primera, porque lo que sigue a la cabecera
    # empieza por ella: tras "Results and Discussion" vienen resultados.
    #
    # La excepción es el resumen. "Summary and Conclusions" es una sección de
    # CIERRE y "manda la primera" la etiquetaba "resumen", que es la etiqueta
    # del abstract: el veredicto final de los autores quedaba marcado como
    # resumen preliminar, y la sección es justo lo que dice a quien lee la
    # respuesta cuánto peso darle. Cuando la primera parte es el resumen manda
    # la otra, que es la específica.
    if len(secciones) == 2 and secciones[0] == "resumen":
        return secciones[1]
    return secciones[0]


# Líneas de las que NUNCA sale el año de publicación: la marca de agua de
# descarga de una revista trae la fecha en que alguien bajó el PDF, que suele
# ser más reciente que la publicación y ganaría cualquier criterio de "el año
# más alto".
_RUIDO_ANIO = (
    "downloaded", "descargado", "accessed", "consultado", "retrieved",
    "printed", "impreso", "copyright", "©",
)


def _extraer_anio(texto: str, doi: str) -> str:
    """Año de publicación, o cadena vacía.

    Prioridad: un año cerca del DOI (ahí está la referencia bibliográfica del
    propio artículo), luego el más reciente de las líneas que no son marcas de
    descarga. Sin esa segunda regla, un PDF bajado en 2026 se cita como de 2026.
    """
    if not texto:
        return ""

    def candidatos(fragmento: str) -> list[tuple[str, int]]:
        salida: list[tuple[str, int]] = []
        rangos = [
            (m.start(), m.end())
            for m in re.finditer(
                r"\b(?:19[5-9]\d|20[0-4]\d)\s*[-\u2013\u2014]\s*"
                r"(?:19[5-9]\d|20[0-4]\d)\b",
                fragmento,
            )
        ]
        for match in _ANIO.finditer(fragmento):
            anio = match.group(1)
            # Un extremo de "2026-2036" es la vigencia de un plan, no un ano
            # de publicacion. Tambien se rechazan anos futuros: el bug llego a
            # guardar literalmente "Health et al., 2036".
            if any(inicio <= match.start() and match.end() <= fin for inicio, fin in rangos):
                continue
            if int(anio) > date.today().year:
                continue
            salida.append((anio, match.start()))
        return salida

    if doi:
        pos = texto.find(doi)
        if pos >= 0:
            ventana = texto[max(0, pos - 120): pos + len(doi) + 120]
            cerca = candidatos(ventana)
            if cerca:
                doi_local = min(120, pos)
                return min(cerca, key=lambda item: abs(item[1] - doi_local))[0]

    encontrados: list[str] = []
    for linea in texto.splitlines():
        bajo = _sin_acentos(linea).lower()
        if any(r in bajo for r in _RUIDO_ANIO):
            continue
        # Sin DOI solo se inspecciona la cabecera bibliografica. Los anos que
        # aparecen ya dentro del resumen, cuerpo o lista de referencias pueden
        # pertenecer a otros estudios y no identifican esta obra.
        if detectar_seccion(linea) is not None:
            break
        encontrados.extend(anio for anio, _ in candidatos(linea))
    if encontrados:
        # En una cabecera bien formada el primer ano es el del trabajo. Elegir
        # el mayor fue precisamente lo que convertia rangos y bibliografia en
        # una supuesta fecha de publicacion.
        return encontrados[0]
    return ""


@dataclass(frozen=True)
class PaperMeta:
    """Identidad del trabajo, para citarlo como lo citaría un humano."""

    titulo: str = ""
    autor: str = ""       # apellido del primer autor, con partículas ("van der Flier")
    anio: str = ""
    doi: str = ""

    @property
    def referencia(self) -> str:
        """Cita corta: "Allegri et al., 2023", o vacío.

        Vacío significa "no se pudo determinar": quien llama cita entonces el
        nombre del archivo, que es corto, único y con el que la interfaz sabe
        enlazar.

        NO se usa el título como respaldo, aunque se conozca. Medido en
        producción: un título de 70 caracteres recortado con puntos suspensivos
        se repetía en cada punto de una lista, hacía la respuesta ilegible y
        rompía el enlace de la cita con su fuente. Una cita tiene que ser corta
        antes que bonita.
        """
        if self.autor and self.anio:
            return f"{self.autor} et al., {self.anio}"
        return ""


def es_encabezado_por_formato(
    texto: str, tamano: float, cuerpo: float, negrita: bool
) -> bool:
    """¿La línea parece un encabezado por cómo está maquetada?

    Existe porque la lista cerrada de secciones solo cubre los nombres de un
    artículo científico. En cualquier otro documento (una guía, un informe, un
    folleto) los encabezados se llaman "Composición del mazo" o "Por qué
    elegirnos", no se reconocen, y entonces la sección detectada al principio
    se arrastra por todo lo que viene después: el fragmento de la página 4
    acaba citado como "sección: Introducción", que es peor que no decir nada.

    Un encabezado se reconoce por la maqueta y no por el nombre: línea corta,
    sin puntuación final, y con más cuerpo de letra o en negrita respecto del
    texto corrido.
    """
    limpio = texto.strip()
    if not limpio or len(limpio) > 80:
        return False
    if limpio.endswith((".", ";", ",", ":")):
        return False
    if not any(c.isalpha() for c in limpio):
        return False
    if len(limpio.split()) > 12:
        return False
    if cuerpo and tamano >= cuerpo + 0.4:
        return True
    return bool(negrita and cuerpo and tamano >= cuerpo - 0.2)


def _lineas_por_tamano(chars: list[dict]) -> list[tuple[float, float, str]]:
    """Agrupa los caracteres de una página en (tamaño, top, texto) por línea.

    `chars` son los de pdfplumber: cada uno con `text`, `size` y `top`. Se
    agrupan por coordenada vertical con tolerancia, que es como se ven las
    líneas en la página.
    """
    filas: dict[int, list[dict]] = {}
    for ch in chars:
        top = ch.get("top")
        if top is None:
            continue
        filas.setdefault(int(round(float(top) / 3.0)), []).append(ch)

    salida: list[tuple[float, float, str]] = []
    for clave in sorted(filas):
        grupo = sorted(filas[clave], key=lambda c: c.get("x0") or 0.0)
        texto = "".join(str(c.get("text") or "") for c in grupo).strip()
        if not texto:
            continue
        tamanos = [float(c.get("size") or 0.0) for c in grupo]
        # La mediana aguanta mejor que la media un superíndice o un símbolo.
        tamanos.sort()
        mediana = tamanos[len(tamanos) // 2] if tamanos else 0.0
        top = min(float(c.get("top") or 0.0) for c in grupo)
        salida.append((round(mediana, 1), top, texto))
    return salida


def _es_ruido_titulo(texto: str) -> bool:
    bajo = _sin_acentos(texto).lower()
    if any(r in bajo for r in _RUIDO_TITULO):
        return True
    # Una línea sin letras (números de página, líneas de símbolos).
    return not any(c.isalpha() for c in texto)


_MAX_LINEAS_CABECERA = 15


def _cabecera(lineas: list[tuple[float, float, str]]) -> list[tuple[float, float, str]]:
    """Las líneas anteriores al primer encabezado de sección.

    El título y los autores están siempre por encima del resumen, así que el
    corte lo marca la primera sección detectada. Es más robusto que cortar por
    coordenada: no depende del tamaño de la página ni de cuánto texto haya.

    Dentro del bloque del título (una línea con el mismo cuerpo de letra
    grande que la anterior) no se acepta una cabecera COMPUESTA. Es la segunda
    barrera del fallo medido el 4 sep 2026: un título de dos líneas cuya
    segunda mitad tiene forma "Sección and Palabra" se cortaba a sí mismo, y
    el trabajo se quedaba sin título ni autor. Un nombre de sección a secas
    ("Abstract") sí corta, esté donde esté: ahí no hay ambigüedad.
    """
    cuerpo = _tamano_cuerpo(lineas)
    for i, (tam, _, texto) in enumerate(lineas):
        en_bloque_titulo = (
            i > 0
            and abs(tam - lineas[i - 1][0]) < 0.6
            and (not cuerpo or tam > cuerpo + 0.5)
        )
        if detectar_seccion(texto, permitir_compuesta=not en_bloque_titulo) is not None:
            return lineas[:i]
    return lineas[:_MAX_LINEAS_CABECERA]


def lineas_con_formato(chars: list[dict]) -> list[tuple[str, float, bool]]:
    """(texto, tamaño, negrita) por línea, para detectar encabezados.

    La negrita sale del nombre de la fuente, que es donde la deja el PDF
    ("...-Bold", "...-Black"); no es infalible, pero es lo único que hay sin
    renderizar la página.
    """
    filas: dict[int, list[dict]] = {}
    for ch in chars:
        top = ch.get("top")
        if top is None:
            continue
        filas.setdefault(int(round(float(top) / 3.0)), []).append(ch)

    salida: list[tuple[str, float, bool]] = []
    for clave in sorted(filas):
        grupo = sorted(filas[clave], key=lambda c: c.get("x0") or 0.0)
        texto = "".join(str(c.get("text") or "") for c in grupo).strip()
        if not texto:
            continue
        tamanos = sorted(float(c.get("size") or 0.0) for c in grupo)
        mediana = tamanos[len(tamanos) // 2] if tamanos else 0.0
        fuentes = " ".join(str(c.get("fontname") or "") for c in grupo).lower()
        negrita = "bold" in fuentes or "black" in fuentes or "heavy" in fuentes
        salida.append((texto, round(mediana, 1), negrita))
    return salida


def tamano_de_cuerpo(paginas: list[list[tuple[str, float, bool]]]) -> float:
    """Tamaño del texto corrido de todo el documento, pesado por caracteres."""
    por_tamano: dict[float, int] = {}
    for lineas in paginas:
        for texto, tamano, _ in lineas:
            por_tamano[tamano] = por_tamano.get(tamano, 0) + len(texto)
    if not por_tamano:
        return 0.0
    return max(por_tamano.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _tamano_cuerpo(lineas: list[tuple[float, float, str]]) -> float:
    """Tamaño de fuente del texto corrido: el que más caracteres ocupa.

    Se pesa por caracteres y no por líneas porque el cuerpo es, por mucho, lo
    que más texto tiene en una página.
    """
    por_tamano: dict[float, int] = {}
    for tam, _, txt in lineas:
        por_tamano[tam] = por_tamano.get(tam, 0) + len(txt)
    if not por_tamano:
        return 0.0
    return max(por_tamano.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _extraer_titulo(lineas: list[tuple[float, float, str]]) -> tuple[str, float]:
    """Título por tamaño de fuente: el bloque más grande de la cabecera.

    Es lo fiable en un PDF de revista: el título está maquetado más grande que
    todo lo demás. La condición de que sea ESTRICTAMENTE mayor que el cuerpo es
    la que evita el falso positivo peor: en un documento sin estructura (unos
    apuntes, una carta) no hay título, y sin esa condición se tomaría el primer
    párrafo como si lo fuera y se citaría un trabajo que no existe.

    Devuelve (título, tamaño usado); título vacío si no hay uno reconocible.
    """
    cabecera = _cabecera(lineas)
    utiles = [
        (tam, top, txt) for tam, top, txt in cabecera
        if not _es_ruido_titulo(txt)
    ]
    if not utiles:
        return "", 0.0

    mayor = max(tam for tam, _, _ in utiles)
    if mayor <= 0:
        return "", 0.0

    # El cuerpo se mide en lo que va DESPUÉS de la cabecera; si el documento no
    # tiene secciones, en las propias líneas de cabecera que no son el título.
    resto = lineas[len(cabecera):]
    referencia = resto or [
        (tam, top, txt) for tam, top, txt in utiles if abs(tam - mayor) >= 0.6
    ]
    cuerpo = _tamano_cuerpo(referencia)
    if cuerpo and mayor <= cuerpo + 0.5:
        return "", 0.0
    if not cuerpo:
        # Todo el documento tiene el mismo tamaño: no hay título maquetado.
        return "", 0.0

    # El título puede ocupar varias líneas del mismo tamaño, seguidas.
    piezas = [txt for tam, _, txt in utiles if abs(tam - mayor) < 0.6]
    titulo = re.sub(r"\s+", " ", " ".join(piezas)).strip()
    if len(titulo) < 8 or len(titulo) > 300:
        return "", mayor
    return titulo, mayor


# Partículas que forman parte del apellido en holandés, alemán, español,
# portugués, italiano, francés y árabe: el apellido es "van der Flier", "de la
# Torre" o "De Strooper", y citarlo como "Flier" o "Torre" no lo reconoce
# nadie que lea literatura sobre Alzheimer. Se absorben hacia la izquierda
# desde el último token del nombre.
_PARTICULAS_APELLIDO = frozenset({
    "van", "der", "den", "ter", "von", "zu", "de", "del", "della", "dei",
    "degli", "di", "da", "das", "do", "dos", "du", "des", "la", "las", "los",
    "le", "el", "al", "bin", "ibn",
})

# Sufijos generacionales y grados que cierran un nombre ("Jack CR Jr",
# "Allegri PhD"). Aquí solo van los que NO pueden confundirse con un bloque
# de iniciales; los ambiguos ("MD", "RN", que son a la vez grado e iniciales
# Vancouver válidas en "Smith MD, Jones AB") viven en `_GRADOS_AMBIGUOS`, que
# los descarta solo cuando delante queda un nombre completo.
_SUFIJOS_NOMBRE = frozenset({
    "jr", "sr", "ii", "iii", "filho", "neto", "junior", "jnr",
    "phd", "msc", "mph", "mbbs", "frcp", "frcpc", "faan", "dphil", "pharmd",
    "drph", "dsc", "scd", "edd", "psyd", "mba", "mhs", "msce", "msci", "facp",
    "faha", "frcpath", "chb", "bsc", "mhsc", "dds", "dvm",
})

# Tratamientos y grados que van DELANTE del nombre ("Prof Dr Ricardo
# Allegri"). El bucle de sufijos solo mira el final, así que sin esto "Prof"
# y "Dr" contaban como tokens del nombre: con cuatro tokens se disparaba la
# regla de apellido doble y salía "Ricardo Allegri" en vez de "Allegri".
_PREFIJOS_NOMBRE = frozenset({
    "prof", "professor", "profesor", "dr", "dra", "drs", "doctor", "doctora",
    "mr", "mrs", "ms", "miss", "sir", "phd", "msc",
})

# Sufijos generacionales que la maqueta cuela ENTRE el apellido y las
# iniciales ("Jack Jr CR"). El bucle que solo mira el final dejaba "Jack Jr"
# como apellido y la cita salía "Jack Jr et al.".
_SUFIJOS_INTERIORES = frozenset({"jr", "sr", "ii", "iii", "junior", "jnr"})

# Grados que son a la vez bloque de iniciales Vancouver válido: "Smith MD"
# puede ser el doctor Smith o Smith con iniciales M. D. Se descarta como
# grado solo cuando quedan dos tokens o más, es decir cuando delante hay un
# nombre completo ("Ricardo Allegri MD"); con un solo token delante gana la
# lectura Vancouver, que es la que salva la cita ("Smith").
_GRADOS_AMBIGUOS = frozenset({"md", "do", "rn"})

# Apellidos de 2 o 3 letras que las revistas imprimen en MAYÚSCULAS junto al
# nombre de pila ("Xin LI", "Jian WU"), convención francesa y de muchas
# firmas asiáticas. Tienen la forma exacta de una firma Vancouver ("Sperling
# RA"), así que hace falta una lista cerrada para cambiar de lectura con
# evidencia: sin ella se perderían las firmas Vancouver reales del corpus, y
# esas son mayoría. El riesgo que queda es un autor cuyas iniciales sean
# justo uno de estos apellidos ("Sperling LI"), mucho menos frecuente.
_APELLIDOS_MAYUSCULAS = frozenset({
    "li", "wu", "xu", "hu", "he", "lu", "yu", "ye", "ng", "ho", "lam",
    "tan", "lin", "gao", "guo", "luo", "zhu", "kim", "lee", "cho", "wei",
})

# Términos de maquetación y de dominio que nunca son el apellido de una
# persona. Un término seguido de su sigla tiene la forma exacta de una firma
# Vancouver ("Cerebrospinal Fluid CSF", "Amyloid PET", "Open Access CC BY",
# "Original Article OA"), y salían como autores: la cita era "Cerebrospinal
# Fluid et al., 2023". Se comprueba palabra a palabra sobre el primer autor.
_TERMINOS_NO_PERSONA = frozenset({
    # Maquetación y front matter de la revista.
    "access", "article", "articles", "author", "authors", "corresponding",
    "research", "review", "reviews", "supplementary", "supporting",
    "information", "editorial", "keywords", "copyright", "license",
    "licence", "reserved", "journal", "volume", "issue", "online",
    "published", "publisher", "received", "revised", "accepted", "funding",
    "disclosure", "disclosures", "conflict", "contributions",
    "availability", "appendix", "highlights", "graphical", "preprint",
    "original", "commentary", "viewpoint", "abstract", "summary", "figure",
    "table", "open", "downloaded", "doi", "issn", "isbn", "pmid",
    # Dominio: entidades y técnicas del corpus médico.
    "cerebrospinal", "fluid", "amyloid", "tau", "plasma", "serum", "blood",
    "cognitive", "impairment", "disease", "dementia", "alzheimer",
    "alzheimers", "biomarker", "biomarkers", "imaging", "hippocampal",
    "cortical", "cohort", "trial", "baseline", "longitudinal",
    "pet", "mri", "csf", "eeg", "meg", "mci", "apoe", "suvr", "fdg",
})

# Bloque de iniciales tal y como queda tras quitar la puntuación de los
# bordes: "WM", "R.F", "CR", "J-P", "J.-P". Siempre en mayúsculas: "Li" o
# "Ma" son apellidos, no iniciales.
_INICIALES = re.compile(r"^(?:[A-Z]\.?){1,3}$|^[A-Z]\.?-[A-Z]\.?$")


def _es_nombre_propio(token: str) -> bool:
    """¿Token con pinta de nombre o apellido (capitalizado, solo letras)?"""
    limpio = token.replace("-", "").replace("'", "")
    return len(token) >= 2 and limpio.isalpha() and token[0].isupper()


def _es_nombre_de_pila(token: str) -> bool:
    """¿Token con forma de nombre de pila normal ("Xin", "Jian")?

    Capitalización de palabra corriente: nada de mayúsculas sostenidas (que
    serían un apellido maquetado o un bloque de iniciales) ni guiones.
    """
    return (
        len(token) >= 2
        and token.isalpha()
        and token[0].isupper()
        and token[1:].islower()
    )


def _apellido_del_primer_autor(
    primero: str, hay_mas_autores: bool, apellido_coma_inicial: bool
) -> str:
    """Apellido (con partículas) del primer autor, o cadena vacía.

    Dos formatos de firma conviven en el corpus y piden reglas distintas:

    * **Vancouver** ("van der Flier WM, Scheltens P, Jack CR Jr"), el estilo
      de Neurology, Alzheimer's & Dementia, Lancet Neurol y JAMA Neurol. Es
      el formato DOMINANTE en literatura sobre Alzheimer y la heurística
      anterior lo anulaba: tomaba el último token ("WM") como apellido y lo
      rechazaba por corto, así que todos esos trabajos acababan citados por
      nombre de archivo aunque el título sí se extrajera. Aquí las iniciales
      van a la derecha; quitadas, TODO lo que queda es el apellido, lo que
      resuelve de paso partículas ("van der Flier") y compuestos españoles
      ("Garcia Ribas MJ").

    * **Occidental** ("Wiesje M. van der Flier, Philip Scheltens"). El
      apellido es el último token, más las partículas que lo preceden. Una
      partícula capitalizada solo se absorbe si no abre el nombre: "Bart De
      Strooper" es "De Strooper", pero en "Le Wang" el "Le" es el nombre de
      pila. Con cuatro o más tokens y sin inicial entre los dos últimos se
      conservan los dos apellidos ("Maria Jose Garcia Ribas" es "Garcia
      Ribas"); con tres ("Maria Garcia Ribas") es indistinguible de
      "Ricardo Francisco Allegri" y se toma solo el último. Y si hay una
      partícula delante de esos dos últimos tokens, lo compuesto es el
      nombre de pila y no el apellido ("Maria del Carmen Garcia" es
      "Garcia").

    En los dos formatos la función devuelve cadena vacía antes que arriesgar
    una cita inventada: es lo que hace `referencia` caer al nombre del
    archivo, que siempre es comprobable.

    `apellido_coma_inicial` dice si la línea entera tenía forma bibliográfica
    "Apellido, N.": ahí `primero` es solo el apellido y no se le puede exigir
    dos palabras.
    """
    # Fuera marcas de afiliación y grados: superíndices, asteriscos, dígitos.
    primero = re.sub(r"[\d\*†‡§¶#]+", " ", primero)
    tokens = [t.strip(".,") for t in primero.split()]
    tokens = [t for t in tokens if t]

    # Tratamiento delante del nombre: "Prof Dr Ricardo Allegri".
    while tokens and tokens[0].lower() in _PREFIJOS_NOMBRE:
        tokens.pop(0)

    while tokens and tokens[-1].lower() in _SUFIJOS_NOMBRE:
        tokens.pop()

    # Sufijo generacional en posición interior: "Jack Jr CR". El bucle de
    # arriba solo mira el final, así que "Jr" sobrevivía y el apellido salía
    # "Jack Jr". Nunca se quita el primer token: en portugués "Neto" y
    # "Filho" también son apellidos y ahí sí encabezan.
    if len(tokens) > 1:
        tokens = [tokens[0]] + [
            t for t in tokens[1:] if t.lower() not in _SUFIJOS_INTERIORES
        ]

    # Grado ambiguo con las iniciales ("MD"): solo se descarta si delante
    # queda un nombre de al menos dos tokens.
    while len(tokens) >= 3 and tokens[-1].lower() in _GRADOS_AMBIGUOS:
        tokens.pop()

    iniciales: list[str] = []
    while tokens and _INICIALES.match(tokens[-1]):
        iniciales.append(tokens.pop())
    if not tokens:
        return ""

    if iniciales and not any(_INICIALES.match(t) for t in tokens):
        # Vancouver. Que quede otra inicial suelta entre los tokens ("R.
        # Allegri WM") delata que lo de la derecha no era el bloque de
        # iniciales de la firma; en ese caso se sigue por la rama occidental.
        #
        # El grado pegado al nombre ("Ricardo Allegri MD", "Ricardo F.
        # Allegri MD") ya no llega aquí: "MD" está en `_GRADOS_AMBIGUOS` y se
        # descarta antes, porque delante queda un nombre completo. Lo que sí
        # llega es "Smith MD", donde con un solo token delante no se puede
        # saber si "MD" es el grado o las iniciales, y gana la lectura de
        # iniciales, que es la que salva la cita.
        siglas = [bloque.replace(".", "") for bloque in reversed(iniciales)]

        # "Nombre APELLIDO" ("Xin LI", "Jian WU"): el bloque de mayúsculas no
        # son iniciales sino el apellido, y la lectura Vancouver se quedaba
        # con el nombre de pila y citaba "Xin et al.". Solo se cambia con las
        # dos evidencias juntas: apellido de la lista cerrada, y delante un
        # único token con capitalización de nombre de pila. Así "Sperling RA"
        # y "Jack CR", que tienen la misma forma, siguen siendo Vancouver.
        if (
            len(tokens) == 1
            and len(siglas) == 1
            and 2 <= len(siglas[0]) <= 3
            and siglas[0].lower() in _APELLIDOS_MAYUSCULAS
            and _es_nombre_de_pila(tokens[0])
        ):
            # Se devuelve capitalizado: la caja alta es maquetación, y en la
            # cita "Li et al." se lee mejor que "LI et al.".
            return siglas[0].capitalize()

        # Un término del dominio o de la maqueta seguido de su sigla tiene la
        # forma exacta de una firma Vancouver ("Cerebrospinal Fluid CSF",
        # "Amyloid PET", "Open Access CC BY", "Corresponding Author RF",
        # "Original Article OA"): los cinco salían como autores. Se rechaza
        # por palabra, por sigla y cuando la sigla son exactamente las
        # iniciales de las palabras ("Alzheimer Disease AD").
        if any(t.lower() in _TERMINOS_NO_PERSONA for t in tokens):
            return ""
        # La sigla solo cuenta con 3 letras o más: con dos ("AD", "CT") choca
        # demasiado con iniciales de personas reales ("Bennett AD").
        if any(len(s) >= 3 and s.lower() in _TERMINOS_NO_PERSONA for s in siglas):
            return ""

        particulas = [t for t in tokens if t.lower() in _PARTICULAS_APELLIDO]
        propios = [
            t for t in tokens
            if t.lower() not in _PARTICULAS_APELLIDO and _es_nombre_propio(t)
        ]
        # Sigla que repite las iniciales de las palabras anteriores. El precio
        # es perder al autor cuyas iniciales coinciden con las de su apellido
        # doble ("Garcia Ribas GR"), y se acepta: quedarse sin cita hace caer
        # al nombre del archivo, mientras que inventarla no tiene remedio.
        if (
            len(propios) >= 2
            and "".join(siglas) == "".join(t[0] for t in propios).upper()
        ):
            return ""
        # Un apellido tiene 1 o 2 palabras propias ("Garcia Ribas", "Ponce de
        # Leon"); tres seguidas de siglas ("Mild Cognitive Impairment MCI")
        # es un término, no una persona.
        if (
            len(particulas) + len(propios) == len(tokens)
            and 1 <= len(propios) <= 2
            and len(tokens) <= 4
            and _es_nombre_propio(tokens[-1])
            # "Figure A" también es "Palabra Inicial": una sola letra sin más
            # autores detrás no basta como firma.
            and (hay_mas_autores or len(iniciales[0].replace(".", "")) >= 2)
        ):
            return " ".join(tokens)
        return ""

    # Occidental: último token, con partículas y compuesto hacia la izquierda.
    # Hacen falta al menos dos palabras con pinta de nombre: "Documentos base
    # principales" no es una firma (la Vancouver ya se validó por su forma).
    if not apellido_coma_inicial and sum(map(_es_nombre_propio, tokens)) < 2:
        return ""
    ultimo = len(tokens) - 1
    nucleo = tokens[ultimo]
    if not _es_nombre_propio(nucleo) or len(nucleo) < 3:
        return ""
    inicio = ultimo
    while inicio > 0:
        anterior = tokens[inicio - 1]
        if anterior.lower() not in _PARTICULAS_APELLIDO:
            break
        if not anterior.islower() and inicio - 1 == 0:
            break
        inicio -= 1
    if (
        inicio == ultimo
        and len(tokens) >= 4
        and _es_nombre_propio(tokens[ultimo - 1])
        and not _INICIALES.match(tokens[ultimo - 1])
        and tokens[ultimo - 1].lower() not in _PARTICULAS_APELLIDO
        # Una partícula ANTES de esos dos últimos tokens delata un nombre de
        # pila compuesto hispano y no un apellido doble: "Maria del Carmen
        # Garcia", "Jose de Jesus Ramirez", "Maria de los Angeles Ruiz",
        # "Juan de Dios Lopez". Sin esta guarda la regla de los cuatro tokens
        # se llevaba media parte del nombre de pila ("Carmen Garcia", "Jesus
        # Ramirez") y esa cita no la reconoce nadie. "Maria Jose Garcia
        # Ribas", que no lleva partícula, conserva su apellido doble.
        #
        # El precio: si además hay apellido doble ("Maria del Pilar Sanchez
        # Ruiz") se cita solo "Ruiz", que sigue siendo un apellido real de
        # esa persona; "Carmen Garcia" no lo era.
        and not any(
            t.lower() in _PARTICULAS_APELLIDO for t in tokens[: ultimo - 1]
        )
    ):
        inicio = ultimo - 1
    return " ".join(tokens[inicio:])


# Forma bibliográfica "Apellido, N." con las partículas delante ("van der
# Flier, W. M.") y las iniciales juntas ("Allegri, RF").
_FORMATO_APELLIDO_INICIAL = re.compile(
    r"^\s*(?:[a-z]{2,3}\s+){0,2}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]{2,}"
    r"\s*,\s*(?P<sigla>[A-Z]{1,3})(?:\.|\b)"
)

# El mismo par, en cualquier posición de la línea: sirve para contar cuántos
# "Apellido, Iniciales" trae, que es lo que distingue una lista bibliográfica
# de una dirección postal.
_PAR_BIBLIOGRAFICO = re.compile(
    r"[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]{2,}\s*,\s*(?P<sigla>[A-Z]{1,3})(?:\.|\b)"
)

# Código postal pegado a la sigla del estado ("MA 02115"). Se exigen 4 a 6
# dígitos y solo espacios entre medias: los grupos de 1 o 2 dígitos son
# marcas de afiliación en superíndice ("Allegri RF1,2") y rechazar por ellas
# dejaría sin cita a los artículos que las llevan.
_DIGITOS_TRAS_SIGLA = re.compile(r"^\s+\d{4,6}\b")

# Siglas de estado y de país que aparecen tras la coma de una dirección. Se
# solapan a propósito con iniciales de personas ("MA" es Massachusetts y
# María Antonia): en la duda gana la lectura de dirección, porque quedarse
# sin cita hace caer al nombre del archivo, que es comprobable, mientras que
# atribuir el trabajo a una ciudad no lo es. Varias siglas valen a la vez
# como país y como estado ("ca", "co", "ar"), y aquí van una sola vez.
_SIGLAS_LUGAR = frozenset({
    # Países.
    "usa", "uk", "nl", "es", "fr", "it", "pt", "be", "ch", "at", "se",
    "dk", "fi", "ie", "pl", "gr", "mx", "br", "cl", "pe", "cn", "jp", "kr",
    "au", "nz", "za",
    # Estados de EE. UU. (y "de", "ca", "co", "ar", "il", que sirven para
    # los dos).
    "al", "ak", "az", "ar", "ca", "co", "ct", "dc", "de", "fl", "ga", "hi",
    "id", "il", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
    "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
    "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
    "wi", "wy",
})


def _parece_direccion(texto: str, coma_inicial: "re.Match[str]") -> bool:
    """¿La forma "Palabra, SIGLA" es en realidad una línea de dirección?

    Medido el 4 sep 2026: al ampliar la sigla a `[A-Z]{1,3}` la línea de
    afiliación que sigue a los autores entró por esta forma, y como
    `apellido_coma_inicial` desactiva la exigencia de dos palabras propias,
    "Boston, MA 02115, USA" daba autor "Boston" y "Amsterdam, NL" daba
    "Amsterdam". La cita salía "Boston et al., 2023". Ocurre precisamente
    cuando la línea de autores no se reconoce y la siguiente es la dirección.

    Dos señales de dirección: la sigla es un estado o país frecuente, o
    detrás lleva un código postal. Y una condición que evita el falso
    positivo simétrico: varios pares "Apellido, Iniciales" en la misma línea
    son una lista bibliográfica ("Ryan, CA, Smith, JB"), y ahí "CA" son las
    iniciales del autor aunque coincida con el código de California.

    Esa salida pide además que ALGUNA de las siglas no sea un código de
    lugar. Sin ese requisito bastaba con enumerar dos ciudades ("Amsterdam,
    NL, Rotterdam, NL") para desactivar la guarda entera y volver a fabricar
    "Amsterdam et al.", que es justo el fallo que se está arreglando.
    """
    siglas = [m.group("sigla").lower() for m in _PAR_BIBLIOGRAFICO.finditer(texto)]
    if len(siglas) > 1 and any(s not in _SIGLAS_LUGAR for s in siglas):
        return False
    if coma_inicial.group("sigla").lower() in _SIGLAS_LUGAR:
        return True
    return bool(_DIGITOS_TRAS_SIGLA.match(texto, coma_inicial.end("sigla")))


def _extraer_autor(
    lineas: list[tuple[float, float, str]], tamano_titulo: float, titulo: str
) -> str:
    """Apellido del primer autor, o cadena vacía si no se puede con confianza.

    Se busca en las líneas que van justo debajo del título y antes del resumen.
    Sirven "Ricardo F. Allegri, Manuel Colomé", "Allegri, R." y la firma
    Vancouver "Allegri RF, Colome M": la línea decide si es una autoría y
    `_apellido_del_primer_autor` saca el apellido según el formato.
    """
    if not lineas:
        return ""
    normal_titulo = normalizar(titulo)
    despues = False
    for tam, _, texto in lineas:
        normal = normalizar(texto)
        if not despues:
            if normal_titulo and normal and normal in normal_titulo:
                despues = True
            continue
        if not normal:
            continue
        # Las demas lineas del titulo tampoco son autores. Un titulo de dos
        # lineas solo marcaba `despues` en la primera, asi que la segunda
        # entraba como candidata a autoria: de "Practical Considerations
        # Today" salia el apellido "Today". Se reconoce por ir contenida en
        # el titulo Y al mismo cuerpo de letra que el.
        if (
            normal_titulo
            and normal in normal_titulo
            and tamano_titulo
            and abs(tam - tamano_titulo) < 0.6
        ):
            continue
        if normal in _SECCIONES["resumen"] or normal.startswith("abstract"):
            break
        bajo = _sin_acentos(texto).lower()
        if any(r in bajo for r in _RUIDO_AUTORES):
            continue
        palabras_normales = set(re.findall(r"[a-z]+", bajo))
        if palabras_normales & _SIGLAS_INSTITUCIONALES:
            continue
        if palabras_normales & _RUIDO_DIRECCION:
            continue
        if tamano_titulo and tam > tamano_titulo + 0.6:
            continue

        # Una linea de autores tiene que parecer realmente una autoria, no el
        # primer subtitulo o frase capitalizada que siga al titulo. Se aceptan
        # "Nombre Apellido" y el formato bibliografico "Apellido, N." (tambien
        # con particula delante, "van der Flier, W. M.", y con varias
        # iniciales juntas, "Allegri, RF"), salvo cuando esa misma forma es
        # una direccion postal ("Boston, MA 02115, USA").
        coma_inicial = _FORMATO_APELLIDO_INICIAL.match(texto)
        formato_apellido_inicial = bool(coma_inicial) and not _parece_direccion(
            texto, coma_inicial
        )

        # Primer autor: hasta la primera coma, "and", "y" o BARRA VERTICAL.
        # Alzheimer's & Dementia (maquetacion Wiley, el corpus central) separa
        # los autores con "|": sin ella la linea entera era un solo autor y se
        # tomaba el ULTIMO apellido, asi que "Wiesje M. van der Flier1 |
        # Philip Scheltens1 | Frederik Barkhof2" se citaba como "Frederik
        # Barkhof et al.", un autor real del trabajo pero no el primero.
        partes = re.split(r",|\band\b|\by\b|&|;|\||\u00b7", texto)
        primero = partes[0]
        hay_mas_autores = len(partes) > 1 and bool(partes[1].strip())

        apellido = _apellido_del_primer_autor(
            primero, hay_mas_autores, formato_apellido_inicial
        )
        if apellido:
            return apellido
    return ""


def extraer_metadatos(chars: list[dict], texto: str) -> PaperMeta:
    """Metadatos del trabajo desde la primera página.

    `chars` son los caracteres de pdfplumber de la página 1 (para el título por
    tamaño de fuente) y `texto` el texto plano de las primeras páginas (para el
    DOI y el año). Todo heurístico y determinista: si algo no se puede extraer
    con confianza, queda vacío y la cita cae al nombre del archivo.
    """
    lineas = _lineas_por_tamano(chars)
    titulo, tamano = _extraer_titulo(lineas)
    autor = _extraer_autor(lineas, tamano, titulo)

    doi = ""
    encontrado = _DOI.search(texto or "")
    if encontrado:
        doi = encontrado.group(0).rstrip(".,;)")

    return PaperMeta(
        titulo=titulo, autor=autor, anio=_extraer_anio(texto or "", doi), doi=doi
    )
