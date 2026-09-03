-- PENDIENTE DE APLICAR (3-sep-2026). Hace falta acceso al proyecto de Supabase
-- y hoy nadie del equipo lo tiene; la service key sirve para filas, no para
-- esquema. Hasta que se corra, el codigo almacena el rol como 'vendedor' y solo
-- MUESTRA "Lector" (ver UserRole en frontend/src/types.ts). Al aplicarla hay
-- que renombrar tambien el identificador en el codigo, en el mismo despliegue.
--
-- Renombra el rol de consulta: los vendedores existentes pasan a ser lectores.
-- Mantiene intactos los privilegios: solo `admin` puede subir o borrar documentos.

alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles
set role = 'lector'
where role = 'vendedor';

alter table public.profiles
  alter column role set default 'lector',
  add constraint profiles_role_check check (role in ('admin', 'lector'));

-- 008 reemplazó el trigger original para usar admin_preasignados; se conserva
-- esa lógica y se cambia únicamente el rol por defecto de nuevas cuentas.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email !~* '@airobotix\.net$' then
    raise exception 'Solo se permiten correos del dominio airobotix.net';
  end if;

  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case
      when exists (
        select 1 from public.admin_preasignados a
        where lower(a.email) = lower(new.email)
      ) then 'admin'
      else 'lector'
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
