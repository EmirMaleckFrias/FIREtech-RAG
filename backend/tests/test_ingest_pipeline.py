"""Ingesta de carpetas: descubrimiento de archivos y dry-run con coste.

El dry-run es la garantía de que nadie gasta sin querer: parsea de verdad y
dice cuánto costaría, sin tocar OpenAI, Qdrant ni Supabase.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.ingest.pipeline import EXIT_ABORTED, _inspect_files, discover_files, run_ingest


@pytest.fixture
def carpeta(tmp_path: Path) -> Path:
    (tmp_path / "uno.txt").write_text("Párrafo uno.\n\nPárrafo dos.", encoding="utf-8")
    (tmp_path / "dos.md").write_text("# Título\n\nCuerpo del documento.", encoding="utf-8")
    (tmp_path / "presentacion.pptx").write_bytes(b"formato no soportado")
    (tmp_path / "imagen.png").write_bytes(b"\x89PNG")
    (tmp_path / ".oculto.txt").write_text("no", encoding="utf-8")
    (tmp_path / "~$temporal.xlsx").write_bytes(b"basura de office")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "tres.txt").write_text("Contenido anidado.", encoding="utf-8")
    return tmp_path


def test_descubre_solo_lo_soportado_y_en_orden(carpeta):
    nombres = [p.name for p in discover_files([carpeta])]

    assert nombres == ["dos.md", "tres.txt", "uno.txt"]


def test_sin_recursion_no_entra_en_subcarpetas(carpeta):
    nombres = [p.name for p in discover_files([carpeta], recursive=False)]

    assert nombres == ["dos.md", "uno.txt"]


def test_acepta_archivos_sueltos_y_no_duplica(carpeta):
    uno = carpeta / "uno.txt"

    nombres = [p.name for p in discover_files([uno, uno, carpeta / "sub"])]

    assert nombres == ["tres.txt", "uno.txt"]


def test_ruta_inexistente_es_un_error_claro(tmp_path):
    with pytest.raises(FileNotFoundError):
        discover_files([tmp_path / "no_existe"])


def test_carpeta_sin_archivos_soportados_devuelve_1(tmp_path, capsys):
    (tmp_path / "algo.png").write_bytes(b"\x89PNG")

    assert run_ingest([tmp_path], dry_run=True) == 1
    assert "No se encontró ningún archivo soportado" in capsys.readouterr().out


def test_dry_run_informa_del_coste_y_no_toca_nada(carpeta, capsys, monkeypatch):
    # Si algo intentara importar los servicios, esto lo haría explotar.
    def _prohibido(*a, **k):
        raise AssertionError("el dry-run no debe tocar servicios externos")

    monkeypatch.setattr("app.services.embeddings.embed_texts", _prohibido)

    assert run_ingest([carpeta], dry_run=True) == 0

    salida = capsys.readouterr().out
    assert "Archivos encontrados: 3" in salida
    assert "Coste de embeddings:" in salida
    assert "estimado, tarifa asumida" in salida
    assert "Dry-run completado" in salida


def test_manifiesto_de_preanalisis_no_retiene_textos_ni_chunks(carpeta):
    plans, failures = _inspect_files(discover_files([carpeta]))

    assert failures == []
    assert len(plans) == 3
    assert all(not hasattr(plan, "text") and not hasattr(plan, "chunk_data") for plan in plans)
    assert all(plan.sha256 and plan.chunks > 0 and plan.tokens > 0 for plan in plans)


def test_el_tope_de_gasto_aborta_antes_de_embeber(carpeta, capsys, monkeypatch):
    def _prohibido(*a, **k):
        raise AssertionError("no debería llegar a embeber")

    monkeypatch.setattr("app.services.embeddings.embed_texts", _prohibido)

    codigo = run_ingest([carpeta], environment="local", max_usd=0.0)

    assert codigo == EXIT_ABORTED
    assert "supera el tope --max-usd" in capsys.readouterr().out


def test_un_archivo_roto_no_tumba_la_corrida(tmp_path, capsys):
    (tmp_path / "bueno.txt").write_text("Texto válido.", encoding="utf-8")
    # PDF inválido: pdfplumber falla al abrirlo.
    (tmp_path / "malo.pdf").write_bytes(b"esto no es un pdf")

    assert run_ingest([tmp_path], dry_run=True) == 0

    salida = capsys.readouterr().out
    assert "FALLO malo.pdf" in salida
    assert "Archivos que fallaron al parsear: 1" in salida
