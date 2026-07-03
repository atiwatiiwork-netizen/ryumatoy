'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { lineDepositForRank } from '@/domain/services/ranks';
import { useSmartBack } from '@/lib/nav';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, BackBar, ProductThumb, cx } from '@/components/ui';

export default function CartPage() {
  const router = useRouter();
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const [code, setCode] = useState('');
  const CURRENT_USER_ID = useCurrentUserId();
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';

  // effective per-unit deposit shown to the member — pre-orders get the rank perk
  // (e.g. Gold pays 50%), matching exactly what submitOrder writes to the order.
  const unitDeposit = (l: (typeof cart.lines)[number]) => {
    const p = db.products.find((pp) => pp.id === l.productId);
    return lineDepositForRank(db.settings, { deposit: l.depositEach, price: l.priceEach, isStock: p?.is_stock ?? true }, myRank);
  };
  const depositSum = cart.lines.reduce((s, l) => s + unitDeposit(l) * l.qty, 0);
  const payNow = depositSum;
  const goBack = useSmartBack('/shop'); // back to wherever the customer came from (board / shop)

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ตะกร้า" onBack={goBack} />
        <div className="py-16 text-center text-ink-faint">
          <Icon name="cart" size={44} className="mx-auto mb-3.5 text-ink-faint" />
          <div className="text-[15px]">ตะกร้าว่างเปล่า</div>
          <div className="mt-4 inline-block"><Button variant="outline" onClick={() => router.push('/shop')}>ไปช็อปเลย</Button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ตะกร้า" onBack={goBack} />

      <div className="mb-[18px] flex flex-col gap-2.5">
        {cart.lines.map((l) => {
          const product = db.products.find((p) => p.id === l.productId)!;
          const variant = db.variants.find((v) => v.id === l.variantId);
          const isPre = !product.is_stock;
          return (
            <div key={l.productId + (l.variantId ?? '')} className="flex gap-3 rounded-card border border-subtle bg-surface-2 p-[11px]">
              <ProductThumb isStock={product.is_stock} size={72} showRibbon={false} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <div className="text-[13px] font-semibold leading-tight">{product.series_name}{variant ? ` · ${variant.name}` : ''}</div>
                  <button onClick={() => cart.remove(l.productId, l.variantId)} className="text-ink-faint"><Icon name="x" size={16} /></button>
                </div>
                <span className={cx('mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10.5px] font-semibold', isPre ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : 'bg-[#2563eb]/[0.14] text-[#60a5fa]')}>
                  {isPre ? 'พรีออเดอร์ · มัดจำ' : 'พร้อมส่ง · เต็มจำนวน'}
                </span>
                <div className="mt-2 flex items-center justify-between">
                  <Stepper qty={l.qty} onChange={(q) => cart.setQty(l.productId, l.variantId, q)} />
                  <span className="text-sm font-bold text-primary-soft">{baht(unitDeposit(l) * l.qty)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mb-4 flex gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-xl border-[1.5px] border-dashed border-accent px-[13px] py-2.5">
          <Icon name="tag" size={17} className="text-primary-soft" />
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="โค้ดส่วนลด" className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-faint" />
        </div>
        <button onClick={() => { cart.applyCoupon(code || null); flash(code ? `ใส่โค้ด ${code}` : 'ล้างโค้ด'); }} className="rounded-xl border border-subtle bg-surface-3 px-[18px] text-[13px] font-bold text-ink">ใช้</button>
      </div>

      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
        <Row label="ยอดมัดจำรวม" value={baht(depositSum)} />
        <div className="my-2.5 border-t border-subtle" />
        <div className="flex items-center justify-between">
          <span className="font-bold">ชำระตอนนี้</span>
          <span className="text-[22px] font-extrabold text-primary-soft">{baht(payNow)}</span>
        </div>
      </div>

      <Button icon="arrowRight" onClick={() => router.push('/checkout')}>สรุปออเดอร์</Button>
    </div>
  );
}

function Row({ label, value, green }: { label: string; value: string; green?: boolean }) {
  return (
    <div className="flex justify-between py-1 text-[13.5px] text-ink-muted2">
      <span>{label}</span>
      <span className={green ? 'font-semibold text-[#4ade80]' : 'font-semibold text-ink'}>{value}</span>
    </div>
  );
}

function Stepper({ qty, onChange }: { qty: number; onChange: (q: number) => void }) {
  const btn = 'grid h-7 w-7 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink';
  return (
    <div className="flex items-center gap-2.5">
      <button className={btn} onClick={() => onChange(qty - 1)}><Icon name="minus" size={15} /></button>
      <span className="min-w-[14px] text-center text-sm font-bold">{qty}</span>
      <button className={`${btn} text-primary-bright`} onClick={() => onChange(qty + 1)}><Icon name="plus" size={15} /></button>
    </div>
  );
}
