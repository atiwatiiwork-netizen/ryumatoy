import type { Database } from '../domain/entities';
import type { PersistenceAdapter } from './persistence';
import { supabase } from './supabaseClient';
import { SEED_DATABASE } from './seed';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase persistence adapter — implements the same PersistenceAdapter contract
 * as localStorage, so the store doesn't know which backend it talks to.
 *
 * load(): fetch every table and assemble one Database object (order_items are
 * nested into their order; shop_settings collapses to one object).
 * persist(next, base): diff each collection by id and upsert changed/new rows,
 * delete removed ones — row-by-row upsert keeps heterogeneous optional columns
 * (e.g. variant_id) safe.
 */

type Row = Record<string, unknown>;

function client(): SupabaseClient {
  if (!supabase) throw new Error('[supabaseAdapter] Supabase is not configured');
  return supabase;
}

async function syncTable(sb: SupabaseClient, table: string, nextRows: Row[], baseRows: Row[], key = 'id') {
  const baseJson = new Map(baseRows.map((r) => [String(r[key]), JSON.stringify(r)]));
  const nextKeys = new Set(nextRows.map((r) => String(r[key])));

  // IMPORTANT: attempt EVERY changed row even if one fails, so a single bad/transient row can't drop
  // its siblings (e.g. bulk-adding 4 products → row 2 blips → rows 3-4 silently never persist). We keep
  // the first error and throw it at the END → the store still rewinds + retries the failed row(s), but
  // the rows that DID upload are already saved. (ryuma-dna-save rule 5)
  let firstError: unknown = null;
  for (const row of nextRows) {
    if (baseJson.get(String(row[key])) !== JSON.stringify(row)) {
      const { error } = await sb.from(table).upsert(row);
      if (error && !firstError) firstError = error;
    }
  }

  const removed = baseRows.filter((r) => !nextKeys.has(String(r[key]))).map((r) => r[key] as string);
  if (removed.length) {
    const { error } = await sb.from(table).delete().in(key, removed);
    if (error && !firstError) firstError = error;
  }

  if (firstError) throw firstError;
}

/** ตารางแบบ "เขียนเพิ่มอย่างเดียว" (ประวัติการกระทำ): upsert เฉพาะแถวใหม่ ไม่แก้ ไม่ลบ.
 *  ⚠ ห้ามใช้ syncTable ปกติกับ activity_logs: ในหน่วยความจำเก็บแค่ 400 แถวล่าสุด (logActivity slice)
 *  และ adapter โหลดมาแค่ 300 → แถวที่ถูกตัดออกจะถูกมองว่า "ถูกลบ" แล้วสั่ง DELETE ประวัติทิ้ง
 *  (RLS ไม่มี policy ลบ → error ทุก flush; ถ้ามี policy ก็จะกลายเป็นลบประวัติจริง). */
async function syncAppendOnly(sb: SupabaseClient, table: string, nextRows: Row[], baseRows: Row[], key = 'id') {
  const known = new Set(baseRows.map((r) => String(r[key])));
  const fresh = nextRows.filter((r) => !known.has(String(r[key])));
  if (fresh.length === 0) return;
  // ignoreDuplicates = ON CONFLICT DO NOTHING → ไม่ต้องมี UPDATE policy และส่งซ้ำได้ปลอดภัย.
  // (สำคัญ: flush ที่ล้มเหลวจะ rewind แล้วส่งชุดเดิมซ้ำ — ถ้าใช้ insert ธรรมดาจะชน primary key
  // แล้ววนพังถาวร; ถ้าใช้ upsert ธรรมดาจะไปเข้า UPDATE ที่ RLS ห้าม — audit v56)
  const { error } = await sb.from(table).upsert(fresh, { ignoreDuplicates: true });
  if (error) throw error;
}

const stripItems = (order: Row): Row => {
  const copy = { ...order };
  delete copy.items;
  return copy;
};

/**
 * ดึง "ทั้งตาราง" แบบแบ่งหน้า — ⚠ PostgREST/Supabase คืนสูงสุด **1000 แถวต่อคำขอ** แล้ว
 * **ตัดที่เหลือทิ้งเงียบๆ ไม่มี error** ถ้าใช้ .select('*') เฉยๆ.
 *
 * ทำไมถึงต้องแก้ก่อนของโต (audit 2026-08-10): พอ preorder_tickets เกิน 1000 แถว แอปจะอ่านตั๋วได้
 * ไม่ครบ → unmatchedApprovedItems เห็น "ออเดอร์อนุมัติแล้วแต่ตั๋วหาย" เป็นร้อยรายการ → ตัวกู้ตั๋ว
 * (self-heal ฝั่งลูกค้า + ปุ่มซ่อมของแอดมิน) มินต์ตั๋วซ้ำให้ทั้งร้านพร้อมกัน = เคสตั๋วซ้ำ Mongkol
 * แต่เกิดทีเดียวทุกคน. เช่นเดียวกับ stock_reservations (นับ hold ขาด = ขายเกิน) และ order_items.
 *
 * ตารางเล็กยังยิงคำขอเดียวเหมือนเดิม (ได้ < 1000 แถวก็หยุด) จึงไม่มีผลกับความเร็วตอนนี้.
 */
// ⚠ 4 ตารางนี้ไม่มีคอลัมน์ id (PK เป็นอย่างอื่น) — .order('id') กับพวกมัน = 42703 ทั้งโหลดล้มทั้งแอป
//   (เหตุการณ์จริง 2026-08-31: ลูกค้าเข้าเว็บไม่ได้ทั้งร้านหลัง deploy .order('id') แบบเหมารวม)
const NO_ID_COLUMN = new Set(['push_prefs', 'push_config', 'app_config', 'rank_tiers']);

async function fetchAll(sb: SupabaseClient, table: string): Promise<{ data: unknown[] | null; error: unknown }> {
  const PAGE = 1000;
  const out: unknown[] = [];
  // ลำดับคงที่กันข้าม/ซ้ำแถวตอนแบ่งหน้า — เฉพาะตารางที่มี id; ที่เหลือเป็นตาราง config เล็ก (หน้าเดียว)
  let orderable = !NO_ID_COLUMN.has(table);
  for (let from = 0; ; from += PAGE) {
    const base = sb.from(table).select('*');
    const { data, error } = await (orderable ? base.order('id', { ascending: true }) : base).range(from, from + PAGE - 1);
    if (error) {
      // กันเหนียว: ตารางใหม่ในอนาคตที่ไม่มี id — ถอย order ออกแล้วลองใหม่ แทนที่จะพังทั้งโหลด
      if (orderable && from === 0 && (error as { code?: string }).code === '42703') { orderable = false; from = -PAGE; continue; }
      return { data: null, error };
    }
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

export const supabaseAdapter: PersistenceAdapter = {
  async load(): Promise<Database> {
    const sb = client();
    const [users, categories, manufacturers, franchises, series, products, boards, boardLogs, batches, stockAdditions, variants, orders, orderItems, tickets, remainingPayments, rankRequests, stockReservations, transfers, coupons, couponGrants, campaigns, campaignAwards, pushSubscriptions, pushPrefs, pushConfig, sourcingRequests, sourcingMemos, missionSubmissions, appConfig, rankTiers, paymentAccounts, activityLogs, paymentPlans, auctions, auctionBids, auctionWatch, auctionEntries, settings] =
      await Promise.all([
        fetchAll(sb, 'users'),
        fetchAll(sb, 'categories'),
        fetchAll(sb, 'manufacturers'),
        fetchAll(sb, 'franchises'),
        fetchAll(sb, 'series'),
        fetchAll(sb, 'products'),
        fetchAll(sb, 'preorder_boards'),
        fetchAll(sb, 'board_close_logs'),
        fetchAll(sb, 'product_batches'),
        fetchAll(sb, 'stock_additions'),
        fetchAll(sb, 'product_variants'),
        fetchAll(sb, 'orders'),
        fetchAll(sb, 'order_items'),
        fetchAll(sb, 'preorder_tickets'),
        fetchAll(sb, 'remaining_payments'),
        fetchAll(sb, 'rank_requests'),
        fetchAll(sb, 'stock_reservations'),
        fetchAll(sb, 'ticket_transfers'),
        fetchAll(sb, 'coupons'),
        fetchAll(sb, 'coupon_grants'),
        fetchAll(sb, 'campaigns'),
        fetchAll(sb, 'campaign_awards'),
        fetchAll(sb, 'push_subscriptions'),
        fetchAll(sb, 'push_prefs'),
        fetchAll(sb, 'push_config'),
        fetchAll(sb, 'sourcing_requests'),
        fetchAll(sb, 'sourcing_memos'),
        fetchAll(sb, 'mission_submissions'),
        fetchAll(sb, 'app_config'),
        fetchAll(sb, 'rank_tiers'),
        fetchAll(sb, 'payment_accounts'),
        // limit ต้อง ≥ cap ในหน่วยความจำ (400 ใน logActivity) ไม่งั้นแถวที่ถูกตัดจะดูเหมือน "ถูกลบ"
        sb.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(400),
        // ใหม่สุดก่อนเสมอ: เรียงตาม due_date ขึ้น + limit จะ "ปักหน้าต่างไว้ที่นัดเก่าสุด"
        // พอมีครบ 500 แถว นัดที่ออกใหม่จะหลุดหน้าต่างทั้งหมด = ฟีเจอร์ตายเงียบ (audit v57 #15)
        sb.from('payment_plans').select('*').order('created_at', { ascending: false }).limit(500),
        // ประมูล (v60) — ยังไม่รัน migration = ตารางไม่มี → ต้องไม่พังทั้งแอป (ไม่อยู่ใน fatal list)
        fetchAll(sb, 'auctions'),
        // auction_bids: RLS ให้ลูกค้าเห็นเฉพาะบิดของตัวเอง (ประวัติสาธารณะมาจาก RPC ที่ปิดชื่อ)
        fetchAll(sb, 'auction_bids'),
        fetchAll(sb, 'auction_watch'),
        fetchAll(sb, 'auction_entries'),
        fetchAll(sb, 'shop_settings'),
      ]);

    // coupon_grants / campaigns / campaign_awards are intentionally NOT in this fatal list: before
    // their migration runs the tables don't exist, and a missing/errored coupon/event table must
    // degrade to "no coupons / no events" — never break the whole app load (the UI just no-ops until
    // the migration is applied).
    const results = [users, categories, manufacturers, franchises, series, products, boards, boardLogs, batches, stockAdditions, variants, orders, orderItems, tickets, remainingPayments, rankRequests, stockReservations, transfers, coupons, rankTiers, paymentAccounts, settings];
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;

    const items = (orderItems.data ?? []) as Array<Row & { order_id: string }>;
    const ordersWithItems = ((orders.data ?? []) as Array<Row & { id: string }>).map((o) => ({
      ...o,
      items: items.filter((i) => i.order_id === o.id),
    }));
    const s = ((settings.data ?? []) as Row[])[0];

    return {
      users: (users.data ?? []) as Database['users'],
      categories: (categories.data ?? []) as Database['categories'],
      manufacturers: (manufacturers.data ?? []) as Database['manufacturers'],
      franchises: (franchises.data ?? []) as Database['franchises'],
      series: ((series.data ?? []) as Array<Row & { franchise_id?: string; franchise_ids?: string[] }>).map((s) => ({
        ...s,
        franchise_ids: s.franchise_ids?.length ? s.franchise_ids : (s.franchise_id ? [s.franchise_id] : []),
      })) as unknown as Database['series'],
      products: (products.data ?? []) as Database['products'],
      boards: (boards.data ?? []) as Database['boards'],
      boardLogs: (boardLogs.data ?? []) as Database['boardLogs'],
      batches: (batches.data ?? []) as Database['batches'],
      stockAdditions: (stockAdditions.data ?? []) as Database['stockAdditions'],
      variants: (variants.data ?? []) as Database['variants'],
      orders: ordersWithItems as unknown as Database['orders'],
      tickets: (tickets.data ?? []) as Database['tickets'],
      remainingPayments: (remainingPayments.data ?? []) as Database['remainingPayments'],
      rankRequests: (rankRequests.data ?? []) as Database['rankRequests'],
      stockReservations: (stockReservations.data ?? []) as Database['stockReservations'],
      transfers: (transfers.data ?? []) as Database['transfers'],
      coupons: (coupons.data ?? []) as Database['coupons'],
      couponGrants: (couponGrants.data ?? []) as Database['couponGrants'],
      campaigns: (campaigns.data ?? []) as Database['campaigns'],
      campaignAwards: (campaignAwards.data ?? []) as Database['campaignAwards'],
      pushSubscriptions: (pushSubscriptions.data ?? []) as Database['pushSubscriptions'],
      pushPrefs: (pushPrefs.data ?? []) as Database['pushPrefs'],
      pushConfig: (pushConfig.data ?? []) as Database['pushConfig'],
      sourcingRequests: (sourcingRequests.data ?? []) as Database['sourcingRequests'],
      // like coupon_grants: tables may not exist before their migrations → degrade to [] (never break load)
      sourcingMemos: (sourcingMemos.data ?? []) as Database['sourcingMemos'],
      missionSubmissions: (missionSubmissions.data ?? []) as Database['missionSubmissions'],
      appConfig: (appConfig.data ?? []) as Database['appConfig'],
      rankTiers: (rankTiers.data ?? []) as Database['rankTiers'],
      paymentAccounts: (paymentAccounts.data ?? []) as Database['paymentAccounts'],
      // ตารางใหม่ v56 — degrade เป็น [] ถ้ายังไม่ได้รัน migration (ไม่ทำให้แอปโหลดพัง)
      activityLogs: (activityLogs.data ?? []) as Database['activityLogs'],
      paymentPlans: (paymentPlans.data ?? []) as Database['paymentPlans'],
      auctions: (auctions.data ?? []) as Database['auctions'],
      auctionBids: (auctionBids.data ?? []) as Database['auctionBids'],
      auctionWatch: (auctionWatch.data ?? []) as Database['auctionWatch'],
      auctionEntries: (auctionEntries.data ?? []) as Database['auctionEntries'],
      settings: s
        ? {
            bank_name: String(s.bank_name ?? ''),
            bank_account: String(s.bank_account ?? ''),
            promptpay_number: String(s.promptpay_number ?? ''),
            line_oa_id: String(s.line_oa_id ?? ''),
            yuan_base: Number(s.yuan_base ?? SEED_DATABASE.settings.yuan_base),
            baht_base: Number(s.baht_base ?? SEED_DATABASE.settings.baht_base),
            baht_per_yuan: Number(s.baht_per_yuan ?? SEED_DATABASE.settings.baht_per_yuan),
            deposit_wcf: Number(s.deposit_wcf ?? SEED_DATABASE.settings.deposit_wcf),
            deposit_mega: Number(s.deposit_mega ?? SEED_DATABASE.settings.deposit_mega),
            eta_min_days: Number(s.eta_min_days ?? SEED_DATABASE.settings.eta_min_days),
            eta_max_days: Number(s.eta_max_days ?? SEED_DATABASE.settings.eta_max_days),
            rank_silver_pieces: Number(s.rank_silver_pieces ?? SEED_DATABASE.settings.rank_silver_pieces),
            rank_gold_pieces: Number(s.rank_gold_pieces ?? SEED_DATABASE.settings.rank_gold_pieces),
            rank_gold_deposit_pct: Number(s.rank_gold_deposit_pct ?? SEED_DATABASE.settings.rank_gold_deposit_pct),
            instock_disc_gold_type: (s.instock_disc_gold_type ?? SEED_DATABASE.settings.instock_disc_gold_type) as 'percent' | 'baht',
            instock_disc_gold_value: Number(s.instock_disc_gold_value ?? SEED_DATABASE.settings.instock_disc_gold_value),
            hero_product_id: (s.hero_product_id ?? undefined) as string | undefined,
            hero_image_url: (s.hero_image_url ?? undefined) as string | undefined,
            announcements: (Array.isArray(s.announcements) ? s.announcements : []) as Database['settings']['announcements'],
          }
        : SEED_DATABASE.settings,
    };
  },

  async persist(next, base) {
    const sb = client();
    // ⚠ FAULT ISOLATION (data-linking audit 2026-07-25 — รากของบั๊ก "ข้อมูลหาย"):
    // เดิม persist เขียนแบบ fail-fast → ตารางแรกที่พัง (เช่น coupon_grants โดน RLS ปฏิเสธในเซสชันลูกค้า)
    // ทำให้ตารางที่เหลือ "ทั้งหมด" หลังจากนั้น (orders → order_items → preorder_tickets →
    // remaining_payments → push_subscriptions …) ไม่ถูกเขียนเลย และพังซ้ำทุก flush ตลอดไป
    // ตอนนี้: เขียนทุกตารางเสมอ เก็บ error ไว้ แล้วโยนรวมตอนจบ (store rewind+retry เหมือนเดิม)
    const errs: string[] = [];
    const step = async (label: string, run: () => Promise<unknown>) => {
      try { await run(); } catch (e) { errs.push(`${label}: ${(e as { message?: string })?.message ?? String(e)}`); }
    };
    await step('users', () => syncTable(sb, 'users', next.users as unknown as Row[], base.users as unknown as Row[]));
    await step('categories', () => syncTable(sb, 'categories', next.categories as unknown as Row[], base.categories as unknown as Row[]));
    await step('manufacturers', () => syncTable(sb, 'manufacturers', next.manufacturers as unknown as Row[], base.manufacturers as unknown as Row[]));
    await step('franchises', () => syncTable(sb, 'franchises', next.franchises as unknown as Row[], base.franchises as unknown as Row[]));
    await step('series', () => syncTable(sb, 'series', next.series as unknown as Row[], base.series as unknown as Row[]));
    await step('products', () => syncTable(sb, 'products', next.products as unknown as Row[], base.products as unknown as Row[]));
    await step('preorder_boards', () => syncTable(sb, 'preorder_boards', next.boards as unknown as Row[], base.boards as unknown as Row[]));
    await step('board_close_logs', () => syncTable(sb, 'board_close_logs', next.boardLogs as unknown as Row[], base.boardLogs as unknown as Row[]));
    await step('product_batches', () => syncTable(sb, 'product_batches', next.batches as unknown as Row[], base.batches as unknown as Row[]));
    await step('stock_additions', () => syncTable(sb, 'stock_additions', next.stockAdditions as unknown as Row[], base.stockAdditions as unknown as Row[]));
    await step('product_variants', () => syncTable(sb, 'product_variants', next.variants as unknown as Row[], base.variants as unknown as Row[]));
    await step('coupons', () => syncTable(sb, 'coupons', next.coupons as unknown as Row[], base.coupons as unknown as Row[]));
    await step('coupon_grants', () => syncTable(sb, 'coupon_grants', next.couponGrants as unknown as Row[], base.couponGrants as unknown as Row[]));
    await step('campaigns', () => syncTable(sb, 'campaigns', next.campaigns as unknown as Row[], base.campaigns as unknown as Row[]));
    await step('campaign_awards', () => syncTable(sb, 'campaign_awards', next.campaignAwards as unknown as Row[], base.campaignAwards as unknown as Row[]));
    await step('push_subscriptions', () => syncTable(sb, 'push_subscriptions', next.pushSubscriptions as unknown as Row[], base.pushSubscriptions as unknown as Row[]));
    await step('push_prefs', () => syncTable(sb, 'push_prefs', next.pushPrefs as unknown as Row[], base.pushPrefs as unknown as Row[], 'user_id'));
    await step('push_config', () => syncTable(sb, 'push_config', next.pushConfig as unknown as Row[], base.pushConfig as unknown as Row[], 'key'));
    await step('sourcing_requests', () => syncTable(sb, 'sourcing_requests', next.sourcingRequests as unknown as Row[], base.sourcingRequests as unknown as Row[]));
    await step('sourcing_memos', () => syncTable(sb, 'sourcing_memos', next.sourcingMemos as unknown as Row[], base.sourcingMemos as unknown as Row[]));
    await step('mission_submissions', () => syncTable(sb, 'mission_submissions', next.missionSubmissions as unknown as Row[], base.missionSubmissions as unknown as Row[]));
    await step('app_config', () => syncTable(sb, 'app_config', next.appConfig as unknown as Row[], base.appConfig as unknown as Row[], 'key'));
    await step('payment_accounts', () => syncTable(sb, 'payment_accounts', next.paymentAccounts as unknown as Row[], base.paymentAccounts as unknown as Row[]));
    await step('activity_logs', () => syncAppendOnly(sb, 'activity_logs', next.activityLogs as unknown as Row[], base.activityLogs as unknown as Row[]));
    await step('payment_plans', () => syncTable(sb, 'payment_plans', next.paymentPlans as unknown as Row[], base.paymentPlans as unknown as Row[]));
    // ประมูล (v60): เขียนได้เฉพาะ "ห้อง" (สร้าง/แก้ตอนร่าง) — ราคา/เวลาปิดเป็นของ server
    // แก้ห้องที่ live แล้วถูกบล็อกใน mutation เพราะ upsert ทั้งแถวจะทับ current_price/ends_at ที่ RPC เพิ่งอัปเดต
    await step('auctions', () => syncTable(sb, 'auctions', next.auctions as unknown as Row[], base.auctions as unknown as Row[]));
    await step('auction_watch', () => syncTable(sb, 'auction_watch', next.auctionWatch as unknown as Row[], base.auctionWatch as unknown as Row[]));
    await step('auction_entries', () => syncTable(sb, 'auction_entries', next.auctionEntries as unknown as Row[], base.auctionEntries as unknown as Row[]));
    // auction_bids: **ไม่ sync โดยตั้งใจ** — บิดเกิดจาก RPC ฝั่ง server เท่านั้น
    // (บิดที่ client เขียนเองได้ = ปั่นราคาได้ และบิดที่เก็บไว้ local ตอนโหมดทดลองต้องไม่ไหลขึ้นจริง)

    // ⚠ ลำดับ orders ก่อน preorder_tickets เป็นความตั้งใจ — ห้ามสลับ (เคสตั๋วซ้ำ Mongkol 2026-08-07)
    //   การเซฟไม่ atomic ข้ามตาราง จึงมีช่วงที่เครื่องอื่นอ่านเจอสถานะครึ่งทางเสมอ คำถามคือ
    //   "ครึ่งทางแบบไหนที่ระบบกู้เองได้":
    //     · orders ก่อน → ครึ่งทาง = "approved แต่ยังไม่มีตั๋ว" → order.status กันแอดมินกดอนุมัติซ้ำ
    //       (หน้าอนุมัติเช็ค stillPending) และ self-heal/ปุ่มซ่อมออกตั๋วที่ขาดให้ได้ตรงใบ ✓
    //     · tickets ก่อน → ครึ่งทาง = "มีตั๋วแต่ออเดอร์ยัง pending" → ไม่มีตัวไหนตรวจเจอ และแอดมิน
    //       ที่กดอนุมัติซ้ำจะผ่านด่าน (status ยัง pending) = ออกตั๋วชุดที่สองทั้งชุด ✗
    //   ตัวที่กันตั๋วซ้ำจริงคือ id ตั๋วที่ผูกกับ order_item (orderTicketId) → มินต์ซ้ำ = upsert แถวเดิม
    await step('orders', () => syncTable(sb, 'orders', next.orders.map(stripItems as never), base.orders.map(stripItems as never)));
    await step('order_items', () => syncTable(
      sb,
      'order_items',
      next.orders.flatMap((o) => o.items) as unknown as Row[],
      base.orders.flatMap((o) => o.items) as unknown as Row[],
    ));
    // ⚠ ลำดับ: remaining_payments ก่อน preorder_tickets — หลักการเดียวกับ orders ก่อน tickets
    //   (เคสตั๋วซ้ำ 2026-08-07): สถานะของสลิป (pending→approved) คือ "ด่าน" ที่กันแอดมินอีกเครื่อง
    //   กดอนุมัติซ้ำ ส่วนตัวเลขบนตั๋ว (หนี้ลด) คือ "เงิน" — ด่านต้องขึ้นเซิร์ฟเวอร์ก่อนเงินเสมอ
    //   เดิมตั๋วลงก่อน → เครื่องอื่น poll เจอช่วงกลางคัน "หนี้ลดแล้วแต่สลิปยัง pending" → อนุมัติซ้ำ
    //   = หนี้ลดสองรอบจากเงินก้อนเดียว (audit ADV-01 2026-08-08)
    await step('remaining_payments', () => syncTable(sb, 'remaining_payments', next.remainingPayments as unknown as Row[], base.remainingPayments as unknown as Row[]));
    await step('preorder_tickets', () => syncTable(sb, 'preorder_tickets', next.tickets as unknown as Row[], base.tickets as unknown as Row[]));

    await step('rank_requests', () => syncTable(sb, 'rank_requests', next.rankRequests as unknown as Row[], base.rankRequests as unknown as Row[]));
    await step('ticket_transfers', () => syncTable(sb, 'ticket_transfers', next.transfers as unknown as Row[], base.transfers as unknown as Row[]));
    await step('rank_tiers', () => syncTable(sb, 'rank_tiers', next.rankTiers as unknown as Row[], base.rankTiers as unknown as Row[], 'name'));

    // Only write settings when they actually changed — otherwise every customer
    // save would try to upsert shop_settings, which RLS blocks for non-admins.
    if (JSON.stringify(next.settings) !== JSON.stringify(base.settings)) {
      await step('shop_settings', async () => {
        const { error } = await sb.from('shop_settings').upsert({ id: 'default', ...next.settings });
        if (error) throw error;
      });
    }
    // ทุกตารางถูกพยายามเขียนครบแล้ว — ค่อยแจ้ง error รวม (store rewind + retry + onPersistError toast)
    if (errs.length) throw new Error(errs.join(' | '));
  },

  async reset(): Promise<Database> {
    return structuredClone(SEED_DATABASE);
  },
};
