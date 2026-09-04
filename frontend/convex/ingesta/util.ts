// Utilidades de texto compartidas por las reglas de PDF y de artículo. Son los
// equivalentes de `str.strip(chars)`, `str.isupper()` e `str.islower()` de
// Python, que las reglas portadas usan a cada paso.

/** Quita de ambos extremos cualquier carácter de `chars` (como `str.strip(chars)`). */
export function recortar(texto: string, chars: string): string {
  let inicio = 0;
  let fin = texto.length;
  while (inicio < fin && chars.includes(texto[inicio])) inicio++;
  while (fin > inicio && chars.includes(texto[fin - 1])) fin--;
  return texto.slice(inicio, fin);
}

/** `str.isupper()` de un solo carácter: letra con mayúscula y minúscula
 *  distintas, en su forma alta. Un dígito da false, como en Python. */
export function esMayuscula(c: string): boolean {
  return c !== "" && c === c.toUpperCase() && c !== c.toLowerCase();
}

/** `str.islower()`: hay letras con caja y todas están en minúscula. */
export function esMinusculas(texto: string): boolean {
  return texto !== texto.toUpperCase() && texto === texto.toLowerCase();
}

/** Primer carácter con contenido (letra o dígito), saltando comillas y
 *  paréntesis de apertura. Es el `re.search(r"[^\W_]", ...)` de Python. */
export function primerAlfanumerico(texto: string): string | null {
  const m = /[\p{L}\p{N}]/u.exec(texto);
  return m ? m[0] : null;
}
