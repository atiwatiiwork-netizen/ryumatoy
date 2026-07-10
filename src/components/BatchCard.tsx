'use client';

import Link from 'next/link';
import type { ProductBatch } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { metaLine } from '@/domain/services/catalog';
import { batchAvailable } from '@/domain/services/reservations';
import { ProductThumb, cx } from './ui';

/** A special pre-order round (สต๊อกใบพรี) shown on the shop — same figure, its own lot/price.
 *  Availability is RESERVATION-AWARE (batchAvailable): someone sitting in the 15-min payment/slip
 *  stage already holds their unit, so a round pulled to 0 shows สินค้าหมด before any slip is approved.
 *  Scarcity labels (owner spec): every buyable state blinks "สินค้าเหลือน้อย" (rounds are limited by
 *  nature); exactly 1 left → "เหลือ 1 ชิ้นสุดท้าย"; 0 → สินค้าหมด, greyed + unclickable. */
export function BatchCard({ batch }: { batch: ProductBatch }) {
  const db = useDatabase();
  const product = db.products.find((p) => p.id === batch.product_id);
  if (!product) return null;
  const avail = batchAvailable(db, batch);
  const soldOut = avail <= 0;
  const lastOne = avail === 1;
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
            : lastOne ? <span className="animate-pulse text-[11px] font-extrabold text-[#f87171]">เหลือ 1 ชิ้นสุดท้าย</span>
            : <span className="animate-pulse text-[11px] font-bold text-[#fbbf24]">สินค้าเหลือน้อย</span>}
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
