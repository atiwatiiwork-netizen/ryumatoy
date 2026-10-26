-- ============================================================================
-- Ryuma — v90 เรื่องซ่อม: ด่านลำดับขั้นฝั่งแอดมิน + ปิดช่องส่งซ้ำของบัญชีที่ถูกระงับ (review รอบ 2 · 2026-10-26)
-- วางใน Supabase SQL Editor แล้วกด Run · รันซ้ำได้ · ต้องรัน v89 ก่อน (แทนที่ฟังก์ชัน ryuma_guard_repair ทั้งตัว)
--
-- แก้อะไร:
--  1) แอดมิน 2 เครื่องกดเรื่องเดียวกันในจังหวะเดียวกัน (ส่งที่อยู่ / แจ้งเลขส่งกลับ) — เดิม trigger ปล่อยแอดมินทุกอย่าง
--     → เครื่องที่สองทับค่าเครื่องแรก + push หาลูกค้าซ้ำ · ตอนนี้: ช่องของแต่ละขั้นแตะได้เฉพาะตอนอยู่ขั้นก่อนหน้า
--     และสถานะเดินได้ตามลำดับเท่านั้น (filed→address_sent→sent_to_tech→returned→done · ปิดเรื่อง(rejected)ได้ทุกขั้นที่ยังไม่จบ)
--  2) ส่งแถวซ้ำ (ลองใหม่) ข้ามเงียบๆ ได้เฉพาะตอนแถวบนเซิร์ฟเวอร์ยังเป็น "ยื่นเรื่อง" ของคนเดิม — ไม่งั้นบัญชีที่ถูกระงับ
--     (RLS ซ่อนแถวจน update โดน 0 แถว → แอปถอยไป upsert ทั้งแถว) จะได้ "บันทึกแล้ว" ทั้งที่ไม่ได้บันทึก
--  3) ข้อความปฏิเสธไม่โชว์ชื่อสถานะดิบ (rejected → sent_to_tech) ให้ลูกค้าเห็น
-- ============================================================================

create or replace function ryuma_guard_repair() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb;
  d_days int;
  d_transit int;
  t record;
  ddl timestamptz;
  cust_cols text[];
  stale constant text := 'ryuma: เรื่องนี้ถูกแก้จากเครื่องอื่นแล้ว — รีเฟรชหน้า';
begin
  -- ── แอดมิน: ทำได้ทุกช่อง แต่ต้องเดินตามลำดับขั้น (กัน 2 เครื่องกดพร้อมกัน / หน้าจอเก่าทับของใหม่) ──
  if is_app_admin() then
    if tg_op = 'UPDATE' then
      if new.status is distinct from old.status and not (
           (old.status = 'filed'        and new.status in ('address_sent', 'rejected'))
        or (old.status = 'address_sent' and new.status in ('sent_to_tech', 'rejected'))
        or (old.status = 'sent_to_tech' and new.status in ('returned', 'rejected'))
        or (old.status = 'returned'     and new.status in ('done', 'rejected'))
      ) then
        raise exception '%', stale;
      end if;
      -- ช่องของขั้นไหน แตะได้เฉพาะตอนกำลังเข้าขั้นนั้น (เครื่องที่สองส่งที่อยู่ซ้ำ = old.status ไม่ใช่ filed แล้ว → ตีกลับ)
      if new.address_sent_at is distinct from old.address_sent_at and old.status <> 'filed' then raise exception '%', stale; end if;
      if new.out_sent_at      is distinct from old.out_sent_at      and old.status <> 'address_sent' then raise exception '%', stale; end if;
      if new.back_sent_at     is distinct from old.back_sent_at     and old.status <> 'sent_to_tech' then raise exception '%', stale; end if;
      if new.received_at      is distinct from old.received_at      and old.status <> 'returned' then raise exception '%', stale; end if;
      if new.rejected_at      is distinct from old.rejected_at      and old.status in ('done', 'rejected') then raise exception '%', stale; end if;
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- ข้อความ raise ขึ้นต้น 'ryuma:' เสมอ = แอปรู้ว่า "ปฏิเสธถาวร" ไม่วนส่งซ้ำ และโชว์ข้อความนี้ให้ลูกค้าอ่านตรงๆ (persistErrors)
  if tg_op = 'INSERT' then
    -- แอปส่งแถวเดิมซ้ำได้ (เซฟติดแล้วแต่คำตอบหาย → ลองใหม่) → ข้ามเงียบๆ เฉพาะเมื่อแถวบนเซิร์ฟเวอร์ยังเป็นของคนเดิมที่ขั้นยื่นเรื่อง
    --   (ไม่งั้น = เครื่องที่ไม่มีสิทธิ์แก้แถวนี้ เช่น บัญชีถูกระงับ ถอยมา upsert ทั้งแถว → ต้องบอกว่าไม่ได้บันทึก)
    if exists (select 1 from repair_claims c where c.id = new.id) then
      if exists (select 1 from repair_claims c where c.id = new.id and c.user_id = app_user_id() and c.status = 'filed' and is_app_approved()) then
        return null;
      end if;
      raise exception 'ryuma: บันทึกไม่ได้ — เรื่องนี้ถูกแก้ไปแล้วหรือบัญชีไม่มีสิทธิ์ รีเฟรชหน้า';
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
    raise exception 'ryuma: สถานะเรื่องนี้เปลี่ยนไปแล้ว — รีเฟรชหน้า';
  end if;
  if (to_jsonb(new) - cust_cols) <> (to_jsonb(old) - cust_cols) then
    raise exception 'ryuma: ช่องนี้แก้ได้เฉพาะแอดมิน';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- trigger เดิม (repair_guard) ชี้ฟังก์ชันชื่อเดิม — ไม่ต้องสร้างใหม่

-- ── ตรวจหลังรัน (fingerprint): fn_v90 = 1 (ฟังก์ชันมีด่านแอดมินแล้ว) · trig = 1 ──
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ryuma_guard_repair' and p.prosrc like '%ถูกแก้จากเครื่องอื่นแล้ว%') as fn_v90,
  (select count(*) from pg_trigger where tgname = 'repair_guard' and not tgisinternal) as trig;
