// Opciones de transporte del chat. No cambian mensajes, herramientas, modelos,
// esfuerzo ni evidencia. OCR e ingesta no activan este perfil.
import type { Telemetria } from "./telemetry";

export interface PerfilChat {
  perfil: "chat";
  tel?: Telemetria;
}

export async function prepararChat(
  kwargs: Record<string, unknown>,
  perfil?: PerfilChat,
): Promise<Record<string, unknown>> {
  if (!perfil || !String(kwargs.model ?? "").startsWith("openai/")) return kwargs;
  const cuerpo = { ...kwargs };
  // El ensayo inicial no mostró una mejora consistente con priority. Se
  // conserva estándar por defecto; prioridad sigue disponible para pruebas.
  const tier = process.env.CHAT_SERVICE_TIER?.trim().toLowerCase() ?? "default";
  if (tier === "priority" && cuerpo.service_tier === undefined) cuerpo.service_tier = "priority";
  if (tier === "default" && cuerpo.service_tier === undefined) cuerpo.service_tier = "default";
  // Sin retención ampliada ni caché de respuestas. Solo ayuda a enrutar un
  // prefijo idéntico a la caché nativa; el proveedor sigue comprobando tokens.
  const cache = !["false", "0", "off"].includes((process.env.CHAT_PROMPT_CACHE_ENABLED ?? "true").toLowerCase());
  if (cache && cuerpo.prompt_cache_key === undefined) {
    const mensajes = Array.isArray(kwargs.messages) ? kwargs.messages : [];
    const fijos = [];
    for (const mensaje of mensajes) {
      if (mensaje?.role !== "system" && mensaje?.role !== "developer") break;
      fijos.push(mensaje);
    }
    if (fijos.length) {
      const bytes = new TextEncoder().encode(JSON.stringify([kwargs.model, fijos]));
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      cuerpo.prompt_cache_key = "rag-chat-v1:" + [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    }
  }
  perfil.tel?.fija({ chat_service_tier_solicitado: cuerpo.service_tier ?? "default" });
  if (cuerpo.prompt_cache_key) perfil.tel?.incr("chat_con_clave_cache");
  return cuerpo;
}

/** Tier realmente servido: pedir priority no garantiza que el proveedor lo conceda. */
export function tierDe(datos: any): string | undefined {
  const tier = datos?.service_tier ?? datos?.provider_metadata?.gateway?.serviceTier ??
    datos?.choices?.[0]?.delta?.provider_metadata?.gateway?.serviceTier;
  return typeof tier === "string" ? tier : undefined;
}

export function anotarTier(tier: string | undefined, perfil?: PerfilChat): void {
  if (!perfil) return;
  const conocido = tier === "priority" || tier === "default" || tier === "flex";
  perfil.tel?.incr(`chat_tier_${conocido ? tier : "no_reportado"}`);
}
