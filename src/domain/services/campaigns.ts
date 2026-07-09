import type { Campaign, CampaignTier, Database } from '../entities';

/**
 * Event/กิจกรรม helpers — the single place that decides how many pre-orders a customer has
 * toward an event and which tier rewards they have earned. (ryuma-event-spec)
 *
 * Counting rule: 1 pre-order ticket = 1 (qty ignored). Only tickets that are NOT a stock round
 * (no batch_id) and were created within the campaign window count. Tiers are CUMULATIVE and LOOP:
 * the top-tier threshold is the "period", so after a customer clears every tier a fresh cycle
 * begins and the thresholds repeat (cycle k requires count ≥ k·top + tier.threshold).
 */

function startOfDay(iso: string): number {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(iso: string): number {
  const d = new Date(iso);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Is a campaign live right now (active flag + within its date window)? */
export function campaignLive(c: Campaign, now: Date = new Date()): boolean {
  if (!c.active) return false;
  const t = now.getTime();
  return t >= startOfDay(c.starts_at) && t <= endOfDay(c.ends_at);
}

/** The single live campaign (v1 allows only one active at a time). Newest first if several qualify. */
export function activeCampaign(db: Database, now: Date = new Date()): Campaign | undefined {
  return [...db.campaigns]
    .filter((c) => campaignLive(c, now))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

/** Tiers sorted by threshold ascending, carrying their original index (used for award keys). */
export function sortedTiers(c: Campaign): { tier: CampaignTier; index: number }[] {
  return c.tiers
    .map((tier, index) => ({ tier, index }))
    .filter((x) => x.tier.threshold > 0)
    .sort((a, b) => a.tier.threshold - b.tier.threshold);
}

/** Top-tier threshold = the loop period. 0 when the campaign has no valid tiers. */
export function topThreshold(c: Campaign): number {
  return c.tiers.reduce((m, t) => Math.max(m, t.threshold || 0), 0);
}

/** How many qualifying pre-order tickets a customer has in this campaign's window. */
export function qualifyingCount(db: Database, c: Campaign, userId: string, now: Date = new Date()): number {
  const from = startOfDay(c.starts_at);
  const to = Math.min(endOfDay(c.ends_at), now.getTime()); // never count into the future
  return db.tickets.filter((t) => {
    if (t.owner_id !== userId) return false;
    if (t.batch_id) return false; // stock round → not a fresh pre-order
    const at = new Date(t.created_at).getTime();
    return at >= from && at <= to;
  }).length;
}

export type EarnedAward = { tierIndex: number; cycle: number; tier: CampaignTier; required: number };

/** Every reward a customer has EARNED (cumulative + loop) at their current count. */
export function earnedAwards(db: Database, c: Campaign, userId: string, now: Date = new Date()): EarnedAward[] {
  const top = topThreshold(c);
  const tiers = sortedTiers(c);
  if (top <= 0 || tiers.length === 0) return [];
  const count = qualifyingCount(db, c, userId, now);
  const minThreshold = tiers[0].tier.threshold;
  const out: EarnedAward[] = [];
  // grow cycles until even the smallest tier of the next cycle is out of reach
  for (let cycle = 0; cycle * top + minThreshold <= count; cycle++) {
    for (const { tier, index } of tiers) {
      const required = cycle * top + tier.threshold;
      if (required <= count) out.push({ tierIndex: index, cycle, tier, required });
    }
  }
  return out;
}

const awardKey = (tierIndex: number, cycle: number) => `${tierIndex}:${cycle}`;

/** Set of "tierIndex:cycle" a customer has already claimed for a campaign. */
export function claimedKeys(db: Database, campaignId: string, userId: string): Set<string> {
  return new Set(
    db.campaignAwards
      .filter((a) => a.campaign_id === campaignId && a.user_id === userId)
      .map((a) => awardKey(a.tier_index, a.cycle)),
  );
}

/** Rewards earned but not yet claimed — what the profile "รับรางวัล" button hands out. */
export function unclaimedAwards(db: Database, c: Campaign, userId: string, now: Date = new Date()): EarnedAward[] {
  const claimed = claimedKeys(db, c.id, userId);
  return earnedAwards(db, c, userId, now).filter((a) => !claimed.has(awardKey(a.tierIndex, a.cycle)));
}

export { awardKey };

/** Progress toward the NEXT reward (smallest required count strictly above the current count). */
export function nextTierProgress(
  db: Database,
  c: Campaign,
  userId: string,
  now: Date = new Date(),
): { count: number; nextRequired: number; need: number; value: number } | null {
  const top = topThreshold(c);
  const tiers = sortedTiers(c);
  if (top <= 0 || tiers.length === 0) return null;
  const count = qualifyingCount(db, c, userId, now);
  const currentCycle = Math.floor(count / top);
  // scan this cycle and the next so we always find a target even right after a cycle rolls over
  for (const cycle of [currentCycle, currentCycle + 1]) {
    for (const { tier } of tiers) {
      const required = cycle * top + tier.threshold;
      if (required > count) return { count, nextRequired: required, need: required - count, value: tier.coupon_value };
    }
  }
  return null;
}

/** Total baht value a customer could still claim right now (for a badge/summary). */
export function unclaimedValue(db: Database, c: Campaign, userId: string, now: Date = new Date()): number {
  return unclaimedAwards(db, c, userId, now).reduce((s, a) => s + a.tier.coupon_value * a.tier.coupon_count, 0);
}
