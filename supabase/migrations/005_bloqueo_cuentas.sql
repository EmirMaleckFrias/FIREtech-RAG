-- Bloqueo de cuentas: un administrador puede revocar el acceso sin borrar nada.
-- El bloqueo se refleja aquí Y en Supabase Auth (ban), de modo que la cuenta no
-- puede volver a entrar ni renovar su token, y el backend rechaza de inmediato
-- las peticiones que lleguen con un token todavía vigente.

alter table profiles add column if not exists blocked boolean not null default false;
