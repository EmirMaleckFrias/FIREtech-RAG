// Del documento de Convex al mensaje del chat. Los casos son los que pueden
// romper la UI, no los que la confirman: un mensaje antiguo sin `estado`, un
// turno colgado, el hop marcador que el agente inserta antes de buscar.
import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import {
  TIMEOUT_MSG,
  TURNO_MAX_MS,
  estadoDeMensaje,
  etiquetaFase,
  hopEnCurso,
  hopFallido,
  mensajeDesdeDoc,
  puntosDelPlan,
} from './mensajes';

const id = (s: string) => s as Id<'messages'>;
const AHORA = 1_700_000_000_000;

describe('estadoDeMensaje', () => {
  it('un mensaje antiguo sin estado ni error es una respuesta lista', () => {
    expect(estadoDeMensaje({ role: 'assistant', creadoEn: AHORA - 10 }, AHORA)).toBe('listo');
  });

  it('un mensaje antiguo sin estado pero con error se pinta como error', () => {
    expect(
      estadoDeMensaje({ role: 'assistant', error: 'se cayó', creadoEn: AHORA - 10 }, AHORA),
    ).toBe('error');
  });

  it('un mensaje del usuario siempre está listo, diga lo que diga su fila', () => {
    expect(estadoDeMensaje({ role: 'user', estado: 'pensando', creadoEn: AHORA }, AHORA)).toBe('listo');
  });

  it('un estado fuera del contrato no se inventa: cuenta como listo', () => {
    expect(estadoDeMensaje({ role: 'assistant', estado: 'volando', creadoEn: AHORA }, AHORA)).toBe('listo');
  });

  it('un turno abierto dentro del tope sigue abierto', () => {
    expect(
      estadoDeMensaje({ role: 'assistant', estado: 'buscando', creadoEn: AHORA - TURNO_MAX_MS + 1 }, AHORA),
    ).toBe('buscando');
  });

  it('un turno abierto más allá del tope se declara error, sin tocar la base', () => {
    expect(
      estadoDeMensaje({ role: 'assistant', estado: 'pensando', creadoEn: AHORA - TURNO_MAX_MS - 1 }, AHORA),
    ).toBe('error');
  });

  it('un turno ya cerrado no caduca aunque sea viejo', () => {
    expect(estadoDeMensaje({ role: 'assistant', estado: 'listo', creadoEn: 0 }, AHORA)).toBe('listo');
    expect(estadoDeMensaje({ role: 'assistant', estado: 'error', creadoEn: 0 }, AHORA)).toBe('error');
  });
});

describe('mensajeDesdeDoc', () => {
  it('mensaje antiguo: sin plan, sin verificacion, hops de dos campos, listo', () => {
    const m = mensajeDesdeDoc(
      {
        _id: id('m1'),
        role: 'assistant',
        content: 'Hola [a.pdf, pág. 1]',
        hops: [{ n: 1, query: 'a' }],
        sources: [{ source_file: 'a.pdf', page: 1, snippet: 's', score: 0.3 }],
        creadoEn: 1,
      },
      AHORA,
      null,
    );
    expect(m.estado).toBe('listo');
    expect(m.streaming).toBe(false);
    expect(m.error).toBeNull();
    expect(m.plan).toEqual([]);
    expect(m.verificacion).toBeNull();
    expect(m.hops).toEqual([{ n: 1, query: 'a' }]);
    expect(m.sources[0].grado).toBe('');
    expect(m.id).toBe('m1');
    expect(m.localId).toBe('m1');
  });

  it('turno colgado: error con el texto de tiempo, y deja de estar en curso', () => {
    const m = mensajeDesdeDoc(
      { _id: id('m2'), role: 'assistant', content: '', estado: 'redactando', creadoEn: AHORA - TURNO_MAX_MS - 5 },
      AHORA,
      null,
    );
    expect(m.estado).toBe('error');
    expect(m.streaming).toBe(false);
    expect(m.error).toBe(TIMEOUT_MSG);
  });

  it('error del agente: manda su texto; sin texto, uno genérico', () => {
    const con = mensajeDesdeDoc(
      { _id: id('m3'), role: 'assistant', content: '', estado: 'error', error: 'El gateway respondió 500', creadoEn: AHORA },
      AHORA,
      null,
    );
    expect(con.error).toBe('El gateway respondió 500');
    const sin = mensajeDesdeDoc(
      { _id: id('m4'), role: 'assistant', content: '', estado: 'error', error: '  ', creadoEn: AHORA },
      AHORA,
      null,
    );
    expect(sin.error).not.toBe('  ');
    expect(sin.error).toBeTruthy();
  });

  it('en curso: streaming true y content vacío aunque haya hops', () => {
    const m = mensajeDesdeDoc(
      { _id: id('m5'), role: 'assistant', content: '', estado: 'buscando', hops: [{ n: 1, query: 'q' }], creadoEn: AHORA },
      AHORA,
      null,
    );
    expect(m.streaming).toBe(true);
    expect(m.content).toBe('');
  });

  it('feedback: el de la fila manda sobre el local; sin fila, el local; basura no cuenta', () => {
    const base = { _id: id('m6'), role: 'assistant', content: 'x', creadoEn: AHORA } as const;
    expect(mensajeDesdeDoc({ ...base, feedback: -1 }, AHORA, 1).feedback).toBe(-1);
    expect(mensajeDesdeDoc({ ...base }, AHORA, 1).feedback).toBe(1);
    expect(mensajeDesdeDoc({ ...base, feedback: 'si' }, AHORA, null).feedback).toBeNull();
    expect(mensajeDesdeDoc({ ...base, feedback: 2 }, AHORA, null).feedback).toBeNull();
  });

  it('el plan de la columna de Convex (lista directa) se lee', () => {
    const m = mensajeDesdeDoc(
      {
        _id: id('m7'),
        role: 'assistant',
        content: '',
        estado: 'buscando',
        plan: [{ id: 'e0', query: 'p', query_en: '', evidence_needed: 'r' }],
        creadoEn: AHORA,
      },
      AHORA,
      null,
    );
    expect(m.plan.map((p) => p.id)).toEqual(['e0']);
    // e0 solo: NO hay partes de la pregunta (modo normal).
    expect(puntosDelPlan(m.plan)).toEqual([]);
  });
});

describe('hop marcador del agente', () => {
  // El agente inserta el hop extra antes de buscar con esta forma exacta.
  const marcador = { n: 3, query: 'x', origen: 'extra' as const, plan_item: 'e2', resultados: 0, estado: 'sin_resultados' as const, recuperacion: 'error' as const, ms: 0 };

  it('con el turno abierto es "buscando", no un fallo', () => {
    expect(hopEnCurso(marcador, true)).toBe(true);
    expect(hopFallido(marcador, true)).toBe(false);
  });

  it('con el turno cerrado la misma forma es un fallo real', () => {
    expect(hopEnCurso(marcador, false)).toBe(false);
    expect(hopFallido(marcador, false)).toBe(true);
  });

  it('un hop completado con error (ms > 0) es fallo aunque el turno siga', () => {
    const fallido = { ...marcador, ms: 812 };
    expect(hopEnCurso(fallido, true)).toBe(false);
    expect(hopFallido(fallido, true)).toBe(true);
  });

  it('un hop con fragmentos nunca es fallo ni marcador', () => {
    const conDatos = { ...marcador, resultados: 2, estado: 'cubierto' as const };
    expect(hopEnCurso(conDatos, true)).toBe(false);
    expect(hopFallido(conDatos, false)).toBe(false);
  });
});

describe('etiquetaFase', () => {
  it('modo normal no anuncia "cada parte de la pregunta"', () => {
    expect(etiquetaFase('buscando', false)).toBe('Buscando en los documentos…');
    expect(etiquetaFase('buscando', true)).toBe('Buscando cada parte de la pregunta…');
  });

  it('cada fase tiene su texto y las finales caen en pensando (no se pintan)', () => {
    expect(etiquetaFase('redactando', false)).toBe('Redactando…');
    expect(etiquetaFase('revisando', false)).toBe('Comprobando cada afirmación…');
    expect(etiquetaFase('pensando', false)).toBe('Pensando…');
  });
});
