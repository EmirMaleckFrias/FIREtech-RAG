// Cobertura de la pregunta: que puntos del plan tienen evidencia y cuales no.
//
// Hay dos origenes y un solo modelo de fila:
// - En una respuesta recien generada, el informe del verificador (columna
//   `verificacion`) trae `cobertura` ya calculada por punto.
// - En un mensaje cargado de sesion puede no haber informe, pero los hops si,
//   y cada hop de origen plan lleva `estado_final` y `usado_en_respuesta`
//   desde que el agente publico la respuesta. La cobertura se reconstruye de
//   ahi.
//
// El punto `e0` es la pregunta entera y no se lista como fila en ningun caso:
// una fila "la pregunta tal como la formulo" al lado de sus partes no aporta
// nada y confunde.
//
// Dos trampas medidas en el port (CONTRATO.md) que este modulo cierra:
// - **Recuperacion en error no es ausencia.** Un punto cuya busqueda lanzo o
//   no llego a tiempo se pinta "no se pudo comprobar", nunca "no esta en los
//   documentos": lo segundo afirma algo que nadie comprobo.
// - **Un hop extra rellena su punto.** Si el modelo busco por su cuenta y
//   declaro el punto (`plan_item` en un hop de origen extra) y trajo
//   fragmentos, ese punto deja de estar sin resultados.

import type { CoberturaPunto, EstadoCobertura, Hop, PlanItem } from '../types';

/** Id del ancla del plan: la pregunta literal. */
export const ANCLA = 'e0';

/** Estado que se puede mostrar. Ademas de los cuatro del contrato hay tres
 *  propios de la UI para no afirmar lo que no se sabe:
 *  - `encontrada`: el hop trajo fragmentos pero nadie dijo si la respuesta los
 *    uso (mensaje persistido sin `estado_final`, p.ej. verificador apagado).
 *  - `no_buscado`: habia plan pero ese punto nunca llego a buscarse (turno
 *    cortado a mitad).
 *  - `error_busqueda`: la busqueda fallo (`recuperacion: "error"`), asi que
 *    no se sabe si esta o no en los documentos. */
export type EstadoFila = EstadoCobertura | 'encontrada' | 'no_buscado' | 'error_busqueda';

export interface FilaCobertura {
  id: string;
  evidence_needed: string;
  estado: EstadoFila;
  n_fragmentos: number;
  documentos: string[];
}

/** Si el hop trajo evidencia para su punto. */
export function trajoEvidencia(h: Hop): boolean {
  return (h.resultados ?? 0) > 0 || h.estado === 'cubierto';
}

/** La busqueda de este hop fallo sin traer nada. */
function fallo(h: Hop): boolean {
  return h.recuperacion === 'error' && !trajoEvidencia(h);
}

/**
 * El hop que representa a cada punto.
 *
 * Cuentan todos los hops con `plan_item`, sean del plan o extra del modelo
 * que declaro el punto. Entre varios del mismo punto manda el ultimo que
 * trajo evidencia; si ninguno trajo, el ultimo intento. Asi un reintento que
 * encuentra algo pisa al que no encontro, y una busqueda extra vacia no
 * degrada un punto que ya estaba cubierto.
 *
 * El dictamen del verificador (`estado_final`, `usado_en_respuesta`) solo lo
 * escribe el agente en los hops del plan, asi que si el elegido es un extra
 * hereda el dictamen del hop del plan del mismo punto.
 */
export function hopsPorPunto(hops: Hop[]): Map<string, Hop> {
  const elegido = new Map<string, Hop>();
  const dictamen = new Map<string, Pick<Hop, 'estado_final' | 'usado_en_respuesta'>>();
  for (const h of hops) {
    if (!h.plan_item) continue;
    if (h.origen === 'plan' && (h.estado_final !== undefined || h.usado_en_respuesta !== undefined)) {
      dictamen.set(h.plan_item, {
        estado_final: h.estado_final,
        usado_en_respuesta: h.usado_en_respuesta,
      });
    }
    const previo = elegido.get(h.plan_item);
    if (!previo || trajoEvidencia(h) || !trajoEvidencia(previo)) elegido.set(h.plan_item, h);
  }
  for (const [id, h] of elegido) {
    const d = dictamen.get(id);
    if (!d) continue;
    const fusion: Hop = { ...h };
    if (fusion.estado_final === undefined && d.estado_final !== undefined) {
      fusion.estado_final = d.estado_final;
    }
    if (fusion.usado_en_respuesta === undefined && d.usado_en_respuesta !== undefined) {
      fusion.usado_en_respuesta = d.usado_en_respuesta;
    }
    elegido.set(id, fusion);
  }
  return elegido;
}

/** Estado de fila de un hop, sin inventar: el `estado_final` del verificador
 *  manda, salvo que diga "sin resultados" de una busqueda que en realidad
 *  fallo; sin dictamen, solo se afirma lo que el propio hop sabe. */
export function estadoDesdeHop(h: Hop): EstadoFila {
  if (h.estado_final) {
    return h.estado_final === 'sin_resultados' && fallo(h) ? 'error_busqueda' : h.estado_final;
  }
  if (fallo(h)) return 'error_busqueda';
  if (h.estado === 'sin_resultados') return 'sin_resultados';
  if (h.usado_en_respuesta === false) return 'evidencia_no_usada';
  if (h.usado_en_respuesta === true) return 'cubierto';
  return 'encontrada';
}

function filaDesdeHop(h: Hop): FilaCobertura {
  return {
    id: h.plan_item ?? '',
    evidence_needed: h.evidence_needed ?? h.query,
    estado: estadoDesdeHop(h),
    n_fragmentos: h.resultados ?? 0,
    documentos: h.documentos ?? [],
  };
}

/** Reconstruye la cobertura desde los hops persistidos. Solo hops con punto
 *  y nunca `e0`; un mensaje antiguo (hops con n y query) devuelve []. */
export function coberturaDesdeHops(hops: Hop[]): FilaCobertura[] {
  const filas: FilaCobertura[] = [];
  for (const h of hopsPorPunto(hops).values()) {
    if (h.plan_item === ANCLA) continue;
    filas.push(filaDesdeHop(h));
  }
  return filas;
}

/**
 * Filas a mostrar al terminar. Prioridad: informe del verificador; si no lo
 * hay, los hops. Si ademas se conoce el plan, los puntos que no aparezcan en
 * ninguna de las dos fuentes se listan como `no_buscado`, y el orden final es
 * el del plan.
 *
 * El informe no distingue "fallo la busqueda" de "no estaba": su
 * CoberturaPunto solo conoce `sin_resultados`. Por eso, cuando el informe
 * dice sin resultados y el hop de ese punto fallo, la fila dice que no se
 * pudo comprobar.
 *
 * Devuelve [] cuando no hay nada que decir (sin plan, sin hops con punto y
 * sin cobertura): ahi la vista debe quedarse exactamente como antes.
 */
export function filasCobertura(
  plan: PlanItem[],
  hops: Hop[],
  cobertura: CoberturaPunto[] | null | undefined,
): FilaCobertura[] {
  const porId = new Map<string, FilaCobertura>();
  const desdeVerificador = cobertura ?? [];
  if (desdeVerificador.length > 0) {
    const porPunto = hopsPorPunto(hops);
    for (const c of desdeVerificador) {
      if (c.id === ANCLA) continue;
      const h = porPunto.get(c.id);
      const estado: EstadoFila =
        c.estado === 'sin_resultados' && h !== undefined && fallo(h) ? 'error_busqueda' : c.estado;
      porId.set(c.id, {
        id: c.id,
        evidence_needed: c.evidence_needed,
        estado,
        n_fragmentos: c.n_fragmentos,
        documentos: c.documentos,
      });
    }
  } else {
    for (const fila of coberturaDesdeHops(hops)) porId.set(fila.id, fila);
  }

  // Los puntos del plan sin fila solo se declaran si el plan se conoce; si
  // ademas la fila del verificador vino sin texto, el plan lo completa.
  for (const item of plan) {
    if (item.id === ANCLA) continue;
    const fila = porId.get(item.id);
    if (fila) {
      if (fila.evidence_needed === '') fila.evidence_needed = item.evidence_needed;
      continue;
    }
    porId.set(item.id, {
      id: item.id,
      evidence_needed: item.evidence_needed,
      estado: 'no_buscado',
      n_fragmentos: 0,
      documentos: [],
    });
  }

  if (plan.length === 0) return [...porId.values()];
  // Orden del plan; lo que el verificador reporte fuera del plan va al final.
  const ordenadas: FilaCobertura[] = [];
  for (const item of plan) {
    const fila = porId.get(item.id);
    if (fila) {
      ordenadas.push(fila);
      porId.delete(item.id);
    }
  }
  return [...ordenadas, ...porId.values()];
}

/** Puntos con evidencia disponible que la respuesta no uso: el aviso que la
 *  medica debe ver, porque es evidencia que existe y no esta en el texto. */
export function puntosNoUsados(cobertura: CoberturaPunto[]): number {
  return cobertura.filter((c) => c.id !== ANCLA && c.estado === 'evidencia_no_usada').length;
}
