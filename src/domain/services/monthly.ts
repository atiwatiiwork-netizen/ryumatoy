import type { Database, PointLedgerEntry, PreorderTicket } from '../entities';
import { isSourcingTicket } from './money';
import { ticketIsFullPay } from './points';
import { ymOf } from './analytics';

/**
 * รางวัลประจำเดือน "ยศ" — พรีครบ X ใบในเดือนนี้ → ได้ยศ + คะแนนโบนัส (เจ้าของ 2026-09-12 ปรับ wording/กติกา)
 *  · ยศ Bronze 5 ใบ → +100 · Silver 10 ใบ → +250 · Gold 20 ใบ → +600 (สะสมต่อกัน: ถึง Gold = ได้ทั้ง 3 ก้อน)
 *  · นับ "ใบ" (ชิ้น) ของตั๋วที่เกิดในเดือนนั้น (approved_at ?? created_at) — รีเซ็ตทุกต้นเดือน
 *  · ค่าเริ่มต้นนับเฉพาะ "ใบพรี" — เปิดนับพร้อมส่งด้วยได้จากตั้งค่า · ไม่นับตั๋วหาของ
 *  · โบนัสลงสมุดคะแนนเป็นแถว kind 'monthly_reward' id = pl-month-<ym>-<user>-<pieces> → จ่ายซ้ำไม่ได้ (idempotent)
 *    จ่ายด้วยปุ่มแอดมิน "จ่ายรางวัลเดือนนี้" (payMonthlyRewards) — ไม่ auto เพราะตั๋วในเดือนอาจถูกลบ/แก้ทีหลัง
 *  · เก็บกติกาใน app_config key 'points_monthly' (jsonb → ไม่ต้องรัน migration) แบบเดียวกับ Event ภารกิจ
 * DNA: ทุกหน้าที่โชว์ "ยศ" ต้องเรียกไฟล์นี้ (tierFor / monthlyPieces) ห้ามนับเอง
 */

export const MONTHLY_KEY = 'points_monthly';

export interface MonthlyTier { pieces: number; label: string; emoji: string; points: number; perks: string[] }
export interface MonthlyConfig {
  enabled: boolean;          // ลูกค้าเห็นบล็อก "รางวัลประจำเดือน" ไหม (แอดมินเห็นพรีวิวเสมอ)
  count: 'pre' | 'all';      // pre = นับเฉพาะใบพรี · all = นับพร้อมส่งด้วย
  tiers: MonthlyTier[];      // เรียงน้อย→มาก
}

export const DEFAULT_MONTHLY: MonthlyConfig = {
  enabled: false,
  count: 'pre',
  tiers: [
    { pieces: 5, label: 'Bronze', emoji: '🥉', points: 100, perks: [] },
    { pieces: 10, label: 'Silver', emoji: '🥈', points: 250, perks: [] },
    { pieces: 20, label: 'Gold', emoji: '🥇', points: 600, perks: [] },
  ],
};

export function monthlyConfig(db: Database): MonthlyConfig {
  const row = db.appConfig.find((c) => c.key === MONTHLY_KEY);
  const v = (row?.value ?? {}) as Partial<MonthlyConfig>;
  const tiers = Array.isArray(v.tiers) && v.tiers.length
    ? v.tiers
        .map((t) => ({
          pieces: Math.max(1, Math.trunc(Number(t.pieces) || 0)),
          label: String(t.label ?? ''),
          emoji: String(t.emoji ?? '🏅'),
          points: Math.max(0, Math.trunc(Number((t as Partial<MonthlyTier>).points) || 0)),
          perks: Array.isArray(t.perks) ? t.perks.map(String) : [],
        }))
        .sort((a, b) => a.pieces - b.pieces)
    : DEFAULT_MONTHLY.tiers;
  return { enabled: v.enabled === true, count: v.count === 'all' ? 'all' : 'pre', tiers };
}

/** เดือนปัจจุบัน (local) YYYY-MM */
export const currentYm = (now: Date = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
export const ymLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
};

/** ตั๋วใบนี้นับเข้า "ใบพรี" ของเดือนไหม */
export function countsForMonthly(db: Database, cfg: MonthlyConfig, t: PreorderTicket): boolean {
  if (isSourcingTicket(db, t)) return false;
  if (cfg.count === 'pre' && ticketIsFullPay(t)) return false;
  return true;
}
export const ticketYm = (t: PreorderTicket) => ymOf(t.approved_at ?? t.created_at);

/** จำนวนใบ (ชิ้น) ของลูกค้าในเดือน ym */
export function monthlyPieces(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): number {
  return db.tickets
    .filter((t) => t.owner_id === userId && ticketYm(t) === ym && countsForMonthly(db, cfg, t))
    .reduce((s, t) => s + Math.max(1, t.qty ?? 1), 0);
}

/** ยศที่ถึง / ยศถัดไป / % ความคืบหน้าจากยศก่อน */
export function tierFor(cfg: MonthlyConfig, pieces: number): { reached: MonthlyTier | null; next: MonthlyTier | null; pct: number; need: number } {
  const reached = [...cfg.tiers].reverse().find((t) => pieces >= t.pieces) ?? null;
  const next = cfg.tiers.find((t) => pieces < t.pieces) ?? null;
  const prev = reached?.pieces ?? 0;
  const pct = next ? Math.min(100, ((pieces - prev) / Math.max(1, next.pieces - prev)) * 100) : 100;
  return { reached, next, pct, need: next ? next.pieces - pieces : 0 };
}

// ── โบนัสยศ → สมุดคะแนน ────────────────────────────────────────────────────────

/** id แถวโบนัส — ตัวเดียวที่ทุกทางต้องใช้ (idempotency key: เดือน+คน+ยศ) */
export const monthlyRewardId = (ym: string, userId: string, pieces: number) => `pl-month-${ym}-${userId}-${pieces}`;
export const monthlyRewardPaid = (db: Database, ym: string, userId: string, pieces: number) =>
  db.pointLedger.some((e) => e.id === monthlyRewardId(ym, userId, pieces));

/** โบนัสที่ลูกค้าคนนี้ "ถึงแล้ว" ในเดือน ym (ทุกยศที่ผ่าน — สะสมต่อกัน) พร้อมสถานะจ่าย */
export function monthlyRewardsFor(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): { tier: MonthlyTier; paid: boolean }[] {
  const pieces = monthlyPieces(db, userId, ym, cfg);
  return cfg.tiers.filter((t) => pieces >= t.pieces && t.points > 0).map((tier) => ({ tier, paid: monthlyRewardPaid(db, ym, userId, tier.pieces) }));
}

/** แถวโบนัสที่ "ค้างจ่าย" ทั้งเดือน (ให้ปุ่มแอดมินกด) */
export function monthlyRewardRows(db: Database, ym: string, actorId: string, cfg: MonthlyConfig = monthlyConfig(db)): PointLedgerEntry[] {
  const now = new Date().toISOString();
  const out: PointLedgerEntry[] = [];
  for (const r of monthlyBoard(db, ym, cfg)) {
    for (const { tier, paid } of monthlyRewardsFor(db, r.userId, ym, cfg)) {
      if (paid) continue;
      out.push({
        id: monthlyRewardId(ym, r.userId, tier.pieces),
        user_id: r.userId,
        delta: tier.points,
        kind: 'monthly_reward',
        ref_type: 'monthly',
        ref_id: `${ym}|${r.userId}|${tier.pieces}`,
        note: `ยศ ${tier.emoji} ${tier.label} · ${ymLabel(ym)} · พรี ${r.pieces} ใบ (เกณฑ์ ${tier.pieces})`,
        created_by: actorId,
        created_at: now,
      });
    }
  }
  return out;
}

export interface MonthlyRow { userId: string; pieces: number; tier: MonthlyTier | null; due: number; paid: number }
/** กระดานเดือน ym: ใครพรีกี่ใบ ถึงยศไหน โบนัสค้าง/จ่ายแล้วเท่าไร — เรียงมาก→น้อย */
export function monthlyBoard(db: Database, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyRow[] {
  const m = new Map<string, number>();
  for (const t of db.tickets) {
    if (ticketYm(t) !== ym || !countsForMonthly(db, cfg, t)) continue;
    m.set(t.owner_id, (m.get(t.owner_id) ?? 0) + Math.max(1, t.qty ?? 1));
  }
  return [...m.entries()]
    .map(([userId, pieces]) => {
      const reached = cfg.tiers.filter((t) => pieces >= t.pieces);
      const paid = reached.filter((t) => monthlyRewardPaid(db, ym, userId, t.pieces)).reduce((s, t) => s + t.points, 0);
      const due = reached.filter((t) => !monthlyRewardPaid(db, ym, userId, t.pieces)).reduce((s, t) => s + t.points, 0);
      return { userId, pieces, tier: tierFor(cfg, pieces).reached, due, paid };
    })
    .sort((a, b) => b.pieces - a.pieces);
}

/** เดือนที่มีตั๋ว (ใหม่→เก่า) สำหรับตัวเลือกเดือนในแอดมิน */
export function monthsWithTickets(db: Database): string[] {
  const set = new Set<string>();
  for (const t of db.tickets) { const ym = ticketYm(t); if (ym) set.add(ym); }
  set.add(currentYm());
  return [...set].sort().reverse();
}
