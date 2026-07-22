'use client';

import { useState, useEffect } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { applyWatermark } from '@/lib/watermark';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { seriesForFranchise } from '@/domain/services/catalog';
import { genId, bulkCreateStock } from '@/data/mutations';
import { sendPush, subsForNewProduct, pushEnabled } from '@/lib/push';
import { StockCondPicker } from '@/components/StockCond';
import { NEW_STOCK_COND } from '@/domain/entities';
import type { Product, StockCond } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent';
const DRAFT_KEY = 'ryuma_stock_bulk_draft';

interface Row { key: string; image?: string; name: string; series_id: string; height: string; price: string; stock: string }
interface Shared { manufacturer_id: string; franchise_id: string; cond?: StockCond }

/** Bulk add IN-STOCK (พร้อมส่ง) products. Shared ค่าย/เรื่อง; per-row image/name/series/สูง/ราคา/สต๊อก.
 *  Rows come from uploading images OR pulling from an existing product (reuse ชื่อ/รูป/สูง/ซีรีย์). */
export function StockBulkAdd({ onDone }: { onDone: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const [sd, setSd] = useState<Shared>(() => {
    if (typeof window !== 'undefined') { try { const s = sessionStorage.getItem(DRAFT_KEY); if (s) return JSON.parse(s).sd; } catch { /* */ } }
    return { manufacturer_id: db.manufacturers[0]?.id ?? '', franchise_id: db.franchises[0]?.id ?? '' };
  });
  const [rows, setRows] = useState<Row[]>(() => {
    if (typeof window !== 'undefined') { try { const s = sessionStorage.getItem(DRAFT_KEY); if (s) return JSON.parse(s).rows ?? []; } catch { /* */ } }
    return [];
  });
  const [uploading, setUploading] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickQ, setPickQ] = useState('');

  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ sd, rows })); } catch { /* */ } }, [sd, rows]);
  useEffect(() => {
    setSd((d) => {
      const m = db.manufacturers.some((x) => x.id === d.manufacturer_id) ? d.manufacturer_id : (db.manufacturers[0]?.id ?? '');
      const f = db.franchises.some((x) => x.id === d.franchise_id) ? d.franchise_id : (db.franchises[0]?.id ?? '');
      return m === d.manufacturer_id && f === d.franchise_id ? d : { ...d, manufacturer_id: m, franchise_id: f };
    });
  }, [db.manufacturers, db.franchises]);

  const seriesOpts = seriesForFranchise(db, sd.franchise_id, sd.manufacturer_id);
  const seriesName = (sid: string) => seriesOpts.find((s) => s.id === sid)?.name;

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const addImages = async (files?: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    const urls = await Promise.all([...files].map(async (f) => { try { return await uploadImage(await applyWatermark(f), 'product'); } catch { return undefined; } }));
    setRows((rs) => [...rs, ...urls.map((image) => ({ key: genId('sr'), image, name: '', series_id: rs[rs.length - 1]?.series_id ?? '', height: '', price: '', stock: '' }))]);
    setUploading(false);
    flash(`เพิ่ม ${urls.filter(Boolean).length} รูป`);
  };

  // pull an existing product (any lifecycle) → prefill a stock row with its ชื่อ/รูป/สูง/ซีรีย์ + suggested price
  const pull = (p: Product) => {
    setRows((rs) => [...rs, {
      key: genId('sr'), image: p.images?.[0], name: p.character_name ?? p.series_name, series_id: p.series_id ?? '',
      height: p.height_cm != null ? String(p.height_cm) : '', price: String(p.price_total), stock: '',
    }]);
    flash(`ดึง "${p.series_name}" มาแล้ว — ใส่สต๊อก`);
  };

  const rowValid = (r: Row) => r.name.trim().length > 0 && Number(r.price) > 0 && Number(r.stock) > 0 && r.height.trim().length > 0;
  const validRows = rows.filter(rowValid);

  const create = () => {
    if (!sd.manufacturer_id || !sd.franchise_id) return flash('เลือกค่าย + เรื่องก่อน');
    if (validRows.length === 0) return flash('ยังไม่มีแถวที่ครบ (ชื่อ + ราคา + สต๊อก + สูง)');
    const products: Product[] = validRows.map((r) => {
      const character = r.name.trim();
      const sn = seriesName(r.series_id);
      const price = Number(r.price) || 0;
      return {
        id: genId('p'), franchise_id: sd.franchise_id, manufacturer_id: sd.manufacturer_id,
        series_id: r.series_id || undefined, series_name: sn ? `${character} - ${sn}` : character, character_name: character || undefined,
        type: 'other', description: '', images: r.image ? [r.image] : [], eta_note: 'พร้อมส่ง',
        price_total: price, deposit_amount: price, // in-stock = pay in full
        is_stock: true, stock_qty: Number(r.stock) || 0,
        height_cm: r.height ? Number(r.height) : undefined,
        has_variants: false, status: 'open', created_at: new Date().toISOString(),
        stock_cond: sd.cond ?? NEW_STOCK_COND, // สภาพจากค่าเริ่มต้นร่วม (default มือ 1 ครบ)
      };
    });
    dispatch(bulkCreateStock(products));
    // push แจ้งลูกค้าตามตัวกรองค่าย/เรื่อง — ทั้งชุด maker/เรื่องเดียวกัน ยิงสรุป 1 ครั้ง.
    // DNA: ห้ามบอกจำนวน/สต๊อก — ใส่แค่ชื่อ + ราคา (ryuma-dna-push-noqty). gate = 'new_instock'.
    if (pushEnabled(db, 'new_instock')) {
      const names = products.map((p) => `${p.series_name} ${baht(p.price_total)}`);
      const body = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` และอีก ${names.length - 3} รายการ` : '');
      sendPush(subsForNewProduct(db, { manufacturer_id: sd.manufacturer_id, franchise_id: sd.franchise_id }),
        { title: products.length > 1 ? `🟢 สินค้าพร้อมส่งเข้าใหม่ ${products.length} รายการ!` : '🟢 สินค้าพร้อมส่งเข้าใหม่!', body: `${body} — แตะดูเลย`, url: '/shop?cat=instock' }, dispatch).catch(() => {});
    }
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* */ }
    flash(`สร้างสินค้าพร้อมส่ง ${products.length} รายการ 🎉 · แจ้งลูกค้าแล้ว`);
    setRows([]);
  };

  const maker = db.manufacturers.find((m) => m.id === sd.manufacturer_id);
  const pickList = db.products
    .filter((p) => p.manufacturer_id === sd.manufacturer_id && (!pickQ.trim() || `${p.series_name} ${p.character_name ?? ''}`.toLowerCase().includes(pickQ.trim().toLowerCase())))
    .slice(0, 60);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <span className="text-xl font-extrabold">เพิ่มสินค้าพร้อมส่ง (In-Stock)</span>
        <button onClick={onDone} className="ml-auto rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">← กลับ</button>
      </div>

      <div className="mb-4 rounded-2xl border border-subtle bg-surface-2 p-4">
        <div className="mb-2.5 text-[12px] text-ink-muted">ค่าเริ่มต้นร่วม — ซีรีย์ตั้งแยกรายแถว</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <select className={inputCls} value={sd.manufacturer_id} onChange={(e) => setSd((d) => ({ ...d, manufacturer_id: e.target.value }))}>{db.manufacturers.map((m) => <option key={m.id} value={m.id}>ค่าย · {m.name}</option>)}</select>
          <select className={inputCls} value={sd.franchise_id} onChange={(e) => setSd((d) => ({ ...d, franchise_id: e.target.value }))}>{db.franchises.map((f) => <option key={f.id} value={f.id}>เรื่อง · {f.name}</option>)}</select>
        </div>
        {/* สภาพสินค้า (ใช้กับทุกแถวที่สร้างรอบนี้ — แก้รายตัวได้ทีหลังในแท็บจัดการสต๊อก) */}
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] font-semibold text-ink-faint">สภาพสินค้า (ใช้ทั้งชุดนี้) · มือ 2 = ลูกค้าเห็นนโยบายชดเชยแตกหัก 250฿ อัตโนมัติ</div>
          <StockCondPicker value={sd.cond ?? NEW_STOCK_COND} onChange={(cond) => setSd((d) => ({ ...d, cond }))} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">
            <Icon name={uploading ? 'box' : 'camera'} size={16} className={uploading ? 'animate-pulse' : ''} /> {uploading ? 'กำลังอัปโหลด…' : 'เลือกรูปหลายรูป'}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploading} onChange={(e) => addImages(e.target.files)} />
          </label>
          <button onClick={() => setPickOpen((o) => !o)} className="rounded-lg border border-subtle bg-surface-3 px-4 py-2 text-[13px] font-bold text-ink-muted2"><Icon name="copy" size={15} className="mr-1 inline align-[-2px]" /> ดึงจากสินค้าเดิม</button>
        </div>

        {pickOpen && (
          <div className="mt-3 rounded-xl border border-subtle bg-surface-3 p-2">
            <input value={pickQ} onChange={(e) => setPickQ(e.target.value)} placeholder="ค้นหาสินค้าของค่ายนี้…" className={cx(inputCls, 'mb-2')} />
            <div className="flex max-h-[240px] flex-col divide-y divide-hair overflow-y-auto">
              {pickList.length === 0 ? <div className="py-4 text-center text-[12px] text-ink-faint">ไม่พบสินค้าของค่ายนี้</div> : pickList.map((p) => (
                <button key={p.id} onClick={() => pull(p)} className="flex items-center gap-2.5 py-2 text-left hover:bg-white/[0.03]">
                  <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={15} className="text-primary-soft/25" />}</div>
                  <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{p.series_name}</div><div className="text-[10.5px] text-ink-faint">{baht(p.price_total)}{p.is_stock ? ' · พร้อมส่ง' : ' · พรี'}</div></div>
                  <span className="text-[11px] font-bold text-primary-soft">+ ดึง</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mb-1 grid grid-cols-[36px_1fr_100px_60px_84px_74px_24px] gap-2 px-1 text-[11px] text-ink-muted">
        <span></span><span>ชื่อ</span><span>ซีรีย์</span><span className="text-center">สูง*</span><span className="text-center">ราคา ฿*</span><span className="text-center">สต๊อก*</span><span></span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-subtle py-12 text-center text-[13px] text-ink-faint">ยังไม่มีแถว — “เลือกรูป” หรือ “ดึงจากสินค้าเดิม” ด้านบน</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const ok = rowValid(r);
            return (
              <div key={r.key} className={cx('grid grid-cols-[36px_1fr_100px_60px_84px_74px_24px] items-center gap-2 rounded-xl border bg-surface-2 p-2', ok ? 'border-subtle' : 'border-[#f87171]/40')}>
                <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-stripe">{r.image ? <img src={r.image} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={16} className="text-primary-soft/25" />}</div>
                <div className="min-w-0">
                  <input className={inputCls} value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="ชื่อสินค้า" />
                  <div className="mt-0.5 truncate text-[10px] text-ink-faint">{r.name.trim() ? `${r.name.trim()}${seriesName(r.series_id) ? ` - ${seriesName(r.series_id)}` : ''}` : '—'}</div>
                </div>
                <select className={inputCls} value={r.series_id} onChange={(e) => set(r.key, { series_id: e.target.value })}><option value="">ซีรีย์…</option>{seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                <input className={cx(inputCls, 'text-center')} inputMode="decimal" value={r.height} onChange={(e) => set(r.key, { height: e.target.value.replace(/[^\d.]/g, '') })} placeholder="ซม." />
                <input className={cx(inputCls, 'text-center')} inputMode="numeric" value={r.price} onChange={(e) => set(r.key, { price: e.target.value.replace(/[^\d]/g, '') })} placeholder="฿" />
                <input className={cx(inputCls, 'text-center')} inputMode="numeric" value={r.stock} onChange={(e) => set(r.key, { stock: e.target.value.replace(/[^\d]/g, '') })} placeholder="จำนวน" />
                <button onClick={() => removeRow(r.key)} aria-label="ลบ" className="grid h-7 w-7 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171]"><Icon name="x" size={13} /></button>
              </div>
            );
          })}
        </div>
      )}

      <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-subtle bg-surface-2/95 p-3 backdrop-blur">
        <span className="text-[13px] text-ink-muted">พร้อมสร้าง <b className="text-ink">{validRows.length}</b>{rows.length > validRows.length ? ` · ยังไม่ครบ ${rows.length - validRows.length}` : ''} · {maker?.name}</span>
        <button onClick={create} disabled={validRows.length === 0} className="ml-auto rounded-lg bg-cta px-6 py-2.5 text-[13px] font-bold text-white disabled:opacity-50">สร้างทั้งหมด ({validRows.length})</button>
      </div>
    </div>
  );
}
