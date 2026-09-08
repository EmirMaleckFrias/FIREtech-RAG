import { citationFileKey, citationPages, extractCitations } from './markdown';
import { tituloDeFuente } from './fuentes';
import type { ChatMessage, Source, SourceFocus } from '../types';

export type FiltroFuentes = 'todas' | 'citadas';
export interface FuenteExplorable {
  key: string;
  source: Source;
  cita: 'pagina' | 'documento' | null;
  busqueda: string;
}
export interface GrupoFuentes {
  key: string;
  file: string;
  items: FuenteExplorable[];
}

export function normalizarBusqueda(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').trim();
}
function claves(s: Source): string[] {
  return [s.source_file, s.citation ?? ''].filter(Boolean).map(citationFileKey);
}
function paginas(s: Source): number[] {
  return [...new Set([s.page, ...(s.source_pages ?? [])]
    .filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0))];
}

/** La coincidencia de página NO identifica qué fragmento verificó el agente. */
export function agruparFuentes(sources: Source[], content: string): GrupoFuentes[] {
  const claveGrupo = (source: Source) => source.document_id
    ? JSON.stringify([source.source_file.trim().toLowerCase(), source.document_id])
    : source.source_file.trim().toLowerCase();
  const documentosPorAlias = new Map<string, Set<string>>();
  const documentosPorNombre = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const nombre of [source.source_file, source.citation ?? ''].filter(Boolean)) {
      const literal = nombre.trim().toLowerCase();
      const documentos = documentosPorNombre.get(literal) ?? new Set<string>();
      documentos.add(claveGrupo(source));
      documentosPorNombre.set(literal, documentos);
    }
    for (const alias of claves(source)) {
      const documentos = documentosPorAlias.get(alias) ?? new Set<string>();
      documentos.add(claveGrupo(source));
      documentosPorAlias.set(alias, documentos);
    }
  }
  const citas = extractCitations(content).map((c) => ({
    key: citationFileKey(c.file), literal: c.file.trim().toLowerCase(), pages: citationPages(c),
  }));
  const grupos = new Map<string, GrupoFuentes>();
  for (const source of sources) {
    const groupKey = claveGrupo(source);
    let grupo = grupos.get(groupKey);
    if (!grupo) {
      grupo = { key: groupKey, file: source.source_file, items: [] };
      grupos.set(groupKey, grupo);
    }
    // El texto completo forma parte de la identidad: dos fragmentos pueden
    // compartir los primeros 80 caracteres y contener evidencias diferentes.
    const key = JSON.stringify([groupKey, source.page, source.locator,
      paginas(source).sort((a, b) => a - b), source.snippet.trim()]);
    const repetida = grupo.items.find((i) => i.key === key);
    if (repetida) {
      repetida.source = {
        ...repetida.source,
        plan_items: [...new Set([...(repetida.source.plan_items ?? []), ...(source.plan_items ?? [])])],
        grado: repetida.source.grado === source.grado ? source.grado : undefined,
      };
      continue;
    }
    const coincidencias = citas.filter((c) => {
      const candidatos = documentosPorNombre.get(c.literal) ?? documentosPorAlias.get(c.key);
      return candidatos?.size === 1 && candidatos.has(groupKey);
    });
    const ps = paginas(source);
    const cita = coincidencias.some((c) => c.pages.some((page) => ps.includes(page)))
      ? 'pagina' : coincidencias.some((c) => c.pages.length === 0 || ps.length === 0)
        ? 'documento' : null;
    grupo.items.push({
      key, source, cita,
      busqueda: normalizarBusqueda([source.source_file, source.title, source.citation,
        source.snippet, source.section, source.locator, source.doi].filter(Boolean).join(' ')),
    });
  }
  const resultado = [...grupos.values()];
  for (const grupo of resultado) {
    grupo.items.sort((a, b) => Number(b.cita !== null) - Number(a.cita !== null));
  }
  return resultado.sort((a, b) =>
    Number(b.items.some((i) => i.cita !== null)) - Number(a.items.some((i) => i.cita !== null)));
}

export function filtrarFuentes(
  grupos: GrupoFuentes[], texto: string, filtro: FiltroFuentes, punto: string,
): GrupoFuentes[] {
  const palabras = normalizarBusqueda(texto).split(/\s+/).filter(Boolean);
  return grupos.map((g) => ({
    ...g,
    items: g.items.filter((i) => (filtro === 'todas' || i.cita !== null) &&
      (!punto || i.source.plan_items?.includes(punto)) &&
      palabras.every((palabra) => i.busqueda.includes(palabra))),
  })).filter((g) => g.items.length > 0);
}

export function puntosDeFuentes(message: ChatMessage | null): { id: string; texto: string }[] {
  const puntos = new Map<string, string>();
  const poner = (id: string | undefined, texto: string | undefined) => {
    if (id && id !== 'e0' && texto?.trim() && !puntos.has(id)) puntos.set(id, texto.trim());
  };
  for (const p of message?.plan ?? []) poner(p.id, p.evidence_needed);
  for (const p of message?.verificacion?.cobertura ?? []) poner(p.id, p.evidence_needed);
  for (const h of message?.hops ?? []) poner(h.plan_item, h.evidence_needed);
  return [...puntos].map(([id, texto]) => ({ id, texto }));
}

export type DestinoFuente =
  | { estado: 'encontrada'; grupo: string; tarjetas: string[] }
  | { estado: 'pagina_ausente'; grupo: string }
  | { estado: 'ambigua' | 'documento_ausente' };

export function resolverDestino(grupos: GrupoFuentes[], focus: SourceFocus): DestinoFuente {
  const key = citationFileKey(focus.file);
  const literal = focus.file.trim().toLowerCase();
  const exactos = grupos.filter((g) => g.items.some((i) =>
    [i.source.source_file, i.source.citation ?? ''].some((v) => v.trim().toLowerCase() === literal)));
  const candidatos = exactos.length > 0 ? exactos :
    grupos.filter((g) => g.items.some((i) => claves(i.source).includes(key)));
  if (candidatos.length === 0) return { estado: 'documento_ausente' };
  if (candidatos.length > 1) return { estado: 'ambigua' };
  const grupo = candidatos[0];
  const items = focus.page === null ? grupo.items :
    grupo.items.filter((i) => paginas(i.source).includes(focus.page!));
  if (items.length === 0) return { estado: 'pagina_ausente', grupo: grupo.key };
  return { estado: 'encontrada', grupo: grupo.key, tarjetas: items.map((i) => i.key) };
}

/** Solo DOI reconocibles; nunca se convierte una URL arbitraria en enlace. */
export function enlaceDoi(valor: string | undefined): string | null {
  const doi = (valor ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  if (!/^10\.\d{4,9}\/[^\s<>"\\]+$/i.test(doi)) return null;
  return 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
}

export function textoParaCopiar(source: Source): string {
  const localizador = source.locator || (source.page !== null ? 'pág. ' + source.page : '');
  const referencia = [tituloDeFuente(source), localizador].filter(Boolean).join(', ');
  const fichero = tituloDeFuente(source) === source.source_file ? '' : 'Archivo: ' + source.source_file;
  return [referencia, fichero, '', source.snippet || 'Sin fragmento disponible.',
    enlaceDoi(source.doi)].filter((v) => v !== null).join('\n').trim();
}
