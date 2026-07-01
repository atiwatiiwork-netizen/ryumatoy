import type { ShopSettings } from '../entities';

/**
 * ETA for a shipping lot: counts eta_min..eta_max days from the date it left the
 * China warehouse (shipped_at). Returns the arrival date range + days-away, and
 * whether it's "arriving soon" (min-day estimate within 2 days) for admin alerts.
 */
export interface Eta {
  from: Date;
  to: Date;
  daysToMin: number; // whole days until the earliest arrival (can be negative if overdue)
  daysToMax: number;
  arrivingSoon: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function computeEta(settings: ShopSettings, shippedAt?: string): Eta | null {
  if (!shippedAt) return null;
  const start = new Date(shippedAt);
  if (isNaN(start.getTime())) return null;
  const from = new Date(start.getTime() + settings.eta_min_days * DAY);
  const to = new Date(start.getTime() + settings.eta_max_days * DAY);
  const now = Date.now();
  const daysToMin = Math.ceil((from.getTime() - now) / DAY);
  const daysToMax = Math.ceil((to.getTime() - now) / DAY);
  return { from, to, daysToMin, daysToMax, arrivingSoon: daysToMin <= 2 };
}

/** Short Thai date range e.g. "8–11 ก.ค." */
export function etaRangeLabel(eta: Eta): string {
  const opt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${eta.from.toLocaleDateString('th-TH', { day: 'numeric' })}–${eta.to.toLocaleDateString('th-TH', opt)}`;
}

/** "(อีก 3–6 วัน)" or "(ถึงแล้ว/เลยกำหนด)" */
export function etaDaysLabel(eta: Eta): string {
  if (eta.daysToMax < 0) return '(เลยกำหนด)';
  const lo = Math.max(0, eta.daysToMin);
  return lo === eta.daysToMax ? `(อีก ${eta.daysToMax} วัน)` : `(อีก ${lo}–${eta.daysToMax} วัน)`;
}
