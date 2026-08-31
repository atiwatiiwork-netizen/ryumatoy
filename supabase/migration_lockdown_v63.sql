-- ============================================================================
-- Ryuma — v63: ปิดช่องโหว่วิกฤต 4 จุด (audit 2026-08-10) · วางใน SQL Editor แล้วกด Run
-- รันซ้ำได้ ไม่ทำข้อมูลเสีย · ไม่ต้องแก้โค้ดฝั่งแอปเลย (แอปทำงานเหมือนเดิมทุกอย่าง)
--
-- 🔧 แก้เพิ่ม (re-audit 2026-08-31 — ต้องรันไฟล์นี้ซ้ำถ้าเคยรันเวอร์ชันเก่าไปแล้ว):
--   · ส่วน 4: เดิม drop ชื่อ policy ผิด (sr_read) → anon ยังอ่าน stock_reservations ได้จริง (แก้แล้ว)
--   · ส่วน 2: guard ตั๋วบังคับ variant_id/qty ตอน insert + บังคับ variant_id/qr/approved_at/warehouse_*/
--            parcel_image/shipped_out_at กลับค่าเดิมตอน update (กันสลับรุ่น/ปลอมหลักฐานโกดัง)
--   · ยังต้องรัน migration_lockdown_v64.sql ต่อ (ปิด: ยกตัวเองเป็นแอดมิน, ลบแถวเงิน, จองปลอม)
--
-- ⚠ ด่วนที่สุดคือส่วนที่ 1 — ตอนนี้ใครก็ได้ที่รู้แค่ URL เว็บ สามารถ:
--   · ไล่ดูชื่อไฟล์ทั้งถัง (ทดสอบจริงแล้ว: 409 ไฟล์ · สลิปโอนเงินลูกค้า 156 ใบ)
--   · โหลดสลิปลูกค้าทุกใบ (ชื่อบัญชี/ยอด/เวลาโอน) — ทดสอบจริงแล้ว HTTP 200
--   · **เขียนทับไฟล์ใดก็ได้** รวม QR รับเงินของร้าน → ลูกค้าสแกนจ่ายเข้าบัญชีคนร้ายทั้งร้าน
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ถังไฟล์ `logos` — ปิดการไล่ดูชื่อไฟล์ + ปิดการเขียนทับ
--    เก็บ "โหลดผ่านลิงก์สาธารณะ" ไว้เหมือนเดิม (bucket public) เพื่อไม่ให้รูปสินค้า/QR
--    ที่เก็บ URL ไว้ในฐานข้อมูลแล้วพังทั้งร้าน — ลิงก์สาธารณะไม่ผ่าน RLS อยู่แล้ว
--    จึงตัด SELECT ของ anon ได้โดยไม่กระทบการแสดงรูป (แอปไม่เคยเรียก list() เลย)
-- ─────────────────────────────────────────────────────────────────────────────

-- ดู/ไล่รายชื่อไฟล์: เฉพาะคนที่ล็อกอินแล้ว (กันคนนอกไล่เก็บสลิปทั้งถัง)
drop policy if exists "logos public read" on storage.objects;
drop policy if exists "logos read authed" on storage.objects;
create policy "logos read authed" on storage.objects
  for select to authenticated using (bucket_id = 'logos');

-- อัปโหลดไฟล์ใหม่: เฉพาะคนที่ล็อกอินแล้ว (เดิมคนนอกอัปได้ = ถังขยะ/ของผิดกฎหมาย)
drop policy if exists "logos open insert" on storage.objects;
drop policy if exists "logos insert authed" on storage.objects;
create policy "logos insert authed" on storage.objects
  for insert to authenticated with check (bucket_id = 'logos');

-- ⛔ เขียนทับไฟล์เดิม: **ห้ามทุกคน** (ไม่สร้าง policy update เลย)
--    ชื่อไฟล์มี timestamp + สุ่ม 5 ตัวอยู่แล้ว การอัปโหลดใหม่จึงไม่เคยชนกัน
--    ผลที่ได้: QR ร้าน/สลิปลูกค้า ถูกสลับหรือทำลายไม่ได้อีก (หลักฐานการโอนแก้ไม่ได้)
drop policy if exists "logos open update" on storage.objects;

-- ⛔ ลบไฟล์: ห้ามเช่นกัน (ไม่เคยมี policy delete อยู่แล้ว — ประกาศไว้กันคนเผลอเพิ่มทีหลัง)
drop policy if exists "logos open delete" on storage.objects;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ตารางเงิน — ลูกค้าแก้ตัวเลขของตัวเองไม่ได้อีก
--    เดิม RLS เป็น `for all using (เป็นของฉัน)` = "ถ้าแถวนี้ของฉัน ฉันแก้ได้ทุกคอลัมน์"
--    และไม่มี trigger คุมคอลัมน์เลย → สมาชิก 1 บัญชียิง REST ตรงด้วย token ตัวเองก็:
--      · ตั้ง remaining_paid = ยอดค้าง → แอดมินเห็น "จ่ายครบ" แล้วปล่อยของ = เงินหาย
--      · insert ตั๋วใหม่ให้ตัวเองฟรี → ของถูกนับว่าขายแล้ว = ของไม่พอส่งคนที่จ่ายจริง
--
--    วิธีที่ใช้: trigger **บังคับค่ากลับ** (ไม่ใช่ raise error) — ของที่ลูกค้าส่งมาผิดจะถูก
--    เขียนทับด้วยค่าเดิมเงียบๆ ทำให้แอปที่เซฟทั้งแถว (optimistic sync) ไม่พังกลางคัน
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function ryuma_guard_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;

  if TG_OP = 'INSERT' then
    -- ⚠ แอปเซฟด้วย upsert → BEFORE INSERT ยิงแม้แถวมีอยู่แล้ว: ถ้าเป็นตั๋วเดิม (เช่นลูกค้าถือ
    --   ตั๋วมอบ/legacy กดเลือกวิธีรับของ) ต้องปล่อยผ่านไปให้ด่าน UPDATE คุม ไม่ใช่ raise
    --   (เหตุการณ์จริง 2026-08-31: guard เดิมทำตั๋วมอบเซฟล้มตลอด — แก้ใน v65 และที่นี่)
    if exists (select 1 from preorder_tickets t where t.id = new.id) then return new; end if;
    -- ตั๋วที่ลูกค้า "ออกเองได้" มีทางเดียว: ตัวกู้ตั๋วที่หายจากออเดอร์ที่อนุมัติแล้ว
    -- ซึ่ง id ต้องเป็น 't-<id ของรายการในออเดอร์>' (orderTicketId) และรายการนั้นต้องเป็นของเขาจริง
    if not exists (
      select 1 from order_items oi join orders o on o.id = oi.order_id
      where 't-' || oi.id = new.id
        and o.user_id = app_user_id()
        and o.status = 'approved'
        and oi.product_id = new.product_id
    ) then
      raise exception 'ryuma: ออกตั๋วเองไม่ได้ (ต้องมาจากออเดอร์ที่อนุมัติแล้วเท่านั้น)';
    end if;
    new.owner_id := app_user_id();
    new.remaining_paid := 0;            -- ห้ามเกิดมาพร้อม "จ่ายครบแล้ว"
    new.status := 'active';
    -- รุ่นย่อย + จำนวน ต้องมาจากรายการในออเดอร์ (กันสลับรุ่นแพงกว่า/ปั๊มจำนวน)
    new.variant_id := (select oi.variant_id from order_items oi where 't-' || oi.id = new.id);
    new.qty := coalesce((select oi.qty from order_items oi where 't-' || oi.id = new.id), 1);
    -- มัดจำต้องไม่เกินที่บันทึกไว้ในรายการของออเดอร์
    new.deposit_paid := least(coalesce(new.deposit_paid, 0),
      coalesce((select oi.deposit_amount from order_items oi where 't-' || oi.id = new.id), 0));
    return new;
  end if;

  -- UPDATE: ลูกค้าแตะได้อย่างเดียวคือ "วิธีรับของ" (delivery) — คอลัมน์อื่นบังคับกลับค่าเดิม
  new.deposit_paid     := old.deposit_paid;
  new.remaining_amount := old.remaining_amount;
  new.remaining_paid   := old.remaining_paid;
  new.status           := old.status;
  new.product_status   := old.product_status;
  new.ticket_no        := old.ticket_no;
  new.owner_id         := old.owner_id;
  new.original_buyer_id := old.original_buyer_id;
  new.product_id       := old.product_id;
  new.variant_id       := old.variant_id;      -- กันสลับรุ่นย่อยเป็นตัวแพงกว่าโดยยอดค้างเท่าเดิม
  new.batch_id         := old.batch_id;
  new.qty              := old.qty;
  new.parcel_no        := old.parcel_no;
  new.carrier          := old.carrier;
  new.approved_at      := old.approved_at;
  new.qr_code_url      := old.qr_code_url;
  -- หลักฐานเข้าโกดังจีน (gate ผลิต→เดินทาง) — ลูกค้าปลอม/รบกวนไม่ได้
  new.warehouse_at        := old.warehouse_at;
  new.warehouse_transport := old.warehouse_transport;
  new.warehouse_slip      := old.warehouse_slip;
  -- หลักฐาน/เวลาการส่งพัสดุ
  new.parcel_image     := old.parcel_image;
  new.shipped_out_at   := old.shipped_out_at;
  return new;
end $$;

drop trigger if exists ryuma_tickets_guard on preorder_tickets;
create trigger ryuma_tickets_guard before insert or update on preorder_tickets
  for each row execute function ryuma_guard_tickets();

create or replace function ryuma_guard_remaining()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    new.user_id     := app_user_id();
    new.status      := 'pending';       -- ลูกค้าอนุมัติสลิปให้ตัวเองไม่ได้
    new.approved_at := null;
    return new;
  end if;
  new.status      := old.status;        -- ห้ามเปลี่ยน pending → approved เอง
  new.amount      := old.amount;
  new.approved_at := old.approved_at;
  new.ticket_id   := old.ticket_id;
  new.user_id     := old.user_id;
  return new;
end $$;

drop trigger if exists ryuma_remaining_guard on remaining_payments;
create trigger ryuma_remaining_guard before insert or update on remaining_payments
  for each row execute function ryuma_guard_remaining();

create or replace function ryuma_guard_orders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    new.user_id := app_user_id();
    new.status  := 'pending_approval';  -- ลูกค้าอนุมัติออเดอร์ตัวเองไม่ได้
    return new;
  end if;
  new.status        := old.status;
  new.total_deposit := old.total_deposit;
  new.user_id       := old.user_id;
  new.approved_at   := old.approved_at;
  return new;
end $$;

drop trigger if exists ryuma_orders_guard on orders;
create trigger ryuma_orders_guard before insert or update on orders
  for each row execute function ryuma_guard_orders();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) สิทธิ์เข้าห้องประมูล — ลูกค้าตั้ง "อนุมัติแล้ว" ให้ตัวเองไม่ได้
--    (ฝั่งลูกค้ายังปิดอยู่ แต่ policy ถูก apply ตั้งแต่ v60 — ช่องเปิดทันทีที่เปิดหน้า)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_auction_entries()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    new.user_id     := app_user_id();
    new.status      := 'pending';
    new.approved_at := null;
    return new;
  end if;
  new.status      := old.status;
  new.approved_at := old.approved_at;
  new.user_id     := old.user_id;
  new.amount      := old.amount;
  return new;
end $$;

drop trigger if exists ryuma_auction_entries_guard on auction_entries;
create trigger ryuma_auction_entries_guard before insert or update on auction_entries
  for each row execute function ryuma_guard_auction_entries();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) ใบจองสต๊อก — ปิดไม่ให้คนนอก (ยังไม่ล็อกอิน) อ่าน
--    ทดสอบจริงแล้ว: anon อ่าน stock_reservations ได้ = รู้ว่าใครจองอะไรกี่ชิ้น
--    (ทะลุด่าน "แคตตาล็อกเฉพาะสมาชิก" v33)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists reservations_read on stock_reservations;
drop policy if exists stock_reservations_read on stock_reservations;
drop policy if exists reservations_read_authed on stock_reservations;
-- ⚠ ชื่อจริงของ policy public-read คือ `sr_read` (migration_reserve_v18.sql:22 `using(true)`)
--   เดิมพลาด drop ชื่อนี้ไป → policy permissive จะ OR กัน anon จึงยังอ่านได้แม้รัน v63
--   (ยืนยันด้วยการทดสอบจริง 2026-08-31: anon อ่าน stock_reservations ได้ 3 แถว)
drop policy if exists sr_read on stock_reservations;
create policy reservations_read_authed on stock_reservations
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ปิดช่อง "ยึดบัญชีด้วยเบอร์โทรอย่างเดียว"  ⚠ วิกฤต
--    เดิม ryuma_link_self ผูก session ปัจจุบันเข้ากับ "แถวผู้ใช้ที่เบอร์ตรงและ auth_id ว่าง"
--    โดยไม่ตรวจอะไรอีกเลย. คนร้ายที่รู้เบอร์เหยื่อ → ไปหน้าสมัครสมาชิก กรอกเบอร์เหยื่อ + PIN ตัวเอง
--    → supabase.auth.signUp สร้าง session ให้ก่อน (แม้ ryuma_signup_v2 จะตอบ 'phone_taken' ทีหลัง)
--    → ตัว self-heal เรียก RPC นี้ → แถวเหยื่อถูกผูกเข้ากับคนร้าย = เข้าเป็นเหยื่อเต็มตัว
--    (เห็นตั๋ว/ยอดค้าง/ที่อยู่ · สั่งของ/เลือกวิธีรับของแทนได้ · เหยื่อล็อกอินไม่ได้อีก)
--    ฝั่งแอปแก้ให้ signOut ทันทีที่สมัครไม่ผ่านแล้ว แต่ RPC ต้องรัดด้วย เพราะเรียกตรงได้
--
--    กติกาใหม่: ผูกอัตโนมัติได้เฉพาะแถวที่ "ยังไม่มีอะไรเลย" (ยังไม่อนุมัติ + ไม่มีตั๋ว + ไม่มีออเดอร์)
--    บัญชีลูกค้าจริงที่มีของ/มีประวัติ ต้องให้แอดมินช่วยผูกเท่านั้น (ปลอดภัยกว่าเสียเงิน)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_link_self()
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_email text; v_phone text; v_id text;
begin
  if v_uid is null then return json_build_object('error','no_session'); end if;
  if exists (select 1 from users where auth_id = v_uid) then return json_build_object('ok', true, 'already', true); end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then return json_build_object('error','no_email'); end if;
  v_phone := split_part(v_email, '@', 1);   -- อีเมลสังเคราะห์คือ {phone}@ryuma.local

  perform set_config('ryuma.trusted', 'on', true);
  -- (a) ผูกแถวเดิมที่ยังไม่มี auth — **เฉพาะแถวที่ยังไม่มีตัวตนจริง** เท่านั้น
  update users u set auth_id = v_uid
   where u.phone = v_phone
     and u.auth_id is null
     and coalesce(u.approved, false) = false                              -- ยังไม่ถูกอนุมัติ
     and not exists (select 1 from preorder_tickets t where t.owner_id = u.id)
     and not exists (select 1 from orders o where o.user_id = u.id)
  returning u.id into v_id;
  if v_id is not null then return json_build_object('ok', true, 'user_id', v_id, 'linked', true); end if;

  -- มีแถวของเบอร์นี้อยู่ แต่เป็นบัญชีที่ใช้งานจริงแล้ว → ห้ามผูกเอง ให้แอดมินจัดการ
  if exists (select 1 from users where phone = v_phone) then
    return json_build_object('error','needs_admin');
  end if;

  -- (b) ไม่มีแถวของเบอร์นี้เลย (auth กำพร้า) → สร้างแถวรออนุมัติให้
  v_id := gen_random_uuid()::text;
  insert into users(id, display_name, phone, rank, rank_seen, total_spent, preferred_lang, approved, pin_reset, auth_id)
    values (v_id, 'ลูกค้า ' || v_phone, v_phone, 'bronze', 'bronze', 0, 'th', false, false, v_uid);
  return json_build_object('ok', true, 'user_id', v_id, 'created', true);
end $$;

grant execute on function ryuma_link_self() to anon, authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select policyname, cmd, roles from pg_policies
--   where tablename = 'objects' and schemaname = 'storage' order by policyname;
--   → ต้องเหลือแค่ "logos read authed" (select) และ "logos insert authed" (insert)
--     **ห้ามมี update/delete**
-- select tgname from pg_trigger where tgrelid = 'preorder_tickets'::regclass and not tgisinternal;
--   → ต้องมี ryuma_tickets_guard
