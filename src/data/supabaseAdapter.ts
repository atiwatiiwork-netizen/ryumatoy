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

const stripItems = (order: Row): Row => {
  const copy = { ...order };
  delete copy.items;
  return copy;
};

export const supabaseAdapter: PersistenceAdapter = {
  async load(): Promise<Database> {
    const sb = client();
    const [users, categories, manufacturers, franchises, series, products, boards, boardLogs, batches, stockAdditions, variants, orders, orderItems, tickets, remainingPayments, rankRequests, stockReservations, transfers, coupons, couponGrants, campaigns, campaignAwards, rankTiers, paymentAccounts, settings] =
      await Promise.all([
        sb.from('users').select('*'),
        sb.from('categories').select('*'),
        sb.from('manufacturers').select('*'),
        sb.from('franchises').select('*'),
        sb.from('series').select('*'),
        sb.from('products').select('*'),
        sb.from('preorder_boards').select('*'),
        sb.from('board_close_logs').select('*'),
        sb.from('product_batches').select('*'),
        sb.from('stock_additions').select('*'),
        sb.from('product_variants').select('*'),
        sb.from('orders').select('*'),
        sb.from('order_items').select('*'),
        sb.from('preorder_tickets').select('*'),
        sb.from('remaining_payments').select('*'),
        sb.from('rank_requests').select('*'),
        sb.from('stock_reservations').select('*'),
        sb.from('ticket_transfers').select('*'),
        sb.from('coupons').select('*'),
        sb.from('coupon_grants').select('*'),
        sb.from('campaigns').select('*'),
        sb.from('campaign_awards').select('*'),
        sb.from('rank_tiers').select('*'),
        sb.from('payment_accounts').select('*'),
        sb.from('shop_settings').select('*'),
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
      rankTiers: (rankTiers.data ?? []) as Database['rankTiers'],
      paymentAccounts: (paymentAccounts.data ?? []) as Database['paymentAccounts'],
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
    await syncTable(sb, 'users', next.users as unknown as Row[], base.users as unknown as Row[]);
    await syncTable(sb, 'categories', next.categories as unknown as Row[], base.categories as unknown as Row[]);
    await syncTable(sb, 'manufacturers', next.manufacturers as unknown as Row[], base.manufacturers as unknown as Row[]);
    await syncTable(sb, 'franchises', next.franchises as unknown as Row[], base.franchises as unknown as Row[]);
    await syncTable(sb, 'series', next.series as unknown as Row[], base.series as unknown as Row[]);
    await syncTable(sb, 'products', next.products as unknown as Row[], base.products as unknown as Row[]);
    await syncTable(sb, 'preorder_boards', next.boards as unknown as Row[], base.boards as unknown as Row[]);
    await syncTable(sb, 'board_close_logs', next.boardLogs as unknown as Row[], base.boardLogs as unknown as Row[]);
    await syncTable(sb, 'product_batches', next.batches as unknown as Row[], base.batches as unknown as Row[]);
    await syncTable(sb, 'stock_additions', next.stockAdditions as unknown as Row[], base.stockAdditions as unknown as Row[]);
    await syncTable(sb, 'product_variants', next.variants as unknown as Row[], base.variants as unknown as Row[]);
    await syncTable(sb, 'coupons', next.coupons as unknown as Row[], base.coupons as unknown as Row[]);
    await syncTable(sb, 'coupon_grants', next.couponGrants as unknown as Row[], base.couponGrants as unknown as Row[]);
    await syncTable(sb, 'campaigns', next.campaigns as unknown as Row[], base.campaigns as unknown as Row[]);
    await syncTable(sb, 'campaign_awards', next.campaignAwards as unknown as Row[], base.campaignAwards as unknown as Row[]);
    await syncTable(sb, 'payment_accounts', next.paymentAccounts as unknown as Row[], base.paymentAccounts as unknown as Row[]);

    await syncTable(sb, 'orders', next.orders.map(stripItems as never), base.orders.map(stripItems as never));
    await syncTable(
      sb,
      'order_items',
      next.orders.flatMap((o) => o.items) as unknown as Row[],
      base.orders.flatMap((o) => o.items) as unknown as Row[],
    );

    await syncTable(sb, 'preorder_tickets', next.tickets as unknown as Row[], base.tickets as unknown as Row[]);
    await syncTable(sb, 'remaining_payments', next.remainingPayments as unknown as Row[], base.remainingPayments as unknown as Row[]);
    await syncTable(sb, 'rank_requests', next.rankRequests as unknown as Row[], base.rankRequests as unknown as Row[]);
    await syncTable(sb, 'ticket_transfers', next.transfers as unknown as Row[], base.transfers as unknown as Row[]);
    await syncTable(sb, 'rank_tiers', next.rankTiers as unknown as Row[], base.rankTiers as unknown as Row[], 'name');

    // Only write settings when they actually changed — otherwise every customer
    // save would try to upsert shop_settings, which RLS blocks for non-admins.
    if (JSON.stringify(next.settings) !== JSON.stringify(base.settings)) {
      const { error } = await sb.from('shop_settings').upsert({ id: 'default', ...next.settings });
      if (error) throw error;
    }
  },

  async reset(): Promise<Database> {
    return structuredClone(SEED_DATABASE);
  },
};
