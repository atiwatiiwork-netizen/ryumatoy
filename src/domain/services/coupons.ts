import type { Coupon, CouponGrant, CouponScope, Database, Product } from '../entities';

/**
 * Coupon helpers — the single place that decides eligibility + discount amount.
 * DNA: fixed baht off, one coupon per order, capped so the payable never goes below 0.
 * (ryuma-coupon-spec)
 */

/** Visual tier by baht value — Ultimate (>=200, diamond) / Premium (>=100, red) / Basic (bronze).
 *  The whole coupon look (color, label, sparkle) is driven off this. (ryuma-coupon-spec) */
export type CouponTier = 'basic' | 'premium' | 'ultimate';
export function couponTier(value: number): CouponTier {
  if (value >= 200) return 'ultimate';
  if (value >= 100) return 'premium';
  return 'basic';
}

/** A coupon is expired when it has an expires_at strictly before `now` (end-of-day inclusive). */
export function couponExpired(coupon: Coupon, now: Date = new Date()): boolean {
  if (!coupon.expires_at) return false;
  // treat expires_at as the last valid day → expired only after that day ends
  const end = new Date(coupon.expires_at);
  end.setHours(23, 59, 59, 999);
  return now.getTime() > end.getTime();
}

/** Does a coupon's product/maker targeting match this product? (untargeted = matches all) */
export function couponMatchesProduct(coupon: Coupon, product: Product): boolean {
  if (coupon.target_product_id && coupon.target_product_id !== product.id) return false;
  if (coupon.target_maker_id && coupon.target_maker_id !== product.manufacturer_id) return false;
  return true;
}

/** Does a coupon's scope allow use on an in-stock (true) vs pre-order (false) line? */
export function scopeAllows(scope: CouponScope, isStock: boolean): boolean {
  return scope === 'both' || (isStock ? scope === 'instock' : scope === 'preorder');
}

/** Baht discount a coupon gives against `amount` — fixed value capped at the amount (never negative). */
export function couponDiscount(coupon: Coupon, amount: number): number {
  return Math.max(0, Math.min(coupon.value, Math.max(0, Math.round(amount))));
}

export type UsableGrant = { grant: CouponGrant; coupon: Coupon };

/** The customer's coupons that are still usable right now (active, coupon active, not expired). */
export function usableGrantsFor(db: Database, userId: string, now: Date = new Date()): UsableGrant[] {
  return db.couponGrants
    .filter((g) => g.user_id === userId && g.status === 'active')
    .map((g) => ({ grant: g, coupon: db.coupons.find((c) => c.id === g.coupon_id)! }))
    .filter((x) => x.coupon && x.coupon.active && !couponExpired(x.coupon, now));
}

/**
 * Coupons the customer can apply to an IN-STOCK checkout: usable + scope allows in-stock +
 * targeting matches at least one in-stock product in the cart.
 */
export function instockCouponsFor(db: Database, userId: string, cartProductIds: string[], now: Date = new Date()): UsableGrant[] {
  const instockProducts = cartProductIds
    .map((pid) => db.products.find((p) => p.id === pid))
    .filter((p): p is Product => !!p && p.is_stock);
  return usableGrantsFor(db, userId, now).filter(
    (x) => scopeAllows(x.coupon.scope, true) && instockProducts.some((p) => couponMatchesProduct(x.coupon, p)),
  );
}

/** Coupons the customer can apply to ONE pre-order ticket's final payment: usable + scope allows
 *  pre-order + targeting matches this ticket's product. */
export function preorderCouponsForTicket(db: Database, userId: string, product: Product, now: Date = new Date()): UsableGrant[] {
  return usableGrantsFor(db, userId, now).filter(
    (x) => scopeAllows(x.coupon.scope, false) && couponMatchesProduct(x.coupon, product),
  );
}

/** Detailed tracking counts for an admin coupon row. */
export function grantStats(db: Database, couponId: string) {
  const gs = db.couponGrants.filter((g) => g.coupon_id === couponId);
  return {
    granted: gs.length,
    active: gs.filter((g) => g.status === 'active').length,
    used: gs.filter((g) => g.status === 'used').length,
    revoked: gs.filter((g) => g.status === 'revoked').length,
  };
}
