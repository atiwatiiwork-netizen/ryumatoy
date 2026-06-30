import type { Database, Product, Franchise, ProductVariant } from '../entities';

/** Catalog read helpers — derive views over the products graph. No mutation. */

export function franchiseOf(db: Database, product: Product): Franchise | undefined {
  return db.franchises.find((f) => f.id === product.franchise_id);
}

export function manufacturerNameOf(db: Database, product: Product): string {
  const fr = franchiseOf(db, product);
  return db.manufacturers.find((m) => m.id === fr?.manufacturer_id)?.name ?? '';
}

export function variantsOf(db: Database, productId: string): ProductVariant[] {
  return db.variants.filter((v) => v.product_id === productId);
}

const TYPE_LABEL: Record<Product['type'], string> = {
  wcf: 'WCF',
  figure: 'Figure',
  resin: 'Resin',
  other: 'Other',
};
export const typeLabel = (t: Product['type']) => TYPE_LABEL[t];

/** `op·WCF` style meta line used on product cards. */
export function metaLine(db: Database, product: Product): string {
  const fr = franchiseOf(db, product);
  return `${fr?.abbr ?? '??'}·${typeLabel(product.type)}`;
}

export interface ProductFilter {
  category?: 'preorder' | 'instock' | null;
  manufacturerId?: string | null;
  franchiseId?: string | null;
  type?: Product['type'] | null;
  status?: Product['status'] | null;
  query?: string;
}

export function filterProducts(db: Database, f: ProductFilter): Product[] {
  return db.products.filter((p) => {
    if (f.category === 'preorder' && p.is_stock) return false;
    if (f.category === 'instock' && !p.is_stock) return false;
    if (f.franchiseId && p.franchise_id !== f.franchiseId) return false;
    if (f.manufacturerId) {
      const fr = franchiseOf(db, p);
      if (fr?.manufacturer_id !== f.manufacturerId) return false;
    }
    if (f.type && p.type !== f.type) return false;
    if (f.status && p.status !== f.status) return false;
    if (f.query) {
      const q = f.query.toLowerCase();
      const hay = `${p.series_name} ${manufacturerNameOf(db, p)} ${franchiseOf(db, p)?.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export const remaining = (price: number, deposit: number) => Math.max(0, price - deposit);
