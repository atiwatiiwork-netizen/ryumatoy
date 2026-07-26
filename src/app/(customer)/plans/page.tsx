'use client';

import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { closePaymentPlan } from '@/data/mutations';
import { livePrice } from '@/domain/services/pricing';
import { lineDepositForRank } from '@/domain/services/ranks';
import { lineImage, productLabel } from '@/domain/services/catalog';
import { availableFor, batchAvailable } from '@/domain/services/reservations';
import { useSmartBack } from '@/lib/nav';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { BackBar, Button, cx } from '@/components/ui';
import type { Database, PaymentPlan } from '@/domain/entities';

/**
 * นัดชำระของฉัน (v57, เจ้าของ 2026-07-26) — แอดมินเป็นคนออกนัดให้ ลูกค้ามาที่หน้านี้เพื่อ "กดจ่าย"
 * กดจ่าย = โหลดรายการเข้าตะกร้าแล้วส่งเข้า /checkout ตัวเดิม → ได้ทุกอย่างของ flow ปกติฟรี:
 * จองสต๊อก 15 นาที · บล็อกเมื่อของหมด (เคส Kid Naruto) · คูปอง · สลิป · คิวอนุมัติ · ออกตั๋ว
 */
export default function PlansPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const cart = useCart();
  const router = useRouter();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');

  const mine = db.paymentPlans.filter((p) => p.user_id === uid);
  const open = mine.filter((p) => p.status === 'open').sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const closed = mine.filter((p) => p.status !== 'open').sort((a, b) => (a.due_date < b.due_date ? 1 : -1)).slice(0, 8);

  const d0 = new Date();
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const myRank = db.users.find((u) => u.id === uid)?.rank ?? 'bronze';

  /** ราคาที่จะถูกเรียกเก็บ "ตอนนี้จริงๆ" — ต้องคิดแบบเดียวกับ submitOrder (livePrice + ขั้นสมาชิก)
   *  ไม่ใช้ตัวเลข snapshot ในนัด เพราะราคาอาจถูกปรับ (เรตหยวน) หลังออกนัด */
  const eachNow = (i: PaymentPlan['items'][number]) => {
    const p = db.products.find((x) => x.id === i.product_id);
    if (!p) return 0;
    const { price, deposit } = livePrice(db, { productId: i.product_id, variantId: i.variant_id, batchId: i.batch_id });
    return lineDepositForRank(db.settings, { deposit, price, isStock: p.is_stock ?? true }, myRank);
  };

  const pay = (plan: PaymentPlan) => {
    const live = plan.items.filter((i) => db.products.some((p) => p.id === i.product_id));
    if (live.length === 0) return flash('สินค้าในนัดนี้ถูกนำออกจากร้านแล้ว — ทักแอดมินได้เลยครับ');
    if (cart.lines.length > 0 && !confirm('ตะกร้ามีสินค้าอยู่ — จะแทนที่ด้วยรายการในนัดชำระนี้?')) return;
    cart.clear();
    for (const i of live) {
      const { price, deposit } = livePrice(db, { productId: i.product_id, variantId: i.variant_id, batchId: i.batch_id });
      const p = db.products.find((x) => x.id === i.product_id);
      cart.add({
        productId: i.product_id, variantId: i.variant_id, batchId: i.batch_id, qty: i.qty,
        priceEach: price,
        depositEach: lineDepositForRank(db.settings, { deposit, price, isStock: p?.is_stock ?? true }, myRank),
      });
    }
    router.push(`/checkout?plan=${encodeURIComponent(plan.id)}`);
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="นัดชำระ" onBack={goBack} />

      {open.length === 0 && closed.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 py-14 text-center text-[13px] text-ink-faint">
          ยังไม่มีนัดชำระ<br />
          <span className="mt-1.5 block text-[12px]">อยากจ่ายทีหลัง? ทักแอดมินได้เลย — แอดมินจะออกนัดให้ แล้วมาโผล่ที่หน้านี้</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {open.map((p) => {
            const overdue = p.due_date < today;
            const isToday = p.due_date === today;
            const dead = p.items.filter((i) => soldOut(db, i));
            const gone = p.items.filter((i) => !db.products.some((x) => x.id === i.product_id));
            const totalNow = p.items.reduce((s, i) => s + eachNow(i) * i.qty, 0);
            const changed = totalNow !== p.amount && totalNow > 0;
            return (
              <div key={p.id} className={cx('rounded-card border bg-surface-2 p-4', overdue ? 'border-[#b91c1c]/50' : isToday ? 'border-[#d97706]/45' : 'border-[#a855f7]/40')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx('rounded-md px-2 py-0.5 text-[11px] font-extrabold',
                    overdue ? 'animate-blink bg-[#b91c1c]/25 text-[#f87171]' : isToday ? 'bg-[#d97706]/20 text-[#fbbf24]' : 'bg-[#a855f7]/20 text-[#c084fc]')}>
                    {overdue ? `เลยกำหนด · ${p.due_date}` : isToday ? 'ครบกำหนดวันนี้' : `ครบกำหนด ${p.due_date}`}
                  </span>
                  <span className="ml-auto text-[19px] font-extrabold text-primary-soft">{baht(totalNow || p.amount)}</span>
                </div>

                <div className="mt-2.5 flex flex-col gap-1.5">
                  {p.items.map((i, n) => {
                    const missing = !db.products.some((x) => x.id === i.product_id);
                    const out = soldOut(db, i);
                    return (
                      <div key={`${i.product_id}-${i.variant_id ?? ''}-${i.batch_id ?? ''}-${n}`} className="flex items-center gap-2.5">
                        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">
                          {!missing && <img src={lineImage(db, i.product_id, i.variant_id)} alt="" className="h-full w-full object-cover" />}
                        </div>
                        <span className={cx('min-w-0 flex-1 truncate text-[12.5px]', (missing || out) && 'text-ink-faint line-through')}>
                          {missing ? i.label : productLabel(db, i.product_id, i.variant_id)}{i.batch_id ? ' · รอบพิเศษ' : ''} ×{i.qty}
                        </span>
                        {missing ? <span className="shrink-0 text-[11px] text-[#f87171]">ไม่มีในร้านแล้ว</span>
                          : out ? <span className="shrink-0 text-[11px] font-bold text-[#f87171]">หมดแล้ว</span>
                          : <span className="shrink-0 text-[12px] font-semibold">{baht(eachNow(i) * i.qty)}</span>}
                      </div>
                    );
                  })}
                </div>

                {p.note && <div className="mt-1.5 text-[11.5px] text-ink-faint">📝 {p.note}</div>}
                {changed && (
                  <div className="mt-2 rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.1] px-3 py-2 text-[11.5px] text-[#fbbf24]">
                    ราคาปรับใหม่แล้ว · ตอนออกนัดคือ {baht(p.amount)} → ตอนนี้ {baht(totalNow)} (ระบบคิดตามราคาปัจจุบันเสมอ)
                  </div>
                )}
                {(dead.length > 0 || gone.length > 0) && (
                  <div className="mt-2 rounded-lg border border-[#b91c1c]/45 bg-[#b91c1c]/[0.1] px-3 py-2 text-[11.5px] text-[#f87171]">
                    มีสินค้าที่หมด/ถูกนำออกแล้ว — จ่ายรายการนี้ไม่ได้ ทักแอดมินให้ออกนัดใหม่นะครับ 🙏
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1">
                    <Button
                      icon="arrowRight"
                      disabled={dead.length > 0 || gone.length > 0}
                      onClick={() => pay(p)}
                    >ชำระเงิน</Button>
                  </div>
                  <button
                    onClick={() => { if (confirm('ยกเลิกนัดชำระนี้?')) { dispatch(closePaymentPlan(p.id, 'cancelled')); flash('ยกเลิกนัดแล้ว'); } }}
                    className="shrink-0 text-[12px] text-ink-faint underline"
                  >ยกเลิกนัด</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {closed.length > 0 && (
        <div className="mt-4 rounded-card border border-subtle bg-surface-2 p-3.5">
          <div className="mb-1.5 text-[12px] font-bold text-ink-muted">นัดที่ปิดแล้ว</div>
          <div className="flex flex-col gap-1">
            {closed.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                <span>{p.due_date}</span>
                <span className={p.status === 'done' ? 'text-[#4ade80]' : ''}>{p.status === 'done' ? 'จ่ายแล้ว ✓' : 'ยกเลิก'}</span>
                <span className="ml-auto font-semibold text-ink-muted2">{baht(p.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-subtle bg-surface-2 px-[13px] py-2.5 text-[11.5px] text-ink-faint">
        <Icon name="bell" size={15} className="mt-0.5 shrink-0" />
        <span>นัดชำระ<b className="text-ink-muted2">ไม่ได้กันของไว้ให้</b> — ถ้าเป็นของจำนวนจำกัด ควรรีบจ่ายก่อนถึงกำหนด</span>
      </div>
    </div>
  );
}

/** ของชิ้นนี้ในนัด "หมด" แล้วหรือยัง (เฉพาะของที่มีจำนวนจำกัด: พร้อมส่ง / รอบพิเศษ) */
function soldOut(db: Database, i: PaymentPlan['items'][number]): boolean {
  const p = db.products.find((x) => x.id === i.product_id);
  if (!p) return false; // ของหายไปเลย — รายงานแยกอีกป้าย
  if (i.batch_id) {
    const b = db.batches.find((x) => x.id === i.batch_id);
    if (!b || b.status !== 'open' || b.published === false) return true;
    return i.qty > batchAvailable(db, b);
  }
  if (p.is_stock) return i.qty > availableFor(db, p);
  return p.status !== 'open'; // พรีปกติ: ปิดรับจองแล้ว = จ่ายไม่ได้
}
