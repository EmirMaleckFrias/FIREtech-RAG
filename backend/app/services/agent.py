"""Agente multi-hop con tool calling (buscar_productos) y respuesta final en streaming.

Contrato (SPEC.md):
    async def run_agent(message, history) -> AsyncIterator[AgentEvent]
    AgentEvent.type: "hop" | "sources" | "token" | "final"
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from openai import AsyncOpenAI

from app.config import get_settings
from app.models import Chunk, SearchFilters, SourceRef
from app.services.qdrant import (
    find_by_skus,
    hybrid_search,
    index_inventory,
    resolve_brand,
)
from app.services.reranker import rerank

logger = logging.getLogger(__name__)

_SNIPPET_LEN = 240

SYSTEM_PROMPT = """\
Eres un asistente experto en catálogos de productos de protección contra incendios \
(rociadores/sprinklers, válvulas, accesorios, etc.). Tu ÚNICA fuente de información \
son los catálogos indexados, que consultas con la herramienta `buscar_productos`.

REGLAS ESTRICTAS DE FIDELIDAD:
1. Responde SOLO con información que aparezca en los resultados de búsqueda de esta \
conversación. Nada de conocimiento externo, suposiciones ni datos inventados.
2. TODA afirmación factual (modelo, SKU, precio, dimensión, material, aprobación, \
K-factor, temperatura, etc.) debe llevar su cita con el formato exacto \
[archivo, pág. X], tomando archivo y página del resultado del que proviene el dato.
3. Si algo no aparece en los resultados, dilo explícitamente, por ejemplo: \
"no encuentro X en los catálogos". Nunca rellenes huecos con estimaciones.
4. Precios: indícalos SIEMPRE con su moneda tal como figura en el catálogo y añade \
la advertencia de que son precios de catálogo y pueden variar o estar desactualizados.
5. Copia las unidades y denominaciones textuales del catálogo (pulgadas, mm, GPM, \
psi, bar, K-factor...). NO conviertas unidades.
6. Si la pregunta compara productos o abarca varias marcas/catálogos, haz VARIAS \
búsquedas con consultas distintas y específicas (una por producto, marca o aspecto) \
antes de responder; no respondas una comparación con una sola búsqueda.
7. Reformula la consulta con vocabulario del dominio; si una búsqueda no devuelve \
resultados útiles, intenta otra formulación antes de rendirte.
8. Tienes un número LIMITADO de búsquedas por pregunta: repártelas entre TODOS los \
productos que pide el usuario. Nunca gastes todas las búsquedas en un solo producto \
dejando otros sin buscar: es mejor una búsqueda por producto que cuatro variantes \
del primero.
9. Los catálogos cubren varias marcas complementarias (ALEUM, Reliable/RASCO, \
Croker, AGF, Notifier, System Sensor, VESDA...). Si un producto no aparece bajo la \
marca que el usuario supone, repite la búsqueda SIN mencionar marca: el equivalente \
puede venir de otro fabricante del catálogo (y dilo en la respuesta).

10. Si el usuario pide "el más barato", "mejor precio", "más económico", "más caro" \
o cualquier superlativo de precio, usa OBLIGATORIAMENTE la herramienta \
`buscar_por_precio` (ordena por el precio real del catálogo). NUNCA declares que \
algo es "el mejor precio" o "el más barato" basándote solo en `buscar_productos`: \
si por alguna razón no usaste `buscar_por_precio`, di "el más barato entre lo \
consultado", nunca un superlativo absoluto.

11. Para preguntas sobre el corpus en sí (cuántos catálogos, suplidores, marcas \
o productos hay; qué catálogos o marcas existen) usa la herramienta \
`inventario_del_indice`, que consulta el índice REAL en este momento, y cita \
esos datos como [inventario del índice]. Nunca respondas conteos del corpus \
desde fragmentos de búsqueda.
12. Para "el más barato/mejor precio de CADA suplidor o marca": primero \
`inventario_del_indice` para conocer las marcas existentes, y luego UNA llamada \
a `buscar_por_precio` por cada marca principal usando su nombre exacto.

Responde siempre en español, de forma clara, estructurada y concisa. Nunca uses \
el guion largo (—) en tus respuestas: separa las ideas con comas, puntos o dos puntos.\
"""

_TOOL = {
    "type": "function",
    "function": {
        "name": "buscar_productos",
        "description": (
            "Busca en los catálogos de productos indexados (búsqueda híbrida "
            "semántica + léxica con reranking). Devuelve fragmentos del catálogo "
            "con su archivo, página y marca. Úsala tantas veces como necesites "
            "(consultas distintas y específicas) antes de responder."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Consulta de búsqueda específica, en el idioma del catálogo, "
                        "con términos del dominio (modelo, SKU, K-factor, etc.)."
                    ),
                },
                "marca": {
                    "type": "string",
                    "description": (
                        "Filtro opcional por marca exacta (p. ej. 'Reliable'). "
                        "Omitir para buscar en todas las marcas."
                    ),
                },
                "categoria": {
                    "type": "string",
                    "description": (
                        "Filtro opcional por categoría exacta (p. ej. 'sprinklers'). "
                        "Omitir para buscar en todas las categorías."
                    ),
                },
            },
            "required": ["query"],
        },
    },
}


_PRICE_TOOL = {
    "type": "function",
    "function": {
        "name": "buscar_por_precio",
        "description": (
            "Busca productos y los devuelve ORDENADOS POR PRECIO REAL del catálogo "
            "(no por similitud). Úsala siempre que el usuario pida el más barato, "
            "el mejor precio, el más económico, el más caro o un ranking de precios. "
            "Recupera un pool amplio de candidatos y los ordena por su campo de "
            "precio exacto, así el resultado #1 sí es el extremo verdadero."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Qué producto/categoría buscar (ej. 'detector aspiración "
                        "VESDA completo', 'coupling rígido 2\"')."
                    ),
                },
                "marca": {
                    "type": "string",
                    "description": "Filtro opcional por marca exacta.",
                },
                "orden": {
                    "type": "string",
                    "enum": ["asc", "desc"],
                    "description": "asc = más baratos primero (default), desc = más caros.",
                },
                "limite": {
                    "type": "integer",
                    "description": "Cuántos devolver (default 10, máx 20).",
                },
            },
            "required": ["query"],
        },
    },
}


_INVENTORY_TOOL = {
    "type": "function",
    "function": {
        "name": "inventario_del_indice",
        "description": (
            "Devuelve el inventario REAL del índice en este momento, calculado "
            "en vivo: total de productos, archivos/catálogos indexados, "
            "suplidores y marcas con su cantidad de chunks. Úsala para toda "
            "pregunta sobre el corpus (cuántos catálogos/suplidores/marcas/"
            "productos hay, qué catálogos existen) y para conocer los nombres "
            "exactos de marca antes de iterar búsquedas por marca."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}


def _format_inventory(inv: dict) -> str:
    lines = [
        "Inventario del índice (calculado en vivo; cítalo como [inventario del índice]):",
        f"- Chunks totales: {inv['total_chunks']} | Productos: {inv['productos']}",
        "- Archivos/catálogos indexados:",
    ]
    lines += [f"    {a['valor']} ({a['chunks']} chunks)" for a in inv["archivos"]]
    lines.append("- Suplidores (líneas comerciales):")
    lines += [f"    {s['valor']} ({s['chunks']} chunks)" for s in inv["suplidores"]]
    lines.append("- Marcas (valores exactos para el filtro `marca`):")
    lines += [f"    {m['valor']} ({m['chunks']} chunks)" for m in inv["marcas"]]
    return "\n".join(lines)


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


async def _execute_search(query: str, marca: str | None, categoria: str | None) -> list[Chunk]:
    settings = get_settings()
    marca = resolve_brand(marca)
    filters = SearchFilters(brand=marca or None, category=categoria or None)

    # Fast-path de SKU exacto: si la consulta trae códigos tipo SKU, se
    # recuperan por match exacto en el payload y se garantizan entre los
    # candidatos — una consulta por SKU nunca debe fallar por semántica.
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
    marca_original = marca
    marca = resolve_brand(marca)
    filters = SearchFilters(brand=marca or None, category=None)
    pool = await hybrid_search(query, filters, _PRICE_POOL)
    if not pool and marca_original and not marca:
        # Marca no reconocida: se busca sin filtro, pero el caller lo sabrá
        # porque el propio pool trae las marcas reales en el texto.
        pool = await hybrid_search(query, SearchFilters(), _PRICE_POOL)

    priced = [
        c for c in pool
        if c.chunk_type == "product" and c.price is not None
        and (c.price_status or "numeric") == "numeric"
    ]
    # Filtro de RELEVANCIA antes del orden por precio: sin esto, los N más
    # baratos del pool son siempre accesorios/repuestos ($20-150) y el corte
    # deja fuera al producto barato que sí responde la consulta (caso real:
    # "detector VESDA completo más barato" cortaba el VLF-500 de $3,088).
    if len(priced) > limite:
        keep = min(30, len(priced))
        priced = await rerank(query, priced, keep)
    priced.sort(key=lambda c: c.price, reverse=(orden == "desc"))
    return priced[:limite]


def _sources_payload(accumulated: dict[str, Chunk]) -> list[dict]:
    return [
        SourceRef(
            source_file=ch.source_file,
            page=ch.page,
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

    client = AsyncOpenAI(api_key=settings.openai_api_key)

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend({"role": m["role"], "content": m["content"]} for m in history)
    messages.append({"role": "user", "content": message})

    accumulated: dict[str, Chunk] = {}  # dedup por id, conserva orden de llegada
    hops: list[dict] = []
    hop_count = 0
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
            "tools": [_TOOL, _PRICE_TOOL, _INVENTORY_TOOL],
            # Tras MAX_HOPS tool calls se fuerza la respuesta final.
            "tool_choice": "none" if force_final else "auto",
        }
        if not force_final:
            kwargs["parallel_tool_calls"] = False

        stream = await client.chat.completions.create(**kwargs)

        content_parts: list[str] = []
        round_emit_started = False
        tool_calls: dict[int, dict] = {}  # index -> {"id", "name", "arguments"}

        async for event in stream:
            if not event.choices:
                continue
            delta = event.choices[0].delta
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
                hop_count += 1
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                query = str(args.get("query") or "").strip() or message
                marca = args.get("marca") or None
                is_price_tool = tc["name"] == "buscar_por_precio"
                is_inventory_tool = tc["name"] == "inventario_del_indice"

                if is_inventory_tool:
                    hop_label = "inventario del índice"
                elif is_price_tool:
                    hop_label = f"por precio: {query}"
                else:
                    hop_label = query
                hop_info = {"n": hop_count, "query": hop_label}
                hops.append(hop_info)
                yield AgentEvent("hop", hop_info)

                try:
                    if is_inventory_tool:
                        chunks = []
                        result_text = _format_inventory(
                            await asyncio.to_thread(index_inventory)
                        )
                    elif is_price_tool:
                        orden = args.get("orden") or "asc"
                        limite = args.get("limite") or 10
                        chunks = await _execute_price_search(query, marca, orden, limite)
                        etiqueta = "ascendente" if orden != "desc" else "descendente"
                        result_text = (
                            f"Productos ordenados por PRECIO REAL del catálogo "
                            f"({etiqueta}); el #1 es el extremo dentro del pool "
                            f"consultado:\n\n" + _format_results(chunks)
                        )
                    else:
                        categoria = args.get("categoria") or None
                        chunks = await _execute_search(query, marca, categoria)
                        result_text = _format_results(chunks)
                except Exception as exc:  # la búsqueda no debe tumbar el stream
                    logger.warning("%s falló (hop %d): %s", tc["name"], hop_count, exc)
                    chunks = []
                    result_text = f"Error al ejecutar la búsqueda: {exc}"

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
