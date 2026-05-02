-- Tighten eval_results SELECT: require both denormalized user_id and parent eval ownership.
--
-- Gap closed: a row with eval_results.user_id = auth.uid() but eval_id pointing at another
-- user's eval (service-role bug or future client) could otherwise be visible; the embedded
-- eval might be hidden by evals RLS, but the eval_results row itself was still returned.
-- This policy requires a matching eval row visible under evals RLS for the same eval_id.
--
-- Legitimate rows (user owns eval and eval_results.user_id matches) continue to match.

DROP POLICY IF EXISTS "eval_results_select" ON public.eval_results;

CREATE POLICY "eval_results_select" ON public.eval_results
  FOR SELECT
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.evals e
      WHERE e.id = eval_results.eval_id
        AND e.user_id = auth.uid()
    )
  );
