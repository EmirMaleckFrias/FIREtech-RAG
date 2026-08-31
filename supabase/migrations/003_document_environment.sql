alter table documents add column if not exists environment text not null default 'local';
