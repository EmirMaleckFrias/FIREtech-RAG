"""Genera PDFs mínimos para los tests, sin añadir dependencias al proyecto.

pdfplumber solo lee, y meter una librería de escritura (reportlab, fpdf) para
los tests sería arrastrar peso al repositorio por un fixture. Un PDF válido de
texto plano son unos pocos objetos, así que se escribe a mano.

Solo ASCII: la fuente base Helvetica sin diccionario de codificación no da
garantías con acentos, y para probar secciones y metadatos no hacen falta.
"""
from __future__ import annotations

from pathlib import Path

ALTO = 792.0
ANCHO = 612.0


def _escapar(texto: str) -> str:
    return texto.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _contenido(lineas: list[tuple[str, float]]) -> bytes:
    """Flujo de contenido: cada línea con su tamaño, de arriba hacia abajo."""
    partes = ["BT"]
    y = ALTO - 60.0
    for texto, size in lineas:
        salto = max(size * 1.6, 12.0)
        partes.append(f"/F1 {size:g} Tf")
        partes.append(f"1 0 0 1 60 {y:.1f} Tm")
        partes.append(f"({_escapar(texto)}) Tj")
        y -= salto
    partes.append("ET")
    return "\n".join(partes).encode("latin-1", errors="replace")


def escribir_pdf(destino: Path, paginas: list[list[tuple[str, float]]]) -> Path:
    """Escribe un PDF con las páginas dadas. Cada página es [(texto, tamaño)]."""
    objetos: list[bytes] = []

    n_paginas = len(paginas)
    # 1 catálogo, 2 pages, 3 fuente, luego por página: objeto página + contenido.
    ids_pagina = [4 + i * 2 for i in range(n_paginas)]

    objetos.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{i} 0 R" for i in ids_pagina)
    objetos.append(
        f"<< /Type /Pages /Kids [{kids}] /Count {n_paginas} >>".encode("latin-1")
    )
    objetos.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for i, lineas in enumerate(paginas):
        id_contenido = ids_pagina[i] + 1
        objetos.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {ANCHO:g} {ALTO:g}] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {id_contenido} 0 R >>"
            ).encode("latin-1")
        )
        flujo = _contenido(lineas)
        objetos.append(
            b"<< /Length " + str(len(flujo)).encode() + b" >>\nstream\n"
            + flujo + b"\nendstream"
        )

    salida = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for numero, cuerpo in enumerate(objetos, start=1):
        offsets.append(len(salida))
        salida += f"{numero} 0 obj\n".encode("latin-1") + cuerpo + b"\nendobj\n"

    inicio_xref = len(salida)
    salida += f"xref\n0 {len(objetos) + 1}\n".encode("latin-1")
    salida += b"0000000000 65535 f \n"
    for off in offsets:
        salida += f"{off:010d} 00000 n \n".encode("latin-1")
    salida += (
        f"trailer\n<< /Size {len(objetos) + 1} /Root 1 0 R >>\n"
        f"startxref\n{inicio_xref}\n%%EOF\n"
    ).encode("latin-1")

    destino.write_bytes(bytes(salida))
    return destino
