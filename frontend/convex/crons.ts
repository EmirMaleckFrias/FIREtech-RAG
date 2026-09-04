// Tareas periódicas. Por ahora una: traer el corpus desde Notion.
//
// El intervalo del cron es estático en el código, así que aquí va cada hora
// y es la acción la que decide si toca: se salta la corrida si NOTION_SYNC_MINUTES
// es 0 o si la última empezó hace menos de ese intervalo (ver
// convex/notion/sync.ts). Así el operador ajusta la cadencia con una variable
// de entorno sin volver a desplegar, con la única limitación de que no baja
// de una hora.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sincronizar notion", { minutes: 60 }, internal.notion.sync.sincronizar, {});

export default crons;
