"""Barrera de fidelidad previa a mostrar una respuesta.

El agente principal redacta un borrador privado. El verificador lo confronta
con los fragmentos recuperados y, si encuentra problemas, este revisor devuelve
la critica al modelo redactor para que produzca una version corregida. Solo una
version aprobada sale hacia el usuario; ante fallo o timeout se responde con
una abstencion segura.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

from app.config import get_settings
from app.models import Chunk
from app.services import telemetry, verificador
from app.services.openai_client import get_async_client, openai_slot

logger = logging.getLogger(__name__)

_SYSTEM = """Eres el redactor final de un sistema RAG para investigacion
medica. Recibes un borrador privado y el informe de un critico que comparo cada
afirmacion con sus fuentes recuperadas.

Corrige el borrador con estas reglas estrictas:
- conserva solo afirmaciones sostenidas literalmente por la evidencia;
- corrige o elimina toda afirmacion parcial, no sostenida o sin cita;
- usa exclusivamente las citas literales disponibles en los resultados;
- no aportes conocimiento externo ni inventes fuentes, cifras o conclusiones;
- si falta evidencia para una parte, declaralo explicitamente;
- devuelve solamente la respuesta final corregida, sin explicar el proceso de
  revision ni mencionar este mensaje.
"""

ABSTENCION_SEGURA = (
    "No puedo ofrecer una respuesta verificable con la evidencia recuperada. "
    "No encuentro respaldo suficiente en los documentos para responder con la "
    "fidelidad requerida."
)


@dataclass(frozen=True)
class ResultadoRevision:
    contenido: str
    informe: verificador.Verificacion
    revisiones: int = 0
    uso_abstencion_segura: bool = False


# Veredictos que son una ATRIBUCION FALSA: la respuesta apunta a una fuente
# que no dice lo que ella dice. Es el daño concreto que esta barrera existe
# para impedir, y lo unico que no puede salir hacia el usuario.
_BLOQUEANTES = frozenset(
    {verificador.NO_SOSTENIDA, verificador.CITA_NO_RESUELVE, verificador.SIN_CITA}
)


def bloqueantes(informe: verificador.Verificacion) -> list[verificador.Afirmacion]:
    """Afirmaciones cuya cita no las sostiene."""
    return [a for a in informe.afirmaciones if a.veredicto in _BLOQUEANTES]


def sin_senal(informe: verificador.Verificacion) -> bool:
    """El verificador no pudo dictaminar NADA: no hay con qué corregir.

    Distinto de que alguna afirmacion quede sin veredicto, que es normal y solo
    significa que esa no se comprobo.
    """
    if not informe.afirmaciones:
        return False
    return all(
        a.veredicto == verificador.SIN_VERIFICAR for a in informe.afirmaciones
    )


def aprobada(informe: verificador.Verificacion) -> bool:
    """True si no queda ninguna atribucion FALSA.

    `parcial` y `sin_verificar` NO bloquean, y esto es deliberado. Antes se
    exigia que TODAS las afirmaciones estuvieran sostenidas, y medido contra
    una sesion de estres de diez preguntas reales solo pasaban 3 -dos de ellas
    abstenciones con cero afirmaciones-: las respuestas de contenido traen
    entre 15 y 36 afirmaciones y basta un matiz para tumbarlas. El usuario
    habria recibido "no puedo ofrecer una respuesta verificable" en 7 de cada
    10 preguntas.

    Eso no es mas seguro, es menos: una barrera que se dispara siempre enseña
    a ignorarla, y un investigador que recibe abstenciones constantes vuelve a
    leer los PDF a mano o se va a un chatbot sin verificacion ninguna. Un
    `parcial` suele ser "la cifra coincide pero generaliza un poco", y eso es
    un juicio que le corresponde a quien investiga, no un motivo para negarle
    la respuesta entera. Ademas VIAJA a la interfaz marcado en ambar, asi que
    lo ve.

    Lo que no se relaja es la garantia: una atribucion falsa nunca sale.
    """
    if informe.citas_sin_resolver or informe.evidencia_sin_cubrir:
        return False
    # Sin ninguna comprobacion no se aprueba, aunque no haya bloqueantes: no
    # haberlos es lo que pasa cuando NADA se comprobo. Al relajar la puerta
    # para que `parcial` no bloqueara, esto quedo abierto un momento -si el
    # verificador se caia, el borrador salia entero sin auditar- y lo cazo el
    # test de Codex del critico caido. Ausencia de fallos no es evidencia de
    # que no los haya.
    if sin_senal(informe):
        return False
    return not bloqueantes(informe)


def _critica(informe: verificador.Verificacion) -> str:
    lineas: list[str] = []
    if not informe.ok:
        lineas.append(f"- La comprobacion no fue concluyente: {informe.nota}")
    for afirmacion in informe.afirmaciones:
        if afirmacion.veredicto == verificador.SOSTENIDA:
            continue
        cita = afirmacion.cita or "sin cita"
        motivo = afirmacion.motivo or "no quedo respaldada"
        lineas.append(
            f"- {afirmacion.veredicto}: {afirmacion.texto!r} ({cita}); {motivo}"
        )
    for punto in informe.evidencia_sin_cubrir:
        lineas.append(f"- Evidencia requerida sin cubrir: {punto}")
    if not lineas:
        lineas.append("- El borrador no supero la barrera de fidelidad.")
    # Corregir no siempre es posible: si el fragmento no dice lo que la
    # afirmacion afirma, no hay redaccion que lo arregle. Decirlo explicito
    # convierte una correccion imposible en una respuesta mas corta y honesta,
    # en vez de gastar la ronda y acabar en abstencion total.
    lineas.append(
        "- Corrige lo que puedas ajustando la afirmacion a lo que su fragmento "
        "sostiene. Lo que NO puedas respaldar, ELIMINALO de la respuesta y di "
        "que no lo encontraste: es mejor una respuesta mas corta y verificable "
        "que una completa que no se sostiene."
    )
    return "\n".join(lineas)


async def _corregir(
    pregunta: str,
    borrador: str,
    mensajes_con_evidencia: list[dict],
    informe: verificador.Verificacion,
) -> str:
    settings = get_settings()
    model = settings.openai_model
    started = time.perf_counter()
    mensajes = list(mensajes_con_evidencia)
    mensajes.extend(
        [
            {"role": "system", "content": _SYSTEM},
            {"role": "assistant", "content": borrador},
            {
                "role": "user",
                "content": (
                    f"Pregunta original: {pregunta}\n\n"
                    f"CRITICA DEL BORRADOR:\n{_critica(informe)}\n\n"
                    "Devuelve ahora la respuesta final corregida."
                ),
            },
        ]
    )
    try:
        async with openai_slot():
            response = await get_async_client().chat.completions.create(
                model=model,
                messages=mensajes,
            )
    except BaseException as exc:
        telemetry.current().record(
            "revisor", model, None,
            ms=(time.perf_counter() - started) * 1000.0,
            ok=False, note=str(exc)[:160],
        )
        raise

    choice = response.choices[0] if response.choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    telemetry.current().record(
        "revisor", getattr(response, "model", None) or model,
        getattr(response, "usage", None),
        ms=(time.perf_counter() - started) * 1000.0,
        ok=bool(content), finish_reason=getattr(choice, "finish_reason", None),
    )
    if not content or not content.strip():
        raise ValueError("el revisor respondio sin contenido")
    return content.strip()


async def revisar_antes_de_publicar(
    pregunta: str,
    borrador: str,
    mensajes_con_evidencia: list[dict],
    chunks: list[Chunk],
    evidencia_requerida: dict[str, str] | None = None,
) -> ResultadoRevision:
    """Verifica, corrige y vuelve a verificar antes de liberar texto."""
    settings = get_settings()
    if not borrador.strip():
        informe_vacio = await verificador.verificar(
            ABSTENCION_SEGURA, chunks, evidencia_requerida=None
        )
        return ResultadoRevision(
            ABSTENCION_SEGURA,
            informe_vacio,
            uso_abstencion_segura=True,
        )
    try:
        async with asyncio.timeout(max(1.0, settings.pre_response_review_timeout_s)):
            informe = await verificador.verificar(
                borrador, chunks, evidencia_requerida
            )
            if aprobada(informe):
                return ResultadoRevision(borrador, informe)

            # `ok=False` tambien se usa para una respuesta factual sin citas:
            # ese es un veredicto determinista y SI se puede corregir.
            #
            # Solo se aborta cuando el verificador no dictamino NADA, porque
            # entonces no hay critica con la que corregir. Antes se abortaba si
            # UNA CUALQUIERA quedaba sin veredicto, y eso era desproporcionado:
            # con 34 afirmaciones repartidas en lotes es normal que el modelo
            # omita algun indice, y en la sesion de estres dos preguntas tenian
            # 10 y 12 asi. Las dos habrian abstenido al instante sin gastar ni
            # una ronda de correccion.
            if sin_senal(informe):
                raise RuntimeError(informe.nota or "verificacion no disponible")

            actual = borrador
            for ronda in range(1, max(0, settings.pre_response_review_max_revisions) + 1):
                actual = await _corregir(
                    pregunta, actual, mensajes_con_evidencia, informe
                )
                informe = await verificador.verificar(
                    actual, chunks, evidencia_requerida
                )
                if aprobada(informe):
                    return ResultadoRevision(actual, informe, revisiones=ronda)
    except Exception as exc:
        logger.warning("Revision previa no disponible; abstencion segura (%s).", exc)

    informe_seguro = await verificador.verificar(
        ABSTENCION_SEGURA, chunks, evidencia_requerida=None
    )
    return ResultadoRevision(
        ABSTENCION_SEGURA,
        informe_seguro,
        revisiones=max(0, settings.pre_response_review_max_revisions),
        uso_abstencion_segura=True,
    )
