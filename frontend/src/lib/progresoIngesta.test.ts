import { describe, expect, test } from 'vitest';
import { fraccionDeProgreso, textoDeProgreso, tiempoRestanteMs } from './progresoIngesta';
import type { ProgresoIngesta } from '../types';

const AHORA = 1_800_000_000_000;
const p = (extra: Partial<ProgresoIngesta>): ProgresoIngesta => ({
  fase: 'embebiendo', hecho: 0, total: 0, empezadoEn: AHORA - 60_000, actualizadoEn: AHORA, ...extra,
});

describe('progreso de la ingesta', () => {
  test('fracción acotada y null sin total', () => {
    expect(fraccionDeProgreso(p({ hecho: 1200, total: 5378 }))).toBeCloseTo(0.223, 3);
    expect(fraccionDeProgreso(p({ hecho: 9, total: 5 }))).toBe(1);
    expect(fraccionDeProgreso(p({ total: 0 }))).toBeNull();
  });

  test('el texto habla de páginas y fragmentos, con lo que falta cuando ya hay ritmo', () => {
    // 1200 de 5378 en 60 s -> quedan (4178 / 20 por segundo) ≈ 209 s. Las
    // cifras van con el separador de miles del navegador (en el entorno de
    // pruebas puede no haber datos de idioma, así que se calcula igual).
    const n = (x: number) => x.toLocaleString('es');
    expect(textoDeProgreso(p({ hecho: 1200, total: 5378 }), AHORA)).toBe(`Indexando ${n(1200)} de ${n(5378)} fragmentos · quedan unos 3 min 29 s`);
    expect(textoDeProgreso(p({ fase: 'leyendo', hecho: 120, total: 600 }), AHORA)).toBe('Leyendo la página 120 de 600 · quedan unos 4 min');
    expect(textoDeProgreso(p({ fase: 'leyendo', total: 0 }), AHORA)).toBe('Leyendo el documento…');
    expect(textoDeProgreso(p({ hecho: 0, total: 0 }), AHORA)).toBe('Preparando el índice…');
  });

  test('ADVERSARIAL: sin ritmo fiable no se promete tiempo', () => {
    // Nada hecho, o menos del 5 %: no hay estimación.
    expect(tiempoRestanteMs(p({ hecho: 0, total: 500 }), AHORA)).toBeNull();
    expect(tiempoRestanteMs(p({ hecho: 10, total: 500 }), AHORA)).toBeNull();
    expect(textoDeProgreso(p({ hecho: 10, total: 500 }), AHORA)).toBe('Indexando 10 de 500 fragmentos');
    // Sin tiempos: tampoco.
    expect(tiempoRestanteMs(p({ hecho: 250, total: 500, empezadoEn: 0, actualizadoEn: 0 }), AHORA)).toBeNull();
    // Terminado: nada que estimar.
    expect(tiempoRestanteMs(p({ hecho: 500, total: 500 }), AHORA)).toBeNull();
    // Casi: menos de cinco segundos.
    const n = (x: number) => x.toLocaleString('es');
    expect(textoDeProgreso(p({ hecho: 5300, total: 5378, empezadoEn: AHORA - 300_000 }), AHORA)).toBe(`Indexando ${n(5300)} de ${n(5378)} fragmentos · ya casi`);
  });
});
