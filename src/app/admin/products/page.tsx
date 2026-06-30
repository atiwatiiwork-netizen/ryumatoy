'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, cx } from '@/components/ui';
import { manufacturerNameOf, franchiseOf, typeLabel } from '@/domain/services/catalog';
import {
  genId, upsertManufacturer, removeManufacturer, upsertFranchise, removeFranchise, upsertProduct, removeProduct,
} from '@/data/mutations';
import type { Product, ProductStatus, ProductType } from '@/domain/entities';

type Tab = 'manufacturers' | 'franchises' | 'products';
const TYPES: { v: ProductType; label: string }[] = [
  { v: 'wcf', label: 'WCF' }, { v: 'figure', label: 'Figure' }, { v: 'resin', label: 'Resin' }, { v: 'other', label: 'อื่นๆ' },
];
const STATUSES: { v: ProductStatus; label: string }[] = [
  { v: 'open', label: 'เปิดจอง' }, { v: 'production', label: 'กำลังผลิต' }, { v: 'shipping', label: 'กำลังเดินทาง' }, { v: 'arrived', label: 'ถึงไทยแล้ว' }, { v: 'closed', label: 'ปิด' },
];

export default function AdminProductsPage() {
  const [tab, setTab] = useState<Tab>('products');
  return (
    <div>
      <div className="mb-5 text-2xl font-extrabold">จัดการสินค้า</div>
      <div className="mb-6 flex gap-2">
        {([['products', 'สินค้า'], ['manufacturers', 'ค่าย'], ['franchises', 'เรื่อง']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cx('rounded-full border px-4 py-2 text-sm font-bold', tab === k ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{label}</button>
        ))}
      </div>
      {tab === 'manufacturers' && <Manufacturers />}
      {tab === 'franchises' && <Franchises />}
      {tab === 'products' && <Products />}
    </div>
  );
}

// ---- shared inputs ---------------------------------------------------------
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>;
}
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-subtle bg-surface-2 p-5">{children}</div>;
}

// ---- Manufacturers (ค่าย) --------------------------------------------------
function Manufacturers() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [name, setName] = useState('');

  const add = () => {
    if (!name.trim()) return;
    dispatch(upsertManufacturer({ id: genId('m'), name: name.trim() }));
    setName(''); flash('เพิ่มค่ายแล้ว');
  };
  const del = (mid: string) => {
    if (db.franchises.some((f) => f.manufacturer_id === mid)) return flash('ลบไม่ได้ — มีเรื่องอยู่ใต้ค่ายนี้');
    dispatch(removeManufacturer(mid)); flash('ลบค่ายแล้ว');
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 font-bold">เพิ่มค่ายใหม่</div>
        <Field label="ชื่อค่าย (Manufacturer)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น Bandai" /></Field>
        <div className="mt-4"><Button onClick={add} icon="plus">เพิ่มค่าย</Button></div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">ค่ายทั้งหมด ({db.manufacturers.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.manufacturers.map((m) => (
            <Row key={m.id} title={m.name} sub={`${db.franchises.filter((f) => f.manufacturer_id === m.id).length} เรื่อง`} onDelete={() => del(m.id)} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---- Franchises (เรื่อง) ---------------------------------------------------
function Franchises() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [name, setName] = useState('');
  const [abbr, setAbbr] = useState('');
  const [manId, setManId] = useState(db.manufacturers[0]?.id ?? '');

  const add = () => {
    if (!name.trim() || !abbr.trim() || !manId) return flash('กรอกชื่อ/ตัวย่อ/ค่ายให้ครบ');
    dispatch(upsertFranchise({ id: genId('f'), name: name.trim(), abbr: abbr.trim().toLowerCase(), manufacturer_id: manId }));
    setName(''); setAbbr(''); flash('เพิ่มเรื่องแล้ว');
  };
  const del = (fid: string) => {
    if (db.products.some((p) => p.franchise_id === fid)) return flash('ลบไม่ได้ — มีสินค้าอยู่ใต้เรื่องนี้');
    dispatch(removeFranchise(fid)); flash('ลบเรื่องแล้ว');
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 font-bold">เพิ่มเรื่องใหม่</div>
        <div className="flex flex-col gap-3">
          <Field label="ชื่อเรื่อง (Franchise)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น One Piece" /></Field>
          <Field label="ตัวย่อ (abbr) — ใช้ออกเลข Ticket"><input className={inputCls} value={abbr} onChange={(e) => setAbbr(e.target.value)} placeholder="เช่น op" /></Field>
          <Field label="ค่าย"><select className={inputCls} value={manId} onChange={(e) => setManId(e.target.value)}>{db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        </div>
        <div className="mt-4"><Button onClick={add} icon="plus">เพิ่มเรื่อง</Button></div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">เรื่องทั้งหมด ({db.franchises.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.franchises.map((f) => (
            <Row key={f.id} title={`${f.name}`} sub={`${f.abbr.toUpperCase()} · ${manufacturerNameOf(db, { franchise_id: f.id } as Product)} · ${db.products.filter((p) => p.franchise_id === f.id).length} สินค้า`} onDelete={() => del(f.id)} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---- Products (สินค้า) -----------------------------------------------------
interface Draft {
  id?: string;
  franchise_id: string;
  series_name: string;
  type: ProductType;
  description: string;
  eta_note: string;
  price_total: string;
  deposit_amount: string;
  is_stock: boolean;
  stock_qty: string;
  has_variants: boolean;
  status: ProductStatus;
}
const emptyDraft = (franchiseId: string): Draft => ({
  franchise_id: franchiseId, series_name: '', type: 'wcf', description: '', eta_note: '', price_total: '', deposit_amount: '', is_stock: false, stock_qty: '', has_variants: false, status: 'open',
});

function Products() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [draft, setDraft] = useState<Draft>(emptyDraft(db.franchises[0]?.id ?? ''));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const editing = Boolean(draft.id);

  const save = () => {
    if (!draft.franchise_id) return flash('เลือกเรื่องก่อน (ต้องมีค่าย/เรื่องก่อน)');
    if (!draft.series_name.trim()) return flash('กรอกชื่อสินค้า');
    const price = Number(draft.price_total) || 0;
    const deposit = Number(draft.deposit_amount) || 0;
    if (price <= 0) return flash('กรอกราคาเต็ม');
    const existing = draft.id ? db.products.find((p) => p.id === draft.id) : undefined;
    const product: Product = {
      id: draft.id ?? genId('p'),
      franchise_id: draft.franchise_id,
      series_name: draft.series_name.trim(),
      type: draft.type,
      description: draft.description.trim(),
      images: existing?.images ?? [],
      eta_note: draft.eta_note.trim() || (draft.is_stock ? 'พร้อมส่ง' : 'TBA'),
      price_total: price,
      deposit_amount: draft.is_stock ? price : deposit,
      is_stock: draft.is_stock,
      stock_qty: draft.is_stock ? Number(draft.stock_qty) || 0 : undefined,
      has_variants: draft.has_variants,
      status: draft.status,
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    dispatch(upsertProduct(product));
    flash(editing ? 'บันทึกสินค้าแล้ว' : 'เพิ่มสินค้าแล้ว');
    setDraft(emptyDraft(db.franchises[0]?.id ?? ''));
  };

  const edit = (p: Product) => setDraft({
    id: p.id, franchise_id: p.franchise_id, series_name: p.series_name, type: p.type, description: p.description,
    eta_note: p.eta_note, price_total: String(p.price_total), deposit_amount: String(p.deposit_amount),
    is_stock: p.is_stock, stock_qty: p.stock_qty != null ? String(p.stock_qty) : '', has_variants: p.has_variants, status: p.status,
  });

  const del = (p: Product) => {
    const usedByTicket = db.tickets.some((t) => t.product_id === p.id);
    const usedByOrder = db.orders.some((o) => o.items.some((i) => i.product_id === p.id));
    if (usedByTicket || usedByOrder) return flash('ลบไม่ได้ — มีใบพรี/ออเดอร์อ้างอิงสินค้านี้');
    dispatch(removeProduct(p.id)); flash('ลบสินค้าแล้ว');
    if (draft.id === p.id) setDraft(emptyDraft(db.franchises[0]?.id ?? ''));
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[380px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-bold">{editing ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</span>
          {editing && <button onClick={() => setDraft(emptyDraft(db.franchises[0]?.id ?? ''))} className="text-xs text-primary-soft">+ เพิ่มใหม่แทน</button>}
        </div>
        {db.franchises.length === 0 ? (
          <div className="text-[13px] text-ink-faint">ยังไม่มีเรื่อง — ไปเพิ่ม “ค่าย” และ “เรื่อง” ก่อน แล้วค่อยเพิ่มสินค้า</div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="เรื่อง (Franchise)"><select className={inputCls} value={draft.franchise_id} onChange={(e) => set('franchise_id', e.target.value)}>{db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
            <Field label="ชื่อสินค้า / ซีรีย์"><input className={inputCls} value={draft.series_name} onChange={(e) => set('series_name', e.target.value)} placeholder="เช่น WCF Vol.38 — Luffy" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ประเภท"><select className={inputCls} value={draft.type} onChange={(e) => set('type', e.target.value as ProductType)}>{TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select></Field>
              <Field label="สถานะ"><select className={inputCls} value={draft.status} onChange={(e) => set('status', e.target.value as ProductStatus)}>{STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.is_stock} onChange={(e) => set('is_stock', e.target.checked)} /> เป็นสินค้าพร้อมส่ง (in-stock)</label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ราคาเต็ม (฿)"><input className={inputCls} inputMode="numeric" value={draft.price_total} onChange={(e) => set('price_total', e.target.value)} placeholder="1290" /></Field>
              {draft.is_stock
                ? <Field label="จำนวนสต็อก"><input className={inputCls} inputMode="numeric" value={draft.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} placeholder="5" /></Field>
                : <Field label="มัดจำ (฿)"><input className={inputCls} inputMode="numeric" value={draft.deposit_amount} onChange={(e) => set('deposit_amount', e.target.value)} placeholder="590" /></Field>}
            </div>
            <Field label="กำหนดการ (ETA)"><input className={inputCls} value={draft.eta_note} onChange={(e) => set('eta_note', e.target.value)} placeholder="เช่น Q3 2026" /></Field>
            <Field label="รายละเอียด"><textarea className={cx(inputCls, 'h-20 resize-none')} value={draft.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <div className="mt-1"><Button onClick={save} icon={editing ? 'check' : 'plus'}>{editing ? 'บันทึก' : 'เพิ่มสินค้า'}</Button></div>
          </div>
        )}
      </Panel>

      <Panel>
        <div className="mb-3 font-bold">สินค้าทั้งหมด ({db.products.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.products.map((p) => (
            <div key={p.id} className="flex items-center gap-3 py-3">
              <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg bg-stripe"><Icon name="box" size={20} className="text-primary-soft/25" /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{p.series_name}</div>
                <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · {typeLabel(p.type)} · {baht(p.price_total)}</div>
              </div>
              <StatusBadge status={(p.is_stock ? 'open' : p.status) as StatusKey} />
              <button onClick={() => edit(p)} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
              <button onClick={() => del(p)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
            </div>
          ))}
          {db.products.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีสินค้า</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---- shared list row -------------------------------------------------------
function Row({ title, sub, onDelete }: { title: string; sub: string; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        <div className="text-[11.5px] text-ink-faint">{sub}</div>
      </div>
      <button onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
    </div>
  );
}
