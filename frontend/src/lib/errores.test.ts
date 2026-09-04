// Lo que se comprueba es que el frontend NO reconozca cadenas: un Error a
// secas con un texto en inglés nunca llega al usuario ni dispara la salida.
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { codigoDeError, esAccesoRevocado, esNoAutenticado, mensajeDeError } from './errores';

describe('mensajeDeError', () => {
  it('ConvexError con mensaje: se muestra tal cual', () => {
    const e = new ConvexError({ codigo: 'solo_admin', mensaje: 'Solo un administrador puede borrar.' });
    expect(mensajeDeError(e, 'x')).toBe('Solo un administrador puede borrar.');
  });

  it('ConvexError con data de texto: se muestra el texto', () => {
    expect(mensajeDeError(new ConvexError('No se encontró la conversación.'), 'x')).toBe(
      'No se encontró la conversación.',
    );
  });

  it('un Error corriente (mensaje del proveedor en inglés) NO se filtra', () => {
    expect(mensajeDeError(new Error('Invalid credentials'), 'No se pudo entrar.')).toBe('No se pudo entrar.');
    expect(mensajeDeError('Server Error', 'por defecto')).toBe('por defecto');
    expect(mensajeDeError(null, 'por defecto')).toBe('por defecto');
  });

  it('ConvexError sin mensaje ni texto útil cae al texto por defecto', () => {
    expect(mensajeDeError(new ConvexError({ codigo: 'raro' }), 'por defecto')).toBe('por defecto');
    expect(mensajeDeError(new ConvexError(''), 'por defecto')).toBe('por defecto');
    expect(mensajeDeError(new ConvexError({ mensaje: '   ' }), 'por defecto')).toBe('por defecto');
  });
});

describe('codigoDeError y las salidas forzadas', () => {
  it('solo un ConvexError con codigo acceso_revocado revoca', () => {
    expect(esAccesoRevocado(new ConvexError({ codigo: 'acceso_revocado', mensaje: 'x' }))).toBe(true);
    // Un Error cuyo texto menciona la revocación NO cuenta: sería reconocer cadenas.
    expect(esAccesoRevocado(new Error('acceso_revocado'))).toBe(false);
    expect(esAccesoRevocado(new ConvexError('acceso_revocado'))).toBe(false);
    expect(esAccesoRevocado(new ConvexError({ codigo: 'no_encontrado' }))).toBe(false);
  });

  it('no_autenticado se reconoce por código, y un código vacío no es código', () => {
    expect(esNoAutenticado(new ConvexError({ codigo: 'no_autenticado' }))).toBe(true);
    expect(codigoDeError(new ConvexError({ codigo: '' }))).toBeNull();
    expect(codigoDeError(new ConvexError({ codigo: 42 }))).toBeNull();
    expect(codigoDeError(undefined)).toBeNull();
  });

  it('acepta `code` como alias de `codigo`', () => {
    expect(codigoDeError(new ConvexError({ code: 'acceso_revocado' }))).toBe('acceso_revocado');
  });
});
