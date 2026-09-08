import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CLAVE_PREFERENCIAS, debeEnviar, leerPreferencias, normalizarPreferencias,
  PREFERENCIAS_INICIALES,
} from './preferencias';
import { AccountSettings } from '../components/AccountSettings';
import { SettingsPanel } from '../components/SettingsPanel';

let valores: Map<string, string>;
beforeEach(() => {
  valores = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((clave: string) => valores.get(clave) ?? null),
    setItem: vi.fn((clave: string, valor: string) => { valores.set(clave, valor); }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('preferencias locales', () => {
  it.each([null, undefined, [], 'incorrecto', 2, true, {}])('ignora valores inválidos: %j', (valor) => {
    expect(normalizarPreferencias(valor)).toEqual(PREFERENCIAS_INICIALES);
  });
  it('solo admite los campos y tipos conocidos, sin opciones del agente', () => {
    expect(normalizarPreferencias({
      tamanoLectura: 'grande', enterEnvia: false, reducirMovimiento: true, modelo: 'otro',
    })).toEqual({ tamanoLectura: 'grande', enterEnvia: false, reducirMovimiento: true });
    expect(normalizarPreferencias({
      tamanoLectura: 'gigante', enterEnvia: 'false', reducirMovimiento: 1,
    })).toEqual(PREFERENCIAS_INICIALES);
  });
  it('lee preferencias parciales y recupera almacenamiento corrupto', () => {
    valores.set(CLAVE_PREFERENCIAS, '{"tamanoLectura":"comodo"}');
    expect(leerPreferencias()).toEqual({ ...PREFERENCIAS_INICIALES, tamanoLectura: 'comodo' });
    valores.set(CLAVE_PREFERENCIAS, '{');
    expect(leerPreferencias()).toEqual(PREFERENCIAS_INICIALES);
  });
  it('funciona cuando el navegador bloquea localStorage', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('bloqueado'); } });
    expect(leerPreferencias()).toEqual(PREFERENCIAS_INICIALES);
  });
  it('aplica, persiste, sincroniza otras pestañas y mantiene cambios sin almacenamiento', async () => {
    vi.resetModules();
    const preferencias = await import('./preferencias');
    const dataset: Record<string, string> = {};
    const ventana = new EventTarget();
    vi.stubGlobal('document', { documentElement: { dataset } });
    vi.stubGlobal('window', ventana);
    const detener = preferencias.iniciarPreferencias();
    expect(dataset).toEqual({ lectura: 'estandar', reducirMovimiento: 'false' });
    expect(preferencias.guardarPreferencias({ tamanoLectura: 'grande' })).toBe(true);
    expect(JSON.parse(valores.get(CLAVE_PREFERENCIAS)!)).toEqual({
      ...PREFERENCIAS_INICIALES, tamanoLectura: 'grande',
    });
    expect(dataset.lectura).toBe('grande');
    const sincronizar = (key: string | null, storageArea: unknown = null) => {
      const evento = Object.assign(new Event('storage'), { key, storageArea });
      ventana.dispatchEvent(evento);
    };
    valores.set(CLAVE_PREFERENCIAS, '{"tamanoLectura":"comodo"}');
    sincronizar('otra-clave');
    expect(dataset.lectura).toBe('grande');
    sincronizar(CLAVE_PREFERENCIAS, {});
    expect(dataset.lectura).toBe('grande');
    sincronizar(CLAVE_PREFERENCIAS);
    expect(dataset.lectura).toBe('comodo');
    valores.clear();
    sincronizar(null);
    expect(dataset.lectura).toBe('estandar');
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('bloqueado'); },
      setItem() { throw new Error('bloqueado'); },
    });
    expect(preferencias.guardarPreferencias({ enterEnvia: false })).toBe(false);
    expect(preferencias.guardarPreferencias({ reducirMovimiento: true })).toBe(false);
    expect(dataset.reducirMovimiento).toBe('true');
    // Un nuevo guardado conserva los cambios de esta visita.
    const guardar = vi.fn();
    vi.stubGlobal('localStorage', { setItem: guardar });
    preferencias.guardarPreferencias({ tamanoLectura: 'grande' });
    expect(JSON.parse(guardar.mock.calls[0][1])).toEqual({
      tamanoLectura: 'grande', enterEnvia: false, reducirMovimiento: true,
    });
    detener();
  });
});

describe('envío de preguntas', () => {
  const enter = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false };
  it('conserva el comportamiento original por defecto', () => {
    expect(debeEnviar(enter, true)).toBe(true);
    expect(debeEnviar({ ...enter, shiftKey: true }, true)).toBe(false);
  });
  it('permite escribir varias líneas y enviar con Ctrl o Cmd', () => {
    expect(debeEnviar(enter, false)).toBe(false);
    expect(debeEnviar({ ...enter, ctrlKey: true }, false)).toBe(true);
    expect(debeEnviar({ ...enter, metaKey: true }, false)).toBe(true);
  });
  it.each([true, false])('no envía mientras se compone con IME o se inserta línea (%s)', (ajuste) => {
    expect(debeEnviar({ ...enter, isComposing: true }, ajuste)).toBe(false);
    expect(debeEnviar({ ...enter, keyCode: 229 }, ajuste)).toBe(false);
    expect(debeEnviar({ ...enter, key: 'Process' }, ajuste)).toBe(false);
    expect(debeEnviar({ ...enter, key: 'a' }, ajuste)).toBe(false);
    expect(debeEnviar({ ...enter, shiftKey: true, ctrlKey: true }, ajuste)).toBe(false);
    expect(debeEnviar({ ...enter, altKey: true }, ajuste)).toBe(false);
  });
});

describe('presentación de Ajustes', () => {
  it('ofrece seis radios nativos, dos interruptores y una salida de sesión', () => {
    const html = renderToStaticMarkup(createElement(AccountSettings, {
      userEmail: 'investigacion@example.org', role: 'lector', onSignOut: () => {},
    }));
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain('Restablecer preferencias');
    expect(html).toContain('Cerrar sesión');
    expect(html).toContain('Miembro');
    expect(html).toContain('No cambian tus documentos');
  });
  it.each(['lector', null] as const)('no expone pestañas de administración al rol %s', (role) => {
    // Se puede renderizar sin ConvexProvider: no se montan queries de admin.
    const html = renderToStaticMarkup(createElement(SettingsPanel, {
      open: true, onClose: () => {}, role, currentUserId: null,
      userEmail: 'investigacion@example.org', onSignOut: () => {},
    }));
    // Mi cuenta y Calidad para todo el mundo; Usuarios y Sistema, ni montadas.
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('id="settings-tab-calidad"');
    expect(html).not.toContain('id="settings-tab-usuarios"');
    expect(html).not.toContain('id="settings-tab-sistema"');
    expect(html).not.toContain('Tu equipo de investigación');
    expect(html).toContain('Hazlo tuyo');
  });
  it('abre Mi cuenta por defecto para el administrador sin consultar otras pestañas', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, {
      open: true, onClose: () => {}, role: 'admin', currentUserId: null,
      userEmail: 'investigacion@example.org', onSignOut: () => {},
    }));
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toMatch(/id="settings-tab-cuenta" aria-selected="true" tabindex="0"/);
    expect(html).toContain('Administrador');
    expect(html).toContain('Hazlo tuyo');
  });
});
