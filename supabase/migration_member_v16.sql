-- ============================================================================
-- Ryuma — new-member approval. Paste into Supabase SQL Editor. Safe to re-run.
-- New Facebook signups start unapproved; admin approves before they can order.
-- Existing rows default to approved = true so nothing breaks.
-- ============================================================================

alter table users add column if not exists approved boolean default true;
