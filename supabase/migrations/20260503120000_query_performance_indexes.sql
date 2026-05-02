-- Indexes for high-volume query patterns (avoids full table scans / in-memory sorts as runs/evals grow).
--
-- Growth scenario: ~100k+ runs per user — dashboard load (ORDER BY timestamp), trace spans (run_id),
-- eval history (ORDER BY evaluated_at), new-eval agent dropdown (bounded client query benefits from user_id index scan).

CREATE INDEX IF NOT EXISTS idx_runs_user_timestamp_desc
  ON public.runs (user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_spans_run_id
  ON public.spans (run_id);

CREATE INDEX IF NOT EXISTS idx_eval_results_user_evaluated_at_desc
  ON public.eval_results (user_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_evals_user_created_at_desc
  ON public.evals (user_id, created_at DESC);
