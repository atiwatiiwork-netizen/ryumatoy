'use client';

import Link from 'next/link';
import type { Product } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { metaLine, variantsOf } from '@/domain/services/catalog';
import { instockPriceFor } from '@/domain/services/ranks';
import { useCurrentUserId } from '@/state/AuthProvider';
import { ProductThumb, StatusBadge } from './ui';

/** Product card used on Home grid + Shop grid. Links to the product route.
 *  `quickAdd` shows an add-to-cart button (used on board pages so customers can add
 *  many items without leaving the page). Variant products still open the detail page. */
export function ProductCard({ product, quickAdd }: { product: Product; quickAdd?: boolean }) {
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';
  const memberPrice = product.is_stock ? instockPriceFor(db.settings, myRank, product.price_total) : product.price_total;
  const saved = memberPrice < product.price_total;
  const inClosingBoard = !!product.board_id && db.boards.some((b) => b.id === product.board_id && b.status === 'open');
  const nVariants = product.has_variants ? variantsOf(db, product.id).length : 0;
  // pre-order simple products can be added straight to the cart; variant ones need a pick
  const canQuickAdd = quickAdd && !product.is_stock && !product.has_variants;

  const doAdd = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    cart.add({ productId: product.id, depositEach: product.deposit_amount, priceEach: product.price_total });
    flash('เพิ่มลงตะกร้าแล้ว ✓');
  };

  return (
    <Link href={`/shop/${product.id}`} className="block overflow-hidden rounded-card border border-subtle bg-surface-2">
      <div className="relative">
        <ProductThumb isStock={product.is_stock} radius="rounded-none" src={product.images[0]} />
        {inClosingBoard && <span className="absolute left-2 top-2 rounded-md bg-[#16a34a] px-1.5 py-0.5 text-[9px] font-extrabold text-white">ใกล้ปิดพรี</span>}
        <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} className="absolute bottom-2 right-2" />
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        {nVariants > 0 && <div className="mt-1 inline-flex items-center rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted2">🎨 {nVariants} แบบ</div>}
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-[15px] font-extrabold text-primary-soft">{baht(memberPrice)}</span>
          {saved && <span className="text-[11px] text-ink-faint line-through">{baht(product.price_total)}</span>}
        </div>
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
