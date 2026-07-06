'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { franchiseOf, stockRemaining, stockSoldQty, stockBuyers, stockAdditionsOf } from '@/domain/services/catalog';
import { availableFor, reservedHeld } from '@/domain/services/reservations';
import { reopenBatch, addStock, addInStock } from '@/data/mutations';
import type { Product } from '@/domain/entities';

export default function StockPage() {
  const db = useDatabase();
  const [makerId, setMakerId] = useState('');

  const inStock = db.products.filter((p) => p.is_stock && (!makerId || p.manufacturer_id === makerId));
  const withSurplus = db.products.filter((p) => (p.surplus_qty ?? 0) > 0 && (!makerId || p.manufacturer_id === makerId));
  const available = withSurplus.filter((p) => stockRemaining(db, p) > 0);
  const soldOut = withSurplus.filter((p) => stockRemaining(db, p) <= 0);

  return (
    <div>
      <div className="mb-2 text-2xl font-extrabold">สต๊อก & พร้อมส่ง</div>
      <div className="mb-5 text-[13px] text-ink-faint">สินค้าพร้อมส่ง (In-Stock) + สต๊อกส่วนเกินจากการปิดรอบ · เติมสต๊อก + ดูประวัติได้</div>

      <div className="mb-5 flex items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={makerId} onChange={(e) => setMakerId(e.target.value)}>
          <option value="">ทุกค่าย</option>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <Section title={`สินค้าพร้อมส่ง · In-Stock (${inStock.length})`}>
        {inStock.length === 0 ? <Empty text="ยังไม่มีสินค้าพร้อมส่ง — เพิ่มที่ จัดการสินค้า → ＋ พร้อมส่ง" /> : inStock.map((p) => <InStockRow key={p.id} product={p} />)}
      </Section>

      <Section title={`สต๊อกส่วนเกิน (จากพรี) · เหลือ (${available.length})`}>
        {available.length === 0 ? <Empty text="ไม่มีสต๊อกเหลือให้ขาย" /> : available.map((p) => <StockRow key={p.id} product={p} />)}
      </Section>

      <Section title={`ขายหมดแล้ว · รอถึงไทย/ส่งมอบ (${soldOut.length})`} muted>
        {soldOut.length === 0 ? <Empty text="ยังไม่มีสินค้าที่ขายสต๊อกหมด" /> : soldOut.map((p) => <StockRow key={p.id} product={p} soldOut />)}
      </Section>
    </div>
  );
}

function Section({ title, children, muted }: { title: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="mb-6">
      <div className={cx('mb-2 text-[15px] font-bold', muted && 'text-ink-muted')}>{title}</div>
      <div className="rounded-2xl border border-subtle bg-surface-2 p-2 lg:p-4">
        <div className="flex flex-col divide-y divide-hair">{children}</div>
      </div>
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <div className="py-6 text-center text-[13px] text-ink-faint">{text}</div>;

// direct in-stock (พร้อมส่ง) product: available / total / held + top-up + stock history
function InStockRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const [addQty, setAddQty] = useState('');
  const total = p.stock_qty ?? 0;
  const held = reservedHeld(db, p.id);
  const avail = availableFor(db, p);
  const sold = db.stockReservations.filter((r) => r.product_id === p.id && !r.batch_id && r.status === 'confirmed').reduce((s, r) => s + r.qty, 0);
  const additions = stockAdditionsOf(db, p.id);
  const topUp = () => { const q = Number(addQty) || 0; if (q <= 0) return flash('ใส่จำนวนที่จะเติม'); dispatch(addInStock(p.id, q)); flash(`เติมสต๊อก +${q}`); setAddQty(''); };

  return (
    <div className="px-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-[160px] flex-1 items-center gap-2 text-left">
          <Icon name="chevronRight" size={16} className={cx('text-ink-faint transition-transform', open && 'rotate-90')} />
          <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={15} className="text-primary-soft/25" />}</div>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{p.series_name}</span>
            <span className="block font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · {baht(p.price_total)} · เหลือ <b className={avail <= 0 ? 'text-[#f87171]' : avail <= 3 ? 'text-[#fbbf24]' : 'text-[#4ade80]'}>{avail}</b>/{total}{held > 0 ? ` · จองอยู่ ${held}` : ''}{sold > 0 ? ` · ขายแล้ว ${sold}` : ''}</span>
          </span>
        </button>
        <label className="text-[12px] text-ink-muted">เติม <input className="ml-1 w-16 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm text-ink outline-none" inputMode="numeric" value={addQty} onChange={(e) => setAddQty(e.target.value.replace(/[^\d]/g, ''))} placeholder="+" /></label>
        <button onClick={topUp} className="rounded-lg bg-cta px-3 py-2 text-[12.5px] font-bold text-white">เติมสต๊อก</button>
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-subtle bg-surface-3 p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-muted">ประวัติสต๊อก ({additions.length})</div>
          {additions.length === 0 ? (
            <div className="text-[12.5px] text-ink-faint">ยังไม่มีประวัติ</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {additions.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-[13px]">
                  <span className="font-semibold text-[#4ade80]">+{a.qty} <span className="font-normal text-ink-muted2">· {a.note ?? 'เติม'}</span></span>
                  <span className="font-mono text-[11px] text-ink-faint">{new Date(a.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StockRow({ product: p, soldOut }: { product: Product; soldOut?: boolean }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const remaining = stockRemaining(db, p);
  const sold = stockSoldQty(db, p.id);
  const surplus = p.surplus_qty ?? 0;
  const [price, setPrice] = useState(String(p.price_total));
  const [qty, setQty] = useState(String(remaining));
  const [label, setLabel] = useState('รอบ 2');
  const [full, setFull] = useState(false); // จ่ายเต็ม (ของถึงแล้ว/พร้อมส่ง) vs เก็บมัดจำ (ระหว่างทาง)
  const [addQty, setAddQty] = useState('');
  const buyers = stockBuyers(db, p.id);
  const additions = stockAdditionsOf(db, p.id);

  // clamp the reopen qty so you can never list more than the remaining stock
  const setQtyClamped = (v: string) => setQty(v === '' ? '' : String(Math.max(0, Math.min(Number(v) || 0, remaining))));

  const reopen = () => {
    const q = Math.min(Number(qty) || 0, remaining);
    if (q <= 0) return flash('จำนวนต้องมากกว่า 0 และไม่เกินสต๊อกที่เหลือ');
    const pr = Number(price) || p.price_total;
    // พร้อมส่ง (ของอยู่ในมือ) = จ่ายเต็ม ; ระหว่างทาง = เก็บมัดจำเดิม แล้วค่อยเก็บส่วนต่างตอนถึงไทย
    const dep = full ? pr : p.deposit_amount;
    dispatch(reopenBatch(p.id, { price: pr, deposit: dep, qty: q, label: label.trim() || undefined }));
    flash(`เปิด${full ? 'ขายพร้อมส่ง' : 'จองรอบใหม่'} ${q} ตัว @ ${baht(pr)}${full ? ' (จ่ายเต็ม)' : ` · มัดจำ ${baht(dep)}`}`);
    setQty('');
  };

  const topUp = () => {
    const q = Number(addQty) || 0;
    if (q <= 0) return flash('ใส่จำนวนที่จะเติม');
    dispatch(addStock(p.id, q));
    flash(`เติมสต๊อก +${q} ตัว`);
    setAddQty('');
  };

  return (
    <div className="px-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-[160px] flex-1 items-center gap-2 text-left">
          <Icon name="chevronRight" size={16} className={cx('text-ink-faint transition-transform', open && 'rotate-90')} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{p.series_name}</span>
            <span className="block font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · สต๊อกที่เหลือ : <b className={soldOut ? 'text-ink-faint' : 'text-primary-soft'}>{remaining}</b> · ขายไปแล้ว {sold}/{surplus}</span>
          </span>
        </button>
        {!soldOut && (
          <>
            <label className="text-[12px] text-ink-muted">ชื่อล็อต <input className="ml-1 w-28 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-sm text-ink outline-none" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="รอบ 2 / พร้อมส่ง" /></label>
            <label className="text-[12px] text-ink-muted">ราคา <input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-sm text-ink outline-none" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <label className="text-[12px] text-ink-muted">จำนวน <input className="ml-1 w-16 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm text-ink outline-none" inputMode="numeric" max={remaining} value={qty} onChange={(e) => setQtyClamped(e.target.value)} /></label>
            <button type="button" onClick={() => setFull((v) => !v)} title="สลับระหว่าง เก็บมัดจำ (ระหว่างทาง) กับ จ่ายเต็ม (พร้อมส่ง)" className={cx('rounded-lg border px-2.5 py-1.5 text-[11.5px] font-bold', full ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted2')}>{full ? 'พร้อมส่ง · จ่ายเต็ม' : `มัดจำ ${baht(p.deposit_amount)}`}</button>
            <button onClick={reopen} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">เปิดขาย</button>
          </>
        )}
        <label className="text-[12px] text-ink-muted">เติม <input className="ml-1 w-14 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm text-ink outline-none" inputMode="numeric" value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder="+" /></label>
        <button onClick={topUp} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-ink-muted2">เพิ่มสต๊อก</button>
      </div>

      {open && (
        <div className="mt-2 grid gap-3 rounded-xl border border-subtle bg-surface-3 p-3 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-[12px] font-semibold text-ink-muted">คนซื้อสต๊อกนี้ ({buyers.reduce((s, b) => s + b.qty, 0)} ตัว)</div>
            {buyers.length === 0 ? (
              <div className="text-[12.5px] text-ink-faint">ยังไม่มีคนซื้อ</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {buyers.map((b, i) => (
                  <div key={i} className="flex items-center justify-between text-[13px]">
                    <span className="flex items-center gap-2"><Icon name="user" size={14} className="text-primary-soft" /> {b.name}</span>
                    <span className="text-ink-muted">×{b.qty} · <span className="font-mono text-[11px] text-ink-faint">{b.ticket_no}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 text-[12px] font-semibold text-ink-muted">ประวัติเติมสต๊อก</div>
            {additions.length === 0 ? (
              <div className="text-[12.5px] text-ink-faint">ยังไม่มีการเติมสต๊อก</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {additions.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-[13px]">
                    <span className="font-semibold text-[#4ade80]">+{a.qty}</span>
                    <span className="font-mono text-[11px] text-ink-faint">{new Date(a.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
