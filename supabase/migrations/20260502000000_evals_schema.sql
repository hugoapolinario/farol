-- evals: definition of an eval rule per agent
CREATE TABLE IF NOT EXISTS public.evals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('correctness', 'groundedness', 'json_validity', 'tone')),
  config JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- eval_results: immutable log of eval runs (append-only)
CREATE TABLE IF NOT EXISTS public.eval_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_id UUID NOT NULL REFERENCES public.evals(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  score FLOAT CHECK (score >= 0 AND score <= 1),
  details JSONB NOT NULL DEFAULT '{}',
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_evals_user_id ON public.evals(user_id);
CREATE INDEX IF NOT EXISTS idx_evals_agent_id ON public.evals(agent_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_eval_id ON public.eval_results(eval_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_trace_id ON public.eval_results(trace_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_user_id ON public.eval_results(user_id);

-- RLS
ALTER TABLE public.evals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_results ENABLE ROW LEVEL SECURITY;

-- evals policies
CREATE POLICY "evals_select" ON public.evals
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "evals_insert" ON public.evals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "evals_update" ON public.evals
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "evals_delete" ON public.evals
  FOR DELETE USING (auth.uid() = user_id);

-- eval_results policies (user_id denormalized for simple RLS)
CREATE POLICY "eval_results_select" ON public.eval_results
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT on eval_results is service-role only (Edge Function)
-- No INSERT policy needed for anon/authenticated