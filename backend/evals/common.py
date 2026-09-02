"""Base común de los runners de evaluación (run_eval.py y judge_answers.py).

Aquí vive lo que ambos scripts necesitan y que antes estaba duplicado o
simplemente no existía: la carga normalizada de los gold sets, la carpeta de
resultados con marca de tiempo, la huella del índice Qdrant contra el que se
midió, los metadatos de la corrida (prompt, modelos, commit), el forzado del
modo de retrieval (híbrido vs denso) y la detección de errores de cuota.

Reglas que este módulo hace cumplir:
  - Ningún documento escrito por los evals contiene el guión largo (U+2014):
    `write_doc` aborta con EXIT_DOC si lo detecta y `sanitize` lo sustituye en
    los textos que vienen de un LLM (respuestas, notas del juez).
  - Toda cifra en USD es una estimación con tarifas asumidas: usar siempre
    `telemetry.PRICING_LABEL` al mostrarla.
  - Al primer error de cuota/facturación (`insufficient_quota`, `billing`) o
    de autenticación se detiene la corrida sin reintentar, se guardan los
    resultados parciales y se sale con EXIT_ERROR. Los 429 puntuales (RPM/TPM)
    no son cuota: se reintentan con backoff.

Códigos de salida compartidos:
  EXIT_OK (0)     todo bien (o sin umbral configurado)
  EXIT_FAIL (1)   algún caso o modo por debajo del umbral pedido
  EXIT_ERROR (2)  error de infraestructura (Qdrant, red) o cuota de OpenAI
  EXIT_DOC (3)    el documento a escribir contenía un guión largo
"""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

EVALS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = EVALS_DIR.parent
PROJECT_DIR = BACKEND_DIR.parent
RESULTS_ROOT = EVALS_DIR / "results"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ERROR = 2
EXIT_DOC = 3

# El carácter se escribe escapado: el literal está prohibido en el repo.
EM_DASH = "\u2014"

# Valores aceptados por `--retrieval` (entrada de la CLI). El modo EFECTIVO
# que se guarda en los payloads usa el vocabulario del servidor:
# 'hybrid' | 'dense-only' (ver effective_retrieval_mode).
RETRIEVAL_MODES = ("hybrid", "dense")


# --- Tiempo -------------------------------------------------------------------

def now_iso() -> str:
    """Marca de tiempo ISO 8601 en UTC con precisión de segundos."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def timestamp_label() -> str:
    """`YYYYmmdd-HHMMSS` (UTC) para nombrar carpetas de resultados."""
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


# --- Gold sets ------------------------------------------------------------------

@dataclass
class GoldItem:
    """Un caso de evaluación normalizado, venga del gold que venga.

    Mapeo de los campos REALES de cada archivo (todos usan `qid` y `question`):
      - gold_set.json (retrieval): `accept_ids` y `accept_skus` son el criterio
        de acierto; `type`, `source_file`, `ref_sku`, `ref_page`, `ref_product`,
        `brand`, `chunk_id`, `fastpath_eligible` quedan en `raw`.
      - gold_real_world.json y gold_agregacion.json (respuesta): la referencia
        es el texto de `expected`; `ref_skus` NO es criterio de acierto (puede
        incluir el producto equivocado como contexto para el juez), así que se
        deja en `raw` y `accept_skus` queda vacío. `type`, `origen` y
        `augment_with_live_inventory` también quedan en `raw`.
      - `history` (lista de {role, content}) es opcional en cualquier gold;
        ningún archivo actual lo trae, así que por defecto es [].

    `retrieval_target` dice qué referencia sirve para medir retrieval:
    'ids' si hay accept_ids, si no 'skus' si hay accept_skus, si no 'expected'
    si hay texto esperado, si no 'none'.
    """

    id: str
    question: str
    accept_ids: list[str] = field(default_factory=list)
    accept_skus: list[str] = field(default_factory=list)
    expected: str | None = None
    history: list[dict] = field(default_factory=list)
    retrieval_target: str = "none"
    raw: dict = field(default_factory=dict)
    source: str = ""

    @property
    def type(self) -> str:
        return str(self.raw.get("type") or "")

    def reference(self) -> dict:
        """Referencia completa para el payload de resultados."""
        return {
            "retrieval_target": self.retrieval_target,
            "accept_ids": list(self.accept_ids),
            "accept_skus": list(self.accept_skus),
            "expected": self.expected,
        }


def _derive_target(accept_ids: list[str], accept_skus: list[str], expected: str | None) -> str:
    if accept_ids:
        return "ids"
    if accept_skus:
        return "skus"
    if expected:
        return "expected"
    return "none"


def _as_str_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value if str(v).strip()]


def gold_item_from_dict(item: dict, source: str = "") -> GoldItem:
    """Normaliza un dict de cualquier gold a `GoldItem` (ver docstring de la clase)."""
    accept_ids = _as_str_list(item.get("accept_ids"))
    accept_skus = _as_str_list(item.get("accept_skus"))
    expected = item.get("expected")
    expected = str(expected).strip() if expected else None
    history = item.get("history") or []
    if not isinstance(history, list):
        raise ValueError(f"{source}:{item.get('qid')}: `history` debe ser una lista")
    qid = item.get("qid") or item.get("id")
    if not qid:
        raise ValueError(f"{source}: caso sin `qid`: {json.dumps(item)[:120]}")
    question = str(item.get("question") or "").strip()
    if not question:
        raise ValueError(f"{source}:{qid}: caso sin `question`")
    return GoldItem(
        id=str(qid),
        question=question,
        accept_ids=accept_ids,
        accept_skus=accept_skus,
        expected=expected,
        history=[{"role": str(h["role"]), "content": str(h["content"])} for h in history],
        retrieval_target=_derive_target(accept_ids, accept_skus, expected),
        raw=dict(item),
        source=source,
    )


def load_gold_file(path: Path) -> tuple[dict, list[GoldItem]]:
    """Lee un gold (`{"meta": {...}, "questions": [...]}` o una lista pelada)
    y devuelve (meta, items). `source` de cada item es el nombre del archivo."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"No existe el gold set {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        meta, questions = {}, data
    else:
        meta = dict(data.get("meta") or {})
        questions = data.get("questions") or []
    items = [gold_item_from_dict(q, source=path.stem) for q in questions]
    return meta, items


def load_gold(paths: Path | str | Iterable[Path | str]) -> list[GoldItem]:
    """Carga uno o varios gold sets y devuelve todos los casos normalizados,
    en el orden de los archivos. Ids duplicados entre archivos se rechazan."""
    if isinstance(paths, (str, Path)):
        paths = [paths]
    items: list[GoldItem] = []
    seen: dict[str, str] = {}
    for p in paths:
        _, part = load_gold_file(Path(p))
        for it in part:
            if it.id in seen:
                raise ValueError(
                    f"qid duplicado '{it.id}' en {it.source} y {seen[it.id]}"
                )
            seen[it.id] = it.source
        items.extend(part)
    return items


# --- Guión largo y escritura de documentos -----------------------------------

def find_em_dashes(text: str) -> list[int]:
    """Números de línea (desde 1) que contienen U+2014."""
    return [i for i, line in enumerate(text.splitlines(), start=1) if EM_DASH in line]


def ensure_no_em_dash(text: str, what: str = "el documento") -> None:
    """Aborta con EXIT_DOC si `text` contiene un guión largo (regla del repo)."""
    lines = find_em_dashes(text)
    if lines:
        shown = ", ".join(str(n) for n in lines[:10])
        more = f" (y {len(lines) - 10} más)" if len(lines) > 10 else ""
        print(
            f"ERROR: {what} contiene el guión largo (U+2014) en las líneas {shown}{more}. "
            "Está prohibido en cualquier archivo del repo: sustitúyelo por ':' ',' '-' "
            "o paréntesis.",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(EXIT_DOC)


def sanitize(value: Any) -> Any:
    """Sustituye U+2014 por '-' recursivamente en str/list/dict.

    Se aplica a lo que producen los LLM (respuestas del agente, notas del juez)
    antes de guardarlo en results.json o en un informe: la regla de no escribir
    el guión largo cubre todos los archivos, también los de resultados.
    """
    if isinstance(value, str):
        return value.replace(EM_DASH, "-")
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize(v) for v in value)
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    return value


def write_doc(path: Path | str, text: str, force: bool = False) -> Path:
    """Escribe un documento Markdown en UTF-8.

    Aborta con EXIT_DOC si el texto trae un guión largo. Si el archivo ya
    existe y `force` es False lanza FileExistsError: los informes bajo docs/
    solo se sobreescriben con `--write-docs`.
    """
    path = Path(path)
    ensure_no_em_dash(text, what=str(path))
    if path.exists() and not force:
        raise FileExistsError(
            f"{path} ya existe; por defecto los informes van a la carpeta de "
            "resultados. Usa --write-docs para sobreescribir el documento en docs/."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path | str, payload: Any) -> Path:
    """Guarda un payload de resultados (saneado de U+2014) en UTF-8."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(sanitize(payload), ensure_ascii=False, indent=1)
    ensure_no_em_dash(text, what=str(path))
    path.write_text(text, encoding="utf-8")
    return path


# --- Carpeta de resultados ------------------------------------------------------

def results_dir(label: str, forced: Path | str | None = None) -> Path:
    """Crea y devuelve la carpeta de resultados de una corrida.

    Por defecto `backend/evals/results/<YYYYmmdd-HHMMSS>-<label>/` (ruta
    relativa a este archivo, no al cwd; la carpeta results/ está en .gitignore).
    Con `forced` se usa esa ruta tal cual (se crea si no existe).
    """
    if forced is not None:
        path = Path(forced)
        path.mkdir(parents=True, exist_ok=True)
        return path
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in label) or "eval"
    base = RESULTS_ROOT / f"{timestamp_label()}-{safe}"
    path = base
    n = 2
    while path.exists():  # dos corridas en el mismo segundo
        path = base.with_name(f"{base.name}-{n}")
        n += 1
    path.mkdir(parents=True, exist_ok=False)
    return path


# --- Huella del índice ----------------------------------------------------------

def _host_without_credentials(url: str) -> str:
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        return f"{host}:{parts.port}" if parts.port else host
    except Exception:
        return ""


def fingerprint_index(client: Any = None) -> dict:
    """Huella del índice Qdrant contra el que se mide, para que dos corridas
    solo se comparen si el índice era el mismo.

    Devuelve {collection, qdrant_host, qdrant_version, total_points, products,
    by_source_file, chunk_types, taken_at}. Todo sale de counts y facets en
    vivo; nunca incluye la clave de Qdrant. `qdrant_version` es None si
    `client.info()` falla. Los errores de conexión se propagan: sin índice no
    hay medición que valga.
    """
    from qdrant_client import models

    from app.config import get_settings
    from app.services.qdrant import get_client

    settings = get_settings()
    client = client or get_client()
    name = settings.qdrant_collection

    version: str | None = None
    try:
        version = str(client.info().version)
    except Exception:
        version = None

    product_filter = models.Filter(
        must=[
            models.FieldCondition(
                key="chunk_type", match=models.MatchValue(value="product")
            )
        ]
    )
    total = client.count(collection_name=name, exact=True).count
    products = client.count(
        collection_name=name, exact=True, count_filter=product_filter
    ).count

    def _facet(key: str, facet_filter: Any = None) -> dict[str, int]:
        res = client.facet(
            collection_name=name, key=key, facet_filter=facet_filter,
            limit=200, exact=True,
        )
        # count > 0: el facet devuelve valores de puntos ya borrados con 0.
        return {
            str(h.value): int(h.count)
            for h in sorted(res.hits, key=lambda h: str(h.value))
            if str(h.value).strip() and h.count > 0
        }

    return {
        "collection": name,
        "qdrant_host": _host_without_credentials(settings.qdrant_url),
        "qdrant_version": version,
        "total_points": int(total),
        "products": int(products),
        "by_source_file": _facet("source_file", product_filter),
        "chunk_types": _facet("chunk_type"),
        "taken_at": now_iso(),
    }


# --- Modo de retrieval ----------------------------------------------------------

def effective_retrieval_mode() -> str:
    """Modo EFECTIVO con el mismo vocabulario que /api/health y /api/stats.

    Devuelve tal cual `qdrant.retrieval_mode()`: 'hybrid' si el modelo BM25
    cargó (la llamada fuerza la carga perezosa, así que ya no puede decir
    'hybrid' con la carga pendiente) o 'dense-only' en cualquier otro caso.
    Así los payloads de los evals se comparan directamente con el `retrieval`
    que reporta el servidor.
    """
    from app.services import qdrant

    return qdrant.retrieval_mode()


def force_retrieval_mode(mode: str) -> str:
    """Fija el modo de retrieval del proceso y devuelve el modo EFECTIVO.

    `mode` usa el vocabulario de la CLI (`RETRIEVAL_MODES`: 'hybrid'|'dense',
    donde 'dense' es el alias de entrada de 'dense-only'). 'dense' pone
    `app.services.qdrant._bm25_failed = True`: con eso `_get_bm25()` devuelve
    None y `hybrid_search` cae a la rama dense-only (ver qdrant.py). 'hybrid'
    no toca nada; si fastembed no está instalado o falla al cargar, el híbrido
    no es posible: se avisa y se devuelve 'dense-only'. Registrar el valor
    devuelto ('hybrid'|'dense-only') en cada payload de resultados.
    """
    if mode not in RETRIEVAL_MODES:
        raise ValueError(f"modo de retrieval desconocido: {mode!r} (usa hybrid|dense)")
    from app.services import qdrant

    if mode == "dense":
        qdrant._bm25_failed = True
    effective = effective_retrieval_mode()
    if mode == "hybrid" and effective != "hybrid":
        print(
            "AVISO: se pidió retrieval híbrido pero BM25 no está disponible "
            "(fastembed no instalado o falló al cargar); la corrida es DENSA.",
            file=sys.stderr,
            flush=True,
        )
    return effective


# --- Errores de cuota -----------------------------------------------------------

def _quota_text(exc: BaseException) -> bool:
    """True si mensaje, `code` o `body` del error hablan de cuota/facturación."""
    parts = [str(exc), str(getattr(exc, "code", "") or ""), str(getattr(exc, "body", "") or "")]
    blob = " ".join(parts).lower()
    return "insufficient_quota" in blob or "billing" in blob


def is_quota_error(exc: BaseException) -> bool:
    """True si el error es de cuota/facturación/autenticación de OpenAI.

    Regla del usuario: al primer error de cuota se detiene la corrida sin
    reintentar, se guardan los parciales y se sale con EXIT_ERROR.

    Un 429 puntual (`RateLimitError` por RPM/TPM) NO es cuota: el SDK y los
    runners lo reintentan con backoff. Solo cuenta como cuota si el código o
    el cuerpo dicen `insufficient_quota`/`billing`. `AuthenticationError`
    (clave inválida o revocada) siempre corta: reintentar no lo arregla.
    """
    try:
        import openai

        if isinstance(exc, openai.AuthenticationError):
            return True
        if isinstance(exc, openai.RateLimitError):
            return _quota_text(exc)
    except ImportError:  # sin SDK solo queda el texto
        pass
    return _quota_text(exc)


# --- Metadatos de la corrida ----------------------------------------------------

def git_commit() -> str | None:
    """Commit corto del repo, o None si git no está disponible."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def run_metadata() -> dict:
    """Lo que hace falta para saber si dos corridas son comparables."""
    from app.config import get_settings

    s = get_settings()
    return {
        "prompt_version": s.prompt_version,
        "openai_model": s.openai_model,
        "rerank_model_resolved": s.rerank_model_resolved,
        "max_hops": s.max_hops,
        "search_top_k": s.search_top_k,
        "rerank_top_k": s.rerank_top_k,
        "embedding_model": s.embedding_model,
        "python": sys.version.split()[0],
        "git_commit": git_commit(),
        "started_at": now_iso(),
    }


# --- Estadística mínima para --repeat -------------------------------------------

def mean_std(values: Iterable[float]) -> tuple[float, float]:
    """Media y desviación típica muestral (0.0 con menos de dos valores)."""
    vals = [float(v) for v in values]
    if not vals:
        return 0.0, 0.0
    mean = statistics.fmean(vals)
    std = statistics.stdev(vals) if len(vals) >= 2 else 0.0
    return mean, std


def fmt_usd(value: float) -> str:
    """Cifra en USD con su etiqueta obligatoria de estimación."""
    from app.services.telemetry import PRICING_LABEL

    return f"{value:.4f} USD ({PRICING_LABEL})"
