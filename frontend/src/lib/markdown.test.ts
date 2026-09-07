// El bloque de diagrama de una respuesta (```flujo): solo la parte pura, que
// es la que decide qué es un paso y qué es una rama. El render con React no se
// prueba aquí porque el proyecto no monta DOM en los tests.
import { describe, expect, it } from 'vitest';
import { parsearFlujo } from './markdown';

describe('parsearFlujo', () => {
  it('una línea, un paso; las vacías no cuentan', () => {
    const pasos = parsearFlujo('Medir la PA en consulta\n\nConfirmar con MAPA\n   \nIniciar tratamiento');
    expect(pasos.map((p) => p.texto)).toEqual([
      'Medir la PA en consulta',
      'Confirmar con MAPA',
      'Iniciar tratamiento',
    ]);
    expect(pasos.every((p) => !p.rama)).toBe(true);
  });

  it('las condiciones y las viñetas son ramas, no pasos siguientes', () => {
    const pasos = parsearFlujo(
      [
        'PA ≥ 140/90 en consulta [g.pdf, pág. 4]',
        'Si se confirma con MAPA: iniciar tratamiento [g.pdf, pág. 9]',
        '- reevaluar a las 4 semanas [g.pdf, pág. 9]',
        '→ si no se confirma: seguimiento anual [g.pdf, pág. 9]',
      ].join('\n'),
    );
    expect(pasos.map((p) => p.rama)).toEqual([false, true, true, true]);
    // La marca de viñeta o flecha no se queda en el texto.
    expect(pasos[2].texto).toBe('reevaluar a las 4 semanas [g.pdf, pág. 9]');
    expect(pasos[3].texto).toBe('si no se confirma: seguimiento anual [g.pdf, pág. 9]');
  });

  it('ADVERSARIAL: "Sistólica: 140" no es una rama por llevar dos puntos', () => {
    const pasos = parsearFlujo('Sistólica: 140 mmHg\nSi es mayor: derivar');
    expect(pasos.map((p) => p.rama)).toEqual([false, true]);
  });

  it('la cabecera de un grafo de mermaid se ignora en vez de pintarse como paso', () => {
    const pasos = parsearFlujo('graph TD\nMedir la PA\nConfirmar');
    expect(pasos.map((p) => p.texto)).toEqual(['Medir la PA', 'Confirmar']);
  });

  it('un bloque vacío no produce pasos: el renderizador cae a bloque de código', () => {
    expect(parsearFlujo('')).toEqual([]);
    expect(parsearFlujo('\n  \n')).toEqual([]);
  });
});

describe('etiquetasDeMermaid', () => {
  it('saca las etiquetas de los nodos en orden y sin repetir, no la sintaxis', async () => {
    const { etiquetasDeMermaid } = await import('../components/Diagrama');
    const codigo = [
      'flowchart TD',
      '  A["PA en consulta 140/90 o más"] --> B["Confirmar con MAPA"]',
      '  B -->|se confirma| C["Iniciar tratamiento"]',
      '  B -->|no se confirma| D["Reevaluar en 6 meses"]',
      '  C --> E["Reevaluar a las 4 semanas"]',
    ].join('\n');
    expect(etiquetasDeMermaid(codigo).split('\n')).toEqual([
      'PA en consulta 140/90 o más',
      'Confirmar con MAPA',
      'Si se confirma: Iniciar tratamiento',
      'Si no se confirma: Reevaluar en 6 meses',
      'Reevaluar a las 4 semanas',
    ]);
  });

  it('el respaldo de un diagrama son pasos legibles, con las ramas marcadas', async () => {
    const { respaldoDeMermaid } = await import('../components/Diagrama');
    const pasos = respaldoDeMermaid(
      'flowchart TD\n A["Medir"] --> B{"¿Confirmada?"}\n B -->|sí| C["Tratar"]',
    );
    expect(pasos.map((p) => [p.texto, p.rama])).toEqual([
      ['Medir', false],
      ['¿Confirmada?', false],
      ['Si sí: Tratar', true],
    ]);
  });

  it('un código que no es un grafo no produce etiquetas y el respaldo queda vacío', async () => {
    const { etiquetasDeMermaid, respaldoDeMermaid } = await import('../components/Diagrama');
    expect(etiquetasDeMermaid('flowchart TD')).toBe('');
    expect(respaldoDeMermaid('%% solo un comentario')).toEqual([]);
  });
});

describe('etiquetasDeMermaid con un mapa mental', () => {
  it('cada línea es un nodo, la raíz sin su forma, y la cabecera no cuenta', async () => {
    const { etiquetasDeMermaid, respaldoDeMermaid } = await import('../components/Diagrama');
    const codigo = [
      'mindmap',
      '  root((p-tau217 en plasma))',
      '    Cohorte china',
      '      AUC 0.983 frente a controles',
      '    Clínica de memoria en Tailandia',
      '      AUC 0.932 para AD frente a no AD',
    ].join('\n');
    expect(etiquetasDeMermaid(codigo).split('\n')).toEqual([
      'p-tau217 en plasma',
      'Cohorte china',
      'AUC 0.983 frente a controles',
      'Clínica de memoria en Tailandia',
      'AUC 0.932 para AD frente a no AD',
    ]);
    expect(respaldoDeMermaid(codigo)).toHaveLength(5);
  });
});
