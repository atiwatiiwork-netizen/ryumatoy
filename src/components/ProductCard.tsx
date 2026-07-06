'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Product } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { metaLine, variantsOf } from '@/domain/services/catalog';
import { availableFor } from '@/domain/services/reservations';
import { instockPriceFor } from '@/domain/services/ranks';
import { useCurrentUserId } from '@/state/AuthProvider';
import { ProductThumb, StatusBadge, cx } from './ui';

/** Product card used on Home grid + Shop grid. Links to the product route.
 *  `quickAdd` shows an add-to-cart button (used on board pages so customers can add
 *  many items without leaving the page). Variant products still open the detail page.
 *
 *  For variant products the card is variant-driven (DNA: variant fields are the source
 *  of truth for both price and image). With no variant picked yet it shows a diagonal
 *  split of the first two variant images as a teaser + a "เริ่ม" (from) price; picking a
 *  swatch swaps the card image and price to that exact variant. */
export function ProductCard({ product, quickAdd }: { product: Product; quickAdd?: boolean }) {
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';

  const variants = product.has_variants ? variantsOf(db, product.id) : [];
  const withImg = variants.filter((v) => v.image_url); // variants that carry their own photo
  const [selId, setSelId] = useState<string | null>(null);
  const sel = variants.find((v) => v.id === selId);

  // Price — variant products read price from the chosen variant (or the cheapest, shown as "เริ่ม").
  const varPrices = variants.map((v) => v.price_total);
  const priceSpread = varPrices.length > 0 && Math.min(...varPrices) !== Math.max(...varPrices);
  const basePrice = product.has_variants
    ? (sel ? sel.price_total : (varPrices.length ? Math.min(...varPrices) : product.price_total))
    : product.price_total;
  const fromPrice = product.has_variants && !sel && priceSpread; // show "เริ่ม" only when prices differ
  const memberPrice = product.is_stock ? instockPriceFor(db.settings, myRank, basePrice) : basePrice;
  const saved = memberPrice < basePrice;

  // Image — chosen variant wins; otherwise a diagonal split of the first two variant images.
  const teaser = !sel && withImg.length >= 2;
  const mainSrc = sel ? (sel.image_url ?? product.images[0]) : (teaser ? withImg[0].image_url : (withImg[0]?.image_url ?? product.images[0]));
  const splitSrc = teaser ? withImg[1].image_url : undefined;

  const inClosingBoard = !!product.board_id && db.boards.some((b) => b.id === product.board_id && b.status === 'open');
  const stockLeft = product.is_stock ? availableFor(db, product) : null; // reservation-aware "เหลือ N"
  const nVariants = variants.length;
  // pre-order simple products can be added straight to the cart; variant ones need a pick
  const canQuickAdd = quickAdd && !product.is_stock && !product.has_variants;

  const doAdd = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    cart.add({ productId: product.id, depositEach: product.deposit_amount, priceEach: product.price_total });
    flash('เพิ่มลงตะกร้าแล้ว ✓');
  };

  const pickVariant = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    setSelId((cur) => (cur === id ? null : id)); // tap again to go back to the teaser
  };

  return (
    <Link href={`/shop/${product.id}`} className="block overflow-hidden rounded-card border border-subtle bg-surface-2">
      <div className="relative">
        <ProductThumb isStock={product.is_stock} radius="rounded-none" src={mainSrc} srcB={splitSrc} />
        {inClosingBoard && <span className="absolute left-2 top-2 rounded-md bg-[#16a34a] px-1.5 py-0.5 text-[9px] font-extrabold text-white">ใกล้ปิดพรี</span>}
        <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} className="absolute bottom-2 right-2" />
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        {nVariants > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {variants.map((v) => (
              <button
                key={v.id}
                onClick={(e) => pickVariant(e, v.id)}
                title={v.name}
                className={`h-7 w-7 shrink-0 overflow-hidden rounded-md border ${sel?.id === v.id ? 'border-primary-soft ring-1 ring-primary-soft' : 'border-subtle'}`}
              >
                {v.image_url
                  ? <img src={v.image_url} alt="" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center bg-white/[0.07] text-[9px] font-bold text-ink-muted2">{v.name.slice(0, 2)}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-baseline gap-1.5">
          {fromPrice && <span className="text-[10px] font-semibold text-ink-faint">เริ่ม</span>}
          <span className="text-[15px] font-extrabold text-primary-soft">{baht(memberPrice)}</span>
          {saved && <span className="text-[11px] text-ink-faint line-through">{baht(basePrice)}</span>}
        </div>
        {sel && <div className="truncate text-[10px] font-semibold text-ink-muted2">{sel.name}</div>}
        {stockLeft != null && <div className={cx('text-[10.5px] font-bold', stockLeft <= 3 ? 'text-[#fbbf24]' : 'text-[#4ade80]')}>พร้อมส่ง · เหลือ {stockLeft} ชิ้น</div>}
        {saved && <div className="text-[10px] font-bold text-[#f1d27a]">ราคาสมาชิก ✦</div>}
        {quickAdd && (
          canQuickAdd
            ? <button onClick={doAdd} className="mt-2 w-full rounded-lg bg-cta py-2 text-[12.5px] font-bold text-white">+ ใส่ตะกร้า</button>
            : <div className="mt-2 w-full rounded-lg border border-subtle py-2 text-center text-[12px] font-semibold text-ink-muted2">เลือกแบบในหน้าสินค้า →</div>
        )}
      </div>
    </Link>
  );
}
