'use client';

import { useState, useEffect } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { applyWatermark } from '@/lib/watermark';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { seriesForFranchise, makersForFranchise } from '@/domain/services/catalog';
import { depositFor } from '@/domain/services/pricing';
import { genId, bulkCreateStockRounds } from '@/data/mutations';
import { readStore, writeStore, removeStore } from '@/lib/safeStorage';
import { store } from '@/data/store';
import type { WcfType } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent';
const DRAFT_KEY = 'ryuma_bulk_sku_draft';

interface Row { key: string; image?: string; name: string; series_id: string; height: string; price: string; dep: string; qty: string; sel: boolean }
interface Shared {
  manufacturer_id: string; franchise_id: string; wcf_type: WcfType;
  fullPay: boolean; startStatus: 'production' | 'shipping'; label: string;
}

/**
 * สร้าง SKU ใหม่ + เปิดรอบพิเศษ ทีละหลายรายการ (เจ้าของ 2026-07-26) —
 * ระบบเดียวกับ "เพิ่มสินค้าหลายรายการ" ของ Pre-Order: เลือกรูปหลายรูป → 1 รูป = 1 สินค้า
 * ค่าเริ่มต้นร่วม (เรื่อง/ค่าย/ชนิด/จุดเริ่ม flow/ร่างหรือเปิดขาย) ตั้งครั้งเดียว
 * ราคา-มัดจำ-จำนวน ตั้งรายแถว แล้วสร้างรวดเดียว
 */
export function BulkNewSku({ onDone }: { onDone: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const st = db.settings;

  const [sd, setSd] = useState<Shared>(() => {
    const s = readStore('session', DRAFT_KEY);
    if (s) { try { return JSON.parse(s).sd as Shared; } catch { /* ร่างเสีย — เริ่มใหม่ */ } }
    return {
      manufacturer_id: db.manufacturers[0]?.id ?? '', franchise_id: db.franchises[0]?.id ?? '',
      wcf_type: 'wcf', fullPay: false, startStatus: 'shipping', label: '',
    };
  });
  const [rows, setRows] = useState<Row[]>(() => {
    const s = readStore('session', DRAFT_KEY);
    if (s) { try { return (JSON.parse(s).rows ?? []) as Row[]; } catch { /* */ } }
    return [];
  });
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assign, setAssign] = useState('');
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => { writeStore('session', DRAFT_KEY, JSON.stringify({ sd, rows })); }, [sd, rows]);
  // ให้ id ที่เลือกไว้ยังใช้ได้เสมอเมื่อข้อมูลจริงโหลดมา (ค่ายต้องอยู่ในเรื่องนั้น)
  useEffect(() => {
    setSd((d) => {
      const f = db.franchises.some((x) => x.id === d.franchise_id) ? d.franchise_id : (db.franchises[0]?.id ?? '');
      const makers = makersForFranchise(db, f);
      const m = makers.some((x) => x.id === d.manufacturer_id) ? d.manufacturer_id : (makers[0]?.id ?? '');
      return m === d.manufacturer_id && f === d.franchise_id ? d : { ...d, manufacturer_id: m, franchise_id: f };
    });
  }, [db.manufacturers, db.franchises]);

  const makerOpts = makersForFranchise(db, sd.franchise_id);
  const seriesOpts = seriesForFranchise(db, sd.franchise_id, sd.manufacturer_id);
  const seriesName = (sid: string) => seriesOpts.find((s) => s.id === sid)?.name;
  const rateDep = depositFor(st, sd.wcf_type);

  const freshRow = (image: string | undefined, prev: Row[], name = ''): Row => ({
    key: genId('r'), image, name,
    series_id: prev[prev.length - 1]?.series_id ?? '',
    height: prev[prev.length - 1]?.height ?? '',
    price: prev[prev.length - 1]?.price ?? '',      // ราคาเดิมติดมาให้ (ล็อตเดียวกันมักราคาเท่ากัน)
    dep: prev[prev.length - 1]?.dep ?? '',
    qty: prev[prev.length - 1]?.qty ?? '1',
    sel: false,
  });

  const addImages = async (files?: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    const items = await Promise.all([...files].map(async (f) => {
      const name = f.name.replace(/\.[^.]+$/, '').trim();
      try { return { url: await uploadImage(await applyWatermark(f), 'product'), name }; }
      catch { return { url: undefined, name }; }
    }));
    setRows((rs) => { let acc = rs; for (const it of items) acc = [...acc, freshRow(it.url, acc, it.name)]; return acc; });
    setUploading(false);
    const okN = items.filter((i) => i.url).length;
    flash(okN === items.length ? `เพิ่ม ${okN} รูป` : `เพิ่ม ${items.length} แถว · อัปโหลดรูปสำเร็จ ${okN} (แถวที่ไม่มีรูปยังสร้างได้)`);
  };

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));
  const dup = (key: string) => setRows((rs) => {
    const i = rs.findIndex((r) => r.key === key); if (i < 0) return rs;
    return [...rs.slice(0, i + 1), { ...rs[i], key: genId('r'), sel: false }, ...rs.slice(i + 1)];
  });

  const selCount = rows.filter((r) => r.sel).length;
  const applySel = (patch: Partial<Row>, msg: string) => { setRows((rs) => rs.map((r) => (r.sel ? { ...r, ...patch, sel: false } : r))); flash(msg); };

  // มัดจำต้องน้อยกว่าราคา (ไม่งั้นสลับไปโหมดจ่ายเต็ม) — กติกาเดียวกับฟอร์มทีละตัว
  const rowValid = (r: Row) => {
    const price = Number(r.price) || 0, qty = Number(r.qty) || 0, dep = Number(r.dep) || 0;
    if (!r.name.trim() || price <= 0 || qty <= 0) return false;
    if (!sd.fullPay && dep > 0 && dep >= price) return false;
    return true;
  };
  const validRows = rows.filter(rowValid);
  const badDep = rows.filter((r) => !sd.fullPay && (Number(r.dep) || 0) > 0 && (Number(r.dep) || 0) >= (Number(r.price) || 0));

  const create = async () => {
    if (busy) return;
    if (!sd.manufacturer_id || !sd.franchise_id) return flash('เลือกค่าย + เรื่องก่อน');
    if (validRows.length === 0) return flash('ยังไม่มีแถวที่กรอกครบ (ต้องมี ชื่อ + ราคา + จำนวน)');
    const n = validRows.length;
    const pieces = validRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    if (!confirm(`สร้าง ${n} สินค้า (รวม ${pieces} ชิ้น)\n\nทุกตัวจะเป็น "ร่าง" — ยังไม่ขึ้นหน้าร้าน ไม่มีการแจ้งลูกค้า\nกดปุ่ม "เปิดขาย" ที่การ์ดรอบทีละตัวเมื่อพร้อม`)) return;
    setBusy(true);
    const items = validRows.map((r) => {
      const character = r.name.trim();
      const sn = seriesName(r.series_id);
      const depNum = Number(r.dep) || 0;
      return {
        franchise_id: sd.franchise_id, manufacturer_id: sd.manufacturer_id,
        series_id: r.series_id || undefined, character_name: character,
        series_name: sn ? `${character} - ${sn}` : character,
        height_cm: r.height ? Number(r.height) : undefined, wcf_type: sd.wcf_type,
        images: r.image ? [r.image] : [],
        qty: Number(r.qty) || 0, price: Number(r.price) || 0, fullPay: sd.fullPay,
        label: sd.label.trim() || undefined,
        deposit: depNum > 0 ? depNum : undefined,
        // v58 (เจ้าของ 2026-07-26): สร้างแบบชุดต้องเป็น "ร่าง" เสมอ ห้ามปล่อยขายทันที
        // — ของเข้าหน้าร้านได้ต่อเมื่อแอดมินกด "เปิดขาย" ที่การ์ดรอบทีละตัวเท่านั้น
        startStatus: sd.startStatus, published: false,
      };
    });
    const before = db.products.length;
    dispatch(bulkCreateStockRounds(items));
    // อ่านกลับ + รอเซฟจริงก่อนล้างร่าง/ยิง push — ถ้าเซฟไม่ผ่าน ร่างต้องอยู่ครบให้กดใหม่ได้
    let made = 0;
    dispatch((d) => { made = d.products.length - before; return d; });
    if (made === 0) { setBusy(false); return flash('สร้างไม่สำเร็จ — ตรวจข้อมูลแล้วลองใหม่'); }
    flash(`กำลังบันทึก ${made} สินค้า…`);
    const failed = await store.flush();
    setBusy(false);
    if (failed) return flash('บันทึกไม่สำเร็จ — ร่างยังอยู่ครบ เช็คเน็ตแล้วกดสร้างใหม่อีกครั้ง');
    removeStore('session', DRAFT_KEY);
    setRows([]);
    // ไม่ยิง push ที่นี่เลย — ของยังเป็นร่าง ยังไม่มีอะไรให้ลูกค้าดู
    // push "เปิดพรีรอบพิเศษ" จะยิงตอนแอดมินกด "เปิดขาย" ที่การ์ดรอบ (publishBatch) เท่านั้น
    flash(`สร้าง ${made} สินค้าแล้ว 📝 เป็นร่างทั้งหมด — กด "เปิดขาย" ที่การ์ดรอบเมื่อพร้อม`);
  };

  return (
    <div className="mb-6 rounded-2xl border border-[#8b5cf6]/40 bg-surface-2 p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-base font-extrabold text-[#c4b5fd]">สร้าง SKU ใหม่ · หลายรายการ</span>
        <button onClick={onDone} className="ml-auto rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">← ทีละตัว</button>
      </div>

      {/* ค่าเริ่มต้นร่วม */}
      <div className="mb-4 rounded-xl border border-subtle bg-surface-3/40 p-3.5">
        <div className="mb-2 text-[12px] text-ink-muted">ค่าเริ่มต้นร่วม — ซีรีย์/ราคา/มัดจำ/จำนวน ตั้งแยกรายแถวด้านล่าง</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select className={inputCls} value={sd.franchise_id} onChange={(e) => setSd((d) => {
            const fid = e.target.value;
            const makers = makersForFranchise(db, fid);
            return { ...d, franchise_id: fid, manufacturer_id: makers.some((m) => m.id === d.manufacturer_id) ? d.manufacturer_id : (makers[0]?.id ?? '') };
          })}>{db.franchises.map((f) => <option key={f.id} value={f.id}>เรื่อง · {f.name}</option>)}</select>
          <select className={inputCls} value={sd.manufacturer_id} onChange={(e) => setSd((d) => ({ ...d, manufacturer_id: e.target.value }))}>
            {makerOpts.map((m) => <option key={m.id} value={m.id}>ค่าย · {m.name}</option>)}
          </select>
          <select className={inputCls} value={sd.wcf_type} onChange={(e) => setSd((d) => ({ ...d, wcf_type: e.target.value as WcfType }))}>
            <option value="wcf">ชนิด · WCF (มัดจำ {baht(st.deposit_wcf)})</option>
            <option value="mega_wcf">ชนิด · Mega (มัดจำ {baht(st.deposit_mega)})</option>
          </select>
          <input className={inputCls} value={sd.label} onChange={(e) => setSd((d) => ({ ...d, label: e.target.value }))} placeholder="ชื่อล็อต (ไม่บังคับ) เช่น รอบพิเศษ" />
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Chip on={sd.fullPay} onClick={() => setSd((d) => ({ ...d, fullPay: true }))}>เก็บเต็มจำนวน (ของอยู่ในมือ)</Chip>
          <Chip on={!sd.fullPay} onClick={() => setSd((d) => ({ ...d, fullPay: false }))}>เก็บมัดจำ ฿{rateDep}</Chip>
          {!sd.fullPay && <>
            <span className="mx-1 text-ink-faint">|</span>
            <Chip on={sd.startStatus === 'production'} onClick={() => setSd((d) => ({ ...d, startStatus: 'production' }))}>เริ่ม: ผลิต (รอโกดัง)</Chip>
            <Chip on={sd.startStatus === 'shipping'} onClick={() => setSd((d) => ({ ...d, startStatus: 'shipping' }))}>เริ่ม: เดินทางแล้ว</Chip>
          </>}
          <span className="ml-auto rounded-lg border border-[#d97706]/60 bg-[#d97706]/15 px-2.5 py-1.5 text-[12px] font-bold text-[#fbbf24]">
            📝 สร้างเป็น “ร่าง” เสมอ — กดเปิดขายทีละตัวทีหลัง
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">
            <Icon name={uploading ? 'box' : 'camera'} size={16} className={uploading ? 'animate-pulse' : ''} /> {uploading ? 'กำลังอัปโหลด…' : 'เลือกรูปหลายรูป'}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploading} onChange={(e) => addImages(e.target.files)} />
          </label>
          {/* ต้องเพิ่มแถวได้แม้ไม่มีรูป — ของบางล็อตยังไม่มีภาพ ห้ามบล็อกงานไว้ที่รูป */}
          <button onClick={() => setRows((rs) => [...rs, freshRow(undefined, rs)])} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] font-semibold text-ink-muted2">＋ เพิ่มแถวเปล่า</button>
          {rows.length > 0 && <span className="text-[11.5px] text-ink-faint">{rows.length} แถว · ใส่รูปทีหลังได้ที่หน้าแก้ไขสินค้า</span>}
        </div>
      </div>

      {/* แถบจัดการแถวที่เลือก */}
      {selCount > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-accent-soft bg-[#b91c1c]/[0.08] px-3 py-2">
          <span className="text-[12.5px] font-semibold text-primary-soft">เลือก {selCount} แถว</span>
          <select value={assign} onChange={(e) => { if (e.target.value) { applySel({ series_id: e.target.value === '__none' ? '' : e.target.value }, 'จัดเข้าซีรีย์แล้ว'); setAssign(''); } }}
            className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12.5px] text-ink outline-none">
            <option value="">จัดเข้าซีรีย์…</option>
            <option value="__none">— ไม่มีซีรีย์ —</option>
            {seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <CopyFirst rows={rows} field="price" label="ใช้ราคาแถวแรก" onApply={applySel} />
          <CopyFirst rows={rows} field="dep" label="ใช้มัดจำแถวแรก" onApply={applySel} />
          <CopyFirst rows={rows} field="qty" label="ใช้จำนวนแถวแรก" onApply={applySel} />
          <button onClick={() => setRows((rs) => rs.filter((r) => !r.sel))} className="rounded-lg border border-[#f87171]/40 px-2.5 py-1.5 text-[12px] font-semibold text-[#f87171]">ลบที่เลือก</button>
          <button onClick={() => setRows((rs) => rs.map((r) => ({ ...r, sel: false })))} className="text-[12px] text-ink-faint">ล้างเลือก</button>
        </div>
      )}

      {/* แถว */}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-subtle py-12 text-center text-[13px] text-ink-faint">ยังไม่มีแถว — กด “เลือกรูปหลายรูป” ด้านบน (1 รูป = 1 สินค้า)</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const ok = rowValid(r);
            const price = Number(r.price) || 0, dep = Number(r.dep) || 0;
            const effDep = sd.fullPay ? price : (dep > 0 ? dep : rateDep);
            return (
              <div key={r.key} className={cx('rounded-xl border bg-surface-2 p-2', ok ? 'border-subtle' : 'border-[#f87171]/40')}>
                <div className="flex items-start gap-2">
                  <button onClick={() => set(r.key, { sel: !r.sel })} className={cx('mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border-[1.5px]', r.sel ? 'border-primary bg-primary' : 'border-subtle')}>
                    {r.sel && <Icon name="check" size={12} className="text-white" />}
                  </button>
                  <button type="button" onClick={() => r.image && setPreview(r.image)} className="group relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">
                    {r.image ? <img src={r.image} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={18} className="text-primary-soft/25" />}
                    {r.image && <span className="pointer-events-none absolute inset-0 hidden place-items-center bg-black/45 text-white group-hover:grid"><Icon name="search" size={16} /></span>}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="grid grid-cols-[1fr_110px] gap-1.5">
                      <input className={inputCls} value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="ชื่อตัวละคร" />
                      <select className={inputCls} value={r.series_id} onChange={(e) => set(r.key, { series_id: e.target.value })}>
                        <option value="">ซีรีย์…</option>
                        {seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-faint">{r.name.trim() ? `${r.name.trim()}${seriesName(r.series_id) ? ` - ${seriesName(r.series_id)}` : ''}` : '— กรอกชื่อ —'}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <input className={cx(inputCls, 'w-24 text-center')} inputMode="numeric" value={r.price} onChange={(e) => set(r.key, { price: e.target.value.replace(/[^\d]/g, '') })} placeholder="ราคาขาย*" />
                      <input className={cx(inputCls, 'w-24 text-center', !sd.fullPay && dep > 0 && dep >= price && 'border-[#f87171]')} inputMode="numeric" disabled={sd.fullPay}
                        value={sd.fullPay ? '' : r.dep} onChange={(e) => set(r.key, { dep: e.target.value.replace(/[^\d]/g, '') })} placeholder={sd.fullPay ? 'จ่ายเต็ม' : `มัดจำ ${rateDep}`} />
                      <input className={cx(inputCls, 'w-16 text-center')} inputMode="numeric" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value.replace(/[^\d]/g, '') })} placeholder="จำนวน*" />
                      <input className={cx(inputCls, 'w-16 text-center')} inputMode="decimal" value={r.height} onChange={(e) => set(r.key, { height: e.target.value.replace(/[^\d.]/g, '') })} placeholder="สูง" />
                      {price > 0 && <span className="text-[11px] text-primary-soft">{baht(price)} · มัดจำ {baht(effDep)}{!sd.fullPay && price > effDep ? ` · ค้าง ${baht(price - effDep)}` : ''}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button onClick={() => dup(r.key)} aria-label="ทำซ้ำ" className="grid h-7 w-7 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="plus" size={13} /></button>
                    <button onClick={() => removeRow(r.key)} aria-label="ลบ" className="grid h-7 w-7 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171]"><Icon name="x" size={13} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {badDep.length > 0 && (
        <div className="mt-2 rounded-lg border border-[#f87171]/40 bg-[#b91c1c]/[0.08] px-3 py-2 text-[11.5px] text-[#f87171]">
          มัดจำต้องน้อยกว่าราคาขาย — แก้ {badDep.length} แถว หรือสลับเป็น “เก็บเต็มจำนวน”
        </div>
      )}

      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-subtle bg-surface-2/95 p-3 backdrop-blur">
        <span className="text-[13px] text-ink-muted">
          พร้อมสร้าง <b className="text-ink">{validRows.length}</b>{rows.length > validRows.length ? ` · ยังไม่ครบ ${rows.length - validRows.length}` : ''}
          {validRows.length > 0 && <> · รวม {validRows.reduce((s, r) => s + (Number(r.qty) || 0), 0)} ชิ้น</>}
        </span>
        <button onClick={create} disabled={validRows.length === 0 || busy} className="ml-auto rounded-lg bg-cta px-6 py-2.5 text-[13px] font-bold text-white disabled:opacity-50">
          {busy ? 'กำลังสร้าง…' : `สร้างทั้งหมด (${validRows.length})`}
        </button>
      </div>

      {preview && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-black/85 p-6" onClick={() => setPreview(null)}>
          <img src={preview} alt="" className="max-h-[85vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button onClick={() => setPreview(null)} className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white"><Icon name="x" size={20} /></button>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, children, tone }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: 'draft' | 'live' }) {
  const active = tone === 'live' ? 'border-[#d4af37] bg-[#d4af37]/20 text-[#f1d27a]'
    : tone === 'draft' ? 'border-[#d97706]/60 bg-[#d97706]/15 text-[#fbbf24]'
    : 'border-primary bg-primary text-white';
  return (
    <button onClick={onClick} className={cx('rounded-lg border px-2.5 py-1.5 text-[12px] font-bold', on ? active : 'border-subtle bg-surface-3 text-ink-muted2')}>{children}</button>
  );
}

/** ปุ่มลัด: ก๊อปค่าจากแถวแรกไปทุกแถวที่เลือก (ล็อตเดียวกันมักราคา/จำนวนเท่ากัน) */
function CopyFirst({ rows, field, label, onApply }: { rows: Row[]; field: 'price' | 'dep' | 'qty'; label: string; onApply: (patch: Partial<Row>, msg: string) => void }) {
  const first = rows[0]?.[field] ?? '';
  return (
    <button disabled={!first} onClick={() => onApply({ [field]: first } as Partial<Row>, `ใช้ค่า ${first} กับแถวที่เลือกแล้ว`)}
      className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted2 disabled:opacity-40">{label}</button>
  );
}
