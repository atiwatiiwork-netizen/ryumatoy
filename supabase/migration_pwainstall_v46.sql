-- ============================================================================
-- Ryuma - v46: PWA install-rate tracking.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Adds users.installed_at — stamped (once) by the client the first time a member
-- opens the app installed to the home screen (standalone display mode). Feeds the
-- "ติดตั้งลงหน้าจอ" metric on /admin/analytics. Written from the CUSTOMER session on
-- the member's OWN row; installed_at is NOT a protected column, so the existing
-- own-row UPDATE policy + guard trigger allow it. No RLS changes needed.
-- ============================================================================

alter table users add column if not exists installed_at timestamptz;

-- self-check (optional):
-- select count(*) filter (where installed_at is not null) as installed, count(*) as total from users where is_admin is not true;
