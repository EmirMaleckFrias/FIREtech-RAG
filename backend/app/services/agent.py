"""Agente multi-hop con búsqueda de documentos y respuesta final en streaming.

Contrato (SPEC.md):
    async def run_agent(message, history) -> AsyncIterator[AgentEvent]
    AgentEvent.type: "hop" | "sources" | "token" | "final"
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from app.config import get_settings
from app.models import Chunk, SearchFilters, SourceRef
from app.services import telemetry
from app.services.openai_client import get_async_client, openai_semaphore
from app.services.qdrant import hybrid_search
from app.services.reranker import filter_relevant, rerank

logger = logging.getLogger(__name__)

_SNIPPET_LEN = 240

SYSTEM_PROMPT = """\
Eres el asistente de investigación de la empresa. Tu ÚNICA fuente de información \
son los documentos indexados, que consultas con la herramienta `buscar_documentos`.

REGLAS ESTRICTAS DE FIDELIDAD:
1. Responde SOLO con información que aparezca en los resultados de búsqueda de esta \
conversación. Nada de conocimiento externo, suposiciones ni datos inventados.
2. TODA afirmación factual debe llevar su cita. Cada resultado de búsqueda \
trae la suya ya escrita entre corchetes en su cabecera: cópiala LITERAL, sin \
cambiarla. No todos los documentos tienen páginas, así que unas citas dicen \
"pág. 12", otras "sección: Métodos" y otras "fila 30": usa la que traiga el \
resultado y nunca te inventes un número de página.
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
9. La SECCIÓN de la que sale un fragmento cambia su peso, y en un trabajo \
científico eso es decisivo: un dato en Resultados es evidencia del propio \
estudio; el mismo enunciado en Discusión o Conclusiones es interpretación de \
sus autores; en Resumen es una síntesis y en Introducción suele ser una \
afirmación sobre trabajos ajenos. Cuando la distinción importe para la \
respuesta, dila.
10. Los documentos pueden estar en un idioma distinto al de la pregunta. Si una \
búsqueda en español devuelve poco, repítela con los términos técnicos en \
inglés antes de concluir que no hay nada: la coincidencia de palabras solo \
funciona en el idioma del documento.
11. La conversación previa es SOLO contexto opcional. Cada pregunta nueva puede \
cambiar de tema por completo: trátala como independiente salvo que contenga una \
referencia explícita a lo anterior ("ese estudio", "y en la otra cohorte", "el \
segundo"). Nunca reduzcas el alcance de una pregunta general al tema de la \
conversación, y no respondas desde tus turnos anteriores: consulta de nuevo.
12. Nunca repitas una llamada con parámetros idénticos. Usa el número limitado de \
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
            "la consulta en lenguaje natural. Los filtros son OPCIONALES y solo "
            "deben usarse cuando el usuario acota explícitamente (un proyecto, "
            "un documento, un idioma): un filtro con un valor que no existe en "
            "el índice deja la búsqueda sin resultados. Ante la duda, busca sin "
            "filtros. Puedes combinar varias búsquedas para responder preguntas "
            "complejas y comparativas."
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
                    "enum": ["pdf", "docx", "xlsx", "csv", "txt", "md"],
                    "description": (
                        "Extensión del archivo. Es el formato, no el género del "
                        "documento: no existen valores como 'articulo' o 'guia'."
                    ),
                },
                "language": {
                    "type": "string",
                    "enum": ["es", "en", "pt", "fr"],
                    "description": (
                        "Idioma detectado del documento. Un documento cuyo idioma "
                        "no se pudo determinar NO casa con ningún valor, así que "
                        "usa este filtro solo si el usuario pide expresamente "
                        "documentos en un idioma, nunca para traducir tu consulta."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Máximo de fragmentos relevantes, entre 1 y 20.",
                },
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
        # La cita se entrega ya montada para que el modelo la copie literal:
        # cada formato tiene el localizador que de verdad existe en él.
        header = f"--- Resultado {i} --- {ch.cite()}"
        if ch.section and ch.locator() != f"sección: {ch.section}":
            header += f" sección: {ch.section}"
        parts.append(f"{header}\n{ch.text}")
    return "\n\n".join(parts)


async def _execute_document_search(args: dict) -> tuple[list[Chunk], str]:
    """Busca evidencia en los documentos: recupera, reordena y filtra.

    El filtro de relevancia es lo que permite responder "no encuentro esto":
    sin él, la herramienta devuelve siempre los mejores fragmentos que haya,
    aunque hablen de otro tema, y el modelo no tiene forma de distinguir
    "esto es lo que hay" de "esto es lo más parecido que hay".
    """
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
    limit = max(1, min(int(args.get("limit") or settings.rerank_top_k), 20))

    candidatos = await hybrid_search(query, filters, settings.search_top_k)

    # Un filtro exacto sobre un valor que no existe en el índice devuelve cero
    # sin decir por qué, y el modelo concluye que el documento no está. Pasó en
    # producción el 2 sep 2026: cuatro búsquedas con `idioma: es` y `idioma: en`
    # dieron 0 resultados sobre una colección que SÍ tenía el documento, porque
    # `language` estaba vacío en todos los puntos. Así que si los filtros dejan
    # la búsqueda vacía se repite sin ellos y se avisa: recuperar con un aviso
    # es honesto, devolver cero en silencio no.
    aviso_filtros = ""
    aplicados = filters.model_dump(exclude_none=True)
    if not candidatos and aplicados:
        candidatos = await hybrid_search(query, SearchFilters(), settings.search_top_k)
        detalle = ", ".join(f"{k}={v!r}" for k, v in aplicados.items())
        if candidatos:
            aviso_filtros = (
                f"AVISO: con los filtros que pusiste ({detalle}) no había NINGÚN "
                f"fragmento, así que la búsqueda se repitió SIN filtros y esto es "
                f"lo que salió. Esos valores no existen en el índice: no vuelvas a "
                f"usarlos y no concluyas nada de que no dieran resultado.\n\n"
            )
        else:
            return [], (
                f"Sin resultados, ni con los filtros ({detalle}) ni sin ellos. "
                f"El índice no tiene nada parecido a esta consulta."
            )

    if not candidatos:
        return [], (
            "El índice no devolvió ningún fragmento para esta búsqueda. "
            "Prueba otra formulación de la consulta."
        )

    ranked = await rerank(query, candidatos, limit)
    resultado = await filter_relevant(query, ranked)

    if resultado.verificado and not resultado.kept:
        # Se le dice al modelo qué documentos se descartaron. Afirmar "no
        # existe" es una afirmación fuerte, y si el usuario preguntó justo por
        # uno de estos archivos, el modelo tiene que poder darse cuenta en vez
        # de negar su existencia.
        vistos = list(dict.fromkeys(ch.fuente() for ch in ranked))[:5]
        return [], (
            aviso_filtros
            + f"Se revisaron los {len(ranked)} fragmentos más parecidos y ninguno "
            f"contiene información sobre esto. Los documentos de los que salían "
            f"eran: {'; '.join(vistos)}. Si alguno de ellos ES lo que te pidieron, "
            f"vuelve a buscar con sus propias palabras antes de responder; si no, "
            f"di que los documentos indexados no cubren el tema, sin presentarlo "
            f"como un fallo de búsqueda."
        )

    texto = aviso_filtros + _format_results(resultado.kept)
    descartados = len(ranked) - len(resultado.kept)
    if resultado.verificado and descartados:
        texto = (
            f"{aviso_filtros}De los {len(ranked)} fragmentos más parecidos, "
            f"{len(resultado.kept)} aportan evidencia y {descartados} hablaban de "
            f"otra cosa.\n\n" + _format_results(resultado.kept)
        )
    elif not resultado.verificado:
        texto = (
            "AVISO: no se pudo verificar la relevancia de estos fragmentos, así "
            "que puede haber alguno que no venga al caso. Cita solo lo que de "
            "verdad responda a la pregunta.\n\n" + texto
        )
    return resultado.kept, texto


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
            snippet=ch.text[:_SNIPPET_LEN],
            score=ch.score,
            chunk_type=ch.chunk_type,
            title=ch.title,
            citation=ch.citation,
            doi=ch.doi,
            locator=ch.locator(),
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
                for key, label in (
                    ("document_type", "tipo"),
                    ("language", "idioma"),
                    ("project_id", "proyecto"),
                    ("document_id", "documento"),
                ):
                    if args.get(key):
                        partes.append(f"{label}: {args[key]}")
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
