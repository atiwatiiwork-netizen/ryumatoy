'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { orderedQtyOf, franchiseOf } from '@/domain/services/catalog';
import { closeProduction, reopenBatch } from '@/data/mutations';

const inputCls = 'w-20 rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-center text-sm text-ink outline-none focus:border-accent';

export default function ProductionPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [makerId, setMakerId] = useState(db.manufacturers[0]?.id ?? '');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});

  // open pre-orders (still accepting orders) for the chosen ค่าย
  const items = db.products.filter((p) => p.manufacturer_id === makerId && !p.is_stock && p.status === 'open');
  const orderedOf = (pid: string) => orderedQtyOf(db, pid);
  const finalOf = (pid: string) => Number(qty[pid] ?? String(orderedOf(pid))) || 0;
  const chosen = items.filter((p) => sel[p.id]);

  const close = () => {
    if (chosen.length === 0) return flash('เลือกรายการที่จะสั่งผลิตก่อน');
    dispatch(closeProduction(chosen.map((p) => ({ productId: p.id, finalQty: finalOf(p.id) }))));
    flash(`ปิดรอบ → ผลิต ${chosen.length} รายการ`);
    setSel({});
    setQty({});
  };

  return (
    <div>
      <div className="mb-2 text-2xl font-extrabold">ปิดรอบสั่งผลิต</div>
      <div className="mb-5 text-[13px] text-ink-faint">เลือกค่าย → ติ๊กรายการที่ค่ายเรียกเก็บ → ใส่จำนวนไฟนอลที่จะสั่ง → กดปิดรอบ (ส่วนที่เกินยอดจอง = สต๊อกร้าน)</div>

      <div className="mb-5 flex items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={makerId} onChange={(e) => { setMakerId(e.target.value); setSel({}); setQty({}); }}>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        {items.length === 0 ? (
          <div className="py-8 text-center text-ink-faint">ไม่มีรายการเปิดจองของค่ายนี้</div>
        ) : (
          <>
            <div className="mb-2 hidden grid-cols-[28px_1fr_90px_110px_1fr] gap-3 px-1 text-[11.5px] font-semibold text-ink-faint lg:grid">
              <span></span><span>สินค้า</span><span className="text-center">ยอดจอง</span><span className="text-center">สั่งไฟนอล</span><span>ส่วนเกิน → สต๊อก</span>
            </div>
            <div className="flex flex-col divide-y divide-hair">
              {items.map((p) => {
                const ordered = orderedOf(p.id);
                const surplus = Math.max(0, finalOf(p.id) - ordered);
                const on = !!sel[p.id];
                return (
                  <div key={p.id} className="grid grid-cols-[28px_1fr] items-center gap-3 py-3 lg:grid-cols-[28px_1fr_90px_110px_1fr]">
                    <button onClick={() => setSel((s) => ({ ...s, [p.id]: !on }))} className={cx('grid h-5 w-5 place-items-center rounded-[5px] border-[1.5px]', on ? 'border-primary bg-primary' : 'border-subtle')}>
                      {on && <Icon name="check" size={12} className="text-white" />}
                    </button>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{p.series_name}</div>
                      <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · {baht(p.price_total)}</div>
                    </div>
                    <div className="text-center text-sm font-bold lg:col-start-3"><span className="text-ink-faint lg:hidden">ยอดจอง </span>{ordered}</div>
                    <div className="lg:col-start-4 lg:text-center">
                      <input className={inputCls} inputMode="numeric" value={qty[p.id] ?? String(ordered)} disabled={!on} onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value }))} />
                    </div>
                    <div className="text-[13px] lg:col-start-5">
                      {on && surplus > 0
                        ? <span className="text-primary-soft">+{surplus} ตัว → สต๊อก</span>
                        : <span className="text-ink-faint">{on ? 'ไม่มีส่วนเกิน' : '—'}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex items-center gap-3">
              <span className="text-[13px] text-ink-muted">เลือก {chosen.length} รายการ</span>
              <div className="ml-auto w-auto"><Button onClick={close} icon="check" style={{ width: 'auto', paddingLeft: 24, paddingRight: 24 }}>ปิดรอบ → ผลิต</Button></div>
            </div>
          </>
        )}
      </div>

      <SurplusReopen makerId={makerId} />
    </div>
  );
}

/** สต๊อกส่วนเกินจากการปิดรอบ → เปิดขายต่อเป็น batch บน SKU เดิม (ราคาใหม่ได้). */
function SurplusReopen({ makerId }: { makerId: string }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [form, setForm] = useState<Record<string, { price: string; qty: string }>>({});

  const surplusProducts = db.products.filter((p) => p.manufacturer_id === makerId && (p.surplus_qty ?? 0) > 0);
  const openBatchQty = (pid: string) => db.batches.filter((b) => b.product_id === pid && b.status === 'open').reduce((s, b) => s + b.stock_qty, 0);

  const reopen = (pid: string, surplus: number, defaultPrice: number, defaultDeposit: number) => {
    const f = form[pid] ?? { price: String(defaultPrice), qty: String(surplus) };
    const price = Number(f.price) || defaultPrice;
    const qty = Number(f.qty) || surplus;
    dispatch(reopenBatch(pid, { price, deposit: defaultDeposit, qty }));
    flash(`เปิดขายสต๊อก ${qty} ตัว @ ${baht(price)}`);
    setForm((s) => ({ ...s, [pid]: { price: String(price), qty: '' } }));
  };

  if (surplusProducts.length === 0) return null;

  return (
    <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">สต๊อกเหลือ → เปิดขายต่อ</div>
      <div className="mb-4 text-[12.5px] text-ink-faint">ส่วนเกินจากการปิดรอบ เปิดขายเป็นล็อตใหม่บนสินค้าเดิมได้ (ตั้งราคาใหม่หรือคงเดิม) — คนจองรอบก่อนราคาไม่กระทบ</div>
      <div className="flex flex-col divide-y divide-hair">
        {surplusProducts.map((p) => {
          const surplus = p.surplus_qty ?? 0;
          const listed = openBatchQty(p.id);
          const f = form[p.id] ?? { price: String(p.price_total), qty: String(surplus) };
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-[160px] flex-1">
                <div className="truncate text-sm font-semibold">{p.series_name}</div>
                <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · ส่วนเกิน {surplus}{listed > 0 ? ` · เปิดขายแล้ว ${listed}` : ''}</div>
              </div>
              <label className="text-[12px] text-ink-muted">ราคา <input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-sm text-ink outline-none" inputMode="numeric" value={f.price} onChange={(e) => setForm((s) => ({ ...s, [p.id]: { ...f, price: e.target.value } }))} /></label>
              <label className="text-[12px] text-ink-muted">จำนวน <input className="ml-1 w-16 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm text-ink outline-none" inputMode="numeric" value={f.qty} onChange={(e) => setForm((s) => ({ ...s, [p.id]: { ...f, qty: e.target.value } }))} /></label>
              <button onClick={() => reopen(p.id, surplus, p.price_total, p.deposit_amount)} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">เปิดขาย</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
