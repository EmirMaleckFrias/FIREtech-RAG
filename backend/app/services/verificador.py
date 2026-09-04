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
3. Las que sí resuelven se mandan al modelo en lotes JSON PARALELOS, con el
   texto de los fragmentos citados, para que dictamine si lo sostienen.
4. Con el mapa fragmento→punto del plan que entrega el pipeline se calcula,
   por código y sin modelo, qué puntos del plan quedaron cubiertos, cuáles
   solo parcialmente, cuáles tenían evidencia que la respuesta no usó y
   cuáles no tenían nada en el índice (`_cobertura`).

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

import asyncio
import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field, replace

from app.config import get_settings
from app.evaluation import ABSTENTION_PATTERNS, CITATION_RE
from app.models import Chunk
from app.services import telemetry
from app.services.openai_client import (
    crear_completion,
    get_async_client,
    openai_slot,
    razonamiento,
)

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

# Estados de cobertura de un punto del plan (contrato compartido con el
# frontend y con el revisor). Los calcula código, no el modelo.
CUBIERTO = "cubierto"
EVIDENCIA_NO_USADA = "evidencia_no_usada"
SIN_RESULTADOS = "sin_resultados"
# `PARCIAL` se reutiliza como estado de cobertura con el mismo literal.

# El ancla del plan es la pregunta literal del usuario. No es un punto de
# evidencia con el que medir cobertura: toda la respuesta "la cubre".
_ANCLA = "e0"

_SYSTEM = """Eres un verificador de atribución en literatura científica. Para
cada afirmación recibes el texto de los fragmentos que la respuesta citó (una
misma cita puede corresponder a varios fragmentos de la misma página o
sección; basta con que UNO sostenga la afirmación). Cada fragmento va
precedido de su cabecera: documento, localizador, sección y tipo (texto o
tabla). Dictamina SOLO si ese fragmento sostiene la afirmación; no juzgues si
es verdad en el mundo, ni aportes conocimiento propio, ni corrijas la
redacción.

- "sostenida": el fragmento lo dice literalmente o en una paráfrasis fiel:
  la cifra, la unidad, la población y el sentido (dirección del efecto,
  comparación, signo) son los mismos. Redondear una cifra sin cambiar su
  magnitud o reordenar la frase no rompe la fidelidad.
- "parcial": el dato coincide pero la afirmación generaliza más de lo que el
  fragmento permite, o cambia la población, el desenlace o el alcance (por
  ejemplo, el fragmento habla de una cohorte y la afirmación lo extiende a
  todos los pacientes).
- "no_sostenida": el fragmento no lo dice, dice otra cosa, o dice lo
  contrario. Una cifra, unidad o población que no aparece en ninguno de los
  fragmentos nunca es "sostenida".

Una frase que DECLARA ausencia de evidencia ("No encuentro X en los
documentos", "los documentos no indican Y") no afirma nada sobre el
fragmento: nunca la dictamines "no_sostenida" porque el fragmento no hable
de X. Si te llega una, devuélvela "parcial" con motivo "declaración de
ausencia, no una atribución": no bloquea y no cuenta como atribución
confirmada.

Sé estricto con las atribuciones: en investigación médica, aprobar una
atribución dudosa es el fallo caro.

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
    # `cite()` del fragmento con el que resolvió la cita, si resolvió. Se
    # conserva por compatibilidad con el frontend y la telemetría; para
    # trazar hay que usar `fragmentos`.
    fragmento_id: str = ""
    # `Chunk.id` de TODOS los fragmentos que comparten esa cita (hermanos de
    # la misma página o sección). La cobertura por punto del plan se calcula
    # con estos ids, nunca con la cita, porque la cita no es única.
    fragmentos: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Verificacion:
    """Resultado de auditar una respuesta. Se serializa al evento SSE."""

    afirmaciones: list[Afirmacion] = field(default_factory=list)
    # Puntos del plan cuya evidencia recuperada la respuesta NO usó. Con mapa
    # fragmento→punto son exactamente los ids con estado `evidencia_no_usada`
    # (nunca los `sin_resultados`: que el índice no tenga nada no es un fallo
    # del redactor). Sin mapa se conserva la lectura antigua, todo o nada.
    evidencia_sin_cubrir: list[str] = field(default_factory=list)
    # Citas que no corresponden a ningún fragmento recuperado. Es el fallo más
    # grave: la respuesta apunta a una fuente que no existe en esta consulta.
    citas_sin_resolver: list[str] = field(default_factory=list)
    # Proporción de afirmaciones sostenidas sobre las verificadas. None cuando
    # no se verificó ninguna: 0.0 diría "todas mal" y sería mentira.
    fidelidad: float | None = None
    ok: bool = True
    nota: str = ""
    # Estado de cada punto del plan (sin el ancla e0), calculado por código a
    # partir del mapa fragmento→punto. Dicts con la forma
    # {id, evidence_needed, estado, n_fragmentos, documentos, afirmaciones},
    # estado ∈ cubierto | parcial | evidencia_no_usada | sin_resultados.
    cobertura: list[dict] = field(default_factory=list)

    def to_payload(self) -> dict:
        return {
            "afirmaciones": [asdict(a) for a in self.afirmaciones],
            "evidencia_sin_cubrir": self.evidencia_sin_cubrir,
            "cobertura": self.cobertura,
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


def _es_auditable(frase: str) -> bool:
    """Si una frase del tramo es una afirmación que hay que juzgar.

    Se descartan cuatro cosas que no afirman nada sobre una fuente y solo
    producirían veredictos sin sentido:

    - los encabezados de lista ("Los hallazgos son:");
    - los restos sin contenido: tras una cita queda el punto de la frase
      anterior, que sin este filtro se colaba como una afirmación cuyo texto
      entero era ".";
    - una frase que YA trae su cita de inventario está atribuida: no se le
      puede colgar la cita de fragmento que venga después. Sin esto, "hay 12
      documentos indexados [inventario del índice]" se juzgaba contra un
      fragmento de un paper, y salía no sostenida con razón;
    - una DECLARACIÓN DE AUSENCIA ("No encuentro la mortalidad a 90 días en
      los documentos"). No afirma nada sobre un fragmento, así que no hay
      nada que dictaminar contra él. Medido en la sesión de estrés: la frase
      de abstención iba pegada a la siguiente frase citada, quedaba adosada a
      esa cita, el juez la dictaminaba `no_sostenida` (el fragmento no habla
      de mortalidad, claro) y ese bloqueante tumbaba la respuesta entera en
      abstención segura. Es justo la conducta que el prompt del agente pide
      ("declara lo que no encuentres") castigada por auditarla como si fuera
      una atribución. Tampoco cuenta como `sin_cita` cuando va tras la última
      cita, por la misma razón. La detección de "toda la respuesta es una
      abstención" (`_parece_abstencion` sobre el texto completo) no cambia.
      Límite conocido y aceptado: una frase que mezcla la declaración y un
      dato ("No encuentro X, pero el AUC fue 0.94") se salta entera; el
      prompt del agente pide la fórmula en frase propia.
    """
    if not frase or frase.endswith(":"):
        return False
    if not _TIENE_CONTENIDO.search(frase):
        return False
    if _CITA_INVENTARIO.search(frase):
        return False
    if _parece_abstencion(frase):
        return False
    return True


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
            if _es_auditable(frase):
                salida.append((frase, m.group(0)))

    # Lo que aparece DESPUES de la ultima cita no puede quedar invisible para
    # la auditoria. Antes, "dato correcto [fuente]. Ademas, AUC 0.99" daba
    # fidelidad 1.0 porque la segunda afirmacion nunca entraba al informe.
    cola = answer[ultimo_fin:].strip()
    if ultimo_fin > 0 and cola:
        for frase in _FIN_DE_FRASE.split(cola):
            frase = frase.strip()
            if _es_auditable(frase):
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


def _cabecera(ch: Chunk, n: int, total: int) -> str:
    """Cabecera de un fragmento en el prompt del juez: fuente · sección · tipo.

    El juez decide "misma población, mismo alcance" mejor si sabe de qué
    documento, sección y tipo de fragmento viene el texto: una fila de tabla
    y un párrafo de discusión no sostienen lo mismo aunque compartan cifra.
    """
    seccion = ch.section.strip() if ch.section else "sin sección"
    tipo = "tabla" if ch.chunk_type == "table" else "texto"
    return (
        f"FRAGMENTO {n} DE {total} ({ch.cite()}) · fuente: {ch.fuente()} · "
        f"sección: {seccion} · tipo: {tipo}"
    )


async def _dictaminar(
    pendientes: list[tuple[int, Afirmacion, list[Chunk]]],
) -> dict[int, tuple[str, str]]:
    """Un request JSON con un lote de afirmaciones que hay que juzgar.

    Cada afirmación puede traer VARIOS fragmentos, porque una misma cita
    corresponde a todos los de su página o sección (ver
    `_indice_de_fragmentos`). Se envían todos y basta con que uno la sostenga:
    la cita del modelo apunta a esa página, y la afirmación está respaldada si
    está en alguno de sus fragmentos.

    Va con razonamiento (`verifier_reasoning_effort`) por `crear_completion`:
    el dictamen "misma cifra pero distinta población" es justo el tipo de
    comparación que sin razonar salía a ojo, y si la API rechaza el
    parámetro se reintenta sin él en vez de perder el lote.
    """
    settings = get_settings()
    model = settings.verifier_model_resolved
    tel = telemetry.current()
    t0 = time.perf_counter()

    bloques = []
    for i, (_, af, chs) in enumerate(pendientes):
        cuerpo = "\n".join(
            f"    {_cabecera(ch, n, len(chs))}: {ch.text}"
            for n, ch in enumerate(chs, start=1)
        )
        bloques.append(f"[{i}] AFIRMACIÓN: {af.texto}\n{cuerpo}")
    payload = "\n\n".join(bloques)

    kwargs = {
        "model": model,
        "temperature": settings.llm_temperature,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": payload},
        ],
        **razonamiento(settings.verifier_reasoning_effort),
    }
    try:
        async with openai_slot():
            resp = await crear_completion(get_async_client(), kwargs)
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


async def _dictaminar_en_lotes(
    pendientes: list[tuple[int, Afirmacion, list[Chunk]]],
    lote: int,
) -> tuple[dict[int, tuple[str, str]], str, bool]:
    """Todos los lotes EN PARALELO. Devuelve (veredictos, nota, todos_caidos).

    Por qué en lotes y no recortando al tope: antes las afirmaciones que
    excedían `verifier_max_claims` quedaban `sin_verificar`, y eso convertía
    el tope en un agujero silencioso justo en las respuestas largas, que son
    las que más afirman: una sesión de estrés midió 34 y 36 afirmaciones en
    respuestas donde 10 y 12 se quedaron sin juzgar. El tope acota el TAMAÑO
    DE CADA PETICIÓN (una lista larga en un solo JSON degrada el dictamen),
    no cuánto se verifica.

    Por qué en paralelo: los lotes eran secuenciales y con tres o cuatro por
    respuesta la verificación sola se comía medio presupuesto de la revisión
    (90 s). El semáforo de `openai_slot` sigue acotando la concurrencia real.

    Por qué `return_exceptions=True`: un lote caído no puede tirar los
    veredictos de los otros. Antes una sola excepción vaciaba `fallos` y todo
    quedaba `sin_verificar`, o sea sin señal, o sea abstención segura. Ahora
    solo si caen TODOS se devuelve `todos_caidos=True` sin veredictos; la
    semántica de `sin_senal` en revisor.py depende exactamente de esto.
    """
    trozos = [pendientes[i : i + lote] for i in range(0, len(pendientes), lote)]
    resultados = await asyncio.gather(
        *(_dictaminar(trozo) for trozo in trozos), return_exceptions=True
    )

    fallos: dict[int, tuple[str, str]] = {}
    caidos: list[str] = []
    for k, (trozo, res) in enumerate(zip(trozos, resultados)):
        if isinstance(res, BaseException):
            inicio = k * lote
            caidos.append(
                f"lote {k + 1}/{len(trozos)} (afirmaciones {inicio}-"
                f"{inicio + len(trozo) - 1}): {str(res)[:120]}"
            )
            logger.warning("Lote %d del verificador no disponible (%s).", k + 1, res)
            continue
        for local, veredicto in res.items():
            fallos[k * lote + local] = veredicto

    if not caidos:
        return fallos, "", False
    if len(caidos) == len(trozos):
        return {}, f"el verificador no pudo dictaminar: {caidos[0]}", True
    nota = (
        f"el verificador no pudo dictaminar {len(caidos)} de {len(trozos)} lotes; "
        "sus afirmaciones quedan sin_verificar: " + "; ".join(caidos)
    )
    return fallos, nota, False


def _cobertura(
    evidencia_requerida: dict[str, str],
    mapa_plan: dict[str, set[str]],
    afirmaciones: list[Afirmacion],
    por_id: dict[str, Chunk],
) -> list[dict]:
    """Estado de cada punto del plan a partir del mapa fragmento→punto.

    Función pura, sin modelo. Para cada punto distinto del ancla, en el orden
    del plan:

    - sin fragmentos en el mapa → `sin_resultados`: el índice no tenía nada,
      y eso no es un fallo del redactor sino un dato para quien investiga;
    - alguna afirmación SOSTENIDA usa un fragmento del punto → `cubierto`;
    - lo usa alguna PARCIAL, o alguna que quedó SIN VERIFICAR → `parcial`.
      La sin_verificar entra aquí a propósito: la respuesta SÍ usó esa
      evidencia (está citada, es trazable) y lo único que falta es el juicio
      del modelo; decir "no la usa" sería falso y mandaría al redactor a
      incorporar lo que ya está;
    - hay fragmentos y ninguna afirmación los usa, o solo los usan
      afirmaciones NO SOSTENIDAS → `evidencia_no_usada`. Lo segundo cuenta
      como no usada porque una cita que no dice lo que la afirmación dice no
      es usar la evidencia, y tras corregir el bloqueante el punto quedará
      efectivamente sin cubrir.

    Sobrecobertura ambigua: un fragmento traído por e1 y e3 cubre los dos.
    Se acepta antes que un falso "sin cubrir", porque un falso sin cubrir
    manda al redactor a rellenar un punto que ya está respondido y, si se
    empeña, a inventar.
    """
    # Fragmentos por punto, en el orden estable del mapa (que es el orden en
    # que se entregaron al modelo).
    fragmentos_por_punto: dict[str, list[str]] = {}
    for cid, puntos in mapa_plan.items():
        for p in puntos:
            fragmentos_por_punto.setdefault(p, []).append(cid)

    salida: list[dict] = []
    for pid, necesidad in evidencia_requerida.items():
        if pid == _ANCLA:
            continue
        ids = fragmentos_por_punto.get(pid, [])
        conjunto = set(ids)
        usadas = [
            i for i, a in enumerate(afirmaciones) if conjunto.intersection(a.fragmentos)
        ]
        veredictos = {afirmaciones[i].veredicto for i in usadas}
        if not ids:
            estado = SIN_RESULTADOS
        elif SOSTENIDA in veredictos:
            estado = CUBIERTO
        elif PARCIAL in veredictos or SIN_VERIFICAR in veredictos:
            estado = PARCIAL
        else:
            estado = EVIDENCIA_NO_USADA
        documentos: list[str] = []
        for cid in ids:
            ch = por_id.get(cid)
            if ch is not None and ch.fuente() not in documentos:
                documentos.append(ch.fuente())
        salida.append(
            {
                "id": pid,
                "evidence_needed": necesidad,
                "estado": estado,
                "n_fragmentos": len(ids),
                "documentos": documentos,
                "afirmaciones": usadas,
            }
        )
    return salida


def _con_cobertura(
    informe: Verificacion,
    evidencia_requerida: dict[str, str] | None,
    mapa_plan: dict[str, set[str]] | None,
    chunks: list[Chunk],
) -> Verificacion:
    """Añade la cobertura por punto al informe cuando hay mapa.

    Sin mapa se devuelve el informe tal cual, con la lectura antigua de
    `evidencia_sin_cubrir` (todo o nada), para no cambiar la semántica de
    quien todavía no lo pasa. Con mapa, `evidencia_sin_cubrir` pasa a ser la
    lista de puntos `evidencia_no_usada`: nunca los `sin_resultados`, porque
    con la cobertura por punto CUALQUIER pregunta con un punto legítimamente
    ausente del corpus acabaría marcada como incompleta para siempre.

    Se aplica también a la abstención completa, al inventario y a la
    respuesta sin citas: la médica tiene que ver, incluso cuando el sistema
    se abstiene, qué puntos tenían evidencia recuperada y cuáles no.
    """
    if mapa_plan is None or not evidencia_requerida:
        return informe
    por_id = {ch.id: ch for ch in chunks}
    cobertura = _cobertura(evidencia_requerida, mapa_plan, informe.afirmaciones, por_id)
    return replace(
        informe,
        cobertura=cobertura,
        evidencia_sin_cubrir=[
            c["id"] for c in cobertura if c["estado"] == EVIDENCIA_NO_USADA
        ],
    )


async def verificar(
    answer: str,
    chunks: list[Chunk],
    evidencia_requerida: dict[str, str] | None = None,
    mapa_plan: dict[str, set[str]] | None = None,
) -> Verificacion:
    """Audita `answer` contra `chunks`. No lanza: informa.

    `evidencia_requerida` son los puntos del plan (`PlanItem.id` →
    `evidence_needed`). `mapa_plan` es `Chunk.id` → ids de los puntos del plan
    que recuperaron ese fragmento; con él la cobertura se calcula POR PUNTO
    (ver `_cobertura`); sin él se conserva la lectura antigua, todo o nada.
    """
    settings = get_settings()
    troceado = _trocear(answer)
    if not troceado:
        # Sin ninguna cita hay dos casos opuestos y hay que separarlos, porque
        # tratarlos igual convierte el fallo más grave en un visto bueno.
        if _parece_abstencion(answer):
            return _con_cobertura(
                Verificacion(
                    ok=True,
                    nota="la respuesta se abstiene y no cita: correcto, nada que atribuir",
                ),
                evidencia_requerida, mapa_plan, chunks,
            )
        if _CITA_INVENTARIO.search(answer):
            # Respuesta de inventario: cita el catálogo del índice, que es la
            # fuente correcta y exacta para "cuántos documentos hay". No hay
            # fragmento contra el que dictaminar, y no haberlo no es un fallo.
            return _con_cobertura(
                Verificacion(
                    ok=True,
                    nota=(
                        "la respuesta cita el inventario del índice: es un conteo "
                        "exacto, no una atribución a un fragmento"
                    ),
                ),
                evidencia_requerida, mapa_plan, chunks,
            )
        # Afirma cosas y no respalda ninguna. En investigación médica esto no
        # es un aviso, es la respuesta inutilizable: no se puede rastrear nada
        # hasta su fuente. Se reporta como una afirmación no citada que abarca
        # toda la respuesta, y con fidelidad 0.0 en vez de None: aquí sí se
        # midió, y el resultado es que nada está respaldado.
        return _con_cobertura(
            Verificacion(
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
            ),
            evidencia_requerida, mapa_plan, chunks,
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
        af = Afirmacion(
            texto=texto, cita=cita, fragmento_id=chs[0].cite(),
            fragmentos=[c.id for c in chs],
        )
        pendientes.append((len(afirmaciones), af, chs))
        afirmaciones.append(af)

    nota = ""
    ok = not hay_sin_cita
    if pendientes:
        lote = max(1, settings.verifier_max_claims)
        fallos, nota, todos_caidos = await _dictaminar_en_lotes(pendientes, lote)
        if todos_caidos:
            # Se conserva lo determinista (las citas que no resuelven) y se
            # deja constancia de que el juicio del modelo no llegó.
            ok = False
        for i, (pos, af, _) in enumerate(pendientes):
            if i not in fallos:
                continue
            veredicto, motivo = fallos[i]
            afirmaciones[pos] = replace(af, veredicto=veredicto, motivo=motivo)

    juzgadas = [a for a in afirmaciones if a.veredicto in _VEREDICTOS_MODELO]
    fidelidad = (
        sum(1 for a in juzgadas if a.veredicto == SOSTENIDA) / len(juzgadas)
        if juzgadas
        else None
    )

    # Cobertura del plan sin mapa: un punto está cubierto si alguna afirmación
    # sostenida resolvió contra un fragmento. Es deliberadamente conservador:
    # no se da por cubierto un punto apoyado solo en una atribución dudosa.
    # Sin trazabilidad fragmento→punto no se puede atribuir cada evidencia a
    # su búsqueda, así que solo se reporta el caso inequívoco: no hay ni una
    # afirmación sostenida. Con mapa, `_con_cobertura` lo sustituye por el
    # cálculo por punto.
    sin_cubrir: list[str] = []
    if evidencia_requerida:
        if not any(a.veredicto == SOSTENIDA for a in afirmaciones):
            sin_cubrir = sorted(evidencia_requerida)

    return _con_cobertura(
        Verificacion(
            afirmaciones=afirmaciones,
            evidencia_sin_cubrir=sin_cubrir,
            citas_sin_resolver=citas_sin_resolver,
            fidelidad=fidelidad,
            ok=ok,
            nota=nota,
        ),
        evidencia_requerida, mapa_plan, chunks,
    )
