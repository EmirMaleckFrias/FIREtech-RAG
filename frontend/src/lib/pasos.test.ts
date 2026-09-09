import { describe, expect, it } from 'vitest';
import type { ChatMessage, Hop, Source } from '../types';
import {
  documentosDelTurno,
  duracionBusquedas,
  formatearDuracion,
  monedasDe,
  pasosDelTurno,
  resumenDelTurno,
} from './pasos';

const fuente = (source_file: string, citation?: string): Source => ({
  source_file,
  page: 1,
  snippet: '',
  score: null,
  citation,
});

const hop = (extra: Partial<Hop> = {}): Hop => ({
  n: 1,
  query: 'p-tau217',
  origen: 'plan',
  plan_item: 'e0',
  resultados: 3,
  documentos: ['Allegri et al., 2023'],
  estado: 'cubierto',
  recuperacion: 'hibrida',
  ms: 1200,
  ...extra,
});

const mensaje = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  localId: 'x',
  id: null,
  role: 'assistant',
  content: '',
  sources: [fuente('PMC1.pdf', 'Allegri et al., 2023')],
  hops: [hop()],
  plan: [],
  progreso: '',
  alcance: null,
  verificacion: null,
  estado: 'buscando',
  streaming: true,
  error: null,
  feedback: null,
  creadoEn: 0,
  ...extra,
});

describe('formatearDuracion', () => {
  it('décimas hasta 10 s, segundos hasta el minuto, y minutos después', () => {
    expect(formatearDuracion(0)).toBe('');
    expect(formatearDuracion(340)).toBe('0,3 s');
    expect(formatearDuracion(1200)).toBe('1,2 s');
    expect(formatearDuracion(9960)).toBe('10 s');
    expect(formatearDuracion(42_400)).toBe('42 s');
    expect(formatearDuracion(64_000)).toBe('1 min 4 s');
    expect(formatearDuracion(120_000)).toBe('2 min');
  });
});

describe('monedasDe', () => {
  it('resuelve la cita al fichero para saber el formato, y un nombre de archivo se lee directo', () => {
    const m = monedasDe(['Allegri et al., 2023', 'protocolo.docx'], [fuente('PMC1.pdf', 'Allegri et al., 2023')]);
    expect(m).toEqual([
      { ref: 'Allegri et al., 2023', familia: 'pdf', sigla: 'PDF' },
      { ref: 'protocolo.docx', familia: 'word', sigla: 'DOC' },
    ]);
  });

  it('una referencia que no está entre las fuentes queda sin formato, con su inicial, y no rompe', () => {
    expect(monedasDe(['Zhang et al., 2021'], [])).toEqual([{ ref: 'Zhang et al., 2021', familia: null, sigla: 'Z' }]);
  });

  it('sin duplicados ni vacíos, en orden', () => {
    expect(monedasDe(['a.pdf', ' ', 'a.pdf', 'b.csv'], []).map((m) => m.ref)).toEqual(['a.pdf', 'b.csv']);
  });
});

describe('pasosDelTurno', () => {
  it('en curso: el paso del estado está en marcha, los anteriores hechos y los siguientes pendientes', () => {
    const pasos = pasosDelTurno(mensaje({ estado: 'redactando' }));
    expect(pasos.map((p) => [p.clave, p.estado])).toEqual([
      ['entender', 'hecho'],
      ['buscar', 'hecho'],
      ['redactar', 'en_curso'],
      ['comprobar', 'pendiente'],
    ]);
    expect(pasos[2].detalle).toBe('con 3 fragmentos de 1 documento');
  });

  it('listo: todo hecho, y el paso de comprobar dice cuántas afirmaciones', () => {
    const pasos = pasosDelTurno(
      mensaje({
        estado: 'listo',
        streaming: false,
        verificacion: {
          afirmaciones: [
            { texto: 'a', cita: '', veredicto: 'sostenida', motivo: '', fragmento_id: '' },
            { texto: 'b', cita: '', veredicto: 'parcial', motivo: '', fragmento_id: '' },
          ],
          evidencia_sin_cubrir: [],
          citas_sin_resolver: [],
          fidelidad: 1,
          ok: true,
          nota: '',
          cobertura: [],
        },
      }),
    );
    expect(pasos.every((p) => p.estado === 'hecho')).toBe(true);
    expect(pasos[3].detalle).toBe('2 afirmaciones contrastadas con su fuente');
    expect(pasos[0].titulo).toBe('Pregunta entendida');
  });

  it('con plan de varias partes, el detalle del primer paso lo dice', () => {
    const pasos = pasosDelTurno(
      mensaje({
        plan: [
          { id: 'e0', query: 'q', evidence_needed: 'todo' },
          { id: 'e1', query: 'q1', evidence_needed: 'dosis' },
          { id: 'e2', query: 'q2', evidence_needed: 'efectos' },
        ],
      }),
    );
    expect(pasos[0].detalle).toBe('dividida en 2 partes');
    expect(pasos[1].titulo).toBe('Buscando cada parte');
  });

  it('ADVERSARIAL: en error no se afirma nada que no conste', () => {
    expect(pasosDelTurno(mensaje({ estado: 'error', hops: [], plan: [] }))).toEqual([]);
    const conBusqueda = pasosDelTurno(mensaje({ estado: 'error' }));
    expect(conBusqueda.map((p) => p.clave)).toEqual(['entender', 'buscar']);
    expect(conBusqueda.every((p) => p.estado === 'hecho')).toBe(true);
  });
});

describe('resumen y agregados', () => {
  it('documentos distintos de todo el turno y suma de tiempos', () => {
    const hops = [hop(), hop({ n: 2, documentos: ['Allegri et al., 2023', 'guia.pdf'], ms: 800 }), hop({ n: 3, ms: undefined })];
    expect(documentosDelTurno(hops)).toEqual(['Allegri et al., 2023', 'guia.pdf']);
    expect(duracionBusquedas(hops)).toBe(2000);
  });

  it('el resumen tiene una pieza por dato, sin separadores dentro del texto', () => {
    const piezas = resumenDelTurno(mensaje({ hops: [hop(), hop({ n: 2, documentos: ['guia.pdf'], ms: 800 })] }));
    expect(piezas).toEqual(['2 búsquedas', '2 documentos', '2 s']);
    for (const p of piezas) expect(p).not.toMatch(/[·|]/);
  });
});

describe('turno detenido', () => {
  it('solo enseña los pasos que llegaron a ocurrir, como el error', () => {
    const pasos = pasosDelTurno(mensaje({ estado: 'cancelado', streaming: false }));
    expect(pasos.map((p) => [p.clave, p.estado])).toEqual([
      ['entender', 'hecho'],
      ['buscar', 'hecho'],
    ]);
  });

  it('detenido antes de buscar no afirma ningún paso', () => {
    expect(pasosDelTurno(mensaje({ estado: 'cancelado', streaming: false, hops: [], plan: [] }))).toEqual([]);
  });
});

describe('progreso y alcance en los pasos', () => {
  it('comprobando: el avance del agente es el detalle del paso en curso, y no se queda al cerrar', () => {
    const enCurso = pasosDelTurno(mensaje({ estado: 'revisando', progreso: 'Comprobando 31 afirmaciones · 12 de 31 listas' }));
    expect(enCurso[3]).toMatchObject({ clave: 'comprobar', estado: 'en_curso', detalle: 'Comprobando 31 afirmaciones · 12 de 31 listas' });
    const cerrado = pasosDelTurno(mensaje({ estado: 'listo', streaming: false, progreso: 'Comprobando 31 afirmaciones · 12 de 31 listas' }));
    expect(cerrado[3].detalle).toBe('');
  });

  it('redactando: el avance se suma al detalle de los fragmentos', () => {
    const pasos = pasosDelTurno(mensaje({ estado: 'redactando', progreso: '4 afirmaciones ya comprobadas sobre la marcha' }));
    expect(pasos[2].detalle).toBe('con 3 fragmentos de 1 documento · 4 afirmaciones ya comprobadas sobre la marcha');
    // Sin avance, el detalle de siempre.
    expect(pasosDelTurno(mensaje({ estado: 'redactando' }))[2].detalle).toBe('con 3 fragmentos de 1 documento');
  });

  it('alcance: el paso de buscar dice a qué documento se acotó, o por qué no', () => {
    const acotado = pasosDelTurno(mensaje({ estado: 'listo', streaming: false, alcance: { pista: 'el PDF', documento: 'M6U1.pdf', encontrado: true } }));
    expect(acotado[1].detalle).toBe('1 búsqueda · solo en «M6U1.pdf»');
    const vacio = pasosDelTurno(mensaje({ estado: 'listo', streaming: false, alcance: { pista: 'el PDF', documento: 'M6U1.pdf', encontrado: false } }));
    expect(vacio[1].detalle).toContain('«M6U1.pdf» no tenía nada sobre esto: se buscó en todos');
    const ambiguo = pasosDelTurno(mensaje({ estado: 'listo', streaming: false, alcance: { pista: 'el PDF indexado', documento: null, candidatos: 3, encontrado: true } }));
    expect(ambiguo[1].detalle).toContain('«el PDF indexado» no identifica un documento (hay 3)');
    const desconocido = pasosDelTurno(mensaje({ estado: 'listo', streaming: false, alcance: { pista: 'el PDF de Smith', documento: null, encontrado: true } }));
    expect(desconocido[1].detalle).toContain('no se reconoció «el PDF de Smith»');
  });
});
