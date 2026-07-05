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

/** % of the full price that has been paid (deposit + remaining paid). */
export function paidPercent(deposit_paid: number, remaining_amount: number, remaining_paid: number): number {
  const total = deposit_paid + remaining_amount;
  if (total <= 0) return 100;
  return Math.round(((deposit_paid + remaining_paid) / total) * 100);
}
