-- ============================================================================
-- Ryuma — v72: ตลาดใบพรี เฟส 1 · สวิตช์ปิดฝั่งลูกค้า (ฝั่ง server) + snapshot ดีล + push
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v71 ก่อน (รันแล้ว)
--
-- เจ้าของสั่ง (2026-09-23): "อย่าเพิ่งให้ลูกค้าเห็น รอทุกอย่างพร้อมก่อน"
--   → ด่านอยู่ที่ฐานข้อมูล ไม่ใช่แค่ซ่อนปุ่ม: ถ้า app_config 'market_public' ยังไม่เปิด
--     ลูกค้าเรียก RPC ตรงๆ ก็ลงขาย/จองไม่ได้ และกระดานคืนว่าง · แอดมินใช้ได้ครบเพื่อทดลอง
--   → push "ลงขายใหม่" ตอนยังปิด ไปถึงเฉพาะเครื่องแอดมิน
--
-- ไฟล์นี้ทำ 4 อย่าง:
--   1) คอลัมน์ ticket_transfers.snap (ยอดเงินของดีล ณ ตอนลงขาย — ผู้ซื้อมองไม่เห็นตั๋วคนอื่นตาม RLS)
--      + ticket_transfers.pushed (กันยิง push ชนิดเดิมซ้ำ)
--   2) ryuma_market_open() — อ่านสวิตช์จาก app_config (ค่าเริ่มต้น = ปิด)
--   3) ทับ ryuma_market_feed / _list / _reserve ด้วยเวอร์ชันที่เช็คสวิตช์ (ลายเซ็นเดิม)
--   4) ryuma_market_push_targets — เซิร์ฟเวอร์เป็นคนเลือกปลายทาง+ข้อความ push (ลูกค้าไม่เห็นเครื่องคนอื่น)
-- ============================================================================

alter table ticket_transfers
  add column if not exists snap   jsonb,
  add column if not exists pushed jsonb not null default '{}'::jsonb;

-- 2) สวิตช์ — ไม่มีแถว = ปิด (ลูกค้าไม่เห็นอะไรจนกว่าแอดมินกดเปิดในหน้า /admin/market)
create or replace function ryuma_market_open()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> 'enabled')::boolean from app_config where key = 'market_public'), false);
$$;

-- 3.1 กระดาน (ทับ v71) — ยังปิด: ลูกค้าได้แถวว่าง + closed=true · แอดมินเห็นตามจริง
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
         and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at)
    ) x), '[]'::json));
end $$;

-- 3.2 ลงประกาศ (ทับ v71) — + สวิตช์ + เก็บ snapshot ยอดเงินของชิ้นที่ขาย (ตั๋วถูกล็อกตลอดดีล ยอดจึงไม่ขยับ)
create or replace function ryuma_market_list(p_ticket_id text, p_qty int, p_price numeric)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); t preorder_tickets%rowtype; v_reason text; v_id text; v_pay jsonb; s record;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_market_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  select payout_info into v_pay from users where id = v_uid;
  if v_pay is null or coalesce(v_pay->>'account_name', '') = ''
     or (coalesce(v_pay->>'promptpay', '') = '' and coalesce(v_pay->>'account_no', '') = '') then
    return json_build_object('error', 'no_payout'); end if;
  select * into t from preorder_tickets where id = p_ticket_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  update ticket_transfers set status = 'expired', to_user_id = null, hold_until = null, updated_at = now()
   where ticket_id = t.id and status in ('listed', 'reserved')
     and not ryuma_market_live(status, hold_until, expires_at);
  v_reason := ryuma_market_block_reason(t.id, v_uid, p_qty);
  if v_reason is not null then return json_build_object('error', v_reason); end if;
  select * into s from ryuma_split_share(p_qty, greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid);
  v_id := 'tr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  insert into ticket_transfers (id, ticket_id, from_user_id, asking_price, status, listed_at, expires_at, qty,
                                product_id, variant_id, batch_id, order_item_id, snap, updated_at)
  values (v_id, t.id, v_uid, p_price, 'listed', now(), now() + interval '14 days', p_qty,
          t.product_id, t.variant_id, t.batch_id,
          case when t.id like 't-%' and exists (select 1 from order_items oi where oi.id = substr(t.id, 3)) then substr(t.id, 3) end,
          jsonb_build_object('paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid, 'total', s.c_dep + s.c_rem,
                             'product_status', t.product_status,
                             'ticket_hint', coalesce(substring(t.ticket_no from '^([A-Za-z]+-[0-9]{4}-[0-9]{2})'), 'RYU') || '-••••'),
          now());
  return json_build_object('ok', true, 'id', v_id, 'expires_at', now() + interval '14 days');
end $$;

-- 3.4 จอง (ทับ v71) — + สวิตช์
create or replace function ryuma_market_reserve(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; v_until timestamptz;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_market_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if coalesce((select nullif(trim(shipping_address), '') from users where id = v_uid), '') = '' then
    return json_build_object('error', 'no_address'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.from_user_id = v_uid then return json_build_object('error', 'own_listing'); end if;
  if tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    if tr.to_user_id = v_uid then
      return json_build_object('ok', true, 'again', true, 'hold_until', tr.hold_until, 'server_now', now()); end if;
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until);
  end if;
  if tr.status not in ('listed', 'reserved') or not (tr.expires_at is null or tr.expires_at > now()) then
    return json_build_object('error', 'gone', 'status', tr.status); end if;
  if exists (select 1 from ticket_transfers x
              where x.to_user_id = v_uid and x.id <> p_id and x.status = 'reserved'
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

-- 4) push — แอปส่งแค่ (id ดีล, ชนิด) · ปลายทาง+ข้อความตัดสินที่นี่ · คนเรียกต้องเป็นคู่ดีลหรือแอดมิน
--    ชนิดเดิมยิงซ้ำไม่ได้ (remind: เว้น 1 ชม.) · ห้ามบอกจำนวน/สต๊อก (DNA push no-qty)
create or replace function ryuma_market_push_targets(p_id text, p_kind text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid text := app_user_id(); v_admin boolean := is_app_admin(); v_open boolean := ryuma_market_open();
  tr ticket_transfers%rowtype; v_last timestamptz; v_name text; v_mk text; v_fr text; v_price text;
  v_to text[] := '{}'; v_admins text[]; v_title text; v_body text; v_url text := '/market/mine';
  v_empty json := json_build_object('targets', '[]'::json);
begin
  if v_uid is null then return v_empty; end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return v_empty; end if;
  if not v_admin and v_uid is distinct from tr.from_user_id and v_uid is distinct from tr.to_user_id then return v_empty; end if;
  begin v_last := (tr.pushed ->> p_kind)::timestamptz; exception when others then v_last := null; end;
  if v_last is not null and (p_kind <> 'remind' or v_last > now() - interval '1 hour') then return v_empty; end if;
  select p.series_name, p.manufacturer_id, p.franchise_id into v_name, v_mk, v_fr from products p where p.id = tr.product_id;
  v_name := coalesce(v_name, 'ใบพรี');
  v_price := to_char(tr.asking_price, 'FM999,999,990');
  select coalesce(array_agg(u.id), '{}') into v_admins from users u where u.is_admin;

  if p_kind = 'listed' then
    if tr.status <> 'listed' or (v_uid is distinct from tr.from_user_id and not v_admin) then return v_empty; end if;
    if exists (select 1 from push_config c where c.key = 'market_new' and c.enabled = false) then return v_empty; end if;
    v_title := '🆕 ตลาดใบพรี · ลงขายใหม่';
    v_body  := v_name || ' · ฿' || v_price;
    v_url   := '/market/' || tr.id;
    -- ข้อ 30: ทุกคน ยกเว้นคนขายเอง + คนที่ปิดค่าย/เรื่องนั้นไว้ · ตลาดยังปิด = เฉพาะแอดมิน
    select coalesce(array_agg(u.id), '{}') into v_to from users u
     where u.id <> tr.from_user_id and u.approved is not false and coalesce(u.suspended, false) = false
       and (v_open or u.is_admin)
       and not exists (select 1 from push_prefs pp where pp.user_id = u.id
                        and (v_mk = any(pp.maker_ids) or v_fr = any(pp.franchise_ids)));
  elsif p_kind = 'reserved' then
    if tr.status <> 'reserved' or v_uid is distinct from tr.to_user_id then return v_empty; end if;
    v_title := '🛒 มีคนกำลังซื้อใบของคุณ';
    v_body  := v_name || ' — ถ้าเขาโอนมา จะแจ้งให้เช็คบัญชีทันที';
    v_to    := array[tr.from_user_id];
  elsif p_kind = 'paid' then
    if tr.status <> 'paid' or (v_uid is distinct from tr.to_user_id and not v_admin) then return v_empty; end if;
    v_title := '💸 มีคนโอนเงินให้คุณแล้ว';
    v_body  := v_name || ' · ฿' || v_price || ' — เช็คบัญชีแล้วกดยืนยันรับเงิน';
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
    v_title := '🤝 ขายสำเร็จแล้ว';
    v_body  := v_name || ' — ร้านโอนสิทธิ์ให้ผู้ซื้อเรียบร้อย';
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

revoke all on function ryuma_market_open()                    from public, anon;
revoke all on function ryuma_market_push_targets(text, text)  from public, anon;
grant execute on function ryuma_market_open()                   to authenticated;
grant execute on function ryuma_market_push_targets(text, text) to authenticated;
-- ทับฟังก์ชันด้วยลายเซ็นเดิม สิทธิ์เรียกของ v71 ยังอยู่ครบ (feed/list/reserve = authenticated เท่านั้น)

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select snap, pushed from ticket_transfers limit 1;       -- คอลัมน์ใหม่
-- select ryuma_market_open();                              -- ต้องได้ false จนกว่าจะกดเปิดในหน้าแอดมิน
