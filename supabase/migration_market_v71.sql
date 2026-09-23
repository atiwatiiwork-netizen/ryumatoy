-- ============================================================================
-- Ryuma — v71: ตลาดใบพรี (P2P ซื้อขายใบพรีระหว่างลูกค้า) · เฟส 0 "ฐานกันพัง"
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ลูกค้ายังไม่เห็นอะไร (หน้าจอมาเฟส 1)
--
-- กติกาทั้งหมดตามที่เจ้าของตอบ 30 ข้อ (2026-09-23):
--   · ผู้ซื้อโอนตรงถึงคนขาย (ร้านไม่ถือเงิน) → คนขายยืนยันรับเงิน → แอดมินไฟนอล → ตั๋ว "ย้ายเจ้าของ" (ไม่ลบ)
--   · ขายได้หลังปิดรอบ (ผลิต/เดินทาง/ถึงไทย) · แตกขายทีละชิ้นได้ · ลงพร้อมกันได้ 5 ใบ · ซื้อมาต้องถือ 3 วัน
--   · ใบมัดจำไม่เต็ม (Diamond 0 / Gold ครึ่ง) ต้องเติมให้ครบมัดจำปกติก่อนลงขาย · ไม่มีค่าธรรมเนียม · ราคาอิสระ
--   · จอง 15 นาที · คนขายยืนยันใน 12 ชม. (เกิน → ตรวจสอบ) · ประกาศ 14 วัน · เลขตั๋วใหม่ = เลขเดิม-T1
--
-- ไฟล์นี้ทำ 6 อย่าง:
--   1) คอลัมน์ใหม่ (ticket_transfers / preorder_tickets.split_from / remaining_payments.purpose / users.payout_info)
--   2) สิทธิ์: ลูกค้า "อ่าน" ได้เฉพาะดีลของตัวเอง — เขียนผ่าน RPC เท่านั้น (เดิมคนขายตั้ง status เองได้)
--   3) RPC 12 ตัว ryuma_market_* (ทุกการเปลี่ยนสถานะ ล็อกแถว กันสองคนจองชนกัน)
--   4) ล็อกตั๋วที่ลงขายในฐานข้อมูล: ห้ามจ่ายส่วนต่าง/เลือกวิธีรับของซ้อนดีล
--   5) guard ตั๋ว: ลูกค้าแตะ split_from ไม่ได้
--   6) เลขตั๋ว: reserve_ticket_nos อ่านเลขลำดับถูกแม้มีเลขแบบ …-0142-T1
-- ⚠ ฝั่งแอปต้อง deploy โค้ดเฟส 0 ก่อนหรือพร้อมกัน (แอปเลิกเขียน ticket_transfers เองแล้ว) — ถ้ารันไฟล์นี้
--   กับแอปเวอร์ชันเก่า: แค่ "ลงขาย P2P" ที่ปิดไว้อยู่แล้วใช้ไม่ได้ ไม่มีอะไรพัง
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) คอลัมน์ใหม่
-- ─────────────────────────────────────────────────────────────────────────────
alter table ticket_transfers
  add column if not exists qty                 int,
  add column if not exists hold_until          timestamptz,
  add column if not exists slip_url            text,
  add column if not exists paid_at             timestamptz,
  add column if not exists seller_confirmed_at timestamptz,
  add column if not exists review_reason       text,
  add column if not exists review_note         text,
  add column if not exists review_evidence     jsonb,
  add column if not exists reviewing_at        timestamptz,
  add column if not exists finalized_by        text,
  add column if not exists prev_ticket_no      text,
  add column if not exists new_ticket_no       text,
  add column if not exists child_ticket_id     text,
  add column if not exists order_item_id       text,
  add column if not exists product_id          text,
  add column if not exists variant_id          text,
  add column if not exists batch_id            text,
  add column if not exists expires_at          timestamptz,
  add column if not exists cancelled_at        timestamptz,
  add column if not exists cancel_reason       text,
  add column if not exists updated_at          timestamptz default now();

alter table preorder_tickets   add column if not exists split_from  text;   -- ตั๋วลูกที่แตกขาย → id ตั๋วแม่
alter table remaining_payments add column if not exists purpose     text;   -- 'topup' = เติมมัดจำก่อนลงขาย
alter table users              add column if not exists payout_info jsonb;  -- บัญชีรับเงินของคนขาย

-- แถวทดลองสมัย scaffold (ก่อน v71 ไม่มีตลาดจริง) → ยกเลิกทิ้ง กันชนดัชนี "ประกาศค้างได้ใบละ 1 แถว"
update ticket_transfers
   set status = 'cancelled', cancelled_at = now(), cancel_reason = 'legacy_scaffold', updated_at = now()
 where expires_at is null and status in ('listed', 'pending_admin');

create unique index if not exists ticket_transfers_one_active
  on ticket_transfers (ticket_id)
  where status in ('listed', 'reserved', 'paid', 'reviewing', 'seller_ok', 'pending_admin');
create index if not exists ticket_transfers_from_idx on ticket_transfers (from_user_id);
create index if not exists ticket_transfers_to_idx   on ticket_transfers (to_user_id);
create index if not exists preorder_tickets_split_idx on preorder_tickets (split_from) where split_from is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) สิทธิ์ — อ่านได้เฉพาะดีลที่ตัวเองเป็นคนขาย/คนซื้อ · เขียนผ่าน RPC (security definer) เท่านั้น
--    เดิม policy `transfers_own for all` ให้เจ้าของแถวแก้ได้ทุกช่อง = คนขายกด status='approved' เองได้
-- ─────────────────────────────────────────────────────────────────────────────
alter table ticket_transfers enable row level security;
drop policy if exists transfers_own   on ticket_transfers;
drop policy if exists transfers_read  on ticket_transfers;
drop policy if exists transfers_admin on ticket_transfers;
create policy transfers_read on ticket_transfers for select
  using (from_user_id = app_user_id() or to_user_id = app_user_id() or is_app_admin());
create policy transfers_admin on ticket_transfers for all
  using (is_app_admin()) with check (is_app_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- ตัวช่วย (ต้องตรงกับ src/domain/services/market.ts ทุกตัว)
-- ─────────────────────────────────────────────────────────────────────────────

-- แถวประกาศนี้ "ยังมีชีวิต" ไหม (หมดอายุแบบขี้เกียจ — ไม่มีตัวตั้งเวลา: จองเกินเวลาแต่ประกาศยังไม่หมด
-- = กลับเป็นลงขาย, ประกาศเกินอายุ = ตาย) · ตรงกับ effectiveStatus ในแอป
create or replace function ryuma_market_live(p_status text, p_hold timestamptz, p_exp timestamptz)
returns boolean language sql stable as $$
  select coalesce(
       p_status in ('paid', 'reviewing', 'seller_ok', 'pending_admin')
    or (p_status = 'reserved' and (p_hold + interval '10 minutes' > now() or p_exp is null or p_exp > now()))
    or (p_status = 'listed'   and (p_exp is null or p_exp > now())), false);
$$;

-- ตั๋วใบนี้ "ลงขายอยู่" ไหม (ใช้ล็อกการจ่ายส่วนต่าง/เลือกวิธีรับของ)
create or replace function ryuma_market_active(p_ticket_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ticket_transfers tr
     where tr.ticket_id = p_ticket_id and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at)
  );
$$;

-- แบ่งเงินตอนแตกขาย (ข้อ 3B) — ลูกได้ (x × qty ÷ ชิ้นทั้งหมด) ปัดครึ่งขึ้น แม่ได้ที่เหลือเป๊ะ ยอดรวมไม่ขยับ
create or replace function ryuma_split_share(p_qty int, p_tqty int, p_dep numeric, p_rem numeric, p_paid numeric,
  out c_dep numeric, out c_rem numeric, out c_paid numeric, out r_dep numeric, out r_rem numeric, out r_paid numeric)
language plpgsql immutable as $$
declare d numeric;
begin
  c_dep  := round(coalesce(p_dep, 0)  * p_qty / p_tqty);
  c_rem  := round(coalesce(p_rem, 0)  * p_qty / p_tqty);
  c_paid := least(round(coalesce(p_paid, 0) * p_qty / p_tqty), c_rem);
  r_dep  := coalesce(p_dep, 0)  - c_dep;
  r_rem  := coalesce(p_rem, 0)  - c_rem;
  r_paid := coalesce(p_paid, 0) - c_paid;
  if r_paid > r_rem then d := r_paid - r_rem; r_paid := r_paid - d; c_paid := c_paid + d; end if;
end $$;

-- "มัดจำปกติ" ต่อชิ้น (ข้อ 9) = มัดจำของรอบก่อนส่วนลดยศ ไม่เกินราคาเต็มต่อชิ้นของตั๋ว
create or replace function ryuma_market_std_deposit(p_ticket_id text)
returns numeric language sql stable security definer set search_path = public as $$
  select greatest(0, least(
    case
      when t.batch_id is not null then coalesce((select b.deposit_amount from product_batches b where b.id = t.batch_id), 0)
      when coalesce(p.is_stock, false) then
        case when p.wcf_type = 'mega_wcf' then coalesce(s.deposit_mega, 500) else coalesce(s.deposit_wcf, 300) end
      when t.variant_id is not null then
        coalesce((select v.deposit_amount from product_variants v where v.id = t.variant_id), p.deposit_amount, 0)
      else coalesce(p.deposit_amount, 0)
    end,
    (coalesce(t.deposit_paid, 0) + coalesce(t.remaining_amount, 0)) / greatest(t.qty, 1)
  ))
  from preorder_tickets t
  left join products p on p.id = t.product_id
  left join shop_settings s on s.id = 'default'
  where t.id = p_ticket_id;
$$;

-- เหตุผลที่ "ลงขายใบนี้ไม่ได้" (null = ได้) — กติกาเดียวกับ sellBlockReason ในแอป
create or replace function ryuma_market_block_reason(p_ticket_id text, p_uid text, p_qty int)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  t preorder_tickets%rowtype; p products%rowtype; v_gap numeric; v_until timestamptz; v_payer text;
begin
  select * into t from preorder_tickets where id = p_ticket_id;
  if not found then return 'not_found'; end if;
  if t.owner_id is distinct from p_uid then return 'not_owner'; end if;
  if t.status in ('shipped', 'pending_approval', 'transferred') then return 'bad_status'; end if;
  if t.delivery is not null then return 'delivery_chosen'; end if;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) RPC — คืน json {ok:true,...} หรือ {error:'<code>'} · ตัวตนมาจาก session (app_user_id) เสมอ ไม่เชื่อ client
--    เวลาจอง: โชว์ลูกค้า 15 นาที + ผ่อนผันหลังบ้านอีก 10 นาที (โอนทันแต่แนบสลิปช้า ไม่โดนตัดสิทธิ์)
-- ─────────────────────────────────────────────────────────────────────────────

-- 3.1 กระดาน — ลูกค้ามองไม่เห็นตั๋วคนอื่นตาม RLS (ถูกต้อง ห้ามเปิด) ข้อมูลประกาศจึงมาจากที่นี่ + ปิดชื่อคนขาย
create or replace function ryuma_market_feed()
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid text := app_user_id();
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  return json_build_object('ok', true, 'server_now', now(), 'rows', coalesce((
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

-- 3.2 ลงประกาศ (คนขาย) — ด่านทั้งหมดอยู่ใน ryuma_market_block_reason + ต้องมีบัญชีรับเงินก่อน
create or replace function ryuma_market_list(p_ticket_id text, p_qty int, p_price numeric)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); t preorder_tickets%rowtype; v_reason text; v_id text; v_pay jsonb;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
  if p_price is null or p_price < 0 or p_price > 1000000 or p_price <> round(p_price) then
    return json_build_object('error', 'bad_price'); end if;
  select payout_info into v_pay from users where id = v_uid;
  if v_pay is null or coalesce(v_pay->>'account_name', '') = ''
     or (coalesce(v_pay->>'promptpay', '') = '' and coalesce(v_pay->>'account_no', '') = '') then
    return json_build_object('error', 'no_payout'); end if;
  select * into t from preorder_tickets where id = p_ticket_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  -- เก็บกวาดแถวเก่าของใบนี้ที่หมดอายุแล้ว (ดัชนี one_active ดูแค่ status ไม่รู้เรื่องเวลา)
  update ticket_transfers set status = 'expired', to_user_id = null, hold_until = null, updated_at = now()
   where ticket_id = t.id and status in ('listed', 'reserved')
     and not ryuma_market_live(status, hold_until, expires_at);
  v_reason := ryuma_market_block_reason(t.id, v_uid, p_qty);
  if v_reason is not null then return json_build_object('error', v_reason); end if;
  v_id := 'tr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  insert into ticket_transfers (id, ticket_id, from_user_id, asking_price, status, listed_at, expires_at, qty,
                                product_id, variant_id, batch_id, order_item_id, updated_at)
  values (v_id, t.id, v_uid, p_price, 'listed', now(), now() + interval '14 days', p_qty,
          t.product_id, t.variant_id, t.batch_id,
          case when t.id like 't-%' and exists (select 1 from order_items oi where oi.id = substr(t.id, 3)) then substr(t.id, 3) end,
          now());
  return json_build_object('ok', true, 'id', v_id, 'expires_at', now() + interval '14 days');
end $$;

-- 3.3 ถอนประกาศ (คนขาย) — ได้เฉพาะตอนยังไม่มีใครจองอยู่
create or replace function ryuma_market_cancel(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now() then
    return json_build_object('error', 'reserved', 'hold_until', tr.hold_until); end if;
  if tr.status not in ('listed', 'reserved') then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'seller', to_user_id = null, hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 3.4 จอง (ผู้ซื้อ) — ล็อกแถว: สองคนกดวินาทีเดียวกัน ได้คนเดียว
create or replace function ryuma_market_reserve(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; v_until timestamptz;
begin
  if v_uid is null or not is_app_approved() then return json_build_object('error', 'no_session'); end if;
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
  -- จองได้ทีละใบต่อคน (กันกดจองกั๊กหลายใบพร้อมกัน)
  if exists (select 1 from ticket_transfers x
              where x.to_user_id = v_uid and x.id <> p_id and x.status = 'reserved'
                and x.hold_until + interval '10 minutes' > now()) then
    return json_build_object('error', 'one_at_a_time'); end if;
  -- ตั๋วต้องยังเหมือนตอนลงประกาศ (เจ้าของเดิม · ยังไม่จัดส่ง · ไม่มีสลิปค้าง) ไม่งั้นปิดประกาศเลย
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

-- 3.5 ปล่อยจอง (ผู้ซื้อเปลี่ยนใจก่อนโอน)
create or replace function ryuma_market_release(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid or tr.status <> 'reserved' then
    return json_build_object('error', 'not_found'); end if;
  update ticket_transfers set status = 'listed', to_user_id = null, hold_until = null, updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 3.6 บัญชีรับเงินของคนขาย — เปิดให้เฉพาะคนที่จองอยู่/จ่ายแล้วของดีลนี้
create or replace function ryuma_market_payout(p_id text)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_pay jsonb;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id;
  if not found or tr.to_user_id is distinct from v_uid
     or not (tr.status in ('paid', 'reviewing', 'seller_ok')
             or (tr.status = 'reserved' and tr.hold_until + interval '10 minutes' > now())) then
    return json_build_object('error', 'not_found'); end if;
  select payout_info into v_pay from users where id = tr.from_user_id;
  return json_build_object('ok', true, 'amount', tr.asking_price,
    'promptpay', v_pay->>'promptpay', 'bank', v_pay->>'bank',
    'account_no', v_pay->>'account_no', 'account_name', v_pay->>'account_name');
end $$;

-- 3.7 แนบสลิป (ผู้ซื้อ) → แจ้งคนขาย + ร้าน (push/LINE ยิงจากแอปหลัง RPC สำเร็จ)
create or replace function ryuma_market_pay(p_id text, p_slip text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  if coalesce(p_slip, '') !~ '^https?://' then return json_build_object('error', 'bad_slip'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if tr.status = 'paid' then return json_build_object('ok', true, 'again', true); end if;
  if tr.status <> 'reserved' or tr.hold_until + interval '10 minutes' <= now() then
    return json_build_object('error', 'hold_expired'); end if;
  update ticket_transfers set status = 'paid', slip_url = p_slip, paid_at = now(), updated_at = now() where id = p_id;
  return json_build_object('ok', true, 'paid_at', now());
end $$;

-- 3.8 คนขายยืนยัน "ได้รับเงินแล้ว" → รอร้านไฟนอล (ยืนยันจากสถานะตรวจสอบได้ด้วย: แอดมินโทรตามแล้วคนขายกดเอง)
create or replace function ryuma_market_seller_confirm(p_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if tr.status = 'seller_ok' then return json_build_object('ok', true, 'again', true); end if;
  if tr.status not in ('paid', 'reviewing') then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers set status = 'seller_ok', seller_confirmed_at = now(), updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 3.9 คนขายแจ้ง "ยังไม่ได้รับเงิน" + หลักฐาน → ตรวจสอบ (ข้อ 22: แอดมินชี้ขาดจากหลักฐานสองฝั่ง)
create or replace function ryuma_market_seller_reject(p_id text, p_note text, p_evidence jsonb default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found or tr.from_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
  if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'reviewing', review_reason = 'not_received', review_note = left(coalesce(p_note, ''), 500),
         review_evidence = p_evidence, reviewing_at = now(), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 3.10 ส่งเข้าตรวจสอบ (ข้อ 12): ผู้ซื้อกดได้เมื่อคนขายเงียบเกิน 12 ชม. · แอดมินกดได้ทุกเมื่อ
create or replace function ryuma_market_escalate(p_id text, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype; v_admin boolean := is_app_admin();
begin
  if v_uid is null then return json_build_object('error', 'no_session'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.status = 'reviewing' then return json_build_object('ok', true, 'again', true); end if;
  if v_admin then
    if tr.status not in ('paid', 'seller_ok', 'pending_admin') then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  else
    if tr.to_user_id is distinct from v_uid then return json_build_object('error', 'not_found'); end if;
    if tr.status <> 'paid' then return json_build_object('error', 'bad_status', 'status', tr.status); end if;
    if tr.paid_at + interval '12 hours' > now() then
      return json_build_object('error', 'too_early', 'at', tr.paid_at + interval '12 hours'); end if;
  end if;
  update ticket_transfers
     set status = 'reviewing', review_reason = case when v_admin then 'admin' else 'seller_silent' end,
         review_note = coalesce(left(p_note, 500), review_note), reviewing_at = now(), updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 3.11 ไฟนอล (แอดมิน) — ครั้งเดียวจบในทรานแซกชันเดียว: ย้ายเจ้าของ (หรือแตกตั๋วลูก) + เลขใหม่ -T<n> + บันทึก
--      original_buyer_id ไม่เปลี่ยน = มัดจำยังผูกออเดอร์เดิมของคนสั่ง → ยอดเงินร้านไม่ขยับสักบาท
create or replace function ryuma_market_finalize(p_id text, p_order_item_id text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; s record;
  v_qty int; v_base text; v_n int; v_no text; v_child text; v_payer text; v_name text;
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
  v_qty := coalesce(tr.qty, t.qty);
  if v_qty < 1 or v_qty > t.qty then return json_build_object('error', 'bad_qty'); end if;
  v_payer := coalesce(t.original_buyer_id, t.owner_id);
  -- เลขใหม่ (ข้อ 24A) = เลขฐาน-T<n+1> · server เห็นตั๋วทุกใบจึงไม่ชน (ticket_no ยัง unique อยู่อีกชั้น)
  v_base := regexp_replace(t.ticket_no, '-T[0-9]+$', '');
  select coalesce(max((substring(x.ticket_no from '-T([0-9]+)$'))::int), 0) into v_n
    from preorder_tickets x where x.ticket_no like v_base || '-T%';
  v_no := v_base || '-T' || (v_n + 1);
  if v_qty = t.qty then
    -- ขายยกใบ: แถวเดิม id เดิม (สลิป/ประวัติ/แต้ม ผูกไว้หมด) แค่เปลี่ยนคนถือ + เลข (QR เก่าที่คนขายแคปไว้ใช้ไม่ได้)
    update preorder_tickets set original_buyer_id = v_payer, owner_id = tr.to_user_id, ticket_no = v_no where id = t.id;
  else
    -- แตกขาย (ข้อ 3B): ลูกได้ส่วนแบ่งตามสัดส่วน แม่เหลือที่เหลือเป๊ะ · approved_at ของลูก = ของแม่ (เดือนของเงินไม่ขยับ)
    select * into s from ryuma_split_share(v_qty, t.qty, t.deposit_paid, t.remaining_amount, t.remaining_paid);
    v_child := 'tc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
    insert into preorder_tickets (id, ticket_no, product_id, variant_id, batch_id, owner_id, original_buyer_id, qty,
        deposit_paid, remaining_amount, remaining_paid, status, product_status, qr_code_url,
        warehouse_at, warehouse_transport, split_from, created_at, approved_at)
    values (v_child, v_no, t.product_id, t.variant_id, t.batch_id, tr.to_user_id, v_payer, v_qty,
        s.c_dep, s.c_rem, s.c_paid, case when s.c_paid >= s.c_rem then 'paid_full' else 'active' end,
        t.product_status, t.qr_code_url, t.warehouse_at, t.warehouse_transport, t.id, now(), t.approved_at);
    update preorder_tickets
       set original_buyer_id = v_payer, qty = t.qty - v_qty,
           deposit_paid = s.r_dep, remaining_amount = s.r_rem, remaining_paid = s.r_paid,
           status = case when s.r_paid >= s.r_rem then 'paid_full' else 'active' end
     where id = t.id;
  end if;
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

-- 3.12 แอดมินยกเลิกดีล (ข้อ 12 default: ถ้าผู้ซื้อโอนไปแล้ว คนขายคืนเงินเองนอกระบบ — บันทึกเหตุผลไว้)
create or replace function ryuma_market_admin_cancel(p_id text, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); tr ticket_transfers%rowtype;
begin
  if v_uid is null or not is_app_admin() then return json_build_object('error', 'admin_only'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.status in ('done', 'approved', 'cancelled', 'expired') then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  update ticket_transfers
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'admin: ' || left(coalesce(p_reason, ''), 300),
         hold_until = null, updated_at = now()
   where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) ล็อกตั๋วที่ลงขายอยู่ในฐานข้อมูล (ชั้นสอง — แอปกันไว้แล้วใน mutation)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_rp_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert แถวเดิม
  if ryuma_market_active(new.ticket_id) then
    raise exception 'ryuma: ใบนี้ลงขายอยู่ในตลาดใบพรี — ถอนประกาศก่อนจ่ายส่วนต่าง';
  end if;
  return new;
end $$;
drop trigger if exists ryuma_market_rp_lock on remaining_payments;
create trigger ryuma_market_rp_lock before insert on remaining_payments
  for each row execute function ryuma_market_rp_lock();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) guard ตั๋ว (ต่อจาก v65 ทุกบรรทัด + 2 ข้อใหม่): ลูกค้าแตะ split_from ไม่ได้ ·
--    ใบที่ลงขายอยู่ เลือก/เปลี่ยนวิธีรับของไม่ได้ (ผู้ซื้อกำลังจะรับสิทธิ์ไป)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;

  if TG_OP = 'INSERT' then
    if exists (select 1 from preorder_tickets t where t.id = new.id) then return new; end if;
    if not exists (
      select 1 from order_items oi join orders o on o.id = oi.order_id
      where 't-' || oi.id = new.id
        and o.user_id = app_user_id()
        and o.status = 'approved'
        and oi.product_id = new.product_id
    ) then
      raise exception 'ryuma: ออกตั๋วเองไม่ได้ (ต้องมาจากออเดอร์ที่อนุมัติแล้วเท่านั้น)';
    end if;
    new.owner_id := app_user_id();
    new.remaining_paid := 0;
    new.status := 'active';
    new.variant_id := (select oi.variant_id from order_items oi where 't-' || oi.id = new.id);
    new.qty := coalesce((select oi.qty from order_items oi where 't-' || oi.id = new.id), 1);
    new.deposit_paid := least(coalesce(new.deposit_paid, 0),
      coalesce((select oi.deposit_amount from order_items oi where 't-' || oi.id = new.id), 0));
    new.split_from := null;                 -- ตั๋วลูกเกิดได้ทางเดียว: ryuma_market_finalize (แอดมิน)
    return new;
  end if;

  new.deposit_paid     := old.deposit_paid;
  new.remaining_amount := old.remaining_amount;
  new.remaining_paid   := old.remaining_paid;
  new.status           := old.status;
  new.product_status   := old.product_status;
  new.ticket_no        := old.ticket_no;
  new.owner_id         := old.owner_id;
  new.original_buyer_id := old.original_buyer_id;
  new.product_id       := old.product_id;
  new.variant_id       := old.variant_id;
  new.batch_id         := old.batch_id;
  new.qty              := old.qty;
  new.parcel_no        := old.parcel_no;
  new.carrier          := old.carrier;
  new.approved_at      := old.approved_at;
  new.qr_code_url      := old.qr_code_url;
  new.warehouse_at        := old.warehouse_at;
  new.warehouse_transport := old.warehouse_transport;
  new.warehouse_slip      := old.warehouse_slip;
  new.parcel_image     := old.parcel_image;
  new.shipped_out_at   := old.shipped_out_at;
  new.split_from       := old.split_from;
  if ryuma_market_active(old.id) then new.delivery := old.delivery; end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) เลขตั๋ว: อ่าน "เลขลำดับที่ต่อจาก prefix" ตรงๆ — เดิมอ่านตัวเลขท้ายสุดของสตริง
--    เลข …-0142-T1 จะถูกอ่านเป็น 1 (ลำดับเดือนนั้นเพี้ยน) · ลายเซ็นเดิม = ทับ ไม่สร้างซ้อน
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function reserve_ticket_nos(p text, c int)
returns int language plpgsql security definer set search_path = public as $$
declare
  cnt int := greatest(coalesce(c, 1), 1);
  real_max int;
  start_n int;
begin
  select coalesce(max((substring(substr(ticket_no, length(p) + 2) from '^([0-9]+)'))::int), 0)
    into real_max
    from preorder_tickets
   where ticket_no like p || '-%';

  insert into ticket_counters(prefix, n) values (p, 0)
    on conflict (prefix) do nothing;

  update ticket_counters
     set n = greatest(n, real_max) + cnt
   where prefix = p
   returning n - cnt + 1 into start_n;

  return start_n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- สิทธิ์เรียกฟังก์ชัน: RPC ให้เฉพาะคนที่ล็อกอิน · ตัวช่วยภายใน ปิดไม่ให้เรียกตรง
-- (block_reason รับ user id จากภายนอก — เปิดไว้ = ใครก็ส่อง "เหตุผล" ตั๋วคนอื่นได้)
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function ryuma_market_block_reason(text, text, int) from public, anon, authenticated;
revoke all on function ryuma_market_std_deposit(text)             from public, anon, authenticated;
revoke all on function ryuma_market_active(text)                  from public, anon, authenticated;

revoke all on function ryuma_market_feed()                           from public, anon;
revoke all on function ryuma_market_list(text, int, numeric)         from public, anon;
revoke all on function ryuma_market_cancel(text)                     from public, anon;
revoke all on function ryuma_market_reserve(text)                    from public, anon;
revoke all on function ryuma_market_release(text)                    from public, anon;
revoke all on function ryuma_market_payout(text)                     from public, anon;
revoke all on function ryuma_market_pay(text, text)                  from public, anon;
revoke all on function ryuma_market_seller_confirm(text)             from public, anon;
revoke all on function ryuma_market_seller_reject(text, text, jsonb) from public, anon;
revoke all on function ryuma_market_escalate(text, text)             from public, anon;
revoke all on function ryuma_market_finalize(text, text)             from public, anon;
revoke all on function ryuma_market_admin_cancel(text, text)         from public, anon;

grant execute on function ryuma_market_feed()                           to authenticated;
grant execute on function ryuma_market_list(text, int, numeric)         to authenticated;
grant execute on function ryuma_market_cancel(text)                     to authenticated;
grant execute on function ryuma_market_reserve(text)                    to authenticated;
grant execute on function ryuma_market_release(text)                    to authenticated;
grant execute on function ryuma_market_payout(text)                     to authenticated;
grant execute on function ryuma_market_pay(text, text)                  to authenticated;
grant execute on function ryuma_market_seller_confirm(text)             to authenticated;
grant execute on function ryuma_market_seller_reject(text, text, jsonb) to authenticated;
grant execute on function ryuma_market_escalate(text, text)             to authenticated;
grant execute on function ryuma_market_finalize(text, text)             to authenticated;
grant execute on function ryuma_market_admin_cancel(text, text)         to authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- 1) คอลัมน์ใหม่ครบ:   select qty, hold_until, child_ticket_id from ticket_transfers limit 1;
--                      select split_from from preorder_tickets limit 1;
-- 2) RPC ครบ 12 ตัว:   select count(*) from pg_proc where proname like 'ryuma_market_%';   -- ได้ 17 (รวมตัวช่วย 5)
-- 3) policy ใหม่:      select policyname from pg_policies where tablename = 'ticket_transfers';  -- transfers_read, transfers_admin
