/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agente_bucle from "../agente/bucle.js";
import type * as agente_cacheCalificaciones from "../agente/cacheCalificaciones.js";
import type * as agente_cachePlan from "../agente/cachePlan.js";
import type * as agente_calificador from "../agente/calificador.js";
import type * as agente_evidencia from "../agente/evidencia.js";
import type * as agente_planner from "../agente/planner.js";
import type * as agente_prompt from "../agente/prompt.js";
import type * as agente_revisor from "../agente/revisor.js";
import type * as agente_verificador from "../agente/verificador.js";
import type * as auth from "../auth.js";
import type * as documentos from "../documentos.js";
import type * as estadisticas from "../estadisticas.js";
import type * as http from "../http.js";
import type * as ingesta_chunking from "../ingesta/chunking.js";
import type * as ingesta_docx from "../ingesta/docx.js";
import type * as ingesta_escritura from "../ingesta/escritura.js";
import type * as ingesta_hash from "../ingesta/hash.js";
import type * as ingesta_idioma from "../ingesta/idioma.js";
import type * as ingesta_lineas from "../ingesta/lineas.js";
import type * as ingesta_lotes from "../ingesta/lotes.js";
import type * as ingesta_paper from "../ingesta/paper.js";
import type * as ingesta_parsear from "../ingesta/parsear.js";
import type * as ingesta_pdf from "../ingesta/pdf.js";
import type * as ingesta_pipeline from "../ingesta/pipeline.js";
import type * as ingesta_tabular from "../ingesta/tabular.js";
import type * as ingesta_texto from "../ingesta/texto.js";
import type * as ingesta_tipos from "../ingesta/tipos.js";
import type * as ingesta_util from "../ingesta/util.js";
import type * as lib_citas from "../lib/citas.js";
import type * as lib_config from "../lib/config.js";
import type * as lib_gateway from "../lib/gateway.js";
import type * as lib_modos from "../lib/modos.js";
import type * as lib_telemetry from "../lib/telemetry.js";
import type * as mensajes from "../mensajes.js";
import type * as permisos from "../permisos.js";
import type * as pruebas from "../pruebas.js";
import type * as search_cacheEmbeddings from "../search/cacheEmbeddings.js";
import type * as search_hybrid from "../search/hybrid.js";
import type * as search_inventario from "../search/inventario.js";
import type * as search_terminos from "../search/terminos.js";
import type * as semilla from "../semilla.js";
import type * as sesiones from "../sesiones.js";
import type * as usuarios from "../usuarios.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agente/bucle": typeof agente_bucle;
  "agente/cacheCalificaciones": typeof agente_cacheCalificaciones;
  "agente/cachePlan": typeof agente_cachePlan;
  "agente/calificador": typeof agente_calificador;
  "agente/evidencia": typeof agente_evidencia;
  "agente/planner": typeof agente_planner;
  "agente/prompt": typeof agente_prompt;
  "agente/revisor": typeof agente_revisor;
  "agente/verificador": typeof agente_verificador;
  auth: typeof auth;
  documentos: typeof documentos;
  estadisticas: typeof estadisticas;
  http: typeof http;
  "ingesta/chunking": typeof ingesta_chunking;
  "ingesta/docx": typeof ingesta_docx;
  "ingesta/escritura": typeof ingesta_escritura;
  "ingesta/hash": typeof ingesta_hash;
  "ingesta/idioma": typeof ingesta_idioma;
  "ingesta/lineas": typeof ingesta_lineas;
  "ingesta/lotes": typeof ingesta_lotes;
  "ingesta/paper": typeof ingesta_paper;
  "ingesta/parsear": typeof ingesta_parsear;
  "ingesta/pdf": typeof ingesta_pdf;
  "ingesta/pipeline": typeof ingesta_pipeline;
  "ingesta/tabular": typeof ingesta_tabular;
  "ingesta/texto": typeof ingesta_texto;
  "ingesta/tipos": typeof ingesta_tipos;
  "ingesta/util": typeof ingesta_util;
  "lib/citas": typeof lib_citas;
  "lib/config": typeof lib_config;
  "lib/gateway": typeof lib_gateway;
  "lib/modos": typeof lib_modos;
  "lib/telemetry": typeof lib_telemetry;
  mensajes: typeof mensajes;
  permisos: typeof permisos;
  pruebas: typeof pruebas;
  "search/cacheEmbeddings": typeof search_cacheEmbeddings;
  "search/hybrid": typeof search_hybrid;
  "search/inventario": typeof search_inventario;
  "search/terminos": typeof search_terminos;
  semilla: typeof semilla;
  sesiones: typeof sesiones;
  usuarios: typeof usuarios;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
