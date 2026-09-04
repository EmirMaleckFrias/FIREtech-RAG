// Genera .docx sintéticos para los tests escribiendo el XML a mano con jszip:
// así se controlan gridSpan, vMerge, gridBefore, controles de contenido y
// tablas anidadas, que es justo lo que hay que probar. Los ficheros reales
// (python-docx) están en `fixtures/` para cruzar las suposiciones sobre el XML.
import JSZip from "jszip";

export type CeldaFalsa =
  | string
  | {
      texto?: string;
      gridSpan?: number;
      vMerge?: "restart" | "continue";
      /** Tabla anidada dentro de la celda. */
      anidada?: FilaFalsa[];
    };

export type FilaFalsa = CeldaFalsa[] | { celdas: CeldaFalsa[]; gridBefore?: number };

export type BloqueFalso =
  | { tipo: "p"; texto: string; estilo?: string }
  | { tipo: "tabla"; filas: FilaFalsa[] }
  | { tipo: "sdt"; bloques: BloqueFalso[] };

const ESTILOS_POR_DEFECTO: Record<string, string> = {
  Normal: "Normal",
  Heading1: "heading 1",
  Heading2: "heading 2",
  Title: "Title",
  Subtitle: "Subtitle",
};

function xmlEscapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parrafo(texto: string, estilo?: string): string {
  const pPr = estilo ? `<w:pPr><w:pStyle w:val="${xmlEscapar(estilo)}"/></w:pPr>` : "";
  if (!texto) return `<w:p>${pPr}</w:p>`;
  // Se parte en dos runs con un espacio preservado para probar la
  // concatenación y xml:space.
  const corte = Math.floor(texto.length / 2);
  return (
    `<w:p>${pPr}` +
    `<w:r><w:t xml:space="preserve">${xmlEscapar(texto.slice(0, corte))}</w:t></w:r>` +
    `<w:r><w:t xml:space="preserve">${xmlEscapar(texto.slice(corte))}</w:t></w:r></w:p>`
  );
}

function celda(c: CeldaFalsa): string {
  const def = typeof c === "string" ? { texto: c } : c;
  const props: string[] = [];
  if (def.gridSpan && def.gridSpan > 1) props.push(`<w:gridSpan w:val="${def.gridSpan}"/>`);
  if (def.vMerge === "restart") props.push('<w:vMerge w:val="restart"/>');
  if (def.vMerge === "continue") props.push("<w:vMerge/>");
  const tcPr = props.length ? `<w:tcPr>${props.join("")}</w:tcPr>` : "";
  const anidada = def.anidada ? tabla(def.anidada) : "";
  return `<w:tc>${tcPr}${parrafo(def.texto ?? "")}${anidada}</w:tc>`;
}

function tabla(filas: FilaFalsa[]): string {
  const cuerpo = filas
    .map((f) => {
      const def = Array.isArray(f) ? { celdas: f } : f;
      const trPr = def.gridBefore ? `<w:trPr><w:gridBefore w:val="${def.gridBefore}"/></w:trPr>` : "";
      return `<w:tr>${trPr}${def.celdas.map(celda).join("")}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr/><w:tblGrid/>${cuerpo}</w:tbl>`;
}

function bloque(b: BloqueFalso): string {
  if (b.tipo === "p") return parrafo(b.texto, b.estilo);
  if (b.tipo === "tabla") return tabla(b.filas);
  return `<w:sdt><w:sdtPr/><w:sdtContent>${b.bloques.map(bloque).join("")}</w:sdtContent></w:sdt>`;
}

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Escribe un .docx con los bloques dados. `estilos: null` omite styles.xml. */
export async function escribirDocx(
  bloques: BloqueFalso[],
  opciones: { estilos?: Record<string, string> | null } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document ${NS_W} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>` +
      bloques.map(bloque).join("") +
      "<w:sectPr/></w:body></w:document>",
  );
  const estilos = opciones.estilos === undefined ? ESTILOS_POR_DEFECTO : opciones.estilos;
  if (estilos !== null) {
    zip.file(
      "word/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<w:styles ${NS_W}>` +
        Object.entries(estilos)
          .map(
            ([id, nombre]) =>
              `<w:style w:type="paragraph" w:styleId="${xmlEscapar(id)}"><w:name w:val="${xmlEscapar(nombre)}"/></w:style>`,
          )
          .join("") +
        "</w:styles>",
    );
  }
  return zip.generateAsync({ type: "uint8array" });
}
