"""Parseo de los 6 .xlsx ORIGINALES (data/raw_xlsx/) — fuente de verdad.

Produce EXACTAMENTE la misma estructura de registros que app.ingest.parse
(`ParsedDoc`/`ParsedRow` con las mismas claves de etiqueta de la lista blanca
por archivo y el mismo row_num 'Fila N' = fila del Excel), de modo que
chunk.py funciona SIN CAMBIOS sobre cualquiera de las dos fuentes.

Reglas (validadas contra los 6 archivos reales):
- openpyxl read_only=True, data_only=True (valores calculados, no fórmulas).
- El header vive en la fila que contiene 'Part Number' (fila 1 en Aleum y
  Reliable 1/2/3; fila 2 en Croker y Notifier, cuya fila 1 está vacía).
- Los headers multi-línea ('Weight\\n(lbs)', 'Categoria\\n (Español)') se
  normalizan colapsando todo whitespace antes de mapearlos a la lista blanca
  exacta de FILE_CONFIGS.
- max_row miente (filas de formato vacías hasta 1000/1985): un registro es
  válido si Part Number no está vacío — criterio verificado: produce los
  conteos exactos 594/396/451/187/15/1977 y rangos contiguos en los 6.
- Los valores se serializan al MISMO formato string que el render PDF
  (str() de Python): int → '975', float → repr corto ('6.6', precios
  Notifier con 13 decimales completos), datetime 00:00 → ISO '2023-07-15'.
- Part Number multilínea (Croker fila 9: '7880MTF-40\\n7880MTP (Powder) or
  7880MTG (Galvanized)?'): la primera línea es el SKU y el resto va a
  `anomalies`, igual que hace parse.py con la línea suelta del PDF.
- page/source_pages quedan en 0/[] — las páginas se cruzan después con el
  PDF vía `attach_pdf_page_map` (las citas humanas abren el PDF).
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from pathlib import Path

import openpyxl

from app.config import DATA_RAW_DIR
from app.ingest.parse import FILE_CONFIGS, ParsedDoc, ParsedRow

logger = logging.getLogger(__name__)

DATA_RAW_XLSX_DIR = DATA_RAW_DIR.parent / "raw_xlsx"

# xlsx original → nombre canónico (el .pdf indexa FILE_CONFIGS, chunk.py y
# el payload source_file: los humanos abren el PDF, las citas lo conservan).
XLSX_TO_PDF: dict[str, str] = {
    "Catalogo_Aleum.xlsx": "Catalogo_Aleum.pdf",
    "Catalogo_Reliable_1.xlsx": "Catalogo_Reliable_1.pdf",
    "Catalogo_Reliable_2.xlsx": "Catalogo_Reliable_2.pdf",
    "Catalogo_Reliable_3.xlsx": "Catalogo_Reliable_3.pdf",
    "Catalogo_Croker__2.xlsx": "Catalogo_Croker__2.pdf",
    "Notifier_.xlsx": "Notifier_.pdf",
}
PDF_TO_XLSX: dict[str, str] = {v: k for k, v in XLSX_TO_PDF.items()}


def xlsx_source_complete(xlsx_dir: Path = DATA_RAW_XLSX_DIR) -> bool:
    """True si data/raw_xlsx existe y contiene los 6 .xlsx canónicos."""
    return xlsx_dir.is_dir() and all(
        (xlsx_dir / name).exists() for name in XLSX_TO_PDF
    )


def _norm_header(text: str) -> str:
    """Colapsa saltos de línea internos, NBSP y espacios múltiples."""
    return " ".join(text.split())


def _format_value(value) -> str:
    """Serializa una celda al mismo string que produjo el render PDF.

    El render usó str() de Python sobre el valor calculado: int sin
    decimales, float con repr corto (los precios de Notifier conservan sus
    13 decimales — el gate de costos confidenciales depende de esa
    precisión), datetime a medianoche como fecha ISO (Croker 'Effective'
    aparece como '2023-07-15' en el PDF).
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        if (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)  # int, float (repr corto), bool


def _map_columns(header_cells: list, labels: tuple[str, ...],
                 file_name: str) -> dict[int, str]:
    """{índice de columna 0-based: etiqueta exacta de la lista blanca}."""
    by_norm = {_norm_header(lab): lab for lab in labels}
    mapping: dict[int, str] = {}
    unknown: list[str] = []
    for idx, cell in enumerate(header_cells):
        if cell is None or not str(cell).strip():
            continue  # columna sin header (col 1 de Notifier)
        label = by_norm.get(_norm_header(str(cell)))
        if label is None:
            unknown.append(str(cell))
            continue
        if label in mapping.values():
            raise ValueError(
                f"{file_name}: etiqueta '{label}' duplicada en el header"
            )
        mapping[idx] = label
    if unknown:
        logger.warning("%s: columnas fuera de la lista blanca (descartadas): %s",
                       file_name, unknown)
    missing = set(labels) - set(mapping.values())
    if missing:
        logger.warning("%s: etiquetas de la lista blanca sin columna: %s",
                       file_name, sorted(missing))
    if "Part Number" not in mapping.values():
        raise ValueError(f"{file_name}: header sin columna 'Part Number'")
    return mapping


def parse_xlsx(xlsx_path: Path) -> ParsedDoc:
    """Parsea un .xlsx de catálogo a las mismas filas estructuradas que
    parse.parse_pdf. file_name del resultado = nombre canónico .pdf."""
    pdf_name = XLSX_TO_PDF.get(xlsx_path.name)
    if pdf_name is None:
        raise ValueError(f"Archivo xlsx sin configuración: {xlsx_path.name}")
    config = FILE_CONFIGS[pdf_name]

    wb = openpyxl.load_workbook(str(xlsx_path), read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        rows: list[ParsedRow] = []
        col_map: dict[int, str] | None = None
        for row_idx, row in enumerate(ws.iter_rows(), start=1):
            values = [c.value for c in row]
            if col_map is None:
                # Detectar la fila de header: la que contiene 'Part Number'
                # (fila 1 en Aleum/Reliable; fila 2 en Croker/Notifier).
                if any(isinstance(v, str) and _norm_header(v) == "Part Number"
                       for v in values):
                    col_map = _map_columns(values, config.labels, pdf_name)
                continue

            fields: dict[str, str] = {}
            anomalies: list[str] = []
            for idx, label in col_map.items():
                raw = values[idx] if idx < len(values) else None
                text = _format_value(raw)
                if not text.strip():
                    continue  # el render PDF omite las celdas vacías
                if label == "Part Number" and "\n" in text:
                    # Croker fila 9: la línea extra del SKU es la misma línea
                    # anómala que parse.py descarta y registra desde el PDF.
                    first, *rest = text.split("\n")
                    text = first.strip()
                    anomalies.extend(s.strip() for s in rest if s.strip())
                fields[label] = text

            # Registro válido = Part Number no vacío (criterio verificado:
            # reproduce los conteos 594/396/451/187/15/1977 exactos).
            if not fields.get("Part Number", "").strip():
                continue
            rows.append(ParsedRow(
                source_row=row_idx,
                fields=fields,
                page=0,           # se cruza después con el PDF
                source_pages=[],
                anomalies=anomalies,
            ))
        if col_map is None:
            raise ValueError(f"{xlsx_path.name}: no se encontró la fila de header")
    finally:
        wb.close()

    if len(rows) != config.expected_blocks:
        logger.warning(
            "%s: se esperaban %d registros y se parsearon %d",
            xlsx_path.name, config.expected_blocks, len(rows),
        )
    return ParsedDoc(file_name=pdf_name, page_count=0, rows=rows)


def attach_pdf_page_map(doc: ParsedDoc, pdf_doc: ParsedDoc) -> int:
    """Cruza por número de fila (idéntico en ambas fuentes: 'Fila N' del PDF
    = fila N del Excel) y copia page/source_pages del PDF a las filas xlsx.
    Filas sin correlato en el PDF quedan con page=0 y source_pages=[].
    Devuelve cuántas filas quedaron sin página."""
    page_map = {r.source_row: (r.page, list(r.source_pages))
                for r in pdf_doc.rows}
    missing = 0
    for row in doc.rows:
        hit = page_map.get(row.source_row)
        if hit is None:
            row.page, row.source_pages = 0, []
            missing += 1
        else:
            row.page, row.source_pages = hit[0], hit[1]
    doc.page_count = pdf_doc.page_count
    if missing:
        logger.warning("%s: %d filas del xlsx sin página en el PDF",
                       doc.file_name, missing)
    return missing
