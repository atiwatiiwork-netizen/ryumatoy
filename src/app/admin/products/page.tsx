'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { applyWatermark } from '@/lib/watermark';
import { baht, STATUS, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, TicketQr, cx } from '@/components/ui';
import { franchiseOf, manufacturerOf, categoryOf, seriesForFranchise, orderedQtyOf } from '@/domain/services/catalog';
import { priceFromYuan, depositFor } from '@/domain/services/pricing';
import type { WcfType } from '@/domain/entities';
import {
  genId, upsertCategory, removeCategory, upsertManufacturer, removeManufacturer, upsertFranchise, removeFranchise,
  upsertSeries, removeSeries, upsertProduct, removeProduct, setProductStatus, closeProduction,
} from '@/data/mutations';
import type { Product, ProductStatus } from '@/domain/entities';

type Tab = 'products' | 'status' | 'categories' | 'manufacturers' | 'franchises' | 'series';
const STATUSES: { v: ProductStatus; label: string }[] = [
  { v: 'open', label: 'เปิดจอง' }, { v: 'production', label: 'กำลังผลิต' }, { v: 'shipping', label: 'กำลังเดินทาง' }, { v: 'arrived', label: 'ถึงไทยแล้ว' }, { v: 'delivered', label: 'ส่งมอบแล้ว' }, { v: 'closed', label: 'ปิด' },
];
const LOT_STEPS: ProductStatus[] = ['open', 'production', 'shipping', 'arrived', 'delivered'];

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>
);
const Panel = ({ children }: { children: React.ReactNode }) => <div className="rounded-2xl border border-subtle bg-surface-2 p-5">{children}</div>;

export default function AdminProductsPage() {
  const [tab, setTab] = useState<Tab>('products');
  return (
    <div>
      <div className="mb-5 text-2xl font-extrabold">จัดการสินค้า</div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* กลุ่มจัดการแคตตาล็อก */}
        {([['products', 'สินค้า'], ['categories', 'ประเภท'], ['franchises', 'เรื่อง'], ['manufacturers', 'ค่าย'], ['series', 'ซีรีย์']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cx('rounded-full border px-4 py-2 text-sm font-bold', tab === k ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{label}</button>
        ))}
        {/* คั่น — สถานะล็อตแยกกลุ่ม */}
        <span className="mx-1.5 h-7 w-px bg-subtle" />
        <button onClick={() => setTab('status')} className={cx('rounded-full border px-4 py-2 text-sm font-bold', tab === 'status' ? 'border-primary bg-primary text-white' : 'border-[#2563eb]/40 bg-[#2563eb]/[0.1] text-[#60a5fa]')}>Status</button>
      </div>
      {tab === 'products' && <Products />}
      {tab === 'status' && <LotStatus />}
      {tab === 'categories' && <Categories />}
      {tab === 'franchises' && <Franchises />}
      {tab === 'manufacturers' && <Manufacturers />}
      {tab === 'series' && <SeriesTab />}
    </div>
  );
}

// ---- ประเภท (Categories / Type) --------------------------------------------
function Categories() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);

  const reset = () => { setId(null); setName(''); setActive(true); };
  const save = () => {
    if (!name.trim()) return flash('กรอกชื่อประเภท');
    dispatch(upsertCategory({ id: id ?? genId('cat'), name: name.trim(), active }));
    flash(id ? 'บันทึกแล้ว' : 'เพิ่มประเภทแล้ว'); reset();
  };
  const del = (cid: string) => {
    if (db.manufacturers.some((m) => m.category_id === cid)) return flash('ลบไม่ได้ — มีค่ายอยู่ใต้ประเภทนี้');
    dispatch(removeCategory(cid)); flash('ลบประเภทแล้ว'); if (id === cid) reset();
  };
  const toggle = (cid: string) => {
    const c = db.categories.find((x) => x.id === cid);
    if (c) dispatch(upsertCategory({ ...c, active: !c.active }));
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between"><span className="font-bold">{id ? 'แก้ไขประเภท' : 'เพิ่มประเภทใหม่'}</span>{id && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
        <div className="flex flex-col gap-3">
          <Field label="ชื่อประเภท (Type)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น WCF, Resin, Bandai" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> เปิดใช้งาน (โชว์บนหน้าร้าน)</label>
          <Button onClick={save} icon={id ? 'check' : 'plus'}>{id ? 'บันทึก' : 'เพิ่มประเภท'}</Button>
        </div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">ประเภททั้งหมด ({db.categories.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.categories.map((c) => (
            <div key={c.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{c.name}</div><div className="text-[11.5px] text-ink-faint">{db.manufacturers.filter((m) => m.category_id === c.id).length} ค่าย</div></div>
              <button onClick={() => toggle(c.id)} className={cx('rounded-full border px-3 py-1 text-[12px] font-semibold', c.active ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-faint')}>{c.active ? 'เปิด' : 'ปิด'}</button>
              <button onClick={() => { setId(c.id); setName(c.name); setActive(c.active); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
              <button onClick={() => del(c.id)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
            </div>
          ))}
          {db.categories.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีประเภท</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---- ค่าย (Manufacturers) with logo upload ---------------------------------
function Manufacturers() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(db.categories[0]?.id ?? '');
  const [logo, setLogo] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reset = () => { setId(null); setName(''); setCategoryId(db.categories[0]?.id ?? ''); setLogo(undefined); };
  const save = () => {
    if (!name.trim()) return flash('กรอกชื่อค่าย');
    if (!categoryId) return flash('เลือกประเภท (ไปเพิ่มประเภทก่อน)');
    dispatch(upsertManufacturer({ id: id ?? genId('m'), name: name.trim(), category_id: categoryId, logo_url: logo }));
    flash(id ? 'บันทึกค่ายแล้ว' : 'เพิ่มค่ายแล้ว'); reset();
  };
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setLogo(await uploadImage(file, 'maker')); flash('อัปโหลดรูปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const del = (mid: string) => {
    if (db.products.some((p) => p.manufacturer_id === mid)) return flash('ลบไม่ได้ — มีสินค้าใช้ค่ายนี้');
    dispatch(removeManufacturer(mid)); flash('ลบค่ายแล้ว'); if (id === mid) reset();
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between"><span className="font-bold">{id ? 'แก้ไขค่าย' : 'เพิ่มค่ายใหม่'}</span>{id && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="grid h-16 w-16 flex-shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-accent bg-surface-3 text-ink-faint">
              {busy ? <Icon name="box" size={20} className="animate-pulse" /> : logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <Icon name="camera" size={20} />}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <div className="text-[12px] text-ink-faint">Icon ค่าย<br />แตะเพื่ออัปโหลด (ไม่บังคับ)</div>
          </div>
          <Field label="ชื่อค่าย (Manufacturer)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น A+, YZ" /></Field>
          <Field label="ประเภท (Type)">
            {db.categories.length === 0
              ? <div className="text-[12px] text-ink-faint">ยังไม่มีประเภท — ไปเพิ่มที่แท็บ “ประเภท” ก่อน</div>
              : <select className={inputCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{db.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (ปิด)'}</option>)}</select>}
          </Field>
          <Button onClick={save} icon={id ? 'check' : 'plus'} disabled={busy}>{id ? 'บันทึก' : 'เพิ่มค่าย'}</Button>
        </div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">ค่ายทั้งหมด ({db.manufacturers.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.manufacturers.map((m) => (
            <div key={m.id} className="flex items-center gap-3 py-3">
              <div className="grid h-10 w-10 flex-shrink-0 place-items-center overflow-hidden rounded-lg border border-subtle bg-surface-3">
                {m.logo_url ? <img src={m.logo_url} alt="" className="h-full w-full object-cover" /> : <Icon name="store" size={18} className="text-ink-faint" />}
              </div>
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{m.name}</div><div className="text-[11.5px] text-ink-faint">{db.categories.find((c) => c.id === m.category_id)?.name ?? '—'} · {db.products.filter((p) => p.manufacturer_id === m.id).length} สินค้า</div></div>
              <button onClick={() => { setId(m.id); setName(m.name); setCategoryId(m.category_id); setLogo(m.logo_url); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
              <button onClick={() => del(m.id)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
            </div>
          ))}
          {db.manufacturers.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีค่าย</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---- เรื่อง (Franchises) ---------------------------------------------------
function Franchises() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [abbr, setAbbr] = useState('');

  const reset = () => { setId(null); setName(''); setAbbr(''); };
  const save = () => {
    if (!name.trim() || !abbr.trim()) return flash('กรอกชื่อ + ตัวย่อ');
    dispatch(upsertFranchise({ id: id ?? genId('f'), name: name.trim(), abbr: abbr.trim().toLowerCase() }));
    flash(id ? 'บันทึกแล้ว' : 'เพิ่มเรื่องแล้ว'); reset();
  };
  const del = (fid: string) => {
    if (db.series.some((s) => s.franchise_id === fid)) return flash('ลบไม่ได้ — มีซีรีย์ใต้เรื่องนี้');
    if (db.products.some((p) => p.franchise_id === fid)) return flash('ลบไม่ได้ — มีสินค้าใต้เรื่องนี้');
    dispatch(removeFranchise(fid)); flash('ลบเรื่องแล้ว'); if (id === fid) reset();
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between"><span className="font-bold">{id ? 'แก้ไขเรื่อง' : 'เพิ่มเรื่องใหม่'}</span>{id && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
        <div className="flex flex-col gap-3">
          <Field label="ชื่อเรื่อง (Franchise)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น One Piece" /></Field>
          <Field label="ตัวย่อ (abbr) — ใช้ออกเลข Ticket"><input className={inputCls} value={abbr} onChange={(e) => setAbbr(e.target.value)} placeholder="เช่น op" /></Field>
          <Button onClick={save} icon={id ? 'check' : 'plus'}>{id ? 'บันทึก' : 'เพิ่มเรื่อง'}</Button>
        </div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">เรื่องทั้งหมด ({db.franchises.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.franchises.map((f) => (
            <div key={f.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{f.name}</div><div className="font-mono text-[11.5px] text-ink-faint">{f.abbr.toUpperCase()} · {db.series.filter((s) => s.franchise_id === f.id).length} ซีรีย์ · {db.products.filter((p) => p.franchise_id === f.id).length} สินค้า</div></div>
              <button onClick={() => { setId(f.id); setName(f.name); setAbbr(f.abbr); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
              <button onClick={() => del(f.id)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
            </div>
          ))}
          {db.franchises.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีเรื่อง</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---- ซีรีย์ (Series) -------------------------------------------------------
function SeriesTab() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [franchiseId, setFranchiseId] = useState(db.franchises[0]?.id ?? '');
  const [makers, setMakers] = useState<string[]>([]);

  const reset = () => { setId(null); setName(''); setFranchiseId(db.franchises[0]?.id ?? ''); setMakers([]); };
  const toggleMaker = (mid: string) => setMakers((arr) => (arr.includes(mid) ? arr.filter((x) => x !== mid) : [...arr, mid]));
  const save = () => {
    if (!name.trim() || !franchiseId) return flash('กรอกชื่อซีรีย์ + เลือกเรื่อง');
    dispatch(upsertSeries({ id: id ?? genId('s'), name: name.trim(), franchise_id: franchiseId, maker_ids: makers }));
    flash(id ? 'บันทึกแล้ว' : 'เพิ่มซีรีย์แล้ว'); reset();
  };
  const del = (sid: string) => {
    if (db.products.some((p) => p.series_id === sid)) return flash('ลบไม่ได้ — มีสินค้าใช้ซีรีย์นี้');
    dispatch(removeSeries(sid)); flash('ลบซีรีย์แล้ว'); if (id === sid) reset();
  };
  const makerNames = (ids: string[]) => ids.map((i) => db.manufacturers.find((m) => m.id === i)?.name).filter(Boolean).join(', ') || '—';

  if (db.franchises.length === 0) return <Panel><div className="text-[13px] text-ink-faint">ยังไม่มีเรื่อง — ไปเพิ่ม “เรื่อง” ก่อน แล้วค่อยสร้างซีรีย์</div></Panel>;

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between"><span className="font-bold">{id ? 'แก้ไขซีรีย์' : 'เพิ่มซีรีย์ใหม่'}</span>{id && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
        <div className="flex flex-col gap-3">
          <Field label="ชื่อซีรีย์"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น Thriller Park" /></Field>
          <Field label="เรื่อง"><select className={inputCls} value={franchiseId} onChange={(e) => setFranchiseId(e.target.value)}>{db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
          <div>
            <div className="mb-2 text-[12.5px] font-semibold text-ink-muted">ค่ายที่ทำซีรีย์นี้ (ติ๊กได้หลายค่าย)</div>
            <div className="flex flex-wrap gap-2">
              {db.manufacturers.length === 0 && <span className="text-[12px] text-ink-faint">ยังไม่มีค่าย — ไปเพิ่มค่ายก่อน</span>}
              {db.manufacturers.map((m) => {
                const on = makers.includes(m.id);
                return <button key={m.id} onClick={() => toggleMaker(m.id)} className={cx('rounded-full border px-3 py-1.5 text-[12.5px] font-semibold', on ? 'border-accent bg-[#b91c1c]/[0.16] text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>{on && '✓ '}{m.name}</button>;
              })}
            </div>
          </div>
          <Button onClick={save} icon={id ? 'check' : 'plus'}>{id ? 'บันทึก' : 'เพิ่มซีรีย์'}</Button>
        </div>
      </Panel>
      <Panel>
        <div className="mb-3 font-bold">ซีรีย์ทั้งหมด ({db.series.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {db.series.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{s.name}</div><div className="text-[11.5px] text-ink-faint">{db.franchises.find((f) => f.id === s.franchise_id)?.name} · ค่าย: {makerNames(s.maker_ids)}</div></div>
              <button onClick={() => { setId(s.id); setName(s.name); setFranchiseId(s.franchise_id); setMakers(s.maker_ids); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
              <button onClick={() => del(s.id)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
            </div>
          ))}
          {db.series.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีซีรีย์</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---- Status — เลือกค่าย → group ตามสถานะ → เลื่อนสถานะรวม (ปิดใบพรี link closeProduction) ----
const STATUS_GROUPS: ProductStatus[] = ['open', 'production', 'shipping', 'arrived', 'delivered'];

function LotStatus() {
  const db = useDatabase();
  const [makerId, setMakerId] = useState(db.manufacturers[0]?.id ?? '');
  const lots = db.products.filter((p) => p.manufacturer_id === makerId && !p.is_stock && p.status !== 'closed');
  return (
    <div className="max-w-[720px]">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={makerId} onChange={(e) => setMakerId(e.target.value)}>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <span className="text-[12px] text-ink-faint">{lots.length} ล็อต</span>
      </div>
      {lots.length === 0 ? (
        <Panel><div className="py-8 text-center text-ink-faint">ไม่มีล็อตพรีของค่ายนี้</div></Panel>
      ) : (
        STATUS_GROUPS.map((st) => {
          const group = lots.filter((p) => p.status === st);
          if (group.length === 0) return null;
          return (
            <div key={st} className="mb-4">
              <Panel>
                <div className="mb-2.5 flex items-center gap-2 text-[13.5px] font-bold text-ink">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_FILL[st as StatusKey] }} />
                  {STATUS[st as StatusKey].label} <span className="text-ink-faint">({group.length})</span>
                </div>
                <div className="flex flex-col divide-y divide-hair">{group.map((p) => <StatusRow key={p.id} product={p} />)}</div>
              </Panel>
            </div>
          );
        })
      )}
    </div>
  );
}

function StatusRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const ordered = orderedQtyOf(db, p.id);
  const count = db.tickets.filter((t) => t.product_id === p.id).length;
  // สเต็ปเปอร์หยุดที่ "ถึงไทยแล้ว" — ส่งมอบทำรายตั๋วที่หน้า สลิป/ออเดอร์
  const idx = LOT_STEPS.indexOf(p.status);
  const arrivedIdx = LOT_STEPS.indexOf('arrived');
  const next = idx < arrivedIdx ? LOT_STEPS[idx + 1] : null;
  const [open, setOpen] = useState(false);
  const [showBuyers, setShowBuyers] = useState(false);
  const [track, setTrack] = useState(p.tracking_no ?? '');
  const [shippedAt, setShippedAt] = useState(p.shipped_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [finalQty, setFinalQty] = useState(String(ordered));
  const buyers = db.tickets.filter((t) => t.product_id === p.id);
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const ticketUrl = (no: string) => (typeof window !== 'undefined' ? `${window.location.origin}/wallet/${encodeURIComponent(no)}` : no);

  const advance = (extra?: { tracking_no?: string; shipped_at?: string }) => {
    if (!next) return;
    dispatch(setProductStatus(p.id, next, extra));
    flash(`${p.series_name} → ${STATUS[next as StatusKey].label} · ${count} ตั๋ว`);
    setOpen(false);
  };
  // ปิดใบพรี = เปิดจอง → ผลิต ผ่าน closeProduction (โค้ดเดียวกับหน้า ปิดรอบสั่งผลิต)
  const closePre = () => {
    const fq = Number(finalQty) || 0;
    if (fq < ordered) return flash(`สั่งไฟนอลต้อง ≥ ยอดจอง (${ordered})`);
    dispatch(closeProduction([{ productId: p.id, finalQty: fq }]));
    const surplus = Math.max(0, fq - ordered);
    flash(`ปิดใบพรี → ผลิต${surplus > 0 ? ` · เกิน ${surplus} → สต๊อก` : ''}`);
    setOpen(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <button onClick={() => setShowBuyers((o) => !o)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold hover:text-primary-soft">{p.series_name}</span>
            <span className={cx('inline-block text-[10px] text-ink-faint transition-transform', showBuyers && 'rotate-180')}>▾</span>
          </div>
          <div className="text-[11px] text-ink-faint">{franchiseOf(db, p)?.name} · จอง {ordered} ตัว{p.production_qty != null ? ` · สั่ง ${p.production_qty}` : ''}</div>
        </button>
        {p.status === 'open' ? (
          <button onClick={() => setOpen((o) => !o)} className="whitespace-nowrap rounded-lg bg-cta px-3 py-1.5 text-[12.5px] font-bold text-white">ปิดใบพรี →</button>
        ) : !next ? (
          <Link href="/admin/orders" className="whitespace-nowrap rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] px-3 py-1.5 text-[12px] font-bold text-primary-soft">จัดส่งรายตั๋ว →</Link>
        ) : (
          <button onClick={() => (next === 'shipping' ? setOpen((o) => !o) : advance())} className="whitespace-nowrap rounded-lg bg-cta px-3 py-1.5 text-[12.5px] font-bold text-white">→ {STATUS[next as StatusKey].label}</button>
        )}
      </div>

      {open && p.status === 'open' && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-muted">สั่งไฟนอล</span>
          <input value={finalQty} onChange={(e) => setFinalQty(e.target.value)} inputMode="numeric" className={cx(inputCls, 'w-24 py-2 text-center')} />
          <span className="text-[11.5px] text-ink-faint">{Number(finalQty) > ordered ? `เกิน ${Number(finalQty) - ordered} → สต๊อก` : 'ไม่มีส่วนเกิน'}</span>
          <button onClick={closePre} className="ml-auto whitespace-nowrap rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">ยืนยันปิดใบพรี</button>
        </div>
      )}

      {open && p.status !== 'open' && next === 'shipping' && (
        <div className="mt-2 flex gap-2">
          <input value={track} onChange={(e) => setTrack(e.target.value)} placeholder="เลข Track จีน→ไทย" className={cx(inputCls, 'py-2')} />
          <input type="date" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} className={cx(inputCls, 'w-[150px] py-2')} />
          <button onClick={() => (track.trim() ? advance({ tracking_no: track.trim(), shipped_at: shippedAt }) : flash('ใส่เลข Track ก่อน'))} className="whitespace-nowrap rounded-lg bg-cta px-4 text-[12.5px] font-bold text-white">ยืนยัน</button>
        </div>
      )}

      {/* dropdown รายชื่อลูกค้าที่พรีล็อตนี้ */}
      {showBuyers && (
        <div className="mt-2 rounded-lg border border-subtle bg-surface-3 p-2">
          {buyers.length === 0 ? (
            <div className="py-2 text-center text-[12px] text-ink-faint">ยังไม่มีลูกค้าพรีล็อตนี้</div>
          ) : (
            <div className="flex flex-col divide-y divide-hair">
              {buyers.map((t) => (
                <Link key={t.id} href={`/wallet/${encodeURIComponent(t.ticket_no)}`} className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-white/[0.03]">
                  <TicketQr value={ticketUrl(t.ticket_no)} size={40} pad={5} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{userName(t.owner_id)}</div>
                    <div className="text-[11px] text-ink-faint">{new Date(t.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })} · <span className="font-mono">{t.ticket_no}</span></div>
                  </div>
                  <span className="whitespace-nowrap text-[11px] font-bold text-primary-soft">ดูตั๋ว →</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- สินค้า (Products) — cascade เรื่อง → ค่าย → ซีรีย์ ----------------------
interface Draft {
  id?: string;
  franchise_id: string;
  manufacturer_id: string;
  series_id: string;
  series_name: string;
  wcf_type: WcfType;
  cost_yuan: string;
  description: string;
  eta_note: string;
  price_total: string;
  deposit_amount: string;
  is_stock: boolean;
  stock_qty: string;
  status: ProductStatus;
  tracking_no: string;
  shipped_at: string;
  images: string[];
}
const emptyDraft = (fid: string, mid: string, deposit: number): Draft => ({
  franchise_id: fid, manufacturer_id: mid, series_id: '', series_name: '', wcf_type: 'wcf', cost_yuan: '', description: '', eta_note: '', price_total: '', deposit_amount: String(deposit), is_stock: false, stock_qty: '', status: 'open', tracking_no: '', shipped_at: '', images: [],
});

function Products() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const st = db.settings;
  const fresh = () => emptyDraft(db.franchises[0]?.id ?? '', db.manufacturers[0]?.id ?? '', depositFor(st, 'wcf'));
  const [draft, setDraft] = useState<Draft>(fresh);
  const [imgBusy, setImgBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const editing = Boolean(draft.id);
  // WCF/Mega → auto deposit ; yuan cost → auto selling price
  const setWcfType = (t: WcfType) => setDraft((d) => ({ ...d, wcf_type: t, deposit_amount: String(depositFor(st, t)) }));
  const setYuan = (v: string) => setDraft((d) => ({ ...d, cost_yuan: v, price_total: v ? String(priceFromYuan(st, Number(v) || 0)) : d.price_total }));
  const addImage = async (file?: File) => {
    if (!file) return;
    setImgBusy(true);
    try { const url = await uploadImage(await applyWatermark(file), 'product'); setDraft((d) => ({ ...d, images: [...d.images, url] })); flash('เพิ่มรูป + ลายน้ำแล้ว'); }
    catch { flash('อัปโหลดรูปไม่สำเร็จ'); }
    finally { setImgBusy(false); }
  };
  const reset = () => setDraft(fresh());

  const seriesOptions = seriesForFranchise(db, draft.franchise_id, draft.manufacturer_id);

  const save = () => {
    if (!draft.franchise_id || !draft.manufacturer_id) return flash('เลือกเรื่อง + ค่าย');
    if (!draft.series_name.trim()) return flash('กรอกชื่อสินค้า');
    const price = Number(draft.price_total) || 0;
    if (price <= 0) return flash('กรอกราคาเต็ม');
    const existing = draft.id ? db.products.find((p) => p.id === draft.id) : undefined;
    const product: Product = {
      id: draft.id ?? genId('p'),
      franchise_id: draft.franchise_id,
      manufacturer_id: draft.manufacturer_id,
      series_id: draft.series_id || undefined,
      series_name: draft.series_name.trim(),
      wcf_type: draft.wcf_type,
      cost_yuan: draft.cost_yuan ? Number(draft.cost_yuan) : undefined,
      type: 'other',
      description: draft.description.trim(),
      images: draft.images,
      eta_note: draft.eta_note.trim() || (draft.is_stock ? 'พร้อมส่ง' : 'TBA'),
      price_total: price,
      deposit_amount: draft.is_stock ? price : (Number(draft.deposit_amount) || 0),
      is_stock: draft.is_stock,
      stock_qty: draft.is_stock ? Number(draft.stock_qty) || 0 : undefined,
      has_variants: false,
      status: draft.status,
      tracking_no: draft.tracking_no.trim() || undefined,
      shipped_at: draft.shipped_at || undefined,
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    dispatch(upsertProduct(product));
    // cascade the lifecycle status to this product's tickets (customer wallet tracking)
    dispatch(setProductStatus(product.id, product.status));
    flash(editing ? 'บันทึกสินค้าแล้ว' : 'เพิ่มสินค้าแล้ว'); reset();
  };

  const edit = (p: Product) => setDraft({
    id: p.id, franchise_id: p.franchise_id, manufacturer_id: p.manufacturer_id, series_id: p.series_id ?? '',
    series_name: p.series_name, wcf_type: p.wcf_type ?? 'wcf', cost_yuan: p.cost_yuan != null ? String(p.cost_yuan) : '',
    description: p.description, eta_note: p.eta_note,
    price_total: String(p.price_total), deposit_amount: String(p.deposit_amount),
    is_stock: p.is_stock, stock_qty: p.stock_qty != null ? String(p.stock_qty) : '', status: p.status,
    tracking_no: p.tracking_no ?? '', shipped_at: p.shipped_at ? p.shipped_at.slice(0, 10) : '', images: p.images ?? [],
  });

  const del = (p: Product) => {
    if (db.tickets.some((t) => t.product_id === p.id) || db.orders.some((o) => o.items.some((i) => i.product_id === p.id))) return flash('ลบไม่ได้ — มีใบพรี/ออเดอร์อ้างอิง');
    dispatch(removeProduct(p.id)); flash('ลบสินค้าแล้ว'); if (draft.id === p.id) reset();
  };

  const ready = db.franchises.length > 0 && db.manufacturers.length > 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[400px_1fr] lg:items-start">
      <Panel>
        <div className="mb-3 flex items-center justify-between"><span className="font-bold">{editing ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</span>{editing && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
        {!ready ? (
          <div className="text-[13px] text-ink-faint">ต้องมี “เรื่อง” และ “ค่าย” อย่างน้อยอย่างละ 1 ก่อน — ไปเพิ่มที่แท็บเรื่อง/ค่าย</div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="1. เรื่อง"><select className={inputCls} value={draft.franchise_id} onChange={(e) => setDraft((d) => ({ ...d, franchise_id: e.target.value, series_id: '' }))}>{db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
              <Field label="2. ค่าย"><select className={inputCls} value={draft.manufacturer_id} onChange={(e) => setDraft((d) => ({ ...d, manufacturer_id: e.target.value, series_id: '' }))}>{db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
            </div>
            <Field label="3. ซีรีย์ (ถ้ามี)">
              <select className={inputCls} value={draft.series_id} onChange={(e) => set('series_id', e.target.value)}>
                <option value="">— ไม่มี —</option>
                {seriesOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="mt-1 block text-[11px] text-ink-faint">เฉพาะซีรีย์ที่ค่ายนี้ทำ ({seriesOptions.length})</span>
            </Field>
            <Field label="ชื่อสินค้า"><input className={inputCls} value={draft.series_name} onChange={(e) => set('series_name', e.target.value)} placeholder="เช่น Luffy — Thriller Park" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ชนิด (มัดจำ)">
                <select className={inputCls} value={draft.wcf_type} onChange={(e) => setWcfType(e.target.value as WcfType)}>
                  <option value="wcf">WCF (มัดจำ {baht(st.deposit_wcf)})</option>
                  <option value="mega_wcf">Mega WCF (มัดจำ {baht(st.deposit_mega)})</option>
                </select>
              </Field>
              <Field label="ต้นทุน (หยวน) — คิดราคาให้">
                <input className={inputCls} inputMode="numeric" value={draft.cost_yuan} onChange={(e) => setYuan(e.target.value)} placeholder="เช่น 328" />
                {draft.cost_yuan && <span className="mt-1 block text-[11px] text-primary-soft">= {baht(priceFromYuan(st, Number(draft.cost_yuan) || 0))}</span>}
              </Field>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] font-semibold text-ink-muted">รูปสินค้า</div>
              <div className="flex flex-wrap gap-2">
                {draft.images.map((img, i) => (
                  <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-subtle">
                    <img src={img} alt="" className="h-full w-full object-cover" />
                    <button onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))} className="absolute right-0 top-0 grid h-5 w-5 place-items-center bg-black/60 text-white"><Icon name="x" size={12} /></button>
                  </div>
                ))}
                <label className="grid h-16 w-16 cursor-pointer place-items-center rounded-lg border border-dashed border-accent bg-surface-3 text-ink-faint">
                  {imgBusy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => addImage(e.target.files?.[0])} />
                </label>
              </div>
            </div>
            <Field label="สถานะ"><select className={inputCls} value={draft.status} onChange={(e) => set('status', e.target.value as ProductStatus)}>{STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select></Field>
            {draft.status === 'shipping' && (
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-[#2563eb]/30 bg-[#2563eb]/[0.06] p-3">
                <Field label="เลข Tracking"><input className={inputCls} value={draft.tracking_no} onChange={(e) => set('tracking_no', e.target.value)} placeholder="เช่น SF123..." /></Field>
                <Field label="วันที่ออกจากจีน (คิด ETA)"><input type="date" className={inputCls} value={draft.shipped_at} onChange={(e) => set('shipped_at', e.target.value)} /></Field>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.is_stock} onChange={(e) => set('is_stock', e.target.checked)} /> สินค้าพร้อมส่ง (in-stock)</label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ราคาเต็ม (฿)"><input className={inputCls} inputMode="numeric" value={draft.price_total} onChange={(e) => set('price_total', e.target.value)} placeholder="1290" /></Field>
              {draft.is_stock
                ? <Field label="จำนวนสต็อก"><input className={inputCls} inputMode="numeric" value={draft.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} placeholder="5" /></Field>
                : <Field label="มัดจำ (฿)"><input className={inputCls} inputMode="numeric" value={draft.deposit_amount} onChange={(e) => set('deposit_amount', e.target.value)} placeholder="590" /></Field>}
            </div>
            <Field label="กำหนดการ (ETA)"><input className={inputCls} value={draft.eta_note} onChange={(e) => set('eta_note', e.target.value)} placeholder="เช่น Q3 2026" /></Field>
            <Field label="รายละเอียด"><textarea className={cx(inputCls, 'h-20 resize-none')} value={draft.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <Button onClick={save} icon={editing ? 'check' : 'plus'}>{editing ? 'บันทึก' : 'เพิ่มสินค้า'}</Button>
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
                <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · {manufacturerOf(db, p)?.name} · {categoryOf(db, p)?.name ?? '—'} · {baht(p.price_total)}</div>
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
