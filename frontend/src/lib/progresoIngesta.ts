// Texto y fracción de la barra de una ingesta en marcha. Funciones puras,
// probadas sin DOM. Quien lee es una médica: "Leyendo la página 120 de 600",
// "Indexando 1.200 de 5.378 fragmentos · quedan unos 2 min", nunca "chunks"
// ni "embeddings".
//
// El tiempo que falta se estima con el ritmo medido hasta ahora (hecho entre
// el tiempo transcurrido desde que empezó la fase); con menos del 5 % hecho
// el ritmo aún no dice nada y no se promete ningún tiempo.

import type { ProgresoIngesta } from '../types';
import { formatearDuracion } from './pasos';
import { plural } from './notion';

/** Fracción 0..1, o null si aún no se conoce el total. */
export function fraccionDeProgreso(p: ProgresoIngesta): number | null {
  if (p.total <= 0) return null;
  return Math.min(1, Math.max(0, p.hecho / p.total));
}

/** Milisegundos que quedan según el ritmo hasta ahora, o null si no se puede
 *  estimar todavía (nada hecho, sin tiempos o menos del 5 % completado). */
export function tiempoRestanteMs(p: ProgresoIngesta, ahora = Date.now()): number | null {
  if (p.total <= 0 || p.hecho <= 0 || p.hecho >= p.total) return null;
  if (p.hecho / p.total < 0.05) return null;
  if (!(p.empezadoEn > 0)) return null;
  const referencia = p.actualizadoEn || ahora;
  const transcurrido = referencia - p.empezadoEn;
  if (!(transcurrido > 0)) return null;
  const ritmo = p.hecho / transcurrido;
  return Math.round((p.total - p.hecho) / ritmo);
}

/** "Leyendo la página 120 de 600" / "Indexando 1.200 de 5.378 fragmentos · quedan unos 2 min". */
export function textoDeProgreso(p: ProgresoIngesta, ahora = Date.now()): string {
  if (p.total <= 0) return p.fase === 'leyendo' ? 'Leyendo el documento…' : 'Preparando el índice…';
  const hecho = p.hecho.toLocaleString('es');
  const base =
    p.fase === 'leyendo'
      ? `Leyendo la página ${hecho} de ${p.total.toLocaleString('es')}`
      : `Indexando ${hecho} de ${plural(p.total, 'fragmento', 'fragmentos')}`;
  const restante = tiempoRestanteMs(p, ahora);
  if (restante === null) return base;
  if (restante < 5_000) return `${base} · ya casi`;
  return `${base} · quedan unos ${formatearDuracion(restante)}`;
}
