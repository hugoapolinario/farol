-- Weekly digest Edge Function auth: set WEEKLY_DIGEST_SECRET (Supabase Dashboard → Edge Functions → Secrets,
-- or `supabase secrets set WEEKLY_DIGEST_SECRET=<value>`). The function rejects requests when the env var
-- is set unless header x-digest-secret matches.
--
-- pg_cron must send the same value. Store it in Vault (same string as WEEKLY_DIGEST_SECRET):
--   select vault.create_secret('<paste-secret-here>', 'weekly_digest_secret');
--
-- Also ensure Vault has project_url and anon_key per:
--   https://supabase.com/docs/guides/functions/schedule-functions

create extension if not exists pg_net with schema extensions;

do $cron$
declare
  jid bigint;
begin
  for jid in (select jobid from cron.job where jobname = 'weekly-digest')
  loop
    perform cron.unschedule(jid);
  end loop;
end;
$cron$;

select cron.schedule(
  'weekly-digest',
  '0 9 * * 1',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-digest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_digest_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
