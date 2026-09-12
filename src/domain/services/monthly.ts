import type { Database, PointLedgerEntry, PreorderTicket } from '../entities';
import { isSourcingTicket, ticketDue } from './money';
import { ticketIsFullPay } from './points';
import { ymOf } from './analytics';

/**
 * รอบเดือน "ยศ" (Phase 1 — เจ้าของ 2026-09-12 ค่ำ):
 *  · สะสมรายเดือน = ใบพรีที่ร้าน "อนุมัติ" ในเดือนนั้น (approved_at เวลาไทย) นับใหม่ทุกต้นเดือน
 *  · สิ้นเดือน → ระบบปิดเดือนเอง (เซสชันแอดมินแรกของเดือนใหม่ closeMonth — idempotent) → snapshot ต่อคน:
 *      ยศ (Bronze 5 / Silver 10 / Gold 20 ใบ) + "ใบที่ได้รางวัล" = N ใบแรกตามลำดับที่แอดมินอนุมัติ (N = เกณฑ์ยศ)
 *      เช่น Silver 10 ลูกค้ามี 14 → 10 ใบแรกได้ ใบที่ 11-14 ไม่ได้ · share ต่อใบ = คะแนนยศ ÷ เกณฑ์ (Silver 250/10 = 25)
 *  · รางวัลผูกกับใบ: **ตอนปิดใบนั้น (แอดมินอนุมัติส่วนต่าง) ได้ส่วนลดอัตโนมัติ = share** — หักจากหนี้เหมือนคูปอง
 *      บันทึกในสมุดเป็น 2 แถว (+share monthly_reward / −share redeem_remaining) เพื่อดูประวัติ ยอดคงเหลือไม่เปลี่ยน
 *      ใบที่ปิดไปก่อนวันปิดเดือน → ได้เป็นแต้ม +share แทน (ลดย้อนหลังไม่ได้)
 *      ใบที่ถูกเซ้ง (owner ≠ original_buyer) → ไม่ได้ (คนสั่งไม่ได้ปิด คนรับไม่ได้ยศ)
 *  · snapshot เก็บใน app_config key 'points_monthly_closed' → เปลี่ยนกติกาทีหลังไม่กระทบเดือนที่ปิดแล้ว
 *  · เริ่มนับจากเดือน start_ym (ตั้งตอนเปิดใช้) — เดือนก่อนหน้านั้นไม่ปิดย้อนหลัง
 * DNA: ทุกหน้าที่โชว์ยศ/โบนัส ต้องเรียกไฟล์นี้ (monthlyStatus / monthlyBonusForTicket / computeMonthSnapshot) ห้ามนับเอง
 */

export const MONTHLY_KEY = 'points_monthly';
export const MONTHLY_CLOSED_KEY = 'points_monthly_closed';

export interface MonthlyTier { pieces: number; label: string; emoji: string; points: number; perks: string[] }
export interface MonthlyConfig {
  enabled: boolean;          // ลูกค้าเห็นบล็อก "รางวัลประจำเดือน" + ระบบปิดเดือน/ให้ส่วนลด (ต้องเปิดคะแนนสะสมด้วยลูกค้าถึงเห็น)
  count: 'pre' | 'all';      // pre = นับเฉพาะใบพรี · all = นับพร้อมส่งด้วย
  tiers: MonthlyTier[];      // เรียงน้อย→มาก, จำนวนใบไม่ซ้ำกัน
  start_ym?: string;         // เดือนแรกที่นับ (YYYY-MM) — ตั้งอัตโนมัติตอนกดเปิด
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
      // จำนวนใบซ้ำกัน 2 ยศ → เก็บยศแรกของจำนวนนั้น
      .filter((t) => (seen.has(t.pieces) ? false : (seen.add(t.pieces), true)));
  }
  return { enabled: v.enabled === true, count: v.count === 'all' ? 'all' : 'pre', tiers, start_ym: typeof v.start_ym === 'string' && /^\d{4}-\d{2}$/.test(v.start_ym) ? v.start_ym : undefined };
}

/** เดือนปัจจุบัน (local) YYYY-MM */
export const currentYm = (now: Date = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
export const prevYm = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
export const nextYm = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
export const ymLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
};
export const ymShort = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });
};

/** ตั๋วใบนี้นับเข้า "ใบพรี" ของเดือนไหม */
export function countsForMonthly(db: Database, cfg: MonthlyConfig, t: PreorderTicket): boolean {
  if (isSourcingTicket(db, t)) return false;
  if (cfg.count === 'pre' && ticketIsFullPay(db, t)) return false;
  return true;
}
/** เดือนที่ตั๋ว "เกิด" (เวลาเครื่อง = ไทย) = เดือนที่แอดมินอนุมัติ */
export const ticketYm = (t: PreorderTicket) => ymOf(t.approved_at ?? t.created_at);
/** คนที่ "พรีจริง" — ตั๋วที่เซ้งต่อ (P2P) ยอดพรีต้องอยู่กับคนสั่ง ไม่ใช่คนรับ */
export const ticketBuyer = (t: PreorderTicket) => t.original_buyer_id || t.owner_id;
const qtyOf = (t: PreorderTicket) => Math.max(1, Math.trunc(t.qty ?? 1) || 1);
/** ลำดับที่แอดมินอนุมัติ (เก่า→ใหม่) — เท่ากันตัดด้วยเลขตั๋ว ให้ผลคงที่ทุกเครื่อง */
const byApproval = (a: PreorderTicket, b: PreorderTicket) => {
  const ta = a.approved_at ?? a.created_at, tb = b.approved_at ?? b.created_at;
  return ta < tb ? -1 : ta > tb ? 1 : a.ticket_no < b.ticket_no ? -1 : a.ticket_no > b.ticket_no ? 1 : 0;
};

/** ใบของลูกค้าที่นับในเดือน ym เรียงตามลำดับอนุมัติ */
export function monthlyTicketsOf(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): PreorderTicket[] {
  return db.tickets.filter((t) => ticketBuyer(t) === userId && ticketYm(t) === ym && countsForMonthly(db, cfg, t)).sort(byApproval);
}
/** จำนวนใบ (ชิ้น) ของลูกค้าในเดือน ym */
export const monthlyPieces = (db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)) =>
  monthlyTicketsOf(db, userId, ym, cfg).reduce((s, t) => s + qtyOf(t), 0);

/** ยศที่ถึง / ยศถัดไป / % ความคืบหน้าจากยศก่อน */
export function tierFor(cfg: MonthlyConfig, pieces: number): { reached: MonthlyTier | null; next: MonthlyTier | null; pct: number; need: number } {
  const reached = [...cfg.tiers].reverse().find((t) => pieces >= t.pieces) ?? null;
  const next = cfg.tiers.find((t) => pieces < t.pieces) ?? null;
  const prev = reached?.pieces ?? 0;
  const pct = next ? Math.min(100, ((pieces - prev) / Math.max(1, next.pieces - prev)) * 100) : 100;
  return { reached, next, pct, need: next ? next.pieces - pieces : 0 };
}
/** ส่วนแบ่งต่อใบของยศ (ปัดลง) — Silver 250/10 = 25 */
export const sharePerPiece = (tier: MonthlyTier) => Math.floor(tier.points / Math.max(1, tier.pieces));

// ── สถานะสด (เดือนที่ยังไม่ปิด) ───────────────────────────────────────────────
export interface MonthlyStatus { pieces: number; top: MonthlyTier | null; next: MonthlyTier | null; pct: number; need: number; rewardTicketIds: string[] }
/** สถานะเดือน ym ของลูกค้า (คำนวณสด) — ใบที่ "จะ" ได้รางวัลถ้าปิดเดือนตอนนี้ */
export function monthlyStatus(db: Database, userId: string, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyStatus {
  const tickets = monthlyTicketsOf(db, userId, ym, cfg);
  const pieces = tickets.reduce((s, t) => s + qtyOf(t), 0);
  const tf = tierFor(cfg, pieces);
  return { pieces, top: tf.reached, next: tf.next, pct: tf.pct, need: tf.need, rewardTicketIds: tf.reached ? firstN(tickets, tf.reached.pieces) : [] };
}
/** N ใบแรกตามลำดับอนุมัติ (นับชิ้นสะสม: ใบ qty 2 กิน 2 ที่) */
function firstN(sorted: PreorderTicket[], n: number): string[] {
  const out: string[] = [];
  let acc = 0;
  for (const t of sorted) { if (acc >= n) break; out.push(t.id); acc += qtyOf(t); }
  return out;
}

// ── snapshot เดือนที่ปิดแล้ว ───────────────────────────────────────────────────
export interface MonthlySnapUser { tier: MonthlyTier; pieces: number; share: number; tickets: string[] } // share = ต่อชิ้น
export interface MonthlySnapshot { ym: string; closed_at: string; by: string; users: Record<string, MonthlySnapUser> }

export function closedMonths(db: Database): Record<string, MonthlySnapshot> {
  const row = db.appConfig.find((c) => c.key === MONTHLY_CLOSED_KEY);
  const v = (row?.value ?? {}) as Record<string, MonthlySnapshot>;
  return v && typeof v === 'object' ? v : {};
}
export const monthSnapshot = (db: Database, ym: string): MonthlySnapshot | undefined => closedMonths(db)[ym];

/** คำนวณผลเดือน ym จากตั๋วจริง (ใช้ทั้งพรีวิวและตอนปิดเดือน) — เก็บเฉพาะคนที่ถึงยศ */
export function computeMonthSnapshot(db: Database, ym: string, actorId: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlySnapshot {
  const users = new Set<string>();
  for (const t of db.tickets) if (ticketYm(t) === ym && countsForMonthly(db, cfg, t)) users.add(ticketBuyer(t));
  const out: MonthlySnapshot = { ym, closed_at: new Date().toISOString(), by: actorId, users: {} };
  for (const uid of users) {
    const st = monthlyStatus(db, uid, ym, cfg);
    if (!st.top) continue;
    out.users[uid] = { tier: st.top, pieces: st.pieces, share: sharePerPiece(st.top), tickets: st.rewardTicketIds };
  }
  return out;
}

/** เดือนที่ "ควรปิดแล้วแต่ยังไม่ปิด" = ตั้งแต่ start_ym ถึงเดือนก่อนหน้าปัจจุบัน (เก่า→ใหม่) */
export function monthsToClose(db: Database, now: Date = new Date(), cfg: MonthlyConfig = monthlyConfig(db)): string[] {
  if (!cfg.enabled || !cfg.start_ym) return [];
  const closed = closedMonths(db);
  const out: string[] = [];
  const last = prevYm(currentYm(now));
  for (let ym = cfg.start_ym, i = 0; ym <= last && i < 36; ym = nextYm(ym), i++) if (!closed[ym]) out.push(ym);
  return out;
}

// ── โบนัสผูกใบ → ส่วนลดตอนปิดใบ ─────────────────────────────────────────────────
export const mbonusId = (ym: string, ticketId: string) => `pl-mbonus-${ym}-${ticketId}`;       // +share (monthly_reward)
export const mbonusUseId = (ym: string, ticketId: string) => `pl-mbonus-use-${ym}-${ticketId}`; // −share (หักอัตโนมัติจากใบนั้น)

export interface TicketBonus { ym: string; tier: MonthlyTier; amount: number; applied: boolean }
/** โบนัสยศที่ผูกกับใบนี้ (จาก snapshot เดือนที่ปิดแล้ว) — null = ไม่มี · applied = ใช้/ให้ไปแล้ว */
export function monthlyBonusForTicket(db: Database, t: PreorderTicket): TicketBonus | null {
  const ym = ticketYm(t);
  const snap = monthSnapshot(db, ym);
  const u = snap?.users[ticketBuyer(t)];
  if (!u || !u.tickets.includes(t.id)) return null;
  if (t.owner_id !== ticketBuyer(t)) return null; // ใบถูกเซ้ง — คนสั่งไม่ได้ปิด คนรับไม่ได้ยศ
  const amount = u.share * qtyOf(t);
  if (amount <= 0) return null;
  return { ym, tier: u.tier, amount, applied: db.pointLedger.some((e) => e.id === mbonusId(ym, t.id)) };
}
/** ส่วนลดโบนัสที่ "จะได้" ตอนปิดใบนี้ (ยังไม่เคยใช้ + ไม่เกินยอดค้าง) — ใช้ทั้งหน้าจ่ายและตอนอนุมัติ */
export function pendingBonusDiscount(db: Database, t: PreorderTicket): number {
  const b = monthlyBonusForTicket(db, t);
  if (!b || b.applied) return 0;
  return Math.min(b.amount, Math.max(0, ticketDue(t)));
}
/** แถวสมุดคู่ (+/−) เมื่อโบนัสถูกใช้เป็นส่วนลดตอนปิดใบ · หรือแถวเดียว (+) เมื่อให้เป็นแต้ม (ใบปิดไปก่อนปิดเดือน) */
export function bonusRows(db: Database, t: PreorderTicket, mode: 'discount' | 'points', amount: number, actorId: string): PointLedgerEntry[] {
  const b = monthlyBonusForTicket(db, t);
  if (!b || b.applied || amount <= 0) return [];
  const now = new Date().toISOString();
  const label = `ยศ ${b.tier.emoji} ${b.tier.label} ${ymShort(b.ym)} · ${t.ticket_no}`;
  const plus: PointLedgerEntry = { id: mbonusId(b.ym, t.id), user_id: t.owner_id, delta: amount, kind: 'monthly_reward', ref_type: 'ticket', ref_id: t.id,
    note: mode === 'discount' ? `โบนัส${label} (ใช้ลดส่วนต่างใบนี้)` : `โบนัส${label} (ใบปิดไปก่อนปิดเดือน → ได้เป็นแต้ม)`, created_by: actorId, created_at: now };
  if (mode === 'points') return [plus];
  return [plus, { id: mbonusUseId(b.ym, t.id), user_id: t.owner_id, delta: -amount, kind: 'redeem_remaining', ref_type: 'ticket', ref_id: `${t.id}|mbonus`,
    note: `หักอัตโนมัติ — ส่วนลดโบนัส${label}`, created_by: actorId, created_at: now }];
}

// ── กระดานแอดมิน ──────────────────────────────────────────────────────────────
export interface MonthlyRow { userId: string; pieces: number; tier: MonthlyTier | null; rewardCount: number; share: number; used: number; pending: number; closedBefore: number; transferred: number }
/** กระดานเดือน ym: ปิดแล้วอ่านจาก snapshot, ยังไม่ปิดคำนวณสด — เรียงมาก→น้อย */
export function monthlyBoard(db: Database, ym: string, cfg: MonthlyConfig = monthlyConfig(db)): MonthlyRow[] {
  const snap = monthSnapshot(db, ym);
  const users = new Set<string>();
  for (const t of db.tickets) if (ticketYm(t) === ym && countsForMonthly(db, cfg, t)) users.add(ticketBuyer(t));
  if (snap) for (const uid of Object.keys(snap.users)) users.add(uid);
  const rows: MonthlyRow[] = [];
  for (const uid of users) {
    const su = snap?.users[uid];
    const live = monthlyStatus(db, uid, ym, cfg);
    const tier = snap ? (su?.tier ?? null) : live.top;
    const ids = snap ? (su?.tickets ?? []) : live.rewardTicketIds;
    const share = snap ? (su?.share ?? 0) : (live.top ? sharePerPiece(live.top) : 0);
    let used = 0, pending = 0, transferred = 0;
    for (const id of ids) {
      const t = db.tickets.find((x) => x.id === id);
      if (!t) continue;
      if (t.owner_id !== ticketBuyer(t)) { transferred += 1; continue; }
      if (db.pointLedger.some((e) => e.id === mbonusId(ym, id))) used += 1; else pending += 1;
    }
    rows.push({ userId: uid, pieces: snap ? (su?.pieces ?? live.pieces) : live.pieces, tier, rewardCount: ids.length, share, used, pending, closedBefore: 0, transferred });
  }
  return rows.sort((a, b) => b.pieces - a.pieces);
}

/** เดือนที่มีตั๋ว (ใหม่→เก่า) สำหรับตัวเลือกเดือนในแอดมิน */
export function monthsWithTickets(db: Database): string[] {
  const set = new Set<string>();
  for (const t of db.tickets) { const ym = ticketYm(t); if (ym) set.add(ym); }
  for (const ym of Object.keys(closedMonths(db))) set.add(ym);
  set.add(currentYm());
  return [...set].sort().reverse();
}

/** เดือนที่ปิดล่าสุดที่ลูกค้าคนนี้ได้ยศ (สำหรับป้าย "ยศล่าสุด") */
export function latestRankOf(db: Database, userId: string): { ym: string; snap: MonthlySnapUser } | null {
  const months = Object.keys(closedMonths(db)).sort().reverse();
  for (const ym of months) { const u = closedMonths(db)[ym].users[userId]; if (u) return { ym, snap: u }; }
  return null;
}
