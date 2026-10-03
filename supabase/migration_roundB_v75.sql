-- ============================================================================
-- Ryuma — v75: แก้บั๊กรอบ B (audit เปลี่ยนใบพรี 2026-10-03) — สถานะดีลตรง + ความปลอดภัย
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v74 ก่อน
--
--  R1-01 คนส่งถอนข้อเสนอได้หลังผู้รับโอนเงินแล้ว → ผู้รับเปิดหน้าโอนเงินแล้ว (payout_viewed_at) = คนส่งถอนเองไม่ได้
--        + สลิปที่แนบหลังดีลปิด/หมดเวลา ถูกเก็บเป็นหลักฐาน (review_reason 'late_slip') เข้าคิวแอดมิน ไม่หายเงียบ
--  R1-60 ระหว่าง 24 ชม. ตอนจ่ายไม่เช็คตั๋วซ้ำ → pay เช็คเจ้าของ/สถานะ/วิธีรับของอีกครั้ง
--  R1-09 ผู้รับเรียก release เปลี่ยนข้อเสนอเป็นประกาศล่องหน ล็อกตั๋วคนส่ง → release ใช้กับดีลตรงไม่ได้
--  R1-38 ส่งข้อเสนอซ้ำหลังเน็ตหลุด ได้ 'already_listed' แจ้งเตือนไม่ออก → ส่งซ้ำแบบเดิม = ok again
--  R1-03 ส่งข้อเสนอใช้ไล่เดาเลขกระเป๋าได้ไม่จำกัด → เช็คตั๋วก่อน + ต้องระบุผู้รับที่ยืนยันแล้ว + นับโควตา
--  R1-02 ข้ามเที่ยงคืนเลขเดิมเป็นของคนอื่น ข้อเสนอไปคนแปลกหน้า → p_expect_user ต้องตรงกับเจ้าของเลขตอนส่ง
--  R1-04 ข้อมูล push ของคนอื่นหลุดไปใช้ยิงข้อความเองได้ → API ส่ง push แบบระบุเครื่องเอง ใช้ได้เฉพาะแอดมิน (แก้ที่ฝั่งแอป /api/push-send)
--  R1-16 ดีลยกให้ฟรีรับ "สลิป" เป็นข้อความอะไรก็ได้ (javascript:) → ต้องเป็น https หรือว่าง · ฟรีไม่เก็บสลิป · ฟรีกด "ยังไม่ได้รับเงิน"/เตือนเงินไม่ได้
-- ⚠ ryuma_market_offer เปลี่ยนเป็น 6 พารามิเตอร์ — ต้อง deploy แอปเวอร์ชันใหม่พร้อมกัน (ลูกค้ายังไม่เห็นฟีเจอร์นี้)
-- ============================================================================

alter table ticket_transfers add column if not exists payout_viewed_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ส่งข้อเสนอ (แทน v73) — 6 พารามิเตอร์: + p_expect_user (คนที่ค้นเลขแล้วยืนยัน "ใช่คนนี้")
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists ryuma_market_offer(text, int, numeric, text, jsonb);
create or replace function ryuma_market_offer(p_ticket_id text, p_qty int, p_price numeric, p_code text, p_payout jsonb, p_expect_user text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); v_day date := ryuma_th_today(); v_code text; v_to text; v_n int; tgt users%rowtype;
  t preorder_tickets%rowtype; ex ticket_transfers%rowtype; v_reason text; v_id text; s record;
  v_until timestamptz := now() + interval '24 hours';
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_direct_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  if p_payout is null or coalesce(trim(p_payout->>'account_name'), '') = ''
     or (coalesce(p_payout->>'promptpay', '') = '' and coalesce(p_payout->>'account_no', '') = '') then
    return json_build_object('error', 'no_payout'); end if;
  -- ตั๋วก่อนเสมอ (R1-03): คนที่ไม่มีตั๋ว/ใช้ตั๋วคนอื่น ไม่ได้คำตอบใดๆ เกี่ยวกับเลขกระเป๋าเลย
  select * into t from preorder_tickets where id = p_ticket_id for update;
  if not found or t.owner_id is distinct from v_uid then return json_build_object('error', 'not_owner'); end if;
  -- ส่งซ้ำหลังเน็ตหลุด (R1-38): มีข้อเสนอค้างแบบเดียวกันอยู่แล้ว = สำเร็จเหมือนเดิม (push กันซ้ำเอง)
  select * into ex from ticket_transfers x
   where x.ticket_id = t.id and x.kind = 'direct' and x.from_user_id = v_uid and x.to_user_id = p_expect_user
     and x.status = 'reserved' and ryuma_market_live(x.status, x.hold_until, x.expires_at)
     and x.asking_price = p_price and coalesce(x.qty, t.qty) = p_qty
   limit 1;
  if found then
    return json_build_object('ok', true, 'again', true, 'id', ex.id, 'hold_until', ex.hold_until, 'server_now', now());
  end if;
  update ticket_transfers set status = 'expired', to_user_id = case when kind = 'direct' then to_user_id end, hold_until = null, updated_at = now()
   where ticket_id = t.id and status in ('listed', 'reserved')
     and not ryuma_market_live(status, hold_until, expires_at);
  v_reason := ryuma_market_block_reason(t.id, v_uid, p_qty);
  if v_reason is not null then return json_build_object('error', v_reason); end if;
  -- เลขกระเป๋า → ต้องเป็นคนเดียวกับที่ยืนยันไว้ (R1-02) · ไม่ตรง/ไม่มี = คำตอบเดียว + นับโควตาค้นเลข (R1-03)
  v_code := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  if length(v_code) <> 4 then return json_build_object('error', 'bad_code'); end if;
  select w.user_id into v_to from wallet_codes w where w.day = v_day and w.code = v_code;
  if v_to is null or p_expect_user is null or v_to is distinct from p_expect_user then
    insert into wallet_lookups (user_id, day, n) values (v_uid, v_day, 1)
      on conflict (user_id, day) do update set n = wallet_lookups.n + 1
      returning n into v_n;
    if v_n > 20 and not is_app_admin() then return json_build_object('error', 'too_many'); end if;
    return json_build_object('error', 'code_changed');
  end if;
  select * into tgt from users where id = v_to;
  if tgt.id = v_uid then return json_build_object('error', 'self'); end if;
  if tgt.approved is false or coalesce(tgt.suspended, false) then return json_build_object('error', 'not_ready'); end if;
  if coalesce(nullif(trim(tgt.shipping_address), ''), '') = '' then return json_build_object('error', 'no_address'); end if;
  select * into s from ryuma_split_share(p_qty, greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid);
  v_id := 'tr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  insert into ticket_transfers (id, ticket_id, from_user_id, to_user_id, asking_price, status, listed_at, hold_until, expires_at, qty,
                                product_id, variant_id, batch_id, order_item_id, kind, payout_snap, snap, updated_at)
  values (v_id, t.id, v_uid, v_to, p_price, 'reserved', now(), v_until, v_until, p_qty,
          t.product_id, t.variant_id, t.batch_id,
          case when t.id like 't-%' and exists (select 1 from order_items oi where oi.id = substr(t.id, 3)) then substr(t.id, 3) end,
          'direct',
          jsonb_build_object('promptpay', nullif(p_payout->>'promptpay', ''), 'bank', nullif(p_payout->>'bank', ''),
                             'account_no', nullif(p_payout->>'account_no', ''), 'account_name', trim(p_payout->>'account_name')),
          jsonb_build_object('paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid, 'total', s.c_dep + s.c_rem,
                             'product_status', t.product_status,
                             'ticket_hint', coalesce(substring(t.ticket_no from '^([A-Za-z]+-[0-9]{4}-[0-9]{2})'), 'RYU') || '-••••'),
          now());
  update users set payout_info = (select payout_snap from ticket_transfers where id = v_id) where id = v_uid;
  return json_build_object('ok', true, 'id', v_id, 'hold_until', v_until, 'server_now', now(),
    'to_mask', 'R•••' || right(coalesce(nullif(regexp_replace(coalesce(tgt.member_code, ''), '[^0-9]', '', 'g'), ''), tgt.id, '00'), 2));
end $$;
revoke all on function ryuma_market_offer(text, int, numeric, text, jsonb, text) from public, anon;
grant execute on function ryuma_market_offer(text, int, numeric, text, jsonb, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) บัญชีรับเงิน (แทน v73) — ผู้รับเปิดดูบัญชีของดีลตรง = เริ่มโอนแล้ว → บันทึก payout_viewed_at (คนส่งถอนเองไม่ได้อีก)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_payout(p_id text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_pay jsonb; v_live boolean;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  v_live := found and tr.status = 'reserved' and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at);
  if not found or tr.to_user_id is distinct from v_uid
     or not (tr.status in ('paid', 'reviewing', 'seller_ok') or v_live) then
    return json_build_object('error', 'not_found'); end if;
  if v_live and coalesce(tr.kind, 'market') = 'direct' and tr.payout_viewed_at is null and coalesce(tr.asking_price, 0) > 0 then
    update ticket_transfers set payout_viewed_at = now(), updated_at = now() where id = p_id;
  end if;
  v_pay := tr.payout_snap;
  if v_pay is null then select payout_info into v_pay from users where id = tr.from_user_id; end if;
  return json_build_object('ok', true, 'amount', tr.asking_price,
    'promptpay', v_pay->>'promptpay', 'bank', v_pay->>'bank',
    'account_no', v_pay->>'account_no', 'account_name', v_pay->>'account_name');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ถอนประกาศ/ถอนข้อเสนอ (แทน v73) — ดีลตรง: ผู้รับเปิดหน้าโอนเงินแล้ว คนส่งถอนเองไม่ได้ (ให้แอดมินยกเลิก) (R1-01)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_cancel(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_direct boolean;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  v_direct := coalesce(tr.kind, 'market') = 'direct';
  if not v_direct and tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until); end if;
  if v_direct and tr.status = 'reserved' and tr.payout_viewed_at is not null
     and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at) then
    return json_build_object('error', 'recipient_paying', 'at', tr.payout_viewed_at); end if;
  if tr.status not in ('listed', 'reserved') then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'seller',
         to_user_id = case when v_direct then to_user_id else null end,
         hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) แนบสลิป (แทน v73)
--    · สลิปต้องเป็น https (หรือว่างเฉพาะดีลยกให้ฟรี · ฟรีไม่เก็บสลิป) (R1-16)
--    · ดีลตรง: เช็คตั๋วซ้ำก่อนรับเงิน (R1-60)
--    · ดีลตรงที่ปิดไปแล้ว (คนส่งถอน/ผู้รับกดไม่รับ/แอดมินยกเลิก/หมดเวลา) แต่ผู้รับโอนไปแล้ว → เก็บสลิปเป็นหลักฐาน
--      review_reason 'late_slip' เข้าคิวแอดมิน "โอนแล้วแต่ดีลปิด" (R1-01) — ไม่ย้ายตั๋ว ไม่เปิดดีลใหม่
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_pay(p_id text, p_slip text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype;
        v_direct boolean; v_free boolean; v_live boolean; v_slip text := nullif(trim(coalesce(p_slip, '')), '');
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  if v_slip is not null and v_slip !~ '^https?://' then return json_build_object('error', 'bad_slip'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  v_direct := coalesce(tr.kind, 'market') = 'direct';
  v_free := v_direct and coalesce(tr.asking_price, 0) = 0;
  if not v_free and v_slip is null then return json_build_object('error', 'bad_slip'); end if;
  if tr.status = 'paid' then return json_build_object('ok', true, 'again', true); end if;
  v_live := tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now();

  if v_direct and v_live then
    select * into t from preorder_tickets where id = tr.ticket_id;
    if not found or t.owner_id is distinct from tr.from_user_id or t.status = 'shipped' or t.delivery is not null
       or coalesce(tr.qty, t.qty) > t.qty then
      update ticket_transfers
         set status = 'cancelled', cancelled_at = now(), cancel_reason = 'ticket_changed', hold_until = null,
             slip_url = case when v_free then null else v_slip end,
             paid_at = case when v_free then null else now() end,
             review_reason = case when v_free then review_reason else 'late_slip' end,
             reviewing_at = case when v_free then reviewing_at else now() end, updated_at = now()
       where id = p_id;
      return json_build_object('error', 'gone', 'recorded', not v_free);
    end if;
  end if;

  if not v_live then
    if v_direct and not v_free and tr.paid_at is null and tr.status in ('reserved', 'cancelled', 'expired') then
      update ticket_transfers
         set status = case when tr.status = 'reserved' then 'expired' else tr.status end,
             slip_url = v_slip, paid_at = now(), review_reason = 'late_slip', reviewing_at = now(),
             hold_until = null, updated_at = now()
       where id = p_id;
      return json_build_object('error', case when tr.status = 'cancelled' then 'withdrawn' else 'hold_expired' end, 'recorded', true);
    end if;
    return json_build_object('error', 'hold_expired');
  end if;

  update ticket_transfers set status = 'paid', slip_url = case when v_free then null else v_slip end, paid_at = now(), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true, 'paid_at', now());
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ผู้รับไม่รับ (แทน v73) — ดีลที่คนส่งถอน/แอดมินยกเลิกไปแล้ว ตอบ 'withdrawn' (เดิมตอบ ok แล้วจอขึ้น "แจ้งคนส่งแล้ว")
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_decline(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid or coalesce(tr.kind, 'market') <> 'direct' then
    return json_build_object('error', 'not_found'); end if;
  if tr.status = 'cancelled' and tr.cancel_reason = 'buyer_declined' then return json_build_object('ok', true, 'again', true); end if;
  if tr.status = 'cancelled' then return json_build_object('error', 'withdrawn'); end if;
  if tr.status <> 'reserved' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'buyer_declined', hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) ปล่อยจอง (แทน v71) — ใช้กับกระดานเท่านั้น · ดีลตรงให้ใช้ "ไม่รับ" (เดิมกลายเป็นประกาศล่องหนล็อกตั๋ว 24 ชม. · R1-09)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_release(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid or tr.status <> 'reserved' then
    return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'direct' then return json_build_object('error', 'use_decline'); end if;
  update ticket_transfers set status = 'listed', to_user_id = null, hold_until = null, updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) คนขายแจ้ง "ยังไม่ได้รับเงิน" (แทน v71) — ดีลยกให้ฟรีไม่มีเงินให้รับ (R1-16)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_seller_reject(p_id text, p_note text, p_evidence jsonb default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'direct' and coalesce(tr.asking_price, 0) = 0 then return json_build_object('error', 'free_deal'); end if;
  if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'reviewing', review_reason = 'not_received', review_note = left(coalesce(p_note, ''), 500),
         review_evidence = p_evidence, reviewing_at = now(), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) แอดมินปิดเรื่อง "โอนแล้วแต่ดีลปิด" หลังเคลียร์คืนเงิน/ตกลงกันแล้ว (บันทึกโน้ต · ไม่แตะตั๋ว)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_late_slip_resolve(p_id text, p_note text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null or not is_app_admin() then return json_build_object('error', 'admin_only'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.review_reason is distinct from 'late_slip' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set review_reason = 'late_slip_done', review_note = left(coalesce(p_note, ''), 500), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;
revoke all on function ryuma_market_late_slip_resolve(text, text) from public, anon;
grant execute on function ryuma_market_late_slip_resolve(text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) push (แทน v73) — + late_slip (ถึงแอดมิน+คนส่ง) · remind ใช้กับดีลที่มีเงินเท่านั้น
--    ⚠ ฟังก์ชันนี้ยังคืน endpoint ให้ผู้เรียก (API ส่ง push ต้องใช้) — ความปลอดภัยมาจาก API: โหมดระบุเครื่องเองใช้ได้เฉพาะแอดมิน
--      ลูกค้าที่ได้ endpoint ไปเอาไปยิงเองไม่ได้ เพราะต้องเซ็นด้วยกุญแจลับ VAPID ของร้านซึ่งอยู่ที่เซิร์ฟเวอร์เท่านั้น
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
    v_body  := v_name || ' — คนส่งถอนข้อเสนอแล้ว ถ้าโอนเงินไปแล้วให้แนบสลิปในหน้าดีลเพื่อแจ้งร้าน';
    v_to    := array_remove(array[tr.to_user_id], null);
  elsif p_kind = 'late_slip' then
    if not v_direct or tr.review_reason is distinct from 'late_slip' or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := '⚠️ ผู้รับโอนเงินแล้วแต่ดีลปิดไปก่อน';
    v_body  := v_name || ' · ฿' || v_price || ' — ร้านจะติดต่อเพื่อเคลียร์คืนเงิน';
    v_url   := '/market/' || tr.id;
    v_to    := array[tr.from_user_id] || v_admins;
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
    if tr.status not in ('paid', 'reviewing') or coalesce(tr.asking_price, 0) = 0
       or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
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

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select payout_viewed_at from ticket_transfers limit 1;                     -- คอลัมน์ใหม่
-- select pronargs from pg_proc where proname = 'ryuma_market_offer';          -- 6 (ตัวเดียว)
