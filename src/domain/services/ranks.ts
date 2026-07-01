import type { Database, RankName, RankTier, ShopSettings } from '../entities';

/** Rank order low→high. */
export const RANK_ORDER: RankName[] = ['bronze', 'silver', 'gold', 'diamond', 'legend'];
export const rankIndex = (r: RankName) => RANK_ORDER.indexOf(r);

/** Pieces (qty) a user has accumulated — counts APPROVED orders only (pre-order + in-stock). */
export function rankPiecesOf(db: Database, userId: string): number {
  return db.orders
    .filter((o) => o.user_id === userId && o.status === 'approved')
    .reduce((s, o) => s + o.items.reduce((n, i) => n + i.qty, 0), 0);
}

/** Rank a user is ELIGIBLE for by pieces (capped at Gold this round; D/L deferred). */
export function eligibleRank(settings: ShopSettings, pieces: number): RankName {
  if (pieces >= settings.rank_gold_pieces) return 'gold';
  if (pieces >= settings.rank_silver_pieces) return 'silver';
  return 'bronze';
}

/** Next rank up + pieces still needed (null when Gold or above this round). */
export function nextRankInfo(settings: ShopSettings, current: RankName, pieces: number): { next: RankName; target: number; need: number } | null {
  if (rankIndex(current) < rankIndex('silver')) return { next: 'silver', target: settings.rank_silver_pieces, need: Math.max(0, settings.rank_silver_pieces - pieces) };
  if (rankIndex(current) < rankIndex('gold')) return { next: 'gold', target: settings.rank_gold_pieces, need: Math.max(0, settings.rank_gold_pieces - pieces) };
  return null;
}

/** % of the standard deposit this rank pays (100 = full, 50 = half, 0 = none). */
export function depositPctForRank(settings: ShopSettings, rank: RankName): number {
  if (rank === 'gold') return settings.rank_gold_deposit_pct;
  if (rank === 'diamond' || rank === 'legend') return 0;
  return 100; // bronze / silver
}

/** Deposit amount for a rank given the standard deposit (no rounding — total price unchanged). */
export function depositForRank(settings: ShopSettings, baseDeposit: number, rank: RankName): number {
  return (baseDeposit * depositPctForRank(settings, rank)) / 100;
}

/** In-stock discount for a rank (Gold+ only this round). Returns null when none. */
export function instockDiscount(settings: ShopSettings, rank: RankName): { type: 'percent' | 'baht'; value: number } | null {
  if (rank === 'gold' && settings.instock_disc_gold_value > 0) return { type: settings.instock_disc_gold_type, value: settings.instock_disc_gold_value };
  return null;
}

/** Apply a rank's in-stock discount to a price (floored at 0). */
export function instockPriceFor(settings: ShopSettings, rank: RankName, price: number): number {
  const d = instockDiscount(settings, rank);
  if (!d) return price;
  const off = d.type === 'percent' ? (price * d.value) / 100 : d.value;
  return Math.max(0, price - off);
}

/** Rank helpers — auto-upgrade on total_spent, never downgrade (PRD §13). */

export function rankFor(db: Database, totalSpent: number): RankName {
  const sorted = [...db.rankTiers].sort((a, b) => b.min_spend - a.min_spend);
  return sorted.find((t) => totalSpent >= t.min_spend)?.name ?? 'bronze';
}

export function tierOf(db: Database, name: RankName): RankTier | undefined {
  return db.rankTiers.find((t) => t.name === name);
}

/** The next tier up and the spend needed to reach it (null when at top). */
export function nextTier(db: Database, name: RankName): { tier: RankTier; remaining: number } | null {
  const current = tierOf(db, name);
  if (!current) return null;
  const up = db.rankTiers
    .filter((t) => t.min_spend > current.min_spend)
    .sort((a, b) => a.min_spend - b.min_spend)[0];
  return up ? { tier: up, remaining: up.min_spend } : null;
}
