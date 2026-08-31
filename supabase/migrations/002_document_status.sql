-- Gestión de documentos (indexación dinámica): estado de ingesta por documento.
-- Ejecutar en el SQL Editor de Supabase o vía MCP de Supabase.

alter table documents add column if not exists status text not null default 'ready'
  check (status in ('processing', 'ready', 'failed'));
alter table documents add column if not exists error text;
