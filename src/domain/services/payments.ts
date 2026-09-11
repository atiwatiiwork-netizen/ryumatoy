import type { Database, PreorderTicket, RemainingPayment } from '../entities';
import { ticketDue } from './money';
import { ticketPaidFull } from './delivery';
import { ticketIsFullPay } from './points';

/**
 * ส่วนต่าง / "รอชำระ" — แหล่งความจริงเดียวว่าใบไหน "เปิดให้จ่ายแล้ว" และสลิปไหนอยู่กลุ่มเดียวกัน
 * (เจ้าของ 2026-09-12: จัดกลุ่มสถานะใหม่ + ปิดใบพรีหลายใบด้วยสลิปเดียว)
 *
 *  · เปิดให้จ่าย = ของกำลังเดินทาง/ถึงไทย/ส่งมอบแล้ว และยังมียอดค้าง (กติกาเดิมของปุ่ม "จ่ายส่วนต่าง")
 *  · บั๊กเดิมที่แก้: ticketDone ถือว่า arrived = จบ → ใบถึงไทยที่ยังค้างจ่ายเคยไปโผล่แท็บ "เรียบร้อย"
 *    ตอนนี้ทุกหน้าถามผ่าน ticketPayable ก่อน แล้วค่อยตกไป "กำลังเดินทาง/เรียบร้อย"
 *  · กลุ่มสลิป = แถว remaining_payments ของคนเดียวกันที่ใช้ slip_url เดียวกัน (URL อัปโหลดมี timestamp+random
 *    ไม่ซ้ำกันแน่นอน) — ไม่พึ่งคอลัมน์ group_id (v67 ยังไม่รัน) เซฟของลูกค้าจึงไม่พังถ้าคอลัมน์ยังไม่มี
 */

export const PAYABLE_STATUSES: PreorderTicket['product_status'][] = ['shipping', 'arrived', 'delivered'];

/** ใบนี้เปิดให้จ่ายส่วนต่างแล้วไหม (ยังค้าง + ของออกจากโรงงานแล้ว + ยังไม่ปิดงาน) */
export const ticketPayable = (t: PreorderTicket): boolean =>
  ticketDue(t) > 0 && PAYABLE_STATUSES.includes(t.product_status) && t.status !== 'shipped';

/** สลิปส่วนต่างที่ยังรอตรวจของใบนี้ (มีได้ใบละ 1) */
export const pendingRpFor = (db: Database, ticketId: string): RemainingPayment | undefined =>
  db.remainingPayments.find((r) => r.ticket_id === ticketId && r.status === 'pending');

/** เลือกจ่ายได้ = เปิดให้จ่าย และไม่มีสลิปค้างตรวจ */
export const ticketSelectable = (db: Database, t: PreorderTicket): boolean => ticketPayable(t) && !pendingRpFor(db, t.id);

/** ใบที่ "รอชำระ" ของลูกค้าคนนี้ (รวมใบที่ส่งสลิปแล้วรอตรวจ — โชว์ในแท็บเดียวกันแต่ติ๊กไม่ได้) */
export const payableTickets = (db: Database, userId: string): PreorderTicket[] =>
  db.tickets.filter((t) => t.owner_id === userId && ticketPayable(t));

/** กุญแจกลุ่มสลิป — group_id (v67) ถ้ามี, ไม่งั้น คน+สลิป, ไม่งั้นแถวเดี่ยว */
export const rpGroupKey = (r: RemainingPayment): string => r.group_id || (r.slip_url ? `${r.user_id}|${r.slip_url}` : r.id);

export interface RpGroup {
  key: string;
  userId: string;
  slipUrl: string;
  rps: RemainingPayment[];   // เรียงตามเวลาที่ส่ง
  total: number;             // ยอดโอนรวมที่ควรเห็นในสลิป
  couponOff: number;         // ส่วนลดคูปองรวม (โชว์)
  createdAt: string;
}

/** สลิปส่วนต่างที่รอตรวจ จัดเป็นกลุ่ม (สลิปเดียวหลายใบ = 1 กลุ่ม) เรียงเก่า→ใหม่ */
export function pendingRpGroups(db: Database): RpGroup[] {
  const m = new Map<string, RpGroup>();
  for (const r of db.remainingPayments) {
    if (r.status !== 'pending') continue;
    const key = rpGroupKey(r);
    let g = m.get(key);
    if (!g) { g = { key, userId: r.user_id, slipUrl: r.slip_url, rps: [], total: 0, couponOff: 0, createdAt: r.created_at }; m.set(key, g); }
    g.rps.push(r);
    g.total += r.amount ?? 0;
    g.couponOff += r.coupon_discount ?? 0;
    if (r.created_at < g.createdAt) g.createdAt = r.created_at;
  }
  return [...m.values()].map((g) => ({ ...g, rps: [...g.rps].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

// ── แท็บกระเป๋าพรี (ตัวเดียวที่ /wallet ใช้ — ทดสอบได้ใน scripts/audit/payments-audit.ts) ──────────────
export type WalletTab = 'preorder' | 'pay' | 'shipping' | 'done';
/**
 * ใบนี้ควรอยู่แท็บไหน (ตัดสินตามลำดับ):
 *  1. รอชำระ  = เปิดให้จ่ายแล้ว (ticketPayable)
 *  2. กำลังเดินทาง = ของกำลังเดินทาง + จ่ายครบแล้ว
 *  3. ใบพรี   = ของยังเปิดจอง/ผลิต — รวมใบที่ "จ่ายครบก่อนของออก" (แอดมินแก้มัดจำเป็นเต็ม/จ่ายล่วงหน้า)
 *              ยกเว้นตั๋วที่จ่ายเต็มตั้งแต่เกิด (พร้อมส่ง/รอบจ่ายเต็ม) = ไม่มีอะไรต้องรอ → เรียบร้อย
 *              (audit 2026-09-12: เดิม ticketDone ถือ paid_full = จบ → ใบพรีที่จ่ายครบแต่ของยังผลิตหายจาก "ใบพรี" ไปโผล่ "เรียบร้อย")
 *  4. เรียบร้อย = ที่เหลือ (ถึงไทย/ส่งมอบ/เสร็จสิ้น จ่ายครบแล้ว)
 */
export function walletTabOf(db: Database, t: PreorderTicket): WalletTab {
  if (ticketPayable(t)) return 'pay';
  if (t.product_status === 'shipping' && t.status !== 'shipped') return 'shipping';
  const live = (t.product_status === 'open' || t.product_status === 'production') && t.status !== 'shipped';
  if (live && !(ticketPaidFull(t) && ticketIsFullPay(db, t))) return 'preorder';
  return 'done';
}
