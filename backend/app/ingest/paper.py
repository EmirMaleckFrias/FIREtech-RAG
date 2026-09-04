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

# Numeración de encabezado: "3.", "3.1", "III.", "IV -".
_PREFIJO_NUMERO = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*|[IVXLC]+)\s*[.)\-:]?\s+", re.IGNORECASE
)

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
)

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


def detectar_seccion(linea: str) -> str | None:
    """Nombre canónico de la sección si la línea es un encabezado, o None.

    Exige que la línea sea corta y que, quitada la numeración, coincida con un
    nombre de sección conocido. Así "Methods" es encabezado pero "the methods
    described by Smith et al. were adapted" no lo es.
    """
    bruto = linea.strip()
    if not bruto or len(bruto) > 80:
        return None
    # Una línea con punto final es prosa, no un encabezado.
    if bruto.endswith((".", ";", ",")) and not re.fullmatch(r"[\dIVXLC.\s]+", bruto):
        return None

    sin_numero = _PREFIJO_NUMERO.sub("", bruto)
    normal = normalizar(sin_numero)
    if not normal or len(normal) > 60:
        return None
    # "y" / "and" sobrantes al final ("Materials and")
    for canonico, formas in _SECCIONES.items():
        if normal in formas:
            return canonico
    return None


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
    autor: str = ""       # apellido del primer autor, si se pudo extraer
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
    """
    for i, (_, _, texto) in enumerate(lineas):
        if detectar_seccion(texto) is not None:
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


def _extraer_autor(
    lineas: list[tuple[float, float, str]], tamano_titulo: float, titulo: str
) -> str:
    """Apellido del primer autor, o cadena vacía si no se puede con confianza.

    Se busca en las líneas que van justo debajo del título y antes del resumen.
    Sirven tanto "Ricardo F. Allegri, Manuel Colomé" como "Allegri, R.": en los
    dos casos el apellido es el último token del primer autor.
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
        if normal in _SECCIONES["resumen"] or normal.startswith("abstract"):
            break
        bajo = _sin_acentos(texto).lower()
        if any(r in bajo for r in _RUIDO_AUTORES):
            continue
        palabras_normales = set(re.findall(r"[a-z]+", bajo))
        if palabras_normales & _SIGLAS_INSTITUCIONALES:
            continue
        if tamano_titulo and tam > tamano_titulo + 0.6:
            continue

        # Una linea de autores tiene que parecer realmente una autoria, no el
        # primer subtitulo o frase capitalizada que siga al titulo. Se aceptan
        # "Nombre Apellido" y el formato bibliografico "Apellido, N.".
        formato_apellido_inicial = re.match(
            r"^\s*[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]{2,}\s*,\s*[A-Z](?:\.|\b)",
            texto,
        )

        # Primer autor: hasta la primera coma, "and" o "y".
        primero = re.split(r",|\band\b|\by\b|&|;", texto)[0]
        # Fuera marcas de afiliación y grados: superíndices, asteriscos, dígitos.
        primero = re.sub(r"[\d\*†‡§¶#]+", " ", primero)
        tokens = [t for t in re.split(r"\s+", primero.strip()) if len(t) > 1]
        if not tokens:
            continue
        tokens_nombre = [
            t.strip(".,") for t in tokens
            if t.strip(".,").replace("-", "").replace("'", "").isalpha()
            and t.strip(".,")[0].isupper()
        ]
        if not formato_apellido_inicial and len(tokens_nombre) < 2:
            continue
        apellido = tokens[-1].strip(".,")
        if len(apellido) >= 3 and apellido[0].isupper() and apellido.replace("-", "").isalpha():
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
