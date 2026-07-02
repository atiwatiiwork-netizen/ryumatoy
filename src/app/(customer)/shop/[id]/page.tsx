'use client';

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, BackBar, ProductThumb, cx } from '@/components/ui';
import { variantsOf, manufacturerNameOf, franchiseOf, categoryOf, seriesOf, remaining } from '@/domain/services/catalog';
import { instockPriceFor } from '@/domain/services/ranks';
import { availableFor, batchAvailable } from '@/domain/services/reservations';
import { useCurrentUserId } from '@/state/AuthProvider';
import { RANK } from '@/lib/theme';

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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
  // in-stock rank discount (Gold+): reduce the buy-now price for the current member
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';
  const price = product.is_stock ? instockPriceFor(db.settings, myRank, rawPrice) : rawPrice;
  const deposit = product.is_stock ? price : rawDeposit;
  const memberSaved = product.is_stock && price < rawPrice;
  const fr = franchiseOf(db, product);
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
        onBack={() => router.push('/shop')}
        right={
          <div className="flex gap-2">
            <button className="grid h-[38px] w-[38px] place-items-center rounded-full border border-subtle bg-surface-3 text-ink"><Icon name="heart" size={18} /></button>
            <button className="grid h-[38px] w-[38px] place-items-center rounded-full border border-subtle bg-surface-3 text-ink"><Icon name="share" size={18} /></button>
          </div>
        }
      />

      <div className="mb-3.5"><ProductThumb isStock={product.is_stock} radius="rounded-2xl" src={product.images[0]} big /></div>
      {product.images.length > 1 && (
        <div className="mb-3.5 flex gap-2 overflow-x-auto no-scrollbar">
          {product.images.map((img, i) => (
            <img key={i} src={img} alt="" className="h-16 w-16 flex-shrink-0 rounded-lg border border-subtle object-cover" />
          ))}
        </div>
      )}

      {batch
        ? <span className="inline-flex items-center rounded-[7px] bg-cta px-2.5 py-1 text-[11px] font-bold text-white">รอบใหม่ · {batch.label} · เหลือ {batch.stock_qty}</span>
        : <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} />}
      <div className="mb-0.5 mt-2 font-mono text-[11px] text-ink-faint">{manufacturerNameOf(db, product)} · {fr?.name}{categoryOf(db, product) ? ` · ${categoryOf(db, product)!.name}` : ''}{seriesOf(db, product) ? ` · ${seriesOf(db, product)!.name}` : ''}</div>
      <div className="text-[22px] font-extrabold leading-tight">{product.series_name}</div>
      <div className="my-1.5 text-2xl font-extrabold text-primary-soft">{baht(price)}</div>
      <div className="mb-4 text-[13.5px] leading-relaxed text-ink-muted2">{product.description}</div>

      {!product.is_stock && (
        <div className="mb-3.5 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-[#b91c1c]/25 bg-surface-2 p-3"><div className="text-[11.5px] text-ink-muted">มัดจำ (จ่ายตอนนี้)</div><div className="mt-0.5 text-lg font-extrabold">{baht(deposit)}</div></div>
          <div className="rounded-xl border border-subtle bg-surface-2 p-3"><div className="text-[11.5px] text-ink-muted">ส่วนต่างคงเหลือ</div><div className="mt-0.5 text-lg font-extrabold">{baht(remaining(price, deposit))}</div></div>
        </div>
      )}

      <div className="mb-[18px] flex items-center gap-2.5 rounded-xl border border-[#2563eb]/30 bg-[#2563eb]/10 px-[13px] py-[11px]">
        <Icon name="truck" size={18} className="text-[#60a5fa]" />
        <span className="text-[13px] text-[#bcd3f5]">กำหนดการ: {product.eta_note}</span>
      </div>

      {variants.length > 0 && (
        <>
          <div className="mb-2.5 text-sm font-bold">เลือกแบบ</div>
          <div className="mb-5 flex flex-col gap-2.5">
            {variants.map((v) => (
              <button key={v.id} onClick={() => setVariantId(v.id)} className={cx('flex items-center justify-between rounded-xl border-2 bg-surface-2 px-3.5 py-3 text-left', v.id === variantId ? 'border-primary' : 'border-subtle')}>
                <span className="text-[13.5px] font-semibold">{v.name}</span>
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
        <div className={cx('mb-2 text-[13px] font-bold', soldOut ? 'text-primary-soft' : 'text-[#4ade80]')}>
          {soldOut ? 'สินค้าหมด / ถูกจองครบแล้ว' : `เหลือ ${avail} ชิ้น`}
        </div>
      )}
      <div className="flex gap-2.5">
        <button className="grid h-[50px] w-[50px] flex-shrink-0 place-items-center rounded-btn border border-subtle bg-surface-3 text-ink"><Icon name="chat" size={20} /></button>
        <Button onClick={addToCart} icon="cart" disabled={soldOut}>{soldOut ? 'สินค้าหมด' : `เพิ่มลงตะกร้า · ${baht(product.is_stock ? price : deposit)}`}</Button>
      </div>
    </div>
  );
}
