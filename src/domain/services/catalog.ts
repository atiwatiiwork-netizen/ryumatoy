import type { Database, Product, Franchise, Manufacturer, Category, Series, ProductVariant } from '../entities';

/** Catalog read helpers — derive views over the products graph. No mutation. */

/** Human size line from the structured fields — "สูง 8.8 · กว้าง 5 · ลึก 3 ซม.".
 *  Height leads; width/depth appear only when set. Empty string when no size given. */
export function dimensionLabel(p: Product): string {
  const parts: string[] = [];
  if (p.height_cm != null) parts.push(`สูง ${p.height_cm}`);
  if (p.width_cm != null) parts.push(`กว้าง ${p.width_cm}`);
  if (p.depth_cm != null) parts.push(`ลึก ${p.depth_cm}`);
  return parts.length ? `${parts.join(' · ')} ซม.` : '';
}

export function franchiseOf(db: Database, product: Product): Franchise | undefined {
  return db.franchises.find((f) => f.id === product.franchise_id);
}

export function manufacturerOf(db: Database, product: Product): Manufacturer | undefined {
  return db.manufacturers.find((m) => m.id === product.manufacturer_id);
}

export function manufacturerNameOf(db: Database, product: Product): string {
  return manufacturerOf(db, product)?.name ?? '';
}

/** ประเภท/Type of a product, derived from its maker's category. */
export function categoryOf(db: Database, product: Product): Category | undefined {
  const maker = manufacturerOf(db, product);
  return maker ? db.categories.find((c) => c.id === maker.category_id) : undefined;
}

/** Makers under a category (used to narrow the ค่าย filter by Type). */
export function makersOfCategory(db: Database, categoryId: string): Manufacturer[] {
  return db.manufacturers.filter((m) => m.category_id === categoryId);
}

export function seriesOf(db: Database, product: Product): Series | undefined {
  return product.series_id ? db.series.find((s) => s.id === product.series_id) : undefined;
}

export function variantsOf(db: Database, productId: string): ProductVariant[] {
  return db.variants.filter((v) => v.product_id === productId);
}

/** The picked variant of a line/ticket/order-item, if any. */
export function variantOf(db: Database, variantId?: string): ProductVariant | undefined {
  return variantId ? db.variants.find((v) => v.id === variantId) : undefined;
}

/** Canonical display label for anything that references a product + optional variant (cart line,
 *  order item, ticket): "SeriesName · VariantName - ค่าย". ONE place so every surface (wallet, cart,
 *  checkout, admin) shows the picked แบบ consistently — and ALWAYS ends with the maker, because the
 *  same character exists from several ค่าย and bare names are indistinguishable (owner 2026-07-16).
 *  (fixes: variant A missing on the wallet; same-character-different-maker confusion) */
export function productLabel(db: Database, productId: string, variantId?: string): string {
  const p = db.products.find((x) => x.id === productId);
  const v = variantOf(db, variantId);
  const maker = p ? manufacturerOf(db, p)?.name : undefined;
  const base = `${p?.series_name ?? ''}${v?.name ? ` · ${v.name}` : ''}`;
  // append " - ค่าย" unless the name already carries it (avoid "Deidara - GEM - GEM")
  return maker && !base.toLowerCase().includes(maker.toLowerCase()) ? `${base} - ${maker}` : base;
}

/** Image for a product line honouring the picked variant: the variant's own image first, else the
 *  product's, else any variant image on the product. */
export function lineImage(db: Database, productId: string, variantId?: string): string | undefined {
  const p = db.products.find((x) => x.id === productId);
  return variantOf(db, variantId)?.image_url ?? p?.images?.[0] ?? db.variants.find((v) => v.product_id === productId && v.image_url)?.image_url;
}

/** Product is still taking bookings via an OPEN board → shown in shop, but NOT yet eligible for the
 *  production queue (the board must be closed first). Prevents a board product being finalized twice. */
export function inOpenBoard(db: Database, p: Product): boolean {
  return !!p.board_id && db.boards.some((b) => b.id === p.board_id && b.status === 'open');
}
/** Board round has ended (board closed) but the product hasn't been sent to production yet →
 *  hidden from the shop, and now eligible for ปิดรอบสั่งผลิต to set the final production qty. */
export function inClosedBoard(db: Database, p: Product): boolean {
  return !!p.board_id && db.boards.some((b) => b.id === p.board_id && b.status !== 'open');
}

/** Tickets that still owe money (unfinished pre-orders) for a product. */
export function outstandingTickets(db: Database, productId: string): number {
  return db.tickets.filter((t) => t.product_id === productId && (t.remaining_amount - t.remaining_paid) > 0).length;
}
/** A finished pre-order that can be flipped to in-stock: still a pre-order, ถึงไทยแล้ว/ส่งมอบ, has
 *  leftover surplus, and NO ticket is still unpaid (the whole round is settled). */
export function canConvertToInStock(db: Database, p: Product): boolean {
  return !p.is_stock && (p.status === 'arrived' || p.status === 'delivered') && (p.surplus_qty ?? 0) > 0 && outstandingTickets(db, p.id) === 0;
}

/** Series under a franchise (optionally further limited to those a maker carries). */
export function seriesForFranchise(db: Database, franchiseId: string, makerId?: string): Series[] {
  return db.series.filter((s) => s.franchise_ids.includes(franchiseId) && (!makerId || s.maker_ids.includes(makerId)));
}

/** Makers that actually make a series under this เรื่อง — derived from series.maker_ids, so the
 *  ค่าย picker only offers makers relevant to the chosen franchise (e.g. Hunter×Hunter → only ks).
 *  Falls back to ALL makers when no series under the franchise names a maker yet, so a brand-new
 *  franchise (no series defined) is never stuck with an empty picker. */
export function makersForFranchise(db: Database, franchiseId: string): Manufacturer[] {
  if (!franchiseId) return db.manufacturers;
  const ids = new Set<string>();
  for (const s of db.series) if (s.franchise_ids.includes(franchiseId)) s.maker_ids.forEach((m) => ids.add(m));
  const list = db.manufacturers.filter((m) => ids.has(m.id));
  return list.length ? list : db.manufacturers;
}

/** Group products by ค่าย → then ซีรีย์, newest-first within each group. Products with no
 *  series fall into a null-series group. Used by both the admin list and the customer shop
 *  so everything reads in a tidy maker → series order. */
export function groupByMakerSeries(db: Database, products: Product[]) {
  const byMaker = new Map<string, Product[]>();
  for (const p of products) { if (!byMaker.has(p.manufacturer_id)) byMaker.set(p.manufacturer_id, []); byMaker.get(p.manufacturer_id)!.push(p); }
  const newestFirst = (a: Product, b: Product) => (a.created_at < b.created_at ? 1 : -1);
  return [...byMaker.entries()]
    .map(([makerId, ps]) => {
      const bySeries = new Map<string, Product[]>();
      for (const p of ps) { const k = p.series_id ?? '__none'; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k)!.push(p); }
      const groups = [...bySeries.entries()]
        .map(([sid, gps]) => ({
          seriesId: sid === '__none' ? null : sid,
          seriesName: sid === '__none' ? null : (db.series.find((s) => s.id === sid)?.name ?? null),
          products: gps.sort(newestFirst),
        }))
        .sort((a, b) => (a.seriesName ?? 'zzz').localeCompare(b.seriesName ?? 'zzz')); // named series first, "อื่นๆ" last
      return { makerId, makerName: db.manufacturers.find((m) => m.id === makerId)?.name ?? '—', groups };
    })
    .sort((a, b) => a.makerName.localeCompare(b.makerName));
}

const TYPE_LABEL: Record<Product['type'], string> = {
  wcf: 'WCF',
  figure: 'Figure',
  resin: 'Resin',
  other: 'Other',
};
export const typeLabel = (t: Product['type']) => TYPE_LABEL[t];

/** `op·A+·WCF` style meta line used on product cards (เรื่อง·ค่าย·ประเภท). */
export function metaLine(db: Database, product: Product): string {
  const fr = franchiseOf(db, product);
  const maker = manufacturerNameOf(db, product);
  const cat = categoryOf(db, product)?.name;
  return [fr?.abbr ?? '??', maker, cat].filter(Boolean).join('·');
}

export interface ProductFilter {
  category?: 'preorder' | 'instock' | 'special' | null;
  categoryId?: string | null; // ประเภท/Type (via maker)
  franchiseId?: string | null;
  manufacturerId?: string | null;
  seriesId?: string | null;
  status?: Product['status'] | null;
  query?: string;
}

export function filterProducts(db: Database, f: ProductFilter): Product[] {
  return db.products.filter((p) => {
    // pre-orders leave the shop once the round closes (→ผลิต/เดินทาง/…); wallet still tracks them
    if (!p.is_stock && p.status !== 'open') return false;
    // a closed board ends its round → its products leave the shop even though still 'open'
    if (inClosedBoard(db, p)) return false;
    // NOTE: sold-out in-stock (available ≤ 0) stays in the shop — shown greyed as "สินค้าหมด" (not removed)
    if (f.category === 'preorder' && p.is_stock) return false;
    if (f.category === 'instock' && !p.is_stock) return false;
    if (f.categoryId && categoryOf(db, p)?.id !== f.categoryId) return false;
    if (f.franchiseId && p.franchise_id !== f.franchiseId) return false;
    if (f.manufacturerId && p.manufacturer_id !== f.manufacturerId) return false;
    if (f.seriesId && p.series_id !== f.seriesId) return false;
    if (f.status && p.status !== f.status) return false;
    if (f.query) {
      const q = f.query.toLowerCase();
      const hay = `${p.series_name} ${manufacturerNameOf(db, p)} ${franchiseOf(db, p)?.name ?? ''} ${seriesOf(db, p)?.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export const remaining = (price: number, deposit: number) => Math.max(0, price - deposit);

/** Total pre-ordered quantity for a product (sum of ticket qty). */
export function orderedQtyOf(db: Database, productId: string): number {
  return db.tickets.filter((t) => t.product_id === productId).reduce((s, t) => s + t.qty, 0);
}

// ---- Surplus stock accounting (reopened batches) ---------------------------

const batchIdsOf = (db: Database, productId: string) => db.batches.filter((b) => b.product_id === productId).map((b) => b.id);

/** Qty of a batch already bought (sum of ticket qty referencing it). */
export function batchSoldQty(db: Database, batchId: string): number {
  return db.tickets.filter((t) => t.batch_id === batchId).reduce((s, t) => s + t.qty, 0);
}

/** Remaining unsold qty of a single batch. */
export function batchRemaining(db: Database, batchId: string, stockQty: number): number {
  return Math.max(0, stockQty - batchSoldQty(db, batchId));
}

/** Does a product have an OPEN special round (สต๊อกใบพรี) right now? */
export function hasOpenBatch(db: Database, productId: string): boolean {
  return db.batches.some((b) => b.product_id === productId && b.status === 'open');
}
export function openBatchOf(db: Database, productId: string) {
  return db.batches.find((b) => b.product_id === productId && b.status === 'open');
}
/** Batches currently on a special round (open) — the "พรีรอบพิเศษ" storefront category.
 *  ร่าง (published === false) ไม่ขึ้นหน้าร้าน — โผล่เมื่อแอดมินกด "เปิดขาย" เท่านั้น (v53). */
export function openRoundBatches(db: Database) {
  return db.batches.filter((b) => b.status === 'open' && b.published !== false);
}

/** Detailed buyers of a single round (batch): name + qty + price paid (snapshot total) + ticket + date. */
export function batchBuyers(db: Database, batchId: string): { name: string; qty: number; paid: number; ticket_no: string; created_at: string }[] {
  return db.tickets
    .filter((t) => t.batch_id === batchId)
    .map((t) => ({ name: db.users.find((u) => u.id === t.owner_id)?.display_name ?? '—', qty: t.qty, paid: t.deposit_paid + t.remaining_amount, ticket_no: t.ticket_no, created_at: t.created_at }));
}

/** Total surplus stock of a product still unsold (surplus_qty − sold across its batches). */
export function stockSoldQty(db: Database, productId: string): number {
  const ids = batchIdsOf(db, productId);
  return db.tickets.filter((t) => t.batch_id && ids.includes(t.batch_id)).reduce((s, t) => s + t.qty, 0);
}
export function stockRemaining(db: Database, product: Product): number {
  return Math.max(0, (product.surplus_qty ?? 0) - stockSoldQty(db, product.id));
}

/** Manual stock top-ups for a product (newest first) — for the audit view. */
export function stockAdditionsOf(db: Database, productId: string) {
  return db.stockAdditions.filter((a) => a.product_id === productId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Who bought this product's surplus stock — buyer name + qty + ticket no. */
export function stockBuyers(db: Database, productId: string): { name: string; qty: number; ticket_no: string }[] {
  const ids = batchIdsOf(db, productId);
  return db.tickets
    .filter((t) => t.batch_id && ids.includes(t.batch_id))
    .map((t) => ({ name: db.users.find((u) => u.id === t.owner_id)?.display_name ?? '—', qty: t.qty, ticket_no: t.ticket_no }));
}
