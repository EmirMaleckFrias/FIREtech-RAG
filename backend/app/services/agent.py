"""Agente multi-hop con búsqueda de documentos y respuesta final en streaming.

Contrato (SPEC.md):
    async def run_agent(message, history) -> AsyncIterator[AgentEvent]
    AgentEvent.type: "hop" | "sources" | "token" | "final"
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from app.config import get_settings
from app.models import Chunk, SearchFilters, SourceRef
from app.services import telemetry
from app.services.openai_client import get_async_client, openai_semaphore
from app.services.qdrant import (
    GROUP_FIELDS,
    _MAX_GROUPS,
    detect_brand_in_text,
    find_by_skus,
    group_values,
    hybrid_search,
    resolve_brand,
    resolve_supplier,
    scan_by_price,
)
from app.services.reranker import filter_relevant, rerank

logger = logging.getLogger(__name__)

_SNIPPET_LEN = 240

SYSTEM_PROMPT = """\
Eres el asistente de investigación de la empresa. Tu ÚNICA fuente de información \
son los documentos indexados, que consultas con la herramienta `buscar_documentos`.

REGLAS ESTRICTAS DE FIDELIDAD:
1. Responde SOLO con información que aparezca en los resultados de búsqueda de esta \
conversación. Nada de conocimiento externo, suposiciones ni datos inventados.
2. TODA afirmación factual debe llevar su cita con el formato exacto \
[archivo, pág. X], tomando archivo y página del resultado del que proviene el dato.
3. Si algo no aparece en los resultados, dilo explícitamente, por ejemplo: \
"no encuentro X en los documentos". Nunca rellenes huecos con estimaciones.
4. Conserva las unidades, fechas, nombres y denominaciones tal como aparecen en la fuente.
5. Para preguntas comparativas o complejas, divide el problema en búsquedas específicas \
y reúne evidencia independiente antes de responder.
6. Reformula la consulta si los resultados no son útiles y busca en más de un documento \
cuando la pregunta lo requiera.
7. Distingue claramente entre evidencia directa, interpretación y ausencia de evidencia.
8. No inventes citas, no atribuyas una afirmación a una fuente que no la contiene y \
señala contradicciones entre documentos.

10. La conversación previa es SOLO contexto opcional. Cada pregunta nueva puede \
cambiar de tema por completo: trátala como independiente salvo que contenga una \
referencia explícita a lo anterior ("ese modelo", "y el precio de cada uno", "el \
segundo"). Nunca reduzcas el alcance de una pregunta general al tema de la \
conversación, y no respondas desde tus turnos anteriores: consulta de nuevo.
11. Nunca repitas una llamada con parámetros idénticos. Usa el número limitado de \
búsquedas para cubrir todas las partes relevantes de la pregunta.

Responde siempre en español, de forma clara, estructurada y concisa. Nunca uses \
el guion largo (em dash, U+2014) en tus respuestas: separa las ideas con comas, puntos o dos puntos.\
"""

_DOCUMENT_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "buscar_documentos",
        "description": (
            "Busca evidencia en los documentos indexados. Usa semantico para "
            "la consulta en lenguaje natural y los filtros documentales cuando "
            "estén disponibles. Puedes combinar varias búsquedas para responder "
            "preguntas complejas y comparativas."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "semantico": {
                    "type": "string",
                    "description": (
                        "Qué evidencia buscar en los documentos. Formula una "
                        "consulta concreta y autónoma."
                    ),
                },
                "project_id": {
                    "type": "string",
                    "description": "Limita la búsqueda a un proyecto autorizado.",
                },
                "document_id": {
                    "type": "string",
                    "description": "Limita la búsqueda a un documento autorizado.",
                },
                "document_type": {
                    "type": "string",
                    "description": "Tipo de archivo o documento, por ejemplo pdf o research_paper.",
                },
                "language": {
                    "type": "string",
                    "description": "Idioma del documento, por ejemplo es o en.",
                },
                "suplidor": {
                    "type": "string",
                    "description": (
                        "Línea comercial exacta: ALEUM CO., RELIABLE, Croker, "
                        "Notifier by Honeywell (se toleran variantes)."
                    ),
                },
                "marca": {
                    "type": "string",
                    "description": "Marca dentro de un suplidor (VESDA, System Sensor...).",
                },
                "precio_min": {"type": "number"},
                "precio_max": {"type": "number"},
                "ordenar": {
                    "type": "string",
                    "enum": ["precio_asc", "precio_desc"],
                    "description": "Orden por precio real. Obligatorio para superlativos de precio.",
                },
                "agrupar_por": {
                    "type": "string",
                    "enum": ["suplidor", "marca", "archivo"],
                    "description": (
                        "Un resultado por grupo (con ordenar) o el conteo por "
                        "grupo (sin ordenar ni semantico)."
                    ),
                },
                "limite": {"type": "integer", "description": "Resultados (default 8, máx 20)."},
                "por_grupo": {"type": "integer", "description": "Resultados por grupo (default 3, máx 5)."},
            },
        },
    },
}


@dataclass
class AgentEvent:
    """Evento emitido por el agente hacia la capa SSE."""

    type: Literal["hop", "sources", "token", "final"]
    data: dict = field(default_factory=dict)


def _format_results(chunks: list[Chunk]) -> str:
    """Formatea los chunks para devolverlos al modelo como resultado de la tool."""
    if not chunks:
        return "Sin resultados para esta búsqueda. Prueba otra formulación de la consulta."
    parts: list[str] = []
    for i, ch in enumerate(chunks, start=1):
        header = f"--- Resultado {i} --- [{ch.source_file}, pág. {ch.page}] ({ch.brand})"
        parts.append(f"{header}\n{ch.text}")
    return "\n\n".join(parts)


# Tokens con pinta de SKU: ≥4 chars, al menos un dígito y una letra o guion.
# Los falsos positivos (300PSI, NFPA-13) son inocuos: la búsqueda exacta
# simplemente no encuentra nada.
_SKU_TOKEN_RE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9./-]{3,}\b")


def _extract_sku_candidates(query: str) -> list[str]:
    out: list[str] = []
    for tok in _SKU_TOKEN_RE.findall(query):
        has_digit = any(c.isdigit() for c in tok)
        has_alpha_or_dash = any(c.isalpha() or c == "-" for c in tok)
        # SKUs 100% numéricos largos (hallazgo del eval: '7R99000455'-style sin
        # letras no disparaba el fast-path). ≥6 dígitos evita confundir medidas.
        if re.fullmatch(r"\d{6,}", tok):
            out.append(tok)
        # Excluye medidas puras tipo 11/2, 1.25, 2026-03-12.
        elif has_digit and has_alpha_or_dash and not re.fullmatch(
            r"[\d./-]+", tok
        ):
            out.append(tok.upper())
    return list(dict.fromkeys(out))[:6]


async def _execute_search(
    query: str,
    marca: str | None,
    categoria: str | None,
    supplier: str | None = None,
) -> list[Chunk]:
    settings = get_settings()
    marca = resolve_brand(marca)
    filters = SearchFilters(
        brand=marca or None, category=categoria or None, supplier=supplier
    )

    # Fast-path de SKU exacto: si la consulta trae códigos tipo SKU, se
    # recuperan por match exacto en el payload y se garantizan entre los
    # candidatos: una consulta por SKU nunca debe fallar por semántica.
    sku_hits: list[Chunk] = []
    if settings.sku_fastpath:
        tokens = _extract_sku_candidates(query)
        if tokens:
            try:
                sku_hits = await asyncio.to_thread(find_by_skus, tokens, 8)
                for ch in sku_hits:
                    ch.score = 1.0
            except Exception as exc:
                logger.warning("Fast-path de SKU falló: %s", exc)

    try:
        candidates = await hybrid_search(query, filters, settings.search_top_k)
    except Exception:
        # Un fallo transitorio (rate limit, red) no debe costarle el hop al
        # agente: un único reintento tras una pausa corta.
        await asyncio.sleep(3)
        candidates = await hybrid_search(query, filters, settings.search_top_k)
    if not candidates and (marca or categoria):
        # Filtro demasiado estricto (valor que no existe tal cual): reintenta
        # sin filtros antes de devolver "sin resultados".
        candidates = await hybrid_search(query, SearchFilters(), settings.search_top_k)

    seen = {ch.id for ch in sku_hits}
    merged = sku_hits + [c for c in candidates if c.id not in seen]
    ranked = await rerank(query, merged, settings.rerank_top_k)

    # Garantía: un chunk cuyo SKU aparece textual en la consulta no puede ser
    # descartado por el reranker.
    ranked_ids = {ch.id for ch in ranked}
    upper_query = query.upper()
    must_keep = [
        ch for ch in sku_hits
        if ch.id not in ranked_ids
        and any(sku and sku.upper() in upper_query for sku in ch.skus)
    ]
    if must_keep:
        ranked = (must_keep + ranked)[: settings.rerank_top_k]
    return ranked


async def _execute_catalog_query(args: dict) -> tuple[list[Chunk], str]:
    """Ejecuta la consulta de documentos. Devuelve (chunks, texto).

    El enrutamiento vive AQUÍ, en el motor, decidido por los parámetros de la
    consulta (no por reglas del prompt sobre tipos de pregunta): agrupar,
    ordenar y filtrar se ejecutan exactos sobre el payload de Qdrant; lo
    semántico usa el retrieval híbrido + reranker de siempre.
    """
    semantico = str(args.get("semantico") or "").strip() or None
    suplidor = resolve_supplier(args.get("suplidor") or args.get("marca"))
    marca_raw = args.get("marca") or (None if suplidor else args.get("suplidor"))
    precio_min = args.get("precio_min")
    precio_max = args.get("precio_max")
    ordenar = args.get("ordenar") or None
    desc = ordenar == "precio_desc"
    grupo = GROUP_FIELDS.get(str(args.get("agrupar_por") or ""))
    limite = max(1, min(int(args.get("limite") or 8), 20))
    por_grupo = max(1, min(int(args.get("por_grupo") or 3), 5))

    # --- agrupaciones ---
    if grupo:
        valores = await asyncio.to_thread(group_values, grupo)
        if not valores:
            return [], "El índice no devolvió grupos para ese campo."

        # Solo conteos: pregunta sobre el corpus.
        if not ordenar and not semantico:
            lineas = [
                "Conteo REAL por grupo (calculado en vivo; cítalo como "
                "[inventario del índice]):"
            ]
            lineas += [f"- {v['valor']}: {v['chunks']} chunks" for v in valores]
            lineas.append(f"Total de grupos: {len(valores)}")
            return [], "\n".join(lineas)

        recortado = len(valores) > _MAX_GROUPS
        chunks_total: list[Chunk] = []
        secciones: list[str] = []
        for v in valores[:_MAX_GROUPS]:
            if ordenar:
                filas = await asyncio.to_thread(
                    lambda val=v["valor"]: scan_by_price(
                        supplier=suplidor,
                        price_min=precio_min,
                        price_max=precio_max,
                        group_field=grupo,
                        group_value=val,
                        descending=desc,
                        limit=por_grupo,
                    )
                )
            else:
                sf = SearchFilters(
                    supplier=v["valor"] if grupo == "supplier" else suplidor,
                    brand=v["valor"] if grupo == "brand" else None,
                )
                filas = (await hybrid_search(semantico, sf, por_grupo * 3))[:por_grupo]
            if filas:
                chunks_total.extend(filas)
                secciones.append(
                    f"=== GRUPO {v['valor']} ===\n" + _format_results(filas)
                )
            else:
                secciones.append(f"=== GRUPO {v['valor']} ===\nSin resultados.")
        encabezado = (
            f"Resultados por grupo ({'precio ' + ('desc' if desc else 'asc') if ordenar else 'relevancia'}):"
        )
        if recortado:
            encabezado += f" (solo los primeros {_MAX_GROUPS} grupos de {len(valores)})"
        return chunks_total, encabezado + "\n\n" + "\n\n".join(secciones)

    # --- orden por precio, sin agrupación ---
    if ordenar:
        if semantico:
            filas = await _execute_price_search(
                semantico,
                args.get("marca") or args.get("suplidor"),
                "desc" if desc else "asc",
                limite,
            )
        else:
            filas = await asyncio.to_thread(
                lambda: scan_by_price(
                    supplier=suplidor,
                    brand=resolve_brand(marca_raw) if not suplidor else None,
                    price_min=precio_min,
                    price_max=precio_max,
                    descending=desc,
                    limit=limite,
                )
            )
        etiqueta = "descendente" if desc else "ascendente"
        texto = (
            f"Productos ordenados por PRECIO REAL del catálogo ({etiqueta}); "
            f"el #1 es el extremo verdadero del conjunto filtrado:\n\n"
            + _format_results(filas)
        )
        return filas, texto

    # --- semántico puro (con filtros opcionales) ---
    if semantico:
        filas = await _execute_search(
            semantico, marca_raw, None, supplier=suplidor
        )
        return filas, _format_results(filas)

    return [], (
        "Consulta vacía: indica `semantico`, u `ordenar`/`agrupar_por` con "
        "filtros. Ejemplo: ordenar='precio_asc' + agrupar_por='suplidor'."
    )


async def _execute_document_search(args: dict) -> tuple[list[Chunk], str]:
    """Busca evidencia documental sin depender de campos de productos."""
    query = str(args.get("semantico") or "").strip()
    if not query:
        return [], "Falta una consulta semántica para buscar en los documentos."

    settings = get_settings()
    filters = SearchFilters(
        project_id=str(args["project_id"]).strip() if args.get("project_id") else None,
        document_id=str(args["document_id"]).strip() if args.get("document_id") else None,
        document_type=str(args["document_type"]).strip() if args.get("document_type") else None,
        language=str(args["language"]).strip() if args.get("language") else None,
    )
    chunks = await hybrid_search(query, filters, settings.search_top_k)
    ranked = await rerank(query, chunks, settings.rerank_top_k)
    return ranked, _format_results(ranked)


_PRICE_POOL = 120  # candidatos recuperados antes de ordenar por precio


async def _execute_price_search(
    query: str, marca: str | None, orden: str, limite: int
) -> list[Chunk]:
    """Recupera un pool amplio y lo ordena por el PRECIO real del payload.

    A diferencia de _execute_search (similitud + rerank), aquí el orden lo da
    el campo de precio del catálogo: el resultado #1 es el extremo verdadero
    dentro de lo que el pool semántico alcanzó a cubrir.
    """
    limite = max(1, min(int(limite or 10), 20))
    # Orden de resolución del filtro:
    # 1) SUPLIDOR (payload `supplier`): filtro exacto EN QDRANT. Es el único
    #    confiable para "por suplidor": viene del archivo de origen y no
    #    depende de que el pool semántico traiga productos de esa línea
    #    (en producción dense-only, un pool genérico casi no los traía y las
    #    4 consultas por suplidor devolvían el mismo producto).
    # 2) MARCA: post-filtro por término en marca/categoría/texto, tolerante a
    #    los errores de etiquetado del origen (VLF-500 con brand Fire-Lite).
    # Sin fallback silencioso: si el filtro deja el pool vacío, se devuelve
    # vacío y el modelo se entera, en vez de recibir resultados de OTRO
    # suplidor como si fueran los pedidos.
    supplier = resolve_supplier(marca)
    if supplier is not None:
        pool = await hybrid_search(
            query, SearchFilters(supplier=supplier), _PRICE_POOL
        )
    else:
        pool = await hybrid_search(query, SearchFilters(), _PRICE_POOL)
        marca_term = resolve_brand(marca) or detect_brand_in_text(query)
        if marca_term:
            needle = marca_term.lower().split()[0]
            pool = [
                c for c in pool
                if needle in c.brand.lower()
                or needle in c.category.lower()
                or needle in c.text[:220].lower()
            ]

    priced = [
        c for c in pool
        if c.chunk_type == "product" and c.price is not None
        and (c.price_status or "numeric") == "numeric"
    ]
    # Orden por precio PRIMERO y filtro de relevancia binario DESPUÉS: el
    # reranker listwise con 100+ ítems perdía productos válidos de forma no
    # determinista (el juez detectó que "detector VESDA más barato" daba
    # $7,221 en vez del VLF-500 de $3,088.89). Clasificar sí/no por ítem
    # preserva el orden por precio y es fiable: el primero que sobrevive al
    # filtro ES el extremo verdadero del pool.
    priced.sort(key=lambda c: c.price, reverse=(orden == "desc"))
    if len(priced) > limite:
        priced = await filter_relevant(query, priced[:80])
    return priced[:limite]


def _sources_payload(accumulated: dict[str, Chunk]) -> list[dict]:
    return [
        SourceRef(
            source_file=ch.source_file,
            page=ch.page,
            project_id=ch.project_id,
            document_id=ch.document_id,
            section=ch.section,
            language=ch.language,
            document_type=ch.document_type,
            source_pages=ch.source_pages,
            brand=ch.brand,
            snippet=ch.text[:_SNIPPET_LEN],
            score=ch.score,
            skus=ch.skus[:8],
            product_names=[p for p in ch.product_names if p][:2],
            category=ch.category,
            chunk_type=ch.chunk_type,
        ).model_dump()
        for ch in accumulated.values()
    ]


async def run_agent(message: str, history: list[dict]) -> AsyncIterator[AgentEvent]:
    """Loop de tool calling multi-hop + respuesta final en streaming.

    history: [{"role": "user"|"assistant", "content": str}, ...] (mensajes previos
    de la sesión); se antepone a los messages para conversación con contexto.
    """
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY no está configurada. Configura OPENAI_API_KEY en backend/.env"
        )

    client = get_async_client()
    tel = telemetry.current()
    tel.set_meta(prompt_version=settings.prompt_version, model=settings.openai_model)

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend({"role": m["role"], "content": m["content"]} for m in history)
    messages.append({"role": "user", "content": message})

    accumulated: dict[str, Chunk] = {}  # dedup por id, conserva orden de llegada
    hops: list[dict] = []
    hop_count = 0
    # Llamadas ya ejecutadas en esta pregunta: (tool, args canónicos) → visto.
    # Una repetición idéntica no re-ejecuta nada ni consume presupuesto: el
    # patrón degenerado medido en producción quemaba 7 de 8 hops repitiendo
    # la misma búsqueda y acababa en "no pude completar".
    executed_calls: set[tuple[str, str]] = set()
    sources_emitted = False
    # Todo el texto emitido como eventos `token` a lo largo de TODAS las rondas
    # (incluye el preámbulo que el modelo pueda escribir antes de una tool call).
    # El content final persistido se construye de aquí, para que lo streameado
    # y lo guardado en la BD sean idénticos.
    emitted_parts: list[str] = []

    while True:
        force_final = hop_count >= settings.max_hops
        kwargs: dict = {
            "model": settings.openai_model,
            "messages": messages,
            "stream": True,
            # El último chunk del stream trae el `usage` de la ronda (prompt,
            # cacheados, salida, razonamiento) y no trae choices.
            "stream_options": {"include_usage": True},
            "tools": [_DOCUMENT_SEARCH_TOOL],
            # Tras MAX_HOPS tool calls se fuerza la respuesta final.
            "tool_choice": "none" if force_final else "auto",
        }
        if not force_final:
            kwargs["parallel_tool_calls"] = False

        round_t0 = time.perf_counter()
        round_usage = None
        round_model = settings.openai_model
        finish_reason: str | None = None
        content_parts: list[str] = []
        round_emit_started = False
        tool_calls: dict[int, dict] = {}  # index -> {"id", "name", "arguments"}

        # La plaza del semáforo se ocupa durante toda la ronda (request +
        # stream): es lo que de verdad está en vuelo contra el API.
        sem = openai_semaphore()
        await sem.acquire()
        try:
            stream = await client.chat.completions.create(**kwargs)

            async for event in stream:
                if getattr(event, "usage", None) is not None:
                    round_usage = event.usage
                    round_model = getattr(event, "model", None) or round_model
                if not event.choices:
                    continue
                choice = event.choices[0]
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
                delta = choice.delta
                if delta is None:
                    continue

                for tcd in delta.tool_calls or []:
                    entry = tool_calls.setdefault(
                        tcd.index, {"id": "", "name": "", "arguments": ""}
                    )
                    if tcd.id:
                        entry["id"] = tcd.id
                    if tcd.function is not None:
                        if tcd.function.name:
                            entry["name"] = tcd.function.name
                        if tcd.function.arguments:
                            entry["arguments"] += tcd.function.arguments

                if delta.content:
                    content_parts.append(delta.content)
                    # El contenido se emite en vivo aunque la ronda acabe en tool
                    # call (preámbulo): ese texto entra igualmente al content final,
                    # así lo streameado y lo persistido coinciden. Solo se suprime
                    # contenido que llegue DESPUÉS de deltas de tool_calls.
                    if not tool_calls:
                        if not sources_emitted:
                            yield AgentEvent(
                                "sources", {"sources": _sources_payload(accumulated)}
                            )
                            sources_emitted = True
                        if not round_emit_started and emitted_parts:
                            # Separador entre el texto de rondas distintas.
                            yield AgentEvent("token", {"text": "\n\n"})
                            emitted_parts.append("\n\n")
                        round_emit_started = True
                        emitted_parts.append(delta.content)
                        yield AgentEvent("token", {"text": delta.content})
        except Exception as exc:
            # Fallo en la petición o a MITAD del stream: la ronda queda medida
            # igual (ok=False), con el usage que hubiera llegado antes del corte.
            # CancelledError/GeneratorExit son BaseException: no entran aquí.
            tel.record(
                "agente", round_model, round_usage,
                ms=(time.perf_counter() - round_t0) * 1000.0,
                ok=False, note=str(exc)[:160],
            )
            raise
        finally:
            sem.release()

        tel.record(
            "agente", round_model, round_usage,
            ms=(time.perf_counter() - round_t0) * 1000.0,
            finish_reason=finish_reason,
            note=("final forzado" if force_final else
                  f"tool_calls={len(tool_calls)}"),
        )
        if round_usage is None:
            tel.incr("rounds_sin_usage")
        if force_final:
            tel.incr("forced_final")

        if tool_calls and not force_final:
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            messages.append(
                {
                    "role": "assistant",
                    "content": "".join(content_parts) or None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"],
                            },
                        }
                        for tc in ordered
                    ],
                }
            )
            for tc in ordered:
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                call_key = (
                    tc["name"],
                    json.dumps(args, sort_keys=True, ensure_ascii=False),
                )
                if call_key in executed_calls:
                    # Repetición exacta: ni se ejecuta ni cuenta como hop.
                    tel.incr("llamadas_repetidas")
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": (
                                "Esta llamada es IDÉNTICA a una que ya ejecutaste "
                                "en esta pregunta: sus resultados están arriba. "
                                "Cambia los parámetros o responde con lo que ya "
                                "tienes."
                            ),
                        }
                    )
                    continue
                executed_calls.add(call_key)
                hop_count += 1

                partes = []
                if args.get("semantico"):
                    partes.append(str(args["semantico"]))
                if args.get("ordenar"):
                    partes.append(
                        "precio ↓" if args["ordenar"] == "precio_desc" else "precio ↑"
                    )
                if args.get("agrupar_por"):
                    partes.append(f"por {args['agrupar_por']}")
                if args.get("suplidor") or args.get("marca"):
                    partes.append(str(args.get("suplidor") or args.get("marca")))
                hop_label = " · ".join(partes) or message
                hop_info = {"n": hop_count, "query": hop_label}
                hops.append(hop_info)
                yield AgentEvent("hop", hop_info)

                tel.incr("hops")
                hop_t0 = time.perf_counter()
                try:
                    chunks, result_text = await _execute_document_search(args)
                except Exception as exc:  # la búsqueda no debe tumbar el stream
                    logger.warning("%s falló (hop %d): %s", tc["name"], hop_count, exc)
                    tel.incr("hops_con_error")
                    chunks = []
                    result_text = f"Error al ejecutar la búsqueda: {exc}"
                hop_info["ms"] = round((time.perf_counter() - hop_t0) * 1000.0, 1)
                hop_info["resultados"] = len(chunks)
                hop_info["chars"] = len(result_text)

                for ch in chunks:
                    if ch.id not in accumulated:
                        accumulated[ch.id] = ch

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result_text,
                    }
                )
            # Si el modelo emitió texto-preámbulo junto a la tool call, `sources`
            # pudo dispararse antes de tiempo (y con menos fuentes). Se re-emite
            # en la respuesta final; el frontend toma el último evento recibido.
            sources_emitted = False
            continue

        # Respuesta final (sin tool calls, o forzada con tool_choice="none").
        # Persistimos exactamente lo emitido (todas las rondas); si nada llegó a
        # emitirse (orden de deltas atípico), cae al contenido de esta ronda.
        content = "".join(emitted_parts) or "".join(content_parts)
        if not sources_emitted:
            yield AgentEvent("sources", {"sources": _sources_payload(accumulated)})
            sources_emitted = True
        yield AgentEvent(
            "final",
            {
                "content": content,
                "sources": _sources_payload(accumulated),
                "hops": hops,
            },
        )
        return
