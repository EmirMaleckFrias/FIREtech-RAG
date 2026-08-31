"""Parseo genérico para documentos subidos por el usuario (no canónicos).

Contrato (SPEC.md, "Gestión de documentos"):
- PDF   → texto por página (pdfplumber), chunks por párrafos de ~400 tokens
          con overlap del 15%; `page` = primera página del chunk,
          `source_pages` = todas, `chunk_type` = "doc_text".
- XLSX/CSV → detección de fila de encabezado, un chunk por fila
          ("Campo: valor"); `chunk_type` = "doc_row", `page` = número de fila.
- TXT/MD → chunks por párrafos; `page` = índice de chunk (1-based).

Cada chunk producido es un dict con TODAS las claves de
`app.services.qdrant._PAYLOAD_KEYS` + `id` (uuid4), listo para
embed_texts → upsert_chunks. Los campos ricos del esquema canónico quedan
en valores neutros (brand/category "", has_price False, precios None).

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

logger = logging.getLogger(__name__)

MAX_CHUNKS = 4000          # tope duro por documento (error claro si se excede)
_TARGET_TOKENS = 400       # tamaño objetivo de chunk (aprox.)
_OVERLAP_TOKENS = 60       # 15% de 400
_MAX_PARA_TOKENS = 500     # párrafos más largos se subdividen por oraciones
_MAX_CHUNK_CHARS = 8000    # límite duro de texto por chunk (= truncado embeddings)
_MAX_SKUS_PER_CHUNK = 32

# ---------------------------------------------------------------------------
# Detección de tokens tipo SKU.
# COPIADO de app/services/agent.py (_SKU_TOKEN_RE / _extract_sku_candidates)
# a propósito: importar agent.py acoplaría la ingesta al agente (OpenAI,
# reranker). Misma normalización (upper) para que el fast-path por SKU del
# agente matchee contra el payload `skus` de estos chunks.
# ---------------------------------------------------------------------------
# Tokens con pinta de SKU: ≥4 chars, al menos un dígito y una letra o guion.
# Los falsos positivos (300PSI, NFPA-13) son inocuos: la búsqueda exacta
# simplemente no encuentra nada.
_SKU_TOKEN_RE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9./-]{3,}\b")


def _extract_sku_candidates(text: str, limit: int = _MAX_SKUS_PER_CHUNK) -> list[str]:
    out: list[str] = []
    for tok in _SKU_TOKEN_RE.findall(text):
        has_digit = any(c.isdigit() for c in tok)
        has_alpha_or_dash = any(c.isalpha() or c == "-" for c in tok)
        # SKUs 100% numéricos largos. ≥6 dígitos evita confundir medidas.
        if re.fullmatch(r"\d{6,}", tok):
            out.append(tok)
        # Excluye medidas puras tipo 11/2, 1.25, 2026-03-12.
        elif has_digit and has_alpha_or_dash and not re.fullmatch(
            r"[\d./-]+", tok
        ):
            out.append(tok.upper())
    return list(dict.fromkeys(out))[:limit]


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
    source_row: int | None = None,
) -> dict:
    """Dict de chunk con TODAS las claves de qdrant._PAYLOAD_KEYS + id."""
    text = text[:_MAX_CHUNK_CHARS]
    return {
        "id": str(uuid.uuid4()),
        "text": text,
        "source_file": file_name,
        "page": page,
        "brand": "",
        "category": "",
        "skus": _extract_sku_candidates(text),
        "product_names": [],
        "has_price": False,
        "chunk_type": chunk_type,
        # Campos ricos del esquema canónico: neutros en documentos genéricos.
        "supplier": "",
        "category_es": "",
        "product_type": "",
        "model_series": "",
        "size_raw": "",
        "approvals": [],
        "box_qty": None,
        "price_net_usd": None,
        "price_list_usd": None,
        "cost_internal_usd": None,
        "price_status": "",
        "price_effective_date": None,
        "currency_assumed": "",
        "is_active": True,
        "visibility": "public",
        "data_quality_flags": [],
        "source_row": source_row,
        "source_pages": source_pages,
    }


def _split_long_paragraph(para: str) -> list[str]:
    """Subdivide párrafos que exceden _MAX_PARA_TOKENS (por oraciones;
    si una 'oración' sigue siendo enorme —texto sin puntuación—, por palabras)."""
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
def _parse_pdf(path: Path, file_name: str) -> tuple[list[dict], int]:
    import pdfplumber

    paras: list[tuple[str, int]] = []
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
            for para in _split_paragraphs(text):
                paras.append((para, page_no))

    chunks: list[dict] = []
    for group in _pack_paragraphs(paras):
        text = "\n\n".join(p for p, _ in group).strip()
        if not text:
            continue
        pages = sorted({pg for _, pg in group})
        chunks.append(
            _base_chunk(file_name, text, pages[0], pages, "doc_text")
        )
    return chunks, page_count


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
            lines.insert(0, f"Hoja: {sheet_label} — Fila {row_no}")
        text = "\n".join(lines).strip()
        if not text:
            continue
        chunks.append(
            _base_chunk(
                file_name, text, row_no, [row_no], "doc_row", source_row=row_no
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
        # page = índice de chunk (1-based) — no hay páginas reales.
        chunks.append(_base_chunk(file_name, chunk_text, i, [i], "doc_text"))
    return chunks, len(chunks)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
SUPPORTED_EXTENSIONS = {".pdf", ".xlsx", ".csv", ".txt", ".md"}


def parse_generic(path: Path, file_name: str) -> tuple[list[dict], int]:
    """Parsea un documento subido → (chunks, pages).

    `pages`: nº de páginas para PDF; nº de filas/chunks para el resto (es lo
    que se muestra como "pages" en GET /documents).
    Levanta ValueError si la extensión no está soportada, si no se extrae
    texto alguno, o si se supera MAX_CHUNKS.
    """
    ext = path.suffix.lower()
    if ext == ".pdf":
        chunks, pages = _parse_pdf(path, file_name)
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
