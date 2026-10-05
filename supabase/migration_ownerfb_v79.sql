-- ============================================================================
-- Ryuma — v79: คำตอบเจ้าของหลังดูพรีวิว (2026-10-05) — เปลี่ยนใบพรี
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v74–v78 ก่อน (รันแล้ว)
--
--  ข้อ 3  คนส่งยกเลิก/ถอนข้อเสนอได้ทุกเมื่อ "พร้อมเหตุผล" (บังคับ · กันเกรียน) — เดิมผู้รับเปิดหน้าโอนแล้วคนส่งถอนเองไม่ได้
--         เหตุผลเก็บใน ticket_transfers.cancel_note · ผู้รับเห็นในหน้าดีล + push · ร้านเห็นในหน้าแอดมิน
--  ข้อ 5  Cool down หลังได้ใบมา ก่อนส่งต่อ: 3 วัน → 2 วัน
--  (ข้อ 1 เติมมัดจำก่อนเริ่ม · ข้อ 2 เวลา 24 ชม./12 ชม./15 นาที · ข้อ 4 โบนัสยศที่ผูกกับใบถูกยกเลิก — เป็นแบบนี้อยู่แล้ว)
-- ============================================================================

alter table ticket_transfers add column if not exists cancel_note text;

-- 1) ถอน/ยกเลิก (ทับ v78) — พารามิเตอร์ใหม่ p_reason · ดีลตรงต้องมีเหตุผล · ถอนได้แม้ผู้รับเปิดหน้าโอนแล้ว
drop function if exists ryuma_market_cancel(text);

create or replace function ryuma_market_cancel(p_id text, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_direct boolean;
        v_reason text := nullif(left(trim(coalesce(p_reason, '')), 300), '');
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  v_direct := coalesce(tr.kind, 'market') = 'direct';
  if not v_direct and tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until); end if;
  -- (เจ้าของ 2026-10-05) คนส่งถอนได้ทุกเมื่อ แม้ผู้รับเปิดหน้าโอนแล้ว — แต่ต้องใส่เหตุผลเสมอ กันเกรียน
  --   ผู้รับ + ร้านเห็นเหตุผล · ถ้าผู้รับโอนไปแล้ว แนบสลิปได้ ระบบเก็บเป็นหลักฐานให้ร้านเคลียร์คืนเงิน (late_slip v75)
  -- ยกให้ฟรีที่ผู้รับกดรับแล้ว (paid) ยังไม่มีเงินเปลี่ยนมือ → คนส่งเปลี่ยนใจได้จนกว่าจะกดยืนยัน (audit รอบ E R1-58)
  if tr.status not in ('listed', 'reserved') and not (v_direct and coalesce(tr.asking_price, 0) = 0 and tr.status = 'paid') then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  if v_direct and (v_reason is null or char_length(v_reason) < 2) then return json_build_object('error', 'reason_required'); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'seller', cancel_note = v_reason,
         to_user_id = case when v_direct then to_user_id else null end,
         hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;
revoke all on function ryuma_market_cancel(text, text) from public, anon;
grant execute on function ryuma_market_cancel(text, text) to authenticated;

-- 2) เหตุผลที่ขาย/เปลี่ยนใบไม่ได้ (ทับ v78) — cool down 2 วัน
create or replace function ryuma_market_block_reason(p_ticket_id text, p_uid text, p_qty int)
returns text language plpgsql volatile security definer set search_path = public as $$
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
  -- ของพร้อมส่ง/งานหาของ ตัดสินก่อน "ยังเปิดจอง" (R2B-17: เดิมของพร้อมส่งได้เหตุผล still_open) ·
  -- ตั๋วในรอบ 'หาของ' นับเป็นงานหาของแม้เรื่องหาของถูกลบไปแล้ว (R2B-19)
  select * into p from products where id = t.product_id;
  if coalesce(p.is_stock, false) and t.batch_id is null and coalesce(t.remaining_amount, 0) = 0 and t.split_from is null
    then return 'instock'; end if;
  if t.batch_id is not null and (select b.label from product_batches b where b.id = t.batch_id) = 'หาของ' then return 'sourcing'; end if;
  if t.product_status = 'open' then return 'still_open'; end if;
  if t.product_status not in ('production', 'shipping', 'arrived') then return 'bad_product_status'; end if;
  if p_qty is null or p_qty < 1 or p_qty > t.qty then return 'bad_qty'; end if;
  select * into p from products where id = t.product_id;
  -- ข้อ 2: ของพร้อมส่ง/งานหาของ ไม่ใช่ใบพรี (ตั๋วลูกใช้สินค้า/รอบเดียวกับแม่ จึงได้ผลเดียวกัน)
  if coalesce(p.is_stock, false) and t.batch_id is null and coalesce(t.remaining_amount, 0) = 0 and t.split_from is null
    then return 'instock'; end if;
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
revoke all on function ryuma_market_block_reason(text, text, int) from public, anon, authenticated;

-- 3) push (ทับ v78) — แจ้งผู้รับพร้อมเหตุผลที่คนส่งถอน
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
    -- ข้อความ "ยกให้" ใช้เฉพาะดีลตรงยอด 0 (R1-33: เดิมกระดานยอด 0 ได้ข้อความยกให้)
    v_title := case when coalesce(tr.asking_price, 0) > 0 or not v_direct then '💸 มีคนโอนเงินให้คุณแล้ว' else '🤝 ผู้รับกดรับใบพรีแล้ว' end;
    v_body  := v_name || case when coalesce(tr.asking_price, 0) > 0 or not v_direct then ' · ฿' || v_price || ' — เช็คบัญชีแล้วกดยืนยันรับเงิน' else ' — กดยืนยันเพื่อส่งให้ร้านโอนสิทธิ์' end;
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

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select pronargs from pg_proc where proname = 'ryuma_market_cancel';   -- 2 (ตัวเดียว)
