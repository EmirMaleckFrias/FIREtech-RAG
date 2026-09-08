// Corre el benchmark médico contra el despliegue de Convex y escribe un
// reporte JSON. Port de `backend/evaluar.py` sobre el arnés interno
// (`pruebas:prepararPregunta` + `pruebas:leerTurno`); la puntuación vive en
// `convex/evaluacion/puntuar.ts` y es la misma que medía el Python.
//
// Ejecutar desde frontend/ (lee VITE_CONVEX_URL y CONVEX_DEPLOY_KEY del
// entorno o de .env.local):
//
//   npx vite-node scripts/evaluar.ts --dataset evals/alzheimer.jsonl --dry-run
//   npx vite-node scripts/evaluar.ts --dataset evals/alzheimer.jsonl --correo medica@alzheimerproject.com
//   npx vite-node scripts/evaluar.ts --dataset ... --correo ... --repeticiones 3 --max-usd 2
//
// `--correo` es la cuenta CUYO CORPUS se pregunta: cada persona tiene el suyo,
// así que la misma pregunta desde dos cuentas busca en índices distintos. Las
// conversaciones que crea el benchmark se borran al terminar cada caso
// (`--conservar` las deja para mirarlas en la interfaz).
//
// Repeticiones: la misma pregunta corrida 5 veces dio fidelidad entre 0.33 y
// 1.00 (2026-09-03). Con una sola pasada cualquier "mejoró" es ruido, así que
// `--repeticiones N` corre cada caso N veces y el reporte agrega (mediana de lo
// numérico, mayoría de lo booleano, la dispersión) MÁS las N corridas crudas.
//
// El reporte se escribe SIEMPRE, también si el bucle se interrumpe (Ctrl-C o un
// fallo): lo ya medido y pagado no se tira, y `interrupted` dice que es parcial
// para que nadie lo compare con uno completo. El código de salida es 0 solo si
// el gate de release pasa y el benchmark se completó.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  agregarCorridas,
  cargarCasos,
  puntuarCaso,
  resumir,
  type Caso,
  type Puntuacion,
  type Resultado,
  type ResultadoAgregado,
} from "../convex/evaluacion/puntuar";

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------
interface Args {
  dataset: string;
  correo: string | null;
  repeticiones: number;
  output: string | null;
  maxUsd: number | null;
  dryRun: boolean;
  conservar: boolean;
  esperaMaxS: number;
}

function leerArgs(argv: string[]): Args {
  const a: Args = { dataset: "", correo: null, repeticiones: 1, output: null, maxUsd: null, dryRun: false, conservar: false, esperaMaxS: 660 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const valor = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`falta el valor de ${k}`);
      return v;
    };
    if (k === "--dataset") a.dataset = valor();
    else if (k === "--correo") a.correo = valor();
    else if (k === "--repeticiones") a.repeticiones = Number(valor());
    else if (k === "--output") a.output = valor();
    else if (k === "--max-usd") a.maxUsd = Number(valor());
    else if (k === "--espera-max") a.esperaMaxS = Number(valor());
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--conservar") a.conservar = true;
    else throw new Error(`argumento desconocido: ${k}`);
  }
  if (!a.dataset) throw new Error("hace falta --dataset");
  if (!Number.isInteger(a.repeticiones) || a.repeticiones < 1) throw new Error("--repeticiones debe ser un entero >= 1");
  if (a.maxUsd !== null && !(a.maxUsd >= 0)) throw new Error("--max-usd debe ser un número >= 0");
  return a;
}

/** Variables del entorno, con `.env.local` de respaldo (sin dependencias). */
function variable(nombre: string): string | undefined {
  if (process.env[nombre]) return process.env[nombre];
  const ruta = resolve(".env.local");
  if (!existsSync(ruta)) return undefined;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (m && m[1] === nombre) return m[2].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Convex
// ---------------------------------------------------------------------------
const prepararPregunta = makeFunctionReference<"mutation", { texto: string; modo: string; correo?: string }, { sessionId: string; messageId: string }>(
  "pruebas:prepararPregunta",
);
const leerTurno = makeFunctionReference<"query", { messageId: string }, Turno | null>("pruebas:leerTurno");
const borrarSesion = makeFunctionReference<"mutation", { sessionId: string }, { estado: string }>("pruebas:borrarSesionDePrueba");

interface Turno {
  estado: string | null;
  error: string | null;
  content: string;
  sources: unknown[];
  hops: unknown[];
  plan: unknown[];
  verificacion: unknown;
  metrics: Record<string, unknown>;
}

const FINALES = new Set(["listo", "error", "cancelado"]);

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Una corrida del caso: lanza la pregunta y espera el turno final. CUALQUIER
 *  fallo se devuelve como resultado con `error`, no como excepción, para que
 *  puntúe (y falle) como las demás y el reporte no pierda lo ya medido. */
async function correrCaso(cliente: ConvexHttpClient, caso: Caso, args: Args): Promise<{ resultado: Resultado; sessionId: string | null }> {
  let sessionId: string | null = null;
  try {
    const { sessionId: sid, messageId } = await cliente.mutation(prepararPregunta, {
      texto: caso.question,
      modo: caso.mode,
      ...(args.correo ? { correo: args.correo } : {}),
    });
    sessionId = sid;
    const limite = Date.now() + args.esperaMaxS * 1000;
    let turno: Turno | null = null;
    while (Date.now() < limite) {
      await dormir(3000);
      turno = await cliente.query(leerTurno, { messageId });
      if (turno === null) throw new Error("el mensaje desapareció mientras se esperaba");
      if (turno.estado && FINALES.has(turno.estado)) break;
    }
    if (!turno || !turno.estado || !FINALES.has(turno.estado)) {
      throw new Error(`el turno no terminó en ${args.esperaMaxS} s (estado: ${turno?.estado ?? "?"})`);
    }
    const metrics = { ...turno.metrics };
    // El verificador deja su informe en la fila (`verificacion`) y su resumen
    // en la telemetría (`metrics.meta.verificacion`), que es lo que lee el
    // puntuador; si la telemetría no lo trajera, se reconstruye de la fila.
    const meta = (metrics.meta ?? {}) as Record<string, unknown>;
    if (!meta.verificacion && turno.verificacion && typeof turno.verificacion === "object") {
      const v = turno.verificacion as { fidelidad?: number | null; afirmaciones?: Array<{ veredicto?: string }> };
      const cuenta = (x: string) => (v.afirmaciones ?? []).filter((a) => a.veredicto === x).length;
      metrics.meta = { ...meta, verificacion: { fidelidad: v.fidelidad ?? null, no_sostenidas: cuenta("no_sostenida"), sin_verificar: cuenta("sin_verificar") } };
    }
    return {
      sessionId,
      resultado: {
        id: caso.id,
        question: caso.question,
        mode: caso.mode,
        answer: turno.content,
        sources: turno.sources,
        hops: turno.hops,
        metrics,
        error: turno.estado === "error" ? (turno.error ?? "error sin detalle") : turno.estado === "cancelado" ? "turno cancelado" : null,
      },
    };
  } catch (exc) {
    return {
      sessionId,
      resultado: {
        id: caso.id, question: caso.question, mode: caso.mode, answer: "", sources: [], hops: [], metrics: {},
        error: `${exc instanceof Error ? exc.constructor.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  const args = leerArgs(process.argv.slice(2));
  const casos = cargarCasos(readFileSync(args.dataset, "utf8"), args.dataset);
  console.log(`Benchmark válido: ${casos.length} casos en ${args.dataset}`);
  if (args.dryRun) return 0;
  if (!args.correo) throw new Error("hace falta --correo: la cuenta cuyo corpus se pregunta");

  const url = variable("VITE_CONVEX_URL");
  const clave = variable("CONVEX_DEPLOY_KEY");
  if (!url || !clave) throw new Error("hacen falta VITE_CONVEX_URL y CONVEX_DEPLOY_KEY (entorno o .env.local)");
  const cliente = new ConvexHttpClient(url);
  cliente.setAdminAuth(clave);

  type Evaluado = { caso: Caso; score: Puntuacion; result: ResultadoAgregado; runs: Array<{ result: Resultado; score: Puntuacion }> };
  const evaluados: Evaluado[] = [];
  let gastado = 0;
  let interrumpido: unknown = null;
  let cortado = false;
  process.on("SIGINT", () => {
    cortado = true;
    console.error("\nInterrumpido: se escribirá lo ya medido.");
  });

  try {
    let topeAlcanzado = false;
    for (const [indice, caso] of casos.entries()) {
      if (cortado) throw new Error("interrumpido por la usuaria");
      const runs: Array<{ result: Resultado; score: Puntuacion }> = [];
      for (let rep = 1; rep <= args.repeticiones; rep++) {
        if (args.maxUsd !== null && gastado >= args.maxUsd) {
          topeAlcanzado = true;
          break;
        }
        if (cortado) throw new Error("interrumpido por la usuaria");
        const etiqueta = `[${indice + 1}/${casos.length}] ${caso.id}` + (args.repeticiones > 1 ? ` (${rep}/${args.repeticiones})` : "");
        console.log(`${etiqueta}: ${caso.question}`);
        const { resultado, sessionId } = await correrCaso(cliente, caso, args);
        const score = puntuarCaso(caso, resultado);
        runs.push({ result: resultado, score });
        gastado += Number((resultado.metrics ?? {}).cost_usd ?? 0) || 0;
        console.log(score.passed ? "  PASS" : "  FAIL: " + score.failures.join("; "));
        if (sessionId && !args.conservar) {
          try {
            await cliente.mutation(borrarSesion, { sessionId });
          } catch (exc) {
            console.warn(`  (no se pudo borrar la conversación de prueba: ${exc instanceof Error ? exc.message : String(exc)})`);
          }
        }
      }
      if (!runs.length) {
        console.log(`Tope de coste alcanzado antes del caso ${caso.id}`);
        break;
      }
      const [score, result] = agregarCorridas(runs.map((r) => r.score), runs.map((r) => r.result));
      evaluados.push({ caso, score, result, runs });
      if (args.repeticiones > 1) {
        const aprobadas = Math.round((score.passed_rate ?? 0) * (score.runs ?? 1));
        let linea = `  => ${score.passed ? "PASS" : "FAIL"} ${aprobadas}/${score.runs} corridas`;
        if (score.failures.length) linea += ": " + score.failures.join("; ");
        console.log(linea);
      }
      if (topeAlcanzado) {
        console.log(`Tope de coste alcanzado: ${caso.id} se agregó con ${runs.length} de ${args.repeticiones} corridas`);
        break;
      }
    }
  } catch (exc) {
    interrumpido = exc;
    console.error(`Benchmark interrumpido tras ${evaluados.length} de ${casos.length} casos: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  if (!evaluados.length) {
    console.log("No se evaluó ningún caso: no hay nada que reportar.");
    return 1;
  }
  const summary = resumir(evaluados.map((e) => e.score), evaluados.map((e) => e.result));
  const reporte = {
    schema_version: 3,
    created_at: new Date().toISOString(),
    dataset: args.dataset,
    correo: args.correo,
    repetitions: args.repeticiones,
    interrupted:
      interrumpido === null
        ? null
        : { error: interrumpido instanceof Error ? interrumpido.message : String(interrumpido), cases_evaluated: evaluados.length, cases_total: casos.length },
    summary,
    cases: evaluados.map((e) => ({ definition: e.caso, score: e.score, result: e.result, runs: e.runs })),
  };
  const salida = args.output ?? resolve("evals/results", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, JSON.stringify(reporte, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Reporte: ${salida}`);
  return summary.release_gate_passed && interrumpido === null ? 0 : 1;
}

process.exitCode = await main();
