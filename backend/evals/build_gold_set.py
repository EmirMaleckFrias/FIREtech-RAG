"""Genera el gold set estratificado para la evaluación de retrieval.

Uso (desde backend/ como cwd):
    .venv\\Scripts\\python.exe -X utf8 evals\\build_gold_set.py [--force]

Muestrea chunks REALES de la colección Qdrant (scroll completo), estratificado
por source_file (proporcional, mínimo por archivo) y chunk_type, y produce
~60 preguntas de 3 tipos:

  - sku_directo (20, sin LLM): plantillas en español sobre un SKU real.
  - parafraseo_natural (30, LLM gpt-5.4-mini): pregunta de instalador/comprador
    sobre el producto SIN mencionar SKU ni short code.
  - rango_familia (10): sobre chunks family_summary ("¿qué medidas hay de X?").

Determinista una vez generado: si evals/gold_set.json existe, NO se regenera
salvo --force. El muestreo usa semilla fija; solo el texto de las preguntas de
parafraseo depende del LLM.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

GOLD_PATH = BACKEND_DIR / "evals" / "gold_set.json"

SEED = 20260829
N_SKU = 20
N_PARAPHRASE = 30
N_FAMILY = 10
MIN_PER_FILE = 4  # mínimo de preguntas de producto por archivo
PARAPHRASE_MODEL = "gpt-5.4-mini"
PARAPHRASE_CONCURRENCY = 4

# --- Plantillas (español variado, sin LLM) ----------------------------------

SKU_TEMPLATES = [
    "¿Cuánto cuesta el {sku}?",
    "precio del {sku}",
    "dame las specs del {sku}",
    "¿{sku} disponible?",
    "¿Tienen el {sku} en stock? necesito 20 unidades",
    "ficha técnica del {sku} por favor",
    "cotízame el {sku}",
    "¿qué es el {sku} y qué precio tiene?",
    "info del producto {sku}",
    "¿me pasas precio y disponibilidad de {sku}?",
]

FAMILY_TEMPLATES = [
    "¿Qué medidas hay de {name}?",
    "¿Qué opciones de {name} manejan?",
    "¿En qué tamaños viene {name} de {brand}?",
    "Pásame la lista de medidas y precios de {name}",
    "¿Qué {name} tienen en catálogo y en qué medidas?",
]

# Tokens con pinta de código (igual espíritu que el fast-path del agente):
# sirve para limpiar nombres al armar preguntas que NO deben llevar códigos.
_CODE_TOKEN_RE = re.compile(r"\b(?=[A-Za-z0-9./-]*\d)[A-Z0-9][A-Z0-9./-]{3,}\b")


def _strip_codes(name: str) -> str:
    def _repl(m: re.Match) -> str:
        tok = m.group(0)
        # Conserva medidas/ángulos cortos sin letras (11.25, 22.5, 1-1/2):
        # son parte del nombre del producto, no códigos. (Fix: la versión
        # inicial se comía el "11.25" de "Codo de 11.25°" — ver q036 en
        # docs/EVAL_RETRIEVAL.md.)
        if re.fullmatch(r"[\d./-]+", tok) and len(tok) < 6:
            return tok
        return ""

    cleaned = _CODE_TOKEN_RE.sub(_repl, name)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" ,;-·")
    return cleaned or name


def _mentions_code(question: str, skus: list[str]) -> bool:
    """¿La pregunta menciona alguno de los códigos prohibidos?"""
    up = question.upper()
    for sku in skus:
        if not sku or len(sku) < 3:
            continue
        pattern = r"(?<![A-Z0-9])" + re.escape(sku.upper()) + r"(?![A-Z0-9])"
        if re.search(pattern, up):
            return True
    return False


# --- Muestreo ----------------------------------------------------------------

def scroll_all() -> list[dict]:
    """Trae TODOS los puntos (payload, sin vectores) en orden estable."""
    from app.config import get_settings
    from app.services.qdrant import get_client

    client = get_client()
    name = get_settings().qdrant_collection
    points: list[dict] = []
    offset = None
    while True:
        batch, offset = client.scroll(
            collection_name=name,
            limit=512,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        for p in batch:
            pl = p.payload or {}
            points.append(
                {
                    "id": str(p.id),
                    "text": pl.get("text") or "",
                    "source_file": pl.get("source_file") or "",
                    "page": int(pl.get("page") or 0),
                    "brand": pl.get("brand") or "",
                    "category": pl.get("category") or "",
                    "skus": [s for s in (pl.get("skus") or []) if s],
                    "product_names": pl.get("product_names") or [],
                    "chunk_type": pl.get("chunk_type") or "",
                    "model_series": pl.get("model_series"),
                    "size_raw": pl.get("size_raw"),
                    "price_net_usd": pl.get("price_net_usd"),
                }
            )
        if offset is None:
            break
    # Orden estable e independiente del orden interno del scroll.
    points.sort(key=lambda p: (p["source_file"], p["page"], p["id"]))
    return points


def largest_remainder(weights: dict[str, int], total: int, minimum: int = 0) -> dict[str, int]:
    """Reparte `total` proporcional a `weights` con mínimo por clave."""
    keys = sorted(weights)
    alloc = {k: minimum for k in keys}
    remaining = total - minimum * len(keys)
    if remaining < 0:
        raise ValueError("total insuficiente para el mínimo por archivo")
    wsum = sum(weights.values()) or 1
    raw = {k: remaining * weights[k] / wsum for k in keys}
    for k in keys:
        alloc[k] += int(raw[k])
    left = total - sum(alloc.values())
    for k in sorted(keys, key=lambda k: raw[k] - int(raw[k]), reverse=True):
        if left <= 0:
            break
        alloc[k] += 1
        left -= 1
    return alloc


def pick_diverse(chunks: list[dict], n: int, rng: random.Random) -> list[dict]:
    """Elige n chunks maximizando diversidad de categoría (round-robin)."""
    by_cat: dict[str, list[dict]] = {}
    for ch in chunks:
        by_cat.setdefault(ch["category"], []).append(ch)
    cats = sorted(by_cat)
    rng.shuffle(cats)
    for cat in cats:
        rng.shuffle(by_cat[cat])
    picked: list[dict] = []
    while len(picked) < n and any(by_cat[c] for c in cats):
        for cat in cats:
            if by_cat[cat] and len(picked) < n:
                picked.append(by_cat[cat].pop())
    return picked


# --- Conjuntos de aceptación --------------------------------------------------

def accept_for_sku(ref_sku: str, all_points: list[dict]) -> tuple[list[str], list[str]]:
    """Gold sku_directo: cualquier chunk que contenga ese SKU en `skus`."""
    up = ref_sku.upper()
    ids = [p["id"] for p in all_points if up in {s.upper() for s in p["skus"]}]
    return [ref_sku], ids


def accept_for_paraphrase(chunk: dict, all_points: list[dict]) -> tuple[list[str], list[str]]:
    """Gold parafraseo: chunks cuyo `skus` intersecta con el del original."""
    base = {s.upper() for s in chunk["skus"]}
    ids = [p["id"] for p in all_points if base & {s.upper() for s in p["skus"]}]
    return sorted({s for s in chunk["skus"]}), ids


def accept_for_family(fam: dict, all_points: list[dict]) -> tuple[list[str], list[str]]:
    """Gold familia: el family_summary O productos que compartan
    model_series / categoría (misma marca y archivo) o algún SKU de la familia."""
    accept_skus = {s.upper() for s in fam["skus"]}
    ids = {fam["id"]}
    for p in all_points:
        if p["id"] == fam["id"]:
            continue
        p_skus = {s.upper() for s in p["skus"]}
        same_series = (
            fam["model_series"]
            and p.get("model_series") == fam["model_series"]
            and p["brand"] == fam["brand"]
            and p["source_file"] == fam["source_file"]
        )
        same_category = (
            p["category"] == fam["category"]
            and p["brand"] == fam["brand"]
            and p["source_file"] == fam["source_file"]
        )
        if (p_skus & accept_skus) or same_series or same_category:
            ids.add(p["id"])
            accept_skus |= p_skus
    return sorted(accept_skus), sorted(ids)


# --- Parafraseo con LLM --------------------------------------------------------

_ASPECTS = [
    "el precio",
    "la disponibilidad / si lo manejan",
    "las especificaciones técnicas",
    "una cotización para una obra",
]


async def _paraphrase_one(client, chunk: dict, include_brand: bool, aspect: str, rng_hint: int) -> str:
    """Genera la pregunta natural con gpt-5.4-mini, con validación y reintentos."""
    forbidden = [s for s in chunk["skus"] if s]
    note = ""
    for attempt in range(4):
        user = (
            "Ficha de un producto de un catálogo de protección contra incendios:\n"
            "---\n"
            f"{chunk['text'][:900]}\n"
            "---\n"
            "Escribe UNA sola pregunta corta y natural EN ESPAÑOL, como la que "
            "haría un instalador o comprador de sistemas contra incendio que "
            "busca ESTE producto exacto en un chat de catálogo, preguntando por "
            f"{aspect}.\n"
            "Reglas estrictas:\n"
            f"- PROHIBIDO mencionar códigos de producto: nada de SKU, número de "
            f"parte ni short code (en particular NO uses: {', '.join(forbidden)}).\n"
            "- Describe el producto por lo que ES: tipo de producto + medida"
            " + material/acabado/característica clave si aplica.\n"
            + (
                f"- Menciona la marca ({chunk['brand']}).\n"
                if include_brand
                else "- NO menciones la marca ni el fabricante.\n"
            )
            + "- Tono coloquial de compra, sin comillas, sin explicación: "
            "devuelve SOLO la pregunta.\n" + note
        )
        try:
            resp = await client.chat.completions.create(
                model=PARAPHRASE_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Generas consultas de prueba realistas para un buscador "
                            "de catálogos. Respondes solo con la pregunta pedida."
                        ),
                    },
                    {"role": "user", "content": user},
                ],
            )
        except Exception as exc:  # 429 / red: backoff y reintento
            msg = str(exc)
            transient = "429" in msg or "rate" in msg.lower() or "timeout" in msg.lower()
            if attempt == 3 or not transient:
                raise
            await asyncio.sleep(2.0 * (2**attempt))
            continue
        question = (resp.choices[0].message.content or "").strip().strip('"“”').strip()
        question = question.splitlines()[0].strip() if question else ""
        if len(question) >= 15 and not _mentions_code(question, forbidden):
            return question
        note = (
            "- OJO: tu intento anterior mencionó un código prohibido o fue "
            "demasiado corto. Genera otra pregunta que cumpla TODAS las reglas.\n"
        )
    # Fallback determinista sin LLM (no debería ocurrir casi nunca).
    names = chunk["product_names"] or [chunk["category"]]
    name_es = _strip_codes(names[-1])
    return f"¿Tienen {name_es}? ¿Qué precio tiene?"


async def _paraphrase_all(items: list[tuple[dict, bool, str]]) -> list[str]:
    from openai import AsyncOpenAI

    from app.config import get_settings

    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY no configurada en backend/.env")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    sem = asyncio.Semaphore(PARAPHRASE_CONCURRENCY)

    async def worker(i: int, chunk: dict, include_brand: bool, aspect: str) -> tuple[int, str]:
        async with sem:
            q = await _paraphrase_one(client, chunk, include_brand, aspect, i)
            print(f"  [parafraseo {i + 1}/{len(items)}] {q}", flush=True)
            return i, q

    results = await asyncio.gather(
        *(worker(i, ch, ib, asp) for i, (ch, ib, asp) in enumerate(items))
    )
    return [q for _, q in sorted(results)]


# --- Construcción principal ----------------------------------------------------

def build(force: bool) -> None:
    if GOLD_PATH.exists() and not force:
        print(f"{GOLD_PATH} ya existe; el gold set es determinista una vez generado.")
        print("Usa --force para regenerarlo (las preguntas de parafraseo cambiarán).")
        return

    from app.services.agent import _extract_sku_candidates

    rng = random.Random(SEED)
    print("Escaneando la colección (scroll completo)...", flush=True)
    all_points = scroll_all()
    products = [p for p in all_points if p["chunk_type"] == "product" and p["skus"]]
    families = [p for p in all_points if p["chunk_type"] == "family_summary" and p["skus"]]
    print(f"  {len(all_points)} puntos ({len(products)} product, {len(families)} family_summary)")

    # -- Estratificación de preguntas de producto (sku_directo + parafraseo) --
    prod_by_file: dict[str, list[dict]] = {}
    for p in products:
        prod_by_file.setdefault(p["source_file"], []).append(p)
    file_counts = {f: len(v) for f, v in prod_by_file.items()}
    n_product_qs = N_SKU + N_PARAPHRASE
    alloc = largest_remainder(file_counts, n_product_qs, minimum=MIN_PER_FILE)
    sku_alloc = largest_remainder(
        {f: alloc[f] for f in alloc}, N_SKU, minimum=1 if len(alloc) <= N_SKU else 0
    )
    # sku_alloc no puede superar alloc por archivo:
    for f in sku_alloc:
        sku_alloc[f] = min(sku_alloc[f], alloc[f])
    print("Asignación por archivo (producto):", alloc)
    print("  de las cuales sku_directo:", sku_alloc)

    questions: list[dict] = []
    paraphrase_jobs: list[tuple[dict, bool, str]] = []  # (chunk, include_brand, aspecto)
    paraphrase_meta: list[dict] = []

    sku_tpl_i = 0
    for f in sorted(alloc):
        chosen = pick_diverse(prod_by_file[f], alloc[f], rng)
        n_sku_f = sku_alloc.get(f, 0)
        for j, chunk in enumerate(chosen):
            if j < n_sku_f:
                # ---- sku_directo: plantilla + SKU real (a veces el short code)
                ref_sku = rng.choice(chunk["skus"])
                tpl = SKU_TEMPLATES[sku_tpl_i % len(SKU_TEMPLATES)]
                sku_tpl_i += 1
                q_text = tpl.format(sku=ref_sku)
                accept_skus, accept_ids = accept_for_sku(ref_sku, all_points)
                questions.append(
                    {
                        "type": "sku_directo",
                        "question": q_text,
                        "source_file": f,
                        "chunk_id": chunk["id"],
                        "ref_sku": ref_sku,
                        "ref_page": chunk["page"],
                        "ref_product": (chunk["product_names"] or [chunk["category"]])[0],
                        "brand": chunk["brand"],
                        "accept_skus": accept_skus,
                        "accept_ids": accept_ids,
                    }
                )
            else:
                # ---- parafraseo_natural: se genera con LLM más abajo
                include_brand = rng.random() < 0.5
                aspect = rng.choice(_ASPECTS)
                paraphrase_jobs.append((chunk, include_brand, aspect))
                accept_skus, accept_ids = accept_for_paraphrase(chunk, all_points)
                paraphrase_meta.append(
                    {
                        "type": "parafraseo_natural",
                        "question": None,  # se completa con el LLM
                        "source_file": f,
                        "chunk_id": chunk["id"],
                        "ref_sku": chunk["skus"][0],
                        "ref_page": chunk["page"],
                        "ref_product": (chunk["product_names"] or [chunk["category"]])[0],
                        "brand": chunk["brand"],
                        "accept_skus": accept_skus,
                        "accept_ids": accept_ids,
                        "gen_include_brand": include_brand,
                        "gen_aspect": aspect,
                    }
                )

    # -- rango_familia -------------------------------------------------------
    fam_by_file: dict[str, list[dict]] = {}
    for p in families:
        fam_by_file.setdefault(p["source_file"], []).append(p)
    fam_alloc = largest_remainder(
        {f: len(v) for f, v in fam_by_file.items()}, N_FAMILY, minimum=1
    )
    print("Asignación por archivo (familia):", fam_alloc)
    fam_tpl_i = 0
    for f in sorted(fam_alloc):
        chosen = pick_diverse(fam_by_file[f], fam_alloc[f], rng)
        for fam in chosen:
            names = fam["product_names"] or [fam["category"]]
            name_es = _strip_codes(names[-1])
            tpl = FAMILY_TEMPLATES[fam_tpl_i % len(FAMILY_TEMPLATES)]
            fam_tpl_i += 1
            q_text = tpl.format(name=name_es, brand=fam["brand"])
            accept_skus, accept_ids = accept_for_family(fam, all_points)
            questions.append(
                {
                    "type": "rango_familia",
                    "question": q_text,
                    "source_file": f,
                    "chunk_id": fam["id"],
                    "ref_sku": fam["skus"][0],
                    "ref_page": fam["page"],
                    "ref_product": names[0],
                    "brand": fam["brand"],
                    "accept_skus": accept_skus,
                    "accept_ids": accept_ids,
                }
            )

    # -- Parafraseo con LLM (lo único no determinista del build) --------------
    print(f"Generando {len(paraphrase_jobs)} parafraseos con {PARAPHRASE_MODEL}...", flush=True)
    generated = asyncio.run(_paraphrase_all(paraphrase_jobs))
    for meta, q_text in zip(paraphrase_meta, generated):
        meta["question"] = q_text
        questions.append(meta)

    # -- qid + elegibilidad de fast-path (diagnóstico) -------------------------
    questions.sort(key=lambda q: (q["type"], q["source_file"], q["ref_page"], q["chunk_id"]))
    for i, q in enumerate(questions, start=1):
        q["qid"] = f"q{i:03d}"
        tokens = _extract_sku_candidates(q["question"])
        accept_up = {s.upper() for s in q["accept_skus"]}
        q["fastpath_eligible"] = bool(set(tokens) & accept_up)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": SEED,
        "paraphrase_model": PARAPHRASE_MODEL,
        "total": len(questions),
        "by_type": {
            t: sum(1 for q in questions if q["type"] == t)
            for t in ("sku_directo", "parafraseo_natural", "rango_familia")
        },
        "by_file": {
            f: sum(1 for q in questions if q["source_file"] == f)
            for f in sorted({q["source_file"] for q in questions})
        },
    }
    GOLD_PATH.write_text(
        json.dumps({"meta": meta, "questions": questions}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nGold set escrito en {GOLD_PATH}")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="regenera aunque exista")
    args = parser.parse_args()
    build(force=args.force)


if __name__ == "__main__":
    main()
