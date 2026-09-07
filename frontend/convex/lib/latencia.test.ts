import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ajustes } from "./config";
import { Telemetria } from "./telemetry";
import { prepararChat } from "./latencia";
import { crearCompletion, completionJson, streamCompletion, _reiniciarRazonamiento } from "./gateway";

beforeEach(() => { vi.stubEnv("CHAT_SERVICE_TIER", "priority"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); _reiniciarRazonamiento(); });
const perfil = { perfil: "chat" as const };
function entrada() {
  return {
    model: "openai/gpt-5.4",
    messages: [{ role: "system", content: "Cita cada afirmación." }, { role: "user", content: "Pregunta privada" }],
    reasoning_effort: "high",
    temperature: 0,
    tools: [{ type: "function", function: { name: "buscar", parameters: { type: "object" } } }],
  };
}
function fetchFalso(respuestas: Response[]) {
  const cuerpos: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    cuerpos.push(JSON.parse(String(init.body)));
    const r = respuestas.shift();
    if (!r) throw new Error("llamada inesperada");
    return r;
  }));
  return cuerpos;
}
function configuracion() { return { ...ajustes(), gatewayApiKey: "clave-de-prueba" }; }
const json = (extra = {}) => Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], service_tier: "priority", ...extra });

describe("latencia del chat sin cambiar sus decisiones", () => {
  test("el default mantiene estándar mientras se mide el beneficio real de prioridad", async () => {
    vi.unstubAllEnvs();
    const anterior = process.env.CHAT_SERVICE_TIER;
    delete process.env.CHAT_SERVICE_TIER;
    try { expect((await prepararChat(entrada(), perfil)).service_tier).toBe("default"); }
    finally { if (anterior !== undefined) process.env.CHAT_SERVICE_TIER = anterior; }
  });
  test("solo agrega opciones de transporte; no muta ni cambia evidencia, tools o razonamiento", async () => {
    const original = entrada();
    const copia = structuredClone(original);
    const r = await prepararChat(original, perfil);
    expect(original).toEqual(copia);
    const { service_tier, prompt_cache_key, ...resto } = r;
    expect(resto).toEqual(original);
    expect(service_tier).toBe("priority");
    expect(prompt_cache_key).toMatch(/^rag-chat-v1:[a-f0-9]{32}$/);
  });
  test("OCR, ingesta y otros proveedores conservan exactamente su petición", async () => {
    const r = entrada();
    expect(await prepararChat(r)).toBe(r);
    const otro = { ...r, model: "anthropic/claude" };
    expect(await prepararChat(otro, perfil)).toBe(otro);
    expect(fetchFalso([json()])).toHaveLength(0);
    await crearCompletion(r, configuracion());
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(r));
  });
  test("clave por prefijo estático: no incorpora pregunta, evidencia ni borrador privados", async () => {
    const original = entrada();
    const uno = await prepararChat(original, perfil);
    const otro = { ...original, messages: [original.messages[0], { role: "user", content: "Otra pregunta" }] };
    expect((await prepararChat(otro, perfil)).prompt_cache_key).toBe(uno.prompt_cache_key);
    otro.messages[0] = { role: "system", content: "Nueva política" };
    expect((await prepararChat(otro, perfil)).prompt_cache_key).not.toBe(uno.prompt_cache_key);
    expect(uno).not.toHaveProperty("prompt_cache_retention");
  });
  test("rollback por variables, sin tocar modelo ni política de revisión", async () => {
    vi.stubEnv("CHAT_SERVICE_TIER", "default");
    vi.stubEnv("CHAT_PROMPT_CACHE_ENABLED", "false");
    expect(await prepararChat(entrada(), perfil)).toEqual({ ...entrada(), service_tier: "default" });
  });
  test("respeta opciones explícitas y no inventa un prefijo si empieza por datos variables", async () => {
    const r = { ...entrada(), service_tier: "default", prompt_cache_key: "explicita" };
    expect(await prepararChat(r, perfil)).toEqual(r);
    expect(await prepararChat({ model: r.model, messages: [{ role: "user", content: "dato privado" }] }, perfil)).not.toHaveProperty("prompt_cache_key");
  });
  test("JSON usa prioridad y registra el tier concedido, incluso si fue degradado", async () => {
    const cuerpos = fetchFalso([json({ service_tier: "default" })]);
    const tel = new Telemetria();
    const r = await completionJson(entrada(), configuracion(), { ...perfil, tel });
    expect(r.datos).toEqual({ ok: true });
    expect(cuerpos[0]).toMatchObject({ service_tier: "priority", response_format: { type: "json_object" } });
    expect(tel.contadores.chat_tier_default).toBe(1);
    expect(tel.contadores.chat_tier_priority).toBeUndefined();
    expect(tel.resumen().pricing).toContain("no incluye");
  });
  test("fallback previo de razonamiento conserva prioridad y caché", async () => {
    const cuerpos = fetchFalso([new Response("unsupported reasoning_effort", { status: 400 }), json()]);
    const r = await crearCompletion(entrada(), configuracion(), perfil);
    expect(r.razonamientoRechazado).toBe(true);
    expect(cuerpos).toHaveLength(2);
    expect(cuerpos[1]).not.toHaveProperty("reasoning_effort");
    expect(cuerpos[1].service_tier).toBe("priority");
    expect(cuerpos[1].prompt_cache_key).toBe(cuerpos[0].prompt_cache_key);
  });
  test("stream mantiene texto, herramientas y usage; cuenta el tier real una sola vez", async () => {
    const eventos = [
      { choices: [{ delta: { content: "Respuesta", tool_calls: [{ index: 0, id: "t1", function: { name: "buscar", arguments: "{}" } }] } }], service_tier: "priority" },
      { choices: [], usage: { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens: 20 }, service_tier: "priority" },
    ];
    const cuerpos = fetchFalso([new Response(eventos.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n")]);
    const tel = new Telemetria();
    const trozos = [];
    for await (const t of streamCompletion(entrada(), configuracion(), { ...perfil, tel })) trozos.push(t);
    expect(trozos[0]).toMatchObject({ texto: "Respuesta", toolCalls: [{ id: "t1", name: "buscar", arguments: "{}" }] });
    expect(trozos[1].usage?.cached).toBe(1024);
    expect(cuerpos[0].service_tier).toBe("priority");
    expect(tel.contadores.chat_tier_priority).toBe(1);
  });
});
