import { describe, expect, test } from 'vitest';
import {
  MAX_ARCHIVOS_POR_TANDA,
  desdeDrop,
  desdeInputDeCarpeta,
  nombreLibre,
  planificar,
  prefijoDeCarpeta,
  recorrer,
  resumenDeTanda,
  sanear,
  textoDeMotivo,
  type ArchivoConRuta,
  type EntradaFs,
} from './carpetas';

// ---------------------------------------------------------------------------
// Fakes de la API de entradas del navegador
// ---------------------------------------------------------------------------
function fichero(nombre: string, contenido = 'x'): EntradaFs {
  const f = new File([contenido], nombre);
  return { isFile: true, isDirectory: false, name: nombre, file: (ok) => ok(f) };
}

/** Un directorio cuyo lector entrega los hijos en lotes de `porLote`, como
 *  hace Chrome (100), y un array vacío al acabar. */
function carpeta(nombre: string, hijos: EntradaFs[], porLote = 100): EntradaFs {
  return {
    isFile: false,
    isDirectory: true,
    name: nombre,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok) => {
          const lote = hijos.slice(i, i + porLote);
          i += porLote;
          ok(lote);
        },
      };
    },
  };
}

const con = (a: ArchivoConRuta[]) => a.map((x) => `${x.carpeta}|${x.file.name}`);

async function conHash(archivos: ArchivoConRuta[], hash: (nombre: string) => string) {
  return archivos.map((a) => ({ ...a, sha256: hash(a.file.name) }));
}

// ---------------------------------------------------------------------------
describe('recorrer una carpeta', () => {
  test('lee TODOS los lotes de readEntries, no solo el primero', async () => {
    // 237 ficheros en lotes de 100: una sola llamada a readEntries habría
    // devuelto 100 y perdido 137 en silencio. Es el error más repetido de
    // esta API, y con carpetas pequeñas no se nota.
    const hijos = Array.from({ length: 237 }, (_, i) => fichero(`f${String(i).padStart(3, '0')}.pdf`));
    const r = await recorrer(carpeta('Docs', hijos));
    expect(r.archivos).toHaveLength(237);
    expect(r.truncado).toBe(false);
  });

  test('recorre subcarpetas y guarda la ruta relativa de cada fichero', async () => {
    const raiz = carpeta('Docs', [
      fichero('guia.pdf'),
      carpeta('2024', [fichero('protocolo.docx'), carpeta('borradores', [fichero('v1.md')])]),
      carpeta('vacia', []),
    ]);
    const r = await recorrer(raiz);
    expect(con(r.archivos).sort()).toEqual([
      'Docs/2024/borradores|v1.md',
      'Docs/2024|protocolo.docx',
      'Docs|guia.pdf',
    ]);
  });

  test('el orden es estable (por nombre): dos subidas de la misma carpeta renombran igual', async () => {
    const desordenado = carpeta('D', [fichero('c.pdf'), fichero('a.pdf'), fichero('b.pdf')]);
    const r = await recorrer(desordenado);
    expect(r.archivos.map((a) => a.file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  test('se detiene en el tope y lo dice, en vez de dejar la pestaña ocupada', async () => {
    const hijos = Array.from({ length: MAX_ARCHIVOS_POR_TANDA + 50 }, (_, i) => fichero(`f${i}.pdf`));
    const r = await recorrer(carpeta('Enorme', hijos));
    expect(r.truncado).toBe(true);
    expect(r.archivos.length).toBe(MAX_ARCHIVOS_POR_TANDA);
  });

  test('un fichero suelto no lleva carpeta', async () => {
    const r = await recorrer(fichero('suelto.pdf'));
    expect(con(r.archivos)).toEqual(['|suelto.pdf']);
  });
});

describe('desdeDrop y desdeInputDeCarpeta', () => {
  test('sin webkitGetAsEntry cae a la lista plana de files', async () => {
    const f = new File(['x'], 'a.pdf');
    const r = await desdeDrop({ items: [] as unknown as DataTransferItemList, files: [f] as unknown as FileList });
    expect(con(r.archivos)).toEqual(['|a.pdf']);
  });

  test('con entradas recorre carpetas y ficheros sueltos a la vez', async () => {
    const items = [
      { kind: 'file', webkitGetAsEntry: () => carpeta('D', [fichero('x.pdf')]) },
      { kind: 'file', webkitGetAsEntry: () => fichero('suelto.md') },
      { kind: 'string', webkitGetAsEntry: () => null },
    ] as unknown as DataTransferItemList;
    const r = await desdeDrop({ items, files: [] as unknown as FileList });
    expect(con(r.archivos).sort()).toEqual(['D|x.pdf', '|suelto.md']);
  });

  test('del input de carpeta, la ruta sale de webkitRelativePath', () => {
    const f = new File(['x'], 'g.pdf');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'Docs/2024/g.pdf' });
    const s = new File(['x'], 'suelto.pdf');
    expect(con(desdeInputDeCarpeta([f, s]).archivos)).toEqual(['Docs/2024|g.pdf', '|suelto.pdf']);
  });

  test('ADVERSARIAL: el input de carpeta aplica el MISMO tope que el arrastre y lo dice', () => {
    // El botón "Elegir una carpeta entera" es el camino destacado, y era el
    // único sin tope: una carpeta de 3000 ficheros se hasheaba y subía entera.
    const files = Array.from({ length: MAX_ARCHIVOS_POR_TANDA + 7 }, (_, i) => new File(['x'], `f${i}.pdf`));
    const r = desdeInputDeCarpeta(files);
    expect(r.archivos).toHaveLength(MAX_ARCHIVOS_POR_TANDA);
    expect(r.truncado).toBe(true);
    expect(desdeInputDeCarpeta(files.slice(0, 3)).truncado).toBe(false);
  });
});

describe('ficheros que no se pueden leer del disco', () => {
  test('ADVERSARIAL: un fichero ilegible no tumba la tanda: se apunta como omitido y los demás siguen', async () => {
    const roto: EntradaFs = {
      name: 'nube.pdf',
      isFile: true,
      isDirectory: false,
      file: (_ok, error) => error(new Error('NotFoundError: placeholder de la nube')),
    };
    const r = await recorrer(carpeta('Docs', [fichero('a.pdf'), roto, fichero('z.pdf')]));
    expect(con(r.archivos)).toEqual(['Docs|a.pdf', 'Docs|z.pdf']);
    expect(r.ilegibles).toEqual([{ nombre: 'nube.pdf', carpeta: 'Docs', motivo: 'ilegible' }]);
    // Y llegan al resumen de la tanda por `planificar`.
    const plan = planificar([], [], 100, r.ilegibles);
    expect(plan.omitidos).toEqual(r.ilegibles);
    expect(textoDeMotivo('ilegible', 100)).toMatch(/no se pudo leer/);
  });

  test('una subcarpeta cuyo listado falla se apunta y no rompe el resto', async () => {
    const rota: EntradaFs = {
      name: 'privada',
      isFile: false,
      isDirectory: true,
      createReader: () => ({ readEntries: (_ok, error) => error(new Error('permiso denegado')) }),
    };
    const r = await recorrer(carpeta('Docs', [fichero('a.pdf'), rota]));
    expect(con(r.archivos)).toEqual(['Docs|a.pdf']);
    expect(r.ilegibles.map((i) => i.nombre)).toEqual(['privada']);
  });
});

// ---------------------------------------------------------------------------
describe('nombres', () => {
  test('sanear coincide con el servidor: quita rutas, caracteres raros y puntos iniciales', () => {
    expect(sanear('a/b/Guía clínica (v2).pdf')).toBe('Gu_a_cl_nica__v2_.pdf');
    expect(sanear('..oculto.pdf')).toBe('oculto.pdf');
    expect(sanear('C:\\Users\\x\\y.pdf')).toBe('y.pdf');
  });

  test('prefijoDeCarpeta aplana la ruta', () => {
    expect(prefijoDeCarpeta('Docs/2024/Protocolos v2')).toBe('Docs-2024-Protocolos_v2');
    expect(prefijoDeCarpeta('')).toBe('');
    expect(prefijoDeCarpeta('/./')).toBe('');
  });

  test('nombreLibre: original, luego con carpeta, luego numerado; nunca repite', () => {
    const ocupados = new Set<string>();
    expect(nombreLibre('guia.pdf', 'Docs', ocupados)).toBe('guia.pdf');
    expect(nombreLibre('guia.pdf', 'Docs', ocupados)).toBe('Docs-guia.pdf');
    expect(nombreLibre('guia.pdf', 'Docs', ocupados)).toBe('Docs-2-guia.pdf');
    expect(nombreLibre('guia.pdf', 'Docs', ocupados)).toBe('Docs-3-guia.pdf');
    expect(ocupados.size).toBe(4);
  });

  test('sin carpeta el prefijo es "copia", para que no salga "-guia.pdf"', () => {
    const ocupados = new Set(['guia.pdf']);
    expect(nombreLibre('guia.pdf', '', ocupados)).toBe('copia-guia.pdf');
  });
});

// ---------------------------------------------------------------------------
describe('planificar', () => {
  const existentes = [
    { fileName: 'guia.pdf', sha256: 'hash-guia' },
    { fileName: 'viejo.pdf', sha256: null },
  ];

  test('omite ocultos, formatos, vacíos y grandes, cada uno con su motivo, y sigue con el resto', async () => {
    const archivos = await conHash(
      [
        { file: new File(['x'], '.DS_Store'), carpeta: 'D' },
        { file: new File(['x'], 'diapos.pptx'), carpeta: 'D' },
        { file: new File([], 'vacio.pdf'), carpeta: 'D' },
        { file: new File([new Uint8Array(2 * 1024 * 1024)], 'gordo.pdf'), carpeta: 'D' },
        { file: new File(['x'], 'bien.pdf'), carpeta: 'D' },
      ],
      (n) => `h-${n}`,
    );
    const plan = planificar(archivos, [], 1);
    expect(plan.aSubir.map((a) => a.nombre)).toEqual(['bien.pdf']);
    expect(plan.omitidos.map((o) => `${o.nombre}:${o.motivo}`)).toEqual([
      '.DS_Store:oculto',
      'diapos.pptx:formato',
      'vacio.pdf:vacio',
      'gordo.pdf:demasiado_grande',
    ]);
  });

  test('el MISMO contenido no se sube dos veces, venga con el nombre que venga', async () => {
    const archivos = await conHash(
      [
        // Mismo hash que 'guia.pdf' del corpus, pero otro nombre: ya estaba.
        { file: new File(['x'], 'guia-copia.pdf'), carpeta: 'D' },
        // Dos dentro de la misma carpeta con el mismo contenido: la segunda sobra.
        { file: new File(['x'], 'a.pdf'), carpeta: 'D' },
        { file: new File(['x'], 'b.pdf'), carpeta: 'D/sub' },
      ],
      (n) => (n === 'guia-copia.pdf' ? 'hash-guia' : 'hash-mismo'),
    );
    const plan = planificar(archivos, existentes, 100);
    expect(plan.aSubir.map((a) => a.nombre)).toEqual(['a.pdf']);
    expect(plan.omitidos.map((o) => `${o.nombre}:${o.motivo}`)).toEqual([
      'guia-copia.pdf:ya_estaba',
      'b.pdf:ya_estaba',
    ]);
  });

  test('el MISMO nombre con OTRO contenido no se omite: se renombra con su carpeta', async () => {
    const archivos = await conHash(
      [
        { file: new File(['x'], 'guia.pdf'), carpeta: 'Protocolos' }, // choca con el corpus
        { file: new File(['x'], 'nota.md'), carpeta: 'A' },
        { file: new File(['x'], 'nota.md'), carpeta: 'B' }, // choca con el de A
        { file: new File(['x'], 'nota.md'), carpeta: 'B' }, // choca con los dos anteriores
      ],
      (n) => `h-${Math.random()}-${n}`,
    );
    const plan = planificar(archivos, existentes, 100);
    expect(plan.omitidos).toEqual([]);
    expect(plan.aSubir.map((a) => a.nombre)).toEqual([
      'Protocolos-guia.pdf',
      'nota.md',
      'B-nota.md',
      'B-2-nota.md',
    ]);
    // Y se recuerda de dónde venía, para poder contarlo.
    expect(plan.aSubir[0].renombradoDesde).toBe('guia.pdf');
    expect(plan.aSubir[1].renombradoDesde).toBeUndefined();
  });

  test('un documento del corpus SIN sha256 (anterior al campo) solo bloquea por nombre', async () => {
    const archivos = await conHash([{ file: new File(['x'], 'viejo.pdf'), carpeta: 'D' }], () => 'nuevo');
    const plan = planificar(archivos, existentes, 100);
    expect(plan.aSubir.map((a) => a.nombre)).toEqual(['D-viejo.pdf']);
  });

  test('la comparación de nombres es tras sanear, como hará el servidor', async () => {
    // "Guía (v2).pdf" se guarda como "Gu_a__v2_.pdf": si ese ya está, choca.
    const archivos = await conHash([{ file: new File(['x'], 'Guía (v2).pdf'), carpeta: 'D' }], () => 'n');
    const plan = planificar(archivos, [{ fileName: 'Gu_a__v2_.pdf', sha256: 'otro' }], 100);
    expect(plan.aSubir[0].nombre).toBe('D-Gu_a__v2_.pdf');
  });
});

describe('resumenDeTanda', () => {
  test('cuenta por motivo, en singular y plural', () => {
    expect(resumenDeTanda(38, 0, [])).toBe('38 archivos subidos');
    expect(
      resumenDeTanda(1, 1, [
        { nombre: 'a', carpeta: '', motivo: 'ya_estaba' },
        { nombre: 'b', carpeta: '', motivo: 'ya_estaba' },
        { nombre: 'c', carpeta: '', motivo: 'formato' },
        { nombre: 'd', carpeta: '', motivo: 'oculto' },
      ]),
    ).toBe('1 archivo subido · 1 falló · 2 ya estaban · 1 formato no admitido · 1 archivo oculto');
  });
});
