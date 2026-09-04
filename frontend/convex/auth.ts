// Autenticación. Reemplaza a Supabase Auth y, sobre todo, al trigger
// `handle_new_user()` de Postgres.
//
// Ese trigger era lo más difícil de portar de todo el esquema: era código
// plpgsql `security definer` colgado de `auth.users`, una tabla propiedad de
// Supabase Auth, redefinido tres veces (migraciones 004, 008 y la 010 que
// nunca se pudo aplicar). Hacía dos cosas: rechazar los correos fuera del
// dominio de la empresa y marcar como administrador a quien estuviera en una
// lista. Aquí las dos viven en `createOrUpdateUser`, que es una función normal
// que se puede leer, probar y cambiar sin permisos de base de datos.
//
// Un efecto colateral que se gana: el trigger lanzaba una excepción y GoTrue la
// traducía a "Database error saving new user", así que el frontend tenía que
// reconocer ese texto en inglés por comparación de cadenas para poder decirle
// a alguien que su correo no era del dominio. Quince traducciones de mensajes
// de error de proveedor desaparecen con esto.
import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import Google from "@auth/core/providers/google";
import type { MutationCtx } from "./_generated/server";
import { ajustes } from "./lib/config";

/** Correo normalizado, o cadena vacía. */
function normalizarCorreo(valor: unknown): string {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

/** Si el correo pertenece al dominio permitido.
 *
 *  La comprobación es sobre el sufijo `@dominio`, no un `includes`: sin la
 *  arroba, "airobotix.net.atacante.com" pasaría. */
export function correoPermitido(correo: string, dominio: string): boolean {
  const c = normalizarCorreo(correo);
  const d = dominio.trim().toLowerCase();
  if (!c || !d) return false;
  return c.endsWith(`@${d}`);
}

/** Google solo se ofrece si el despliegue tiene sus credenciales.
 *
 *  Listarlo sin ellas deja un botón que falla al pulsarlo, que es peor que no
 *  tener el botón. Con contraseña se puede entrar desde el primer momento. */
function proveedores() {
  const lista: any[] = [Password({ profile: (params) => ({ email: normalizarCorreo(params.email) }) })];
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    lista.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        // Que el selector de cuenta salga siempre: con varias cuentas de
        // Google abiertas, el silencioso entraba con la equivocada.
        authorization: { params: { prompt: "select_account" } },
      }),
    );
  }
  return lista;
}

/** Si Google está disponible en este despliegue (lo consulta la UI). */
export function googleDisponible(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: proveedores(),
  callbacks: {
    /** Alta y actualización de una cuenta. Aquí viven las dos reglas del
     *  trigger que se retira. */
    async createOrUpdateUser(ctxGenerico, args) {
      // El contexto que pasa Convex Auth está tipado contra un esquema
      // genérico, no contra el nuestro, así que sin esto `withIndex("email")`
      // no compila: TypeScript no sabe qué índices tiene la tabla. La forma en
      // tiempo de ejecución es la misma; lo único que falta es el tipo.
      const ctx = ctxGenerico as unknown as MutationCtx;
      const a = ajustes();
      const correo = normalizarCorreo(args.profile?.email);

      // 1) Dominio de la empresa. Se comprueba en el ALTA y también al
      //    entrar: si mañana se cambia el dominio permitido, una cuenta
      //    antigua fuera de él deja de poder entrar, en vez de quedarse
      //    dentro para siempre por haberse creado antes.
      if (correo && !correoPermitido(correo, a.dominioPermitido)) {
        throw new Error(
          `Solo se permiten correos del dominio ${a.dominioPermitido}.`,
        );
      }

      if (args.existingUserId) {
        await ctx.db.patch(args.existingUserId, {
          ultimoAccesoEn: Date.now(),
          ...(correo ? { email: correo } : {}),
        });
        return args.existingUserId;
      }

      if (!correo) {
        throw new Error("El proveedor de acceso no devolvió un correo.");
      }

      // 2) Administradores preasignados. Era una tabla con un `exists
      //    (select 1 ... where lower(email) = lower(new.email))`; aquí es una
      //    lectura por índice. Quien no esté en la lista entra como lector,
      //    que es el rol que menos supone.
      const preasignado = await ctx.db
        .query("adminsPreasignados")
        .withIndex("email", (q) => q.eq("email", correo))
        .unique();

      const ahora = Date.now();
      return await ctx.db.insert("users", {
        email: correo,
        name: typeof args.profile?.name === "string" ? args.profile.name : undefined,
        image: typeof args.profile?.image === "string" ? args.profile.image : undefined,
        rol: preasignado ? "admin" : "lector",
        bloqueado: false,
        creadoEn: ahora,
        ultimoAccesoEn: ahora,
      });
    },
  },
});
