// El render de bloques de Notion a Markdown, sobre árboles construidos a mano
// con la forma que devuelve la API (`type`, `<type>.rich_text`, `children`).
import { describe, expect, test } from "vitest";
import type { BloqueNotion, TextoRico } from "./api";
import { adjuntosDe, estaExcluida, idConGuiones, normalizarId, tituloDe, type PaginaNotion } from "./api";
import { renderizarBloques, renderizarPagina, textoRicoAMarkdown, textoUtil } from "./markdown";

function t(texto: string, extra: Partial<TextoRico> = {}): TextoRico {
  return { type: "text", plain_text: texto, href: null, ...extra };
}

let n = 0;
function bloque(type: string, datos: Record<string, unknown> = {}, children?: BloqueNotion[]): BloqueNotion {
  n += 1;
  return { id: `bloque-${n}`, type, has_children: Boolean(children), children, [type]: datos };
}

function parrafo(texto: string, children?: BloqueNotion[]) {
  return bloque("paragraph", { rich_text: [t(texto)] }, children);
}

describe("texto rico", () => {
  test("negrita, cursiva, código y enlaces básicos, sin marcas alrededor de los espacios", () => {
    const md = textoRicoAMarkdown([
      t("Hola "),
      t("mundo ", { annotations: { bold: true } }),
      t("en cursiva", { annotations: { italic: true } }),
      t(" y "),
      t("código", { annotations: { code: true } }),
      t(" con "),
      t("enlace", { href: "https://ejemplo.org" }),
    ]);
    expect(md).toBe("Hola **mundo** *en cursiva* y `código` con [enlace](https://ejemplo.org)");
  });
});

describe("bloques", () => {
  test("encabezados, listas, cita, código, divisor y enlaces", () => {
    const md = renderizarBloques([
      bloque("heading_1", { rich_text: [t("Método")] }),
      parrafo("Primer párrafo."),
      bloque("heading_2", { rich_text: [t("Pasos")] }),
      bloque("numbered_list_item", { rich_text: [t("uno")] }),
      bloque("numbered_list_item", { rich_text: [t("dos")] }, [
        bloque("bulleted_list_item", { rich_text: [t("anidado")] }),
      ]),
      bloque("bulleted_list_item", { rich_text: [t("viñeta")] }),
      bloque("to_do", { rich_text: [t("hecho")], checked: true }),
      bloque("to_do", { rich_text: [t("pendiente")], checked: false }),
      bloque("quote", { rich_text: [t("una cita")] }),
      bloque("callout", { rich_text: [t("ojo")], icon: { emoji: "!" } }),
      bloque("code", { rich_text: [t("print(1)")], language: "python" }),
      bloque("divider"),
      bloque("bookmark", { url: "https://a.b/c", caption: [] }),
      bloque("image", { caption: [t("figura 1")] }),
      bloque("child_page", { title: "Otra página" }),
    ]);
    expect(md).toBe(
      [
        "## Método",
        "",
        "Primer párrafo.",
        "",
        "### Pasos",
        "",
        "1. uno",
        "2. dos",
        "   - anidado",
        "- viñeta",
        "- [x] hecho",
        "- [ ] pendiente",
        "",
        "> una cita",
        "",
        "> ! ojo",
        "",
        "```python",
        "print(1)",
        "```",
        "",
        "---",
        "",
        "<https://a.b/c>",
        "",
        "*Imagen: figura 1*",
        "",
        // Los ids de Notion van sin guiones en la URL.
        "[Otra página](https://www.notion.so/bloque" + String(n) + ")",
      ].join("\n"),
    );
  });

  test("la numeración se reinicia tras un bloque que no es de lista", () => {
    const md = renderizarBloques([
      bloque("numbered_list_item", { rich_text: [t("a")] }),
      bloque("numbered_list_item", { rich_text: [t("b")] }),
      parrafo("corte"),
      bloque("numbered_list_item", { rich_text: [t("c")] }),
    ]);
    expect(md).toBe("1. a\n2. b\n\ncorte\n\n1. c");
  });

  test("tabla con cabecera y sin ella; las barras de las celdas se escapan", () => {
    const fila = (...celdas: string[]) =>
      bloque("table_row", { cells: celdas.map((c) => [t(c)]) });
    const con = renderizarBloques([
      bloque("table", { has_column_header: true, table_width: 2 }, [fila("Marcador", "Valor"), fila("p-tau|217", "0,94")]),
    ]);
    expect(con).toBe("| Marcador | Valor |\n| --- | --- |\n| p-tau\\|217 | 0,94 |");
    const sin = renderizarBloques([bloque("table", { has_column_header: false }, [fila("a", "b")])]);
    expect(sin).toBe("|  |  |\n| --- | --- |\n| a | b |");
  });

  test("toggle, synced_block y columnas: se baja a los hijos", () => {
    const md = renderizarBloques([
      bloque("toggle", { rich_text: [t("Detalles")] }, [parrafo("dentro del toggle")]),
      bloque("synced_block", {}, [parrafo("sincronizado")]),
      bloque("column_list", {}, [bloque("column", {}, [parrafo("en columna")])]),
    ]);
    expect(md).toBe("- Detalles\n  dentro del toggle\n\nsincronizado\n\nen columna");
  });

  test("bloques sin texto (file, pdf, vídeo, desconocidos) no dejan líneas vacías", () => {
    const md = renderizarBloques([
      bloque("file", { name: "x.pdf", file: { url: "https://s3/x.pdf" } }),
      bloque("pdf", { caption: [], file: { url: "https://s3/y.pdf" } }),
      bloque("video", {}),
      bloque("tipo_futuro", {}),
      parrafo("solo esto"),
    ]);
    expect(md).toBe("solo esto");
  });
});

describe("página", () => {
  test("el título va como `# ` y el texto útil no cuenta el título ni la sintaxis", () => {
    const md = renderizarPagina("Guía", [bloque("heading_1", { rich_text: [t("Uno")] }), parrafo("texto")]);
    expect(md).toBe("# Guía\n\n## Uno\n\ntexto\n");
    expect(textoUtil(md)).toBe("Uno texto".length);
    expect(textoUtil("# Solo título\n")).toBe(0);
  });
});

describe("propiedades y adjuntos", () => {
  const pagina = (props: Record<string, unknown>): PaginaNotion =>
    ({ id: "p", last_edited_time: "2026-01-01T00:00:00.000Z", properties: props }) as PaginaNotion;

  test("título: la propiedad de tipo title, se llame como se llame", () => {
    expect(tituloDe(pagina({ Nombre: { type: "title", title: [t("Mi "), t("guía")] } }))).toBe("Mi guía");
    expect(tituloDe(pagina({}))).toBe("");
  });

  test("exclusión: cualquier select/status con valor Excluir/Exclude, se llame como se llame", () => {
    expect(estaExcluida(pagina({ Estado: { type: "select", select: { name: "Excluir" } } }))).toBe(true);
    expect(estaExcluida(pagina({ Status: { type: "status", status: { name: "exclude" } } }))).toBe(true);
    expect(estaExcluida(pagina({ Fase: { type: "select", select: { name: " EXCLUIR " } } }))).toBe(true);
    expect(estaExcluida(pagina({ Estado: { type: "select", select: { name: "Publicado" } } }))).toBe(false);
    // Solo el valor exacto: "Excluir del informe" o un texto libre no cuentan.
    expect(estaExcluida(pagina({ Estado: { type: "select", select: { name: "Excluir del informe" } } }))).toBe(false);
    expect(estaExcluida(pagina({ Nota: { type: "rich_text", rich_text: [t("Excluir")] } }))).toBe(false);
    expect(estaExcluida(pagina({}))).toBe(false);
  });

  test("adjuntos: propiedad files más bloques file/pdf anidados, sin duplicar por URL", () => {
    const p = pagina({
      Adjuntos: {
        type: "files",
        files: [
          { name: "guia.pdf", type: "file", file: { url: "https://s3/guia.pdf?X-Amz=1" } },
          { name: "externo.xlsx", type: "external", external: { url: "https://otro/externo.xlsx" } },
        ],
      },
    });
    const bloques = [
      bloque("toggle", { rich_text: [] }, [
        bloque("file", { name: "guia.pdf", file: { url: "https://s3/guia.pdf?X-Amz=2" } }),
        // Caption sin extensión: el nombre sale de la URL.
        bloque("pdf", { caption: [t("Anexo 2")], file: { url: "https://s3/anexo.pdf?X=1" } }),
        // Ni caption ni URL con extensión: un bloque pdf es un .pdf.
        bloque("pdf", { caption: [t("Anexo 3")], file: { url: "https://s3/f/abc123" } }),
        bloque("pdf", { caption: [], file: { url: "https://s3/carpeta/sin%20nombre.pdf?x=1" } }),
      ]),
    ];
    expect(adjuntosDe(p, bloques).map((a) => a.nombre)).toEqual([
      "guia.pdf",
      "externo.xlsx",
      "anexo.pdf",
      "Anexo_3.pdf",
      "sin_nombre.pdf",
    ]);
  });

  test("normalizarId acepta con guiones, sin guiones y la URL pegada", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(normalizarId(id)).toBe(id);
    expect(normalizarId("01234567-89ab-cdef-0123-456789abcdef")).toBe(id);
    expect(normalizarId(`https://www.notion.so/equipo/Corpus-${id}?v=deadbeefdeadbeefdeadbeefdeadbeef`)).toBe(id);
  });

  test("la URL real de la base del proyecto: el id es el del path, no la vista de `?v=`", () => {
    const url =
      "https://app.notion.com/p/alzheimersproject/335a4d85fda0809fa768f42762f885bb?v=335a4d85fda080b2b85c000c6e7d8c63";
    expect(normalizarId(url)).toBe("335a4d85fda0809fa768f42762f885bb");
    expect(idConGuiones(url)).toBe("335a4d85-fda0-809f-a768-f42762f885bb");
    expect(idConGuiones("335a4d85-fda0-809f-a768-f42762f885bb")).toBe("335a4d85-fda0-809f-a768-f42762f885bb");
  });
});
