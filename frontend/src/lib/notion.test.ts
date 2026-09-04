import { describe, expect, test } from 'vitest';
import {
  describirCorrida,
  describirProgreso,
  fraccionProgreso,
  haceCuanto,
  iconoEsImagen,
  leerAvisoNotion,
  textoDeAviso,
  urlSinAvisoNotion,
} from './notion';
import type { CorridaNotion, ProgresoNotion } from '../types';

const AHORA = Date.parse('2026-09-04T12:00:00Z');

function corrida(extra: Partial<CorridaNotion> = {}): CorridaNotion {
  return {
    empezadoEn: AHORA - 13 * 60_000,
    terminadoEn: AHORA - 12 * 60_000,
    estado: 'ok',
    paginas: 14,
    nuevos: 3,
    actualizados: 1,
    borrados: 0,
    errores: [],
    ...extra,
  };
}

describe('leerAvisoNotion', () => {
  test('reconoce los tres resultados y el motivo corto', () => {
    expect(leerAvisoNotion('?notion=conectado')).toEqual({ tipo: 'conectado' });
    expect(leerAvisoNotion('?x=1&notion=cancelado')).toEqual({ tipo: 'cancelado' });
    expect(leerAvisoNotion('?notion=error&motivo=estado')).toEqual({ tipo: 'error', motivo: 'estado' });
    expect(leerAvisoNotion('?notion=error')).toEqual({ tipo: 'error', motivo: null });
  });

  test('ignora lo que no reconoce, incluido un motivo con caracteres raros', () => {
    expect(leerAvisoNotion('')).toBeNull();
    expect(leerAvisoNotion('?notion=otro')).toBeNull();
    expect(leerAvisoNotion('?notion=error&motivo=<script>')).toEqual({ tipo: 'error', motivo: null });
  });
});

describe('urlSinAvisoNotion', () => {
  test('quita solo notion y motivo, y conserva el resto', () => {
    expect(urlSinAvisoNotion('https://app.example/?notion=conectado')).toBe('/');
    expect(urlSinAvisoNotion('https://app.example/ruta?a=1&notion=error&motivo=estado#h')).toBe('/ruta?a=1#h');
  });
});

describe('textos', () => {
  test('los avisos no hablan de tokens, variables, ids ni API', () => {
    const textos = [
      textoDeAviso({ tipo: 'conectado' }),
      textoDeAviso({ tipo: 'cancelado' }),
      textoDeAviso({ tipo: 'error', motivo: 'estado' }),
      textoDeAviso({ tipo: 'error', motivo: 'no_habilitada' }),
      textoDeAviso({ tipo: 'error', motivo: 'intercambio' }),
      textoDeAviso({ tipo: 'error', motivo: null }),
    ];
    for (const t of textos) {
      expect(t).not.toMatch(/\btoken\b|\bvariable\b|\bid\b|\bAPI\b|NOTION_/i);
      expect(t.length).toBeGreaterThan(20);
    }
    expect(textoDeAviso({ tipo: 'error', motivo: 'estado' })).toMatch(/caducado/);
  });

  test('haceCuanto con palabras completas', () => {
    expect(haceCuanto(AHORA - 10_000, AHORA)).toBe('hace un momento');
    expect(haceCuanto(AHORA - 60_000, AHORA)).toBe('hace 1 minuto');
    expect(haceCuanto(AHORA - 12 * 60_000, AHORA)).toBe('hace 12 minutos');
    expect(haceCuanto(AHORA - 3 * 3_600_000, AHORA)).toBe('hace 3 horas');
    expect(haceCuanto(AHORA - 72 * 3_600_000, AHORA)).toBe('hace 3 días');
  });

  test('describirCorrida en una frase llana', () => {
    expect(describirCorrida(corrida(), AHORA)).toBe(
      'Hace 12 minutos: 14 páginas revisadas, 3 documentos nuevos, 1 actualizado',
    );
    expect(describirCorrida(corrida({ nuevos: 0, actualizados: 0, borrados: 2, paginas: 1 }), AHORA)).toBe(
      'Hace 12 minutos: 1 página revisada, 2 retirados',
    );
    expect(describirCorrida(corrida({ nuevos: 0, actualizados: 0 }), AHORA)).toBe(
      'Hace 12 minutos: 14 páginas revisadas, sin cambios',
    );
    // Sin `terminadoEn` (corrida que murió) se usa el inicio.
    expect(describirCorrida(corrida({ terminadoEn: null }), AHORA)).toMatch(/^Hace 13 minutos/);
  });

  test('describirProgreso y fraccionProgreso', () => {
    const p: ProgresoNotion = {
      empezadoEn: AHORA,
      paginasTotal: 20,
      paginasProcesadas: 8,
      paginaActual: 'Protocolo de p-tau217',
      nuevos: 0,
      actualizados: 0,
      borrados: 0,
      errores: [],
    };
    expect(describirProgreso(p)).toBe('Sincronizando: 8 de 20 páginas, ahora: Protocolo de p-tau217');
    expect(fraccionProgreso(p)).toBeCloseTo(0.4);
    expect(describirProgreso({ ...p, paginaActual: null })).toBe('Sincronizando: 8 de 20 páginas');
    expect(describirProgreso({ ...p, paginasTotal: null })).toBe('Sincronizando: leyendo la lista de páginas…');
    expect(fraccionProgreso({ ...p, paginasTotal: null })).toBeNull();
    expect(fraccionProgreso({ ...p, paginasTotal: 0 })).toBe(1);
    expect(fraccionProgreso({ ...p, paginasProcesadas: 25 })).toBe(1);
  });

  test('iconoEsImagen solo con http(s)', () => {
    expect(iconoEsImagen('https://img.example/i.png')).toBe(true);
    expect(iconoEsImagen('🧠')).toBe(false);
    expect(iconoEsImagen('javascript:alert(1)')).toBe(false);
    expect(iconoEsImagen(null)).toBe(false);
  });
});
