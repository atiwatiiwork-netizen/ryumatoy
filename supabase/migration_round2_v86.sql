-- ============================================================================
-- Ryuma — v86: รอบ 2 ของ audit 2026-10-12 — รูรั่วที่กระทบร้านอยู่แล้ว (ไม่เกี่ยวกับสวิตช์ตลาด)
-- รันไฟล์นี้ไฟล์เดียว · รันซ้ำได้ (ทุกตัวเป็น create or replace / drop if exists) · ไม่แก้ข้อมูลเดิม
--
--   1) รายการในออเดอร์ (order_items): ลูกค้าตั้งราคา/มัดจำเองไม่ได้อีก (M02 · วิกฤต)
--      เดิม: ลูกค้ายิงตรงใส่ราคา 1,000 ให้ของ 4,000 → แอดมินอนุมัติ → ได้ตั๋ว "จ่ายครบ" ปลอม
--      ตอนนี้: ฐานข้อมูลเทียบกับราคาร้าน + มัดจำตามยศ (สูตรเดียวกับ livePrice + lineDepositForRank ในแอป)
--      ต่ำกว่าที่ต้องจ่าย = ปรับขึ้นเป็นของร้าน (ยอดออเดอร์จะไม่ตรง → อนุมัติไม่ได้) · เพิ่มรายการได้เฉพาะออเดอร์รอตรวจ · หลังสร้างแก้ราคาไม่ได้
--      ตั๋วของออเดอร์ที่ยังไม่อนุมัติ ออกไม่ได้แม้แอดมิน · แต้มปิดใบต้องมีตั๋วจริง
--   2) อนุมัติออเดอร์: ยอดออเดอร์ต้องตรงกับมัดจำของรายการ ±1 บาท (หักคูปอง/แต้มได้เฉพาะของพร้อมส่ง) · ไม่มีรายการ = อนุมัติไม่ได้ — ใช้กับแอดมินด้วย
--   3) คลังรูป logos: ลูกค้าดู "รายชื่อไฟล์" ได้เฉพาะไฟล์ของตัวเอง (M06) · รูปยังเปิดด้วยลิงก์สาธารณะได้ตามเดิม
--   4) reserve_ticket_nos: คนไม่ล็อกอินเรียกไม่ได้ · ลูกค้าต้องอนุมัติแล้ว · ไม่เกิน 50/ครั้ง และดันตัวนับนำหน้าตั๋วจริงไม่เกิน 200 (M13)
--   5) ryuma_link_auth: ต้องยืนยัน PIN + ต้องเป็นบัญชีของเบอร์นั้นเอง (M39 · เดิมคนไม่ล็อกอินผูกบัญชีคนอื่นได้)
--   6) ryuma_schema_check: เพิ่มแถว v86 (ต้องได้ 32/32)
--   เทสต์: npm run audit:sql (round2-audit)
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) guard order_items (ทับ v65)
--    ราคา/มัดจำที่ "ต่ำกว่าร้านตอนนี้" ไม่ปฏิเสธ แต่ "ปรับขึ้นเป็นค่าของร้าน" — เพราะหัวออเดอร์ถูกบันทึกไปก่อนแล้ว
--    (adapter เขียน orders → order_items คนละคำขอ) ถ้าปฏิเสธจะเหลือออเดอร์ครึ่งๆ กลางๆ (คูปองถูกใช้/แต้มถูกกัน/สลิปแนบแล้ว)
--    → ยอดออเดอร์จะไม่ตรงกับรายการ แล้วด่านอนุมัติ (ข้อ 2) จะไม่ให้อนุมัติจนกว่าแอดมินจัดการ
--    ราคาเปลี่ยนระหว่างลูกค้ากำลังจ่าย (ร้านขึ้นราคา/ปรับยศ) ก็ไปจบที่ด่านอนุมัติแบบเดียวกัน ไม่ใช่ออเดอร์หาย
--    ปฏิเสธเฉพาะสิ่งที่แอปปกติไม่มีวันส่ง: ออเดอร์คนอื่น/ออเดอร์ที่ไม่ใช่ "รอตรวจ" · จำนวน < 1 · สินค้าไม่มี · แบบ/รอบที่ไม่ใช่ของสินค้านี้ · รอบที่ยังไม่เปิดขาย
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_order_items()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner text; v_status text; v_p products%rowtype; v_price numeric; v_dep numeric; v_need numeric; v_rank text; v_pct numeric;
        v_b_status text; v_b_pub boolean; v_vprod text; v_auction boolean := false;
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
    if exists (select 1 from order_items i where i.id = new.id) then return new; end if;
    select o.user_id, o.status into v_owner, v_status from orders o where o.id = new.order_id;
    if v_owner is distinct from app_user_id() then
      raise exception 'ryuma: เพิ่มรายการในออเดอร์คนอื่นไม่ได้';
    end if;
    -- เพิ่มรายการได้เฉพาะออเดอร์ที่ยัง "รอตรวจ" (กันเพิ่มของเข้าออเดอร์ที่อนุมัติแล้ว แล้วออกตั๋วเองผ่าน self-heal)
    if v_status is distinct from 'pending_approval' then
      raise exception 'ryuma: ออเดอร์นี้ปิดแล้ว เพิ่มรายการไม่ได้';
    end if;
    if coalesce(new.qty, 0) < 1 then raise exception 'ryuma: จำนวนสินค้าไม่ถูกต้อง'; end if;
    select * into v_p from products where id = new.product_id;
    if not found then raise exception 'ryuma: ไม่พบสินค้านี้แล้ว — รีเฟรชหน้าแล้วสั่งใหม่'; end if;

    -- ราคาร้าน ณ ตอนนี้ (สูตรเดียวกับ livePrice): รอบพิเศษ → แบบ → สินค้า
    if new.batch_id is not null then
      select b.price_total, b.deposit_amount, b.status, b.published into v_price, v_dep, v_b_status, v_b_pub
        from product_batches b where b.id = new.batch_id and b.product_id = new.product_id;
      if not found then raise exception 'ryuma: รอบนี้ไม่ใช่ของสินค้านี้ — รีเฟรชหน้าแล้วสั่งใหม่'; end if;
      -- รอบที่ยังเป็นร่าง/ปิดแล้ว (ราคาเก่า/ราคาตกลงกับลูกค้าเดิม) — แอปปกติไม่ส่ง (submitOrder ต้อง open + published)
      if v_b_status is distinct from 'open' or v_b_pub is false then
        raise exception 'ryuma: รอบนี้ปิดรับแล้ว/ยังไม่เปิดขาย — รีเฟรชหน้าแล้วสั่งใหม่';
      end if;
    else
      if new.variant_id is not null then
        select v.price_total, v.deposit_amount, v.product_id into v_price, v_dep, v_vprod from product_variants v where v.id = new.variant_id;
        if found and v_vprod is distinct from new.product_id then
          raise exception 'ryuma: แบบนี้ไม่ใช่ของสินค้านี้ — รีเฟรชหน้าแล้วสั่งใหม่';
        end if;
      end if;
      if v_price is null then v_price := v_p.price_total; v_dep := v_p.deposit_amount; end if;
    end if;
    v_price := coalesce(v_price, 0);
    v_dep := coalesce(v_dep, 0);

    -- มัดจำที่ต้องจ่ายต่อชิ้น (สูตรเดียวกับ lineDepositForRank): จ่ายเต็ม (ของพร้อมส่ง / มัดจำ ≥ ราคา) = ราคาเต็ม
    --   พรี = มัดจำ × % ตามยศ (Gold = ตั้งค่าร้าน · Diamond/Legend = 0 · อื่นๆ = 100) ปัดเป็นบาท
    if coalesce(v_p.is_stock, false) or v_dep >= v_price then
      v_need := v_price;
    else
      v_rank := coalesce((select u.rank from users u where u.id = app_user_id()), 'bronze');
      v_pct := case when v_rank = 'gold' then coalesce((select s.rank_gold_deposit_pct from shop_settings s where s.id = 'default'), 50)
                    when v_rank in ('diamond', 'legend') then 0
                    else 100 end;
      v_need := round(v_dep * v_pct / 100);
    end if;

    -- ประมูลที่ชนะ: จ่ายเต็มจำนวนตามยอดที่ชนะ ชิ้นเดียว (livePrice ใช้ราคาประมูลเฉพาะบรรทัดของห้องนั้น)
    if new.qty = 1 and new.unit_price is not null and new.unit_price < v_price and new.unit_deposit >= new.unit_price
       and exists (select 1 from auctions a
                    where a.winner_user_id = app_user_id() and a.product_id = new.product_id
                      and a.status in ('ended', 'awarded') and (a.pay_order_id is null or a.pay_order_id = new.order_id)
                      and a.winning_amount is not null and new.unit_price >= a.winning_amount) then
      v_auction := true;
    end if;

    if not v_auction then
      -- ต่ำกว่าร้าน → ปรับขึ้นเป็นของร้าน (ไม่ปฏิเสธ — ดูหัวข้อ) · จ่ายมากกว่าได้ ไม่เสียหาย
      new.unit_price := greatest(coalesce(new.unit_price, 0), v_price);
      new.unit_deposit := greatest(coalesce(new.unit_deposit, 0), v_need);
      if new.unit_deposit > new.unit_price then new.unit_deposit := new.unit_price; end if;
    end if;
    new.deposit_amount := new.unit_deposit * new.qty;
    return new;
  end if;

  -- UPDATE ของลูกค้า: แก้ได้แค่ลดจำนวน (ยกเลิกบางชิ้น) · ราคา/มัดจำ/สินค้า ล็อก
  new.product_id     := old.product_id;
  new.variant_id     := old.variant_id;
  new.order_id       := old.order_id;
  new.deposit_amount := old.deposit_amount;
  new.unit_price     := old.unit_price;
  new.unit_deposit   := old.unit_deposit;
  new.batch_id       := old.batch_id;
  new.qty            := least(coalesce(new.qty, old.qty), old.qty);
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) อนุมัติออเดอร์: ยอดออเดอร์ต้อง "ตรง" กับมัดจำของรายการ (±1 บาท) — ใช้กับแอดมินด้วย
--    ยอดที่ถูก = มัดจำพรี + max(0, ยอดพร้อมส่ง − คูปอง − แต้ม) (คูปอง/แต้มใช้ได้กับของพร้อมส่งเท่านั้น เหมือน submitOrder)
--    ต่ำกว่า = ออเดอร์ถูกแก้ตัวเลข / ราคาเปลี่ยนระหว่างสั่ง (ข้อ 1 ปรับรายการขึ้น) · สูงกว่า = รายการไม่ครบ (บันทึกไม่หมด)
--    ไม่มีรายการเลย = อนุมัติไม่ได้
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_orders_approve_check()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pre numeric; v_stock numeric; v_min numeric; v_n int;
begin
  if current_setting('ryuma.trusted', true) = 'on' then return new; end if;
  if new.status is distinct from 'approved' or old.status is not distinct from 'approved' then return new; end if;
  select coalesce(sum(case when coalesce(p.is_stock, false) then 0 else coalesce(i.deposit_amount, 0) end), 0),
         coalesce(sum(case when coalesce(p.is_stock, false) then coalesce(i.deposit_amount, 0) else 0 end), 0),
         count(*) filter (where coalesce(i.qty, 0) > 0)
    into v_pre, v_stock, v_n
    from order_items i left join products p on p.id = i.product_id
   where i.order_id = new.id;
  if v_n = 0 then
    raise exception 'ryuma: ออเดอร์นี้ไม่มีรายการสินค้า (บันทึกไม่ครบ) — อนุมัติไม่ได้ ให้ปฏิเสธแล้วให้ลูกค้าสั่งใหม่';
  end if;
  v_min := v_pre + greatest(0, v_stock - coalesce(new.coupon_discount, 0) - coalesce(new.points_redeemed, 0));
  if coalesce(new.total_deposit, 0) + 1 < v_min then
    raise exception 'ryuma: ยอดออเดอร์ % บาท ต่ำกว่ามัดจำของรายการ % บาท (ราคาเปลี่ยนระหว่างสั่ง หรือออเดอร์ถูกแก้ตัวเลข) — อนุมัติไม่ได้', coalesce(new.total_deposit, 0), v_min;
  end if;
  if coalesce(new.total_deposit, 0) - 1 > v_min then
    raise exception 'ryuma: ยอดออเดอร์ % บาท มากกว่ามัดจำของรายการ % บาท (รายการบันทึกไม่ครบ) — อนุมัติไม่ได้ ตรวจรายการก่อน', coalesce(new.total_deposit, 0), v_min;
  end if;
  return new;
end $$;

drop trigger if exists ryuma_orders_approve_check on orders;
create trigger ryuma_orders_approve_check before update on orders
  for each row execute function ryuma_orders_approve_check();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b) guard ตั๋ว (ทับ v85 · ตัวเดียวกันทุกบรรทัด) + ตั๋วของออเดอร์ที่ยังไม่อนุมัติ ออกไม่ได้แม้แอดมิน
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_oi order_items%rowtype; v_p products%rowtype; v_unit_price numeric; v_unit_dep numeric;
begin
  if current_setting('ryuma.market_rpc', true) = 'on' then return new; end if;

  if is_app_admin() then
    if TG_OP = 'INSERT' then
      -- (v86) ตั๋วของรายการในออเดอร์ (id t-<item>) ออกได้เมื่อออเดอร์ "อนุมัติแล้ว" เท่านั้น — แม้แอดมิน
      --   เดิม: ด่านอนุมัติปฏิเสธสถานะออเดอร์ แต่ adapter เขียนตั๋วต่อ (เขียนทุกตาราง) → ตั๋วหลุดเข้ากระเป๋าทั้งที่ออเดอร์ไม่ผ่าน
      --   adapter เขียน orders ก่อน preorder_tickets เสมอ → การอนุมัติปกติ สถานะเป็น approved แล้วตอนตั๋วมาถึง
      if exists (select 1 from order_items i join orders o on o.id = i.order_id
                  where 't-' || i.id = new.id and o.status is distinct from 'approved') then
        raise exception 'ryuma: ออเดอร์ของตั๋ว % ยังไม่ได้อนุมัติ — ออกตั๋วไม่ได้', coalesce(new.ticket_no, new.id);
      end if;
      return new;
    end if;
    -- (a) โครงสร้างของตั๋วที่เคยผ่านตลาด: เปลี่ยนผ่านการเขียนตารางไม่ได้ (ทางเดียวคือไฟนอล) — เก็บค่าเดิมเงียบๆ
    --     กันหน้าจอเก่าเขียนเจ้าของ/เลขตั๋ว/จำนวนชิ้นกลับเป็นของคนขาย (audit R2A-01)
    if ryuma_ticket_market_history(old.id, old.split_from) then
      new.id                := old.id;
      new.owner_id          := old.owner_id;
      new.original_buyer_id := old.original_buyer_id;
      new.ticket_no         := old.ticket_no;
      new.split_from        := old.split_from;
      new.qty               := old.qty;
      new.product_id        := old.product_id;
      new.variant_id        := old.variant_id;
      new.batch_id          := old.batch_id;
    end if;
    -- (b) เลขรุ่นไม่ตรง = หน้าจอโหลดก่อนไฟนอล → ห้ามแก้เงิน/สถานะ/วิธีรับของ (audit R2A-01 แตกขาย, R2A-02)
    if new.market_rev is distinct from old.market_rev then
      if row(new.deposit_paid, new.remaining_amount, new.remaining_paid, new.status, new.delivery)
         is distinct from row(old.deposit_paid, old.remaining_amount, old.remaining_paid, old.status, old.delivery) then
        raise exception 'ryuma: ตั๋ว % เปลี่ยนมือหรือแตกขายไปแล้ว — รีเฟรชหน้าก่อนแก้', old.ticket_no;
      end if;
      new.market_rev := old.market_rev;
    end if;
    -- (c) ดีลค้างอยู่ → แอดมินก็แก้เงิน/สถานะ/วิธีรับของไม่ได้ (ผู้ซื้อตกลงตามยอดใน snapshot แล้ว · audit R2B-01)
    if ryuma_market_active(old.id)
       and row(new.deposit_paid, new.remaining_amount, new.remaining_paid, new.status, new.delivery)
           is distinct from row(old.deposit_paid, old.remaining_amount, old.remaining_paid, old.status, old.delivery) then
      raise exception 'ryuma: ตั๋ว % อยู่ระหว่างซื้อขาย/เปลี่ยนใบ — ยกเลิกดีลก่อนแก้เงินหรือสถานะ', old.ticket_no;
    end if;
    -- (d) ตั๋วที่เปลี่ยนมือแล้ว: แก้มัดจำไม่ได้ (เงินจะไม่ลงบัญชีใครเลย · audit R3-16)
    if new.deposit_paid is distinct from old.deposit_paid and ryuma_ticket_transferred(old.id, old.split_from) then
      raise exception 'ryuma: ตั๋ว % เปลี่ยนมือแล้ว แก้มัดจำไม่ได้', old.ticket_no;
    end if;
    -- (e) ตั๋วที่เปลี่ยนมือแล้ว: ยอดเต็มขึ้นไม่ได้ (หน้าจอแอปรุ่นเก่าที่ไม่ส่งเลขรุ่น เขียนยอดก่อนแตกขายกลับให้ใบแม่ · review รอบ A)
    --     ยอดลดลงได้ (คูปอง/แต้ม) · จ่ายเพิ่มได้ (อนุมัติสลิป)
    if new.remaining_amount > old.remaining_amount and ryuma_ticket_transferred(old.id, old.split_from) then
      raise exception 'ryuma: ตั๋ว % เปลี่ยนมือแล้ว เพิ่มยอดค้างไม่ได้ — รีเฟรชหน้าก่อนแก้', old.ticket_no;
    end if;
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if exists (select 1 from preorder_tickets t where t.id = new.id) then return new; end if;
    -- ลูกค้าออกตั๋วเองได้ทางเดียว = self-heal ตั๋วที่หายของรายการในออเดอร์ตัวเองที่อนุมัติแล้ว (id t-<item>)
    -- ค่าเงิน/สถานะ/คนจ่าย คำนวณที่นี่ทั้งหมด ไม่เชื่อค่าจากเครื่องลูกค้า (review รอบ A: เดิมลูกค้าตั้งยอดค้าง 0 + 'ถึงไทย' เองได้
    -- และออกตั๋วซ้ำให้รายการที่ขายไปแล้วได้ ถ้าตั๋วเดิมเป็น id รุ่นเก่า)
    select oi.* into v_oi from order_items oi join orders o on o.id = oi.order_id
     where 't-' || oi.id = new.id and o.user_id = app_user_id() and o.status = 'approved' and oi.product_id = new.product_id;
    if not found then
      raise exception 'ryuma: ออกตั๋วเองไม่ได้ (ต้องมาจากออเดอร์ที่อนุมัติแล้วเท่านั้น)';
    end if;
    if coalesce(v_oi.qty, 0) <= 0 then raise exception 'ryuma: รายการนี้ถูกยกเลิกแล้ว ออกตั๋วไม่ได้'; end if;
    if exists (select 1 from ticket_transfers tr where tr.order_item_id = v_oi.id) then
      raise exception 'ryuma: ตั๋วของรายการนี้เคยซื้อขาย/เปลี่ยนใบแล้ว ออกตั๋วใหม่ไม่ได้';
    end if;
    -- ตั๋วรุ่นเก่า (id ไม่ผูกรายการ): ถ้าจำนวนตั๋วของคนจ่าย (ไม่นับตั๋วลูก) ครบจำนวนรายการแล้ว = ไม่ได้หาย
    if (select count(*) from preorder_tickets x
         where coalesce(x.original_buyer_id, x.owner_id) = app_user_id() and x.split_from is null
           and x.product_id = v_oi.product_id and x.variant_id is not distinct from v_oi.variant_id
           and x.batch_id is not distinct from v_oi.batch_id)
       >= (select count(*) from order_items i join orders o on o.id = i.order_id
            where o.user_id = app_user_id() and o.status = 'approved' and coalesce(i.qty, 0) > 0
              and i.product_id = v_oi.product_id and i.variant_id is not distinct from v_oi.variant_id
              and i.batch_id is not distinct from v_oi.batch_id) then
      raise exception 'ryuma: ตั๋วของรายการนี้มีอยู่แล้ว';
    end if;
    select * into v_p from products where id = v_oi.product_id;
    v_unit_price := coalesce(v_oi.unit_price, (select v.price_total from product_variants v where v.id = v_oi.variant_id), v_p.price_total, 0);
    v_unit_dep   := coalesce(v_oi.unit_deposit, (select v.deposit_amount from product_variants v where v.id = v_oi.variant_id), v_p.deposit_amount, 0);
    new.owner_id := app_user_id();
    new.original_buyer_id := app_user_id();
    new.variant_id := v_oi.variant_id;
    new.batch_id := v_oi.batch_id;
    new.qty := coalesce(v_oi.qty, 1);
    new.deposit_paid := least(coalesce(new.deposit_paid, 0), coalesce(v_oi.deposit_amount, 0));
    new.remaining_amount := greatest(0, v_unit_price - v_unit_dep) * coalesce(v_oi.qty, 1);
    new.remaining_paid := 0;
    new.status := case when greatest(0, v_unit_price - v_unit_dep) <= 0 then 'paid_full' else 'active' end;
    -- สูตรเดียวกับ mirrorStatusFor (mutations.ts): รอบมัดจำบน SKU ที่จบไปแล้ว = เริ่ม 'open'
    new.product_status := case when v_oi.batch_id is not null and greatest(0, v_unit_price - v_unit_dep) > 0
                                    and v_p.status in ('arrived', 'delivered', 'closed') then 'open' else v_p.status end;
    new.split_from := null;
    new.market_rev := 0;
    new.delivery := null;
    return new;
  end if;

  -- คนที่ไม่ใช่ผู้ถือตอนนี้ (เช่นคนขายเดิมที่ยังเป็น original_buyer ตาม RLS v21) แก้ตั๋วไม่ได้ทุกช่อง
  -- (review รอบ A: เดิมคนขายเปลี่ยนวิธีรับของ/ที่อยู่ของตั๋วที่ขายไปแล้วได้)
  if old.owner_id is distinct from app_user_id() then return old; end if;
  new.id               := old.id;
  new.created_at       := old.created_at;
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
  new.market_rev       := old.market_rev;
  if ryuma_market_active(old.id) then new.delivery := old.delivery; end if;
  -- แอดมินรับเรื่องแล้ว (accepted_at) → ลูกค้าแก้วิธีรับของไม่ได้ (กันเครื่องลูกค้าเซฟซ้ำแล้วลบการรับเรื่อง · audit R3-06)
  if old.delivery is not null and coalesce(old.delivery ->> 'accepted_at', '') <> '' then new.delivery := old.delivery; end if;
  return new;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2c) แต้มปิดใบ (earn_ticket) ต้องมีตั๋วจริง — กันแต้มหลุดตอนตั๋วบันทึกไม่ผ่าน (ออเดอร์ถูกด่านอนุมัติปฏิเสธ)
--     adapter เขียน point_ledger หลัง preorder_tickets เสมอ
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_point_ledger_ticket_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'earn_ticket' and new.ref_id is not null
     and not exists (select 1 from preorder_tickets t where t.id = new.ref_id) then
    raise exception 'ryuma: ไม่พบตั๋วของแต้มนี้ (%) — ตั๋วยังบันทึกไม่ขึ้น', new.ref_id;
  end if;
  return new;
end $$;
drop trigger if exists ryuma_point_ledger_ticket_check on point_ledger;
create trigger ryuma_point_ledger_ticket_check before insert on point_ledger
  for each row execute function ryuma_point_ledger_ticket_check();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) คลังรูป logos: ดูรายชื่อไฟล์ได้เฉพาะของตัวเอง (แอดมินดูได้ทั้งหมด) · ลิงก์สาธารณะยังเปิดรูปได้ตามเดิม
--    (แอปไม่เคยเรียก list() · การอัปโหลดใช้ upsert:false แล้ว — ไม่ต้องอ่านไฟล์คนอื่น)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "logos read authed" on storage.objects;
drop policy if exists "logos read own or admin" on storage.objects;
create policy "logos read own or admin" on storage.objects
  for select to authenticated using (bucket_id = 'logos' and (owner = auth.uid() or public.is_app_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) reserve_ticket_nos (ทับ v71): ต้องล็อกอิน · ลูกค้าจองได้ไม่เกิน 50 เลขต่อครั้ง (แอดมิน 1,000)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function reserve_ticket_nos(p text, c int)
returns int language plpgsql security definer set search_path = public as $$
declare
  cnt int := greatest(coalesce(c, 1), 1);
  real_max int;
  start_n int;
begin
  if auth.uid() is null and not is_app_admin() and current_user <> 'postgres' then
    raise exception 'ryuma: ต้องเข้าสู่ระบบก่อน';
  end if;
  if coalesce(p, '') = '' or length(p) > 32 then raise exception 'ryuma: prefix เลขตั๋วไม่ถูกต้อง'; end if;
  if cnt > (case when is_app_admin() then 1000 else 50 end) then
    raise exception 'ryuma: ขอเลขตั๋วมากเกินไปในครั้งเดียว';
  end if;
  if not is_app_admin() and not is_app_approved() then raise exception 'ryuma: บัญชียังไม่ได้รับอนุมัติ'; end if;

  select coalesce(max((substring(substr(ticket_no, length(p) + 2) from '^([0-9]+)'))::int), 0)
    into real_max
    from preorder_tickets
   where ticket_no like p || '-%';

  insert into ticket_counters(prefix, n) values (p, 0)
    on conflict (prefix) do nothing;
  -- ลูกค้า: ห้ามดันตัวนับนำหน้าเลขตั๋วจริงเกิน 200 (กันยิงวนจนเลขตั๋วทั้งเดือนกระโดด · self-heal จริงใช้ไม่กี่เลข)
  if not is_app_admin() and (select greatest(c.n, real_max) from ticket_counters c where c.prefix = p) + cnt - real_max > 200 then
    raise exception 'ryuma: ขอเลขตั๋วมากเกินไป — ติดต่อแอดมิน';
  end if;

  update ticket_counters
     set n = greatest(n, real_max) + cnt
   where prefix = p
   returning n - cnt + 1 into start_n;

  return start_n;
end $$;
revoke all on function reserve_ticket_nos(text, int) from public, anon;
grant execute on function reserve_ticket_nos(text, int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ryuma_link_auth: ผูกบัญชีเข้าสู่ระบบกับสมาชิกรุ่นเก่า ต้อง (ก) ล็อกอินด้วยบัญชีนั้นเอง (ข) อีเมลบัญชี = เบอร์ของสมาชิก (ค) PIN ถูก
--    เดิม: ใครก็ได้ (ไม่ล็อกอินก็ได้) ผูก auth ของตัวเองเข้ากับสมาชิกที่ยังไม่เคยผูก = ยึดบัญชีคนอื่น
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists ryuma_link_auth(text, uuid);
create or replace function ryuma_link_auth(p_user_id text, p_auth_id uuid, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_phone text; v_sec user_secrets; v_email text;
begin
  if auth.uid() is null or p_auth_id is distinct from auth.uid() then return json_build_object('error', 'forbidden'); end if;
  select phone into v_phone from users where id = p_user_id and auth_id is null;
  if not found then return json_build_object('error', 'not_found'); end if;
  select email into v_email from auth.users where id = auth.uid();
  if lower(coalesce(v_email, '')) is distinct from regexp_replace(coalesce(v_phone, ''), '\D', '', 'g') || '@ryuma.local' then
    return json_build_object('error', 'forbidden');
  end if;
  select * into v_sec from user_secrets where user_id = p_user_id;
  if not found then return json_build_object('error', 'not_found'); end if;
  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    return json_build_object('error', 'locked', 'until', v_sec.locked_until);
  end if;
  if v_sec.pin_hash is distinct from crypt(coalesce(p_pin, ''), v_sec.pin_hash) then
    update user_secrets
       set attempts = coalesce(attempts, 0) + 1,
           locked_until = case when coalesce(attempts, 0) + 1 >= 5 then now() + interval '15 minutes' else null end
     where user_id = p_user_id;
    return json_build_object('error', 'wrong_pin');
  end if;
  perform set_config('ryuma.trusted', 'on', true);
  update users set auth_id = p_auth_id where id = p_user_id and auth_id is null;
  return json_build_object('ok', true);
end $$;
revoke all on function ryuma_link_auth(text, uuid, text) from public, anon;
grant execute on function ryuma_link_auth(text, uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) ตัวตรวจสภาพฐานข้อมูล (ทับ v85) — เพิ่มแถว v86
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_schema_check()
returns table (step int, version text, item text, ok boolean)
language sql stable security definer set search_path = public as $fn$
with fp as (
  select p.oid, p.proname, p.pronargs, replace(p.prosrc, chr(13), '') src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
), trg as (
  select c.relname tbl, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal
), pol as (
  select policyname, coalesce(qual, '') qual, coalesce(with_check, '') chk from pg_policies where schemaname = 'public' and tablename = 'preorder_tickets'
), col as (
  select table_name::text table_name, column_name::text column_name, is_nullable::text is_nullable from information_schema.columns where table_schema = 'public'
), a(o, v, chk, ok) as (
  select 1, 'v71', 'ticket_transfers.qty column', exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'qty')
  union all select 2, 'v72', 'fn ryuma_market_open', exists(select 1 from fp where proname = 'ryuma_market_open')
  union all select 3, 'v73', 'fn ryuma_wallet_code', exists(select 1 from fp where proname = 'ryuma_wallet_code')
  union all select 4, 'v74', 'preorder_tickets.market_rev column', exists(select 1 from col where table_name = 'preorder_tickets' and column_name = 'market_rev')
  union all select 5, 'v74', 'fn ryuma_ticket_transferred', exists(select 1 from fp where proname = 'ryuma_ticket_transferred')
  union all select 6, 'v74', 'ryuma_guard_tickets carries the market_rev token', exists(select 1 from fp where proname = 'ryuma_guard_tickets' and src like '%market_rev%')
  union all select 7, 'v74', 'trigger remaining_payments.ryuma_rp_owner_check', exists(select 1 from trg where tbl = 'remaining_payments' and tgname = 'ryuma_rp_owner_check')
  union all select 8, 'v74', 'trigger preorder_tickets.ryuma_tickets_market_nodelete', exists(select 1 from trg where tbl = 'preorder_tickets' and tgname = 'ryuma_tickets_market_nodelete')
  union all select 9, 'v74', 'trigger order_items.ryuma_order_items_market_lock', exists(select 1 from trg where tbl = 'order_items' and tgname = 'ryuma_order_items_market_lock')
  union all select 10, 'v74', 'ryuma_ticket_market_history NOT executable by anon', not exists(select 1 from fp where proname = 'ryuma_ticket_market_history' and has_function_privilege('anon', oid, 'execute'))
  union all select 11, 'v75', 'fn late_slip_resolve + 5-arg offer dropped', exists(select 1 from fp where proname = 'ryuma_market_late_slip_resolve') and not exists(select 1 from fp where proname = 'ryuma_market_offer' and pronargs = 5)
  union all select 12, 'v76', 'payout vault + 4-arg list only + review std_deposit calc', exists(select 1 from pg_class where relname = 'ticket_transfer_payouts')
                         and not exists(select 1 from fp where proname = 'ryuma_market_list' and pronargs <> 4)
                         and exists(select 1 from fp where proname = 'ryuma_item_std_deposit_calc' and src like '%deposit_mega%')
  union all select 13, 'v77', 'ticket RLS = holder + admin only (no tickets_own / original_buyer_id)', not exists(select 1 from pol where policyname = 'tickets_own')
                         and (select count(*) from pol where policyname in ('tickets_read', 'tickets_insert', 'tickets_update', 'tickets_delete')) = 4
                         and not exists(select 1 from pol where qual like '%original_buyer_id%' or chk like '%original_buyer_id%')
  union all select 14, 'v78', 'trigger ticket_transfers.ryuma_transfers_keep_recipient', exists(select 1 from trg where tbl = 'ticket_transfers' and tgname = 'ryuma_transfers_keep_recipient')
  union all select 15, 'v78', 'rp_lock locks the ticket row, no admin bypass', exists(select 1 from fp where proname = 'ryuma_market_rp_lock' and src like '%for update%' and src not like '%is_app_admin()%')
  union all select 16, 'v78', 'purge refuses self/admin (review version)', exists(select 1 from fp where proname = 'ryuma_admin_purge_user' and src like '%admin_target%')
  union all select 17, 'v78', 'feed counts board sales only', exists(select 1 from fp where proname = 'ryuma_market_feed' and src like '%coalesce(d.kind, ''market'') = ''market'') as seller_sold%')
  union all select 18, 'v79', 'cancel_note column + 2-arg cancel only', exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'cancel_note') and not exists(select 1 from fp where proname = 'ryuma_market_cancel' and pronargs <> 2)
  union all select 19, 'v80', 'guard_user_columns: first phone allowed + suspended locked', exists(select 1 from fp where proname = 'guard_user_columns' and src like '%coalesce(old.phone, '''') <> ''''%' and src like '%new.suspended%is distinct from old.suspended%')
  union all select 20, 'v80', 'sourcing + coupon guards raise ryuma: messages', (select count(*) from fp where proname in ('ryuma_guard_sourcing', 'ryuma_guard_coupon_grant') and src like '%ryuma:%') = 2
  union all select 21, 'v81', 'table product_lines', exists(select 1 from pg_class where relname = 'product_lines')
  union all select 22, 'v82', 'table external_parcels', exists(select 1 from pg_class where relname = 'external_parcels')
  union all select 23, 'v83', 'transfer_counts + is_shop_image + finalize advisory lock + qty not null', exists(select 1 from fp where proname = 'ryuma_transfer_counts') and exists(select 1 from fp where proname = 'ryuma_is_shop_image')
                         and exists(select 1 from fp where proname = 'ryuma_market_finalize' and src like '%pg_advisory_xact_lock(hashtext(''ryuma_ticket_no:''%')
                         and exists(select 1 from col where table_name = 'preorder_tickets' and column_name = 'qty' and is_nullable = 'NO')
  union all select 24, 'v84', 'seller_flag + has_bell + slip_history', exists(select 1 from fp where proname = 'ryuma_market_seller_flag') and exists(select 1 from fp where proname = 'ryuma_has_bell') and exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'slip_history')
  union all select 25, 'v85', 'fn ryuma_schema_check', true
  union all select 26, 'v86', 'order_items guard: shop price + rank deposit + pending orders only', exists(select 1 from fp where proname = 'ryuma_guard_order_items' and src like '%ออเดอร์นี้ปิดแล้ว%' and src like '%greatest(coalesce(new.unit_price%')
  union all select 27, 'v86', 'trigger orders.ryuma_orders_approve_check (two-sided)', exists(select 1 from trg where tbl = 'orders' and tgname = 'ryuma_orders_approve_check') and exists(select 1 from fp where proname = 'ryuma_orders_approve_check' and src like '%มากกว่ามัดจำของรายการ%')
  union all select 28, 'v86', 'logos: customers list only their own files', exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'logos read own or admin')
                         and not exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'logos read authed')
  union all select 29, 'v86', 'reserve_ticket_nos: not anon + bounded for customers', exists(select 1 from fp where proname = 'reserve_ticket_nos' and src like '%real_max > 200%') and not exists(select 1 from fp where proname = 'reserve_ticket_nos' and has_function_privilege('anon', oid, 'execute'))
  union all select 30, 'v86', 'ryuma_link_auth needs PIN (3-arg only, not anon)', exists(select 1 from fp where proname = 'ryuma_link_auth' and pronargs = 3)
                         and not exists(select 1 from fp where proname = 'ryuma_link_auth' and (pronargs <> 3 or has_function_privilege('anon', oid, 'execute')))
  union all select 31, 'v86', 'ticket guard: order must be approved before its tickets', exists(select 1 from fp where proname = 'ryuma_guard_tickets' and src like '%ยังไม่ได้อนุมัติ — ออกตั๋วไม่ได้%')
  union all select 32, 'v86', 'trigger point_ledger.ryuma_point_ledger_ticket_check', exists(select 1 from trg where tbl = 'point_ledger' and tgname = 'ryuma_point_ledger_ticket_check')
)
select o, v, chk, ok from a
 where auth.uid() is null or is_app_admin()
 order by o;
$fn$;
revoke all on function ryuma_schema_check() from public, anon;
grant execute on function ryuma_schema_check() to authenticated;

-- ── ตรวจหลังรัน: ต้องได้ ok_count = 32 และ total = 32
--    (ถ้าไม่ครบ ดูแถวที่เป็น false ด้วย:  select * from ryuma_schema_check() where not ok;)
select count(*) filter (where ok) as ok_count, count(*) as total from ryuma_schema_check();
