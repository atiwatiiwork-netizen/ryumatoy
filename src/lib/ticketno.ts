import { supabase, hasSupabase } from '@/data/supabaseClient';

/**
 * Reserve ticket_no blocks from the server so numbers are globally unique + race-free — fixes the
 * customer-session collision where client-side counting under-counts behind RLS (migration v47).
 *
 * Call these in the UI handler BEFORE dispatching the issuing mutation; pass the returned start map
 * into the mutation (approveOrder / submitOrder / fillMissingTicketsFor). When Supabase isn't
 * configured (seed/preview) they return {} and the mutation falls back to client numbering.
 */

export type TicketNoStart = Record<string, number>; // prefix → first reserved number

/** Reserve a contiguous block for one prefix; returns the FIRST number, or null on seed/failure.
 *  TIMEOUT-bounded (8s): on a bad resume a wedged client's request never settles — an un-bounded
 *  await here froze the CHECKOUT button forever (resume hang #7). Timing out falls back to client
 *  numbering like any other reserve failure. */
export async function reserveTicketBlock(prefix: string, count: number): Promise<number | null> {
  if (!hasSupabase || !supabase || count < 1) return null;
  try {
    const { data, error } = await Promise.race([
      supabase.rpc('reserve_ticket_nos', { p: prefix, c: count }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reserve timed out')), 8000)),
    ]);
    return !error && typeof data === 'number' ? data : null;
  } catch {
    return null; // never let a reserve failure block checkout — the mutation falls back to client numbering
  }
}

/** Reserve start numbers for many prefix→count pairs. Prefixes that fail/aren't configured are simply
 *  omitted, so the mutation falls back to nextTicketNo for those. */
export async function reserveTicketNos(counts: TicketNoStart): Promise<TicketNoStart> {
  const out: TicketNoStart = {};
  for (const [prefix, count] of Object.entries(counts)) {
    const start = await reserveTicketBlock(prefix, count);
    if (start != null) out[prefix] = start;
  }
  return out;
}
