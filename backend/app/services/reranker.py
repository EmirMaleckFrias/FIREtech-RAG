"""Reranking listwise con LLM: un solo request JSON reordena los candidatos.

Ante cualquier fallo (API caída, JSON inválido, ranking malformado) se
mantiene el orden original de Qdrant, cortado a top_k.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

from app.config import get_settings
from app.models import Chunk
from app.services import telemetry
from app.services.openai_client import (
    crear_completion,
    get_async_client,
    openai_slot,
    razonamiento,
)

logger = logging.getLogger(__name__)


async def _json_completion(
    messages: list[dict], note: str, componente: str = "reranker"
) -> dict:
    """Una llamada JSON al modelo de rerank, bajo el semáforo y con usage
    registrado en la telemetría del request.

    `componente` es el nombre bajo el que se agrega en telemetría: `reranker`
    para rerank/filter_relevant y `grader` para el calificador pointwise, que
    hace varias llamadas por pregunta y hay que poder medirlo aparte."""
    settings = get_settings()
    model = settings.rerank_model_resolved
    tel = telemetry.current()
    t0 = time.perf_counter()
    try:
        async with openai_slot():
            resp = await crear_completion(
                get_async_client(),
                {
                    "model": model,
                    "temperature": settings.llm_temperature,
                    "response_format": {"type": "json_object"},
                    "messages": messages,
                    **razonamiento(settings.rerank_reasoning_effort),
                },
            )
    except Exception as exc:
        tel.record(
            componente, model, None, ms=(time.perf_counter() - t0) * 1000.0,
            ok=False, note=f"{note}: {str(exc)[:120]}",
        )
        raise
    choice = resp.choices[0] if resp.choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    tel.record(
        componente, getattr(resp, "model", None) or model, getattr(resp, "usage", None),
        ms=(time.perf_counter() - t0) * 1000.0, ok=bool(content),
        finish_reason=getattr(choice, "finish_reason", None),
        note=note if content else f"{note}: respuesta sin contenido",
    )
    if not content:
        # Sin choices o content None (refusal, content_filter): antes devolvía
        # {} en silencio y el caller creía que el modelo había respondido.
        # Al lanzar, rerank/filter_relevant caen a su fallback con log.
        raise ValueError("respuesta sin contenido")
    return json.loads(content)

_TRUNCATE_CHARS = 600

_SYSTEM_PROMPT = (
    "Eres un reranker de fragmentos de documentos. Recibes una consulta y una "
    "lista de fragmentos numerados. Devuelve SOLO un objeto JSON con la forma "
    '{"ranking": [índices]} donde "ranking" contiene los índices de TODOS '
    "los fragmentos ordenados de mayor a menor relevancia respecto de la "
    "consulta. Ordena por cuánta evidencia aporta el fragmento para responder "
    "la consulta, no por parecido de palabras. No incluyas texto adicional ni "
    "explicaciones."
)

_FILTER_SYSTEM_PROMPT = (
    "Decides qué fragmentos de documentos sirven de evidencia para una "
    "consulta. Recibes la consulta y una lista de fragmentos numerados. "
    'Devuelve SOLO un objeto JSON {"relevantes": [índices]} con los índices '
    "de los fragmentos que contienen información que ayuda a responder la "
    "consulta, aunque sea parcialmente. Incluye el fragmento si aporta un "
    "dato, una definición, una cifra, un método o un resultado sobre el tema "
    "preguntado. Excluye solo los que hablan de otro tema, los que son "
    "índices, portadas, bibliografías o encabezados sin contenido, y los que "
    "se limitan a mencionar el tema de pasada sin decir nada de él. Si "
    "NINGUNO sirve, devuelve la lista vacía: es una respuesta legítima y "
    "necesaria, porque quien pregunta debe poder saber que el índice no tiene "
    "esa información. Ante la duda sobre un fragmento que parece aportar "
    "algo, inclúyelo."
)

# Antes eran 450 caracteres (~28% de un fragmento típico de 1.600): el filtro
# descartaba fragmentos cuya cifra clave estaba al final porque nunca la veía.
# Es el camino de rollback cuando el pipeline de evidencia está apagado, así
# que se sube el corte sin cambiar la forma del prompt. Con 60 candidatos son
# unos 18k tokens de entrada, dentro de lo que el modelo de rerank admite.
_FILTER_TRUNCATE_CHARS = 1200


@dataclass(frozen=True)
class RelevanceOutcome:
    """Resultado del filtro de relevancia, con tres estados distinguibles.

    - `kept` con elementos y `verificado=True`: esos fragmentos sirven.
    - `kept` vacío y `verificado=True`: el modelo dijo que NINGUNO sirve. Es
      información real y hay que pasarla al agente para que responda que no
      encuentra nada, en vez de entregarle fragmentos de otro tema.
    - `verificado=False`: el filtro no se pudo aplicar (API caída, JSON roto).
      `kept` trae los fragmentos sin filtrar y nadie debe concluir nada de
      que no se hayan descartado.
    """

    kept: list[Chunk]
    verificado: bool
    motivo: str


async def filter_relevant(query: str, chunks: list[Chunk]) -> RelevanceOutcome:
    """Filtro binario de relevancia por fragmento.

    A diferencia del ranking listwise, clasificar sí/no por ítem es fiable
    con listas grandes y PRESERVA el orden de entrada en la salida.
    """
    if not chunks:
        return RelevanceOutcome([], True, "sin candidatos")
    if len(chunks) == 1:
        # Con un solo candidato no vale la pena una llamada, pero tampoco se
        # puede afirmar que sea relevante: queda sin verificar.
        return RelevanceOutcome(list(chunks), False, "un solo candidato, no se filtra")

    numbered = "\n".join(
        f"[{i}] {c.text[:_FILTER_TRUNCATE_CHARS]}" for i, c in enumerate(chunks)
    )
    try:
        data = await _json_completion(
            [
                {"role": "system", "content": _FILTER_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"Consulta: {query}\n\nFragmentos:\n{numbered}",
                },
            ],
            note=f"filter_relevant n={len(chunks)}",
        )
        raw = data.get("relevantes")
        if not isinstance(raw, list):
            raise ValueError("respuesta sin lista 'relevantes'")
        keep: set[int] = set()
        for r in raw:
            if isinstance(r, bool):
                continue
            try:
                idx = int(r)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(chunks):
                keep.add(idx)
        return RelevanceOutcome(
            [c for i, c in enumerate(chunks) if i in keep],
            True,
            f"{len(keep)} de {len(chunks)} fragmentos aportan evidencia",
        )
    except Exception as exc:
        logger.warning("filter_relevant falló (%s); se continúa sin filtrar.", exc)
        return RelevanceOutcome(list(chunks), False, f"filtro no aplicado: {exc}")


def _apply_ranking(ranking: object, chunks: list[Chunk]) -> list[Chunk]:
    """Reordena según `ranking`; índices inválidos o duplicados se ignoran y
    los que falten se anexan al final en su orden original."""
    ordered: list[int] = []
    seen: set[int] = set()
    if isinstance(ranking, list):
        for raw in ranking:
            if isinstance(raw, bool):
                continue
            try:
                idx = int(raw)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(chunks) and idx not in seen:
                seen.add(idx)
                ordered.append(idx)
    ordered.extend(i for i in range(len(chunks)) if i not in seen)
    return [chunks[i] for i in ordered]


async def rerank(query: str, chunks: list[Chunk], top_k: int) -> list[Chunk]:
    """Reordena `chunks` por relevancia frente a `query` y corta a `top_k`.

    Un solo request listwise en JSON mode. Si hay top_k o menos candidatos,
    devuelve directo sin llamar al LLM.
    """
    if len(chunks) <= top_k:
        return chunks

    try:
        numbered = "\n\n".join(
            f"[{i}] {chunk.text[:_TRUNCATE_CHARS]}"
            for i, chunk in enumerate(chunks)
        )
        user_prompt = (
            f"Consulta: {query}\n\n"
            f"Fragmentos candidatos ({len(chunks)}):\n{numbered}\n\n"
            'Responde con el JSON {"ranking": [índices en orden de '
            "relevancia descendente]}."
        )

        data = await _json_completion(
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            note=f"rerank n={len(chunks)} top_k={top_k}",
        )
        reordered = _apply_ranking(data.get("ranking"), chunks)
        return reordered[:top_k]
    except Exception as exc:
        logger.warning(
            "Reranker LLM falló (%s); se mantiene el orden de Qdrant.", exc
        )
        return chunks[:top_k]


# --- Calificación por punto del plan ----------------------------------------
#
# Por qué pointwise y con el texto completo: la selección de evidencia pasaba
# por un rerank LISTWISE (permutar 60 fragmentos en un JSON, medido 2/10
# permutaciones distintas a temperatura 0) y por un filtro binario que solo
# veía 450 caracteres de cada fragmento y descartaba los que tenían la cifra
# clave al final. Un juicio por fragmento sobre el texto entero es la salida
# más estable que puede dar un modelo, y con la sección en la cabecera puede
# distinguir un dato de Resultados de una mención de pasada en Introducción.

GRADOS = ("directa", "parcial", "no")

# Tamaño máximo de lote. Por encima, los lotes van en paralelo bajo el
# semáforo de OpenAI y se unen por índice global.
_GRADER_LOTE = 20

_GRADER_SYSTEM_PROMPT = (
    "Eres un evaluador de evidencia para investigación médica. Recibes una "
    "pregunta, la descripción de la evidencia que se necesita para responderla "
    "y una lista de fragmentos numerados de documentos, cada uno con una "
    "cabecera (fuente, sección, tipo, cita) y su texto completo. Juzga CADA "
    "fragmento POR SÍ SOLO, sin compararlo con los demás, y asígnale un grado:\n"
    '- "directa": el fragmento contiene el dato, la cifra, la definición, el '
    "método o el resultado que pide la evidencia necesaria, en la población o "
    "el contexto por el que se pregunta.\n"
    '- "parcial": habla del tema y aporta algo útil, pero sin el dato exacto, o '
    "lo aporta en otra población o contexto, o solo lo interpreta o lo comenta "
    "sin darlo.\n"
    '- "no": trata otro tema, o es portada, índice, bibliografía o cabecera sin '
    "contenido, o menciona el tema de pasada sin decir nada de él.\n"
    "Fíjate en la sección: un dato en Resultados o en una tabla vale como "
    "evidencia; la misma frase en Introducción suele ser contexto de otros "
    'trabajos. Ante la duda entre "parcial" y "no", elige "parcial": que '
    "alguien pierda una cifra por un descarte es peor que un fragmento de más. "
    "Devuelve SOLO un objeto JSON con la forma "
    '{"fragmentos": [{"i": <índice tal como aparece en la cabecera>, '
    '"grado": "directa"|"parcial"|"no", "motivo": "<una frase>"}]} con una '
    "entrada por cada fragmento recibido, usando exactamente el índice de su "
    "cabecera. Sin texto adicional."
)


@dataclass(frozen=True)
class Calificacion:
    """Grado de cada fragmento como evidencia para un punto del plan.

    `grados` va por índice del fragmento en la lista de entrada. Mismos tres
    estados que `RelevanceOutcome`: `verificado=False` significa que el
    calificador no se pudo aplicar (API caída, JSON roto) en al menos un lote
    y NADIE debe concluir nada de un grado ausente. Los grados de los lotes que
    sí respondieron se devuelven igual.
    """

    grados: dict[int, str]
    verificado: bool
    motivo: str


def _cabecera(i: int, ch: Chunk) -> str:
    """Cabecera de un fragmento en el prompt del calificador. El índice es el
    GLOBAL de la lista de entrada aunque el fragmento vaya en el segundo lote:
    así el modelo solo tiene que copiarlo y nadie reindexa nada."""
    tipo = "tabla" if ch.chunk_type == "table" else "texto"
    return (
        f"[{i}] fuente: {ch.fuente()} · seccion: {ch.section or 'desconocida'} "
        f"· tipo: {tipo} · cita: {ch.cite()}"
    )


def _parsear_grados(data: object, offset: int, n: int) -> dict[int, str]:
    """Lee {"fragmentos": [{"i", "grado", ...}]} con la misma tolerancia que
    `_apply_ranking`: entradas que no son objetos, índices fuera de
    [offset, offset+n), booleanos o repetidos y grados fuera de GRADOS se
    ignoran uno a uno. Solo la ausencia de la lista es un fallo del lote."""
    if not isinstance(data, dict):
        raise ValueError("respuesta JSON que no es un objeto")
    raw = data.get("fragmentos")
    if not isinstance(raw, list):
        raise ValueError("respuesta sin lista 'fragmentos'")
    grados: dict[int, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        i, g = item.get("i"), item.get("grado")
        if isinstance(i, bool) or not isinstance(g, str):
            continue
        try:
            idx = int(i)
        except (TypeError, ValueError):
            continue
        grado = g.strip().lower()
        if not (offset <= idx < offset + n) or idx in grados or grado not in GRADOS:
            continue
        grados[idx] = grado
    return grados


async def _calificar_lote(
    query: str,
    evidence_needed: str,
    lote: list[Chunk],
    offset: int,
    n_total: int,
    k: int,
    n_lotes: int,
) -> dict[int, str]:
    """Una llamada por lote. Devuelve grados ya en índice global."""
    fragmentos = "\n\n".join(
        f"{_cabecera(offset + j, ch)}\n{ch.text}" for j, ch in enumerate(lote)
    )
    user_prompt = (
        f"Pregunta: {query}\n"
        f"Evidencia necesaria: {evidence_needed}\n\n"
        f"Fragmentos ({len(lote)}, índices {offset} a {offset + len(lote) - 1}):\n\n"
        f"{fragmentos}\n\n"
        'Responde con el JSON {"fragmentos": [{"i": índice, "grado": '
        '"directa"|"parcial"|"no", "motivo": "..."}]}, una entrada por '
        "fragmento."
    )
    data = await _json_completion(
        [
            {"role": "system", "content": _GRADER_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        note=f"calificar n={n_total} lote={k + 1}/{n_lotes}",
        componente="grader",
    )
    return _parsear_grados(data, offset, len(lote))


async def calificar_evidencia(
    query: str, evidence_needed: str, chunks: list[Chunk]
) -> Calificacion:
    """Califica cada fragmento COMPLETO como evidencia directa, parcial o no.

    Pointwise: cada fragmento se juzga por sí solo frente a `query` con el
    objetivo `evidence_needed`, con cabecera fuente/sección/tipo/cita y el
    texto sin truncar. Más de `_GRADER_LOTE` fragmentos se parten en lotes
    que corren en paralelo (cada llamada ocupa su plaza del semáforo). Un lote
    caído no tumba los demás: sus índices quedan sin grado y `verificado`
    pasa a False con el recuento en `motivo`.
    """
    if not chunks:
        return Calificacion({}, True, "sin candidatos")

    lotes = [chunks[i : i + _GRADER_LOTE] for i in range(0, len(chunks), _GRADER_LOTE)]
    resultados = await asyncio.gather(
        *(
            _calificar_lote(
                query, evidence_needed, lote, k * _GRADER_LOTE, len(chunks), k, len(lotes)
            )
            for k, lote in enumerate(lotes)
        ),
        return_exceptions=True,
    )

    grados: dict[int, str] = {}
    fallidos = 0
    for k, r in enumerate(resultados):
        if isinstance(r, BaseException):
            if not isinstance(r, Exception):
                # CancelledError y compañía no son un fallo del lote: se propagan.
                raise r
            fallidos += 1
            logger.warning(
                "calificar_evidencia: lote %d/%d falló (%s); sus fragmentos quedan sin calificar.",
                k + 1, len(lotes), r,
            )
            continue
        grados.update(r)
    # Orden estable por índice: gather ya respeta el orden de los lotes, pero
    # así el dict no depende de en qué orden respondió el modelo dentro de uno.
    grados = dict(sorted(grados.items()))

    conteo = {g: sum(1 for v in grados.values() if v == g) for g in GRADOS}
    resumen = (
        f"{conteo['directa']} directa, {conteo['parcial']} parcial, {conteo['no']} no "
        f"de {len(chunks)} fragmentos"
    )
    sin_calificar = len(chunks) - len(grados)
    if fallidos:
        return Calificacion(
            grados,
            False,
            f"{fallidos} de {len(lotes)} lotes fallaron; {sin_calificar} fragmentos "
            f"sin calificar; {resumen}",
        )
    if sin_calificar:
        resumen += f"; {sin_calificar} sin calificar por el modelo"
    return Calificacion(grados, True, resumen)
