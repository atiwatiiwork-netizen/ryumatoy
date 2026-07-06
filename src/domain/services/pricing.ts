import type { ShopSettings, WcfType } from '../entities';

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

/** Round a price UP to the nearest 50 (…50 or …00) — used for in-stock resale pricing.
 *  e.g. 1623 → 1650, 2715 → 2750, 1650 → 1650. */
export function roundTo50(n: number): number {
  return Math.ceil(Math.max(0, n) / 50) * 50;
}
