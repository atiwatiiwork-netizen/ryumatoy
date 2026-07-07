'use client';

import Link from 'next/link';
import type { ProductBatch } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { metaLine, batchRemaining } from '@/domain/services/catalog';
import { ProductThumb, cx } from './ui';

/** A special pre-order round (สต๊อกใบพรี) shown on the shop — same figure, its own lot/price.
 *  Stock shown as "เหลือน้อย"/"สินค้าหมด" (never an exact count); sold-out stays greyed. */
export function BatchCard({ batch }: { batch: ProductBatch }) {
  const db = useDatabase();
  const product = db.products.find((p) => p.id === batch.product_id);
  if (!product) return null;
  const remaining = batchRemaining(db, batch.id, batch.stock_qty);
  const soldOut = remaining <= 0;
  const low = remaining > 0 && remaining <= 3;
  const fullPay = batch.deposit_amount >= batch.price_total;

  const inner = (
    <div className={cx('block overflow-hidden rounded-card border bg-surface-2', soldOut ? 'border-subtle opacity-60' : 'border-accent-soft')}>
      <div className="relative">
        <ProductThumb isStock={false} radius="rounded-none" src={product.images[0]} showRibbon={false} />
        <span className="absolute right-2 top-2 rounded-md bg-cta px-2 py-0.5 text-[10px] font-bold text-white">{batch.label || 'รอบพิเศษ'}</span>
        {soldOut && (
          <div className="absolute inset-0 grid place-items-center bg-black/55">
            <span className="rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-bold text-white">สินค้าหมด</span>
          </div>
        )}
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[15px] font-extrabold text-primary-soft">{baht(batch.price_total)}</span>
          {soldOut ? <span className="text-[11px] text-ink-faint">หมด</span>
            : low ? <span className="text-[11px] font-bold text-[#fbbf24]">เหลือน้อย</span>
            : <span className="text-[11px] text-ink-faint">พร้อมจอง</span>}
        </div>
        {/* full-pay batch = ready-to-ship; deposit batch = still a pre-order round */}
        <div className="mt-0.5 text-[10.5px] font-semibold text-ink-muted2">
          {fullPay ? 'พร้อมส่ง · จ่ายเต็ม' : `พรีรอบพิเศษ · มัดจำ ${baht(batch.deposit_amount)}`}
        </div>
      </div>
    </div>
  );

  // sold-out stays visible but is not clickable (nothing to buy)
  return soldOut ? inner : <Link href={`/shop/${product.id}?batch=${batch.id}`}>{inner}</Link>;
}
