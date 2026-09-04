// Barrera de fidelidad previa a mostrar una respuesta.
// Port de `backend/app/services/revisor.py`, con una política de publicación
// QUIRÚRGICA que el Python no tenía (ver `revisarAntesDePublicar`).
//
// El agente principal redacta un borrador privado. El verificador lo confronta
// con los fragmentos recuperados y, si encuentra problemas, este revisor
// devuelve la crítica al modelo redactor para que produzca una versión
// corregida. Si tras las rondas de corrección quedan frases que no se
// sostienen, se ELIMINAN de forma determinista y se publica el resto, verificado
// otra vez. Solo una versión aprobada sale hacia el usuario; ante fallo o
// timeout se responde con una abstención segura.
import { ajustes, type Ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import { Telemetria } from "../lib/telemetry";
import { claveCita, nuevaRegexCitas, type Fragmento } from "../lib/citas";
import * as verificador from "./verificador";
import type { Afirmacion, Verificacion } from "./verificador";

const SISTEMA = `Eres el redactor final de un sistema RAG para investigación
médica. Recibes un borrador privado y el informe de un crítico que comparó cada
afirmación con sus fuentes recuperadas.

Corrige el borrador con estas reglas estrictas:
- conserva solo afirmaciones sostenidas literalmente por la evidencia;
- corrige o elimina toda afirmación parcial, no sostenida o sin cita;
- usa exclusivamente las citas literales disponibles en los resultados;
- no aportes conocimiento externo ni inventes fuentes, cifras o conclusiones;
- si falta evidencia para una parte, decláralo explícitamente;
- devuelve solamente la respuesta final corregida, sin explicar el proceso de
  revisión ni mencionar este mensaje.
`;

// Texto literal del Python. Casa con `PATRONES_ABSTENCION` ("no encuentro"),
// así que verificarlo no gasta ninguna llamada y siempre sale aprobado.
export const ABSTENCION_SEGURA =
  "No puedo ofrecer una respuesta verificable con la evidencia recuperada. " +
  "No encuentro respaldo suficiente en los documentos para responder con la " +
  "fidelidad requerida.";

export interface ResultadoRevision {
  contenido: string;
  informe: Verificacion;
  revisiones: number;
  usoAbstencionSegura: boolean;
  /** Por qué se cayó a la abstención segura, o null si se publicó texto.
   *  "timeout" | "sin_senal" | "rechazada_tras_correccion" | "borrador_vacio" | "error". */
  motivoAbstencion: string | null;
  /** El ÚLTIMO informe real del borrador (o de su corrección) cuando se
   *  abstuvo. Sin esto, una abstención segura era indiagnosticable: el
   *  informe que viajaba era el de la propia abstención, con cero
   *  afirmaciones, y no se podía saber si la barrera cayó por el reloj, por
   *  citas que no resolvían o por afirmaciones no sostenidas. Medido en la
   *  primera sesión de estrés sobre Convex: tres preguntas sobre papers
   *  acabaron en abstención y no había forma de saber por qué. */
  informeBorrador: Verificacion | null;
  /** Frases que la eliminación determinista quitó del texto publicado por no
   *  poder sostenerse con la evidencia (vacío si no hizo falta o se abstuvo). */
  frasesEliminadas: string[];
}

// Veredictos que son una ATRIBUCIÓN FALSA: la respuesta apunta a una fuente
// que no dice lo que ella dice. Es el daño concreto que esta barrera existe
// para impedir, y lo único que no puede salir hacia el usuario.
const BLOQUEANTES: ReadonlySet<string> = new Set([
  verificador.NO_SOSTENIDA,
  verificador.CITA_NO_RESUELVE,
  verificador.SIN_CITA,
]);

/** Afirmaciones cuya cita no las sostiene. */
export function bloqueantes(informe: Verificacion): Afirmacion[] {
  return informe.afirmaciones.filter((a) => BLOQUEANTES.has(a.veredicto));
}

/** El verificador no pudo dictaminar NADA: no hay con qué corregir.
 *
 *  Distinto de que alguna afirmación quede sin veredicto, que es normal y
 *  solo significa que esa no se comprobó. Con los lotes en paralelo del
 *  verificador esto solo ocurre si caen TODOS los lotes: uno caído deja sus
 *  afirmaciones `sin_verificar` y conserva el resto, así que sigue habiendo
 *  señal con la que corregir. */
export function sinSenal(informe: Verificacion): boolean {
  if (!informe.afirmaciones.length) return false;
  return informe.afirmaciones.every((a) => a.veredicto === verificador.SIN_VERIFICAR);
}

/** True si no queda ninguna atribución FALSA.
 *
 *  `parcial` y `sin_verificar` NO bloquean, y esto es deliberado. Antes se
 *  exigía que TODAS las afirmaciones estuvieran sostenidas, y medido contra
 *  una sesión de estrés de diez preguntas reales solo pasaban 3 (dos de ellas
 *  abstenciones con cero afirmaciones): las respuestas de contenido traen
 *  entre 15 y 36 afirmaciones y basta un matiz para tumbarlas. El usuario
 *  habría recibido "no puedo ofrecer una respuesta verificable" en 7 de cada
 *  10 preguntas.
 *
 *  Eso no es más seguro, es menos: una barrera que se dispara siempre enseña
 *  a ignorarla, y un investigador que recibe abstenciones constantes vuelve a
 *  leer los PDF a mano o se va a un chatbot sin verificación ninguna. Un
 *  `parcial` suele ser "la cifra coincide pero generaliza un poco", y eso es
 *  un juicio que le corresponde a quien investiga, no un motivo para negarle
 *  la respuesta entera. Además VIAJA a la interfaz marcado en ámbar, así que
 *  lo ve.
 *
 *  `evidencia_sin_cubrir` TAMPOCO bloquea. Bloqueaba, y con la cobertura por
 *  punto del plan eso habría sido letal: cualquier pregunta con un punto cuya
 *  evidencia recuperada la respuesta no usara habría acabado en abstención
 *  segura tras gastar el presupuesto entero (medido: 280 s para no decir
 *  nada), y un punto que el redactor decide no usar porque no responde a la
 *  pregunta es una decisión editorial, no una atribución falsa. La cobertura
 *  es INFORMACIÓN para la médica (que ve por punto qué hubo y qué no) y
 *  CRÍTICA para el redactor (que en la ronda de corrección recibe punto por
 *  punto qué incorporar o qué declarar ausente); no es motivo de abstención.
 *
 *  Lo que sigue sin salir nunca es la atribución falsa: una cita que no
 *  resuelve, una afirmación que su fragmento no sostiene, o una respuesta
 *  factual sin una sola cita. Pero "no sale" ya no significa "se abstiene de
 *  todo": ver la política quirúrgica en `revisarAntesDePublicar`. */
export function aprobada(informe: Verificacion): boolean {
  if (informe.citas_sin_resolver.length) return false;
  // Sin ninguna comprobación no se aprueba, aunque no haya bloqueantes: no
  // haberlos es lo que pasa cuando NADA se comprobó. Al relajar la puerta
  // para que `parcial` no bloqueara, esto quedó abierto un momento (si el
  // verificador se caía, el borrador salía entero sin auditar) y lo cazó el
  // test de un revisor externo del crítico caído. Ausencia de fallos no es
  // evidencia de que no los haya.
  if (sinSenal(informe)) return false;
  return bloqueantes(informe).length === 0;
}

/** Citas de `citas_sin_resolver` que no son ya la cita de una afirmación
 *  CITA_NO_RESUELVE: las que viajan pegadas a una frase que sí se sostiene
 *  con sus otras citas. Sin listarlas aparte, el redactor no sabría por qué
 *  la respuesta no se aprueba. */
function citasInventadasSueltas(informe: Verificacion): string[] {
  const salida: string[] = [];
  for (const c of informe.citas_sin_resolver) {
    if (salida.includes(c)) continue;
    const yaListada = informe.afirmaciones.some(
      (a) => a.veredicto === verificador.CITA_NO_RESUELVE && claveCita(a.cita).includes(claveCita(c)),
    );
    if (!yaListada) salida.push(c);
  }
  return salida;
}

export interface OpcionesCritica {
  /** Última ronda: en vez de pedir que corrija, ordena BORRAR literalmente las
   *  frases que siguen bloqueantes. Es lo que hace posible la publicación
   *  quirúrgica: si el redactor no las borra, las borra el código. */
  ordenarBorrado?: boolean;
}

/** La crítica que recibe el redactor: qué falló y qué hacer con cada punto. */
export function _critica(informe: Verificacion, opciones: OpcionesCritica = {}): string {
  const lineas: string[] = [];
  const haySinVerificar = informe.afirmaciones.some((a) => a.veredicto === verificador.SIN_VERIFICAR);
  // La nota del verificador se muestra si la comprobación no fue
  // concluyente, y también si un lote cayó dejando afirmaciones sin
  // verificar aunque `ok` siga en true: el redactor debe saber que esas no
  // están aprobadas, solo sin juzgar.
  if (!informe.ok || (informe.nota && haySinVerificar)) {
    lineas.push(`- La comprobación no fue concluyente: ${informe.nota}`);
  }
  for (const af of informe.afirmaciones) {
    if (af.veredicto === verificador.SOSTENIDA) continue;
    const citaTxt = af.cita || "sin cita";
    const motivo = af.motivo || "no quedó respaldada";
    lineas.push(`- ${af.veredicto}: '${af.texto.replace(/'/g, "\\'")}' (${citaTxt}); ${motivo}`);
  }
  const inventadas = citasInventadasSueltas(informe);
  for (const c of inventadas) {
    lineas.push(
      `- cita_no_resuelve: la cita ${c} no corresponde a ningún fragmento recuperado; ` +
        "quítala del texto (la frase que la lleva conserva las citas que sí resuelven)",
    );
  }
  // Cobertura por punto del plan. Al redactor se le dice EXACTAMENTE qué
  // hacer con cada punto, porque "evidencia sin cubrir: e2" no le sirve: no
  // sabe si e2 es algo que debe buscar en los fragmentos que ya tiene o algo
  // que el índice no tiene y debe declarar ausente. Confundir los dos casos
  // es lo que lleva a rellenar con conocimiento propio.
  for (const punto of informe.cobertura) {
    if (punto.estado === verificador.EVIDENCIA_NO_USADA) {
      const docs = punto.documentos.join(", ") || "los documentos recuperados";
      lineas.push(
        `- Punto ${punto.id} (${punto.evidence_needed}): se recuperaron ` +
          `${punto.n_fragmentos} fragmentos de ${docs} y la respuesta no los usa ` +
          "ni los descarta: incorpóralos con su cita o di explícitamente por qué " +
          "no responden al punto",
      );
    } else if (punto.estado === verificador.SIN_RESULTADOS) {
      lineas.push(
        `- Punto ${punto.id} (${punto.evidence_needed}): el índice no tiene evidencia; ` +
          "decláralo con la fórmula 'No encuentro ... en los documentos', no lo rellenes",
      );
    }
  }
  if (!informe.cobertura.length) {
    // Sin mapa fragmento -> punto solo existe la lectura antigua, todo o nada.
    for (const punto of informe.evidencia_sin_cubrir) {
      lineas.push(`- Evidencia requerida sin cubrir: ${punto}`);
    }
  }
  if (!lineas.length) lineas.push("- El borrador no superó la barrera de fidelidad.");

  if (opciones.ordenarBorrado) {
    // Última ronda. Medido en el despliegue: tras una ronda de "corrige o
    // elimina", el redactor tendía a REESCRIBIR la frase condenada, que
    // volvía a caer, y la respuesta entera acababa en abstención por una
    // sola frase. Aquí se le quita la opción: las frases que siguen sin
    // sostenerse se borran, y si no las borra él las borra el código.
    const frases = bloqueantes(informe);
    if (frases.length) {
      lineas.push(
        "- ÚLTIMA RONDA. Estas frases no se pueden sostener con la evidencia: bórralas, " +
          "ajusta la redacción alrededor y no las sustituyas por otras afirmaciones:",
      );
      for (const af of frases) lineas.push(`  "${af.texto}"${af.cita ? ` (${af.cita})` : ""}`);
    }
    if (inventadas.length) {
      lineas.push(
        "- Y quita del texto estas citas, que no corresponden a ningún fragmento " +
          `recuperado: ${inventadas.join(" ")}`,
      );
    }
    lineas.push(
      "- No reescribas las frases listadas: bórralas. El resto de la respuesta, " +
        "si está sostenido, se conserva tal cual.",
    );
    return lineas.join("\n");
  }
  // Corregir no siempre es posible: si el fragmento no dice lo que la
  // afirmación afirma, no hay redacción que lo arregle. Decirlo explícito
  // convierte una corrección imposible en una respuesta más corta y honesta,
  // en vez de gastar la ronda y acabar en abstención total.
  lineas.push(
    "- Corrige lo que puedas ajustando la afirmación a lo que su fragmento " +
      "sostiene. Lo que NO puedas respaldar, ELIMÍNALO de la respuesta y di " +
      "que no lo encontraste: es mejor una respuesta más corta y verificable " +
      "que una completa que no se sostiene.",
  );
  return lineas.join("\n");
}

/** Pide al redactor una versión corregida del borrador con la crítica. */
async function _corregir(
  pregunta: string,
  borrador: string,
  mensajesConEvidencia: Record<string, unknown>[],
  informe: Verificacion,
  a: Ajustes,
  tel: Telemetria,
  opciones: OpcionesCritica = {},
): Promise<string> {
  const modelo = a.modelo;
  const t0 = Date.now();
  const mensajes: Record<string, unknown>[] = [
    ...mensajesConEvidencia,
    { role: "system", content: SISTEMA },
    { role: "assistant", content: borrador },
    {
      role: "user",
      content:
        `Pregunta original: ${pregunta}\n\n` +
        `CRÍTICA DEL BORRADOR:\n${_critica(informe, opciones)}\n\n` +
        "Devuelve ahora la respuesta final corregida.",
    },
  ];
  // Misma temperatura que el redactor original (la corrección no debe variar
  // entre corridas más que el borrador) y razonamiento alto: cada ronda de
  // corrección tiene que resolver a la vez bloqueantes, puntos sin usar y
  // puntos ausentes sin inventar. `crearCompletion` reintenta sin
  // razonamiento si la API lo rechaza. Sin herramientas: aquí solo se
  // redacta, no se busca.
  const kwargs: Record<string, unknown> = {
    model: modelo,
    messages: mensajes,
    temperature: a.temperatura,
    ...gateway.razonamiento(a.razonamientoRevisor),
  };

  let r: Awaited<ReturnType<typeof gateway.crearCompletion>>;
  try {
    r = await gateway.crearCompletion(kwargs, a);
  } catch (exc) {
    tel.anota("revisor", modelo, null, {
      ms: Date.now() - t0,
      ok: false,
      nota: String(exc).slice(0, 160),
    });
    throw exc;
  }
  if (r.razonamientoRechazado) tel.incr("razonamiento_rechazado");

  const choice = r.datos?.choices?.[0];
  const contenido: unknown = choice?.message?.content;
  const texto = typeof contenido === "string" ? contenido.trim() : "";
  tel.anota("revisor", r.datos?.model || modelo, r.datos?.usage ? gateway.usoDe(r.datos.usage) : null, {
    ms: Date.now() - t0,
    ok: texto.length > 0,
    finishReason: choice?.finish_reason ?? null,
  });
  if (!texto) throw new Error("el revisor respondió sin contenido");
  return texto;
}

// --- Eliminación determinista -------------------------------------------------
//
// Último recurso antes de la abstención. Medido en el despliegue real: una
// respuesta con 22 afirmaciones sostenidas, 4 no sostenidas y fidelidad 0.85
// acabó entera en "no puedo ofrecer una respuesta verificable" porque la única
// ronda de corrección no arregló las 4. Quitar esas frases y publicar las 22
// es más seguro que abstenerse: la médica recibe todo lo que SÍ se sostiene y
// nada de lo que no.

const TIENE_CONTENIDO = /[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
// Tirada de citas (o corchetes de inventario) que sigue a una frase.
const TIRADA_CITAS = "(?:\\s*[,;]?\\s*\\[[^\\[\\]\\n]+\\])*";

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** El texto literal, tolerando cualquier espaciado: el troceado recorta los
 *  bordes de cada frase pero el contenido puede llevar saltos de línea o
 *  dobles espacios donde la frase lleva uno. */
function patronFlexible(texto: string): string {
  return escaparRegex(texto.trim()).replace(/\s+/g, "\\s+");
}

function citasIndividuales(cita: string): string[] {
  return [...cita.matchAll(nuevaRegexCitas())].map((m) => m[0]);
}

interface Localizacion {
  inicio: number;
  /** Fin de la frase, antes de sus citas. */
  finTexto: number;
  /** Fin de la frase con sus citas. */
  fin: number;
}

/** Dónde está la frase de una afirmación en el contenido, con la tirada de
 *  citas que la sigue. Si el texto aparece varias veces se prefiere la
 *  ocurrencia seguida de las citas de la afirmación. */
function localizar(contenido: string, af: Afirmacion): Localizacion | null {
  if (!af.texto.trim()) return null;
  const re = new RegExp(`(${patronFlexible(af.texto)})(${TIRADA_CITAS})`, "g");
  const candidatos = [...contenido.matchAll(re)];
  if (!candidatos.length) return null;
  const claves = citasIndividuales(af.cita).map(claveCita);
  const elegido =
    candidatos.find((m) => claves.length > 0 && claves.every((k) => claveCita(m[2]).includes(k))) ??
    candidatos[0];
  const inicio = elegido.index ?? 0;
  return { inicio, finTexto: inicio + elegido[1].length, fin: inicio + elegido[0].length };
}

/** Texto desde la cita anterior (o el principio) hasta `hasta`: el tramo que
 *  compartía las citas de la frase que se va a quitar. */
function tramoAnterior(texto: string, hasta: number): string {
  const antes = texto.slice(0, hasta);
  let finUltimaCita = 0;
  for (const m of antes.matchAll(nuevaRegexCitas())) finUltimaCita = (m.index ?? 0) + m[0].length;
  return antes.slice(finUltimaCita);
}

/** Quita `[inicio, fin)` y recompone la costura: la puntuación que quedaba
 *  colgando, el separador anterior y el hueco (conservando el salto de línea
 *  si lo había). */
function quitar(contenido: string, inicio: number, fin: number): string {
  const crudoAntes = contenido.slice(0, inicio);
  const crudoDespues = contenido.slice(fin);
  let antes = crudoAntes.replace(/\s+$/, "");
  let despues = crudoDespues.replace(/^\s+/, "");
  let hueco = crudoAntes.slice(antes.length) + crudoDespues.slice(0, crudoDespues.length - despues.length);

  const colgante = despues.match(/^[.;:,!?]+/);
  if (colgante) {
    if (/[,;:]$/.test(antes)) {
      // "X [a], B [b]. C" -> "X [a]. C": el cierre lo aporta lo que sigue.
      antes = antes.replace(/[,;:]+$/, "");
    } else if (antes === "" || /[.!?]$/.test(antes) || /(?:^|\n)[ \t]*(?:[-*•]|\d+[.)])?$/.test(antes)) {
      // La frase iba al principio del texto, de una línea o de una viñeta, o
      // tras otra frase ya cerrada: su punto ya no cierra nada.
      const resto = despues.slice(colgante[0].length);
      const blanco = resto.match(/^\s*/)?.[0] ?? "";
      hueco += blanco;
      despues = resto.slice(blanco.length);
    }
  }
  if (!antes) return despues;
  if (!despues) return antes;
  if (hueco.includes("\n")) return antes + (hueco.includes("\n\n") ? "\n\n" : "\n") + despues;
  if (/^[.;:,!?)]/.test(despues)) return antes + despues;
  return antes + " " + despues;
}

// Una línea que solo tiene marcador de viñeta o numeración y puntuación suelta.
const LINEA_HUECA = /^\s*(?:[-*•]|\d+[.)])\s*[.;:,]?\s*$/;
// Una línea que es solo viñeta y citas (más puntuación): las citas se recolocan.
const LINEA_SOLO_CITAS = /^\s*(?:[-*•]|\d+[.)])?\s*((?:\[[^\[\]\n]+\]\s*[,;]?\s*)+)[.;:,]?\s*$/;

/** Rango de un encabezado: `#` de Markdown por su nivel, una línea en
 *  negrita entera, o una línea corta que acaba en dos puntos. */
function nivelEncabezado(linea: string): number | null {
  const md = linea.match(/^\s*(#{1,6})\s+\S/);
  if (md) return md[1].length;
  if (/^\s*\*\*[^*\n]+\*\*:?\s*$/.test(linea)) return 7;
  if (/^\s*[^\n]{1,80}:\s*$/.test(linea) && !/\[[^\]]+\]/.test(linea)) return 8;
  return null;
}

/** Deja el texto presentable tras quitar frases: viñetas que quedaron vacías,
 *  citas que quedaron solas en su línea (se pegan a la frase anterior, a la
 *  que siguen respaldando) y encabezados sin contenido debajo. */
function limpiarLineas(texto: string): string {
  const conCitasRecolocadas: string[] = [];
  for (const linea of texto.split("\n")) {
    if (LINEA_HUECA.test(linea)) continue;
    const soloCitas = linea.match(LINEA_SOLO_CITAS);
    if (soloCitas) {
      // A la última línea con una frase, saltando blancos y encabezados: una
      // cita pegada a "**Lo que no está**" convertiría el encabezado en una
      // afirmación con cita.
      let k = conCitasRecolocadas.length - 1;
      while (k >= 0 && (!conCitasRecolocadas[k].trim() || nivelEncabezado(conCitasRecolocadas[k]) !== null)) k--;
      if (k >= 0) {
        conCitasRecolocadas[k] = conCitasRecolocadas[k].replace(/\s+$/, "") + " " + soloCitas[1].trim();
        continue;
      }
    }
    conCitasRecolocadas.push(linea);
  }
  // Un encabezado sin nada debajo hasta el siguiente encabezado de igual o
  // mayor rango (o el final) ya no encabeza nada: por ejemplo "**Lo que no
  // está**" cuando se borró la única frase que tenía.
  const salida: string[] = [];
  for (let i = 0; i < conCitasRecolocadas.length; i++) {
    const nivel = nivelEncabezado(conCitasRecolocadas[i]);
    if (nivel !== null) {
      let j = i + 1;
      while (j < conCitasRecolocadas.length && !conCitasRecolocadas[j].trim()) j++;
      if (j >= conCitasRecolocadas.length) continue;
      const siguiente = nivelEncabezado(conCitasRecolocadas[j]);
      if (siguiente !== null && siguiente <= nivel) continue;
    }
    salida.push(conCitasRecolocadas[i]);
  }
  return salida.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Recorte {
  texto: string;
  /** Textos de las afirmaciones bloqueantes que se quitaron. */
  eliminadas: string[];
  /** Citas inventadas que se quitaron sueltas, sin su frase. */
  citasQuitadas: string[];
}

/** Quita del contenido cada afirmación bloqueante (su frase y, salvo que otras
 *  frases del tramo se apoyaran en ellas, sus citas) y cada cita que no
 *  resuelve. Devuelve null si alguna frase no se localiza, porque entonces no
 *  se puede garantizar que lo publicado no la contenga.
 *
 *  Función pura: no llama al modelo. El texto recortado se vuelve a verificar
 *  antes de publicarse. */
export function _recortar(contenido: string, informe: Verificacion): Recorte | null {
  let texto = contenido;
  const eliminadas: string[] = [];
  for (const af of bloqueantes(informe)) {
    const pos = localizar(texto, af);
    if (!pos) return null;
    // Si entre la cita anterior y esta frase hay otras afirmaciones, se
    // apoyaban en las citas que van a desaparecer (la cita de cierre respalda
    // el tramo completo): se conservan y `limpiarLineas` las recoloca.
    const conservarCitas =
      pos.fin > pos.finTexto && verificador._tieneAfirmaciones(tramoAnterior(texto, pos.inicio));
    texto = quitar(texto, pos.inicio, conservarCitas ? pos.finTexto : pos.fin);
    eliminadas.push(af.texto);
  }
  const citasQuitadas: string[] = [];
  for (const c of [...new Set(informe.citas_sin_resolver)]) {
    const re = new RegExp(`\\s*[,;]?\\s*${patronFlexible(c)}`, "g");
    const nuevo = texto.replace(re, "");
    if (nuevo !== texto) {
      texto = nuevo;
      citasQuitadas.push(c);
    }
  }
  return { texto: limpiarLineas(texto), eliminadas, citasQuitadas };
}

function contar(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/** Corre `trabajo` contra un reloj. Si vence, rechaza con un error que lo dice.
 *
 *  A diferencia de `asyncio.timeout`, aquí no se cancela el trabajo perdedor:
 *  una promesa no se puede abortar desde fuera. Lo que garantiza este helper
 *  es que el LLAMADOR no espera más del tope; el trabajo abandonado, si acaba
 *  fallando, no deja un rechazo sin manejar. */
async function conTope<T>(ms: number, trabajo: () => Promise<T>): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const vence = new Promise<never>((_, rechaza) => {
    temporizador = setTimeout(
      () => rechaza(new Error(`la revisión superó su tope de ${Math.round(ms / 1000)} s`)),
      ms,
    );
  });
  const p = trabajo();
  p.catch(() => undefined);
  try {
    return await Promise.race([p, vence]);
  } finally {
    clearTimeout(temporizador);
  }
}

function publicada(
  contenido: string,
  informe: Verificacion,
  revisiones: number,
  frasesEliminadas: string[],
): ResultadoRevision {
  return {
    contenido,
    informe,
    revisiones,
    usoAbstencionSegura: false,
    motivoAbstencion: null,
    informeBorrador: null,
    frasesEliminadas,
  };
}

/** Verifica, corrige y vuelve a verificar antes de liberar texto.
 *
 *  Política QUIRÚRGICA. La anterior era todo o nada: una sola no_sostenida
 *  tras la única ronda de corrección mandaba TODA la respuesta a la
 *  abstención. Eso violaba el propio argumento de `aprobada` (una barrera que
 *  se dispara siempre enseña a ignorarla) y pasó en 3 de 12 preguntas de
 *  estrés, una de ellas con 22 sostenidas y fidelidad 0.85. Ahora:
 *
 *  1. se verifica el borrador; si está aprobado, sale;
 *  2. hasta `maxRevisiones` rondas de corrección por el modelo; la última
 *     ordena BORRAR literalmente lo que siga sin sostenerse;
 *  3. si aun así quedan bloqueantes, se eliminan por código (`_recortar`),
 *     el texto recortado se verifica otra vez y se publica si está aprobado,
 *     con la nota de cuántas frases se quitaron;
 *  4. solo si eso tampoco basta (una frase no se localiza, o el recorte no
 *     deja nada aprobable) se responde con la abstención segura.
 *
 *  La garantía no cambia: ninguna atribución falsa se publica. Lo que cambia
 *  es que el resto de la respuesta, si se sostiene, ya no paga por ella.
 *
 *  `tiempoDisponibleS` es lo que queda del reloj ÚNICO de la pregunta: la
 *  revisión no puede gastar más que eso aunque su tope propio sea mayor,
 *  porque la acción muere al agotar su tiempo y una revisión que llega tarde
 *  no es una respuesta más corta, es ninguna. `mapaPlan` viaja a todas las
 *  verificaciones para que el informe de cobertura exista también cuando se
 *  abstiene. */
export async function revisarAntesDePublicar(
  pregunta: string,
  borrador: string,
  mensajesConEvidencia: Record<string, unknown>[],
  fragmentos: Fragmento[],
  evidenciaRequerida: Record<string, string> | null = null,
  mapaPlan: Record<string, string[]> | null = null,
  tiempoDisponibleS: number | null = null,
  tel?: Telemetria,
): Promise<ResultadoRevision> {
  const a = ajustes();
  const t = tel ?? new Telemetria();
  const maxRevisiones = Math.max(0, Math.floor(a.maxRevisiones) || 0);

  // La abstención segura también informa cobertura, pero SOLO cuando hay
  // mapa: sin él, pasarle el plan produciría la lectura antigua ("todo sin
  // cubrir") sobre un texto que por definición no cubre nada, ruido que
  // antes no existía.
  const planParaAbstencion = mapaPlan != null ? evidenciaRequerida : null;

  if (!borrador.trim()) {
    const informeVacio = await verificador.verificar(
      ABSTENCION_SEGURA, fragmentos, planParaAbstencion, mapaPlan, t,
    );
    return {
      contenido: ABSTENCION_SEGURA, informe: informeVacio, revisiones: 0,
      usoAbstencionSegura: true, motivoAbstencion: "borrador_vacio", informeBorrador: null,
      frasesEliminadas: [],
    };
  }

  let tope = a.revisionTimeoutS;
  if (tiempoDisponibleS != null) tope = Math.min(tope, tiempoDisponibleS);
  tope = Math.max(1, tope);

  let motivo: string | null = null;
  let ultimoInforme: Verificacion | null = null;
  try {
    const resultado = await conTope(tope * 1000, async (): Promise<ResultadoRevision | null> => {
      let informe = await verificador.verificar(borrador, fragmentos, evidenciaRequerida, mapaPlan, t);
      ultimoInforme = informe;
      if (aprobada(informe)) return publicada(borrador, informe, 0, []);
      // `ok=false` también se usa para una respuesta factual sin citas: ese
      // es un veredicto determinista y SÍ se puede corregir.
      //
      // Solo se aborta cuando el verificador no dictaminó NADA, porque
      // entonces no hay crítica con la que corregir. Antes se abortaba si
      // UNA CUALQUIERA quedaba sin veredicto, y eso era desproporcionado:
      // con 34 afirmaciones repartidas en lotes es normal que el modelo
      // omita algún índice, y en la sesión de estrés dos preguntas tenían
      // 10 y 12 así. Las dos habrían abstenido al instante sin gastar ni
      // una ronda de corrección.
      if (sinSenal(informe)) {
        motivo = "sin_senal";
        throw new Error(informe.nota || "verificación no disponible");
      }

      let actual = borrador;
      for (let ronda = 1; ronda <= maxRevisiones; ronda++) {
        actual = await _corregir(pregunta, actual, mensajesConEvidencia, informe, a, t, {
          ordenarBorrado: ronda === maxRevisiones && ronda >= 2,
        });
        informe = await verificador.verificar(actual, fragmentos, evidenciaRequerida, mapaPlan, t);
        ultimoInforme = informe;
        if (aprobada(informe)) return publicada(actual, informe, ronda, []);
      }

      // ÚLTIMO RECURSO antes de la abstención: quitar por código lo que
      // sigue sin sostenerse y publicar el resto, verificado otra vez.
      if (sinSenal(informe)) {
        motivo = "sin_senal";
        return null;
      }
      const recorte = _recortar(actual, informe);
      if (!recorte || recorte.texto === actual || !TIENE_CONTENIDO.test(recorte.texto)) {
        motivo = "rechazada_tras_correccion";
        return null;
      }
      const informeRecorte = await verificador.verificar(
        recorte.texto, fragmentos, evidenciaRequerida, mapaPlan, t,
      );
      ultimoInforme = informeRecorte;
      if (!aprobada(informeRecorte)) {
        motivo = "rechazada_tras_correccion";
        return null;
      }
      t.incr("frases_eliminadas", recorte.eliminadas.length);
      const partes = [informeRecorte.nota];
      if (recorte.eliminadas.length) {
        partes.push(
          `se ${recorte.eliminadas.length === 1 ? "eliminó" : "eliminaron"} ` +
            `${contar(recorte.eliminadas.length, "frase", "frases")} por no poder sostenerse con la evidencia`,
        );
      }
      if (recorte.citasQuitadas.length) {
        partes.push(
          `se ${recorte.citasQuitadas.length === 1 ? "quitó" : "quitaron"} ` +
            `${contar(recorte.citasQuitadas.length, "cita", "citas")} que no correspondían a ningún fragmento recuperado`,
        );
      }
      return publicada(
        recorte.texto,
        { ...informeRecorte, nota: partes.filter(Boolean).join("; ") },
        maxRevisiones,
        recorte.eliminadas,
      );
    });
    if (resultado) return resultado;
  } catch (exc) {
    if (!motivo) motivo = /superó su tope/.test(String(exc)) ? "timeout" : "error";
    console.warn(`Revisión previa no disponible; abstención segura (${motivo}: ${String(exc)}).`);
  }

  const informeSeguro = await verificador.verificar(
    ABSTENCION_SEGURA, fragmentos, planParaAbstencion, mapaPlan, t,
  );
  return {
    contenido: ABSTENCION_SEGURA,
    informe: informeSeguro,
    revisiones: maxRevisiones,
    usoAbstencionSegura: true,
    motivoAbstencion: motivo ?? "rechazada_tras_correccion",
    informeBorrador: ultimoInforme,
    frasesEliminadas: [],
  };
}
