// Cliente del AI Gateway de Vercel. Port de `backend/app/services/openai_client.py`
// y de la política de reintentos de `backend/app/services/embeddings.py`.
//
// Se habla con la API por `fetch` a pelo en vez de con el SDK: el runtime por
// defecto de Convex trae `fetch` y no necesita Node, así que las acciones
// arrancan más rápido y no hay que marcar los ficheros con "use node".
// Comprobado contra el gateway desde Node el 4 sep 2026: chat 200 con
// razonamiento, embeddings 200 con 3072 dimensiones y el stream de SSE con su
// `usage` en el último trozo.
//
// El proveedor es SIEMPRE el gateway, nunca la API de OpenAI directa, y los
// modelos van con el proveedor por delante (`openai/gpt-5.4`).
import { ajustes, exigirClave, type Ajustes } from "./config";

// --- Razonamiento -----------------------------------------------------------
//
// El backend anterior estuvo semanas mandando CERO tokens de razonamiento: una
// nota decía que la API rechazaba `reasoning_effort` junto a function tools y
// se apagó en todo el sistema. Medido de nuevo contra el gateway con los
// kwargs exactos del bucle, funciona, y el efecto es grande: ante una pregunta
// comparativa, sin razonamiento el modelo pedía UNA búsqueda y con esfuerzo
// alto pedía tres, una por término.
//
// Como ya rompió el modo extendido una vez, el parámetro no se manda a ciegas:
// si la API lo rechaza con un 400 que lo nombra, se reintenta sin él y queda
// apagado un rato. El peor caso es volver a la conducta anterior, no perder la
// respuesta.
let _razonamientoRechazadoHasta = 0;
const RAZONAMIENTO_REINTENTO_MS = 10 * 60 * 1000;

/** Los kwargs de razonamiento, o nada si está apagado o lo rechazaron. */
export function razonamiento(esfuerzo?: string | null): {
  reasoning_effort?: string;
} {
  const e = String(esfuerzo ?? "").trim().toLowerCase();
  if (!e || e === "none") return {};
  if (Date.now() < _razonamientoRechazadoHasta) return {};
  return { reasoning_effort: e };
}

/** Si el razonamiento está apagado por un rechazo reciente de la API. */
export function razonamientoRechazado(): boolean {
  return Date.now() < _razonamientoRechazadoHasta;
}

/** Solo para pruebas. */
export function _reiniciarRazonamiento(): void {
  _razonamientoRechazadoHasta = 0;
}

function esRechazoDeRazonamiento(estado: number, cuerpo: string): boolean {
  return estado === 400 && /reasoning/i.test(cuerpo);
}

// --- Errores y reintentos ---------------------------------------------------

export class ErrorGateway extends Error {
  constructor(
    readonly estado: number,
    readonly cuerpo: string,
    readonly reintentable: boolean,
  ) {
    super(`gateway ${estado}: ${cuerpo.slice(0, 300)}`);
    this.name = "ErrorGateway";
  }
}

/** Qué errores NO merecen reintento.
 *
 *  La distinción importa y viene de un incidente real: en septiembre de 2026
 *  la cuenta se quedó sin saldo y la API devolvía 429 con
 *  `credit_balance_exhausted`. Reintentar eso cinco veces con espera
 *  exponencial solo alarga el fallo; hay que propagarlo ya. Un 429 de límite
 *  de ritmo, en cambio, se resuelve esperando. */
function esReintentable(estado: number, cuerpo: string): boolean {
  if (estado === 429) {
    // Saldo agotado o cuota: no se arregla esperando.
    return !/insufficient_quota|credit_balance|billing|exceeded your current quota/i.test(
      cuerpo,
    );
  }
  if (estado === 408 || estado === 409) return true;
  if (estado >= 500) return true;
  // 401, 403 y el resto de 4xx: propagar de inmediato.
  return false;
}

const INTENTOS = 5;
const ESPERA_MAX_MS = 20_000;

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tope de llamadas simultáneas al gateway. En el backend anterior era un
// semáforo de 3 y el "paralelo" del pipeline de evidencia resultaba nominal:
// cinco puntos del plan hacían cola de a tres. Aquí cada pregunta corre en su
// propia acción, así que esto es concurrencia POR PREGUNTA y puede ser más
// generosa; lo que la acota de verdad es el límite de ritmo del gateway.
const MAX_EN_VUELO = 8;
let _enVuelo = 0;
const _cola: Array<() => void> = [];

async function plaza<T>(fn: () => Promise<T>): Promise<T> {
  if (_enVuelo >= MAX_EN_VUELO) {
    await new Promise<void>((r) => _cola.push(r));
  }
  _enVuelo++;
  try {
    return await fn();
  } finally {
    _enVuelo--;
    const siguiente = _cola.shift();
    if (siguiente) siguiente();
  }
}

async function peticion(
  ruta: string,
  cuerpo: unknown,
  a: Ajustes,
  opciones: { stream?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  const clave = exigirClave(a);
  const url = `${a.gatewayBaseUrl.replace(/\/$/, "")}${ruta}`;
  const timeoutMs = opciones.timeoutMs ?? 120_000;

  let ultimo: ErrorGateway | null = null;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clave}`,
        },
        body: JSON.stringify(cuerpo),
        signal: ctrl.signal,
      });
      if (r.ok) return r;
      const texto = await r.text();
      const reintentable = esReintentable(r.status, texto);
      ultimo = new ErrorGateway(r.status, texto, reintentable);
      if (!reintentable || intento === INTENTOS) throw ultimo;
    } catch (exc) {
      if (exc instanceof ErrorGateway) {
        if (!exc.reintentable || intento === INTENTOS) throw exc;
        ultimo = exc;
      } else {
        // Corte de red o timeout: sí se reintenta.
        ultimo = new ErrorGateway(0, String(exc).slice(0, 300), true);
        if (intento === INTENTOS) throw ultimo;
      }
    } finally {
      clearTimeout(reloj);
    }
    await espera(Math.min(ESPERA_MAX_MS, 500 * 2 ** (intento - 1)));
  }
  throw ultimo ?? new ErrorGateway(0, "sin respuesta", false);
}

// --- Chat -------------------------------------------------------------------

export interface UsoTokens {
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
}

export function usoDe(usage: any): UsoTokens {
  const cd = usage?.completion_tokens_details ?? {};
  const pd = usage?.prompt_tokens_details ?? {};
  return {
    prompt: Number(usage?.prompt_tokens ?? 0) || 0,
    cached: Number(pd?.cached_tokens ?? 0) || 0,
    completion: Number(usage?.completion_tokens ?? 0) || 0,
    reasoning: Number(cd?.reasoning_tokens ?? 0) || 0,
  };
}

/** Una llamada a `/chat/completions`, con el fallback de razonamiento.
 *
 *  Si la petición lleva `reasoning_effort` y la API la rechaza con un 400 que
 *  lo nombra, se anota el rechazo, se reintenta UNA vez sin el parámetro y se
 *  devuelve el aviso para que el llamador lo cuente en la telemetría. */
export async function crearCompletion(
  kwargs: Record<string, unknown>,
  a: Ajustes = ajustes(),
): Promise<{ datos: any; razonamientoRechazado: boolean }> {
  return plaza(async () => {
    try {
      const r = await peticion("/chat/completions", kwargs, a);
      return { datos: await r.json(), razonamientoRechazado: false };
    } catch (exc) {
      if (
        !(exc instanceof ErrorGateway) ||
        !("reasoning_effort" in kwargs) ||
        !esRechazoDeRazonamiento(exc.estado, exc.cuerpo)
      ) {
        throw exc;
      }
      _razonamientoRechazadoHasta = Date.now() + RAZONAMIENTO_REINTENTO_MS;
      const sin = { ...kwargs };
      delete sin.reasoning_effort;
      const r = await peticion("/chat/completions", sin, a);
      return { datos: await r.json(), razonamientoRechazado: true };
    }
  });
}

/** Una llamada JSON: devuelve el objeto ya parseado del `content`.
 *
 *  Sin `choices` o con `content` nulo (rechazo, filtro de contenido) LANZA en
 *  vez de devolver `{}`: el llamador tiene que poder distinguir "el modelo
 *  dijo que no hay nada" de "el modelo no respondió". */
export async function completionJson(
  kwargs: Record<string, unknown>,
  a: Ajustes = ajustes(),
): Promise<{
  datos: any;
  usage: UsoTokens;
  modelo: string;
  finishReason: string | null;
  razonamientoRechazado: boolean;
}> {
  const { datos, razonamientoRechazado: rechazado } = await crearCompletion(
    { ...kwargs, response_format: { type: "json_object" } },
    a,
  );
  const choice = datos?.choices?.[0];
  const contenido = choice?.message?.content;
  if (!contenido) throw new Error("respuesta sin contenido");
  return {
    datos: JSON.parse(contenido),
    usage: usoDe(datos?.usage),
    modelo: datos?.model || String(kwargs.model ?? ""),
    finishReason: choice?.finish_reason ?? null,
    razonamientoRechazado: rechazado,
  };
}

/** Trozo de un stream de chat: texto, llamadas a herramienta o el uso final. */
export interface TrozoStream {
  texto?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  finishReason?: string;
  usage?: UsoTokens;
  modelo?: string;
}

/** Streamea `/chat/completions` y va emitiendo los trozos.
 *
 *  El stream se consume aquí y NO se reenvía al navegador: en Convex el agente
 *  escribe el avance en la base y el cliente se resuscribe, que es lo que hace
 *  que una respuesta sobreviva a que se cierre el navegador. */
export async function* streamCompletion(
  kwargs: Record<string, unknown>,
  a: Ajustes = ajustes(),
): AsyncGenerator<TrozoStream> {
  const cuerpo = {
    ...kwargs,
    stream: true,
    stream_options: { include_usage: true },
  };
  const r = await plaza(() => peticion("/chat/completions", cuerpo, a, { stream: true }));
  if (!r.body) throw new Error("el gateway no devolvió cuerpo en el stream");

  const lector = r.body.getReader();
  const dec = new TextDecoder();
  let resto = "";
  // Tope de INACTIVIDAD del stream. `peticion` suelta su AbortController al
  // recibir las cabeceras, así que un stream que se queda mudo a mitad
  // colgaba el `for await` hasta que la acción muriera por la plataforma, y
  // nadie escribía `error` en el mensaje. Lo cazó la revisión adversarial del
  // bucle. 90 s sin un solo trozo es fallo, no una respuesta larga.
  const INACTIVIDAD_MS = 90_000;
  const leerConTope = async () => {
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vence = new Promise<never>((_, rechaza) => {
      reloj = setTimeout(
        () => rechaza(new ErrorGateway(0, `stream sin datos durante ${INACTIVIDAD_MS / 1000} s`, false)),
        INACTIVIDAD_MS,
      );
    });
    try {
      return await Promise.race([lector.read(), vence]);
    } finally {
      clearTimeout(reloj);
    }
  };
  while (true) {
    let paso: ReadableStreamReadResult<Uint8Array>;
    try {
      paso = await leerConTope();
    } catch (exc) {
      try { await lector.cancel(); } catch { /* ya cerrado */ }
      throw exc;
    }
    const { done, value } = paso;
    if (done) break;
    resto += dec.decode(value, { stream: true });
    const lineas = resto.split("\n");
    resto = lineas.pop() ?? "";
    for (const cruda of lineas) {
      const linea = cruda.trim();
      if (!linea.startsWith("data:")) continue;
      const payload = linea.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let d: any;
      try {
        d = JSON.parse(payload);
      } catch {
        continue; // un trozo partido por el medio: el siguiente lo completa
      }
      const trozo: TrozoStream = {};
      if (d.usage) {
        trozo.usage = usoDe(d.usage);
        trozo.modelo = d.model;
      }
      const choice = d.choices?.[0];
      if (choice) {
        if (choice.finish_reason) trozo.finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) trozo.texto = delta.content;
        if (delta?.tool_calls?.length) {
          trozo.toolCalls = delta.tool_calls.map((t: any) => ({
            index: t.index,
            id: t.id,
            name: t.function?.name,
            arguments: t.function?.arguments,
          }));
        }
      }
      if (Object.keys(trozo).length) yield trozo;
    }
  }
}

// --- Embeddings -------------------------------------------------------------

const EMB_MAX_CHARS = 8000;

function prepararTexto(t: string): string {
  return t.replace(/\s*\n\s*/g, " ").trim().slice(0, EMB_MAX_CHARS);
}

/** Vectores de varios textos en UNA petición.
 *
 *  Se manda en lote a propósito: las consultas del plan de evidencia salen
 *  todas juntas, así que son menos peticiones, menos ocasiones de fallo y
 *  menos latencia que N llamadas seguidas. */
export async function embed(
  textos: string[],
  a: Ajustes = ajustes(),
): Promise<{ vectores: number[][]; usage: UsoTokens; modelo: string }> {
  if (!textos.length) {
    return {
      vectores: [],
      usage: { prompt: 0, cached: 0, completion: 0, reasoning: 0 },
      modelo: a.modeloEmbedding,
    };
  }
  const r = await plaza(() =>
    peticion(
      "/embeddings",
      { model: a.modeloEmbedding, input: textos.map(prepararTexto) },
      a,
    ),
  );
  const d = await r.json();
  const vectores: number[][] = (d?.data ?? [])
    .slice()
    .sort((x: any, y: any) => (x.index ?? 0) - (y.index ?? 0))
    .map((x: any) => x.embedding as number[]);
  if (vectores.length !== textos.length) {
    throw new Error(
      `el gateway devolvió ${vectores.length} vectores para ${textos.length} textos`,
    );
  }
  const dims = vectores[0]?.length ?? 0;
  if (dims !== a.dimensiones) {
    throw new Error(
      `el modelo devolvió vectores de ${dims} dimensiones y el índice espera ${a.dimensiones}`,
    );
  }
  return { vectores, usage: usoDe(d?.usage), modelo: d?.model || a.modeloEmbedding };
}

/** Vector de una sola consulta. */
export async function embedConsulta(
  texto: string,
  a: Ajustes = ajustes(),
): Promise<{ vector: number[]; usage: UsoTokens; modelo: string }> {
  const { vectores, usage, modelo } = await embed([texto], a);
  return { vector: vectores[0], usage, modelo };
}
