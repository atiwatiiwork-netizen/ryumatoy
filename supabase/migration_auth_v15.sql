-- ============================================================================
-- Ryuma — Facebook login + mandatory profile fields. Paste into Supabase SQL Editor.
-- Safe to re-run. Captures phone + shipping address (+ optional LINE) after login.
-- RLS stays OFF this round.
-- ============================================================================

alter table users add column if not exists phone            text;
alter table users add column if not exists shipping_address text;
alter table users add column if not exists line_id          text;
