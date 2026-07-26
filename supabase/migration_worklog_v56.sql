-- ============================================================================
-- v56 (2026-07-25): ประวัติการกระทำ (activity_logs) + นัดชำระ (payment_plans)
-- รันทั้งไฟล์ใน Supabase SQL Editor
-- ============================================================================

-- ── 1) ประวัติการกระทำ: ใครทำอะไร เมื่อไหร่ (write-only audit trail) ──
create table if not exists activity_logs (
  id           text primary key,
  actor_id     text,
  actor_name   text,
  action       text not null,
  summary      text not null,
  target_id    text,
  target_label text,
  amount       numeric,
  created_at   timestamptz not null default now()
);
create index if not exists activity_logs_created_idx on activity_logs (created_at desc);

alter table activity_logs enable row level security;
drop policy if exists activity_read on activity_logs;
drop policy if exists activity_write on activity_logs;
-- อ่านได้เฉพาะแอดมิน (ประวัติภายในร้าน)
create policy activity_read  on activity_logs for select using (is_app_admin());
-- เขียนได้ทุกคนที่ล็อกอิน (ลูกค้าก็สร้าง event ได้ เช่น ส่งสลิป) แต่ห้ามแก้/ลบ
create policy activity_write on activity_logs for insert with check (auth.uid() is not null);

-- ── 2) นัดชำระ: "หยิบของไว้ก่อน จ่ายสิ้นเดือน" + เตือนเมื่อถึงกำหนด ──
create table if not exists payment_plans (
  id          text primary key,
  user_id     text not null,
  due_date    date not null,
  note        text,
  amount      numeric not null default 0,
  items       jsonb not null default '[]'::jsonb,
  status      text not null default 'open',   -- open | done | cancelled
  reminded_at timestamptz,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists payment_plans_due_idx on payment_plans (due_date);

alter table payment_plans enable row level security;
drop policy if exists plans_own on payment_plans;
drop policy if exists plans_admin on payment_plans;
-- ลูกค้าจัดการนัดชำระของตัวเองได้ (สร้าง/แก้/ยกเลิก)
create policy plans_own   on payment_plans for all
  using (user_id = (select id from users where auth_id = auth.uid()))
  with check (user_id = (select id from users where auth_id = auth.uid()));
-- แอดมินเห็น/จัดการได้ทั้งหมด
create policy plans_admin on payment_plans for all using (is_app_admin()) with check (is_app_admin());
