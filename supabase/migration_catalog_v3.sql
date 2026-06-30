-- ============================================================================
-- Ryuma — Catalog v3: ประเภท (Type) above ค่าย. Paste into Supabase SQL Editor.
-- Safe to re-run. A maker belongs to one Type; only active Types show on the shop.
-- ============================================================================

create table if not exists categories (
  id text primary key,
  name text not null,
  active boolean default true
);

alter table manufacturers add column if not exists category_id text references categories(id);

insert into categories (id, name, active) values
  ('cat-wcf', 'WCF', true),
  ('cat-resin', 'Resin', false),
  ('cat-bandai', 'Bandai', false)
on conflict (id) do nothing;
