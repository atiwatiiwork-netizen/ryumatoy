'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch, useStore } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCart } from '@/state/CartProvider';
import { createPaymentPlan } from '@/data/mutations';
import { notifyAdminLine } from '@/lib/notify';
import { useCurrentUserId } from '@/state/AuthProvider';
import { lineDepositForRank } from '@/domain/services/ranks';
import { productLabel } from '@/domain/services/catalog';
import { livePrice } from '@/domain/services/pricing';
import { useSmartBack } from '@/lib/nav';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, BackBar, ProductThumb, cx } from '@/components/ui';

export default function CartPage() {
  const router = useRouter();
  const db = useDatabase();
  const cart = useCart();
  const CURRENT_USER_ID = useCurrentUserId();
  const myRank = db.users.find((u) => u.id === CURRENT_USER_ID)?.rank ?? 'bronze';

  // effective per-unit deposit shown to the member — pre-orders get the rank perk
  // (e.g. Gold pays 50%), matching exactly what submitOrder writes to the order.
  const unitDeposit = (l: (typeof cart.lines)[number]) => {
    const p = db.products.find((pp) => pp.id === l.productId);
    const { price, deposit } = livePrice(db, l); // live price — reflects any admin re-price immediately
    return lineDepositForRank(db.settings, { deposit, price, isStock: p?.is_stock ?? true }, myRank);
  };
  const depositSum = cart.lines.reduce((s, l) => (db.products.some((p) => p.id === l.productId) ? s + unitDeposit(l) * l.qty : s), 0);
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
          const product = db.products.find((p) => p.id === l.productId);
          if (!product) return null; // product was removed since it was added → skip (never crash)
          const variant = db.variants.find((v) => v.id === l.variantId);
          const isPre = !product.is_stock;
          // line photo: the chosen แบบ's own image first, else the product photo
          const img = variant?.image_url ?? product.images[0] ?? db.variants.find((v) => v.product_id === product.id && v.image_url)?.image_url;
          return (
            <div key={l.productId + (l.variantId ?? '') + (l.batchId ?? '')} className="flex gap-3 rounded-card border border-subtle bg-surface-2 p-[11px]">
              <ProductThumb isStock={product.is_stock} size={72} showRibbon={false} src={img} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <div className="text-[13px] font-semibold leading-tight">{productLabel(db, l.productId, l.variantId)}</div>
                  <button onClick={() => cart.remove(l.productId, l.variantId, l.batchId)} className="text-ink-faint"><Icon name="x" size={16} /></button>
                </div>
                <span className={cx('mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10.5px] font-semibold', isPre ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : 'bg-[#2563eb]/[0.14] text-[#60a5fa]')}>
                  {isPre ? 'พรีออเดอร์ · มัดจำ' : 'พร้อมส่ง · เต็มจำนวน'}
                </span>
                <div className="mt-2 flex items-center justify-between">
                  <Stepper qty={l.qty} onChange={(q) => cart.setQty(l.productId, l.variantId, q, l.batchId)} />
                  <span className="text-sm font-bold text-primary-soft">{baht(unitDeposit(l) * l.qty)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#8b5cf6]/25 bg-[#8b5cf6]/[0.06] px-[13px] py-2.5 text-[12.5px] text-[#c4b5fd]">
        <Icon name="tag" size={16} /> มีคูปองส่วนลด? เลือกใช้ได้ที่หน้าชำระเงิน
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

      {/* นัดจ่ายทีหลัง (เจ้าของ 2026-07-25): ลูกค้าที่ยังไม่พร้อมโอนวันนี้ ตั้งวันที่จะจ่ายไว้
          ระบบเตือนเมื่อถึงกำหนด + แอดมินเห็นในหน้า "งานค้างวันนี้" (ไม่ตัดสต๊อกให้อัตโนมัติ) */}
      <PlanLater />
    </div>
  );
}

function PlanLater() {
  const db = useDatabase();
  const cart = useCart();
  const dispatch = useDispatch();
  const store = useStore();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const myRank = db.users.find((u) => u.id === uid)?.rank ?? 'bronze';
  // นับเฉพาะรายการที่สินค้ายังอยู่จริง — ของที่ถูกลบไปแล้วจะทำให้ยอดนัดเพี้ยนและจ่ายไม่ได้
  const liveLines = cart.lines.filter((l) => db.products.some((p) => p.id === l.productId));
  const eachOf = (l: (typeof cart.lines)[number]) => {
    const p = db.products.find((x) => x.id === l.productId);
    const { price, deposit } = livePrice(db, l);
    return lineDepositForRank(db.settings, { deposit, price, isStock: p?.is_stock ?? true }, myRank);
  };
  const total = liveLines.reduce((s, l) => s + eachOf(l) * l.qty, 0);
  const d0 = new Date();
  const minDate = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const dmax = new Date(d0); dmax.setDate(dmax.getDate() + 180);
  const maxDate = `${dmax.getFullYear()}-${String(dmax.getMonth() + 1).padStart(2, '0')}-${String(dmax.getDate()).padStart(2, '0')}`;

  const save = async () => {
    if (busy) return;
    if (!uid) return flash('เข้าสู่ระบบก่อนนะครับ');
    if (!date) return flash('เลือกวันที่จะจ่ายก่อน');
    if (date < minDate) return flash('เลือกวันที่ตั้งแต่วันนี้เป็นต้นไป');
    if (date > maxDate) return flash('นัดล่วงหน้าได้ไม่เกิน 180 วัน');
    if (liveLines.length === 0) return flash('ไม่มีสินค้าที่ตั้งนัดได้ (สินค้าถูกนำออกจากร้านแล้ว)');
    const items = liveLines.map((l) => ({
      product_id: l.productId, variant_id: l.variantId, batch_id: l.batchId, qty: l.qty,
      label: productLabel(db, l.productId, l.variantId), each: eachOf(l),
    }));
    setBusy(true);
    // นับก่อน-หลัง แทนการหาด้วยวันที่: ถ้าลูกค้ามีนัดวันเดียวกันอยู่แล้ว การหาด้วยวันที่จะเจอใบเก่า
    // แล้วรายงานว่า "สำเร็จ" ทั้งที่ถูกเพดาน 5 ใบปัดตก (audit v56)
    let before = 0, after = 0;
    dispatch((d) => { before = d.paymentPlans.length; return d; });
    dispatch(createPaymentPlan(uid, date, items, note));
    dispatch((d) => { after = d.paymentPlans.length; return d; });
    if (after === before) { setBusy(false); return flash('ตั้งนัดไม่สำเร็จ — มีนัดค้างครบ 5 รายการแล้ว (ปิดของเก่าก่อน)'); }
    // ต้องเซฟลงเซิร์ฟเวอร์ให้จบก่อน ค่อยแจ้งแอดมิน — ไม่งั้นเจ้าของได้ LINE ของนัดที่ไม่มีอยู่จริง
    await store.flush();
    setBusy(false);
    notifyAdminLine(`📅 นัดชำระใหม่: ${db.users.find((u) => u.id === uid)?.display_name ?? ''} · ${total.toLocaleString()} บาท · ครบกำหนด ${date}`);
    flash('ตั้งนัดชำระแล้ว 📅 แอดมินจะทักเตือนเมื่อถึงวัน');
    setOpen(false); setDate(''); setNote('');
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2.5 w-full rounded-btn border border-[#a855f7]/45 bg-[#a855f7]/[0.08] py-3 text-[13px] font-bold text-[#c084fc]">
        📅 ยังไม่พร้อมโอน — นัดจ่ายทีหลัง
      </button>
    );
  }
  return (
    <div className="mt-2.5 rounded-card border border-[#a855f7]/45 bg-[#a855f7]/[0.07] p-4">
      <div className="text-[13px] font-bold text-[#c084fc]">📅 นัดจ่ายทีหลัง</div>
      <div className="mt-0.5 text-[11.5px] text-ink-muted2">
        บอกวันที่จะโอน แอดมินจะเห็นรายการนี้ล่วงหน้าและทักเตือนเมื่อถึงกำหนด ·
        <b className="text-[#fbbf24]"> ยังไม่ได้กันของให้</b> ถ้าเป็นของจำนวนจำกัดควรทักแอดมินยืนยันอีกที
        · จ่ายก่อนกำหนดได้เลย แล้วแอดมินจะปิดนัดให้
      </div>
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-ink-muted">วันที่จะจ่าย
          <input type="date" min={minDate} max={maxDate} value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none" />
        </label>
        <label className="text-[12px] text-ink-muted">โน้ตถึงแอดมิน (ไม่บังคับ)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น รอเงินเดือนออก" className="mt-1 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint" />
        </label>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[12.5px] text-ink-muted">ยอดที่นัดไว้</span>
        <span className="text-[16px] font-extrabold text-primary-soft">{baht(total)}</span>
        <button onClick={save} disabled={busy} className="ml-auto rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white disabled:opacity-60">{busy ? 'กำลังบันทึก…' : 'ตั้งนัด'}</button>
        <button onClick={() => setOpen(false)} className="text-[12.5px] text-ink-faint">ยกเลิก</button>
      </div>
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
