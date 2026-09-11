-- ============================================================================
-- Ryuma — v66: ระบบคะแนนสะสม (POINTS) เฟส 1 "ได้คะแนน" (ryuma-points-spec)
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย
--
-- กติกา (เจ้าของ 2026-09-10/11):
--   · คะแนน "คงที่ต่อชิ้น" (กำไรร้าน fix 200-250/ชิ้น ไม่ขึ้นกับราคา — เจ้าของ 2026-09-11): ใบพรี 20 · พร้อมส่ง 30 · 1 คะแนน = 1฿
--   · ใบพรี/รอบพิเศษ: ได้ครั้งเดียวตอน "ตั๋วปิดยอด" (ส่วนต่างงวดสุดท้ายอนุมัติ) ไม่ใช่ตอนมัดจำ
--   · พร้อมส่ง: ตั๋วเกิดมาปิดยอดอยู่แล้ว → ได้ตอนแอดมินอนุมัติออเดอร์
--   · ตั๋วหาของ / ประมูล ไม่ให้ในเฟสนี้
--
-- โครง: point_ledger = สมุดบัญชี บวก/ลบ ไม่แก้แถวเก่า · ยอดคงเหลือ = sum(delta)
--   id ของแถว "ได้คะแนน" ผูกกับตั๋วเสมอ (pl-earn-<ticket_id>) → กดอนุมัติซ้ำ/เซฟล้มแล้วส่งซ้ำ
--   = upsert แถวเดิม ไม่ใช่แถวใหม่ (บทเรียนตั๋วซ้ำ Mongkol) + unique(kind, ref_id) เป็นด่านชั้น DB
-- RLS: ลูกค้าอ่านได้เฉพาะแถวตัวเอง · เขียน/แก้/ลบ = แอดมินเท่านั้น (ลูกค้าปั้นคะแนนเองไม่ได้)
-- Depends on app_user_id(), is_app_admin() (v20/v21).
-- ============================================================================

create table if not exists point_ledger (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  delta int not null,                      -- +ได้ / -ใช้ / -หมดอายุ / ± แอดมินปรับ
  kind text not null,                      -- earn_ticket | reverse_ticket | redeem_order | redeem_remaining | refund | expire | admin_adjust
  ref_type text,                           -- ticket | order | remaining_payment
  ref_id text,
  note text,
  created_by text,                         -- 'system' | admin user id
  created_at timestamptz not null default now()
);
create index if not exists point_ledger_user_idx on point_ledger(user_id);
create index if not exists point_ledger_ref_idx on point_ledger(ref_type, ref_id);
-- ด่านกันให้คะแนนซ้ำ: ตั๋ว 1 ใบ ได้ earn_ticket ได้แถวเดียว (ref_id ว่างได้สำหรับ admin_adjust)
create unique index if not exists point_ledger_kind_ref_uq on point_ledger(kind, ref_id) where ref_id is not null;

-- ตั้งค่าใน shop_settings (แอดมินแก้ได้จากหน้า /admin/points)
alter table shop_settings add column if not exists points_enabled boolean default false;
alter table shop_settings add column if not exists points_per_piece_pre int default 20;      -- คะแนน/ชิ้น ใบพรี (กำไร 200-250 → ~10%)
alter table shop_settings add column if not exists points_per_piece_instock int default 30;  -- คะแนน/ชิ้น พร้อมส่ง/จ่ายเต็ม (กำไรสูงกว่า)
alter table shop_settings add column if not exists points_min_redeem int default 50;
alter table shop_settings add column if not exists points_max_per_piece_pre int default 100;
alter table shop_settings add column if not exists points_max_per_piece_instock int default 200;
alter table shop_settings add column if not exists points_expire_months int default 12;

-- RLS
alter table point_ledger enable row level security;

drop policy if exists point_ledger_read on point_ledger;
create policy point_ledger_read on point_ledger for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists point_ledger_admin_write on point_ledger;
create policy point_ledger_admin_write on point_ledger for insert
  with check (is_app_admin());

drop policy if exists point_ledger_admin_update on point_ledger;
create policy point_ledger_admin_update on point_ledger for update
  using (is_app_admin()) with check (is_app_admin());

drop policy if exists point_ledger_admin_delete on point_ledger;
create policy point_ledger_admin_delete on point_ledger for delete
  using (is_app_admin());

-- guard: แถวในสมุดห้ามแก้ตัวเลขย้อนหลัง (append-only) — แก้ผิดให้เพิ่มแถว admin_adjust แทน
create or replace function ryuma_guard_point_ledger() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    if new.delta is distinct from old.delta or new.user_id is distinct from old.user_id
       or new.kind is distinct from old.kind or new.ref_id is distinct from old.ref_id then
      raise exception 'ryuma: แถวคะแนนแก้ย้อนหลังไม่ได้ — เพิ่มแถว admin_adjust แทน';
    end if;
  end if;
  if new.delta = 0 then raise exception 'ryuma: delta ต้องไม่เป็น 0'; end if;
  return new;
end $$;

drop trigger if exists point_ledger_guard on point_ledger;
create trigger point_ledger_guard before insert or update on point_ledger
  for each row execute function ryuma_guard_point_ledger();

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='point_ledger';
-- select polname, cmd from pg_policies where tablename = 'point_ledger';
