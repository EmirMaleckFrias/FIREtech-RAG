// Render de los bloques de una página de Notion a Markdown, para que el texto
// de la página entre en la ingesta como un `.md` más (parsear.ts ya trata
// `.md` como texto con encabezados y listas).
//
// Es una función pura sobre el árbol que devuelve `ClienteNotion.bloquesDePagina`
// (los hijos ya vienen resueltos en `children`), así que se prueba sin red.
//
// Qué se conserva y qué no, y por qué:
// - Encabezados, listas, citas, callouts, código y tablas: son estructura
//   que el troceado y las citas de la respuesta aprovechan (secciones,
//   filas de tabla).
// - Negrita, cursiva y enlaces básicos del texto: cuestan poco y el modelo
//   los lee; subrayado y color no, porque en Markdown no existen.
// - Imágenes: solo su pie de foto. No se descargan: el índice es de texto.
// - `child_page` y `child_database`: el título como enlace, sin recorrer.
//   Son otras páginas; si interesan, están en la base y llegan por su lado.
// - `synced_block`, `toggle`, `column_list`/`column`: se recorren sus hijos,
//   que es donde está el contenido.
import type { BloqueNotion, TextoRico } from "./api";
import { textoPlano } from "./api";

/** Un tramo de texto rico a Markdown en línea. Los espacios de los extremos
 *  quedan fuera de las marcas (`**hola **` no es negrita en Markdown). */
export function textoRicoAMarkdown(rico: TextoRico[] | undefined): string {
  let salida = "";
  for (const t of rico ?? []) {
    const crudo = t.plain_text ?? "";
    if (!crudo) continue;
    const ini = crudo.match(/^\s*/)?.[0] ?? "";
    const fin = crudo.match(/\s*$/)?.[0] ?? "";
    let nucleo = crudo.slice(ini.length, crudo.length - fin.length);
    if (nucleo) {
      const a = t.annotations ?? {};
      if (a.code) nucleo = `\`${nucleo}\``;
      if (a.bold) nucleo = `**${nucleo}**`;
      if (a.italic) nucleo = `*${nucleo}*`;
      if (a.strikethrough) nucleo = `~~${nucleo}~~`;
      // Enlaces y menciones de página llevan `href`; los dos se conservan
      // como enlace, que es lo que el modelo sabe leer.
      if (t.href) nucleo = `[${nucleo}](${t.href})`;
    }
    salida += ini + nucleo + fin;
  }
  return salida;
}

function rico(b: BloqueNotion, tipo: string): string {
  const datos = b[tipo] as { rich_text?: TextoRico[] } | undefined;
  return textoRicoAMarkdown(datos?.rich_text);
}

function sangrar(texto: string, prefijo: string): string {
  return texto
    .split("\n")
    .map((l) => (l ? prefijo + l : l))
    .join("\n");
}

/** Los hijos de un bloque, sangrados bajo él (listas anidadas, contenido de
 *  un toggle o de un callout). */
function hijosSangrados(b: BloqueNotion, prefijo = "  "): string {
  if (!b.children || b.children.length === 0) return "";
  const cuerpo = renderizarBloques(b.children);
  return cuerpo ? "\n" + sangrar(cuerpo, prefijo) : "";
}

function tabla(b: BloqueNotion): string {
  const filas = (b.children ?? [])
    .filter((f) => f.type === "table_row")
    .map((f) => {
      const celdas = ((f.table_row as { cells?: TextoRico[][] } | undefined)?.cells ?? []).map((c) =>
        textoRicoAMarkdown(c).replace(/\|/g, "\\|").replace(/\n/g, " "),
      );
      return celdas;
    });
  if (filas.length === 0) return "";
  const ancho = Math.max(...filas.map((f) => f.length));
  const rellenar = (f: string[]) => [...f, ...new Array<string>(Math.max(0, ancho - f.length)).fill("")];
  const linea = (f: string[]) => `| ${rellenar(f).join(" | ")} |`;
  const conCabecera = Boolean((b.table as { has_column_header?: boolean } | undefined)?.has_column_header);
  // Markdown exige una fila de cabecera. Sin `has_column_header`, la primera
  // fila es datos, así que se pone una cabecera vacía para no perderla.
  const cabecera = conCabecera ? filas[0] : new Array<string>(ancho).fill("");
  const cuerpo = conCabecera ? filas.slice(1) : filas;
  const separador = `| ${new Array<string>(ancho).fill("---").join(" | ")} |`;
  return [linea(cabecera), separador, ...cuerpo.map(linea)].join("\n");
}

function urlDeBloque(b: BloqueNotion, tipo: string): string {
  const datos = b[tipo] as { url?: string; caption?: TextoRico[] } | undefined;
  const url = datos?.url ?? "";
  const pie = textoRicoAMarkdown(datos?.caption);
  if (!url) return pie;
  return pie ? `[${pie}](${url})` : `<${url}>`;
}

/** Un bloque a Markdown (sin la línea en blanco de separación). "" si no
 *  aporta texto. */
function renderizarBloque(b: BloqueNotion, numero: number): string {
  switch (b.type) {
    case "paragraph":
      return rico(b, "paragraph") + hijosSangrados(b, "");
    case "heading_1":
      return `## ${rico(b, "heading_1")}` + hijosSangrados(b, "");
    case "heading_2":
      return `### ${rico(b, "heading_2")}` + hijosSangrados(b, "");
    case "heading_3":
      return `#### ${rico(b, "heading_3")}` + hijosSangrados(b, "");
    case "bulleted_list_item":
      return `- ${rico(b, "bulleted_list_item")}` + hijosSangrados(b);
    case "numbered_list_item":
      return `${numero}. ${rico(b, "numbered_list_item")}` + hijosSangrados(b, "   ");
    case "to_do": {
      const hecho = Boolean((b.to_do as { checked?: boolean } | undefined)?.checked);
      return `- [${hecho ? "x" : " "}] ${rico(b, "to_do")}` + hijosSangrados(b);
    }
    case "toggle":
      return `- ${rico(b, "toggle")}` + hijosSangrados(b);
    case "quote":
      return sangrar(rico(b, "quote") + hijosSangrados(b, ""), "> ");
    case "callout": {
      const icono = (b.callout as { icon?: { emoji?: string } } | undefined)?.icon?.emoji;
      const texto = (icono ? `${icono} ` : "") + rico(b, "callout") + hijosSangrados(b, "");
      return sangrar(texto, "> ");
    }
    case "code": {
      const datos = b.code as { rich_text?: TextoRico[]; language?: string } | undefined;
      const lenguaje = (datos?.language ?? "").replace(/plain text/i, "").trim();
      return `\`\`\`${lenguaje}\n${textoPlano(datos?.rich_text)}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "table":
      return tabla(b);
    case "bookmark":
    case "embed":
    case "link_preview":
      return urlDeBloque(b, b.type);
    case "image": {
      const pie = textoRicoAMarkdown((b.image as { caption?: TextoRico[] } | undefined)?.caption);
      return pie ? `*Imagen: ${pie}*` : "";
    }
    case "child_page": {
      const titulo = (b.child_page as { title?: string } | undefined)?.title ?? "";
      return titulo ? `[${titulo}](https://www.notion.so/${b.id.replace(/-/g, "")})` : "";
    }
    case "child_database": {
      const titulo = (b.child_database as { title?: string } | undefined)?.title ?? "";
      return titulo ? `[${titulo}](https://www.notion.so/${b.id.replace(/-/g, "")})` : "";
    }
    case "synced_block":
    case "column_list":
    case "column":
      return renderizarBloques(b.children ?? []);
    case "table_of_contents":
    case "breadcrumb":
    case "file":
    case "pdf":
    case "video":
    case "audio":
    case "equation":
    case "unsupported":
      // Los ficheros los baja la sincronización por su lado (api.adjuntosDe);
      // el resto no tiene texto que indexar.
      return "";
    default:
      return "";
  }
}

/** Lista de bloques a Markdown. Los elementos de lista consecutivos van
 *  pegados; entre todo lo demás hay una línea en blanco. La numeración de
 *  las listas numeradas se reinicia en cada tanda consecutiva, como en
 *  Notion. */
export function renderizarBloques(bloques: BloqueNotion[]): string {
  const partes: string[] = [];
  let numero = 0;
  let anteriorEraLista = false;
  for (const b of bloques) {
    const esNumerada = b.type === "numbered_list_item";
    const esLista = esNumerada || b.type === "bulleted_list_item" || b.type === "to_do" || b.type === "toggle";
    numero = esNumerada ? numero + 1 : 0;
    const texto = renderizarBloque(b, numero);
    if (!texto.trim()) {
      anteriorEraLista = false;
      continue;
    }
    if (partes.length > 0) partes.push(esLista && anteriorEraLista ? "\n" : "\n\n");
    partes.push(texto);
    anteriorEraLista = esLista;
  }
  return partes.join("");
}

/** La página entera: el título como `# ` y el cuerpo debajo. */
export function renderizarPagina(titulo: string, bloques: BloqueNotion[]): string {
  const cuerpo = renderizarBloques(bloques);
  const cabecera = titulo.trim() ? `# ${titulo.trim()}` : "";
  return [cabecera, cuerpo].filter(Boolean).join("\n\n") + "\n";
}

/** Caracteres de texto útil del cuerpo: sin el título, sin la sintaxis de
 *  Markdown y con los espacios colapsados. Es lo que decide si la página
 *  merece un documento propio: una ficha con solo el título y dos palabras no
 *  aporta nada al índice y sí ruido a las búsquedas. */
export function textoUtil(markdown: string): number {
  const sinTitulo = markdown.replace(/^# .*\n?/, "");
  const limpio = sinTitulo
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ""))
    .replace(/[#>*_`~|\-]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return limpio.length;
}
