// Datos iniciales: los administradores preasignados. Port de la migración
// `008_admins_preasignados.sql`, que insertaba tres correos en
// `admin_preasignados` para que el trigger `handle_new_user()` los diera de
// alta como administradores.
//
// Se ejecuta a mano una vez por despliegue:
//     npx convex run semilla:sembrarAdmins
// Es idempotente: volver a correrla no duplica nada.
import { internalMutation, mutation } from "./_generated/server";
import { usuario } from "./usuarios";

/** Los tres correos de la migración original, ya en minúsculas: el trigger
 *  comparaba con `lower(email)` y auth.ts normaliza igual. */
export const ADMINS_INICIALES = [
  "emir.malek@airobotix.net",
  "frandy.aquino@airobotix.net",
  "flemming.villalona@airobotix.net",
] as const;

export const sembrarAdmins = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ahora = Date.now();
    let insertados = 0;
    for (const email of ADMINS_INICIALES) {
      const existe = await ctx.db
        .query("adminsPreasignados")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      if (existe) continue;
      await ctx.db.insert("adminsPreasignados", { email, anadidoEn: ahora });
      insertados++;
    }
    return { insertados, total: ADMINS_INICIALES.length };
  },
});

/** Quien ya se dio de alta ANTES de sembrar la lista entró como lector,
 *  porque el callback de auth.ts no encontró su correo. Esta mutación cubre
 *  ese hueco: si el correo de quien llama está en la lista, pasa a admin.
 *  No recibe argumentos a propósito: solo se puede ascender uno mismo, y
 *  solo si la lista ya lo dice. */
export const ascenderSiPreasignado = mutation({
  args: {},
  handler: async (ctx) => {
    const u = await usuario(ctx);
    const rolActual = u.rol ?? "lector";
    if (rolActual === "admin") return { rol: rolActual, cambiado: false };

    const correo = (u.email ?? "").trim().toLowerCase();
    if (!correo) return { rol: rolActual, cambiado: false };
    const preasignado = await ctx.db
      .query("adminsPreasignados")
      .withIndex("email", (q) => q.eq("email", correo))
      .first();
    if (!preasignado) return { rol: rolActual, cambiado: false };

    await ctx.db.patch(u._id, { rol: "admin" });
    return { rol: "admin" as const, cambiado: true };
  },
});
