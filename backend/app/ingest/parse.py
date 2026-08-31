"""Parseo de los 6 PDFs de catálogo (renders lineales de Excel vía ReportLab).

Estrategia (docs/sintesis_esquema.json, "chunking_strategy"):
1. Extraer el texto de TODAS las páginas (pdfplumber; validado sin mojibake).
2. Concatenar el documento completo — los registros cruzan saltos de página,
   está PROHIBIDO segmentar por página.
3. Eliminar cabeceras/pies '<nombre>.xlsx — pág. N' y líneas '===== PAGE'.
4. Segmentar por el marcador de fila '■ Fila N' / 'Fila N' a inicio de línea.
5. Parsear pares 'Etiqueta: valor' SOLO contra la lista blanca EXACTA de
   etiquetas de cada archivo (con acentos: 'Descripción' ≠ 'Description').
   Toda línea sin etiqueta conocida es continuación multilínea del último
   campo visto (los valores abarcan 2-4 líneas).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

logger = logging.getLogger(__name__)

# --- Marcadores estructurales ------------------------------------------------
# Reliable_1 puede aparecer con o sin '■' según el extractor; la regex admite
# ambos. El encabezado '[Fila 1 — ENCABEZADO]' NO matchea (va entre corchetes).
_ROW_MARKER = re.compile(r"^\s*■?\s*Fila\s+(\d+)\s*$")
_PAGE_FOOTER = re.compile(r"^\s*\S+\.xlsx\s*[—–-]+\s*p[áa]g\.\s*\d+\s*$")
_PAGE_SEP = re.compile(r"^\s*=====\s*PAGE\b")


@dataclass
class FileConfig:
    """Configuración por archivo: lista blanca exacta de etiquetas + conteos."""

    labels: tuple[str, ...]
    expected_blocks: int
    first_row: int
    last_row: int


# Listas blancas EXACTAS por archivo (encabezado real de cada Excel, validado
# contra el texto extraído). El orden no importa: se matchea por prefijo
# 'Etiqueta:' probando de la más larga a la más corta.
FILE_CONFIGS: dict[str, FileConfig] = {
    "Catalogo_Aleum.pdf": FileConfig(
        labels=(
            "Part Number",
            "Picture",
            "Manufacturer",
            "Category",
            "Categoria",
            "Size",
            "Dimensions",
            "Weight (lbs)",
            "Short Description",
            "Descripcion Corta (Español)",
            "Description",
            "Descripción (Español)",
            "Unit Price",
            "Price Confirmation Date",
        ),
        expected_blocks=594,
        first_row=2,
        last_row=595,
    ),
    "Catalogo_Reliable_1.pdf": FileConfig(
        labels=(
            "Part Number",
            "Short Code",
            "Size",
            "Photo",
            "Supplier",
            "Category (English)",
            "Categoria (Español)",
            "Temp °F",
            "Temp °C",
            "Finish",
            "Finish (Spanish)",
            "Short Description",
            "Descripción Corta",
            "Description",
            "Descripción",
            "Bulletin",
            "Net/Net (USD)",
            "Price Effective Date",
        ),
        expected_blocks=396,
        first_row=2,
        last_row=397,
    ),
    "Catalogo_Reliable_2.pdf": FileConfig(
        labels=(
            "Part Number",
            "Short Code",
            "Size",
            "Photo 1",
            "Photo 2",
            "Supplier",
            "Category (English)",
            "Categoria (Español)",
            "Finish",
            "Finish (Spanish)",
            "Short Description",
            "Descripción Corta",
            "Description",
            "Descripción",
            "Bulletin",
            "Net/Net (USD)",
            "Price Effective Date",
        ),
        expected_blocks=451,
        first_row=2,
        last_row=452,
    ),
    "Catalogo_Reliable_3.pdf": FileConfig(
        labels=(
            "Part Number",
            "Short Code",
            "Size",
            "Photo",
            "Supplier",
            "Category (English)",
            "Categoria (Español)",
            "Box Qty",
            "Finish",
            "Finish (Spanish)",
            "Short Description",
            "Descripción Corta",
            "Description",
            "Descripción",
            "Bulletin",
            "Net/Net (USD)",
            "Price Effective Date",
        ),
        expected_blocks=187,
        first_row=2,
        last_row=188,
    ),
    "Catalogo_Croker__2.pdf": FileConfig(
        labels=(
            "Part Number",
            "Size",
            "Picture",
            "Manufacturer",
            "Dimensions",
            "Trim Style",
            "Door & Frame Materials",
            "Door Style",
            "Door Glazing",
            "Unit Cost",
            "List Price",
            "Effective",
            "Weight (lbs)",
            "Category",
            "Categoria",
            "Short Description",
            "Descripción Corta",
            "Description",
            "Descripción",
        ),
        expected_blocks=15,
        first_row=3,
        last_row=17,
    ),
    "Notifier_.pdf": FileConfig(
        labels=(
            "Part Number",
            "Size",
            "Dimensions",
            "Brand",
            "Supplier",
            "Category",
            "Categoria",
            "Picture",
            "Short Description",
            "Descripcion Corta",
            "Description",
            "Descripcion",
            "PRECIO DE LISTA July 2026",
            "COSTO FIRETECH",
            "Weight (lbs)",
        ),
        expected_blocks=1977,
        first_row=3,
        last_row=1979,
    ),
}

# Campos ruido que se descartan siempre (fórmulas Excel rotas '#VALUE!') y por
# archivo (Dimensions en Aleum está 100% vacía cuando aparece).
NOISE_LABELS: dict[str, tuple[str, ...]] = {
    "Catalogo_Aleum.pdf": ("Picture", "Dimensions"),
    "Catalogo_Reliable_1.pdf": ("Photo",),
    "Catalogo_Reliable_2.pdf": ("Photo 1", "Photo 2"),
    "Catalogo_Reliable_3.pdf": ("Photo",),
    "Catalogo_Croker__2.pdf": ("Picture",),
    "Notifier_.pdf": ("Picture",),
}


@dataclass
class ParsedRow:
    """Un bloque '■ Fila N' parseado a pares etiqueta→valor."""

    source_row: int
    fields: dict[str, str]
    page: int                      # primera página PDF del registro (1-based)
    source_pages: list[int]        # todas las páginas que abarca
    anomalies: list[str] = field(default_factory=list)  # líneas anómalas descartadas


@dataclass
class ParsedDoc:
    file_name: str
    page_count: int
    rows: list[ParsedRow]


def extract_pages(pdf_path: Path) -> list[str]:
    """Texto por página con pdfplumber (validado: 0 U+FFFD, 0 (cid:) en los 6)."""
    pages: list[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or "")
    return pages


def _iter_clean_lines(pages: list[str]):
    """(línea, nº de página 1-based) del documento completo, sin cabeceras
    de página ni separadores. Las líneas en blanco parásitas se descartan."""
    for page_no, page_text in enumerate(pages, start=1):
        for line in page_text.splitlines():
            if not line.strip():
                continue
            if _PAGE_FOOTER.match(line) or _PAGE_SEP.match(line):
                continue
            yield line, page_no


def parse_pdf(pdf_path: Path) -> ParsedDoc:
    """Parsea un PDF de catálogo completo a filas estructuradas."""
    file_name = pdf_path.name
    config = FILE_CONFIGS.get(file_name)
    if config is None:
        raise ValueError(f"Archivo sin configuración de parseo: {file_name}")

    pages = extract_pages(pdf_path)

    # Etiquetas de la más larga a la más corta para que 'Descripcion Corta'
    # gane sobre 'Descripcion' y 'Category (English)' sobre 'Category'.
    labels_sorted = sorted(config.labels, key=len, reverse=True)
    label_prefixes = [(lab, lab + ":") for lab in labels_sorted]

    rows: list[ParsedRow] = []
    current: ParsedRow | None = None
    last_label: str | None = None

    def flush() -> None:
        nonlocal current
        if current is not None:
            rows.append(current)
            current = None

    for line, page_no in _iter_clean_lines(pages):
        marker = _ROW_MARKER.match(line)
        if marker:
            flush()
            current = ParsedRow(
                source_row=int(marker.group(1)),
                fields={},
                page=page_no,
                source_pages=[page_no],
            )
            last_label = None
            continue

        if current is None:
            # Preámbulo del documento (nombre del xlsx, 'Hoja:', encabezado
            # '[Fila N — ENCABEZADO]' y sus líneas 'Col n:'): se descarta.
            continue

        if page_no not in current.source_pages:
            current.source_pages.append(page_no)

        stripped = line.strip()
        matched_label: str | None = None
        for lab, prefix in label_prefixes:
            if stripped.startswith(prefix):
                matched_label = lab
                value = stripped[len(prefix):].strip()
                break

        if matched_label is not None:
            if matched_label in current.fields:
                # Etiqueta repetida en el mismo bloque (no observado, defensivo)
                current.fields[matched_label] += "\n" + value
            else:
                current.fields[matched_label] = value
            last_label = matched_label
            continue

        # Línea sin etiqueta conocida → continuación multilínea del último
        # campo. Excepción: 'Part Number' nunca es multilínea; una continuación
        # ahí es una línea anómala del origen (Croker Fila 9:
        # '7880MTP (Powder) or 7880MTG (Galvanized)?') → se descarta y registra.
        if last_label is None or last_label == "Part Number":
            current.anomalies.append(stripped)
            continue
        current.fields[last_label] += "\n" + stripped

    flush()

    # Sanidad estructural (la validación dura vive en el dry-run del pipeline).
    if len(rows) != config.expected_blocks:
        logger.warning(
            "%s: se esperaban %d bloques 'Fila N' y se parsearon %d",
            file_name, config.expected_blocks, len(rows),
        )

    return ParsedDoc(file_name=file_name, page_count=len(pages), rows=rows)
