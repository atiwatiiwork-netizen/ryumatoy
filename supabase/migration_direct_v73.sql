-- ============================================================================
-- Ryuma — v73: "เปลี่ยนใบพรี" ให้คนที่รู้จัก (direct transfer) · เฟส 1
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v71 + v72 ก่อน (รันแล้วทั้งคู่)
--
-- Flow ที่เจ้าของวาง (2026-10-02):
--   ทุกคนมี "เลขกระเป๋า 4 หลัก" รีเซ็ตทุกวัน (เวลาไทย) → คนขายเลือกตั๋ว → เติมมัดจำถ้าไม่เต็ม (สลิปเข้าร้าน
--   แยกหัวข้อ "เติมมัดจำ") → เลือกบัญชีรับเงิน + ยอด → ใส่เลขกระเป๋าผู้รับ → push ผู้รับ → ผู้รับโอน+สลิป
--   → คนขายยืนยัน → แอดมินไฟนอล (ryuma_market_finalize เดิม ไม่แตะ)
--
-- ไฟล์นี้ทำ 6 อย่าง:
--   1) คอลัมน์: ticket_transfers.kind ('market'|'direct') + payout_snap (บัญชีที่ล็อกกับดีล) · users.payout_accounts
--      + ตาราง wallet_codes (เลขรายวัน) · wallet_lookups (นับครั้งค้นเลข กันไล่เดา)
--   2) สวิตช์ ryuma_direct_open() — app_config 'market_direct' (ไม่มีแถว = ปิด · แอดมินใช้ได้เสมอเพื่อลอง)
--   3) RPC ใหม่ 4 ตัว: ryuma_wallet_code / ryuma_wallet_lookup / ryuma_market_offer / ryuma_market_decline
--   4) ทับ RPC เดิม 5 ตัว (ลายเซ็นเดิม): feed ซ่อนดีลตรง · reserve ปัดคนอื่น · cancel ให้คนขายถอนข้อเสนอได้ ·
--      payout อ่านบัญชีที่ล็อกกับดีล · pay ยอด 0 ไม่ต้องสลิป
--   5) ทับ ryuma_market_push_targets: ชนิดใหม่ offer / declined / withdrawn
--   6) สิทธิ์เรียก
-- ⚠ ฝั่งแอปต้อง deploy พร้อมกัน — ก่อน deploy: แอปเวอร์ชันเก่าไม่เรียกฟังก์ชันใหม่ ไม่มีอะไรพัง
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) คอลัมน์ + ตารางใหม่
-- ─────────────────────────────────────────────────────────────────────────────
alter table ticket_transfers
  add column if not exists kind        text,    -- null/'market' = กระดาน · 'direct' = เปลี่ยนใบให้คนที่ระบุ
  add column if not exists payout_snap jsonb;   -- บัญชีรับเงินที่ล็อกกับดีลตอนส่งข้อเสนอ (คนขายแก้บัญชีทีหลังไม่กระทบ)

alter table users add column if not exists payout_accounts jsonb;  -- [{id,bank,account_no,account_name,promptpay}] (guard ไม่ล็อก = ลูกค้าแก้เองได้)

create table if not exists wallet_codes (
  day        date not null,
  code       text not null,
  user_id    text not null,
  created_at timestamptz not null default now(),
  primary key (day, code)
);
create unique index if not exists wallet_codes_user_day on wallet_codes (user_id, day);
alter table wallet_codes enable row level security;
drop policy if exists wallet_codes_own on wallet_codes;
create policy wallet_codes_own on wallet_codes for select using (user_id = app_user_id() or is_app_admin());
-- ไม่มี policy เขียน = เขียนผ่าน RPC (security definer) เท่านั้น

create table if not exists wallet_lookups (
  user_id text not null,
  day     date not null,
  n       int  not null default 0,
  primary key (user_id, day)
);
alter table wallet_lookups enable row level security;  -- ไม่มี policy เลย = อ่าน/เขียนผ่าน RPC เท่านั้น

create index if not exists ticket_transfers_kind_idx on ticket_transfers (kind) where kind = 'direct';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) สวิตช์ — ไม่มีแถว = ปิด (เจ้าของ 2026-10-02: "อย่าเพิ่งเปิดให้ลูกค้าเห็น ทำพรีวิวให้เล่นก่อน")
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_direct_open()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> 'enabled')::boolean from app_config where key = 'market_direct'), false);
$$;

-- วันของไทย (เลขกระเป๋ารีเซ็ตเที่ยงคืนไทย ไม่ใช่ UTC)
create or replace function ryuma_th_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) RPC ใหม่
-- ─────────────────────────────────────────────────────────────────────────────

-- 3.1 เลขกระเป๋าของฉันวันนี้ — ยังไม่มี = สุ่ม 4 หลักที่ไม่ชนใครในวันนั้น (unique (day, code) เป็นด่านจริง)
create or replace function ryuma_wallet_code()
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); v_day date := ryuma_th_today(); v_code text; i int;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_direct_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  select code into v_code from wallet_codes where user_id = v_uid and day = v_day;
  if v_code is null then
    for i in 1..80 loop
      v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      begin
        insert into wallet_codes (day, code, user_id) values (v_day, v_code, v_uid);
        exit;
      exception when unique_violation then
        -- ชนเลขคนอื่น → สุ่มใหม่ · ถ้าชน (user_id, day) = อีกเครื่องของคนเดียวกันเพิ่งสร้าง → อ่านของเขา
        select code into v_code from wallet_codes where user_id = v_uid and day = v_day;
        if v_code is not null then exit; end if;
        v_code := null;
      end;
    end loop;
  end if;
  if v_code is null then return json_build_object('error', 'busy'); end if;
  return json_build_object('ok', true, 'code', v_code, 'day', v_day,
    'resets_at', ((v_day + 1)::timestamp at time zone 'Asia/Bangkok'), 'server_now', now());
end $$;

-- 3.2 ค้นเลขกระเป๋า → ใครคือผู้รับ (ชื่อ+รูป เพื่อยืนยัน "ใช่คนนี้ไหม") · จำกัด 20 ครั้ง/วัน กันไล่เดา
--     คืนเฉพาะคนที่รับใบได้จริง (อนุมัติแล้ว · ไม่ถูกระงับ · มีที่อยู่) — เหตุผลที่ไม่ผ่านไม่บอกรายละเอียดอื่น
create or replace function ryuma_wallet_lookup(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); v_day date := ryuma_th_today(); v_code text; v_n int; u users%rowtype;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_direct_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  v_code := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  if length(v_code) <> 4 then return json_build_object('error', 'bad_code'); end if;
  insert into wallet_lookups (user_id, day, n) values (v_uid, v_day, 1)
    on conflict (user_id, day) do update set n = wallet_lookups.n + 1
    returning n into v_n;
  if v_n > 20 and not is_app_admin() then return json_build_object('error', 'too_many'); end if;
  select u2.* into u from wallet_codes w join users u2 on u2.id = w.user_id where w.day = v_day and w.code = v_code;
  if not found then return json_build_object('error', 'not_found'); end if;
  if u.id = v_uid then return json_build_object('error', 'self'); end if;
  if u.approved is false or coalesce(u.suspended, false) then return json_build_object('error', 'not_ready'); end if;
  if coalesce(nullif(trim(u.shipping_address), ''), '') = '' then return json_build_object('error', 'no_address'); end if;
  return json_build_object('ok', true, 'user_id', u.id, 'name', u.display_name, 'avatar_url', u.avatar_url,
    'mask', 'R•••' || right(coalesce(nullif(regexp_replace(coalesce(u.member_code, ''), '[^0-9]', '', 'g'), ''), u.id, '00'), 2));
end $$;

-- 3.3 ส่งข้อเสนอ "เปลี่ยนใบพรี" ให้คนที่ระบุด้วยเลขกระเป๋า
--     = แถว ticket_transfers สถานะ reserved ล็อกผู้รับทันที (ไม่ขึ้นกระดาน) · ผู้รับมี 24 ชม. โอน+แนบสลิป
--     · บัญชีรับเงินถูกก๊อปปี้ลง payout_snap (ผู้รับโอนเข้าบัญชีที่เห็นตอนนั้นเสมอ)
create or replace function ryuma_market_offer(p_ticket_id text, p_qty int, p_price numeric, p_code text, p_payout jsonb)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); v_day date := ryuma_th_today(); v_code text; v_to text; tgt users%rowtype;
  t preorder_tickets%rowtype; v_reason text; v_id text; s record; v_until timestamptz := now() + interval '24 hours';
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_direct_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  if p_payout is null or coalesce(p_payout->>'account_name', '') = ''
     or (coalesce(p_payout->>'promptpay', '') = '' and coalesce(p_payout->>'account_no', '') = '') then
    return json_build_object('error', 'no_payout'); end if;
  -- ผู้รับ (กติกาเดียวกับ ryuma_wallet_lookup)
  v_code := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  if length(v_code) <> 4 then return json_build_object('error', 'bad_code'); end if;
  select u2.* into tgt from wallet_codes w join users u2 on u2.id = w.user_id where w.day = v_day and w.code = v_code;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tgt.id = v_uid then return json_build_object('error', 'self'); end if;
  if tgt.approved is false or coalesce(tgt.suspended, false) then return json_build_object('error', 'not_ready'); end if;
  if coalesce(nullif(trim(tgt.shipping_address), ''), '') = '' then return json_build_object('error', 'no_address'); end if;
  v_to := tgt.id;
  -- ตั๋ว (ด่านเดียวกับลงกระดาน)
  select * into t from preorder_tickets where id = p_ticket_id for update;
  if not found then return json_build_object('error', 'ticket_missing'); end if;
  update ticket_transfers set status = 'expired', to_user_id = null, hold_until = null, updated_at = now()
   where ticket_id = t.id and status in ('listed', 'reserved')
     and not ryuma_market_live(status, hold_until, expires_at);
  v_reason := ryuma_market_block_reason(t.id, v_uid, p_qty);
  if v_reason is not null then return json_build_object('error', v_reason); end if;
  select * into s from ryuma_split_share(p_qty, greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid);
  v_id := 'tr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  insert into ticket_transfers (id, ticket_id, from_user_id, to_user_id, asking_price, status, listed_at, hold_until, expires_at, qty,
                                product_id, variant_id, batch_id, order_item_id, kind, payout_snap, snap, updated_at)
  values (v_id, t.id, v_uid, v_to, p_price, 'reserved', now(), v_until, v_until, p_qty,
          t.product_id, t.variant_id, t.batch_id,
          case when t.id like 't-%' and exists (select 1 from order_items oi where oi.id = substr(t.id, 3)) then substr(t.id, 3) end,
          'direct',
          jsonb_build_object('promptpay', nullif(p_payout->>'promptpay', ''), 'bank', nullif(p_payout->>'bank', ''),
                             'account_no', nullif(p_payout->>'account_no', ''), 'account_name', p_payout->>'account_name'),
          jsonb_build_object('paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid, 'total', s.c_dep + s.c_rem,
                             'product_status', t.product_status,
                             'ticket_hint', coalesce(substring(t.ticket_no from '^([A-Za-z]+-[0-9]{4}-[0-9]{2})'), 'RYU') || '-••••'),
          now());
  -- บัญชีที่เลือกล่าสุด = บัญชีหลัก (ryuma_market_payout เดิม/กระดานอ่านช่องนี้)
  update users set payout_info = (select payout_snap from ticket_transfers where id = v_id) where id = v_uid;
  return json_build_object('ok', true, 'id', v_id, 'hold_until', v_until, 'server_now', now(),
    'to_mask', 'R•••' || right(coalesce(nullif(regexp_replace(coalesce(tgt.member_code, ''), '[^0-9]', '', 'g'), ''), tgt.id, '00'), 2));
end $$;

-- 3.4 ผู้รับปฏิเสธข้อเสนอ (ยังไม่ได้โอน) → ปิดดีล ปลดล็อกตั๋วทันที
create or replace function ryuma_market_decline(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid or coalesce(tr.kind, 'market') <> 'direct' then
    return json_build_object('error', 'not_found'); end if;
  if tr.status = 'cancelled' then return json_build_object('ok', true, 'again', true); end if;
  if tr.status <> 'reserved' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'buyer_declined', hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) ทับ RPC เดิม (ลายเซ็นเดิม สิทธิ์เรียกคงอยู่)
-- ─────────────────────────────────────────────────────────────────────────────

-- 4.1 กระดาน (ทับ v72) — ดีลตรงไม่ขึ้นกระดาน
create or replace function ryuma_market_feed()
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid text := app_user_id();
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_market_open() and not is_app_admin() then
    return json_build_object('ok', true, 'closed', true, 'server_now', now(), 'rows', '[]'::json); end if;
  return json_build_object('ok', true, 'closed', not ryuma_market_open(), 'server_now', now(), 'rows', coalesce((
    select json_agg(row_to_json(x) order by x.listed_at desc) from (
      select tr.id, tr.product_id, tr.variant_id, tr.batch_id,
             t.product_status, t.warehouse_at,
             coalesce(tr.qty, t.qty) as qty, t.qty as ticket_qty,
             tr.asking_price, tr.listed_at, tr.expires_at,
             case when tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then 'reserved' else 'listed' end as status,
             case when tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then tr.hold_until end as hold_until,
             (tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() and tr.to_user_id = v_uid) as reserved_by_me,
             (tr.from_user_id = v_uid) as mine,
             s.c_dep + s.c_paid as paid, s.c_rem - s.c_paid as due, s.c_dep + s.c_rem as total,
             'R•••' || right(coalesce(nullif(regexp_replace(coalesce(u.member_code, ''), '[^0-9]', '', 'g'), ''), u.id, '00'), 2) as seller,
             u.rank as seller_rank,
             (select count(*) from ticket_transfers d where d.from_user_id = tr.from_user_id and d.status in ('done', 'approved')) as seller_sold,
             coalesce(substring(t.ticket_no from '^([A-Za-z]+-[0-9]{4}-[0-9]{2})'), 'RYU') || '-••••' as ticket_hint
        from ticket_transfers tr
        join preorder_tickets t on t.id = tr.ticket_id
        left join users u on u.id = tr.from_user_id
        cross join lateral ryuma_split_share(coalesce(tr.qty, t.qty), greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid) s
       where tr.status in ('listed', 'reserved')
         and coalesce(tr.kind, 'market') = 'market'
         and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at)
    ) x), '[]'::json));
end $$;

-- 4.2 จอง (ทับ v72) — ดีลตรง: คนอื่นจองไม่ได้ (ผู้รับที่ถูกระบุไว้กดซ้ำ = ok again)
create or replace function ryuma_market_reserve(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; v_until timestamptz;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'direct' then
    if tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
    if tr.status = 'reserved' and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at) then
      return json_build_object('ok', true, 'again', true, 'hold_until', tr.hold_until, 'server_now', now()); end if;
    return json_build_object('error', 'gone', 'status', tr.status);
  end if;
  if not ryuma_market_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if coalesce((select nullif(trim(shipping_address), '') from users where id = v_uid), '') = '' then
    return json_build_object('error', 'no_address'); end if;
  if tr.from_user_id = v_uid then return json_build_object('error', 'own_listing'); end if;
  if tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    if tr.to_user_id = v_uid then
      return json_build_object('ok', true, 'again', true, 'hold_until', tr.hold_until, 'server_now', now()); end if;
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until);
  end if;
  if tr.status not in ('listed', 'reserved') or not (tr.expires_at is null or tr.expires_at > now()) then
    return json_build_object('error', 'gone', 'status', tr.status); end if;
  if exists (select 1 from ticket_transfers x
              where x.to_user_id = v_uid and x.id <> p_id and x.status = 'reserved' and coalesce(x.kind, 'market') = 'market'
                and x.hold_until + interval '10 minutes' > now()) then
    return json_build_object('error', 'one_at_a_time'); end if;
  select * into t from preorder_tickets where id = tr.ticket_id;
  if not found or t.owner_id is distinct from tr.from_user_id or t.status = 'shipped' or t.delivery is not null
     or coalesce(tr.qty, t.qty) > t.qty
     or exists (select 1 from remaining_payments r where r.ticket_id = t.id and r.status = 'pending') then
    update ticket_transfers set status = 'cancelled', cancelled_at = now(), cancel_reason = 'ticket_changed',
           to_user_id = null, hold_until = null, updated_at = now() where id = p_id;
    return json_build_object('error', 'gone', 'status', 'cancelled');
  end if;
  v_until := now() + interval '15 minutes';
  update ticket_transfers set status = 'reserved', to_user_id = v_uid, hold_until = v_until, updated_at = now() where id = p_id;
  return json_build_object('ok', true, 'hold_until', v_until, 'server_now', now());
end $$;

-- 4.3 ถอนประกาศ/ถอนข้อเสนอ (ทับ v71) — ดีลตรง: คนขายถอนได้ตลอดจนกว่าผู้รับจะแนบสลิป
create or replace function ryuma_market_cancel(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'market' and tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until); end if;
  if tr.status not in ('listed', 'reserved') then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'seller',
         to_user_id = case when coalesce(tr.kind, 'market') = 'direct' then to_user_id else null end,
         hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 4.4 บัญชีรับเงิน (ทับ v71) — ดีลตรงอ่านบัญชีที่ล็อกไว้กับดีล · เปิดให้เฉพาะผู้รับของดีลนี้
create or replace function ryuma_market_payout(p_id text)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_pay jsonb;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id;
  if not found or tr.to_user_id is distinct from v_uid
     or not (tr.status in ('paid', 'reviewing', 'seller_ok')
             or (tr.status = 'reserved' and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at))) then
    return json_build_object('error', 'not_found'); end if;
  v_pay := tr.payout_snap;
  if v_pay is null then select payout_info into v_pay from users where id = tr.from_user_id; end if;
  return json_build_object('ok', true, 'amount', tr.asking_price,
    'promptpay', v_pay->>'promptpay', 'bank', v_pay->>'bank',
    'account_no', v_pay->>'account_no', 'account_name', v_pay->>'account_name');
end $$;

-- 4.5 แนบสลิป (ทับ v71) — ดีลตรงยอด 0 (ยกให้) ไม่ต้องมีสลิป · เวลาจองของดีลตรง = 24 ชม. (hold_until)
create or replace function ryuma_market_pay(p_id text, p_slip text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_free boolean;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  v_free := coalesce(tr.kind, 'market') = 'direct' and coalesce(tr.asking_price, 0) = 0;
  if not v_free and coalesce(p_slip, '') !~ '^https?://' then return json_build_object('error', 'bad_slip'); end if;
  if tr.status = 'paid' then return json_build_object('ok', true, 'again', true); end if;
  if tr.status <> 'reserved' or tr.hold_until + interval '10 minutes' <= now() then
    return json_build_object('error', 'hold_expired'); end if;
  update ticket_transfers set status = 'paid', slip_url = nullif(p_slip, ''), paid_at = now(), updated_at = now() where id = p_id;
  return json_build_object('ok', true, 'paid_at', now());
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) push (ทับ v72) — + offer (ถึงผู้รับ) · declined (ผู้รับไม่รับ → คนขาย) · withdrawn (คนขายถอน → ผู้รับ)
--    ห้ามบอกจำนวน/สต๊อก (DNA push no-qty) · ชนิดเดิมยิงซ้ำไม่ได้ (remind: เว้น 1 ชม.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_push_targets(p_id text, p_kind text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid text := app_user_id(); v_admin boolean := is_app_admin(); v_open boolean := ryuma_market_open();
  tr ticket_transfers%rowtype; v_last timestamptz; v_name text; v_mk text; v_fr text; v_price text; v_direct boolean;
  v_to text[] := '{}'; v_admins text[]; v_title text; v_body text; v_url text := '/market/mine';
  v_empty json := json_build_object('targets', '[]'::json);
begin
  if v_uid is null then return v_empty; end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return v_empty; end if;
  if not v_admin and v_uid is distinct from tr.from_user_id and v_uid is distinct from tr.to_user_id then return v_empty; end if;
  begin v_last := (tr.pushed ->> p_kind)::timestamptz; exception when others then v_last := null; end;
  if v_last is not null and (p_kind <> 'remind' or v_last > now() - interval '1 hour') then return v_empty; end if;
  v_direct := coalesce(tr.kind, 'market') = 'direct';
  select p.series_name, p.manufacturer_id, p.franchise_id into v_name, v_mk, v_fr from products p where p.id = tr.product_id;
  v_name := coalesce(v_name, 'ใบพรี');
  v_price := to_char(tr.asking_price, 'FM999,999,990');
  select coalesce(array_agg(u.id), '{}') into v_admins from users u where u.is_admin;

  if p_kind = 'listed' then
    if v_direct or tr.status <> 'listed' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    if exists (select 1 from push_config c where c.key = 'market_new' and c.enabled = false) then return v_empty; end if;
    v_title := '🆕 ตลาดใบพรี · ลงขายใหม่';
    v_body  := v_name || ' · ฿' || v_price;
    v_url   := '/market/' || tr.id;
    select coalesce(array_agg(u.id), '{}') into v_to from users u
     where u.id <> tr.from_user_id and u.approved is not false and coalesce(u.suspended, false) = false
       and (v_open or u.is_admin)
       and not exists (select 1 from push_prefs pp where pp.user_id = u.id
                        and (v_mk = any(pp.maker_ids) or v_fr = any(pp.franchise_ids)));
  elsif p_kind = 'offer' then
    if not v_direct or tr.status <> 'reserved' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    v_title := '🎁 มีคนเปลี่ยนใบพรีให้คุณ';
    v_body  := v_name || case when coalesce(tr.asking_price, 0) > 0 then ' · โอน ฿' || v_price || ' ภายใน 24 ชม. แล้วแนบสลิป' else ' · ยกให้ฟรี — เปิดดูแล้วกดรับ' end;
    v_url   := '/market/' || tr.id;
    v_to    := array[tr.to_user_id];
  elsif p_kind = 'declined' then
    if not v_direct or tr.status <> 'cancelled' or tr.cancel_reason <> 'buyer_declined' or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := '↩️ ผู้รับไม่รับข้อเสนอ';
    v_body  := v_name || ' — ใบพรีปลดล็อกแล้ว ส่งให้คนอื่นได้';
    v_to    := array[tr.from_user_id];
  elsif p_kind = 'withdrawn' then
    if not v_direct or tr.status <> 'cancelled' or tr.cancel_reason <> 'seller' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    v_title := '❌ ข้อเสนอถูกถอน';
    v_body  := v_name || ' — คนส่งถอนข้อเสนอแล้ว';
    v_to    := array_remove(array[tr.to_user_id], null);
  elsif p_kind = 'reserved' then
    if v_direct or tr.status <> 'reserved' or v_uid is distinct from tr.to_user_id then return v_empty; end if;
    v_title := '🛒 มีคนกำลังซื้อใบของคุณ';
    v_body  := v_name || ' — ถ้าเขาโอนมา จะแจ้งให้เช็คบัญชีทันที';
    v_to    := array[tr.from_user_id];
  elsif p_kind = 'paid' then
    if tr.status <> 'paid' or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := case when coalesce(tr.asking_price, 0) > 0 then '💸 มีคนโอนเงินให้คุณแล้ว' else '🤝 ผู้รับกดรับใบพรีแล้ว' end;
    v_body  := v_name || case when coalesce(tr.asking_price, 0) > 0 then ' · ฿' || v_price || ' — เช็คบัญชีแล้วกดยืนยันรับเงิน' else ' — กดยืนยันเพื่อส่งให้ร้านโอนสิทธิ์' end;
    v_to    := array[tr.from_user_id] || v_admins;
  elsif p_kind = 'seller_ok' then
    if tr.status <> 'seller_ok' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    v_title := '✅ คนขายยืนยันรับเงินแล้ว';
    v_body  := v_name || ' — รอร้านโอนสิทธิ์ให้';
    v_to    := array[tr.to_user_id] || v_admins;
  elsif p_kind = 'reviewing' then
    if tr.status <> 'reviewing' then return v_empty; end if;
    v_title := '🔎 ร้านกำลังตรวจสอบดีล';
    v_body  := v_name || ' — แอดมินจะติดต่อเพื่อเคลียร์ให้';
    v_to    := array[tr.from_user_id, tr.to_user_id] || v_admins;
  elsif p_kind = 'remind' then
    if tr.status not in ('paid', 'reviewing') or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := '⏰ มีเงินรอคุณยืนยัน';
    v_body  := v_name || ' · ฿' || v_price || ' — เปิดแอปธนาคารเช็ค แล้วกดยืนยันรับเงิน';
    v_to    := array[tr.from_user_id];
  elsif p_kind = 'done' then
    if tr.status not in ('done', 'approved') or not v_admin then return v_empty; end if;
    v_title := '🎉 ใบพรีเข้ากระเป๋าแล้ว!';
    v_body  := v_name || coalesce(' · ' || tr.new_ticket_no, '');
    v_url   := '/wallet/' || coalesce(tr.new_ticket_no, '');
    v_to    := array[tr.to_user_id];
  elsif p_kind = 'sold' then
    if tr.status not in ('done', 'approved') or not v_admin then return v_empty; end if;
    v_title := case when v_direct then '🤝 เปลี่ยนใบพรีสำเร็จ' else '🤝 ขายสำเร็จแล้ว' end;
    v_body  := v_name || ' — ร้านโอนสิทธิ์ให้ผู้รับเรียบร้อย';
    v_to    := array[tr.from_user_id];
  elsif p_kind = 'cancelled' then
    if tr.status <> 'cancelled' or not v_admin then return v_empty; end if;
    v_title := '❌ ดีลถูกยกเลิก';
    v_body  := v_name || ' — ดูรายละเอียดในรายการซื้อขายของคุณ';
    v_to    := array_remove(array[tr.from_user_id, tr.to_user_id], null);
  else
    return v_empty;
  end if;

  update ticket_transfers set pushed = coalesce(pushed, '{}'::jsonb) || jsonb_build_object(p_kind, now()) where id = p_id;
  return json_build_object('title', v_title, 'body', v_body, 'url', v_url, 'targets', coalesce((
    select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
      from push_subscriptions s where s.user_id = any(v_to)), '[]'::json));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) สิทธิ์เรียก — ฟังก์ชันใหม่ให้เฉพาะคนล็อกอิน
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function ryuma_direct_open()                                          from public, anon;
revoke all on function ryuma_th_today()                                             from public, anon;
revoke all on function ryuma_wallet_code()                                          from public, anon;
revoke all on function ryuma_wallet_lookup(text)                                    from public, anon;
revoke all on function ryuma_market_offer(text, int, numeric, text, jsonb)          from public, anon;
revoke all on function ryuma_market_decline(text)                                   from public, anon;
grant execute on function ryuma_direct_open()                                   to authenticated;
grant execute on function ryuma_th_today()                                      to authenticated;
grant execute on function ryuma_wallet_code()                                   to authenticated;
grant execute on function ryuma_wallet_lookup(text)                             to authenticated;
grant execute on function ryuma_market_offer(text, int, numeric, text, jsonb)   to authenticated;
grant execute on function ryuma_market_decline(text)                            to authenticated;
-- ฟังก์ชันที่ทับด้วยลายเซ็นเดิม (feed/reserve/cancel/payout/pay/push_targets) สิทธิ์ของ v71/v72 ยังอยู่ครบ

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select kind, payout_snap from ticket_transfers limit 1;             -- คอลัมน์ใหม่
-- select ryuma_direct_open();                                         -- false จนกว่าจะกดเปิดในหน้าแอดมิน
-- select count(*) from pg_proc where proname in ('ryuma_wallet_code','ryuma_wallet_lookup','ryuma_market_offer','ryuma_market_decline'); -- 4
