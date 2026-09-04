// Las dos trampas del contrato sobre la cobertura, en vitest. El script
// src/checks/normalize.check.ts cubre lo mismo en node puro; aquí se
// añaden los casos de hopsPorPunto que la vista en vivo usa directamente.
import { describe, expect, it } from 'vitest';
import type { Hop } from '../types';
import { coberturaDesdeHops, estadoDesdeHop, filasCobertura, hopsPorPunto } from './cobertura';

const plan = (id: string, extra: Partial<Hop> = {}): Hop => ({
  n: 1,
  query: `q-${id}`,
  origen: 'plan',
  plan_item: id,
  evidence_needed: `necesidad ${id}`,
  resultados: 0,
  estado: 'sin_resultados',
  recuperacion: 'hibrida',
  ms: 500,
  ...extra,
});

describe('recuperacion en error no es ausencia', () => {
  it('un hop fallido sin fragmentos es error_busqueda', () => {
    expect(estadoDesdeHop(plan('e1', { recuperacion: 'error' }))).toBe('error_busqueda');
  });

  it('el mismo hop con un dictamen sin_resultados del verificador sigue siendo error_busqueda', () => {
    expect(estadoDesdeHop(plan('e1', { recuperacion: 'error', estado_final: 'sin_resultados' }))).toBe(
      'error_busqueda',
    );
  });

  it('un dictamen distinto no se pisa', () => {
    expect(estadoDesdeHop(plan('e1', { recuperacion: 'error', estado_final: 'parcial' }))).toBe('parcial');
  });

  it('con informe: solo la fila sin_resultados de un hop fallido cambia', () => {
    const hops = [plan('e1', { recuperacion: 'error' }), plan('e2')];
    const filas = filasCobertura([], hops, [
      { id: 'e1', evidence_needed: 'a', estado: 'sin_resultados', n_fragmentos: 0, documentos: [], afirmaciones: [] },
      { id: 'e2', evidence_needed: 'b', estado: 'sin_resultados', n_fragmentos: 0, documentos: [], afirmaciones: [] },
    ]);
    expect(filas.map((f) => f.estado)).toEqual(['error_busqueda', 'sin_resultados']);
  });

  it('las grafías antiguas de recuperacion no son fallo', () => {
    expect(estadoDesdeHop(plan('e1', { recuperacion: 'hybrid' }))).toBe('sin_resultados');
  });
});

describe('hops extra que rellenan un punto', () => {
  it('un extra con fragmentos representa al punto', () => {
    const extra: Hop = { n: 2, query: 'bis', origen: 'extra', plan_item: 'e1', resultados: 2, estado: 'cubierto', documentos: ['Z'] };
    const m = hopsPorPunto([plan('e1'), extra]);
    expect(m.get('e1')?.resultados).toBe(2);
    expect(coberturaDesdeHops([plan('e1'), extra]).map((f) => f.estado)).toEqual(['encontrada']);
  });

  it('un extra vacío o fallido no degrada un punto con evidencia', () => {
    const cubierto = plan('e1', { resultados: 3, estado: 'cubierto', estado_final: 'cubierto', usado_en_respuesta: true });
    const extra: Hop = { n: 2, query: 'bis', origen: 'extra', plan_item: 'e1', resultados: 0, estado: 'sin_resultados', recuperacion: 'error', ms: 12 };
    expect(hopsPorPunto([cubierto, extra]).get('e1')?.n).toBe(1);
    expect(coberturaDesdeHops([cubierto, extra]).map((f) => f.estado)).toEqual(['cubierto']);
  });

  it('el extra elegido hereda el dictamen del hop del plan', () => {
    const conDictamen = plan('e2', { estado_final: 'evidencia_no_usada', usado_en_respuesta: false });
    const extra: Hop = { n: 2, query: 'bis', origen: 'extra', plan_item: 'e2', resultados: 1, estado: 'cubierto' };
    const elegido = hopsPorPunto([conDictamen, extra]).get('e2');
    expect(elegido?.n).toBe(2);
    expect(elegido?.estado_final).toBe('evidencia_no_usada');
    expect(coberturaDesdeHops([conDictamen, extra]).map((f) => f.estado)).toEqual(['evidencia_no_usada']);
  });

  it('entre dos sin evidencia manda el último intento; entre dos con evidencia también', () => {
    expect(hopsPorPunto([plan('e1', { n: 1 }), plan('e1', { n: 2 })]).get('e1')?.n).toBe(2);
    expect(
      hopsPorPunto([
        plan('e1', { n: 1, resultados: 3, estado: 'cubierto' }),
        plan('e1', { n: 2, resultados: 1, estado: 'cubierto' }),
      ]).get('e1')?.n,
    ).toBe(2);
  });

  it('un extra sin punto declarado no toca ninguna fila y e0 nunca es fila', () => {
    const suelto: Hop = { n: 3, query: 'suelta', origen: 'extra', resultados: 4, estado: 'cubierto' };
    expect(coberturaDesdeHops([suelto, plan('e0', { resultados: 5, estado: 'cubierto' })])).toEqual([]);
  });
});
