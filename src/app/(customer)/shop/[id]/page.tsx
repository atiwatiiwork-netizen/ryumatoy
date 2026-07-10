'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { ProductCard } from '@/components/ProductCard';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, BackBar, ProductThumb, cx } from '@/components/ui';
import { variantsOf, manufacturerNameOf, franchiseOf, categoryOf, seriesOf, remaining, dimensionLabel } from '@/domain/services/catalog';
import { depositForRank } from '@/domain/services/ranks';
import { useSmartBack } from '@/lib/nav';
import { availableFor, batchAvailable } from '@/domain/services/reservations';
import { downloadBranded } from '@/lib/watermark';
import { useCurrentUserId } from '@/state/AuthProvider';
import { RANK } from '@/lib/theme';
import { EventProgress } from '@/components/EventBits';

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const goBack = useSmartBack('/shop');
  const params = useSearchParams();
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();

  const product = db.products.find((p) => p.id === id);
  const variants = product ? variantsOf(db, product.id) : [];
  const [variantId, setVariantId] = useState<string | undefined>(variants[0]?.id);

  if (!product) return <div className="p-10 text-ink-faint">ไม่พบสินค้า</div>;

  // reopened stock batch (from a ?batch= link) overrides the price/deposit
  const batch = db.batches.find((b) => b.id === params.get('batch') && b.product_id === product.id && b.status === 'open');
  const variant = variants.find((v) => v.id === variantId);
  const rawPrice = batch ? batch.price_total : (variant?.price_total ?? product.price_total);
  const rawDeposit = batch ? batch.deposit_amount : (variant?.deposit_amount ?? product.deposit_amount);
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';
  const price = rawPrice; // one price for every rank (no in-stock rank discount)
  // full payment when in-stock, or a reopened batch priced pay-in-full (deposit ≥ price, i.e. a
  // "พร้อมส่ง" round). Such lines never get the pre-order rank deposit perk (nothing to reduce).
  const isFullPay = product.is_stock || rawDeposit >= rawPrice;
  // `deposit` = the BASE value stored on the cart line (submitOrder re-applies the rank perk).
  const deposit = isFullPay ? price : rawDeposit;
  // `shownDeposit` = what the member actually pays now (pre-orders get the rank deposit perk,
  // e.g. Gold 50%) — DNA rule: every deposit shown to a user must reflect their rank.
  const shownDeposit = isFullPay ? price : depositForRank(db.settings, rawDeposit, myRank);
  const memberSaved = false; // in-stock has no rank discount → one price for all
  const fr = franchiseOf(db, product);
  // "อื่นๆ ในซีรีย์นี้" — other bookable/in-stock products sharing this series (arc)
  const series = seriesOf(db, product);
  const seriesLink = product.series_id ? `/shop?franchise=${product.franchise_id}&series=${product.series_id}` : null;
  const seriesMates = product.series_id
    ? db.products.filter((p) => p.series_id === product.series_id && p.id !== product.id && (p.is_stock || p.status === 'open')).slice(0, 10)
    : [];
  // live availability for limited-qty items (in-stock / batch) — reservation-aware
  const limited = batch ? true : product.is_stock;
  const avail = batch ? batchAvailable(db, batch) : product.is_stock ? availableFor(db, product) : null;
  const soldOut = limited && (avail ?? 1) <= 0;

  const addToCart = () => {
    if (soldOut) return flash('สินค้าหมด/ถูกจองครบแล้ว');
    cart.add({ productId: product.id, variantId: batch ? undefined : variantId, batchId: batch?.id, depositEach: deposit, priceEach: price });
    flash('เพิ่มลงตะกร้าแล้ว');
    router.push('/cart');
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar
        title=""
        onBack={goBack}
        right={
          <div className="flex gap-2">
            <button className="grid h-[38px] w-[38px] place-items-center rounded-full border border-subtle bg-surface-3 text-ink"><Icon name="heart" size={18} /></button>
            <button className="grid h-[38px] w-[38px] place-items-center rounded-full border border-subtle bg-surface-3 text-ink"><Icon name="share" size={18} /></button>
          </div>
        }
      />

      <div className="mb-2"><ProductThumb isStock={product.is_stock} radius="rounded-2xl" src={variant?.image_url ?? product.images[0]} big /></div>
      {(variant?.image_url ?? product.images[0]) && (
        <button onClick={() => downloadBranded((variant?.image_url ?? product.images[0])!, product.is_stock, product.series_name)} className="mb-3.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-muted2">
          <Icon name="share" size={15} /> เซฟรูป (ติดแบรนด์ + ป้าย)
        </button>
      )}
      {product.images.length > 1 && (
        <div className="mb-3.5 flex gap-2 overflow-x-auto no-scrollbar">
          {product.images.map((img, i) => (
            <img key={i} src={img} alt="" className="h-16 w-16 flex-shrink-0 rounded-lg border border-subtle object-cover" />
          ))}
        </div>
      )}

      {batch
        ? <span className="inline-flex items-center rounded-[7px] bg-cta px-2.5 py-1 text-[11px] font-bold text-white">พรีรอบพิเศษ · {batch.label}{(avail ?? 0) > 0 ? '' : ' · หมด'}</span>
        : <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} />}
      <div className="mb-0.5 mt-2 font-mono text-[11px] text-ink-faint">{manufacturerNameOf(db, product)} · {fr?.name}{categoryOf(db, product) ? ` · ${categoryOf(db, product)!.name}` : ''}{seriesOf(db, product) ? ` · ${seriesOf(db, product)!.name}` : ''}</div>
      <div className="text-[22px] font-extrabold leading-tight">{product.series_name}</div>
      {series && seriesLink && (
        <Link href={seriesLink} className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-3 px-3 py-1 text-[12px] font-semibold text-ink-muted2">
          <Icon name="tag" size={13} className="text-primary-soft" /> ซีรีย์ {series.name} · ดูตัวอื่น →
        </Link>
      )}
      <div className="my-1.5 text-2xl font-extrabold text-primary-soft">{baht(price)}</div>
      {dimensionLabel(product) && <div className="mb-1.5 text-[13.5px] font-semibold text-ink-muted">{dimensionLabel(product)}</div>}
      {product.description && <div className="mb-4 text-[13.5px] leading-relaxed text-ink-muted2">{product.description}</div>}

      {!product.is_stock && (
        <div className="mb-3.5 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-[#b91c1c]/25 bg-surface-2 p-3"><div className="text-[11.5px] text-ink-muted">มัดจำ (จ่ายตอนนี้)</div><div className="mt-0.5 text-lg font-extrabold">{baht(shownDeposit)}</div></div>
          <div className="rounded-xl border border-subtle bg-surface-2 p-3"><div className="text-[11.5px] text-ink-muted">ส่วนต่างคงเหลือ</div><div className="mt-0.5 text-lg font-extrabold">{baht(remaining(price, shownDeposit))}</div></div>
        </div>
      )}

      <div className="mb-[18px] flex items-center gap-2.5 rounded-xl border border-[#2563eb]/30 bg-[#2563eb]/10 px-[13px] py-[11px]">
        <Icon name="truck" size={18} className="text-[#60a5fa]" />
        <span className="text-[13px] text-[#bcd3f5]">กำหนดการ: {product.eta_note}</span>
      </div>

      {/* live-event blurb + personal progress (pre-order only; renders nothing when no event) */}
      {!product.is_stock && <div className="mb-[18px] -mt-1"><EventProgress variant="inline" /></div>}

      {variants.length > 0 && (
        <>
          <div className="mb-2.5 text-sm font-bold">เลือกแบบ</div>
          <div className="mb-5 flex flex-col gap-2.5">
            {variants.map((v) => (
              <button key={v.id} onClick={() => setVariantId(v.id)} className={cx('flex items-center gap-3 rounded-xl border-2 bg-surface-2 px-3 py-2.5 text-left', v.id === variantId ? 'border-primary' : 'border-subtle')}>
                {v.image_url && <img src={v.image_url} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />}
                <span className="flex-1 text-[13.5px] font-semibold">{v.name}</span>
                <span className="text-sm font-bold text-primary-soft">{baht(v.price_total)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {memberSaved && (
        <div className="mb-2 flex items-center gap-2 text-[13px]">
          <span className="rounded-md bg-[#d4af37]/15 px-2 py-0.5 text-[12px] font-bold text-[#f1d27a]">ราคาสมาชิก {RANK[myRank].label}</span>
          <span className="font-extrabold text-ink">{baht(price)}</span>
          <span className="text-ink-faint line-through">{baht(rawPrice)}</span>
        </div>
      )}
      {limited && (
        <div className={cx('mb-2 text-[13px] font-bold', soldOut ? 'text-primary-soft' : avail === 1 ? 'animate-pulse text-[#f87171]' : 'text-[#4ade80]')}>
          {soldOut ? 'สินค้าหมด / ถูกจองครบแล้ว' : avail === 1 ? 'เหลือ 1 ชิ้นสุดท้าย!' : `เหลือ ${avail} ชิ้น`}
        </div>
      )}
      <div className="flex gap-2.5">
        <button className="grid h-[50px] w-[50px] flex-shrink-0 place-items-center rounded-btn border border-subtle bg-surface-3 text-ink"><Icon name="chat" size={20} /></button>
        <Button onClick={addToCart} icon="cart" disabled={soldOut}>{soldOut ? 'สินค้าหมด' : `เพิ่มลงตะกร้า · ${baht(shownDeposit)}`}</Button>
      </div>

      {/* others in the same series (arc) — collect the set */}
      {seriesMates.length > 0 && (
        <div className="mt-9">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[17px] font-extrabold">👥 อื่นๆ ในซีรีย์ {series?.name}</div>
            {seriesLink && <Link href={seriesLink} className="text-[13px] font-semibold text-primary-soft">ดูทั้งหมด →</Link>}
          </div>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 no-scrollbar">
            {seriesMates.map((p) => (
              <div key={p.id} className="w-[150px] shrink-0"><ProductCard product={p} quickAdd /></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
