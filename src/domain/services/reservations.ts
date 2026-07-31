import type { Database, Product, ProductBatch, StockReservation } from '../entities';

/**
 * บัญชีสต๊อกเดียว (audit 2026-07-23 — เดิมมี "2 เล่ม" ตั๋ว vs ใบจอง แล้วมองไม่เห็นกัน):
 *   ใช้ไป = ตั๋วที่ออกแล้ว (ทุกทาง รวมแอดมินมอบ) + hold ที่ยังค้างระหว่างซื้อ (active ไม่หมดอายุ / paid รอตรวจ)
 * ใบจองสถานะ 'confirmed' (approve แล้ว) ไม่นับ — เพราะตั๋วของออเดอร์นั้นถูกนับแทนแล้ว (กันหักซ้ำ).
 * สูตรนี้ต้องตรงกับ server RPC ryuma_available (migration_reserve_v55) เสมอ.
 */

/** hold ที่ค้างระหว่างซื้อ (ยังไม่มีตั๋ว): จ่ายสลิปแล้วรอตรวจ หรือกำลังอยู่หน้าจ่าย (15 นาที). */
export function isPendingHold(r: StockReservation): boolean {
  if (r.status === 'paid') return true;
  if (r.status === 'active' && r.reserved_until) return new Date(r.reserved_until) > new Date();
  return false;
}
/** (เดิม) hold ที่นับว่ากันของอยู่ รวม confirmed — คงไว้ให้โค้ดเก่าที่อ้าง isHeld ตรงๆ */
export function isHeld(r: StockReservation): boolean {
  return r.status === 'confirmed' || isPendingHold(r);
}

/** hold ค้าง (pending เท่านั้น) ของ product (ไม่มี batch) หรือของ batch. */
export function pendingHeld(db: Database, productId: string, batchId?: string): number {
  return db.stockReservations
    .filter((r) => (batchId ? r.batch_id === batchId : r.product_id === productId && !r.batch_id))
    .filter(isPendingHold)
    .reduce((s, r) => s + r.qty, 0);
}

/** @deprecated เดิมรวม confirmed (บัญชีใบจองล้วน) — เหลือไว้เผื่ออ้างอิง; ใช้ pendingHeld + ตั๋วแทน */
export function reservedHeld(db: Database, productId: string, batchId?: string): number {
  return db.stockReservations
    .filter((r) => (batchId ? r.batch_id === batchId : r.product_id === productId && !r.batch_id))
    .filter(isHeld)
    .reduce((s, r) => s + r.qty, 0);
}

/** Total stock for an in-stock/surplus product (before holds). */
export function stockTotalOf(db: Database, p: Product): number {
  if (p.is_stock) return p.stock_qty ?? 0;
  return (p.surplus_qty ?? 0) + db.stockAdditions.filter((a) => a.product_id === p.id).reduce((s, a) => s + a.qty, 0);
}

/** ตั๋วขาย in-stock ของ product นี้ (ไม่ผูก batch + จ่ายเต็มไม่มีส่วนต่าง) — ตั๋วพรีเดิมบน SKU
 *  ที่ถูก convert ทีหลัง (remaining > 0) ไม่นับ เพราะ stock_qty ตอน convert หักส่วนที่ขายไปแล้ว. */
export function instockSoldQty(db: Database, productId: string): number {
  return db.tickets
    .filter((t) => t.product_id === productId && !t.batch_id && t.remaining_amount === 0)
    .reduce((s, t) => s + t.qty, 0);
}

/** ตั๋วที่ออกแล้วของรอบ (ทุกทาง: ซื้อ/แอดมินมอบ). */
export function batchSoldTickets(db: Database, batchId: string): number {
  return db.tickets.filter((t) => t.batch_id === batchId).reduce((s, t) => s + t.qty, 0);
}

/** Available-to-buy สินค้า in-stock = สต๊อก − ตั๋วขายแล้ว − hold ค้าง. */
export function availableFor(db: Database, p: Product): number {
  return Math.max(0, stockTotalOf(db, p) - instockSoldQty(db, p.id) - pendingHeld(db, p.id));
}

/** Available-to-buy ของรอบพิเศษ = สต๊อกรอบ − ตั๋วออกแล้ว (รวม grant) − hold ค้าง. */
export function batchAvailable(db: Database, b: ProductBatch): number {
  return Math.max(0, (b.stock_qty ?? 0) - batchSoldTickets(db, b.id) - pendingHeld(db, b.product_id, b.id));
}

// ── เพดานซื้อรอบพิเศษต่อคน (เจ้าของ 2026-07-30 — ของ hot คนแย่งกัน เช่น Orochimaru) ──
// เดิม 3 → ลดเป็น 2 (เจ้าของสั่งคืนวันเดียวกัน ก่อนลงจริง)
export const BATCH_MAX_PER_USER = 2;

/** จำนวนที่คนนี้ "ถือแล้ว" ในรอบ = ตั๋วที่ออกแล้ว (รวมที่แอดมินมอบ) + hold ค้างของตัวเอง
 *  (กำลังอยู่หน้าจ่าย/สลิปรอตรวจ). excludeResIds = hold ที่หนุนออเดอร์ที่กำลังส่งอยู่ตอนนี้ —
 *  ต้องยกเว้น ไม่งั้นการซื้อครั้งแรกถูกนับซ้ำ (hold 3 + รายการ 3 = 6 ทั้งที่คือของก้อนเดียวกัน). */
export function userTakenInBatch(db: Database, userId: string, batchId: string, excludeResIds?: string[]): number {
  const fromTickets = db.tickets.filter((t) => t.batch_id === batchId && t.owner_id === userId).reduce((s, t) => s + t.qty, 0);
  const fromHolds = db.stockReservations
    .filter((r) => r.batch_id === batchId && r.user_id === userId && !excludeResIds?.includes(r.id))
    .filter(isPendingHold)
    .reduce((s, r) => s + r.qty, 0);
  return fromTickets + fromHolds;
}

/** จำนวนที่ "คนนี้ถือค้างอยู่เอง" ตอนนี้ (กำลังจ่าย/สลิปรอตรวจ) ของ batch หรือ product (in-stock).
 *  ใช้บวกกลับตอนเทียบกับ ryuma_available ซึ่งหัก hold ทุกใบรวมของเจ้าตัวไปแล้ว. */
export function myPendingHold(db: Database, userId: string, productId: string, batchId?: string): number {
  return db.stockReservations
    .filter((r) => r.user_id === userId && (batchId ? r.batch_id === batchId : r.product_id === productId && !r.batch_id))
    .filter(isPendingHold)
    .reduce((s, r) => s + r.qty, 0);
}

/** โควตาที่ยังซื้อได้ในรอบนี้ตามเพดานต่อคน (ยังไม่หักว่าสต๊อกเหลือจริงเท่าไหร่). */
export function userBatchQuota(db: Database, userId: string, batchId: string): number {
  return Math.max(0, BATCH_MAX_PER_USER - userTakenInBatch(db, userId, batchId));
}

/** สถานะ "หมด" ของรอบ (เจ้าของ 2026-07-30): null = ยังมีของ ·
 *  'temp' = หมดชั่วคราว — มีคนถือ hold/สลิปรอตรวจอยู่ ถ้าไม่ผ่าน/หมดเวลา ของจะหลุดกลับมา ·
 *  'gone' = หมดจริง — ตั๋วออกครบทั้งรอบแล้ว ไม่มีทางหลุด. */
export function batchGoneState(db: Database, b: ProductBatch): 'temp' | 'gone' | null {
  if (batchAvailable(db, b) > 0) return null;
  return pendingHeld(db, b.product_id, b.id) > 0 ? 'temp' : 'gone';
}

/** เวอร์ชัน in-stock ของ batchGoneState — แนวคิดเดียวกัน (hold ค้าง = อาจหลุดคืน). */
export function stockGoneState(db: Database, p: Product): 'temp' | 'gone' | null {
  if (!p.is_stock || availableFor(db, p) > 0) return null;
  return pendingHeld(db, p.id) > 0 ? 'temp' : 'gone';
}
