ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;
