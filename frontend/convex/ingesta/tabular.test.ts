// @vitest-environment node
// XLSX, CSV y texto plano: una fila por chunk con la cabecera detectada,
// detección de delimitador, codificaciones y el saneo de `parsearDocumento`.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parsearDocumento } from "./parsear";
import {
  detectarCabecera,
  detectarDelimitador,
  esFormatoFecha,
  fechaDeSerial,
  leerCsv,
  leerXlsx,
  parsearCsvDocumento,
  parsearXlsx,
} from "./tabular";
import { decodificarBytes, parsearTexto } from "./texto";
import { escribirXlsx } from "./xlsxFalso.test-util";

function fixture(nombre: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${nombre}`, import.meta.url)));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("xlsx", () => {
  test("una fila por chunk, con la cabecera detectada y el número de fila como página", async () => {
    const bytes = await escribirXlsx([
      {
        nombre: "Pacientes",
        filas: [
          ["ID", "Grupo", "Edad", "Fecha visita", "MMSE"],
          ["P001", "Control", 72, { fecha: new Date(Date.UTC(2023, 0, 5)) }, 28.5],
          null,
          [{ inline: "P002" }, "AD", 74, { fecha: new Date(Date.UTC(2023, 1, 10, 14, 30)) }, 21],
        ],
      },
    ]);
    const { chunks, pages } = await parsearXlsx(bytes, "datos.xlsx");
    expect(chunks.map((c) => c.text)).toEqual([
      "ID: P001\nGrupo: Control\nEdad: 72\nFecha visita: 2023-01-05\nMMSE: 28.5",
      "ID: P002\nGrupo: AD\nEdad: 74\nFecha visita: 2023-02-10 14:30:00\nMMSE: 21",
    ]);
    // La fila vacía cuenta en la numeración: el segundo paciente es la fila 4.
    expect(chunks.map((c) => c.page)).toEqual([2, 4]);
    expect(chunks.map((c) => c.sourcePages)).toEqual([[2], [4]]);
    expect(chunks.every((c) => c.chunkType === "table" && c.documentType === "xlsx")).toBe(true);
    expect(chunks[1].metadata).toEqual({ source_row: 4 });
    expect(pages).toBe(2);
  });

  test("con varias hojas cada chunk dice de cuál sale", async () => {
    const bytes = await escribirXlsx([
      { nombre: "Pacientes", filas: [["ID", "Grupo"], ["P001", "Control"]] },
      { nombre: "Notas", filas: [["Criterio", "Valor"], ["Edad mínima", 55]] },
    ]);
    const { chunks } = await parsearXlsx(bytes, "datos.xlsx");
    expect(chunks.map((c) => c.text)).toEqual([
      "Hoja: Pacientes, fila 2\nID: P001\nGrupo: Control",
      "Hoja: Notas, fila 2\nCriterio: Edad mínima\nValor: 55",
    ]);
  });

  test("sin cabecera (primera fila ancha numérica) los campos se numeran por columna", async () => {
    const bytes = await escribirXlsx([{ nombre: "Datos", filas: [[1, 2, 3], [4, 5, 6]] }]);
    const { chunks } = await parsearXlsx(bytes, "datos.xlsx");
    expect(chunks.map((c) => c.text)).toEqual([
      "Columna 1: 1\nColumna 2: 2\nColumna 3: 3",
      "Columna 1: 4\nColumna 2: 5\nColumna 3: 6",
    ]);
  });

  test("booleanos, fórmulas y celdas vacías como openpyxl con data_only", async () => {
    const bytes = await escribirXlsx([
      {
        nombre: "Datos",
        filas: [
          ["Campo", "Valor", "Activo", "Nota"],
          ["Doble", { formula: "B1*2", resultado: 110 }, true, null],
          ["Sin caché", { formula: "B1*3" }, false, { formula: "CONCAT(A1)", resultado: "texto" }],
        ],
      },
    ]);
    const { chunks } = await parsearXlsx(bytes, "datos.xlsx");
    expect(chunks.map((c) => c.text)).toEqual([
      "Campo: Doble\nValor: 110\nActivo: True",
      "Campo: Sin caché\nActivo: False\nNota: texto",
    ]);
  });

  test("formatos de fecha: integrados y personalizados, sin tomar números por fechas", () => {
    expect(esFormatoFecha(14, undefined)).toBe(true);
    expect(esFormatoFecha(22, undefined)).toBe(true);
    expect(esFormatoFecha(0, "General")).toBe(false);
    expect(esFormatoFecha(164, "yyyy-mm-dd")).toBe(true);
    expect(esFormatoFecha(165, "yyyy-mm-dd h:mm:ss")).toBe(true);
    expect(esFormatoFecha(166, "0.00%")).toBe(false);
    expect(esFormatoFecha(167, '#,##0 "meses"')).toBe(false);
    expect(esFormatoFecha(168, "[h]:mm:ss")).toBe(true);
    expect(esFormatoFecha(169, "@")).toBe(false);
    expect(fechaDeSerial(44931)).toBe("2023-01-05");
    expect(fechaDeSerial(44967.60416666666)).toBe("2023-02-10 14:30:00");
    expect(fechaDeSerial(0.5)).toBe("12:00:00");
  });

  test("el fichero real de openpyxl: fechas con estilo propio, fila vacía y hoja que empieza en B2", async () => {
    const hojas = await leerXlsx(fixture("datos.xlsx"));
    expect(hojas.map(([nombre]) => nombre)).toEqual(["Pacientes", "Notas"]);
    const { chunks } = await parsearXlsx(fixture("datos.xlsx"), "datos.xlsx");
    expect(chunks.map((c) => c.text)).toEqual([
      "Hoja: Pacientes, fila 2\nID: P001\nGrupo: Control\nEdad: 72\nFecha visita: 2023-01-05\nMMSE: 28.5",
      "Hoja: Pacientes, fila 3\nID: P002\nGrupo: AD\nEdad: 74\nFecha visita: 2023-02-10 14:30:00\nMMSE: 21",
      "Hoja: Pacientes, fila 5\nID: P003\nGrupo: MCI\nEdad: 71\nFecha visita: 2023-03-01\nMMSE: 26",
      "Hoja: Notas, fila 3\nCriterio: Edad mínima\nValor: 55",
      // La fórmula no tiene resultado cacheado: openpyxl daba None y el campo no sale.
      "Hoja: Notas, fila 4\nCriterio: Fórmula",
    ]);
  });

  test("la cabecera es la primera fila ancha si es textual", () => {
    expect(detectarCabecera([[1, ["ID", "Grupo"]], [2, ["P001", "AD"]]])).toEqual([["ID", "Grupo"], 0]);
    expect(detectarCabecera([[1, ["Titulo", ""]], [2, ["ID", "Grupo"]], [3, ["P001", "AD"]]])).toEqual([["ID", "Grupo"], 1]);
    expect(detectarCabecera([[1, ["1", "2"]], [2, ["3", "4"]]])).toEqual([null, -1]);
    expect(detectarCabecera([[1, ["solo"]], [2, ["una"]]])).toEqual([null, -1]);
  });
});

describe("csv", () => {
  test("el delimitador se detecta por consistencia entre líneas", () => {
    expect(detectarDelimitador("a,b,c\n1,2,3\n4,5,6")).toBe(",");
    expect(detectarDelimitador("a;b;c\n1;2;3")).toBe(";");
    expect(detectarDelimitador("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectarDelimitador("a|b|c\n1|2|3")).toBe("|");
    // Comas dentro del texto de un fichero con punto y coma: gana la consistencia.
    expect(detectarDelimitador("nombre;nota\nAllegri, R.;buena, muy buena\nColome;regular\nGuilbe, J.;mala")).toBe(";");
    // Comas decimales entrecomilladas en un fichero con punto y coma.
    expect(detectarDelimitador('id;valor\n1;"3,4"\n2;"5,6"')).toBe(";");
    // Una sola columna: coma por defecto.
    expect(detectarDelimitador("uno\ndos\ntres")).toBe(",");
  });

  test("comillas, comillas dobladas y saltos dentro de un campo", () => {
    expect(leerCsv('a,"b, con coma","c ""entre"" comillas"\n1,"dos\nlíneas",3\n', ",")).toEqual([
      ["a", "b, con coma", 'c "entre" comillas'],
      ["1", "dos\nlíneas", "3"],
    ]);
    // Una línea en blanco es un registro vacío, para que la numeración coincida.
    expect(leerCsv("a;b\r\n\r\n1;2", ";")).toEqual([["a", "b"], [""], ["1", "2"]]);
  });

  test("un csv con punto y coma da una fila por chunk con la cabecera detectada", () => {
    const { chunks, pages } = parsearCsvDocumento(
      utf8("id;grupo;valor\n1;Control;\"3,4\"\n\n2;AD;5\n"),
      "datos.csv",
    );
    expect(chunks.map((c) => c.text)).toEqual(["id: 1\ngrupo: Control\nvalor: 3,4", "id: 2\ngrupo: AD\nvalor: 5"]);
    // La línea en blanco cuenta: la segunda fila de datos es la 4.
    expect(chunks.map((c) => c.page)).toEqual([2, 4]);
    expect(chunks.every((c) => c.chunkType === "table" && c.documentType === "csv")).toBe(true);
    expect(pages).toBe(2);
  });

  test("bytes en cp1252 se decodifican", () => {
    // "Médico" con la é de Windows-1252 (0xE9), que no es utf-8 válido.
    const bytes = new Uint8Array([0x4d, 0xe9, 0x64, 0x69, 0x63, 0x6f]);
    expect(decodificarBytes(bytes)).toBe("Médico");
    expect(decodificarBytes(utf8("﻿con BOM"))).toBe("con BOM");
    const { chunks } = parsearCsvDocumento(
      new Uint8Array([...utf8("campo,valor\n"), 0x4d, 0xe9, 0x64, 0x69, 0x63, 0x6f, ...utf8(",1\n")]),
      "datos.csv",
    );
    expect(chunks[0].text).toBe("campo: Médico\nvalor: 1");
  });
});

describe("texto plano y saneo general", () => {
  test("txt y md: chunks por párrafos con el índice como página", () => {
    const { chunks, pages } = parsearTexto(utf8("Párrafo uno.\n\nPárrafo dos.\n\n\n\nPárrafo tres."), "notas.txt");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Párrafo uno.\n\nPárrafo dos.\n\nPárrafo tres.");
    expect(chunks[0].page).toBe(1);
    expect(chunks[0].documentType).toBe("txt");
    expect(pages).toBe(1);
    const largo = Array.from({ length: 60 }, (_, i) => `Párrafo ${i} con bastantes palabras para sumar tokens al total.`).join("\n\n");
    const varios = parsearTexto(utf8(largo), "notas.md");
    expect(varios.chunks.length).toBeGreaterThan(1);
    expect(varios.chunks.map((c) => c.page)).toEqual(varios.chunks.map((_, i) => i + 1));
  });

  test("parsearDocumento decide por extensión, detecta el idioma y aplica los topes", async () => {
    const es = await parsearDocumento(
      "notas.TXT",
      utf8(
        "La concentracion de amiloide beta 42 disminuye en las fases mas tempranas de la enfermedad, " +
          "mientras que la proteina tau total y la fosforilada aumentan de forma progresiva con el paso " +
          "de los anos en los pacientes que fueron seguidos durante el estudio en los tres centros.",
      ),
    );
    expect(es.chunks[0].language).toBe("es");
    expect(es.chunks[0].documentType).toBe("txt");
    await expect(parsearDocumento("presentacion.pptx", utf8("x"))).rejects.toThrow("Extensión no soportada");
    await expect(parsearDocumento("vacio.txt", utf8("   \n\n  "))).rejects.toThrow("no contiene texto extraíble");
    await expect(parsearDocumento("malo.pdf", utf8("esto no es un pdf"))).rejects.toThrow();
    const filas = ["id,valor", ...Array.from({ length: 4001 }, (_, i) => `${i},${i}`)].join("\n");
    await expect(parsearDocumento("enorme.csv", utf8(filas))).rejects.toThrow("el máximo permitido es 4000");
  });
});
