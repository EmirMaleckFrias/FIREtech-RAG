// El bucle del agente: la acción que responde una pregunta. Port de
// `run_agent` en `backend/app/services/agent.py` al modelo de Convex.
//
// Lo que cambia respecto al original, y por qué:
//
// - **No hay stream hacia el navegador.** El agente escribe su avance en la
//   fila del mensaje del asistente (`estado`, `plan`, `hops`, `sources`, y al
//   final `content`, `verificacion` y `metrics`) y el cliente se resuscribe.
//   Una respuesta sobrevive a que se cierre el navegador y desaparece la clase
//   de fallos de mensajes a medias que había con el SSE cortado (dos caminos de
//   guardado parcial en routes.py existían solo por eso).
// - **El borrador nunca se publica sin aprobar.** `content` se queda vacío
//   hasta que la barrera de revisión lo aprueba o lo sustituye por la
//   abstención segura. Es la misma garantía que en Python, con menos código:
//   allí había que suprimir los tokens del stream.
// - **La pregunta se clasifica ANTES de buscar.** "¿Qué eres?", "hola" o
//   "gracias" no ejecutan el pipeline ni reciben la orden de declarar
//   ausencia: la revisión adversarial midió que sí lo hacían.
// - **Un solo reloj.** El presupuesto total de la pregunta arranca aquí, antes
//   del planner, y la revisión recibe lo que quede. Una acción de Convex dura
//   600 s, el doble que la función de Vercel, así que el presupuesto del modo
//   extendido vuelve a los 240 s que quería y sobra margen para revisar.
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { ajustes, exigirClave, type Ajustes } from "../lib/config";
import * as gateway from "../lib/gateway";
import { Telemetria } from "../lib/telemetry";
import * as modos from "../lib/modos";
import { fuente, type Fragmento } from "../lib/citas";
import * as planner from "./planner";
import { claveDe as claveDePlan } from "./cachePlan";
import * as evidencia from "./evidencia";
import * as verificador from "./verificador";
import * as revisor from "./revisor";
import * as alcance from "./alcance";
import {
  HERRAMIENTAS,
  INSTRUCCION_SIN_DOCUMENTOS,
  NOMBRE_BUSCAR,
  NOMBRE_INVENTARIO,
  SYSTEM_PROMPT,
  VERSION_PROMPT,
  fuentesPayload,
  textoDeInventario,
} from "./prompt";
import type { FiltrosBusqueda } from "../search/hybrid";

type Mensaje = Record<string, unknown>;

/** Caracteres nuevos de borrador que hacen falta para lanzar otra verificación
 *  anticipada: un párrafo o dos. Menos sería una llamada por frase. */
const MIN_ANTICIPO_CHARS = 700;
/** Cuánto se espera, como mucho, a las verificaciones anticipadas en vuelo
 *  antes de entrar en la barrera. */
const ESPERA_ANTICIPADAS_MS = 15_000;

interface Hop {
  n: number;
  query: string;
  origen: "plan" | "extra";
  plan_item: string;
  evidence_needed: string;
  resultados: number;
  nuevos?: number;
  documentos: string[];
  estado: "cubierto" | "sin_resultados";
  recuperacion: string;
  relevancia_verificada: boolean;
  ms: number;
  /** La búsqueda de este hop está en marcha. Lo llevan los marcadores que se
   *  escriben ANTES de buscar y se apaga al completarlos. Antes esto se
   *  INFERÍA de "recuperación en error, cero resultados y cero ms", y eso
   *  confundía un marcador con un punto cuya búsqueda falló al instante
   *  (medido con un test adversarial: un índice caído devuelve el error en
   *  menos de un milisegundo), que se quedaba pintado como "buscando" hasta
   *  el final del turno. */
  en_curso?: boolean;
  estado_final?: string;
  usado_en_respuesta?: boolean;
}

/** Nombres únicos de documento de una lista de fragmentos, en orden de aparición. */
function documentosUnicos(fragmentos: Fragmento[], max = 8): string[] {
  const vistos: string[] = [];
  for (const ch of fragmentos) {
    const f = fuente(ch);
    if (!vistos.includes(f)) vistos.push(f);
    if (vistos.length >= max) break;
  }
  return vistos;
}

/** El hop de un punto del plan ANTES de buscarlo: la misma marca de "en
 *  curso" que usan los hops extra (recuperación "error", cero resultados,
 *  cero ms), que la interfaz pinta como "buscando" mientras el turno vive y
 *  como "no se pudo comprobar" si el turno cerró así (ver `hopEnCurso` en
 *  `src/lib/mensajes.ts`). Se escribe al empezar y se sustituye por el hop de
 *  verdad en cuanto el punto termina, para que cada parte de la pregunta se
 *  vaya marcando sola en vez de aparecer hecha de golpe. */
function hopMarcador(p: planner.PuntoPlan, n: number): Hop {
  return {
    n,
    query: p.queryEn && p.queryEn !== p.query ? `${p.query} · en: ${p.queryEn}` : p.query,
    origen: "plan",
    plan_item: p.id,
    evidence_needed: p.evidenceNeeded,
    resultados: 0,
    documentos: [],
    estado: "sin_resultados",
    recuperacion: "error",
    relevancia_verificada: false,
    ms: 0,
    en_curso: true,
  };
}

function hopDePunto(p: evidencia.PuntoEvidencia, n: number, origen: "plan" | "extra", etiqueta?: string): Hop {
  return {
    n,
    query: etiqueta ?? (p.queryEn && p.queryEn !== p.query ? `${p.query} · en: ${p.queryEn}` : p.query),
    origen,
    plan_item: p.id === "extra" ? "" : p.id,
    evidence_needed: p.evidenceNeeded,
    resultados: p.fragmentos.length,
    documentos: p.estado === "cubierto" ? documentosUnicos(p.fragmentos) : p.documentosRevisados,
    estado: p.estado,
    recuperacion: p.recuperacion,
    relevancia_verificada: p.relevanciaVerificada,
    ms: Math.round(p.ms),
    // Explícito y siempre presente: este hop ya terminó. TODO hop que escribe
    // el agente lleva `en_curso`, para que la interfaz no tenga que adivinarlo
    // (ver el comentario del campo).
    en_curso: false,
  };
}

/** Clave de una llamada a herramienta para detectar repeticiones exactas.
 *
 *  Ignora `punto` y `limit` (este ya no está en la herramienta, pero un modelo
 *  puede seguir mandándolo): repetir la misma consulta cambiando solo la
 *  etiqueta del punto o el número de resultados no aporta evidencia nueva,
 *  y el patrón degenerado medido en producción quemaba 7 de 8 búsquedas
 *  repitiendo la misma. */
function claveDeLlamada(nombre: string, args: Record<string, unknown>): string {
  const relevantes: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    if (k === "punto" || k === "limit") continue;
    const val = args[k];
    if (val === undefined || val === null || val === "") continue;
    relevantes[k] = typeof val === "string" ? val.trim().toLowerCase() : val;
  }
  return `${nombre}:${JSON.stringify(relevantes)}`;
}

function filtrosDe(args: Record<string, unknown>): FiltrosBusqueda {
  const f: FiltrosBusqueda = {};
  const texto = (k: string) => (typeof args[k] === "string" && String(args[k]).trim()) || undefined;
  if (texto("project_id")) f.projectId = texto("project_id");
  if (texto("document_id")) f.documentId = texto("document_id");
  if (texto("document_type")) f.documentType = texto("document_type");
  if (texto("language")) f.language = texto("language");
  return f;
}

function etiquetaDeLlamada(args: Record<string, unknown>, porDefecto: string): string {
  const partes: string[] = [];
  if (typeof args.semantico === "string" && args.semantico.trim()) partes.push(args.semantico.trim());
  for (const [k, etiqueta] of [
    ["document_type", "tipo"],
    ["language", "idioma"],
    ["project_id", "proyecto"],
    ["document_id", "documento"],
  ] as const) {
    // Mismo recorte que `filtrosDe`: un filtro de espacios no se aplica y
    // tampoco debe aparecer en la etiqueta como si se hubiera aplicado.
    const val = typeof args[k] === "string" ? String(args[k]).trim() : "";
    if (val) partes.push(`${etiqueta}: ${val}`);
  }
  return partes.join(" · ") || porDefecto;
}

/** Resumen auditable del dictamen que corresponde al texto publicado. */
function registrarVerificacion(
  tel: Telemetria,
  informe: verificador.Verificacion | null,
  opciones: { revisionPrevia: boolean; revisiones: number; abstencionSegura: boolean },
): void {
  if (!informe) return;
  const cuenta = (v: string) => informe.afirmaciones.filter((a) => a.veredicto === v).length;
  tel.fija({
    verificacion: {
      afirmaciones: informe.afirmaciones.length,
      sostenidas: cuenta(verificador.SOSTENIDA),
      no_sostenidas: cuenta(verificador.NO_SOSTENIDA),
      // Atribuciones a otra entidad: van dentro de las no sostenidas y además
      // se cuentan aparte, porque son el fallo que las medidas de fidelidad
      // clásicas no ven y el evaluador las mide por separado.
      entidad_distinta: informe.afirmaciones.filter((a) => a.entidad_distinta).length,
      parciales: cuenta(verificador.PARCIAL),
      sin_cita: cuenta(verificador.SIN_CITA),
      sin_verificar: cuenta(verificador.SIN_VERIFICAR),
      citas_sin_resolver: informe.citas_sin_resolver,
      fidelidad: informe.fidelidad,
      ok: informe.ok,
      revision_previa: opciones.revisionPrevia,
      revisiones: opciones.revisiones,
      abstencion_segura: opciones.abstencionSegura,
      cobertura: informe.cobertura,
    },
  });
}

export const correr = internalAction({
  args: {
    messageId: v.id("messages"),
    sessionId: v.id("sessions"),
    userId: v.id("users"),
    texto: v.string(),
    modo: v.string(),
    historial: v.array(v.object({ role: v.string(), content: v.string() })),
  },
  handler: async (ctx, args) => {
    const a = ajustes();
    const tel = new Telemetria();
    const inicio = Date.now();

    // Escribir el avance nunca debe tumbar la respuesta: si la base falla un
    // instante, se sigue y se vuelve a intentar en la siguiente escritura. Las
    // escrituras CRÍTICAS (publicar, o marcar el error) sí se reintentan con
    // espera, porque si la final falla el mensaje se quedaba en "revisando"
    // para siempre sin contenido ni error: lo cazó la revisión adversarial.
    // El turno dejó de ser nuestro: la usuaria lo detuvo (`mensajes.detener`)
    // o borró la conversación. Se distingue de "la escritura falló" a
    // propósito: un fallo transitorio de la base se reintenta y el trabajo
    // sigue, pero un turno abandonado no se vuelve a tocar.
    let abandonado = false;
    const actualizar = async (cambios: Record<string, unknown>, critico = false): Promise<boolean> => {
      if (abandonado) return false;
      const intentos = critico ? 4 : 1;
      for (let i = 1; i <= intentos; i++) {
        try {
          const sigue = await ctx.runMutation(internal.mensajes.actualizarTurno, {
            messageId: args.messageId,
            cambios,
          });
          if (!sigue) {
            abandonado = true;
            return false;
          }
          return true;
        } catch (exc) {
          console.error(`No se pudo escribir el avance del mensaje (intento ${i}/${intentos})`, args.messageId, exc);
          if (i < intentos) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
        }
      }
      return false;
    };

    try {
      exigirClave(a);
      const modo = modos.resolver(args.modo, a);
      tel.fija({ prompt_version: VERSION_PROMPT, model: a.modelo, modo: modo.nombre });
      const limiteTotalMs = a.presupuestoTotalS * 1000;
      const restanteS = () => Math.max(0, (limiteTotalMs - (Date.now() - inicio)) / 1000);

      // 0. Caché del plan: la misma pregunta reutiliza la misma clase y el
      //    mismo plan. Es lo que hace que la recuperación sea determinista de
      //    verdad: sin esto el planner redactaba las consultas distinto en cada
      //    corrida y cambiaba la evidencia (medido: huellas distintas con
      //    fidelidad idéntica). Solo se cachean preguntas SIN historial, porque
      //    una repregunta ("y en la otra cohorte?") depende de la conversación.
      const cacheable = args.historial.length === 0;
      const clavePlan = claveDePlan(args.texto, a.modelo, VERSION_PROMPT);
      let enCache: { items: unknown[]; preguntaEn: string; clase: string | null; variantes?: string[]; documento?: string } | null = null;
      if (cacheable) {
        try {
          enCache = await ctx.runQuery(internal.agente.cachePlan.leer, { clave: clavePlan, ahora: Date.now() });
        } catch (exc) {
          console.warn("caché del plan no disponible", exc);
        }
      }
      tel.fija({ plan_en_cache: Boolean(enCache) });

      // 1. Clasificar ANTES de buscar. Solo lo documental entra al pipeline.
      // Con la clase en caché (preguntas sin historial) no hay referencia que
      // resolver: la consulta es la pregunta. Con historial, el clasificador
      // devuelve además la pregunta reescrita para que se entienda sola, y
      // ESA es la que se busca; lo que se redacta sigue siendo el texto
      // literal de quien pregunta (ver planner.Clasificacion).
      // Con la clase en caché, la versión inglesa del ancla también está en
      // caché (la guardó el planificador o el clasificador de la primera vez).
      // Sin historial la consulta que se planifica es la literal, así que el
      // planificador no necesita esperar al clasificador: se lanzan a la vez y
      // se ahorran los 3 a 5 s del clasificador (medido el 8 sep 2026). Si la
      // clase resulta no ser documental, el plan se desecha; una llamada de
      // más en un saludo es barata comparada con un turno documental de tres
      // minutos. Con historial no se puede: el planificador necesita la
      // consulta autónoma que devuelve el clasificador.
      const planEnCache = Boolean(enCache && Array.isArray(enCache.items) && enCache.items.length);
      const planAnticipado =
        cacheable && (enCache?.clase ?? null) === null && modo.planifica && !planEnCache
          ? planner.planificar(args.texto, [], a.maxConsultasPlan, tel)
          : null;
      const clasificacion: planner.Clasificacion =
        (enCache?.clase ?? null) !== null
          ? { clase: enCache!.clase as planner.Clase, consulta: args.texto, consultaEn: enCache!.preguntaEn ?? "", documento: enCache!.documento ?? "" }
          : await planner.clasificar(args.texto, args.historial, tel);
      const clase = clasificacion.clase;
      const consulta = clasificacion.consulta;
      tel.fija({ clase, consulta_reformulada: planner.clave(consulta) !== planner.clave(args.texto) });
      if (clase !== "documental") {
        const contenido = await responderSinDocumentos(a, args.texto, args.historial, tel);
        await actualizar({
          estado: "listo",
          content: contenido,
          sources: [],
          hops: [],
          plan: [],
          verificacion: undefined,
          metrics: tel.resumen(),
        });
        return;
      }

      // 1b. Alcance: si la pregunta pide limitarse a un documento, se resuelve
      //     la pista contra los documentos de la persona y se convierte en el
      //     filtro `documentId` de TODAS las búsquedas del turno (plan y
      //     extras). Ver agente/alcance.ts para las reglas y el caso medido.
      const pistaDocumento = (clasificacion.documento ?? "").trim();
      let alcanceTurno: alcance.Alcance = { tipo: "sin_pista" };
      if (pistaDocumento) {
        try {
          const nombrados = await ctx.runQuery(internal.agente.alcance.documentosDe, { propietario: args.userId });
          alcanceTurno = alcance.elegirDocumento(pistaDocumento, nombrados);
          // La pista no encaja con ningún NOMBRE, pero puede describir el
          // documento por su tema ("el PDF de sistemas eléctricos y
          // electrónicos de aeronaves", medido el 9 sep 2026: el fichero se
          // llama `--M6U1_PDF.pdf` y no tiene título). Se pregunta al índice
          // léxico, que es quien sabe de qué habla cada documento, y solo se
          // acota si uno DOMINA la muestra.
          if (alcanceTurno.tipo === "desconocido") {
            const conteos = await ctx.runQuery(internal.agente.alcance.documentosPorContenido, {
              propietario: args.userId,
              pista: pistaDocumento,
            });
            const id = alcance.dominante(conteos);
            const doc = id ? nombrados.find((d) => String(d.id) === id) : undefined;
            if (doc) {
              alcanceTurno = {
                tipo: "elegido",
                id: doc.id,
                nombre: (doc.titulo ?? "").trim() || doc.fileName,
                generico: false,
                porContenido: true,
              };
              tel.incr("alcance_por_contenido");
            }
          }
        } catch (exc) {
          console.warn("no se pudieron listar los documentos para el alcance", exc);
        }
        tel.fija({
          alcance_pista: pistaDocumento,
          alcance: alcanceTurno.tipo,
          alcance_documento: alcanceTurno.tipo === "elegido" ? alcanceTurno.nombre : null,
        });
      }
      const documentoElegido = alcanceTurno.tipo === "elegido" ? alcanceTurno : null;
      // Filtros vigentes para las búsquedas del turno. Se vacían si la
      // búsqueda acotada no encuentra nada (ver el paso 3).
      let filtrosAlcance: FiltrosBusqueda = documentoElegido ? { documentId: String(documentoElegido.id) } : {};
      const alcancePublicable = (encontrado: boolean) =>
        pistaDocumento
          ? {
              pista: pistaDocumento,
              documento: documentoElegido?.nombre ?? null,
              candidatos: alcanceTurno.tipo === "ambiguo" ? alcanceTurno.candidatos : undefined,
              por_contenido: documentoElegido?.porContenido === true ? true : undefined,
              encontrado,
            }
          : undefined;

      // 2. Plan de evidencia. El ancla e0 es SIEMPRE la pregunta literal.
      await actualizar({ estado: "buscando", alcance: alcancePublicable(true) });
      if (abandonado) return;
      let items: planner.PuntoPlan[] = [];
      // El inglés del ancla sale del clasificador cuando no corre el
      // planificador (modo normal): antes e0 se buscaba una sola vez, en
      // español, contra un corpus en inglés. El planificador, si corre, lo
      // sustituye por el suyo.
      let preguntaEn = clasificacion.consultaEn ?? "";
      let variantes: string[] = [];
      if (modo.planifica) {
        if (enCache && Array.isArray(enCache.items) && enCache.items.length) {
          items = enCache.items as planner.PuntoPlan[];
          preguntaEn = enCache.preguntaEn || preguntaEn;
          variantes = enCache.variantes ?? [];
          tel.incr("plan_cache_hits");
          void ctx.runMutation(internal.agente.cachePlan.contarUso, { clave: clavePlan }).catch(() => undefined);
        } else {
          const r = planAnticipado ? await planAnticipado : await planner.planificar(consulta, args.historial, a.maxConsultasPlan, tel);
          items = r.items;
          preguntaEn = r.preguntaEn || preguntaEn;
          variantes = r.variantesPregunta ?? [];
          if (cacheable && items.length) {
            try {
              await ctx.runMutation(internal.agente.cachePlan.guardar, {
                clave: clavePlan, pregunta: args.texto, modelo: a.modelo, version: VERSION_PROMPT,
                clase, items, preguntaEn, variantes, documento: pistaDocumento,
              });
            } catch (exc) {
              console.warn("no se pudo guardar el plan en caché", exc);
            }
          }
        }
      } else if (cacheable && !enCache) {
        // En modo normal no hay plan, pero la clase y el inglés del ancla sí
        // vale la pena recordarlos.
        void ctx
          .runMutation(internal.agente.cachePlan.guardar, {
            clave: clavePlan, pregunta: args.texto, modelo: a.modelo, version: VERSION_PROMPT,
            clase, items: [], preguntaEn, variantes: [], documento: pistaDocumento,
          })
          .catch(() => undefined);
      }
      const plan = planner.conAncla(consulta, preguntaEn, items, variantes);
      const planPublicable = () =>
        plan.map((p) => ({
          id: p.id,
          query: p.query,
          query_en: p.queryEn,
          evidence_needed: p.evidenceNeeded,
          ...(p.variantes?.length ? { variantes: p.variantes } : {}),
        }));
      await actualizar({ plan: planPublicable() });

      // 3. Toda la evidencia del plan, en paralelo, antes del primer turno del
      //    modelo. Aquí es donde la variación entre corridas deja de existir:
      //    la misma pregunta recupera la misma evidencia.
      const limiteEvidenciaMs = Math.min(a.prefetchTimeoutS * 1000, restanteS() * 1000);
      // Los hops del plan se escriben en cuanto cada punto termina, no todos
      // al final: primero un marcador por punto (la interfaz los pinta
      // "buscando") y luego el hop de verdad según llegan. Las escrituras van
      // en serie para que dos puntos que acaban a la vez no lleguen a la base
      // en el orden contrario y una parte ya hecha vuelva a "buscando".
      const hops: Hop[] = plan.map((p, i) => hopMarcador(p, i + 1));
      let cola: Promise<void> = Promise.resolve();
      const enSerie = (f: () => Promise<unknown>): void => {
        cola = cola.then(
          () => f().then(() => undefined),
          () => undefined,
        );
      };
      const marcarPunto = (punto: evidencia.PuntoEvidencia, i: number) => {
        hops[i] = hopDePunto(punto, i + 1, "plan");
        enSerie(() => actualizar({ hops: [...hops] }));
      };
      await actualizar({ hops: [...hops] });
      if (abandonado) return;
      let ev = await evidencia.ejecutarPlan(
        ctx,
        args.userId,
        plan,
        modo,
        filtrosAlcance,
        tel,
        limiteEvidenciaMs,
        { alTerminarPunto: marcarPunto },
      );
      // La búsqueda acotada al documento pedido no encontró NADA: puede que
      // el documento no hable de eso, o que la pista se resolviera al
      // documento equivocado. En los dos casos lo honesto es buscar en todos
      // y decir en la respuesta que lo que sale no es de ese documento, en
      // vez de una abstención que la usuaria no puede distinguir de "el
      // documento no lo dice".
      let alcanceEncontrado = true;
      if (documentoElegido && ev.acumulado.size === 0 && !ev.puntos.some((p) => p.recuperacion === "error")) {
        tel.incr("alcance_sin_resultados");
        alcanceEncontrado = false;
        filtrosAlcance = {};
        // Se vuelve a buscar: las partes ya marcadas vuelven a "buscando",
        // porque lo que se enseñaba (nada en ese documento) ya no es lo que
        // se va a responder.
        plan.forEach((p, i) => { hops[i] = hopMarcador(p, i + 1); });
        enSerie(() => actualizar({ hops: [...hops] }));
        ev = await evidencia.ejecutarPlan(
          ctx, args.userId, plan, modo, {}, tel, Math.min(limiteEvidenciaMs, restanteS() * 1000),
          { alTerminarPunto: marcarPunto },
        );
      }
      const acumulado = new Map<string, Fragmento>(ev.acumulado);
      const mapa: Record<string, string[]> = { ...ev.mapa };
      const grados: Record<string, string> = { ...ev.grados };
      // El estado final de los hops del plan es el del retorno, no el de los
      // avisos: un punto que venció recibió un `ms` provisional, y un aviso
      // pudo perderse. Y se espera a que la cola vacíe ANTES de la escritura
      // de abajo, para que ninguna escritura de avance la pise.
      ev.puntos.forEach((p, i) => { hops[i] = hopDePunto(p, i + 1, "plan"); });
      await cola;
      tel.incr("hops_plan", ev.puntos.length);
      tel.incr("puntos_sin_resultados", ev.puntos.filter((p) => p.estado === "sin_resultados").length);
      // Los ids y sus grados van a la telemetría para poder MEDIR el
      // determinismo entre corridas (solape de conjuntos) y atribuir la
      // variación que quede al calificador o a la recuperación.
      // Y los candidatos que trajo cada búsqueda ANTES del calificador: con
      // ellos el evaluador mide la recuperación por separado (si la evidencia
      // esperada no estaba entre los candidatos falló la búsqueda; si estaba y
      // no llegó a las fuentes, falló el calificador). Los hops extra se
      // añaden bajo "extra:<n>" según llegan.
      const recuperacion: Record<string, evidencia.CandidatoRecuperado[]> = Object.fromEntries(
        ev.puntos.map((p) => [p.id, p.candidatos ?? []]),
      );
      tel.fija({
        huella_evidencia: ev.huella,
        evidencia_ids: [...acumulado.keys()].sort(),
        evidencia_grados: Object.fromEntries([...acumulado.keys()].sort().map((id) => [id, grados[id] ?? ""])),
        recuperacion,
      });
      const fuentes = () => fuentesPayload(acumulado.values(), mapa, grados);
      await actualizar({ hops, sources: fuentes(), alcance: alcancePublicable(alcanceEncontrado) });
      if (abandonado) return;

      // Lo que el redactor tiene que saber del alcance. Va como mensaje de
      // sistema DESPUÉS de la evidencia, en el canal de instrucciones y no en
      // el de datos.
      const notaAlcance = notaDeAlcance(pistaDocumento, alcanceTurno, alcanceEncontrado);

      // 4. Los mensajes: prompt, modo, historial, pregunta y la evidencia como
      //    intercambio de herramientas sintético (el formato que el modelo ya
      //    sabe leer y que la corrección del revisor reutiliza).
      const mensajes: Mensaje[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: modo.instruccion },
        ...args.historial.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: args.texto },
        ...evidencia.mensajesSinteticos(ev, plan),
        ...(notaAlcance ? [{ role: "system", content: notaAlcance } as Mensaje] : []),
      ];

      // 5. Redacción, con búsquedas extra acotadas.
      // Detenida antes de redactar: no se gasta ni una llamada más.
      await actualizar({ estado: "redactando" });
      if (abandonado) return;

      // Verificación ANTICIPADA: el borrador se juzga por párrafos según llega
      // por el stream, en vez de esperar a que el redactor termine. Medido en
      // producción el 8 sep 2026: redacción de 95 a 106 s seguida de una
      // verificación de 40 a 114 s, las dos en serie. La misma frase con la
      // misma cita y el mismo apartado recibe el mismo veredicto la juzgue
      // quien la juzgue (`claveDeAfirmacion`), así que juzgarla antes no cambia
      // nada del dictamen: la barrera arranca con estos veredictos y solo
      // pregunta por la cola. Se corta en párrafos completos ("\n\n") para que
      // cada frase lleve ya su cita; lo que quede sin cita en un parcial es un
      // veredicto determinista que no se guarda, y se recalcula al final.
      const requerida: Record<string, string> = Object.fromEntries(
        plan.map((p) => [p.id, p.evidenceNeeded]),
      );
      const conocidos = new Map<string, verificador.Afirmacion>();
      // El avance dentro de una fase, en una frase para la usuaria. Solo se
      // escribe cuando cambia: cada escritura es una mutación.
      let ultimoProgreso = "";
      let enBarrera = false;
      const escribirProgreso = async (texto: string) => {
        if (texto === ultimoProgreso || abandonado) return;
        ultimoProgreso = texto;
        await actualizar({ progreso: texto });
      };
      const anticipadas: Promise<unknown>[] = [];
      let verificadoHasta = 0;
      const anticipar = (borradorParcial: string) => {
        if (!a.habilitarVerificacion) return;
        const corte = borradorParcial.lastIndexOf("\n\n");
        if (corte <= verificadoHasta || corte - verificadoHasta < MIN_ANTICIPO_CHARS) return;
        verificadoHasta = corte;
        tel.incr("verificaciones_anticipadas");
        anticipadas.push(
          verificador
            .verificar(borradorParcial.slice(0, corte), [...acumulado.values()], requerida, mapa, tel, {
              veredictosPrevios: conocidos,
              pregunta: consulta,
            })
            .then((inf) => {
              for (const [k, af] of verificador.veredictosDe(inf)) conocidos.set(k, af);
              // Una anticipada que aterriza ya en la barrera no debe pisar el
              // texto de la barrera con el de la redacción.
              if (!enBarrera) void escribirProgreso(textoDeProgresoRedactando(conocidos.size));
            })
            .catch((exc: unknown) => console.warn("verificación anticipada fallida", String(exc).slice(0, 120))),
        );
      };
      let hopsExtra = 0;
      let hopsSinAvance = 0;
      // Las consultas del plan ya se ejecutaron: repetirlas, en cualquiera de
      // sus dos idiomas, no aporta nada y gastaría la única extra del modo.
      const ejecutadas = new Set<string>(
        plan.flatMap((p) => [
          claveDeLlamada(NOMBRE_BUSCAR, { semantico: p.query }),
          ...(p.queryEn ? [claveDeLlamada(NOMBRE_BUSCAR, { semantico: p.queryEn })] : []),
          ...(p.variantes ?? []).map((vr) => claveDeLlamada(NOMBRE_BUSCAR, { semantico: vr })),
        ]),
      );
      let contenido = "";

      const motivoDeParada = (): string | null => {
        if (modo.maxHopsExtra && hopsExtra >= modo.maxHopsExtra) {
          return `tope de ${modo.maxHopsExtra} búsquedas extra`;
        }
        if (modo.maxHopsSinAvance && hopsSinAvance >= modo.maxHopsSinAvance) {
          return `${hopsSinAvance} búsquedas seguidas sin encontrar nada nuevo`;
        }
        const transcurrido = (Date.now() - inicio) / 1000;
        if (modo.presupuestoS && transcurrido >= modo.presupuestoS) {
          return `tiempo agotado (${Math.round(transcurrido)} s)`;
        }
        // Reservar siempre sitio para la barrera de revisión.
        if (restanteS() < 60) return "queda poco tiempo para revisar la respuesta";
        return null;
      };

      while (true) {
        const motivo = motivoDeParada();
        const forzar = motivo !== null;
        if (forzar && hopsExtra) {
          // El modelo tiene que saber que se acabó el presupuesto, para que
          // responda con lo que tiene y diga qué le falta, en vez de creer
          // que decidió parar él.
          mensajes.push({
            role: "system",
            content:
              `Se acabó el presupuesto de búsquedas (${motivo}). Responde ya con ` +
              "la evidencia que tienes y di explícitamente qué parte de la " +
              "pregunta te quedó sin cubrir.",
          });
        }
        const kwargs: Record<string, unknown> = {
          model: a.modelo,
          temperature: a.temperatura,
          messages: mensajes,
          tools: HERRAMIENTAS,
          tool_choice: forzar ? "none" : "auto",
          ...gateway.razonamiento(modo.esfuerzo),
        };
        if (!forzar) kwargs.parallel_tool_calls = false;

        const t0 = Date.now();
        let texto = "";
        const llamadas = new Map<number, { id: string; name: string; arguments: string }>();
        let usage: gateway.UsoTokens | null = null;
        let modeloRonda = a.modelo;
        let finish: string | null = null;
        try {
          for await (const trozo of gateway.streamCompletion(kwargs, a, { perfil: "chat", tel })) {
            if (trozo.usage) {
              usage = trozo.usage;
              if (trozo.modelo) modeloRonda = trozo.modelo;
            }
            if (trozo.finishReason) finish = trozo.finishReason;
            if (trozo.texto) {
              texto += trozo.texto;
              anticipar(texto);
            }
            for (const tc of trozo.toolCalls ?? []) {
              const e = llamadas.get(tc.index) ?? { id: "", name: "", arguments: "" };
              if (tc.id) e.id = tc.id;
              if (tc.name) e.name = tc.name;
              if (tc.arguments) e.arguments += tc.arguments;
              llamadas.set(tc.index, e);
            }
          }
        } catch (exc) {
          tel.anota("agente", modeloRonda, usage, {
            ms: Date.now() - t0,
            ok: false,
            nota: String(exc).slice(0, 160),
          });
          throw exc;
        }
        tel.anota("agente", modeloRonda, usage, {
          ms: Date.now() - t0,
          finishReason: finish,
          nota: forzar ? `final forzado: ${motivo}` : `tool_calls=${llamadas.size}`,
        });
        if (gateway.razonamientoRechazado()) tel.incr("razonamiento_rechazado");
        if (forzar) tel.incr("forced_final");

        if (llamadas.size && !forzar) {
          const ordenadas = [...llamadas.entries()].sort((x, y) => x[0] - y[0]).map(([, tc]) => tc);
          mensajes.push({
            role: "assistant",
            content: texto || null,
            tool_calls: ordenadas.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const tc of ordenadas) {
            let argumentos: Record<string, unknown> = {};
            try {
              const crudo: unknown = JSON.parse(tc.arguments || "{}");
              // "null", "[]" o "3" son JSON válido y no son argumentos: sin esta
              // guarda, Object.keys(null) tumbaba la respuesta entera.
              argumentos =
                crudo && typeof crudo === "object" && !Array.isArray(crudo)
                  ? (crudo as Record<string, unknown>)
                  : {};
            } catch {
              argumentos = {};
            }
            const clave = claveDeLlamada(tc.name, argumentos);
            if (ejecutadas.has(clave)) {
              // Repetición exacta: ni se ejecuta ni cuenta como búsqueda, pero
              // SÍ como ronda sin avance, o un modelo que insiste en repetirse
              // solo lo pararía el reloj (medido: 61 rondas en modo normal).
              tel.incr("llamadas_repetidas");
              hopsSinAvance += 1;
              mensajes.push({
                role: "tool",
                tool_call_id: tc.id,
                content:
                  "Esta llamada es IDÉNTICA a una que ya está en esta pregunta: sus " +
                  "resultados están arriba. Cambia los parámetros o responde con lo " +
                  "que ya tienes.",
              });
              continue;
            }
            ejecutadas.add(clave);

            if (tc.name === NOMBRE_INVENTARIO) {
              // El inventario no cuenta como búsqueda extra ni como "sin
              // avance": lista los documentos en lugar de recuperar fragmentos.
              const t1 = Date.now();
              let contenidoTool: string;
              let inventarioOk = true;
              try {
                const inv = await ctx.runQuery(internal.search.inventario.inventario, {
                  propietario: args.userId,
                });
                contenidoTool = textoDeInventario(inv);
              } catch (exc) {
                inventarioOk = false;
                tel.incr("hops_con_error");
                contenidoTool = `Error al consultar el inventario: ${String(exc).slice(0, 200)}`;
              }
              hops.push({
                n: hops.length + 1,
                query: "inventario de documentos",
                origen: "extra",
                plan_item: "",
                evidence_needed: "",
                resultados: 0,
                documentos: [],
                estado: inventarioOk ? "cubierto" : "sin_resultados",
                recuperacion: inventarioOk ? "hibrida" : "error",
                relevancia_verificada: inventarioOk,
                ms: Date.now() - t1,
                en_curso: false,
              });
              mensajes.push({ role: "tool", tool_call_id: tc.id, content: contenidoTool });
              await actualizar({ hops });
              continue;
            }

            if (modo.maxHopsExtra && hopsExtra >= modo.maxHopsExtra) {
              // Varias tool calls en la MISMA ronda: `parallel_tool_calls:
              // false` es una petición, no una garantía, y el tope solo se
              // miraba entre rondas.
              tel.incr("extras_rechazadas_por_tope");
              mensajes.push({
                role: "tool",
                tool_call_id: tc.id,
                content:
                  `Tope de búsquedas extra del modo alcanzado (${modo.maxHopsExtra}). ` +
                  "Responde con la evidencia que ya tienes y declara lo que falte.",
              });
              continue;
            }
            hopsExtra += 1;
            tel.incr("hops_extra");
            const consulta = String(argumentos.semantico ?? "").trim();
            const puntoDeclarado = String(argumentos.punto ?? "").trim();
            const puntoDelPlan = plan.find((p) => p.id === puntoDeclarado);
            const punto = puntoDelPlan ? puntoDelPlan.id : "extra";
            // El alcance manda sobre lo que el modelo pida: una búsqueda extra
            // no puede salirse del documento al que la pregunta se limitó.
            const filtros = { ...filtrosDe(argumentos), ...filtrosAlcance };
            const hop: Hop = {
              n: hops.length + 1,
              query: etiquetaDeLlamada(argumentos, args.texto),
              origen: "extra",
              plan_item: puntoDelPlan ? puntoDelPlan.id : "",
              evidence_needed: puntoDelPlan?.evidenceNeeded ?? "",
              resultados: 0,
              documentos: [],
              estado: "sin_resultados",
              recuperacion: "error",
              relevancia_verificada: false,
              ms: 0,
              en_curso: true,
            };
            hops.push(hop);
            await actualizar({ hops });

            let contenidoTool: string;
            if (!consulta) {
              contenidoTool = "Falta una consulta semántica para buscar en los documentos.";
              hopsSinAvance += 1;
            } else {
              const t1 = Date.now();
              let resultado: evidencia.PuntoEvidencia | null = null;
              let aviso = "";
              // Con tope: `buscarYCalificar` no tiene reloj propio, y una
              // búsqueda colgada retenía la acción hasta que la plataforma la
              // mataba sin que nadie escribiera `error`.
              const topeExtraMs = Math.max(5_000, Math.min(a.prefetchTimeoutS * 1000, (restanteS() - 60) * 1000));
              const conTopeExtra = <T,>(p: Promise<T>): Promise<T> =>
                new Promise<T>((resolver, rechazar) => {
                  const reloj = setTimeout(
                    () => rechazar(new Error(`la búsqueda extra superó ${Math.round(topeExtraMs / 1000)} s`)),
                    topeExtraMs,
                  );
                  p.then((v) => { clearTimeout(reloj); resolver(v); }, (e) => { clearTimeout(reloj); rechazar(e); });
                });
              try {
                resultado = await conTopeExtra(evidencia.buscarYCalificar(
                  ctx, args.userId, consulta, puntoDelPlan?.evidenceNeeded ?? consulta, punto, modo, filtros, tel,
                ));
                // Un filtro exacto sobre un valor que no existe devuelve cero
                // sin decir por qué, y el modelo concluye que el documento no
                // está. Pasó en producción con `idioma: es`: cuatro búsquedas
                // vacías sobre una colección que SÍ tenía el documento. Si los
                // filtros dejan la búsqueda vacía se repite sin ellos y se
                // avisa: recuperar con un aviso es honesto, devolver cero en
                // silencio no.
                // Se relajan SOLO los filtros que puso el modelo: el del
                // alcance (el documento al que la pregunta pidió limitarse) se
                // mantiene, y el corpus de la persona no se relaja nunca.
                const propios = filtrosDe(argumentos);
                if (!resultado.fragmentos.length && Object.keys(propios).length) {
                  const sinFiltros = await conTopeExtra(evidencia.buscarYCalificar(
                    ctx, args.userId, consulta, puntoDelPlan?.evidenceNeeded ?? consulta, punto, modo, filtrosAlcance, tel,
                  ));
                  if (sinFiltros.fragmentos.length) {
                    const detalle = Object.entries(propios).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(", ");
                    aviso =
                      `AVISO: con los filtros que pusiste (${detalle}) no había NINGÚN ` +
                      "fragmento, así que la búsqueda se repitió SIN filtros y esto es lo " +
                      "que salió. Esos valores no existen en el índice: no vuelvas a " +
                      "usarlos y no concluyas nada de que no dieran resultado.\n\n";
                    resultado = sinFiltros;
                  }
                }
              } catch (exc) {
                console.warn(`${tc.name} falló (búsqueda extra ${hopsExtra}):`, exc);
                tel.incr("hops_con_error");
              }
              hop.ms = Date.now() - t1;

              if (!resultado) {
                contenidoTool = "Error al ejecutar la búsqueda: no se pudo comprobar este punto.";
                hopsSinAvance += 1;
              } else {
                let nuevos = 0;
                for (const ch of resultado.fragmentos) {
                  if (!acumulado.has(ch._id)) {
                    acumulado.set(ch._id, ch);
                    nuevos += 1;
                  }
                  const lista = (mapa[ch._id] ??= []);
                  if (!lista.includes(punto)) lista.push(punto);
                }
                // El grado lo pone la calificación de ESTA búsqueda; el del
                // plan solo si esta no lo trae (regresión frente al Python,
                // cazada en la revisión adversarial).
                Object.assign(grados, Object.fromEntries(
                  resultado.fragmentos.map((ch) => [
                    ch._id, resultado!.grados?.[ch._id] ?? ev.grados[ch._id] ?? grados[ch._id] ?? "",
                  ]),
                ));
                hopsSinAvance = nuevos ? 0 : hopsSinAvance + 1;
                Object.assign(hop, hopDePunto(resultado, hop.n, "extra", hop.query), { nuevos, plan_item: hop.plan_item });
                recuperacion[`extra:${hop.n}`] = resultado.candidatos ?? [];
                tel.fija({ recuperacion });
                if (resultado.estado === "sin_resultados") {
                  const revisados = resultado.documentosRevisados.length
                    ? ` Los documentos de los que salían los candidatos eran: ${resultado.documentosRevisados.join("; ")}.`
                    : "";
                  contenidoTool = resultado.recuperacion === "error"
                    ? "La búsqueda no se pudo completar (fallo de recuperación). No concluyas que el dato no existe: di que no pudiste comprobarlo."
                    : `Se revisaron los candidatos más parecidos y ninguno contiene información sobre esto.${revisados} Si alguno de ellos ES lo que te pidieron, vuelve a buscar con sus propias palabras; si no, di que no lo encuentras en los documentos.`;
                } else {
                  const cabecera = resultado.relevanciaVerificada
                    ? ""
                    : "AVISO: no se pudo verificar la relevancia de estos fragmentos, así que puede haber alguno que no venga al caso. Cita solo lo que de verdad responda a la pregunta.\n\n";
                  // Con el grado por fragmento, igual que ven los puntos del plan.
                  contenidoTool = aviso + cabecera + evidencia.formatearResultados(resultado.fragmentos, resultado.grados ?? null);
                }
              }
            }
            mensajes.push({ role: "tool", tool_call_id: tc.id, content: contenidoTool });
            await actualizar({ hops, sources: fuentes() });
          }
          continue;
        }

        contenido = texto;
        break;
      }

      // 6. Barrera de fidelidad. El borrador sigue privado hasta aquí.
      enBarrera = true;
      ultimoProgreso = textoDeProgresoRevisando(conocidos.size);
      await actualizar({ estado: "revisando", progreso: ultimoProgreso });
      if (abandonado) return;
      // Las verificaciones anticipadas que sigan en vuelo están a punto de
      // terminar: se esperan un poco, no indefinidamente (una colgada no
      // puede retener la barrera; lo que no llegue se juzga otra vez).
      if (anticipadas.length) {
        await Promise.race([
          Promise.allSettled(anticipadas),
          new Promise((r) => setTimeout(r, ESPERA_ANTICIPADAS_MS)),
        ]);
        tel.fija({ veredictos_anticipados: conocidos.size });
      }
      const fragmentos = [...acumulado.values()];
      let informe: verificador.Verificacion | null = null;
      let revisiones = 0;
      let abstencionSegura = false;
      const revisionPrevia = a.habilitarVerificacion && a.habilitarRevisionPrevia;
      if (revisionPrevia) {
        // La consulta autónoma, no el texto literal: en una repregunta ("¿y en
        // la otra cohorte?") la literal no nombra la entidad y el juez no
        // podría comprobarla. Sin historial son la misma cadena.
        const r = await revisor.revisarAntesDePublicar(
          consulta, contenido, mensajes, fragmentos, requerida, mapa, restanteS(), tel,
          {
            veredictosIniciales: conocidos,
            alAvanzar: (evento) => void escribirProgreso(textoDeProgreso(evento, conocidos.size)),
          },
        );
        contenido = r.contenido;
        informe = r.informe;
        revisiones = r.revisiones;
        abstencionSegura = r.usoAbstencionSegura;
        if (revisiones) tel.incr("respuestas_revisadas");
        if (r.publicadaTrasTope) {
          // El reloj (o un fallo de la corrección) cortó la revisión con un
          // borrador ya verificado: se publicó recortado en vez de abstener.
          // Queda anotado para medir cuántas respuestas salen por aquí.
          tel.fija({ barrera: { motivo: "tope_con_borrador_verificado", publicada_recortada: true } });
        }
        if (r.frasesEliminadas?.length) {
          // Última barrera antes de la abstención: se publicó el texto SIN
          // las frases que no se pudieron sostener. Queda contado y listado
          // para poder medir cuánto se recorta y por qué.
          tel.incr("frases_eliminadas", r.frasesEliminadas.length);
          tel.fija({ frases_eliminadas: r.frasesEliminadas.map((f) => f.slice(0, 160)) });
        }
        if (abstencionSegura) {
          tel.incr("abstenciones_seguras");
          // Diagnóstico: por qué no se publicó el borrador y qué dijo el
          // verificador de él. Sin esto una abstención segura no se podía
          // investigar (ver revisor.ResultadoRevision.informeBorrador).
          tel.fija({
            barrera: {
              motivo: r.motivoAbstencion,
              informe_borrador: r.informeBorrador
                ? {
                    afirmaciones: r.informeBorrador.afirmaciones.map((af) => ({
                      veredicto: af.veredicto, cita: af.cita, motivo: af.motivo,
                      texto: af.texto.slice(0, 200),
                    })),
                    citas_sin_resolver: r.informeBorrador.citas_sin_resolver,
                    fidelidad: r.informeBorrador.fidelidad,
                    ok: r.informeBorrador.ok,
                    nota: r.informeBorrador.nota,
                    cobertura: r.informeBorrador.cobertura.map((c) => `${c.id}:${c.estado}`),
                  }
                : null,
            },
          });
        }
      } else if (a.habilitarVerificacion && contenido) {
        try {
          informe = await verificador.verificar(contenido, fragmentos, requerida, mapa, tel, {
            pregunta: consulta,
            veredictosPrevios: conocidos,
          });
        } catch (exc) {
          console.error("La verificación falló; la respuesta se publica sin anotar", exc);
          tel.incr("verificacion_fallida");
          tel.fija({ verificacion_error: String(exc).slice(0, 200) });
        }
      }

      // 7. La cobertura por punto vuelve a los hops del plan, que es lo que se
      //    persiste y con lo que la UI reconstruye la tabla al reabrir.
      if (informe) {
        for (const h of hops) {
          if (h.origen !== "plan" || !h.plan_item) continue;
          const c = informe.cobertura.find((x) => x.id === h.plan_item);
          if (!c) continue;
          h.estado_final = c.estado;
          h.usado_en_respuesta = c.estado === "cubierto" || c.estado === "parcial";
        }
        tel.incr("puntos_no_usados", informe.cobertura.filter((c) => c.estado === "evidencia_no_usada").length);
      }
      registrarVerificacion(tel, informe, { revisionPrevia, revisiones, abstencionSegura });

      // 8. Publicar. Solo ahora el texto se hace visible. El plan viaja otra
      //    vez por si su escritura temprana falló: sin él la UI no puede
      //    reconstruir la tabla de cobertura.
      const publicado = await actualizar({
        estado: "listo",
        content: contenido,
        sources: fuentes(),
        hops,
        plan: planPublicable(),
        verificacion: informe ?? undefined,
        metrics: tel.resumen(),
        error: undefined,
      }, true);
      if (!publicado) {
        // Último recurso: que el turno no se quede abierto para siempre.
        await actualizar({
          estado: "error",
          error: "La respuesta se generó pero no se pudo guardar. Vuelve a preguntar.",
        }, true);
      }
    } catch (exc) {
      if (abandonado) {
        // Se detuvo mientras trabajaba: no es un fallo y no se escribe nada.
        console.info(`Turno detenido por la usuaria; el agente lo abandona (${args.messageId}).`);
        return;
      }
      console.error("El agente falló", args.messageId, exc);
      await actualizar({
        estado: "error",
        error: String(exc instanceof Error ? exc.message : exc).slice(0, 500),
        metrics: tel.resumen(),
      }, true);
    }
  },
});

/** Respuesta a una pregunta que no es sobre los documentos: una sola llamada,
 *  sin herramientas y sin barrera, porque no hay nada que atribuir. */
async function responderSinDocumentos(
  a: Ajustes,
  texto: string,
  historial: { role: string; content: string }[],
  tel: Telemetria,
): Promise<string> {
  const t0 = Date.now();
  const kwargs: Record<string, unknown> = {
    model: a.modelo,
    temperature: a.temperatura,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: INSTRUCCION_SIN_DOCUMENTOS },
      ...historial.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: texto },
    ],
    ...gateway.razonamiento("low"),
  };
  const { datos } = await gateway.crearCompletion(kwargs, a, { perfil: "chat", tel });
  const choice = datos?.choices?.[0];
  tel.anota("agente", datos?.model || a.modelo, gateway.usoDe(datos?.usage), {
    ms: Date.now() - t0,
    finishReason: choice?.finish_reason ?? null,
    nota: "sin documentos",
  });
  const contenido = String(choice?.message?.content ?? "").trim();
  if (contenido) return contenido;
  // Vacío porque el modelo terminó sin decir nada (un saludo sin más): se
  // presenta. Vacío por un corte de longitud, un filtro o un rechazo: se dice
  // la verdad, no un saludo, para que la usuaria no crea que no se entendió
  // su pregunta y la reformule en vano.
  const razon: string | null = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  if (razon === null || razon === "stop") {
    return "Soy el asistente de investigación de la empresa: respondo con los documentos indexados y cito de dónde sale cada dato. ¿Qué quieres consultar?";
  }
  console.warn(`respuesta sin documentos vacía (finish_reason=${razon})`);
  return "No he podido completar la respuesta esta vez. Vuelve a intentarlo o reformula la pregunta.";
}

// --- Textos de avance y de alcance ---------------------------------------------

function plural(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Mientras se redacta: cuántas afirmaciones del borrador ya se juzgaron. */
export function textoDeProgresoRedactando(conocidas: number): string {
  return conocidas > 0 ? `${plural(conocidas, "afirmación ya comprobada", "afirmaciones ya comprobadas")} sobre la marcha` : "";
}

/** Al entrar en la barrera, antes de que el verificador diga cuántas quedan. */
export function textoDeProgresoRevisando(conocidas: number): string {
  return conocidas > 0
    ? `${plural(conocidas, "afirmación comprobada", "afirmaciones comprobadas")} · revisando el resto`
    : "Contrastando cada afirmación con su fuente";
}

/** Un evento de la barrera, en la frase que ve la usuaria. */
export function textoDeProgreso(evento: revisor.EventoRevision, conocidas: number): string {
  if (evento.fase === "corrigiendo") {
    const ronda = evento.rondas > 1 ? ` · ronda ${evento.ronda} de ${evento.rondas}` : "";
    return `Corrigiendo ${plural(evento.fallos, "afirmación sin respaldo", "afirmaciones sin respaldo")}${ronda}`;
  }
  if (evento.total === 0) return textoDeProgresoRevisando(conocidas);
  return `Comprobando ${plural(evento.total, "afirmación", "afirmaciones")} · ${evento.hechas} de ${evento.total} listas`;
}

/** Lo que el redactor tiene que saber del alcance pedido. Vacío si no se pidió. */
export function notaDeAlcance(pista: string, resultado: alcance.Alcance, encontrado: boolean): string {
  if (!pista || resultado.tipo === "sin_pista") return "";
  if (resultado.tipo === "elegido") {
    // Resuelto por el tema y no por el nombre: el redactor tiene que decir a
    // qué documento entendió que se refería, porque pudo entenderlo mal.
    const comoSeResolvio = resultado.porContenido
      ? ` No lo nombró: se refirió a él como "${pista}" y es el único documento del que trata eso, así que ` +
        "di al principio de la respuesta con qué documento estás respondiendo."
      : ` (se refirió a él como "${pista}").`;
    if (encontrado) {
      return (
        `ALCANCE: quien pregunta pidió responder únicamente con el documento «${resultado.nombre}»` +
        `${comoSeResolvio} Toda la evidencia que has recibido es de ese documento y las ` +
        "búsquedas que hagas también se limitarán a él. No menciones ni supongas otros documentos."
      );
    }
    return (
      `AVISO DE ALCANCE: quien pregunta pidió responder únicamente con el documento «${resultado.nombre}» ` +
      `(se refirió a él como "${pista}"), pero en ese documento no se encontró NADA sobre esto, así que la ` +
      "búsqueda se hizo en todos sus documentos. Empieza la respuesta diciendo que ese documento no lo trata " +
      "y que lo que sigue sale de otros documentos, nombrándolos. No le atribuyas a ese documento ningún dato."
    );
  }
  if (resultado.tipo === "ambiguo") {
    return (
      `AVISO DE ALCANCE: quien pregunta pidió limitarse a "${pista}", pero eso no identifica un documento: hay ` +
      `${resultado.candidatos} que encajan, así que se buscó en todos. Di al principio de qué documento sale ` +
      "cada dato y no mezcles dos documentos en una misma afirmación. Si quiere uno concreto, tendrá que nombrarlo."
    );
  }
  return (
    `AVISO DE ALCANCE: quien pregunta pidió limitarse a "${pista}", pero ningún documento indexado se llama así, ` +
    "así que se buscó en todos. Dilo al principio de la respuesta y nombra de qué documento sale cada dato."
  );
}

