-- Administradores pre-asignados: correos que nacen con rol admin al registrarse.
-- El trigger handle_new_user consulta esta tabla en vez de llevar correos
-- cosidos en el codigo: designar a alguien nuevo es un INSERT aqui.

create table if not exists admin_preasignados (
  email text primary key,
  added_at timestamptz not null default now()
);

insert into admin_preasignados (email) values
  ('emir.malek@airobotix.net'),
  ('frandy.aquino@airobotix.net'),
  ('flemming.villalona@airobotix.net')
on conflict (email) do nothing;

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
      else 'vendedor'
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Si alguno de los pre-asignados ya tenia cuenta, se promueve de una vez.
update profiles
set role = 'admin'
where lower(email) in (select lower(email) from admin_preasignados)
  and role <> 'admin';

alter table admin_preasignados enable row level security;
