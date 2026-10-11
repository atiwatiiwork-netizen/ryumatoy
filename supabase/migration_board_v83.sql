-- ============================================================================
-- Ryuma — v83: ตลาดใบพรี "ก่อนเปิดสวิตช์" (รอบ 4 ของ audit 1005) — ผลจากจำลองสถานการณ์กระดานบน Postgres จริง
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v71–v79 ก่อน (รันแล้ว)
-- ลูกค้ายังไม่เห็นตลาด (สวิตช์ market_public / market_direct ยังปิด) — ไฟล์นี้ไม่เปิดอะไรให้ใคร
--
--  1) ตั๋วจำนวนชิ้นว่าง (qty null) ลงขาย 2 ชิ้นได้ แล้วระบบแบ่งเงินเป็น 2 เท่า = เสกมัดจำ
--     → เติม 1 ให้แถวที่ว่าง + ค่าเริ่มต้น 1 + ห้ามว่าง · ด่านลงขาย/โอนสิทธิ์กันซ้ำอีกชั้น
--  2) ตั๋วรอบพิเศษลงขายได้ทั้งที่รอบยังเปิดขายอยู่ (ร้านยังขายตัวเดียวกัน) → still_open จนกว่ารอบปิด/หมด
--  3) สลิปรับลิงก์จากเว็บไหนก็ได้ (ผู้ซื้อแนบลิงก์ที่สลับรูปทีหลังได้/ลิงก์หลอก) → ต้องเป็นรูปในที่เก็บรูปของร้านเท่านั้น
--     (หลักฐานของคนขายก็เช่นกัน — ลิงก์นอกร้านถูกตัดทิ้ง)
--  4) แอดมินยกเลิกดีลที่ผู้ซื้อโอนเงินแล้ว → ดีลหายจากทุกคิว ไม่มีใครตามคืนเงิน → เข้าคิว "เคลียร์คืนเงิน" (late_slip)
--  5) ลงขายแล้วถอนเอง (ไม่มีเงินเปลี่ยนมือ) ถูกนับเป็น "ประวัติซื้อขาย" ตลอดไป → แอดมินแก้/ลบตั๋ว/ลดรายการไม่ได้
--     → นับเฉพาะดีลที่มีเงินเปลี่ยนมือ / โอนสิทธิ์แล้ว / ยังค้างอยู่
--  6) จอง: ล็อกแถวผู้ซื้อ (กดจอง 2 ใบพร้อมกันทะลุกติกา "จองทีละใบ")
--  7) โอนสิทธิ์: ล็อกเลขฐานตั๋ว (โอนใบแม่กับใบลูกพร้อมกันได้เลข -T<n> ชนกัน)
--  8) ส่งข้อเสนอเปลี่ยนใบ: เดาเลขกระเป๋าผิดจนเกินเพดานแล้ว "เดาถูก" ยังผ่าน = เดาได้ไม่จำกัด → นับทุกครั้ง + เกินเพดานปฏิเสธก่อน
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) จำนวนชิ้นของตั๋วห้ามว่าง (เงินแบ่งตามจำนวนชิ้น)
-- ─────────────────────────────────────────────────────────────────────────────
select set_config('ryuma.market_rpc', 'on', false);   -- ให้ guard ตั๋วยอมให้เติมค่า (ทางเดียวกับไฟนอล)
update preorder_tickets set qty = 1 where qty is null;
select set_config('ryuma.market_rpc', 'off', false);
alter table preorder_tickets alter column qty set default 1;
alter table preorder_tickets alter column qty set not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) "มีประวัติซื้อขาย" = ดีลที่มีเงินเปลี่ยนมือ / โอนสิทธิ์แล้ว / ยังค้างอยู่ (ทับ v74)
--    ลงขายแล้วถอน / หมดอายุโดยไม่มีใครโอน = ไม่ใช่ประวัติ (แอดมินแก้/ลบตั๋วได้ตามปกติ)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_transfer_counts(p_status text, p_paid_at timestamptz, p_hold timestamptz, p_exp timestamptz)
returns boolean language sql stable as $$
  select p_status in ('done', 'approved') or p_paid_at is not null or ryuma_market_live(p_status, p_hold, p_exp);
$$;

create or replace function ryuma_ticket_market_history(p_id text, p_split_from text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_split_from is not null
      or exists (select 1 from ticket_transfers tr
                  where (tr.ticket_id = p_id or tr.child_ticket_id = p_id)
                    and ryuma_transfer_counts(tr.status, tr.paid_at, tr.hold_until, tr.expires_at))
      or exists (select 1 from preorder_tickets c where c.split_from = p_id);
$$;

create or replace function ryuma_order_items_market_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_t preorder_tickets%rowtype;
begin
  if current_setting('ryuma.market_rpc', true) = 'on' then return new; end if;
  if coalesce(new.qty, 0) < coalesce(old.qty, 0) then
    select * into v_t from preorder_tickets where id = 't-' || old.id;
    if found and ryuma_ticket_market_history(v_t.id, v_t.split_from) then
      raise exception 'ryuma: ตั๋ว % มีประวัติซื้อขาย/เปลี่ยนใบ ยกเลิกรายการนี้ไม่ได้', v_t.ticket_no;
    end if;
    -- ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) — ดีลบันทึกรายการต้นทางไว้ที่ ticket_transfers.order_item_id
    if exists (select 1 from ticket_transfers tr where tr.order_item_id = old.id
                and ryuma_transfer_counts(tr.status, tr.paid_at, tr.hold_until, tr.expires_at)) then
      raise exception 'ryuma: รายการนี้เป็นต้นทางของตั๋วที่มีประวัติซื้อขาย/เปลี่ยนใบ ยกเลิกไม่ได้';
    end if;
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1+2) ด่านลงขาย (ทับ v79) — + จำนวนชิ้นว่าง/ศูนย์ + รอบพิเศษที่ยังเปิดขาย
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_block_reason(p_ticket_id text, p_uid text, p_qty int)
returns text language plpgsql security definer set search_path = public as $$
declare
  t preorder_tickets%rowtype; p products%rowtype; v_gap numeric; v_until timestamptz; v_payer text;
begin
  select * into t from preorder_tickets where id = p_ticket_id;
  if not found then return 'not_found'; end if;
  if t.owner_id is distinct from p_uid then return 'not_owner'; end if;
  -- ล็อกแถวคนขาย: ข้อเสนอ/ประกาศของคนเดียวกันที่ยิงพร้อมกัน ต้องเข้าคิว ไม่งั้นทะลุเพดาน 5 ใบ (audit รอบ E R1-61)
  perform 1 from users where id = p_uid for update;
  if t.status in ('shipped', 'pending_approval', 'transferred') then return 'bad_status'; end if;
  if t.delivery is not null then return 'delivery_chosen'; end if;
  select * into p from products where id = t.product_id;
  if coalesce(p.is_stock, false) and t.batch_id is null and coalesce(t.remaining_amount, 0) = 0 and t.split_from is null
    then return 'instock'; end if;
  if t.batch_id is not null and (select b.label from product_batches b where b.id = t.batch_id) = 'หาของ' then return 'sourcing'; end if;
  if t.product_status = 'open' then return 'still_open'; end if;
  -- รอบพิเศษที่ร้านยังเปิดขายอยู่ (เปิด + ไม่ซ่อน + ยังมีของ) = ยังเปิดจอง (ข้อ 1A · audit 1005 รอบ 4)
  if t.batch_id is not null and exists (select 1 from product_batches b where b.id = t.batch_id
       and b.status = 'open' and b.published is not false and coalesce(b.stock_qty, 0) > 0) then return 'still_open'; end if;
  if t.product_status not in ('production', 'shipping', 'arrived') then return 'bad_product_status'; end if;
  if t.qty is null or t.qty < 1 or p_qty is null or p_qty < 1 or p_qty > t.qty then return 'bad_qty'; end if;
  v_payer := coalesce(t.original_buyer_id, t.owner_id);
  if exists (select 1 from sourcing_requests s where s.product_id = t.product_id and s.user_id = v_payer)
     and (t.batch_id is null or (select b.label from product_batches b where b.id = t.batch_id) = 'หาของ')
    then return 'sourcing'; end if;
  if exists (select 1 from remaining_payments r where r.ticket_id = t.id and r.status = 'pending') then return 'pending_slip'; end if;
  if ryuma_market_active(t.id) then return 'already_listed'; end if;
  if (select count(*) from ticket_transfers tr
       where tr.from_user_id = p_uid and tr.ticket_id <> t.id
         and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at)) >= 5
    then return 'max_active'; end if;
  -- ข้อ 5: ได้ใบมาจากตลาด/เปลี่ยนใบ ต้องถือครบ 2 วัน (cool down · เจ้าของ 2026-10-05)
  select max(tr.approved_at) + interval '2 days' into v_until from ticket_transfers tr
   where tr.status in ('done', 'approved') and tr.to_user_id = p_uid and coalesce(tr.child_ticket_id, tr.ticket_id) = t.id;
  if v_until is not null and v_until > now() then return 'resell_hold'; end if;
  -- ข้อ 9: เติมมัดจำให้ครบทั้งใบก่อน
  v_gap := ceil(ryuma_market_std_deposit(t.id) * t.qty - (coalesce(t.deposit_paid, 0) + coalesce(t.remaining_paid, 0)));
  if v_gap > 0 then return 'topup_needed'; end if;
  return null;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) สลิป/หลักฐาน ต้องเป็นรูปในที่เก็บรูปของร้าน (Supabase Storage ของโปรเจกต์)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_is_shop_image(p_url text)
returns boolean language sql immutable as $$
  select coalesce(p_url ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/[^?#]+$', false);
$$;

-- แนบสลิป (ทับ v75) — ตรรกะเดิมทุกบรรทัด + เช็คที่มาของรูป
create or replace function ryuma_market_pay(p_id text, p_slip text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype;
        v_direct boolean; v_free boolean; v_live boolean; v_slip text := nullif(trim(coalesce(p_slip, '')), '');
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  if v_slip is not null and not ryuma_is_shop_image(v_slip) then return json_build_object('error', 'bad_slip'); end if;
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

-- คนขายแจ้ง "ยังไม่ได้รับเงิน" (ทับ v75) — หลักฐานเก็บเฉพาะรูปของร้าน
create or replace function ryuma_market_seller_reject(p_id text, p_note text, p_evidence jsonb default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_ev jsonb;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'direct' and coalesce(tr.asking_price, 0) = 0 then return json_build_object('error', 'free_deal'); end if;
  if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  if jsonb_typeof(p_evidence) = 'array' then
    select jsonb_agg(e) into v_ev from jsonb_array_elements_text(p_evidence) e where ryuma_is_shop_image(e);
  end if;
  update ticket_transfers
     set status = 'reviewing', review_reason = 'not_received', review_note = left(coalesce(p_note, ''), 500),
         review_evidence = v_ev, reviewing_at = now(), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) แอดมินยกเลิก (ทับ v71) — ผู้ซื้อโอนเงินไปแล้ว → เข้าคิว "เคลียร์คืนเงิน" ไม่หายเงียบ
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_admin_cancel(p_id text, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_money boolean;
begin
  if v_uid is null or not is_app_admin() then return json_build_object('error', 'admin_only'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.status in ('done', 'approved', 'cancelled', 'expired') then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  v_money := tr.paid_at is not null and coalesce(tr.asking_price, 0) > 0;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'admin: ' || left(coalesce(p_reason, ''), 300),
         hold_until = null,
         review_reason = case when v_money then 'late_slip' else review_reason end,
         reviewing_at  = case when v_money then now() else reviewing_at end,
         updated_at = now()
   where id = p_id;
  return json_build_object('ok', true, 'refund', v_money);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) จอง (ทับ v73) — ตรรกะเดิม + ล็อกแถวผู้ซื้อก่อนเช็ค "จองทีละใบ"
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- จองทีละใบ: ล็อกแถวผู้ซื้อก่อน — กดจอง 2 ประกาศพร้อมกัน อีกอันต้องรอแล้วเห็นใบแรก (audit 1005 รอบ 4)
  perform 1 from users where id = v_uid for update;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 1+7) โอนสิทธิ์ (ทับ v77) — ตรรกะเดิมทุกบรรทัด + จำนวนชิ้นต้องมีจริง + ล็อกเลขฐานตั๋วก่อนนับ -T<n>
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_finalize(p_id text, p_order_item_id text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; s record;
  v_qty int; v_base text; v_n int; v_no text; v_child text; v_payer text; v_name text;
  b point_ledger%rowtype; v_claw numeric; v_clawed numeric;
begin
  if v_uid is null or not is_app_admin() then return json_build_object('error', 'admin_only'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.status in ('done', 'approved') then
    return json_build_object('ok', true, 'again', true, 'new_ticket_no', tr.new_ticket_no, 'child_ticket_id', tr.child_ticket_id); end if;
  if tr.status not in ('paid', 'reviewing', 'seller_ok', 'pending_admin') or tr.to_user_id is null then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  select * into t from preorder_tickets where id = tr.ticket_id for update;
  if not found then return json_build_object('error', 'ticket_missing'); end if;
  if t.owner_id is distinct from tr.from_user_id then return json_build_object('error', 'owner_changed'); end if;
  if t.status = 'shipped' or t.delivery is not null then return json_build_object('error', 'ticket_moving'); end if;
  if t.qty is null or t.qty < 1 then return json_build_object('error', 'bad_qty'); end if;
  v_qty := coalesce(tr.qty, t.qty);
  if v_qty < 1 or v_qty > t.qty then return json_build_object('error', 'bad_qty'); end if;
  select * into s from ryuma_split_share(v_qty, t.qty, t.deposit_paid, t.remaining_amount, t.remaining_paid);
  -- ยอดเงินของชิ้นที่ขายต้องเท่ากับตอนตกลงกัน (snapshot) — ไม่งั้นผู้ซื้อรับหนี้คนละก้อนกับที่เห็น (audit R2B-01)
  if tr.snap is not null and (tr.snap ? 'paid') and (tr.snap ? 'due') then
    if (s.c_dep + s.c_paid) <> (tr.snap ->> 'paid')::numeric or (s.c_rem - s.c_paid) <> (tr.snap ->> 'due')::numeric then
      return json_build_object('error', 'ticket_changed',
        'snap_paid', tr.snap ->> 'paid', 'snap_due', tr.snap ->> 'due', 'paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid);
    end if;
  end if;
  v_payer := coalesce(t.original_buyer_id, t.owner_id);
  v_base := regexp_replace(t.ticket_no, '-T[0-9]+$', '');
  -- ล็อกเลขฐาน: ใบแม่กับใบลูกที่โอนพร้อมกันต้องเข้าคิว ไม่งั้นนับ -T<n> ได้เลขเดียวกัน (audit 1005 รอบ 4)
  perform pg_advisory_xact_lock(hashtext('ryuma_ticket_no:' || v_base));
  select coalesce(max((substring(x.ticket_no from '-T([0-9]+)$'))::int), 0) into v_n
    from preorder_tickets x where x.ticket_no like v_base || '-T%';
  v_no := v_base || '-T' || (v_n + 1);
  perform set_config('ryuma.market_rpc', 'on', true);
  if v_qty = t.qty then
    update preorder_tickets
       set original_buyer_id = v_payer, owner_id = tr.to_user_id, ticket_no = v_no, market_rev = t.market_rev + 1
     where id = t.id;
  else
    v_child := 'tc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
    insert into preorder_tickets (id, ticket_no, product_id, variant_id, batch_id, owner_id, original_buyer_id, qty,
        deposit_paid, remaining_amount, remaining_paid, status, product_status, qr_code_url,
        warehouse_at, warehouse_transport, split_from, created_at, approved_at, market_rev)
    values (v_child, v_no, t.product_id, t.variant_id, t.batch_id, tr.to_user_id, v_payer, v_qty,
        s.c_dep, s.c_rem, s.c_paid, case when s.c_paid >= s.c_rem then 'paid_full' else 'active' end,
        t.product_status, t.qr_code_url, t.warehouse_at, t.warehouse_transport, t.id, now(), t.approved_at, t.market_rev + 1);
    update preorder_tickets
       set original_buyer_id = v_payer, qty = t.qty - v_qty,
           deposit_paid = s.r_dep, remaining_amount = s.r_rem, remaining_paid = s.r_paid,
           status = case when s.r_paid >= s.r_rem then 'paid_full' else 'active' end,
           market_rev = t.market_rev + 1
     where id = t.id;
  end if;
  perform set_config('ryuma.market_rpc', 'off', true);
  -- โบนัสยศรายเดือนที่ผูกกับใบนี้ แล้วถูกใช้/ให้ไปแล้ว → ดึงคืนจากคนขายตามสัดส่วนชิ้นที่ขาย (v77)
  for b in select * from point_ledger where kind = 'monthly_reward' and ref_type = 'ticket' and ref_id = t.id and delta > 0 loop
    select coalesce(-sum(delta), 0) into v_clawed from point_ledger
     where kind = 'reverse_ticket' and user_id = b.user_id and ref_id like t.id || '|mbonus-claw|%';
    v_claw := round((b.delta - v_clawed) * v_qty::numeric / greatest(t.qty, 1));
    if v_claw > 0 then
      insert into point_ledger (id, user_id, delta, kind, ref_type, ref_id, note, created_by, created_at)
      values ('pl-mclaw-' || p_id || '-' || b.id, b.user_id, -v_claw, 'reverse_ticket', 'ticket', t.id || '|mbonus-claw|' || p_id,
              'ดึงคืนโบนัสยศ — ' || t.ticket_no || ' เปลี่ยนมือ' || case when v_qty < t.qty then ' (' || v_qty || '/' || t.qty || ' ชิ้น)' else '' end,
              v_uid, now())
      on conflict do nothing;
    end if;
  end loop;
  update ticket_transfers
     set status = 'done', approved_at = now(), finalized_by = v_uid, prev_ticket_no = t.ticket_no,
         new_ticket_no = v_no, child_ticket_id = v_child,
         order_item_id = coalesce(order_item_id, p_order_item_id), updated_at = now()
   where id = p_id;
  select display_name into v_name from users where id = v_uid;
  insert into activity_logs (id, actor_id, actor_name, action, summary, target_id, target_label, amount, created_at)
  values ('al-mk-' || p_id, v_uid, v_name, 'market_finalize',
          'ตลาดใบพรี: โอนสิทธิ์ ' || t.ticket_no || ' → ' || v_no
            || case when v_child is not null then ' (แตกขาย ' || v_qty || ' ชิ้น)' else '' end,
          coalesce(v_child, t.id), v_no, tr.asking_price, now())
  on conflict (id) do nothing;
  return json_build_object('ok', true, 'new_ticket_no', v_no, 'child_ticket_id', v_child);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) ส่งข้อเสนอเปลี่ยนใบ (ทับ v76) — ทุกครั้งที่ใส่เลขกระเป๋า "นับ" · เกินเพดานวันละ 20 = ปฏิเสธก่อนดูว่าเลขถูกไหม
--    (เดิมนับเฉพาะเลขผิด และเลขถูกผ่านเสมอ → เกินเพดานแล้วยังไล่เดาได้ เพราะคำตอบของเลขถูกต่างจากเลขผิด)
--    กดซ้ำข้อเสนอเดิม (again) ไม่นับ
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_offer(p_ticket_id text, p_qty integer, p_price numeric, p_code text, p_payout jsonb, p_expect_user text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); v_day date := ryuma_th_today(); v_code text; v_to text; v_n int; tgt users%rowtype;
  t preorder_tickets%rowtype; ex ticket_transfers%rowtype; v_reason text; v_id text; s record;
  v_until timestamptz := now() + interval '24 hours'; v_pay jsonb;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_direct_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  if p_price > 0 then
    if p_payout is null or coalesce(trim(p_payout->>'account_name'), '') = ''
       or (coalesce(p_payout->>'promptpay', '') = '' and coalesce(p_payout->>'account_no', '') = '') then
      return json_build_object('error', 'no_payout'); end if;
    v_pay := jsonb_build_object('promptpay', nullif(regexp_replace(coalesce(p_payout->>'promptpay', ''), '[^0-9]', '', 'g'), ''),
                                'bank', nullif(left(trim(coalesce(p_payout->>'bank', '')), 60), ''),
                                'account_no', nullif(regexp_replace(coalesce(p_payout->>'account_no', ''), '[^0-9]', '', 'g'), ''),
                                'account_name', left(trim(p_payout->>'account_name'), 120));
  end if;
  select * into t from preorder_tickets where id = p_ticket_id for update;
  if not found or t.owner_id is distinct from v_uid then return json_build_object('error', 'not_owner'); end if;
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
  v_code := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  if length(v_code) <> 4 then return json_build_object('error', 'bad_code'); end if;
  -- นับทุกครั้ง แล้วค่อยตัดสิน (ตัวนับเดียวกับค้นเลขกระเป๋า ryuma_wallet_lookup)
  insert into wallet_lookups (user_id, day, n) values (v_uid, v_day, 1)
    on conflict (user_id, day) do update set n = wallet_lookups.n + 1
    returning n into v_n;
  if v_n > 20 and not is_app_admin() then return json_build_object('error', 'too_many'); end if;
  select w.user_id into v_to from wallet_codes w where w.day = v_day and w.code = v_code;
  if v_to is null or p_expect_user is null or v_to is distinct from p_expect_user then
    return json_build_object('error', 'code_changed');
  end if;
  select * into tgt from users where id = v_to;
  if tgt.id = v_uid then return json_build_object('error', 'self'); end if;
  if tgt.approved is false or coalesce(tgt.suspended, false) then return json_build_object('error', 'not_ready'); end if;
  if coalesce(nullif(trim(tgt.shipping_address), ''), '') = '' then return json_build_object('error', 'no_address'); end if;
  select * into s from ryuma_split_share(p_qty, greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid);
  v_id := 'tr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  insert into ticket_transfers (id, ticket_id, from_user_id, to_user_id, asking_price, status, listed_at, hold_until, expires_at, qty,
                                product_id, variant_id, batch_id, order_item_id, kind, snap, updated_at)
  values (v_id, t.id, v_uid, v_to, p_price, 'reserved', now(), v_until, v_until, p_qty,
          t.product_id, t.variant_id, t.batch_id,
          case when t.id like 't-%' and exists (select 1 from order_items oi where oi.id = substr(t.id, 3)) then substr(t.id, 3) end,
          'direct',
          jsonb_build_object('paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid, 'total', s.c_dep + s.c_rem,
                             'product_status', t.product_status,
                             'ticket_hint', coalesce(substring(t.ticket_no from '^([A-Za-z]+-[0-9]{4}-[0-9]{2})'), 'RYU') || '-••••'),
          now());
  if v_pay is not null then
    insert into ticket_transfer_payouts (transfer_id, payout) values (v_id, v_pay)
      on conflict (transfer_id) do update set payout = excluded.payout;
  end if;
  return json_build_object('ok', true, 'id', v_id, 'hold_until', v_until, 'server_now', now(),
    'to_mask', 'R•••' || right(coalesce(nullif(regexp_replace(coalesce(tgt.member_code, ''), '[^0-9]', '', 'g'), ''), tgt.id, '00'), 2));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- สิทธิ์เรียก (ทับฟังก์ชันด้วยลายเซ็นเดิม = สิทธิ์เดิมยังอยู่ · ตัวช่วยใหม่ปิดไม่ให้เรียกตรง)
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function ryuma_transfer_counts(text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function ryuma_is_shop_image(text) from public, anon, authenticated;
revoke all on function ryuma_market_block_reason(text, text, int) from public, anon, authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select count(*) from preorder_tickets where qty is null;                     -- ต้องได้ 0
-- select ryuma_is_shop_image('https://evil.example.com/x.jpg');                -- ต้องได้ false
