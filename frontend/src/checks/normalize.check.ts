// Comprobacion ejecutable de los normalizadores y de la reconstruccion de
// cobertura, contra payloads VIEJOS (sin plan, hops solo con n y query,
// verificacion sin cobertura) y NUEVOS (contrato F y columnas de Convex).
// Se empaqueta con esbuild y se corre con node, sin depender de vitest:
//
//   cd frontend && node_modules/.bin/esbuild src/checks/normalize.check.ts \
//     --bundle --platform=node --format=esm --outfile=/tmp/x/normalize.check.mjs \
//     && node /tmp/x/normalize.check.mjs
//
// El fichero cuelga de src/ para que `tsc` lo tipe en cada build; como solo
// importa modulos puros (lib/normalize, lib/cobertura) no arrastra el cliente
// de Convex ni React. Los mismos casos, y los del resto de lib/, viven
// tambien como tests de vitest (src/lib/*.test.ts).
//
// Las aserciones son adversariales a proposito: lo que se comprueba es que un
// campo ausente NO se convierta en una afirmacion (grado "directa" inventado,
// un punto "cubierto" sin que el verificador lo dijera, una fila para e0).

import { coberturaDesdeHops, filasCobertura, puntosNoUsados } from '../lib/cobertura';
import {
  normalizeHop,
  normalizeHops,
  normalizePlan,
  normalizeSources,
  normalizeVerificacion,
} from '../lib/normalize';

// Sin `process`: tsconfig solo carga los tipos de vite/client y package.json
// no es de este frente. Los fallos se acumulan y al final se lanzan como un
// Error, que en node termina el proceso con codigo distinto de cero.
const fallos: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) fallos.push(`FALLO: ${msg}`);
}
function eq(a: unknown, b: unknown, msg: string): void {
  check(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);
}

/* ---------------- verificacion: payload viejo (sin cobertura) ---------------- */
const viejo = normalizeVerificacion({
  afirmaciones: [{ texto: 't', cita: 'c', veredicto: 'sostenida', motivo: '', fragmento_id: 'f1' }],
  evidencia_sin_cubrir: [],
  citas_sin_resolver: [],
  fidelidad: 1,
  ok: true,
  nota: '',
});
check(viejo !== null, 'verificacion vieja debe normalizarse');
eq(viejo?.cobertura, [], 'verificacion vieja: cobertura por defecto []');
eq(puntosNoUsados(viejo?.cobertura ?? []), 0, 'sin cobertura no hay puntos no usados');

/* ---------------- verificacion: payload nuevo ---------------- */
const nuevo = normalizeVerificacion({
  afirmaciones: [],
  evidencia_sin_cubrir: ['e2'],
  citas_sin_resolver: [],
  fidelidad: null,
  ok: true,
  nota: '',
  cobertura: [
    { id: 'e1', evidence_needed: 'dosis', estado: 'cubierto', n_fragmentos: 3, documentos: ['A et al., 2020'], afirmaciones: [0] },
    { id: 'e2', evidence_needed: 'efectos adversos', estado: 'evidencia_no_usada', n_fragmentos: 2, documentos: ['B et al., 2021'], afirmaciones: [] },
    { id: 'e3', evidence_needed: 'mortalidad', estado: 'sin_resultados', n_fragmentos: 0, documentos: [], afirmaciones: [] },
    // Fuera del contrato: un estado inventado y una fila sin id se descartan.
    { id: 'e4', evidence_needed: 'x', estado: 'aprobado', n_fragmentos: 1, documentos: [], afirmaciones: [] },
    { evidence_needed: 'sin id', estado: 'cubierto', n_fragmentos: 1, documentos: [], afirmaciones: [] },
    // Tipos sucios: n_fragmentos como string, documentos con no-strings.
    { id: 'e5', evidence_needed: 'y', estado: 'parcial', n_fragmentos: '2', documentos: ['C', 7, null], afirmaciones: ['0', 1] },
  ],
});
check(nuevo !== null, 'verificacion nueva debe normalizarse');
eq(nuevo?.cobertura.map((c) => c.id), ['e1', 'e2', 'e3', 'e5'], 'cobertura: descarta estado desconocido y fila sin id');
eq(nuevo?.cobertura[3], { id: 'e5', evidence_needed: 'y', estado: 'parcial', n_fragmentos: 0, documentos: ['C'], afirmaciones: [1] }, 'cobertura: tipos sucios a valores neutros');
eq(puntosNoUsados(nuevo?.cobertura ?? []), 1, 'un punto con evidencia_no_usada');
// e0 con evidencia_no_usada no cuenta: es la pregunta entera, no un punto.
eq(puntosNoUsados([{ id: 'e0', evidence_needed: '', estado: 'evidencia_no_usada', n_fragmentos: 1, documentos: [], afirmaciones: [] }]), 0, 'e0 no cuenta como punto no usado');

/* ---------------- hops: viejo y nuevo ---------------- */
eq(normalizeHop({ n: 1, query: 'q' }), { n: 1, query: 'q' }, 'hop viejo: exactamente {n, query}, sin claves nuevas');
eq(normalizeHops(null), [], 'hops null (jsonb sin columna) -> []');
eq(normalizeHops([{ n: 1, query: 'a' }, 'basura', null, { n: 2, query: 'b' }]), [{ n: 1, query: 'a' }, { n: 2, query: 'b' }], 'hops: se saltan los que no son objeto');
const hopNuevo = normalizeHop({
  n: 1, query: 'dosis de lecanemab', origen: 'plan', plan_item: 'e1', evidence_needed: 'dosis',
  resultados: 7, documentos: ['A et al., 2020'], estado: 'cubierto', recuperacion: 'hybrid',
  relevancia_verificada: true, ms: 812.3, estado_final: 'cubierto', usado_en_respuesta: true,
});
eq(hopNuevo?.plan_item, 'e1', 'hop nuevo: plan_item');
eq(hopNuevo?.estado_final, 'cubierto', 'hop nuevo: estado_final');
// Un estado_final fuera del contrato NO se cuela; un origen raro tampoco.
const hopSucio = normalizeHop({ n: 1, query: 'q', origen: 'modelo', estado_final: 'ok', estado: 'bien', usado_en_respuesta: 'si' });
check(hopSucio !== null && !('origen' in hopSucio) && !('estado_final' in hopSucio) && !('estado' in hopSucio) && !('usado_en_respuesta' in hopSucio), 'hop sucio: valores fuera del contrato se omiten');

/* ---------------- plan ---------------- */
eq(normalizePlan({ items: [{ id: 'e0', query: 'p', evidence_needed: 'respuesta directa' }, { id: '', query: 'x' }, 'no'] }), [{ id: 'e0', query: 'p', query_en: '', evidence_needed: 'respuesta directa' }], 'plan: descarta items sin id o no objeto');
eq(normalizePlan(null), [], 'plan null -> []');
eq(normalizePlan({ items: 'x' }), [], 'plan con items no array -> []');

/* ---------------- sources ---------------- */
const fuentes = normalizeSources([
  { source_file: 'a.pdf', page: 1, snippet: 's', score: 0.5 },
  { source_file: 'b.pdf', page: 2, snippet: 's', score: 0.5, plan_items: ['e0', 'e2'], grado: 'directa' },
  { source_file: 'c.pdf', page: 3, snippet: 's', score: 0.5, plan_items: 'e2', grado: 'excelente' },
]);
eq(fuentes[0].plan_items, [], 'source vieja: plan_items []');
eq(fuentes[0].grado, '', 'source vieja: grado vacio (sin calificar), no "directa"');
eq(fuentes[1].plan_items, ['e0', 'e2'], 'source nueva: plan_items');
eq(fuentes[1].grado, 'directa', 'source nueva: grado');
eq(fuentes[2].plan_items, [], 'source sucia: plan_items no array -> []');
eq(fuentes[2].grado, '', 'source sucia: grado fuera del contrato -> vacio');

/* ---------------- cobertura desde hops (mensaje persistido) ---------------- */
eq(coberturaDesdeHops([{ n: 1, query: 'a' }, { n: 2, query: 'b' }]), [], 'hops viejos: sin cobertura (nada que mostrar)');
const hopsPersistidos = normalizeHops([
  { n: 1, query: 'pregunta entera', origen: 'plan', plan_item: 'e0', estado: 'cubierto', resultados: 5, estado_final: 'cubierto', usado_en_respuesta: true },
  { n: 2, query: 'dosis', origen: 'plan', plan_item: 'e1', evidence_needed: 'dosis', estado: 'cubierto', resultados: 3, documentos: ['A'], estado_final: 'cubierto', usado_en_respuesta: true },
  { n: 3, query: 'efectos', origen: 'plan', plan_item: 'e2', evidence_needed: 'efectos', estado: 'cubierto', resultados: 2, documentos: ['B'], estado_final: 'evidencia_no_usada', usado_en_respuesta: false },
  { n: 4, query: 'mortalidad', origen: 'plan', plan_item: 'e3', evidence_needed: 'mortalidad', estado: 'sin_resultados', resultados: 0, documentos: [] },
  // Hop con fragmentos pero sin estado_final ni usado_en_respuesta: el
  // verificador no dictamino. NO puede salir como "cubierto".
  { n: 5, query: 'coste', origen: 'plan', plan_item: 'e4', evidence_needed: 'coste', estado: 'cubierto', resultados: 4, documentos: ['C'] },
  { n: 6, query: 'extra del modelo', origen: 'extra', estado: 'cubierto', resultados: 1 },
]);
const filas = coberturaDesdeHops(hopsPersistidos);
eq(filas.map((f) => f.id), ['e1', 'e2', 'e3', 'e4'], 'desde hops: sin e0 y sin extra');
eq(filas.map((f) => f.estado), ['cubierto', 'evidencia_no_usada', 'sin_resultados', 'encontrada'], 'desde hops: estado_final manda; sin el, no se afirma "cubierto"');
eq(filas[1].documentos, ['B'], 'desde hops: documentos');

// Reintento: dos hops del mismo punto, cuenta el ultimo.
const reintento = coberturaDesdeHops(normalizeHops([
  { n: 1, query: 'a', origen: 'plan', plan_item: 'e1', estado: 'sin_resultados', resultados: 0 },
  { n: 2, query: 'a2', origen: 'plan', plan_item: 'e1', estado: 'cubierto', resultados: 2, estado_final: 'cubierto' },
]));
eq(reintento.map((f) => f.estado), ['cubierto'], 'reintento: manda el ultimo hop del punto');

/* ---------------- filasCobertura: prioridad y orden ---------------- */
const plan = normalizePlan({ items: [
  { id: 'e0', query: 'p', evidence_needed: 'respuesta directa' },
  { id: 'e1', query: 'dosis', evidence_needed: 'dosis' },
  { id: 'e2', query: 'efectos', evidence_needed: 'efectos adversos' },
  { id: 'e3', query: 'mortalidad', evidence_needed: 'mortalidad' },
] });
// Con informe del verificador: manda el informe, en el orden del plan.
const conInforme = filasCobertura(plan, hopsPersistidos, nuevo?.cobertura);
eq(conInforme.map((f) => `${f.id}:${f.estado}`), ['e1:cubierto', 'e2:evidencia_no_usada', 'e3:sin_resultados', 'e5:parcial'], 'con informe: orden del plan, lo ajeno al plan al final, sin e0');
// Sin informe: desde hops; el punto del plan sin hop sale como no_buscado.
const sinInforme = filasCobertura(plan, hopsPersistidos.filter((h) => h.plan_item !== 'e3'), []);
eq(sinInforme.map((f) => `${f.id}:${f.estado}`), ['e1:cubierto', 'e2:evidencia_no_usada', 'e3:no_buscado', 'e4:encontrada'], 'sin informe: desde hops + no_buscado para el punto sin hop');
// Mensaje antiguo: sin plan, hops viejos, sin informe -> nada.
eq(filasCobertura([], [{ n: 1, query: 'a' }], null), [], 'mensaje antiguo: ninguna fila');
// Plan vacio con informe: el informe se muestra igual (orden de llegada).
eq(filasCobertura([], [], nuevo?.cobertura).map((f) => f.id), ['e1', 'e2', 'e3', 'e5'], 'sin plan pero con informe: se muestra el informe');
// Un informe con solo e0 no genera filas (e0 nunca es fila).
eq(filasCobertura([], [], [{ id: 'e0', evidence_needed: '', estado: 'cubierto', n_fragmentos: 1, documentos: [], afirmaciones: [] }]), [], 'informe solo con e0: ninguna fila');
// Fila del informe sin texto: el plan lo completa.
const completada = filasCobertura(plan, [], [{ id: 'e2', evidence_needed: '', estado: 'parcial', n_fragmentos: 1, documentos: [], afirmaciones: [] }]);
eq(completada.find((f) => f.id === 'e2')?.evidence_needed, 'efectos adversos', 'evidence_needed vacio se completa desde el plan');

/* ---------------- recuperacion en error NO es ausencia ---------------- */
const hopsConFallo = normalizeHops([
  { n: 1, query: 'a', origen: 'plan', plan_item: 'e1', evidence_needed: 'a', estado: 'sin_resultados', resultados: 0, recuperacion: 'error', ms: 45000 },
  { n: 2, query: 'b', origen: 'plan', plan_item: 'e2', evidence_needed: 'b', estado: 'sin_resultados', resultados: 0, recuperacion: 'hibrida', ms: 800 },
]);
eq(coberturaDesdeHops(hopsConFallo).map((f) => `${f.id}:${f.estado}`), ['e1:error_busqueda', 'e2:sin_resultados'], 'busqueda fallida se distingue de sin resultados');
// El informe del verificador solo sabe decir sin_resultados: si el hop de ese
// punto fallo, la fila dice que no se pudo comprobar.
eq(
  filasCobertura([], hopsConFallo, [
    { id: 'e1', evidence_needed: 'a', estado: 'sin_resultados', n_fragmentos: 0, documentos: [], afirmaciones: [] },
    { id: 'e2', evidence_needed: 'b', estado: 'sin_resultados', n_fragmentos: 0, documentos: [], afirmaciones: [] },
  ]).map((f) => f.estado),
  ['error_busqueda', 'sin_resultados'],
  'con informe: sin_resultados + hop fallido -> error_busqueda; sin_resultados + hop limpio se respeta',
);
// Un dictamen distinto de sin_resultados NO se pisa aunque el hop fallara (la
// evidencia pudo llegar por otra busqueda).
eq(
  filasCobertura([], hopsConFallo, [
    { id: 'e1', evidence_needed: 'a', estado: 'cubierto', n_fragmentos: 2, documentos: ['X'], afirmaciones: [0] },
  ]).map((f) => f.estado),
  ['cubierto'],
  'un dictamen cubierto no se degrada por un hop fallido',
);
// Un hop con recuperacion error pero CON fragmentos no es un fallo.
eq(coberturaDesdeHops(normalizeHops([
  { n: 1, query: 'a', origen: 'plan', plan_item: 'e1', estado: 'cubierto', resultados: 3, recuperacion: 'error' },
])).map((f) => f.estado), ['encontrada'], 'recuperacion error con fragmentos: no es fallo');

/* ---------------- hop extra que rellena un punto ---------------- */
eq(
  coberturaDesdeHops(normalizeHops([
    { n: 1, query: 'a', origen: 'plan', plan_item: 'e1', evidence_needed: 'a', estado: 'sin_resultados', resultados: 0 },
    { n: 2, query: 'a bis', origen: 'extra', plan_item: 'e1', estado: 'cubierto', resultados: 2, documentos: ['Z'] },
  ])).map((f) => `${f.id}:${f.estado}:${f.n_fragmentos}:${f.documentos.join('|')}`),
  ['e1:encontrada:2:Z'],
  'un extra con fragmentos saca al punto de sin_resultados (y aporta sus documentos)',
);
eq(
  coberturaDesdeHops(normalizeHops([
    { n: 1, query: 'a', origen: 'plan', plan_item: 'e1', estado: 'cubierto', resultados: 3, estado_final: 'cubierto', usado_en_respuesta: true },
    { n: 2, query: 'a bis', origen: 'extra', plan_item: 'e1', estado: 'sin_resultados', resultados: 0, recuperacion: 'error', ms: 12 },
  ])).map((f) => f.estado),
  ['cubierto'],
  'un extra vacio o fallido no degrada un punto cubierto',
);
eq(
  coberturaDesdeHops(normalizeHops([
    { n: 1, query: 'a', origen: 'plan', plan_item: 'e2', estado: 'sin_resultados', resultados: 0, estado_final: 'cubierto', usado_en_respuesta: true },
    { n: 2, query: 'a bis', origen: 'extra', plan_item: 'e2', estado: 'cubierto', resultados: 2 },
  ])).map((f) => f.estado),
  ['cubierto'],
  'el extra elegido hereda el dictamen del verificador del hop del plan',
);
// Un extra sin plan_item sigue sin tocar ninguna fila.
eq(coberturaDesdeHops(normalizeHops([
  { n: 1, query: 'suelta', origen: 'extra', estado: 'cubierto', resultados: 4 },
])), [], 'extra sin punto declarado: ninguna fila');

/* ---------------- plan: lista directa y claves camelCase ---------------- */
eq(
  normalizePlan([
    { id: 'e0', query: 'p', query_en: 'q', evidence_needed: 'x' },
    { id: 'e1', query: 'a', queryEn: 'b', evidenceNeeded: 'c' },
    { query: 'sin id' },
  ]),
  [
    { id: 'e0', query: 'p', query_en: 'q', evidence_needed: 'x' },
    { id: 'e1', query: 'a', query_en: 'b', evidence_needed: 'c' },
  ],
  'plan: la columna de Convex es una lista directa; camelCase se traduce; sin id se descarta',
);

/* ---------------- recuperacion: las dos grafias ---------------- */
eq(normalizeHop({ n: 1, query: 'q', recuperacion: 'hibrida' })?.recuperacion, 'hibrida', 'recuperacion nueva (hibrida)');
eq(normalizeHop({ n: 1, query: 'q', recuperacion: 'lexica' })?.recuperacion, 'lexica', 'recuperacion nueva (lexica)');
eq(normalizeHop({ n: 1, query: 'q', recuperacion: 'hybrid' })?.recuperacion, 'hybrid', 'recuperacion antigua (hybrid)');
check(!('recuperacion' in (normalizeHop({ n: 1, query: 'q', recuperacion: 'magica' }) ?? {})), 'recuperacion fuera del contrato se omite');

if (fallos.length > 0) {
  throw new Error(`${fallos.length} comprobacion(es) fallida(s)\n${fallos.join('\n')}`);
}
console.info('normalize.check: todas las comprobaciones pasan');
