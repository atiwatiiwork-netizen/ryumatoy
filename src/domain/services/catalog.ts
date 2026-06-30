import type { Database, Product, Franchise, Manufacturer, Series, ProductVariant } from '../entities';

/** Catalog read helpers — derive views over the products graph. No mutation. */

export function franchiseOf(db: Database, product: Product): Franchise | undefined {
  return db.franchises.find((f) => f.id === product.franchise_id);
}

export function manufacturerOf(db: Database, product: Product): Manufacturer | undefined {
  return db.manufacturers.find((m) => m.id === product.manufacturer_id);
}

export function manufacturerNameOf(db: Database, product: Product): string {
  return manufacturerOf(db, product)?.name ?? '';
}

export function seriesOf(db: Database, product: Product): Series | undefined {
  return product.series_id ? db.series.find((s) => s.id === product.series_id) : undefined;
}

export function variantsOf(db: Database, productId: string): ProductVariant[] {
  return db.variants.filter((v) => v.product_id === productId);
}

/** Series under a franchise (optionally further limited to those a maker carries). */
export function seriesForFranchise(db: Database, franchiseId: string, makerId?: string): Series[] {
  return db.series.filter((s) => s.franchise_id === franchiseId && (!makerId || s.maker_ids.includes(makerId)));
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
  return [fr?.abbr ?? '??', maker, typeLabel(product.type)].filter(Boolean).join('·');
}

export interface ProductFilter {
  category?: 'preorder' | 'instock' | null;
  franchiseId?: string | null;
  manufacturerId?: string | null;
  seriesId?: string | null;
  type?: Product['type'] | null;
  status?: Product['status'] | null;
  query?: string;
}

export function filterProducts(db: Database, f: ProductFilter): Product[] {
  return db.products.filter((p) => {
    if (f.category === 'preorder' && p.is_stock) return false;
    if (f.category === 'instock' && !p.is_stock) return false;
    if (f.franchiseId && p.franchise_id !== f.franchiseId) return false;
    if (f.manufacturerId && p.manufacturer_id !== f.manufacturerId) return false;
    if (f.seriesId && p.series_id !== f.seriesId) return false;
    if (f.type && p.type !== f.type) return false;
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
