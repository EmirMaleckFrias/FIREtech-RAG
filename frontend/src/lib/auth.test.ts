// Dominio permitido y salida forzada. Los casos negativos son los que valen:
// un dominio que CONTIENE el permitido, un aviso que no debe dispararse.
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { avisarSiEsFatal, isAllowedEmail, motivoDeSalida, onSalidaForzada } from './auth';

describe('isAllowedEmail', () => {
  it('acepta el dominio exacto, sin distinguir mayúsculas ni espacios', () => {
    expect(isAllowedEmail('ana@airobotix.net')).toBe(true);
    expect(isAllowedEmail('  Ana.Perez@AIROBOTIX.NET ')).toBe(true);
  });

  it('rechaza dominios que contienen o extienden el permitido', () => {
    expect(isAllowedEmail('ana@airobotix.net.atacante.com')).toBe(false);
    expect(isAllowedEmail('ana@sub.airobotix.net')).toBe(false);
    expect(isAllowedEmail('ana@notairobotix.net')).toBe(false);
    expect(isAllowedEmail('airobotix.net')).toBe(false);
    expect(isAllowedEmail('ana@airobotix.net@otro.com')).toBe(false);
  });

  it('rechaza lo que no es un correo', () => {
    expect(isAllowedEmail('')).toBe(false);
    expect(isAllowedEmail('@airobotix.net')).toBe(false);
    expect(isAllowedEmail('ana @airobotix.net')).toBe(false);
  });
});

describe('salida forzada', () => {
  it('solo los códigos de acceso obligan a salir', () => {
    expect(motivoDeSalida(new ConvexError({ codigo: 'acceso_revocado' }))).toBe('revocado');
    expect(motivoDeSalida(new ConvexError({ codigo: 'no_autenticado' }))).toBe('expirado');
    expect(motivoDeSalida(new ConvexError({ codigo: 'no_encontrado' }))).toBeNull();
    expect(motivoDeSalida(new Error('Unauthorized'))).toBeNull();
  });

  it('avisa a los suscriptores solo en los casos fatales y devuelve si lo hizo', () => {
    const recibidos: string[] = [];
    const off = onSalidaForzada((m) => recibidos.push(m));
    try {
      expect(avisarSiEsFatal(new Error('cualquier cosa'))).toBe(false);
      expect(recibidos).toEqual([]);
      expect(avisarSiEsFatal(new ConvexError({ codigo: 'acceso_revocado' }))).toBe(true);
      expect(recibidos).toEqual(['revocado']);
    } finally {
      off();
    }
    // Des-suscrito: ya no llega nada.
    avisarSiEsFatal(new ConvexError({ codigo: 'no_autenticado' }));
    expect(recibidos).toEqual(['revocado']);
  });
});
