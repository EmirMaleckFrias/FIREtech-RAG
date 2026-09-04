// Reconstrucción de párrafos a partir de las líneas físicas de un PDF. Port de
// `_abre_parrafo`, `_unir_lineas`, `_cierra_oracion` y `_es_linea_suelta` de
// `backend/app/ingest/generic.py`.
//
// pdf.js (como pdfplumber) devuelve líneas físicas, no párrafos, y hay que
// decidir dónde acaba uno con el texto y la geometría de la línea. Trocear por
// líneas, que es lo que se hacía hasta sep 2026, partía oraciones ("between
// 2018 and" | "2021."), separaba cifras de sus unidades ("542" | "pg/mL") y
// dejaba las palabras cortadas con guion como dos mitades que no existen
// ("hippocam-" | "pal").
//
// Tres cambios respecto al Python, medidos en la revisión adversarial final
// del 4 sep 2026:
//
// 1. La fila de tabla ya NO se reconoce por densidad de cifras sino por
//    GEOMETRÍA (huecos horizontales grandes entre los items de la línea, ver
//    `pdf.ts`), y llega aquí como el flag `esFila`. La heurística por cifras
//    fallaba en tablas SIN números (la tabla de estudios incluidos de una
//    revisión sistemática: Study / Design / Population / Outcome) y daba
//    falsos positivos en prosa ("Los 72 pacientes recibieron 10 mg").
// 2. La palabra cortada con guion se comprueba ANTES que cualquier "la
//    siguiente parece fila": "hippocam-" + "pal 3.2 cm3 4.1 cm3" no se
//    recomponía y el término desaparecía del índice.
// 3. El des-guionado ya no conserva el guion por "izquierda corta" (<= 5
//    caracteres): en la maquetación a dos columnas "sig-"+"nificant",
//    "pa-"+"tients", "cog-"+"nitive", "de-"+"mentia" y "re-"+"sults" son
//    cortes normalísimos. Ver `unirLineas`.
import { esMayuscula, primerAlfanumerico, recortar } from "./util";

// Marcadores que abren párrafo por sí solos, aunque la línea anterior no haya
// cerrado la oración: viñetas y rótulos de tabla o figura. Un rótulo ("Table 1.
// Baseline characteristics") suele venir tras una fila de tabla que no acaba en
// punto, y pegarlo al párrafo anterior le quitaría su condición de rótulo. Las
// enumeraciones "(1)", "a)" NO cuentan: en un artículo van dentro de la oración
// ("two criteria: (1) age... and (2) ...") y una línea que empieza por "(2) and"
// es continuación. Los símbolos van como escape: el guion largo no debe
// aparecer literalmente en ningún archivo del proyecto (ver paper.normalizar).
const VINETA = /^[-*+\u2022\u00b7\u25e6\u25aa\u2023\u2013\u2014]\s+/;

// El rótulo exige puntuación de rótulo tras el número ("Table 1." / "Figure 3:"
// / "TABLE 1 |"): sin ella, "as summarized in" | "Table 1, the groups differed"
// (una referencia dentro de la oración que cae a inicio de línea, cosa que pasa
// en casi todo párrafo de Resultados) se partiría por la mitad. Se pierde el
// rótulo sin puntuación ("Table 1 Baseline characteristics", estilo Springer),
// que entonces se pega a la fila anterior: no se pierde nada, solo se junta.
//
// La puntuación NO basta por sí sola, y por eso el rótulo solo abre párrafo si
// la línea anterior no está a mitad de oración (ver `abreParrafo`): medido el
// 4 sep 2026, `_abre_parrafo("summarized in", "Table 1. The groups did not
// differ.")` devolvía True y partía la oración en dos, porque el punto que
// sigue al número era el de "Table 1." pero cerraba la frase de la referencia.
const ROTULO = /^(?:table|tabla|cuadro|figure|figura|fig\.|box)\s*S?\d+[a-z]?\s*[.:|]/i;

/** En Word el rótulo es un párrafo propio y no hay oración que partir, así que
 *  basta con que empiece por "Tabla N"; un falso positivo ("Table 1 shows...")
 *  solo añade al chunk de la tabla la frase que la describe. */
export const ROTULO_TABLA = /^(?:table|tabla|cuadro)\s*S?\d/i;

// Fin de oración, admitiendo el cierre de comillas o paréntesis tras el punto.
const FIN_DE_ORACION = /[.?!:][)\]"'\u201d\u2019]*$/;

// Fin de oración con la cita Vancouver pegada al punto ("cognitive decline.12,13",
// "the first one.14", "decline.12-14"), que es el estilo de la mayoría de
// revistas médicas: el superíndice se extrae como texto normal, así que sin esta
// variante NINGUNA oración citada cerraba y el párrafo crecía hasta el corte
// duro de MAX_PARA_TOKENS, en mitad de una frase. Medido el 4 sep 2026 con un
// PDF de tres oraciones citadas: salían como UN párrafo con la variante
// desactivada y como tres con ella.
//
// Exige una LETRA justo antes del punto, y ahí está la defensa de los decimales
// y las versiones: "0.31" y "gpt-5.4" llevan un dígito delante del punto, así
// que no cierran oración por esta vía y siguen sin partir la línea.
const FIN_CON_CITA = /\p{L}[.?!]\d{1,3}(?:\s*[,;\u2010\u2013-]\s*\d{1,3})*$/u;
// El superíndice de cita, para quitarlo antes de mirar las abreviaturas.
const SUFIJO_CITA = /\d{1,3}(?:\s*[,;\u2010\u2013-]\s*\d{1,3})*$/;

// Palabra cortada por el maquetador: una letra seguida de guion al final.
const CORTE_DE_PALABRA = /\p{L}[-\u2010\u00ad]$/u;
// Cualquier guion pegado a una palabra o cifra al final ("COVID-", "12-").
const GUION_FINAL = /[\p{L}\p{N}_][-\u2010\u00ad\u2013]$/u;

// Prefijos y palabras que forman término con guion y que casi nunca son un
// punto de silabeo de una palabra más larga: si la parte cortada acaba en uno
// de ellos, el guion es del compuesto y se conserva ("non-carriers",
// "beta-amyloid", "long-term", "meta-analysis", "follow-up",
// "community-dwelling", "cross-sectional", "post-hoc", "p-tau").
//
// NO están "pre", "co", "inter", "intra", "multi", "semi", "re" ni "sub",
// aunque también formen compuestos: son sílabas iniciales de palabras muy
// frecuentes del corpus, y a final de línea son casi siempre una palabra
// partida ("pre-"+"vious", "co-"+"hort", "inter-"+"vention", "multi-"+"ple",
// "semi-"+"nal"). Conservarles el guion inventaba "co-hort" e
// "inter-vention", términos que no encuentra nadie, mientras que unirlos en un
// compuesto real ("comorbid", "prespecified", "interrater") da una grafía que
// también existe. "meta" sí está: "metabolic" se silabea me-ta-bo-lic y el
// maquetador no corta en "meta-", así que a final de línea es casi siempre
// "meta-analysis".
const PREFIJOS_CON_GUION = new Set(
  `non self beta alpha gamma delta tau p t e4 apoe long short well cross meta post
   pseudo quasi high low one two three single double half follow year case
   placebo dose time age sex disease amyloid evidence population community cut
   end real gold state quality`.split(/\s+/),
);

// Prefijos que sí se parten a menudo pero que delante de VOCAL forman el
// compuesto con guion por convención ortográfica: "anti-inflammatory",
// "anti-amyloid", "pre-existing", "co-occurring", "re-evaluate",
// "intra-abdominal". "anti-" + "body" sigue uniéndose en "antibody", que es la
// grafía correcta, y "anti" no puede ir en la lista de arriba por eso mismo.
const PREFIJOS_ANTE_VOCAL = new Set(
  `anti pre co re semi multi inter intra de micro macro extra ultra hyper hypo
   neuro immuno socio psycho`.split(/\s+/),
);
const EMPIEZA_POR_VOCAL = /^[aeiouáéíóúàèìòùäëïöü]/i;

// Abreviaturas con punto que NO cierran la oración. Corta a propósito: "etc."
// o "no." sí pueden cerrarla, y una lista larga inventa más de lo que arregla.
const ABREVIATURAS = [
  "et al.", "e.g.", "i.e.", "vs.", "cf.", "fig.", "figs.", "eq.", "ref.",
  "approx.", "ca.", "p. ej.", "vol.", "pp.",
];

// Palabras de enlace (preposiciones, conjunciones, artículos, auxiliares) en
// es/en. Son la señal de que una línea sigue a mitad de oración: ni una fila de
// tabla ni un subtítulo acaban en "and" o "de", y una línea de prosa cortada por
// el maquetador lo hace constantemente ("were assessed by" | "Smith and...").
const ENLACES = new Set(
  `a about above after against all also among an and any are as at be because
   been before being below both but by during each either for from further had
   has have how however if in into is it its less many more most much neither
   no not of on only or other over per same several since so some such than
   that the their then there therefore these this those though through thus to
   under until upon very was were what when where whether which while with
   within without
   al ademas ante antes aunque como con cada cual cuando de del desde donde
   durante el en entonces entre era eran es fue fueron ha han hacia hasta la
   las los luego mas mientras muy para pero por pues que quien salvo se segun
   si sin sobre solo su sus tambien tanto tras un una unos unas varios y`.split(/\s+/),
);

const ADORNO_DE_CELDA = "()[]{}<>\u00ab\u00bb\"'\u201c\u201d.,;:*\u2020\u2021\u00a7";

/** ¿La palabra es de enlace (preposición, conjunción, artículo, auxiliar)?
 *  Una línea que acaba en una está a mitad de frase. */
export function esPalabraDeEnlace(palabra: string): boolean {
  return ENLACES.has(recortar(palabra, ADORNO_DE_CELDA).toLowerCase());
}

// Un párrafo de PDF que aún tiene <= tantas palabras es demasiado corto para ser
// prosa: si además no acaba en puntuación, es un subtítulo que no se detectó.
const MAX_PALABRAS_SUELTA = 6;

/** ¿El texto acumulado cierra una oración? (con o sin cita Vancouver). */
export function cierraOracion(anterior: string): boolean {
  return FIN_DE_ORACION.test(anterior) || FIN_CON_CITA.test(anterior);
}

/** El texto sin el superíndice de cita Vancouver, si lo lleva. */
function sinSuperindice(texto: string): string {
  return FIN_CON_CITA.test(texto) ? texto.replace(SUFIJO_CITA, "") : texto;
}

/** ¿Acaba en una abreviatura con punto que no cierra la oración?
 *
 *  Se mira sobre la línea SIN el superíndice de cita: "Smith et al.12" y
 *  "Fig.2" cierran por la regla Vancouver (letra, punto, dígitos) pero el
 *  punto es el de la abreviatura, y partir ahí dejaba "reported that..." como
 *  párrafo aparte. Medido en la revisión adversarial final del Python. */
function terminaEnAbreviatura(texto: string): boolean {
  const bajo = sinSuperindice(texto).toLowerCase();
  return ABREVIATURAS.some((abreviatura) => bajo.endsWith(abreviatura));
}

/** ¿`anterior` es una línea que va sola (un subtítulo que no se detectó)?
 *
 *  Un subtítulo con el mismo cuerpo de letra que el texto y con un nombre no
 *  canónico ("Statistical analysis", "Sample size calculation") no lo cazan ni
 *  `detectarSeccion` ni `esEncabezadoPorFormato`, y como no acaba en
 *  puntuación se pegaba a la primera frase del párrafo siguiente, que es la
 *  frase que mejor lo resume.
 *
 *  Cuatro condiciones, todas necesarias porque cada una tapa un falso positivo
 *  medido con los casos del propio test de `abreParrafo`:
 *  - `anterior` tiene <= MAX_PALABRAS_SUELTA palabras. `anterior` es el
 *    párrafo en construcción, así que esto solo puede ser cierto en su primera
 *    línea: una línea física de prosa lleva 10-15 palabras.
 *  - no acaba en signo de puntuación (una coma o un punto y coma es prosa).
 *  - no acaba en palabra de enlace ni en palabra con dígitos: "were assessed
 *    by", "as summarized in" y "the coefficient was" son prosa cortada, y "The
 *    mean difference was 0.31" o "We used gpt-5.4" (encontrados atacando esta
 *    misma regla: pocas palabras, mayúscula al principio y en la línea
 *    siguiente) son primera línea de párrafo, no subtítulos. Un subtítulo que
 *    acabe en número ("Experiment 2") se pierde a cambio, y no pasa nada: se
 *    queda pegado al párrafo que describe, que es lo de antes.
 *  - empieza por mayúscula y la línea siguiente también (un subtítulo abre el
 *    bloque; si la siguiente empieza en minúscula es su continuación).
 *
 *  El compromiso que queda: una primera línea de párrafo de <=6 palabras que
 *  acabe en palabra plena y siga con mayúscula ("All patients received" |
 *  "Aricept ...") se parte de más. Es un párrafo en dos, no un dato perdido. */
export function esLineaSuelta(anterior: string, linea: string): boolean {
  const palabras = anterior.split(/\s+/).filter(Boolean);
  if (!palabras.length || palabras.length > MAX_PALABRAS_SUELTA) return false;
  if (!/[\p{L}\p{N}]$/u.test(anterior)) return false;
  const ultima = palabras[palabras.length - 1];
  if (ENLACES.has(recortar(ultima, ADORNO_DE_CELDA).toLowerCase())) return false;
  if (/\p{Nd}/u.test(ultima)) return false;
  const primera = primerAlfanumerico(anterior);
  if (primera === null || !esMayuscula(primera)) return false;
  const inicio = primerAlfanumerico(linea);
  return inicio !== null && esMayuscula(inicio);
}

/** ¿`linea` empieza un párrafo nuevo, o continúa el que acaba en `anterior`?
 *
 *  La regla: la línea anterior cerró la oración (punto, interrogación,
 *  exclamación o dos puntos, con cierre de comillas o paréntesis si lo hay) Y
 *  la nueva arranca con mayúscula o cifra. Todo lo demás continúa el párrafo:
 *  una línea que acaba en "and" o en "hippocam-" no cierra nada, y minúscula
 *  tras punto es una abreviatura ("et al.", "e.g.") o un punto decimal.
 *
 *  Se acepta cortar de más entre dos oraciones del mismo párrafo (ocurre
 *  cuando una oración termina justo a final de línea; con 10-15 palabras por
 *  línea, en torno al 7 % de las oraciones): el empaquetador las vuelve a
 *  juntar, y una frontera entre oraciones es un buen sitio para cortar. Lo que
 *  NO se acepta es cortar de menos, que es lo que hacía el troceo por líneas.
 *
 *  La regla del párrafo NO se aplica a lo que no es prosa: una fila de tabla
 *  (`esFila`, decidida por geometría en pdf.ts) nunca se pega, ni como línea
 *  nueva ni como línea anterior (regresión medida el 4 sep 2026: las tablas de
 *  un PDF salían con todas las filas en una línea), y una línea que va sola
 *  tampoco (`esLineaSuelta`, el subtítulo no detectado que se comía la primera
 *  frase del párrafo).
 *
 *  Orden de las guardas: la palabra cortada con guion va ANTES que las de
 *  fila. Medido: "hippocam-" + "pal 3.2 cm3 4.1 cm3" (el rótulo de una fila
 *  partido en dos líneas) no se recomponía y "hippocampal" desaparecía del
 *  índice. */
export function abreParrafo(
  anterior: string,
  linea: string,
  flags: { anteriorEsFila?: boolean; lineaEsFila?: boolean } = {},
): boolean {
  if (VINETA.test(linea)) return true;
  if (GUION_FINAL.test(anterior)) return false;
  // Una fila de tabla es un párrafo propio: nada se le pega delante ni detrás.
  if (flags.lineaEsFila) return true;
  // El rótulo de tabla solo abre párrafo si la anterior NO sigue a mitad de
  // oración: si sigue, "Table 1." es una referencia dentro de la frase ("as
  // summarized in" | "Table 1. The groups did not differ.") y su punto es el
  // final de ESA frase, no el de un rótulo.
  if (ROTULO.test(linea) && (cierraOracion(anterior) || flags.anteriorEsFila)) return true;
  if (flags.anteriorEsFila) return true;
  if (!cierraOracion(anterior)) return esLineaSuelta(anterior, linea);
  if (terminaEnAbreviatura(anterior)) return false;
  const inicio = primerAlfanumerico(linea);
  if (inicio === null) return true;
  return esMayuscula(inicio) || /\p{Nd}/u.test(inicio);
}

/** Pega `linea` al final de `anterior`, deshaciendo el corte de palabra.
 *
 *  "hippocam-" + "pal" -> "hippocampal": el guion lo puso el maquetador y sin
 *  quitarlo la palabra no existe en el índice (medido con el parser: tras
 *  indexar un párrafo con "hippocam-" a final de línea, "hippocampal" no
 *  aparecía en ningún chunk). Se quita solo cuando lo precede una letra y la
 *  continuación es minúscula; con mayúscula o cifra detrás ("anti-" +
 *  "Alzheimer", "COVID-" + "19") el guion es parte del término y se conserva.
 *
 *  Y se conserva TAMBIÉN cuando la parte izquierda es un prefijo o palabra de
 *  compuesto conocido (PREFIJOS_CON_GUION), o uno de los prefijos que forman
 *  compuesto delante de vocal (PREFIJOS_ANTE_VOCAL, "anti-" + "inflammatory"):
 *  un compuesto partido justo en su propio guion perdía el guion y quedaba
 *  indexado como "antiinflammatory" o "betaamyloid", términos centrales del
 *  corpus que así no encontraba nadie.
 *
 *  La versión anterior conservaba además el guion con cualquier izquierda de
 *  <= 5 caracteres. Era falso para la maquetación a dos columnas, donde
 *  "sig-"+"nificant", "pa-"+"tients", "cog-"+"nitive", "de-"+"mentia" y
 *  "re-"+"sults" son cortes de maquetador normalísimos y quedaban como
 *  "sig-nificant" o "de-mentia": ahora, fuera de las dos listas, se une sin
 *  guion. El compromiso que queda es el compuesto de izquierda desconocida
 *  ("state-of-the-art" partido en "state-" está en la lista; "web-" + "based"
 *  no) que pierde su guion: la grafía unida sigue siendo buscable por el
 *  vector y el guion de menos no inventa una palabra rara, al revés que
 *  "de-mentia". */
export function unirLineas(anterior: string, linea: string): string {
  if (CORTE_DE_PALABRA.test(anterior) && /^\p{Ll}/u.test(linea)) {
    const izquierda = /(\p{L}+)[-\u2010\u00ad]$/u.exec(anterior);
    const parte = izquierda ? izquierda[1].toLowerCase() : "";
    const conservar =
      PREFIJOS_CON_GUION.has(parte) ||
      (PREFIJOS_ANTE_VOCAL.has(parte) && EMPIEZA_POR_VOCAL.test(linea));
    return conservar ? anterior + linea : anterior.slice(0, -1) + linea;
  }
  if (GUION_FINAL.test(anterior)) return anterior + linea;
  return `${anterior} ${linea}`;
}
