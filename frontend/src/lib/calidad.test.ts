import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { CalidadTab } from '../components/CalidadTab';
import { SettingsPanel } from '../components/SettingsPanel';
import {
  limiteDeGeneracion,
  PASO_GENERACION_MAX_MS,
  PREPARACION_GENERACION_MAX_MS,
  describirAvanceCorrida,
  describirGeneracion,
  estadoDeCorrida,
  etiquetaCategoria,
  faseDeGeneracion,
  fechaDeCorrida,
  fraccionCorrida,
  fraccionGeneracion,
  fraseDeFallo,
  frasesDeFallos,
  generacionColgada,
  ordenarCasos,
  porcentaje,
  resumenDeCorrida,
  textoDeDisparo,
  textoDeFuentes,
} from './calidad';
// El umbral del servidor, importado de verdad y no copiado: si alguien cambia
// uno de los dos, el test de abajo lo dice. (El componente no lo importa
// porque ese módulo arrastraría el runtime del servidor al navegador.)
import { generacionColgada as generacionColgadaServidor, PASO_GENERACION_MAX_MS as PASO_SERVIDOR, PREPARACION_GENERACION_MAX_MS as PREPARACION_SERVIDOR } from '../../convex/evaluacion/datos';
import type { CasoEvaluacion, CorridaEvaluacion, GeneracionEvaluacion, ResumenEvaluacion } from '../types';

// El componente se renderiza de verdad (react-dom/server) con `convex/react`
// sustituido: las queries devuelven estos datos y las mutaciones no llaman a
// nada. Sin red y sin ConvexProvider. `vi.hoisted` porque `vi.mock` se eleva
// por encima de los imports y la fábrica no puede ver una const normal.
const datos = vi.hoisted(() => ({
  casos: [] as unknown[],
  generacion: null as unknown,
  corridas: [] as unknown[],
  resultados: [] as unknown[],
}));
vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === 'skip') return undefined;
    switch (getFunctionName(ref as FunctionReference<'query'>)) {
      case 'evaluacion/datos:casos':
        return datos.casos;
      case 'evaluacion/datos:generacionActual':
        return datos.generacion;
      case 'evaluacion/datos:corridas':
        return datos.corridas;
      case 'evaluacion/datos:resultadosDe':
        return datos.resultados;
      default:
        return undefined;
    }
  },
  useMutation: () => async () => null,
}));

const AHORA = Date.parse('2026-09-08T12:00:00Z');

/** Los mensajes que produce puntuar.ts, en su forma de UNA corrida. */
const FALLOS_UNA_CORRIDA = [
  'evidencia no recuperada: e1',
  'hops insuficientes: 0 < 2',
  'conceptos ausentes en búsquedas: amiloide, tau',
  'respuesta incompleta: 0\\.94, AUC',
  'contenido prohibido: donepezilo',
  'debía abstenerse y no lo hizo',
  'se abstuvo en un caso con evidencia esperada',
  'citas no resolubles: [guia.pdf, pág. 99]',
  'respuesta factual sin citas',
  'error de ejecución: TypeError: fetch failed',
  '2 afirmación(es) que su fragmento citado no sostiene',
  'el caso exige fidelidad mínima pero la verificación no la midió',
  'fidelidad 0.60 por debajo del mínimo 0.80',
];

/** Los mismos, tal como los deja `agregarCorridas` con tres repeticiones. */
const FALLOS_AGREGADOS = [
  'evidencia no recuperada: e1 (2/3 corridas)',
  'hops insuficientes (2/3 corridas): 0 < 2, 1 < 2',
  'conceptos ausentes en búsquedas: amiloide, tau (1/3 corridas)',
  'respuesta incompleta: 0\\.94, AUC (3/3 corridas)',
  'contenido prohibido: donepezilo (1/3 corridas)',
  'debía abstenerse y no lo hizo (3/3 corridas)',
  'se abstuvo en un caso con evidencia esperada (1/3 corridas)',
  'citas no resolubles (1/3 corridas): [guia.pdf, pág. 99]',
  'respuesta factual sin citas (2/3 corridas)',
  'error de ejecución (1/3 corridas): TypeError: fetch failed',
  'afirmaciones que su fragmento citado no sostiene (2/3 corridas): 2, 1',
  'el caso exige fidelidad mínima pero la verificación no la midió (3/3 corridas)',
  'fidelidad por debajo del mínimo 0.80 (2/3 corridas): 0.60, 0.71',
];

const RESUMEN: ResumenEvaluacion = {
  cases: 10,
  passed: 8,
  pass_rate: 0.8,
  release_gate_passed: false,
  critical_failures: ['single_hop-003'],
  unstable_cases: [],
  mean_evidence_recall: 0.9,
  mean_citation_precision: 0.95,
  mean_faithfulness: 0.923,
  mean_retrieval_mrr: 0.7,
  mean_retrieval_hit_at_5: 0.8,
  mean_retrieval_hit_at_20: 0.9,
  mean_context_precision: 0.6,
  entity_misattributions_total: 2,
  failures_by_stage: { retrieval: 1, grading: 0, generation: 1 },
  unsupported_claims_total: 3,
  mean_latency_ms: 42_000,
  by_category: { single_hop: { total: 5, passed: 4 } },
};

function caso(extra: Partial<CasoEvaluacion>): CasoEvaluacion {
  return {
    _id: `caso-${extra.clave ?? 'x'}` as CasoEvaluacion['_id'],
    clave: 'single_hop-001',
    pregunta: '¿Qué dosis se usó?',
    modo: 'normal',
    categoria: 'single_hop',
    critico: false,
    respuestaEsperada: '10 mg al día',
    estado: 'propuesto',
    origen: 'generado',
    creadoEn: AHORA,
    fuentes: ['guia.pdf'],
    ...extra,
  };
}

function generacion(extra: Partial<GeneracionEvaluacion>): GeneracionEvaluacion {
  return {
    _id: 'gen' as GeneracionEvaluacion['_id'],
    empezadoEn: AHORA - 5 * 60_000,
    terminadoEn: null,
    estado: 'running',
    objetivo: 20,
    generados: 7,
    descartados: 1,
    paso: 'Leyendo guia.pdf',
    error: null,
    ...extra,
  };
}

const JERGA = /regex|MRR|chunk|embedding|token|\bids?\b|JSON|\bhops?\b|\bAPI\b|null|undefined|NaN|recall|precision|single_hop|multi_hop|corridas\)|\d+\/\d+/i;

describe('etiquetaCategoria', () => {
  test('las cinco categorías en palabras y las desconocidas sin enseñar el identificador', () => {
    expect(etiquetaCategoria('single_hop')).toBe('Un documento');
    expect(etiquetaCategoria('multi_hop')).toBe('Varios documentos');
    expect(etiquetaCategoria('tabla')).toBe('Tabla o cifra');
    expect(etiquetaCategoria('abstencion')).toBe('Debe decir que no está');
    expect(etiquetaCategoria('entidad')).toBe('Trampa de otra entidad');
    // ADVERSARIAL: una categoría nueva del backend no se pinta cruda.
    expect(etiquetaCategoria('cross_doc_v2')).toBe('Otro tipo');
    expect(etiquetaCategoria('')).toBe('Otro tipo');
  });
});

describe('textoDeFuentes', () => {
  test('lista los documentos sin repetir y explica cuando no debe haber ninguno', () => {
    expect(textoDeFuentes({ fuentes: ['guia.pdf', 'guia.pdf', ' estudio.docx '], categoria: 'multi_hop' })).toBe('guia.pdf, estudio.docx');
    expect(textoDeFuentes({ fuentes: [], categoria: 'abstencion' })).toContain('no está en tus documentos');
    expect(textoDeFuentes({ fuentes: [], categoria: 'entidad' })).toContain('no está en tus documentos');
    expect(textoDeFuentes({ fuentes: ['', '  '], categoria: 'single_hop' })).toBe('Sin documento concreto');
  });
});

describe('fraseDeFallo', () => {
  test('cada tipo de fallo de puntuar.ts tiene su frase', () => {
    const frases = FALLOS_UNA_CORRIDA.map(fraseDeFallo);
    expect(frases).toEqual([
      'No encontró la evidencia esperada en tus documentos',
      'Buscó menos veces de las necesarias',
      'No buscó algunos conceptos clave: amiloide, tau',
      'La respuesta no menciona algo que debía decir: 0.94, AUC',
      'La respuesta incluye algo que no debía decir: donepezilo',
      'Respondió cuando debía decir que no está en tus documentos',
      'Dijo que no estaba en tus documentos, y sí estaba',
      'Citó una fuente que no existe',
      'Afirmó cosas sin citar ninguna fuente',
      'El asistente no llegó a responder por un error',
      'Afirmó algo que su fuente no dice',
      'No se pudo comprobar si las afirmaciones tenían respaldo',
      'Demasiadas afirmaciones sin respaldo en las fuentes citadas',
    ]);
  });

  test('la forma agregada de N corridas da la misma frase más "en k de n intentos"', () => {
    const sueltas = FALLOS_UNA_CORRIDA.map(fraseDeFallo);
    const agregadas = FALLOS_AGREGADOS.map(fraseDeFallo);
    for (let i = 0; i < sueltas.length; i++) {
      expect(agregadas[i].startsWith(sueltas[i])).toBe(true);
      expect(agregadas[i]).toMatch(/\(en [123] de 3 intentos\)$/);
    }
    expect(fraseDeFallo('evidencia no recuperada: e1 (2/3 corridas)')).toBe(
      'No encontró la evidencia esperada en tus documentos (en 2 de 3 intentos)',
    );
    // ADVERSARIAL: con una sola repetición el sufijo sobra y no se añade.
    expect(fraseDeFallo('respuesta factual sin citas (1/1 corridas)')).toBe('Afirmó cosas sin citar ninguna fuente');
  });

  test('ADVERSARIAL: un detalle que es un patrón de búsqueda no se enseña', () => {
    expect(fraseDeFallo('respuesta incompleta: (?:amiloide|amyloid), 0\\.94')).toBe('La respuesta no menciona algo que debía decir');
    expect(fraseDeFallo('conceptos ausentes en búsquedas: tau\\b, [Aa]beta')).toBe('No buscó algunos conceptos clave');
    expect(fraseDeFallo('contenido prohibido: .*curativo')).toBe('La respuesta incluye algo que no debía decir');
    // Un detalle vacío tampoco deja los dos puntos colgando.
    expect(fraseDeFallo('respuesta incompleta: ')).toBe('La respuesta no menciona algo que debía decir');
  });

  test('ADVERSARIAL: un fallo desconocido no filtra su texto original', () => {
    const raro = 'metric_x below threshold: regex /chunk_id/ null';
    expect(fraseDeFallo(raro)).toBe('Otro fallo en la comprobación automática');
    expect(fraseDeFallo('')).toBe('Otro fallo en la comprobación automática');
    // Ni el identificador de la evidencia ni el error técnico de ejecución llegan a la pantalla.
    expect(fraseDeFallo('evidencia no recuperada: e1')).not.toMatch(/\be1\b/);
    expect(fraseDeFallo('error de ejecución: TypeError: fetch failed')).not.toMatch(/TypeError|fetch/);
    expect(fraseDeFallo('citas no resolubles: [guia.pdf, pág. 99]')).not.toContain('guia.pdf');
  });

  test('frasesDeFallos no repite la frase de dos evidencias que faltan', () => {
    expect(frasesDeFallos(['evidencia no recuperada: e1', 'evidencia no recuperada: e2', 'respuesta factual sin citas'])).toEqual([
      'No encontró la evidencia esperada en tus documentos',
      'Afirmó cosas sin citar ninguna fuente',
    ]);
    expect(frasesDeFallos([])).toEqual([]);
  });
});

describe('resumenDeCorrida', () => {
  test('porcentajes enteros, cuenta de preguntas bien y atribuciones', () => {
    const r = resumenDeCorrida(RESUMEN);
    expect(r.bien).toBe('8 de 10 preguntas bien');
    expect(r.fraccionBien).toBe(0.8);
    expect(r.fidelidad).toBe('92 %');
    expect(r.busqueda).toBe('80 %');
    expect(r.atribuciones).toBe('2');
    expect(r.todoBien).toBe(false);
  });

  test('todo bien exige todas las preguntas y la barrera del evaluador', () => {
    expect(resumenDeCorrida({ ...RESUMEN, passed: 10, release_gate_passed: true, critical_failures: [] }).todoBien).toBe(true);
    // ADVERSARIAL: todas las preguntas bien pero la barrera dice que no: no se celebra.
    expect(resumenDeCorrida({ ...RESUMEN, passed: 10, release_gate_passed: false }).todoBien).toBe(false);
    // ADVERSARIAL: cero preguntas no es "todo bien".
    expect(resumenDeCorrida({ ...RESUMEN, cases: 0, passed: 0, release_gate_passed: true }).todoBien).toBe(false);
  });

  test('ADVERSARIAL: un resumen antiguo sin las métricas nuevas dice "Sin medir", no "0 %"', () => {
    const viejo = { ...RESUMEN } as Record<string, unknown>;
    delete viejo.mean_retrieval_hit_at_5;
    delete viejo.entity_misattributions_total;
    const r = resumenDeCorrida(viejo as unknown as ResumenEvaluacion);
    expect(r.busqueda).toBe('Sin medir');
    expect(r.atribuciones).toBe('Sin medir');
    expect(resumenDeCorrida({ ...RESUMEN, mean_faithfulness: null }).fidelidad).toBe('Sin medir');
    expect(resumenDeCorrida({ ...RESUMEN, mean_retrieval_hit_at_5: null }).busqueda).toBe('Sin medir');
    expect(resumenDeCorrida({ ...RESUMEN, entity_misattributions_total: 0 }).atribuciones).toBe('0');
  });

  test('ADVERSARIAL: sin resumen, cifras imposibles o no numéricas no rompen la fila', () => {
    expect(resumenDeCorrida(null)).toEqual({
      bien: 'Sin resultados', fraccionBien: null, fidelidad: 'Sin medir', busqueda: 'Sin medir', atribuciones: 'Sin medir', todoBien: false,
    });
    expect(resumenDeCorrida(undefined).bien).toBe('Sin resultados');
    // Más aprobadas que casos (fila corrupta): se acota.
    expect(resumenDeCorrida({ ...RESUMEN, cases: 3, passed: 7 }).bien).toBe('3 de 3 preguntas bien');
    expect(resumenDeCorrida({ ...RESUMEN, cases: 1, passed: 1 }).bien).toBe('1 de 1 pregunta bien');
    expect(resumenDeCorrida({ ...RESUMEN, cases: 0, passed: 0 }).fraccionBien).toBeNull();
    const raro = { ...RESUMEN, mean_faithfulness: Number.NaN, mean_retrieval_hit_at_5: 7, entity_misattributions_total: -1 };
    const r = resumenDeCorrida(raro);
    expect(r.fidelidad).toBe('Sin medir');
    expect(r.busqueda).toBe('100 %');
    expect(r.atribuciones).toBe('Sin medir');
  });

  test('porcentaje acota a 0..100 y rechaza lo que no es número', () => {
    expect(porcentaje(0.923)).toBe('92 %');
    expect(porcentaje(0)).toBe('0 %');
    expect(porcentaje(1.4)).toBe('100 %');
    expect(porcentaje(-0.2)).toBe('0 %');
    expect(porcentaje(null)).toBeNull();
    expect(porcentaje('0.5')).toBeNull();
    expect(porcentaje(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('corridas', () => {
  test('estado en una palabra con su tono', () => {
    expect(estadoDeCorrida({ estado: 'running', resumen: null })).toEqual({ texto: 'En marcha', tono: 'curso' });
    expect(estadoDeCorrida({ estado: 'error', resumen: null })).toEqual({ texto: 'Interrumpida', tono: 'error' });
    expect(estadoDeCorrida({ estado: 'ok', resumen: RESUMEN })).toEqual({ texto: 'Con fallos', tono: 'fallos' });
    expect(estadoDeCorrida({ estado: 'ok', resumen: { ...RESUMEN, passed: 10, release_gate_passed: true } })).toEqual({ texto: 'Todo bien', tono: 'bien' });
    // ADVERSARIAL: terminada sin resumen (fila a medio escribir) no es "Todo bien".
    expect(estadoDeCorrida({ estado: 'ok', resumen: null }).tono).toBe('fallos');
  });

  test('disparo y fecha en llano', () => {
    expect(textoDeDisparo('manual')).toBe('A petición');
    expect(textoDeDisparo('programada')).toBe('Automática');
    const esperada = new Date(AHORA).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    expect(fechaDeCorrida(AHORA)).toBe(esperada);
    expect(fechaDeCorrida(0)).toBe('Sin fecha');
    expect(fechaDeCorrida(Number.NaN)).toBe('Sin fecha');
  });

  test('el avance cuenta preguntas y enseña la pregunta en curso, no su clave', () => {
    expect(describirAvanceCorrida({ casosHechos: 3, casosTotal: 12 }, '¿Qué dosis se usó?')).toBe('Evaluando: 3 de 12 preguntas · ahora: ¿Qué dosis se usó?');
    expect(describirAvanceCorrida({ casosHechos: 3, casosTotal: 12 })).toBe('Evaluando: 3 de 12 preguntas');
    expect(describirAvanceCorrida({ casosHechos: 0, casosTotal: 1 }, '  ')).toBe('Evaluando: 0 de 1 pregunta');
    // ADVERSARIAL: hechos por encima del total (contador desfasado) se acota.
    expect(describirAvanceCorrida({ casosHechos: 15, casosTotal: 12 })).toBe('Evaluando: 12 de 12 preguntas');
    expect(fraccionCorrida({ casosHechos: 3, casosTotal: 12 })).toBe(0.25);
    expect(fraccionCorrida({ casosHechos: 15, casosTotal: 12 })).toBe(1);
    expect(fraccionCorrida({ casosHechos: 0, casosTotal: 0 })).toBeNull();
  });
});

describe('generación', () => {
  test('en marcha: cuántas van y qué hace; terminada: cuántas salieron y cuándo', () => {
    expect(describirGeneracion(generacion({}), AHORA)).toBe('Proponiendo preguntas: 7 de 20 · Leyendo guia.pdf');
    expect(describirGeneracion(generacion({ paso: null }), AHORA)).toBe('Proponiendo preguntas: 7 de 20');
    expect(describirGeneracion(generacion({ estado: 'ok', generados: 18, descartados: 2, terminadoEn: AHORA - 2 * 3_600_000 }), AHORA)).toBe(
      '18 preguntas propuestas, 2 descartadas por no poder comprobarse (hace 2 horas)',
    );
    expect(describirGeneracion(generacion({ estado: 'ok', generados: 1, descartados: 0, terminadoEn: AHORA - 20_000 }), AHORA)).toBe(
      '1 pregunta propuesta (hace un momento)',
    );
    expect(describirGeneracion(generacion({ estado: 'error', error: 'gateway 500', terminadoEn: AHORA - 60_000 }), AHORA)).toBe(
      'No se pudieron proponer las preguntas (hace 1 minuto)',
    );
    // ADVERSARIAL: más generadas que el objetivo (el generador se pasó) no da "25 de 20".
    expect(describirGeneracion(generacion({ generados: 25 }), AHORA)).toBe('Proponiendo preguntas: 20 de 20 · Leyendo guia.pdf');
    expect(fraccionGeneracion({ generados: 7, objetivo: 20 })).toBe(0.35);
    expect(fraccionGeneracion({ generados: 25, objetivo: 20 })).toBe(1);
    expect(fraccionGeneracion({ generados: 0, objetivo: 0 })).toBeNull();
  });

  test('ADVERSARIAL: una generación que figura en marcha desde hace horas está colgada, no en marcha', () => {
    // La acción del servidor muere a los 10 minutos como mucho; si Convex la
    // mata sin pasar por su catch, la fila se queda `running` con su último
    // paso. Antes, esto daba el texto de avance y apagaba el botón para siempre.
    const colgada = generacion({ empezadoEn: AHORA - 3 * 3_600_000, paso: 'Leyendo x.pdf (3 de 4)' });
    expect(generacionColgada(colgada, AHORA)).toBe(true);
    expect(faseDeGeneracion(colgada, AHORA)).toBe('colgada');
    const texto = describirGeneracion(colgada, AHORA);
    expect(texto).toBe('La propuesta anterior no terminó (empezó hace 3 horas). Puedes volver a intentarlo.');
    expect(texto).not.toContain('Proponiendo');
    expect(texto).not.toContain('Leyendo');
    // Una en marcha de verdad (cinco minutos) sigue siendo avance.
    expect(faseDeGeneracion(generacion({}), AHORA)).toBe('en_marcha');
    expect(generacionColgada(generacion({}), AHORA)).toBe(false);
  });

  test('ADVERSARIAL: el umbral es el del servidor y complementario a su regla de conflicto', () => {
    // Si aquí el botón se habilitara antes de que el servidor deje de
    // responder "conflicto", la médica pulsaría y vería un error; si después,
    // el botón seguiría apagado un rato sin motivo. Con el mismo reloj, los
    // dos cambian en el mismo milisegundo.
    expect(PREPARACION_GENERACION_MAX_MS).toBe(PREPARACION_SERVIDOR);
    expect(PASO_GENERACION_MAX_MS).toBe(PASO_SERVIDOR);
    // Con cero avance el límite es preparación más un paso; con 7 propuestas
    // y 2 descartadas, preparación más diez pasos. En todos los instantes la
    // regla de aquí coincide con la del servidor (`datos.generacionColgada`).
    for (const avance of [{ generados: 0, descartados: 0 }, { generados: 7, descartados: 2 }]) {
      const limite = limiteDeGeneracion({ empezadoEn: AHORA, ...avance }) - AHORA;
      for (const edad of [0, 1, 60_000, limite - 1, limite, limite + 1, 3 * 3_600_000, 30 * 3_600_000]) {
        const g = generacion({ empezadoEn: AHORA - edad, ...avance });
        expect(generacionColgada(g, AHORA), `edad ${edad} avance ${JSON.stringify(avance)}`).toBe(generacionColgadaServidor(g, AHORA));
      }
      expect(faseDeGeneracion(generacion({ empezadoEn: AHORA - limite, ...avance }), AHORA)).toBe('en_marcha');
      expect(faseDeGeneracion(generacion({ empezadoEn: AHORA - limite - 1, ...avance }), AHORA)).toBe('colgada');
    }
  });

  test('ADVERSARIAL: solo una en marcha puede estar colgada; una terminada hace horas o un reloj atrasado no', () => {
    const hace3h = AHORA - 3 * 3_600_000;
    expect(faseDeGeneracion(generacion({ estado: 'ok', empezadoEn: hace3h, terminadoEn: hace3h + 60_000 }), AHORA)).toBe('terminada');
    expect(faseDeGeneracion(generacion({ estado: 'error', empezadoEn: hace3h, terminadoEn: hace3h + 60_000 }), AHORA)).toBe('fallida');
    expect(generacionColgada(generacion({ estado: 'ok', empezadoEn: hace3h }), AHORA)).toBe(false);
    expect(describirGeneracion(generacion({ estado: 'ok', empezadoEn: hace3h, terminadoEn: hace3h + 60_000 }), AHORA)).toMatch(/preguntas propuestas/);
    // El reloj del navegador va por detrás del servidor: la generación "empezó
    // en el futuro" y se sigue tratando como en marcha, nunca como colgada.
    expect(faseDeGeneracion(generacion({ empezadoEn: AHORA + 5 * 60_000 }), AHORA)).toBe('en_marcha');
  });
});

describe('ordenarCasos', () => {
  test('agrupa por estado: propuestas más nuevas primero, aprobadas por clave, descartadas más nuevas primero', () => {
    const casos = [
      caso({ clave: 'single_hop-010', estado: 'aprobado', creadoEn: AHORA - 5 }),
      caso({ clave: 'tabla-001', estado: 'propuesto', creadoEn: AHORA - 100 }),
      caso({ clave: 'single_hop-002', estado: 'aprobado', creadoEn: AHORA - 1 }),
      caso({ clave: 'entidad-001', estado: 'descartado', creadoEn: AHORA - 50 }),
      caso({ clave: 'multi_hop-001', estado: 'propuesto', creadoEn: AHORA }),
      caso({ clave: 'abstencion-001', estado: 'descartado', creadoEn: AHORA - 10 }),
    ];
    const g = ordenarCasos(casos);
    expect(g.propuestos.map((c) => c.clave)).toEqual(['multi_hop-001', 'tabla-001']);
    // Orden numérico: la 2 antes que la 10, aunque alfabéticamente "10" < "2".
    expect(g.aprobados.map((c) => c.clave)).toEqual(['single_hop-002', 'single_hop-010']);
    expect(g.descartados.map((c) => c.clave)).toEqual(['abstencion-001', 'entidad-001']);
  });

  test('ADVERSARIAL: no modifica la lista de entrada y un estado desconocido queda a la vista', () => {
    const casos = [
      caso({ clave: 'b', estado: 'propuesto', creadoEn: AHORA - 1 }),
      caso({ clave: 'a', estado: 'propuesto', creadoEn: AHORA }),
      caso({ clave: 'z', estado: 'pendiente' as CasoEvaluacion['estado'], creadoEn: AHORA - 9 }),
    ];
    const copia = [...casos];
    const g = ordenarCasos(casos);
    expect(casos).toEqual(copia);
    expect(g.propuestos.map((c) => c.clave)).toEqual(['a', 'b', 'z']);
    expect(g.aprobados).toEqual([]);
    expect(ordenarCasos([])).toEqual({ propuestos: [], aprobados: [], descartados: [] });
  });
});

describe('sin jerga ni guion largo', () => {
  test('nada de lo que producen estas funciones habla en el idioma del evaluador', () => {
    const textos: string[] = [
      ...['single_hop', 'multi_hop', 'tabla', 'abstencion', 'entidad', 'otra'].map(etiquetaCategoria),
      ...FALLOS_UNA_CORRIDA.map(fraseDeFallo),
      ...FALLOS_AGREGADOS.map(fraseDeFallo),
      fraseDeFallo('lo que sea'),
      ...Object.values(resumenDeCorrida(RESUMEN)).filter((v): v is string => typeof v === 'string'),
      ...Object.values(resumenDeCorrida(null)).filter((v): v is string => typeof v === 'string'),
      estadoDeCorrida({ estado: 'running', resumen: null }).texto,
      estadoDeCorrida({ estado: 'ok', resumen: RESUMEN }).texto,
      estadoDeCorrida({ estado: 'error', resumen: null }).texto,
      textoDeDisparo('manual'),
      textoDeDisparo('programada'),
      describirAvanceCorrida({ casosHechos: 3, casosTotal: 12 }, null),
      describirGeneracion(generacion({}), AHORA),
      describirGeneracion(generacion({ empezadoEn: AHORA - 3 * 3_600_000 }), AHORA),
      describirGeneracion(generacion({ estado: 'ok', terminadoEn: AHORA }), AHORA),
      describirGeneracion(generacion({ estado: 'error', terminadoEn: AHORA }), AHORA),
      textoDeFuentes({ fuentes: [], categoria: 'abstencion' }),
      textoDeFuentes({ fuentes: [], categoria: 'single_hop' }),
      fechaDeCorrida(0),
    ];
    expect(textos.length).toBeGreaterThan(30);
    for (const t of textos) {
      expect(t, t).not.toMatch(JERGA);
      expect(t, t).not.toContain('\u2014');
      expect(t.trim(), t).not.toBe('');
    }
  });
});

/* ---------------------------------------------------------------------
   El componente entero, renderizado con datos simulados
   --------------------------------------------------------------------- */

/** Texto visible: sin etiquetas y con las entidades que escribe React. */
function textoVisible(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Los atributos del botón cuyo `title` empieza así, para mirar `disabled`. */
function atributosDelBoton(html: string, tituloInicio: string): string {
  const m = new RegExp(`<button([^>]*)title="${tituloInicio}[^"]*"`).exec(html);
  expect(m, `no hay botón con title "${tituloInicio}"`).not.toBeNull();
  return m![1];
}

function corrida(extra: Partial<CorridaEvaluacion>): CorridaEvaluacion {
  return {
    _id: 'k57corrida1' as CorridaEvaluacion['_id'],
    empezadoEn: AHORA - 3_600_000,
    terminadoEn: AHORA - 3_000_000,
    estado: 'ok',
    disparo: 'manual',
    casosTotal: 10,
    casosHechos: 10,
    casoActual: null,
    repeticiones: 1,
    resumen: RESUMEN,
    error: null,
    ...extra,
  };
}

const JERGA_PANTALLA = /regex|MRR|chunk|embedding|token|JSON|\bAPI\b|single_hop|multi_hop|\babstencion\b|\bnull\b|undefined|NaN|\bid\b/i;

describe('CalidadTab renderizado', () => {
  // El componente lee el reloj para decidir si la generación en marcha sigue
  // viva, y las fechas de los datos simulados van relativas a AHORA: sin
  // fijar el reloj, la generación "de hace 5 minutos" pasaría a colgada en
  // cuanto el reloj real superase AHORA + 20 min y el primer test fallaría
  // según la hora a la que se ejecute.
  beforeEach(() => vi.useFakeTimers({ now: AHORA }));
  afterEach(() => vi.useRealTimers());

  test('con preguntas en los tres estados, una generación y una corrida en marcha', () => {
    datos.casos = [
      caso({ _id: 'k17a' as CasoEvaluacion['_id'], clave: 'single_hop-001', estado: 'propuesto', critico: true, pregunta: '¿Qué dosis de donepezilo se usó?' }),
      caso({ _id: 'k17b' as CasoEvaluacion['_id'], clave: 'multi_hop-002', estado: 'aprobado', categoria: 'multi_hop', pregunta: '¿Coinciden los dos estudios en la edad media?', fuentes: ['a.pdf', 'b.pdf'] }),
      caso({ _id: 'k17c' as CasoEvaluacion['_id'], clave: 'entidad-003', estado: 'descartado', categoria: 'entidad', fuentes: [] }),
    ];
    datos.generacion = generacion({});
    datos.corridas = [
      corrida({ _id: 'k57r' as CorridaEvaluacion['_id'], estado: 'running', casosTotal: 2, casosHechos: 1, casoActual: 'multi_hop-002', resumen: null, terminadoEn: null }),
      corrida({ _id: 'k57ok' as CorridaEvaluacion['_id'] }),
      corrida({ _id: 'k57err' as CorridaEvaluacion['_id'], estado: 'error', disparo: 'programada', resumen: null, error: 'gateway 500' }),
    ];
    const html = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    const texto = textoVisible(html);

    // Las tres listas, con la categoría en palabras y sin la clave ni la categoría crudas.
    expect(texto).toContain('Por revisar (1)');
    expect(texto).toContain('Aprobadas (1)');
    expect(texto).toContain('Descartadas (1)');
    expect(texto).toContain('Un documento');
    expect(texto).toContain('Importante');
    expect(texto).toContain('Varios documentos');
    expect(texto).toContain('Documentos esperados: guia.pdf');
    expect(html).not.toContain('single_hop');
    expect(html).not.toContain('multi_hop');
    expect(html).not.toContain('entidad-003');
    // La respuesta esperada va en un cuadro editable con tope del servidor.
    // (React escribe el atributo como `maxLength`; por eso la `i`.)
    expect(html).toMatch(/<textarea[^>]*maxlength="2000"[^>]*>10 mg al día<\/textarea>/i);
    // La generación en marcha se enseña con su avance y el botón queda deshabilitado.
    expect(texto).toContain('Proponiendo preguntas: 7 de 20 · Leyendo guia.pdf');
    expect(atributosDelBoton(html, 'Proponer preguntas nuevas')).toContain('disabled');
    // La corrida en marcha enseña la PREGUNTA del caso en curso, no su clave,
    // y "Evaluar ahora" queda deshabilitado mientras dure.
    expect(texto).toContain('Evaluando: 1 de 2 preguntas · ahora: ¿Coinciden los dos estudios en la edad media?');
    // En la tabla, la fila en marcha no confunde "respondidas" con "bien".
    expect(texto).toContain('1 de 2 respondidas');
    expect(atributosDelBoton(html, 'Responder ahora todas las preguntas aprobadas')).toContain('disabled');
    // El historial, en palabras y porcentajes.
    expect(texto).toContain('8 de 10 preguntas bien');
    expect(texto).toContain('92 %');
    expect(texto).toContain('80 %');
    expect(texto).toContain('Con fallos');
    expect(texto).toContain('Interrumpida');
    expect(texto).toContain('En marcha');
    expect(texto).toContain('A petición');
    expect(texto).toContain('Automática');
    // El motivo de una corrida interrumpida solo se enseña al abrir su fila.
    expect(texto).not.toContain('gateway 500');
    // Accesibilidad: avances anunciados y pestaña con encabezados propios.
    expect(html.match(/role="status"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-labelledby="calidad-historial-titulo"');
    // ADVERSARIAL: nada de lo visible ni de los title habla en el idioma del evaluador.
    expect(texto).not.toMatch(JERGA_PANTALLA);
    for (const m of html.matchAll(/title="([^"]*)"/g)) expect(m[1]).not.toMatch(JERGA_PANTALLA);
    expect(html).not.toContain('\u2014');
  });

  test('sin preguntas ni corridas: estado vacío, Proponer activo y Evaluar apagado', () => {
    datos.casos = [];
    datos.generacion = null;
    datos.corridas = [];
    const html = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    const texto = textoVisible(html);
    expect(texto).toContain('Todavía no hay preguntas de control');
    expect(texto).toContain('Todavía no se ha evaluado ninguna vez');
    expect(texto).toContain('Marca al menos una pregunta como correcta para poder evaluar.');
    expect(atributosDelBoton(html, 'Proponer preguntas nuevas')).not.toContain('disabled');
    expect(atributosDelBoton(html, 'Responder ahora todas las preguntas aprobadas')).toContain('disabled');
    expect(texto).not.toMatch(JERGA_PANTALLA);
  });

  test('ADVERSARIAL: una generación colgada desde hace horas no bloquea "Proponer preguntas" ni enseña su avance', () => {
    // El caso medido: la fila `running` de hace 3 h con su último paso guardado.
    datos.casos = [];
    datos.generacion = generacion({ empezadoEn: AHORA - 3 * 3_600_000, generados: 7, paso: 'Leyendo x.pdf (3 de 4)' });
    datos.corridas = [];
    const html = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    const texto = textoVisible(html);
    expect(atributosDelBoton(html, 'Proponer preguntas nuevas')).not.toContain('disabled');
    expect(texto).toContain('La propuesta anterior no terminó (empezó hace 3 horas). Puedes volver a intentarlo.');
    expect(texto).not.toContain('Proponiendo preguntas');
    expect(texto).not.toContain('Leyendo x.pdf');
    // Ni barra en marcha: no hay corrida ni generación viva que la justifique.
    expect(html).not.toContain('calidad-barra');
    // El aviso se anuncia como estado, igual que el avance al que sustituye.
    expect(html).toMatch(/<div class="docs-poll-warn" role="status">/);
    expect(texto).not.toMatch(JERGA_PANTALLA);
  });

  test('ADVERSARIAL: un minuto antes de su límite sigue en marcha con el botón apagado, y al cumplirlo se libera', () => {
    datos.casos = [];
    // Con 7 propuestas el límite por avance es la preparación más ocho pasos:
    // se arranca un minuto antes de cumplirlo.
    const limite = limiteDeGeneracion({ empezadoEn: 0, generados: 7, descartados: 1 });
    datos.generacion = generacion({ empezadoEn: AHORA - (limite - 60_000) });
    datos.corridas = [];
    const antes = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    expect(atributosDelBoton(antes, 'Proponer preguntas nuevas')).toContain('disabled');
    expect(textoVisible(antes)).toContain('Proponiendo preguntas: 7 de 20');
    // Dos minutos después ha pasado el límite: en el mismo instante en que el
    // servidor aceptaría la pulsación, el botón se habilita.
    vi.setSystemTime(AHORA + 2 * 60_000);
    const despues = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    expect(atributosDelBoton(despues, 'Proponer preguntas nuevas')).not.toContain('disabled');
    expect(textoVisible(despues)).toContain('La propuesta anterior no terminó');
  });

  test('ADVERSARIAL: la última generación falló y un resumen antiguo no rompen la pestaña', () => {
    datos.casos = [caso({ _id: 'k17d' as CasoEvaluacion['_id'], clave: 'tabla-001', categoria: 'tabla', estado: 'aprobado' })];
    datos.generacion = generacion({ estado: 'error', error: 'gateway 500', terminadoEn: AHORA });
    const viejo = { ...RESUMEN } as Record<string, unknown>;
    delete viejo.mean_retrieval_hit_at_5;
    delete viejo.entity_misattributions_total;
    datos.corridas = [corrida({ resumen: viejo as unknown as ResumenEvaluacion })];
    const html = renderToStaticMarkup(createElement(CalidadTab, { open: true }));
    const texto = textoVisible(html);
    expect(texto).toContain('No se pudieron proponer las preguntas');
    expect(texto).toContain('Motivo: gateway 500');
    expect(texto).toContain('Sin medir');
    expect(texto).toContain('1 pregunta aprobada');
    // Con una aprobada y sin corrida en marcha, Evaluar está disponible.
    expect(atributosDelBoton(html, 'Responder ahora todas las preguntas aprobadas')).not.toContain('disabled');
  });
});

describe('SettingsPanel con la pestaña Calidad', () => {
  const props = { open: true, onClose: () => {}, currentUserId: null, userEmail: 'investigacion@example.org', onSignOut: () => {} };

  test.each(['lector', null] as const)('el rol %s ve Mi cuenta y Calidad, y ninguna pestaña de administración', (role) => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { ...props, role }));
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('id="settings-tab-calidad"');
    expect(html).not.toContain('id="settings-tab-usuarios"');
    expect(html).not.toContain('id="settings-tab-sistema"');
    expect(html).not.toContain('Tu equipo de investigación');
    // Arranca en Mi cuenta, con el cuerpo etiquetado como panel de pestañas.
    expect(html).toMatch(/id="settings-tab-cuenta" aria-selected="true" tabindex="0"/);
    expect(html).toContain('aria-labelledby="settings-tab-cuenta"');
    expect(html).toContain('Hazlo tuyo');
  });

  test('el administrador ve las cuatro, con Calidad la segunda', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { ...props, role: 'admin' }));
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    const orden = [...html.matchAll(/id="settings-tab-([a-z]+)"/g)].map((m) => m[1]);
    expect(orden).toEqual(['cuenta', 'calidad', 'usuarios', 'sistema']);
  });
});
