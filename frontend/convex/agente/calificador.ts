// Calificador pointwise de evidencia. Port de `calificar_evidencia` y de su
// prompt, en `backend/app/services/reranker.py`. El rerank listwise y el
// filtro binario de ese mismo fichero NO se portan: eran el camino de
// rollback del bucle antiguo y aquí el pipeline de evidencia es el único.
//
// Por qué pointwise y con el texto completo: la selección de evidencia pasaba
// por un rerank LISTWISE (permutar 60 fragmentos en un JSON, medido 2/10
// permutaciones distintas a temperatura 0) y por un filtro binario que solo
// veía 450 caracteres de cada fragmento y descartaba los que tenían la cifra
// clave al final. Un juicio por fragmento sobre el texto entero es la salida
// más estable que puede dar un modelo, y con la sección en la cabecera puede
// distinguir un dato de Resultados de una mención de pasada en Introducción.
import * as gateway from "../lib/gateway";
import { ajustes, modeloRerankResuelto } from "../lib/config";
import { cita, fuente, type Fragmento } from "../lib/citas";
import type { Telemetria } from "../lib/telemetry";

export type Grado = "directa" | "parcial" | "no";
export const GRADOS: readonly Grado[] = ["directa", "parcial", "no"];

export interface Calificacion {
  /** Grado por índice del fragmento en la lista de entrada. Un índice ausente
   *  significa que el modelo no lo juzgó: nadie debe leerlo como "no". */
  grados: Record<number, Grado>;
  /** false = el calificador no se pudo aplicar (API caída, JSON roto en al
   *  menos un lote, o el modelo no emitió NINGÚN grado). Los grados de los
   *  lotes que sí respondieron se devuelven igual, pero nadie debe concluir
   *  nada de un grado ausente. */
  verificado: boolean;
  motivo: string;
}

/** Tamaño máximo de lote. Por encima, los lotes van en paralelo (cada uno
 *  ocupa su plaza en el gateway) y se unen por índice global. */
export const LOTE = 20;

/** Motivo de la trampa medida el 4 sep 2026: el modelo respondía
 *  `{"fragmentos": []}` o se saltaba todas las entradas y el resultado se
 *  daba por verificado, con lo que todos los candidatos se entregaban como
 *  "parcial" sin grado y con la relevancia marcada como comprobada. Sin
 *  ningún grado, `verificado` es false, igual que si la llamada hubiera
 *  fallado. */
export const MOTIVO_SIN_GRADOS = "el calificador no emitió ningún grado";

export const PROMPT_CALIFICADOR =
  "Eres un evaluador de evidencia para investigación médica. Recibes una " +
  "pregunta, la descripción de la evidencia que se necesita para responderla " +
  "y una lista de fragmentos numerados de documentos, cada uno con una " +
  "cabecera (fuente, sección, tipo, cita) y su texto completo. Juzga CADA " +
  "fragmento POR SÍ SOLO, sin compararlo con los demás, y asígnale un grado:\n" +
  '- "directa": el fragmento contiene el dato, la cifra, la definición, el ' +
  "método o el resultado que pide la evidencia necesaria, en la población o " +
  "el contexto por el que se pregunta.\n" +
  '- "parcial": habla del tema y aporta algo útil, pero sin el dato exacto, o ' +
  "lo aporta en otra población o contexto, o solo lo interpreta o lo comenta " +
  "sin darlo.\n" +
  '- "no": trata otro tema, o es portada, índice, bibliografía o cabecera sin ' +
  "contenido, o menciona el tema de pasada sin decir nada de él.\n" +
  "Fíjate en la sección: un dato en Resultados o en una tabla vale como " +
  "evidencia; la misma frase en Introducción suele ser contexto de otros " +
  'trabajos. Ante la duda entre "parcial" y "no", elige "parcial": que ' +
  "alguien pierda una cifra por un descarte es peor que un fragmento de más. " +
  "Devuelve SOLO un objeto JSON con la forma " +
  '{"fragmentos": [{"i": <índice tal como aparece en la cabecera>, ' +
  '"grado": "directa"|"parcial"|"no", "motivo": "<una frase>"}]} con una ' +
  "entrada por cada fragmento recibido, usando exactamente el índice de su " +
  "cabecera. Sin texto adicional.";

/** Cabecera de un fragmento en el prompt del calificador. El índice es el
 *  GLOBAL de la lista de entrada aunque el fragmento vaya en el segundo lote:
 *  así el modelo solo tiene que copiarlo y nadie reindexa nada. Sin sección
 *  se dice "desconocida", no se deja un hueco que el modelo pueda leer como
 *  "sección vacía". */
export function cabecera(i: number, ch: Fragmento): string {
  const tipo = ch.chunkType === "table" ? "tabla" : "texto";
  return (
    `[${i}] fuente: ${fuente(ch)} · seccion: ${ch.section || "desconocida"} ` +
    `· tipo: ${tipo} · cita: ${cita(ch)}`
  );
}

/** Lee {"fragmentos": [{"i", "grado", ...}]} con tolerancia por entrada:
 *  las que no son objetos, índices fuera de [offset, offset+n), booleanos,
 *  no enteros o repetidos y grados fuera de GRADOS se ignoran uno a uno. Solo
 *  la ausencia de la lista es un fallo del lote. */
export function parsearGrados(
  data: unknown,
  offset: number,
  n: number,
): Record<number, Grado> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("respuesta JSON que no es un objeto");
  }
  const crudos: unknown = (data as Record<string, unknown>).fragmentos;
  if (!Array.isArray(crudos)) throw new Error("respuesta sin lista 'fragmentos'");
  const grados: Record<number, Grado> = {};
  for (const item of crudos) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { i, grado: g } = item as { i?: unknown; grado?: unknown };
    if (typeof i === "boolean" || typeof g !== "string") continue;
    if (typeof i !== "number" && typeof i !== "string") continue;
    const idx = Number(i);
    if (!Number.isInteger(idx)) continue;
    const grado = g.trim().toLowerCase();
    if (idx < offset || idx >= offset + n || idx in grados) continue;
    if (!(GRADOS as readonly string[]).includes(grado)) continue;
    grados[idx] = grado as Grado;
  }
  return grados;
}

/** Una llamada por lote. Devuelve grados ya en índice global.
 *
 *  La ronda se anota DESPUÉS de parsear: una respuesta que llega pero no trae
 *  la lista es un lote fallido, y anotarla como "ok" inflaría en verde la
 *  medida de cuánto falla el calificador (el mismo error que ya se pagó en el
 *  planificador). */
async function calificarLote(
  consulta: string,
  evidenceNeeded: string,
  lote: Fragmento[],
  offset: number,
  nTotal: number,
  k: number,
  nLotes: number,
  tel?: Telemetria,
): Promise<Record<number, Grado>> {
  const a = ajustes();
  const modelo = modeloRerankResuelto(a);
  const nota = `calificar n=${nTotal} lote=${k + 1}/${nLotes}`;
  const fragmentos = lote
    .map((ch, j) => `${cabecera(offset + j, ch)}\n${ch.text}`)
    .join("\n\n");
  const usuario =
    `Pregunta: ${consulta}\n` +
    `Evidencia necesaria: ${evidenceNeeded}\n\n` +
    `Fragmentos (${lote.length}, índices ${offset} a ${offset + lote.length - 1}):\n\n` +
    `${fragmentos}\n\n` +
    'Responde con el JSON {"fragmentos": [{"i": índice, "grado": ' +
    '"directa"|"parcial"|"no", "motivo": "..."}]}, una entrada por ' +
    "fragmento.";
  const t0 = Date.now();
  let modeloReal = modelo;
  let usage: gateway.UsoTokens | null = null;
  let finishReason: string | null = null;
  try {
    const r = await gateway.completionJson(
      {
        model: modelo,
        temperature: a.temperatura,
        messages: [
          { role: "system", content: PROMPT_CALIFICADOR },
          { role: "user", content: usuario },
        ],
        ...gateway.razonamiento(a.razonamientoCalificador),
      },
      a,
    );
    modeloReal = r.modelo || modelo;
    usage = r.usage;
    finishReason = r.finishReason;
    if (r.razonamientoRechazado) tel?.incr("razonamiento_rechazado");
    const grados = parsearGrados(r.datos, offset, lote.length);
    tel?.anota("grader", modeloReal, usage, {
      ms: Date.now() - t0,
      ok: true,
      finishReason,
      nota,
    });
    return grados;
  } catch (exc) {
    tel?.anota("grader", modeloReal, usage, {
      ms: Date.now() - t0,
      ok: false,
      finishReason,
      nota: `${nota}: ${String(exc).slice(0, 120)}`,
    });
    throw exc;
  }
}

/** Califica cada fragmento COMPLETO como evidencia directa, parcial o no.
 *
 *  Pointwise: cada fragmento se juzga por sí solo frente a `consulta` con el
 *  objetivo `evidenceNeeded`, con cabecera fuente/sección/tipo/cita y el
 *  texto sin truncar. Más de `LOTE` fragmentos se parten en lotes que corren
 *  en paralelo (`Promise.allSettled`). Un lote caído no tumba los demás: sus
 *  índices quedan sin grado y `verificado` pasa a false con el recuento en
 *  `motivo`. Y sin ningún grado en total, `verificado` también es false. */
export async function calificarEvidencia(
  consulta: string,
  evidenceNeeded: string,
  fragmentos: Fragmento[],
  tel?: Telemetria,
): Promise<Calificacion> {
  if (!fragmentos.length) return { grados: {}, verificado: true, motivo: "sin candidatos" };

  const lotes: Fragmento[][] = [];
  for (let i = 0; i < fragmentos.length; i += LOTE) lotes.push(fragmentos.slice(i, i + LOTE));
  const resultados = await Promise.allSettled(
    lotes.map((lote, k) =>
      calificarLote(
        consulta,
        evidenceNeeded,
        lote,
        k * LOTE,
        fragmentos.length,
        k,
        lotes.length,
        tel,
      ),
    ),
  );

  const sueltos: Record<number, Grado> = {};
  let fallidos = 0;
  resultados.forEach((r, k) => {
    if (r.status === "rejected") {
      fallidos += 1;
      console.warn(
        `calificarEvidencia: lote ${k + 1}/${lotes.length} falló (${String(r.reason).slice(0, 160)}); sus fragmentos quedan sin calificar.`,
      );
      return;
    }
    Object.assign(sueltos, r.value);
  });
  // Orden estable por índice: allSettled ya respeta el orden de los lotes,
  // pero así el objeto no depende de en qué orden respondió el modelo dentro
  // de uno.
  const grados: Record<number, Grado> = {};
  for (const i of Object.keys(sueltos).map(Number).sort((x, y) => x - y)) grados[i] = sueltos[i];

  const nGrados = Object.keys(grados).length;
  const conteo = { directa: 0, parcial: 0, no: 0 };
  for (const g of Object.values(grados)) conteo[g] += 1;
  let resumen =
    `${conteo.directa} directa, ${conteo.parcial} parcial, ${conteo.no} no ` +
    `de ${fragmentos.length} fragmentos`;
  const sinCalificar = fragmentos.length - nGrados;
  if (fallidos) {
    return {
      grados,
      verificado: false,
      motivo:
        `${fallidos} de ${lotes.length} lotes fallaron; ${sinCalificar} fragmentos ` +
        `sin calificar; ${resumen}`,
    };
  }
  if (!nGrados) return { grados, verificado: false, motivo: MOTIVO_SIN_GRADOS };
  if (sinCalificar) resumen += `; ${sinCalificar} sin calificar por el modelo`;
  return { grados, verificado: true, motivo: resumen };
}
