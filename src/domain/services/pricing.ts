import type { Database, ShopSettings, WcfType } from '../entities';

/**
 * Cost/price calculator (PRD intake). Selling price scales linearly with the
 * yuan cost: ฿ = baht_base + (yuan − yuan_base) × baht_per_yuan.
 * e.g. 288¥ → 1550฿ ; 328¥ → 1550 + 40×5 = 1750฿. Linear both directions.
 * Constants live in ShopSettings so admin can adjust them as the rate moves.
 */
export function priceFromYuan(settings: ShopSettings, yuan: number): number {
  return Math.round(settings.baht_base + (yuan - settings.yuan_base) * settings.baht_per_yuan);
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
export function livePrice(db: Database, line: { productId: string; variantId?: string; batchId?: string }): { price: number; deposit: number } {
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
