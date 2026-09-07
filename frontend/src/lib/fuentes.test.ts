import { describe, expect, it } from 'vitest';
import type { PlanItem, Source } from '../types';
import { extensionDe, piezasDeMeta, sirvioPara, tituloDeFuente } from './fuentes';

const fuente = (extra: Partial<Source> = {}): Source => ({
  source_file: '01_hipertension_adultos.pdf',
  page: 3,
  snippet: 'texto',
  score: 0.03,
  ...extra,
});

const plan: PlanItem[] = [
  { id: 'e0', query: 'todo', evidence_needed: 'la pregunta entera' },
  { id: 'e1', query: 'q1', evidence_needed: 'cifras de tensión objetivo' },
  { id: 'e2', query: 'q2', evidence_needed: 'fármacos de primera línea' },
];

const textos = (s: Source, p: PlanItem[] = plan) => piezasDeMeta(s, p).map((x) => x.texto);

describe('extensionDe', () => {
  it('la extensión en minúsculas, y vacío si no hay', () => {
    expect(extensionDe('Guia.PDF')).toBe('pdf');
    expect(extensionDe('informe.final.docx')).toBe('docx');
    expect(extensionDe('sin_extension')).toBe('');
    expect(extensionDe('C:\\ruta\\a\\fichero.md')).toBe('md');
  });
});

describe('piezasDeMeta: nada redundante', () => {
  it('ADVERSARIAL: el formato no se repite si la extensión del fichero ya lo dice', () => {
    // El caso de la captura: "01_hipertension… · pág. 3 · Resumen ejecutivo ·
    // pdf" decía "pdf" al lado de un fichero que acaba en .pdf.
    const s = fuente({ citation: 'OMS, 2024', section: 'Resumen ejecutivo', document_type: 'pdf' });
    expect(textos(s)).toEqual(['01_hipertension_adultos.pdf', 'pág. 3', 'Resumen ejecutivo']);
  });

  it('un formato que NO es la extensión sí se dice (una imagen indexada por OCR)', () => {
    const s = fuente({ source_file: 'protocolo.png', citation: 'Protocolo', document_type: 'imagen' });
    expect(textos(s)).toContain('imagen');
  });

  it('el nombre del fichero no se repite cuando es el propio título de la tarjeta', () => {
    const s = fuente({ document_type: 'pdf' });
    expect(tituloDeFuente(s)).toBe('01_hipertension_adultos.pdf');
    expect(textos(s)).toEqual(['pág. 3']);
  });

  it('sin página no se inventa una: manda el localizador del backend', () => {
    const sinPagina = fuente({ citation: 'Guía', page: null, locator: 'tabla 2' });
    expect(textos(sinPagina)).toEqual(['01_hipertension_adultos.pdf', 'tabla 2']);
    const soloFichero = fuente({ citation: 'Guía', page: null, document_type: 'pdf' });
    expect(textos(soloFichero)).toEqual(['01_hipertension_adultos.pdf']);
  });

  it('la sección no se repite si el localizador ya es esa sección', () => {
    const s = fuente({ citation: 'Guía', page: null, locator: 'sección: Métodos', section: 'Métodos' });
    expect(textos(s)).toEqual(['01_hipertension_adultos.pdf', 'sección: Métodos']);
  });
});

describe('piezasDeMeta: para qué sirvió', () => {
  it('el ancla e0 no cuenta como punto: sirvió para la pregunta entera no informa', () => {
    expect(sirvioPara(fuente({ plan_items: ['e0'] }), plan)).toBeNull();
    expect(textos(fuente({ citation: 'Guía', plan_items: ['e0'] }))).not.toContain('sirvió para 1 punto');
  });

  it('cuenta los puntos reales y el tooltip lleva su evidencia necesaria', () => {
    const r = sirvioPara(fuente({ plan_items: ['e0', 'e1', 'e2'] }), plan);
    expect(r?.texto).toBe('sirvió para 2 puntos');
    expect(r?.titulo).toBe('cifras de tensión objetivo\nfármacos de primera línea');
  });

  it('sin el plan a mano (un mensaje de otra sesión) el texto se emite igual', () => {
    const r = sirvioPara(fuente({ plan_items: ['e1'] }), []);
    expect(r?.texto).toBe('sirvió para 1 punto');
    expect(r?.titulo).toBe('Puntos del plan de evidencia');
  });
});

describe('piezasDeMeta: las clases que la vista necesita', () => {
  it('solo el fichero se marca como recortable, y el plan lleva su clase', () => {
    const piezas = piezasDeMeta(
      fuente({ citation: 'OMS, 2024', section: 'Resumen ejecutivo', language: 'es', plan_items: ['e1'] }),
      plan,
    );
    expect(piezas.filter((p) => p.clase === 'source-meta-file')).toHaveLength(1);
    expect(piezas[0].clase).toBe('source-meta-file');
    expect(piezas[piezas.length - 1].clase).toBe('source-meta-plan');
    // Las demás no llevan clase: no se recortan, se dejan pasar de línea.
    expect(piezas.slice(1, -1).every((p) => p.clase === undefined)).toBe(true);
  });
});
