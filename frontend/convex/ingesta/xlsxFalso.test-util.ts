// Genera .xlsx sintéticos para los tests con jszip: cadenas compartidas y en
// línea, números, booleanos, fechas con estilo y fórmulas con o sin resultado
// cacheado. El fichero real de openpyxl está en `fixtures/datos.xlsx`.
import JSZip from "jszip";

export type CeldaXlsx =
  | string
  | number
  | boolean
  | null
  | { fecha: Date }
  | { formula: string; resultado?: string | number }
  | { inline: string };

export interface HojaFalsa {
  nombre: string;
  /** null = fila vacía (sin celdas). */
  filas: Array<CeldaXlsx[] | null>;
  /** Número de la primera fila (1 por defecto). */
  filaInicial?: number;
}

function xmlEscapar(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function letras(indice: number): string {
  let s = "";
  let n = indice + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Serial de Excel (sistema 1900) de una fecha UTC. */
export function serialDe(fecha: Date): number {
  return (fecha.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
}

export async function escribirXlsx(hojas: HojaFalsa[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const compartidas: string[] = [];
  const indiceCompartida = (s: string) => {
    let i = compartidas.indexOf(s);
    if (i < 0) {
      compartidas.push(s);
      i = compartidas.length - 1;
    }
    return i;
  };

  const hojasXml = hojas.map((hoja) => {
    const filas: string[] = [];
    hoja.filas.forEach((celdas, i) => {
      const r = (hoja.filaInicial ?? 1) + i;
      if (celdas === null) {
        filas.push(`<row r="${r}"></row>`);
        return;
      }
      const cs = celdas
        .map((valor, j) => {
          const ref = `${letras(j)}${r}`;
          if (valor === null) return "";
          if (typeof valor === "string") return `<c r="${ref}" t="s"><v>${indiceCompartida(valor)}</v></c>`;
          if (typeof valor === "number") return `<c r="${ref}"><v>${valor}</v></c>`;
          if (typeof valor === "boolean") return `<c r="${ref}" t="b"><v>${valor ? 1 : 0}</v></c>`;
          if ("inline" in valor) {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscapar(valor.inline)}</t></is></c>`;
          }
          if ("fecha" in valor) {
            const serial = serialDe(valor.fecha);
            const conHora = serial % 1 !== 0;
            return `<c r="${ref}" s="${conHora ? 2 : 1}"><v>${serial}</v></c>`;
          }
          if (valor.resultado === undefined) return `<c r="${ref}"><f>${xmlEscapar(valor.formula)}</f></c>`;
          if (typeof valor.resultado === "string") {
            return `<c r="${ref}" t="str"><f>${xmlEscapar(valor.formula)}</f><v>${xmlEscapar(valor.resultado)}</v></c>`;
          }
          return `<c r="${ref}"><f>${xmlEscapar(valor.formula)}</f><v>${valor.resultado}</v></c>`;
        })
        .join("");
      filas.push(`<row r="${r}">${cs}</row>`);
    });
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${filas.join("")}</sheetData></worksheet>`
    );
  });

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<workbookPr/><sheets>" +
      hojas
        .map((h, i) => `<sheet name="${xmlEscapar(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      "</sheets></workbook>",
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      hojas
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      "</Relationships>",
  );
  hojasXml.forEach((xml, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml));
  zip.file(
    "xl/sharedStrings.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${compartidas.length}" uniqueCount="${compartidas.length}">` +
      compartidas.map((s) => `<si><t xml:space="preserve">${xmlEscapar(s)}</t></si>`).join("") +
      "</sst>",
  );
  // Estilo 1: fecha integrada (numFmtId 14); estilo 2: fecha y hora personalizada.
  zip.file(
    "xl/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss"/></numFmts>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>' +
      "</styleSheet>",
  );
  return zip.generateAsync({ type: "uint8array" });
}
