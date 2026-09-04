// Lo que hace falta para tratar un PDF como un artículo científico y no como
// un montón de texto: de qué trabajo salió cada fragmento y de qué sección.
// Port de `backend/app/ingest/paper.py`.
//
// Dos cosas que cambian la calidad de una respuesta sobre literatura:
//
// 1. **La cita.** Para quien investiga, `estudio_cohorte.pdf, pág. 3` no
//    sirve: la referencia real es "Allegri et al., 2023". Se extrae de la
//    primera página con heurísticas deterministas (sin LLM, coste cero) y,
//    cuando no se puede extraer con confianza, se cae al nombre del archivo.
//    Nunca se inventa una referencia.
// 2. **La sección.** El mismo enunciado vale muy distinto según de dónde
//    salga: un dato en Resultados es evidencia, en Discusión es interpretación
//    del autor y en Introducción suele ser una afirmación sobre el trabajo de
//    otros. Detectar el encabezado vigente y llevarlo a la cita permite que
//    quien lee la respuesta sepa qué peso darle.
//
// Y una que ahorra dinero y ruido: la bibliografía son títulos ajenos, casa
// con casi cualquier consulta y no es evidencia de nada, así que se descarta.
//
// Cuatro guardas nuevas respecto al Python, de la revisión adversarial final
// del 4 sep 2026 (fabricaban o perdían citas): el ruido de institución se mira
// sobre el SEGMENTO del primer autor y no sobre la línea entera; el apellido
// corto en mayúsculas ("Xin LI") solo gana cuando toda la línea sigue esa
// convención; los términos que no son persona se rechazan en TODAS las ramas;
// y quitar un tratamiento ("Dr.") no puede dejar la firma sin autor.
import { sinAcentos } from "./idioma";
import type { MetaObra } from "./tipos";
import { esMayuscula, esMinusculas, recortar } from "./util";

// Secciones canónicas de un artículo, con sus formas en inglés y español. La
// clave es el nombre canónico interno; los valores, cómo aparecen escritas.
const SECCIONES: Record<string, string[]> = {
  resumen: ["abstract", "resumen", "summary", "sumario"],
  introduccion: ["introduction", "introduccion", "background", "antecedentes"],
  "trabajo relacionado": ["related work", "trabajos relacionados", "estado del arte"],
  metodos: [
    "methods", "method", "methodology", "materials and methods",
    "material and methods", "patients and methods", "metodos", "metodo",
    "metodologia", "materiales y metodos", "material y metodos",
    "pacientes y metodos", "sujetos y metodos",
  ],
  resultados: ["results", "findings", "resultados", "hallazgos"],
  discusion: ["discussion", "discusion"],
  conclusiones: ["conclusion", "conclusions", "concluding remarks", "conclusiones"],
  limitaciones: ["limitations", "limitaciones"],
  referencias: [
    "references", "reference list", "bibliography", "literature cited",
    "referencias", "referencias bibliograficas", "bibliografia",
  ],
  agradecimientos: [
    "acknowledgements", "acknowledgments", "agradecimientos", "funding",
    "financiacion", "conflict of interest", "conflicto de intereses",
    "author contributions", "contribucion de los autores",
    "data availability", "disponibilidad de datos",
  ],
  anexos: [
    "appendix", "appendices", "supplementary material", "supporting information",
    "anexo", "anexos", "material suplementario",
  ],
};

/** Sección cuyo contenido son referencias a trabajos ajenos. */
export const REFERENCIAS = "referencias";

// Numeración de encabezado: "3.", "3.1", "III.", "IV -" y la de Wiley "2 | METHODS".
//
// Medido el 3 sep 2026 sobre cabeceras de Alzheimer's & Dementia (maquetación
// Wiley, el corpus central del proyecto): "2 | METHODS", "3 | RESULTS" y
// "5 | REFERENCES" daban None porque la barra no contaba como separador. La
// consecuencia era grave: `canonica` nunca llegaba a "referencias", así que la
// bibliografía ENTERA se embebía, y con las cabeceras al mismo cuerpo de letra
// que el texto salía UN solo chunk con Introducción+Métodos+Resultados+
// bibliografía etiquetado con el título como sección.
//
// Dos cuidados. Tras el número tiene que venir un separador o al menos un
// espacio: si el espacio fuera opcional, la rama romana se comería la "I" de
// "Introduction" o la "C" de "Conclusions" (por eso L y C tampoco están en la
// clase: ningún artículo llega a la sección 50). Y los romanos se exigen bien
// formados y EN MAYÚSCULAS: con IGNORECASE, "ivxlc Results" pasaba por
// cabecera numerada.
const PREFIJO_NUMERO =
  /^\s*(?:\d+(?:\.\d+)*|(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3}))(?:\s*[.)\-:|\u00b7\u2013\u2014]\s*|\s+)/;

// Folio pegado a la cabecera que abre la página ("3 RESULTS 5", "References
// 12"): el extractor los deja en la misma línea cuando comparten altura.
const PAGINA_FINAL = /\s+\d{1,4}$/;

// Conjunción que junta dos secciones en una cabecera ("Results and Discussion",
// "Resultados y Discusión", "Discussion/Conclusion").
const UNION_SECCIONES = /\s+(?:and|y|e|&)\s+|\s*\/\s*/;

// Colas que algunas revistas añaden al nombre de la sección ("Conflict of
// Interest Statement", "Data Availability Statement").
const COLAS_SECCION = [" statement", " statements", " section"];

// Palabras que acompañan legítimamente a un nombre de sección en cabeceras
// reales de revista: "Subjects and Methods", "Strengths and Limitations",
// "Study Design and Methods" y el resumen estructurado de JAMA ("Conclusions
// and Relevance"). La lista es cerrada a propósito: junto a un nombre de
// sección, una palabra DESCONOCIDA delata la segunda línea de un título
// partido y no una cabecera (ver `seccionCompuesta`).
const CALIFICADORES_CABECERA = new Set([
  "subjects", "patients", "participants", "materials", "material",
  "study design", "design", "strengths", "relevance", "importance",
  "sujetos", "pacientes", "participantes", "materiales", "diseno",
  "diseno del estudio", "fortalezas", "relevancia", "importancia",
]);

// Índice inverso forma escrita -> nombre canónico.
const FORMA_A_CANONICO = new Map<string, string>();
for (const [canonico, formas] of Object.entries(SECCIONES)) {
  for (const forma of formas) FORMA_A_CANONICO.set(forma, canonico);
}

const DOI = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i;
const ANIO = /\b(19[5-9]\d|20[0-4]\d)\b/g;
const RANGO_DE_ANIOS =
  /\b(?:19[5-9]\d|20[0-4]\d)\s*[-\u2013\u2014]\s*(?:19[5-9]\d|20[0-4]\d)\b/g;

// Ruido típico de la cabecera de un PDF de revista, que nunca es el título.
const RUIDO_TITULO = [
  "downloaded from", "doi:", "https://", "http://", "www.", "issn",
  "all rights reserved", "creative commons", "licensed under", "open access",
  "received:", "accepted:", "published:", "corresponding author",
  "original research", "research article", "review article", "case report",
  "artículo original", "articulo original", "revista",
];

// Palabras que descartan un segmento como línea de autores.
const RUIDO_AUTORES = [
  "university", "universidad", "department", "departamento", "hospital",
  "institute", "instituto", "school", "facultad", "abstract", "resumen",
  "keywords", "palabras clave", "@", "correspondence",
  // Instituciones, guías y encabezados de monografías no son personas. La
  // heurística anterior tomaba la última palabra ("Salud", "Health") y
  // fabricaba citas como "Salud et al.".
  "organization", "organizacion", "world health", "salud mundial",
  "ministry", "ministerio", "association", "asociacion", "society",
  "sociedad", "foundation", "fundacion", "committee", "comite",
  "initiative", "iniciativa", "consortium", "consorcio", "agency",
  "agencia", "guideline", "guia", "documentos base", "fuentes",
  // Pie de la línea de autores: la dirección postal y el aviso de
  // correspondencia. Se buscan como subcadena porque son inequívocos.
  "corresponding author", "e-mail", "email",
];

// Palabras de una línea de dirección o afiliación, buscadas como PALABRA
// entera y no como subcadena: "usa" aparece dentro de "causa" y "usado", y
// "clinic" dentro de "clinical", así que como subcadena descartarían líneas
// legítimas. Van aparte de `RUIDO_AUTORES`, que sí es por subcadena.
const RUIDO_DIRECCION = new Set([
  "center", "centers", "centre", "centres", "centro", "centros",
  "clinic", "clinica", "laboratory", "laboratorio", "college", "campus",
  "street", "avenue", "road", "box", "zip", "postal",
  "usa", "netherlands", "spain", "france", "germany", "italy", "canada",
  "australia", "china", "japan", "brazil", "mexico", "argentina", "chile",
  "colombia", "sweden", "denmark", "norway", "finland", "belgium",
  "austria", "poland", "greece", "ireland", "switzerland", "portugal",
  "espana", "francia", "alemania", "italia", "brasil", "suiza",
]);

// Siglas institucionales frecuentes en el corpus médico. Aunque una de ellas
// sea autora real de un informe, no se le puede aplicar "et al.": esa forma es
// exclusiva de autorías personales. Sin metadatos bibliográficos estructurados
// es más fiel caer al nombre del archivo que inventar una autoría.
const SIGLAS_INSTITUCIONALES = new Set([
  "oms", "who", "gina", "gold", "kdigo", "cdc", "nih", "niddk",
  "aha", "esc", "fao", "unep", "woah",
]);

// Marcas de agua y avisos legales que las revistas estampan en cada página. No
// son contenido del trabajo: si entran al índice, se pagan al embeberlos y
// aparecen como resultado de búsquedas que no tienen nada que ver.
const RUIDO_PAGINA = [
  "downloaded from", "descargado de", "all rights reserved",
  "todos los derechos reservados", "this article is protected by copyright",
  "creative commons", "licensed under", "terms and conditions",
  "see the terms and conditions", "wiley online library",
  "unauthorized reproduction", "reproduccion no autorizada",
];

/** ¿La línea es marca de agua o aviso legal de la revista? */
export function esRuidoDePagina(linea: string): boolean {
  const bajo = sinAcentos(linea).toLowerCase();
  return RUIDO_PAGINA.some((r) => bajo.includes(r));
}

/** Cuántas líneas de cada borde de la página pueden ser cabecera o pie. */
export const BORDE_PAGINA = 2;

/** Líneas que se repiten en el borde de casi todas las páginas.
 *
 *  En un artículo son el nombre de la revista, el DOI y el número de página,
 *  estampados en cada hoja. Se detectan por repetición y no por maquetación,
 *  que es lo que funciona sin conocer la plantilla de cada editorial.
 *
 *  Solo se miran las primeras y últimas líneas de cada página: sin esa
 *  restricción, una frase legítima que aparezca en varias páginas (el pie de
 *  una tabla que se repite, una definición citada dos veces) se borraría del
 *  índice, y perder contenido es mucho peor que arrastrar una cabecera.
 *
 *  Devuelve las líneas ya normalizadas, para comparar contra `normalizar`. */
export function lineasRepetidas(porPagina: string[][], minimoPaginas = 3): Set<string> {
  const total = porPagina.length;
  if (total < minimoPaginas) return new Set();
  const conteo = new Map<string, number>();
  for (const lineas of porPagina) {
    const utiles = lineas.filter((l) => l.trim());
    const bordes = [...utiles.slice(0, BORDE_PAGINA), ...utiles.slice(-BORDE_PAGINA)];
    for (const normal of new Set(bordes.map(normalizar))) {
      // Una cabecera es corta; un párrafo largo repetido es contenido.
      if (!normal || normal.length > 90) continue;
      conteo.set(normal, (conteo.get(normal) ?? 0) + 1);
    }
  }
  const umbral = Math.max(minimoPaginas, Math.floor(total * 0.6));
  return new Set([...conteo].filter(([, veces]) => veces >= umbral).map(([normal]) => normal));
}

/** ¿La línea está en el borde de su página (cabecera o pie)? */
export function enBorde(indice: number, totalLineas: number): boolean {
  return indice < BORDE_PAGINA || indice >= totalLineas - BORDE_PAGINA;
}

/** ¿La línea es un folio ("3 of 12", "12", "Page 4", "pág. 7")? Nunca es
 *  contenido, y al separar las columnas de una página el folio de la
 *  cabecera queda como línea propia. */
export function esNumeroDePagina(texto: string): boolean {
  // Un número suelto de cuatro cifras ("2021") es un año, no un folio.
  return /^(?:(?:page|p\.|pag\.?|pág\.?|pagina|página)\s*\d{1,4}|\d{1,3})(?:\s*(?:of|de|\/)\s*\d{1,4})?$/i.test(
    texto.trim(),
  );
}

/** Quita el folio pegado por un hueco grande a una cabecera o pie corridos
 *  ("SILVA ET AL.  3 of 12" -> "SILVA ET AL."). Solo tiene sentido en el borde
 *  de la página. La forma "N of M" es inequívoca y se quita siempre; un número
 *  suelto ("Alz Dement  3") solo si el llamador lo pide (primera o última
 *  línea y no fila de tabla): en una fila del borde, "MMSE  28  21" perdía su
 *  última celda. */
export function sinFolio(texto: string, tambienNumeroSuelto = false): string {
  let limpio = texto
    .replace(/\s{2,}\d{1,3}\s*(?:of|de|\/)\s*\d{1,4}$/, "")
    .replace(/^\d{1,3}\s*(?:of|de|\/)\s*\d{1,4}\s{2,}/, "");
  if (tambienNumeroSuelto) {
    limpio = limpio.replace(/\s{2,}\d{1,3}$/, "").replace(/^\d{1,3}\s{2,}/, "");
  }
  return limpio.trim();
}

/** ¿Más de la mitad de los tokens son letras sueltas? Es la cabecera corrida
 *  con letras espaciadas de las revistas ("B I O M A R K E R S", "R E S E A R C
 *  H A R T I C L E"): en negrita y al cuerpo de letra del texto, pasaba por
 *  encabezado y salía como sección de la mitad del resumen (medido el 4 sep
 *  2026 con PMC12739034). */
export function esLetrasEspaciadas(texto: string): boolean {
  const tokens = texto.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  return tokens.filter((t) => t.length === 1).length * 2 > tokens.length;
}

/** "R E S U L T S" -> "RESULTS": une las letras sueltas de una cabecera con
 *  letras espaciadas, para que se compare con los nombres canónicos. Las
 *  palabras van separadas por dos o más espacios. */
export function desespaciar(texto: string): string {
  if (!esLetrasEspaciadas(texto)) return texto;
  return texto
    .trim()
    .split(/\s{2,}/)
    .map((palabra) =>
      palabra.split(/\s+/).every((t) => t.length === 1) ? palabra.replace(/\s+/g, "") : palabra,
    )
    .join(" ");
}

// Nombre propio con el superíndice de afiliación pegado: "Che1", "Ritter4,5",
// "Silva-Rodríguez1,2". Solo letras latinas, para que "Aβ42" no cuente.
const NOMBRE_CON_SUPERINDICE = /(?:^|\s)[A-Z\u00c0-\u00de][A-Za-z\u00c0-\u00ff'\u2019.-]+\d{1,2}(?:,\d{1,2})*(?=\s|$)/g;

/** ¿La línea es una lista de autores con superíndices numéricos pegados a los
 *  nombres ("Ping Che1  Nan Zhang2")? En negrita y grande, pasaba por
 *  encabezado y toda la portada salía con esa "sección". Con una sola marca
 *  se exige que sea el último token y que todo lo demás vaya capitalizado
 *  ("Ping Che1"): "Plasma Aβ42 Levels" o "COVID-19 and dementia" no lo son. */
export function esLineaDeAutores(texto: string): boolean {
  const marcas = texto.match(NOMBRE_CON_SUPERINDICE)?.length ?? 0;
  if (marcas >= 2) return true;
  if (marcas === 0) return false;
  const tokens = texto.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (!NOMBRE_CON_SUPERINDICE.test(" " + tokens[tokens.length - 1])) {
    NOMBRE_CON_SUPERINDICE.lastIndex = 0;
    return false;
  }
  NOMBRE_CON_SUPERINDICE.lastIndex = 0;
  return tokens.every((t) => /^[A-Z\u00c0-\u00de]/.test(t) || /^(and|y|&|\|)$/i.test(t));
}

/** Minúsculas, sin acentos, sin puntuación de borde y sin espacios dobles. */
export function normalizar(texto: string): string {
  // Los guiones tipográficos van como escape a propósito: el guion largo no
  // debe aparecer literalmente en ningún archivo del proyecto.
  const limpio = recortar(sinAcentos(texto).toLowerCase().trim(), " .:-_*#\t\u2013\u2014");
  return limpio.replace(/\s+/g, " ");
}

/** Nombre canónico de la sección si la línea es un encabezado, o null.
 *
 *  Exige que la línea sea corta y que, quitada la numeración, coincida con un
 *  nombre de sección conocido. Así "Methods" es encabezado pero "the methods
 *  described by Smith et al. were adapted" no lo es.
 *
 *  `permitirCompuesta: false` apaga el reconocimiento de cabeceras de dos
 *  secciones ("Results and Discussion"). Lo usa `cabecera` dentro del bloque
 *  del título, donde esa forma es casi siempre la segunda línea de un título
 *  partido y aceptarla cuesta el título, el autor y la cita. */
export function detectarSeccion(
  linea: string,
  opciones: { permitirCompuesta?: boolean } = {},
): string | null {
  const permitirCompuesta = opciones.permitirCompuesta ?? true;
  const bruto = linea.trim();
  if (!bruto || bruto.length > 80) return null;
  // Una línea con punto final es prosa, no un encabezado.
  if (/[.;,]$/.test(bruto) && !/^[\dIVXLC.\s]+$/.test(bruto)) return null;

  const canonico = seccionPorNombre(bruto);
  if (canonico) return canonico;

  // Segundo intento: sin el número de página pegado ("3 RESULTS 5").
  const sinPagina = bruto.replace(PAGINA_FINAL, "");
  if (sinPagina !== bruto) {
    const otro = seccionPorNombre(sinPagina);
    if (otro) return otro;
  }

  // Tercer intento: dos secciones en una cabecera, o una cola de revista.
  if (!permitirCompuesta) return null;
  return seccionCompuesta(sinPagina);
}

/** Coincidencia exacta con un nombre de sección, quitada la numeración. */
function seccionPorNombre(bruto: string): string | null {
  const normal = normalizar(desespaciar(bruto).replace(PREFIJO_NUMERO, ""));
  if (!normal || normal.length > 60) return null;
  return FORMA_A_CANONICO.get(normal) ?? null;
}

/** Cabecera corta que junta dos secciones o añade una cola.
 *
 *  "Results and Discussion", "Subjects and Methods", "Discussion/Conclusion",
 *  "Conflict of Interest Statement".
 *
 *  Se limita a líneas de hasta 4 palabras y se exige una conjunción o una
 *  cola conocida, NO basta con que la línea empiece por el nombre de una
 *  sección. Sin esa exigencia, un renglón de prosa partido ("Results were
 *  compared against") o un titulillo corrido ("Summary of Product
 *  Characteristics") pasarían por cabecera, y como `cabecera` corta el título
 *  en la primera sección detectada, el artículo se quedaría sin título y sin
 *  autores.
 *
 *  Con conjunción se exige que TODAS las partes sean reconocibles: nombre de
 *  sección, o calificador de `CALIFICADORES_CABECERA`. Medido el 4 sep 2026
 *  sobre 100 primeras páginas, bastaba con que UNA parte fuera sección, y eso
 *  convertía en cabecera la segunda línea de un título partido: "Blood
 *  biomarkers for Alzheimer disease: Limitations and Opportunities" daba
 *  "limitaciones" en su segunda mitad, y "Findings and Implications" daba
 *  "resultados". El título se cortaba ahí, y sin título no hay autor: la cita
 *  caía al nombre del archivo o, peor, salía del pie de la página.
 *
 *  El precio es perder cabeceras reales con cola libre ("Limitations and
 *  Future Directions", que tiene exactamente la misma forma). Se asume a
 *  propósito: no etiquetar una sección solo deja el fragmento con la sección
 *  anterior, mientras que partir el título destruye la cita del trabajo
 *  entero. */
function seccionCompuesta(bruto: string): string | null {
  const normal = normalizar(desespaciar(bruto).replace(PREFIJO_NUMERO, ""));
  if (!normal || normal.split(/\s+/).length > 4) return null;
  for (const cola of COLAS_SECCION) {
    if (normal.endsWith(cola)) {
      const canonico = FORMA_A_CANONICO.get(normal.slice(0, -cola.length).trim());
      if (canonico) return canonico;
    }
  }
  const partes = normal.split(UNION_SECCIONES).filter(Boolean);
  if (partes.length !== 2) return null;
  const canonicos = partes.map((p) => FORMA_A_CANONICO.get(p) ?? null);
  const todasReconocibles = partes.every(
    (parte, i) => canonicos[i] !== null || CALIFICADORES_CABECERA.has(parte),
  );
  const secciones = canonicos.filter((c): c is string => c !== null);
  if (!todasReconocibles || !secciones.length) return null;
  // Con dos secciones manda la primera, porque lo que sigue a la cabecera
  // empieza por ella: tras "Results and Discussion" vienen resultados.
  //
  // La excepción es el resumen. "Summary and Conclusions" es una sección de
  // CIERRE y "manda la primera" la etiquetaba "resumen", que es la etiqueta
  // del abstract: el veredicto final de los autores quedaba marcado como
  // resumen preliminar, y la sección es justo lo que dice a quien lee la
  // respuesta cuánto peso darle. Cuando la primera parte es el resumen manda
  // la otra, que es la específica.
  if (secciones.length === 2 && secciones[0] === "resumen") return secciones[1];
  return secciones[0];
}

// Líneas de las que NUNCA sale el año de publicación: la marca de agua de
// descarga de una revista trae la fecha en que alguien bajó el PDF, que suele
// ser más reciente que la publicación y ganaría cualquier criterio de "el año
// más alto".
const RUIDO_ANIO = [
  "downloaded", "descargado", "accessed", "consultado", "retrieved",
  "printed", "impreso", "copyright", "\u00a9",
];

// Referencia bibliográfica del propio artículo tal y como la estampa la
// revista en la portada: "Alzheimer's Dement. 2025;21(Suppl. 2):e099222",
// "Neurology 2026;107:e214712". El año va pegado al volumen con punto y coma.
const REFERENCIA_BIBLIOGRAFICA = /\b(19[5-9]\d|20[0-4]\d);\s*\d{1,4}\b/;
// Línea de fechas editoriales: "Received: 27 January 2026  Accepted: 28 May 2026".
const FECHAS_EDITORIALES = /\b(?:received|revised|accepted|published|recibido|revisado|aceptado|publicado)\b/i;

/** Año de publicación, o cadena vacía.
 *
 *  Prioridad, medida el 4 sep 2026 con cinco PDF reales de Alzheimer's &
 *  Dementia y Neurology:
 *  1. Un año junto a CUALQUIER aparición del DOI. Solo se miraba la primera,
 *     y en Wiley esa es la línea "DOI: 10.1002/..." de la esquina superior,
 *     sin año; la del pie ("https://doi.org/...") va pegada a la referencia
 *     bibliográfica. Así PMC12741034 se quedaba sin año y PMC12777541 tomaba
 *     el 2022 de "enrolled between 2022 and October 2024" del resumen.
 *  2. La línea de fechas editoriales (Received/Revised/Accepted).
 *  3. La referencia bibliográfica de la portada ("Revista 2025;21:...").
 *  4. La cabecera, línea a línea hasta la primera sección, saltando las
 *     marcas de descarga: un PDF bajado en 2026 no se cita como de 2026.
 *  Y nunca un año menor que el de la referencia bibliográfica de la propia
 *  cabecera. */
function extraerAnio(texto: string, doi: string, textoPortada = ""): string {
  if (!texto) return "";
  const anioActual = new Date().getFullYear();

  const candidatos = (fragmento: string): Array<[string, number]> => {
    const rangos = [...fragmento.matchAll(RANGO_DE_ANIOS)].map(
      (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as [number, number],
    );
    const salida: Array<[string, number]> = [];
    for (const m of fragmento.matchAll(ANIO)) {
      const anio = m[1];
      const inicio = m.index ?? 0;
      const fin = inicio + m[0].length;
      // Un extremo de "2026-2036" es la vigencia de un plan, no un año de
      // publicación. También se rechazan años futuros: el bug llegó a
      // guardar literalmente "Health et al., 2036".
      if (rangos.some(([a, b]) => a <= inicio && fin <= b)) continue;
      if (parseInt(anio, 10) > anioActual) continue;
      salida.push([anio, inicio]);
    }
    return salida;
  };

  const referencia = REFERENCIA_BIBLIOGRAFICA.exec(textoPortada);
  const anioBibliografico =
    referencia && parseInt(referencia[1], 10) <= anioActual ? referencia[1] : "";
  const conSuelo = (anio: string): string =>
    anioBibliografico && anio < anioBibliografico ? anioBibliografico : anio;

  if (doi) {
    // Todas las apariciones del DOI. La ventana que lleva la referencia
    // bibliográfica ("Revista 2025;21:...") manda; si ninguna la lleva, el año
    // más cercano al DOI en la primera ventana que tenga alguno.
    let primero = "";
    let pos = texto.indexOf(doi);
    while (pos >= 0) {
      const inicio = Math.max(0, pos - 120);
      const ventana = texto.slice(inicio, pos + doi.length + 120);
      const bibliografica = REFERENCIA_BIBLIOGRAFICA.exec(ventana);
      if (bibliografica && parseInt(bibliografica[1], 10) <= anioActual) {
        return conSuelo(bibliografica[1]);
      }
      const cerca = candidatos(ventana);
      if (cerca.length && !primero) {
        const doiLocal = pos - inicio;
        primero = cerca.reduce((mejor, item) =>
          Math.abs(item[1] - doiLocal) < Math.abs(mejor[1] - doiLocal) ? item : mejor,
        )[0];
      }
      pos = texto.indexOf(doi, pos + doi.length);
    }
    if (primero) return conSuelo(primero);
  }

  const lineas = texto.split(/\r\n|\r|\n/);
  for (const linea of lineas) {
    if (!FECHAS_EDITORIALES.test(linea)) continue;
    const fechas = candidatos(linea);
    // La última fecha (aceptado, publicado) es la más cercana a la publicación.
    if (fechas.length) return conSuelo(fechas[fechas.length - 1][0]);
  }

  if (anioBibliografico) return anioBibliografico;

  const encontrados: string[] = [];
  for (const linea of lineas) {
    const bajo = sinAcentos(linea).toLowerCase();
    if (RUIDO_ANIO.some((r) => bajo.includes(r))) continue;
    // Sin DOI solo se inspecciona la cabecera bibliográfica. Los años que
    // aparecen ya dentro del resumen, cuerpo o lista de referencias pueden
    // pertenecer a otros estudios y no identifican esta obra.
    if (detectarSeccion(linea) !== null) break;
    encontrados.push(...candidatos(linea).map(([anio]) => anio));
  }
  // En una cabecera bien formada el primer año es el del trabajo. Elegir el
  // mayor fue precisamente lo que convertía rangos y bibliografía en una
  // supuesta fecha de publicación.
  return encontrados.length ? conSuelo(encontrados[0]) : "";
}

/** Cita corta: "Allegri et al., 2023", o vacío.
 *
 *  Vacío significa "no se pudo determinar": quien llama cita entonces el
 *  nombre del archivo, que es corto, único y con el que la interfaz sabe
 *  enlazar.
 *
 *  NO se usa el título como respaldo, aunque se conozca. Medido en
 *  producción: un título de 70 caracteres recortado con puntos suspensivos se
 *  repetía en cada punto de una lista, hacía la respuesta ilegible y rompía el
 *  enlace de la cita con su fuente. Una cita tiene que ser corta antes que
 *  bonita. */
export function referenciaDe(meta: MetaObra): string {
  if (meta.autor && meta.anio) return `${meta.autor} et al., ${meta.anio}`;
  return "";
}

/** ¿La línea parece un encabezado por cómo está maquetada?
 *
 *  Existe porque la lista cerrada de secciones solo cubre los nombres de un
 *  artículo científico. En cualquier otro documento (una guía, un informe, un
 *  folleto) los encabezados se llaman "Composición del mazo" o "Por qué
 *  elegirnos", no se reconocen, y entonces la sección detectada al principio
 *  se arrastra por todo lo que viene después: el fragmento de la página 4
 *  acaba citado como "sección: Introducción", que es peor que no decir nada.
 *
 *  Un encabezado se reconoce por la maqueta y no por el nombre: línea corta,
 *  sin puntuación final, y con más cuerpo de letra o en negrita respecto del
 *  texto corrido. */
export function esEncabezadoPorFormato(
  texto: string,
  tamano: number,
  cuerpo: number,
  negrita: boolean,
): boolean {
  const limpio = texto.trim();
  if (!limpio || limpio.length > 80) return false;
  if (/[.;,:]$/.test(limpio)) return false;
  if (!/\p{L}/u.test(limpio)) return false;
  if (limpio.split(/\s+/).length > 12) return false;
  // La cabecera corrida con letras espaciadas y la línea de autores con
  // superíndices van en negrita y grandes, pero no son secciones.
  if (esLetrasEspaciadas(limpio) || esLineaDeAutores(limpio)) return false;
  // Tres señales de línea de párrafo, medidas con el resumen de Alzheimer's &
  // Dementia, que va a 9 pt sobre un cuerpo de 8 y colaba como encabezado
  // cualquier línea suya de menos de 80 caracteres: un encabezado empieza por
  // mayúscula o cifra (no "impairment (MCI)/dementia. Results were..."), no
  // acaba en la palabra cortada de un renglón ("faster neu-"), y no es una
  // etiqueta con dos puntos seguida de una frase ("METHODS: We analyzed 982
  // community-dwelling individuals followed").
  if (!/^["'(\[\u00ab\u201c]?[\p{Lu}\p{N}]/u.test(limpio)) return false;
  if (/\p{L}[-\u2010\u00ad]$/u.test(limpio)) return false;
  const trasDosPuntos = /:\s+(.+)$/.exec(limpio);
  if (trasDosPuntos && trasDosPuntos[1].split(/\s+/).length >= 4) return false;
  if (cuerpo && tamano >= cuerpo + 0.4) return true;
  return Boolean(negrita && cuerpo && tamano >= cuerpo - 0.2);
}

/** Una línea física con su formato, como la construye `pdf.ts`. Reemplaza a
 *  los `chars` de pdfplumber: pdf.js ya agrupa los caracteres en items y el
 *  tamaño y la negrita se calculan por línea al montarla. */
export interface LineaFormato {
  texto: string;
  tamano: number;
  negrita: boolean;
}

/** Tamaño de fuente del texto corrido: el que más caracteres ocupa.
 *
 *  Se pesa por caracteres y no por líneas porque el cuerpo es, por mucho, lo
 *  que más texto tiene en una página. A igualdad, gana el menor. */
function tamanoCuerpo(lineas: Array<{ tamano: number; texto: string }>): number {
  const porTamano = new Map<number, number>();
  for (const { tamano, texto } of lineas) {
    porTamano.set(tamano, (porTamano.get(tamano) ?? 0) + texto.length);
  }
  let mejor: [number, number] | null = null;
  for (const par of porTamano) {
    if (mejor === null || par[1] > mejor[1] || (par[1] === mejor[1] && par[0] < mejor[0])) {
      mejor = par;
    }
  }
  return mejor ? mejor[0] : 0;
}

/** Tamaño del texto corrido de todo el documento, pesado por caracteres. */
export function tamanoDeCuerpo(paginas: LineaFormato[][]): number {
  return tamanoCuerpo(paginas.flat());
}

function esRuidoTitulo(texto: string): boolean {
  const bajo = sinAcentos(texto).toLowerCase();
  if (RUIDO_TITULO.some((r) => bajo.includes(r))) return true;
  // Una línea sin letras (números de página, líneas de símbolos).
  return !/\p{L}/u.test(texto);
}

const MAX_LINEAS_CABECERA = 15;

/** Las líneas anteriores al primer encabezado de sección.
 *
 *  El título y los autores están siempre por encima del resumen, así que el
 *  corte lo marca la primera sección detectada. Es más robusto que cortar por
 *  coordenada: no depende del tamaño de la página ni de cuánto texto haya.
 *
 *  Dentro del bloque del título (una línea con el mismo cuerpo de letra
 *  grande que la anterior) no se acepta una cabecera COMPUESTA. Es la segunda
 *  barrera del fallo medido el 4 sep 2026: un título de dos líneas cuya
 *  segunda mitad tiene forma "Sección and Palabra" se cortaba a sí mismo, y
 *  el trabajo se quedaba sin título ni autor. Un nombre de sección a secas
 *  ("Abstract") sí corta, esté donde esté: ahí no hay ambigüedad. */
function cabecera(lineas: LineaFormato[]): LineaFormato[] {
  const cuerpo = tamanoCuerpo(lineas);
  for (let i = 0; i < lineas.length; i++) {
    const { tamano, texto } = lineas[i];
    const enBloqueTitulo =
      i > 0 &&
      Math.abs(tamano - lineas[i - 1].tamano) < 0.6 &&
      (!cuerpo || tamano > cuerpo + 0.5);
    if (detectarSeccion(texto, { permitirCompuesta: !enBloqueTitulo }) !== null) {
      return lineas.slice(0, i);
    }
  }
  return lineas.slice(0, MAX_LINEAS_CABECERA);
}

/** Título por tamaño de fuente: el bloque más grande de la cabecera.
 *
 *  Es lo fiable en un PDF de revista: el título está maquetado más grande que
 *  todo lo demás. La condición de que sea ESTRICTAMENTE mayor que el cuerpo es
 *  la que evita el falso positivo peor: en un documento sin estructura (unos
 *  apuntes, una carta) no hay título, y sin esa condición se tomaría el primer
 *  párrafo como si lo fuera y se citaría un trabajo que no existe.
 *
 *  Devuelve el título, el tamaño usado y los índices (en `lineas`) de las
 *  líneas que lo forman: el bloque del título. Título vacío si no hay uno
 *  reconocible. */
function extraerTitulo(lineas: LineaFormato[]): { titulo: string; tamano: number; indices: number[] } {
  const nada = { titulo: "", tamano: 0, indices: [] as number[] };
  const cab = cabecera(lineas);
  const utiles = cab.map((l, i) => ({ ...l, indice: i })).filter((l) => !esRuidoTitulo(l.texto));
  if (!utiles.length) return nada;

  const mayor = Math.max(...utiles.map((l) => l.tamano));
  if (mayor <= 0) return nada;

  // El cuerpo se mide en lo que va DESPUÉS de la cabecera; si el documento no
  // tiene secciones, en las propias líneas de cabecera que no son el título.
  const resto = lineas.slice(cab.length);
  const referencia = resto.length ? resto : utiles.filter((l) => Math.abs(l.tamano - mayor) >= 0.6);
  const cuerpo = tamanoCuerpo(referencia);
  if (cuerpo && mayor <= cuerpo + 0.5) return nada;
  // Todo el documento tiene el mismo tamaño: no hay título maquetado.
  if (!cuerpo) return nada;

  // El título puede ocupar varias líneas del mismo tamaño, seguidas.
  const bloque = utiles.filter((l) => Math.abs(l.tamano - mayor) < 0.6);
  const titulo = bloque.map((l) => l.texto).join(" ").replace(/\s+/g, " ").trim();
  if (titulo.length < 8 || titulo.length > 300) return { ...nada, tamano: mayor };
  return { titulo, tamano: mayor, indices: bloque.map((l) => l.indice) };
}

// Partículas que forman parte del apellido en holandés, alemán, español,
// portugués, italiano, francés y árabe: el apellido es "van der Flier", "de la
// Torre" o "De Strooper", y citarlo como "Flier" o "Torre" no lo reconoce
// nadie que lea literatura sobre Alzheimer. Se absorben hacia la izquierda
// desde el último token del nombre.
const PARTICULAS_APELLIDO = new Set([
  "van", "der", "den", "ter", "von", "zu", "de", "del", "della", "dei",
  "degli", "di", "da", "das", "do", "dos", "du", "des", "la", "las", "los",
  "le", "el", "al", "bin", "ibn",
]);

// Sufijos generacionales y grados que cierran un nombre ("Jack CR Jr",
// "Allegri PhD"). Aquí solo van los que NO pueden confundirse con un bloque
// de iniciales; los ambiguos ("MD", "RN", que son a la vez grado e iniciales
// Vancouver válidas en "Smith MD, Jones AB") viven en `GRADOS_AMBIGUOS`, que
// los descarta solo cuando delante queda un nombre completo.
const SUFIJOS_NOMBRE = new Set([
  "jr", "sr", "ii", "iii", "filho", "neto", "junior", "jnr",
  "phd", "msc", "mph", "mbbs", "frcp", "frcpc", "faan", "dphil", "pharmd",
  "drph", "dsc", "scd", "edd", "psyd", "mba", "mhs", "msce", "msci", "facp",
  "faha", "frcpath", "chb", "bsc", "mhsc", "dds", "dvm",
]);

// Tratamientos y grados que van DELANTE del nombre ("Prof Dr Ricardo
// Allegri"). El bucle de sufijos solo mira el final, así que sin esto "Prof"
// y "Dr" contaban como tokens del nombre: con cuatro tokens se disparaba la
// regla de apellido doble y salía "Ricardo Allegri" en vez de "Allegri".
const PREFIJOS_NOMBRE = new Set([
  "prof", "professor", "profesor", "dr", "dra", "drs", "doctor", "doctora",
  "mr", "mrs", "ms", "miss", "sir", "phd", "msc",
]);

// Sufijos generacionales que la maqueta cuela ENTRE el apellido y las
// iniciales ("Jack Jr CR"). El bucle que solo mira el final dejaba "Jack Jr"
// como apellido y la cita salía "Jack Jr et al.".
const SUFIJOS_INTERIORES = new Set(["jr", "sr", "ii", "iii", "junior", "jnr"]);

// Grados que son a la vez bloque de iniciales Vancouver válido: "Smith MD"
// puede ser el doctor Smith o Smith con iniciales M. D. Se descarta como
// grado solo cuando quedan dos tokens o más, es decir cuando delante hay un
// nombre completo ("Ricardo Allegri MD"); con un solo token delante gana la
// lectura Vancouver, que es la que salva la cita ("Smith").
const GRADOS_AMBIGUOS = new Set(["md", "do", "rn"]);

// Apellidos de 2 o 3 letras que las revistas imprimen en MAYÚSCULAS junto al
// nombre de pila ("Xin LI", "Jian WU"), convención francesa y de muchas
// firmas asiáticas. Tienen la forma exacta de una firma Vancouver ("Sperling
// RA"), así que hace falta una lista cerrada para cambiar de lectura con
// evidencia: sin ella se perderían las firmas Vancouver reales del corpus, y
// esas son mayoría.
const APELLIDOS_MAYUSCULAS = new Set([
  "li", "wu", "xu", "hu", "he", "lu", "yu", "ye", "ng", "ho", "lam",
  "tan", "lin", "gao", "guo", "luo", "zhu", "kim", "lee", "cho", "wei",
]);

// Términos de maquetación y de dominio que nunca son el apellido de una
// persona. Un término seguido de su sigla tiene la forma exacta de una firma
// Vancouver ("Cerebrospinal Fluid CSF", "Amyloid PET", "Open Access CC BY",
// "Original Article OA"), y salían como autores: la cita era "Cerebrospinal
// Fluid et al., 2023". Se comprueba palabra a palabra sobre el primer autor,
// y en TODAS las ramas: en la occidental sin iniciales "Open Access Article"
// daba "Article" (revisión adversarial final).
const TERMINOS_NO_PERSONA = new Set([
  // Maquetación y front matter de la revista.
  "access", "article", "articles", "author", "authors", "corresponding",
  "research", "review", "reviews", "supplementary", "supporting",
  "information", "editorial", "keywords", "copyright", "license",
  "licence", "reserved", "journal", "volume", "issue", "online",
  "published", "publisher", "received", "revised", "accepted", "funding",
  "disclosure", "disclosures", "conflict", "contributions",
  "availability", "available", "appendix", "highlights", "graphical", "preprint",
  "original", "commentary", "viewpoint", "abstract", "summary", "figure",
  "table", "open", "downloaded", "doi", "issn", "isbn", "pmid",
  // Dominio: entidades y técnicas del corpus médico.
  "cerebrospinal", "fluid", "amyloid", "tau", "plasma", "serum", "blood",
  "cognitive", "impairment", "disease", "dementia", "alzheimer",
  "alzheimers", "biomarker", "biomarkers", "imaging", "hippocampal",
  "cortical", "cohort", "trial", "baseline", "longitudinal",
  "pet", "mri", "csf", "eeg", "meg", "mci", "apoe", "suvr", "fdg",
]);

// Bloque de iniciales tal y como queda tras quitar la puntuación de los
// bordes: "WM", "R.F", "CR", "J-P", "J.-P". Siempre en mayúsculas: "Li" o
// "Ma" son apellidos, no iniciales.
const INICIALES = /^(?:[A-Z]\.?){1,3}$|^[A-Z]\.?-[A-Z]\.?$/;

// Marcas de afiliación y grados pegados a la firma: superíndices, asteriscos,
// dígitos.
const MARCAS_DE_AFILIACION = /[\d*\u2020\u2021\u00a7\u00b6#]+/g;

/** ¿Token con pinta de nombre o apellido (capitalizado, solo letras)? */
function esNombrePropio(token: string): boolean {
  const limpio = token.replace(/[-']/g, "");
  return token.length >= 2 && /^\p{L}+$/u.test(limpio) && esMayuscula(token[0]);
}

/** ¿Token con forma de nombre de pila normal ("Xin", "Jian")?
 *
 *  Capitalización de palabra corriente: nada de mayúsculas sostenidas (que
 *  serían un apellido maquetado o un bloque de iniciales) ni guiones. */
function esNombreDePila(token: string): boolean {
  return /^\p{Lu}\p{Ll}+$/u.test(token);
}

function tokensDeFirma(segmento: string): string[] {
  return segmento
    .replace(MARCAS_DE_AFILIACION, " ")
    .split(/\s+/)
    .map((t) => recortar(t, ".,"))
    .filter(Boolean);
}

/** ¿El segmento sigue la convención "Nombre APELLIDO" con apellido corto en
 *  mayúsculas de la lista cerrada ("Jian WU")? */
function terminaEnApellidoMayusculas(segmento: string): boolean {
  const tokens = tokensDeFirma(segmento);
  if (tokens.length < 2) return false;
  const ultimo = tokens[tokens.length - 1];
  return (
    /^[A-Z]{2,3}$/.test(ultimo) &&
    APELLIDOS_MAYUSCULAS.has(ultimo.toLowerCase()) &&
    esNombreDePila(tokens[tokens.length - 2])
  );
}

function esRuidoDeAutores(segmento: string): boolean {
  const bajo = sinAcentos(segmento).toLowerCase();
  if (RUIDO_AUTORES.some((r) => bajo.includes(r))) return true;
  const palabras = bajo.match(/[a-z]+/g) ?? [];
  return palabras.some((p) => SIGLAS_INSTITUCIONALES.has(p) || RUIDO_DIRECCION.has(p));
}

/** ¿El segmento parece una firma de coautor? Vancouver ("Scheltens P",
 *  "Jack CR Jr") u occidental ("Manuel Colome"), sin palabras de institución. */
function pareceFirma(segmento: string): boolean {
  if (esRuidoDeAutores(segmento)) return false;
  const tokens = tokensDeFirma(segmento);
  if (tokens.some((t) => TERMINOS_NO_PERSONA.has(t.toLowerCase()))) return false;
  const sinSufijos = tokens.filter((t) => !SUFIJOS_NOMBRE.has(t.toLowerCase()));
  if (sinSufijos.length < 2) return false;
  const ultimo = sinSufijos[sinSufijos.length - 1];
  if (INICIALES.test(ultimo)) return sinSufijos.slice(0, -1).some(esNombrePropio);
  return sinSufijos.filter(esNombrePropio).length >= 2;
}

/** Apellido (con partículas) del primer autor, o cadena vacía.
 *
 *  Dos formatos de firma conviven en el corpus y piden reglas distintas:
 *
 *  * **Vancouver** ("van der Flier WM, Scheltens P, Jack CR Jr"), el estilo
 *    de Neurology, Alzheimer's & Dementia, Lancet Neurol y JAMA Neurol. Es
 *    el formato DOMINANTE en literatura sobre Alzheimer y la heurística
 *    anterior lo anulaba: tomaba el último token ("WM") como apellido y lo
 *    rechazaba por corto, así que todos esos trabajos acababan citados por
 *    nombre de archivo aunque el título sí se extrajera. Aquí las iniciales
 *    van a la derecha; quitadas, TODO lo que queda es el apellido, lo que
 *    resuelve de paso partículas ("van der Flier") y compuestos españoles
 *    ("Garcia Ribas MJ").
 *
 *  * **Occidental** ("Wiesje M. van der Flier, Philip Scheltens"). El
 *    apellido es el último token, más las partículas que lo preceden. Una
 *    partícula capitalizada solo se absorbe si no abre el nombre: "Bart De
 *    Strooper" es "De Strooper", pero en "Le Wang" el "Le" es el nombre de
 *    pila. Con cuatro o más tokens y sin inicial entre los dos últimos se
 *    conservan los dos apellidos ("Maria Jose Garcia Ribas" es "Garcia
 *    Ribas"); con tres ("Maria Garcia Ribas") es indistinguible de
 *    "Ricardo Francisco Allegri" y se toma solo el último. Y si hay una
 *    partícula delante de esos dos últimos tokens, lo compuesto es el
 *    nombre de pila y no el apellido ("Maria del Carmen Garcia" es
 *    "Garcia").
 *
 *  En los dos formatos la función devuelve cadena vacía antes que arriesgar
 *  una cita inventada: es lo que hace `referenciaDe` caer al nombre del
 *  archivo, que siempre es comprobable.
 *
 *  `apellidoComaInicial` dice si la línea entera tenía forma bibliográfica
 *  "Apellido, N.": ahí `primero` es solo el apellido y no se le puede exigir
 *  dos palabras. `otrosSegmentos` son los demás autores de la línea, que
 *  sirven de evidencia para las dos lecturas ambiguas. */
export function apellidoDelPrimerAutor(
  primero: string,
  hayMasAutores: boolean,
  apellidoComaInicial: boolean,
  otrosSegmentos: string[] = [],
): string {
  let tokens = tokensDeFirma(primero);

  // Tratamiento delante del nombre: "Prof Dr Ricardo Allegri".
  let quitoTratamiento = false;
  while (tokens.length && PREFIJOS_NOMBRE.has(tokens[0].toLowerCase())) {
    tokens.shift();
    quitoTratamiento = true;
  }

  while (tokens.length && SUFIJOS_NOMBRE.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  // Sufijo generacional en posición interior: "Jack Jr CR". El bucle de
  // arriba solo mira el final, así que "Jr" sobrevivía y el apellido salía
  // "Jack Jr". Nunca se quita el primer token: en portugués "Neto" y
  // "Filho" también son apellidos y ahí sí encabezan.
  if (tokens.length > 1) {
    tokens = [tokens[0], ...tokens.slice(1).filter((t) => !SUFIJOS_INTERIORES.has(t.toLowerCase()))];
  }

  // Grado ambiguo con las iniciales ("MD"): solo se descarta si delante
  // queda un nombre de al menos dos tokens.
  while (tokens.length >= 3 && GRADOS_AMBIGUOS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  // Un término del dominio o de la maqueta nunca es una persona, tenga o no
  // iniciales al lado: "Cerebrospinal Fluid CSF" y "Open Access Article" se
  // rechazan aquí, antes de decidir el formato.
  if (tokens.some((t) => TERMINOS_NO_PERSONA.has(t.toLowerCase()))) return "";

  // Quitar el tratamiento no puede dejar la firma sin autor: "Dr. Allegri, M
  // Colome" perdía a Allegri porque un solo token no pasaba la exigencia de
  // dos palabras propias de la rama occidental. Si tras el tratamiento queda
  // un único token capitalizado y hay más autores en la línea, ese token ES
  // el apellido (revisión adversarial final).
  if (
    quitoTratamiento &&
    tokens.length === 1 &&
    hayMasAutores &&
    esNombrePropio(tokens[0]) &&
    tokens[0].length >= 3
  ) {
    return tokens[0];
  }

  const iniciales: string[] = [];
  while (tokens.length && INICIALES.test(tokens[tokens.length - 1])) {
    iniciales.push(tokens.pop() as string);
  }
  if (!tokens.length) return "";

  if (iniciales.length && !tokens.some((t) => INICIALES.test(t))) {
    // Vancouver. Que quede otra inicial suelta entre los tokens ("R.
    // Allegri WM") delata que lo de la derecha no era el bloque de
    // iniciales de la firma; en ese caso se sigue por la rama occidental.
    //
    // El grado pegado al nombre ("Ricardo Allegri MD", "Ricardo F.
    // Allegri MD") ya no llega aquí: "MD" está en `GRADOS_AMBIGUOS` y se
    // descarta antes, porque delante queda un nombre completo. Lo que sí
    // llega es "Smith MD", donde con un solo token delante no se puede
    // saber si "MD" es el grado o las iniciales, y gana la lectura de
    // iniciales, que es la que salva la cita.
    const siglas = iniciales.slice().reverse().map((bloque) => bloque.replace(/\./g, ""));

    // "Nombre APELLIDO" ("Xin LI", "Jian WU"): el bloque de mayúsculas no
    // son iniciales sino el apellido, y la lectura Vancouver se quedaba
    // con el nombre de pila y citaba "Xin et al.". Pero "Sperling LI" y
    // "Bennett HE" tienen exactamente la misma forma y son firmas Vancouver
    // con iniciales corrientes: la revisión adversarial final los encontró
    // citados como "Li et al." y "He et al.". Solo se cambia de lectura con
    // TODA la evidencia: apellido de la lista cerrada, delante un único token
    // con capitalización de nombre de pila, y los demás autores de la línea
    // siguiendo la misma convención ("Xin LI, Jian WU"). Ante la duda (un
    // solo autor, o coautores con forma "Apellido AB") es un bloque de
    // iniciales y el apellido es el token anterior.
    if (
      tokens.length === 1 &&
      siglas.length === 1 &&
      siglas[0].length >= 2 &&
      siglas[0].length <= 3 &&
      APELLIDOS_MAYUSCULAS.has(siglas[0].toLowerCase()) &&
      esNombreDePila(tokens[0]) &&
      otrosSegmentos.length > 0 &&
      otrosSegmentos.every(terminaEnApellidoMayusculas)
    ) {
      // Se devuelve capitalizado: la caja alta es maquetación, y en la
      // cita "Li et al." se lee mejor que "LI et al.".
      const sigla = siglas[0];
      return sigla[0] + sigla.slice(1).toLowerCase();
    }

    // La sigla solo cuenta con 3 letras o más: con dos ("AD", "CT") choca
    // demasiado con iniciales de personas reales ("Bennett AD").
    if (siglas.some((s) => s.length >= 3 && TERMINOS_NO_PERSONA.has(s.toLowerCase()))) return "";

    // Una sola firma con un bloque de TRES mayúsculas ("Amsterdam UMC",
    // "Hospital Clinic HCB") es casi siempre una institución con su sigla:
    // sin más autores en la línea no hay forma de saberlo, y la cita
    // inventada no tiene remedio. Un autor único con tres iniciales se
    // pierde a cambio y cae al nombre del archivo.
    if (!hayMasAutores && siglas[0].length >= 3) return "";

    // Con más segmentos en la línea, alguno tiene que parecer una firma de
    // coautor. Al mirar el ruido de institución solo en el primer segmento,
    // "Amsterdam UMC, Department of Neurology" llegaba aquí con la forma
    // exacta de "Apellido AB" y salía "Amsterdam et al.".
    if (hayMasAutores && !otrosSegmentos.some(pareceFirma)) return "";

    const particulas = tokens.filter((t) => PARTICULAS_APELLIDO.has(t.toLowerCase()));
    const propios = tokens.filter(
      (t) => !PARTICULAS_APELLIDO.has(t.toLowerCase()) && esNombrePropio(t),
    );
    // Sigla que repite las iniciales de las palabras anteriores. El precio
    // es perder al autor cuyas iniciales coinciden con las de su apellido
    // doble ("Garcia Ribas GR"), y se acepta: quedarse sin cita hace caer
    // al nombre del archivo, mientras que inventarla no tiene remedio.
    if (
      propios.length >= 2 &&
      siglas.join("") === propios.map((t) => t[0]).join("").toUpperCase()
    ) {
      return "";
    }
    // Un apellido tiene 1 o 2 palabras propias ("Garcia Ribas", "Ponce de
    // Leon"); tres seguidas de siglas ("Mild Cognitive Impairment MCI")
    // es un término, no una persona.
    if (
      particulas.length + propios.length === tokens.length &&
      propios.length >= 1 &&
      propios.length <= 2 &&
      tokens.length <= 4 &&
      esNombrePropio(tokens[tokens.length - 1]) &&
      // "Figure A" también es "Palabra Inicial": una sola letra sin más
      // autores detrás no basta como firma.
      (hayMasAutores || iniciales[0].replace(/\./g, "").length >= 2)
    ) {
      return tokens.join(" ");
    }
    return "";
  }

  // Occidental: último token, con partículas y compuesto hacia la izquierda.
  // Hacen falta al menos dos palabras con pinta de nombre: "Documentos base
  // principales" no es una firma (la Vancouver ya se validó por su forma).
  if (!apellidoComaInicial && tokens.filter(esNombrePropio).length < 2) return "";
  const ultimo = tokens.length - 1;
  const nucleo = tokens[ultimo];
  if (!esNombrePropio(nucleo) || nucleo.length < 3) return "";
  let inicio = ultimo;
  while (inicio > 0) {
    const anterior = tokens[inicio - 1];
    if (!PARTICULAS_APELLIDO.has(anterior.toLowerCase())) break;
    if (!esMinusculas(anterior) && inicio - 1 === 0) break;
    inicio--;
  }
  if (
    inicio === ultimo &&
    tokens.length >= 4 &&
    esNombrePropio(tokens[ultimo - 1]) &&
    !INICIALES.test(tokens[ultimo - 1]) &&
    !PARTICULAS_APELLIDO.has(tokens[ultimo - 1].toLowerCase()) &&
    // Una partícula ANTES de esos dos últimos tokens delata un nombre de
    // pila compuesto hispano y no un apellido doble: "Maria del Carmen
    // Garcia", "Jose de Jesus Ramirez", "Maria de los Angeles Ruiz",
    // "Juan de Dios Lopez". Sin esta guarda la regla de los cuatro tokens
    // se llevaba media parte del nombre de pila ("Carmen Garcia", "Jesus
    // Ramirez") y esa cita no la reconoce nadie. "Maria Jose Garcia
    // Ribas", que no lleva partícula, conserva su apellido doble.
    //
    // El precio: si además hay apellido doble ("Maria del Pilar Sanchez
    // Ruiz") se cita solo "Ruiz", que sigue siendo un apellido real de
    // esa persona; "Carmen Garcia" no lo era.
    !tokens.slice(0, ultimo - 1).some((t) => PARTICULAS_APELLIDO.has(t.toLowerCase()))
  ) {
    inicio = ultimo - 1;
  }
  return tokens.slice(inicio).join(" ");
}

// Forma bibliográfica "Apellido, N." con las partículas delante ("van der
// Flier, W. M.") y las iniciales juntas ("Allegri, RF").
const FORMATO_APELLIDO_INICIAL =
  /^\s*(?:[a-z]{2,3}\s+){0,2}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]{2,}\s*,\s*(?<sigla>[A-Z]{1,3})(?:\.|\b)/;

// El mismo par, en cualquier posición de la línea: sirve para contar cuántos
// "Apellido, Iniciales" trae, que es lo que distingue una lista bibliográfica
// de una dirección postal.
const PAR_BIBLIOGRAFICO =
  /[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]{2,}\s*,\s*(?<sigla>[A-Z]{1,3})(?:\.|\b)/g;

// Código postal pegado a la sigla del estado ("MA 02115"). Se exigen 4 a 6
// dígitos y solo espacios entre medias: los grupos de 1 o 2 dígitos son
// marcas de afiliación en superíndice ("Allegri RF1,2") y rechazar por ellas
// dejaría sin cita a los artículos que las llevan.
const DIGITOS_TRAS_SIGLA = /^\s+\d{4,6}\b/;

// Siglas de estado y de país que aparecen tras la coma de una dirección. Se
// solapan a propósito con iniciales de personas ("MA" es Massachusetts y
// María Antonia): en la duda gana la lectura de dirección, porque quedarse
// sin cita hace caer al nombre del archivo, que es comprobable, mientras que
// atribuir el trabajo a una ciudad no lo es.
const SIGLAS_LUGAR = new Set([
  // Países.
  "usa", "uk", "nl", "es", "fr", "it", "pt", "be", "ch", "at", "se",
  "dk", "fi", "ie", "pl", "gr", "mx", "br", "cl", "pe", "cn", "jp", "kr",
  "au", "nz", "za",
  // Estados de EE. UU. (y "de", "ca", "co", "ar", "il", que sirven para
  // los dos).
  "al", "ak", "az", "ar", "ca", "co", "ct", "dc", "de", "fl", "ga", "hi",
  "id", "il", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy",
]);

/** ¿La forma "Palabra, SIGLA" es en realidad una línea de dirección?
 *
 *  Medido el 4 sep 2026: al ampliar la sigla a `[A-Z]{1,3}` la línea de
 *  afiliación que sigue a los autores entró por esta forma, y como
 *  `apellidoComaInicial` desactiva la exigencia de dos palabras propias,
 *  "Boston, MA 02115, USA" daba autor "Boston" y "Amsterdam, NL" daba
 *  "Amsterdam". La cita salía "Boston et al., 2023". Ocurre precisamente
 *  cuando la línea de autores no se reconoce y la siguiente es la dirección.
 *
 *  Dos señales de dirección: la sigla es un estado o país frecuente, o
 *  detrás lleva un código postal. Y una condición que evita el falso
 *  positivo simétrico: varios pares "Apellido, Iniciales" en la misma línea
 *  son una lista bibliográfica ("Ryan, CA, Smith, JB"), y ahí "CA" son las
 *  iniciales del autor aunque coincida con el código de California.
 *
 *  Esa salida pide además que ALGUNA de las siglas no sea un código de
 *  lugar. Sin ese requisito bastaba con enumerar dos ciudades ("Amsterdam,
 *  NL, Rotterdam, NL") para desactivar la guarda entera y volver a fabricar
 *  "Amsterdam et al.", que es justo el fallo que se está arreglando. */
function pareceDireccion(texto: string, comaInicial: RegExpExecArray): boolean {
  const siglas = [...texto.matchAll(PAR_BIBLIOGRAFICO)].map((m) =>
    (m.groups?.sigla ?? "").toLowerCase(),
  );
  if (siglas.length > 1 && siglas.some((s) => !SIGLAS_LUGAR.has(s))) return false;
  const sigla = comaInicial.groups?.sigla ?? "";
  if (SIGLAS_LUGAR.has(sigla.toLowerCase())) return true;
  // Fin de la sigla: el match acaba en ella, salvo el punto opcional.
  let fin = comaInicial.index + comaInicial[0].length;
  if (comaInicial[0].endsWith(".")) fin--;
  return DIGITOS_TRAS_SIGLA.test(texto.slice(fin));
}

// Primer autor: hasta la primera coma, "and", "y" o BARRA VERTICAL.
// Alzheimer's & Dementia (maquetación Wiley, el corpus central) separa los
// autores con "|": sin ella la línea entera era un solo autor y se tomaba el
// ULTIMO apellido, así que "Wiesje M. van der Flier1 | Philip Scheltens1 |
// Frederik Barkhof2" se citaba como "Frederik Barkhof et al.", un autor real
// del trabajo pero no el primero.
const SEPARADOR_DE_AUTORES = /,|\band\b|\by\b|&|;|\||\u00b7/;

/** Apellido del primer autor, o cadena vacía si no se puede con confianza.
 *
 *  Se busca en las líneas que van justo debajo del título y antes del resumen.
 *  Sirven "Ricardo F. Allegri, Manuel Colomé", "Allegri, R." y la firma
 *  Vancouver "Allegri RF, Colome M": la línea decide si es una autoría y
 *  `apellidoDelPrimerAutor` saca el apellido según el formato.
 *
 *  El ruido de institución y dirección se comprueba sobre el SEGMENTO del
 *  primer autor, no sobre la línea entera. En la maqueta de un solo grupo la
 *  línea de autores arrastra institución, ciudad y país ("Ricardo F. Allegri,
 *  Department of Neurology, Boston, MA, USA"), y con la comprobación sobre
 *  toda la línea se descartaba la línea legítima y la cita salía de la línea
 *  bibliográfica de la revista (revisión adversarial final). */
function extraerAutor(lineas: LineaFormato[], tamanoTitulo: number, titulo: string): string {
  if (!lineas.length) return "";
  const normalTitulo = normalizar(titulo);
  let despues = false;
  for (const { tamano, texto } of lineas) {
    const normal = normalizar(texto);
    if (!despues) {
      if (normalTitulo && normal && normalTitulo.includes(normal)) despues = true;
      continue;
    }
    if (!normal) continue;
    // Las demás líneas del título tampoco son autores. Un título de dos
    // líneas solo marcaba `despues` en la primera, así que la segunda
    // entraba como candidata a autoría: de "Practical Considerations
    // Today" salía el apellido "Today". Se reconoce por ir contenida en
    // el título Y al mismo cuerpo de letra que él.
    if (
      normalTitulo &&
      normalTitulo.includes(normal) &&
      tamanoTitulo &&
      Math.abs(tamano - tamanoTitulo) < 0.6
    ) {
      continue;
    }
    if (SECCIONES.resumen.includes(normal) || normal.startsWith("abstract")) break;
    if (tamanoTitulo && tamano > tamanoTitulo + 0.6) continue;

    // Los resúmenes de congreso de Wiley separan a los autores con dobles
    // espacios y el superíndice de afiliación pegado ("Ping Che1  Nan
    // Zhang2"), sin comas: la línea entera era un solo autor y salía "Nan
    // Zhang et al." (medido el 4 sep 2026 con PMC12739034 y PMC12777541).
    const partes = esLineaDeAutores(texto)
      ? texto.split(SEPARADOR_DE_AUTORES).flatMap((p) => p.split(/\s{2,}/))
      : texto.split(SEPARADOR_DE_AUTORES);
    const primero = partes[0];
    const hayMasAutores = partes.length > 1 && partes[1].trim() !== "";
    const otros = partes.slice(1).map((p) => p.trim()).filter(Boolean);

    if (esRuidoDeAutores(primero)) continue;

    // Una línea de autores tiene que parecer realmente una autoría, no el
    // primer subtítulo o frase capitalizada que siga al título. Se aceptan
    // "Nombre Apellido" y el formato bibliográfico "Apellido, N." (también
    // con partícula delante, "van der Flier, W. M.", y con varias
    // iniciales juntas, "Allegri, RF"), salvo cuando esa misma forma es
    // una dirección postal ("Boston, MA 02115, USA").
    const comaInicial = FORMATO_APELLIDO_INICIAL.exec(texto);
    const formatoApellidoInicial = comaInicial !== null && !pareceDireccion(texto, comaInicial);

    const apellido = apellidoDelPrimerAutor(primero, hayMasAutores, formatoApellidoInicial, otros);
    if (apellido) return apellido;
  }
  return "";
}

/** Metadatos del trabajo desde la primera página.
 *
 *  `lineas` son las líneas de la página 1 con su tamaño (para el título por
 *  tamaño de fuente) y `texto` el texto plano de las primeras páginas (para el
 *  DOI y el año). Todo heurístico y determinista: si algo no se puede extraer
 *  con confianza, queda vacío y la cita cae al nombre del archivo. */
export function extraerMetadatos(lineas: LineaFormato[], texto: string): MetaObra {
  return extraerMetadatosConBloque(lineas, texto).meta;
}

/** Como `extraerMetadatos`, más los índices de las líneas de la página 1 que
 *  forman el bloque del título. Esas líneas nunca son una sección: la segunda
 *  línea de un título partido, a la misma fuente grande, se tomaba como
 *  encabezado por formato y la mitad del documento salía con sección
 *  "unimpaired older adults" o "in Patients With Prion Diseases" (medido el
 *  4 sep 2026 con cinco PDF reales). */
export function extraerMetadatosConBloque(
  lineas: LineaFormato[],
  texto: string,
): { meta: MetaObra; lineasTitulo: Set<number> } {
  const { titulo, tamano, indices } = extraerTitulo(lineas);
  const autor = extraerAutor(lineas, tamano, titulo);

  let doi = "";
  const encontrado = DOI.exec(texto ?? "");
  if (encontrado) doi = encontrado[0].replace(/[.,;)]+$/, "");

  const textoPortada = lineas.map((l) => l.texto).join("\n");
  const meta = { titulo, autor, anio: extraerAnio(texto ?? "", doi, textoPortada), doi };
  return { meta, lineasTitulo: new Set(titulo ? indices : []) };
}
