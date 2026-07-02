-- ============================================================================
-- Ryuma — a series can belong to MULTIPLE เรื่อง (franchises). Paste into SQL Editor.
-- Safe to re-run. Adds franchise_ids text[] and backfills from the old single franchise_id.
-- The old franchise_id column is kept (harmless) so nothing breaks if not migrated yet.
-- ============================================================================
alter table series add column if not exists franchise_ids text[] default '{}';

update series
  set franchise_ids = array[franchise_id]
  where franchise_id is not null and (franchise_ids is null or franchise_ids = '{}');
