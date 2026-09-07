import { describe, expect, test } from 'vitest';
import {
  avisoParaCerrarEmergenteNube,
  describirCorridaNube,
  describirProgresoNube,
  esAvisoNube,
  fraccionProgresoNube,
  leerAvisoNube,
  MARCA_VIDA_MS,
  ponerMarcaNube,
  textoDeAvisoNube,
  urlSinAvisoNube,
} from './nube';
import type { AlmacenSimple } from './notion';
import type { CorridaNube, ProgresoNube } from '../types';

const AHORA = Date.parse('2026-09-07T12:00:00Z');

function corrida(extra: Partial<CorridaNube> = {}): CorridaNube {
  return {
    empezadoEn: AHORA - 13 * 60_000,
    terminadoEn: AHORA - 12 * 60_000,
    estado: 'ok',
    ficheros: 14,
    nuevos: 3,
    actualizados: 1,
    borrados: 0,
    errores: [],
    ...extra,
  };
}

function almacen(): AlmacenSimple & { datos: Map<string, string> } {
  const datos = new Map<string, string>();
  return {
    datos,
    getItem: (k) => datos.get(k) ?? null,
    setItem: (k, v) => void datos.set(k, v),
    removeItem: (k) => void datos.delete(k),
  };
}

describe('leerAvisoNube', () => {
  test('reconoce proveedor, resultado y motivo corto', () => {
    expect(leerAvisoNube('?nube=google&resultado=conectado')).toEqual({ proveedor: 'google', tipo: 'conectado' });
    expect(leerAvisoNube('?x=1&nube=onedrive&resultado=cancelado')).toEqual({ proveedor: 'onedrive', tipo: 'cancelado' });
    expect(leerAvisoNube('?nube=google&resultado=error&motivo=estado')).toEqual({ proveedor: 'google', tipo: 'error', motivo: 'estado' });
    expect(leerAvisoNube('?nube=google&resultado=error')).toEqual({ proveedor: 'google', tipo: 'error', motivo: null });
  });

  test('ADVERSARIAL: ignora proveedores y resultados desconocidos, y un motivo raro', () => {
    expect(leerAvisoNube('')).toBeNull();
    expect(leerAvisoNube('?nube=dropbox&resultado=conectado')).toBeNull();
    expect(leerAvisoNube('?nube=google&resultado=otro')).toBeNull();
    expect(leerAvisoNube('?notion=conectado')).toBeNull();
    expect(leerAvisoNube('?nube=google&resultado=error&motivo=<script>')).toEqual({ proveedor: 'google', tipo: 'error', motivo: null });
  });
});

describe('urlSinAvisoNube', () => {
  test('quita nube, resultado y motivo, y conserva el resto', () => {
    expect(urlSinAvisoNube('https://app.example/?nube=google&resultado=conectado')).toBe('/');
    expect(urlSinAvisoNube('https://app.example/ruta?a=1&nube=onedrive&resultado=error&motivo=estado#h')).toBe('/ruta?a=1#h');
  });
});

describe('textos', () => {
  test('nombran al proveedor y no hablan de tokens, variables, ids ni API', () => {
    const avisos = [
      textoDeAvisoNube({ proveedor: 'google', tipo: 'conectado' }),
      textoDeAvisoNube({ proveedor: 'onedrive', tipo: 'cancelado' }),
      textoDeAvisoNube({ proveedor: 'google', tipo: 'error', motivo: 'estado' }),
      textoDeAvisoNube({ proveedor: 'onedrive', tipo: 'error', motivo: 'no_habilitada' }),
      textoDeAvisoNube({ proveedor: 'google', tipo: 'error', motivo: 'intercambio' }),
      textoDeAvisoNube({ proveedor: 'google', tipo: 'error', motivo: null }),
    ];
    expect(avisos[0]).toContain('Google Drive');
    expect(avisos[1]).toContain('OneDrive');
    for (const a of avisos) expect(a).not.toMatch(/token|variable|\bid\b|API|OAuth|client/i);
  });

  test('la corrida se describe en archivos, con los cambios o "sin cambios"', () => {
    expect(describirCorridaNube(corrida(), AHORA)).toBe('Hace 12 minutos: 14 archivos revisados, 3 documentos nuevos, 1 actualizado');
    expect(describirCorridaNube(corrida({ nuevos: 0, actualizados: 0 }), AHORA)).toBe('Hace 12 minutos: 14 archivos revisados, sin cambios');
    expect(describirCorridaNube(corrida({ ficheros: 1, nuevos: 0, actualizados: 0, borrados: 2 }), AHORA)).toBe(
      'Hace 12 minutos: 1 archivo revisado, 2 retirados',
    );
  });

  test('el progreso dice cuántos van y cuál se lee, y la fracción acompaña', () => {
    const p: ProgresoNube = {
      vivaHasta: AHORA + 60_000, empezadoEn: AHORA, ficherosTotal: 20, ficherosProcesados: 8, ficheroActual: 'Protocolos/guia.pdf',
      nuevos: 0, actualizados: 0, borrados: 0, errores: [],
    };
    expect(describirProgresoNube(p)).toBe('Sincronizando: 8 de 20 archivos, ahora: Protocolos/guia.pdf');
    expect(fraccionProgresoNube(p)).toBe(0.4);
    expect(describirProgresoNube({ ...p, ficherosTotal: null })).toBe('Sincronizando: leyendo las carpetas…');
    expect(fraccionProgresoNube({ ...p, ficherosTotal: null })).toBeNull();
    expect(fraccionProgresoNube({ ...p, ficherosTotal: 0 })).toBe(1);
    expect(fraccionProgresoNube({ ...p, ficherosProcesados: 99 })).toBe(1);
  });
});

describe('emergente', () => {
  test('esAvisoNube exige un proveedor conocido', () => {
    expect(esAvisoNube({ proveedor: 'google', tipo: 'conectado' })).toBe(true);
    expect(esAvisoNube({ proveedor: 'onedrive', tipo: 'error', motivo: null })).toBe(true);
    expect(esAvisoNube({ tipo: 'conectado' })).toBe(false);
    expect(esAvisoNube({ proveedor: 'box', tipo: 'conectado' })).toBe(false);
    expect(esAvisoNube(null)).toBe(false);
  });

  test('solo cierra la emergente si la URL trae ?nube= Y hay marca reciente; la marca se consume', () => {
    const a = almacen();
    // Sin marca: página completa (respaldo).
    expect(avisoParaCerrarEmergenteNube('?nube=google&resultado=conectado', a, AHORA)).toBeNull();
    ponerMarcaNube(a, AHORA - 1000);
    // ADVERSARIAL: una carga sin ?nube= NO gasta la marca.
    expect(avisoParaCerrarEmergenteNube('', a, AHORA)).toBeNull();
    expect(a.datos.size).toBe(1);
    expect(avisoParaCerrarEmergenteNube('?nube=google&resultado=conectado', a, AHORA)).toEqual({ proveedor: 'google', tipo: 'conectado' });
    expect(a.datos.size).toBe(0);
    // Marca vieja: no cuenta.
    ponerMarcaNube(a, AHORA - MARCA_VIDA_MS - 1);
    expect(avisoParaCerrarEmergenteNube('?nube=google&resultado=conectado', a, AHORA)).toBeNull();
  });
});
