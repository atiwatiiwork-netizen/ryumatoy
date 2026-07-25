import type { Database, PreorderTicket } from '../entities';
import { ymOf } from './analytics';

/**
 * เส้นเงิน — แหล่งความจริงเดียวของ "เงินเข้า/เงินค้าง" ทั้งระบบ (flow review 2026-07-25).
 *
 * ก่อนหน้านี้ dashboard นับรายได้จาก orders.total_deposit อย่างเดียว → **ส่วนต่างที่ลูกค้าจ่าย
 * ตอนของถึงไทย และมัดจำหาของ ไม่เคยโผล่ในรายงานไหนเลย** (สแกน live 2026-07-25: ค้างเก็บ 224,180฿).
 * ทุกหน้าที่โชว์ตัวเลขเงินต้องเรียกจากไฟล์นี้เท่านั้น.
 *
 * นิยาม (ตกลงกับเจ้าของ):
 *  - เงินเข้า = มัดจำจากออเดอร์ที่อนุมัติแล้ว (สุทธิหลังคูปอง) + ส่วนต่างที่อนุมัติแล้ว + มัดจำหาของที่จ่ายแล้ว
 *  - ค้างเก็บ = ผลรวมส่วนต่างที่ยังไม่ได้จ่ายของตั๋วที่ยังไม่จบ (ตั๋ว shipped ที่ยังค้าง = ผิดปกติ นับด้วย + เตือน)
 *  - เดือนของเงิน = เดือนที่ "รับเงิน" จริง (อนุมัติ) ไม่ใช่วันสั่ง
 */

/** จ่ายมาแล้วทั้งหมดของตั๋วใบนี้ (มัดจำ + ส่วนต่างที่จ่ายแล้ว). */
export const ticketPaid = (t: PreorderTicket) => (t.deposit_paid ?? 0) + (t.remaining_paid ?? 0);
/** ยังค้างของตั๋วใบนี้ (ไม่ติดลบ). */
export const ticketDue = (t: PreorderTicket) => Math.max(0, (t.remaining_amount ?? 0) - (t.remaining_paid ?? 0));
/** ราคาเต็มของตั๋วใบนี้ตาม snapshot ที่บันทึกไว้ (จ่ายแล้ว + ค้าง). */
export const ticketTotal = (t: PreorderTicket) => ticketPaid(t) + ticketDue(t);

export interface MoneyRow {
  deposits: number;   // มัดจำ/เต็มจำนวน จากออเดอร์ที่อนุมัติ (สุทธิหลังคูปอง = เงินที่โอนเข้าจริง)
  remaining: number;  // ส่วนต่างที่อนุมัติแล้ว
  sourcing: number;   // มัดจำหาของที่ลูกค้าจ่ายแล้ว (paid/working)
  total: number;      // รวมเงินเข้า
  orders: number;     // จำนวนออเดอร์ที่อนุมัติ
}

const empty = (): MoneyRow => ({ deposits: 0, remaining: 0, sourcing: 0, total: 0, orders: 0 });

/**
 * เงินเข้าในเดือน ym (YYYY-MM local) — ถ้าไม่ระบุ = ทั้งหมดตั้งแต่เปิดร้าน.
 * ยึด "วันที่รับเงิน": ออเดอร์ใช้ approved_at (fallback created_at), ส่วนต่างใช้ approved_at,
 * หาของใช้ paid_at — เพื่อให้ยอดเดือนตรงกับเงินที่เข้าบัญชีจริงในเดือนนั้น.
 */
export function cashIn(db: Database, ym?: string): MoneyRow {
  const row = empty();
  const inMonth = (iso?: string) => !ym || ymOf(iso) === ym;

  for (const o of db.orders) {
    if (o.status !== 'approved') continue;
    if (!inMonth(o.approved_at ?? o.created_at)) continue;
    row.deposits += o.total_deposit ?? 0; // total_deposit = สุทธิหลังหักคูปองแล้ว (เงินโอนจริง)
    row.orders += 1;
  }
  for (const r of db.remainingPayments) {
    if (r.status !== 'approved') continue;
    if (!inMonth(r.approved_at ?? r.created_at)) continue;
    row.remaining += r.amount ?? 0;
  }
  for (const s of db.sourcingRequests) {
    if (!['paid', 'working'].includes(s.status)) continue;
    if (!inMonth(s.paid_at ?? s.created_at)) continue;
    row.sourcing += (s.deposit ?? 0) * (s.qty ?? 1);
  }
  row.total = row.deposits + row.remaining + row.sourcing;
  return row;
}

export interface Outstanding {
  total: number;          // ค้างเก็บรวม (บาท)
  tickets: number;        // จำนวนใบที่ค้าง
  customers: number;      // จำนวนคนที่ค้าง
  collectable: number;    // ค้างที่ "เก็บได้แล้ว" (ของถึงไทย/พร้อมส่ง → ทวงได้เลย)
  notYet: number;         // ค้างที่ยังไม่ถึงกำหนด (ของยังผลิต/เดินทาง)
  shippedUnpaid: number;  // ⚠ ส่งของไปแล้วแต่ยังค้าง (ไม่ควรมี)
}

/** ยอดค้างเก็บทั้งระบบ แยกว่าทวงได้แล้วหรือยัง (ของถึงไทยแล้ว = ทวงได้). */
export function outstanding(db: Database): Outstanding {
  const out: Outstanding = { total: 0, tickets: 0, customers: 0, collectable: 0, notYet: 0, shippedUnpaid: 0 };
  const owners = new Set<string>();
  for (const t of db.tickets) {
    const due = ticketDue(t);
    if (due <= 0) continue;
    out.total += due;
    out.tickets += 1;
    owners.add(t.owner_id);
    if (t.status === 'shipped') out.shippedUnpaid += due;
    else if (['arrived', 'delivered'].includes(t.product_status)) out.collectable += due;
    else out.notYet += due;
  }
  out.customers = owners.size;
  return out;
}

/** ลูกค้าที่ค้างจ่าย เรียงมากไปน้อย — สำหรับหน้าทวงเงิน. */
export function debtors(db: Database): { userId: string; name: string; due: number; tickets: PreorderTicket[]; collectable: number }[] {
  const map = new Map<string, { userId: string; name: string; due: number; tickets: PreorderTicket[]; collectable: number }>();
  for (const t of db.tickets) {
    const due = ticketDue(t);
    if (due <= 0) continue;
    const row = map.get(t.owner_id) ?? {
      userId: t.owner_id,
      name: db.users.find((u) => u.id === t.owner_id)?.display_name ?? '—',
      due: 0, tickets: [], collectable: 0,
    };
    row.due += due;
    row.tickets.push(t);
    if (['arrived', 'delivered'].includes(t.product_status)) row.collectable += due;
    map.set(t.owner_id, row);
  }
  return [...map.values()].sort((a, b) => b.collectable - a.collectable || b.due - a.due);
}

/** เดือนที่มีเงินเข้า (ใหม่→เก่า) + เดือนปัจจุบันเสมอ — สำหรับตัวเลือกเดือน. */
export function cashMonths(db: Database): string[] {
  const s = new Set<string>();
  for (const o of db.orders) if (o.status === 'approved') { const m = ymOf(o.approved_at ?? o.created_at); if (m) s.add(m); }
  for (const r of db.remainingPayments) if (r.status === 'approved') { const m = ymOf(r.approved_at ?? r.created_at); if (m) s.add(m); }
  for (const p of db.sourcingRequests) if (['paid', 'working'].includes(p.status)) { const m = ymOf(p.paid_at ?? p.created_at); if (m) s.add(m); }
  return [...s].sort().reverse();
}
