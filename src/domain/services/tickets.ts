import type { Database } from '../entities';

/**
 * Ticket number generator — `{abbr}-{year}-{month}-{seq}` (PRD §8).
 * Sequence is per-franchise, per-month, padded to 4 digits.
 */
export function nextTicketNo(db: Database, franchiseAbbr: string, when = new Date(), pending: { ticket_no: string }[] = []): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const prefix = `${franchiseAbbr.toUpperCase()}-${year}-${month}-`;
  // count issued tickets PLUS ones being created in this same batch (pending) — otherwise two tickets
  // of the same franchise issued in one approveOrder collide (ticket_no is UNIQUE in the DB → the
  // second insert fails → later tickets never persist → they vanish from the customer's wallet).
  const seq = [...db.tickets, ...pending].filter((t) => t.ticket_no.startsWith(prefix)).length + 1;
  return prefix + String(seq).padStart(4, '0');
}

/**
 * APPROVED-order items that have no matching ticket — the "จ่ายแล้วตั๋วหาย" detector.
 * A ticket matches an item on owner + product + variant + batch, and each ticket satisfies at most
 * one item (same greedy matching repairTickets uses). Non-atomic multi-table flushes (a mobile
 * customer backgrounding the app mid-save on a Diamond auto-approve) can persist the order but not
 * its tickets; this finds those splits. `userId` narrows to one customer (self-heal).
 */
export function unmatchedApprovedItems(db: Database, userId?: string): { order: Database['orders'][number]; item: Database['orders'][number]['items'][number] }[] {
  const used = new Set<string>();
  const key = (a?: string) => a ?? null;
  const out: { order: Database['orders'][number]; item: Database['orders'][number]['items'][number] }[] = [];
  for (const order of db.orders) {
    if (order.status !== 'approved') continue;
    if (userId && order.user_id !== userId) continue;
    for (const item of order.items) {
      const match = db.tickets.find((t) =>
        !used.has(t.id) && t.owner_id === order.user_id && t.product_id === item.product_id &&
        key(t.variant_id) === key(item.variant_id) && key(t.batch_id) === key(item.batch_id));
      if (match) used.add(match.id);
      else out.push({ order, item });
    }
  }
  return out;
}

/** % of the full price that has been paid (deposit + remaining paid). */
export function paidPercent(deposit_paid: number, remaining_amount: number, remaining_paid: number): number {
  const total = deposit_paid + remaining_amount;
  if (total <= 0) return 100;
  return Math.round(((deposit_paid + remaining_paid) / total) * 100);
}
