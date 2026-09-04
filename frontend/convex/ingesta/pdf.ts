// PDF con conciencia de documento: sección vigente y metadatos de la obra.
// Port de `_parse_pdf` de generic.py sobre pdf.js (vía unpdf, que empaqueta
// pdf.js para entornos sin worker ni canvas) en vez de pdfplumber.
//
// Lo que daba pdfplumber en `page.chars` (tamaño, posición, nombre de la
// fuente por carácter) lo da aquí `getTextContent()` por ITEM: `str`, la
// matriz `transform` (x, y y tamaño), `width` y `fontName`. Con eso se
// reconstruyen las líneas físicas agrupando por la coordenada vertical, y de
// la geometría sale lo que el Python tenía que adivinar por el texto: una fila
// de tabla son items separados por huecos horizontales grandes, y las dos
// columnas de un artículo se separan por el canal vertical que ninguna línea
// cruza.
//
// Medido el 4 sep 2026 con un PDF sintético: cada `Tj` sale como un item con
// su x y su anchura; los huecos entre celdas salen como items de espacio con
// `width` igual al hueco; el superíndice de cita sale con su tamaño (6 frente
// a 10) y la base elevada 4 pt; y el nombre real de la fuente ("Helvetica-Bold")
// solo aparece en `page.commonObjs` DESPUÉS de `getOperatorList()`, no tras
// `getTextContent()`, que no manda las fuentes al hilo principal.
import { getDocumentProxy } from "unpdf";
import {
  agruparPorSeccion,
  chunkBase,
  conContexto,
  empaquetar,
  partirParrafoLargo,
} from "./chunking";
import { abreParrafo, esPalabraDeEnlace, unirLineas } from "./lineas";
import * as paper from "./paper";
import { META_VACIA, type ChunkParseado, type MetaObra } from "./tipos";

/** Una línea física con su formato y su geometría. */
export interface LineaPdf extends paper.LineaFormato {
  /** Fila de tabla, decidida por geometría (ver `construirLineas`). */
  esFila: boolean;
  /** Huecos horizontales grandes dentro de la línea. */
  huecos: number;
  /** x de inicio y de fin de cada item que sigue a un hueco grande, para
   *  comprobar la alineación de columnas con las líneas vecinas. */
  columnas: number[];
  /** Base de la línea (coordenada y de pdf.js, crece hacia arriba). */
  y: number;
}

export interface ItemTexto {
  str: string;
  x: number;
  y: number;
  ancho: number;
  tamano: number;
  fuente: string;
}

/** Un hueco cuenta como separación de celdas si mide al menos tantas veces el
 *  ancho medio de carácter de la línea. Un espacio normal mide ~0,28 em y la
 *  justificación lo estira hasta ~0,5 em; tres caracteres (~1,5 em) no salen
 *  de la prosa. */
const MULTIPLO_HUECO = 3;
/** Tiempo total dedicado a `getOperatorList()` para saber qué fuentes son
 *  negrita. Esa llamada decodifica también las imágenes de la página; en un
 *  PDF con muchas figuras se deja de mirar la negrita antes que agotar la
 *  acción. Sin negrita solo se pierde el encabezado al cuerpo de letra del
 *  texto, que pasa a ser una línea suelta (ver lineas.esLineaSuelta). */
const PRESUPUESTO_NEGRITA_MS = 20_000;

const FUENTE_NEGRITA = /bold|black|heavy/i;

/** Mediana del tamaño de fuente pesada por caracteres: aguanta mejor que la
 *  media un superíndice o un símbolo (como hacía el Python con los chars). */
function medianaPonderada(items: ItemTexto[]): number {
  const pares = items
    .map((it) => [it.tamano, Math.max(1, it.str.trim().length)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const total = pares.reduce((s, [, n]) => s + n, 0);
  let acumulado = 0;
  for (const [tamano, n] of pares) {
    acumulado += n;
    if (acumulado * 2 >= total) return Math.round(tamano * 10) / 10;
  }
  return Math.round((pares[pares.length - 1]?.[0] ?? 0) * 10) / 10;
}

/** Umbral de "hueco grande" de un conjunto de items: tres anchos medios de
 *  carácter. */
function umbralDeHueco(items: ItemTexto[]): number {
  let caracteres = 0;
  let anchoTotal = 0;
  for (const it of items) {
    caracteres += it.str.trim().length;
    anchoTotal += it.ancho;
  }
  const anchoMedio = caracteres ? anchoTotal / caracteres : medianaPonderada(items) * 0.5;
  return MULTIPLO_HUECO * anchoMedio;
}

/** Cuántos huecos grandes hay entre los items de una línea, de izquierda a
 *  derecha. */
function contarHuecos(items: ItemTexto[]): number {
  const ordenados = items.slice().sort((a, b) => a.x - b.x);
  const umbral = umbralDeHueco(ordenados);
  let huecos = 0;
  let finPrevio = ordenados[0].x + ordenados[0].ancho;
  for (let i = 1; i < ordenados.length; i++) {
    if (ordenados[i].x - finPrevio >= umbral) huecos++;
    finPrevio = Math.max(finPrevio, ordenados[i].x + ordenados[i].ancho);
  }
  return huecos;
}

/** Monta el texto de una línea a partir de sus items, de izquierda a derecha.
 *
 *  Entre dos items consecutivos: hueco grande -> dos espacios y se anota una
 *  columna; hueco de una palabra (> 0,15 em) o espacio ya presente -> un
 *  espacio; pegados -> nada (kerning, cambio de fuente a mitad de palabra, o
 *  el superíndice de cita justo tras el punto, que tiene que quedar como
 *  "decline.12,13" para que `cierraOracion` lo reconozca).
 *
 *  La negrita es por MAYORÍA de caracteres, no por "algún item en negrita":
 *  en un resumen estructurado la etiqueta "Conclusion:" va en negrita y el
 *  resto de la línea no, y con "alguno" la línea entera contaba como negrita y
 *  pasaba por encabezado (medido el 4 sep 2026 con PMC12739034: la sección de
 *  la mitad del resumen era "Conclusion: Plasma p-tau217 demonstrated..."). */
function montarLinea(items: ItemTexto[], nombresFuente: Map<string, string>): LineaPdf {
  const ordenados = items.slice().sort((a, b) => a.x - b.x);
  let caracteres = 0;
  let caracteresNegrita = 0;
  for (const it of ordenados) {
    const n = it.str.trim().length;
    caracteres += n;
    if (FUENTE_NEGRITA.test(nombresFuente.get(it.fuente) ?? "")) caracteresNegrita += n;
  }
  const tamano = medianaPonderada(ordenados);
  const umbralHueco = umbralDeHueco(ordenados);

  let texto = ordenados[0].str.trim();
  let finPrevio = ordenados[0].x + ordenados[0].ancho;
  let strPrevio = ordenados[0].str;
  let huecos = 0;
  const columnas: number[] = [];
  for (let i = 1; i < ordenados.length; i++) {
    const it = ordenados[i];
    const hueco = it.x - finPrevio;
    let separador = "";
    if (hueco >= umbralHueco) {
      separador = "  ";
      huecos++;
      columnas.push(it.x, it.x + it.ancho);
    } else if (hueco > 0.15 * it.tamano || /\s$/.test(strPrevio) || /^\s/.test(it.str)) {
      separador = " ";
    }
    texto += separador + it.str.trim();
    finPrevio = Math.max(finPrevio, it.x + it.ancho);
    strPrevio = it.str;
  }
  // La negrita sale del nombre de la fuente, que es donde la deja el PDF
  // ("...-Bold", "...-Black"); no es infalible, pero es lo único que hay sin
  // renderizar la página.
  const negrita = caracteresNegrita * 2 > caracteres;
  const mayor = ordenados.reduce((m, it) => (it.tamano > m.tamano ? it : m), ordenados[0]);
  return { texto: texto.trim(), tamano, negrita, esFila: false, huecos, columnas, y: mayor.y };
}

/** Agrupa los items por línea física (misma base), de arriba abajo.
 *
 *  Se agrupa por la base de la línea con una tolerancia proporcional al
 *  tamaño (0,45 em): un superíndice va elevado ~0,35 em y cae dentro; la
 *  línea siguiente está a >= 1 em y cae fuera. La tolerancia se toma del
 *  mayor de los dos tamaños porque, ordenados de arriba abajo, el superíndice
 *  (pequeño y elevado) llega ANTES que el cuerpo de su propia línea. */
function agruparPorLinea(items: ItemTexto[]): ItemTexto[][] {
  const ordenados = items.filter((it) => it.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const grupos: ItemTexto[][] = [];
  let actual: ItemTexto[] = [];
  let yBase = 0;
  let tamanoBase = 0;
  for (const it of ordenados) {
    if (actual.length) {
      const tolerancia = Math.max(2, 0.45 * Math.max(tamanoBase, it.tamano));
      if (Math.abs(it.y - yBase) <= tolerancia) {
        actual.push(it);
        if (it.tamano > tamanoBase) {
          tamanoBase = it.tamano;
          yBase = it.y;
        }
        continue;
      }
      grupos.push(actual);
    }
    actual = [it];
    yBase = it.y;
    tamanoBase = it.tamano;
  }
  if (actual.length) grupos.push(actual);
  return grupos;
}

/** Tolerancia en x para decidir si un item toca el canal. */
const TOL_CANAL = 1;

function cruzaCanal(it: ItemTexto, g: number): boolean {
  return it.x < g - TOL_CANAL && it.x + it.ancho > g + TOL_CANAL;
}

/** Fracción de valores que caen a <= 2,5 pt del valor más frecuente. */
function fraccionAlineada(valores: number[]): number {
  if (!valores.length) return 0;
  const redondeados = valores.map((v) => Math.round(v));
  const frecuencia = new Map<number, number>();
  for (const v of redondeados) frecuencia.set(v, (frecuencia.get(v) ?? 0) + 1);
  const moda = [...frecuencia].sort((a, b) => b[1] - a[1])[0][0];
  return valores.filter((v) => Math.abs(v - moda) <= 2.5).length / valores.length;
}

/** x del canal vertical entre dos columnas de texto, o null si la página es
 *  de una sola columna.
 *
 *  Por qué hace falta: en Alzheimer's & Dementia y Neurology (el corpus del
 *  proyecto) el cuerpo va a dos columnas y las dos comparten la rejilla de
 *  base, así que agrupar por altura fundía cada línea de la izquierda con la
 *  de la derecha. Medido el 4 sep 2026 con cinco PDF reales: "2  METHODS" salía
 *  como "2  METHODS  2. Interpretation: Elevated plasma..." y no se reconocía
 *  (35 de 49 fragmentos con la sección "2.3 Plasma biomarker measurements",
 *  que fue el único encabezado que cayó solo en su línea); en Neurology TODAS
 *  las líneas del cuerpo quedaban marcadas como fila de tabla, porque el hueco
 *  del canal se alinea entre líneas vecinas, y no se reconstruía ni un
 *  párrafo. pdfplumber tenía el mismo defecto: el Python original heredó
 *  estas líneas fundidas.
 *
 *  Se busca la x (entre el 25 % y el 75 % del ancho) que MENOS líneas cruzan y
 *  que más líneas parte en dos lados o deja a la derecha. Se acepta solo con
 *  evidencia de texto a dos columnas, para no partir por la mitad una tabla:
 *  al menos un 30 % de las líneas partidas o a la derecha, no más de un 35 %
 *  cruzando (títulos, tablas y pies a todo el ancho), la mayoría de las líneas
 *  partidas con UN solo hueco grande (una tabla de cuatro columnas tiene
 *  tres), y un borde alineado (el margen derecho de la columna izquierda o el
 *  de la derecha, que el texto justificado deja recto y las celdas de una
 *  tabla no). */
export function detectarCanal(grupos: ItemTexto[][], anchoPagina: number): number | null {
  if (grupos.length < 8 || !(anchoPagina > 0)) return null;
  const desde = Math.round(anchoPagina * 0.25);
  const hasta = Math.round(anchoPagina * 0.75);
  let mejorPuntos = -Infinity;
  let candidatos: number[] = [];
  for (let g = desde; g <= hasta; g += 2) {
    let cruzan = 0;
    let utiles = 0;
    for (const grupo of grupos) {
      if (grupo.some((it) => cruzaCanal(it, g))) {
        cruzan++;
        continue;
      }
      const izquierda = grupo.some((it) => it.x + it.ancho <= g + TOL_CANAL);
      const derecha = grupo.some((it) => it.x >= g - TOL_CANAL);
      if (derecha) utiles++; // partida en dos lados, o solo a la derecha
      void izquierda;
    }
    const puntos = utiles - cruzan;
    if (puntos > mejorPuntos) {
      mejorPuntos = puntos;
      candidatos = [g];
    } else if (puntos === mejorPuntos) {
      candidatos.push(g);
    }
  }
  if (!candidatos.length) return null;
  // El centro de la meseta de mejores candidatos: el medio del canal.
  const g = candidatos[Math.floor(candidatos.length / 2)];

  let cruzan = 0;
  let utiles = 0;
  let partidasConUnHueco = 0;
  let partidas = 0;
  const finesIzquierda: number[] = [];
  const finesDerecha: number[] = [];
  for (const grupo of grupos) {
    if (grupo.some((it) => cruzaCanal(it, g))) {
      cruzan++;
      continue;
    }
    const izq = grupo.filter((it) => it.x + it.ancho <= g + TOL_CANAL);
    const der = grupo.filter((it) => it.x >= g - TOL_CANAL);
    if (der.length) utiles++;
    if (izq.length) finesIzquierda.push(Math.max(...izq.map((it) => it.x + it.ancho)));
    if (der.length) finesDerecha.push(Math.max(...der.map((it) => it.x + it.ancho)));
    if (izq.length && der.length) {
      partidas++;
      if (contarHuecos(grupo) === 1) partidasConUnHueco++;
    }
  }
  if (utiles < Math.max(5, 0.3 * grupos.length)) return null;
  if (cruzan > 0.35 * grupos.length) return null;
  if (partidas && partidasConUnHueco < 0.6 * partidas) return null;
  if (fraccionAlineada(finesIzquierda) < 0.4 && fraccionAlineada(finesDerecha) < 0.4) return null;
  return g;
}

/** Reordena las líneas de una página a dos columnas en orden de lectura.
 *
 *  Una línea que cruza el canal es de ancho completo (título, tabla o pie a
 *  toda página) y cierra la banda en curso. Las demás se parten en su lado
 *  izquierdo y derecho; al cerrar cada banda salen primero todas las líneas
 *  de la izquierda y luego las de la derecha.
 *
 *  Solo cuenta el cruce, no el número de huecos: la primera versión trataba
 *  "dos o más huecos grandes" como fila de tabla a todo el ancho, y un
 *  encabezado numerado fundido con la otra columna ("2  METHODS  2.
 *  Interpretation: ...") tiene justo dos, el del número y el del canal, así
 *  que se quedaba sin partir y sin reconocer (medido con PMC13390017). Una
 *  fila de tabla a todo el ancho que no pise el canal se parte en dos
 *  mitades, cada una con sus celdas: se degrada la estructura, no se pierde
 *  el dato. */
export function ordenarEnColumnas(grupos: ItemTexto[][], g: number): ItemTexto[][] {
  const salida: ItemTexto[][] = [];
  let izquierda: ItemTexto[][] = [];
  let derecha: ItemTexto[][] = [];
  const volcar = () => {
    salida.push(...izquierda, ...derecha);
    izquierda = [];
    derecha = [];
  };
  for (const grupo of grupos) {
    if (grupo.some((it) => cruzaCanal(it, g))) {
      volcar();
      salida.push(grupo);
      continue;
    }
    const izq = grupo.filter((it) => it.x + it.ancho <= g + TOL_CANAL);
    const der = grupo.filter((it) => it.x + it.ancho > g + TOL_CANAL);
    if (izq.length) izquierda.push(izq);
    if (der.length) derecha.push(der);
  }
  volcar();
  return salida;
}

/** Líneas físicas de una página a partir de sus items, en orden de lectura.
 *
 *  Fila de tabla: dos o más huecos grandes, o uno solo cuando la línea
 *  vecina tiene una columna alineada con él (una tabla de dos columnas; una
 *  cabecera con el folio a la derecha no la tiene). Se decide aquí, por
 *  geometría, y viaja como flag: la heurística por cifras que había en el
 *  Python fallaba en tablas sin números y partía prosa con dos cifras. */
export function construirLineas(
  items: ItemTexto[],
  nombresFuente: Map<string, string>,
  anchoPagina = 0,
): LineaPdf[] {
  let grupos = agruparPorLinea(items);
  const ancho = anchoPagina || Math.max(0, ...items.map((it) => it.x + it.ancho));
  const canal = detectarCanal(grupos, ancho);
  if (canal !== null) grupos = ordenarEnColumnas(grupos, canal);

  const lineas = grupos.map((g) => montarLinea(g, nombresFuente)).filter((l) => l.texto);
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (linea.huecos >= 2) {
      linea.esFila = true;
      continue;
    }
    if (linea.huecos !== 1) continue;
    const tolerancia = Math.max(2, 0.6 * linea.tamano);
    const vecinas = [lineas[i - 1], lineas[i + 1]].filter(
      (v): v is LineaPdf => v !== undefined && v.huecos >= 1,
    );
    linea.esFila = vecinas.some((v) =>
      v.columnas.some((c) => linea.columnas.some((d) => Math.abs(c - d) <= tolerancia)),
    );
  }
  return lineas;
}

/** Índices de las líneas del borde superior e inferior de la página POR
 *  ALTURA (las `cuantas` más altas y las más bajas por su `y`), no por
 *  posición en la lista. Al leer a dos columnas, la cabecera corrida de la
 *  columna derecha (en las páginas pares de Wiley: "4 of 12  SILVA-RODRÍGUEZ
 *  ET AL.") sale después de toda la columna izquierda, y por índice ya no
 *  estaba en el borde: la repetición contaba dos páginas de tres y la cabecera
 *  entraba al índice. */
function bordesPorAltura(lineas: LineaPdf[], cuantas: number): Set<number> {
  const orden = lineas.map((l, i) => ({ y: l.y, i })).sort((a, b) => b.y - a.y);
  const borde = new Set<number>();
  for (const { i } of orden.slice(0, cuantas)) borde.add(i);
  for (const { i } of orden.slice(-cuantas)) borde.add(i);
  return borde;
}

/** Líneas con formato de cada página del PDF, y el número de páginas. */
export async function extraerLineas(
  bytes: Uint8Array,
): Promise<{ paginas: LineaPdf[][]; numPaginas: number }> {
  // pdf.js TRANSFIERE el ArrayBuffer al (falso) worker y lo deja desconectado:
  // parsear dos veces los mismos bytes daba DataCloneError en la segunda. Se
  // le entrega una copia y el llamador conserva los suyos.
  const documento = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const paginas: LineaPdf[][] = [];
    const limiteNegrita = Date.now() + PRESUPUESTO_NEGRITA_MS;
    // Las fuentes son del documento, no de la página: resuelta una vez, vale
    // para todas las páginas que la usen.
    const nombresFuente = new Map<string, string>();
    for (let n = 1; n <= documento.numPages; n++) {
      const items: ItemTexto[] = [];
      let pagina;
      let anchoPagina = 0;
      try {
        pagina = await documento.getPage(n);
        const [x0, , x1] = pagina.view as number[];
        anchoPagina = Math.abs(x1 - x0);
        const contenido = await pagina.getTextContent();
        for (const it of contenido.items) {
          if (!("str" in it) || !it.str.trim()) continue;
          const [a, b, c, d, e, f] = it.transform as number[];
          const tamano = it.height || Math.hypot(c, d) || Math.hypot(a, b);
          items.push({ str: it.str, x: e, y: f, ancho: it.width, tamano, fuente: it.fontName });
        }
      } catch (exc) {
        console.warn(`pág. ${n}: fallo extrayendo texto (${String(exc)}); se omite.`);
        paginas.push([]);
        continue;
      }
      const fuentes = new Set(items.map((it) => it.fuente));
      const desconocidas = [...fuentes].filter((f) => !nombresFuente.has(f));
      // Solo merece la pena si la página mezcla fuentes: con una sola no hay
      // negrita que distinguir del cuerpo.
      if (desconocidas.length && fuentes.size >= 2 && Date.now() < limiteNegrita) {
        try {
          await pagina.getOperatorList();
        } catch {
          // Sin nombres de fuente en esta página: se sigue sin negrita.
        }
      }
      for (const f of desconocidas) {
        if (!pagina.commonObjs.has(f)) continue;
        const obj = pagina.commonObjs.get(f) as { name?: string; bold?: boolean; black?: boolean } | null;
        nombresFuente.set(
          f,
          `${obj?.name ?? ""}${obj?.bold ? " bold" : ""}${obj?.black ? " black" : ""}`,
        );
      }
      paginas.push(construirLineas(items, nombresFuente, anchoPagina));
    }
    return { paginas, numPaginas: documento.numPages };
  } finally {
    await documento.destroy().catch(() => undefined);
  }
}

/** PDF -> chunks con sección vigente y metadatos de la obra.
 *
 *  Devuelve también las líneas de bibliografía descartadas.
 *
 *  La sección se arrastra desde el último encabezado, y un encabezado se
 *  reconoce de dos maneras: por su nombre, cuando es una sección de artículo
 *  conocida (Métodos, Resultados), y por su MAQUETA, cuando no lo es. La
 *  segunda hace falta porque en un documento que no es un paper los
 *  encabezados se llaman "Composición del mazo" o "Por qué elegirnos": sin
 *  detectarlos, la primera sección reconocida se arrastraría hasta el final y
 *  el fragmento de la página 4 acabaría citado como "sección: Introducción",
 *  que es peor que no decir nada.
 *
 *  Las líneas del BLOQUE DEL TÍTULO nunca son sección: fijan como sección el
 *  título entero, que `conContexto` no repite. Antes cada línea del título
 *  partido se detectaba como encabezado por formato y la segunda quedaba como
 *  sección de todo lo que seguía ("unimpaired older adults").
 *
 *  La bibliografía se descarta por defecto: son títulos de trabajos ajenos que
 *  casan con casi cualquier consulta sin ser evidencia de nada, y ocupan una
 *  parte nada despreciable de lo que se paga por embeber. */
export async function parsearPdf(
  bytes: Uint8Array,
  nombre: string,
  opciones: { omitirReferencias?: boolean } = {},
): Promise<{ chunks: ChunkParseado[]; pages: number; descartados: number }> {
  const omitirReferencias = opciones.omitirReferencias ?? true;
  // Primera pasada: texto y formato de cada página. Hace falta el documento
  // entero antes de empezar, por dos razones: las cabeceras y pies se
  // detectan por repetirse entre páginas, y el tamaño del texto corrido (con
  // el que se reconocen los encabezados) solo se sabe mirándolo todo.
  const { paginas, numPaginas } = await extraerLineas(bytes);

  const textoCabecera = paginas
    .slice(0, 2)
    .map((p) => p.map((l) => l.texto).join("\n"))
    .join("\n");
  const { meta, lineasTitulo }: { meta: MetaObra; lineasTitulo: Set<number> } = paginas[0]?.length
    ? paper.extraerMetadatosConBloque(paginas[0], textoCabecera)
    : { meta: META_VACIA, lineasTitulo: new Set<number>() };
  const citation = paper.referenciaDe(meta);
  // Para detectar cabeceras y pies repetidos, cada página se mira ordenada por
  // altura: el borde es el de la hoja, no el del orden de lectura.
  const repetidas = paper.lineasRepetidas(
    paginas.map((p) => p.slice().sort((a, b) => b.y - a.y).map((l) => l.texto)),
  );
  const cuerpo = paper.tamanoDeCuerpo(paginas);

  // (párrafo, páginas que abarca, sección)
  const paras: Array<[string, number[], string]> = [];
  let descartados = 0;
  let seccion = "";
  let canonica = "";

  // Segunda pasada: secciones y párrafos. Los encabezados se detectan línea a
  // línea, porque un encabezado suele ser su propia línea corta. El resto de
  // líneas se van UNIENDO en párrafos (ver lineas.abreParrafo).
  let abierto = ""; // párrafo en construcción
  let abiertoEsFila = false;
  let abiertoPaginas: number[] = []; // páginas que toca (puede cruzar de página)
  // Encabezado por formato en construcción: su tamaño, mientras la línea
  // anterior haya sido también de encabezado. Sirve para unir un encabezado
  // partido en dos líneas ("3.2  Longitudinal cognitive trajectories of" /
  // "%p-tau217 groups"): cada línea se detectaba por formato y la segunda
  // quedaba como sección de 16 fragmentos (medido el 4 sep 2026 con
  // PMC13390017). Se une cuando la anterior acaba en palabra de enlace o la
  // nueva no empieza por mayúscula ni cifra; "2  METHODS" seguido de "2.1
  // Study participants" son dos encabezados y no se unen.
  let encabezadoAbierto: number | null = null;

  const cerrarParrafo = () => {
    const texto = abierto.trim();
    if (texto) {
      for (const pieza of partirParrafoLargo(texto)) paras.push([pieza, abiertoPaginas.slice(), seccion]);
    }
    abierto = "";
    abiertoEsFila = false;
    abiertoPaginas = [];
  };

  paginas.forEach((lineas, indice) => {
    const numeroPagina = indice + 1;
    const enBordeDeHoja = bordesPorAltura(lineas, paper.BORDE_PAGINA);
    const extremos = bordesPorAltura(lineas, 1);
    lineas.forEach((linea, i) => {
      const enBorde = enBordeDeHoja.has(i);
      // En el borde de la página el folio va pegado a la cabecera o al pie
      // corridos por un hueco grande ("SILVA ET AL.  3 of 12", "Alzheimer's
      // Dement. 2026;22:e71599.  wileyonlinelibrary.com/journal/alz  1 of 12"):
      // se quita antes de nada. El número suelto solo en la primera o última
      // línea y nunca en una fila de tabla: aplicado a todo el borde, una fila
      // cuya última celda era un número ("MMSE  28  21") perdía esa celda.
      const extremo = extremos.has(i);
      const texto = (enBorde ? paper.sinFolio(linea.texto, extremo && !linea.esFila) : linea.texto).trim();
      if (!texto) return;
      if (paper.esRuidoDePagina(texto) || paper.esNumeroDePagina(texto)) return;
      if (enBorde && repetidas.has(paper.normalizar(texto))) return;
      if (indice === 0 && lineasTitulo.has(i)) {
        // El párrafo abierto se cierra ANTES de cambiar la sección:
        // pertenece a la anterior.
        cerrarParrafo();
        canonica = "";
        seccion = meta.titulo;
        encabezadoAbierto = null;
        return;
      }
      // Segunda línea de un encabezado partido: mismo tamaño que el
      // encabezado que acaba de abrirse, corta, y o bien la anterior acababa en
      // palabra de enlace o esta no empieza por mayúscula ni cifra.
      if (encabezadoAbierto !== null && !linea.esFila && Math.abs(linea.tamano - encabezadoAbierto) < 0.6) {
        const palabras = seccion.split(/\s+/);
        const corta = texto.length <= 80 && texto.split(/\s+/).length <= 12 && !/[.;,:]$/.test(texto);
        if (corta && (esPalabraDeEnlace(palabras[palabras.length - 1]) || !/^[\p{Lu}\p{N}]/u.test(texto))) {
          seccion = `${seccion} ${texto}`;
          return;
        }
      }
      const detectada = paper.detectarSeccion(texto);
      if (detectada === null) {
        // No es una sección con nombre conocido, pero puede ser un encabezado
        // igualmente: si lo es, RESETEA la sección en vez de dejar que la
        // anterior se arrastre por un contenido que no describe. Una fila de
        // tabla en negrita (la cabecera de columnas) no es un encabezado.
        if (
          !linea.esFila &&
          paper.esEncabezadoPorFormato(texto, linea.tamano, cuerpo, linea.negrita)
        ) {
          cerrarParrafo();
          canonica = "";
          seccion = texto;
          encabezadoAbierto = linea.tamano;
          return;
        }
      } else {
        cerrarParrafo();
        canonica = detectada;
        seccion = texto;
        encabezadoAbierto = null;
        return;
      }
      encabezadoAbierto = null;
      if (omitirReferencias && canonica === paper.REFERENCIAS) {
        descartados++;
        return;
      }
      if (
        abierto &&
        abreParrafo(abierto, texto, { anteriorEsFila: abiertoEsFila, lineaEsFila: linea.esFila })
      ) {
        cerrarParrafo();
      }
      if (abierto) {
        abierto = unirLineas(abierto, texto);
        abiertoEsFila = abiertoEsFila || linea.esFila;
      } else {
        abierto = texto;
        abiertoEsFila = linea.esFila;
      }
      if (!abiertoPaginas.includes(numeroPagina)) abiertoPaginas.push(numeroPagina);
    });
  });
  cerrarParrafo();

  // Se empaqueta por tramos de sección (ver agruparPorSeccion), con el solape
  // de empaquetar, y cada chunk lleva delante el título de la obra y su
  // sección: un fragmento de Resultados tiene que decir que lo es también en
  // el texto que se embebe, no solo en el payload.
  const chunks: ChunkParseado[] = [];
  for (const [sec, grupo] of agruparPorSeccion(paras)) {
    for (const paquete of empaquetar(grupo)) {
      const cuerpoChunk = paquete.map(([t]) => t).join("\n\n").trim();
      if (!cuerpoChunk) continue;
      const pags = [...new Set(paquete.flatMap(([, pgs]) => pgs))].sort((a, b) => a - b);
      chunks.push(
        chunkBase(nombre, conContexto(cuerpoChunk, meta.titulo, sec), pags[0], pags, "text", {
          section: sec,
          meta,
          citation,
        }),
      );
    }
  }
  return { chunks, pages: numPaginas, descartados };
}
