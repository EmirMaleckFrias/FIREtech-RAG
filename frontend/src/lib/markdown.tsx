// Renderizador de markdown mínimo propio (sin dependencias): negritas,
// cursivas, código inline, bloques de código, encabezados, listas (con un
// nivel de anidación), tablas, citas de bloque y reglas horizontales.
// Las citas tipo [Catalogo_Reliable_1.pdf, pág. 3] se convierten en chips.
//
// Nota: no se soportan *cursivas/negritas con guion bajo* (_x_, __x__) a
// propósito: los nombres de archivo como Catalogo_Reliable_1.pdf los
// activarían por accidente.

import type { ReactNode } from 'react';
import { IconDocument } from '../components/icons';

export interface CitationRef {
  file: string;
  pageLabel: string | null;
  firstPage: number | null;
  raw: string;
}

interface MarkdownProps {
  text: string;
  onCitation?: (ref: CitationRef) => void;
  /**
   * Nodo inline (el caret de streaming) anclado al final del último bloque de
   * texto. Al vivir dentro del flujo del markdown, sigue el punto exacto de
   * escritura y permite el fade del borde de escritura sin re-animar nada.
   */
  tail?: ReactNode;
}

export function Markdown({ text, onCitation, tail }: MarkdownProps) {
  return <div className="md">{renderBlocks(text, onCitation, tail)}</div>;
}

/* ---------------------------------- citas --------------------------------- */

/** Extensiones indexables (fuente única de la lista, siempre con flag "i"). */
const CITATION_EXTS = 'pdf|xlsx|csv|txt|md';

/**
 * Token de cita. Fuente ÚNICA del patrón: la comparten el renderizador
 * inline (chips) y extractCitations (panel de fuentes): no duplicar en
 * otros módulos, y compilar SIEMPRE sus derivados con la flag "i".
 *
 * Formatos aceptados:
 *   [archivo.pdf, pág. 3]   con cualquier extensión indexable (pdf, xlsx,
 *                           csv, txt, md) y cualquier capitalización (.PDF)
 *   [archivo.xlsx]          con extensión y sin página
 *   [archivo, pág. 3]       sin extensión pero con página ("pág", "págs",
 *                           "página", "pag"...): el resto del pipeline ya
 *                           tolera nombres sin extensión (citationFileKey).
 */
const CITATION_TOKEN_RE = new RegExp(
  `\\[[^\\[\\]\\n]*?\\.(?:${CITATION_EXTS})\\b[^\\]\\n]*\\]` +
    `|\\[[^\\[\\]\\n,]+,\\s*p[aá]g(?:ina)?s?\\.?\\s*\\d[^\\]\\n]*\\]`,
  'i',
);

/** Cita con extensión: el nombre termina en ella (haya coma después o no). */
const CITATION_WITH_EXT_RE = new RegExp(
  `^\\[\\s*([^\\],]*?\\.(?:${CITATION_EXTS}))\\b\\s*,?\\s*(.*)\\]$`,
  'i',
);
/** Cita sin extensión: el nombre llega hasta la primera coma (o el cierre). */
const CITATION_NO_EXT_RE = /^\[\s*([^\],]+?)\s*(?:,\s*(.*))?\]$/;

export function parseCitation(raw: string): CitationRef | null {
  const m = CITATION_WITH_EXT_RE.exec(raw) ?? CITATION_NO_EXT_RE.exec(raw);
  if (!m) return null;
  const file = m[1].trim();
  if (file === '') return null;
  const rest = m[2] ?? '';
  const pm = /(\d+(?:\s*[-–,]\s*\d+)*)/.exec(rest);
  const pageLabel = pm ? pm[1].replace(/\s+/g, '') : null;
  const firstNum = pageLabel ? /^\d+/.exec(pageLabel) : null;
  return {
    file,
    pageLabel,
    firstPage: firstNum ? parseInt(firstNum[0], 10) : null,
    raw,
  };
}

/** Extensiones indexables: una cita (o un source_file) puede venir con o sin ella. */
const FILE_EXT_RE = new RegExp(`\\.(?:${CITATION_EXTS})$`, 'i');

/**
 * Clave normalizada para matchear el archivo de una cita con el source_file
 * del panel de fuentes: minúsculas, sin extensión y sin espacios extremos,
 * la misma normalización que aplica el chip al mostrar el nombre base (el
 * modelo a veces cita el nombre sin extensión o con otra capitalización).
 */
export function citationFileKey(name: string): string {
  return name.trim().toLowerCase().replace(FILE_EXT_RE, '');
}

/**
 * Todas las citas [archivo, pág. X] presentes en un texto, usando EXACTAMENTE
 * el mismo patrón con el que el renderizador convierte citas en chips.
 */
export function extractCitations(text: string): CitationRef[] {
  const re = new RegExp(CITATION_TOKEN_RE.source, 'gi');
  const out: CitationRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = parseCitation(m[0]);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Expande el pageLabel de una cita ("3", "3-5", "3,7") a páginas concretas.
 * Devuelve [] si la cita no menciona página (⇒ aplica a todo el archivo).
 */
export function citationPages(ref: CitationRef): number[] {
  if (!ref.pageLabel) return [];
  const out = new Set<number>();
  for (const part of ref.pageLabel.split(',')) {
    const m = /^(\d+)(?:[-–](\d+))?$/.exec(part);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (b >= a && b - a <= 400) {
      for (let p = a; p <= b; p++) out.add(p);
    } else {
      out.add(a); // rango invertido o absurdo: solo el primer número
    }
  }
  return [...out];
}

function CitationChip({
  refData,
  onClick,
}: {
  refData: CitationRef;
  onClick?: (ref: CitationRef) => void;
}) {
  const base = refData.file.replace(FILE_EXT_RE, '');
  return (
    <button
      type="button"
      className="citation-chip"
      title={refData.raw}
      onClick={onClick ? () => onClick(refData) : undefined}
    >
      <span className="citation-doc" aria-hidden="true">
        <IconDocument size={11} />
      </span>
      <span className="citation-file">{base}</span>
      {refData.pageLabel !== null && (
        <span className="citation-page">pág. {refData.pageLabel}</span>
      )}
    </button>
  );
}

/* --------------------------------- inline --------------------------------- */

// La alternativa de cita se construye desde CITATION_TOKEN_RE (fuente única).
// Flag "i" por las extensiones en mayúsculas (.PDF); el resto de alternativas
// (código, negrita, cursiva) no contiene letras y no se ve afectado.
const INLINE_RE = new RegExp(
  `(${CITATION_TOKEN_RE.source})|(\`[^\`\\n]+\`)|(\\*\\*[^\\n]+?\\*\\*)|(\\*[^*\\s][^*\\n]*?\\*)`,
  'gi',
);

function renderInline(
  text: string,
  onCitation: ((ref: CitationRef) => void) | undefined,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'gi');
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}i${k++}`;
    if (m[1]) {
      const ref = parseCitation(tok);
      if (ref) nodes.push(<CitationChip key={key} refData={ref} onClick={onCitation} />);
      else nodes.push(tok);
    } else if (m[2]) {
      nodes.push(
        <code key={key} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[3]) {
      nodes.push(
        <strong key={key}>{renderInline(tok.slice(2, -2), onCitation, key + '-')}</strong>,
      );
    } else {
      nodes.push(<em key={key}>{renderInline(tok.slice(1, -1), onCitation, key + '-')}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Renderiza un grupo de líneas como párrafo, uniendo con <br/>. */
function renderLines(
  lines: string[],
  onCitation: ((ref: CitationRef) => void) | undefined,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}br${idx}`} />);
    out.push(...renderInline(line, onCitation, `${keyPrefix}l${idx}`));
  });
  return out;
}

/* --------------------------------- bloques -------------------------------- */

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function isTableLine(s: string): boolean {
  return /^\s*\|.*\|\s*$/.test(s);
}

function isTableSeparator(s: string): boolean {
  const t = s.trim();
  return /^[|\s:-]+$/.test(t) && t.includes('-') && t.includes('|');
}

function isHeading(s: string): boolean {
  return /^#{1,6}\s+/.test(s);
}

function isHr(s: string): boolean {
  return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(s);
}

function isFence(s: string): boolean {
  return /^\s*```/.test(s);
}

function isBlockquote(s: string): boolean {
  return /^\s*>/.test(s);
}

function isListStart(s: string): boolean {
  return LIST_ITEM_RE.test(s);
}

function splitTableRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

type Align = 'left' | 'center' | 'right';

function parseAligns(sep: string): Align[] {
  return splitTableRow(sep).map((cell) => {
    const starts = cell.startsWith(':');
    const ends = cell.endsWith(':');
    if (starts && ends) return 'center';
    if (ends) return 'right';
    return 'left';
  });
}

interface ListItem {
  text: string;
  children: string[];
  childOrdered: boolean;
}

/** ¿Solo quedan líneas en blanco a partir de `i`? (=> este es el último bloque) */
function restIsBlank(lines: string[], i: number): boolean {
  for (let j = i; j < lines.length; j++) {
    if (lines[j].trim() !== '') return false;
  }
  return true;
}

function renderBlocks(
  text: string,
  onCitation: ((ref: CitationRef) => void) | undefined,
  tail?: ReactNode,
): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let tailUsed = false;

  const nextKey = () => `b${key++}`;
  // El tail se ancla dentro del bloque solo si es el último del documento.
  const takeTail = (): boolean => {
    if (tail === undefined || tailUsed || !restIsBlank(lines, i)) return false;
    tailUsed = true;
    return true;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Bloque de código ```
    if (isFence(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume cierre (o EOF)
      out.push(
        <pre key={nextKey()} className="md-pre">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Encabezado
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      const Tag = HEADING_TAGS[hm[1].length - 1];
      i++;
      const hKey = nextKey();
      out.push(
        <Tag key={hKey}>
          {renderInline(hm[2], onCitation, `h${hKey}`)}
          {takeTail() ? tail : null}
        </Tag>,
      );
      continue;
    }

    // Regla horizontal
    if (isHr(line)) {
      out.push(<hr key={nextKey()} />);
      i++;
      continue;
    }

    // Tabla (línea |...| seguida de separador |---|---|)
    if (isTableLine(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const tKey = nextKey();
      out.push(
        <div key={tKey} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c} style={{ textAlign: aligns[c] ?? 'left' }}>
                    {renderInline(cell, onCitation, `${tKey}th${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: aligns[c] ?? 'left' }}>
                      {renderInline(cell, onCitation, `${tKey}r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lista (con un nivel de anidación por indentación)
    if (isListStart(line)) {
      const first = LIST_ITEM_RE.exec(line);
      const ordered = /\d/.test(first ? first[2] : '-');
      const items: ListItem[] = [];
      while (i < lines.length) {
        const lm = LIST_ITEM_RE.exec(lines[i]);
        if (!lm) break;
        const indent = lm[1].length;
        const marker = lm[2];
        const content = lm[3];
        if (indent >= 2 && items.length > 0) {
          const parent = items[items.length - 1];
          if (parent.children.length === 0) parent.childOrdered = /\d/.test(marker);
          parent.children.push(content);
        } else {
          items.push({ text: content, children: [], childOrdered: false });
        }
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      const lKey = nextKey();
      const listTail = takeTail();
      out.push(
        <ListTag key={lKey}>
          {items.map((item, idx) => {
            const SubTag = item.childOrdered ? 'ol' : 'ul';
            return (
              <li key={idx}>
                {renderInline(item.text, onCitation, `${lKey}li${idx}`)}
                {item.children.length > 0 && (
                  <SubTag>
                    {item.children.map((child, cIdx) => (
                      <li key={cIdx}>
                        {renderInline(child, onCitation, `${lKey}li${idx}s${cIdx}`)}
                      </li>
                    ))}
                  </SubTag>
                )}
                {listTail && idx === items.length - 1 ? tail : null}
              </li>
            );
          })}
        </ListTag>,
      );
      continue;
    }

    // Cita de bloque
    if (isBlockquote(line)) {
      const quoted: string[] = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const qKey = nextKey();
      out.push(
        <blockquote key={qKey}>
          {renderLines(quoted, onCitation, qKey)}
          {takeTail() ? tail : null}
        </blockquote>,
      );
      continue;
    }

    // Párrafo: acumula hasta línea en blanco u otro bloque especial
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        isFence(next) ||
        isHeading(next) ||
        isHr(next) ||
        isListStart(next) ||
        isBlockquote(next) ||
        (isTableLine(next) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    const pKey = nextKey();
    out.push(
      <p key={pKey}>
        {renderLines(para, onCitation, pKey)}
        {takeTail() ? tail : null}
      </p>,
    );
  }

  // Fallback: el último bloque no admite tail inline (tabla, código, hr…).
  if (tail !== undefined && !tailUsed) {
    out.push(
      <div key="md-tail" className="md-tail">
        {tail}
      </div>,
    );
  }

  return out;
}
