import type { Database, RankName, RankTier, ShopSettings } from '../entities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  RANK PERKS — SINGLE SOURCE OF TRUTH  (โครงสร้าง DNA ของระบบ)
 *  ────────────────────────────────────────────────────────────────────────────
 *  DNA RULE: any place that charges a deposit, prices an item, or gates access
 *  MUST resolve the user's rank through THIS file — never hard-code a perk inline.
 *  Every current & future privilege lives here so the whole app stays consistent:
 *    • deposit perk   → depositForRank() / depositPctForRank()   (Gold pays 50%)
 *    • in-stock disc  → instockPriceFor() / instockDiscount()
 *    • early access   → earlyAccessHoursFor()                    (future "เห็นก่อน")
 *    • one snapshot   → rankPerks()  (all perks for a rank in one object)
 *  When adding a new perk: add it here + surface it via rankPerks(), then read it
 *  from the feature — do not compute rank logic anywhere else.
 * ════════════════════════════════════════════════════════════════════════════
 */

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

/** Deposit actually collected for ONE unit of a purchase line — THE single place that decides
 *  whether the pre-order deposit perk applies. Full-payment lines (in-stock items, or a reopened
 *  batch priced pay-in-full where deposit ≥ price) collect the full amount and get NO rank perk
 *  (there is nothing to reduce). Pre-order lines get depositForRank. DNA: cart / checkout /
 *  submitOrder must all call this so a "พร้อมส่ง จ่ายเต็ม" batch never gets its deposit halved. */
export function lineDepositForRank(settings: ShopSettings, line: { deposit: number; price: number; isStock: boolean }, rank: RankName): number {
  const fullPay = line.isStock || line.deposit >= line.price;
  return fullPay ? line.deposit : depositForRank(settings, line.deposit, rank);
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

/** Early-access window (hours a rank can see/book new items before everyone) — future
 *  "เห็นก่อน" perk. Reads rank_tiers.early_access_hours; 0 = no head start (default now). */
export function earlyAccessHoursFor(db: Database, rank: RankName): number {
  return db.rankTiers.find((t) => t.name === rank)?.early_access_hours ?? 0;
}

/** One snapshot of EVERY perk a rank gets — the unified view of all privileges.
 *  Features should read what they need from here rather than recompute rank logic. */
export function rankPerks(db: Database, settings: ShopSettings, rank: RankName) {
  return {
    rank,
    depositPct: depositPctForRank(settings, rank),        // % of standard deposit paid now
    instockDiscount: instockDiscount(settings, rank),     // buy-now discount (or null)
    earlyAccessHours: earlyAccessHoursFor(db, rank),      // head-start window (future)
  };
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
