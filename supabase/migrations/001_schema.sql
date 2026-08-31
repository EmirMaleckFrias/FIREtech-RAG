-- RAG de Productos — esquema Supabase
-- Ejecutar en el SQL Editor de Supabase o vía MCP de Supabase.

create extension if not exists "pgcrypto";

create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Nueva conversación',
  created_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  hops jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_session on chat_messages(session_id, created_at);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  file_name text not null unique,
  sha256 text not null,
  pages int not null default 0,
  chunks int not null default 0,
  brand text,
  ingested_at timestamptz not null default now()
);

create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  error text
);

create table if not exists message_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references chat_messages(id) on delete cascade,
  rating int not null check (rating in (1, -1)),
  comment text,
  created_at timestamptz not null default now()
);

-- El frontend nunca toca Supabase directamente (todo pasa por el backend con service key),
-- así que RLS se habilita cerrado por defecto.
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;
alter table documents enable row level security;
alter table ingestion_runs enable row level security;
alter table message_feedback enable row level security;
