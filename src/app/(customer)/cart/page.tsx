'use client';

import { useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { lineDepositForRank } from '@/domain/services/ranks';
import { productLabel } from '@/domain/services/catalog';
import { livePrice } from '@/domain/services/pricing';
import { userBatchQuota, BATCH_MAX_PER_USER, batchAvailable, availableFor, pendingHeld, myPendingHold } from '@/domain/services/reservations';
import { useToast } from '@/state/ToastProvider';
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
  const { flash } = useToast();

  // ── สถานะ "ของหมด" ต่อบรรทัด (เจ้าของ 2026-07-30: ของหมดต้องรู้ตั้งแต่ตะกร้า ไม่ใช่ไปงงหน้าชำระ) ──
  // 'temp' = มีคนถือ hold/สลิปรอตรวจ (รอของหลุดได้) · 'gone' = ตั๋วออกครบจริง · null = ยังซื้อได้
  // ⚠ กติกาต้องตรงกับ deadLines ในหน้าชำระเป๊ะๆ (audit 2026-07-30): เดิมตะกร้าไม่รู้จัก "สินค้าถูกลบ"
  //   กับ "พรีปกติปิดรับจองแล้ว" แต่หน้าชำระเด้งกลับตะกร้าเพราะสองข้อนี้ → ลูกค้ากดสรุปออเดอร์ →
  //   เด้งกลับ → ตะกร้าบอกว่าปกติ → กดใหม่ → เด้งอีก วนไม่จบ และไม่มีอะไรบอกว่าตัวไหนเสีย
  //   hold ของตัวเองต้องไม่ทำให้ของตัวเองกลายเป็น "หมด" ด้วย (สูตรเดียวกับหน้าชำระ)
  const lineGone = (l: (typeof cart.lines)[number]): 'temp' | 'gone' | null => {
    const p = db.products.find((pp) => pp.id === l.productId);
    if (!p) return 'gone'; // ถูกนำออกจากร้านแล้ว
    const mine = myPendingHold(db, CURRENT_USER_ID, p.id, l.batchId);
    if (l.batchId) {
      const b = db.batches.find((bb) => bb.id === l.batchId);
      if (!b || b.status !== 'open' || b.published === false) return 'gone'; // รอบปิดไปแล้ว
      if (l.qty <= batchAvailable(db, b) + mine) return null;
      return pendingHeld(db, p.id, l.batchId) > 0 ? 'temp' : 'gone';
    }
    if (p.is_stock) return l.qty > availableFor(db, p) + mine ? (pendingHeld(db, p.id) > 0 ? 'temp' : 'gone') : null;
    return p.status !== 'open' ? 'gone' : null; // พรีปกติ: ปิดรับจองแล้ว = จ่ายไม่ได้
  };
  const deadLines = cart.lines.filter((l) => lineGone(l) !== null);
  const deadCount = deadLines.length;
  const anyTemp = deadLines.some((l) => lineGone(l) === 'temp');
  const goCheckout = () => {
    if (deadCount > 0) return flash(anyTemp
      ? '⏳ มีสินค้าหมดชั่วคราวในตะกร้า — รอของหลุด หรือเอาออกก่อนแล้วค่อยชำระ'
      : 'มีสินค้าที่สั่งไม่ได้แล้วในตะกร้า — เอาออกก่อนแล้วค่อยชำระนะครับ');
    router.push('/checkout');
  };

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
          const gone = lineGone(l);
          return (
            <div key={l.productId + (l.variantId ?? '') + (l.batchId ?? '')} className={cx('flex gap-3 rounded-card border bg-surface-2 p-[11px]', gone ? 'border-[#d97706]/45 opacity-90' : 'border-subtle')}>
              <ProductThumb isStock={product.is_stock} size={72} showRibbon={false} src={img} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <div className="text-[13px] font-semibold leading-tight">{productLabel(db, l.productId, l.variantId)}</div>
                  <button onClick={() => cart.remove(l.productId, l.variantId, l.batchId)} className="text-ink-faint"><Icon name="x" size={16} /></button>
                </div>
                <span className={cx('mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10.5px] font-semibold', isPre ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : 'bg-[#2563eb]/[0.14] text-[#60a5fa]')}>
                  {isPre ? 'พรีออเดอร์ · มัดจำ' : 'พร้อมส่ง · เต็มจำนวน'}
                </span>
                {gone && (() => {
                  // บอกให้ตรงเหตุ ไม่ใช่เหมารวมว่า "หมด" (ลูกค้าจะได้รู้ว่าต้องเอาออกหรือรอ)
                  const why = !product ? 'ถูกนำออกจากร้านแล้ว'
                    : (!l.batchId && !product.is_stock && product.status !== 'open') ? 'ปิดรับจองรอบนี้แล้ว'
                    : gone === 'temp' ? '⏳ หมดชั่วคราว · รอของหลุด' : 'สินค้าหมดแล้ว';
                  return (
                    <span className={cx('ml-1.5 mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10.5px] font-bold', gone === 'temp' ? 'animate-blink bg-[#d97706]/20 text-[#fbbf24]' : 'bg-white/[0.08] text-ink-faint')}>
                      {why}
                    </span>
                  );
                })()}
                <div className="mt-2 flex items-center justify-between">
                  {/* รอบพิเศษจำกัด 3 ตัว/คน (เจ้าของ 2026-07-30) — เพดาน = โควตาที่เหลือ
                      (หักตั๋วที่มี + สลิปรอตรวจแล้ว) กันกดบวกเกินแล้วไปตายตอนส่งออเดอร์ */}
                  <Stepper qty={l.qty} max={l.batchId ? userBatchQuota(db, CURRENT_USER_ID, l.batchId) : undefined}
                    onChange={(q) => cart.setQty(l.productId, l.variantId, q, l.batchId)} />
                  <span className="text-sm font-bold text-primary-soft">{baht(unitDeposit(l) * l.qty)}</span>
                </div>
                {l.batchId && l.qty >= userBatchQuota(db, CURRENT_USER_ID, l.batchId) && (
                  <div className="mt-1 text-[10.5px] font-semibold text-ink-faint">รอบพิเศษจำกัด {BATCH_MAX_PER_USER} ตัว/คน</div>
                )}
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

      {deadCount > 0 && (
        <div className="mb-2.5 rounded-xl border border-[#d97706]/45 bg-[#d97706]/[0.1] px-3.5 py-2.5 text-[12.5px] text-[#fbbf24]">
          {anyTemp
            ? <>⏳ มีสินค้าหมดชั่วคราว {deadCount} รายการ — ถ้าคนที่จองไว้ไม่ชำระ ของจะกลับมาให้กด หรือเอาออกจากตะกร้าก่อนแล้วค่อยชำระรายการอื่น</>
            : <>มีสินค้าที่สั่งไม่ได้แล้ว {deadCount} รายการ (หมด/ปิดรับจอง/ถูกนำออก) — เอาออกก่อนแล้วค่อยชำระรายการอื่นนะครับ</>}
          <button onClick={() => { deadLines.forEach((l) => cart.remove(l.productId, l.variantId, l.batchId)); flash('เอารายการที่สั่งไม่ได้ออกแล้ว'); }}
            className="mt-2 w-full rounded-lg bg-cta py-2 text-[12.5px] font-bold text-white">เอารายการที่สั่งไม่ได้ออก ({deadCount})</button>
        </div>
      )}
      <Button icon="arrowRight" onClick={goCheckout}>สรุปออเดอร์</Button>

      {/* นัดจ่ายทีหลัง (v57 เจ้าของ 2026-07-26): ย้ายไปเป็นงานแอดมินล้วน — ลูกค้าตั้งนัดเองไม่ได้แล้ว
          แอดมินออกนัดให้ที่ /admin/today แล้วลูกค้าจ่ายจากเมนู "นัดชำระ" (/plans) */}
      <div className="mt-2.5 rounded-xl border border-subtle bg-surface-2 px-[13px] py-2.5 text-[12px] text-ink-faint">
        📅 อยากจ่ายทีหลัง? ทักแอดมินได้เลย — แอดมินจะออก “นัดชำระ” ให้ แล้วรายการจะไปโผล่ในเมนู <b className="text-ink-muted2">นัดชำระ</b> ของคุณ
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

function Stepper({ qty, max, onChange }: { qty: number; max?: number; onChange: (q: number) => void }) {
  const btn = 'grid h-7 w-7 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink';
  return (
    <div className="flex items-center gap-2.5">
      <button className={btn} onClick={() => onChange(qty - 1)}><Icon name="minus" size={15} /></button>
      <span className="min-w-[14px] text-center text-sm font-bold">{qty}</span>
      <button className={cx(btn, 'text-primary-bright disabled:opacity-35')} disabled={max != null && qty >= max} onClick={() => onChange(max != null ? Math.min(max, qty + 1) : qty + 1)}><Icon name="plus" size={15} /></button>
    </div>
  );
}
