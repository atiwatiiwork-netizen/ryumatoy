-- ============================================================================
-- v58 (2026-07-26): แก้ 3 รูที่ตรวจเจอจาก audit 4 ทีม — ทั้งหมดเป็นเรื่อง RLS/trigger
-- รันทั้งไฟล์ใน Supabase SQL Editor (ปลอดภัย รันซ้ำได้)
-- ============================================================================

-- ── 1) 🔴 คืนช่องทางให้ RPC ของเราเขียนคอลัมน์ที่ป้องกันไว้ ─────────────────
-- v23 เคยอนุญาต `current_setting('ryuma.trusted') = 'on'` เพื่อให้ SECURITY DEFINER RPC
-- ของเราเอง (ryuma_link_self / ryuma_link_auth / ryuma_set_new_pin / ryuma_signup_v2)
-- เขียน auth_id / fb_link / pin_reset ได้ — แต่ v40 เขียนฟังก์ชันทับโดยลืมเงื่อนไขนั้น
-- ผลคือ: ลูกค้าที่แถว users ยังไม่มี auth_id ล็อกอินแล้ว ryuma_link_self ถูก trigger เตะ
--        → ผูกบัญชีไม่สำเร็จตลอดกาล → ค้างหน้า "กำลังโหลดบัญชี…" เข้าร้านไม่ได้เลย
-- + เพิ่มข้อยกเว้น: ตั้ง "เบอร์ครั้งแรก" ได้ (null/ว่าง → มีค่า) เพราะหน้ากรอกที่อยู่
--   (ProfileGate) บันทึกเบอร์+ที่อยู่ในคำสั่งเดียว ถ้าโดนเตะ ที่อยู่ก็ไม่ถูกบันทึกไปด้วย
--   แล้วหน้ากรอกจะเด้งซ้ำทุกครั้งที่เปิดแอป — แก้ไม่ได้เลยจนกว่าแอดมินจะไปกรอกให้
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;
  if new.id          is distinct from old.id
     or new.auth_id     is distinct from old.auth_id
     or new.is_admin    is distinct from old.is_admin
     or new.approved    is distinct from old.approved
     or new.suspended   is distinct from old.suspended
     or new.rank        is distinct from old.rank
     or new.total_spent is distinct from old.total_spent
     or new.member_code is distinct from old.member_code
     -- เบอร์: ห้าม "เปลี่ยน" ของเดิม แต่ "ใส่ครั้งแรก" ได้
     or (new.phone is distinct from old.phone and coalesce(old.phone,'') <> '')
     or new.fb_link     is distinct from old.fb_link
     or new.pin_reset   is distinct from old.pin_reset
  then
    raise exception 'ryuma: not allowed to modify protected user columns';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_user on users;
create trigger trg_guard_user before update on users for each row execute function guard_user_columns();

-- ── 2) 🟠 ภารกิจ: ลูกค้าต้องอัปเดตแถวของตัวเองได้ ตอนระบบส่งซ้ำ ────────────
-- adapter เซฟด้วย upsert = INSERT .. ON CONFLICT DO UPDATE — Postgres จะตรวจ policy UPDATE
-- ตอนชนคีย์เสมอ (ไม่ได้ข้ามให้) ถ้าไม่มี policy จะ error 42501 แล้ววนพังทุกครั้งที่ flush
-- (เคสนี้เกิดเมื่อ flush รอบก่อนล้ม แล้วระบบ rewind ส่งแถวเดิมซ้ำ)
drop policy if exists mission_update_own on mission_submissions;
create policy mission_update_own on mission_submissions for update
  using (user_id = app_user_id() and status = 'pending')
  with check (user_id = app_user_id());

-- ── 3) ตรวจผลหลังรัน (ไม่บังคับ) ───────────────────────────────────────────
-- select proname from pg_proc where proname = 'guard_user_columns';
-- select polname from pg_policy where polrelid = 'mission_submissions'::regclass;
