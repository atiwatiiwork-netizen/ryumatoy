-- ============================================================================
-- Ryuma — v78: แก้บั๊กรอบ E (audit เปลี่ยนใบพรี 2026-10-03) — รอบสุดท้าย · พฤติกรรมฝั่งเซิร์ฟเวอร์ที่เหลือ
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v74–v77 ก่อน (รันแล้ว)
--
--  R1-32  กระดาน "ขายสำเร็จ N ครั้ง" นับการเปลี่ยนใบ/ยกให้ด้วย → นับเฉพาะขายบนกระดาน
--  R2B-17 ของพร้อมส่งถูกบล็อกด้วยเหตุผล "ยังเปิดจองอยู่" → ตัดสินของพร้อมส่ง/หาของก่อน
--  R2B-19 ตั๋วในรอบ "หาของ" ที่เรื่องหาของถูกลบไปแล้ว ผ่านด่านตลาดได้ → ดูชื่อรอบด้วย
--  R1-61  ข้อเสนอ/ประกาศที่ยิงพร้อมกันทะลุเพดาน 5 ใบ · สลิปส่วนต่างกับข้อเสนอที่ยิงพร้อมกันติดทั้งคู่ → ล็อกแถวให้เข้าคิว
--  R1-58  ยกให้ฟรีที่ผู้รับกดรับแล้ว คนส่งยกเลิกไม่ได้ → ยกเลิกได้จนกว่าจะกดยืนยัน
--  R1-36  ข้อเสนอเปลี่ยนใบที่หมดเวลา ถูกล้างชื่อผู้รับตอนลงประกาศใหม่ → ประวัติผู้รับหาย → เก็บชื่อผู้รับไว้เสมอ
--  R1-33  ข้อความ push ไม่แยกกระดาน/เปลี่ยนใบ/ยกให้
--  review  ลบสมาชิก: ห้ามลบตัวเอง / ห้ามลบบัญชีแอดมิน
-- ============================================================================


-- 1) กระดาน: "ขายสำเร็จ N ครั้ง" นับเฉพาะการขายบนกระดาน ไม่นับเปลี่ยนใบ/ยกให้ (R1-32) — ทับ v73
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
             (select count(*) from ticket_transfers d where d.from_user_id = tr.from_user_id and d.status in ('done', 'approved') and coalesce(d.kind, 'market') = 'market') as seller_sold,
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


-- 2) เหตุผลที่ขาย/เปลี่ยนใบไม่ได้ (ทับ v71) — ลำดับใหม่ + ล็อกแถวคนขาย
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
  -- ข้อ 5: ซื้อจากตลาดมา ต้องถือครบ 3 วัน
  select max(tr.approved_at) + interval '3 days' into v_until from ticket_transfers tr
   where tr.status in ('done', 'approved') and tr.to_user_id = p_uid and coalesce(tr.child_ticket_id, tr.ticket_id) = t.id;
  if v_until is not null and v_until > now() then return 'resell_hold'; end if;
  -- ข้อ 9: เติมมัดจำให้ครบทั้งใบก่อน
  v_gap := ceil(ryuma_market_std_deposit(t.id) * t.qty - (coalesce(t.deposit_paid, 0) + coalesce(t.remaining_paid, 0)));
  if v_gap > 0 then return 'topup_needed'; end if;
  return null;
end $$;

revoke all on function ryuma_market_block_reason(text, text, int) from public, anon, authenticated;

-- 3) ถอน (ทับ v75) — + ยกเลิกการยกให้ที่ผู้รับกดรับแล้ว
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
  -- ยกให้ฟรีที่ผู้รับกดรับแล้ว (paid) ยังไม่มีเงินเปลี่ยนมือ → คนส่งเปลี่ยนใจได้จนกว่าจะกดยืนยัน (audit รอบ E R1-58)
  if tr.status not in ('listed', 'reserved') and not (v_direct and coalesce(tr.asking_price, 0) = 0 and tr.status = 'paid') then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'seller',
         to_user_id = case when v_direct then to_user_id else null end,
         hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;


-- 4) ล็อกจ่ายส่วนต่างระหว่างดีล (ทับ v74) — + ล็อกแถวตั๋ว
create or replace function ryuma_market_rp_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert แถวเดิม
  -- ล็อกแถวตั๋วก่อนเช็ค: สลิปส่วนต่างกับข้อเสนอที่ยิงพร้อมกันต้องเข้าคิว ไม่งั้นติดทั้งคู่ (audit รอบ E R1-61)
  perform 1 from preorder_tickets where id = new.ticket_id for update;
  if ryuma_market_active(new.ticket_id) then
    raise exception 'ryuma: ใบนี้อยู่ระหว่างซื้อขาย/เปลี่ยนใบ — จบดีลหรือถอนก่อนจ่ายส่วนต่าง';
  end if;
  return new;
end $$;


-- 5) push (ทับ v75) — ข้อความแยกกระดาน / เปลี่ยนใบ / ยกให้
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
    v_body  := v_name || case when coalesce(tr.asking_price, 0) = 0 then ' — คนส่งยกเลิกการยกให้แล้ว' else ' — คนส่งถอนข้อเสนอแล้ว ถ้าโอนเงินไปแล้วให้แนบสลิปในหน้าดีลเพื่อแจ้งร้าน' end;
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


-- 6) ดีลเปลี่ยนใบ (direct) ห้ามถูกล้างชื่อผู้รับ — ประวัติของผู้รับผูกกับช่องนี้ (R1-36)
--    (ตัวล้างแถวหมดอายุตอนลงประกาศกระดานใหม่ ตั้ง to_user_id = null กับทุกแถว)
create or replace function ryuma_transfers_keep_recipient()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.kind, 'market') = 'direct' and old.to_user_id is not null and new.to_user_id is null then
    new.to_user_id := old.to_user_id;
  end if;
  return new;
end $$;
drop trigger if exists ryuma_transfers_keep_recipient on ticket_transfers;
create trigger ryuma_transfers_keep_recipient before update on ticket_transfers
  for each row execute function ryuma_transfers_keep_recipient();

-- 7) ลบสมาชิก (ทับ v76) — + ห้ามลบตัวเอง / ห้ามลบบัญชีแอดมิน (ถอดสิทธิ์แอดมินก่อนถ้าจำเป็นจริง)
create or replace function ryuma_admin_purge_user(p_user_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_auth uuid; v_live int; v_hist int; v_recv int; v_sold int;
begin
  if not is_app_admin() then return json_build_object('error','not_admin'); end if;
  -- ห้ามลบตัวเอง และห้ามลบบัญชีแอดมิน (review รอบ E: รายการรออนุมัติเคยโชว์ปุ่มปฏิเสธบนบัญชีแอดมิน = ลบถาวร)
  if p_user_id = app_user_id() then return json_build_object('error', 'self'); end if;
  if exists (select 1 from users where id = p_user_id and is_admin) then return json_build_object('error', 'admin_target'); end if;
  select count(*) into v_live from ticket_transfers tr
   where (tr.from_user_id = p_user_id or tr.to_user_id = p_user_id)
     and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at);
  if v_live > 0 then return json_build_object('error', 'live_deal', 'live', v_live); end if;
  select count(*) into v_hist from ticket_transfers tr
   where (tr.from_user_id = p_user_id or tr.to_user_id = p_user_id)
     and (tr.status in ('done', 'approved') or tr.paid_at is not null);
  select count(*) into v_recv from preorder_tickets t
   where t.owner_id = p_user_id and (coalesce(t.original_buyer_id, t.owner_id) <> p_user_id or t.split_from is not null);
  select count(*) into v_sold from preorder_tickets t
   where t.original_buyer_id = p_user_id and t.owner_id <> p_user_id;
  if v_hist + v_recv + v_sold > 0 then
    return json_build_object('error', 'market_history', 'deals', v_hist, 'received', v_recv, 'sold', v_sold);
  end if;

  select auth_id into v_auth from users where id = p_user_id;
  perform set_config('ryuma.trusted', 'on', true);
  delete from ticket_transfers where from_user_id = p_user_id or to_user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);
  delete from remaining_payments where user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);
  delete from preorder_tickets where owner_id = p_user_id;
  delete from order_items where order_id in (select id from orders where user_id = p_user_id);
  delete from orders where user_id = p_user_id;
  delete from rank_requests where user_id = p_user_id;
  delete from stock_reservations where user_id = p_user_id;
  delete from user_secrets where user_id = p_user_id;
  delete from users where id = p_user_id;
  if v_auth is not null then delete from auth.users where id = v_auth; end if;
  perform set_config('ryuma.trusted', 'off', true);
  return json_build_object('ok', true);
end $$;

revoke all on function ryuma_admin_purge_user(text) from public, anon;
grant execute on function ryuma_admin_purge_user(text) to authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select tgname from pg_trigger where tgname = 'ryuma_transfers_keep_recipient';   -- 1 แถว
