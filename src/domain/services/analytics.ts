import type { Database, PreorderTicket } from '../entities';
import { franchiseOf, manufacturerOf } from './catalog';

/**
 * วิเคราะห์รายเดือน — pre-order demand + bell adoption, sliced by month.
 * ยอดใบพรี = จำนวนตั๋วพรีที่ออก (issued after approval). Month keys are LOCAL YYYY-MM (matches the
 * Dashboard's local getMonth() slicing), so a late-night order lands in the same month the shop sees.
 */

export type RankRow = { name: string; tickets: number; pieces: number };

/** LOCAL year-month of an ISO timestamp, e.g. "2026-07". */
export function ymOf(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Current LOCAL year-month. */
export function currentYm(): string {
  return ymOf(new Date().toISOString());
}

/** Tickets issued within a YYYY-MM month. */
export function ticketsInMonth(db: Database, ym: string): PreorderTicket[] {
  return db.tickets.filter((t) => ymOf(t.created_at) === ym);
}

function rankBy(db: Database, tickets: PreorderTicket[], keyOf: (t: PreorderTicket) => string): RankRow[] {
  const m = new Map<string, RankRow>();
  for (const t of tickets) {
    const name = keyOf(t);
    const row = m.get(name) ?? { name, tickets: 0, pieces: 0 };
    row.tickets += 1;
    row.pieces += t.qty || 1;
    m.set(name, row);
  }
  return [...m.values()].sort((a, b) => b.tickets - a.tickets || b.pieces - a.pieces || a.name.localeCompare(b.name));
}

/** ยอดใบพรี จัดกลุ่มตาม เรื่อง (franchise), มากไปน้อย. */
export function topFranchises(db: Database, tickets: PreorderTicket[]): RankRow[] {
  return rankBy(db, tickets, (t) => {
    const p = db.products.find((x) => x.id === t.product_id);
    return (p && franchiseOf(db, p)?.name) || 'ไม่ทราบเรื่อง';
  });
}

/** ยอดใบพรี จัดกลุ่มตาม ค่าย (manufacturer), มากไปน้อย. */
export function topMakers(db: Database, tickets: PreorderTicket[]): RankRow[] {
  return rankBy(db, tickets, (t) => {
    const p = db.products.find((x) => x.id === t.product_id);
    return (p && manufacturerOf(db, p)?.name) || 'ไม่ทราบค่าย';
  });
}

/** Distinct months that carry tickets, newest-first. Always includes the current month (for the picker). */
export function ticketMonths(db: Database): string[] {
  const s = new Set<string>([currentYm()]);
  for (const t of db.tickets) { const ym = ymOf(t.created_at); if (ym) s.add(ym); }
  return [...s].sort().reverse();
}

/**
 * กระดิ่งแจ้งเตือน adoption (NOW snapshot, not monthly): distinct approved members who have at least one
 * push subscription, out of all approved members. Admin accounts are excluded from both sides.
 */
export function bellAdoption(db: Database): { enabled: number; total: number } {
  const adminIds = new Set(db.users.filter((u) => u.is_admin).map((u) => u.id));
  const members = db.users.filter((u) => !u.is_admin && u.approved !== false);
  const memberIds = new Set(members.map((u) => u.id));
  const enabled = new Set(db.pushSubscriptions.map((s) => s.user_id).filter((id) => memberIds.has(id) && !adminIds.has(id)));
  return { enabled: enabled.size, total: members.length };
}

/**
 * ติดตั้งลงหน้าจอ (PWA) adoption (NOW snapshot): approved members who have opened the app at least once in
 * standalone (installed_at stamped), out of all approved members. Admin excluded.
 */
export function installAdoption(db: Database): { installed: number; total: number } {
  const members = db.users.filter((u) => !u.is_admin && u.approved !== false);
  return { installed: members.filter((u) => !!u.installed_at).length, total: members.length };
}
