"""Verificación de la respuesta final: cada afirmación contra su propia cita.

Por qué existe, y por qué no basta con el reranker ni con el prompt de
fidelidad: **corrección y fidelidad de atribución son fallos distintos**. Una
respuesta puede ser cierta y aun así citar un fragmento que no sostiene lo que
dice, o mezclar dos estudios en una frase con una sola cita. Para quien
investiga, eso no es un detalle de estilo: es una afirmación que no puede
rastrear hasta su fuente, y por tanto no puede usar.

Cómo funciona:

1. La respuesta se parte en afirmaciones citadas, con el MISMO regex de citas
   que usa el evaluador offline (`app.evaluation`). Que la comprobación en
   caliente y la medición en frío cuenten lo mismo no es casualidad: si
   divergieran, el benchmark dejaría de describir lo que hace producción.
2. Cada afirmación se resuelve contra los fragmentos realmente recuperados,
   por su `Chunk.cite()`: la MISMA cadena entre corchetes que `_format_results`
   entrega al modelo para que la copie literal. Ojo, `Chunk.locator()` no vale
   aquí, aunque el nombre lo sugiera: devuelve solo la parte interna ("pág. 3")
   sin el documento ni los corchetes, así que no matchea el regex de citas.
   Una cita que no resuelve es un fallo de trazabilidad y se marca sin gastar
   una llamada al modelo.
3. Las que sí resuelven se mandan al modelo en UN solo request JSON, con el
   texto del fragmento citado, para que dictamine si lo sostiene.

Tres decisiones de diseño que conviene no revertir sin pensarlo:

- **El veredicto por defecto es "sin verificar", nunca "sostenida".** Si el
  modelo falla, si el JSON viene malformado o si la respuesta excede
  `verifier_max_claims`, las afirmaciones quedan sin verificar. Un verificador
  que ante la duda aprueba es peor que no tener verificador, porque produce
  una garantía falsa.
- **No reescribe ni censura la respuesta.** El usuario ya la leyó mientras
  streameaba; borrarla a posteriori sería peor experiencia y ocultaría el
  problema. Lo que hace es anotarla, y dejar el fallo visible y auditable.
- **No tumba la pregunta.** Igual que el reranker, ante cualquier excepción se
  devuelve lo que se pueda y queda registrado en telemetría.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field

from app.config import get_settings
from app.evaluation import CITATION_RE
from app.models import Chunk
from app.services import telemetry
from app.services.openai_client import get_async_client, openai_slot

logger = logging.getLogger(__name__)

# Veredictos posibles de una afirmación. "sin_verificar" es el estado por
# defecto y el que se usa ante cualquier fallo: nunca se aprueba por omisión.
SOSTENIDA = "sostenida"
NO_SOSTENIDA = "no_sostenida"
PARCIAL = "parcial"
CITA_NO_RESUELVE = "cita_no_resuelve"
SIN_VERIFICAR = "sin_verificar"

_VEREDICTOS_MODELO = {SOSTENIDA, NO_SOSTENIDA, PARCIAL}

_SYSTEM = """Eres un verificador de atribución en literatura científica. Para
cada afirmación recibes el texto del fragmento que la respuesta citó. Dictamina
SOLO si ese fragmento sostiene la afirmación; no juzgues si es verdad en el
mundo, ni aportes conocimiento propio, ni corrijas la redacción.

- "sostenida": el fragmento afirma lo que dice la afirmación, incluidas sus
  cifras, su población y su dirección.
- "parcial": el fragmento sostiene una parte pero no toda (por ejemplo, la
  cifra coincide pero la población o el desenlace no, o la afirmación
  generaliza más de lo que el fragmento permite).
- "no_sostenida": el fragmento no lo dice, dice otra cosa, o dice lo contrario.

Una cifra que no aparece en el fragmento nunca es "sostenida". Sé estricto: en
investigación médica, aprobar una atribución dudosa es el fallo caro.

Devuelve solo JSON con esta forma, un objeto por afirmación recibida:
{"veredictos":[{"i":0,"veredicto":"sostenida","motivo":"por qué, en una frase"}]}"""

# Corta una respuesta en unidades verificables. Una afirmación es el tramo de
# texto que termina en una cita: es la unidad que el prompt del agente exige
# ("TODA afirmación factual debe llevar su cita"), así que es también la unidad
# que se puede auditar.
_FIN_DE_FRASE = re.compile(r"(?<=[.;:!?])\s+")


@dataclass(frozen=True)
class Afirmacion:
    """Un tramo de respuesta con la cita que lo respalda, y su veredicto."""

    texto: str
    cita: str
    veredicto: str = SIN_VERIFICAR
    motivo: str = ""
    # `cite()` del fragmento con el que resolvió la cita, si resolvió.
    fragmento_id: str = ""


@dataclass(frozen=True)
class Verificacion:
    """Resultado de auditar una respuesta. Se serializa al evento SSE."""

    afirmaciones: list[Afirmacion] = field(default_factory=list)
    # Puntos del plan de evidencia que ninguna afirmación sostenida cubre.
    evidencia_sin_cubrir: list[str] = field(default_factory=list)
    # Citas que no corresponden a ningún fragmento recuperado. Es el fallo más
    # grave: la respuesta apunta a una fuente que no existe en esta consulta.
    citas_sin_resolver: list[str] = field(default_factory=list)
    # Proporción de afirmaciones sostenidas sobre las verificadas. None cuando
    # no se verificó ninguna: 0.0 diría "todas mal" y sería mentira.
    fidelidad: float | None = None
    ok: bool = True
    nota: str = ""

    def to_payload(self) -> dict:
        return {
            "afirmaciones": [asdict(a) for a in self.afirmaciones],
            "evidencia_sin_cubrir": self.evidencia_sin_cubrir,
            "citas_sin_resolver": self.citas_sin_resolver,
            "fidelidad": self.fidelidad,
            "ok": self.ok,
            "nota": self.nota,
        }


def _trocear(answer: str) -> list[tuple[str, str]]:
    """Parte la respuesta en (texto, cita) por cada cita que aparece.

    El texto asociado a una cita es lo que va desde el final de la cita
    anterior hasta ella: es exactamente lo que esa cita respalda según el
    contrato del prompt del agente.
    """
    salida: list[tuple[str, str]] = []
    ultimo_fin = 0
    for m in CITATION_RE.finditer(answer):
        tramo = answer[ultimo_fin : m.start()].strip()
        ultimo_fin = m.end()
        if not tramo:
            continue
        # De un tramo largo con varias frases, la afirmación que la cita
        # respalda es la última: las anteriores ya llevaban la suya o son
        # texto de enlace.
        frases = [f for f in _FIN_DE_FRASE.split(tramo) if f.strip()]
        texto = frases[-1].strip() if frases else tramo
        salida.append((texto, m.group(0)))
    return salida


def _indice_de_fragmentos(chunks: list[Chunk]) -> dict[str, Chunk]:
    """Fragmentos indexados por su cita completa, en minúsculas y normalizada.

    La comparación es laxa en forma y estricta en contenido: el modelo copia la
    cita literal, pero un espacio de diferencia no debería contar como cita
    inventada.
    """
    return {" ".join(ch.cite().casefold().split()): ch for ch in chunks}


async def _dictaminar(
    pendientes: list[tuple[int, Afirmacion, Chunk]],
) -> dict[int, tuple[str, str]]:
    """Un único request JSON con todas las afirmaciones que hay que juzgar."""
    settings = get_settings()
    model = settings.verifier_model_resolved
    tel = telemetry.current()
    t0 = time.perf_counter()

    bloques = []
    for i, (_, af, ch) in enumerate(pendientes):
        bloques.append(
            f"[{i}] AFIRMACIÓN: {af.texto}\n"
            f"    FRAGMENTO CITADO ({ch.cite()}): {ch.text}"
        )
    payload = "\n\n".join(bloques)

    try:
        async with openai_slot():
            resp = await get_async_client().chat.completions.create(
                model=model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": payload},
                ],
            )
    except Exception as exc:
        tel.record(
            "verificador", model, None, ms=(time.perf_counter() - t0) * 1000.0,
            ok=False, note=str(exc)[:160],
        )
        raise

    choice = resp.choices[0] if resp.choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    tel.record(
        "verificador", getattr(resp, "model", None) or model,
        getattr(resp, "usage", None), ms=(time.perf_counter() - t0) * 1000.0,
        ok=bool(content), finish_reason=getattr(choice, "finish_reason", None),
        note=f"afirmaciones={len(pendientes)}",
    )
    if not content:
        raise ValueError("el verificador respondió sin contenido")

    data = json.loads(content)
    crudos = data.get("veredictos")
    if not isinstance(crudos, list):
        raise ValueError("respuesta sin lista veredictos")

    fallos: dict[int, tuple[str, str]] = {}
    for raw in crudos:
        if not isinstance(raw, dict):
            continue
        try:
            i = int(raw.get("i"))
        except (TypeError, ValueError):
            continue
        if not 0 <= i < len(pendientes):
            continue
        veredicto = str(raw.get("veredicto") or "").strip().casefold()
        if veredicto not in _VEREDICTOS_MODELO:
            continue
        fallos[i] = (veredicto, str(raw.get("motivo") or "").strip()[:200])
    return fallos


async def verificar(
    answer: str,
    chunks: list[Chunk],
    evidencia_requerida: dict[str, str] | None = None,
) -> Verificacion:
    """Audita `answer` contra `chunks`. No lanza: informa.

    `evidencia_requerida` son los puntos del plan (`PlanItem.id` →
    `evidence_needed`). Se usa para reportar qué quedó sin cubrir; si no se
    planificó, se omite esa parte.
    """
    settings = get_settings()
    troceado = _trocear(answer)
    if not troceado:
        # Una respuesta sin ninguna cita puede ser legítima (abstención) o el
        # peor caso posible (afirmaciones sin respaldo). Aquí no se puede
        # distinguir, así que no se inventa un veredicto.
        return Verificacion(
            ok=True,
            nota="la respuesta no contiene citas; nada que atribuir",
        )

    indice = _indice_de_fragmentos(chunks)
    afirmaciones: list[Afirmacion] = []
    pendientes: list[tuple[int, Afirmacion, Chunk]] = []
    citas_sin_resolver: list[str] = []

    for texto, cita in troceado:
        clave = " ".join(cita.casefold().split())
        ch = indice.get(clave)
        if ch is None:
            citas_sin_resolver.append(cita)
            afirmaciones.append(
                Afirmacion(
                    texto=texto, cita=cita, veredicto=CITA_NO_RESUELVE,
                    motivo="la cita no corresponde a ningún fragmento recuperado",
                )
            )
            continue
        af = Afirmacion(texto=texto, cita=cita, fragmento_id=ch.cite())
        if len(pendientes) < settings.verifier_max_claims:
            pendientes.append((len(afirmaciones), af, ch))
        else:
            af = Afirmacion(
                texto=texto, cita=cita, fragmento_id=ch.cite(),
                motivo=f"por encima del tope de {settings.verifier_max_claims} afirmaciones",
            )
        afirmaciones.append(af)

    nota = ""
    ok = True
    if pendientes:
        try:
            fallos = await _dictaminar(pendientes)
        except Exception as exc:
            # Se conserva lo determinista (las citas que no resuelven) y se
            # deja constancia de que el juicio del modelo no llegó.
            ok = False
            nota = f"el verificador no pudo dictaminar: {str(exc)[:160]}"
            logger.warning("Verificación no disponible (%s).", exc)
            fallos = {}
        for i, (pos, af, _) in enumerate(pendientes):
            if i not in fallos:
                continue
            veredicto, motivo = fallos[i]
            afirmaciones[pos] = Afirmacion(
                texto=af.texto, cita=af.cita, veredicto=veredicto,
                motivo=motivo, fragmento_id=af.fragmento_id,
            )

    juzgadas = [a for a in afirmaciones if a.veredicto in _VEREDICTOS_MODELO]
    fidelidad = (
        sum(1 for a in juzgadas if a.veredicto == SOSTENIDA) / len(juzgadas)
        if juzgadas
        else None
    )

    # Cobertura del plan: un punto está cubierto si alguna afirmación sostenida
    # resolvió contra un fragmento. Es deliberadamente conservador: no se da
    # por cubierto un punto apoyado solo en una atribución dudosa.
    sin_cubrir: list[str] = []
    if evidencia_requerida:
        respaldados = {a.fragmento_id for a in afirmaciones if a.veredicto == SOSTENIDA}
        if not respaldados:
            sin_cubrir = sorted(evidencia_requerida)
        else:
            # Sin trazabilidad fragmento→punto del plan no se puede atribuir
            # cada evidencia a su búsqueda, así que solo se reporta el caso
            # inequívoco: no hay ni una afirmación sostenida.
            sin_cubrir = []

    return Verificacion(
        afirmaciones=afirmaciones,
        evidencia_sin_cubrir=sin_cubrir,
        citas_sin_resolver=citas_sin_resolver,
        fidelidad=fidelidad,
        ok=ok,
        nota=nota,
    )
