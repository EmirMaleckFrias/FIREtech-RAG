// La fila de metadatos de una fuente: de dónde sale el fragmento y para qué
// sirvió. Está aquí y no dentro de components/SourcesPanel.tsx porque es una
// decisión de contenido (qué se dice y qué se calla), y así se puede probar.
//
// El panel mide 320 px, así que cada pieza de más es una pieza que se aplasta
// contra la siguiente. Dos reglas para no llenarlo de ruido:
//
// - **Nada redundante.** El formato (`pdf`) no se dice si la extensión del
//   fichero ya lo dice, y el fichero no se repite si el título de la tarjeta
//   ES el nombre del fichero. Antes se pintaba "…pdf" al lado de
//   "01_hipertension.pdf".
// - **Lo que ocupa, se recorta; no se desborda.** Cada pieza va en su caja y
//   la vista las deja pasar de línea. El nombre del fichero es la única que
//   puede ser larga, y es la única que se acorta con puntos suspensivos.

import { ANCLA } from './cobertura';
import type { PlanItem, Source } from '../types';

export interface PiezaMeta {
  texto: string;
  /** Clase extra de la pieza (el fichero se recorta, el plan lleva tooltip). */
  clase?: string;
  /** Texto del `title` del navegador. */
  titulo?: string;
}

/** "pdf" de "guia.pdf"; "" si no tiene extensión. En minúsculas. */
export function extensionDe(nombre: string): string {
  const m = /\.([^./\\]+)$/.exec(nombre.trim().toLowerCase());
  return m ? m[1] : '';
}

/** Título de la tarjeta: la referencia del trabajo si se conoce. Para quien
 *  investiga, "Allegri et al., 2021" identifica la fuente; el nombre del
 *  archivo es solo dónde está guardada. */
export function tituloDeFuente(s: Source): string {
  return s.citation || s.title || s.source_file;
}

/** Puntos del plan a los que sirvió la fuente, sin el ancla `e0` (la pregunta
 *  entera): "sirvió para 1 punto" siendo ese punto la propia pregunta no
 *  informa de nada. El tooltip lleva los `evidence_needed` cuando se conoce
 *  el plan (un mensaje de esta sesión). */
export function sirvioPara(s: Source, plan: PlanItem[]): { texto: string; titulo: string } | null {
  const ids = (s.plan_items ?? []).filter((id) => id !== ANCLA);
  if (ids.length === 0) return null;
  const porId = new Map(plan.map((p) => [p.id, p.evidence_needed]));
  const nombres = ids.map((id) => porId.get(id)).filter((x): x is string => !!x);
  return {
    texto: `sirvió para ${ids.length} ${ids.length === 1 ? 'punto' : 'puntos'}`,
    titulo: nombres.length > 0 ? nombres.join('\n') : 'Puntos del plan de evidencia',
  };
}

/**
 * Las piezas de la fila de metadatos, en orden: dónde está (fichero,
 * localizador, sección), qué es (formato, idioma) y para qué sirvió.
 *
 * `titulo` es el de la tarjeta: si coincide con el nombre del fichero, el
 * fichero no se repite abajo.
 */
export function piezasDeMeta(s: Source, plan: PlanItem[], titulo = tituloDeFuente(s)): PiezaMeta[] {
  const piezas: PiezaMeta[] = [];
  const esElFichero = titulo === s.source_file;
  if (!esElFichero) {
    piezas.push({ texto: s.source_file, clase: 'source-meta-file', titulo: s.source_file });
  }
  // El localizador lo decide el backend según el formato: un .docx no tiene
  // páginas, así que la UI no debe inventarse un "pág. N".
  const localizador = s.locator || (s.page !== null ? `pág. ${s.page}` : '');
  if (localizador) piezas.push({ texto: localizador });
  if (s.section && localizador !== `sección: ${s.section}`) piezas.push({ texto: s.section });
  // El formato solo si aporta algo: con "guia.pdf" delante (o como título),
  // decir "pdf" es repetirse.
  const ext = extensionDe(s.source_file);
  if (s.document_type && s.document_type.toLowerCase() !== ext) {
    piezas.push({ texto: s.document_type });
  }
  if (s.language) piezas.push({ texto: s.language });
  const puntos = sirvioPara(s, plan);
  if (puntos !== null) {
    piezas.push({ texto: puntos.texto, clase: 'source-meta-plan', titulo: puntos.titulo });
  }
  return piezas;
}
