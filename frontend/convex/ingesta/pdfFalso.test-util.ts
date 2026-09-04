// Genera PDFs mínimos para los tests, sin añadir dependencias al proyecto.
// Port de `tests/pdf_falso.py`, ampliado con lo que pide probar la geometría:
// segmentos con su propia x (celdas de tabla), negrita (Helvetica-Bold),
// tamaño por segmento y superíndices pegados al texto anterior.
//
// El nombre lleva dos puntos a propósito: el bundler de Convex se salta los
// ficheros "con varios puntos", así que esto no se despliega como módulo, y
// vitest solo ejecuta los `*.test.ts`.
//
// Se escribe con WinAnsiEncoding para poder poner acentos en los tests.

const ALTO = 792;
const ANCHO = 612;

export interface Segmento {
  texto: string;
  /** x del inicio; por defecto el margen izquierdo. */
  x?: number;
  size?: number;
  negrita?: boolean;
  /** Sigue justo donde acabó el segmento anterior (un superíndice de cita). */
  pegado?: boolean;
  /** Elevación del texto (Ts), en puntos. */
  elevar?: number;
}

/** [texto, tamaño] o una línea con varios segmentos. */
export type LineaFalsa = [string, number] | { size: number; segmentos: Segmento[] };

function escapar(texto: string): string {
  return texto.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** latin-1 (WinAnsi para lo que aquí se usa); lo que no cabe sale como "?". */
function bytesLatin1(texto: string): Uint8Array {
  const salida = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    salida[i] = c <= 0xff ? c : 0x3f;
  }
  return salida;
}

function concatenar(trozos: Uint8Array[]): Uint8Array {
  const total = trozos.reduce((s, t) => s + t.length, 0);
  const salida = new Uint8Array(total);
  let pos = 0;
  for (const t of trozos) {
    salida.set(t, pos);
    pos += t.length;
  }
  return salida;
}

/** Flujo de contenido: cada línea con su tamaño, de arriba hacia abajo. */
function contenido(lineas: LineaFalsa[]): Uint8Array {
  const partes = ["BT"];
  let y = ALTO - 60;
  for (const l of lineas) {
    const linea = Array.isArray(l) ? { size: l[1], segmentos: [{ texto: l[0] }] } : l;
    const salto = Math.max(linea.size * 1.6, 12);
    for (const s of linea.segmentos) {
      const fuente = s.negrita ? "F2" : "F1";
      const size = s.size ?? linea.size;
      partes.push(`/${fuente} ${size} Tf`);
      if (!s.pegado) partes.push(`1 0 0 1 ${s.x ?? 60} ${y.toFixed(1)} Tm`);
      if (s.elevar) partes.push(`${s.elevar} Ts`);
      partes.push(`(${escapar(s.texto)}) Tj`);
      if (s.elevar) partes.push("0 Ts");
    }
    y -= salto;
  }
  partes.push("ET");
  return bytesLatin1(partes.join("\n"));
}

/** Escribe un PDF con las páginas dadas. Cada página es una lista de líneas. */
export function escribirPdf(paginas: LineaFalsa[][]): Uint8Array {
  const objetos: Uint8Array[] = [];
  const n = paginas.length;
  // 1 catálogo, 2 pages, 3 y 4 fuentes, luego por página: página + contenido.
  const idsPagina = paginas.map((_, i) => 5 + i * 2);

  objetos.push(bytesLatin1("<< /Type /Catalog /Pages 2 0 R >>"));
  objetos.push(
    bytesLatin1(
      `<< /Type /Pages /Kids [${idsPagina.map((i) => `${i} 0 R`).join(" ")}] /Count ${n} >>`,
    ),
  );
  objetos.push(
    bytesLatin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  );
  objetos.push(
    bytesLatin1(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ),
  );
  paginas.forEach((lineas, i) => {
    const idContenido = idsPagina[i] + 1;
    objetos.push(
      bytesLatin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idContenido} 0 R >>`,
      ),
    );
    const flujo = contenido(lineas);
    objetos.push(
      concatenar([
        bytesLatin1(`<< /Length ${flujo.length} >>\nstream\n`),
        flujo,
        bytesLatin1("\nendstream"),
      ]),
    );
  });

  const trozos: Uint8Array[] = [bytesLatin1("%PDF-1.4\n")];
  let longitud = trozos[0].length;
  const offsets: number[] = [];
  objetos.forEach((cuerpo, k) => {
    offsets.push(longitud);
    const objeto = concatenar([bytesLatin1(`${k + 1} 0 obj\n`), cuerpo, bytesLatin1("\nendobj\n")]);
    trozos.push(objeto);
    longitud += objeto.length;
  });
  const inicioXref = longitud;
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  trozos.push(bytesLatin1(xref));
  return concatenar(trozos);
}

/** Una fila de tabla: celdas en columnas a distancia fija (huecos grandes). */
export function fila(celdas: string[], size = 10, x0 = 60, paso = 100): LineaFalsa {
  return { size, segmentos: celdas.map((texto, j) => ({ texto, x: x0 + j * paso })) };
}
