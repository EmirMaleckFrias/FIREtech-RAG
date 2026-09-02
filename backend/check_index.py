"""Inspector de SOLO LECTURA del indice Qdrant del RAG de productos.

Uso (desde backend/, con el venv activo):
    python check_index.py [--json] [--source-file NOMBRE] [--collection NOMBRE]
                          [--expect TOTAL,PRODUCT,FAMILY,DOC] [--apply-indexes]

--json           imprime todo el informe como JSON en stdout, sin texto extra.
--source-file    restringe totales, cobertura, facetas, cardinalidades, precio
                 y documentos a ese archivo (los indices son de la coleccion).
--collection     nombre de la coleccion (default: settings.qdrant_collection).
--expect         totales esperados "total,product,family,doc" (p. ej.
                 3573,3483,86,4): exit 1 si lo medido no coincide. Sin el
                 flag solo se informa.
--apply-indexes  UNICA operacion de escritura: crea los indices de payload
                 que falten (nunca borra ni recrea los existentes).

Exit codes: 0 ok; 1 si falla la asercion de facetas o el --expect; 2 si no
conecta con Qdrant o la coleccion no existe.

Todas las cifras salen de counts/facets exactos en el momento de la llamada:
el script no asume nada sobre el contenido del indice.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qdrant_client import QdrantClient, models  # noqa: E402
from qdrant_client.http.exceptions import (  # noqa: E402
    ResponseHandlingException,
    UnexpectedResponse,
)

from app.config import get_settings  # noqa: E402

# Indices de payload que la app necesita (filtros, facets y order_by). Tipo
# keyword salvo el booleano has_price y el float price_usd (orden por precio).
EXPECTED_INDEXES: dict[str, models.PayloadSchemaType] = {
    "brand": models.PayloadSchemaType.KEYWORD,
    "category": models.PayloadSchemaType.KEYWORD,
    "source_file": models.PayloadSchemaType.KEYWORD,
    "has_price": models.PayloadSchemaType.BOOL,
    "skus": models.PayloadSchemaType.KEYWORD,
    "supplier": models.PayloadSchemaType.KEYWORD,
    "chunk_type": models.PayloadSchemaType.KEYWORD,
    "price_usd": models.PayloadSchemaType.FLOAT,
    "price_status": models.PayloadSchemaType.KEYWORD,
}

# Campos del payload cuya cobertura se mide entre productos, con su tipo. Para
# los keyword se cuenta ademas cuantos valen '' exactamente (IsEmpty no los
# considera vacios: solo ausentes, null o lista vacia).
COVERAGE_FIELDS: dict[str, str] = {
    "brand": "keyword",
    "category": "keyword",
    "supplier": "keyword",
    "source_file": "keyword",
    "skus": "keyword",
    "has_price": "bool",
    "price_usd": "float",
    "price_status": "keyword",
    "product_type": "keyword",
    "model_series": "keyword",
    "price_net_usd": "float",
    "price_list_usd": "float",
}

PRODUCT_TYPE = "product"
FAMILY_TYPE = "family_summary"
DOC_TYPES = ("doc_text", "doc_row")

# Facetas de producto: campo -> (limite de valores a listar, mide cardinalidad).
PRODUCT_FACETS: tuple[tuple[str, int, bool], ...] = (
    ("supplier", 1000, False),
    ("brand", 20, False),
    ("source_file", 1000, False),
    ("price_status", 1000, False),
    ("product_type", 20, False),
    ("category", 20, True),
)

CARDINALITY_LIMIT = 1000
SIN_INDICE = "sin indice"


def _force_utf8() -> None:
    """Consola Windows (cp1252) no imprime acentos ni simbolos: forzar UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _safe_host(url: str) -> str:
    """Host de Qdrant sin credenciales, ruta ni query (nunca imprimir claves)."""
    parsed = urlparse(url)
    host = parsed.hostname or url
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return f"{parsed.scheme}://{host}" if parsed.scheme else host


def _is_index_error(exc: Exception) -> bool:
    """Qdrant responde 400 cuando facet/order_by piden un campo sin indice."""
    return isinstance(exc, UnexpectedResponse) and exc.status_code == 400


def _schema_type_name(info: Any) -> str:
    """Nombre del tipo de un PayloadIndexInfo ('keyword', 'float', ...)."""
    data_type = getattr(info, "data_type", info)
    return str(getattr(data_type, "value", data_type))


class Inspector:
    """Recolecta el informe en un dict; el render (texto o JSON) va aparte."""

    def __init__(
        self, client: QdrantClient, collection: str, source_file: str | None
    ) -> None:
        self.client = client
        self.collection = collection
        self.source_file = source_file

    # --- filtros --------------------------------------------------------------
    def _scope(self) -> list[models.Condition]:
        if not self.source_file:
            return []
        return [
            models.FieldCondition(
                key="source_file", match=models.MatchValue(value=self.source_file)
            )
        ]

    def _filter(
        self,
        *conds: models.Condition,
        must_not: list[models.Condition] | None = None,
    ) -> models.Filter:
        return models.Filter(must=[*self._scope(), *conds], must_not=must_not)

    def _product_filter(
        self,
        *conds: models.Condition,
        must_not: list[models.Condition] | None = None,
    ) -> models.Filter:
        return self._filter(
            models.FieldCondition(
                key="chunk_type", match=models.MatchValue(value=PRODUCT_TYPE)
            ),
            *conds,
            must_not=must_not,
        )

    # --- primitivas ------------------------------------------------------------
    def _count(self, flt: models.Filter | None) -> int:
        return self.client.count(
            collection_name=self.collection, count_filter=flt, exact=True
        ).count

    def _facet(
        self, key: str, flt: models.Filter | None, limit: int
    ) -> tuple[list[dict], bool]:
        """Valores con conteo > 0 (sin lapidas) y si se alcanzo el limite."""
        res = self.client.facet(
            collection_name=self.collection,
            key=key,
            facet_filter=flt,
            limit=limit,
            exact=True,
        )
        hits = [
            {"valor": str(h.value), "chunks": h.count}
            for h in res.hits
            if h.count > 0
        ]
        return hits, len(res.hits) >= limit

    # --- secciones ------------------------------------------------------------
    def header(self, server_version: str, environment: str, url: str) -> dict:
        return {
            "qdrant_host": _safe_host(url),
            "coleccion": self.collection,
            "qdrant_version": server_version,
            "environment": environment,
            "fecha_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source_file": self.source_file,
        }

    def totals(self) -> dict:
        total = self._count(self._filter() if self.source_file else None)
        products = self._count(self._product_filter())
        por_tipo: dict[str, int] = {}
        error = None
        try:
            hits, _ = self._facet(
                "chunk_type", self._filter() if self.source_file else None, 1000
            )
            por_tipo = {h["valor"]: h["chunks"] for h in hits}
        except UnexpectedResponse as exc:
            if not _is_index_error(exc):
                raise
            error = SIN_INDICE
        docs = sum(por_tipo.get(t, 0) for t in DOC_TYPES)
        return {
            "total": total,
            "product": products,
            "family_summary": por_tipo.get(FAMILY_TYPE, 0),
            "doc": docs,
            "por_chunk_type": por_tipo,
            "error": error,
        }

    def indexes(self, apply: bool) -> dict:
        existing = self._payload_schema()
        missing = [f for f in EXPECTED_INDEXES if f not in existing]
        applied: list[str] = []
        apply_errors: dict[str, str] = {}
        if apply and missing:
            for field in missing:
                try:
                    self.client.create_payload_index(
                        collection_name=self.collection,
                        field_name=field,
                        field_schema=EXPECTED_INDEXES[field],
                        wait=True,
                    )
                    applied.append(field)
                except Exception as exc:  # se informa y se sigue con el resto
                    apply_errors[field] = str(exc)[:200]
            existing = self._payload_schema()
            missing = [f for f in EXPECTED_INDEXES if f not in existing]
        extra = sorted(f for f in existing if f not in EXPECTED_INDEXES)
        wrong_type = {
            f: {"esperado": EXPECTED_INDEXES[f].value, "actual": existing[f]["tipo"]}
            for f in EXPECTED_INDEXES
            if f in existing and existing[f]["tipo"] != EXPECTED_INDEXES[f].value
        }
        return {
            "existentes": existing,
            "esperados": {f: t.value for f, t in EXPECTED_INDEXES.items()},
            "faltantes": missing,
            "sobrantes": extra,
            "tipo_distinto": wrong_type,
            "aplicados": applied,
            "errores_aplicar": apply_errors,
        }

    def _payload_schema(self) -> dict[str, dict]:
        info = self.client.get_collection(collection_name=self.collection)
        schema = info.payload_schema or {}
        return {
            field: {"tipo": _schema_type_name(idx), "puntos": getattr(idx, "points", None)}
            for field, idx in sorted(schema.items())
        }

    def coverage(self, products: int) -> dict:
        out: dict[str, dict] = {}
        for field, kind in COVERAGE_FIELDS.items():
            row: dict[str, Any] = {"tipo": kind, "total": products}
            try:
                row["vacios"] = self._count(
                    self._product_filter(
                        models.IsEmptyCondition(is_empty=models.PayloadField(key=field))
                    )
                )
                if kind == "keyword":
                    row["cadena_vacia"] = self._count(
                        self._product_filter(
                            models.FieldCondition(
                                key=field, match=models.MatchValue(value="")
                            )
                        )
                    )
                else:
                    row["cadena_vacia"] = 0
                row["cubiertos"] = products - row["vacios"] - row["cadena_vacia"]
                row["porcentaje"] = (
                    round(100.0 * row["cubiertos"] / products, 1) if products else 0.0
                )
            except UnexpectedResponse as exc:
                if not _is_index_error(exc):
                    raise
                row["error"] = SIN_INDICE
            out[field] = row
        return out

    def facets(self, products: int) -> dict:
        out: dict[str, Any] = {"campos": {}}
        for field, limit, with_cardinality in PRODUCT_FACETS:
            row: dict[str, Any] = {"limite": limit}
            try:
                hits, at_limit = self._facet(field, self._product_filter(), limit)
                row["valores"] = hits
                row["suma"] = sum(h["chunks"] for h in hits)
                row["limite_alcanzado"] = at_limit
                if with_cardinality:
                    card, card_limit = self._facet(
                        field, self._product_filter(), CARDINALITY_LIMIT
                    )
                    row["cardinalidad"] = len(card)
                    row["cardinalidad_limite_alcanzado"] = card_limit
            except UnexpectedResponse as exc:
                if not _is_index_error(exc):
                    raise
                row["error"] = SIN_INDICE
            out["campos"][field] = row
        supplier = out["campos"].get("supplier", {})
        suma = supplier.get("suma")
        out["asercion_supplier"] = {
            "suma_facet": suma,
            "count_product": products,
            "ok": suma is not None and suma == products,
        }
        return out

    def cardinalities(self) -> dict:
        out: dict[str, Any] = {}
        for field, kind in COVERAGE_FIELDS.items():
            if kind != "keyword":
                continue
            try:
                hits, at_limit = self._facet(
                    field, self._product_filter(), CARDINALITY_LIMIT
                )
                out[field] = {
                    "distintos": len(hits),
                    "limite": CARDINALITY_LIMIT,
                    "limite_alcanzado": at_limit,
                }
            except UnexpectedResponse as exc:
                if not _is_index_error(exc):
                    raise
                out[field] = {"error": SIN_INDICE}
        return out

    def price(self) -> dict:
        out: dict[str, Any] = {}
        out["con_price_usd"] = self._count(
            self._product_filter(
                must_not=[
                    models.IsEmptyCondition(is_empty=models.PayloadField(key="price_usd"))
                ]
            )
        )
        for label, direction in (
            ("min", models.Direction.ASC),
            ("max", models.Direction.DESC),
        ):
            try:
                points, _ = self.client.scroll(
                    collection_name=self.collection,
                    scroll_filter=self._product_filter(),
                    order_by=models.OrderBy(key="price_usd", direction=direction),
                    limit=1,
                    with_payload=["price_usd", "skus", "source_file", "supplier"],
                )
            except UnexpectedResponse as exc:
                if not _is_index_error(exc):
                    raise
                out[label] = {"error": SIN_INDICE}
                continue
            if not points:
                out[label] = None
                continue
            payload = points[0].payload or {}
            out[label] = {
                "price_usd": payload.get("price_usd"),
                "skus": payload.get("skus") or [],
                "source_file": payload.get("source_file"),
                "supplier": payload.get("supplier"),
            }
        return out

    def documents(self) -> dict:
        flt = self._filter(
            models.FieldCondition(
                key="chunk_type", match=models.MatchAny(any=list(DOC_TYPES))
            )
        )
        out: dict[str, Any] = {"chunk_types": list(DOC_TYPES), "total": self._count(flt)}
        try:
            hits, _ = self._facet("source_file", flt, 1000)
            out["por_source_file"] = {h["valor"]: h["chunks"] for h in hits}
        except UnexpectedResponse as exc:
            if not _is_index_error(exc):
                raise
            out["por_source_file"] = SIN_INDICE
        return out


# ---------------------------------------------------------------------------
# Render en texto
# ---------------------------------------------------------------------------
def _pct(row: dict) -> str:
    return f"{row['cubiertos']}/{row['total']} ({row['porcentaje']:.1f}%)"


def render_text(report: dict) -> str:
    lines: list[str] = []
    h = report["cabecera"]
    lines.append("=" * 72)
    lines.append("INSPECCION DEL INDICE QDRANT (solo lectura)")
    lines.append("=" * 72)
    lines.append(f"Qdrant:      {h['qdrant_host']} (servidor {h['qdrant_version']})")
    lines.append(f"Coleccion:   {h['coleccion']}")
    lines.append(f"Entorno:     {h['environment']}")
    lines.append(f"Fecha UTC:   {h['fecha_utc']}")
    if h.get("source_file"):
        lines.append(f"Alcance:     solo source_file = {h['source_file']}")

    t = report["totales"]
    lines.append("")
    lines.append("-- Totales " + "-" * 61)
    lines.append(f"Puntos totales:   {t['total']}")
    if t.get("error"):
        lines.append(f"Por chunk_type:   {t['error']}")
    for tipo, n in sorted(t["por_chunk_type"].items(), key=lambda kv: -kv[1]):
        lines.append(f"  {tipo:<16} {n}")
    if report.get("expect"):
        e = report["expect"]
        estado = "OK" if e["ok"] else "FALLO"
        lines.append(
            f"--expect:         {estado} (esperado total={e['esperado']['total']} "
            f"product={e['esperado']['product']} family={e['esperado']['family_summary']} "
            f"doc={e['esperado']['doc']}; medido total={t['total']} "
            f"product={t['product']} family={t['family_summary']} doc={t['doc']})"
        )

    ix = report["indices"]
    lines.append("")
    lines.append("-- Indices de payload " + "-" * 50)
    for field, info in ix["existentes"].items():
        marca = "" if field in ix["esperados"] else "  (sobrante)"
        pts = f", {info['puntos']} puntos" if info.get("puntos") is not None else ""
        lines.append(f"  {field:<14} {info['tipo']}{pts}{marca}")
    lines.append(
        "Faltantes:        "
        + (", ".join(f"{f} ({ix['esperados'][f]})" for f in ix["faltantes"]) or "ninguno")
    )
    lines.append("Sobrantes:        " + (", ".join(ix["sobrantes"]) or "ninguno"))
    if ix["tipo_distinto"]:
        for f, d in ix["tipo_distinto"].items():
            lines.append(
                f"Tipo distinto:    {f}: esperado {d['esperado']}, actual {d['actual']}"
            )
    if ix["aplicados"]:
        lines.append("Creados ahora:    " + ", ".join(ix["aplicados"]))
    for f, err in ix["errores_aplicar"].items():
        lines.append(f"Error creando {f}: {err}")

    cov = report["cobertura"]
    lines.append("")
    lines.append("-- Cobertura por campo (chunk_type=product) " + "-" * 28)
    for field, row in cov.items():
        if row.get("error"):
            lines.append(f"  {field:<16} {row['error']}")
            continue
        extra = ""
        if row["tipo"] == "keyword":
            extra = f", vacios {row['vacios']}, '' exacto {row['cadena_vacia']}"
        else:
            extra = f", vacios {row['vacios']}"
        lines.append(f"  {field:<16} {_pct(row)}{extra}")

    fc = report["facetas"]
    lines.append("")
    lines.append("-- Facetas de producto " + "-" * 49)
    for field, row in fc["campos"].items():
        if row.get("error"):
            lines.append(f"[{field}] {row['error']}")
            continue
        titulo = f"[{field}] top {row['limite']}"
        if "cardinalidad" in row:
            tope = " (limite alcanzado)" if row["cardinalidad_limite_alcanzado"] else ""
            titulo += f", cardinalidad total {row['cardinalidad']}{tope}"
        elif row["limite_alcanzado"]:
            titulo += " (limite alcanzado)"
        lines.append(titulo)
        for v in row["valores"]:
            valor = v["valor"] if v["valor"].strip() else "''"
            lines.append(f"  {v['chunks']:>6}  {valor}")
    a = fc["asercion_supplier"]
    estado = "OK" if a["ok"] else "FALLO"
    lines.append(
        f"Asercion suma facet supplier == count(product): {estado} "
        f"({a['suma_facet']} vs {a['count_product']})"
    )

    card = report["cardinalidades"]
    lines.append("")
    lines.append("-- Cardinalidades (valores distintos, productos) " + "-" * 23)
    for field, row in card.items():
        if row.get("error"):
            lines.append(f"  {field:<16} {row['error']}")
        elif row["limite_alcanzado"]:
            lines.append(f"  {field:<16} >= {row['distintos']} (limite {row['limite']} alcanzado)")
        else:
            lines.append(f"  {field:<16} {row['distintos']}")

    pr = report["precio"]
    lines.append("")
    lines.append("-- Precio (price_usd, productos) " + "-" * 39)
    lines.append(f"Productos con price_usd: {pr['con_price_usd']}")
    for label in ("min", "max"):
        row = pr.get(label)
        if row is None:
            lines.append(f"  {label}: sin datos")
        elif row.get("error"):
            lines.append(f"  {label}: {row['error']}")
        else:
            skus = ", ".join(row["skus"]) or "(sin sku)"
            lines.append(
                f"  {label}: {row['price_usd']} USD  {skus}  "
                f"[{row['source_file']}, {row['supplier']}]"
            )

    d = report["documentos"]
    lines.append("")
    lines.append("-- Documentos subidos (chunk_type in doc_text, doc_row) " + "-" * 16)
    lines.append(f"Total: {d['total']}")
    if isinstance(d["por_source_file"], dict):
        for f, n in sorted(d["por_source_file"].items(), key=lambda kv: -kv[1]):
            lines.append(f"  {n:>6}  {f}")
    else:
        lines.append(f"  por source_file: {d['por_source_file']}")

    lines.append("")
    lines.append(f"Exit code: {report['exit_code']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_expect(raw: str | None) -> dict[str, int] | None:
    if raw is None:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        raise argparse.ArgumentTypeError(
            "--expect espera cuatro enteros: total,product,family,doc"
        )
    total, product, family, doc = (int(p) for p in parts)
    return {"total": total, "product": product, "family_summary": family, "doc": doc}


def build_report(args: argparse.Namespace) -> tuple[dict, int]:
    settings = get_settings()
    collection = args.collection or settings.qdrant_collection
    # Cliente propio (misma configuracion que app.services.qdrant.get_client)
    # para no arrastrar la importacion de embeddings/OpenAI/fastembed en un
    # inspector de solo lectura. La version del servidor se imprime aparte,
    # asi que se omite el aviso de compatibilidad del cliente.
    client = QdrantClient(
        url=settings.qdrant_url,
        api_key=settings.qdrant_api_key or None,
        timeout=30,
        check_compatibility=False,
    )
    server_version = client.info().version
    client.get_collection(collection_name=collection)  # 404 si no existe

    insp = Inspector(client, collection, args.source_file)
    report: dict[str, Any] = {
        "cabecera": insp.header(server_version, settings.environment, settings.qdrant_url)
    }
    report["totales"] = insp.totals()
    report["indices"] = insp.indexes(apply=args.apply_indexes)
    products = report["totales"]["product"]
    report["cobertura"] = insp.coverage(products)
    report["facetas"] = insp.facets(products)
    report["cardinalidades"] = insp.cardinalities()
    report["precio"] = insp.price()
    report["documentos"] = insp.documents()

    exit_code = 0
    if not report["facetas"]["asercion_supplier"]["ok"]:
        exit_code = 1
    if args.expect is not None:
        medido = {k: report["totales"][k] for k in args.expect}
        ok = medido == args.expect
        report["expect"] = {"esperado": args.expect, "medido": medido, "ok": ok}
        if not ok:
            exit_code = 1
    report["exit_code"] = exit_code
    return report, exit_code


def main() -> int:
    _force_utf8()
    parser = argparse.ArgumentParser(
        description="Inspector de solo lectura del indice Qdrant"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="imprime el informe completo como JSON en stdout, sin texto extra",
    )
    parser.add_argument(
        "--source-file", metavar="NOMBRE", default=None,
        help="restringe totales, cobertura y facetas a ese archivo",
    )
    parser.add_argument(
        "--collection", metavar="NOMBRE", default=None,
        help="coleccion a inspeccionar (default: settings.qdrant_collection)",
    )
    parser.add_argument(
        "--expect", metavar="TOTAL,PRODUCT,FAMILY,DOC", type=_parse_expect,
        default=None,
        help="totales esperados; exit 1 si lo medido no coincide",
    )
    parser.add_argument(
        "--apply-indexes", action="store_true",
        help="crea SOLO los indices de payload faltantes (unica escritura)",
    )
    args = parser.parse_args()

    try:
        report, exit_code = build_report(args)
    except (ResponseHandlingException, UnexpectedResponse) as exc:
        detalle = str(exc).splitlines()[0][:200]
        print(f"No se pudo consultar Qdrant: {detalle}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_text(report))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
