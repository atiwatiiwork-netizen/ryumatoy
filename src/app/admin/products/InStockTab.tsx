'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { franchiseOf, canConvertToInStock, outstandingTickets, stockAdditionsOf } from '@/domain/services/catalog';
import { availableFor, reservedHeld } from '@/domain/services/reservations';
import { roundTo50 } from '@/domain/services/pricing';
import { convertToInStock, restockInStock, removeProduct } from '@/data/mutations';
import type { Product } from '@/domain/entities';
import { StockBulkAdd } from './StockBulkAdd';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent';

/** Admin tab for พร้อมส่ง (in-stock): convert finished pre-orders, add new (bulk), and manage stock. */
export function InStockTab() {
  const db = useDatabase();
  const [makerId, setMakerId] = useState('');
  const [adding, setAdding] = useState(false);

  if (adding) return <StockBulkAdd onDone={() => setAdding(false)} />;

  const byMaker = (p: Product) => !makerId || p.manufacturer_id === makerId;
  const convertible = db.products.filter((p) => byMaker(p) && canConvertToInStock(db, p));
  const inStock = db.products.filter((p) => byMaker(p) && p.is_stock);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={makerId} onChange={(e) => setMakerId(e.target.value)}>
          <option value="">ทุกค่าย</option>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button onClick={() => setAdding(true)} className="ml-auto rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white"><Icon name="plus" size={15} className="mr-1 inline align-[-2px]" /> เพิ่มพร้อมส่งใหม่</button>
      </div>

      {/* convert finished pre-orders */}
      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-1 text-base font-bold">แปลงพรีที่จบแล้ว → พร้อมส่ง ({convertible.length})</div>
        <div className="mb-3 text-[12px] text-ink-faint">เฉพาะพรีที่ “ถึงไทย/ส่งมอบ” + ไม่มีตั๋วค้างจ่าย · สต๊อก = ส่วนเกินอัตโนมัติ</div>
        {convertible.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีพรีที่พร้อมแปลง (ต้องถึงไทยแล้ว + จ่ายครบทุกตั๋ว + มีส่วนเกิน)</div>
        ) : (
          <div className="flex flex-col divide-y divide-hair">{convertible.map((p) => <ConvertRow key={p.id} product={p} />)}</div>
        )}
      </div>

      {/* manage in-stock */}
      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 text-base font-bold">จัดการสต๊อกพร้อมส่ง ({inStock.length})</div>
        {inStock.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีสินค้าพร้อมส่ง</div>
        ) : (
          <div className="flex flex-col divide-y divide-hair">{inStock.map((p) => <ManageRow key={p.id} product={p} />)}</div>
        )}
      </div>
    </div>
  );
}

function ConvertRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const base = p.price_total;
  const [price, setPrice] = useState(String(base));
  const surplus = p.surplus_qty ?? 0;
  const pct = (n: number) => setPrice(String(roundTo50(base * (1 + n / 100))));
  const doConvert = () => {
    const pr = Number(price) || base;
    dispatch(convertToInStock(p.id, pr));
    flash(`แปลง "${p.series_name}" → พร้อมส่ง · สต๊อก ${surplus} · ${baht(pr)}`);
    setOpen(false);
  };
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={16} className="text-primary-soft/25" />}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{p.series_name}</div>
          <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · ราคาพรี {baht(base)} · ส่วนเกิน {surplus} ชิ้น</div>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">แปลงเป็นพร้อมส่ง</button>
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-subtle bg-surface-3 p-3">
          <div className="mb-2 text-[12px] text-ink-muted">ตั้งราคาพร้อมส่ง (ปุ่ม % คิดจากราคาพรี ปัดขึ้นลงท้าย 50)</div>
          <div className="flex flex-wrap items-center gap-2">
            <input className={cx(inputCls, 'w-28 text-center')} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} />
            {[10, 20, 30].map((n) => <button key={n} onClick={() => pct(n)} className="rounded-lg border border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">+{n}% = {baht(roundTo50(base * (1 + n / 100)))}</button>)}
            <button onClick={doConvert} className="ml-auto rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">ยืนยันแปลง → สต๊อก {surplus}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ManageRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const [addQty, setAddQty] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const total = p.stock_qty ?? 0;
  const held = reservedHeld(db, p.id);
  const avail = availableFor(db, p);
  const additions = stockAdditionsOf(db, p.id);
  const buyers = db.stockReservations
    .filter((r) => r.product_id === p.id && !r.batch_id && (r.status === 'confirmed' || r.status === 'paid'))
    .map((r) => ({ name: db.users.find((u) => u.id === r.user_id)?.display_name ?? '—', qty: r.qty, status: r.status, when: r.reserved_until }));
  const openTickets = outstandingTickets(db, p.id);

  const restock = () => {
    const q = Number(addQty) || 0;
    const np = newPrice ? Number(newPrice) : undefined;
    if (q <= 0 && np == null) return flash('ใส่จำนวนที่เติม หรือราคาใหม่');
    dispatch(restockInStock(p.id, q, np));
    flash(`${q > 0 ? `เติม +${q}` : ''}${np != null ? ` · ราคาใหม่ ${baht(np)}` : ''}`);
    setAddQty(''); setNewPrice('');
  };
  const del = () => {
    if (held > 0 || db.tickets.some((t) => t.product_id === p.id)) return flash('ลบไม่ได้ — มีคนจอง/ซื้อค้างอยู่');
    if (!confirm(`ลบ "${p.series_name}" ออกถาวร?`)) return;
    dispatch(removeProduct(p.id)); flash('ลบแล้ว');
  };

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-[160px] flex-1 items-center gap-2 text-left">
          <Icon name="chevronRight" size={16} className={cx('text-ink-faint transition-transform', open && 'rotate-90')} />
          <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={16} className="text-primary-soft/25" />}</div>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 truncate text-sm font-semibold">{p.series_name}
              {p.stock_origin === 'preorder' && <span className="rounded bg-[#2563eb]/[0.15] px-1.5 text-[9px] font-bold text-[#60a5fa]">จากพรี</span>}
            </span>
            <span className="block font-mono text-[11px] text-ink-faint">{baht(p.price_total)} · เหลือ <b className={avail <= 0 ? 'text-[#f87171]' : avail <= 3 ? 'text-[#fbbf24]' : 'text-[#4ade80]'}>{avail}</b>/{total}{held > 0 ? ` · จองอยู่ ${held}` : ''}</span>
          </span>
        </button>
        <button onClick={del} className="grid h-8 w-8 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171]"><Icon name="x" size={14} /></button>
      </div>
      {open && (
        <div className="mt-2 grid gap-3 rounded-xl border border-subtle bg-surface-3 p-3 lg:grid-cols-2">
          {/* restock */}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">เติมสต๊อก / แก้ราคา</div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[12px] text-ink-muted">เติม <input className={cx(inputCls, 'ml-1 inline w-16 text-center')} inputMode="numeric" value={addQty} onChange={(e) => setAddQty(e.target.value.replace(/[^\d]/g, ''))} placeholder="+" /></label>
              <label className="text-[12px] text-ink-muted">ราคาใหม่ <input className={cx(inputCls, 'ml-1 inline w-20 text-center')} inputMode="numeric" value={newPrice} onChange={(e) => setNewPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder={String(p.price_total)} /></label>
              <button onClick={restock} className="rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">บันทึก</button>
            </div>
            {openTickets > 0 && <div className="mt-2 text-[11px] text-[#fbbf24]">⚠️ มีตั๋วค้างจ่าย {openTickets} — ลบไม่ได้</div>}
          </div>
          {/* buyers */}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">คนซื้อ ({buyers.reduce((s, b) => s + b.qty, 0)})</div>
            {buyers.length === 0 ? <div className="text-[12px] text-ink-faint">ยังไม่มีคนซื้อ</div> : (
              <div className="flex flex-col gap-1">
                {buyers.map((b, i) => <div key={i} className="flex items-center justify-between text-[12.5px]"><span className="flex items-center gap-1.5"><Icon name="user" size={13} className="text-primary-soft" /> {b.name}</span><span className="text-ink-muted">×{b.qty} · {b.status === 'confirmed' ? 'ขายแล้ว' : 'รออนุมัติ'}</span></div>)}
              </div>
            )}
          </div>
          {/* history */}
          <div className="lg:col-span-2">
            <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">ประวัติสต๊อก (เข้า/ออก)</div>
            <div className="flex flex-col gap-1">
              {additions.map((a) => <div key={a.id} className="flex items-center justify-between text-[12.5px]"><span className="font-semibold text-[#4ade80]">+{a.qty} <span className="font-normal text-ink-muted2">· {a.note ?? 'เติม'}</span></span><span className="font-mono text-[11px] text-ink-faint">{new Date(a.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</span></div>)}
              {buyers.filter((b) => b.status === 'confirmed').map((b, i) => <div key={'s' + i} className="flex items-center justify-between text-[12.5px]"><span className="font-semibold text-[#f87171]">−{b.qty} <span className="font-normal text-ink-muted2">· ขายให้ {b.name}</span></span></div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
