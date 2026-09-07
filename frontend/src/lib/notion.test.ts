import { describe, expect, test } from 'vitest';
import {
  avisoParaCerrarEmergente,
  describirCorrida,
  describirProgreso,
  fraccionProgreso,
  haceCuanto,
  iconoEsImagen,
  esAvisoNotion,
  leerAvisoNotion,
  MARCA_VIDA_MS,
  ponerMarcaConexion,
  quitarMarcaConexion,
  rasgosEmergente,
  textoDeAviso,
  urlSinAvisoNotion,
} from './notion';
import type { AlmacenSimple } from './notion';
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
      vivaHasta: Number.MAX_SAFE_INTEGER,
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

// ---------------------------------------------------------------------------
// Vuelta de Notion sin abandonar la aplicación
// ---------------------------------------------------------------------------
//
// Estas pruebas van a por los modos de fallo, no a por el camino feliz: que la
// marca no se gaste de más, que no se gaste de menos, que un almacén que lanza
// no tumbe nada y que un aviso venido de otra ventana no pueda colar texto en
// la pantalla.

/** `localStorage` de mentira. Las pruebas corren en `edge-runtime`, sin DOM. */
function almacenFalso(inicial: Record<string, string> = {}) {
  const mapa = new Map(Object.entries(inicial));
  return {
    getItem: (k: string) => mapa.get(k) ?? null,
    setItem: (k: string, v: string) => void mapa.set(k, v),
    removeItem: (k: string) => void mapa.delete(k),
    tamano: () => mapa.size,
  };
}

/** Almacén que lanza en todo: modo privado con el almacenamiento bloqueado. */
const almacenRoto: AlmacenSimple = {
  getItem() {
    throw new Error('bloqueado');
  },
  setItem() {
    throw new Error('bloqueado');
  },
  removeItem() {
    throw new Error('bloqueado');
  },
};

describe('marca de conexión con Notion', () => {
  test('la marca se consume UNA vez: una segunda pestaña con la misma URL ya no se cierra', () => {
    const a = almacenFalso();
    ponerMarcaConexion(a, AHORA);
    expect(avisoParaCerrarEmergente('?notion=conectado', a, AHORA + 5_000)).toEqual({
      tipo: 'conectado',
    });
    expect(avisoParaCerrarEmergente('?notion=conectado', a, AHORA + 6_000)).toBeNull();
    expect(a.tamano()).toBe(0);
  });

  test('una carga SIN ?notion= no gasta la marca, aunque la emergente siga abierta', () => {
    const a = almacenFalso();
    ponerMarcaConexion(a, AHORA);
    expect(avisoParaCerrarEmergente('', a, AHORA + 1_000)).toBeNull();
    expect(avisoParaCerrarEmergente('?otra=cosa', a, AHORA + 2_000)).toBeNull();
    // …y cuando por fin vuelve la emergente, la marca sigue ahí.
    expect(avisoParaCerrarEmergente('?notion=conectado', a, AHORA + 3_000)).toEqual({
      tipo: 'conectado',
    });
  });

  test('sin marca (respaldo de página completa) se monta la aplicación, no se cierra la pestaña', () => {
    const a = almacenFalso();
    expect(avisoParaCerrarEmergente('?notion=conectado', a, AHORA)).toBeNull();
  });

  test('una marca vieja o con un reloj imposible no cierra nada', () => {
    const vieja = almacenFalso();
    ponerMarcaConexion(vieja, AHORA - MARCA_VIDA_MS - 1);
    expect(avisoParaCerrarEmergente('?notion=conectado', vieja, AHORA)).toBeNull();

    // Justo en el límite tampoco: la vida es estrictamente menor.
    const limite = almacenFalso();
    ponerMarcaConexion(limite, AHORA - MARCA_VIDA_MS);
    expect(avisoParaCerrarEmergente('?notion=conectado', limite, AHORA)).toBeNull();

    // Marca del futuro (reloj cambiado): no se acepta.
    const futura = almacenFalso();
    ponerMarcaConexion(futura, AHORA + 60_000);
    expect(avisoParaCerrarEmergente('?notion=conectado', futura, AHORA)).toBeNull();

    // Basura escrita a mano.
    const basura = almacenFalso({ 'rag:notion-conectando': 'ayer' });
    expect(avisoParaCerrarEmergente('?notion=conectado', basura, AHORA)).toBeNull();
  });

  test('la vuelta con error también cierra la emergente: si no, quedaría abierta para siempre', () => {
    const a = almacenFalso();
    ponerMarcaConexion(a, AHORA);
    expect(avisoParaCerrarEmergente('?notion=error&motivo=estado', a, AHORA + 1_000)).toEqual({
      tipo: 'error',
      motivo: 'estado',
    });
  });

  test('un almacén que lanza no rompe nada: se comporta como si no hubiera marca', () => {
    expect(() => ponerMarcaConexion(almacenRoto, AHORA)).not.toThrow();
    expect(() => quitarMarcaConexion(almacenRoto)).not.toThrow();
    expect(avisoParaCerrarEmergente('?notion=conectado', almacenRoto, AHORA)).toBeNull();
  });
});

describe('avisos que llegan de otra ventana', () => {
  test('solo se aceptan las formas conocidas', () => {
    expect(esAvisoNotion({ tipo: 'conectado' })).toBe(true);
    expect(esAvisoNotion({ tipo: 'cancelado' })).toBe(true);
    expect(esAvisoNotion({ tipo: 'error', motivo: 'estado' })).toBe(true);
    expect(esAvisoNotion({ tipo: 'error', motivo: null })).toBe(true);
    expect(esAvisoNotion({ tipo: 'error' })).toBe(true);

    expect(esAvisoNotion(null)).toBe(false);
    expect(esAvisoNotion('conectado')).toBe(false);
    expect(esAvisoNotion({})).toBe(false);
    expect(esAvisoNotion({ tipo: 'CONECTADO' })).toBe(false);
    expect(esAvisoNotion({ tipo: 'error', motivo: { toString: 'no' } })).toBe(false);
    expect(esAvisoNotion({ tipo: 'error', motivo: 7 })).toBe(false);
  });

  test('un motivo hostil nunca llega a la pantalla: sale el texto genérico', () => {
    const hostil = { tipo: 'error' as const, motivo: '<img src=x onerror=alert(1)>' };
    expect(esAvisoNotion(hostil)).toBe(true);
    expect(textoDeAviso(hostil)).toBe(
      'No se completó la conexión con Notion. Vuelve a intentarlo en un momento.',
    );
    expect(textoDeAviso(hostil)).not.toContain('onerror');
  });
});

describe('rasgosEmergente', () => {
  test('centra la ventana y nunca sale de la pantalla', () => {
    const r = rasgosEmergente({ width: 1920, height: 1080 });
    expect(r).toContain('width=820');
    expect(r).toContain('height=860');
    expect(r).toContain('left=550');
    expect(r).toContain('top=110');
  });

  test('en una pantalla diminuta no da tamaños ni posiciones negativas', () => {
    const r = rasgosEmergente({ width: 320, height: 480 });
    for (const [, valor] of r.matchAll(/(?:width|height|left|top)=(-?\d+)/g)) {
      expect(Number(valor)).toBeGreaterThanOrEqual(0);
    }
    expect(r).toContain('left=0');
    expect(r).toContain('top=0');
  });
});
