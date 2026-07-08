import type { Database, User } from '../entities';

/** Member helpers — dormant-account detection (กันสปาย). */

export const DORMANT_DAYS = 30;

/**
 * "สมาชิกเงียบ": approved 30+ days ago (proxied by signup date — admin approves within hours),
 * still holds NO ticket and has NEVER placed an order. A competitor account made just to browse
 * the members-only catalog looks exactly like this → surfaced for the admin to suspend.
 */
export function dormantNewMembers(db: Database, days = DORMANT_DAYS, now: Date = new Date()): User[] {
  const cutoff = now.getTime() - days * 86400000;
  return db.users.filter((u) =>
    !u.is_admin && u.id !== 'u-admin'
    && u.approved !== false && u.suspended !== true
    && !!u.created_at && new Date(u.created_at).getTime() <= cutoff
    && !db.tickets.some((t) => t.owner_id === u.id)
    && !db.orders.some((o) => o.user_id === u.id),
  ).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')); // oldest signup first (most suspicious)
}

/** Currently suspended members (for the admin list + unsuspend). */
export function suspendedMembers(db: Database): User[] {
  return db.users.filter((u) => u.suspended === true && !u.is_admin);
}

/** Days since signup — for the dormant list display. */
export function daysSinceSignup(u: User, now: Date = new Date()): number {
  return u.created_at ? Math.floor((now.getTime() - new Date(u.created_at).getTime()) / 86400000) : 0;
}
