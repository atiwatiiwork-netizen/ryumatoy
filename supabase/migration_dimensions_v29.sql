-- ============================================================================
-- Ryuma — structured product size (cm). Paste into SQL Editor. Safe to re-run.
-- height is the primary spec; width/depth optional (shown on the card only when set).
-- ============================================================================
alter table products add column if not exists height_cm numeric;
alter table products add column if not exists width_cm  numeric;
alter table products add column if not exists depth_cm  numeric;
