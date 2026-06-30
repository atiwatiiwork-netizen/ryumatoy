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

  for (const row of nextRows) {
    if (baseJson.get(String(row[key])) !== JSON.stringify(row)) {
      const { error } = await sb.from(table).upsert(row);
      if (error) throw error;
    }
  }

  const removed = baseRows.filter((r) => !nextKeys.has(String(r[key]))).map((r) => r[key] as string);
  if (removed.length) {
    const { error } = await sb.from(table).delete().in(key, removed);
    if (error) throw error;
  }
}

const stripItems = (order: Row): Row => {
  const copy = { ...order };
  delete copy.items;
  return copy;
};

export const supabaseAdapter: PersistenceAdapter = {
  async load(): Promise<Database> {
    const sb = client();
    const [users, categories, manufacturers, franchises, series, products, variants, orders, orderItems, tickets, transfers, coupons, rankTiers, settings] =
      await Promise.all([
        sb.from('users').select('*'),
        sb.from('categories').select('*'),
        sb.from('manufacturers').select('*'),
        sb.from('franchises').select('*'),
        sb.from('series').select('*'),
        sb.from('products').select('*'),
        sb.from('product_variants').select('*'),
        sb.from('orders').select('*'),
        sb.from('order_items').select('*'),
        sb.from('preorder_tickets').select('*'),
        sb.from('ticket_transfers').select('*'),
        sb.from('coupons').select('*'),
        sb.from('rank_tiers').select('*'),
        sb.from('shop_settings').select('*'),
      ]);

    const results = [users, categories, manufacturers, franchises, series, products, variants, orders, orderItems, tickets, transfers, coupons, rankTiers, settings];
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
      series: (series.data ?? []) as Database['series'],
      products: (products.data ?? []) as Database['products'],
      variants: (variants.data ?? []) as Database['variants'],
      orders: ordersWithItems as unknown as Database['orders'],
      tickets: (tickets.data ?? []) as Database['tickets'],
      transfers: (transfers.data ?? []) as Database['transfers'],
      coupons: (coupons.data ?? []) as Database['coupons'],
      rankTiers: (rankTiers.data ?? []) as Database['rankTiers'],
      settings: s
        ? {
            bank_name: String(s.bank_name ?? ''),
            bank_account: String(s.bank_account ?? ''),
            promptpay_number: String(s.promptpay_number ?? ''),
            line_oa_id: String(s.line_oa_id ?? ''),
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
    await syncTable(sb, 'product_variants', next.variants as unknown as Row[], base.variants as unknown as Row[]);
    await syncTable(sb, 'coupons', next.coupons as unknown as Row[], base.coupons as unknown as Row[]);

    await syncTable(sb, 'orders', next.orders.map(stripItems as never), base.orders.map(stripItems as never));
    await syncTable(
      sb,
      'order_items',
      next.orders.flatMap((o) => o.items) as unknown as Row[],
      base.orders.flatMap((o) => o.items) as unknown as Row[],
    );

    await syncTable(sb, 'preorder_tickets', next.tickets as unknown as Row[], base.tickets as unknown as Row[]);
    await syncTable(sb, 'ticket_transfers', next.transfers as unknown as Row[], base.transfers as unknown as Row[]);
    await syncTable(sb, 'rank_tiers', next.rankTiers as unknown as Row[], base.rankTiers as unknown as Row[], 'name');

    const { error } = await sb.from('shop_settings').upsert({ id: 'default', ...next.settings });
    if (error) throw error;
  },

  async reset(): Promise<Database> {
    return structuredClone(SEED_DATABASE);
  },
};
