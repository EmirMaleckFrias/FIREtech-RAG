"""Reintento de indexación: cuándo se considera abandonado un `processing`.

Regresión de un bloqueo mutuo encontrado en revisión: si la función de Vercel
muere por el corte de 300 s a mitad de ingesta NO hay excepción de Python, así
que nadie marca el documento como `failed` y se queda en `processing` para
siempre. Y entonces los dos caminos de recuperación se bloqueaban entre sí:
`/upload` responde 409 porque el nombre ya existe, y `/reindex` respondía 409
porque estaba "procesando". La única salida era borrar y resubir.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.api.documents import PROCESSING_STALE_MINUTES, _processing_rancio


def _hace(minutos: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutos)).isoformat()


def test_un_processing_reciente_no_se_toca():
    """Reingerir en paralelo duplicaría chunks: si de verdad sigue vivo, no."""
    assert _processing_rancio({"ingested_at": _hace(1)}) is False


def test_un_processing_pasado_el_tope_se_considera_abandonado():
    assert _processing_rancio({"ingested_at": _hace(PROCESSING_STALE_MINUTES + 1)}) is True


def test_el_tope_deja_holgura_sobre_el_corte_de_vercel():
    """La función muere a los 300 s, así que nada legítimo vive 10 minutos."""
    assert PROCESSING_STALE_MINUTES * 60 > 300


def test_sin_fecha_se_permite_el_reintento():
    """Un `processing` sin marca de tiempo es indistinguible de uno
    abandonado, y bloquear el reintento para siempre es peor que permitir uno
    de más: como mucho reingiere algo que ya estaba bien."""
    assert _processing_rancio({}) is True
    assert _processing_rancio({"ingested_at": None}) is True


def test_una_fecha_corrupta_no_bloquea_el_reintento():
    assert _processing_rancio({"ingested_at": "no-es-una-fecha"}) is True


def test_acepta_el_formato_con_Z_de_supabase():
    """PostgREST devuelve las fechas con sufijo Z, que fromisoformat no come
    en todas las versiones de Python."""
    ahora = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    assert _processing_rancio({"ingested_at": ahora}) is False


def test_una_fecha_sin_zona_se_asume_utc_y_no_revienta():
    """Si la columna llegara sin tzinfo, comparar contra un aware daría
    TypeError y tumbaría el endpoint."""
    ingenua = (datetime.now(timezone.utc) - timedelta(minutes=60)).replace(tzinfo=None)
    assert _processing_rancio({"ingested_at": ingenua.isoformat()}) is True


# ---------------------------------------------------------------------------
# El endpoint, ejecutado de verdad: que renueve la fecha al marcar processing
# ---------------------------------------------------------------------------
async def test_el_reindex_renueva_ingested_at_o_la_guarda_se_salta_a_si_misma(
    settings_override, monkeypatch, tmp_path
):
    """Regresión de un fallo que se anulaba solo.

    `_processing_rancio` mide la antigüedad con `ingested_at`, pero
    `upsert_document_status` NO lo actualiza (solo lo escribe
    `register_document`). Así que al reindexar, el registro heredaba la fecha
    vieja, se consideraba abandonado de inmediato, y un segundo reindex
    concurrente pasaba el guarda: dos ingestas a la vez duplicando fragmentos.
    """
    from fastapi import BackgroundTasks

    from app.api import documents as mod
    from app.services.auth import AuthUser

    antiguo = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    monkeypatch.setattr(
        mod.supabase_db, "list_documents",
        lambda: [{"file_name": "x.pdf", "status": "failed",
                  "ingested_at": antiguo, "id": "doc-1"}],
    )
    llamadas: list[dict] = []
    monkeypatch.setattr(
        mod.supabase_db, "upsert_document_status",
        lambda fn, st, err=None, **kw: llamadas.append(
            {"file": fn, "status": st, **kw}) or True,
    )
    # el archivo tiene que existir para no salir por el 409 de file_not_stored
    monkeypatch.setattr(mod, "UPLOADS_DIR", tmp_path)
    (tmp_path / "x.pdf").write_bytes(b"%PDF-1.4 fake")
    # camino local: la ingesta se encola y no corre dentro del test
    monkeypatch.setattr(mod, "IS_SERVERLESS", False)

    tareas = BackgroundTasks()
    await mod.reindex_document(
        "x.pdf", tareas, user=AuthUser(id="u1", email="a@airobotix.net", role="admin")
    )

    assert len(llamadas) == 1
    marcada = llamadas[0]
    assert marcada["status"] == "processing"
    assert "ingested_at" in marcada, "sin renovar la fecha, la guarda se anula sola"
    # y la fecha nueva NO puede parecer rancia
    assert _processing_rancio({"ingested_at": marcada["ingested_at"]}) is False
    # con la fecha vieja sí lo parecía: eso era el bug
    assert _processing_rancio({"ingested_at": antiguo}) is True
