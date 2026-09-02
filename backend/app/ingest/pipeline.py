"""Ingesta de documentos: descubrir archivos → parse → embed → upsert.

Un solo camino, el mismo que usa la subida por la web (`app.ingest.generic`),
y sin nada específico de ningún dominio: lo que entra es una carpeta o una
lista de archivos.

- Dry-run: descubre y parsea SIN llamar a OpenAI, Qdrant ni Supabase (los
  imports de servicios están diferidos). Imprime por archivo las páginas, los
  chunks y los tokens, y al final el COSTE ESTIMADO de los embeddings. Sirve
  para saber lo que va a costar antes de gastarlo.
- Ingesta real: preflight de solo lectura (host de Qdrant sin credenciales,
  colección, puntos, filas en Supabase) → por archivo: embed, borrar los
  puntos anteriores de ese archivo, upsert, registrar en Supabase.

Idempotencia: cada archivo se identifica por su sha256. Si ya está registrado
con el mismo sha256, se salta sin embeber nada (`--force` lo reingesta igual).
Reingerir un archivo cambiado borra sus puntos viejos antes de insertar, así
que nunca quedan fragmentos huérfanos de una versión anterior.

Exit codes de `run_ingest`: 0 ok, 1 fallo, 2 abortado por una guarda del
preflight (nada se tocó).
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path
from urllib.parse import urlsplit

from app.ingest.generic import SUPPORTED_EXTENSIONS, parse_generic

logger = logging.getLogger(__name__)

# Exit code de las guardas del preflight (nada se tocó).
EXIT_ABORTED = 2

# Tarifa asumida de text-embedding-3-large, USD por millón de tokens. No es
# una tarifa oficial verificada: toda cifra que salga de aquí se etiqueta
# "estimado". Vive aquí y no en telemetry.py para que el dry-run no importe
# nada de servicios.
_EMBED_USD_PER_MTOK = 0.13

# Carpeta por defecto de la ingesta por CLI.
DEFAULT_DOCS_DIRNAME = "documentos"


def _est_tokens(text: str) -> int:
    """Misma estimación que el chunker: unos 4 caracteres por token."""
    return max(1, len(text) // 4)


def discover_files(targets: list[Path], recursive: bool = True) -> list[Path]:
    """Archivos soportados a partir de carpetas o rutas concretas.

    Ordenados por nombre para que dos corridas procesen en el mismo orden.
    Los archivos ocultos y los temporales de Office (que empiezan por ~$) se
    ignoran, que es lo que hay en cualquier carpeta real de trabajo.
    """
    found: list[Path] = []
    for target in targets:
        if target.is_dir():
            it = target.rglob("*") if recursive else target.glob("*")
            found.extend(p for p in it if p.is_file())
        elif target.is_file():
            found.append(target)
        else:
            raise FileNotFoundError(f"No existe {target}")

    out: list[Path] = []
    for path in found:
        if path.name.startswith((".", "~$")):
            continue
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        out.append(path)
    return sorted(set(out), key=lambda p: str(p).lower())


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Preflight de la ingesta real (sin gastar nada: ni OpenAI ni escrituras)
# ---------------------------------------------------------------------------
def _qdrant_host_label(url: str) -> str:
    """Host[:puerto] de la URL de Qdrant, sin credenciales ni query string."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or url
        return f"{host}:{parts.port}" if parts.port else host
    except Exception:
        return "(url no parseable)"


def _preflight(settings, environment: str | None, reset: bool) -> int | None:
    """Imprime el estado de Qdrant y Supabase y aplica las guardas.

    Devuelve un exit code para abortar, o None para continuar. Corre ANTES de
    embeber el primer chunk, así una colección equivocada o un entorno mal
    etiquetado se ven sin gastar tokens. Solo lecturas.
    """
    from app.services import supabase_db
    from app.services.qdrant import get_client

    print("\n--- Preflight (solo lecturas, nada se ha tocado todavía) ---")

    effective_env = settings.environment
    if environment is not None and environment != effective_env:
        print(
            f"ABORTADO: se pidió environment={environment!r} pero la "
            f"configuración cargó {effective_env!r}. Fija la variable "
            f"ENVIRONMENT antes de importar la app (ingest.py lo hace con "
            f"--environment)."
        )
        return EXIT_ABORTED
    print(f"Entorno: {effective_env}")

    client = get_client()
    collection = settings.qdrant_collection
    host = _qdrant_host_label(settings.qdrant_url)
    api_key_label = "api key configurada" if settings.qdrant_api_key else "sin api key"
    try:
        version = client.info().version
    except Exception:
        version = "desconocida"
    try:
        exists = client.collection_exists(collection)
    except Exception as exc:
        print(f"Qdrant: {host} ({api_key_label}) NO responde: {exc}")
        print("ABORTADO: sin Qdrant no hay dónde upsertear; nada se embebió.")
        return 1
    print(f"Qdrant: {host} ({api_key_label}), versión {version}")
    if exists:
        try:
            points = client.count(collection_name=collection, exact=True).count
        except Exception as exc:
            logger.warning("No se pudo contar la colección: %s", exc)
            points = "desconocidos"
        print(f"  colección '{collection}': existe, {points} puntos.")
    else:
        print(f"  colección '{collection}': NO existe (se creará).")

    if not supabase_db.db_available():
        print(
            "Supabase: no configurado; el registro de documentos y del run irá "
            "a memoria y se perderá al terminar el proceso."
        )
    else:
        try:
            rows = supabase_db.list_documents()
            print(
                f"Supabase: {len(rows)} documentos registrados para "
                f"'{effective_env}'."
            )
        except Exception as exc:
            print(f"Supabase: no se pudo leer documents ({exc}); se continúa.")

    if reset and exists:
        print(
            f"--reset: la colección '{collection}' se borrará y recreará. Todo "
            f"documento subido por la web que no esté también en la carpeta de "
            f"esta ingesta habrá que volver a subirlo."
        )
    elif reset:
        print("--reset: la colección no existe, no hay nada que borrar.")
    return None


def run_ingest(
    targets: list[Path],
    dry_run: bool = False,
    reset: bool = False,
    environment: str | None = None,
    project_id: str | None = None,
    force: bool = False,
    recursive: bool = True,
    max_usd: float | None = None,
) -> int:
    """Ingiere archivos o carpetas. Devuelve el exit code del proceso.

    project_id: etiqueta todos los chunks de esta corrida, para poder acotar
        después las búsquedas a ese conjunto.
    force: reingiere aunque el sha256 coincida con lo ya registrado.
    max_usd: si el coste estimado de los embeddings lo supera, aborta con
        exit 2 antes de gastar un token.
    """
    t0 = time.time()

    files = discover_files(targets, recursive=recursive)
    if not files:
        print(
            "No se encontró ningún archivo soportado en "
            f"{', '.join(str(t) for t in targets)}. "
            f"Extensiones aceptadas: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
        )
        return 1

    print(f"Archivos encontrados: {len(files)}")

    # 1. Parse (sin servicios externos).
    parsed: list[dict] = []
    total_chunks = total_tokens = 0
    failures: list[tuple[Path, str]] = []
    for path in files:
        try:
            chunks, pages = parse_generic(path, path.name)
        except Exception as exc:
            failures.append((path, str(exc)))
            print(f"  FALLO {path.name}: {exc}")
            continue
        tokens = sum(_est_tokens(c["text"]) for c in chunks)
        for chunk in chunks:
            chunk["project_id"] = project_id
        parsed.append(
            {"path": path, "chunks": chunks, "pages": pages, "tokens": tokens}
        )
        total_chunks += len(chunks)
        total_tokens += tokens
        print(
            f"  {path.name}: {len(chunks)} fragmentos"
            + (f" de {pages} páginas" if path.suffix.lower() == ".pdf" else "")
            + f", {tokens} tokens estimados"
        )

    if not parsed:
        print("\nNingún archivo se pudo parsear.")
        return 1

    coste = total_tokens / 1_000_000 * _EMBED_USD_PER_MTOK
    print(
        f"\nTOTAL: {len(parsed)} archivos, {total_chunks} fragmentos, "
        f"{total_tokens} tokens estimados."
    )
    # Con pocos archivos el coste redondeado a céntimos es 0.00 y no dice
    # nada: se muestra con la precisión suficiente para que se vea la cifra.
    etiqueta = (
        f"{coste:.4f} USD" if coste >= 0.0001
        else f"menos de 0.0001 USD ({coste * 100:.5f} centavos)"
    )
    print(
        f"Coste de embeddings: {etiqueta} (estimado, tarifa asumida "
        f"{_EMBED_USD_PER_MTOK} USD por millón de tokens)."
    )
    if failures:
        print(f"Archivos que fallaron al parsear: {len(failures)}")
        for path, err in failures[:20]:
            print(f"  - {path.name}: {err}")

    if dry_run:
        print(
            f"\nDry-run completado en {time.time() - t0:.1f}s, sin llamadas a "
            f"OpenAI, Qdrant ni Supabase."
        )
        return 0

    if max_usd is not None and coste > max_usd:
        print(
            f"\nABORTADO: el coste estimado ({coste:.4f} USD) supera el tope "
            f"--max-usd de {max_usd:.4f} USD. Nada se embebió. Reduce los "
            f"archivos o sube el tope."
        )
        return EXIT_ABORTED

    # ------------------------------------------------------------------
    # Ingesta real (imports diferidos para que el dry-run no toque nada)
    # ------------------------------------------------------------------
    from app.config import get_settings
    from app.services import supabase_db
    from app.services.embeddings import embed_texts
    from app.services.qdrant import (
        delete_by_file,
        ensure_collection,
        get_client,
        upsert_chunks,
    )

    settings = get_settings()

    aborted = _preflight(settings, environment, reset)
    if aborted is not None:
        return aborted

    try:
        registrados = {
            r.get("file_name"): r.get("sha256")
            for r in supabase_db.list_documents()
        }
    except Exception as exc:
        logger.warning("No se pudo leer el registro de documentos: %s", exc)
        registrados = {}

    run_id = supabase_db.start_run()
    run_stats: dict = {
        "environment": settings.environment,
        "project_id": project_id,
        "files": {},
    }
    try:
        if reset:
            client = get_client()
            if client.collection_exists(settings.qdrant_collection):
                client.delete_collection(settings.qdrant_collection)
                print(f"Colección '{settings.qdrant_collection}' borrada (--reset).")
        ensure_collection()

        total_points = 0
        saltados = 0
        for data in parsed:
            path: Path = data["path"]
            chunks: list[dict] = data["chunks"]
            sha256 = _sha256(path)

            if not force and registrados.get(path.name) == sha256:
                saltados += 1
                print(f"  {path.name}: sin cambios (mismo sha256), se salta.")
                continue

            print(f"Embebiendo {len(chunks)} chunks de {path.name} ...", flush=True)
            vectors = embed_texts([c["text"] for c in chunks])
            if len(vectors) != len(chunks):
                raise RuntimeError(
                    f"{path.name}: {len(vectors)} embeddings para "
                    f"{len(chunks)} chunks"
                )
            for chunk, vec in zip(chunks, vectors):
                chunk["dense"] = vec

            # Borrar antes de insertar: si el archivo ya estaba con otra
            # versión, sus puntos viejos no deben sobrevivir.
            delete_by_file(path.name)
            upserted = upsert_chunks(chunks)
            total_points += upserted
            print(f"  upserted {upserted} puntos.")

            supabase_db.register_document(
                file_name=path.name,
                sha256=sha256,
                pages=data["pages"],
                chunks=len(chunks),
            )
            run_stats["files"][path.name] = {
                "pages": data["pages"],
                "chunks": len(chunks),
                "upserted": upserted,
            }

        run_stats["total_points"] = total_points
        run_stats["saltados"] = saltados
        run_stats["elapsed_s"] = round(time.time() - t0, 1)
        supabase_db.finish_run(run_id, "completed", run_stats)
        print(
            f"\nIngesta completa: {total_points} puntos en "
            f"'{settings.qdrant_collection}'"
            + (f", {saltados} archivos sin cambios" if saltados else "")
            + f" ({run_stats['elapsed_s']}s)."
        )
        return 0
    except Exception as exc:
        logger.exception("Falló la ingesta")
        run_stats["elapsed_s"] = round(time.time() - t0, 1)
        supabase_db.finish_run(run_id, "failed", run_stats, error=str(exc))
        print(f"\nERROR en la ingesta: {exc}")
        return 1
