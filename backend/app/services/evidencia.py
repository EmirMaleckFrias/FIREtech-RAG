"""Pipeline de evidencia: ejecuta el plan de búsquedas por código, no el modelo.

Por qué existe. Hasta ahora el agente decidía libremente cuántas búsquedas
hacía (medido: 6-10 para la misma pregunta), el plan del planificador solo se
le SUGERÍA como texto, ningún fragmento sabía qué punto del plan lo había
traído y un paper largo podía ocupar los 12 huecos que llegan al modelo. El
resultado medido fue que la misma pregunta daba una fidelidad entre 0.33 y
1.00 según la corrida. Bajar la temperatura no lo arregla (ver el comentario de
`llm_temperature` en app/config.py): hay que sacar la decisión de qué buscar
de manos del modelo.

Aquí la evidencia pasa a ser una función determinista de (pregunta, índice):

1. Cada punto del plan lanza EN PARALELO la búsqueda híbrida con su consulta
   y, si la hay, con su versión en inglés (el corpus es mayormente inglés y
   BM25 no traduce). Las dos listas se fusionan por RRF con orden total.
2. Se podan las secciones que nunca son evidencia (bibliografía,
   agradecimientos, financiación, conflictos) y se deduplica por id y por
   texto normalizado. NUNCA por solape de shingles: dos fragmentos contiguos
   comparten solo el párrafo de solape y son dos evidencias distintas.
3. Se preseleccionan N candidatos garantizando una cuota mínima por documento,
   para que un paper largo no expulse al resto antes de que nadie los lea.
4. El calificador (`reranker.calificar_evidencia`) lee cada candidato completo
   y le da un grado frente al dato que se buscaba: directa, parcial o no.
5. El orden final es determinista: grado > peso de la sección (Resultados
   pesa más que Discusión; una sección desconocida es neutra, jamás
   descarta) > rango RRF > id. Se entregan hasta `perfil.fragmentos`, otra vez
   con cuota mínima por documento.

Todo con orden total y desempates explícitos, para que la misma entrada
produzca los mismos ids: `huella()` lo mide en telemetría.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import unicodedata
from dataclasses import dataclass, field

from app.config import get_settings
from app.models import Chunk, SearchFilters
from app.services import reranker
from app.services.planner import PlanItem
from app.services.qdrant import hybrid_search, retrieval_mode

logger = logging.getLogger(__name__)

# Constante clásica de RRF. Con k=60 el primer puesto vale 1/61 y el décimo
# 1/70: premia coincidir en las dos listas sin que un solo primer puesto
# arrase.
RRF_K = 60

CUBIERTO = "cubierto"
SIN_RESULTADOS = "sin_resultados"
# Origen de un fragmento que trajo una búsqueda del modelo, no del plan.
EXTRA = "extra"

# Cuota mínima por documento en la preselección de candidatos (paso 3) y en
# la entrega final (paso 5). Es un SUELO, no un techo: garantiza que un
# segundo documento entre a que lo lea el calificador, pero no recorta al
# primero si el resto no tiene nada relevante.
CUOTA_CANDIDATOS = 3
CUOTA_FINAL = 2

# Secciones que no son evidencia y que aun así recupera la búsqueda porque
# repiten los términos de la pregunta (la bibliografía es el peor caso: cada
# referencia nombra el biomarcador y la cohorte). Lista local a propósito: no
# se importa nada de app/ingest.
_SECCIONES_PODADAS = (
    "bibliograf",
    "referenc",
    "agradecim",
    "acknowledg",
    "funding",
    "financia",
    "conflict",
    "conflicto",
    "competing interest",
    "declaration of interest",
)

# Peso de la sección en el orden final. En un trabajo científico un dato en
# Resultados es evidencia del propio estudio; el mismo enunciado en Discusión
# es interpretación de sus autores. Sección desconocida = 1.0 (neutro): el
# peso ordena, nunca descarta.
_PESOS_SECCION: tuple[tuple[tuple[str, ...], float], ...] = (
    (("result", "finding", "hallazgo"), 3.0),
    (("method", "metodo", "material", "abstract", "resumen", "summary"), 2.0),
    (("discus", "conclu", "limitation", "limitacion"), 1.5),
)

_GRADO_RANGO = {"directa": 0, "parcial": 1}
_RELEVANTES = ("directa", "parcial")
_MAX_DOCUMENTOS_REVISADOS = 5


@dataclass
class PuntoEvidencia:
    """Resultado de ejecutar UN punto del plan (o una búsqueda extra)."""

    id: str
    query: str
    query_en: str
    evidence_needed: str
    fragmentos: list[Chunk] = field(default_factory=list)
    # Documentos de los que salían los candidatos (para que, si no hay
    # evidencia, el modelo sepa qué se revisó antes de decir "no está").
    documentos_revisados: list[str] = field(default_factory=list)
    estado: str = SIN_RESULTADOS
    # False cuando el calificador no se pudo aplicar: los fragmentos van en
    # orden RRF y nadie debe concluir nada de que estén o no.
    relevancia_verificada: bool = False
    # "hybrid" | "dense" | "error"
    recuperacion: str = "error"
    ms: float = 0.0
    # Grado del calificador por Chunk.id ("directa" | "parcial"); vacío cuando
    # no se calificó.
    grados: dict[str, str] = field(default_factory=dict)
    # Candidatos que llegaron al calificador. 0 con recuperación distinta de
    # "error" significa que el índice no devolvió nada parecido.
    n_candidatos: int = 0


@dataclass
class EvidenciaPlan:
    """Evidencia de todo el plan, ya fusionada y trazable por punto."""

    puntos: list[PuntoEvidencia] = field(default_factory=list)
    # Chunk.id -> ids de los puntos que lo recuperaron ("extra" para hops del
    # modelo). Es la trazabilidad que antes no existía: con ella el
    # verificador puede decir qué punto quedó sin usar en la respuesta.
    mapa: dict[str, set[str]] = field(default_factory=dict)
    # Todos los fragmentos entregados al modelo, por id, en orden estable
    # (orden del plan y, dentro de cada punto, orden de entrega).
    acumulado: dict[str, Chunk] = field(default_factory=dict)
    # Chunk.id -> "directa" | "parcial" | "" (sin calificar).
    grados: dict[str, str] = field(default_factory=dict)


# --- utilidades deterministas -------------------------------------------------
def _normalizar(texto: str) -> str:
    """Minúsculas sin acentos y con espacios colapsados: la forma en la que se
    comparan textos y nombres de sección."""
    sin_acentos = "".join(
        c for c in unicodedata.normalize("NFKD", texto or "")
        if not unicodedata.combining(c)
    )
    return " ".join(sin_acentos.casefold().split())


def seccion_podada(section: str) -> bool:
    norm = _normalizar(section)
    return bool(norm) and any(clave in norm for clave in _SECCIONES_PODADAS)


def peso_seccion(section: str) -> float:
    norm = _normalizar(section)
    if not norm:
        return 1.0
    for claves, peso in _PESOS_SECCION:
        if any(clave in norm for clave in claves):
            return peso
    return 1.0


def fusionar_rrf(listas: list[list[Chunk]]) -> list[Chunk]:
    """Fusión RRF de varias listas con orden total.

    El desempate por (source_file, page, id) importa: dos fragmentos con la
    misma puntuación RRF quedarían en el orden que diera el diccionario, y
    ese orden depende de cuál de las dos búsquedas respondió antes.
    """
    puntuacion: dict[str, float] = {}
    por_id: dict[str, Chunk] = {}
    for lista in listas:
        for rango, ch in enumerate(lista, start=1):
            puntuacion[ch.id] = puntuacion.get(ch.id, 0.0) + 1.0 / (RRF_K + rango)
            por_id.setdefault(ch.id, ch)
    return sorted(
        por_id.values(),
        key=lambda c: (-puntuacion[c.id], c.source_file, c.page, c.id),
    )


def podar(chunks: list[Chunk]) -> list[Chunk]:
    return [c for c in chunks if not seccion_podada(c.section)]


def deduplicar(chunks: list[Chunk]) -> list[Chunk]:
    """Quita repetidos por id y por texto normalizado, conservando el primero.

    Solo texto IDÉNTICO. Dos fragmentos contiguos comparten el párrafo de
    solape (unos 60 de 400 tokens) y son dos evidencias distintas: fusionarlos
    por solape de shingles perdía la segunda.
    """
    vistos_id: set[str] = set()
    vistos_texto: set[str] = set()
    salida: list[Chunk] = []
    for c in chunks:
        clave_texto = _normalizar(c.text)
        if c.id in vistos_id or (clave_texto and clave_texto in vistos_texto):
            continue
        vistos_id.add(c.id)
        vistos_texto.add(clave_texto)
        salida.append(c)
    return salida


def seleccionar_con_cuota(ordenados: list[Chunk], tope: int, cuota: int) -> list[Chunk]:
    """Los primeros `tope` de `ordenados`, garantizando `cuota` por documento.

    La cuota es un suelo: si hay varios documentos, cada uno mete al menos
    `cuota` fragmentos (o los que tenga) desplazando a los últimos del
    documento que ya supera la cuota. Las tablas (chunk_type "table") nunca se
    desplazan: una fila con la cifra es justo lo que se busca y suele quedar
    abajo del ranking porque tiene poco texto. Si solo quedan tablas por
    desplazar, la cuota cede y el tope se respeta igual.
    """
    if tope <= 0:
        return []
    if len(ordenados) <= tope:
        return list(ordenados)
    por_doc: dict[str, list[Chunk]] = {}
    for c in ordenados:
        por_doc.setdefault(c.source_file, []).append(c)
    seleccion = list(ordenados[:tope])
    if len(por_doc) < 2 or cuota <= 0:
        return seleccion
    ids = {c.id for c in seleccion}

    def cuenta(doc: str) -> int:
        return sum(1 for c in seleccion if c.source_file == doc)

    # Documentos en orden de aparición en el ranking: el mejor documento
    # asegura su cuota antes que el siguiente.
    for doc in por_doc:
        faltan = max(0, cuota - cuenta(doc))
        pendientes = [c for c in por_doc[doc] if c.id not in ids][:faltan]
        for candidato in pendientes:
            victima = None
            for c in reversed(seleccion):
                if c.chunk_type == "table" or c.source_file == doc:
                    continue
                if cuenta(c.source_file) > cuota:
                    victima = c
                    break
            if victima is None:
                break
            seleccion.remove(victima)
            ids.discard(victima.id)
            seleccion.append(candidato)
            ids.add(candidato.id)
    rango = {c.id: i for i, c in enumerate(ordenados)}
    seleccion.sort(key=lambda c: rango[c.id])
    return seleccion


def _documentos(chunks: list[Chunk]) -> list[str]:
    return list(dict.fromkeys(c.fuente() for c in chunks))


def _modo_recuperacion() -> str:
    try:
        return "hybrid" if retrieval_mode() == "hybrid" else "dense"
    except Exception:
        return "dense"


# --- ejecución de un punto ------------------------------------------------------
async def _recuperar(
    query: str, query_en: str, filtros: SearchFilters, top_k: int
) -> list[Chunk]:
    """Búsqueda híbrida de la consulta y, si difiere, de su versión en inglés,
    en paralelo, fusionadas por RRF. Si una de las dos falla se sigue con la
    otra; si fallan todas, sube la primera excepción."""
    consultas = [query]
    if query_en and _normalizar(query_en) != _normalizar(query):
        consultas.append(query_en)
    resultados = await asyncio.gather(
        *(hybrid_search(q, filtros, top_k) for q in consultas),
        return_exceptions=True,
    )
    listas = [r for r in resultados if not isinstance(r, BaseException)]
    fallos = [r for r in resultados if isinstance(r, BaseException)]
    if not listas:
        raise fallos[0]
    for exc in fallos:
        logger.warning("Una de las búsquedas del punto falló (%s); se sigue con la otra.", exc)
    return fusionar_rrf(listas)


async def _ejecutar_punto(
    item: PlanItem, perfil, filtros: SearchFilters
) -> PuntoEvidencia:
    settings = get_settings()
    t0 = time.perf_counter()
    punto = PuntoEvidencia(
        id=item.id,
        query=item.query,
        query_en=item.query_en,
        evidence_needed=item.evidence_needed,
    )
    try:
        fusion = await _recuperar(item.query, item.query_en, filtros, settings.search_top_k)
    except Exception as exc:
        logger.warning("Punto %s: la búsqueda falló (%s).", item.id, exc)
        punto.recuperacion = "error"
        punto.ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return punto
    punto.recuperacion = _modo_recuperacion()

    candidatos = seleccionar_con_cuota(
        deduplicar(podar(fusion)),
        max(1, settings.evidence_candidates_per_item),
        CUOTA_CANDIDATOS,
    )
    punto.n_candidatos = len(candidatos)
    punto.documentos_revisados = _documentos(candidatos)[:_MAX_DOCUMENTOS_REVISADOS]
    if not candidatos:
        punto.ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return punto

    try:
        calificacion = await reranker.calificar_evidencia(
            item.query, item.evidence_needed, candidatos
        )
    except Exception as exc:
        # Igual que el resto del backend: el fallo del modelo degrada, no
        # tumba. Pero queda marcado, porque nadie debe leer estos fragmentos
        # como "relevantes": son "los más parecidos".
        logger.warning("Punto %s: el calificador falló (%s).", item.id, exc)
        calificacion = reranker.Calificacion({}, False, f"calificador no aplicado: {exc}")

    tope = max(1, int(getattr(perfil, "fragmentos", settings.rerank_top_k)))
    if not calificacion.verificado:
        punto.fragmentos = candidatos[:tope]
        punto.relevancia_verificada = False
    else:
        # Un índice AUSENTE con verificado=True (el modelo se saltó una entrada)
        # no es un "no": nadie debe concluir nada de un grado ausente
        # (contrato C), y perder una cifra por un descarte es peor que un
        # fragmento de más. Se ordena como "parcial" y se entrega sin grado.
        relevantes = [
            (i, c)
            for i, c in enumerate(candidatos)
            if calificacion.grados.get(i, "parcial") in _RELEVANTES
        ]
        # Orden final determinista: grado > peso de sección > rango RRF > id.
        # El índice `i` ES el rango RRF (los candidatos conservan ese orden).
        relevantes.sort(
            key=lambda ic: (
                _GRADO_RANGO[calificacion.grados.get(ic[0], "parcial")],
                -peso_seccion(ic[1].section),
                ic[0],
                ic[1].id,
            )
        )
        ordenados = [c for _, c in relevantes]
        punto.fragmentos = seleccionar_con_cuota(ordenados, tope, CUOTA_FINAL)
        entregados = {c.id for c in punto.fragmentos}
        punto.grados = {
            c.id: calificacion.grados[i]
            for i, c in relevantes
            if c.id in entregados and i in calificacion.grados
        }
        punto.relevancia_verificada = True
    punto.estado = CUBIERTO if punto.fragmentos else SIN_RESULTADOS
    punto.ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return punto


def _punto_fallido(item: PlanItem, ms: float, motivo: str) -> PuntoEvidencia:
    logger.warning("Punto %s no llegó: %s", item.id, motivo)
    return PuntoEvidencia(
        id=item.id,
        query=item.query,
        query_en=item.query_en,
        evidence_needed=item.evidence_needed,
        estado=SIN_RESULTADOS,
        recuperacion="error",
        ms=round(ms, 1),
    )


async def ejecutar_plan(
    plan: list[PlanItem],
    perfil,
    filtros: SearchFilters | None = None,
    deadline_monotonic: float | None = None,
) -> EvidenciaPlan:
    """Ejecuta todos los puntos del plan en paralelo y fusiona la evidencia.

    Cada punto es una tarea propia bajo un único tope de reloj
    (`evidence_prefetch_timeout_s`, recortado a lo que quede hasta
    `deadline_monotonic`): el que no llega queda "sin_resultados" con
    recuperación "error" y el resto se entrega igual. Nunca lanza.
    """
    settings = get_settings()
    filtros = filtros or SearchFilters()
    tope_s = float(settings.evidence_prefetch_timeout_s)
    if deadline_monotonic is not None:
        tope_s = min(tope_s, deadline_monotonic - time.monotonic())
    tope_s = max(0.0, tope_s)

    evidencia = EvidenciaPlan()
    if not plan:
        return evidencia

    t0 = time.perf_counter()
    tareas = [asyncio.ensure_future(_ejecutar_punto(it, perfil, filtros)) for it in plan]
    hechas, pendientes = await asyncio.wait(tareas, timeout=tope_s)
    for t in pendientes:
        t.cancel()
    if pendientes:
        await asyncio.gather(*pendientes, return_exceptions=True)
    transcurrido_ms = (time.perf_counter() - t0) * 1000.0

    for item, tarea in zip(plan, tareas):
        if tarea in hechas and not tarea.cancelled() and tarea.exception() is None:
            punto = tarea.result()
        elif tarea in hechas and not tarea.cancelled():
            punto = _punto_fallido(item, transcurrido_ms, f"excepción: {tarea.exception()}")
        else:
            punto = _punto_fallido(item, transcurrido_ms, f"no llegó en {tope_s:.0f} s")
        evidencia.puntos.append(punto)
        for ch in punto.fragmentos:
            evidencia.mapa.setdefault(ch.id, set()).add(punto.id)
            evidencia.acumulado.setdefault(ch.id, ch)
            # Un grado no vacío gana sobre "" (un punto sin calificador pudo
            # entregar el mismo fragmento que otro sí calificado).
            if not evidencia.grados.get(ch.id):
                evidencia.grados[ch.id] = punto.grados.get(ch.id, "")
    return evidencia


async def buscar_y_calificar(
    query: str,
    evidence_needed: str,
    punto: str,
    perfil,
    filtros: SearchFilters | None = None,
) -> PuntoEvidencia:
    """El mismo camino que un punto del plan, para UNA consulta.

    Lo usan las búsquedas extra del modelo: así un hop del modelo pasa por la
    misma poda, la misma cuota y el mismo calificador que el plan, y su
    evidencia queda igual de trazable (`punto` = id del plan que intenta
    rellenar, o vacío = "extra").
    """
    item = PlanItem(
        id=(punto or "").strip() or EXTRA,
        query=query,
        evidence_needed=evidence_needed or query,
    )
    return await _ejecutar_punto(item, perfil, filtros or SearchFilters())


def huella(evidencia: EvidenciaPlan) -> str:
    """sha256 de los Chunk.id entregados, ordenados. Dos corridas de la misma
    pregunta sobre el mismo índice deben dar la misma huella: es lo que mide
    el determinismo en telemetría."""
    ids = sorted(evidencia.acumulado)
    return hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()


# --- lo que lee el modelo -----------------------------------------------------
def formatear_resultados(chunks: list[Chunk], grados: dict[str, str] | None = None) -> str:
    """Formato de resultados de la herramienta de búsqueda. Es el formato que
    `agent._format_results` entrega desde siempre, con una línea opcional de
    grado del calificador."""
    if not chunks:
        return "Sin resultados para esta búsqueda. Prueba otra formulación de la consulta."
    parts: list[str] = []
    for i, ch in enumerate(chunks, start=1):
        # La cita va etiquetada y entre corchetes, ya montada, para que el
        # modelo la copie literal. La sección va en su propia línea y no
        # pegada a la cita: cuando iban juntas, el modelo arrastraba el
        # "sección: X" fuera de los corchetes y ensuciaba cada línea de la
        # respuesta con un texto que ademas no forma parte de la cita.
        lineas = [f"--- Resultado {i} ---", f"cita: {ch.cite()}"]
        if ch.section and ch.locator() != f"sección: {ch.section}":
            lineas.append(f"(sección del documento: {ch.section})")
        grado = (grados or {}).get(ch.id, "")
        if grado:
            lineas.append(f"(evidencia {grado} para este punto)")
        lineas.append(ch.text)
        parts.append("\n".join(lineas))
    return "\n\n".join(parts)


AVISO_SIN_VERIFICAR = (
    "AVISO: no se pudo verificar la relevancia de estos fragmentos, así "
    "que puede haber alguno que no venga al caso. Cita solo lo que de "
    "verdad responda a la pregunta."
)


def texto_de_punto(punto: PuntoEvidencia) -> str:
    """El mensaje `tool` de un punto: cabecera de estado + resultados.

    La cabecera existe para que el modelo sepa QUÉ dato se buscaba y en qué
    quedó, sin tener que inferirlo de los fragmentos. Y en el caso vacío
    dice qué documentos se revisaron: afirmar "no está" es una afirmación
    fuerte y el modelo tiene que poder darse cuenta si el usuario preguntó
    justo por uno de esos documentos.
    """
    if punto.id == EXTRA:
        etiqueta = f"BÚSQUEDA EXTRA ({punto.evidence_needed})"
    else:
        etiqueta = f"PUNTO {punto.id} ({punto.evidence_needed})"

    if punto.estado == CUBIERTO and punto.fragmentos:
        docs = "; ".join(_documentos(punto.fragmentos))
        cabecera = (
            f"{etiqueta}: cubierto, {len(punto.fragmentos)} fragmentos de: {docs}"
        )
        if not punto.relevancia_verificada:
            cabecera += "\n" + AVISO_SIN_VERIFICAR
        return cabecera + "\n\n" + formatear_resultados(punto.fragmentos, punto.grados)

    if punto.recuperacion == "error":
        return (
            f"{etiqueta}: sin resultados: la búsqueda falló o no llegó a tiempo. "
            f"No concluyas que el dato no existe; di que no pudiste comprobarlo."
        )
    if punto.documentos_revisados:
        docs = "; ".join(punto.documentos_revisados)
        return (
            f"{etiqueta}: sin resultados: se revisaron {punto.n_candidatos} "
            f"fragmentos de {docs} y ninguno aporta evidencia sobre este punto. "
            f"Di que no lo encuentras en los documentos, sin presentarlo como "
            f"un fallo de búsqueda."
        )
    return (
        f"{etiqueta}: sin resultados: el índice no devolvió ningún fragmento "
        f"parecido a esta consulta."
    )


def id_de_llamada(punto_id: str) -> str:
    return f"call_plan_{punto_id}"


def mensajes_sinteticos(evidencia: EvidenciaPlan) -> list[dict]:
    """UN mensaje assistant con N tool_calls y N mensajes tool, en el orden
    del plan. Así la evidencia entra en la conversación exactamente como si
    el modelo la hubiera pedido, y el modelo la lee como resultados de
    búsqueda, que es lo que las reglas de fidelidad le mandan usar. El
    gateway acepta ids sintéticos (probado: 200)."""
    if not evidencia.puntos:
        return []
    assistant = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": id_de_llamada(p.id),
                "type": "function",
                "function": {
                    "name": "buscar_documentos",
                    "arguments": json.dumps(
                        {"semantico": p.query, "punto": p.id}, ensure_ascii=False
                    ),
                },
            }
            for p in evidencia.puntos
        ],
    }
    tools = [
        {
            "role": "tool",
            "tool_call_id": id_de_llamada(p.id),
            "content": texto_de_punto(p),
        }
        for p in evidencia.puntos
    ]
    return [assistant, *tools]
