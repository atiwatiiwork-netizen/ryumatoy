-- ============================================================================
-- Ryuma — Parcel tracking (in-Thailand shipment). Paste into Supabase SQL Editor.
-- Safe to re-run. After the item arrives in TH and the balance is paid, admin enters
-- the carrier + tracking no on the TICKET → the pre-order for that ticket is DONE.
-- ============================================================================

alter table preorder_tickets add column if not exists carrier        text;   -- 'ems'|'jt'|'flash'|'kerry'
alter table preorder_tickets add column if not exists parcel_no       text;   -- tracking number
alter table preorder_tickets add column if not exists parcel_image    text;   -- optional photo of the label/slip
alter table preorder_tickets add column if not exists shipped_out_at  timestamptz; -- when admin dispatched the parcel
