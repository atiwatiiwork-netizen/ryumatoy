-- ============================================================================
-- Ryuma — Payment accounts (multi-account + QR). Paste into Supabase SQL Editor.
-- Safe to re-run. Accounts with active=true are shown to customers at checkout.
-- ============================================================================

create table if not exists payment_accounts (
  id text primary key,
  name text not null,
  number text not null,
  qr_url text,
  active boolean default true
);

insert into payment_accounts (id, name, number, active) values
  ('pay-1', 'Ryuma Toy Shop', '081-234-5678', true)
on conflict (id) do nothing;
