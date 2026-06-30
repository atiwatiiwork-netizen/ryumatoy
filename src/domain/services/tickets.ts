import type { Database } from '../entities';

/**
 * Ticket number generator — `{abbr}-{year}-{month}-{seq}` (PRD §8).
 * Sequence is per-franchise, per-month, padded to 4 digits.
 */
export function nextTicketNo(db: Database, franchiseAbbr: string, when = new Date()): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const prefix = `${franchiseAbbr.toUpperCase()}-${year}-${month}-`;
  const seq = db.tickets.filter((t) => t.ticket_no.startsWith(prefix)).length + 1;
  return prefix + String(seq).padStart(4, '0');
}

/** % of the full price that has been paid (deposit + remaining paid). */
export function paidPercent(deposit_paid: number, remaining_amount: number, remaining_paid: number): number {
  const total = deposit_paid + remaining_amount;
  if (total <= 0) return 100;
  return Math.round(((deposit_paid + remaining_paid) / total) * 100);
}
