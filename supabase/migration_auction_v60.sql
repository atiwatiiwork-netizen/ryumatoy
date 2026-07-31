-- ============================================================================
-- v60 (2026-07-31): ระบบประมูล (auction) — สเปกที่เจ้าของเคาะครบ 20 ข้อ
--
-- กติกาที่ฝัง "ฝั่ง server" ทั้งหมด (ห้ามตัดสินที่เครื่องลูกค้า):
--   · ราคาเปิด 1,000 (ตั้งต่อรายการ) · บิดต้องลงท้ายด้วย 0 และ >= ราคาปัจจุบัน + ขั้นบันได
--   · บันไดขั้น: <3,000 = +20 · 3,000–4,999 = +50 · 5,000–9,999 = +100 · 10,000+ = +200
--   · ต่อเวลาสะสม: บิดในช่วง 30 นาทีสุดท้าย → ends_at = max(ends_at, now) + 5 นาที
--     เพดาน = เวลาปิดเดิม + 60 นาที
--   · สิทธิ์บิด = มีใบพรีที่ "ของยังไม่ถึงมือ" หรือ จ่ายเข้าสนาม 300 ที่แอดมินอนุมัติแล้ว
--   · ชนะค้างจ่ายพร้อมกันได้สูงสุด 2 รายการ/คน
--
-- ⚠ ทำไมต้องเป็น RPC: store ของแอปเป็น optimistic client store — สองคนกดบิดวินาทีเดียวกัน
--   จะเขียนทับกันเงียบๆ (เคสเดียวกับ "ขายเกิน") การประมูลจึงต้องตัดสินในทรานแซกชันเดียว
--   ที่ล็อกแถวประมูลไว้ก่อนเสมอ
-- ⚠ authz (บทเรียน v59): ห้ามเชื่อ user id ที่ส่งมาจาก client — ใช้ app_user_id() เท่านั้น
-- idempotent: รันซ้ำได้
-- ============================================================================

-- ── ตาราง ───────────────────────────────────────────────────────────────────
create table if not exists auctions (
  id               text primary key,
  product_id       text references products(id) on delete set null,
  title            text not null,
  images           jsonb not null default '[]'::jsonb,
  detail           text,
  start_price      int  not null default 1000,
  buy_now_price    int,
  ends_at          timestamptz not null,
  original_ends_at timestamptz not null,
  extend_min       int  not null default 5,   -- ต่อครั้งละกี่นาที
  window_min       int  not null default 30,  -- เริ่มต่อเวลาเมื่อเหลือกี่นาที
  cap_min          int  not null default 60,  -- ต่อได้ไม่เกินกี่นาทีจากเวลาปิดเดิม
  status           text not null default 'draft',  -- draft|live|ended|awarded|paid|cancelled
  current_price    int  not null default 0,
  bid_count        int  not null default 0,
  extend_count     int  not null default 0,
  winner_user_id   text references users(id),
  winning_amount   int,
  runner_up_user_id text references users(id),
  runner_up_amount int,
  pay_due_at       timestamptz,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

create table if not exists auction_bids (
  id          text primary key,
  auction_id  text not null references auctions(id) on delete cascade,
  user_id     text not null references users(id),
  amount      int  not null,
  status      text not null default 'active',   -- active | void
  void_reason text,
  created_at  timestamptz not null default now()
);
create index if not exists auction_bids_auction_idx on auction_bids(auction_id, amount desc);

-- กระดิ่งรายชิ้น. ใช้ id เป็น PK (ไม่ใช่ composite) เพราะ syncTable ฝั่งแอปเทียบด้วยคีย์เดียว
create table if not exists auction_watch (
  id         text primary key,
  auction_id text not null references auctions(id) on delete cascade,
  user_id    text not null references users(id),
  created_at timestamptz not null default now(),
  unique (auction_id, user_id)
);

-- มัดจำเข้าสนาม ฿300 (เจ้าของ: "ไม่ใช่กินเปล่า" — เอาสลิปใบเดิมไปแปะเป็นมัดจำพรีรายการอื่นได้)
-- ⚠ ต้องจดไว้ ไม่งั้นเงินก้อนนี้ถูกนับสองรอบ: รอบแรกตอนรับ 300 รอบสองตอนอนุมัติออเดอร์พรีที่ใช้สลิปใบเดิม
create table if not exists auction_entries (
  id          text primary key,
  user_id     text not null references users(id),
  amount      int  not null default 300,
  kind        text not null default 'slip',    -- slip = โอนจริง | admin = แอดมินปลดล็อกให้
  slip_url    text,
  note        text,
  status      text not null default 'pending', -- pending|approved|rejected|used
  order_id    text,
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  used_at     timestamptz
);

-- ── ขั้นบันไดการบิด ─────────────────────────────────────────────────────────
create or replace function ryuma_bid_step(p_price int)
returns int language sql immutable as $$
  select case
    when p_price >= 10000 then 200
    when p_price >=  5000 then 100
    when p_price >=  3000 then  50
    else 20
  end;
$$;

-- ── สิทธิ์เข้าประมูล ────────────────────────────────────────────────────────
-- (ก) มีใบพรีที่ของยังไม่ถึงมือ  หรือ  (ข) จ่ายเข้าสนามแล้ว/แอดมินปลดล็อกให้
create or replace function ryuma_can_bid(p_user_id text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from preorder_tickets t
    left join products p on p.id = t.product_id
    where t.owner_id = p_user_id
      and coalesce(t.status, '') <> 'shipped'
      and coalesce(t.product_status, '') <> 'delivered'
      -- ซื้อของพร้อมส่งล้วน (ไม่มีรอบ + จ่ายครบ) ไม่นับว่าเป็นใบพรี
      and not (coalesce(p.is_stock, false) and coalesce(t.remaining_amount, 0) = 0 and coalesce(t.batch_id, '') = '')
  ) or exists (
    select 1 from auction_entries e where e.user_id = p_user_id and e.status in ('approved', 'used')
  );
$$;

-- ── บิด ─────────────────────────────────────────────────────────────────────
create or replace function ryuma_place_bid(p_auction_id text, p_amount int)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  a auctions%rowtype;
  v_uid text;
  v_min int;
  v_step int;
  v_cap timestamptz;
  v_new_end timestamptz;
  v_extended boolean := false;
  v_open_wins int;
begin
  v_uid := app_user_id();
  if v_uid is null then return json_build_object('error', 'auth'); end if;

  -- ล็อกแถวก่อนอ่านค่า: กันสองคนบิดวินาทีเดียวกันแล้วทับกัน
  select * into a from auctions where id = p_auction_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'live' then return json_build_object('error', 'not_live'); end if;
  if now() >= a.ends_at then return json_build_object('error', 'ended'); end if;

  if not ryuma_can_bid(v_uid) then return json_build_object('error', 'no_right'); end if;

  -- เพดานชนะค้างจ่าย 2 รายการ/คน
  select count(*) into v_open_wins from auctions
    where winner_user_id = v_uid and status in ('ended', 'awarded');
  if v_open_wins >= 2 then return json_build_object('error', 'too_many_wins'); end if;

  v_min := case when a.bid_count = 0 then a.start_price
                else a.current_price + ryuma_bid_step(a.current_price) end;
  if p_amount % 10 <> 0 then
    return json_build_object('error', 'not_round', 'min', v_min);
  end if;
  if p_amount < v_min then
    return json_build_object('error', 'too_low', 'min', v_min, 'price', a.current_price);
  end if;

  insert into auction_bids (id, auction_id, user_id, amount)
    values ('ab-' || replace(gen_random_uuid()::text, '-', ''), p_auction_id, v_uid, p_amount);

  -- ต่อเวลาแบบสะสม: ทุกบิดในช่วง window นาทีสุดท้าย บวกอีก extend นาที (เพดานจากเวลาปิดเดิม)
  v_new_end := a.ends_at;
  if now() >= a.ends_at - make_interval(mins => a.window_min) then
    v_cap := a.original_ends_at + make_interval(mins => a.cap_min);
    v_new_end := greatest(a.ends_at, now()) + make_interval(mins => a.extend_min);
    if v_new_end > v_cap then v_new_end := v_cap; end if;
    v_extended := v_new_end > a.ends_at;
  end if;

  update auctions set
    current_price = p_amount,
    bid_count     = bid_count + 1,
    ends_at       = v_new_end,
    extend_count  = extend_count + (case when v_extended then 1 else 0 end)
  where id = p_auction_id;

  return json_build_object(
    'ok', true, 'price', p_amount, 'ends_at', v_new_end, 'extended', v_extended,
    'bid_count', a.bid_count + 1, 'next_min', p_amount + ryuma_bid_step(p_amount),
    'server_now', now());
end $$;

-- ── ซื้อเลย (ปิดทันที) ──────────────────────────────────────────────────────
create or replace function ryuma_auction_buynow(p_auction_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare a auctions%rowtype; v_uid text; v_open_wins int; v_runner record;
begin
  v_uid := app_user_id();
  if v_uid is null then return json_build_object('error', 'auth'); end if;

  select * into a from auctions where id = p_auction_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'live' then return json_build_object('error', 'not_live'); end if;
  if now() >= a.ends_at then return json_build_object('error', 'ended'); end if;
  if a.buy_now_price is null then return json_build_object('error', 'no_buynow'); end if;
  if a.current_price >= a.buy_now_price then return json_build_object('error', 'price_passed'); end if;
  if not ryuma_can_bid(v_uid) then return json_build_object('error', 'no_right'); end if;

  select count(*) into v_open_wins from auctions
    where winner_user_id = v_uid and status in ('ended', 'awarded');
  if v_open_wins >= 2 then return json_build_object('error', 'too_many_wins'); end if;

  insert into auction_bids (id, auction_id, user_id, amount)
    values ('ab-' || replace(gen_random_uuid()::text, '-', ''), p_auction_id, v_uid, a.buy_now_price);

  -- อันดับ 2 = บิดสูงสุดของคนอื่น (กติกา "2 อันดับแรกมีสิทธิ์")
  select b.user_id, max(b.amount) as amount into v_runner
    from auction_bids b
   where b.auction_id = p_auction_id and b.status = 'active' and b.user_id <> v_uid
   group by b.user_id order by 2 desc limit 1;

  update auctions set
    status = 'ended', current_price = a.buy_now_price, bid_count = bid_count + 1,
    ends_at = now(), closed_at = now(),
    winner_user_id = v_uid, winning_amount = a.buy_now_price,
    runner_up_user_id = v_runner.user_id, runner_up_amount = v_runner.amount,
    pay_due_at = now() + interval '24 hours'
  where id = p_auction_id;

  return json_build_object('ok', true, 'price', a.buy_now_price, 'won', true, 'server_now', now());
end $$;

-- ── ปิดประมูล + สรุปผล (แอดมินกด หรือ cron เรียกทีหลัง) ─────────────────────
create or replace function ryuma_auction_close(p_auction_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare a auctions%rowtype; v_win record; v_runner record;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if a.status <> 'live' then return json_build_object('error', 'not_live'); end if;
  if now() < a.ends_at and not is_app_admin() then return json_build_object('error', 'not_yet'); end if;

  select b.user_id, max(b.amount) as amount into v_win
    from auction_bids b where b.auction_id = p_auction_id and b.status = 'active'
    group by b.user_id order by 2 desc limit 1;

  if v_win.user_id is null then
    update auctions set status = 'ended', closed_at = now() where id = p_auction_id;
    return json_build_object('ok', true, 'winner', null);
  end if;

  select b.user_id, max(b.amount) as amount into v_runner
    from auction_bids b
   where b.auction_id = p_auction_id and b.status = 'active' and b.user_id <> v_win.user_id
   group by b.user_id order by 2 desc limit 1;

  update auctions set
    status = 'ended', closed_at = now(),
    winner_user_id = v_win.user_id, winning_amount = v_win.amount,
    runner_up_user_id = v_runner.user_id, runner_up_amount = v_runner.amount,
    pay_due_at = now() + interval '24 hours'
  where id = p_auction_id;

  return json_build_object('ok', true, 'winner', v_win.user_id, 'amount', v_win.amount);
end $$;

-- ── สถานะสด (หน้าห้องประมูลเรียกทุก 4 วิ — ถูกกว่าโหลดทั้งตาราง) ────────────
create or replace function ryuma_auction_state(p_auction_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare a auctions%rowtype; v_uid text; v_top text;
begin
  select * into a from auctions where id = p_auction_id;
  if not found then return json_build_object('error', 'not_found'); end if;
  v_uid := app_user_id();
  select b.user_id into v_top from auction_bids b
    where b.auction_id = p_auction_id and b.status = 'active'
    order by b.amount desc, b.created_at asc limit 1;
  return json_build_object(
    'ok', true, 'price', a.current_price, 'bid_count', a.bid_count, 'ends_at', a.ends_at,
    'status', a.status, 'extend_count', a.extend_count, 'server_now', now(),
    'leading', (v_top is not null and v_top = v_uid),
    'next_min', case when a.bid_count = 0 then a.start_price
                     else a.current_price + ryuma_bid_step(a.current_price) end);
end $$;

-- ── ประวัติบิดแบบ "ปิดชื่อ" (เจ้าของ: ลูกค้าเห็นครบทุกบรรทัดแต่ไม่เห็นชื่อ) ──
-- ห้ามให้ client อ่าน auction_bids ตรงๆ ไม่งั้นเปิด devtools ก็เห็น user_id ทั้งตาราง
create or replace function ryuma_auction_bids(p_auction_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid text; v_admin boolean;
begin
  v_uid := app_user_id();
  v_admin := coalesce(is_app_admin(), false);
  return coalesce((
    select json_agg(row_to_json(x) order by x.created_at desc) from (
      select b.id, b.amount, b.created_at, b.status,
             dense_rank() over (order by first_at.t) as seq,
             (b.user_id = v_uid) as mine,
             case when v_admin then u.display_name else null end as name,
             case when v_admin then u.member_code  else null end as member_code
        from auction_bids b
        join users u on u.id = b.user_id
        join lateral (select min(b2.created_at) as t from auction_bids b2
                       where b2.auction_id = b.auction_id and b2.user_id = b.user_id) first_at on true
       where b.auction_id = p_auction_id
    ) x
  ), '[]'::json);
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table auctions        enable row level security;
alter table auction_bids    enable row level security;
alter table auction_watch   enable row level security;
alter table auction_entries enable row level security;

drop policy if exists auctions_read on auctions;
create policy auctions_read on auctions for select using (is_app_approved());
drop policy if exists auctions_admin on auctions;
create policy auctions_admin on auctions for all using (is_app_admin()) with check (is_app_admin());

-- บิด: ลูกค้าเห็นเฉพาะของตัวเอง (ประวัติสาธารณะไปทาง RPC ที่ปิดชื่อแล้ว) · เขียนได้ทาง RPC เท่านั้น
drop policy if exists auction_bids_own on auction_bids;
create policy auction_bids_own on auction_bids for select using (user_id = app_user_id() or is_app_admin());
drop policy if exists auction_bids_admin on auction_bids;
create policy auction_bids_admin on auction_bids for all using (is_app_admin()) with check (is_app_admin());

drop policy if exists auction_watch_own on auction_watch;
create policy auction_watch_own on auction_watch for all
  using (user_id = app_user_id() or is_app_admin()) with check (user_id = app_user_id() or is_app_admin());

drop policy if exists auction_entries_own on auction_entries;
create policy auction_entries_own on auction_entries for select using (user_id = app_user_id() or is_app_admin());
drop policy if exists auction_entries_insert on auction_entries;
create policy auction_entries_insert on auction_entries for insert with check (user_id = app_user_id());
drop policy if exists auction_entries_admin on auction_entries;
create policy auction_entries_admin on auction_entries for all using (is_app_admin()) with check (is_app_admin());

grant execute on function ryuma_bid_step(int)             to anon, authenticated;
grant execute on function ryuma_can_bid(text)             to anon, authenticated;
grant execute on function ryuma_place_bid(text, int)      to anon, authenticated;
grant execute on function ryuma_auction_buynow(text)      to anon, authenticated;
grant execute on function ryuma_auction_close(text)       to anon, authenticated;
grant execute on function ryuma_auction_state(text)       to anon, authenticated;
grant execute on function ryuma_auction_bids(text)        to anon, authenticated;
