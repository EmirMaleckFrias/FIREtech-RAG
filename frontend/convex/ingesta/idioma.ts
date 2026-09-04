// Detección de idioma por palabras funcionales, sin dependencias ni modelo.
// Port de `backend/app/ingest/idioma.py`.
//
// Existe porque un filtro que se ofrece y nunca se rellena es peor que no
// ofrecerlo: el modelo lo usa de buena fe, el filtro exacto no casa con nada y
// la respuesta acaba siendo un "no encuentro ese documento" con toda la
// confianza del mundo. Medido en producción el 2 sep 2026: cuatro búsquedas
// seguidas con `idioma: es` e `idioma: en` devolvieron 0 resultados sobre una
// colección que tenía el documento pedido, porque `language` estaba vacío en
// todos los puntos.
//
// El método es el clásico de proporción de palabras funcionales. Es sobrado
// para distinguir los idiomas de un corpus científico y no acierta siempre:
// ante la duda devuelve cadena vacía, que significa "no lo sé", nunca una
// adivinanza.

function conjunto(palabras: string): Set<string> {
  return new Set(palabras.split(/\s+/).filter(Boolean));
}

// Palabras funcionales frecuentes y, en lo posible, discriminantes. Se
// comparan sin acentos, así que "también" entra como "tambien".
const FUNCIONALES: Array<[string, Set<string>]> = [
  [
    "es",
    conjunto(`
      el la los las un una unos unas de del al y o pero si no que con para por
      como mas muy sin sobre entre cuando donde porque este esta estos estas
      ese esa eso su sus nuestro nuestra tambien fue fueron ser es son era
      han hay habia se le les lo mismo cada tras desde hasta segun ademas
    `),
  ],
  [
    "en",
    conjunto(`
      the a an of in on at to for from by with and or but if not that this
      these those which who whom whose was were is are be been being has have
      had it its as than then there their we you he she they them our
      about between during after before while however therefore thus also
    `),
  ],
  [
    "pt",
    conjunto(`
      o a os as um uma uns umas de do da dos das no na nos nas e ou mas se
      nao que com para por como mais muito sem sobre entre quando onde porque
      este esta esse essa isso seu seus nosso nossa tambem foi foram ser sao
      era tem ha havia depois antes porem portanto assim ainda ja
    `),
  ],
  [
    "fr",
    conjunto(`
      le la les un une des du de au aux et ou mais si ne pas que qui quoi
      dont avec pour par comme plus tres sans sur entre quand ou parce ce
      cette ces son ses notre nos aussi etait etaient etre est sont ont avait
      il elle ils elles nous vous cependant donc ainsi encore deja
    `),
  ],
];

/** Mínimo de palabras para que la proporción signifique algo. */
const MINIMO_PALABRAS = 25;
/** La lengua ganadora tiene que llevar al menos esta proporción de funcionales. */
const MINIMA_PROPORCION = 0.04;
/** Y superar a la siguiente por este margen, o queda como no determinado. */
const MARGEN = 1.25;

const PALABRA = /[a-zA-ZÀ-ɏ]+/g;

/** Quita los diacríticos: "también" -> "tambien". */
export function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Código de dos letras del idioma, o cadena vacía si no está claro.
 *
 *  Cadena vacía es una respuesta legítima: es mejor no etiquetar que etiquetar
 *  mal, porque la etiqueta se convierte en un filtro exacto. */
export function detectarIdioma(texto: string): string {
  if (!texto) return "";
  const palabras = (sinAcentos(texto).match(PALABRA) ?? []).map((p) => p.toLowerCase());
  if (palabras.length < MINIMO_PALABRAS) return "";

  const total = palabras.length;
  const puntajes: Array<[number, string]> = FUNCIONALES.map(([codigo, funcionales]) => {
    let aciertos = 0;
    for (const p of palabras) if (funcionales.has(p)) aciertos++;
    return [aciertos / total, codigo];
  });
  puntajes.sort((a, b) => b[0] - a[0]);

  const [mejor, codigo] = puntajes[0];
  const segundo = puntajes.length > 1 ? puntajes[1][0] : 0;
  if (mejor < MINIMA_PROPORCION) return "";
  if (segundo > 0 && mejor < segundo * MARGEN) return "";
  return codigo;
}
