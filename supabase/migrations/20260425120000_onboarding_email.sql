-- Onboarding email columns (welcome + follow-up). Updated by supabase/functions/onboarding-email
-- after a successful Resend send.
alter table public.subscriptions
  add column if not exists welcome_email_sent_at timestamptz,
  add column if not exists followup_email_sent_at timestamptz;

-- Schedules (pg_cron + pg_net) call the Edge Function. Requires:
--   - extensions: pg_cron, pg_net (https://supabase.com/docs/guides/database/extensions)
--   - Vault secrets: project_url, anon_key (see weekly digest migration and Supabase schedule-functions docs)
--
-- Jobs unschedule on re-apply to keep definitions idempotent.

create extension if not exists pg_net with schema extensions;

do $cron$
declare
  jid bigint;
begin
  for jid in (select jobid from cron.job where jobname in ('send-welcome-emails', 'send-followup-emails'))
  loop
    perform cron.unschedule(jid);
  end loop;
end;
$cron$;

select cron.schedule(
  'send-welcome-emails',
  '*/30 * * * *',
  $$
  select
    net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/onboarding-email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
      ),
      body := jsonb_build_object(
        'email', u.email,
        'user_id', u.id::text,
        'event', 'welcome'
      )
    ) as request_id
  from auth.users u
  join public.subscriptions s on s.user_id = u.id
  where s.welcome_email_sent_at is null
    and u.created_at > now() - interval '2 hours'
    and u.email_confirmed_at is not null;
  $$
);

select cron.schedule(
  'send-followup-emails',
  '0 * * * *',
  $$
  select
    net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/onboarding-email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
      ),
      body := jsonb_build_object(
        'email', u.email,
        'user_id', u.id::text,
        'event', 'followup'
      )
    ) as request_id
  from auth.users u
  join public.subscriptions s on s.user_id = u.id
  where s.followup_email_sent_at is null
    and s.welcome_email_sent_at is not null
    and s.welcome_email_sent_at < now() - interval '24 hours'
    and u.email_confirmed_at is not null;
  $$
);
