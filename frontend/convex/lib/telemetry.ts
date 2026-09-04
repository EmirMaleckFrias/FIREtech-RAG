// Telemetría de una pregunta: qué llamó a qué modelo, cuántos tokens, cuánto
// tardó y cuánto costó. Port de `backend/app/services/telemetry.py`.
//
// Diferencia con el original: allí el acumulador vivía en un `contextvars`
// porque FastAPI lo compartía entre capas. Aquí se crea uno por acción y se
// pasa explícitamente, que es más código en las firmas y mucho menos misterio:
// una acción de Convex es un ámbito claro y no hay estado global que se cuele
// entre peticiones concurrentes.
//
// El coste es SIEMPRE una estimación con tarifas asumidas, y hay que
// etiquetarlo así donde se muestre. En este proyecto además el coste no es un
// criterio de decisión: se mide para que se vea, no para frenar por él.

/** (entrada, entrada cacheada, salida) en USD por millón de tokens.
 *
 *  Tarifas ASUMIDAS a 1 de septiembre de 2026; la entrada cacheada se asume al
 *  10 % de la normal. Sustituir por las oficiales cuando se confirmen. */
export const PRECIOS_ASUMIDOS: Record<string, [number, number, number]> = {
  "gpt-5.4": [1.25, 0.125, 10.0],
  "gpt-5.4-mini": [0.25, 0.025, 2.0],
  "text-embedding-3-large": [0.13, 0.13, 0.0],
};

export const ETIQUETA_PRECIOS = "estimado, tarifas asumidas";

/** Tarifa del modelo. Gana la clave más larga que sea prefijo del nombre, así
 *  que un snapshot tipo `gpt-5.4-2026-03-01` casa con `gpt-5.4`.
 *
 *  Se quita antes el prefijo de proveedor, porque el gateway nombra los
 *  modelos como `openai/gpt-5.4` y con eso NINGUNA clave casaba: el coste
 *  salía 0.00 en todas las peticiones. Se descubrió en una sesión de estrés
 *  donde las diez preguntas reportaron cero dólares. */
export function tarifaDe(
  modelo: string,
): [number, number, number] | null {
  const nombre = modelo.includes("/") ? modelo.split("/", 2)[1] : modelo;
  let mejor: string | null = null;
  for (const clave of Object.keys(PRECIOS_ASUMIDOS)) {
    if (nombre === clave || nombre.startsWith(clave + "-")) {
      if (mejor === null || clave.length > mejor.length) mejor = clave;
    }
  }
  return mejor ? PRECIOS_ASUMIDOS[mejor] : null;
}

export interface Uso {
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
}

const USO_CERO: Uso = { prompt: 0, cached: 0, completion: 0, reasoning: 0 };

/** Una llamada a un modelo, ya terminada. */
export interface Ronda {
  componente: string;
  modelo: string;
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
  ms: number;
  ok: boolean;
  finishReason: string | null;
  nota: string;
}

export class Telemetria {
  readonly rondas: Ronda[] = [];
  readonly contadores: Record<string, number> = {};
  readonly meta: Record<string, unknown> = {};
  private readonly t0 = Date.now();

  /** Anota una llamada a un modelo.
   *
   *  Ojo con el orden: hay que anotar DESPUÉS de parsear la respuesta, no
   *  antes. En el planificador estaba antes con `ok = hay contenido`, así que
   *  un JSON malformado dejaba una ronda anotada "ok" y el manejador de error
   *  anotaba otra en fallo: la telemetría mostraba dos rondas contradictorias
   *  para una sola llamada. */
  anota(
    componente: string,
    modelo: string,
    uso: Uso | null | undefined,
    opciones: {
      ms: number;
      ok?: boolean;
      finishReason?: string | null;
      nota?: string;
    },
  ): void {
    const u = uso ?? USO_CERO;
    this.rondas.push({
      componente,
      modelo,
      prompt: u.prompt,
      cached: u.cached,
      completion: u.completion,
      reasoning: u.reasoning,
      ms: opciones.ms,
      ok: opciones.ok ?? true,
      finishReason: opciones.finishReason ?? null,
      nota: opciones.nota ?? "",
    });
    if (!uso) this.incr("rondas_sin_usage");
  }

  incr(nombre: string, cuanto = 1): void {
    this.contadores[nombre] = (this.contadores[nombre] ?? 0) + cuanto;
  }

  fija(campos: Record<string, unknown>): void {
    Object.assign(this.meta, campos);
  }

  /** USD estimados de todo lo anotado. */
  costeUsd(): number {
    let total = 0;
    for (const r of this.rondas) {
      const tarifa = tarifaDe(r.modelo);
      if (!tarifa) continue;
      const [entrada, cacheada, salida] = tarifa;
      // Los cacheados NO se cobran además de los de entrada: van descontados.
      const noCacheados = Math.max(0, r.prompt - r.cached);
      total +=
        (noCacheados * entrada) / 1e6 +
        (r.cached * cacheada) / 1e6 +
        (r.completion * salida) / 1e6;
    }
    return Math.round(total * 1e6) / 1e6;
  }

  /** El resumen que se guarda con el mensaje y se muestra en los evals. */
  resumen(): Record<string, unknown> {
    const porComponente: Record<string, Record<string, number>> = {};
    const porModelo: Record<string, Record<string, number>> = {};
    const tokens = { ...USO_CERO, total: 0 };

    for (const r of this.rondas) {
      const c = (porComponente[r.componente] ??= {
        rondas: 0,
        prompt: 0,
        cached: 0,
        completion: 0,
        reasoning: 0,
        ms: 0,
        errores: 0,
      });
      c.rondas += 1;
      c.prompt += r.prompt;
      c.cached += r.cached;
      c.completion += r.completion;
      c.reasoning += r.reasoning;
      c.ms += r.ms;
      if (!r.ok) c.errores += 1;

      const m = (porModelo[r.modelo] ??= {
        prompt: 0,
        cached: 0,
        completion: 0,
        reasoning: 0,
      });
      m.prompt += r.prompt;
      m.cached += r.cached;
      m.completion += r.completion;
      m.reasoning += r.reasoning;

      tokens.prompt += r.prompt;
      tokens.cached += r.cached;
      tokens.completion += r.completion;
      tokens.reasoning += r.reasoning;
    }
    tokens.total = tokens.prompt + tokens.completion;

    return {
      ms_total: Date.now() - this.t0,
      rondas: this.rondas.length,
      tokens,
      por_componente: porComponente,
      por_modelo: porModelo,
      cost_usd: this.costeUsd(),
      pricing: ETIQUETA_PRECIOS,
      counters: { ...this.contadores },
      meta: { ...this.meta },
    };
  }

  /** Segundos transcurridos desde que empezó la pregunta. */
  transcurridoS(): number {
    return (Date.now() - this.t0) / 1000;
  }
}
