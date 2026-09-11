import type { Database, PointLedgerEntry, PreorderTicket } from '../entities';
import { isSourcingTicket } from './money';
import { ticketIsFullPay } from './points';
import { ymOf } from './analytics';

/**
 * รางวัลประจำเดือน "ยศ" — พรีครบ X ใบในเดือนนี้ → ได้ยศ + คะแนนโบนัส (เจ้าของ 2026-09-12)
 *  · ยศ Bronze 5 ใบ → +100 · Silver 10 ใบ → +250 · Gold 20 ใบ → +600
 *  · **ไม่สะสมต่อกัน** (เจ้าของยืนยัน 2026-09-12): ได้ก้อนของ "ยศสูงสุดที่ถึง" ก้อนเดียว — ถึง Gold = 600 ไม่ใช่ 950
 *    ถ้าจ่าย Bronze ไปแล้วกลางเดือน แล้วลูกค้าขึ้น Gold → จ่ายเพิ่มแค่ส่วนต่างให้รวมเป็น 600 (monthlyStatus.due)
 *  · นับ "ใบ" (ชิ้น) ของตั๋วที่ **เกิด** ในเดือนนั้น (approved_at ?? created_at, เวลาเครื่องไทย) — นับใหม่ทุกต้นเดือน
 *  · เจ้าของใบ = original_buyer_id (คนที่พรีจริง) ไม่ใช่ owner_id ปัจจุบัน — กันเคสเซ้งใบ (P2P) แล้วยอดพรีไปโผล่ที่คนรับ
 *  · ค่าเริ่มต้นนับเฉพาะ "ใบพรี" (ticketIsFullPay = false ตาม snapshot ออเดอร์) — เปิดนับพร้อมส่งด้วยได้ · ไม่นับตั๋วหาของ
 *  · โบนัสลงสมุดคะแนน kind 'monthly_reward' · id = pl-month-<ym>-<user>-<pieces>-<seq> (seq = ครั้งที่จ่ายของยศนั้น
 *    ปกติ 0; >0 เฉพาะเมื่อแอดมินขึ้นคะแนนของยศหลังจ่ายไปแล้ว) → กดจ่ายซ้ำในสถานะเดิม = แถวเดิม ไม่จ่ายซ้ำ
 *    จ่ายด้วยปุ่มแอดมิน (payMonthlyRewards) — ไม่ auto เพราะตั๋วในเดือนอาจถูกลบ/แก้ทีหลัง
 *  · เก็บกติกาใน app_config key 'points_monthly' (jsonb → ไม่ต้องรัน migration) แบบเดียวกับ Event ภารกิจ
 * DNA: ทุกหน้าที่โชว์ "ยศ/ยอดพรีเดือน" ต้องเรียกไฟล์นี้ (monthlyStatus / monthlyPieces / tierFor) ห้ามนับเอง
 */

export const MONTHLY_KEY = 'points_monthly';

export interface MonthlyTier { pieces: number; label: string; emoji: string; points: number; perks: string[] }
export interface MonthlyConfig {
  enabled: boolean;          // ลูกค้าเห็นบล็อก "รางวัลประจำเดือน" ไหม (แอดมินเห็นพรีวิวเสมอ) — ต้องเปิดคะแนนสะสมด้วยลูกค้าถึงเห็น
  count: 'pre' | 'all';      // pre = นับเฉพาะใบพรี · all = นับพร้อมส่งด้วย
  tiers: MonthlyTier[];      // เรียงน้อย→มาก, จำนวนใบไม่ซ้ำกัน
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
  let tiers = DEFAULT_MONTHLY.tiers;
  if (Array.isArray(v.tiers) && v.tiers.length) {
    const seen = new Set<number>();
    tiers = v.tiers
      .map((t) => ({
        pieces: Math.max(1, Math.trunc(Number(t.pieces) || 0)),
        label: String(t.label ?? ''),
        emoji: String(t.emoji ?? '🏅'),
        points: Math.max(0, Math.trunc(Number((t as Partial<MonthlyTier>).points) || 0)),
        perks: Array.isArray(t.perks) ? t.perks.map(String) : [],
      }))
      .sort((a, b) => a.pieces - b.pieces)
      // จำนวนใบซ้ำกัน 2 ยศ → id แถวโบนัสชนกัน (ยศหลังจ่ายไม่ได้ตลอดกาล) → เก็บยศแรกของจำนวนนั้น
      .filter((t) => (seen.has(t.pieces) ? false : (seen.add(t.pieces), true)));
  }
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
  if (cfg.count === 'pre' && ticketIsFullPay(db, t)) return false;
  return true;
}
/** เดือนที่ตั๋ว "เกิด" (เวลาเครื่อง = ไทย) */
export const ticketYm = (t: PreorderTicket) => ymOf(t.approved_at ?? t.created_at);
/** คนที่ "พรีจริง" — ตั๋วที่เซ้งต่อ (P2P) ยอดพรีต้องอยู่กับคนสั่ง ไม่ใช่คนรับ */
export const ticketBuyer = (t: PreorderTicket) => t.original_buyer_id || t.owner_id;
const qtyOf = (t: PreorderTicket) => Math.max(1, Math.trunc(t.qty ?? 1) || 1);

/** จำนวนใบ (ชิ้น) ของลูกค้าในเดือน ym */
export function monthlyPieces(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): number {
  return db.tickets
    .filter((t) => ticketBuyer(t) === userId && ticketYm(t) === ym && countsForMonthly(db, cfg, t))
    .reduce((s, t) => s + qtyOf(t), 0);
}

/** ยศที่ถึง / ยศถัดไป / % ความคืบหน้าจากยศก่อน */
export function tierFor(cfg: MonthlyConfig, pieces: number): { reached: MonthlyTier | null; next: MonthlyTier | null; pct: number; need: number } {
  const reached = [...cfg.tiers].reverse().find((t) => pieces >= t.pieces) ?? null;
  const next = cfg.tiers.find((t) => pieces < t.pieces) ?? null;
  const prev = reached?.pieces ?? 0;
  const pct = next ? Math.min(100, ((pieces - prev) / Math.max(1, next.pieces - prev)) * 100) : 100;
  return { reached, next, pct, need: next ? next.pieces - pieces : 0 };
}

// ── โบนัสยศ → สมุดคะแนน (ไม่สะสมต่อกัน) ─────────────────────────────────────────

const refPrefix = (ym: string, userId: string) => `${ym}|${userId}|`;
/** id แถวโบนัส — ตัวเดียวที่ทุกทางต้องใช้ (idempotency key: เดือน+คน+ยศ+ครั้ง) */
export const monthlyRewardId = (ym: string, userId: string, pieces: number, seq = 0) => `pl-month-${ym}-${userId}-${pieces}${seq ? `-${seq}` : ''}`;

/** โบนัสที่จ่ายไปแล้วของเดือนนี้ (ทุกแถว monthly_reward ของ เดือน+คน) */
export function monthlyPaid(db: Database, ym: string, userId: string): number {
  const p = refPrefix(ym, userId);
  return db.pointLedger.filter((e) => e.kind === 'monthly_reward' && e.ref_id?.startsWith(p)).reduce((s, e) => s + e.delta, 0);
}

export interface MonthlyStatus {
  pieces: number;
  top: MonthlyTier | null;   // ยศสูงสุดที่ถึง
  entitled: number;          // คะแนนที่ "ควรได้" = top.points (ก้อนเดียว)
  paid: number;              // จ่ายไปแล้ว
  due: number;               // ยังค้าง = entitled − paid (≥0)
  over: number;              // จ่ายเกิน (ตั๋วถูกลบ/ลดคะแนนยศหลังจ่าย) = paid − entitled (≥0) → แอดมินหักมือ
}
/** สถานะโบนัสเดือน ym ของลูกค้าคนหนึ่ง — หัวใจของทั้งการ์ดลูกค้าและกระดานแอดมิน */
export function monthlyStatus(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyStatus {
  const pieces = monthlyPieces(db, userId, ym, cfg);
  const top = tierFor(cfg, pieces).reached;
  const entitled = top?.points ?? 0;
  const paid = monthlyPaid(db, ym, userId);
  return { pieces, top, entitled, paid, due: Math.max(0, entitled - paid), over: Math.max(0, paid - entitled) };
}

/** แถวโบนัสที่ "ค้างจ่าย" ทั้งเดือน (ให้ปุ่มแอดมินกด) — 1 คน 1 แถว = ส่วนต่างถึงยอดของยศสูงสุด */
export function monthlyRewardRows(db: Database, ym: string, actorId: string, cfg: MonthlyConfig = monthlyConfig(db)): PointLedgerEntry[] {
  const now = new Date().toISOString();
  const out: PointLedgerEntry[] = [];
  for (const r of monthlyBoard(db, ym, cfg)) {
    if (!r.top || r.due <= 0) continue;
    // seq = จำนวนแถวเดิมของยศนี้ (ปกติ 0) → id ใหม่เฉพาะเมื่อยศเดิมถูกจ่ายแล้วแต่คะแนนยศถูกขึ้นทีหลัง
    const base = monthlyRewardId(ym, r.userId, r.top.pieces);
    let seq = 0;
    while (db.pointLedger.some((e) => e.id === monthlyRewardId(ym, r.userId, r.top!.pieces, seq))) seq += 1;
    out.push({
      id: seq ? monthlyRewardId(ym, r.userId, r.top.pieces, seq) : base,
      user_id: r.userId,
      delta: r.due,
      kind: 'monthly_reward',
      ref_type: 'monthly',
      ref_id: `${refPrefix(ym, r.userId)}${r.top.pieces}${seq ? `|${seq}` : ''}`,
      note: `ยศ ${r.top.emoji} ${r.top.label} · ${ymLabel(ym)} · พรี ${r.pieces} ใบ (เกณฑ์ ${r.top.pieces})${r.paid > 0 ? ` · จ่ายเพิ่มจาก ${r.paid} ให้ครบ ${r.entitled}` : ''}`,
      created_by: actorId,
      created_at: now,
    });
  }
  return out;
}

export interface MonthlyRow extends MonthlyStatus { userId: string }
/** กระดานเดือน ym: ใครพรีกี่ใบ ถึงยศไหน โบนัสค้าง/จ่ายแล้ว/จ่ายเกิน — เรียงมาก→น้อย
 *  รวมคนที่ "เคยได้โบนัสเดือนนี้" แม้ตั๋วถูกลบไปหมด (จะโผล่เป็น over) */
export function monthlyBoard(db: Database, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyRow[] {
  const users = new Set<string>();
  for (const t of db.tickets) if (ticketYm(t) === ym && countsForMonthly(db, cfg, t)) users.add(ticketBuyer(t));
  const p = `${ym}|`; // ref_id = ym|user|pieces → กรองด้วยเดือนก่อน แล้วค่อยเอา user_id ของแถว
  for (const e of db.pointLedger) if (e.kind === 'monthly_reward' && e.ref_id?.startsWith(p)) users.add(e.user_id);
  return [...users]
    .map((userId) => ({ userId, ...monthlyStatus(db, userId, ym, cfg) }))
    .sort((a, b) => b.pieces - a.pieces || b.paid - a.paid);
}

/** เดือนที่มีตั๋ว (ใหม่→เก่า) สำหรับตัวเลือกเดือนในแอดมิน */
export function monthsWithTickets(db: Database): string[] {
  const set = new Set<string>();
  for (const t of db.tickets) { const ym = ticketYm(t); if (ym) set.add(ym); }
  set.add(currentYm());
  return [...set].sort().reverse();
}
