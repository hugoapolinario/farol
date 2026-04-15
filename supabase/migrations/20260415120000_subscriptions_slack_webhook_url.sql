-- Slack incoming webhook URL (Builder+), separate from generic webhook_url
alter table public.subscriptions
  add column if not exists slack_webhook_url text;
