'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, BackBar, QrPanel, cx } from '@/components/ui';
import { tierOf } from '@/domain/services/ranks';
import { submitOrder } from '@/data/mutations';

export default function CheckoutPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const cart = useCart();
  const { flash } = useToast();
  const [slip, setSlip] = useState<string | null>(null);

  const me = db.users.find((u) => u.id === CURRENT_USER_ID)!;
  const discountPct = tierOf(db, me.rank)?.discount_percent ?? 0;
  const depositSum = cart.depositTotal();
  const discount = Math.round((depositSum * discountPct) / 100);
  const payNow = depositSum - discount;

  const submit = () => {
    if (!slip) return;
    dispatch(submitOrder(CURRENT_USER_ID, cart.lines, 'slip://uploaded'));
    cart.clear();
    flash('ส่งคำขอแล้ว · รอ Admin ตรวจสอบ');
    router.push('/wallet');
  };

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ชำระเงิน" onBack={() => router.push('/cart')} />
        <div className="py-16 text-center text-ink-faint">ไม่มีรายการให้ชำระ</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ชำระเงิน" onBack={() => router.push('/cart')} />

      <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 p-[15px]">
        {cart.lines.map((l) => {
          const product = db.products.find((p) => p.id === l.productId)!;
          const variant = db.variants.find((v) => v.id === l.variantId);
          return (
            <div key={l.productId + (l.variantId ?? '')} className="flex justify-between gap-2.5 py-1 text-[13px]">
              <span className="text-ink-muted2">{product.series_name}{variant ? ` · ${variant.name}` : ''} ×{l.qty}</span>
              <span className="font-semibold">{baht(l.depositEach * l.qty)}</span>
            </div>
          );
        })}
        <div className="my-2.5 border-t border-subtle" />
        <div className="flex items-center justify-between">
          <span className="font-bold">ยอดโอน</span>
          <span className="text-xl font-extrabold text-primary-soft">{baht(payNow)}</span>
        </div>
      </div>

      <div className="mb-3.5 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
        <div className="mb-3.5 text-sm font-bold">สแกนจ่ายผ่าน PromptPay</div>
        <div className="mb-3.5 flex justify-center"><QrPanel size={172} /></div>
        <CopyRow label="ชื่อบัญชี" value={db.settings.bank_account} onCopy={() => flash('คัดลอกแล้ว')} />
        <CopyRow label="พร้อมเพย์" value={db.settings.promptpay_number} onCopy={() => flash('คัดลอกเบอร์แล้ว')} />
        <div className="my-3 border-t border-dashed border-subtle" />
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-ink-muted">ยอดโอน</span>
          <span className="text-xl font-extrabold text-primary-soft">{baht(payNow)}</span>
        </div>
      </div>

      <button
        onClick={() => setSlip('uploaded')}
        className={cx('mb-4 w-full rounded-card border-[1.5px] border-dashed p-[22px] text-center', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.06]' : 'border-accent')}
      >
        <Icon name={slip ? 'check' : 'camera'} size={28} className={cx('mx-auto mb-2', slip ? 'text-[#4ade80]' : 'text-primary-soft')} />
        <div className="text-sm font-semibold">{slip ? 'แนบสลิปแล้ว ✓' : 'แตะเพื่อถ่าย / เลือกรูปสลิป'}</div>
        <div className="mt-1 text-[11.5px] text-ink-faint">JPG / PNG ≤ 5MB · บังคับแนบ</div>
      </button>

      <Button disabled={!slip} onClick={submit}>ส่งคำขอ · รอ Admin ตรวจสอบ</Button>
      <div className="mt-2.5 text-center text-[11.5px] text-ink-faint">เมื่อ Admin อนุมัติสลิป ระบบจะออก Ticket ให้อัตโนมัติ</div>
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between py-[5px] text-[13px]">
      <span className="text-ink-muted">{label}</span>
      <button onClick={onCopy} className="inline-flex items-center gap-1.5 font-semibold text-ink">{value} <Icon name="copy" size={15} className="text-ink-faint" /></button>
    </div>
  );
}
