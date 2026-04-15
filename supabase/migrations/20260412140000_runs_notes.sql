-- User-editable run annotations (trace modal notes in app)
alter table public.runs add column if not exists notes text;
