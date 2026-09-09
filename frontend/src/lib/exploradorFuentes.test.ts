import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  agruparFuentes, enlaceDoi, filtrarFuentes, normalizarBusqueda,
  puntosDeFuentes, resolverDestino, textoParaCopiar,
} from './exploradorFuentes';
import { SourcesPanel } from '../components/SourcesPanel';
import { citationPages, extractCitations, parseCitation } from './markdown';
import type { ChatMessage, Source } from '../types';

const fuente = (extra: Partial<Source> = {}): Source => ({
  source_file: 'estudio.pdf', page: 3, snippet: 'La población mostró una mejoría.',
  score: .83, citation: 'Allegri et al., 2021', ...extra,
});
const mensaje = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  localId: 'm1', id: null, role: 'assistant', content: '', sources: [], progreso: '', alcance: null,
  hops: [], plan: [], verificacion: null, estado: 'listo', streaming: false,
  error: null, feedback: null, creadoEn: 0, ...extra,
});
const cita = '[Allegri et al., 2021, pág. 3]';

describe('identidad y asociación de citas', () => {
  it('distingue documentos y fragmentos, ordenando primero los asociados a citas', () => {
    const grupos = agruparFuentes([
      fuente({ source_file: 'otro.pdf', citation: '', page: 1 }),
      fuente({ page: 7 }), fuente(), fuente(),
    ], cita);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].file).toBe('estudio.pdf');
    expect(grupos[0].items).toHaveLength(2);
    expect(grupos[0].items.map((i) => i.cita)).toEqual(['pagina', null]);
  });
  it('no pierde evidencias distintas que empiezan por los mismos 80 caracteres', () => {
    const prefijo = 'a'.repeat(100);
    expect(agruparFuentes([fuente({ snippet: prefijo + 'A' }),
      fuente({ snippet: prefijo + 'B' })], '')[0].items).toHaveLength(2);
  });
  it('fusiona puntos de fragmentos repetidos sin mutar el original ni extender un grado', () => {
    const original = fuente({ plan_items: ['e1'], grado: 'directa' });
    const repetida = fuente({ plan_items: ['e2'], grado: 'parcial' });
    const item = agruparFuentes([original, repetida], '')[0].items[0];
    expect(item.source.plan_items).toEqual(['e1', 'e2']);
    expect(item.source.grado).toBeUndefined();
    expect(original.plan_items).toEqual(['e1']);
  });
  it('reconoce nombre de archivo y varias páginas de un fragmento', () => {
    const grupos = agruparFuentes([fuente({ page: 2, source_pages: [2, 3] })], '[estudio.pdf, pág. 3]');
    expect(grupos[0].items[0].cita).toBe('pagina');
  });
  it('sin página disponible solo afirma coincidencia de documento', () => {
    expect(agruparFuentes([fuente({ page: null })], cita)[0].items[0].cita).toBe('documento');
  });
  it('una referencia ambigua no marca arbitrariamente dos documentos como citados', () => {
    const grupos = agruparFuentes([fuente(), fuente({ source_file: 'segundo.pdf' })], cita);
    expect(grupos.every((g) => g.items[0].cita === null)).toBe(true);
    expect(resolverDestino(grupos, { file: 'Allegri et al., 2021', page: 3, token: 1 }).estado).toBe('ambigua');
  });
  it('documentos de igual nombre con ids diferentes no se fusionan', () => {
    const grupos = agruparFuentes([fuente({ document_id: 'a' }), fuente({ document_id: 'b' })], '');
    expect(grupos).toHaveLength(2);
    expect(resolverDestino(grupos, { file: 'estudio.pdf', page: 3, token: 1 }).estado).toBe('ambigua');
  });
  it('no fusiona PDF y Word de igual nombre base y prioriza la extensión explícita', () => {
    const grupos = agruparFuentes([fuente(), fuente({ source_file: 'estudio.docx', citation: '' })], '[estudio.pdf, pág. 3]');
    expect(grupos).toHaveLength(2);
    expect(grupos[0].items[0].cita).toBe('pagina');
    expect(grupos[1].items[0].cita).toBeNull();
    expect(resolverDestino(grupos, { file: 'estudio.pdf', page: 3, token: 1 }).estado).toBe('encontrada');
    expect(resolverDestino(grupos, { file: 'estudio', page: 3, token: 1 }).estado).toBe('ambigua');
  });
});

describe('buscar y filtrar', () => {
  const grupos = agruparFuentes([
    fuente({ plan_items: ['e1'], title: 'Estudio clínico', doi: '10.1234/ejemplo' }),
    fuente({ page: 7, snippet: 'Una segunda evidencia.', plan_items: ['e2'] }),
  ], cita);
  it('busca palabras sin depender de mayúsculas, acentos u orden', () => {
    expect(normalizarBusqueda('  CLÍNICO  ')).toBe('clinico');
    expect(filtrarFuentes(grupos, 'mejoria clinico', 'todas', '')[0].items).toHaveLength(1);
  });
  it.each(['Allegri', '2021', 'estudio.pdf', '10.1234/ejemplo', 'poblacion'])('busca por metadatos o contenido: %s', (texto) => {
    expect(filtrarFuentes(grupos, texto, 'todas', '').length).toBeGreaterThan(0);
  });
  it('combina texto, citas y punto sin cambiar los grupos originales', () => {
    expect(filtrarFuentes(grupos, 'mejoria', 'citadas', 'e1')[0].items).toHaveLength(1);
    expect(filtrarFuentes(grupos, '', 'citadas', 'e2')).toEqual([]);
    expect(grupos[0].items).toHaveLength(2);
  });
  it('devuelve vacío ante una búsqueda inexistente o un punto sin fragmentos', () => {
    expect(filtrarFuentes(grupos, 'inexistente', 'todas', '')).toEqual([]);
    expect(filtrarFuentes(grupos, '', 'todas', 'e99')).toEqual([]);
  });
  it('recupera etiquetas de puntos del historial y excluye el ancla e0', () => {
    const msg = mensaje({
      plan: [{ id: 'e0', query: 'q', evidence_needed: 'Pregunta entera' },
        { id: 'e1', query: 'q', evidence_needed: 'Población' }],
      hops: [{ n: 1, query: 'q', plan_item: 'e1', evidence_needed: 'Duplicado' },
        { n: 2, query: 'q', plan_item: 'e2', evidence_needed: 'Resultados' }],
    });
    expect(puntosDeFuentes(msg)).toEqual([{ id: 'e1', texto: 'Población' }, { id: 'e2', texto: 'Resultados' }]);
    expect(puntosDeFuentes(null)).toEqual([]);
  });
});

describe('navegación desde la respuesta', () => {
  const grupos = agruparFuentes([fuente(), fuente({ snippet: 'Otro fragmento de la misma página.' }),
    fuente({ page: 8, source_pages: [8, 9] })], cita);
  it('abre todos los candidatos de la página, no pretende conocer el fragmento exacto', () => {
    const destino = resolverDestino(grupos, { file: 'Allegri et al., 2021', page: 3, token: 1 });
    expect(destino.estado).toBe('encontrada');
    if (destino.estado === 'encontrada') expect(destino.tarjetas).toHaveLength(2);
  });
  it('reconoce páginas secundarias y citas sin página', () => {
    expect(resolverDestino(grupos, { file: 'estudio.pdf', page: 9, token: 1 }).estado).toBe('encontrada');
    const destino = resolverDestino(grupos, { file: 'estudio.pdf', page: null, token: 1 });
    if (destino.estado === 'encontrada') expect(destino.tarjetas).toHaveLength(3);
    else throw new Error('Documento no encontrado');
  });
  it('no sustituye una página ausente por la primera del documento', () => {
    expect(resolverDestino(grupos, { file: 'estudio.pdf', page: 99, token: 1 }).estado).toBe('pagina_ausente');
    expect(resolverDestino(grupos, { file: 'ausente.pdf', page: 3, token: 1 }).estado).toBe('documento_ausente');
  });
});

describe('referencias copiables y enlaces seguros', () => {
  it.each([undefined, '', 'javascript:alert(1)', 'https://evil.example/a', '10.12/corto',
    '10.1234/con espacios', '10.1234/<script>'])('no ofrece enlaces para DOI inválido: %s', (valor) => {
    expect(enlaceDoi(valor)).toBeNull();
  });
  it.each(['10.1234/abc', 'doi: 10.1234/abc', 'https://doi.org/10.1234/abc'])('normaliza el DOI %s', (valor) => {
    expect(enlaceDoi(valor)).toBe('https://doi.org/10.1234/abc');
  });
  it('codifica los caracteres especiales sin crear query ni fragmento de URL', () => {
    expect(enlaceDoi('10.1234/abc?x#y')).toBe('https://doi.org/10.1234/abc%3Fx%23y');
  });
  it('copia texto, referencia y localizador sin inventar año o página', () => {
    const texto = textoParaCopiar(fuente({ source_file: 'protocolo.docx', page: null,
      citation: '', locator: 'sección: Métodos', snippet: 'Texto literal.' }));
    expect(texto).toContain('protocolo.docx, sección: Métodos');
    expect(texto).toContain('Texto literal.');
    expect(texto).not.toContain('pág.');
    expect(texto).not.toContain('2026');
  });
});

describe('interfaz de Fuentes', () => {
  it('muestra controles y explicación sin score presentado como certeza', () => {
    const html = renderToStaticMarkup(createElement(SourcesPanel, {
      open: true, message: mensaje({ sources: [fuente()], content: cita }), focus: null, onClose() {},
    }));
    expect(html).toContain('Buscar en las fuentes de esta respuesta');
    expect(html).toContain('Cerrar fuentes');
    expect(html).toContain('Página citada');
    expect(html).toContain('no una verificación');
    expect(html).not.toContain('83%');
    expect(html).toContain('1 documento · 1 fragmento');
    expect(html).not.toContain('fuentes-summary');
    expect(html).not.toContain('fuentes-fragment-number');
  });
  it('oculta semánticamente el panel cerrado y admite respuestas sin fuentes', () => {
    const html = renderToStaticMarkup(createElement(SourcesPanel, {
      open: false, message: null, focus: null, onClose() {},
    }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Sin fuentes todavía');
  });
});

describe('contrato compartido entre las citas del chat y Fuentes', () => {
  it('no interpreta el año como página ni corta el autor en la primera coma', () => {
    const refs = extractCitations('Ver ' + cita);
    expect(refs).toHaveLength(1);
    expect(refs[0].file).toBe('Allegri et al., 2021');
    expect(refs[0].firstPage).toBe(3);
    expect(citationPages(refs[0])).toEqual([3]);
  });
  it('admite referencia autor-año sin página', () => {
    const refs = extractCitations('[Allegri et al., 2021]');
    expect(refs[0].file).toBe('Allegri et al., 2021');
    expect(refs[0].firstPage).toBeNull();
    expect(agruparFuentes([fuente()], '[Allegri et al., 2021]')[0].items[0].cita).toBe('documento');
  });
  it.each(['estudio.pdf', 'PROTOCOLO.DOCX', 'imagen.png', 'datos.csv'])('mantiene ficheros y rangos: %s', (nombre) => {
    const refs = extractCitations('[' + nombre + ', págs. 3–5,7]');
    expect(refs[0].file).toBe(nombre);
    expect(citationPages(refs[0])).toEqual([3, 4, 5, 7]);
    expect(extractCitations('[' + nombre + ']')[0].firstPage).toBeNull();
  });
  it('admite nombres con comas y no convierte corchetes genéricos en citas', () => {
    expect(parseCitation('[guía, edición 2024.pdf, pág. 6]')?.file).toBe('guía, edición 2024.pdf');
    expect(extractCitations('[nota importante]')).toEqual([]);
    expect(parseCitation('[nota importante]')).toBeNull();
  });
});
