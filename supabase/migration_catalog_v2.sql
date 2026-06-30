-- ============================================================================
-- Ryuma — Catalog v2 migration. Paste into Supabase SQL Editor and Run.
-- Safe to re-run.
--
-- New model: เรื่อง (franchise) and ค่าย (manufacturer) are independent. ซีรีย์
-- (series) belongs to a franchise and lists which makers carry it (maker_ids).
-- A product picks franchise + manufacturer + (optional) series.
-- Also: manufacturers get a logo, stored in a public 'logos' Storage bucket.
-- ============================================================================

-- ค่าย gets an icon/logo
alter table manufacturers add column if not exists logo_url text;

-- เรื่อง is no longer tied to a maker
alter table franchises drop column if exists manufacturer_id;

-- ซีรีย์ — belongs to a franchise; maker_ids = which ค่าย make this series
create table if not exists series (
  id text primary key,
  name text not null,
  franchise_id text references franchises(id) on delete cascade,
  maker_ids text[] default '{}'
);

-- สินค้า — now carries its own maker + optional series
alter table products add column if not exists manufacturer_id text references manufacturers(id);
alter table products add column if not exists series_id text references series(id);

-- ---- Storage bucket for maker logos -----------------------------------------
insert into storage.buckets (id, name, public) values ('logos', 'logos', true)
on conflict (id) do nothing;

-- Public read + open upload (no auth yet — tightened in the Facebook OAuth step).
drop policy if exists "logos public read" on storage.objects;
create policy "logos public read" on storage.objects for select using (bucket_id = 'logos');

drop policy if exists "logos open insert" on storage.objects;
create policy "logos open insert" on storage.objects for insert with check (bucket_id = 'logos');

drop policy if exists "logos open update" on storage.objects;
create policy "logos open update" on storage.objects for update using (bucket_id = 'logos');
