-- ============================================================================
-- v55 (2026-07-23): บัญชีสต๊อกเดียว — อุดรูขายเกินของรอบพิเศษ/in-stock
-- เดิม: available = stock − holds(active+paid+confirmed) → ตั๋วที่แอดมิน "มอบ" ตรงๆ
-- (grantSpecialTickets ไล่ใบพรีเก่า) ไม่มี hold → server มองไม่เห็น → ลูกค้าจองทับได้ = ขายเกิน
-- ใหม่: available = stock − ตั๋วที่ออกแล้ว (ทุกทาง) − holds ที่ค้างระหว่างซื้อ (active ไม่หมดอายุ + paid)
--       'confirmed' (approve แล้ว) ไม่นับ เพราะตั๋วของออเดอร์นั้นถูกนับแทน (กันหักซ้ำ)
-- สูตรนี้ต้องตรงกับ src/domain/services/reservations.ts เสมอ
-- ============================================================================

-- holds ที่ค้างระหว่างซื้อเท่านั้น (ตัด 'confirmed' ออก — ตั๋วนับแทนแล้ว)
create or replace function ryuma_held(p_product_id text, p_batch_id text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  if coalesce(p_batch_id,'') <> '' then
    select coalesce(sum(qty),0) into v from stock_reservations
      where batch_id = p_batch_id and (status = 'paid' or (status='active' and reserved_until > now()));
  else
    select coalesce(sum(qty),0) into v from stock_reservations
      where product_id = p_product_id and coalesce(batch_id,'')='' and (status = 'paid' or (status='active' and reserved_until > now()));
  end if;
  return coalesce(v,0);
end $$;

-- ตั๋วที่ออกแล้ว: batch → ทุกใบของรอบ (ซื้อ+แอดมินมอบ) · product (in-stock) → ตั๋วซื้อพร้อมส่ง
-- (batch ว่าง + ไม่มีส่วนต่าง; ตั๋วพรีเดิมบน SKU ที่ convert ทีหลังมี remaining > 0 จึงไม่โดนหักซ้ำ)
create or replace function ryuma_sold(p_product_id text, p_batch_id text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  if coalesce(p_batch_id,'') <> '' then
    select coalesce(sum(qty),0) into v from preorder_tickets where batch_id = p_batch_id;
  else
    select coalesce(sum(t.qty),0) into v from preorder_tickets t
      where t.product_id = p_product_id and coalesce(t.batch_id,'') = '' and coalesce(t.remaining_amount,0) = 0;
  end if;
  return coalesce(v,0);
end $$;

create or replace function ryuma_available(p_product_id text, p_batch_id text)
returns int language sql security definer set search_path = public, extensions as $$
  select ryuma_stock_total(p_product_id, p_batch_id)
       - ryuma_sold(p_product_id, p_batch_id)
       - ryuma_held(p_product_id, p_batch_id);
$$;

grant execute on function ryuma_sold(text,text) to anon, authenticated;
