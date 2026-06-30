import type { Database, RankName, RankTier } from '../entities';

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
