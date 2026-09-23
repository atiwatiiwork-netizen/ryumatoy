import type { Database, OrderItem, PointLedgerEntry, PreorderTicket, ShopSettings } from '../entities';
import { ticketPaid, ticketDue, isSourcingTicket } from './money';
import { orderOfTicket } from './journey';
import { isAdminUser, isStaffAccount } from './admins';
import { ledgerById, ledgerTotals, orderItemById, auctionPayOrderIds, approvedRpTicketIds, ticketById, lastApprovedRpAt } from './indexes';

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
/** ปรับยอดแต้มปิดยอดให้ตรงอัตราตอนเปิดตัว (เช่น รอบพิเศษจ่ายเต็มที่เคยได้ 30 ช่วงพรีวิว → 20) — ใบละครั้งเดียว */
export const earnFixIdFor = (ticketId: string) => `pl-fix-${ticketId}`;

/** ตั๋ว "จ่ายเต็มตั้งแต่เกิด" (พร้อมส่ง / รอบจ่ายเต็ม) → ใช้อัตราพร้อมส่ง + ไม่นับเป็น "ใบพรี" รายเดือน.
 *  ตัดสินจาก **snapshot ของรายการในออเดอร์** (unit_deposit ≥ unit_price) ไม่ใช่สภาพตั๋วปัจจุบัน — เพราะ
 *   · คูปองที่ครอบส่วนต่างทั้งก้อน / แอดมินแก้มัดจำเป็นเต็มราคา ทำให้ remaining_amount กลายเป็น 0 ทีหลัง
 *     (audit 2026-09-12: ใบพรีจริงถูกตีเป็น "พร้อมส่ง" → ได้ 30 แทน 20 และหลุดจากยอดพรีรายเดือน)
 *   · ห้ามดู product.is_stock: SKU พรีที่ถูก convert เป็นพร้อมส่งทีหลัง จะทำให้ตั๋วพรีเก่าถูกตีเป็นพร้อมส่ง
 *  ตั๋วมอบ/legacy (ไม่มีรายการออเดอร์คู่): จ่ายเต็ม = ไม่มีส่วนต่างตั้งแต่เกิด และไม่เคยมีสลิปส่วนต่านอนุมัติ */
export function ticketIsFullPay(db: Database, t: PreorderTicket): boolean {
  if (t.id.startsWith('t-')) {
    const it = orderItemById(db).get(t.id.slice(2))?.item;
    if (it && it.unit_price != null && it.unit_deposit != null) return it.unit_deposit >= it.unit_price;
    // แถวรุ่นเก่าไม่มี snapshot → ใช้ fallback ด้านล่าง
  }
  return (t.remaining_amount ?? 0) === 0 && (t.remaining_paid ?? 0) === 0
    && !approvedRpTicketIds(db).has(t.id);
}


/** อัตราคะแนนต่อชิ้น (พรี / พร้อมส่ง) — ตัวเดียวที่หน้าจอใช้โชว์ตัวเลข.
 *  fallback 20/30 เมื่อ settings มาจากสแนปช็อตเก่าที่ยังไม่มีคีย์ (กัน NaN/0 เงียบๆ) */
export function pointsRates(settings: ShopSettings): { pre: number; instock: number } {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : d);
  return { pre: n(settings.points_per_piece_pre, 20), instock: n(settings.points_per_piece_instock, 30) };
}

/** "ใบพรี" ในสายตาเจ้าของ = พรีปกติ + รอบพิเศษ (batch) — ใช้อัตราใบพรี + นับยอดพรีรายเดือน.
 *  รอบพิเศษที่เก็บเต็มราคาตั้งแต่แรกก็ยังเป็น "ใบพรี" (เจ้าของ 2026-09-12 ค่ำ: "ทั้งรอบปกติ - รอบพิเศษ")
 *  ไม่ใช่ใบพรี = พร้อมส่ง / จ่ายเต็มตั้งแต่เกิดโดยไม่มีรอบ (ticketIsFullPay) */
export const ticketIsPre = (db: Database, t: PreorderTicket) => !!t.batch_id || !ticketIsFullPay(db, t);

/** อัตราคะแนนต่อชิ้นของตั๋วใบนี้ — ตั้งอัตราพร้อมส่ง = 0 คือ "นับเฉพาะใบพรี" (โหมดเปิดตัว) */
export function ratePerPiece(db: Database, t: PreorderTicket): number {
  const r = pointsRates(db.settings);
  return ticketIsPre(db, t) ? r.pre : r.instock;
}

/** คะแนน "เต็มใบ" ตามสูตร (ไม่ดูเกณฑ์/ปิดยอด) — ใช้โชว์ "จะได้เมื่อปิดยอด" */
export const rawPointsForTicket = (db: Database, t: PreorderTicket) => ratePerPiece(db, t) * Math.max(1, t.qty ?? 1);

/** ตั๋วใบนี้ "ปิดยอดแล้ว" (จ่ายครบ + มีเงินจริง) */
export const ticketClosed = (t: PreorderTicket) => ticketDue(t) === 0 && ticketPaid(t) > 0;

/** ตั๋วใบนี้เข้าเกณฑ์ได้คะแนนไหม (ไม่ดูว่าเคยได้แล้วหรือยัง) — ตัวชี้ขาดตัวเดียว */
export function ticketEarnEligible(db: Database, t: PreorderTicket): { ok: boolean; why?: string } {
  if (!ticketClosed(t)) return { ok: false, why: 'ยังไม่ปิดยอด' };
  const block = ticketEarnBlock(db, t);
  return block ? { ok: false, why: block } : { ok: true };
}

/** เหตุที่ตั๋ว "ไม่มีสิทธิ์ได้คะแนนเลย" (ไม่ดูว่าปิดยอดหรือยัง) — null = มีสิทธิ์
 *  ใช้ทั้งตอนให้ (ticketEarnEligible) และตอนเปิดตัวดึงแต้มที่เคยให้ผิดกติกาคืน (launchCorrectionRows) */
export function ticketEarnBlock(db: Database, t: PreorderTicket): string | null {
  // สถานะที่ยังไม่ใช่ตั๋วจริง / ย้ายมือไปแล้ว (audit 2026-09-23)
  if (t.status === 'pending_approval' || t.status === 'transferred') return 'สถานะตั๋วไม่เข้าเกณฑ์';
  // บัญชีทีมงาน/แอดมิน — ตั๋วทดสอบไม่ควรพองหนี้คะแนนร้าน
  if (isStaffAccount(db, t.owner_id)) return 'บัญชีแอดมิน/ทีมงาน';
  if (isSourcingTicket(db, t)) return 'ตั๋วหาของ (ไม่ให้เฟสนี้)';
  // ออเดอร์ที่เป็นตัวจ่ายค่าประมูล (v61) — คะแนนประมูลค่อยว่ากันเฟสหน้า
  if (t.id.startsWith('t-')) {
    const orderId = orderItemById(db).get(t.id.slice(2))?.orderId;
    if (orderId && auctionPayOrderIds(db).has(orderId)) return 'ออเดอร์ประมูล (ไม่ให้เฟสนี้)';
  } else {
    const pays = auctionPayOrderIds(db);
    const order = pays.size ? orderOfTicket(db, t) : undefined;
    if (order && pays.has(order.id)) return 'ออเดอร์ประมูล (ไม่ให้เฟสนี้)';
  }
  return null;
}

/** คะแนนที่ตั๋วใบนี้ "ควรได้" ตอนนี้ — 0 ถ้าไม่เข้าเกณฑ์/ยังไม่ปิดยอด */
export function pointsForTicket(db: Database, t: PreorderTicket): number {
  return ticketEarnEligible(db, t).ok ? rawPointsForTicket(db, t) : 0;
}

export const hasEarned = (db: Database, ticketId: string) => ledgerById(db).has(earnIdFor(ticketId));

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
  const kindLabel = ticketIsPre(db, t) ? 'ใบพรี' : 'พร้อมส่ง';
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
  const idx = ledgerById(db);
  const earn = idx.get(earnIdFor(ticketId));
  if (!earn) return null;
  if (idx.has(reverseIdFor(ticketId))) return null;
  const fix = idx.get(earnFixIdFor(ticketId)); // ปรับอัตราตอนเปิดตัว (ถ้ามี) → ดึงคืน "สุทธิ"
  const net = earn.delta + (fix?.delta ?? 0);
  if (net === 0) return null;
  return {
    id: reverseIdFor(ticketId),
    user_id: earn.user_id,
    delta: -net,
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
export const balanceOf = (db: Database, userId: string) => Math.max(0, ledgerTotals(db).get(userId)?.sum ?? 0);

/** ยอดสะสม = ผลรวมคะแนนที่ "ได้จริง" (ปิดตั๋ว + รางวัลยศรายเดือน) หัก reverse — ไม่นับแอดมินเติม/คืน */
export const lifetimeOf = (db: Database, userId: string) => Math.max(0, ledgerTotals(db).get(userId)?.life ?? 0);

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

/** ขั้นของปุ่มเลือกแต้ม (50 / 100 / 150 …) */
export const POINT_STEP = 50;
export type RedeemKind = 'pre' | 'instock';

/** เพดาน/ขั้นต่ำการใช้แต้ม (เจ้าของ 2026-09-12): ปิดใบพรี 200 **ต่อใบ** · พร้อมส่ง 400 **ต่อออเดอร์** · ขั้นต่ำ 50
 *  (คอลัมน์ยังชื่อ *_per_piece จาก v66 แต่ความหมายคือ "ต่อรายการ" ไม่คูณ qty — DB trigger v67 ใช้ค่าเดียวกัน) */
export function redeemRules(settings: ShopSettings, kind: RedeemKind): { cap: number; min: number } {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : d);
  return { cap: n(kind === 'instock' ? settings.points_max_per_piece_instock : settings.points_max_per_piece_pre, kind === 'instock' ? 400 : 200), min: n(settings.points_min_redeem, 50) };
}

/** แต้มสูงสุดที่ใช้ได้กับรายการนี้ = min(คงเหลือ, เพดาน, ยอดค้างหลังคูปอง) ปัดลงเป็นขั้น 50 · ต่ำกว่าขั้นต่ำ = 0 */
export function maxRedeemable(settings: ShopSettings, args: { balance: number; kind: RedeemKind; payable: number }): number {
  const { cap, min } = redeemRules(settings, args.kind);
  const raw = Math.max(0, Math.floor(Math.min(args.balance, cap, args.payable)));
  const stepped = Math.floor(raw / POINT_STEP) * POINT_STEP;
  return stepped >= min ? stepped : 0;
}

/** ปุ่มเลือก: 50, 100, … ถึงเพดานที่ใช้ได้ */
export function redeemPicks(max: number, min = 50, step = POINT_STEP): number[] {
  const out: number[] = [];
  for (let v = Math.max(min, step); v <= max; v += step) out.push(v);
  return out;
}

/** ตัวเลขแต้มที่ "ใช้จริง" ตามที่ลูกค้าขอ — ด่านฝั่งแอป (DB trigger v67 เป็นด่านจริงอีกชั้น):
 *  ระบบปิด / ต่ำกว่าขั้นต่ำ / เกินเพดาน / เกินยอดค้าง / เกินคงเหลือ → ตัดลงหรือ 0 (ไม่ปัดตกทั้งรายการ) */
export function clampRedeem(db: Database, userId: string, kind: RedeemKind, payable: number, requested: number): number {
  if (!redeemEnabled(db)) return 0; // สวิตช์ใช้แต้มปิด (หรือระบบคะแนนปิด) → ไม่รับแต้มเลย
  const { cap, min } = redeemRules(db.settings, kind);
  const r = Math.max(0, Math.trunc(requested || 0));
  if (r < min) return 0;
  return Math.max(0, Math.floor(Math.min(r, cap, payable, balanceOf(db, userId))));
}

// ── แถว "จองแต้ม/คืนแต้ม" (v67) — DB trigger เป็นคนสร้างจริง; แอปใส่สำเนา id เดียวกันไว้โชว์ล่วงหน้า (adapter ไม่ส่งขึ้น) ──
export const redeemHoldId = (rowId: string) => `pl-redeem-${rowId}`;
export const refundId = (rowId: string) => `pl-refund-${rowId}`;
export function holdRow(userId: string, rowId: string, kind: 'redeem_remaining' | 'redeem_order', points: number, note: string): PointLedgerEntry {
  return { id: redeemHoldId(rowId), user_id: userId, delta: -points, kind, ref_type: kind === 'redeem_order' ? 'order' : 'remaining_payment', ref_id: rowId, note, created_by: 'system', created_at: new Date().toISOString() };
}
export function refundRow(userId: string, rowId: string, refType: 'order' | 'remaining_payment', points: number, note: string): PointLedgerEntry {
  return { id: refundId(rowId), user_id: userId, delta: points, kind: 'refund', ref_type: refType, ref_id: rowId, note, created_by: 'system', created_at: new Date().toISOString() };
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
    const idx = ledgerById(db);
    const earn = idx.get(earnIdFor(t.id));
    if (earn) r.earned += earn.delta + (idx.get(earnFixIdFor(t.id))?.delta ?? 0); else r.missing += pts;
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
  earn_adjust: { label: 'ปรับคะแนนปิดยอดตามกติกา', emoji: '⚖️' },
  monthly_reward: { label: 'รางวัลยศประจำเดือน', emoji: '🏆' },
  coupon_reward: { label: 'รางวัลแต้ม · คูปอง / Event / ภารกิจ', emoji: '🎁' },
  redeem_order: { label: 'ใช้ลด · ซื้อพร้อมส่ง', emoji: '🛒' },
  redeem_remaining: { label: 'ใช้ลด · ส่วนต่าง', emoji: '🎟️' },
  refund: { label: 'คืนคะแนน · สลิปไม่ผ่าน', emoji: '↩️' },
  expire: { label: 'หมดอายุ', emoji: '⌛' },
  admin_adjust: { label: 'แอดมินปรับ', emoji: '🛠️' },
};

/** ฝั่งลูกค้าเห็นระบบคะแนนไหม (เจ้าของ 2026-09-12: ซ่อนไว้จนกว่าจะพร้อมประกาศ) —
 *  เปิดสวิตช์แล้ว = ทุกคนเห็น · ยังปิด = เฉพาะแอดมินเห็น (พรีวิวหน้าลูกค้าด้วยบัญชีตัวเอง) */
export const pointsVisibleTo = (db: Database, userId: string) => db.settings.points_enabled || isAdminUser(db, userId);

// ── สวิตช์ "ใช้แต้มตัดยอด" (เจ้าของ 2026-09-12 ค่ำ: เปิดโชว์แต้มก่อน ยังไม่เปิดลดจริง) ──────────
/** เก็บใน app_config key 'points_redeem' → { enabled } — ไม่ต้องรัน migration (แบบเดียวกับ points_monthly) */
export const REDEEM_KEY = 'points_redeem';
/** ค่าที่แอดมินตั้งไว้ (ยังไม่ดูว่าระบบคะแนนเปิดไหม) — ใช้โชว์สถานะปุ่มในแอดมิน */
export function redeemFlag(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === REDEEM_KEY);
  return (row?.value as { enabled?: unknown } | undefined)?.enabled === true;
}
/** ลูกค้าใช้แต้มตัดยอดได้ไหม = ระบบคะแนนเปิด **และ** สวิตช์ใช้แต้มเปิด —
 *  ตัวเดียวที่ปุ่มเลือกแต้ม (หน้าตั๋ว / จ่ายรวม / checkout) และ clampRedeem ใช้ · ปิด = เห็นแต้ม แต่ยังใช้ลดไม่ได้ */
export const redeemEnabled = (db: Database) => db.settings.points_enabled && redeemFlag(db);

// ── คูปองแต้ม (rework 2026-09-12 ค่ำ: คูปอง / Event / ภารกิจ ให้เป็นแต้มแทนส่วนลดตรง) ──────────────
/** id แถว "ได้แต้มจากคูปอง" ผูกกับ grant → มอบซ้ำ/เซฟล้มส่งซ้ำ = แถวเดิม (DB unique(kind, ref_id) อีกชั้น) */
export const couponRewardId = (grantId: string) => `pl-coupon-${grantId}`;
/** แถวแต้มของคูปองแต้ม — เกิดใน mutation เดียวกับ grant (grantCoupon / grantCampaignRewards) ทั้งหมดรันในเซสชันแอดมิน (RLS) */
export function couponRewardRow(grant: { id: string; user_id: string; granted_at: string }, coupon: { label: string; value: number }, actorId = 'system'): PointLedgerEntry {
  return {
    id: couponRewardId(grant.id),
    user_id: grant.user_id,
    delta: Math.max(0, Math.trunc(coupon.value)),
    kind: 'coupon_reward',
    ref_type: 'coupon_grant',
    ref_id: grant.id,
    note: `คูปองแต้ม · ${coupon.label}`,
    created_by: actorId,
    created_at: grant.granted_at,
  };
}

// ── ประกาศเปิดระบบ (เจ้าของ 2026-09-23: "ตอนเปิดครั้งแรก มีแจ้งเตือน → ระบบคะแนนเปิดแล้ว คะแนนของคุณคือ xx") ──
/** app_config 'points_launch' → { at, by } — ตั้งครั้งแรกที่กดเปิดตัว (ไม่ทับ) · ป๊อปอัปลูกค้าโชว์ครั้งเดียวต่อ at */
export const POINTS_LAUNCH_KEY = 'points_launch';
export function pointsLaunchInfo(db: Database): { at: string; by?: string } | null {
  const v = db.appConfig.find((c) => c.key === POINTS_LAUNCH_KEY)?.value as { at?: unknown; by?: unknown } | undefined;
  return typeof v?.at === 'string' ? { at: v.at, by: typeof v.by === 'string' ? v.by : undefined } : null;
}
/** ใบที่ได้คะแนนแล้ว (หักใบที่ถูกลบ) — ใช้ในข้อความ "จากใบพรีที่ปิดแล้ว n ใบ" */
export function earnedTicketCount(db: Database, userId: string): number {
  const mine = db.pointLedger.filter((e) => e.user_id === userId);
  return Math.max(0, mine.filter((e) => e.kind === 'earn_ticket').length - mine.filter((e) => e.kind === 'reverse_ticket').length);
}
/** ข้อความประกาศเปิดระบบ — ตัวเดียวที่ป๊อปอัปลูกค้า / push / พรีวิวแอดมินใช้ (ห้ามเขียนข้อความซ้ำที่อื่น) */
export function launchNotice(db: Database, userId: string): { balance: number; tickets: number; rate: number; canRedeem: boolean; title: string; body: string; url: string } {
  const balance = balanceOf(db, userId);
  const tickets = earnedTicketCount(db, userId);
  const rate = pointsRates(db.settings).pre;
  const canRedeem = redeemEnabled(db);
  const title = '⭐ ระบบคะแนนสะสมเปิดแล้ว!';
  const body = balance > 0
    ? `คะแนนของคุณคือ ${balance.toLocaleString('en-US')} แต้ม${tickets > 0 ? ` (จากใบพรีที่ปิดแล้ว ${tickets} ใบ)` : ''} — แตะดูประวัติและวิธีสะสม`
    : `เริ่มสะสมได้แล้ว — ปิดใบพรีรับ +${rate} แต้ม/ใบ`;
  return { balance, tickets, rate, canRedeem, title, body, url: '/points' };
}

/** แถว "ดึงคืน" ตอนเปิดตัว (audit 2026-09-23): แต้มที่เคยให้ไปก่อนเปิดตัวแต่ผิดกติกาเปิดตัว —
 *  ของพร้อมส่งที่ได้ 30 ช่วงพรีวิว (อัตราตอนนี้ = 0) / บัญชีแอดมิน / ตั๋วหาของ / ตั๋วที่ถูกลบไปแล้วแต่แต้มยังอยู่
 *  id = pl-rev-<ticketId> (ตัวเดียวกับตอนลบตั๋ว) → เรียกซ้ำไม่ดึงซ้ำ */
export function launchCorrectionRows(db: Database, actorId?: string): PointLedgerEntry[] {
  const out: PointLedgerEntry[] = [];
  const idx = ledgerById(db);
  const tix = ticketById(db);
  const now = new Date().toISOString();
  for (const e of db.pointLedger) {
    if (e.kind !== 'earn_ticket' || !e.ref_id) continue;
    if (idx.has(reverseIdFor(e.ref_id)) || out.some((x) => x.ref_id === e.ref_id)) continue; // ดึงคืน/ปรับไปแล้ว
    const t = tix.get(e.ref_id);
    const raw = t ? rawPointsForTicket(db, t) : 0;
    const why = !t ? 'ตั๋วถูกลบไปแล้ว' : raw === 0 ? 'ยังไม่ให้คะแนนของพร้อมส่ง' : ticketEarnBlock(db, t);
    if (why) {
      const r = reverseRowForTicket(db, e.ref_id, { actorId, note: `ปรับตอนเปิดตัว — ${why} (${e.note ?? e.ref_id})` });
      if (r) out.push(r);
      continue;
    }
    // ได้ไปคนละอัตรากับกติกาตอนนี้ (เช่น รอบพิเศษจ่ายเต็มได้ 30 ช่วงพรีวิว → ตอนนี้ใบพรี 20) → แถวปรับส่วนต่าง ใบละครั้ง
    // kind แยก (earn_adjust) เพราะ DB มี unique(kind, ref_id) — ใช้ earn_ticket ซ้ำ ref_id เดิมไม่ได้
    const fix = idx.get(earnFixIdFor(e.ref_id));
    const net = e.delta + (fix?.delta ?? 0);
    if (!fix && net !== raw) {
      out.push({
        id: earnFixIdFor(e.ref_id), user_id: e.user_id, delta: raw - net, kind: 'earn_adjust', ref_type: 'ticket', ref_id: e.ref_id,
        note: `ปรับตอนเปิดตัว — คะแนนปิดยอดตามอัตราปัจจุบัน ${raw} (เดิม ${net})`, created_by: actorId ?? 'system', created_at: now,
      });
    }
  }
  return out;
}

/** แต้มที่ "ใช้ได้จริง" ของสลิป/ออเดอร์นี้ตอนอนุมัติ (audit 2026-09-23): เชื่อ points_redeemed เฉพาะเมื่อ DB จองแต้มไว้จริง
 *  (มีแถว pl-redeem-<id> ยอดตรง) และยังไม่ถูกคืน (ไม่มี pl-refund-<id>) — กันสลิปที่ถูกปฏิเสธแล้วส่งซ้ำด้วย id เดิม
 *  (แถวจองเดิมถูก "do nothing" = ไม่หักแต้ม แต่หนี้ลด) / แถวที่ยิงเข้ามาเองโดยไม่ผ่าน trigger */
export function heldPointsFor(db: Database, rowId: string, requested: number | undefined): number {
  const want = Math.max(0, Math.trunc(requested ?? 0));
  if (want <= 0) return 0;
  const idx = ledgerById(db);
  const hold = idx.get(redeemHoldId(rowId));
  if (!hold || hold.delta !== -want) return 0;
  if (idx.has(refundId(rowId))) return 0;
  return want;
}

/** เวลาที่ตั๋ว "ปิดยอด" (ประมาณ, ISO): สลิปส่วนต่างอนุมัติล่าสุด / ปิดใบนอกระบบ / อนุมัติออเดอร์หรือวันออกตั๋ว (จ่ายครบตั้งแต่เกิด) */
export function ticketClosedAt(db: Database, t: PreorderTicket): string {
  return [lastApprovedRpAt(db).get(t.id), t.shipped_out_at, t.approved_at ?? t.created_at]
    .filter((x): x is string => !!x)
    .reduce((a, b) => (b > a ? b : a), '');
}

/** ตั๋วที่ระบบแอดมิน "เติมแต้มให้เองอัตโนมัติ" (AdminShell) — ตกหล่น + ปิดยอด **หลังวันเปิดตัว** เท่านั้น
 *  (audit 2026-09-23: ถ้ากวาดทุกใบ พอเจ้าของปรับอัตราพร้อมส่งขึ้นทีหลัง ระบบจะแจกย้อนหลังของพร้อมส่งทุกใบทันทีแบบไม่ถาม)
 *  ของเก่าก่อนเปิดตัว = ปุ่ม "ให้คะแนนย้อนหลัง" ที่แอดมินกดเองเท่านั้น */
export function sweepCandidates(db: Database): PreorderTicket[] {
  const li = pointsLaunchInfo(db);
  if (!li || !db.settings.points_enabled) return [];
  return ticketsMissingEarn(db).filter((t) => ticketClosedAt(db, t) >= li.at);
}
