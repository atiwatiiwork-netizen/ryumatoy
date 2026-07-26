import type { Database, PreorderTicket } from '../entities';
import { grantedTicketIds } from './money';
import { orderOfTicket } from './journey';

/**
 * "ตั๋วใบนี้มาจากทางไหน" (เจ้าของ 2026-07-26) — ใช้ตรวจย้อนหลังเวลามีอะไรผิดพลาด
 * ว่าใบไหนเกิดจากวิธีอะไร วันที่เท่าไหร่ ยอดเต็มเท่าไหร่ มัดจำเท่าไหร่.
 *
 * ตั๋วในระบบเกิดได้ 5 ทาง และแต่ละทาง "เส้นเงิน" ไม่เหมือนกัน:
 *   preorder — ลูกค้าสั่งพรีปกติ + แอดมินอนุมัติสลิป (มีออเดอร์คู่)
 *   special  — ซื้อจากรอบพิเศษ/สต๊อกใบพรี (มีออเดอร์คู่ + ผูก batch)
 *   instock  — ซื้อของพร้อมส่ง จ่ายเต็มตั้งแต่แรก (มีออเดอร์คู่ ไม่มีส่วนต่าง)
 *   granted  — แอดมินมอบตั๋วให้เอง (ไล่เก็บใบพรีเก่า) — **ไม่มีออเดอร์** เก็บเงินนอกระบบ
 *   sourcing — เกิดจากงานหาของตอนกด "เริ่มงาน" — **ไม่มีออเดอร์** เงินอยู่ในฝั่งหาของ
 */
export type TicketSource = 'preorder' | 'special' | 'instock' | 'granted' | 'sourcing';

export interface TicketOrigin {
  source: TicketSource;
  label: string;
  emoji: string;
  /** สีป้าย (tailwind classes) */
  cls: string;
  at: string;            // วันที่ได้ตั๋ว (อนุมัติ > สร้าง)
  price: number;         // ยอดเต็มของใบนี้ (มัดจำ + ค้าง)
  deposit: number;       // ที่จ่ายมาแล้วเป็นมัดจำ
  paid: number;          // จ่ายมาแล้วทั้งหมด (มัดจำ + ส่วนต่างที่อนุมัติ)
  due: number;           // ยังค้าง
  orderId?: string;      // ออเดอร์ต้นทาง (ถ้ามี)
  batchLabel?: string;   // ชื่อรอบ (ถ้าเป็นรอบพิเศษ)
}

const META: Record<TicketSource, { label: string; emoji: string; cls: string }> = {
  preorder: { label: 'พรีออเดอร์ปกติ', emoji: '📝', cls: 'bg-[#16a34a]/[0.16] text-[#4ade80]' },
  special: { label: 'รอบพิเศษ / สต๊อกใบพรี', emoji: '⚡', cls: 'bg-[#d97706]/[0.18] text-[#fbbf24]' },
  instock: { label: 'ซื้อของพร้อมส่ง', emoji: '🛒', cls: 'bg-[#2563eb]/[0.16] text-[#60a5fa]' },
  granted: { label: 'แอดมินมอบตั๋วให้', emoji: '🎁', cls: 'bg-[#8b5cf6]/[0.18] text-[#c4b5fd]' },
  sourcing: { label: 'งานหาของ', emoji: '🔎', cls: 'bg-[#0891b2]/[0.18] text-[#67e8f9]' },
};

export function ticketSourceOf(db: Database, t: PreorderTicket): TicketSource {
  // หาของมาก่อนเสมอ — ตั๋วพวกนี้ก็ไม่มีออเดอร์เหมือน granted แต่คนละเส้นเงิน
  if (db.sourcingRequests.some((s) => s.product_id === t.product_id)) return 'sourcing';
  if (grantedTicketIds(db).has(t.id)) return 'granted';
  if (t.batch_id) return 'special';
  const p = db.products.find((x) => x.id === t.product_id);
  if (p?.is_stock && (t.remaining_amount ?? 0) === 0) return 'instock';
  return 'preorder';
}

export function ticketOrigin(db: Database, t: PreorderTicket): TicketOrigin {
  const source = ticketSourceOf(db, t);
  const order = source === 'granted' || source === 'sourcing' ? undefined : orderOfTicket(db, t);
  const batch = t.batch_id ? db.batches.find((b) => b.id === t.batch_id) : undefined;
  const deposit = t.deposit_paid ?? 0;
  const due = Math.max(0, (t.remaining_amount ?? 0) - (t.remaining_paid ?? 0));
  return {
    source, ...META[source],
    at: t.approved_at ?? t.created_at,
    price: deposit + (t.remaining_amount ?? 0),
    deposit,
    paid: deposit + (t.remaining_paid ?? 0),
    due,
    orderId: order?.id,
    batchLabel: batch?.label,
  };
}

/** จัดกลุ่มตั๋วของลูกค้า 1 คนตามแหล่งที่มา — เรียงใหม่→เก่าในแต่ละกลุ่ม */
export function ticketsBySource(db: Database, userId: string): { source: TicketSource; label: string; emoji: string; cls: string; rows: { ticket: PreorderTicket; origin: TicketOrigin }[]; price: number; paid: number; due: number }[] {
  const order: TicketSource[] = ['preorder', 'special', 'granted', 'sourcing', 'instock'];
  const mine = db.tickets.filter((t) => t.owner_id === userId).map((t) => ({ ticket: t, origin: ticketOrigin(db, t) }));
  return order
    .map((source) => {
      const rows = mine.filter((x) => x.origin.source === source).sort((a, b) => (a.origin.at < b.origin.at ? 1 : -1));
      return {
        source, ...META[source], rows,
        price: rows.reduce((s, x) => s + x.origin.price, 0),
        paid: rows.reduce((s, x) => s + x.origin.paid, 0),
        due: rows.reduce((s, x) => s + x.origin.due, 0),
      };
    })
    .filter((g) => g.rows.length > 0);
}
