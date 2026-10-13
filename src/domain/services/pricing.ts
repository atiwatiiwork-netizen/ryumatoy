import type { Database, Product, ShopSettings, WcfType } from '../entities';
import { isPendingHold } from './reservations';

/**
 * ค่าส่งเพิ่มตามช่วงต้นทุน (v87 · เจ้าของ 2026-10-13: เปลี่ยนมาส่งรถ เรทเดิมขาดทุน)
 *   ต้นทุน < surcharge_from_yuan_1 → +0 (288–348 เท่าเดิม)
 *   ต้นทุน ≥ surcharge_from_yuan_1 → +surcharge_baht_1 (ตั้งต้น 349 → +40)
 *   ต้นทุน ≥ surcharge_from_yuan_2 → +surcharge_baht_2 (ตั้งต้น 500 → +80 · แทนขั้น 1 ไม่บวกซ้อน)
 * เป็นก้อนคงที่ต่อชิ้น ไม่ใช่ต่อหยวน — ตั้งค่าได้ที่ /admin/payment
 */
export function shippingSurcharge(settings: ShopSettings, yuan: number): number {
  const y1 = Number(settings.surcharge_from_yuan_1) || 0;
  const y2 = Number(settings.surcharge_from_yuan_2) || 0;
  const b1 = Math.max(0, Number(settings.surcharge_baht_1) || 0);
  const b2 = Math.max(0, Number(settings.surcharge_baht_2) || 0);
  if (y2 > 0 && yuan >= y2) return b2;
  if (y1 > 0 && yuan >= y1) return b1;
  return 0;
}

/**
 * Cost/price calculator (PRD intake). Selling price scales linearly with the
 * yuan cost: ฿ = baht_base + (yuan − yuan_base) × baht_per_yuan, แล้วบวกค่าส่งเพิ่มตามช่วง (shippingSurcharge).
 * e.g. 288¥ → 1550฿ ; 348¥ → 1550 + 60×5 = 1850฿ ; 400¥ → 2110 + 40 = 2150฿ ; 500¥ → 2610 + 80 = 2690฿.
 * Constants live in ShopSettings so admin can adjust them as the rate moves.
 */
export function priceFromYuan(settings: ShopSettings, yuan: number): number {
  // floor ที่ 0 — สูตรเชิงเส้นให้ค่าติดลบได้ถ้า yuan ต่ำกว่า yuan_base มากๆ (money audit F12)
  const linear = Math.max(0, Math.round(settings.baht_base + (yuan - settings.yuan_base) * settings.baht_per_yuan));
  return linear + shippingSurcharge(settings, yuan);
}

/**
 * "มีคนพรีแล้ว" ของ SKU นี้ (ทุกรอบ · ทุกทาง) — ด่านของกฎเจ้าของ 2026-10-13: สินค้าที่มีลูกค้าแล้วห้ามแตะราคา
 *   · ตั๋วที่ออกแล้ว (กระดานหลักหรือรอบพิเศษ · รวมแอดมินมอบ)
 *   · รายการในออเดอร์ที่ยัง "รอตรวจ" (จ่ายมัดจำแล้ว รอแอดมินอนุมัติ — ตั๋วยังไม่ออก แต่ลูกค้าตกลงราคานั้นแล้ว)
 *   · hold ที่ค้างระหว่างซื้อ (กำลังอยู่หน้าจ่าย/ส่งสลิปแล้ว) — ราคาที่เขาเห็นต้องไม่ขยับใต้เท้า
 */
export function bookedProductIds(db: Database): Set<string> {
  const ids = new Set<string>();
  for (const t of db.tickets) ids.add(t.product_id);
  for (const o of db.orders) if (o.status === 'pending_approval') for (const i of o.items ?? []) ids.add(i.product_id);
  for (const r of db.stockReservations) if (r.product_id && isPendingHold(r)) ids.add(r.product_id);
  return ids;
}
export function hasPreorderBookings(db: Database, productId: string): boolean {
  return bookedProductIds(db).has(productId);
}

export type RepriceOpts = { booked?: Set<string> };

/**
 * เมื่อแอดมินบันทึกสูตร (from → to): ราคา/มัดจำใหม่ของสินค้า 1 ตัว — หรือ null ถ้าสินค้านั้นห้ามแตะ:
 *   ไม่ใช่พรี (is_stock) · รอบไม่ได้เปิดรับ (status ≠ open) · มีคนพรีแล้ว (bookedProductIds) · สินค้าหลายแบบ
 * ขยับเฉพาะค่าที่ "ตามสูตร" อยู่ (กฎเจ้าของ 2026-10-13 · ปุ่มอัปเดตราคาถูกถอด เพราะ v88 ปรับของเดิมในฐานข้อมูลแล้ว):
 *   · ราคา: ขยับเมื่อราคาตอนนี้ = สูตรเก่า → สูตรใหม่ · ราคาที่ตั้งเอง (≠ สูตรเก่า) ไม่ถูกแตะ
 *   · มัดจำ: ขยับเมื่อมัดจำตอนนี้ = เรทเก่าของชนิดนั้น → เรทใหม่ · มัดจำที่ตั้งเอง (เช่น 1,000) ไม่ถูกแตะ
 *   มัดจำต้องไม่เกินราคา (money audit F12)
 * ใช้ร่วมกันทั้ง mutation (updateSettings) และหน้าแอดมิน (รายการ "จะเปลี่ยน") — ห้ามมี 2 สูตร
 */
export function repriceOf(db: Database, from: ShopSettings, to: ShopSettings, p: Product, opts: RepriceOpts = {}): { price_total: number; deposit_amount: number } | null {
  if (p.is_stock || p.status !== 'open' || p.has_variants) return null;
  if ((opts.booked ?? bookedProductIds(db)).has(p.id)) return null;
  const followsPrice = p.cost_yuan != null && p.price_total === priceFromYuan(from, p.cost_yuan);
  const price_total = followsPrice ? priceFromYuan(to, p.cost_yuan!) : p.price_total;
  const followsDeposit = !!p.wcf_type && p.deposit_amount === Math.min(p.price_total, depositFor(from, p.wcf_type));
  const deposit_amount = Math.min(price_total, followsDeposit ? depositFor(to, p.wcf_type) : p.deposit_amount);
  return { price_total, deposit_amount };
}

/** สินค้าที่ "จะเปลี่ยน" ถ้าบันทึกสูตร from → to + จำนวนพรีที่เปิดอยู่แต่ถูกกันไว้เพราะมีคนพรีแล้ว */
export function repriceTargets(db: Database, from: ShopSettings, to: ShopSettings): {
  changed: { product: Product; next: { price_total: number; deposit_amount: number } }[];
  protectedCount: number;
} {
  const booked = bookedProductIds(db);
  const changed: { product: Product; next: { price_total: number; deposit_amount: number } }[] = [];
  let protectedCount = 0;
  for (const p of db.products) {
    if (p.is_stock || p.status !== 'open') continue;
    if (booked.has(p.id)) { protectedCount++; continue; }
    const next = repriceOf(db, from, to, p, { booked });
    if (next && (next.price_total !== p.price_total || next.deposit_amount !== p.deposit_amount)) changed.push({ product: p, next });
  }
  return { changed, protectedCount };
}

/** Default deposit for a product's tier — Mega WCF is higher than standard WCF. */
export function depositFor(settings: ShopSettings, wcfType?: WcfType): number {
  return wcfType === 'mega_wcf' ? settings.deposit_mega : settings.deposit_wcf;
}

/**
 * LIVE price/deposit for a cart line — read from the current batch → variant → product (in that order),
 * NOT a value snapshotted when the item was added to the cart. This is what keeps the cart, checkout, and
 * the order/ticket in lockstep: the price locks at ORDER submit (order_item.unit_price), never earlier, so
 * an admin re-pricing (e.g. a yuan-formula change) can't leave a cart billing a stale price. Falls back to
 * 0 only if the source is gone (callers skip lines whose product no longer exists).
 */
export function livePrice(db: Database, line: { productId: string; variantId?: string; batchId?: string; auctionId?: string }): { price: number; deposit: number } {
  // ประมูล (v61) มาก่อนทุกอย่าง: ราคาคือ "ยอดที่ชนะ" ของห้องนั้น และเก็บเต็มจำนวน (มัดจำ = ราคา)
  // ที่ต้องอยู่ตรงนี้เพราะ submitOrder ล็อกราคาจาก livePrice เสมอ — ถ้าไม่ดัก ผู้ชนะจะถูกคิด
  // "ราคาป้าย" ของสินค้าแทนยอดที่ประมูลได้
  if (line.auctionId) {
    const a = db.auctions.find((x) => x.id === line.auctionId);
    if (a?.winning_amount) return { price: a.winning_amount, deposit: a.winning_amount };
  }
  if (line.batchId) { const b = db.batches.find((x) => x.id === line.batchId); if (b) return { price: b.price_total, deposit: b.deposit_amount }; }
  if (line.variantId) { const v = db.variants.find((x) => x.id === line.variantId); if (v) return { price: v.price_total, deposit: v.deposit_amount }; }
  const p = db.products.find((x) => x.id === line.productId);
  if (p) return { price: p.price_total, deposit: p.deposit_amount };
  return { price: 0, deposit: 0 };
}

/** Round a price UP to the nearest 50 (…50 or …00) — used for in-stock resale pricing.
 *  e.g. 1623 → 1650, 2715 → 2750, 1650 → 1650. */
export function roundTo50(n: number): number {
  return Math.ceil(Math.max(0, n) / 50) * 50;
}
