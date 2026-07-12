import type { Database, SourcingRequest, SourcingTransport } from '../entities';

/**
 * ระบบหาของ helpers — TTL, ETA from the transport config, status buckets. (ryuma-sourcing-spec)
 * TTL: 'quoted' and 'unavailable' live 5 days (expires_at); an expired row is treated as history
 * ("ส่งเช็คใหม่" clones it). Fulfilled requests ('working') ride the created product's lot status.
 */

export const SOURCING_TTL_DAYS = 5;
export const MAX_OPEN_REQUESTS = 3; // ค้างพร้อมกันต่อคน (requested/quoted/paid)

export const sourcingExpired = (r: SourcingRequest, now: Date = new Date()): boolean =>
  (r.status === 'quoted' || r.status === 'unavailable') && !!r.expires_at && new Date(r.expires_at).getTime() < now.getTime();

/** Effective status — maps timed-out quoted/unavailable rows to 'expired' without a write. */
export const sourcingStatusOf = (r: SourcingRequest, now: Date = new Date()) =>
  sourcingExpired(r, now) ? 'expired' : r.status;

/** Days left before a quoted/unavailable row expires (ceil; 0 = last day). */
export function sourcingDaysLeft(r: SourcingRequest, now: Date = new Date()): number | null {
  if (!r.expires_at || (r.status !== 'quoted' && r.status !== 'unavailable')) return null;
  return Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - now.getTime()) / 86400000));
}

/** Rows counted against the 3-open cap: anything still needing action from either side. */
export function openSourcingCount(db: Database, userId: string, now: Date = new Date()): number {
  return db.sourcingRequests.filter((r) => r.user_id === userId
    && ['requested', 'quoted', 'paid'].includes(sourcingStatusOf(r, now))).length;
}

// ── transport ETA config (app_config key 'sourcing_eta') ────────────────────
export interface SourcingEtaConfig { truck_min: number; truck_max: number; ship_min: number; ship_max: number }
const ETA_DEFAULT: SourcingEtaConfig = { truck_min: 7, truck_max: 10, ship_min: 15, ship_max: 25 };

export function sourcingEtaConfig(db: Database): SourcingEtaConfig {
  const row = db.appConfig.find((c) => c.key === 'sourcing_eta');
  return { ...ETA_DEFAULT, ...(row?.value as Partial<SourcingEtaConfig> | undefined) };
}

export function transportRange(db: Database, t: SourcingTransport): { min: number; max: number } {
  const c = sourcingEtaConfig(db);
  return t === 'truck' ? { min: c.truck_min, max: c.truck_max } : { min: c.ship_min, max: c.ship_max };
}

export const transportLabel = (t: SourcingTransport) => (t === 'truck' ? '🚚 รถ' : '🚢 เรือ');

/** ETA line. Before approval: "ประมาณ X-Y วันหลังเริ่มงาน". After (start = approve+1): a date range. */
export function sourcingEtaLabel(db: Database, r: SourcingRequest, now: Date = new Date()): string {
  if (!r.transport) return '';
  const { min, max } = transportRange(db, r.transport);
  if (!r.approved_at) return `ประมาณ ${min}-${max} วันหลังเริ่มงาน`;
  const start = new Date(new Date(r.approved_at).getTime() + 86400000); // เริ่มนับวันถัดไป
  const d = (n: number) => new Date(start.getTime() + n * 86400000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  void now;
  return `คาดว่าถึง ${d(min)} – ${d(max)}`;
}

/** Watchlist rows (still alive): quoted = "ตัดสินใจก่อน", unavailable = "ยังหาไม่ได้". */
export function watchlistOf(db: Database, userId: string, now: Date = new Date()) {
  return db.sourcingRequests
    .filter((r) => r.user_id === userId && (sourcingStatusOf(r, now) === 'quoted' || sourcingStatusOf(r, now) === 'unavailable'))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Requests that expire TODAY (daysLeft 0) — targets for the admin's "เตือนวันสุดท้าย" push button. */
export function expiringToday(db: Database, now: Date = new Date()): SourcingRequest[] {
  return db.sourcingRequests.filter((r) => sourcingDaysLeft(r, now) === 0 && !sourcingExpired(r, now));
}
