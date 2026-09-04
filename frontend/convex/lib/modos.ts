// Los dos modos de respuesta: pensamiento normal y pensamiento extendido.
// Port de `backend/app/services/modos.py`.
//
// La diferencia entre ellos es cuánto se le deja BUSCAR y DELIBERAR, nunca
// cuánta verdad se le exige. Las reglas de fidelidad (responder solo con lo
// recuperado, citar cada afirmación, decir cuando algo no está) son idénticas
// en los dos: un modo rápido que además miente no sirve para nada.
import type { Ajustes } from "./config";

export type NombreModo = "normal" | "extendido";

export interface Modo {
  nombre: NombreModo;
  etiqueta: string;
  /** 0 = sin tope de búsquedas iniciadas por el modelo. */
  maxHops: number;
  /** Segundos de reloj antes de forzar la respuesta final. */
  presupuestoS: number;
  /** Búsquedas seguidas sin nada nuevo antes de responder con lo que hay. */
  maxHopsSinAvance: number;
  /** Fragmentos que llegan al modelo por punto del plan. */
  fragmentos: number;
  /** Candidatos que se califican por punto antes de quedarse con los mejores. */
  candidatosPorPunto: number;
  /** Si la pregunta se descompone en un plan de evidencia antes de buscar.
   *
   *  Vive aquí y no en los ajustes porque es parte de CÓMO trabaja el modo:
   *  normal va al grano y extendido existe justo para descomponer. El
   *  interruptor del despliegue puede apagarlo en los dos, pero nunca
   *  encenderlo donde el modo dice no. */
  planifica: boolean;
  /** Si cada consulta del plan se busca también en inglés.
   *
   *  El corpus es mayoritariamente inglés y el lado léxico de la búsqueda no
   *  traduce: una consulta en español solo casa palabras en documentos en
   *  español. Antes esto dependía de que el modelo se acordara de reformular
   *  (era una regla del prompt); ahora lo hace el código siempre. */
  buscaEnIngles: boolean;
  /** Búsquedas EXTRA que el modelo puede pedir además del plan. */
  maxHopsExtra: number;
  /** `reasoning_effort` de la API. null = no se manda el parámetro.
   *
   *  Historia, porque ya mordió dos veces. El 2 sep 2026 el modelo rechazaba
   *  con 400 cualquier esfuerzo distinto de "none" junto a function tools, y
   *  dejarlo puesto sin probar tumbó el modo extendido entero en producción;
   *  se apagó en todo el backend. El 4 sep 2026 se volvió a medir contra el
   *  gateway con los kwargs exactos del bucle y funciona, con 76-338 tokens de
   *  razonamiento por ronda, y con un efecto claro: ante una pregunta
   *  comparativa, sin razonamiento el modelo pedía UNA búsqueda y con esfuerzo
   *  alto pedía tres. El fallback ante un 400 vive en lib/gateway.ts. */
  esfuerzo: string | null;
  /** Coda que se añade al prompt del sistema para explicar cómo trabajar. */
  instruccion: string;
}

export const NORMAL: Modo = {
  nombre: "normal",
  etiqueta: "Pensamiento normal",
  maxHops: 2,
  presupuestoS: 60,
  // 2 y no 1: el tope de búsquedas ya acota el gasto, así que este freno era
  // redundante y sí hacía daño. Con 1, una primera búsqueda vacía prohibía el
  // reintento que el propio sistema pide, y se respondía "no lo encuentro en
  // los documentos" sobre información que sí estaba indexada.
  maxHopsSinAvance: 2,
  fragmentos: 8,
  candidatosPorPunto: 20,
  planifica: false,
  buscaEnIngles: true,
  maxHopsExtra: 1,
  // medium y no high: en normal la respuesta debe llegar en segundos y el
  // razonamiento se gasta sobre todo en leer bien la evidencia que ya se le
  // entregó, que es donde medium ya cambia la conducta.
  esfuerzo: "medium",
  instruccion:
    "MODO ACTIVO: pensamiento normal, el que eligió quien pregunta. La " +
    "evidencia de la pregunta ya está recuperada y organizada arriba, con su " +
    "estado. Ve al grano: responde con ella, cita literal y di qué no " +
    "encontraste. Tienes UNA búsqueda extra, solo para un punto sin " +
    "resultados o para comprobar una discrepancia. Si la pregunta resulta ser " +
    "más compleja de lo que cabe aquí, responde con lo que tengas y dile a " +
    "quien pregunta que en pensamiento extendido puedes profundizar. Las " +
    "reglas de fidelidad y de citas se cumplen igual: rápido no significa laxo.",
};

export const EXTENDIDO: Modo = {
  nombre: "extendido",
  maxHops: 0,
  etiqueta: "Pensamiento extendido",
  // 240 s. En Vercel esto estaba recortado a 180 porque la función moría a los
  // 300 y había que dejar sitio a la barrera de revisión dentro del mismo
  // reloj. Una acción de Convex dura 600 s, así que el presupuesto vuelve a
  // ser el que el modo quiere y sigue sobrando margen para revisar.
  presupuestoS: 240,
  maxHopsSinAvance: 3,
  // 10 y no 12. Medido en la primera sesión de estrés sobre Convex: con 5 o 6
  // puntos del plan, 12 por punto ponían 60-72 fragmentos delante del
  // redactor y la redacción con razonamiento alto tardaba 76-119 s en una
  // sola llamada. El calificador ya ordena por grado, así que el noveno y el
  // décimo son parciales casi siempre.
  fragmentos: 10,
  candidatosPorPunto: 30,
  planifica: true,
  buscaEnIngles: true,
  maxHopsExtra: 2,
  esfuerzo: "high",
  instruccion:
    "MODO ACTIVO: pensamiento extendido, el que eligió quien pregunta. La " +
    "evidencia de cada punto de la pregunta ya está recuperada y organizada " +
    "arriba, con su estado: esos son tus resultados de búsqueda. Tómate el " +
    "trabajo en serio: léela entera antes de escribir, contrasta lo que dicen " +
    "documentos distintos y di explícitamente si se contradicen. Tienes hasta " +
    "DOS búsquedas extra, solo para un punto sin resultados o para comprobar " +
    "una discrepancia; no gana nada quien busca por buscar. Antes de dar la " +
    "respuesta, repasa si alguna parte de la pregunta quedó sin evidencia y " +
    "dilo en vez de rellenarla.",
};

export const MODOS: Record<string, Modo> = {
  [NORMAL.nombre]: NORMAL,
  [EXTENDIDO.nombre]: EXTENDIDO,
};

export const POR_DEFECTO = NORMAL;

/** Combina el presupuesto del modo con el techo del operador.
 *
 *  El modo decide cómo quiere trabajar; las variables del despliegue son el
 *  techo de quien opera, y por eso solo pueden APRETAR, nunca soltar. Un 0
 *  significa "sin límite" en los dos lados. */
function techo(delModo: number, delOperador: number): number {
  if (!delOperador) return delModo;
  if (!delModo) return delOperador;
  return Math.min(delModo, delOperador);
}

/** El modo pedido, o el normal si viene vacío o con un valor desconocido.
 *
 *  Un nombre inválido no es un error que deba tumbar la pregunta: se responde
 *  en el modo normal, que es el que menos supone. */
export function resolver(nombre: string | null | undefined, a?: Ajustes): Modo {
  let base = POR_DEFECTO;
  if (nombre) {
    base = MODOS[String(nombre).trim().toLowerCase()] ?? POR_DEFECTO;
  }
  if (!a) return base;

  // Techo del operador sobre el razonamiento: vacío = manda el modo; "none" lo
  // apaga; cualquier otro valor sustituye al del modo.
  let esfuerzo = base.esfuerzo;
  const techoEsfuerzo = String(a.razonamientoAgente ?? "").trim().toLowerCase();
  if (techoEsfuerzo) esfuerzo = techoEsfuerzo === "none" ? null : techoEsfuerzo;

  return {
    ...base,
    esfuerzo,
    maxHops: techo(base.maxHops, a.maxHops),
    maxHopsExtra: techo(base.maxHopsExtra, a.maxHops),
    presupuestoS: techo(base.presupuestoS, a.presupuestoAgenteS),
    maxHopsSinAvance: techo(base.maxHopsSinAvance, a.maxHopsSinAvance),
    // El ajuste del despliegue solo manda si es > 0: con un default fijo
    // pisaba siempre al del modo (normal 20, extendido 30).
    candidatosPorPunto: a.candidatosPorPunto > 0 ? a.candidatosPorPunto : base.candidatosPorPunto,
    planifica: base.planifica && a.habilitarPlan,
  };
}
