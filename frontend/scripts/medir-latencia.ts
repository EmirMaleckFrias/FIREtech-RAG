// Prueba opt-in contra el gateway real. Solo datos sintéticos, sin escribir
// documentos, usuarios ni mensajes en Convex. Requiere OPENAI_API_KEY.
// Ejecutar desde frontend: npx vite-node scripts/medir-latencia.ts
import { revisarAntesDePublicar } from "../convex/agente/revisor";
import { verificar } from "../convex/agente/verificador";
import { SYSTEM_PROMPT } from "../convex/agente/prompt";
import { cita, type Fragmento } from "../convex/lib/citas";
import { Telemetria } from "../convex/lib/telemetry";

if (!process.env.OPENAI_API_KEY) throw new Error("Configura OPENAI_API_KEY para esta prueba opt-in");
const f: Fragmento = {
  _id: "sintetico-1", sourceFile: "prueba-sintetica.pdf", page: 1,
  documentType: "pdf", chunkType: "text", section: "Resultados",
  text: "Datos inventados SOLO para probar el software. La cohorte A tuvo 120 participantes, " +
    "un AUC de 0.84 y un seguimiento de 12 meses. La cohorte B tuvo 80 participantes, " +
    "un AUC de 0.78 y un seguimiento de 6 meses. No se midió la mortalidad. " +
    "El estudio fue observacional. No permite inferir causalidad ni eficacia de tratamientos.",
};
const pregunta = "Compara tamaño, AUC y seguimiento de las cohortes A y B. ¿Se midió mortalidad?";
const borrador = `La cohorte A tuvo 120 participantes ${cita(f)}. ` +
  `Su AUC fue 0.99 ${cita(f)}. Su seguimiento fue de 12 meses ${cita(f)}.\n` +
  `La cohorte B tuvo 80 participantes ${cita(f)}. ` +
  `Su AUC fue 0.78 ${cita(f)}. Su seguimiento fue de 6 meses ${cita(f)}.\n` +
  `No se midió la mortalidad ${cita(f)}.`;
const mensajes = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: `${pregunta}\n\nEVIDENCIA DISPONIBLE:\n${cita(f)}\n${f.text}` },
];
for (const tier of ["default", "priority", "priority", "default"]) {
  process.env.CHAT_SERVICE_TIER = tier;
  process.env.CHAT_PROMPT_CACHE_ENABLED = tier === "priority" ? "true" : "false";
  const tel = new Telemetria();
  const rechazo = await verificar(borrador, [f], null, null, tel);
  const detectaError = rechazo.afirmaciones.some((a) => a.texto.includes("0.99") && a.veredicto !== "sostenida");
  if (!detectaError) throw new Error(`El verificador no detectó la cifra inventada (${tier})`);
  const inicio = Date.now();
  const resultado = await revisarAntesDePublicar(pregunta, borrador, mensajes, [f], null, null, 150, tel);
  const publicado = resultado.contenido;
  const conservaDatos = ["120", "80", "12", "6"].every((n) => new RegExp(`\\b${n}\\b`).test(publicado)) &&
    /0[.,]84/.test(publicado) && /0[.,]78/.test(publicado) && /mortalidad/i.test(publicado);
  const correcto = detectaError && conservaDatos && !/0[.,]99/.test(publicado) &&
    !resultado.usoAbstencionSegura && resultado.informe?.ok && resultado.informe?.fidelidad === 1 &&
    resultado.informe?.citas_sin_resolver.length === 0;
  console.log(JSON.stringify({ tier, ms_revision: Date.now() - inicio, correcto,
    revisiones: resultado.revisiones, afirmaciones: resultado.informe?.afirmaciones.length,
    fidelidad: resultado.informe?.fidelidad, counters: tel.contadores,
    rondas: tel.rondas.map(({ componente, modelo, ms, cached, prompt, reasoning }) => ({ componente, modelo, ms, cached, prompt, reasoning })),
  }));
  if (!correcto) throw new Error(`La corrección no superó la comprobación de datos (${tier})`);
}
