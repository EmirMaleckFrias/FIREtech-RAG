// Tareas periódicas. Por ahora una: traer el corpus desde Notion.
//
// El intervalo del cron es estático en el código, así que aquí va cada hora
// y es la acción la que decide si toca: se salta la corrida si NOTION_SYNC_MINUTES
// es 0 o si la última de ESA PERSONA empezó hace menos de ese intervalo (ver
// convex/notion/sync.ts). Así el operador ajusta la cadencia con una variable
// de entorno sin volver a desplegar, con la única limitación de que no baja
// de una hora.
//
// El cron no sincroniza "el" Notion, porque no hay uno: cada persona conecta
// el suyo y tiene su propio corpus (ver `propietario` en schema.ts). Así que
// lo que corre cada hora es un reparto: se mira quién tiene conexión con base
// elegida y se agenda UNA sincronización por cuenta. Van agendadas y no en
// serie dentro de una acción a propósito: una corrida que se cuelga o que
// agota su límite de 20 minutos no debe dejar sin sincronizar a las demás.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const crons = cronJobs();

/** Agenda una sincronización por cada cuenta con Notion conectado. */
export const repartirSincronizaciones = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ agendadas: number }> => {
    const conexiones = await ctx.db.query("notionConexion").collect();
    let agendadas = 0;
    for (const c of conexiones) {
      // Sin base elegida no hay nada que traer; la acción también lo
      // comprobaría, pero agendarla sería ruido en los logs cada hora.
      if (!c.databaseId) continue;
      await ctx.scheduler.runAfter(0, internal.notion.sync.sincronizar, {
        propietario: c.conectadoPor,
      });
      agendadas += 1;
    }
    return { agendadas };
  },
});

crons.interval("sincronizar notion", { minutes: 60 }, internal.crons.repartirSincronizaciones, {});

export default crons;
