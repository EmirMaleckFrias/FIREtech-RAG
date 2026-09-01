-- Autenticación multiusuario: perfiles con rol, dominio permitido y datos por usuario.
-- Decisiones del negocio (31-ago-2026):
--   - Acceso con correo y contraseña (Supabase Auth).
--   - Solo correos @airobotix.net pueden registrarse.
--   - Roles: admin (sube y borra documentos) y vendedor (solo consulta).
--   - Los costos internos siguen ocultos para todos los roles.
--   - Las conversaciones son privadas de cada usuario; los documentos los ve todo el mundo.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'vendedor' check (role in ('admin', 'vendedor')),
  created_at timestamptz not null default now()
);

-- Un solo punto de verdad para el dominio permitido y el alta de perfil: aunque
-- alguien llame a la API de Supabase Auth directamente, el registro se rechaza.
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
      when lower(new.email) = 'emir.malek@airobotix.net' then 'admin'
      else 'vendedor'
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Conversaciones privadas por usuario. Las filas previas quedan con user_id
-- nulo: el backend solo se las muestra a los administradores (histórico de
-- las pruebas, no se pierde nada y nadie ve conversaciones ajenas).
alter table chat_sessions add column if not exists user_id uuid references auth.users(id) on delete cascade;
create index if not exists idx_chat_sessions_user on chat_sessions(user_id, created_at desc);

-- Trazabilidad de quién subió cada documento (visibles para todos).
alter table documents add column if not exists uploaded_by uuid references auth.users(id) on delete set null;

alter table profiles enable row level security;
