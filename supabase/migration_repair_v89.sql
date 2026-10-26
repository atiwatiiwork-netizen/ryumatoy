-- ============================================================================
-- Ryuma — v89 ระบบยื่นเรื่องซ่อม (เจ้าของ 2026-10-26)
-- วางใน Supabase SQL Editor แล้วกด Run · รันซ้ำได้ (idempotent) · ไม่พึ่ง v80–v88
--
-- flow: ลูกค้าได้รับของแล้วชำรุด → ยื่นเรื่อง (รูป + รายละเอียด) ภายในกำหนด
--   → แอดมินส่งที่อยู่ช่าง → ลูกค้าส่งของ + แจ้งเลขพัสดุ → ช่างซ่อมเสร็จส่งคืน
--   → แอดมินแจ้งเลขพัสดุส่งกลับ → ลูกค้ากดได้รับของ = จบ
-- กฎเคลม: ระบบมี "วันที่ส่งของ" (preorder_tickets.shipped_out_at) ไม่มีวันที่ลูกค้ารับจริง
--   → ยื่นได้ถึงสิ้นวัน (เวลาไทย) ของ วันที่ส่ง + days (15) + transit_days (3 เผื่อขนส่ง · รับเอง/รถเข้ารับ = 0)
--   ตั้งค่าได้ที่ app_config key 'repair_config' {days, transit_days, address}
-- สิทธิ์: ลูกค้าเห็น/เขียนเฉพาะเรื่องของตัวเอง และเปลี่ยนได้แค่ 3 จังหวะ (trigger คุม) · แอดมินทำได้ทุกอย่าง
-- Depends on v20/v21 helpers: app_user_id(), is_app_admin(), is_app_approved().
-- ============================================================================

create table if not exists repair_claims (
  id              text primary key,
  ticket_id       text not null,
  user_id         text not null,                 -- เจ้าของตั๋ว ณ ตอนยื่น (owner_id ไม่ใช่ผู้ซื้อคนแรก)
  status          text not null default 'filed', -- filed | address_sent | sent_to_tech | returned | done | rejected
  description     text not null default '',
  images          jsonb not null default '[]'::jsonb,
  shipped_out_at  timestamptz,                   -- snapshot จากตั๋ว (server เขียนทับตอน insert)
  deadline_at     timestamptz,                   -- snapshot กำหนดยื่น (server เขียนทับตอน insert)
  filed_at        timestamptz not null default now(),
  tech_address    text,                          -- ที่อยู่ช่างที่ส่งให้ลูกค้า (snapshot — แก้ค่าตั้งต้นทีหลังไม่กระทบ)
  address_note    text,
  address_sent_at timestamptz,
  address_sent_by text,
  out_carrier     text,                          -- ลูกค้า → ช่าง
  out_tracking    text,
  out_sent_at     timestamptz,
  back_carrier    text,                          -- ช่าง → ลูกค้า
  back_tracking   text,
  back_sent_at    timestamptz,
  back_sent_by    text,
  received_at     timestamptz,                   -- ลูกค้ากดได้รับของ (หรือแอดมินปิดเรื่อง)
  rejected_at     timestamptz,
  rejected_by     text,
  reject_reason   text,
  admin_note      text,
  updated_at      timestamptz not null default now()
);
create index if not exists repair_claims_ticket_idx on repair_claims (ticket_id);
create index if not exists repair_claims_user_idx on repair_claims (user_id);

alter table repair_claims enable row level security;

drop policy if exists repair_read on repair_claims;
create policy repair_read on repair_claims for select
  using (user_id = app_user_id() or is_app_admin());

-- สมาชิกที่ถูกระงับ (v40) ยื่น/เดินเรื่องไม่ได้
drop policy if exists repair_insert on repair_claims;
create policy repair_insert on repair_claims for insert
  with check ((user_id = app_user_id() and is_app_approved()) or is_app_admin());

drop policy if exists repair_update on repair_claims;
create policy repair_update on repair_claims for update
  using ((user_id = app_user_id() and is_app_approved()) or is_app_admin())
  with check ((user_id = app_user_id() and is_app_approved()) or is_app_admin());

drop policy if exists repair_delete on repair_claims;
create policy repair_delete on repair_claims for delete
  using (is_app_admin());

-- ค่าตั้งต้น + ตรา v=89 = "ตารางพร้อมแล้ว" (แอปใช้ตรานี้เปิดปุ่มฝั่งลูกค้า — แอดมินเซฟที่อยู่ก่อนรัน SQL จะไม่มีตรา)
-- ถ้ามี key อยู่แล้ว (แอดมินตั้งที่อยู่ไว้ก่อน) เก็บค่าเดิม แค่เติมตรา
insert into app_config (key, value)
  values ('repair_config', '{"days":15,"transit_days":3,"address":"","v":89}'::jsonb)
  on conflict (key) do update set value = app_config.value || '{"v":89}'::jsonb;

-- ── ด่าน (trigger): ลูกค้าทำได้แค่ ยื่น / แจ้งเลขส่งไปช่าง / กดได้รับของ — ที่เหลือแอดมิน ──
create or replace function ryuma_guard_repair() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb;
  d_days int;
  d_transit int;
  t record;
  ddl timestamptz;
  cust_cols text[];
begin
  if is_app_admin() then
    new.updated_at := now();
    return new;
  end if;

  -- ข้อความ raise ขึ้นต้น 'ryuma:' เสมอ = แอปรู้ว่า "ปฏิเสธถาวร" ไม่วนส่งซ้ำ และโชว์ข้อความนี้ให้ลูกค้าอ่านตรงๆ (persistErrors)
  if tg_op = 'INSERT' then
    -- แอปส่งแถวเดิมซ้ำได้ (เซฟติดแล้วแต่คำตอบหาย → ลองใหม่) → ข้ามเงียบๆ ไม่ให้ด่านข้างล่างตีกลับว่า "มีเรื่องค้าง"
    if exists (select 1 from repair_claims c where c.id = new.id) then
      return null;
    end if;
    if new.user_id is distinct from app_user_id() then
      raise exception 'ryuma: ยื่นได้เฉพาะเรื่องของตัวเอง';
    end if;
    if new.status <> 'filed' then
      raise exception 'ryuma: เรื่องซ่อมเริ่มได้ที่ขั้นยื่นเรื่องเท่านั้น';
    end if;
    select * into t from preorder_tickets where id = new.ticket_id;
    if not found or t.owner_id is distinct from new.user_id or t.status <> 'shipped' then
      raise exception 'ryuma: ยื่นได้เฉพาะใบของตัวเองที่ได้รับของแล้ว';
    end if;
    if t.shipped_out_at is null then
      raise exception 'ryuma: ใบนี้ไม่มีวันที่ส่งในระบบ — ทักแอดมิน';
    end if;
    if exists (select 1 from repair_claims c where c.ticket_id = new.ticket_id and c.status not in ('done', 'rejected')) then
      raise exception 'ryuma: ใบนี้มีเรื่องซ่อมค้างอยู่แล้ว';
    end if;
    select value into cfg from app_config where key = 'repair_config';
    d_days := coalesce((cfg->>'days')::int, 15);
    d_transit := case when coalesce(t.delivery->>'method', '') in ('courier', 'pickup') then 0 else coalesce((cfg->>'transit_days')::int, 3) end;
    -- จุดตัด = เที่ยงคืนเวลาไทย "หลัง" วันสุดท้าย (นับเป็นวัน ไม่ใช่ชั่วโมง) — สูตรเดียวกับ repair.ts repairDeadline
    ddl := ((((t.shipped_out_at at time zone 'Asia/Bangkok')::date + (d_days + d_transit + 1))::timestamp) at time zone 'Asia/Bangkok');
    if now() >= ddl then
      raise exception 'ryuma: เกินกำหนดยื่นเรื่องซ่อมแล้ว (วันสุดท้าย %)', to_char((ddl at time zone 'Asia/Bangkok') - interval '1 day', 'DD/MM/YYYY');
    end if;
    -- server เป็นคนเขียน snapshot เอง และล้างช่องของแอดมินทุกช่อง (ไม่เชื่อค่าจากแอป)
    new.shipped_out_at := t.shipped_out_at;
    new.deadline_at := ddl;
    new.filed_at := now();
    new.tech_address := null; new.address_note := null; new.address_sent_at := null; new.address_sent_by := null;
    new.out_carrier := null; new.out_tracking := null; new.out_sent_at := null;
    new.back_carrier := null; new.back_tracking := null; new.back_sent_at := null; new.back_sent_by := null;
    new.received_at := null; new.rejected_at := null; new.rejected_by := null; new.reject_reason := null; new.admin_note := null;
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE โดยเจ้าของเรื่อง: อนุญาต 3 จังหวะเท่านั้น และแตะได้เฉพาะช่องของจังหวะนั้น
  if old.user_id is distinct from app_user_id() then
    raise exception 'ryuma: แก้ได้เฉพาะเรื่องของตัวเอง';
  end if;
  -- ช่องที่เป็นของ server/แอดมิน ตรึงค่าเดิมไว้ก่อนเทียบ (แอปส่งค่าที่คำนวณเองมาได้ เช่น filed_at จากเครื่องลูกค้า)
  new.user_id := old.user_id; new.ticket_id := old.ticket_id;
  new.shipped_out_at := old.shipped_out_at; new.deadline_at := old.deadline_at; new.filed_at := old.filed_at;
  if old.status = 'filed' and new.status = 'filed' then
    cust_cols := array['description', 'images', 'updated_at'];
  elsif old.status = 'address_sent' and new.status = 'sent_to_tech' then
    cust_cols := array['status', 'out_carrier', 'out_tracking', 'out_sent_at', 'updated_at'];
    if coalesce(new.out_tracking, '') = '' then raise exception 'ryuma: ใส่เลขพัสดุก่อน'; end if;
  elsif old.status = 'returned' and new.status = 'done' then
    cust_cols := array['status', 'received_at', 'updated_at'];
  else
    raise exception 'ryuma: สถานะเรื่องนี้เปลี่ยนไปแล้ว — รีเฟรชหน้า (% → %)', old.status, new.status;
  end if;
  if (to_jsonb(new) - cust_cols) <> (to_jsonb(old) - cust_cols) then
    raise exception 'ryuma: ช่องนี้แก้ได้เฉพาะแอดมิน';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists repair_guard on repair_claims;
create trigger repair_guard before insert or update on repair_claims
  for each row execute function ryuma_guard_repair();

-- ── ตรวจหลังรัน (fingerprint): cols = 26 · policies = 4 · trig = 1 · cfg_v89 = 1 · claims = 0 (ครั้งแรก) ──
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'repair_claims') as cols,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'repair_claims') as policies,
  (select count(*) from pg_trigger where tgname = 'repair_guard' and not tgisinternal) as trig,
  (select count(*) from app_config where key = 'repair_config' and (value->>'v')::int = 89) as cfg_v89,
  (select count(*) from repair_claims) as claims;
