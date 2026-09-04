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
  modelo falla o si el JSON viene malformado, las afirmaciones quedan sin
  verificar. Un verificador
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
from app.evaluation import ABSTENTION_PATTERNS, CITATION_RE
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
# Respuesta que afirma cosas y no cita NADA. Es el peor caso de todos, y
# durante un tiempo pasaba como "nada que atribuir": no hay citas que
# comprobar, luego no hay nada que reprochar. El razonamiento estaba al
# revés. Una abstención legítima tampoco lleva citas, así que las dos se
# distinguen por el TEXTO, con los mismos patrones que el evaluador.
SIN_CITA = "sin_cita"
SIN_VERIFICAR = "sin_verificar"

_VEREDICTOS_MODELO = {SOSTENIDA, NO_SOSTENIDA, PARCIAL}

_SYSTEM = """Eres un verificador de atribución en literatura científica. Para
cada afirmación recibes el texto de los fragmentos que la respuesta citó (una
misma cita puede corresponder a varios fragmentos de la misma página o
sección; basta con que UNO sostenga la afirmación). Dictamina
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
# Una "frase" sin ninguna letra ni digito no afirma nada: es puntuacion
# suelta, una viñeta o un separador.
_TIENE_CONTENIDO = re.compile(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]")

# La herramienta de inventario le dice al modelo que cite el catálogo del
# índice así (ver `_execute_inventory` en app/services/agent.py). NO casa con
# CITATION_RE, y con razón: no apunta a un fragmento, apunta a un conteo exacto
# de Qdrant. Pero hay que reconocerla, porque si no una respuesta de inventario
# -"tienes 12 documentos indexados y son estos"- se leía como una respuesta que
# afirma sin citar nada, o sea el peor veredicto posible, cuando en realidad
# citó la única fuente que existe para ese dato.
_CITA_INVENTARIO = re.compile(r"\[inventario del [ií]ndice\]", re.IGNORECASE)


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


def _parece_abstencion(answer: str) -> bool:
    """Si la respuesta dice que no encontró la información.

    Una abstención es el ÚNICO caso en que no citar nada es correcto, así que
    es la línea que separa "no hay nada que atribuir" de "afirmó sin respaldo".
    """
    return any(
        re.search(patron, answer, re.IGNORECASE) for patron in ABSTENTION_PATTERNS
    )


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
        # TODAS las frases del tramo, no solo la última. Antes se auditaba
        # únicamente la última y el resto desaparecía del informe -ni como
        # sostenida ni como sin_verificar-, así que una lista de cinco viñetas
        # con una sola cita al final reportaba "1 afirmación, fidelidad 1.0".
        # Eso es la garantía falsa que este módulo existe para impedir, y
        # además el propio prompt del agente empuja a ese formato: "no repitas
        # la misma cita en cada punto de una lista si todos salen del mismo
        # sitio". La lectura correcta del contrato es que la cita de cierre
        # respalda el tramo COMPLETO.
        for frase in _FIN_DE_FRASE.split(tramo):
            frase = frase.strip()
            # Se descartan tres cosas que no afirman nada y solo producirian
            # veredictos sin sentido: los encabezados de lista ("Los hallazgos
            # son:"), y los restos sin contenido -tras una cita queda el punto
            # de la frase anterior, que sin este filtro se colaba como una
            # afirmacion cuyo texto entero era "."-.
            if not frase or frase.endswith(":"):
                continue
            if not _TIENE_CONTENIDO.search(frase):
                continue
            # Una frase que YA trae su cita de inventario está atribuida: no se
            # le puede colgar la cita de fragmento que venga después. Sin esto,
            # "hay 12 documentos indexados [inventario del índice]" se juzgaba
            # contra un fragmento de un paper, y salía no sostenida con razón.
            if _CITA_INVENTARIO.search(frase):
                continue
            salida.append((frase, m.group(0)))

    # Lo que aparece DESPUES de la ultima cita no puede quedar invisible para
    # la auditoria. Antes, "dato correcto [fuente]. Ademas, AUC 0.99" daba
    # fidelidad 1.0 porque la segunda afirmacion nunca entraba al informe.
    cola = answer[ultimo_fin:].strip()
    if ultimo_fin > 0 and cola:
        for frase in _FIN_DE_FRASE.split(cola):
            frase = frase.strip()
            if not frase or frase.endswith(":") or not _TIENE_CONTENIDO.search(frase):
                continue
            if _CITA_INVENTARIO.search(frase) or _parece_abstencion(frase):
                continue
            salida.append((frase, ""))
    return salida


def _indice_de_fragmentos(chunks: list[Chunk]) -> dict[str, list[Chunk]]:
    """Fragmentos agrupados por su cita completa, en minúsculas y normalizada.

    El valor es una LISTA y no un fragmento, porque `cite()` NO es única: su
    localizador es la página o la sección (`Chunk.locator`), y con fragmentos
    de ~400 tokens una página de paper a dos columnas produce dos o tres, los
    tres con la misma cita. Cuando esto era un dict de un solo fragmento se
    quedaba con el último de cada página, y entonces una afirmación sacada del
    fragmento A se dictaminaba contra el texto del fragmento B: producía
    `no_sostenida` falsos y, peor, `sostenida` falsos cuando el hermano decía
    algo parecido.

    La comparación es laxa en forma y estricta en contenido: el modelo copia la
    cita literal, pero un espacio de diferencia no debería contar como cita
    inventada.
    """
    indice: dict[str, list[Chunk]] = {}
    for ch in chunks:
        indice.setdefault(" ".join(ch.cite().casefold().split()), []).append(ch)
    return indice


async def _dictaminar(
    pendientes: list[tuple[int, Afirmacion, list[Chunk]]],
) -> dict[int, tuple[str, str]]:
    """Un único request JSON con todas las afirmaciones que hay que juzgar.

    Cada afirmación puede traer VARIOS fragmentos, porque una misma cita
    corresponde a todos los de su página o sección (ver
    `_indice_de_fragmentos`). Se envían todos y basta con que uno la sostenga:
    la cita del modelo apunta a esa página, y la afirmación está respaldada si
    está en alguno de sus fragmentos.
    """
    settings = get_settings()
    model = settings.verifier_model_resolved
    tel = telemetry.current()
    t0 = time.perf_counter()

    bloques = []
    for i, (_, af, chs) in enumerate(pendientes):
        cuerpo = "\n".join(
            f"    FRAGMENTO {n} DE {len(chs)} ({ch.cite()}): {ch.text}"
            for n, ch in enumerate(chs, start=1)
        )
        bloques.append(f"[{i}] AFIRMACIÓN: {af.texto}\n{cuerpo}")
    payload = "\n\n".join(bloques)

    try:
        async with openai_slot():
            resp = await get_async_client().chat.completions.create(
                model=model,
                temperature=settings.llm_temperature,
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
        # Sin ninguna cita hay dos casos opuestos y hay que separarlos, porque
        # tratarlos igual convierte el fallo más grave en un visto bueno.
        if _parece_abstencion(answer):
            return Verificacion(
                ok=True,
                nota="la respuesta se abstiene y no cita: correcto, nada que atribuir",
            )
        if _CITA_INVENTARIO.search(answer):
            # Respuesta de inventario: cita el catálogo del índice, que es la
            # fuente correcta y exacta para "cuántos documentos hay". No hay
            # fragmento contra el que dictaminar, y no haberlo no es un fallo.
            return Verificacion(
                ok=True,
                nota=(
                    "la respuesta cita el inventario del índice: es un conteo "
                    "exacto, no una atribución a un fragmento"
                ),
            )
        # Afirma cosas y no respalda ninguna. En investigación médica esto no
        # es un aviso, es la respuesta inutilizable: no se puede rastrear nada
        # hasta su fuente. Se reporta como una afirmación no citada que abarca
        # toda la respuesta, y con fidelidad 0.0 en vez de None: aquí sí se
        # midió, y el resultado es que nada está respaldado.
        return Verificacion(
            afirmaciones=[
                Afirmacion(
                    texto=answer.strip()[:400],
                    cita="",
                    veredicto=SIN_CITA,
                    motivo=(
                        "la respuesta afirma sin citar ninguna fuente y no se "
                        "declara ausencia de evidencia"
                    ),
                )
            ],
            evidencia_sin_cubrir=sorted(evidencia_requerida or {}),
            fidelidad=0.0,
            ok=False,
            nota="respuesta sin una sola cita que no es una abstención",
        )

    indice = _indice_de_fragmentos(chunks)
    afirmaciones: list[Afirmacion] = []
    pendientes: list[tuple[int, Afirmacion, list[Chunk]]] = []
    citas_sin_resolver: list[str] = []

    hay_sin_cita = False
    for texto, cita in troceado:
        if not cita:
            hay_sin_cita = True
            afirmaciones.append(
                Afirmacion(
                    texto=texto,
                    cita="",
                    veredicto=SIN_CITA,
                    motivo="afirmacion posterior a la ultima cita, sin fuente propia",
                )
            )
            continue
        clave = " ".join(cita.casefold().split())
        chs = indice.get(clave)
        if not chs:
            citas_sin_resolver.append(cita)
            afirmaciones.append(
                Afirmacion(
                    texto=texto, cita=cita, veredicto=CITA_NO_RESUELVE,
                    motivo="la cita no corresponde a ningún fragmento recuperado",
                )
            )
            continue
        af = Afirmacion(texto=texto, cita=cita, fragmento_id=chs[0].cite())
        pendientes.append((len(afirmaciones), af, chs))
        afirmaciones.append(af)

    nota = ""
    ok = not hay_sin_cita
    if pendientes:
        try:
            # En LOTES de verifier_max_claims, no recortando a ese tope. Antes
            # las afirmaciones que lo excedían quedaban `sin_verificar`, y eso
            # convertía el tope en un agujero silencioso justo en las
            # respuestas largas, que son las que más afirman: una sesión de
            # estrés midió 34 y 36 afirmaciones en respuestas donde 10 y 12
            # se quedaron sin juzgar. El tope sigue existiendo, pero ahora
            # acota el TAMAÑO DE CADA PETICIÓN (una lista larga en un solo
            # JSON degrada el dictamen), no cuánto se verifica.
            fallos = {}
            lote = max(1, settings.verifier_max_claims)
            for i in range(0, len(pendientes), lote):
                trozo = pendientes[i : i + lote]
                for local, veredicto in (await _dictaminar(trozo)).items():
                    fallos[i + local] = veredicto
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
