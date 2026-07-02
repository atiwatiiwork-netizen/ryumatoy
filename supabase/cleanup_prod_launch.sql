-- ============================================================================
-- Ryuma — PRODUCTION LAUNCH DATA CLEANUP.  ⚠️ IRREVERSIBLE. Paste into SQL Editor.
-- Wrapped in a transaction: if any statement fails, NOTHING is deleted (rolls back).
--
-- DELETES:
--   • all members except the shop owner (is_admin = true) + their Supabase Auth logins/PINs
--   • ALL orders / order_items / preorder_tickets / remaining_payments / rank_requests /
--     stock_reservations / ticket_transfers  (they all belong to those members)
--   • ALL products (+ variants / batches / stock additions)
--   • ALL coupons
-- KEEPS (untouched):
--   • the admin/owner user (is_admin = true)
--   • makers (ค่าย) / franchises (เรื่อง) / series / categories / rank_tiers
--   • payment accounts, shop settings, and EVERY banner (promo announcements + board posters)
--   • the boards themselves (กระดานปิดพรี) — only the products inside them are cleared
--   • all app functions / features (code)
--
-- RUN THE PRE-CHECK FIRST (separately) to confirm who will be kept:
--   select display_name, phone, is_admin from users where is_admin = true;
-- It should list ONLY your owner account. If so, run the block below.
-- ============================================================================
begin;

-- 1. member activity (every row belongs to a non-admin member)
delete from ticket_transfers;
delete from remaining_payments;
delete from preorder_tickets;
delete from order_items;
delete from orders;
delete from rank_requests;
delete from stock_reservations;

-- 2. all products (makers / franchises / series stay). variants/batches/stock cascade, deleted explicitly too.
delete from product_variants;
delete from product_batches;
delete from stock_additions;
delete from products;                 -- boards remain; their product links simply vanish

-- 3. coupons
delete from coupons;

-- 4. members except the owner (user_secrets cascade-deletes with the user)
delete from users where is_admin is not true;

-- 5. their Supabase Auth logins — all phone customers use {phone}@ryuma.local.
--    The admin signs in with Facebook (not @ryuma.local), so the owner login is untouched.
delete from auth.users where email like '%@ryuma.local';

-- 6. tidy up: clear any dangling featured-product ref + restart member codes at RYU-0001
update shop_settings set hero_product_id = null where hero_product_id is not null;
select setval('member_seq', 1, false);

commit;
