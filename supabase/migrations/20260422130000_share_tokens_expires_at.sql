ALTER TABLE public.share_tokens
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
