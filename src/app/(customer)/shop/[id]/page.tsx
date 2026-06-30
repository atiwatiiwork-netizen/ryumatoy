'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, BackBar, ProductThumb, cx } from '@/components/ui';
import { variantsOf, manufacturerNameOf, franchiseOf, typeLabel, remaining } from '@/domain/services/catalog';

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();

  const product = db.products.find((p) => p.id === id);
  const variants = product ? variantsOf(db, product.id) : [];
  const [variantId, setVariantId] = useState<string | undefined>(variants[0]?.id);

  if (!product) return <div className="p-10 text-ink-faint">ไม่พบสินค้า</div>;

  const variant = variants.find((v) => v.id === variantId);
  const price = variant?.price_total ?? product.price_total;
  const deposit = variant?.deposit_amount ?? product.deposit_amount;
  const fr = franchiseOf(db, product);

  const addToCart = () => {
    cart.add({ productId: product.id, variantId, depositEach: deposit, priceEach: price });
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

      <div className="mb-3.5"><ProductThumb isStock={product.is_stock} radius="rounded-2xl" /></div>

      <StatusBadge status={(product.is_stock ? 'open' : product.status) as StatusKey} />
      <div className="mb-0.5 mt-2 font-mono text-[11px] text-ink-faint">{manufacturerNameOf(db, product)} · {fr?.name} · {typeLabel(product.type)}</div>
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

      <div className="flex gap-2.5">
        <button className="grid h-[50px] w-[50px] flex-shrink-0 place-items-center rounded-btn border border-subtle bg-surface-3 text-ink"><Icon name="chat" size={20} /></button>
        <Button onClick={addToCart} icon="cart">เพิ่มลงตะกร้า · {baht(product.is_stock ? price : deposit)}</Button>
      </div>
    </div>
  );
}
