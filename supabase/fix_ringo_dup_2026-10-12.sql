-- ─────────────────────────────────────────────────────────────────────────────
-- แก้สินค้าซ้ำ "Ringo - 7 SwordMaster" (เจ้าของเผลอลงซ้ำ 2 ตัว 2026-10-12)
-- รันใน Supabase SQL Editor ทีละส่วน: ส่วน 1 ดูก่อน → ส่วน 2 รวม+ลบ → ส่วน 3 เช็คผล
--
-- หลักการ (ครอบทั้ง 3 กรณีอัตโนมัติ):
--   · เก็บตัวที่ "มีใบพรี/รายการสั่งซื้อ" มากกว่า · เท่ากัน (รวมถึง 0–0) → เก็บตัวที่สร้างก่อน
--   · ใบพรี / รายการในออเดอร์ / รอบพิเศษ / คูปอง ฯลฯ ของตัวซ้ำ → ย้ายไปตัวที่เก็บทั้งหมด (ไม่มีอะไรหาย)
--   · ในไลน์: ตัวสมาชิกที่ผูกกับตัวซ้ำถูกเอาออก (ถ้าในไลน์นั้นไม่มีตัวที่เก็บ → เปลี่ยนให้ผูกตัวที่เก็บแทน)
--   · แล้วค่อยลบสินค้าตัวซ้ำ
--
-- ⚠ trigger ryuma_tickets_guard จะ "คืนค่า product_id เดิม" เงียบๆ เมื่อแก้จาก SQL Editor (ไม่ใช่แอดมินในแอป)
--   → ปิด trigger ชั่วคราวในทรานแซกชันเดียวกัน (วิธีเดียวกับที่เคยทำกับ trg_guard_user)
--   order_items ใช้ ryuma.trusted = 'on' (ด่านของมันรองรับอยู่แล้ว)
-- ─────────────────────────────────────────────────────────────────────────────

-- ส่วน 1) ดูก่อน (อ่านอย่างเดียว) — ต้องเห็น 2 แถว
select p.id, p.series_name, p.created_at, p.status, p.price_total, p.deposit_amount,
       (select count(*) from preorder_tickets t where t.product_id = p.id)                                   as tickets,
       (select count(*) from order_items i where i.product_id = p.id)                                        as order_items,
       (select count(*) from order_items i join orders o on o.id = i.order_id
          where i.product_id = p.id and o.status = 'pending_approval')                                       as pending_orders,
       (select count(*) from product_batches b where b.product_id = p.id)                                    as batches,
       (select string_agg(l.name, ', ') from product_lines l
          where exists (select 1 from jsonb_array_elements(l.members) m where (m->'product_ids') ? p.id))    as in_lines
from products p
where p.series_name ilike 'Ringo%'
order by p.created_at;

-- ส่วน 2) รวม + ลบ (ทรานแซกชันเดียว · ถ้าพบไม่ใช่ 2 ตัวพอดีจะหยุดเองไม่ทำอะไร)
begin;
select set_config('ryuma.trusted', 'on', true);
alter table preorder_tickets disable trigger ryuma_tickets_guard;

do $$
declare k text; d text; n int;
begin
  with c as (
    select p.id, p.created_at,
           (select count(*) from preorder_tickets t where t.product_id = p.id)
         + (select count(*) from order_items i where i.product_id = p.id) as refs
    from products p where p.series_name ilike 'Ringo%'
  )
  select (select id from c order by refs desc, created_at asc limit 1),
         (select id from c order by refs desc, created_at asc offset 1 limit 1),
         (select count(*) from c)
    into k, d, n;
  if n <> 2 then
    raise exception 'ryuma: พบสินค้าชื่อ Ringo % ตัว (ต้องเป็น 2 พอดี) — แก้เงื่อนไขชื่อในสคริปต์เป็น id ตรงๆ แล้วรันใหม่', n;
  end if;

  -- ย้ายทุกอย่างที่ชี้ตัวซ้ำ → ตัวที่เก็บ
  update preorder_tickets   set product_id = k where product_id = d;
  update order_items        set product_id = k where product_id = d;
  update product_variants   set product_id = k where product_id = d;
  update product_batches    set product_id = k where product_id = d;
  update stock_additions    set product_id = k where product_id = d;
  update stock_reservations set product_id = k where product_id = d;
  update auctions           set product_id = k where product_id = d;
  update sourcing_requests  set source_product_id = k where source_product_id = d;
  update sourcing_requests  set product_id = k where product_id = d;
  update coupons            set target_product_id = k where target_product_id = d;
  update campaigns          set target_product_id = k where target_product_id = d;
  update shop_settings      set hero_product_id = k where hero_product_id = d;

  -- ไลน์: มีตัวที่ผูก k อยู่แล้ว → เอาสมาชิกที่ผูก d ออก · ไม่มี → เปลี่ยน d เป็น k ในสมาชิกนั้น
  update product_lines l
     set members = (
       select coalesce(jsonb_agg(
                case when (m->'product_ids') ? d
                     then jsonb_set(m, '{product_ids}',
                            (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(m->'product_ids') x where x <> d)
                            || to_jsonb(array[k]))
                     else m end), '[]'::jsonb)
       from jsonb_array_elements(l.members) m
       where not ((m->'product_ids') ? d
                  and exists (select 1 from jsonb_array_elements(l.members) m2 where (m2->'product_ids') ? k))
     ),
         updated_at = now()
   where exists (select 1 from jsonb_array_elements(l.members) m where (m->'product_ids') ? d);

  delete from products where id = d;
  raise notice 'ryuma: เก็บ % · ลบ % แล้ว', k, d;
end $$;

alter table preorder_tickets enable trigger ryuma_tickets_guard;
commit;

-- ส่วน 3) เช็คผล — ต้องเหลือ 1 แถว และ tickets/order_items = ผลรวมของสองแถวเดิม
select p.id, p.series_name, p.created_at,
       (select count(*) from preorder_tickets t where t.product_id = p.id) as tickets,
       (select count(*) from order_items i where i.product_id = p.id)      as order_items,
       (select string_agg(l.name, ', ') from product_lines l
          where exists (select 1 from jsonb_array_elements(l.members) m where (m->'product_ids') ? p.id)) as in_lines
from products p where p.series_name ilike 'Ringo%';
-- ปิด/รีเฟรชแท็บแอดมินที่เปิดค้างไว้หลังรัน (ไม่งั้น store ในเครื่องยังเห็นตัวซ้ำจนกว่าจะโหลดใหม่)
