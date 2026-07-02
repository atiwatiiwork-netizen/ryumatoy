import { supabase } from '@/data/supabaseClient';

type Res = { ok?: boolean; error?: string; reservation_id?: string; until?: string; available?: number };

async function call(fn: string, args: Record<string, unknown>): Promise<Res> {
  if (!supabase) return { error: 'no_server' };
  const { data, error } = await supabase.rpc(fn, args);
  return (data ?? { error: error?.message ?? 'error' }) as Res;
}

/** Reserve `qty` of an in-stock product/batch for 15 min (atomic, oversell-proof). */
export const reserveStock = (productId: string, batchId: string | undefined, qty: number, userId: string) =>
  call('ryuma_reserve', { p_product_id: productId, p_batch_id: batchId ?? '', p_qty: qty, p_user_id: userId, p_ttl: 900 });

/** Slip submitted → stop the 15-min timer (hold until admin decides). */
export const payReservation = (id: string) => call('ryuma_reserve_pay', { p_id: id });
/** Admin approved → convert hold to a real sale. */
export const confirmReservation = (id: string) => call('ryuma_reserve_confirm', { p_id: id });
/** Admin rejected / cancelled → return the stock. */
export const releaseReservation = (id: string) => call('ryuma_reserve_release', { p_id: id });
