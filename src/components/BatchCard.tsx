'use client';

import Link from 'next/link';
import type { ProductBatch } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { metaLine, batchRemaining } from '@/domain/services/catalog';
import { ProductThumb } from './ui';

/** A reopened stock batch shown on the shop — same figure, its own lot/price. */
export function BatchCard({ batch }: { batch: ProductBatch }) {
  const db = useDatabase();
  const product = db.products.find((p) => p.id === batch.product_id);
  if (!product) return null;
  return (
    <Link href={`/shop/${product.id}?batch=${batch.id}`} className="block overflow-hidden rounded-card border border-accent-soft bg-surface-2">
      <div className="relative">
        <ProductThumb isStock={false} radius="rounded-none" src={product.images[0]} showRibbon={false} />
        <span className="absolute right-2 top-2 rounded-md bg-cta px-2 py-0.5 text-[10px] font-bold text-white">รอบใหม่</span>
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[15px] font-extrabold text-primary-soft">{baht(batch.price_total)}</span>
          <span className="text-[11px] text-ink-faint">เหลือ {batchRemaining(db, batch.id, batch.stock_qty)}</span>
        </div>
      </div>
    </Link>
  );
}
