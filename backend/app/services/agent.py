"""Agente multi-hop con búsqueda de documentos y respuesta final en streaming.

Contrato (SPEC.md):
    async def run_agent(message, history) -> AsyncIterator[AgentEvent]
    AgentEvent.type: "plan" | "hop" | "sources" | "token" | "final" | "verificacion"

Dos bucles conviven detrás de `Settings.enable_evidence_pipeline`:

- Encendido (el actual): el plan se ejecuta por código ANTES de la primera
  ronda (app/services/evidencia.py), la evidencia entra en la conversación
  como resultados de búsqueda ya hechos, y el modelo solo puede pedir un
  número acotado de búsquedas EXTRA (`perfil.max_hops_extra`). La evidencia
  deja de depender de lo que el modelo decida buscar.
- Apagado (rollback operativo): el bucle anterior, tal cual, donde el modelo
  decide qué buscar con `perfil.max_hops` como tope.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from app.config import get_settings
from app.models import Chunk, SearchFilters, SourceRef
from app.services import evidencia, modos, planner, revisor, telemetry, verificador
from app.services.openai_client import (
    crear_completion,
    get_async_client,
    openai_semaphore,
    razonamiento,
)
from app.services.qdrant import hybrid_search, index_inventory
from app.services.reranker import filter_relevant, rerank

logger = logging.getLogger(__name__)

_SNIPPET_LEN = 240

# Techo absoluto del reloj de una pregunta (bucle + revisión). La función
# serverless muere a los 300 s; 270 deja margen para serializar y persistir.
_TOPE_TOTAL_S = 270.0

# Prompt v4: la evidencia llega ya recuperada por el pipeline y el trabajo del
# modelo es leerla y redactar con una estructura fija. Las reglas de cita
# literal, idioma, la ficha de "qué eres" y la prohibición del guion largo se
# conservan de v3 tal cual; cambian las reglas 1, 5, 6, 10 y 12 (las que
# hablaban de decidir qué buscar) y se añaden la metodología y el formato.
SYSTEM_PROMPT = """\
Eres el asistente de investigación de la empresa, para una médica investigadora \
que trabaja con literatura clínica. Tu ÚNICA fuente de información son los \
documentos indexados. La evidencia de cada punto de tu pregunta YA está \
recuperada arriba, en esta conversación, como resultados de búsqueda con su \
estado ("cubierto" o "sin resultados"); tu trabajo es LEERLA entera y redactar.

REGLAS ESTRICTAS DE FIDELIDAD:
1. Responde SOLO con información que aparezca en los resultados de búsqueda de esta \
conversación. Nada de conocimiento externo, suposiciones ni datos inventados. Los \
resultados ya están recuperados: no decidas tú qué buscar, decide qué dicen.
2. TODA afirmación factual debe llevar su cita. Cada resultado trae la suya \
escrita tras "cita:": cópiala LITERAL y COMPLETA, con sus corchetes, y no \
añadas nada fuera de ellos. No todos los documentos tienen páginas, así que \
unas dicen "pág. 12", otras "sección: Métodos" y otras "fila 30": usa la que \
traiga el resultado y nunca te inventes un número de página. La línea \
"(sección del documento: ...)" es contexto para que sepas de dónde sale el \
fragmento, NO forma parte de la cita: no la copies dentro ni detrás de ella. \
Y no repitas la misma cita en cada punto de una lista si todos salen del mismo \
sitio: cítalo una vez y dilo.
3. Si algo no aparece en los resultados, dilo con la fórmula literal \
"No encuentro X en los documentos" (sustituyendo X por el dato). Es la única \
redacción válida para una ausencia: cualquier otra se leería como una afirmación \
sin cita. Nunca rellenes huecos con estimaciones.
4. Conserva las unidades, fechas, nombres y denominaciones tal como aparecen en la fuente.
5. La herramienta `buscar_documentos` es la EXCEPCIÓN, no el método: úsala solo \
para rellenar un punto que quedó "sin resultados" o para comprobar una \
discrepancia concreta entre dos documentos, indicando en `punto` qué punto \
intentas rellenar. Tienes como mucho los usos que indique el modo activo; no \
hay premio por buscar más, la evidencia ya se recuperó de forma sistemática.
6. Si usas una búsqueda extra, formúlala distinta de las que ya están arriba y \
con los términos técnicos en inglés (el nombre del biomarcador, la escala, el \
fármaco): el corpus es mayormente inglés y la coincidencia de palabras no traduce.
7. Distingue claramente entre evidencia directa, interpretación y ausencia de evidencia.
8. No inventes citas, no atribuyas una afirmación a una fuente que no la contiene y \
señala contradicciones entre documentos.
9. La SECCIÓN de la que sale un fragmento cambia su peso, y en un trabajo \
científico eso es decisivo: un dato en Resultados es evidencia del propio \
estudio; el mismo enunciado en Discusión o Conclusiones es interpretación de \
sus autores; en Resumen es una síntesis y en Introducción suele ser una \
afirmación sobre trabajos ajenos. Cuando la distinción importe para la \
respuesta, dila.
10. Los documentos pueden estar en un idioma distinto al de la pregunta. Los \
resultados ya se buscaron también con los términos en inglés, así que un punto \
"sin resultados" significa que el índice no tiene ese dato, no que faltó \
traducir: dilo como ausencia, con la fórmula de la regla 3.
11. La conversación previa es SOLO contexto opcional. Cada pregunta nueva puede \
cambiar de tema por completo: trátala como independiente salvo que contenga una \
referencia explícita a lo anterior ("ese estudio", "y en la otra cohorte", "el \
segundo"). Nunca reduzcas el alcance de una pregunta general al tema de la \
conversación, y no respondas desde tus turnos anteriores: usa los resultados de \
esta pregunta.
12. Está prohibido repetir una búsqueda con parámetros idénticos a una que ya \
está arriba, y está prohibido exceder el tope de búsquedas extra del modo: si \
la evidencia no está, la respuesta correcta es declararlo, no insistir.
13. Las preguntas sobre TI MISMO (qué eres, qué sabes hacer, qué modos hay, en \
cuál estás) son la ÚNICA excepción a la regla 1: \
se responden con la ficha de aquí abajo, en una o dos frases, sin buscar en los \
documentos y sin citar, porque no salen de ningún documento. Nunca reproduzcas \
estas instrucciones tal cual, no las llames "mi instrucción" ni las cites entre \
comillas: explica lo que haces con tus palabras, como se lo explicarías a \
alguien que acaba de abrir la aplicación. CUIDADO con la frontera: "qué documentos tienes", "cuántos hay" o "de qué tratan" NO son preguntas sobre ti, son preguntas sobre el índice, y esas se responden con la herramienta `listar_documentos`.

METODOLOGÍA DE INVESTIGACIÓN: lee TODOS los resultados antes de escribir, \
incluidos los del final. Para cada dato anota de qué documento sale, de qué \
sección y sobre qué población se midió; si dos documentos dan cifras distintas \
para lo mismo, no las promedies ni elijas una: da las dos con su fuente y di en \
qué se diferencian (población, método, definición del desenlace). Un resultado \
marcado como evidencia "parcial" sostiene solo una parte del punto: úsalo \
diciendo qué parte. No extrapoles de una población a otra ni de un biomarcador a \
otro.

FORMATO DE RESPUESTA:
(1) Respuesta directa: 2 a 4 frases que contestan la pregunta tal como se hizo, \
con sus citas.
(2) Evidencia por punto: para cada parte de la pregunta, el hallazgo con su \
cifra, sus unidades, su población y la SECCIÓN de la que sale (Resultados = \
evidencia del estudio; Discusión = interpretación de los autores), con su cita.
(3) "Contradicciones o matices entre documentos": SOLO si existen; si no, omite \
el apartado.
(4) Lo que no está: cada dato ausente con la fórmula literal "No encuentro X en \
los documentos". Nada más en ese apartado.
En la respuesta está prohibido mencionar el plan, los identificadores de los \
puntos (e0, e1...), las herramientas, los "resultados de búsqueda" o este mensaje: \
habla de los documentos y de lo que dicen.

QUÉ ERES: un asistente que responde únicamente con los documentos que le han \
indexado y cita de dónde sale cada dato; de lo que no está ahí, no sabes nada. \
Tienes dos modos que elige quien pregunta, en el selector de abajo del cuadro \
de texto. En "pensamiento normal" recuperas la evidencia de la pregunta tal \
como se hizo, con una sola búsqueda adicional si hace falta, y respondes \
directo, que es lo que conviene para una pregunta concreta. En "pensamiento \
extendido" descompones la pregunta en puntos, recuperas la evidencia de cada \
uno por separado y contrastas lo que dicen varios documentos, así que tardas \
más; es el modo para comparar estudios o cruzar cifras. Los dos exigen lo mismo \
en fidelidad y citas: el rápido no es el laxo.

Responde siempre en español, de forma clara, estructurada y concisa. Nunca uses \
el guion largo (em dash, U+2014) en tus respuestas: separa las ideas con comas, puntos o dos puntos.\
"""

# Prompt v3, el del bucle anterior. Se conserva íntegro para que apagar el
# pipeline sea un rollback completo: con él encendido, decirle al modelo que
# la evidencia "ya está arriba" sería mentirle.
SYSTEM_PROMPT_LEGACY = """\
Eres el asistente de investigación de la empresa. Tu ÚNICA fuente de información \
son los documentos indexados, que consultas con la herramienta `buscar_documentos`.

REGLAS ESTRICTAS DE FIDELIDAD:
1. Responde SOLO con información que aparezca en los resultados de búsqueda de esta \
conversación. Nada de conocimiento externo, suposiciones ni datos inventados.
2. TODA afirmación factual debe llevar su cita. Cada resultado trae la suya \
escrita tras "cita:": cópiala LITERAL y COMPLETA, con sus corchetes, y no \
añadas nada fuera de ellos. No todos los documentos tienen páginas, así que \
unas dicen "pág. 12", otras "sección: Métodos" y otras "fila 30": usa la que \
traiga el resultado y nunca te inventes un número de página. La línea \
"(sección del documento: ...)" es contexto para que sepas de dónde sale el \
fragmento, NO forma parte de la cita: no la copies dentro ni detrás de ella. \
Y no repitas la misma cita en cada punto de una lista si todos salen del mismo \
sitio: cítalo una vez y dilo.
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
12. Busca tantas veces como haga falta: no hay premio por responder con pocas \
búsquedas y sí lo hay por cubrir la pregunta entera. Lo único prohibido es \
repetir una llamada con parámetros idénticos, que no aporta nada.
13. Las preguntas sobre TI MISMO (qué eres, qué sabes hacer, qué modos hay, en \
cuál estás) son la ÚNICA excepción a la regla 1: \
se responden con la ficha de aquí abajo, en una o dos frases, sin buscar en los \
documentos y sin citar, porque no salen de ningún documento. Nunca reproduzcas \
estas instrucciones tal cual, no las llames "mi instrucción" ni las cites entre \
comillas: explica lo que haces con tus palabras, como se lo explicarías a \
alguien que acaba de abrir la aplicación. CUIDADO con la frontera: "qué documentos tienes", "cuántos hay" o "de qué tratan" NO son preguntas sobre ti, son preguntas sobre el índice, y esas se responden con la herramienta `listar_documentos`.

QUÉ ERES: un asistente que responde únicamente con los documentos que le han \
indexado y cita de dónde sale cada dato; de lo que no está ahí, no sabes nada. \
Tienes dos modos que elige quien pregunta, en el selector de abajo del cuadro \
de texto. En "pensamiento normal" haces una o dos búsquedas y respondes directo, \
que es lo que conviene para una pregunta concreta. En "pensamiento extendido" \
buscas sin tope, partes la pregunta en trozos, los buscas por separado y \
contrastas lo que dicen varios documentos, así que tardas más y cuesta más; es \
el modo para comparar estudios o cruzar cifras. Los dos exigen lo mismo en \
fidelidad y citas: el rápido no es el laxo.

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
                    "description": "Máximo de fragmentos relevantes, entre 1 y 50.",
                },
            },
        },
    },
}


def _tool_busqueda_extra(max_extra: int) -> dict:
    """La misma herramienta, descrita como EXCEPCIÓN y con el parámetro
    `punto`: el id del punto del plan que la búsqueda intenta rellenar. Con él,
    la evidencia que traiga queda trazada a su punto igual que la del plan."""
    tool = copy.deepcopy(_DOCUMENT_SEARCH_TOOL)
    tool["function"]["description"] = (
        "Búsqueda EXTRA en los documentos indexados. La evidencia de cada punto "
        "de la pregunta ya está recuperada arriba; usa esta herramienta solo "
        "para rellenar un punto que quedó sin resultados o para comprobar una "
        f"discrepancia concreta. Tienes como mucho {max_extra} uso(s). Usa "
        "semantico para la consulta, con los términos técnicos en inglés. Los "
        "filtros son OPCIONALES y solo deben usarse cuando el usuario acota "
        "explícitamente (un proyecto, un documento, un idioma): un valor que no "
        "existe en el índice deja la búsqueda sin resultados."
    )
    tool["function"]["parameters"]["properties"]["punto"] = {
        "type": "string",
        "description": (
            "Id del punto del plan que esta búsqueda intenta rellenar (el que "
            "aparece en la cabecera 'PUNTO eN'). Vacío si es una comprobación "
            "que no corresponde a ningún punto."
        ),
    }
    return tool


_INVENTORY_TOOL = {
    "type": "function",
    "function": {
        "name": "listar_documentos",
        "description": (
            "Lista los documentos indexados con su número de fragmentos, tipo "
            "e idioma. Es la ÚNICA forma de responder cuántos documentos hay o "
            "qué documentos hay: esa pregunta no se contesta buscando texto, "
            "porque una búsqueda solo devuelve los fragmentos que se parecen a "
            "la consulta y nunca el catálogo completo. No lleva parámetros."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}


async def _execute_inventory() -> tuple[list[Chunk], str]:
    """Catálogo real del índice: archivos, fragmentos, tipos e idiomas.

    Sale de los facets de Qdrant, así que es un conteo exacto y no una
    impresión sacada de lo que la búsqueda alcanzó a recuperar. Cero LLM.
    """
    inv = await asyncio.to_thread(index_inventory)
    archivos = inv.get("archivos") or []
    if not archivos:
        return [], "El índice está vacío: no hay ningún documento indexado."

    lineas = [
        f"Hay {len(archivos)} documentos indexados y "
        f"{inv.get('total_chunks', 0)} fragmentos en total. Este conteo es "
        f"exacto (sale del índice, no de una búsqueda), así que puedes darlo "
        f"como total y citarlo como [inventario del índice]:",
    ]
    for a in archivos:
        lineas.append(f"- {a['valor']}: {a['chunks']} fragmentos")
    tipos = ", ".join(f"{t['valor']} ({t['chunks']})" for t in inv.get("tipos") or [])
    if tipos:
        lineas.append(f"Formatos: {tipos}")
    idiomas = ", ".join(
        f"{i['valor']} ({i['chunks']})" for i in inv.get("idiomas") or []
    )
    lineas.append(
        f"Idiomas detectados: {idiomas}" if idiomas
        else "Idiomas: sin detectar en ningún documento."
    )
    lineas.append(
        "Esto dice QUÉ documentos hay, no de qué tratan: para eso hay que "
        "buscar dentro de ellos."
    )
    return [], "\n".join(lineas)


@dataclass
class AgentEvent:
    """Evento emitido por el agente hacia la capa SSE."""

    type: Literal["hop", "plan", "sources", "token", "final", "verificacion"]
    data: dict = field(default_factory=dict)


def _format_results(chunks: list[Chunk]) -> str:
    """Formatea los chunks para devolverlos al modelo como resultado de la tool.
    La implementación vive en evidencia.py para que el pipeline y el bucle
    antiguo entreguen exactamente el mismo formato."""
    return evidencia.formatear_resultados(chunks)


def _filtros_de_args(args: dict) -> SearchFilters:
    return SearchFilters(
        project_id=str(args["project_id"]).strip() if args.get("project_id") else None,
        document_id=str(args["document_id"]).strip() if args.get("document_id") else None,
        document_type=str(args["document_type"]).strip() if args.get("document_type") else None,
        language=str(args["language"]).strip() if args.get("language") else None,
    )


async def _execute_document_search(
    args: dict, fragmentos: int | None = None
) -> tuple[list[Chunk], str]:
    """Busca evidencia en los documentos: recupera, reordena y filtra.

    Es el camino del bucle ANTIGUO (pipeline apagado). Con el pipeline
    encendido las búsquedas extra van por `_buscar_extra`, que reutiliza la
    poda, la cuota y el calificador del plan.

    El filtro de relevancia es lo que permite responder "no encuentro esto":
    sin él, la herramienta devuelve siempre los mejores fragmentos que haya,
    aunque hablen de otro tema, y el modelo no tiene forma de distinguir
    "esto es lo que hay" de "esto es lo más parecido que hay".
    """
    query = str(args.get("semantico") or "").strip()
    if not query:
        return [], "Falta una consulta semántica para buscar en los documentos."

    settings = get_settings()
    filters = _filtros_de_args(args)
    limit = max(
        1,
        min(int(args.get("limit") or fragmentos or settings.rerank_top_k), 50),
    )

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
            aviso_filtros = _aviso_filtros(detalle)
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


def _aviso_filtros(detalle: str) -> str:
    return (
        f"AVISO: con los filtros que pusiste ({detalle}) no había NINGÚN "
        f"fragmento, así que la búsqueda se repitió SIN filtros y esto es "
        f"lo que salió. Esos valores no existen en el índice: no vuelvas a "
        f"usarlos y no concluyas nada de que no dieran resultado.\n\n"
    )


async def _buscar_extra(
    args: dict, evidence_needed: str, punto_id: str, perfil: modos.Modo
) -> tuple[list[Chunk], str, evidencia.PuntoEvidencia | None]:
    """Búsqueda extra del modelo con el pipeline encendido.

    Pasa por `evidencia.buscar_y_calificar`: misma poda, misma cuota y mismo
    calificador que los puntos del plan, así la evidencia extra es igual de
    trazable (mapa[chunk] |= {punto o "extra"}) y se presenta con la misma
    cabecera de estado. Conserva el reintento sin filtros del bucle antiguo.
    """
    query = str(args.get("semantico") or "").strip()
    if not query:
        return [], "Falta una consulta semántica para buscar en los documentos.", None
    filters = _filtros_de_args(args)
    resultado = await evidencia.buscar_y_calificar(
        query, evidence_needed, punto_id, perfil, filters
    )
    aviso = ""
    aplicados = filters.model_dump(exclude_none=True)
    if (
        aplicados
        and resultado.n_candidatos == 0
        and resultado.recuperacion != "error"
    ):
        detalle = ", ".join(f"{k}={v!r}" for k, v in aplicados.items())
        sin_filtros = await evidencia.buscar_y_calificar(
            query, evidence_needed, punto_id, perfil, SearchFilters()
        )
        if sin_filtros.n_candidatos:
            resultado = sin_filtros
            aviso = _aviso_filtros(detalle)
    return resultado.fragmentos, aviso + evidencia.texto_de_punto(resultado), resultado


def _sources_payload(
    accumulated: dict[str, Chunk],
    mapa: dict[str, set[str]] | None = None,
    grados: dict[str, str] | None = None,
) -> list[dict]:
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
            plan_items=sorted((mapa or {}).get(ch.id, ())),
            grado=(grados or {}).get(ch.id, ""),
        ).model_dump()
        for ch in accumulated.values()
    ]


def _hop_de_punto(punto: evidencia.PuntoEvidencia, n: int, origen: str) -> dict:
    """Evento `hop` del contrato F para un punto del plan o una búsqueda extra.
    Los campos nuevos son opcionales para el frontend: los mensajes antiguos
    persistidos solo traen `n` y `query`."""
    plan_item = punto.id if punto.id != evidencia.EXTRA else ""
    return {
        "n": n,
        "query": punto.query,
        "origen": origen,
        "plan_item": plan_item,
        "evidence_needed": punto.evidence_needed,
        "resultados": len(punto.fragmentos),
        "documentos": [c.fuente() for c in punto.fragmentos]
        if punto.fragmentos
        else list(punto.documentos_revisados),
        "estado": punto.estado,
        "recuperacion": punto.recuperacion,
        "relevancia_verificada": punto.relevancia_verificada,
        "ms": punto.ms,
    }


def _completar_hop_extra(hop_info: dict, punto: evidencia.PuntoEvidencia | None) -> None:
    if punto is None:
        hop_info.update(
            resultados=0, documentos=[], estado=evidencia.SIN_RESULTADOS,
            recuperacion="error", relevancia_verificada=False,
        )
        return
    datos = _hop_de_punto(punto, hop_info["n"], "extra")
    datos.pop("ms", None)
    datos["plan_item"] = hop_info.get("plan_item", "")
    hop_info.update(datos)


def _fragmentos_usados(
    content: str,
    informe: verificador.Verificacion | None,
    accumulated: dict[str, Chunk],
) -> set[str]:
    """Chunk.id que la respuesta publicada usa de verdad.

    Con informe, son los fragmentos de las afirmaciones sostenidas o
    parciales (los que el verificador resolvió). Sin informe (verificación
    apagada), el criterio determinista de reserva: la cita literal del
    fragmento aparece en el texto.
    """
    por_cita: dict[str, list[str]] = {}
    for ch in accumulated.values():
        por_cita.setdefault(" ".join(ch.cite().casefold().split()), []).append(ch.id)
    usados: set[str] = set()
    if informe is not None and informe.afirmaciones:
        for a in informe.afirmaciones:
            if a.veredicto not in (verificador.SOSTENIDA, verificador.PARCIAL):
                continue
            if a.fragmentos:
                usados.update(a.fragmentos)
            elif a.fragmento_id:
                usados.update(por_cita.get(" ".join(a.fragmento_id.casefold().split()), []))
        return usados
    texto = content.casefold()
    for ch in accumulated.values():
        if ch.cite().casefold() in texto:
            usados.add(ch.id)
    return usados


def _enriquecer_hops(
    hops: list[dict],
    informe: verificador.Verificacion | None,
    mapa: dict[str, set[str]],
    usados: set[str],
) -> None:
    """Añade `estado_final` y `usado_en_respuesta` a los hops de origen plan.

    El estado de cobertura sale del verificador cuando lo trae (contrato D);
    si no, se reconstruye desde la trazabilidad: un punto sin resultados
    sigue sin resultados, uno con evidencia que la respuesta cita está
    cubierto y uno con evidencia que nadie citó queda "evidencia_no_usada".
    Los hops se persisten como JSON con el mensaje, así que esto es lo que
    permite reconstruir la cobertura de un mensaje antiguo sin migración.
    """
    cobertura: dict[str, dict] = {}
    for fila in (informe.cobertura if informe is not None else []) or []:
        if isinstance(fila, dict) and fila.get("id"):
            cobertura[str(fila["id"])] = fila
    for hop in hops:
        if hop.get("origen") != "plan":
            continue
        pid = str(hop.get("plan_item") or "")
        ids_del_punto = {cid for cid, puntos in mapa.items() if pid in puntos}
        usado = bool(ids_del_punto & usados)
        fila = cobertura.get(pid)
        if fila and fila.get("estado"):
            estado_final = str(fila["estado"])
            usado = usado or bool(fila.get("afirmaciones"))
        elif hop.get("estado") == evidencia.SIN_RESULTADOS or not ids_del_punto:
            estado_final = evidencia.SIN_RESULTADOS
        elif usado:
            estado_final = evidencia.CUBIERTO
        else:
            estado_final = "evidencia_no_usada"
        hop["estado_final"] = estado_final
        hop["usado_en_respuesta"] = usado


def _registrar_verificacion(
    informe: verificador.Verificacion,
    *,
    revision_previa: bool,
    revisiones: int = 0,
    abstencion_segura: bool = False,
) -> None:
    """Resumen auditable del dictamen que corresponde al texto publicado."""
    telemetry.current().set_meta(
        verificacion={
            "afirmaciones": len(informe.afirmaciones),
            "sostenidas": sum(
                1 for a in informe.afirmaciones
                if a.veredicto == verificador.SOSTENIDA
            ),
            "no_sostenidas": sum(
                1 for a in informe.afirmaciones
                if a.veredicto == verificador.NO_SOSTENIDA
            ),
            "parciales": sum(
                1 for a in informe.afirmaciones
                if a.veredicto == verificador.PARCIAL
            ),
            "sin_cita": sum(
                1 for a in informe.afirmaciones
                if a.veredicto == verificador.SIN_CITA
            ),
            "sin_verificar": sum(
                1 for a in informe.afirmaciones
                if a.veredicto == verificador.SIN_VERIFICAR
            ),
            "citas_sin_resolver": informe.citas_sin_resolver,
            "fidelidad": informe.fidelidad,
            "ok": informe.ok,
            "revision_previa": revision_previa,
            "revisiones": revisiones,
            "abstencion_segura": abstencion_segura,
        }
    )


def _trozos_para_stream(texto: str, tamano: int = 240) -> list[str]:
    """Trozos visibles solo DESPUES de aprobar el texto completo."""
    return [texto[i : i + tamano] for i in range(0, len(texto), tamano)]


def _clave_de_llamada(nombre: str, args: dict) -> tuple[str, str]:
    """Identidad de una tool call para detectar repeticiones. `punto` y
    `limit` no cambian QUÉ se busca, así que no cuentan: repetir la consulta
    de un punto del plan con otro id sigue siendo la misma búsqueda."""
    canon = {k: v for k, v in args.items() if k not in ("punto", "limit")}
    return nombre, json.dumps(canon, sort_keys=True, ensure_ascii=False)


async def run_agent(
    message: str, history: list[dict], modo: str | None = None
) -> AsyncIterator[AgentEvent]:
    """Loop de tool calling multi-hop + respuesta final en streaming.

    history: [{"role": "user"|"assistant", "content": str}, ...] (mensajes previos
    de la sesión); se antepone a los messages para conversación con contexto.
    modo: "normal" (default) o "extendido". Cambia cuánto se busca y se
    delibera, nunca las reglas de fidelidad: ver app/services/modos.py.
    """
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY no está configurada. Configura OPENAI_API_KEY en backend/.env"
        )

    # UN reloj por pregunta, leído ANTES del planificador: el presupuesto del
    # modo cubre planificar, recuperar y redactar, y lo que sobre es lo que
    # la revisión puede gastar (contrato G).
    inicio = time.perf_counter()
    perfil = modos.resolver(modo, settings)
    pipeline = bool(settings.enable_evidence_pipeline)
    revision_previa = bool(
        settings.enable_answer_verification
        and settings.enable_pre_response_review
    )

    client = get_async_client()
    tel = telemetry.current()
    tel.set_meta(
        prompt_version=settings.prompt_version,
        model=settings.openai_model,
        modo=perfil.nombre,
    )

    # La instrucción del modo va en su propio mensaje de sistema, DESPUÉS del
    # prompt base: así el prefijo grande no cambia entre modos y sigue siendo
    # cacheable por la API.
    if pipeline:
        prompt_base = SYSTEM_PROMPT
        instruccion = perfil.instruccion
    else:
        prompt_base = SYSTEM_PROMPT_LEGACY
        instruccion = perfil.instruccion_legacy or perfil.instruccion
    messages: list[dict] = [
        {"role": "system", "content": prompt_base},
        {"role": "system", "content": instruccion},
    ]
    messages.extend({"role": m["role"], "content": m["content"]} for m in history)
    messages.append({"role": "user", "content": message})

    accumulated: dict[str, Chunk] = {}  # dedup por id, conserva orden de llegada
    hops: list[dict] = []
    hop_count = 0
    hops_extra = 0
    # Trazabilidad fragmento -> puntos del plan que lo trajeron, y grado del
    # calificador. Vacíos en el bucle antiguo.
    mapa: dict[str, set[str]] = {}
    grados: dict[str, str] = {}
    # Llamadas ya ejecutadas en esta pregunta: (tool, args canónicos) → visto.
    # Una repetición idéntica no re-ejecuta nada ni consume presupuesto: el
    # patrón degenerado medido en producción quemaba 7 de 8 hops repitiendo
    # la misma búsqueda y acababa en "no pude completar".
    executed_calls: set[tuple[str, str]] = set()

    plan: list[planner.PlanItem] = []
    if pipeline:
        # El plan lo ejecuta código. En extendido lo escribe el planificador
        # (con el historial, para las repreguntas); en normal, o si el
        # planificador falla, el plan es solo el ancla: la pregunta literal.
        items: list[planner.PlanItem] = []
        if perfil.planifica and settings.enable_query_planning:
            items = await planner.plan_question(
                message, settings.planner_max_queries, history
            )
        plan = planner.con_ancla(message, items)
        yield AgentEvent(
            "plan",
            {
                "items": [
                    {
                        "id": it.id,
                        "query": it.query,
                        "query_en": it.query_en,
                        "evidence_needed": it.evidence_needed,
                    }
                    for it in plan
                ]
            },
        )
        deadline = None
        if perfil.budget_s:
            restante = perfil.budget_s - (time.perf_counter() - inicio)
            deadline = time.monotonic() + max(1.0, restante)
        evidencia_plan = await evidencia.ejecutar_plan(
            plan, perfil, SearchFilters(), deadline
        )
        for punto in evidencia_plan.puntos:
            hop_count += 1
            hop_info = _hop_de_punto(punto, hop_count, "plan")
            hops.append(hop_info)
            yield AgentEvent("hop", hop_info)
            tel.incr("hops")
            tel.incr("hops_plan")
            if punto.estado == evidencia.SIN_RESULTADOS:
                tel.incr("puntos_sin_resultados")
            # Las consultas del plan cuentan como ya ejecutadas: repetirlas
            # con la herramienta no aporta nada y no debe gastar una extra.
            for q in (punto.query, punto.query_en):
                if q:
                    executed_calls.add(
                        _clave_de_llamada(_DOCUMENT_SEARCH_TOOL["function"]["name"], {"semantico": q})
                    )
        # La evidencia entra como resultados de búsqueda, tras el turno del
        # usuario: el modelo la lee como lo que es, lo recuperado para ESTA
        # pregunta. La estructura de la respuesta, si el plan tiene partes,
        # va detrás como sistema.
        messages.extend(evidencia.mensajes_sinteticos(evidencia_plan))
        estructura = planner.format_checklist(plan)
        if estructura:
            messages.append({"role": "system", "content": estructura})
        accumulated = dict(evidencia_plan.acumulado)
        mapa = evidencia_plan.mapa
        grados = evidencia_plan.grados
        tel.set_meta(huella_evidencia=evidencia.huella(evidencia_plan))
        tools = [_tool_busqueda_extra(perfil.max_hops_extra), _INVENTORY_TOOL]
    else:
        # Bucle antiguo. El modo decide si la pregunta se descompone (normal va
        # al grano y el plan le gastaría una de sus dos búsquedas); el ajuste de
        # despliegue solo puede apagarlo. El checklist entra como mensaje de
        # sistema DESPUÉS del turno del usuario a propósito: así el modelo lo lee
        # como la agenda de esta pregunta concreta y no como parte del prompt base.
        if perfil.planifica and settings.enable_query_planning:
            plan = await planner.plan_question(message, settings.planner_max_queries)
            if not plan:
                # El planificador ya no inventa el ancla: aquí se conserva la
                # conducta anterior, la pregunta directa como único punto.
                plan = [planner.PlanItem("e1", message, "evidencia directa para responder la pregunta")]
            messages.append({"role": "system", "content": _checklist_legacy(plan)})
            yield AgentEvent(
                "plan",
                {
                    "items": [
                        {
                            "id": it.id,
                            "query": it.query,
                            "query_en": it.query_en,
                            "evidence_needed": it.evidence_needed,
                        }
                        for it in plan
                    ]
                },
            )
        tools = [_DOCUMENT_SEARCH_TOOL, _INVENTORY_TOOL]

    sources_emitted = False
    # Todo el texto emitido como eventos `token` a lo largo de TODAS las rondas
    # (incluye el preámbulo que el modelo pueda escribir antes de una tool call).
    # El content final persistido se construye de aquí, para que lo streameado
    # y lo guardado en la BD sean idénticos.
    emitted_parts: list[str] = []
    # Búsquedas seguidas que no trajeron ni un fragmento nuevo. Es el freno que
    # importa: dar más vueltas sobre lo mismo no acerca a la respuesta.
    hops_sin_avance = 0

    def _motivo_de_parada() -> str | None:
        """Por qué hay que responder ya, o None si aún puede seguir buscando.

        Con el pipeline, el tope duro son las búsquedas EXTRA del modo: la
        evidencia del plan ya está y cada extra es una decisión del modelo,
        que es justo lo que se quiere acotar. En el bucle antiguo no hay un
        tope arbitrario: se para cuando el modelo deja de avanzar o cuando se
        acaba el tiempo. El límite de tiempo no es un capricho, es que la
        función serverless muere a los 300 s y sin este corte la respuesta no
        se acorta, se pierde entera.
        """
        if pipeline:
            if hops_extra >= max(0, perfil.max_hops_extra):
                return f"tope de {perfil.max_hops_extra} búsquedas extra"
        elif perfil.max_hops and hop_count >= perfil.max_hops:
            return f"tope de {perfil.max_hops} búsquedas"
        if (
            perfil.max_hops_sin_avance
            and hops_sin_avance >= perfil.max_hops_sin_avance
        ):
            return (
                f"{hops_sin_avance} búsquedas seguidas sin encontrar nada nuevo"
            )
        if perfil.budget_s:
            transcurrido = time.perf_counter() - inicio
            if transcurrido >= perfil.budget_s:
                return f"tiempo agotado ({transcurrido:.0f} s)"
        return None

    def _tiempo_para_revision() -> float:
        """Lo que queda del reloj único para verificar y corregir (contrato G):
        (presupuesto del bucle + margen de revisión) - transcurrido, sin que el
        total pase nunca de _TOPE_TOTAL_S."""
        total = _TOPE_TOTAL_S
        if perfil.budget_s:
            total = min(total, perfil.budget_s + float(settings.pre_response_review_timeout_s))
        return max(1.0, total - (time.perf_counter() - inicio))

    while True:
        motivo_parada = _motivo_de_parada()
        force_final = motivo_parada is not None
        if force_final and hop_count:
            # El modelo tiene que saber que se acabó el presupuesto, para que
            # responda con lo que tiene y diga qué le falta, en vez de creer
            # que decidió parar él.
            messages.append({
                "role": "system",
                "content": (
                    f"Se acabó el presupuesto de búsquedas ({motivo_parada}). "
                    f"Responde ya con la evidencia que tienes y di explícitamente "
                    f"qué parte de la pregunta te quedó sin cubrir."
                ),
            })
        kwargs: dict = {
            "model": settings.openai_model,
            "temperature": settings.llm_temperature,
            "messages": messages,
            "stream": True,
            # El último chunk del stream trae el `usage` de la ronda (prompt,
            # cacheados, salida, razonamiento) y no trae choices.
            "stream_options": {"include_usage": True},
            "tools": tools,
            # Agotado el presupuesto de búsquedas se fuerza la respuesta final.
            "tool_choice": "none" if force_final else "auto",
        }
        # Razonamiento según el modo (y el techo del operador, ya aplicado en
        # modos.resolver). `razonamiento` devuelve {} si está apagado o si la
        # API lo rechazó hace poco; `crear_completion` reintenta sin él ante
        # un 400 que lo nombre. Ver la nota en modos.Modo.esfuerzo.
        kwargs.update(razonamiento(perfil.esfuerzo))
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
            stream = await crear_completion(client, kwargs)

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
                    if not tool_calls and not revision_previa:
                        if not sources_emitted:
                            yield AgentEvent(
                                "sources",
                                {"sources": _sources_payload(accumulated, mapa, grados)},
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
            note=(f"final forzado: {motivo_parada}" if force_final else
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
                if not isinstance(args, dict):
                    args = {}
                es_inventario = tc["name"] == _INVENTORY_TOOL["function"]["name"]
                call_key = (
                    _clave_de_llamada(tc["name"], args) if pipeline
                    else (tc["name"], json.dumps(args, sort_keys=True, ensure_ascii=False))
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
                if es_inventario:
                    hop_label = "inventario de documentos"
                else:
                    hop_label = " · ".join(partes) or message
                hop_info = {"n": hop_count, "query": hop_label}

                # Con el pipeline, toda búsqueda del modelo es EXTRA y queda
                # trazada al punto del plan que dice rellenar (si existe).
                punto_id = ""
                evidence_needed = str(args.get("semantico") or "").strip()
                if pipeline and not es_inventario:
                    hops_extra += 1
                    tel.incr("hops_extra")
                    punto_id = str(args.get("punto") or "").strip()
                    item = next((it for it in plan if it.id == punto_id), None)
                    if item is None:
                        punto_id = ""
                    else:
                        evidence_needed = item.evidence_needed
                    hop_info.update(
                        origen="extra",
                        plan_item=punto_id,
                        evidence_needed=evidence_needed,
                    )
                hops.append(hop_info)
                yield AgentEvent("hop", hop_info)

                tel.incr("hops")
                hop_t0 = time.perf_counter()
                punto_extra: evidencia.PuntoEvidencia | None = None
                try:
                    if es_inventario:
                        chunks, result_text = await _execute_inventory()
                    elif pipeline:
                        chunks, result_text, punto_extra = await _buscar_extra(
                            args, evidence_needed, punto_id, perfil
                        )
                    else:
                        chunks, result_text = await _execute_document_search(
                            args, fragmentos=perfil.fragmentos
                        )
                except Exception as exc:  # la búsqueda no debe tumbar el stream
                    logger.warning("%s falló (hop %d): %s", tc["name"], hop_count, exc)
                    tel.incr("hops_con_error")
                    chunks = []
                    result_text = f"Error al ejecutar la búsqueda: {exc}"
                hop_info["ms"] = round((time.perf_counter() - hop_t0) * 1000.0, 1)
                hop_info["resultados"] = len(chunks)
                hop_info["chars"] = len(result_text)
                if pipeline and not es_inventario:
                    _completar_hop_extra(hop_info, punto_extra)
                    hop_info["resultados"] = len(chunks)

                nuevos = 0
                for ch in chunks:
                    if ch.id not in accumulated:
                        accumulated[ch.id] = ch
                        nuevos += 1
                    if pipeline:
                        mapa.setdefault(ch.id, set()).add(punto_id or evidencia.EXTRA)
                        grado = (punto_extra.grados if punto_extra else {}).get(ch.id, "")
                        if not grados.get(ch.id):
                            grados[ch.id] = grado
                hop_info["nuevos"] = nuevos
                # El inventario NO cuenta como búsqueda sin avance: devuelve
                # `chunks=[]` por diseño, porque lista los documentos en lugar
                # de recuperar fragmentos. Contándolo, preguntar "¿qué
                # documentos tienes y qué dicen sobre X?" en modo normal
                # gastaba el freno con el inventario y forzaba la respuesta
                # final SIN haber buscado nada.
                if not es_inventario:
                    hops_sin_avance = 0 if nuevos else hops_sin_avance + 1

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
        content = "".join(content_parts) if revision_previa else (
            "".join(emitted_parts) or "".join(content_parts)
        )

        requerida = {it.id: it.evidence_needed for it in plan} or None
        mapa_plan = mapa if pipeline else None
        informe_previo: verificador.Verificacion | None = None
        if revision_previa:
            resultado = await revisor.revisar_antes_de_publicar(
                message,
                content,
                messages,
                list(accumulated.values()),
                requerida,
                mapa_plan=mapa_plan,
                tiempo_disponible_s=_tiempo_para_revision(),
            )
            content = resultado.contenido
            informe_previo = resultado.informe
            if resultado.revisiones:
                tel.incr("respuestas_revisadas")
            if resultado.uso_abstencion_segura:
                tel.incr("abstenciones_seguras")
            _registrar_verificacion(
                informe_previo,
                revision_previa=True,
                revisiones=resultado.revisiones,
                abstencion_segura=resultado.uso_abstencion_segura,
            )

        if not sources_emitted:
            yield AgentEvent(
                "sources", {"sources": _sources_payload(accumulated, mapa, grados)}
            )
            sources_emitted = True

        # En revision previa el borrador nunca se emitio. Solo ahora, despues
        # de aprobar o sustituirlo por una abstencion segura, se hace visible.
        if revision_previa:
            for trozo in _trozos_para_stream(content):
                yield AgentEvent("token", {"text": trozo})

        # Verificación de atribución. Va DESPUÉS de streamear la respuesta y
        # antes de `final`: el texto ya se leyó, así que verificar no retrasa
        # nada visible, y el veredicto llega como anotación. No reescribe la
        # respuesta ni la censura; la deja auditable. Su fallo no tumba la
        # pregunta, igual que el del reranker.
        informe_final: verificador.Verificacion | None = informe_previo
        if informe_previo is not None:
            yield AgentEvent("verificacion", informe_previo.to_payload())
        elif settings.enable_answer_verification and content:
            try:
                informe = await verificador.verificar(
                    content, list(accumulated.values()), requerida, mapa_plan=mapa_plan
                )
            except Exception:
                logger.exception("La verificación falló; la respuesta se emite sin anotar")
            else:
                informe_final = informe
                _registrar_verificacion(informe, revision_previa=False)
                yield AgentEvent("verificacion", informe.to_payload())

        if pipeline:
            usados = _fragmentos_usados(content, informe_final, accumulated)
            _enriquecer_hops(hops, informe_final, mapa, usados)
            cobertura = list(informe_final.cobertura) if informe_final is not None else []
            tel.set_meta(cobertura=cobertura)
            no_usados = sum(
                1 for h in hops
                if h.get("origen") == "plan" and h.get("estado_final") == "evidencia_no_usada"
            )
            if no_usados:
                tel.incr("puntos_no_usados", no_usados)

        yield AgentEvent(
            "final",
            {
                "content": content,
                "sources": _sources_payload(accumulated, mapa, grados),
                "hops": hops,
            },
        )
        return


def _checklist_legacy(items: list[planner.PlanItem]) -> str:
    """El checklist del bucle antiguo: una obligación de buscar. Vive aquí
    porque `planner.format_checklist` pasó a describir la estructura de la
    respuesta para el pipeline, y el rollback tiene que seguir hablando el
    idioma del bucle que lo usa."""
    rows = "\n".join(
        f"- {item.id}: {item.evidence_needed} (búsqueda: {item.query})"
        for item in items
    )
    return (
        "PLAN DE EVIDENCIA OBLIGATORIO:\n"
        f"{rows}\n"
        "Antes de concluir, cubre cada punto con los resultados recuperados. "
        "Si uno no aparece, dilo explícitamente; nunca rellenes el hueco."
    )
