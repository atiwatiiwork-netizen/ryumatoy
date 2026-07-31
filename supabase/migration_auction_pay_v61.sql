-- ============================================================================
-- v61 (2026-07-31): ประมูล เฟส 2 — เส้นเงินผู้ชนะ + คำขอยกเลิกบิด + กัน push รัว
-- เพิ่มคอลัมน์อย่างเดียว ไม่แตะข้อมูลเดิม · รันซ้ำได้
-- ============================================================================

-- ผู้ชนะกด "ชำระเงิน" → ออเดอร์ปกติ (สลิป/อนุมัติ/ออกตั๋ว/จัดส่ง ใช้ท่อเดิมทั้งหมด)
-- ต้องผูก order ไว้กับห้อง เพื่อ (1) กันจ่ายซ้ำ (2) พออนุมัติสลิปแล้วปิดห้องเป็น 'paid' อัตโนมัติ
alter table auctions add column if not exists pay_order_id text;

-- กัน push "ราคาขยับ" ยิงรัวทุกบิด (ช่วงท้ายบิดกันนาทีละหลายครั้ง = คนปิดกระดิ่งถาวร)
alter table auctions add column if not exists last_price_push_at timestamptz;

-- ลูกค้าถอนบิดเองไม่ได้ (กติกาเจ้าของข้อ 19) — ส่งคำขอมาให้แอดมินอนุมัติ
alter table auction_bids add column if not exists cancel_requested_at timestamptz;
alter table auction_bids add column if not exists cancel_reason text;

-- คำขอยกเลิกบิด: ต้องผ่าน RPC เท่านั้น ห้ามเปิด policy UPDATE ให้ลูกค้าเขียนแถวบิดตรงๆ
-- (ถ้าเปิด เขาจะแก้ช่อง amount ของบิดตัวเองได้ = ปั่นราคาย้อนหลัง)
-- ตัวนี้แตะได้แค่ 2 ช่อง และเฉพาะบิดของตัวเองที่ยังไม่ถูกยกเลิก
drop function if exists ryuma_request_bid_cancel(text, text);
create or replace function ryuma_request_bid_cancel(p_bid_id text, p_reason text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid text; v_owner text; v_status text;
begin
  v_uid := app_user_id();
  if v_uid is null then return json_build_object('error', 'auth'); end if;
  select user_id, status into v_owner, v_status from auction_bids where id = p_bid_id;
  if v_owner is null then return json_build_object('error', 'not_found'); end if;
  if v_owner <> v_uid then return json_build_object('error', 'forbidden'); end if;
  if v_status <> 'active' then return json_build_object('error', 'not_active'); end if;
  update auction_bids
     set cancel_requested_at = now(), cancel_reason = left(coalesce(p_reason, ''), 200)
   where id = p_bid_id;
  return json_build_object('ok', true);
end $$;

grant execute on function ryuma_request_bid_cancel(text, text) to anon, authenticated;

-- ── เป้าหมาย push ที่ "ลูกค้าเป็นคนจุดชนวน" (โดนแซง / ราคาขยับ) ─────────────
-- ปัญหา: RLS ให้ลูกค้าอ่าน push_subscriptions ได้เฉพาะของตัวเอง → เครื่องคนที่โดนแซง
-- มองไม่เห็นจากเบราว์เซอร์ของคนที่บิด. จะเปิดให้ลูกค้าอ่าน endpoint คนอื่นก็ไม่ได้ (เอาไปยิง spam)
-- ทางออก: ฟังก์ชัน security definer ตัวนี้ถูกเรียกจาก **ฝั่งเซิร์ฟเวอร์ (/api/push-send)** เท่านั้น
-- endpoint จึงไม่เคยหลุดถึงเบราว์เซอร์ลูกค้า และข้อความก็ถูกประกอบที่นี่ (ลูกค้าแทรกข้อความไม่ได้)
--
-- สิทธิ์จุดชนวน: ต้องเป็น "ผู้นำราคาปัจจุบัน" ของห้องนั้นเท่านั้น (= คนที่เพิ่งบิดสำเร็จ)
-- กัน push รัว: kind='price' ยิงได้ไม่ถี่กว่า 5 นาที/ห้อง โดยจดเวลาไว้ในแถวเดียวกันแบบอะตอมมิก
drop function if exists ryuma_auction_push_targets(text, text);
create or replace function ryuma_auction_push_targets(p_auction_id text, p_kind text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  a auctions%rowtype;
  v_uid text;
  v_top text;
  v_prev text;
  v_users text[];
  v_title text;
  v_body text;
begin
  v_uid := app_user_id();
  if v_uid is null then return json_build_object('targets', '[]'::json); end if;

  select * into a from auctions where id = p_auction_id for update;
  if not found or a.status <> 'live' then return json_build_object('targets', '[]'::json); end if;

  -- ผู้นำราคาตอนนี้ต้องเป็นคนเรียก (คนที่เพิ่งบิดสำเร็จ) — คนอื่นจุดชนวนไม่ได้
  select b.user_id into v_top from auction_bids b
   where b.auction_id = p_auction_id and b.status = 'active'
   order by b.amount desc, b.created_at asc limit 1;
  if v_top is null or v_top <> v_uid then return json_build_object('targets', '[]'::json); end if;

  if p_kind = 'outbid' then
    -- คนที่เพิ่งถูกแซง = ผู้นำคนก่อนหน้า (คนละคนกับผู้เรียก)
    select b.user_id into v_prev from auction_bids b
     where b.auction_id = p_auction_id and b.status = 'active' and b.user_id <> v_uid
     order by b.amount desc, b.created_at asc limit 1;
    if v_prev is null then return json_build_object('targets', '[]'::json); end if;
    v_users := array[v_prev];
    v_title := '⚡ มีคนบิดแซงคุณแล้ว';
    v_body  := a.title || ' — ราคาตอนนี้ ' || to_char(a.current_price, 'FM999,999') || ' บาท';

  elsif p_kind = 'price' then
    -- กระดิ่ง + คนที่เคยบิด (ยกเว้นผู้เรียก) · ไม่ถี่กว่า 5 นาที/ห้อง
    if a.last_price_push_at is not null and a.last_price_push_at > now() - interval '5 minutes' then
      return json_build_object('targets', '[]'::json);
    end if;
    update auctions set last_price_push_at = now() where id = p_auction_id;
    select coalesce(array_agg(distinct u), '{}') into v_users from (
      select w.user_id as u from auction_watch w where w.auction_id = p_auction_id
      union
      select b.user_id from auction_bids b where b.auction_id = p_auction_id and b.status = 'active'
    ) s where u <> v_uid;
    v_title := '🔔 ราคาประมูลขยับแล้ว';
    v_body  := a.title || ' — ตอนนี้ ' || to_char(a.current_price, 'FM999,999') || ' บาท';
  else
    return json_build_object('targets', '[]'::json);
  end if;

  if v_users is null or array_length(v_users, 1) is null then
    return json_build_object('targets', '[]'::json);
  end if;

  return json_build_object(
    'title', v_title,
    'body', v_body,
    'url', '/auctions/' || a.id,
    'targets', coalesce((
      select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
        from push_subscriptions s where s.user_id = any(v_users)
    ), '[]'::json));
end $$;

grant execute on function ryuma_auction_push_targets(text, text) to anon, authenticated;

-- ── ตรวจหลังรัน: ต้องได้ 4 แถว ──────────────────────────────────────────────
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in
       (('auctions','pay_order_id'), ('auctions','last_price_push_at'),
        ('auction_bids','cancel_requested_at'), ('auction_bids','cancel_reason'))
 order by table_name, column_name;
