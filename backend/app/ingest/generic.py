"""Parseo de documentos: el único camino de ingesta del sistema.

Contrato (SPEC.md, "Gestión de documentos"):
- PDF   → texto por página (pdfplumber), chunks por párrafos de ~400 tokens
          con overlap del 15%; `page` = primera página del chunk,
          `source_pages` = todas, `chunk_type` = "text".
- DOCX  → párrafos agrupados por sección (el encabezado vigente) y una
          tabla por chunk; Word no tiene páginas, así que se cita por sección.
- XLSX/CSV → detección de fila de encabezado, un chunk por fila
          ("Campo: valor"); `chunk_type` = "table", `page` = número de fila.
- TXT/MD → chunks por párrafos; `page` = índice de chunk (1-based).

Cada chunk producido es un dict con TODAS las claves de
`app.services.qdrant._PAYLOAD_KEYS` + `id` (uuid4), listo para
embed_texts → upsert_chunks. `project_id` y `document_id` los rellena quien
llama, que es el único que sabe a qué proyecto pertenece el archivo.

Saneo: chunks con texto vacío se omiten; documentos que generan más de
MAX_CHUNKS chunks (o cero) levantan ValueError con mensaje claro.
"""
from __future__ import annotations

import csv
import io
import logging
import re
import uuid
from pathlib import Path

from app.ingest.idioma import detectar_idioma

logger = logging.getLogger(__name__)

MAX_CHUNKS = 4000          # tope duro por documento (error claro si se excede)
_TARGET_TOKENS = 400       # tamaño objetivo de chunk (aprox.)
_OVERLAP_TOKENS = 60       # 15% de 400
_MAX_PARA_TOKENS = 500     # párrafos más largos se subdividen por oraciones
_MAX_CHUNK_CHARS = 8000    # límite duro de texto por chunk (= truncado embeddings)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _est_tokens(text: str) -> int:
    """Estimación barata de tokens (~4 chars/token para es/en)."""
    return max(1, len(text) // 4)


def _base_chunk(
    file_name: str,
    text: str,
    page: int,
    source_pages: list[int],
    chunk_type: str,
    section: str = "",
    source_row: int | None = None,
    meta: object | None = None,
) -> dict:
    """Dict de chunk con TODAS las claves de qdrant._PAYLOAD_KEYS + id.

    `project_id` y `document_id` los rellena quien llama (la ruta de subida o
    el CLI de ingesta), porque el parser no sabe a qué proyecto pertenece el
    archivo. `language` queda vacío hasta que se detecte.

    `meta` es un `paper.PaperMeta` cuando el documento es un artículo: lo que
    permite citar "Allegri et al., 2023" en vez del nombre del archivo. Se
    repite en cada fragmento a propósito, para que una cita no necesite ir a
    buscar nada más.
    """
    text = text[:_MAX_CHUNK_CHARS]
    return {
        "id": str(uuid.uuid4()),
        "text": text,
        "source_file": file_name,
        "page": page,
        "project_id": None,
        "document_id": None,
        "section": section,
        "language": "",
        "document_type": Path(file_name).suffix.lower().lstrip(".") or "unknown",
        "source_pages": source_pages,
        "metadata": {"source_row": source_row} if source_row is not None else {},
        "chunk_type": chunk_type,
        "title": getattr(meta, "titulo", "") or "",
        "citation": getattr(meta, "referencia", "") or "",
        "doi": getattr(meta, "doi", "") or "",
    }


def _split_long_paragraph(para: str) -> list[str]:
    """Subdivide párrafos que exceden _MAX_PARA_TOKENS (por oraciones;
    si una 'oración' sigue siendo enorme (texto sin puntuación), por palabras)."""
    if _est_tokens(para) <= _MAX_PARA_TOKENS:
        return [para]

    sentences: list[str] = []
    for sent in re.split(r"(?<=[.!?;:])\s+", para):
        sent = sent.strip()
        if not sent:
            continue
        if _est_tokens(sent) <= _MAX_PARA_TOKENS:
            sentences.append(sent)
        else:  # sin puntuación: corte duro por palabras
            words = sent.split()
            cur: list[str] = []
            cur_len = 0
            for word in words:
                cur.append(word)
                cur_len += len(word) + 1
                if cur_len // 4 >= _TARGET_TOKENS:
                    sentences.append(" ".join(cur))
                    cur, cur_len = [], 0
            if cur:
                sentences.append(" ".join(cur))

    # Empaqueta oraciones en piezas de ~_TARGET_TOKENS.
    pieces: list[str] = []
    cur_sents: list[str] = []
    cur_tok = 0
    for sent in sentences:
        stok = _est_tokens(sent)
        if cur_sents and cur_tok + stok > _TARGET_TOKENS:
            pieces.append(" ".join(cur_sents))
            cur_sents, cur_tok = [], 0
        cur_sents.append(sent)
        cur_tok += stok
    if cur_sents:
        pieces.append(" ".join(cur_sents))
    return pieces


def _split_paragraphs(text: str) -> list[str]:
    """Párrafos por líneas en blanco; los muy largos se subdividen."""
    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if para:
            out.extend(_split_long_paragraph(para))
    return out


def _pack_paragraphs(
    paras: list[tuple[str, int]]
) -> list[list[tuple[str, int]]]:
    """Agrupa (párrafo, página) en chunks de ~_TARGET_TOKENS con overlap
    de ~_OVERLAP_TOKENS tomado de los párrafos finales del chunk anterior."""
    chunks: list[list[tuple[str, int]]] = []
    cur: list[tuple[str, int]] = []
    cur_tok = 0
    for para, page in paras:
        ptok = _est_tokens(para)
        if cur and cur_tok + ptok > _TARGET_TOKENS:
            chunks.append(cur)
            # Overlap: párrafos finales hasta cubrir ~_OVERLAP_TOKENS.
            tail: list[tuple[str, int]] = []
            ttok = 0
            for prev in reversed(cur):
                t = _est_tokens(prev[0])
                if tail and ttok + t > _OVERLAP_TOKENS:
                    break
                tail.insert(0, prev)
                ttok += t
                if ttok >= _OVERLAP_TOKENS:
                    break
            # Si el overlap fuese el chunk entero no aporta nada (y duplicaría
            # todo el texto): se descarta.
            if len(tail) == len(cur):
                tail = []
            cur = list(tail)
            cur_tok = sum(_est_tokens(p) for p, _ in cur)
        cur.append((para, page))
        cur_tok += ptok
    if cur:
        chunks.append(cur)
    return chunks


def _decode_bytes(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------
def _parse_pdf(
    path: Path, file_name: str, skip_references: bool = True
) -> tuple[list[dict], int, int]:
    """PDF con conciencia de documento: sección vigente y metadatos de la obra.

    Devuelve (chunks, páginas, párrafos_de_bibliografía_descartados).

    La sección se arrastra desde el último encabezado, y un encabezado se
    reconoce de dos maneras: por su nombre, cuando es una sección de artículo
    conocida (Métodos, Resultados), y por su MAQUETA, cuando no lo es. La
    segunda hace falta porque en un documento que no es un paper los
    encabezados se llaman "Composición del mazo" o "Por qué elegirnos": sin
    detectarlos, la primera sección reconocida se arrastraría hasta el final y
    el fragmento de la página 4 acabaría citado como "sección: Introducción",
    que es peor que no decir nada.

    La bibliografía se descarta por defecto: son títulos de trabajos ajenos que
    matchean con casi cualquier consulta sin ser evidencia de nada, y ocupan
    una parte nada despreciable de lo que se paga por embeber.
    """
    import pdfplumber

    from app.ingest import paper as paper_mod

    # (párrafo, página, sección)
    paras: list[tuple[str, int, str]] = []
    meta = paper_mod.PaperMeta()
    descartados = 0
    seccion = ""
    canonica = ""

    # Primera pasada: texto y formato de cada página. Hace falta el documento
    # entero antes de empezar, por dos razones: las cabeceras y pies se
    # detectan por repetirse entre páginas, y el tamaño del texto corrido (con
    # el que se reconocen los encabezados) solo se sabe mirándolo todo.
    paginas: list[tuple[int, list[str]]] = []
    formato: list[list[tuple[str, float, bool]]] = []
    chars: list[dict] = []
    cabecera_texto: list[str] = []

    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        for page_no, page in enumerate(pdf.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                logger.warning(
                    "%s pág. %d: fallo extrayendo texto (%s); se omite.",
                    file_name, page_no, exc,
                )
                continue
            try:
                chars_pagina = page.chars or []
            except Exception:
                chars_pagina = []
            if page_no == 1:
                chars = chars_pagina
            if page_no <= 2:
                cabecera_texto.append(text)
            paginas.append((page_no, text.splitlines()))
            formato.append(paper_mod.lineas_con_formato(chars_pagina))

    if chars:
        meta = paper_mod.extraer_metadatos(chars, "\n".join(cabecera_texto))

    repetidas = paper_mod.lineas_repetidas([lineas for _, lineas in paginas])
    cuerpo = paper_mod.tamano_de_cuerpo(formato)
    # Formato por texto de línea, para consultarlo mientras se recorre el texto
    # plano (que es lo que da los párrafos). Si una línea se repite con formatos
    # distintos gana el primero, que es suficiente para decidir si es titular.
    formato_por_texto: dict[str, tuple[float, bool]] = {}
    for lineas_pag in formato:
        for texto_linea, tamano, negrita in lineas_pag:
            formato_por_texto.setdefault(texto_linea.strip(), (tamano, negrita))

    # Segunda pasada: secciones y párrafos. Los encabezados se detectan línea a
    # línea, porque un encabezado suele ser su propia línea corta.
    for page_no, lineas in paginas:
        utiles = [l for l in lineas if l.strip()]
        for i, linea in enumerate(utiles):
            if paper_mod.es_ruido_de_pagina(linea):
                continue
            if (
                paper_mod.en_borde(i, len(utiles))
                and paper_mod.normalizar(linea) in repetidas
            ):
                continue
            detectada = paper_mod.detectar_seccion(linea)
            if detectada is None:
                # No es una sección con nombre conocido, pero puede ser un
                # encabezado igualmente: si lo es, RESETEA la sección en vez de
                # dejar que la anterior se arrastre por un contenido que no
                # describe.
                tamano, negrita = formato_por_texto.get(linea.strip(), (0.0, False))
                if paper_mod.es_encabezado_por_formato(
                    linea, tamano, cuerpo, negrita
                ):
                    canonica = ""
                    seccion = linea.strip()
                    continue
            else:
                canonica = detectada
                seccion = linea.strip()
                continue
            if skip_references and canonica == paper_mod.REFERENCIAS:
                descartados += 1
                continue
            for para in _split_paragraphs(linea):
                paras.append((para, page_no, seccion))

    chunks: list[dict] = []
    # Se empaqueta sin mezclar secciones, para que la cita de un fragmento
    # apunte a una sección de verdad y no a la frontera entre dos.
    actual: list[tuple[str, int]] = []
    actual_tok = 0
    actual_sec = ""

    def _cerrar() -> None:
        nonlocal actual, actual_tok
        if not actual:
            return
        texto = "\n\n".join(p for p, _ in actual).strip()
        if texto:
            paginas = sorted({pg for _, pg in actual})
            chunks.append(
                _base_chunk(
                    file_name, texto, paginas[0], paginas, "text",
                    section=actual_sec, meta=meta,
                )
            )
        actual = []
        actual_tok = 0

    for texto, pagina, sec in paras:
        if sec != actual_sec:
            _cerrar()
            actual_sec = sec
        tok = _est_tokens(texto)
        if actual and actual_tok + tok > _TARGET_TOKENS:
            _cerrar()
        actual.append((texto, pagina))
        actual_tok += tok
    _cerrar()

    return chunks, page_count, descartados


# ---------------------------------------------------------------------------
# Tabulares (XLSX / CSV)
# ---------------------------------------------------------------------------
def _cell_str(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _looks_numeric(s: str) -> bool:
    return bool(re.fullmatch(r"[-+]?[\d.,%$ ]+", s))


def _detect_header(rows: list[tuple[int, list[str]]]) -> tuple[list[str] | None, int]:
    """(header, índice en `rows` de la fila de header) o (None, -1).

    Header = la primera fila con ≥2 celdas no vacías, si ≥60% de esas celdas
    son textuales (no numéricas). Si esa primera fila 'ancha' es numérica,
    se asume que no hay encabezado.
    """
    for idx, (_row_no, cells) in enumerate(rows[:10]):
        non_empty = [c for c in cells if c]
        if len(non_empty) < 2:
            continue
        texty = [c for c in non_empty if not _looks_numeric(c)]
        if len(texty) / len(non_empty) >= 0.6:
            return cells, idx
        return None, -1
    return None, -1


def _rows_to_chunks(
    rows: list[tuple[int, list[str]]],
    file_name: str,
    sheet_label: str | None = None,
) -> list[dict]:
    """Un chunk por fila de datos ("Campo: valor"). page = número de fila."""
    if not rows:
        return []
    header, header_idx = _detect_header(rows)
    data_rows = rows[header_idx + 1:] if header is not None else rows

    def field_name(j: int) -> str:
        if header is not None and j < len(header) and header[j]:
            return header[j]
        return f"Columna {j + 1}"

    chunks: list[dict] = []
    for row_no, cells in data_rows:
        lines = [
            f"{field_name(j)}: {val}"
            for j, val in enumerate(cells)
            if val
        ]
        if not lines:
            continue
        if sheet_label:
            lines.insert(0, f"Hoja: {sheet_label}, fila {row_no}")
        text = "\n".join(lines).strip()
        if not text:
            continue
        chunks.append(
            _base_chunk(
                file_name, text, row_no, [row_no], "table", source_row=row_no
            )
        )
    return chunks


def _parse_xlsx(path: Path, file_name: str) -> tuple[list[dict], int]:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        sheets_with_data: list[tuple[str, list[tuple[int, list[str]]]]] = []
        for ws in wb.worksheets:
            rows: list[tuple[int, list[str]]] = []
            for row_no, row in enumerate(ws.iter_rows(values_only=True), start=1):
                cells = [_cell_str(v) for v in row]
                if any(cells):
                    rows.append((row_no, cells))
                # Corta temprano cuando el tope ya está garantizadamente
                # excedido (+10: margen por la posible fila de header).
                if len(rows) > MAX_CHUNKS + 10:
                    break
            if rows:
                sheets_with_data.append((ws.title, rows))
    finally:
        wb.close()

    multi = len(sheets_with_data) > 1
    chunks: list[dict] = []
    for title, rows in sheets_with_data:
        chunks.extend(
            _rows_to_chunks(rows, file_name, sheet_label=title if multi else None)
        )
    return chunks, len(chunks)


def _parse_csv(path: Path, file_name: str) -> tuple[list[dict], int]:
    text = _decode_bytes(path.read_bytes())
    sample = text[:8192]
    try:
        dialect: csv.Dialect | type[csv.Dialect] = csv.Sniffer().sniff(
            sample, delimiters=",;\t|"
        )
    except csv.Error:
        dialect = csv.excel

    rows: list[tuple[int, list[str]]] = []
    reader = csv.reader(io.StringIO(text), dialect)
    for row_no, row in enumerate(reader, start=1):
        cells = [c.strip() for c in row]
        if any(cells):
            rows.append((row_no, cells))
        if len(rows) > MAX_CHUNKS + 10:  # ver comentario en _parse_xlsx
            break

    chunks = _rows_to_chunks(rows, file_name)
    return chunks, len(chunks)


# ---------------------------------------------------------------------------
# TXT / MD
# ---------------------------------------------------------------------------
def _parse_text(path: Path, file_name: str) -> tuple[list[dict], int]:
    text = _decode_bytes(path.read_bytes())
    paras = [(p, 0) for p in _split_paragraphs(text)]

    chunks: list[dict] = []
    for i, group in enumerate(_pack_paragraphs(paras), start=1):
        chunk_text = "\n\n".join(p for p, _ in group).strip()
        if not chunk_text:
            continue
        # page = índice de chunk (1-based): no hay páginas reales.
        chunks.append(_base_chunk(file_name, chunk_text, i, [i], "text"))
    return chunks, len(chunks)


# ---------------------------------------------------------------------------
# Word (.docx)
# ---------------------------------------------------------------------------
def _es_titulo(parrafo) -> bool:
    """¿El párrafo es un encabezado? Por estilo, que es lo fiable en Word."""
    nombre = (getattr(parrafo.style, "name", "") or "").lower()
    return nombre.startswith(("heading", "título", "titulo", "subtitle", "subtítulo"))


def _tabla_a_texto(tabla) -> str:
    """Tabla de Word como texto plano, una fila por línea.

    Se conserva el orden de las celdas y se separan con ' | ' para que el
    modelo pueda leer la fila entera; las tablas de un documento clínico
    suelen llevar los datos que a nadie le sirve perder.
    """
    filas: list[str] = []
    for fila in tabla.rows:
        celdas = [c.text.strip().replace("\n", " ") for c in fila.cells]
        # Word repite la celda combinada en cada columna que abarca.
        limpias: list[str] = []
        for celda in celdas:
            if not limpias or celda != limpias[-1]:
                limpias.append(celda)
        linea = " | ".join(limpias).strip(" |")
        if linea:
            filas.append(linea)
    return "\n".join(filas)


def _parse_docx(path: Path, file_name: str) -> tuple[list[dict], int]:
    """Word: párrafos agrupados por sección, más las tablas del documento.

    Word no tiene páginas: el salto de página lo calcula el visor al
    renderizar, así que el localizador de cita es la sección (el encabezado
    vigente) y, a falta de encabezados, el número de fragmento.
    """
    import docx

    documento = docx.Document(str(path))

    # (texto, sección) en el orden del documento.
    bloques: list[tuple[str, str]] = []
    seccion = ""
    for parrafo in documento.paragraphs:
        texto = parrafo.text.strip()
        if not texto:
            continue
        if _es_titulo(parrafo):
            seccion = texto
            # El título también se indexa: es la mejor pista de qué viene.
            bloques.append((texto, seccion))
            continue
        for pieza in _split_long_paragraph(texto):
            bloques.append((pieza, seccion))

    # Las tablas van al final porque python-docx no da su posición relativa
    # respecto de los párrafos sin bajar al XML; cada una es su propio chunk.
    tablas: list[str] = []
    for tabla in documento.tables:
        texto = _tabla_a_texto(tabla)
        if texto:
            tablas.append(texto[:_MAX_CHUNK_CHARS])

    chunks: list[dict] = []
    indice = 0

    # Los párrafos se empaquetan a ~_TARGET_TOKENS SIN mezclar secciones, para
    # que la cita de un chunk apunte a una sección de verdad y no a dos.
    actual: list[str] = []
    actual_tok = 0
    actual_sec = ""

    def _cerrar() -> None:
        nonlocal actual, actual_tok, indice
        if not actual:
            return
        indice += 1
        chunks.append(
            _base_chunk(
                file_name,
                "\n\n".join(actual),
                indice,
                [indice],
                "text",
                section=actual_sec,
            )
        )
        actual = []
        actual_tok = 0

    for texto, sec in bloques:
        if sec != actual_sec:
            _cerrar()
            actual_sec = sec
        tok = _est_tokens(texto)
        if actual and actual_tok + tok > _TARGET_TOKENS:
            _cerrar()
        actual.append(texto)
        actual_tok += tok
    _cerrar()

    # Las tablas se numeran aparte (tabla 1, tabla 2...): es como las busca
    # quien abre el documento, y no comparten numeración con los párrafos.
    for numero, texto in enumerate(tablas, start=1):
        chunks.append(
            _base_chunk(file_name, texto, numero, [numero], "table")
        )

    return chunks, len(chunks)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"}


def parse_generic(
    path: Path, file_name: str, skip_references: bool = True
) -> tuple[list[dict], int]:
    """Parsea un documento → (chunks, pages).

    `pages`: nº de páginas para PDF; nº de filas/chunks para el resto (es lo
    que se muestra como "pages" en GET /documents).

    `skip_references`: descarta la bibliografía de un PDF (default). Son
    títulos de trabajos ajenos: matchean con cualquier consulta, no son
    evidencia de nada y se pagan igual al embeberlos. Ponerlo en False solo
    tiene sentido si lo que se quiere consultar ES la bibliografía.

    Levanta ValueError si la extensión no está soportada, si no se extrae
    texto alguno, o si se supera MAX_CHUNKS.
    """
    ext = path.suffix.lower()
    descartados = 0
    if ext == ".pdf":
        chunks, pages, descartados = _parse_pdf(
            path, file_name, skip_references=skip_references
        )
        if descartados:
            logger.info(
                "%s: %d líneas de bibliografía descartadas.", file_name, descartados
            )
    elif ext == ".docx":
        chunks, pages = _parse_docx(path, file_name)
    elif ext == ".doc":
        raise ValueError(
            "El formato .doc (Word 97-2003) no se puede leer. Abre el archivo "
            "en Word y guárdalo como .docx, o expórtalo a PDF."
        )
    elif ext == ".xlsx":
        chunks, pages = _parse_xlsx(path, file_name)
    elif ext == ".csv":
        chunks, pages = _parse_csv(path, file_name)
    elif ext in (".txt", ".md"):
        chunks, pages = _parse_text(path, file_name)
    else:
        raise ValueError(f"Extensión no soportada: {ext}")

    # Saneo final: sin texto → fuera (defensa extra; ya se filtra antes).
    chunks = [c for c in chunks if c["text"].strip()]

    # Idioma del documento entero, no por fragmento: un artículo está escrito
    # en un idioma, y decidirlo sobre todo el texto es mucho más fiable que
    # sobre un párrafo corto. Si no queda claro se deja vacío.
    idioma = detectar_idioma("\n".join(c["text"] for c in chunks[:40]))
    for chunk in chunks:
        chunk["language"] = idioma

    if not chunks:
        raise ValueError(
            f"'{file_name}' no contiene texto extraíble (¿PDF escaneado sin OCR "
            f"o archivo vacío?)"
        )
    if len(chunks) > MAX_CHUNKS:
        raise ValueError(
            f"'{file_name}' genera {len(chunks)} chunks; el máximo permitido es "
            f"{MAX_CHUNKS}. Divide el documento en archivos más pequeños."
        )
    return chunks, pages
