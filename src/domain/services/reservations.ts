import type { Database, Product, ProductBatch, StockReservation } from '../entities';

/** A reservation counts against stock while: paid, confirmed, or active-and-unexpired. */
export function isHeld(r: StockReservation): boolean {
  if (r.status === 'paid' || r.status === 'confirmed') return true;
  if (r.status === 'active' && r.reserved_until) return new Date(r.reserved_until) > new Date();
  return false;
}

/** Units currently held for a product (no batch) or a specific batch. */
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

/** Available-to-buy for a product = total − held (reservation-based, oversell-proof). */
export function availableFor(db: Database, p: Product): number {
  return Math.max(0, stockTotalOf(db, p) - reservedHeld(db, p.id));
}

export function batchAvailable(db: Database, b: ProductBatch): number {
  return Math.max(0, (b.stock_qty ?? 0) - reservedHeld(db, b.product_id, b.id));
}
