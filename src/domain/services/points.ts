import type { Database, OrderItem, PointLedgerEntry, PreorderTicket, ShopSettings } from '../entities';
import { ticketPaid, ticketDue, isSourcingTicket } from './money';
import { orderOfTicket } from './journey';
import { isAdminUser } from './admins';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  POINTS — SINGLE SOURCE OF TRUTH ของระบบคะแนนสะสม (ryuma-points-spec, migration v66)
 *  ────────────────────────────────────────────────────────────────────────────
 *  DNA RULE: ทุกที่ที่ "คิด/ให้/ใช้/โชว์" คะแนน ต้องเรียกไฟล์นี้ ห้ามคำนวณเองในหน้าจอ.
 *
 *  กติกา (เจ้าของ 2026-09-10/11):
 *   · คะแนน **คงที่ต่อชิ้น** ไม่ใช่ % ของราคา — เพราะกำไรร้าน fix 200-250/ชิ้น ไม่ขึ้นกับราคาของ
 *     (สูตรตามราคาทำให้ของ 4,000 กิน 20% ของกำไร แต่ของ 800 กินแค่ 4% — ไม่ยุติธรรมกับร้าน)
 *     ใบพรี/รอบพิเศษ = points_per_piece_pre (20 ≈ 10% ของกำไร) · พร้อมส่ง/จ่ายเต็ม = points_per_piece_instock (30)
 *   · ได้คะแนน "ครั้งเดียว" ตอนตั๋วปิดยอด (ticketDue = 0) — ใบพรีได้ตอนส่วนต่างงวดสุดท้ายถูกอนุมัติ,
 *     พร้อมส่ง/จ่ายเต็มได้ตอนอนุมัติออเดอร์ (ตั๋วเกิดมาปิดยอดแล้ว) — **ไม่ให้ตอนมัดจำ**
 *   · × qty ของตั๋ว (ตั๋ว 1 ใบ 2 ชิ้น = 2 เท่า)
 *   · ไม่ให้: ตั๋วหาของ (เงินอยู่ฝั่งหาของ) · ออเดอร์จ่ายค่าประมูล (เฟสหน้า)
 *   · Milestone 500/1,000/2,000 นับ "สะสมตลอดชีพ" (ผลรวมแถวบวก) ไม่ถอย รางวัล = สิทธิ์ ไม่ใช่เงิน
 *     ที่ 20/ชิ้น → 500 = 25 ชิ้น · 1,000 = 50 ชิ้น (= เกณฑ์ Gold) · 2,000 = 100 ชิ้น
 *
 *  กันบั๊ก (บทเรียนคูปอง orphan v38/v39 + ตั๋วซ้ำ Mongkol):
 *   · id แถว earn ผูกตั๋ว (earnIdFor) → อนุมัติซ้ำ/เซฟล้มส่งซ้ำ = แถวเดิม · DB มี unique(kind, ref_id) อีกชั้น
 *   · แถวคะแนนเกิดใน mutation เดียวกับการอนุมัติ (ไม่ใช่ effect แยก) → ไม่มี "ปิดยอดแล้วแต่คะแนนไม่มา"
 *   · ลูกค้าเขียน point_ledger ไม่ได้เลย (RLS) → ปั้นคะแนนเองไม่ได้
 * ════════════════════════════════════════════════════════════════════════════
 */

/** id แถว "ได้คะแนน" ของตั๋วใบนี้ — ตัวเดียวที่ทุกทางต้องใช้ (idempotency key) */
export const earnIdFor = (ticketId: string) => `pl-earn-${ticketId}`;
export const reverseIdFor = (ticketId: string) => `pl-rev-${ticketId}`;

/** ตั๋ว "จ่ายเต็มตั้งแต่เกิด" (พร้อมส่ง / รอบจ่ายเต็ม) → ใช้อัตราพร้อมส่ง + ไม่นับเป็น "ใบพรี" รายเดือน.
 *  ตัดสินจาก **snapshot ของรายการในออเดอร์** (unit_deposit ≥ unit_price) ไม่ใช่สภาพตั๋วปัจจุบัน — เพราะ
 *   · คูปองที่ครอบส่วนต่างทั้งก้อน / แอดมินแก้มัดจำเป็นเต็มราคา ทำให้ remaining_amount กลายเป็น 0 ทีหลัง
 *     (audit 2026-09-12: ใบพรีจริงถูกตีเป็น "พร้อมส่ง" → ได้ 30 แทน 20 และหลุดจากยอดพรีรายเดือน)
 *   · ห้ามดู product.is_stock: SKU พรีที่ถูก convert เป็นพร้อมส่งทีหลัง จะทำให้ตั๋วพรีเก่าถูกตีเป็นพร้อมส่ง
 *  ตั๋วมอบ/legacy (ไม่มีรายการออเดอร์คู่): จ่ายเต็ม = ไม่มีส่วนต่างตั้งแต่เกิด และไม่เคยมีสลิปส่วนต่านอนุมัติ */
export function ticketIsFullPay(db: Database, t: PreorderTicket): boolean {
  if (t.id.startsWith('t-')) {
    const it = orderItemIndex(db).get(t.id.slice(2));
    if (it && it.unit_price != null && it.unit_deposit != null) return it.unit_deposit >= it.unit_price;
    // แถวรุ่นเก่าไม่มี snapshot → ใช้ fallback ด้านล่าง
  }
  return (t.remaining_amount ?? 0) === 0 && (t.remaining_paid ?? 0) === 0
    && !db.remainingPayments.some((r) => r.ticket_id === t.id && r.status === 'approved');
}

/** ดัชนี order_item ตาม id — แคชต่อ db (WeakMap) เพราะ ticketIsFullPay ถูกเรียกต่อตั๋ว×ต่อคนในกระดาน/จำลอง
 *  (ไล่สแกน orders ทุกครั้ง = O(ตั๋ว×ออเดอร์×คน) หน้าแอดมินจะหน่วงเมื่อร้านโต) */
const itemIndexCache = new WeakMap<Database, Map<string, OrderItem>>();
function orderItemIndex(db: Database): Map<string, OrderItem> {
  let m = itemIndexCache.get(db);
  if (!m) {
    m = new Map();
    for (const o of db.orders) for (const it of o.items) m.set(it.id, it);
    itemIndexCache.set(db, m);
  }
  return m;
}

/** อัตราคะแนนต่อชิ้น (พรี / พร้อมส่ง) — ตัวเดียวที่หน้าจอใช้โชว์ตัวเลข.
 *  fallback 20/30 เมื่อ settings มาจากสแนปช็อตเก่าที่ยังไม่มีคีย์ (กัน NaN/0 เงียบๆ) */
export function pointsRates(settings: ShopSettings): { pre: number; instock: number } {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : d);
  return { pre: n(settings.points_per_piece_pre, 20), instock: n(settings.points_per_piece_instock, 30) };
}

/** อัตราคะแนนต่อชิ้นของตั๋วใบนี้ */
export function ratePerPiece(db: Database, t: PreorderTicket): number {
  const r = pointsRates(db.settings);
  return ticketIsFullPay(db, t) ? r.instock : r.pre;
}

/** คะแนน "เต็มใบ" ตามสูตร (ไม่ดูเกณฑ์/ปิดยอด) — ใช้โชว์ "จะได้เมื่อปิดยอด" */
export const rawPointsForTicket = (db: Database, t: PreorderTicket) => ratePerPiece(db, t) * Math.max(1, t.qty ?? 1);

/** ตั๋วใบนี้ "ปิดยอดแล้ว" (จ่ายครบ + มีเงินจริง) */
export const ticketClosed = (t: PreorderTicket) => ticketDue(t) === 0 && ticketPaid(t) > 0;

/** ตั๋วใบนี้เข้าเกณฑ์ได้คะแนนไหม (ไม่ดูว่าเคยได้แล้วหรือยัง) — ตัวชี้ขาดตัวเดียว */
export function ticketEarnEligible(db: Database, t: PreorderTicket): { ok: boolean; why?: string } {
  if (!ticketClosed(t)) return { ok: false, why: 'ยังไม่ปิดยอด' };
  if (isSourcingTicket(db, t)) return { ok: false, why: 'ตั๋วหาของ (ไม่ให้เฟสนี้)' };
  // ออเดอร์ที่เป็นตัวจ่ายค่าประมูล (v61) — คะแนนประมูลค่อยว่ากันเฟสหน้า
  if (t.id.startsWith('t-')) {
    const itemId = t.id.slice(2);
    const order = db.orders.find((o) => o.items.some((i) => i.id === itemId));
    if (order && db.auctions.some((a) => a.pay_order_id === order.id)) return { ok: false, why: 'ออเดอร์ประมูล (ไม่ให้เฟสนี้)' };
  } else {
    const order = orderOfTicket(db, t);
    if (order && db.auctions.some((a) => a.pay_order_id === order.id)) return { ok: false, why: 'ออเดอร์ประมูล (ไม่ให้เฟสนี้)' };
  }
  return { ok: true };
}

/** คะแนนที่ตั๋วใบนี้ "ควรได้" ตอนนี้ — 0 ถ้าไม่เข้าเกณฑ์/ยังไม่ปิดยอด */
export function pointsForTicket(db: Database, t: PreorderTicket): number {
  return ticketEarnEligible(db, t).ok ? rawPointsForTicket(db, t) : 0;
}

export const hasEarned = (db: Database, ticketId: string) => db.pointLedger.some((e) => e.id === earnIdFor(ticketId));

/**
 * สร้างแถว "ได้คะแนน" ให้ตั๋วใบนี้ — คืน null เมื่อ: ระบบปิด / ไม่เข้าเกณฑ์ / ได้ไปแล้ว / คะแนนเป็น 0.
 * ⚠ ต้องเรียกกับ db ที่ตั๋ว "อัปเดตแล้ว" (หลังบวกส่วนต่าง) — ผู้เรียกคือ approveOrder / approveRemainingPayment
 */
export function earnRowForTicket(db: Database, t: PreorderTicket, opts: { actorId?: string; now?: string; force?: boolean; note?: string } = {}): PointLedgerEntry | null {
  if (!opts.force && !db.settings.points_enabled) return null;
  if (hasEarned(db, t.id)) return null;
  const pts = pointsForTicket(db, t);
  if (pts <= 0) return null;
  const product = db.products.find((p) => p.id === t.product_id);
  const kindLabel = ticketIsFullPay(db, t) ? 'พร้อมส่ง' : 'ใบพรี';
  return {
    id: earnIdFor(t.id),
    user_id: t.owner_id,
    delta: pts,
    kind: 'earn_ticket',
    ref_type: 'ticket',
    ref_id: t.id,
    note: opts.note ?? `ปิดยอด ${t.ticket_no} · ${product?.series_name ?? 'สินค้า'}${t.qty > 1 ? ` ×${t.qty}` : ''} · ${kindLabel} ${ratePerPiece(db, t)}/ใบ`,
    created_by: opts.actorId ?? 'system',
    created_at: opts.now ?? new Date().toISOString(),
  };
}

/** แถว "ดึงคะแนนกลับ" เมื่อตั๋วที่เคยได้คะแนนถูกลบ — null ถ้าไม่เคยได้ หรือดึงกลับไปแล้ว */
export function reverseRowForTicket(db: Database, ticketId: string, opts: { actorId?: string; note?: string } = {}): PointLedgerEntry | null {
  const earn = db.pointLedger.find((e) => e.id === earnIdFor(ticketId));
  if (!earn) return null;
  if (db.pointLedger.some((e) => e.id === reverseIdFor(ticketId))) return null;
  return {
    id: reverseIdFor(ticketId),
    user_id: earn.user_id,
    delta: -earn.delta,
    kind: 'reverse_ticket',
    ref_type: 'ticket',
    ref_id: ticketId,
    note: opts.note ?? `ดึงคืน — ตั๋วถูกลบ (${earn.note ?? ticketId})`,
    created_by: opts.actorId ?? 'system',
    created_at: new Date().toISOString(),
  };
}

// ── อ่านค่า ───────────────────────────────────────────────────────────────────

export const ledgerOf = (db: Database, userId: string) =>
  db.pointLedger.filter((e) => e.user_id === userId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

/** ยอดคงเหลือใช้ได้ = ผลรวมทุกแถว (ไม่ติดลบเวลาโชว์) */
export const balanceOf = (db: Database, userId: string) =>
  Math.max(0, db.pointLedger.filter((e) => e.user_id === userId).reduce((s, e) => s + e.delta, 0));

/** ยอดสะสม = ผลรวมคะแนนที่ "ได้จริง" (ปิดตั๋ว + รางวัลยศรายเดือน) หัก reverse — ไม่นับแอดมินเติม/คืน */
export const lifetimeOf = (db: Database, userId: string) =>
  Math.max(0, db.pointLedger
    .filter((e) => e.user_id === userId && (e.kind === 'earn_ticket' || e.kind === 'reverse_ticket' || e.kind === 'monthly_reward'))
    .reduce((s, e) => s + e.delta, 0));

/** วันที่เคลื่อนไหวล่าสุด (ใช้กับกติกาหมดอายุ 12 เดือน — ตัวกวาดยังไม่เปิด) */
export const lastActivityOf = (db: Database, userId: string) => ledgerOf(db, userId)[0]?.created_at;

/** หนี้คะแนนค้างทั้งร้าน (คะแนน = บาท) */
export function pointsLiability(db: Database): { points: number; customers: number } {
  const byUser = new Map<string, number>();
  for (const e of db.pointLedger) byUser.set(e.user_id, (byUser.get(e.user_id) ?? 0) + e.delta);
  let points = 0, customers = 0;
  for (const v of byUser.values()) if (v > 0) { points += v; customers += 1; }
  return { points, customers };
}

// ── Milestone (สิทธิ์ ไม่ใช่เงิน — เจ้าของ 2026-09-10) ─────────────────────────

export interface Milestone { threshold: number; label: string; emoji: string; perks: string[] }
export const MILESTONES: Milestone[] = [
  { threshold: 500, label: 'นักสะสม', emoji: '🥉', perks: ['ป้ายในโปรไฟล์', 'เห็นรอบใหม่ก่อน 3 ชม.'] },
  { threshold: 1000, label: 'ขาประจำ', emoji: '🥈', perks: ['เพดานของ hot 3 ตัว/คน', 'เห็นรอบใหม่ก่อน 6 ชม.'] },
  { threshold: 2000, label: 'ตำนาน', emoji: '🥇', perks: ['จองของพร้อมส่งก่อน 24 ชม.', 'คิวส่งมอบก่อน', 'ป้ายพิเศษ'] },
];

export function milestoneProgress(lifetime: number): { reached: Milestone[]; next: Milestone | null; pct: number; need: number } {
  const reached = MILESTONES.filter((m) => lifetime >= m.threshold);
  const next = MILESTONES.find((m) => lifetime < m.threshold) ?? null;
  const prev = reached[reached.length - 1]?.threshold ?? 0;
  const pct = next ? Math.min(100, ((lifetime - prev) / (next.threshold - prev)) * 100) : 100;
  return { reached, next, pct, need: next ? next.threshold - lifetime : 0 };
}

// ── ใช้คะแนน (เฟสหน้า — เตรียมสูตรกลางไว้ให้ checkout / wallet เรียก) ───────────

/** ยอดคะแนนที่ใช้ได้กับรายการนี้ = min(คงเหลือ, เพดาน×qty, ยอดค้างหลังคูปอง) และต้อง ≥ ขั้นต่ำ */
export function maxRedeemable(settings: ShopSettings, args: { balance: number; isStock: boolean; qty: number; payable: number }): number {
  const cap = (args.isStock ? settings.points_max_per_piece_instock : settings.points_max_per_piece_pre) * Math.max(1, args.qty);
  const m = Math.max(0, Math.floor(Math.min(args.balance, cap, args.payable)));
  return m >= settings.points_min_redeem ? m : 0;
}

// ── เครื่องมือแอดมิน: ตรวจสอบ / จำลอง / ย้อนหลัง ────────────────────────────────

export interface SimRow {
  userId: string;
  closedTickets: number;      // ตั๋วปิดยอดที่เข้าเกณฑ์
  wouldEarn: number;          // คะแนนที่ "ควรมี" ถ้าให้ทุกใบที่ปิดยอดแล้ว
  earned: number;             // ที่ให้ไปแล้วจริง (แถว earn)
  missing: number;            // ควรได้แต่ยังไม่มีแถว (ตั๋วปิดยอดก่อนเปิดระบบ / เซฟล้ม)
  balance: number;
  lifetime: number;
}

/** จำลองทั้งร้าน: ใครควรมีกี่คะแนน เทียบกับที่ให้ไปจริง — หัวใจของหน้าพรีวิวแอดมิน */
export function simulateAll(db: Database): SimRow[] {
  const rows = new Map<string, SimRow>();
  const get = (uid: string) => {
    let r = rows.get(uid);
    if (!r) { r = { userId: uid, closedTickets: 0, wouldEarn: 0, earned: 0, missing: 0, balance: balanceOf(db, uid), lifetime: lifetimeOf(db, uid) }; rows.set(uid, r); }
    return r;
  };
  for (const t of db.tickets) {
    const pts = pointsForTicket(db, t);
    if (pts <= 0) continue;
    const r = get(t.owner_id);
    r.closedTickets += 1;
    r.wouldEarn += pts;
    // ที่ให้ไปแล้ว = ตัวเลขในสมุดจริง (อัตราอาจเปลี่ยนหลังให้ไป) ไม่ใช่สูตรปัจจุบัน
    const earn = db.pointLedger.find((e) => e.id === earnIdFor(t.id));
    if (earn) r.earned += earn.delta; else r.missing += pts;
  }
  // คนที่มีแถวในสมุดแต่ตั๋วถูกลบไปแล้ว ก็ต้องโผล่ (ยอดคงเหลือ/หนี้)
  for (const e of db.pointLedger) get(e.user_id);
  return [...rows.values()].sort((a, b) => b.wouldEarn - a.wouldEarn || b.balance - a.balance);
}

/** ตั๋วที่ปิดยอดแล้ว เข้าเกณฑ์ แต่ยังไม่มีแถวคะแนน (ใช้กับปุ่ม "ให้คะแนนย้อนหลัง") */
export function ticketsMissingEarn(db: Database): PreorderTicket[] {
  return db.tickets.filter((t) => pointsForTicket(db, t) > 0 && !hasEarned(db, t.id));
}

export const KIND_LABEL: Record<PointLedgerEntry['kind'], { label: string; emoji: string }> = {
  earn_ticket: { label: 'ได้คะแนน · ปิดยอด', emoji: '✨' },
  reverse_ticket: { label: 'ดึงคืน · ตั๋วถูกลบ', emoji: '↩️' },
  monthly_reward: { label: 'รางวัลยศประจำเดือน', emoji: '🏆' },
  redeem_order: { label: 'ใช้ลด · ซื้อพร้อมส่ง', emoji: '🛒' },
  redeem_remaining: { label: 'ใช้ลด · ส่วนต่าง', emoji: '🎟️' },
  refund: { label: 'คืนคะแนน · สลิปไม่ผ่าน', emoji: '↩️' },
  expire: { label: 'หมดอายุ', emoji: '⌛' },
  admin_adjust: { label: 'แอดมินปรับ', emoji: '🛠️' },
};

/** ฝั่งลูกค้าเห็นระบบคะแนนไหม (เจ้าของ 2026-09-12: ซ่อนไว้จนกว่าจะพร้อมประกาศ) —
 *  เปิดสวิตช์แล้ว = ทุกคนเห็น · ยังปิด = เฉพาะแอดมินเห็น (พรีวิวหน้าลูกค้าด้วยบัญชีตัวเอง) */
export const pointsVisibleTo = (db: Database, userId: string) => db.settings.points_enabled || isAdminUser(db, userId);
