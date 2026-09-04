// Verificación de la respuesta final: cada afirmación contra su propia cita.
// Port de `backend/app/services/verificador.py`.
//
// Por qué existe, y por qué no basta con el calificador ni con el prompt de
// fidelidad: corrección y fidelidad de atribución son fallos distintos. Una
// respuesta puede ser cierta y aun así citar un fragmento que no sostiene lo
// que dice, o mezclar dos estudios en una frase con una sola cita. Para quien
// investiga, eso no es un detalle de estilo: es una afirmación que no puede
// rastrear hasta su fuente, y por tanto no puede usar.
//
// Cómo funciona:
//
// 1. La respuesta se parte en afirmaciones citadas, con el MISMO patrón de
//    citas que usa el evaluador (`lib/citas.ts`, idéntico al del backend). Que
//    la comprobación en caliente y la medición en frío cuenten lo mismo no es
//    casualidad: si divergieran, el benchmark dejaría de describir producción.
// 2. Cada afirmación se resuelve contra los fragmentos realmente recuperados,
//    por su `cita()`: la MISMA cadena entre corchetes que se entrega al modelo
//    para que la copie literal. Ojo, `localizador()` no vale aquí aunque el
//    nombre lo sugiera: devuelve solo la parte interna ("pág. 3") sin el
//    documento ni los corchetes, así que no casa con el patrón de citas. Una
//    cita que no resuelve es un fallo de trazabilidad y se marca sin gastar
//    una llamada al modelo.
// 3. Las que sí resuelven se mandan al modelo en lotes JSON PARALELOS, con el
//    texto de los fragmentos citados, para que dictamine si lo sostienen.
// 4. Con el mapa fragmento -> punto del plan que entrega el pipeline se
//    calcula, por código y sin modelo, qué puntos quedaron cubiertos, cuáles
//    solo parcialmente, cuáles tenían evidencia que la respuesta no usó y
//    cuáles no tenían nada en el índice (`_cobertura`).
//
// Tres decisiones de diseño que conviene no revertir sin pensarlo:
//
// - El veredicto por defecto es "sin verificar", nunca "sostenida". Si el
//   modelo falla o el JSON viene malformado, las afirmaciones quedan sin
//   verificar. Un verificador que ante la duda aprueba es peor que no tener
//   verificador, porque produce una garantía falsa.
// - No reescribe ni censura la respuesta: la anota y deja el fallo visible y
//   auditable. Reescribir es trabajo del revisor, que pide una corrección al
//   redactor con esta crítica en la mano.
// - No tumba la pregunta. Ante cualquier excepción se devuelve lo que se
//   pueda y queda registrado en telemetría.
import { ajustes, modeloVerificadorResuelto, type Ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import { Telemetria } from "../lib/telemetry";
import {
  CITA_INVENTARIO,
  cita,
  claveCita,
  fuente,
  nuevaRegexCitas,
  pareceAbstencion,
  type Fragmento,
} from "../lib/citas";

// Veredictos posibles de una afirmación. "sin_verificar" es el estado por
// defecto y el que se usa ante cualquier fallo: nunca se aprueba por omisión.
export const SOSTENIDA = "sostenida";
export const NO_SOSTENIDA = "no_sostenida";
export const PARCIAL = "parcial";
export const CITA_NO_RESUELVE = "cita_no_resuelve";
// Respuesta que afirma cosas y no cita NADA. Es el peor caso de todos, y
// durante un tiempo pasaba como "nada que atribuir": no hay citas que
// comprobar, luego no hay nada que reprochar. El razonamiento estaba al
// revés. Una abstención legítima tampoco lleva citas, así que las dos se
// distinguen por el TEXTO, con los mismos patrones que el evaluador.
export const SIN_CITA = "sin_cita";
export const SIN_VERIFICAR = "sin_verificar";

const VEREDICTOS_MODELO: ReadonlySet<string> = new Set([SOSTENIDA, NO_SOSTENIDA, PARCIAL]);

// Estados de cobertura de un punto del plan (contrato compartido con el
// frontend y con el revisor). Los calcula código, no el modelo. `PARCIAL` se
// reutiliza como estado de cobertura con el mismo literal.
export const CUBIERTO = "cubierto";
export const EVIDENCIA_NO_USADA = "evidencia_no_usada";
export const SIN_RESULTADOS = "sin_resultados";

// El ancla del plan es la pregunta literal del usuario. No es un punto de
// evidencia con el que medir cobertura: toda la respuesta "la cubre".
const ANCLA = "e0";

// Prompt del juez. El párrafo sobre declaraciones de ausencia cambió respecto
// al Python: allí una frase de abstención no llegaba nunca al juez, así que
// bastaba con pedirle "parcial" por si acaso. Aquí SÍ llega cuando lleva cita
// (ver `_trocear`), porque "No hay evidencia de que reduzca la mortalidad
// [cita]" es una afirmación sobre esa fuente y puede ser justo lo contrario de
// lo que dice el fragmento. El juez tiene que poder decir "no_sostenida" en
// ese caso y "parcial" solo cuando el fragmento no trata el asunto.
//
// Segunda diferencia, por un defecto medido en el despliegue real (paper de
// Alzheimer's & Dementia, 5 puntos del plan): la frase "el seguimiento fue
// anual hasta 12 años, con duración media de 7.9 ± 3.3 años y N visitas"
// iba seguida de TRES citas ([pág. 1] [pág. 4] [pág. 5]) y cada fragmento
// sostenía una parte. El juez la condenó tres veces ("pág. 1 no da la
// duración media", "pág. 4 no sostiene el seguimiento anual") y esas tres
// no_sostenidas mandaron una respuesta buena a la abstención segura. Ahora
// la frase llega UNA vez con los fragmentos de todas sus citas, y el prompt
// dice que con citas distintas la evidencia está repartida.
const SISTEMA = `Eres un verificador de atribución en literatura científica. Para
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

Una afirmación puede traer fragmentos de citas DISTINTAS: la frase iba
seguida de varias citas ("... [pág. 1] [pág. 4] [pág. 5]") y la cabecera de
cada fragmento dice cuál es la suya. Entonces la evidencia está REPARTIDA y
"sostenida" significa que cada parte de la afirmación está en alguno de los
fragmentos, no que uno solo la contenga entera. No la condenes porque ningún
fragmento la diga completa; condénala solo si alguna parte no está en
ninguno o alguno la contradice.

Una frase que DECLARA ausencia de evidencia ("No hay evidencia de que X",
"los documentos no indican Y") y va atribuida a un fragmento es una
afirmación SOBRE ese fragmento y se dictamina como las demás: "sostenida" si
el fragmento dice eso mismo (que no hubo efecto, que no se midió, que no hay
datos); "no_sostenida" si el fragmento dice lo contrario (sí hay evidencia,
sí lo mide, sí lo reporta), que es el caso grave: un hallazgo negativo
colgado de una fuente que dice lo opuesto. Si el fragmento simplemente no
trata el asunto, devuélvela "parcial" con motivo "declaración de ausencia,
no una atribución": no bloquea y no cuenta como atribución confirmada.

Sé estricto con las atribuciones: en investigación médica, aprobar una
atribución dudosa es el fallo caro.

Devuelve solo JSON con esta forma, un objeto por afirmación recibida:
{"veredictos":[{"i":0,"veredicto":"sostenida","motivo":"por qué, en una frase"}]}`;

// Corta un tramo en frases. Una afirmación es el tramo de texto que termina
// en una cita: es la unidad que el prompt del agente exige ("TODA afirmación
// factual debe llevar su cita"), así que es también la unidad auditable.
const FIN_DE_FRASE = /(?<=[.;:!?])\s+/;
// Una "frase" sin ninguna letra ni dígito no afirma nada: es puntuación
// suelta, una viñeta o un separador.
const TIENE_CONTENIDO = /[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
// Un dígito dentro de una declaración de ausencia delata que además afirma
// algo ("No hay datos de X, pero el AUC fue 0,94").
const TIENE_DIGITO = /\d/;
// Una línea que es un encabezado Markdown: "## Resultados" o "**Lo que no
// está**". El Python solo reconocía los encabezados que acaban en ":", y el
// modelo actual escribe los suyos en negrita: sin esto, "**Lo que no está**"
// se auditaba contra la cita de la frase siguiente como si afirmara algo, y
// el juez lo condenaba. La forma en negrita se limita a líneas cortas y sin
// dígitos para no tragarse una afirmación entera en negrita ("**El AUC fue
// 0.94**"), que sí hay que auditar.
const ENCABEZADO_MD = /^\s*(?:#{1,6}\s+\S[^\n]*|\*\*[^*\n\d]{1,80}\*\*:?)\s*$/;

/** Un tramo de respuesta con la cita que lo respalda, y su veredicto. */
export interface Afirmacion {
  texto: string;
  cita: string;
  veredicto: string;
  motivo: string;
  // `cita()` del fragmento con el que resolvió, si resolvió. Se conserva por
  // compatibilidad con el frontend; para trazar hay que usar `fragmentos`.
  fragmento_id: string;
  // `_id` de TODOS los fragmentos que comparten esa cita (hermanos de la
  // misma página o sección). La cobertura por punto se calcula con estos ids,
  // nunca con la cita, porque la cita no es única.
  fragmentos: string[];
}

/** Estado de un punto del plan, calculado por código a partir del mapa. */
export interface CoberturaPunto {
  id: string;
  evidence_needed: string;
  estado: "cubierto" | "parcial" | "evidencia_no_usada" | "sin_resultados";
  n_fragmentos: number;
  documentos: string[];
  afirmaciones: number[];
}

/** Resultado de auditar una respuesta. Viaja tal cual al mensaje. */
export interface Verificacion {
  afirmaciones: Afirmacion[];
  // Puntos del plan cuya evidencia recuperada la respuesta NO usó. Con mapa
  // son exactamente los ids con estado `evidencia_no_usada` (nunca los
  // `sin_resultados`: que el índice no tenga nada no es un fallo del
  // redactor). Sin mapa se conserva la lectura antigua, todo o nada.
  evidencia_sin_cubrir: string[];
  // Estado de cada punto del plan (sin el ancla e0).
  cobertura: CoberturaPunto[];
  // Citas que no corresponden a ningún fragmento recuperado. Es el fallo más
  // grave: la respuesta apunta a una fuente que no existe en esta consulta.
  citas_sin_resolver: string[];
  // Proporción de afirmaciones sostenidas sobre las juzgadas. null cuando no
  // se juzgó ninguna: 0.0 diría "todas mal" y sería mentira.
  fidelidad: number | null;
  ok: boolean;
  nota: string;
}

function afirmacion(campos: Partial<Afirmacion> & { texto: string; cita: string }): Afirmacion {
  return {
    veredicto: SIN_VERIFICAR,
    motivo: "",
    fragmento_id: "",
    fragmentos: [],
    ...campos,
  };
}

function informeVacio(campos: Partial<Verificacion> = {}): Verificacion {
  return {
    afirmaciones: [],
    evidencia_sin_cubrir: [],
    cobertura: [],
    citas_sin_resolver: [],
    fidelidad: null,
    ok: true,
    nota: "",
    ...campos,
  };
}

// --- Troceo --------------------------------------------------------------

/** Si una frase tiene algo que juzgar, sea cual sea su papel en el tramo.
 *
 *  Se descartan tres cosas que no afirman nada sobre una fuente y solo
 *  producirían veredictos sin sentido:
 *
 *  - los encabezados: de lista ("Los hallazgos son:") y de Markdown ("##
 *    Resultados", "**Lo que no está**");
 *  - los restos sin contenido: tras una cita queda el punto de la frase
 *    anterior, que sin este filtro se colaba como una afirmación cuyo texto
 *    entero era ".";
 *  - una frase que YA trae su cita de inventario está atribuida: no se le
 *    puede colgar la cita de fragmento que venga después. Sin esto, "hay 12
 *    documentos indexados [inventario del índice]" se juzgaba contra un
 *    fragmento de un paper, y salía no sostenida con razón. */
function tieneAlgoQueJuzgar(frase: string): boolean {
  if (!frase || frase.endsWith(":")) return false;
  if (ENCABEZADO_MD.test(frase)) return false;
  if (!TIENE_CONTENIDO.test(frase)) return false;
  if (CITA_INVENTARIO.test(frase)) return false;
  return true;
}

/** Si una frase es una declaración PURA de ausencia y por tanto no se audita.
 *
 *  Es la regla corregida tras la revisión adversarial del port de Python. La
 *  regla anterior ("una frase que casa con los patrones de abstención no se
 *  audita, con cita o sin ella") nació de un fallo real: en la sesión de
 *  estrés, "No encuentro la mortalidad a 90 días en los documentos" iba
 *  pegada a la frase citada siguiente, quedaba adosada a esa cita, el juez la
 *  dictaminaba no_sostenida y ese bloqueante tumbaba la respuesta entera en
 *  abstención segura: la conducta que el prompt del agente PIDE, castigada.
 *
 *  Pero era demasiado ancha y dejaba pasar dos cosas graves: un hallazgo
 *  negativo atribuido a una fuente ("No hay evidencia de que reduzca la
 *  mortalidad [cita]") es una AFIRMACIÓN sobre esa fuente y puede ser lo
 *  contrario de lo que dice el fragmento; y una cita inventada pegada a una
 *  frase así nunca llegaba a `citas_sin_resolver`. Por eso esta función NO se
 *  aplica a la frase dueña de la cita (esa se audita siempre, ver
 *  `_trocear`), y solo salta una frase si además de casar con los patrones
 *  no contiene ningún dígito: "No hay datos de X, pero el AUC fue 0,94"
 *  afirma una cifra y tiene que auditarse. */
function esAusenciaPura(frase: string): boolean {
  return pareceAbstencion(frase) && !TIENE_DIGITO.test(frase);
}

/** Un trozo auditable: el texto y las citas que lo respaldan (ninguna en la cola). */
export interface Trozo {
  texto: string;
  /** Cada cita por separado, en orden de aparición. */
  citas: string[];
  /** Las citas tal cual aparecen en el texto ("[a] [b]"); "" en la cola. */
  cita: string;
}

/** Las frases auditables de un tramo.
 *
 *  Un encabezado Markdown no acaba en puntuación, así que el corte por fin de
 *  frase lo pegaba a la viñeta siguiente ("**Lo que no está**\n- Dos") y esa
 *  "frase" se juzgaba con el encabezado dentro; y si la viñeta estaba vacía,
 *  el encabezado solo pasaba por afirmación. Por eso cada línea de encabezado
 *  se separa como frase propia antes de cortar, y `tieneAlgoQueJuzgar` la
 *  descarta. */
function frasesDe(tramo: string): string[] {
  const segmentos: string[] = [];
  let pendiente: string[] = [];
  const cierra = () => {
    if (pendiente.length) segmentos.push(pendiente.join("\n"));
    pendiente = [];
  };
  for (const linea of tramo.split("\n")) {
    if (ENCABEZADO_MD.test(linea)) {
      cierra();
      segmentos.push(linea);
    } else {
      pendiente.push(linea);
    }
  }
  cierra();
  return segmentos
    .flatMap((seg) => seg.split(FIN_DE_FRASE))
    .map((f) => f.trim())
    .filter(tieneAlgoQueJuzgar);
}

/** Si un texto contiene alguna frase que se auditaría: con contenido y que no
 *  sea una declaración pura de ausencia. Lo usa el revisor para saber si al
 *  quitar una frase con sus citas dejaría sin respaldo a las que la preceden
 *  en el mismo tramo. */
export function _tieneAfirmaciones(tramo: string): boolean {
  return frasesDe(tramo).some((f) => !esAusenciaPura(f));
}

interface CitaHallada {
  texto: string;
  inicio: number;
  fin: number;
}

/** Las citas de un trozo tal cual aparecen en el texto. Las consecutivas se
 *  toman en un solo corte del original, con lo que haya entre ellas ("[a] [b]",
 *  "[a], [b]"); si hubiera grupos separados por texto se unen con un espacio. */
function citasTalCual(respuesta: string, citas: CitaHallada[]): string {
  const grupos: string[] = [];
  let inicio = citas[0].inicio;
  let fin = citas[0].fin;
  for (const c of citas.slice(1)) {
    if (TIENE_CONTENIDO.test(respuesta.slice(fin, c.inicio))) {
      grupos.push(respuesta.slice(inicio, fin));
      inicio = c.inicio;
    }
    fin = c.fin;
  }
  grupos.push(respuesta.slice(inicio, fin));
  return grupos.join(" ");
}

function trozoDe(respuesta: string, texto: string, citas: CitaHallada[]): Trozo {
  return {
    texto,
    citas: citas.map((c) => c.texto),
    cita: citas.length ? citasTalCual(respuesta, citas) : "",
  };
}

/** Parte la respuesta en (texto, cita) por cada cita que aparece.
 *
 *  El texto asociado a una cita es lo que va desde el final de la cita
 *  anterior hasta ella: es exactamente lo que esa cita respalda según el
 *  contrato del prompt del agente. Dentro de ese tramo:
 *
 *  - la ÚLTIMA frase con contenido es la dueña de la cita (la cita va pegada
 *    a ella) y se audita SIEMPRE, diga lo que diga; su cita tiene que
 *    resolver contra un fragmento recuperado;
 *  - las demás frases del tramo se auditan contra la misma cita, salvo las
 *    declaraciones puras de ausencia (`esAusenciaPura`), que se saltan sin
 *    contar como sin_cita. Se auditan TODAS, no solo la última: antes se
 *    auditaba únicamente la última y el resto desaparecía del informe, así
 *    que una lista de cinco viñetas con una sola cita al final reportaba
 *    "1 afirmación, fidelidad 1.0". Eso es la garantía falsa que este módulo
 *    existe para impedir, y además el propio prompt del agente empuja a ese
 *    formato ("no repitas la misma cita en cada punto de una lista"). La
 *    lectura correcta del contrato es que la cita de cierre respalda el
 *    tramo COMPLETO;
 *  - varias citas seguidas ("dato [a] [b]", "[a], [b]") son citas de la MISMA
 *    frase: producen UN solo trozo con todas, que se juzgará contra la unión
 *    de sus fragmentos. Es el defecto medido en el despliegue: una frase con
 *    tres citas cuya unión la sostenía entera se condenaba tres veces, una
 *    por cada fragmento que solo sostenía su parte. Y como todas respaldan
 *    el tramo completo, se añaden también a las demás frases del tramo. El
 *    Python descartaba en silencio la cita con tramo vacío, y así una cita
 *    inventada en esa posición nunca llegaba a `citas_sin_resolver`: el
 *    mismo hueco que la trampa medida, por otra puerta. Una cita delante de
 *    todo texto se adosa a la primera frase que la sigue.
 *
 *  Lo que aparece DESPUÉS de la última cita no puede quedar invisible: antes,
 *  "dato correcto [fuente]. Además, AUC 0.99" daba fidelidad 1.0 porque la
 *  segunda afirmación nunca entraba al informe. La cola sigue el mismo
 *  criterio de las frases no dueñas: una declaración pura de ausencia se
 *  salta; cualquier otra frase queda con cita "" (sin_cita).
 *
 *  `hayCitas` dice si apareció alguna cita en todo el texto: es lo único que
 *  decide si `pareceAbstencion` sobre la respuesta ENTERA tiene la palabra. */
export function _trocear(respuesta: string): { trozos: Trozo[]; hayCitas: boolean } {
  // Se acumulan textos con sus citas halladas y se convierten en trozos al
  // final, porque una cita consecutiva se añade a TODAS las frases del tramo
  // en curso después de haberlas emitido.
  const acumulado: Array<{ texto: string; citas: CitaHallada[] }> = [];
  let ultimoFin = 0;
  let hayCitas = false;
  // Posiciones en `acumulado` de las frases del tramo en curso.
  let indicesTramo: number[] = [];
  // Citas que aparecieron antes de cualquier frase con contenido.
  let huerfanas: CitaHallada[] = [];

  for (const m of respuesta.matchAll(nuevaRegexCitas())) {
    hayCitas = true;
    const inicio = m.index ?? 0;
    const hallada: CitaHallada = { texto: m[0], inicio, fin: inicio + m[0].length };
    const tramo = respuesta.slice(ultimoFin, inicio).trim();
    ultimoFin = hallada.fin;

    const frases = frasesDe(tramo);
    if (!frases.length) {
      // Cita consecutiva: la frase iba seguida de varias, y todas respaldan
      // el mismo tramo. Sin frase anterior, queda a la espera de la primera.
      if (indicesTramo.length) {
        for (const k of indicesTramo) acumulado[k].citas.push(hallada);
      } else {
        huerfanas.push(hallada);
      }
      continue;
    }

    indicesTramo = [];
    frases.forEach((frase, k) => {
      const esDuena = k === frases.length - 1;
      // Una cita que iba delante de todo el texto pertenece a la primera
      // frase que la sigue, que pasa a ser dueña de ella.
      const previas = k === 0 ? huerfanas : [];
      if (!esDuena && !previas.length && esAusenciaPura(frase)) return;
      indicesTramo.push(acumulado.length);
      acumulado.push({ texto: frase, citas: [...previas, hallada] });
    });
    huerfanas = [];
  }

  const cola = respuesta.slice(ultimoFin).trim();
  if (hayCitas && cola) {
    for (const frase of frasesDe(cola)) {
      if (huerfanas.length) {
        // Las citas iban delante de todo el texto: esta es la frase que las contiene.
        acumulado.push({ texto: frase, citas: huerfanas });
        huerfanas = [];
        continue;
      }
      if (!esAusenciaPura(frase)) acumulado.push({ texto: frase, citas: [] });
    }
  }
  // Respuesta que es solo citas, sin una frase con contenido: no se pierden.
  if (huerfanas.length) acumulado.push({ texto: respuesta.trim().slice(0, 400), citas: huerfanas });

  return {
    trozos: acumulado.map(({ texto, citas }) => trozoDe(respuesta, texto, citas)),
    hayCitas,
  };
}

// --- Resolución de citas y juez -------------------------------------------

/** Fragmentos agrupados por su cita completa, normalizada con `claveCita`.
 *
 *  El valor es una LISTA y no un fragmento, porque `cita()` NO es única: su
 *  localizador es la página o la sección, y con fragmentos de ~400 tokens una
 *  página de paper a dos columnas produce dos o tres, los tres con la misma
 *  cita. Cuando esto era un mapa de un solo fragmento se quedaba con el
 *  último de cada página, y entonces una afirmación sacada del fragmento A se
 *  dictaminaba contra el texto del fragmento B: producía `no_sostenida`
 *  falsos y, peor, `sostenida` falsos cuando el hermano decía algo parecido.
 *
 *  La comparación es laxa en forma y estricta en contenido: el modelo copia
 *  la cita literal, pero un espacio de diferencia no debería contar como cita
 *  inventada. */
function indiceDeFragmentos(fragmentos: Fragmento[]): Map<string, Fragmento[]> {
  const indice = new Map<string, Fragmento[]>();
  for (const ch of fragmentos) {
    const clave = claveCita(cita(ch));
    const lista = indice.get(clave);
    if (lista) lista.push(ch);
    else indice.set(clave, [ch]);
  }
  return indice;
}

/** Cabecera de un fragmento en el prompt del juez: fuente · sección · tipo.
 *
 *  El juez decide "misma población, mismo alcance" mejor si sabe de qué
 *  documento, sección y tipo de fragmento viene el texto: una fila de tabla
 *  y un párrafo de discusión no sostienen lo mismo aunque compartan cifra. */
function cabecera(ch: Fragmento, n: number, total: number): string {
  const seccion = ch.section?.trim() || "sin sección";
  const tipo = ch.chunkType === "table" ? "tabla" : "texto";
  return (
    `FRAGMENTO ${n} DE ${total} (${cita(ch)}) · fuente: ${fuente(ch)} · ` +
    `sección: ${seccion} · tipo: ${tipo}`
  );
}

interface Pendiente {
  // Posición de la afirmación en la lista final del informe.
  pos: number;
  af: Afirmacion;
  fragmentos: Fragmento[];
}

type Fallos = Map<number, { veredicto: string; motivo: string }>;

/** Una petición JSON con un lote de afirmaciones que hay que juzgar.
 *
 *  Cada afirmación puede traer VARIOS fragmentos, por dos vías: una misma
 *  cita corresponde a todos los de su página o sección (ver
 *  `indiceDeFragmentos`), y una frase puede ir seguida de varias citas
 *  distintas (ver `_trocear`). Se envían todos con su cabecera, y en el
 *  segundo caso se etiqueta la afirmación como evidencia repartida: está
 *  respaldada si cada parte está en alguno de ellos.
 *
 *  Va con razonamiento (`razonamientoVerificador`): el dictamen "misma cifra
 *  pero distinta población" es justo el tipo de comparación que sin razonar
 *  salía a ojo. Si la API rechaza el parámetro, `crearCompletion` reintenta
 *  sin él en vez de perder el lote, y aquí se cuenta en telemetría. */
async function dictaminar(pendientes: Pendiente[], a: Ajustes, tel: Telemetria): Promise<Fallos> {
  const modelo = modeloVerificadorResuelto(a);
  const t0 = Date.now();

  const bloques = pendientes.map(({ af, fragmentos }, i) => {
    const cuerpo = fragmentos
      .map((ch, n) => `    ${cabecera(ch, n + 1, fragmentos.length)}: ${ch.text}`)
      .join("\n");
    // Con citas distintas la evidencia está repartida, y se le dice al juez
    // en la propia afirmación para que no la condene por no estar entera en
    // ninguno de los fragmentos (defecto medido, ver `SISTEMA`).
    const citasDistintas = new Set(fragmentos.map((ch) => claveCita(cita(ch)))).size;
    const etiqueta = citasDistintas > 1 ? ` (evidencia repartida en ${citasDistintas} citas)` : "";
    return `[${i}] AFIRMACIÓN${etiqueta}: ${af.texto}\n${cuerpo}`;
  });

  const kwargs: Record<string, unknown> = {
    model: modelo,
    temperature: a.temperatura,
    messages: [
      { role: "system", content: SISTEMA },
      { role: "user", content: bloques.join("\n\n") },
    ],
    ...gateway.razonamiento(a.razonamientoVerificador),
  };

  let r: Awaited<ReturnType<typeof gateway.completionJson>>;
  try {
    r = await gateway.completionJson(kwargs, a);
  } catch (exc) {
    tel.anota("verificador", modelo, null, {
      ms: Date.now() - t0,
      ok: false,
      nota: String(exc).slice(0, 160),
    });
    throw exc;
  }
  if (r.razonamientoRechazado) tel.incr("razonamiento_rechazado");

  // Se anota DESPUÉS de mirar la forma de la respuesta: una sin lista de
  // veredictos no es una ronda "ok" aunque el gateway haya respondido 200.
  const crudos: unknown = r.datos?.veredictos;
  const conLista = Array.isArray(crudos);
  tel.anota("verificador", r.modelo || modelo, r.usage, {
    ms: Date.now() - t0,
    ok: conLista,
    finishReason: r.finishReason,
    nota: conLista
      ? `afirmaciones=${pendientes.length}`
      : `afirmaciones=${pendientes.length}; respuesta sin lista veredictos`,
  });
  if (!conLista) throw new Error("respuesta sin lista veredictos");

  const fallos: Fallos = new Map();
  for (const raw of crudos as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    // Solo un número o una cadena numérica: `Number(true)` es 1 y colaría un
    // veredicto en la afirmación equivocada.
    if (typeof obj.i !== "number" && typeof obj.i !== "string") continue;
    const i = Number(obj.i);
    if (!Number.isInteger(i) || i < 0 || i >= pendientes.length) continue;
    const veredicto = String(obj.veredicto ?? "").trim().toLowerCase();
    if (!VEREDICTOS_MODELO.has(veredicto)) continue;
    fallos.set(i, { veredicto, motivo: String(obj.motivo ?? "").trim().slice(0, 200) });
  }
  return fallos;
}

/** Todos los lotes EN PARALELO. Devuelve los veredictos, la nota y si cayeron todos.
 *
 *  Por qué en lotes y no recortando al tope: antes las afirmaciones que
 *  excedían el tope quedaban `sin_verificar`, y eso convertía el tope en un
 *  agujero silencioso justo en las respuestas largas, que son las que más
 *  afirman: una sesión de estrés midió 34 y 36 afirmaciones en respuestas
 *  donde 10 y 12 se quedaron sin juzgar. El tope acota el TAMAÑO DE CADA
 *  PETICIÓN (una lista larga en un solo JSON degrada el dictamen), no cuánto
 *  se verifica.
 *
 *  Por qué en paralelo: los lotes eran secuenciales y con tres o cuatro por
 *  respuesta la verificación sola se comía medio presupuesto de la revisión
 *  (90 s). La plaza del gateway sigue acotando la concurrencia real.
 *
 *  Por qué `allSettled`: un lote caído no puede tirar los veredictos de los
 *  otros. Antes una sola excepción vaciaba los fallos y todo quedaba
 *  `sin_verificar`, o sea sin señal, o sea abstención segura. Ahora solo si
 *  caen TODOS se devuelve `todosCaidos` sin veredictos; la semántica de
 *  `sinSenal` en revisor.ts depende exactamente de esto. */
async function dictaminarEnLotes(
  pendientes: Pendiente[],
  lote: number,
  a: Ajustes,
  tel: Telemetria,
): Promise<{ fallos: Fallos; nota: string; todosCaidos: boolean }> {
  const trozos: Pendiente[][] = [];
  for (let i = 0; i < pendientes.length; i += lote) trozos.push(pendientes.slice(i, i + lote));

  const resultados = await Promise.allSettled(trozos.map((t) => dictaminar(t, a, tel)));

  const fallos: Fallos = new Map();
  const caidos: string[] = [];
  resultados.forEach((res, k) => {
    if (res.status === "rejected") {
      const inicio = k * lote;
      caidos.push(
        `lote ${k + 1}/${trozos.length} (afirmaciones ${inicio}-` +
          `${inicio + trozos[k].length - 1}): ${String(res.reason).slice(0, 120)}`,
      );
      console.warn(`Lote ${k + 1} del verificador no disponible (${String(res.reason)})`);
      return;
    }
    for (const [local, veredicto] of res.value) fallos.set(k * lote + local, veredicto);
  });

  if (!caidos.length) return { fallos, nota: "", todosCaidos: false };
  if (caidos.length === trozos.length) {
    return { fallos: new Map(), nota: `el verificador no pudo dictaminar: ${caidos[0]}`, todosCaidos: true };
  }
  return {
    fallos,
    nota:
      `el verificador no pudo dictaminar ${caidos.length} de ${trozos.length} lotes; ` +
      `sus afirmaciones quedan sin_verificar: ${caidos.join("; ")}`,
    todosCaidos: false,
  };
}

// --- Cobertura por punto del plan -----------------------------------------

/** Estado de cada punto del plan a partir del mapa fragmento -> punto.
 *
 *  Función pura, sin modelo. Para cada punto distinto del ancla, en el orden
 *  del plan:
 *
 *  - sin fragmentos en el mapa -> `sin_resultados`: el índice no tenía nada,
 *    y eso no es un fallo del redactor sino un dato para quien investiga;
 *  - alguna afirmación SOSTENIDA usa un fragmento del punto -> `cubierto`;
 *  - lo usa alguna PARCIAL, o alguna que quedó SIN VERIFICAR -> `parcial`.
 *    La sin_verificar entra aquí a propósito: la respuesta SÍ usó esa
 *    evidencia (está citada, es trazable) y lo único que falta es el juicio
 *    del modelo; decir "no la usa" sería falso y mandaría al redactor a
 *    incorporar lo que ya está;
 *  - hay fragmentos y ninguna afirmación los usa, o solo los usan
 *    afirmaciones NO SOSTENIDAS -> `evidencia_no_usada`. Lo segundo cuenta
 *    como no usada porque una cita que no dice lo que la afirmación dice no
 *    es usar la evidencia, y tras corregir el bloqueante el punto quedará
 *    efectivamente sin cubrir.
 *
 *  Sobrecobertura ambigua: un fragmento traído por e1 y e3 cubre los dos. Se
 *  acepta antes que un falso "sin cubrir", porque un falso sin cubrir manda
 *  al redactor a rellenar un punto que ya está respondido y, si se empeña, a
 *  inventar. */
export function _cobertura(
  evidenciaRequerida: Record<string, string>,
  mapaPlan: Record<string, string[]>,
  afirmaciones: Afirmacion[],
  porId: ReadonlyMap<string, Fragmento>,
): CoberturaPunto[] {
  // Fragmentos por punto, en el orden estable del mapa (que es el orden en
  // que se entregaron al modelo).
  const fragmentosPorPunto = new Map<string, string[]>();
  for (const [cid, puntos] of Object.entries(mapaPlan)) {
    for (const p of puntos) {
      const lista = fragmentosPorPunto.get(p);
      if (lista) lista.push(cid);
      else fragmentosPorPunto.set(p, [cid]);
    }
  }

  const salida: CoberturaPunto[] = [];
  for (const [pid, necesidad] of Object.entries(evidenciaRequerida)) {
    if (pid === ANCLA) continue;
    const ids = fragmentosPorPunto.get(pid) ?? [];
    const conjunto = new Set(ids);
    const usadas: number[] = [];
    afirmaciones.forEach((af, i) => {
      if (af.fragmentos.some((f) => conjunto.has(f))) usadas.push(i);
    });
    const veredictos = new Set(usadas.map((i) => afirmaciones[i].veredicto));

    let estado: CoberturaPunto["estado"];
    if (!ids.length) estado = SIN_RESULTADOS;
    else if (veredictos.has(SOSTENIDA)) estado = CUBIERTO;
    else if (veredictos.has(PARCIAL) || veredictos.has(SIN_VERIFICAR)) estado = PARCIAL;
    else estado = EVIDENCIA_NO_USADA;

    const documentos: string[] = [];
    for (const cid of ids) {
      const ch = porId.get(cid);
      if (ch && !documentos.includes(fuente(ch))) documentos.push(fuente(ch));
    }
    salida.push({
      id: pid,
      evidence_needed: necesidad,
      estado,
      n_fragmentos: ids.length,
      documentos,
      afirmaciones: usadas,
    });
  }
  return salida;
}

/** Añade la cobertura por punto al informe cuando hay mapa.
 *
 *  Sin mapa se devuelve el informe tal cual, con la lectura antigua de
 *  `evidencia_sin_cubrir` (todo o nada), para no cambiar la semántica de
 *  quien todavía no lo pasa. Con mapa, `evidencia_sin_cubrir` pasa a ser la
 *  lista de puntos `evidencia_no_usada`: nunca los `sin_resultados`, porque
 *  con la cobertura por punto CUALQUIER pregunta con un punto legítimamente
 *  ausente del corpus acabaría marcada como incompleta para siempre.
 *
 *  Se aplica también a la abstención completa, al inventario y a la
 *  respuesta sin citas: la médica tiene que ver, incluso cuando el sistema
 *  se abstiene, qué puntos tenían evidencia recuperada y cuáles no. */
function conCobertura(
  informe: Verificacion,
  evidenciaRequerida: Record<string, string> | null | undefined,
  mapaPlan: Record<string, string[]> | null | undefined,
  fragmentos: Fragmento[],
): Verificacion {
  if (mapaPlan == null || !evidenciaRequerida || !Object.keys(evidenciaRequerida).length) {
    return informe;
  }
  const porId = new Map(fragmentos.map((ch) => [ch._id, ch] as const));
  const cobertura = _cobertura(evidenciaRequerida, mapaPlan, informe.afirmaciones, porId);
  return {
    ...informe,
    cobertura,
    evidencia_sin_cubrir: cobertura.filter((c) => c.estado === EVIDENCIA_NO_USADA).map((c) => c.id),
  };
}

// --- Entrada ----------------------------------------------------------------

/** Audita `respuesta` contra `fragmentos`. No lanza: informa.
 *
 *  `evidenciaRequerida` son los puntos del plan (id -> evidence_needed).
 *  `mapaPlan` es `_id` del fragmento -> ids de los puntos que lo recuperaron;
 *  con él la cobertura se calcula POR PUNTO (ver `_cobertura`); sin él se
 *  conserva la lectura antigua, todo o nada. e0 se excluye de la cobertura. */
export async function verificar(
  respuesta: string,
  fragmentos: Fragmento[],
  evidenciaRequerida: Record<string, string> | null = null,
  mapaPlan: Record<string, string[]> | null = null,
  tel?: Telemetria,
): Promise<Verificacion> {
  const a = ajustes();
  const t = tel ?? new Telemetria();
  const { trozos, hayCitas } = _trocear(respuesta);

  if (!hayCitas) {
    // Sin ninguna cita hay dos casos opuestos y hay que separarlos, porque
    // tratarlos igual convierte el fallo más grave en un visto bueno. Es el
    // ÚNICO sitio donde `pareceAbstencion` sobre el texto entero decide algo.
    if (pareceAbstencion(respuesta)) {
      return conCobertura(
        informeVacio({ nota: "la respuesta se abstiene y no cita: correcto, nada que atribuir" }),
        evidenciaRequerida,
        mapaPlan,
        fragmentos,
      );
    }
    if (CITA_INVENTARIO.test(respuesta)) {
      // Respuesta de inventario: cita el catálogo del índice, que es la
      // fuente correcta y exacta para "cuántos documentos hay". No hay
      // fragmento contra el que dictaminar, y no haberlo no es un fallo.
      return conCobertura(
        informeVacio({
          nota:
            "la respuesta cita el inventario del índice: es un conteo exacto, " +
            "no una atribución a un fragmento",
        }),
        evidenciaRequerida,
        mapaPlan,
        fragmentos,
      );
    }
    // Afirma cosas y no respalda ninguna. En investigación médica esto no es
    // un aviso, es la respuesta inutilizable: no se puede rastrear nada
    // hasta su fuente. Se reporta como una afirmación no citada que abarca
    // toda la respuesta, y con fidelidad 0.0 en vez de null: aquí sí se
    // midió, y el resultado es que nada está respaldado.
    return conCobertura(
      informeVacio({
        afirmaciones: [
          afirmacion({
            texto: respuesta.trim().slice(0, 400),
            cita: "",
            veredicto: SIN_CITA,
            motivo:
              "la respuesta afirma sin citar ninguna fuente y no se declara " +
              "ausencia de evidencia",
          }),
        ],
        evidencia_sin_cubrir: Object.keys(evidenciaRequerida ?? {}).sort(),
        fidelidad: 0.0,
        ok: false,
        nota: "respuesta sin una sola cita que no es una abstención",
      }),
      evidenciaRequerida,
      mapaPlan,
      fragmentos,
    );
  }

  const indice = indiceDeFragmentos(fragmentos);
  const afirmaciones: Afirmacion[] = [];
  const pendientes: Pendiente[] = [];
  const citasSinResolver: string[] = [];
  let haySinCita = false;

  for (const trozo of trozos) {
    const { texto } = trozo;
    if (!trozo.citas.length) {
      haySinCita = true;
      afirmaciones.push(
        afirmacion({
          texto,
          cita: "",
          veredicto: SIN_CITA,
          motivo: "afirmación posterior a la última cita, sin fuente propia",
        }),
      );
      continue;
    }
    // Unión de los hermanos de TODAS las citas de la frase, sin repetir. Una
    // cita que no resuelve va a `citas_sin_resolver` (bloquea la publicación
    // hasta que se quite) y la afirmación se sigue juzgando contra las que
    // sí resuelven; solo si no resuelve ninguna es CITA_NO_RESUELVE.
    const hermanos: Fragmento[] = [];
    const vistos = new Set<string>();
    for (const c of trozo.citas) {
      const lista = indice.get(claveCita(c));
      if (!lista?.length) {
        citasSinResolver.push(c);
        continue;
      }
      for (const ch of lista) {
        if (vistos.has(ch._id)) continue;
        vistos.add(ch._id);
        hermanos.push(ch);
      }
    }
    if (!hermanos.length) {
      afirmaciones.push(
        afirmacion({
          texto,
          cita: trozo.cita,
          veredicto: CITA_NO_RESUELVE,
          motivo:
            trozo.citas.length > 1
              ? "ninguna de las citas corresponde a un fragmento recuperado"
              : "la cita no corresponde a ningún fragmento recuperado",
        }),
      );
      continue;
    }
    const af = afirmacion({
      texto,
      cita: trozo.cita,
      fragmento_id: cita(hermanos[0]),
      fragmentos: hermanos.map((c) => c._id),
    });
    pendientes.push({ pos: afirmaciones.length, af, fragmentos: hermanos });
    afirmaciones.push(af);
  }

  let nota = "";
  let ok = !haySinCita;
  if (pendientes.length) {
    const lote = Math.max(1, Math.floor(a.maxAfirmacionesPorLote) || 1);
    const resultado = await dictaminarEnLotes(pendientes, lote, a, t);
    nota = resultado.nota;
    if (resultado.todosCaidos) {
      // Se conserva lo determinista (las citas que no resuelven) y se deja
      // constancia de que el juicio del modelo no llegó.
      ok = false;
    }
    pendientes.forEach(({ pos, af }, i) => {
      const fallo = resultado.fallos.get(i);
      if (fallo) afirmaciones[pos] = { ...af, veredicto: fallo.veredicto, motivo: fallo.motivo };
    });
  }

  const juzgadas = afirmaciones.filter((x) => VEREDICTOS_MODELO.has(x.veredicto));
  const fidelidad = juzgadas.length
    ? juzgadas.filter((x) => x.veredicto === SOSTENIDA).length / juzgadas.length
    : null;

  // Cobertura del plan sin mapa: un punto está cubierto si alguna afirmación
  // sostenida resolvió contra un fragmento. Es deliberadamente conservador:
  // no se da por cubierto un punto apoyado solo en una atribución dudosa.
  // Sin trazabilidad fragmento -> punto no se puede atribuir cada evidencia
  // a su búsqueda, así que solo se reporta el caso inequívoco: no hay ni una
  // afirmación sostenida. Con mapa, `conCobertura` lo sustituye por el
  // cálculo por punto.
  let sinCubrir: string[] = [];
  if (evidenciaRequerida && Object.keys(evidenciaRequerida).length) {
    if (!afirmaciones.some((x) => x.veredicto === SOSTENIDA)) {
      sinCubrir = Object.keys(evidenciaRequerida).sort();
    }
  }

  return conCobertura(
    informeVacio({
      afirmaciones,
      evidencia_sin_cubrir: sinCubrir,
      citas_sin_resolver: citasSinResolver,
      fidelidad,
      ok,
      nota,
    }),
    evidenciaRequerida,
    mapaPlan,
    fragmentos,
  );
}
