"""Los dos modos de respuesta: pensamiento normal y pensamiento extendido.

La diferencia entre ellos es cuánto se le deja BUSCAR y DELIBERAR, nunca cuánta
verdad se le exige. Las reglas de fidelidad (responder solo con lo recuperado,
citar cada afirmación, decir cuando algo no está) son idénticas en los dos: un
modo rápido que además miente no sirve para nada.

- normal: la evidencia de la pregunta literal llega ya recuperada (pipeline
  de evidencia, app/services/evidencia.py) y el modelo tiene UNA búsqueda
  extra para rellenar un hueco. Es el modo para la pregunta directa, "qué
  dice el documento X sobre Y". Usa el mismo modelo grande y el mismo
  calificador, así que la respuesta es igual de fiable; lo único que no hace
  es descomponer.
- extendido: la pregunta se descompone en un plan (planner.py), el pipeline
  ejecuta todos los puntos en paralelo, hay más fragmentos por punto, hasta
  dos búsquedas extra y esfuerzo de razonamiento alto. Es el modo para la
  pregunta que hay que descomponer: comparar estudios, cruzar cifras, buscar
  contradicciones.

Con `Settings.enable_evidence_pipeline` apagado (rollback) rige el bucle
anterior: el modelo decide qué buscar, con `max_hops` como tope y
`instruccion_legacy` como coda.
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
    # Tope de búsquedas del bucle ANTIGUO (pipeline apagado). 0 = sin tope.
    max_hops: int
    # Búsquedas que el modelo puede pedir ADEMÁS de las del plan cuando el
    # pipeline de evidencia está encendido. Es un tope duro: medido, dejar
    # que el modelo decidiera cuántas búsquedas hacía daba 6-10 para la misma
    # pregunta y una fidelidad de 0.33 a 1.00 entre corridas. Las extra
    # existen solo para rellenar un punto sin resultados o comprobar una
    # discrepancia, no para explorar.
    max_hops_extra: int
    # Segundos de reloj antes de forzar la respuesta final.
    budget_s: float
    # Búsquedas seguidas sin nada nuevo antes de responder con lo que hay.
    max_hops_sin_avance: int
    # Fragmentos que llegan al modelo por búsqueda.
    fragmentos: int
    # Si la pregunta se descompone en un plan de evidencia antes de buscar
    # (app/services/planner.py). Vive aquí y no en Settings porque es parte de
    # CÓMO trabaja el modo: normal va al grano con dos búsquedas y el plan solo
    # le gastaría una de ellas; extendido existe justo para descomponer. El
    # interruptor de despliegue es Settings.enable_query_planning, que puede
    # apagarlo en los dos modos pero nunca encenderlo donde el modo dice no.
    planifica: bool
    # `reasoning_effort` de la API. None = no se envía el parámetro.
    #
    # Historia, porque ya mordió dos veces. El 2 sep 2026 gpt-5.4 en
    # /v1/chat/completions rechazaba con 400 cualquier reasoning_effort
    # distinto de 'none' junto a function tools, y dejarlo puesto sin probar
    # tumbó el modo extendido entero en producción; se apagó. El 4 sep 2026 se
    # volvió a medir contra el gateway de Vercel con los kwargs EXACTOS del
    # bucle (temperature=0, stream, stream_options, tools, tool_choice auto y
    # none, parallel_tool_calls=False) y con esfuerzo medium y high: todo
    # 200, con 76-338 tokens de razonamiento por ronda. Y el efecto es el que
    # se buscaba: ante una pregunta comparativa, sin razonamiento el modelo
    # pedía UNA búsqueda; con high pedía tres, una por término.
    #
    # Para que un cambio de la API no vuelva a romper el modo, el parámetro
    # no se manda a ciegas: `openai_client.crear_completion` captura el 400
    # que lo nombra, reintenta sin él y lo deja apagado un rato. Así el peor
    # caso es volver a la conducta anterior, no perder la respuesta.
    esfuerzo: str | None
    # Coda que se añade al system prompt para explicar cómo trabajar (con el
    # pipeline de evidencia encendido).
    instruccion: str
    # La misma coda para el bucle anterior (pipeline apagado): ahí el modelo
    # sí decide qué buscar, y decirle que la evidencia "ya está arriba" sería
    # mentirle. Se conserva para que el rollback sea completo.
    instruccion_legacy: str = ""


NORMAL = Modo(
    nombre="normal",
    etiqueta="Pensamiento normal",
    max_hops=2,
    max_hops_extra=1,
    budget_s=60.0,
    # Si la primera búsqueda no trae nada nuevo, la segunda tampoco lo hará por
    # insistir: se responde con lo que haya.
    # 2 y no 1: con max_hops=2 el tope de búsquedas ya acota el gasto, así
    # que este freno era redundante y sí hacía daño. El prompt le pide al
    # modelo reformular cuando una búsqueda no trae nada, y en un corpus en
    # inglés con preguntas en español ese reintento es el caso NORMAL, no la
    # excepción. Con 1, la primera búsqueda vacía prohibía el reintento que el
    # propio sistema acababa de pedir, y se respondía "no lo encuentro en los
    # documentos" sobre información que sí estaba indexada.
    max_hops_sin_avance=2,
    fragmentos=8,
    planifica=False,
    # medium y no high: en normal la respuesta debe llegar en segundos y el
    # razonamiento se gasta sobre todo en elegir bien la única o las dos
    # búsquedas, que es donde medium ya cambia la conducta.
    esfuerzo="medium",
    instruccion=(
        "MODO ACTIVO: pensamiento normal, el que eligió quien pregunta. Ve al "
        "grano. La evidencia de la pregunta ya está recuperada arriba; léela y "
        "responde con ella. Tienes UNA búsqueda extra como máximo, y solo para "
        "rellenar un hueco concreto que la evidencia no cubra, no para "
        "explorar. Si la pregunta resulta ser más compleja de lo que cabe "
        "aquí, responde con lo que tengas y dile al usuario que en "
        "pensamiento extendido puedes descomponerla y profundizar. Las reglas "
        "de fidelidad y de citas se cumplen igual: rápido no significa laxo."
    ),
    instruccion_legacy=(
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
    max_hops_extra=2,
    # 180 y no 240: el presupuesto del bucle tiene que dejar sitio a la
    # barrera de revisión (verificar, corregir, volver a verificar; hasta
    # pre_response_review_timeout_s) DENTRO de los 300 s de la función
    # serverless. Con 240 + 45 de revisión ya se rozaba el límite, y al
    # encender el razonamiento la revisión necesita más margen, no menos. En
    # la sesión de estrés ninguna pregunta extendida pasó de 80 s de bucle,
    # así que 180 no recorta nada real.
    budget_s=180.0,
    max_hops_sin_avance=3,
    fragmentos=12,
    planifica=True,
    # Ver la nota del campo. high: este modo existe para deliberar.
    esfuerzo="high",
    instruccion=(
        "MODO ACTIVO: pensamiento extendido, el que eligió quien pregunta. "
        "Tómate el trabajo en serio. La pregunta ya se descompuso en puntos y "
        "la evidencia de cada uno está recuperada arriba, con su estado: tu "
        "trabajo es LEERLA entera, cruzar lo que dicen los distintos documentos "
        "y redactar por puntos. Tienes hasta dos búsquedas extra, y solo para "
        "rellenar un punto sin resultados o comprobar una discrepancia entre "
        "documentos. Cuando la pregunta admite comparación, contrasta la "
        "evidencia de varios documentos antes de concluir y di explícitamente "
        "si se contradicen. Antes de dar la respuesta final, repasa si algún "
        "punto quedó sin evidencia y dilo en vez de rellenarlo."
    ),
    instruccion_legacy=(
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
    AGENT_MAX_HOPS_SIN_AVANCE) se aplican encima del perfil; MAX_HOPS acota
    tanto `max_hops` (bucle antiguo) como `max_hops_extra` (pipeline).
    """
    base = POR_DEFECTO
    if nombre:
        base = MODOS.get(str(nombre).strip().lower(), POR_DEFECTO)
    if settings is None:
        return base

    from dataclasses import replace

    # Techo del operador sobre el razonamiento: vacío = manda el modo; "none"
    # lo apaga; cualquier otro valor sustituye al del modo (es el interruptor
    # para bajar a medium/low en el despliegue sin tocar código).
    esfuerzo = base.esfuerzo
    techo_esfuerzo = str(getattr(settings, "agent_reasoning_effort", "") or "").strip().lower()
    if techo_esfuerzo:
        esfuerzo = None if techo_esfuerzo == "none" else techo_esfuerzo

    techo_hops = getattr(settings, "max_hops", 0) or 0
    return replace(
        base,
        esfuerzo=esfuerzo,
        max_hops=int(_techo(base.max_hops, techo_hops)),
        # El mismo techo del operador acota las búsquedas extra del pipeline:
        # MAX_HOPS=1 en el despliegue significa "una búsqueda del modelo como
        # mucho", sea cual sea el bucle que esté encendido.
        max_hops_extra=int(_techo(base.max_hops_extra, techo_hops)),
        budget_s=_techo(base.budget_s, getattr(settings, "agent_budget_s", 0.0) or 0.0),
        max_hops_sin_avance=int(
            _techo(
                base.max_hops_sin_avance,
                getattr(settings, "agent_max_hops_sin_avance", 0) or 0,
            )
        ),
    )
