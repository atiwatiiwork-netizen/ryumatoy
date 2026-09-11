import type { Database, PreorderTicket } from '../entities';
import { isSourcingTicket } from './money';
import { ticketIsFullPay } from './points';
import { ymOf } from './analytics';

/**
 * รางวัลรายเดือน — "พรีครบ X ชิ้นในเดือนนี้ → ได้ด่าน/สิทธิ์" (เจ้าของ 2026-09-12, แท็บใน /admin/points)
 *  · นับ "ชิ้น" ของตั๋วที่เกิดในเดือนนั้น (approved_at ?? created_at) — ไม่ใช่คะแนน, ไม่ใช่บาท
 *    เพราะกำไรร้าน fix ต่อชิ้น → ความขยันซื้อวัดเป็นชิ้นตรงที่สุด และรีเซ็ตทุกเดือน (เกมรอบเดือน)
 *  · ค่าเริ่มต้นนับเฉพาะ "ใบพรี" (ยอดพรี) — เปิดนับพร้อมส่งด้วยได้จากตั้งค่า
 *  · ไม่นับตั๋วหาของ (เงินอยู่ฝั่งหาของ)
 *  · รางวัล = สิทธิ์ (ไม่ใช่เงิน — ตกลง 2026-09-10) แอดมินเห็นใครถึงด่านแล้วจัดให้ · เฟสนี้ยังไม่บังคับใช้อัตโนมัติ
 *  · เก็บกติกาใน app_config key 'points_monthly' (jsonb → ไม่ต้องรัน migration) แบบเดียวกับ Event ภารกิจ
 * DNA: ทุกหน้าที่โชว์ "ด่านรายเดือน" ต้องเรียกไฟล์นี้ (tierFor / monthlyPieces) ห้ามนับเอง
 */

export const MONTHLY_KEY = 'points_monthly';

export interface MonthlyTier { pieces: number; label: string; emoji: string; perks: string[] }
export interface MonthlyConfig {
  enabled: boolean;          // ลูกค้าเห็นบล็อก "รางวัลรายเดือน" ไหม (แอดมินเห็นพรีวิวเสมอ)
  count: 'pre' | 'all';      // pre = นับเฉพาะใบพรี · all = นับพร้อมส่งด้วย
  tiers: MonthlyTier[];      // เรียงน้อย→มาก
}

export const DEFAULT_MONTHLY: MonthlyConfig = {
  enabled: false,
  count: 'pre',
  tiers: [
    { pieces: 5, label: 'นักสะสม', emoji: '🥉', perks: ['ป้ายในโปรไฟล์', 'เห็นรอบใหม่ก่อน 3 ชม.'] },
    { pieces: 10, label: 'ขาประจำ', emoji: '🥈', perks: ['เพดานของ hot 3 ตัว/คน', 'เห็นรอบใหม่ก่อน 6 ชม.'] },
    { pieces: 20, label: 'ตำนาน', emoji: '🥇', perks: ['จองของพร้อมส่งก่อน 24 ชม.', 'คิวส่งมอบก่อน', 'ป้ายพิเศษ'] },
  ],
};

export function monthlyConfig(db: Database): MonthlyConfig {
  const row = db.appConfig.find((c) => c.key === MONTHLY_KEY);
  const v = (row?.value ?? {}) as Partial<MonthlyConfig>;
  const tiers = Array.isArray(v.tiers) && v.tiers.length
    ? v.tiers
        .map((t) => ({ pieces: Math.max(1, Math.trunc(Number(t.pieces) || 0)), label: String(t.label ?? ''), emoji: String(t.emoji ?? '🏅'), perks: Array.isArray(t.perks) ? t.perks.map(String) : [] }))
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

/** ตั๋วใบนี้นับเข้า "ยอดพรี" ของเดือนไหม */
export function countsForMonthly(db: Database, cfg: MonthlyConfig, t: PreorderTicket): boolean {
  if (isSourcingTicket(db, t)) return false;
  if (cfg.count === 'pre' && ticketIsFullPay(t)) return false;
  return true;
}
export const ticketYm = (t: PreorderTicket) => ymOf(t.approved_at ?? t.created_at);

/** จำนวนชิ้นของลูกค้าในเดือน ym */
export function monthlyPieces(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): number {
  return db.tickets
    .filter((t) => t.owner_id === userId && ticketYm(t) === ym && countsForMonthly(db, cfg, t))
    .reduce((s, t) => s + Math.max(1, t.qty ?? 1), 0);
}

/** ด่านที่ถึง / ด่านถัดไป / % ความคืบหน้าจากด่านก่อน */
export function tierFor(cfg: MonthlyConfig, pieces: number): { reached: MonthlyTier | null; next: MonthlyTier | null; pct: number; need: number } {
  const reached = [...cfg.tiers].reverse().find((t) => pieces >= t.pieces) ?? null;
  const next = cfg.tiers.find((t) => pieces < t.pieces) ?? null;
  const prev = reached?.pieces ?? 0;
  const pct = next ? Math.min(100, ((pieces - prev) / Math.max(1, next.pieces - prev)) * 100) : 100;
  return { reached, next, pct, need: next ? next.pieces - pieces : 0 };
}

export interface MonthlyRow { userId: string; pieces: number; tier: MonthlyTier | null }
/** กระดานเดือน ym: ใครพรีกี่ชิ้น ถึงด่านไหน — เรียงมาก→น้อย */
export function monthlyBoard(db: Database, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyRow[] {
  const m = new Map<string, number>();
  for (const t of db.tickets) {
    if (ticketYm(t) !== ym || !countsForMonthly(db, cfg, t)) continue;
    m.set(t.owner_id, (m.get(t.owner_id) ?? 0) + Math.max(1, t.qty ?? 1));
  }
  return [...m.entries()]
    .map(([userId, pieces]) => ({ userId, pieces, tier: tierFor(cfg, pieces).reached }))
    .sort((a, b) => b.pieces - a.pieces);
}

/** เดือนที่มีตั๋ว (ใหม่→เก่า) สำหรับตัวเลือกเดือนในแอดมิน */
export function monthsWithTickets(db: Database): string[] {
  const set = new Set<string>();
  for (const t of db.tickets) { const ym = ticketYm(t); if (ym) set.add(ym); }
  set.add(currentYm());
  return [...set].sort().reverse();
}
