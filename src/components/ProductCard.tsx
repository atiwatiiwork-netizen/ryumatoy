'use client';

import Link from 'next/link';
import type { Product } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { metaLine } from '@/domain/services/catalog';
import { instockPriceFor } from '@/domain/services/ranks';
import { CURRENT_USER_ID } from '@/data/seed';
import { ProductThumb, StatusBadge } from './ui';

/** Product card used on Home grid + Shop grid. Links to the product route. */
export function ProductCard({ product }: { product: Product }) {
  const db = useDatabase();
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';
  const memberPrice = product.is_stock ? instockPriceFor(db.settings, myRank, product.price_total) : product.price_total;
  const saved = memberPrice < product.price_total;
  return (
    <Link href={`/shop/${product.id}`} className="block overflow-hidden rounded-card border border-subtle bg-surface-2">
      <div className="relative">
        <ProductThumb isStock={product.is_stock} radius="rounded-none" src={product.images[0]} />
        <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} className="absolute bottom-2 right-2" />
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-[15px] font-extrabold text-primary-soft">{baht(memberPrice)}</span>
          {saved && <span className="text-[11px] text-ink-faint line-through">{baht(product.price_total)}</span>}
        </div>
        {saved && <div className="text-[10px] font-bold text-[#f1d27a]">ราคาสมาชิก ✦</div>}
      </div>
    </Link>
  );
}
