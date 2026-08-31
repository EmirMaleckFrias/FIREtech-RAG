"""Chunking según docs/sintesis_esquema.json.

- Normalización: fracciones Unicode → decimal (size_in), precios → float 2
  decimales con enum price_status (numeric|call|discontinued|missing), flags
  de calidad (duplicate_sku_conflict, typo_source, size_normalized_from_typo,
  bulletin_suspect, price_missing, anomalous_line, brand_inferred).
- Texto embebible bilingüe según la plantilla exacta de la síntesis.
- 1 chunk = 1 fila de producto + chunks family_summary (Aleum por Category,
  Reliable_2 por Category, Reliable_3 por familia normalizada ~16).
- Dedup Notifier: 102 SKUs repetidos → fila más completa (más campos no
  nulos; empate → menor Fila), registrando las source_rows fusionadas.
- GATE DE CONFIDENCIALIDAD: 'COSTO FIRETECH' (Notifier) y 'Unit Cost'
  (Croker) van SOLO al payload (cost_internal_usd, visibility='internal')
  y JAMÁS al campo text. `find_cost_leaks` lo verifica automáticamente.
"""
from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict

from app.ingest.parse import FILE_CONFIGS, NOISE_LABELS, ParsedDoc, ParsedRow

# ---------------------------------------------------------------------------
# Semántica por archivo
# ---------------------------------------------------------------------------
SUPPLIERS = {
    "Catalogo_Aleum.pdf": "ALEUM CO.",
    "Catalogo_Reliable_1.pdf": "RELIABLE",
    "Catalogo_Reliable_2.pdf": "RELIABLE",
    "Catalogo_Reliable_3.pdf": "RELIABLE",
    "Catalogo_Croker__2.pdf": "Croker",
    "Notifier_.pdf": "Notifier by Honeywell",
}

# price_net_usd (Aleum Unit Price, Reliable Net/Net) vs price_list_usd
# (Croker List Price, Notifier PRECIO DE LISTA) — nunca mezclarlos.
PRICE_SEMANTICS = {  # (etiqueta del campo de precio público, 'net'|'list')
    "Catalogo_Aleum.pdf": ("Unit Price", "net"),
    "Catalogo_Reliable_1.pdf": ("Net/Net (USD)", "net"),
    "Catalogo_Reliable_2.pdf": ("Net/Net (USD)", "net"),
    "Catalogo_Reliable_3.pdf": ("Net/Net (USD)", "net"),
    "Catalogo_Croker__2.pdf": ("List Price", "list"),
    "Notifier_.pdf": ("PRECIO DE LISTA July 2026", "list"),
}

# Costos internos CONFIDENCIALES: solo payload, jamás al texto.
INTERNAL_COST_LABELS = {
    "Catalogo_Croker__2.pdf": "Unit Cost",
    "Notifier_.pdf": "COSTO FIRETECH",
}

PRICE_EFFECTIVE_DATES = {
    "Catalogo_Aleum.pdf": "2025-04-28",
    "Catalogo_Reliable_1.pdf": "2026-03-12",
    "Catalogo_Reliable_2.pdf": "2026-03-12",
    "Catalogo_Reliable_3.pdf": "2026-03-12",
    "Catalogo_Croker__2.pdf": "2023-07-15",
    "Notifier_.pdf": "2026-07-01",
}

# Duplicados Aleum con datos contradictorios: conservar AMBAS filas + flag.
ALEUM_CONFLICT_SKUS = {"ALGMT-8250", "ALGMT-8300", "ALGMT-8400"}

# Typos conocidos del origen (flag typo_source; el texto crudo se conserva).
_KNOWN_TYPOS = re.compile(
    r"Superviory|Sprinler|Sprinker|Oulet|mouting", re.IGNORECASE
)

# ---------------------------------------------------------------------------
# Normalización de texto y medidas
# ---------------------------------------------------------------------------
_FRACTION_MAP = {
    "½": " 1/2", "¼": " 1/4", "¾": " 3/4",
    "⅛": " 1/8", "⅜": " 3/8", "⅝": " 5/8", "⅞": " 7/8",
    "⅓": " 1/3", "⅔": " 2/3",
}

# Typo del origen (Reliable_2): pies (′/’) donde son pulgadas ('2′ x 1 1/4″').
_PRIME_TYPO = re.compile(r"(\d)\s*[′’](?=\s*[xX×])")


def _ws(text: str) -> str:
    """Colapsa saltos de línea de envoltura y espacios múltiples."""
    return re.sub(r"\s+", " ", text).strip()


def _norm_fractions(text: str) -> str:
    for k, v in _FRACTION_MAP.items():
        text = text.replace(k, v)
    return re.sub(r"\s+", " ", text).strip()


_SIZE_MIXED = re.compile(r"^(\d+)[ -](\d+)/(\d+)")
_SIZE_FRAC = re.compile(r"^(\d+)/(\d+)")
_SIZE_DEC = re.compile(r"^(\d+(?:\.\d+)?)")


def parse_size_in(size_raw: str | None) -> list[float] | None:
    """'2 x ½' → [2.0, 0.5]; '1-1/4' → [1.25]; '11/2X11/4' → [1.5, 1.25];
    '24"' → [24.0]; 'QUART'/'W14' (no dimensional) → None. Orden del origen."""
    if not size_raw:
        return None
    s = _norm_fractions(size_raw)
    s = s.replace("″", '"').replace("”", '"').replace("×", "x")
    values: list[float] = []
    for part in re.split(r"\s*[xX]\s*", s):
        part = part.strip().strip('"').strip()
        if not part:
            continue
        m = _SIZE_MIXED.match(part)
        if m:
            values.append(int(m[1]) + int(m[2]) / int(m[3]))
            continue
        m = _SIZE_FRAC.match(part)
        if m:
            num, den = int(m[1]), int(m[2])
            if num > den and den in (2, 4, 8, 16) and (num % 10) < den:
                # '11/2' = notación pegada de '1 1/2' (tamaño de tubería real)
                values.append(num // 10 + (num % 10) / den)
            else:
                values.append(num / den)
            continue
        m = _SIZE_DEC.match(part)
        if m:
            values.append(float(m[1]))
            continue
        # parte no numérica ('S', 'T', 'SOC', 'FM HEAD ADPT., LONG') → se ignora
    return [round(v, 4) for v in values] or None


_NUM_RE = re.compile(r"^-?[\d,]+(?:\.\d+)?$")


def parse_price(raw: str | None) -> tuple[float | None, str]:
    """(valor 2 decimales | None, price_status). Nunca castea texto a float."""
    if raw is None or not raw.strip():
        return None, "missing"
    value = raw.strip()
    if _NUM_RE.match(value):
        return round(float(value.replace(",", "")), 2), "numeric"
    low = value.lower()
    if "call" in low:
        return None, "call"
    if "discontinued" in low or "descontinuado" in low:
        return None, "discontinued"
    return None, "missing"


def _parse_float(raw: str | None) -> float | None:
    if not raw:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", raw.replace(",", ""))
    return float(m.group()) if m else None


def _parse_int(raw: str | None) -> int | None:
    v = _parse_float(raw)
    return int(v) if v is not None else None


# ---------------------------------------------------------------------------
# Extracción por regex desde descripciones (lista cerrada de aprobaciones)
# ---------------------------------------------------------------------------
_APPROVAL_PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    ("cULus", re.compile(r"\bcULus\b", re.IGNORECASE)),
    ("ULC", re.compile(r"\bULC\b")),
    ("UL", re.compile(r"\bUL\b")),
    ("FM", re.compile(r"\bFM\b")),
    ("VdS", re.compile(r"\bVdS\b", re.IGNORECASE)),
    ("CE", re.compile(r"\bCE\b")),
    ("CSFM", re.compile(r"\bCSFM\b|California State Fire Marshal", re.IGNORECASE)),
    ("NFPA-13", re.compile(r"\bNFPA[ -]?13\b")),
    ("NFPA-25", re.compile(r"\bNFPA[ -]?25\b")),
)


def extract_approvals(text: str) -> list[str]:
    return [name for name, pat in _APPROVAL_PATTERNS if pat.search(text)]


_K_FACTOR = re.compile(r"\bK[ ]?(\d{1,2}(?:\.\d)?)\b|\b(\d{1,2}(?:\.\d)?)[ ]?K\b")
_PSI = re.compile(r"(\d{2,4})\s*(?:PSI|P\.S\.I\.)", re.IGNORECASE)
# Años imposibles (>2026) o truncados ('August 202') en Bulletin.
_BULLETIN_SUSPECT = re.compile(r"\b20(2[7-9]|3\d)\b|\b20\d$")


def extract_k_factor(text: str) -> float | None:
    m = _K_FACTOR.search(text)
    if not m:
        return None
    return float(m.group(1) or m.group(2))


def extract_psi(text: str) -> int | None:
    m = _PSI.search(text)
    return int(m.group(1)) if m else None


_SERIES_ALEUM = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,7}$")
_SERIES_R1 = re.compile(
    r"\b(F1FR[0-9]+(?:-[0-9]+)?(?:SS|-80SS)?|F1FR-80SS|F1Res|GFR|LT56|SWC|F2|RA\d{4}|W\d{1,2})\b"
)
_SERIES_R2 = re.compile(r"#([A-Z]{2,4}\d*)|\b([A-Z]{2,4}\d)\b")
_SERIES_CROKER = re.compile(r"\bModel\s+([A-Za-z0-9-]+)")


def extract_model_series(file_name: str, f: dict, category_en: str) -> str | None:
    if file_name == "Catalogo_Aleum.pdf":
        parts = [p.strip() for p in category_en.split("/")]
        for part in parts[1:]:
            if _SERIES_ALEUM.match(part):
                return part
        return None
    if file_name == "Catalogo_Reliable_1.pdf":
        text = _ws(f.get("Short Description", "") + " " + f.get("Description", ""))
        m = _SERIES_R1.search(text)
        return m.group(1) if m else None
    if file_name == "Catalogo_Reliable_2.pdf":
        m = _SERIES_R2.search(_ws(f.get("Short Description", "")))
        if m:
            return m.group(1) or m.group(2)
        m = _SERIES_R2.search(_ws(f.get("Description", "")))
        return (m.group(1) or m.group(2)) if m else None
    if file_name == "Catalogo_Reliable_3.pdf":
        return _ws(f.get("Bulletin", "")) or None
    if file_name == "Catalogo_Croker__2.pdf":
        m = _SERIES_CROKER.search(_ws(f.get("Description", "")))
        return m.group(1) if m else None
    return None  # Notifier: demasiado heterogéneo


# ---------------------------------------------------------------------------
# product_type: taxonomía propia unificada (~30 valores)
# ---------------------------------------------------------------------------
_TYPE_RULES: tuple[tuple[str, str], ...] = (
    # (substring en category_en+short_desc lowercased, tipo)
    ("butterfly valve", "butterfly_valve"),
    ("gate valve", "gate_valve"),
    ("os&y", "gate_valve"),
    ("check valve", "check_valve"),
    ("indicator post", "indicator_post"),
    ("testandrain", "drain_valve"),
    ("drain valve", "drain_valve"),
    ("corrosion monitor", "corrosion_monitor"),
    ("mechanical tee", "mechanical_tee"),
    ("escutcheon", "escutcheon"),
    ("cover plate", "cover_plate"),
    ("wrench", "wrench"),
    ("sprinkler connector", "flexible_connector"),
    ("flexible sprinkler", "flexible_connector"),
    ("strap", "hanger"),
    ("hanger", "hanger"),
    ("sprinkler adapter", "adapter"),
    ("sprinkler head", "cpvc_fitting"),
    ("sprinkler", "sprinkler"),
    ("waterflow", "waterflow_switch"),
    ("supervisory", "waterflow_switch"),
    ("tee", "tee"),
    ("cross", "cross"),
    ("elbow", "elbow"),
    ("ell", "elbow"),
    ("bushing", "reducer"),
    ("reducer", "reducer"),
    ("coupling", "coupling"),
    ("flange", "flange"),
    ("nipple", "cpvc_fitting"),
    ("cap dauber", "consumable"),
    ("cement", "consumable"),
    ("sealant", "consumable"),
    ("test plug", "cpvc_fitting"),
    ("cap", "cap"),
    ("adapter", "adapter"),
    ("cabinet", "cabinet"),
    ("enclosure", "cabinet"),
    ("hose reel", "hose_rack"),
    ("hose storage", "hose_rack"),
    ("restricting", "angle_valve"),
    ("valve / angle", "angle_valve"),
    ("angle", "angle_valve"),
    ("hydrant", "hydrant"),
    ("nozzle", "nozzle"),
    ("hose", "hose"),
    ("rack", "hose_rack"),
    ("smoke detector", "detector"),
    ("heat detector", "detector"),
    ("detector", "detector"),
    ("vesda", "detector"),
    ("li-ion tamer", "detector"),
    ("audible/visual", "notification_device"),
    ("notification", "notification_device"),
    ("speaker", "notification_device"),
    ("strobe", "notification_device"),
    ("horn", "notification_device"),
    ("audio", "notification_device"),
    ("led signage", "notification_device"),
    ("onyx controls", "facp_panel"),
    ("inspire controls", "facp_panel"),
    ("conventional controls", "facp_panel"),
    ("firewarden", "facp_panel"),
    ("controls", "facp_panel"),
    ("battery", "battery"),
    ("batteries", "battery"),
    ("power supplies", "power_supply"),
    ("power supply", "power_supply"),
    ("licensing", "license"),
    ("license", "license"),
    ("onyxworks", "software"),
    ("communicator", "communicator"),
    ("noti-fire-net", "network_card"),
    ("network", "network_card"),
    ("door holder", "door_holder"),
    ("pull station", "pull_station_cover"),
    ("wireless", "wireless_device"),
    ("phone", "phone"),
    ("cable", "cable"),
    ("label", "consumable"),
    ("pipe", "pipe_accessory"),
    ("spare", "spare_part"),
    ("replacement", "spare_part"),
    ("device", "module"),
    ("module", "module"),
    ("training", "service"),
)


def _needle_pattern(needle: str) -> re.Pattern:
    """Coincidencia con bordes de palabra (evita 'tee' dentro de 'sTEEl')
    y plural opcional ('cabinet' → 'Cabinets')."""
    pattern = re.escape(needle)
    if needle[-1].isalnum():
        pattern += r"(?:es|s)?\b"
    if needle[0].isalnum():
        pattern = r"\b" + pattern
    return re.compile(pattern)


_TYPE_PATTERNS: tuple[tuple[re.Pattern, str], ...] = tuple(
    (_needle_pattern(needle), ptype) for needle, ptype in _TYPE_RULES
)


def map_product_type(category_en: str | None, short_desc_en: str | None) -> str | None:
    """La categoría es autoritativa; la descripción solo es fallback (evita
    que 'Fire Hose Rack Assemblies' en la descripción reclasifique un 'Rack')."""
    for source in (category_en, short_desc_en):
        if not source:
            continue
        text = source.lower()
        for pattern, ptype in _TYPE_PATTERNS:
            if pattern.search(text):
                return ptype
    return None


# ---------------------------------------------------------------------------
# Marca (brand ≠ archivo)
# ---------------------------------------------------------------------------
_NOTIFIER_BRAND_CANON = {
    "vesda": "VESDA",
    "fire-lite": "Fire-Lite Alarms",
    "fire-lite alarms": "Fire-Lite Alarms",
}

# Inferencia por categoría (flag brand_inferred) para las ~1.850 filas
# Notifier sin campo Brand.
_NOTIFIER_CATEGORY_BRANDS: tuple[tuple[str, str], ...] = (
    ("xtralis", "VESDA"),
    ("vesda", "VESDA"),
    ("system sensor", "System Sensor"),
    ("hyperspike", "HyperSpike"),
    ("li-ion tamer", "Li-ion Tamer"),
    ("stopper pull station", "STI"),
    ("door holders - rsg", "RSG"),
    ("door holders - rixson", "Rixson"),
    ("door holder", "RSG"),
    ("firewarden", "Fire-Lite Alarms"),
)


def resolve_brand(file_name: str, f: dict) -> tuple[str, bool]:
    """(brand, brand_inferred). Nunca derivada del nombre de archivo a ciegas."""
    if file_name == "Catalogo_Aleum.pdf":
        return _ws(f.get("Manufacturer", "")) or "ALEUM CO.", False
    if file_name in ("Catalogo_Reliable_1.pdf", "Catalogo_Reliable_2.pdf",
                     "Catalogo_Reliable_3.pdf"):
        return "Reliable", False
    if file_name == "Catalogo_Croker__2.pdf":
        return _ws(f.get("Manufacturer", "")) or "Croker", False
    # Notifier: campo Brand si existe; si no, inferir por categoría + flag.
    raw = _ws(f.get("Brand", ""))
    if raw:
        return _NOTIFIER_BRAND_CANON.get(raw.lower(), raw), False
    category = _ws(f.get("Category", "")).lower()
    for needle, brand in _NOTIFIER_CATEGORY_BRANDS:
        if needle in category:
            return brand, True
    return "Notifier", True


# ---------------------------------------------------------------------------
# Deduplicación de frases EN/ES entre descripción corta y larga
# ---------------------------------------------------------------------------
def _dedup_long(short: str, long: str) -> str:
    """Frases de la descripción larga no repetidas contra la corta."""
    short_n = _ws(short).lower()
    long_w = _ws(long)
    if not long_w:
        return ""
    # La larga suele empezar repitiendo la corta literal → recortar el prefijo.
    if short_n and long_w.lower().startswith(short_n):
        long_w = long_w[len(short_n):].lstrip(" .,;:-")
    if not long_w:
        return ""
    kept: list[str] = []
    for sentence in re.split(r"(?<=[.;])\s+", long_w):
        s = sentence.strip()
        if not s:
            continue
        s_n = s.lower().rstrip(".;")
        if s_n and short_n and s_n in short_n:
            continue
        if any(s_n == k.lower().rstrip(".;") for k in kept):
            continue
        kept.append(s)
    return " ".join(kept)


# ---------------------------------------------------------------------------
# Construcción del chunk de producto
# ---------------------------------------------------------------------------
def _fmt_price(value: float) -> str:
    return f"{value:.2f}"


def _fmt_num(value: float) -> str:
    return f"{value:g}"


def build_product_chunk(file_name: str, row: ParsedRow) -> dict:
    config = FILE_CONFIGS[file_name]
    noise = set(NOISE_LABELS.get(file_name, ()))
    f = {k: v for k, v in row.fields.items() if k not in noise}

    supplier = SUPPLIERS[file_name]
    price_label, price_kind = PRICE_SEMANTICS[file_name]
    effective_date = PRICE_EFFECTIVE_DATES[file_name]
    flags: list[str] = []

    sku = _ws(f.get("Part Number", ""))
    short_code = _ws(f.get("Short Code", "")) or None

    brand, brand_inferred = resolve_brand(file_name, f)
    if brand_inferred:
        flags.append("brand_inferred")

    # Categorías bilingües (crudas; 44 filas Notifier sin categoría → None).
    if file_name in ("Catalogo_Reliable_1.pdf", "Catalogo_Reliable_2.pdf",
                     "Catalogo_Reliable_3.pdf"):
        category_en = _ws(f.get("Category (English)", "")) or None
        category_es = _ws(f.get("Categoria (Español)", "")) or None
    else:
        category_en = _ws(f.get("Category", "")) or None
        category_es = _ws(f.get("Categoria", "")) or None
    category_path = (
        [p.strip() for p in category_en.split("/") if p.strip()] if category_en else []
    )

    # Descripciones bilingües
    if file_name == "Catalogo_Aleum.pdf":
        short_en = _ws(f.get("Short Description", ""))
        short_es = _ws(f.get("Descripcion Corta (Español)", ""))
        desc_en = _ws(f.get("Description", ""))
        desc_es = _ws(f.get("Descripción (Español)", ""))
    elif file_name == "Notifier_.pdf":
        short_en = _ws(f.get("Short Description", ""))
        short_es = _ws(f.get("Descripcion Corta", ""))
        desc_en = _ws(f.get("Description", ""))
        desc_es = _ws(f.get("Descripcion", ""))
    else:
        short_en = _ws(f.get("Short Description", ""))
        short_es = _ws(f.get("Descripción Corta", ""))
        desc_en = _ws(f.get("Description", ""))
        desc_es = _ws(f.get("Descripción", ""))

    # Typo del origen: pies por pulgadas ('2′ x 1 1/4″') → corregir con flag.
    def _fix_prime(text: str) -> str:
        nonlocal flags
        fixed, n = _PRIME_TYPO.subn(r'\1″', text)
        if n and "size_normalized_from_typo" not in flags:
            flags.append("size_normalized_from_typo")
            if "typo_source" not in flags:
                flags.append("typo_source")
        return fixed

    short_en, short_es = _fix_prime(short_en), _fix_prime(short_es)
    desc_en, desc_es = _fix_prime(desc_en), _fix_prime(desc_es)

    # Reliable_2: short code duplicado al inicio ('21MTTR 21MTTR RASCO...').
    def _dedup_leading_token(text: str) -> str:
        tokens = text.split(" ", 2)
        if len(tokens) >= 2 and tokens[0] == tokens[1]:
            return " ".join(tokens[1:])
        return text

    short_en = _dedup_leading_token(short_en)
    short_es = _dedup_leading_token(short_es)

    # Typos conocidos del origen → flag (el texto crudo se conserva).
    if _KNOWN_TYPOS.search(" ".join((short_en, short_es, desc_en, desc_es,
                                     category_en or "", category_es or ""))):
        if "typo_source" not in flags:
            flags.append("typo_source")

    # Medidas
    size_raw = _ws(f.get("Size", "")) or None
    size_in = parse_size_in(size_raw)

    # Specs numéricas
    weight_lbs = _parse_float(f.get("Weight (lbs)"))
    temp_f = _parse_float(f.get("Temp °F"))
    temp_c = _parse_float(f.get("Temp °C"))
    box_qty = _parse_int(f.get("Box Qty"))
    finish_en = _ws(f.get("Finish", "")) or None
    finish_es = _ws(f.get("Finish (Spanish)", "")) or None
    dimensions = _ws(f.get("Dimensions", "")) or None

    en_blob = " ".join(x for x in (short_en, desc_en, category_en or "") if x)
    k_factor = extract_k_factor(en_blob) if file_name == "Catalogo_Reliable_1.pdf" else None
    pressure_psi = extract_psi(en_blob)
    approvals = extract_approvals(en_blob)

    bulletin = _ws(f.get("Bulletin", "")) or None
    if bulletin and _BULLETIN_SUSPECT.search(bulletin):
        flags.append("bulletin_suspect")

    model_series = extract_model_series(file_name, f, category_en or "")

    # Precios: público (net|list) + costo interno confidencial.
    price_value, price_status = parse_price(f.get(price_label))
    price_net_usd = price_value if price_kind == "net" else None
    price_list_usd = price_value if price_kind == "list" else None
    if price_status == "missing":
        flags.append("price_missing")

    cost_internal_usd = None
    cost_label = INTERNAL_COST_LABELS.get(file_name)
    if cost_label:
        cost_value, cost_status = parse_price(f.get(cost_label))
        if cost_status == "numeric":
            cost_internal_usd = cost_value

    if row.anomalies:
        flags.append("anomalous_line")

    is_active = price_status != "discontinued"

    # --- Texto embebible (plantilla de la síntesis; SIN costo interno) -----
    lines: list[str] = []

    cat_part = " / ".join(x for x in (category_en, category_es) if x)
    seg1 = f"{supplier} — {brand}"
    if cat_part:
        seg1 += f" | {cat_part}"
    ptype = map_product_type(category_en, short_en)
    if ptype:
        seg1 += f" | {ptype}"
    lines.append(seg1)

    seg2 = f"SKU: {sku}"
    if short_code:
        seg2 += f" (Short Code: {short_code})"
    if model_series:
        seg2 += f" | Serie/Modelo: {model_series}"
    if size_raw:
        seg2 += f" | Medida: {size_raw}"
        if size_in:
            seg2 += f" ({' x '.join(_fmt_num(v) for v in size_in)} in)"
    lines.append(seg2)

    shorts = []
    if short_en:
        shorts.append(short_en.rstrip(".") + ".")
    if short_es and _ws(short_es).lower() != _ws(short_en).lower():
        shorts.append(short_es.rstrip(".") + ".")
    if shorts:
        lines.append(" ".join(shorts))

    extra_en = _dedup_long(short_en, desc_en)
    extra_es = _dedup_long(short_es, desc_es)
    if extra_es and extra_es.lower() == extra_en.lower():
        extra_es = ""
    extras = " ".join(x for x in (extra_en, extra_es) if x)
    if extras:
        lines.append(extras)

    specs: list[str] = []
    if finish_en or finish_es:
        specs.append("/".join(x for x in (finish_en, finish_es) if x))
    if temp_f is not None:
        t = f"{_fmt_num(temp_f)}°F"
        if temp_c is not None:
            t += f" ({_fmt_num(temp_c)}°C)"
        specs.append(t)
    if k_factor is not None:
        specs.append(f"K{_fmt_num(k_factor)}")
    if pressure_psi is not None:
        specs.append(f"{pressure_psi} PSI")
    if weight_lbs is not None:
        specs.append(f"{_fmt_num(weight_lbs)} lbs")
    if box_qty is not None:
        specs.append(f"caja de {box_qty}")
    if dimensions:
        specs.append(f"Dimensiones: {dimensions}")
    for label, key in (("Montaje", "Trim Style"),
                       ("Puerta/Marco", "Door & Frame Materials"),
                       ("Estilo de puerta", "Door Style"),
                       ("Vidrio", "Door Glazing")):
        v = _ws(f.get(key, ""))
        if v:
            specs.append(f"{label}: {v}")
    approvals_txt = ", ".join(approvals) if approvals else "no listadas en el catálogo"
    spec_line = ""
    if specs:
        spec_line = "Specs: " + ", ".join(specs) + ". "
    spec_line += f"Aprobaciones: {approvals_txt}."
    if bulletin:
        spec_line += f" Bulletin {bulletin}."
    lines.append(spec_line)

    price_word = "neto" if price_kind == "net" else "de lista"
    if price_status == "numeric" and price_value is not None:
        price_line = (f"Precio {price_word}: {_fmt_price(price_value)} USD "
                      f"(vigencia {effective_date}).")
    elif price_status == "call":
        price_line = ("Precio: CONSULTAR PRECIO (CALL) — no publicado en el "
                      f"catálogo (vigencia {effective_date}).")
    elif price_status == "discontinued":
        price_line = "Estado: DESCONTINUADO — sin precio de lista vigente."
    else:
        price_line = "Precio: no disponible en el catálogo."
    if box_qty is not None:
        price_line += (f" Nota: el precio es unitario aunque se vende por caja "
                       f"de {box_qty} piezas.")
    if sku in ALEUM_CONFLICT_SKUS and file_name == "Catalogo_Aleum.pdf":
        price_line += (" ADVERTENCIA: este SKU aparece duplicado en el catálogo"
                       " con medida y precio distintos; confirmar la variante"
                       " antes de cotizar.")
    lines.append(price_line)

    text = "\n".join(lines)

    product_names = [n for n in (short_en, short_es) if n]
    skus = [sku] + ([short_code] if short_code else [])

    return {
        "id": str(uuid.uuid4()),
        # --- claves de _PAYLOAD_KEYS (todas presentes) ---
        "text": text,
        "source_file": file_name,
        "page": row.page,
        "brand": brand,
        "category": category_en,          # category = category_en
        "skus": skus,
        "product_names": product_names,
        "has_price": price_status == "numeric",
        "chunk_type": "product",
        "supplier": supplier,
        "category_es": category_es,
        "product_type": ptype,
        "model_series": model_series,
        "size_raw": size_raw,
        "approvals": approvals,
        "box_qty": box_qty,
        "price_net_usd": price_net_usd,
        "price_list_usd": price_list_usd,
        "cost_internal_usd": cost_internal_usd,
        "price_status": price_status,
        "price_effective_date": effective_date,
        "currency_assumed": True,
        "is_active": is_active,
        "visibility": "internal" if cost_internal_usd is not None else "public",
        "data_quality_flags": flags,
        "source_row": row.source_row,
        "source_pages": row.source_pages,
        # --- extras no persistidos por qdrant.upsert_chunks (auditoría) ---
        "sku": sku,
        "short_code": short_code,
        "size_in": size_in,
        "currency": "USD",
        "raw_internal_cost": _ws(f.get(cost_label, "")) if cost_label else "",
        "merged_source_rows": [],
    }


# ---------------------------------------------------------------------------
# Dedup Notifier: 102 SKUs repetidos → fila más completa
# ---------------------------------------------------------------------------
def _row_completeness(file_name: str, row: ParsedRow) -> int:
    noise = set(NOISE_LABELS.get(file_name, ()))
    return sum(
        1 for k, v in row.fields.items() if k not in noise and v and v.strip()
    )


def dedup_notifier_rows(file_name: str, rows: list[ParsedRow]) -> tuple[list[ParsedRow], dict[int, list[int]]]:
    """Devuelve (filas deduplicadas, {fila elegida: [filas fusionadas]})."""
    by_sku: dict[str, list[ParsedRow]] = defaultdict(list)
    for row in rows:
        by_sku[_ws(row.fields.get("Part Number", ""))].append(row)

    kept: list[ParsedRow] = []
    merged: dict[int, list[int]] = {}
    for sku, group in by_sku.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        # más campos no nulos; empate → menor Fila
        best = sorted(
            group,
            key=lambda r: (-_row_completeness(file_name, r), r.source_row),
        )[0]
        merged[best.source_row] = sorted(
            r.source_row for r in group if r is not best
        )
        # las páginas de las filas fusionadas se registran para trazabilidad
        pages = sorted({p for r in group for p in r.source_pages})
        best = ParsedRow(
            source_row=best.source_row,
            fields=best.fields,
            page=best.page,
            source_pages=pages,
            anomalies=best.anomalies,
        )
        kept.append(best)
    kept.sort(key=lambda r: r.source_row)
    return kept, merged


# ---------------------------------------------------------------------------
# Chunks family_summary
# ---------------------------------------------------------------------------
# Reliable_3: 26 categorías crudas → 16 familias normalizadas ("por serie").
# Cada regla: (needles con semántica AND, etiqueta EN, etiqueta ES). Las
# alternativas OR se expresan como reglas separadas con la misma etiqueta.
_R3_FAMILY_RULES: tuple[tuple[tuple[str, ...], str, str], ...] = (
    (("strap",), "CPVC Hangers & Straps", "Colgadores y Abrazaderas CPVC"),
    (("band hanger",), "CPVC Hangers & Straps", "Colgadores y Abrazaderas CPVC"),
    (("elbow",), "CPVC Elbows", "Codos CPVC"),
    (("tee", "reducing"), "CPVC Reducing Tees", "Tees Reductoras CPVC"),
    (("sprinkler head",), "Sprinkler Head Tees & Adapters", "Tees y Adaptadores de Cabeza de Rociador"),
    (("sprinkler adapter",), "Sprinkler Adapters", "Adaptadores de Rociador"),
    (("bushing",), "Reducer Bushings", "Bushings Reductores"),
    (("coupling", "reducer"), "CPVC Reducing Couplings", "Acoplamientos Reductores CPVC"),
    (("grooved coupling",), "Grooved Coupling Adapters", "Adaptadores de Acople Ranurado"),
    (("coupling",), "CPVC Couplings", "Acoplamientos CPVC"),
    (("cap dauber",), "Cement & Applicators", "Cemento y Aplicadores"),
    (("cement",), "Cement & Applicators", "Cemento y Aplicadores"),
    (("sealant",), "Thread Sealant", "Sellador de Rosca"),
    (("cap",), "CPVC Caps", "Tapas CPVC"),
    (("cross",), "CPVC Crosses", "Cruces CPVC"),
    (("test plug",), "Test Plugs", "Tapones de Prueba"),
    (("adapter",), "CPVC Adapters", "Adaptadores CPVC"),
    (("tee",), "CPVC Tees", "Tees CPVC"),
)


def _r3_family(category_en: str) -> tuple[str, str]:
    cat = (category_en or "").lower()
    for needles, label_en, label_es in _R3_FAMILY_RULES:
        if all(n in cat for n in needles):
            return label_en, label_es
    return category_en or "Sin categoría", category_en or "Sin categoría"


def _family_price_repr(chunk: dict) -> str:
    if chunk["price_status"] == "numeric":
        value = chunk["price_net_usd"] if chunk["price_net_usd"] is not None else chunk["price_list_usd"]
        return f"{value:.2f} USD"
    if chunk["price_status"] == "call":
        return "CONSULTAR PRECIO"
    if chunk["price_status"] == "discontinued":
        return "DESCONTINUADO"
    return "sin precio"


def build_family_summaries(file_name: str, product_chunks: list[dict]) -> list[dict]:
    """~48 Aleum (por Category), ~22 Reliable_2 (por Category), ~16 Reliable_3
    (por familia normalizada). Tabla compacta medida → SKU → precio."""
    if file_name not in ("Catalogo_Aleum.pdf", "Catalogo_Reliable_2.pdf",
                         "Catalogo_Reliable_3.pdf"):
        return []

    groups: dict[str, list[dict]] = defaultdict(list)
    labels_es: dict[str, str] = {}
    for chunk in product_chunks:
        if file_name == "Catalogo_Reliable_3.pdf":
            label_en, label_es = _r3_family(chunk["category"] or "")
        else:
            label_en = chunk["category"] or "Sin categoría"
            label_es = chunk["category_es"] or label_en
        groups[label_en].append(chunk)
        labels_es.setdefault(label_en, label_es)

    supplier = SUPPLIERS[file_name]
    effective_date = PRICE_EFFECTIVE_DATES[file_name]
    summaries: list[dict] = []
    for label_en in sorted(groups, key=lambda k: min(c["page"] for c in groups[k])):
        members = sorted(
            groups[label_en],
            key=lambda c: (
                (c["size_in"][0] if c.get("size_in") else float("inf")),
                c["size_raw"] or "",
                c["sku"],
            ),
        )
        label_es = labels_es[label_en]
        # serie dominante si es consistente
        series_values = {c["model_series"] for c in members if c["model_series"]}
        series = series_values.pop() if len(series_values) == 1 else None
        brand_values = {c["brand"] for c in members}
        brand = brand_values.pop() if len(brand_values) == 1 else SUPPLIERS[file_name]

        title = f"Familia {series} ({label_en} / {label_es})" if series else \
            f"Familia {label_en} / {label_es}"
        header = (
            f"{supplier} — {title}: serie completa de medidas y precios "
            f"{'netos' if PRICE_SEMANTICS[file_name][1] == 'net' else 'de lista'} "
            f"USD (vigencia {effective_date}):"
        )
        table = [
            f"{c['size_raw'] or '—'} → {c['sku']} → {_family_price_repr(c)}"
            for c in members
        ]
        text = header + "\n" + "\n".join(table)

        pages = sorted({p for c in members for p in c["source_pages"]})
        first_page = min(c["page"] for c in members)
        summaries.append({
            "id": str(uuid.uuid4()),
            "text": text,
            "source_file": file_name,
            "page": first_page,           # primera página de la familia
            "brand": brand,
            "category": label_en if file_name == "Catalogo_Reliable_3.pdf" else (members[0]["category"] or label_en),
            "skus": [c["sku"] for c in members],
            "product_names": [label_en, label_es],
            "has_price": any(c["has_price"] for c in members),
            "chunk_type": "family_summary",
            "supplier": supplier,
            "category_es": label_es,
            "product_type": members[0]["product_type"],
            "model_series": series,
            "size_raw": None,
            "approvals": [],
            "box_qty": None,
            "price_net_usd": None,
            "price_list_usd": None,
            "cost_internal_usd": None,
            "price_status": None,
            "price_effective_date": effective_date,
            "currency_assumed": True,
            "is_active": True,
            "visibility": "public",
            "data_quality_flags": [],
            "source_row": None,
            "source_pages": pages,
            # extras
            "sku": "",
            "short_code": None,
            "size_in": None,
            "currency": "USD",
            "raw_internal_cost": "",
            "merged_source_rows": [],
        })
    return summaries


# ---------------------------------------------------------------------------
# Orquestación por documento
# ---------------------------------------------------------------------------
def build_chunks(doc: ParsedDoc) -> tuple[list[dict], dict]:
    """(chunks producto + family_summary, stats del archivo)."""
    file_name = doc.file_name
    rows = doc.rows

    merged_map: dict[int, list[int]] = {}
    if file_name == "Notifier_.pdf":
        rows, merged_map = dedup_notifier_rows(file_name, rows)

    # Aleum: SKUs duplicados con datos contradictorios → conservar ambas filas.
    dup_conflict_rows: set[int] = set()
    if file_name == "Catalogo_Aleum.pdf":
        sku_counts = Counter(_ws(r.fields.get("Part Number", "")) for r in rows)
        for r in rows:
            sku = _ws(r.fields.get("Part Number", ""))
            if sku_counts[sku] > 1 or sku in ALEUM_CONFLICT_SKUS:
                dup_conflict_rows.add(r.source_row)

    product_chunks: list[dict] = []
    for row in rows:
        chunk = build_product_chunk(file_name, row)
        if row.source_row in dup_conflict_rows:
            chunk["data_quality_flags"].append("duplicate_sku_conflict")
        if row.source_row in merged_map:
            chunk["data_quality_flags"].append("merged_duplicate_rows")
            chunk["merged_source_rows"] = merged_map[row.source_row]
        product_chunks.append(chunk)

    family_chunks = build_family_summaries(file_name, product_chunks)
    chunks = product_chunks + family_chunks

    # --- stats -------------------------------------------------------------
    config = FILE_CONFIGS[file_name]
    noise = set(NOISE_LABELS.get(file_name, ()))
    missing_fields = {
        label: sum(1 for r in rows if not _ws(r.fields.get(label, "")))
        for label in config.labels
        if label not in noise
    }
    missing_fields = {k: v for k, v in missing_fields.items() if v > 0}
    flag_counts = Counter(
        flag for c in product_chunks for flag in c["data_quality_flags"]
    )
    status_counts = Counter(c["price_status"] for c in product_chunks)
    stats = {
        "blocks_parsed": len(doc.rows),
        "expected_blocks": config.expected_blocks,
        "product_chunks": len(product_chunks),
        "family_chunks": len(family_chunks),
        "merged_duplicate_skus": len(merged_map),
        "merged_rows_removed": sum(len(v) for v in merged_map.values()),
        "price_status": dict(status_counts),
        "missing_fields": missing_fields,
        "flags": dict(flag_counts),
        "pages": doc.page_count,
    }
    return chunks, stats


# ---------------------------------------------------------------------------
# GATE de confidencialidad: 0 costos internos en textos embebidos
# ---------------------------------------------------------------------------
_NUM_TOKEN = re.compile(r"\d+(?:\.\d+)?")


def find_cost_leaks(all_chunks: list[dict]) -> list[str]:
    """Escanea TODOS los textos generados; devuelve violaciones (lista vacía
    si el gate pasa).

    (a) Global: ningún token numérico del texto coincide con un valor crudo
        de costo interno de alta precisión (≥3 decimales — imposible en los
        precios públicos, que se imprimen redondeados a 2).
    (b) Por chunk: ningún token numérico del texto equivale (±0.005) a su
        propio costo interno. Excepción documentada: cuando el catálogo trae
        costo == precio público (licencias INSPIRE de Notifier, margen cero),
        el número del texto ES el precio de lista legítimo, no una fuga.
    """
    violations: list[str] = []
    raw_costs: set[str] = set()
    for chunk in all_chunks:
        raw = chunk.get("raw_internal_cost") or ""
        if raw and _NUM_RE.match(raw) and re.search(r"\.\d{3,}$", raw):
            raw_costs.add(raw)

    for chunk in all_chunks:
        text = chunk["text"]
        tokens = set(_NUM_TOKEN.findall(text))

        leaked_raw = tokens & raw_costs
        for token in sorted(leaked_raw):
            violations.append(
                f"{chunk['source_file']} fila {chunk['source_row']}: "
                f"costo interno crudo '{token}' filtrado al texto"
            )

        cost = chunk.get("cost_internal_usd")
        if cost is None:
            continue
        public = chunk.get("price_net_usd")
        if public is None:
            public = chunk.get("price_list_usd")
        if public is not None and abs(public - cost) < 0.005:
            continue  # margen cero: el precio público coincide con el costo
        for token in tokens:
            try:
                value = float(token)
            except ValueError:
                continue
            if abs(value - cost) < 0.005:
                violations.append(
                    f"{chunk['source_file']} fila {chunk['source_row']}: "
                    f"costo interno '{token}' presente en el texto"
                )
                break
    return violations
