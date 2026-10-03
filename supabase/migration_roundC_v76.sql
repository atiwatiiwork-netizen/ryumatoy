-- ============================================================================
-- Ryuma — v76: แก้บั๊กรอบ C (audit เปลี่ยนใบพรี 2026-10-03) — บัญชีรับเงิน + เติมมัดจำ
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v74 v75 ก่อน (รันแล้ว)
--
-- บัญชีรับเงิน
--  R1-10 ผู้รับอ่านบัญชีคนส่งได้ตลอด (ผ่านตาราง ticket_transfers) แม้ถอน/ปฏิเสธ/หมดเวลา/ยกให้ฟรี
--        → ย้ายบัญชีที่ล็อกกับดีลไปตารางลับ ticket_transfer_payouts (ไม่มี policy ให้ลูกค้า) อ่านได้ทาง RPC เท่านั้น
--  R1-07 / R1-08 กระดานอ่านบัญชี "สด" ของคนขาย (เปลี่ยนกลางดีลได้) + ผู้ซื้อที่หมดเวลาจองยังเห็นบัญชีได้ 14 วัน
--        → ลงประกาศ = ล็อกบัญชีตอนนั้น · ผู้ซื้อกระดานเห็นเฉพาะช่วงจอง (15+10 นาที) หรือหลังโอนแล้ว
--  R1-49 คนส่ง/คนขายดูได้ว่าเงินต้องเข้าบัญชีไหน (RPC เดียวกัน) · แอดมินดูได้ทุกดีล
--  R1-58 ยกให้ฟรี (฿0) ไม่ต้องมีบัญชีรับเงิน
-- เติมมัดจำ
--  R1-22 / R2B-05 ยอดที่ต้องเติมคิดจากมัดจำ "ตอนซื้อ" (order_items.std_deposit) ไม่ใช่มัดจำสินค้าปัจจุบัน ·
--        ตั๋วที่ไม่มีออเดอร์ (แอดมินมอบ/ไล่เก็บ/หาของ) ไม่ได้ลดมัดจำด้วยยศ = ไม่ต้องเติม (เจ้าของ: เติมเฉพาะใบที่ยศลดมัดจำ)
--  R1-25 เครื่องเก่ากดปฏิเสธสลิปที่อนุมัติไปแล้ว = ลบแถวเงินที่อนุมัติแล้ว → สลิปที่อนุมัติแล้วลบไม่ได้อีก
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) มัดจำมาตรฐาน "ตอนซื้อ" ต่อชิ้น (ก่อนส่วนลดยศ) บันทึกลงรายการในออเดอร์
-- ─────────────────────────────────────────────────────────────────────────────
alter table order_items add column if not exists std_deposit numeric;

-- มัดจำมาตรฐานของรายการ ณ ตอนนี้ (สูตรเดียวกับ livePrice + lineDepositForRank ก่อนลดยศ): จ่ายเต็ม = ราคาเต็ม
--   SKU ที่ถูก convert เป็นของพร้อมส่ง (is_stock, ไม่มีรอบ): deposit_amount ของ SKU = ราคาเต็ม ใช้ไม่ได้ → ขั้นมัดจำมาตรฐานร้าน
--   (wcf 300 / mega 500 ตาม shop_settings — เหมือน v71) · รายการพร้อมส่งจ่ายเต็มจริงได้ราคาเต็มจาก greatest(มัดจำที่จ่าย, …) อยู่แล้ว
create or replace function ryuma_item_std_deposit_calc(p_product text, p_variant text, p_batch text, p_unit_price numeric, p_unit_dep numeric)
returns numeric language sql stable security definer set search_path = public as $$
  select greatest(coalesce(p_unit_dep, 0), coalesce((
    select case
      when p_batch is not null then
        (select case when b.deposit_amount >= b.price_total then b.price_total else b.deposit_amount end
           from product_batches b where b.id = p_batch)
      when coalesce(p.is_stock, false) then
        (select case when p.wcf_type = 'mega_wcf' then coalesce(s.deposit_mega, 500) else coalesce(s.deposit_wcf, 300) end
           from (select 1) one left join shop_settings s on s.id = 'default')
      when p_variant is not null then
        coalesce((select v.deposit_amount from product_variants v where v.id = p_variant), p.deposit_amount)
      else p.deposit_amount
    end
    from products p where p.id = p_product), 0));
$$;
revoke all on function ryuma_item_std_deposit_calc(text, text, text, numeric, numeric) from public, anon, authenticated;

-- รายการใหม่: เซิร์ฟเวอร์คำนวณเองเสมอ (ลูกค้าตั้งค่าเองไม่ได้) · แก้ทีหลังไม่ได้
--   ข้อยกเว้นเดียว: ryuma.trusted = 'on' (เจ้าของแก้ค่าที่ผิดจาก SQL Editor ได้ — ดูวิธีท้ายไฟล์)
--   แถวที่ยังไม่มีค่า (null) → คำนวณจากเซิร์ฟเวอร์ ไม่รับค่าจากเครื่องลูกค้า
create or replace function ryuma_order_items_std_deposit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_trusted boolean := coalesce(current_setting('ryuma.trusted', true) = 'on', false);
begin
  if TG_OP = 'INSERT' then
    if exists (select 1 from order_items i where i.id = new.id) then return new; end if; -- upsert แถวเดิม → ด่าน UPDATE
    -- ⚠ current_setting คืน null ถ้าไม่ได้ตั้ง → ต้อง coalesce ไม่งั้น not(null) = null แล้วข้ามการคำนวณ
    if new.std_deposit is null or not (is_app_admin() or v_trusted) then
      new.std_deposit := ryuma_item_std_deposit_calc(new.product_id, new.variant_id, new.batch_id, new.unit_price,
                           coalesce(new.unit_deposit, new.deposit_amount / greatest(new.qty, 1)));
    end if;
    return new;
  end if;
  if v_trusted and new.std_deposit is not null then return new; end if;
  if old.std_deposit is not null then
    new.std_deposit := old.std_deposit;
  else
    new.std_deposit := ryuma_item_std_deposit_calc(new.product_id, new.variant_id, new.batch_id, new.unit_price,
                         coalesce(new.unit_deposit, new.deposit_amount / greatest(new.qty, 1)));
  end if;
  return new;
end $$;
drop trigger if exists ryuma_order_items_std_deposit on order_items;
create trigger ryuma_order_items_std_deposit before insert or update on order_items
  for each row execute function ryuma_order_items_std_deposit();

-- เติมค่าให้รายการเก่า (ก่อน v76 ไม่ได้เก็บ) — ตัดสินจาก "ยอดที่จ่ายจริง" ไม่ใช่ยศวันนี้ (ยศเปลี่ยนได้หลังซื้อ):
--   จ่ายเต็มราคา → มัดจำที่จ่าย
--   จ่าย 0 แต่สินค้ามีมัดจำ → ได้ส่วนลด Diamond → มัดจำมาตรฐานปัจจุบัน
--   ยอดที่จ่าย = มัดจำฐาน × % Gold ของฐานที่ไม่เกินมัดจำปัจจุบัน → ได้ส่วนลด Gold → มัดจำฐานนั้น (= ยอดจ่าย ÷ % Gold)
--   นอกนั้น → มัดจำที่จ่าย (จ่ายเต็มตามยศ bronze/silver แม้ร้านขึ้นมัดจำทีหลัง)
-- ทำหลังสร้าง trigger แล้ว (รายการที่เข้ามาระหว่างรันได้ค่าจากเซิร์ฟเวอร์) และตั้ง ryuma.trusted ให้เขียนค่าได้
select set_config('ryuma.trusted', 'on', false);
with base as (
  select i.id,
         coalesce(i.unit_deposit, i.deposit_amount / greatest(i.qty, 1)) as paid,
         i.unit_price,
         ryuma_item_std_deposit_calc(i.product_id, i.variant_id, i.batch_id, i.unit_price, 0) as cur,
         coalesce((select s.rank_gold_deposit_pct from shop_settings s where s.id = 'default'), 50) as gpct
    from order_items i
   where i.std_deposit is null
)
update order_items i set std_deposit = case
    when b.paid is null then b.cur
    when b.paid >= coalesce(b.unit_price, 1e12) then b.paid
    when b.paid = 0 and b.cur > 0 then b.cur
    when b.gpct > 0 and b.gpct < 100 and b.paid > 0
         and round(b.paid * 100 / b.gpct) <= b.cur + 1 then least(round(b.paid * 100 / b.gpct), b.cur)
    else b.paid
  end
  from base b
 where i.id = b.id;
select set_config('ryuma.trusted', 'off', false);

-- "มัดจำปกติ" ต่อชิ้นที่ต้องเติมให้ถึงก่อนเปลี่ยนใบ/ลงขาย (ทับ v71) — ต้องตรงกับ standardDepositPerUnit ในแอป
--   หา "รายการในออเดอร์ต้นทาง" ของตั๋ว (ตั๋วลูกใช้ของตั๋วแม่ต้นสาย):
--     1) ตั๋วผูกรายการ id = 't-' || item.id
--     2) ตั๋วรุ่นเก่า: รายการของคนจ่าย สินค้า/แบบ/รอบเดียวกัน และมัดจำต่อชิ้นตรงกับตั๋ว (±1 บาท)
--   ไม่เจอ = ตั๋วแอดมินมอบ/ไล่เก็บ/หาของ → 0 (ไม่ได้ลดมัดจำด้วยยศ ไม่ต้องเติม)
create or replace function ryuma_market_std_deposit(p_ticket_id text)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare t preorder_tickets%rowtype; r preorder_tickets%rowtype; nx preorder_tickets%rowtype; v_base numeric; n int := 0;
begin
  select * into t from preorder_tickets where id = p_ticket_id;
  if not found then return 0; end if;
  r := t;
  while r.split_from is not null and n < 20 loop
    select * into nx from preorder_tickets where id = r.split_from;
    exit when not found;
    r := nx; n := n + 1;
  end loop;
  select coalesce(i.std_deposit, i.unit_deposit, i.deposit_amount / greatest(i.qty, 1)) into v_base
    from order_items i join orders o on o.id = i.order_id
   where 't-' || i.id = r.id and o.status = 'approved';
  if v_base is null then
    select coalesce(i.std_deposit, i.unit_deposit, i.deposit_amount / greatest(i.qty, 1)) into v_base
      from order_items i join orders o on o.id = i.order_id
     where o.user_id = coalesce(r.original_buyer_id, r.owner_id) and o.status = 'approved' and coalesce(i.qty, 0) > 0
       and i.product_id = r.product_id and i.variant_id is not distinct from r.variant_id
       and i.batch_id is not distinct from r.batch_id
       and abs(coalesce(i.unit_deposit, i.deposit_amount / greatest(i.qty, 1)) - coalesce(r.deposit_paid, 0) / greatest(r.qty, 1)) <= 1
     order by abs(extract(epoch from (coalesce(o.approved_at, o.created_at) - r.created_at)))
     limit 1;
  end if;
  if v_base is null then return 0; end if;
  return greatest(0, least(v_base, (coalesce(t.deposit_paid, 0) + coalesce(t.remaining_amount, 0)) / greatest(t.qty, 1)));
end $$;
revoke all on function ryuma_market_std_deposit(text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ตารางลับ: บัญชีรับเงินที่ล็อกกับดีล (ลูกค้าอ่านตรงไม่ได้ · อ่านผ่าน ryuma_market_payout เท่านั้น)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ticket_transfer_payouts (
  transfer_id text primary key,
  payout      jsonb not null,
  created_at  timestamptz not null default now()
);
alter table ticket_transfer_payouts enable row level security;
revoke all on ticket_transfer_payouts from anon, authenticated;

insert into ticket_transfer_payouts (transfer_id, payout)
select id, payout_snap from ticket_transfers where payout_snap is not null
on conflict (transfer_id) do nothing;
update ticket_transfers set payout_snap = null where payout_snap is not null;

-- กันเหนียว: ใครเขียน payout_snap ลงตารางดีล → ย้ายเข้าตารางลับ แล้วล้างช่องนั้นทิ้ง
create or replace function ryuma_transfers_payout_vault()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.payout_snap is not null then
    insert into ticket_transfer_payouts (transfer_id, payout) values (new.id, new.payout_snap)
      on conflict (transfer_id) do update set payout = excluded.payout;
    new.payout_snap := null;
  end if;
  return new;
end $$;
drop trigger if exists ryuma_transfers_payout_vault on ticket_transfers;
create trigger ryuma_transfers_payout_vault before insert or update on ticket_transfers
  for each row execute function ryuma_transfers_payout_vault();

create or replace function ryuma_transfers_payout_cleanup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from ticket_transfer_payouts where transfer_id = old.id;
  return old;
end $$;
drop trigger if exists ryuma_transfers_payout_cleanup on ticket_transfers;
create trigger ryuma_transfers_payout_cleanup after delete on ticket_transfers
  for each row execute function ryuma_transfers_payout_cleanup();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ส่งข้อเสนอ (ทับ v75) — บัญชีเข้าตารางลับ · ยกให้ฟรีไม่ต้องมีบัญชี (R1-58) · ไม่เขียนทับบัญชีหลักของคนส่ง
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_offer(p_ticket_id text, p_qty int, p_price numeric, p_code text, p_payout jsonb, p_expect_user text)
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
revoke all on function ryuma_market_offer(text, int, numeric, text, jsonb, text) from public, anon;
grant execute on function ryuma_market_offer(text, int, numeric, text, jsonb, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) ลงประกาศกระดาน (ทับ v72) — ล็อกบัญชีรับเงินตอนลงประกาศ (R1-07)
-- ─────────────────────────────────────────────────────────────────────────────
--    + p_payout = บัญชีที่คนขายเลือกในหน้าลงขาย (ส่งมากับคำขอ) — เดิมอ่าน payout_info ตอนนั้น ซึ่งอาจยังเป็นบัญชีเก่า
--      ถ้าการบันทึก "บัญชีหลัก" ยังไม่ขึ้น → ผู้ซื้อโอนเข้าบัญชีที่คนขายไม่ได้เลือก 14 วัน (review รอบ C) · ไม่ส่ง = ใช้บัญชีหลัก
drop function if exists ryuma_market_list(text, int, numeric);
create or replace function ryuma_market_list(p_ticket_id text, p_qty int, p_price numeric, p_payout jsonb default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); t preorder_tickets%rowtype; v_reason text; v_id text; v_pay jsonb; s record;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if not ryuma_market_open() and not is_app_admin() then return json_build_object('error', 'closed'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  if p_payout is not null then
    v_pay := jsonb_build_object('promptpay', nullif(regexp_replace(coalesce(p_payout->>'promptpay', ''), '[^0-9]', '', 'g'), ''),
                                'bank', nullif(left(trim(coalesce(p_payout->>'bank', '')), 60), ''),
                                'account_no', nullif(regexp_replace(coalesce(p_payout->>'account_no', ''), '[^0-9]', '', 'g'), ''),
                                'account_name', left(trim(coalesce(p_payout->>'account_name', '')), 120));
  else
    select payout_info into v_pay from users where id = v_uid;
  end if;
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
  insert into ticket_transfer_payouts (transfer_id, payout) values (v_id, v_pay)
    on conflict (transfer_id) do update set payout = excluded.payout;
  return json_build_object('ok', true, 'id', v_id, 'expires_at', now() + interval '14 days');
end $$;
revoke all on function ryuma_market_list(text, int, numeric, jsonb) from public, anon;
grant execute on function ryuma_market_list(text, int, numeric, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) อ่านบัญชีรับเงินของดีล (ทับ v75)
--    · ผู้รับดีลตรง: ระหว่างข้อเสนอยังไม่หมดเวลา (เปิดดู = เริ่มโอน → บันทึก payout_viewed_at) หรือหลังโอนแล้ว
--    · ผู้ซื้อกระดาน: เฉพาะช่วงจอง (15 นาที + ผ่อนผัน 10) หรือหลังโอนแล้ว (R1-08)
--    · คนส่ง/คนขาย: ดูบัญชีของดีลตัวเองได้เสมอ (รู้ว่าเงินต้องเข้าบัญชีไหน · R1-49) · แอดมิน: ทุกดีล
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_payout(p_id text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_pay jsonb; v_direct boolean; v_live boolean; v_buyer boolean;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  v_direct := coalesce(tr.kind, 'market') = 'direct';
  -- coalesce ทุกตัว: ค่า null (เช่น hold_until ว่าง / ผู้รับว่าง) ต้องแปลว่า "ไม่มีสิทธิ์" ไม่ใช่หลุดด่าน
  v_live := coalesce(tr.status = 'reserved' and case when v_direct then ryuma_market_live(tr.status, tr.hold_until, tr.expires_at)
                                                     else tr.hold_until + interval '10 minutes' > now() end, false);
  v_buyer := coalesce(tr.to_user_id = v_uid, false) and (tr.status in ('paid', 'reviewing', 'seller_ok') or v_live);
  if not (v_buyer or coalesce(tr.from_user_id = v_uid, false) or is_app_admin()) then return json_build_object('error', 'not_found'); end if;
  if v_buyer and v_live and v_direct and tr.payout_viewed_at is null and coalesce(tr.asking_price, 0) > 0 then
    update ticket_transfers set payout_viewed_at = now(), updated_at = now() where id = p_id;
  end if;
  select payout into v_pay from ticket_transfer_payouts where transfer_id = tr.id;
  -- ประกาศกระดานที่ลงก่อน v76 (ยังไม่มีบัญชีล็อก) → บัญชีหลักของคนขาย
  if v_pay is null and not v_direct then select payout_info into v_pay from users where id = tr.from_user_id; end if;
  if v_pay is null then return json_build_object('ok', true, 'amount', tr.asking_price, 'none', true); end if;
  return json_build_object('ok', true, 'amount', tr.asking_price,
    'promptpay', v_pay->>'promptpay', 'bank', v_pay->>'bank',
    'account_no', v_pay->>'account_no', 'account_name', v_pay->>'account_name');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) สลิปที่อนุมัติแล้ว = หลักฐานเงินเข้า ลบไม่ได้ (แม้แอดมิน) — เครื่องเก่ากดปฏิเสธทับไม่ได้อีก (R1-25)
--    ทางเดียวที่ลบได้: RPC ที่ตั้ง ryuma.trusted (เช่นลบสมาชิก)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_rp_keep_approved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('ryuma.trusted', true) = 'on' then return old; end if;
  if old.status = 'approved' then
    raise exception 'ryuma: สลิปนี้อนุมัติไปแล้ว ลบ/ปฏิเสธไม่ได้ — รีเฟรชหน้าเช็คสถานะล่าสุด';
  end if;
  return old;
end $$;
drop trigger if exists ryuma_rp_keep_approved on remaining_payments;
create trigger ryuma_rp_keep_approved before delete on remaining_payments
  for each row execute function ryuma_rp_keep_approved();

-- ลบสมาชิก (ทับ v74) — เหมือนเดิมทุกด่าน + ตั้ง ryuma.trusted ตอนลบ (สลิปที่อนุมัติแล้วของคนนี้ลบได้เฉพาะทางนี้)
create or replace function ryuma_admin_purge_user(p_user_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_auth uuid; v_live int; v_hist int; v_recv int; v_sold int;
begin
  if not is_app_admin() then return json_build_object('error','not_admin'); end if;
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
-- select count(*) filter (where std_deposit is null) as missing from order_items;        -- 0
-- select count(*) from ticket_transfers where payout_snap is not null;                   -- 0 (ย้ายเข้าตารางลับแล้ว)
-- select count(*) from ticket_transfer_payouts;                                           -- เท่าจำนวนดีลที่เคยมีบัญชี
--
-- ถ้าต้องแก้ std_deposit ของรายการไหนเอง (ปกติไม่ต้อง) — ต้องตั้ง ryuma.trusted ก่อน ไม่งั้น trigger คงค่าเดิม:
--   select set_config('ryuma.trusted', 'on', false);
--   update order_items set std_deposit = 300 where id = '<id รายการ>';
--   select set_config('ryuma.trusted', 'off', false);
