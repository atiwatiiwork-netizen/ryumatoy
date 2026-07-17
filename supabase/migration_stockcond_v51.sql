-- ============================================================================
-- Ryuma - v51: in-stock product condition (สภาพสินค้าพร้อมส่ง).
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- stock_cond jsonb: { hand: 1|2, box_color, box_brown, card, intact }
--  - hand 1/2 = มือ 1 / มือ 2 (surplus converted from a finished pre-order = auto มือ 1)
--  - box_color / box_brown ticked separately (บางชิ้นกล่องสีมา กล่องน้ำตาลเป็นของอื่น)
--  - card = มีการ์ด, intact = ไม่มีแตกหัก
-- Display policy (client-side): มือ2 → "ถึงมือแตกหัก ชดเชย 250 บาททุกกรณี"; in-stock
-- prices are always "ราคารวมส่งแล้ว". No RLS change (products policies cover it).
-- ============================================================================

alter table products add column if not exists stock_cond jsonb;

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='products' and column_name='stock_cond';
