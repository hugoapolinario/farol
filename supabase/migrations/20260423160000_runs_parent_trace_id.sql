ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS parent_trace_id text;
