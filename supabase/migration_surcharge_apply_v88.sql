-- ============================================================================
-- Ryuma — v88: ปรับราคาสินค้าพรีเดิมตามกฎค่าส่งรถ (เจ้าของ 2026-10-13) — ทำให้เลย ไม่ต้องกดปุ่มในแอป
-- รันไฟล์นี้ไฟล์เดียว · รวม v87 ไว้แล้ว (ไม่ต้องรัน v87 แยก) · รันซ้ำได้ ไม่บวกซ้ำ
--
--   กฎ: ต้นทุน 288–348¥ เท่าเดิม · ตั้งแต่ 349¥ +40 · ตั้งแต่ 500¥ +80 (แทน ไม่บวกซ้อน)
--   แตะเฉพาะ: สินค้าพรีกระดานหลักที่ "เปิดรับอยู่" (status open · ไม่ใช่พร้อมส่ง · ไม่ใช่สินค้าหลายแบบ · มีต้นทุนหยวน)
--             และ "ยังไม่มีคนพรีเลย" ตอนที่รัน — เช็คในฐานข้อมูลตอนนั้นเลย:
--               ไม่มีตั๋ว (ทุกรอบ) · ไม่มีออเดอร์รอตรวจ · ไม่มีคนกำลังจ่ายเงิน (hold ยังไม่หมดเวลา / ส่งสลิปแล้ว)
--   ไม่แตะ: ปิดรอบแล้ว · มีคนพรีแล้ว · ตั๋ว/ออเดอร์/มัดจำ/แต้ม · ราคารอบพิเศษ · ของพร้อมส่ง
--
--   วิธีคิดราคาใหม่ (สูตร = ฐานบาท + (หยวน − ฐานหยวน) × บาทต่อหยวน จาก shop_settings ตอนนี้):
--     ราคาตรงสูตรเดิม                    → สูตรใหม่ (= เดิม + 40/80)
--     ราคาตรงสูตรใหม่อยู่แล้ว              → ไม่แตะ (ลงหลังแอปใหม่ขึ้น)
--     ลงช่วง 13:11–13:20 ที่ขั้น 1 ยังเป็น 329 (329–348¥ ได้ +40 ไป) → เอา 40 ออก
--     ราคาตั้งเอง ลงก่อนกฎใหม่ (ก่อน 2026-10-13 13:11) → ราคาเดิม + 40/80
--     ราคาตั้งเอง ลงหลังกฎใหม่             → ไม่แตะ (แอดมินพิมพ์เองตามกฎใหม่แล้ว)
--
--   สำรอง: ทุกตัวที่ถูกปรับถูกบันทึกใน price_surcharge_v88 (ราคาเก่า/ใหม่) → กันบวกซ้ำ + ย้อนได้
--   ย้อนกลับ (ถ้าต้องการ): update products p set price_total = b.old_price
--                            from price_surcharge_v88 b where p.id = b.product_id and p.price_total = b.new_price;
--   เทสต์: npm run audit:sql (surcharge88-audit)
-- ============================================================================

-- ── 1) ตั้งค่า 4 ช่อง (เหมือน v87) ─────────────────────────────────────────────
alter table shop_settings add column if not exists surcharge_from_yuan_1 numeric default 349;
alter table shop_settings add column if not exists surcharge_baht_1 numeric default 40;
alter table shop_settings add column if not exists surcharge_from_yuan_2 numeric default 500;
alter table shop_settings add column if not exists surcharge_baht_2 numeric default 80;

update shop_settings set
  surcharge_from_yuan_1 = coalesce(surcharge_from_yuan_1, 349),
  surcharge_baht_1 = coalesce(surcharge_baht_1, 40),
  surcharge_from_yuan_2 = coalesce(surcharge_from_yuan_2, 500),
  surcharge_baht_2 = coalesce(surcharge_baht_2, 80)
where id = 'default';

-- ── 2) ตารางสำรองราคา (SQL เท่านั้น · API อ่าน/เขียนไม่ได้) ───────────────────────
create table if not exists price_surcharge_v88 (
  product_id  text primary key,
  series_name text,
  cost_yuan   numeric,
  old_price   numeric not null,
  new_price   numeric not null,
  rule        text,
  applied_at  timestamptz default now()
);
alter table price_surcharge_v88 enable row level security;
revoke all on price_surcharge_v88 from anon, authenticated;

-- ── 3) ปรับราคา (คำสั่งเดียว: เช็คคนพรี + บันทึกสำรอง + แก้ราคา พร้อมกัน) ─────────
with s as (
  select yuan_base::numeric yb, baht_base::numeric bb, baht_per_yuan::numeric per,
         coalesce(surcharge_from_yuan_1, 349)::numeric y1, greatest(0, coalesce(surcharge_baht_1, 40))::numeric b1,
         coalesce(surcharge_from_yuan_2, 500)::numeric y2, greatest(0, coalesce(surcharge_baht_2, 80))::numeric b2
    from shop_settings where id = 'default'
), c as (
  select p.id, p.series_name, p.cost_yuan, p.price_total, p.created_at,
         greatest(0, round(s.bb + (p.cost_yuan - s.yb) * s.per)) as base,
         case when s.y2 > 0 and p.cost_yuan >= s.y2 then s.b2
              when s.y1 > 0 and p.cost_yuan >= s.y1 then s.b1
              else 0 end as sur
    from products p cross join s
   where p.status = 'open'
     and coalesce(p.is_stock, false) = false
     and coalesce(p.has_variants, false) = false
     and p.cost_yuan is not null
     and not exists (select 1 from price_surcharge_v88 b where b.product_id = p.id)
     and not exists (select 1 from preorder_tickets t where t.product_id = p.id)
     and not exists (select 1 from order_items i join orders o on o.id = i.order_id
                      where i.product_id = p.id and o.status = 'pending_approval')
     and not exists (select 1 from stock_reservations r
                      where r.product_id = p.id and (r.status = 'paid' or (r.status = 'active' and r.reserved_until > now())))
), plan as (
  select id, series_name, cost_yuan, price_total as old_price,
         case
           when price_total = base + sur then null
           when price_total = base then base + sur
           when sur = 0 and cost_yuan >= 329 and price_total = base + 40
                and created_at >= timestamptz '2026-10-13 13:11:00+07' then base
           when sur > 0 and created_at < timestamptz '2026-10-13 13:11:00+07' then price_total + sur
           else null
         end as new_price,
         case
           when price_total = base then 'ตามสูตร +' || sur::text
           when sur = 0 then 'ลงช่วงขั้น 329 −40'
           else 'ราคาตั้งเอง +' || sur::text
         end as rule
    from c
), ins as (
  insert into price_surcharge_v88 (product_id, series_name, cost_yuan, old_price, new_price, rule)
  select id, series_name, cost_yuan, old_price, new_price, rule
    from plan where new_price is not null and new_price <> old_price
  returning product_id, new_price
)
update products p
   set price_total = ins.new_price,
       deposit_amount = least(p.deposit_amount, ins.new_price)
  from ins
 where p.id = ins.product_id;

-- ── ตรวจหลังรัน: cols ต้องได้ 4 · changed = จำนวนที่ปรับ · list = รายการ เก่า → ใหม่
--    kept_booked = พรีที่เปิดอยู่ ต้นทุน ≥ 349¥ ที่มีคนพรีแล้ว (ไม่แตะ ตามกฎ)
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_settings'
      and column_name in ('surcharge_from_yuan_1', 'surcharge_baht_1', 'surcharge_from_yuan_2', 'surcharge_baht_2')) as cols,
  (select count(*) from price_surcharge_v88) as changed,
  (select count(*) from products p
    where p.status = 'open' and coalesce(p.is_stock, false) = false and p.cost_yuan >= 349
      and (exists (select 1 from preorder_tickets t where t.product_id = p.id)
        or exists (select 1 from order_items i join orders o on o.id = i.order_id
                    where i.product_id = p.id and o.status = 'pending_approval'))) as kept_booked,
  (select string_agg(series_name || ' · ' || cost_yuan::text || '¥ · ' || old_price::text || ' → ' || new_price::text || ' (' || rule || ')', E'\n' order by series_name)
     from price_surcharge_v88) as list;
