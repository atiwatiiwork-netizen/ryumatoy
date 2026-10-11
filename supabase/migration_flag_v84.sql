-- ============================================================================
-- Ryuma — v84: ตลาดใบพรี — คำติชมเจ้าของหลังลองเล่น (2026-10-11)
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v83 ก่อน (รันแล้ว)
-- ลูกค้ายังไม่เห็นตลาด (สวิตช์ยังปิด) — ไฟล์นี้ไม่เปิดอะไรให้ใคร
--
--  1) ต้องเปิดกระดิ่ง (มีเครื่องรับแจ้งเตือน) ก่อนลงขาย / ส่งข้อเสนอเปลี่ยนใบ / จองซื้อ — ทุกขั้นของดีลแจ้งผ่าน push
--     ไม่มีกระดิ่ง = 'no_bell' (แอดมินยกเว้นไว้ทดสอบ)
--  2) คนขายเช็คสลิปแล้ว "ยังไม่ได้รับเงิน" → เลือกเหตุผล 3 แบบ แจ้งกลับผู้ซื้อก่อน (ยังไม่เข้าร้าน):
--       not_arrived = สลิปถูก แต่เงินไม่เข้า · wrong_amount = สลิปถูก ได้เงินไม่ครบ/เกิน · wrong_slip = สลิปผิด
--     ผู้ซื้อตอบ: แนบสลิปใหม่/สลิปเพิ่ม (คนขายได้เวลาเช็คใหม่ 12 ชม.) · หรือมั่นใจว่าสลิปถูก → ส่งเรื่องให้คนขาย + ร้านตรวจ
--     ดีลยังเป็น 'paid' ตลอด (ใบยังล็อก) — แค่มีธง seller_flag · สลิปเก่าเก็บไว้ใน slip_history เป็นหลักฐาน
--  3) push 2 ชนิดใหม่: flagged (ถึงผู้ซื้อ) · reslip (ถึงคนขาย + แอดมิน) — ส่งซ้ำได้ทุกรอบที่เกิดใหม่
-- ============================================================================

alter table ticket_transfers
  add column if not exists seller_flag      text,
  add column if not exists seller_flag_note text,
  add column if not exists seller_flag_at   timestamptz,
  add column if not exists slip_history     jsonb not null default '[]'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) กระดิ่ง = มีเครื่องรับแจ้งเตือนที่ผูกกับบัญชีนี้อย่างน้อย 1 เครื่อง (นิยามเดียวกับภารกิจ "เปิดกระดิ่ง")
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_has_bell(p_uid text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from push_subscriptions s where s.user_id = p_uid);
$$;

-- ด่านลงขาย/ส่งข้อเสนอ (ทับ v83) — เหมือนเดิมทุกบรรทัด + กระดิ่งเป็นด่านสุดท้าย (เหตุผลอื่นโชว์ก่อน)
create or replace function ryuma_market_block_reason(p_ticket_id text, p_uid text, p_qty int)
returns text language plpgsql security definer set search_path = public as $$
declare
  t preorder_tickets%rowtype; p products%rowtype; v_gap numeric; v_until timestamptz; v_payer text;
begin
  select * into t from preorder_tickets where id = p_ticket_id;
  if not found then return 'not_found'; end if;
  if t.owner_id is distinct from p_uid then return 'not_owner'; end if;
  perform 1 from users where id = p_uid for update;
  if t.status in ('shipped', 'pending_approval', 'transferred') then return 'bad_status'; end if;
  if t.delivery is not null then return 'delivery_chosen'; end if;
  select * into p from products where id = t.product_id;
  if coalesce(p.is_stock, false) and t.batch_id is null and coalesce(t.remaining_amount, 0) = 0 and t.split_from is null
    then return 'instock'; end if;
  if t.batch_id is not null and (select b.label from product_batches b where b.id = t.batch_id) = 'หาของ' then return 'sourcing'; end if;
  if t.product_status = 'open' then return 'still_open'; end if;
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
  select max(tr.approved_at) + interval '2 days' into v_until from ticket_transfers tr
   where tr.status in ('done', 'approved') and tr.to_user_id = p_uid and coalesce(tr.child_ticket_id, tr.ticket_id) = t.id;
  if v_until is not null and v_until > now() then return 'resell_hold'; end if;
  v_gap := ceil(ryuma_market_std_deposit(t.id) * t.qty - (coalesce(t.deposit_paid, 0) + coalesce(t.remaining_paid, 0)));
  if v_gap > 0 then return 'topup_needed'; end if;
  -- (เจ้าของ 2026-10-11) ต้องเปิดกระดิ่งก่อนลงขาย — มีคนจอง/โอน/ยืนยัน แจ้งผ่าน push ทั้งหมด
  if not is_app_admin() and not ryuma_has_bell(p_uid) then return 'no_bell'; end if;
  return null;
end $$;

-- จอง (ทับ v83) — เหมือนเดิมทุกบรรทัด + ผู้ซื้อต้องเปิดกระดิ่ง
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
  -- (เจ้าของ 2026-10-11) ผู้ซื้อต้องเปิดกระดิ่งก่อนจอง — คนขายยืนยัน/ร้านโอนสิทธิ์ แจ้งผ่าน push
  if not is_app_admin() and not ryuma_has_bell(v_uid) then return json_build_object('error', 'no_bell'); end if;
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
-- 2) คนขาย "ยังไม่ได้รับเงิน" + เหตุผล → แจ้งผู้ซื้อก่อน (ดีลยัง paid · ใบยังล็อก)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_seller_flag(p_id text, p_reason text, p_note text default null, p_evidence jsonb default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_ev jsonb;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  if p_reason is null or p_reason not in ('not_arrived', 'wrong_amount', 'wrong_slip') then return json_build_object('error', 'bad_reason'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if coalesce(tr.kind, 'market') = 'direct' and coalesce(tr.asking_price, 0) = 0 then return json_build_object('error', 'free_deal'); end if;
  if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  if tr.seller_flag is not null then return json_build_object('ok', true, 'again', true); end if;
  if jsonb_typeof(p_evidence) = 'array' then
    select jsonb_agg(e) into v_ev from jsonb_array_elements_text(p_evidence) e where ryuma_is_shop_image(e);
  end if;
  update ticket_transfers
     set seller_flag = p_reason, seller_flag_note = nullif(left(trim(coalesce(p_note, '')), 500), ''), seller_flag_at = now(),
         review_evidence = coalesce(v_ev, review_evidence), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ผู้ซื้อตอบธงของคนขาย: 'reslip' แนบสลิปใหม่/เพิ่ม (คนขายได้เวลาเช็คใหม่) · 'escalate' มั่นใจว่าถูก → ร้านตรวจ
create or replace function ryuma_market_buyer_reply(p_id text, p_action text, p_slip text default null, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid text := app_user_id(); tr ticket_transfers%rowtype;
  v_slip text := nullif(trim(coalesce(p_slip, '')), ''); v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_seller text; v_buyer text; v_label text;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  if tr.seller_flag is null then return json_build_object('error', 'no_flag'); end if;
  if p_action = 'reslip' then
    if v_slip is null or not ryuma_is_shop_image(v_slip) then return json_build_object('error', 'bad_slip'); end if;
    update ticket_transfers
       set slip_history = coalesce(slip_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'slip', slip_url, 'paid_at', paid_at, 'flag', seller_flag, 'flag_note', seller_flag_note,
             'flag_at', seller_flag_at, 'buyer_note', v_note, 'replaced_at', now())),
           slip_url = v_slip, paid_at = now(), seller_flag = null, seller_flag_note = null, seller_flag_at = null, updated_at = now()
     where id = p_id;
    return json_build_object('ok', true, 'paid_at', now());
  elsif p_action = 'escalate' then
    v_seller := case when coalesce(tr.kind, 'market') = 'direct' then 'คนส่ง' else 'คนขาย' end;
    v_buyer  := case when coalesce(tr.kind, 'market') = 'direct' then 'ผู้รับ' else 'ผู้ซื้อ' end;
    v_label  := case tr.seller_flag when 'not_arrived' then 'สลิปถูกแต่เงินไม่เข้า'
                                    when 'wrong_amount' then 'ได้เงินไม่ครบ/เกิน' else 'สลิปผิด' end;
    update ticket_transfers
       set status = 'reviewing', review_reason = 'not_received', reviewing_at = now(), updated_at = now(),
           review_note = left(v_seller || 'แจ้ง: ' || v_label || coalesce(' — ' || tr.seller_flag_note, '')
                              || ' · ' || v_buyer || 'ยืนยันว่าสลิปถูก' || coalesce(': ' || v_note, ''), 500)
     where id = p_id;
    return json_build_object('ok', true);
  end if;
  return json_build_object('error', 'bad_action');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) push (ทับ v79) — + flagged / reslip (ส่งซ้ำได้ทุกครั้งที่เกิดรอบใหม่) · remind ไม่ส่งถ้าคนขายตอบแล้ว
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
  if v_last is not null and not (
       (p_kind = 'remind'  and v_last <= now() - interval '1 hour')
    or (p_kind = 'flagged' and tr.seller_flag_at is not null and v_last < tr.seller_flag_at)
    or (p_kind = 'reslip'  and tr.paid_at is not null and v_last < tr.paid_at)) then return v_empty; end if;
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
    v_body  := v_name || case when coalesce(tr.asking_price, 0) = 0 then ' — คนส่งยกเลิกการยกให้แล้ว' else ' — คนส่งถอนข้อเสนอแล้ว' end
            || coalesce(' · เหตุผล: ' || tr.cancel_note, '')
            || case when coalesce(tr.asking_price, 0) > 0 then ' · ถ้าโอนเงินไปแล้ว ให้แนบสลิปในหน้าดีลเพื่อแจ้งร้าน' else '' end;
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
    v_title := case when coalesce(tr.asking_price, 0) > 0 or not v_direct then '💸 มีคนโอนเงินให้คุณแล้ว' else '🤝 ผู้รับกดรับใบพรีแล้ว' end;
    v_body  := v_name || case when coalesce(tr.asking_price, 0) > 0 or not v_direct then ' · ฿' || v_price || ' — เช็คบัญชีแล้วกดยืนยันรับเงิน' else ' — กดยืนยันเพื่อส่งให้ร้านโอนสิทธิ์' end;
    v_to    := array[tr.from_user_id] || v_admins;
  elsif p_kind = 'flagged' then
    if tr.status <> 'paid' or tr.seller_flag is null or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    v_title := case when v_direct then '⚠️ คนส่งยังไม่ได้รับเงิน' else '⚠️ คนขายยังไม่ได้รับเงิน' end;
    v_body  := v_name || ' — ' || case tr.seller_flag when 'not_arrived' then 'สลิปถูกแต่เงินไม่เข้า'
                                                      when 'wrong_amount' then 'ได้เงินไม่ครบ/เกิน' else 'สลิปผิด' end
            || coalesce(' · ' || tr.seller_flag_note, '')
            || ' · เปิดดีลเพื่อแนบสลิปใหม่ หรือถ้ามั่นใจว่าสลิปถูก กดส่งเรื่องให้ร้าน';
    v_url   := '/market/' || tr.id;
    v_to    := array[tr.to_user_id];
  elsif p_kind = 'reslip' then
    if tr.status <> 'paid' or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := case when v_direct then '📎 ผู้รับแนบสลิปใหม่แล้ว' else '📎 ผู้ซื้อแนบสลิปใหม่แล้ว' end;
    v_body  := v_name || ' · ฿' || v_price || ' — เช็คบัญชีอีกครั้งแล้วกดยืนยันรับเงิน';
    v_url   := '/market/' || tr.id;
    v_to    := array[tr.from_user_id] || v_admins;
  elsif p_kind = 'seller_ok' then
    if tr.status <> 'seller_ok' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    v_title := case when v_direct and coalesce(tr.asking_price, 0) = 0 then '✅ คนส่งยืนยันยกให้แล้ว' when v_direct then '✅ คนส่งยืนยันรับเงินแล้ว' else '✅ คนขายยืนยันรับเงินแล้ว' end;
    v_body  := v_name || ' — รอร้านโอนสิทธิ์ให้';
    v_to    := array[tr.to_user_id] || v_admins;
  elsif p_kind = 'reviewing' then
    if tr.status <> 'reviewing' then return v_empty; end if;
    v_title := '🔎 ร้านกำลังตรวจสอบดีล';
    v_body  := v_name || ' — แอดมินจะติดต่อเพื่อเคลียร์ให้';
    v_to    := array[tr.from_user_id, tr.to_user_id] || v_admins;
  elsif p_kind = 'remind' then
    if tr.status not in ('paid', 'reviewing') or coalesce(tr.asking_price, 0) = 0 or tr.seller_flag is not null
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
    v_body  := v_name || case when v_direct then ' — ร้านโอนสิทธิ์ให้ผู้รับเรียบร้อย' else ' — ร้านโอนสิทธิ์ให้ผู้ซื้อเรียบร้อย' end;
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
-- สิทธิ์เรียก
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function ryuma_has_bell(text) from public, anon, authenticated;
revoke all on function ryuma_market_block_reason(text, text, int) from public, anon, authenticated;
revoke all on function ryuma_market_seller_flag(text, text, text, jsonb) from public, anon;
revoke all on function ryuma_market_buyer_reply(text, text, text, text) from public, anon;
grant execute on function ryuma_market_seller_flag(text, text, text, jsonb) to authenticated;
grant execute on function ryuma_market_buyer_reply(text, text, text, text) to authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select seller_flag, slip_history from ticket_transfers limit 1;   -- คอลัมน์ใหม่
