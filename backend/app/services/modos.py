"""Los dos modos de respuesta: pensamiento normal y pensamiento extendido.

La diferencia entre ellos es cuánto se le deja BUSCAR y DELIBERAR, nunca cuánta
verdad se le exige. Las reglas de fidelidad (responder solo con lo recuperado,
citar cada afirmación, decir cuando algo no está) son idénticas en los dos: un
modo rápido que además miente no sirve para nada.

- normal: una o dos búsquedas y respuesta. Es el modo para la pregunta directa,
  "qué dice el documento X sobre Y". Sigue usando el modelo grande, el reranker
  y el filtro de relevancia, así que la respuesta es igual de fiable; lo único
  que no hace es dar vueltas.
- extendido: sin tope de búsquedas, presupuesto de tiempo largo, más fragmentos
  por búsqueda y esfuerzo de razonamiento alto. Es el modo para la pregunta que
  hay que descomponer: comparar estudios, cruzar cifras, buscar contradicciones.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Nombre = Literal["normal", "extendido"]


@dataclass(frozen=True)
class Modo:
    """Presupuesto de un modo. Nada de esto cambia las reglas de fidelidad."""

    nombre: Nombre
    etiqueta: str
    # 0 = sin tope de búsquedas.
    max_hops: int
    # Segundos de reloj antes de forzar la respuesta final.
    budget_s: float
    # Búsquedas seguidas sin nada nuevo antes de responder con lo que hay.
    max_hops_sin_avance: int
    # Fragmentos que llegan al modelo por búsqueda.
    fragmentos: int
    # `reasoning_effort` de la API. None = no se envía el parámetro.
    esfuerzo: str | None
    # Coda que se añade al system prompt para explicar cómo trabajar.
    instruccion: str


NORMAL = Modo(
    nombre="normal",
    etiqueta="Pensamiento normal",
    max_hops=2,
    budget_s=60.0,
    # Si la primera búsqueda no trae nada nuevo, la segunda tampoco lo hará por
    # insistir: se responde con lo que haya.
    max_hops_sin_avance=1,
    fragmentos=8,
    esfuerzo=None,
    instruccion=(
        "MODO ACTIVO: pensamiento normal, el que eligió quien pregunta. Ve al "
        "grano. Con una búsqueda bien formulada "
        "suele bastar, y tienes dos como máximo, así que úsalas para cubrir la "
        "pregunta y no para explorar. Si la pregunta resulta ser más compleja de "
        "lo que cabe en dos búsquedas, responde con lo que tengas y dile al "
        "usuario que en pensamiento extendido puedes profundizar. Las reglas de "
        "fidelidad y de citas se cumplen igual: rápido no significa laxo."
    ),
)

EXTENDIDO = Modo(
    nombre="extendido",
    etiqueta="Pensamiento extendido",
    max_hops=0,
    budget_s=240.0,
    max_hops_sin_avance=3,
    fragmentos=12,
    esfuerzo="high",
    instruccion=(
        "MODO ACTIVO: pensamiento extendido, el que eligió quien pregunta. "
        "Tómate el trabajo en serio. Descompón la "
        "pregunta en las partes que la componen y busca cada una por separado, "
        "con sus propios términos; no hay tope de búsquedas y no gana nada quien "
        "responde con pocas. Cuando la pregunta admite comparación, reúne "
        "evidencia de varios documentos antes de concluir y di explícitamente si "
        "se contradicen. Antes de dar la respuesta final, repasa si alguna parte "
        "de la pregunta quedó sin evidencia y dilo en vez de rellenarla."
    ),
)

MODOS: dict[str, Modo] = {NORMAL.nombre: NORMAL, EXTENDIDO.nombre: EXTENDIDO}
POR_DEFECTO = NORMAL


def _techo(del_modo: float, del_operador: float) -> float:
    """Combina el presupuesto del modo con el techo del operador.

    El modo decide cómo quiere trabajar; las variables de entorno son el techo
    de quien opera el despliegue, y por eso solo pueden APRETAR, nunca soltar.
    Un 0 significa "sin límite" en los dos lados.
    """
    if not del_operador:
        return del_modo
    if not del_modo:
        return del_operador
    return min(del_modo, del_operador)


def resolver(nombre: str | None, settings=None) -> Modo:
    """Modo pedido, o el normal si viene vacío o con un valor desconocido.

    Un nombre inválido no es un error que deba tumbar la pregunta: se responde
    en el modo normal, que es el que menos supone.

    Con `settings`, los topes del despliegue (MAX_HOPS, AGENT_BUDGET_S,
    AGENT_MAX_HOPS_SIN_AVANCE) se aplican encima del perfil.
    """
    base = POR_DEFECTO
    if nombre:
        base = MODOS.get(str(nombre).strip().lower(), POR_DEFECTO)
    if settings is None:
        return base

    from dataclasses import replace

    return replace(
        base,
        max_hops=int(_techo(base.max_hops, getattr(settings, "max_hops", 0) or 0)),
        budget_s=_techo(base.budget_s, getattr(settings, "agent_budget_s", 0.0) or 0.0),
        max_hops_sin_avance=int(
            _techo(
                base.max_hops_sin_avance,
                getattr(settings, "agent_max_hops_sin_avance", 0) or 0,
            )
        ),
    )
