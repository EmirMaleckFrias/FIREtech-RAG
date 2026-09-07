import { describe, expect, test } from 'vitest';
import {
  casa,
  cifra,
  componer,
  fechaCorta,
  formatoDe,
  hayFiltros,
  identidadDe,
  listar,
  maxFragmentos,
  normalizar,
  pesoRelativo,
  resumir,
  SIN_FILTROS,
  type Filtros,
} from './biblioteca';
import type { DocumentInfo } from '../types';

let n = 0;
function doc(p: Partial<DocumentInfo> = {}): DocumentInfo {
  n += 1;
  return {
    id: `doc${n}` as DocumentInfo['id'],
    fileName: `f${n}.pdf`,
    pages: 1,
    chunks: 10,
    status: 'ready',
    error: null,
    ingestadoEn: 1_000 * n,
    titulo: null,
    citation: null,
    origen: 'subida',
    sha256: null,
    avisos: null,
    ...p,
  } as DocumentInfo;
}

const AHORA = Date.parse('2026-09-07T12:00:00');

describe('formatoDe', () => {
  test('agrupa por familia, no por extensión: a ella le da igual xlsx o csv', () => {
    expect(formatoDe('a.pdf').familia).toBe('pdf');
    expect(formatoDe('a.DOCX').familia).toBe('word');
    expect(formatoDe('a.xlsx').familia).toBe('hoja');
    expect(formatoDe('a.csv').familia).toBe('hoja');
    expect(formatoDe('foto.JPEG').familia).toBe('imagen');
    expect(formatoDe('nota.md').familia).toBe('texto');
  });

  test('un nombre raro no revienta: cae en texto', () => {
    expect(formatoDe('sin-extension').familia).toBe('texto');
    expect(formatoDe('').familia).toBe('texto');
    expect(formatoDe('.oculto').familia).toBe('texto');
    // Punto en la carpeta pero no en el fichero: la extensión es lo último.
    expect(formatoDe('v1.2/informe.pdf').familia).toBe('pdf');
  });
});

describe('identidadDe', () => {
  test('la cita manda y el título va debajo', () => {
    const d = doc({ citation: 'Silva-Rodríguez et al., 2026', titulo: 'Prognostic value of %p-tau217', fileName: 'PMC1.pdf' });
    expect(identidadDe(d)).toEqual({
      principal: 'Silva-Rodríguez et al., 2026',
      secundaria: 'Prognostic value of %p-tau217',
      fichero: 'PMC1.pdf',
    });
  });

  test('sin cita manda el título, y NO se repite debajo', () => {
    const d = doc({ titulo: 'Guía de p-tau217', fileName: 'guia.docx' });
    expect(identidadDe(d)).toEqual({ principal: 'Guía de p-tau217', secundaria: '', fichero: 'guia.docx' });
  });

  test('sin cita ni título, el nombre no se enseña dos veces', () => {
    const d = doc({ fileName: 'datos.xlsx' });
    expect(identidadDe(d)).toEqual({ principal: 'datos.xlsx', secundaria: '', fichero: '' });
  });

  test('cita o título con solo espacios cuentan como ausentes', () => {
    expect(identidadDe(doc({ citation: '   ', titulo: '  ', fileName: 'x.pdf' })).principal).toBe('x.pdf');
  });
});

describe('búsqueda', () => {
  test('normalizar quita tildes y trata guiones y puntos como espacios', () => {
    expect(normalizar('Silva-Rodríguez et al., 2026')).toBe('silva rodriguez et al 2026');
    expect(normalizar('PMC13390017.pdf')).toBe('pmc13390017 pdf');
    // La ñ se descompone en n + tilde combinante, y la tilde se quita: es una
    // sola palabra, no dos.
    expect(normalizar('  ÁÉÍÓÚñ  ')).toBe('aeioun');
  });

  test('todas las palabras cuentan, y pueden estar en campos distintos', () => {
    const d = doc({ citation: 'Silva-Rodríguez et al., 2026', titulo: 'Prognostic value', fileName: 'PMC13390017.pdf' });
    expect(casa(d, 'silva 2026')).toBe(true);
    expect(casa(d, 'SILVA RODRIGUEZ')).toBe(true);
    // Una palabra de la cita y otra del título: casa igual.
    expect(casa(d, 'silva prognostic')).toBe(true);
    // Y del nombre del fichero.
    expect(casa(d, '13390017')).toBe(true);
    expect(casa(d, 'coysh')).toBe(false);
    // Una consulta vacía o de espacios no filtra nada.
    expect(casa(d, '   ')).toBe(true);
  });
});

describe('listar', () => {
  const pdfViejo = doc({ fileName: 'viejo.pdf', chunks: 50, ingestadoEn: 100 });
  const wordNuevo = doc({ fileName: 'nuevo.docx', chunks: 3, ingestadoEn: 900 });
  const imagenNotion = doc({ fileName: 'foto.png', chunks: 8, ingestadoEn: 500, origen: 'notion' });
  const roto = doc({ fileName: 'roto.pdf', chunks: 0, status: 'failed', ingestadoEn: 700 });
  const todos = [pdfViejo, wordNuevo, imagenNotion, roto];

  test('los tres órdenes, y el desempate es estable', () => {
    expect(listar(todos, SIN_FILTROS, 'recientes').map((d) => d.fileName)).toEqual([
      'nuevo.docx', 'roto.pdf', 'foto.png', 'viejo.pdf',
    ]);
    expect(listar(todos, SIN_FILTROS, 'peso').map((d) => d.fileName)).toEqual([
      'viejo.pdf', 'foto.png', 'nuevo.docx', 'roto.pdf',
    ]);
    expect(listar(todos, SIN_FILTROS, 'nombre').map((d) => d.fileName)).toEqual([
      'foto.png', 'nuevo.docx', 'roto.pdf', 'viejo.pdf',
    ]);
  });

  test('empate exacto de fecha y de peso: el orden NO depende del render', () => {
    // Es el caso de una carpeta entera subida de golpe. Sin desempate, dos
    // documentos con el mismo `ingestadoEn` salían en el orden que diera el
    // sort del motor y las fichas saltaban de sitio entre renders.
    const a = doc({ fileName: 'b.pdf', ingestadoEn: 500, chunks: 7 });
    const b = doc({ fileName: 'a.pdf', ingestadoEn: 500, chunks: 7 });
    expect(listar([a, b], SIN_FILTROS, 'recientes').map((d) => d.fileName)).toEqual(['a.pdf', 'b.pdf']);
    expect(listar([b, a], SIN_FILTROS, 'recientes').map((d) => d.fileName)).toEqual(['a.pdf', 'b.pdf']);
    expect(listar([a, b], SIN_FILTROS, 'peso').map((d) => d.fileName)).toEqual(['a.pdf', 'b.pdf']);
  });

  test('no toca el array de entrada, que viene de una suscripción', () => {
    const entrada = [...todos];
    listar(entrada, SIN_FILTROS, 'nombre');
    expect(entrada.map((d) => d.fileName)).toEqual(todos.map((d) => d.fileName));
  });

  test('filtra por formato, estado, Notion y texto, y los filtros se acumulan', () => {
    const f = (p: Partial<Filtros>): Filtros => ({ ...SIN_FILTROS, ...p });
    expect(listar(todos, f({ formato: 'pdf' }), 'nombre').map((d) => d.fileName)).toEqual(['roto.pdf', 'viejo.pdf']);
    expect(listar(todos, f({ estado: 'failed' }), 'nombre').map((d) => d.fileName)).toEqual(['roto.pdf']);
    expect(listar(todos, f({ soloNotion: true }), 'nombre').map((d) => d.fileName)).toEqual(['foto.png']);
    // Acumulados: PDF Y fallido.
    expect(listar(todos, f({ formato: 'pdf', estado: 'failed' }), 'nombre').map((d) => d.fileName)).toEqual(['roto.pdf']);
    // Acumulados hasta no dejar nada.
    expect(listar(todos, f({ formato: 'word', estado: 'failed' }), 'nombre')).toEqual([]);
    // El texto se acumula con lo demás.
    expect(listar(todos, f({ formato: 'pdf', texto: 'viejo' }), 'nombre').map((d) => d.fileName)).toEqual(['viejo.pdf']);
  });

  test('hayFiltros distingue "sin tocar" de "filtrado a nada"', () => {
    expect(hayFiltros(SIN_FILTROS)).toBe(false);
    expect(hayFiltros({ ...SIN_FILTROS, texto: '  ' })).toBe(false);
    expect(hayFiltros({ ...SIN_FILTROS, texto: 'x' })).toBe(true);
    expect(hayFiltros({ ...SIN_FILTROS, formato: 'pdf' })).toBe(true);
    expect(hayFiltros({ ...SIN_FILTROS, soloNotion: true })).toBe(true);
  });
});

describe('la forma del corpus', () => {
  test('los fragmentos que se cuentan son los de lo LISTO', () => {
    // Un documento en proceso todavía no responde nada y uno fallido no lo
    // va a hacer: sumarlos infla la cifra de cuánta evidencia hay.
    const docs = [
      doc({ chunks: 50, status: 'ready' }),
      doc({ chunks: 30, status: 'processing' }),
      doc({ chunks: 99, status: 'failed' }),
      doc({ chunks: 10, status: 'ready', origen: 'notion' }),
    ];
    expect(resumir(docs)).toEqual({
      documentos: 4,
      fragmentos: 60,
      procesando: 1,
      fallidos: 1,
      deNotion: 1,
    });
  });

  test('la composición reparte por FRAGMENTOS y respeta el orden fijo', () => {
    const docs = [
      doc({ fileName: 'a.md', chunks: 25 }),
      doc({ fileName: 'b.pdf', chunks: 50 }),
      doc({ fileName: 'c.pdf', chunks: 25 }),
    ];
    const tramos = componer(docs);
    // PDF antes que texto aunque el .md se insertara primero.
    expect(tramos.map((t) => t.formato.familia)).toEqual(['pdf', 'texto']);
    expect(tramos[0]).toMatchObject({ documentos: 2, fragmentos: 75, fraccion: 0.75 });
    expect(tramos[1]).toMatchObject({ documentos: 1, fragmentos: 25, fraccion: 0.25 });
    // Y las fracciones suman 1.
    expect(tramos.reduce((s, t) => s + t.fraccion, 0)).toBeCloseTo(1);
  });

  test('los formatos que no tiene no aparecen', () => {
    expect(componer([doc({ fileName: 'a.pdf' })]).map((t) => t.formato.familia)).toEqual(['pdf']);
    expect(componer([])).toEqual([]);
  });

  test('con nada listo, las fracciones son 0 y no se divide por cero', () => {
    const tramos = componer([doc({ fileName: 'a.pdf', chunks: 9, status: 'processing' })]);
    expect(tramos).toHaveLength(1);
    expect(tramos[0]).toMatchObject({ documentos: 1, fragmentos: 0, fraccion: 0 });
  });

  test('el peso relativo se compara con el máximo y no aplasta a los pequeños', () => {
    const docs = [doc({ chunks: 57 }), doc({ chunks: 3 }), doc({ chunks: 0, status: 'failed' })];
    const max = maxFragmentos(docs);
    expect(max).toBe(57);
    expect(pesoRelativo(57, max)).toBe(1);
    // En lineal serían 0,05 (una línea invisible); en raíz, 0,23: se ve.
    expect(pesoRelativo(3, max)).toBeCloseTo(0.229, 2);
    expect(pesoRelativo(0, max)).toBe(0);
    // Sin nada listo no hay máximo: no se divide por cero.
    expect(maxFragmentos([doc({ chunks: 9, status: 'failed' })])).toBe(0);
    expect(pesoRelativo(9, 0)).toBe(0);
  });
});

describe('fechaCorta', () => {
  test('hoy, ayer, día y mes, y el año solo si es otro', () => {
    expect(fechaCorta(Date.parse('2026-09-07T09:00:00'), AHORA)).toBe('hoy');
    expect(fechaCorta(Date.parse('2026-09-06T23:59:00'), AHORA)).toBe('ayer');
    expect(fechaCorta(Date.parse('2026-09-01T10:00:00'), AHORA)).toBe('1 sep');
    expect(fechaCorta(Date.parse('2025-12-24T10:00:00'), AHORA)).toBe('24 dic 2025');
  });

  test('"ayer" es por día de calendario, no por 24 horas', () => {
    // 23:30 de ayer a 00:30 de hoy es una hora, pero es ayer.
    expect(fechaCorta(Date.parse('2026-09-06T23:30:00'), Date.parse('2026-09-07T00:30:00'))).toBe('ayer');
  });

  test('una fecha ausente o imposible da cadena vacía, no "Invalid Date"', () => {
    expect(fechaCorta(0, AHORA)).toBe('');
    expect(fechaCorta(Number.NaN, AHORA)).toBe('');
    expect(fechaCorta(-1, AHORA)).toBe('');
  });
});

describe('cifra', () => {
  test('separador de miles español, sin depender del ICU del runtime', () => {
    expect(cifra(7)).toBe('7');
    expect(cifra(999)).toBe('999');
    expect(cifra(1000)).toBe('1.000');
    expect(cifra(1240)).toBe('1.240');
    expect(cifra(1234567)).toBe('1.234.567');
    // Casos que no deberían pasar pero no pueden salir como "NaN" en pantalla.
    expect(cifra(0)).toBe('0');
    expect(cifra(Number.NaN)).toBe('0');
    expect(cifra(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
