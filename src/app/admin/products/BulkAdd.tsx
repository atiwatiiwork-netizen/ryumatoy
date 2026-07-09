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
import { priceFromYuan, depositFor } from '@/domain/services/pricing';
import { genId, bulkCreateProducts } from '@/data/mutations';
import { store } from '@/data/store';
import type { Product, WcfType } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent';
const DRAFT_KEY = 'ryuma_bulk_draft';

interface VDraft { key: string; image?: string; vname: string; cost_yuan: string }
interface Row {
  key: string;
  image?: string;
  name: string;      // character
  series_id: string; // per-row
  cost_yuan: string;
  height: string; width: string; depth: string;
  sel: boolean;
  variants?: VDraft[]; // present → this row is ONE variant product
}
interface Shared { manufacturer_id: string; franchise_id: string; wcf_type: WcfType; eta_q: string; eta_year: string }

const YEARS = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() + i));

/** Bulk add: pick many images → one row each; set shared ค่าย/เรื่อง/ชนิด/ETA once; series is per-row
 *  (group-assign several at once); merge rows into a variant product; create all in one go. */
export function BulkAdd({ onDone }: { onDone: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const st = db.settings;

  const [sd, setSd] = useState<Shared>(() => {
    if (typeof window !== 'undefined') { try { const s = sessionStorage.getItem(DRAFT_KEY); if (s) return JSON.parse(s).sd; } catch { /* */ } }
    return { manufacturer_id: db.manufacturers[0]?.id ?? '', franchise_id: db.franchises[0]?.id ?? '', wcf_type: 'wcf', eta_q: '', eta_year: '' };
  });
  const [rows, setRows] = useState<Row[]>(() => {
    if (typeof window !== 'undefined') { try { const s = sessionStorage.getItem(DRAFT_KEY); if (s) return JSON.parse(s).rows ?? []; } catch { /* */ } }
    return [];
  });
  const [uploading, setUploading] = useState(false);
  const [assign, setAssign] = useState('');
  const [preview, setPreview] = useState<string | null>(null); // click a thumbnail → enlarge

  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ sd, rows })); } catch { /* */ } }, [sd, rows]);
  // keep shared ids valid once real data loads (ค่าย stays within the franchise's own makers)
  useEffect(() => {
    setSd((d) => {
      const f = db.franchises.some((x) => x.id === d.franchise_id) ? d.franchise_id : (db.franchises[0]?.id ?? '');
      const makers = makersForFranchise(db, f);
      const m = makers.some((x) => x.id === d.manufacturer_id) ? d.manufacturer_id : (makers[0]?.id ?? '');
      return m === d.manufacturer_id && f === d.franchise_id ? d : { ...d, manufacturer_id: m, franchise_id: f };
    });
  }, [db.manufacturers, db.franchises, db.series]);

  const makerOpts = makersForFranchise(db, sd.franchise_id); // ค่าย limited to the chosen เรื่อง
  const seriesOpts = seriesForFranchise(db, sd.franchise_id, sd.manufacturer_id);
  const seriesName = (sid: string) => seriesOpts.find((s) => s.id === sid)?.name;

  const freshRow = (image: string | undefined, prev: Row[], name = ''): Row => ({
    key: genId('r'), image, name, series_id: prev[prev.length - 1]?.series_id ?? '', // sticky: inherit last row's series
    cost_yuan: '', height: '', width: '', depth: '', sel: false,
  });
  // default the character name to the image's file name (minus extension) so the admin doesn't retype
  const nameFromFile = (fileName: string) => fileName.replace(/\.[^.]+$/, '').trim();

  const addImages = async (files?: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    const items = await Promise.all([...files].map(async (f) => {
      const name = nameFromFile(f.name);
      try { return { url: await uploadImage(await applyWatermark(f), 'product'), name }; }
      catch { return { url: undefined, name }; }
    }));
    setRows((rs) => { let acc = rs; for (const it of items) acc = [...acc, freshRow(it.url, acc, it.name)]; return acc; });
    setUploading(false);
    flash(`เพิ่ม ${items.filter((i) => i.url).length} รูป`);
  };

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setV = (rk: string, vk: string, patch: Partial<VDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === rk ? { ...r, variants: r.variants!.map((v) => (v.key === vk ? { ...v, ...patch } : v)) } : r)));
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));
  const dup = (key: string) => setRows((rs) => { const i = rs.findIndex((r) => r.key === key); if (i < 0) return rs; const c = { ...rs[i], key: genId('r'), sel: false, variants: rs[i].variants?.map((v) => ({ ...v, key: genId('rv') })) }; return [...rs.slice(0, i + 1), c, ...rs.slice(i + 1)]; });

  const selCount = rows.filter((r) => r.sel).length;
  const applyAssign = (sid: string) => { setRows((rs) => rs.map((r) => (r.sel ? { ...r, series_id: sid, sel: false } : r))); setAssign(''); flash('จัดเข้าซีรีย์แล้ว'); };
  const merge = () => {
    const sel = rows.filter((r) => r.sel && !r.variants);
    if (sel.length < 2) return flash('เลือกอย่างน้อย 2 แถว (แบบธรรมดา) เพื่อรวมเป็น variants');
    const first = sel[0];
    const merged: Row = {
      key: genId('r'), name: first.name, series_id: first.series_id, cost_yuan: '',
      height: first.height, width: first.width, depth: first.depth, sel: false,
      variants: sel.map((r) => ({ key: genId('rv'), image: r.image, vname: r.name, cost_yuan: r.cost_yuan })),
    };
    const keys = new Set(sel.map((r) => r.key));
    setRows((rs) => [merged, ...rs.filter((r) => !keys.has(r.key))]);
    flash(`รวม ${sel.length} รูปเป็น 1 สินค้า (variants)`);
  };
  const splitVariant = (key: string) => setRows((rs) => {
    const i = rs.findIndex((r) => r.key === key); if (i < 0 || !rs[i].variants) return rs;
    const back = rs[i].variants!.map((v) => ({ key: genId('r'), image: v.image, name: v.vname, series_id: rs[i].series_id, cost_yuan: v.cost_yuan, height: rs[i].height, width: rs[i].width, depth: rs[i].depth, sel: false } as Row));
    return [...rs.slice(0, i), ...back, ...rs.slice(i + 1)];
  });

  const rowValid = (r: Row) => {
    if (!r.height.trim()) return false;
    if (r.variants) return r.name.trim().length > 0 && r.variants.length > 0 && r.variants.every((v) => v.vname.trim() && Number(v.cost_yuan) > 0);
    return r.name.trim().length > 0 && Number(r.cost_yuan) > 0;
  };
  const validRows = rows.filter(rowValid);

  const create = async () => {
    if (!sd.manufacturer_id || !sd.franchise_id) return flash('เลือกค่าย + เรื่องก่อน');
    if (validRows.length === 0) return flash('ยังไม่มีแถวที่กรอกครบ (ต้องมี ชื่อ + หยวน + สูง)');
    const etaNote = sd.eta_q && sd.eta_year ? `${sd.eta_q} ${sd.eta_year}` : 'TBA';
    const deposit = depositFor(st, sd.wcf_type);
    const items = validRows.map((r) => {
      const character = r.name.trim();
      const sn = seriesName(r.series_id);
      const finalName = sn ? `${character} - ${sn}` : character;
      const isVar = !!r.variants?.length;
      const variants = isVar ? r.variants!.map((v) => ({ name: v.vname.trim(), price_total: priceFromYuan(st, Number(v.cost_yuan) || 0), image_url: v.image })) : [];
      const price = isVar ? Math.min(...variants.map((v) => v.price_total)) : priceFromYuan(st, Number(r.cost_yuan) || 0);
      const images = isVar ? (r.variants![0].image ? [r.variants![0].image!] : []) : (r.image ? [r.image] : []);
      const product: Product = {
        id: genId('p'), franchise_id: sd.franchise_id, manufacturer_id: sd.manufacturer_id,
        series_id: r.series_id || undefined, series_name: finalName, character_name: character || undefined,
        wcf_type: sd.wcf_type, cost_yuan: isVar ? undefined : (Number(r.cost_yuan) || undefined),
        type: 'other', description: '', images, eta_note: etaNote,
        price_total: price, deposit_amount: deposit, is_stock: false,
        height_cm: r.height ? Number(r.height) : undefined, width_cm: r.width ? Number(r.width) : undefined, depth_cm: r.depth ? Number(r.depth) : undefined,
        has_variants: isVar, status: 'open', created_at: new Date().toISOString(),
      };
      return { product, variants };
    });
    dispatch(bulkCreateProducts(items));
    // wait for the rows to actually persist before clearing the draft — if the save fails, onPersistError
    // (AdminShell) toasts and the store keeps retrying; we keep the draft so nothing is silently lost.
    const n = items.length;
    flash(`กำลังบันทึก ${n} สินค้า…`);
    await store.flush();
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* */ }
    flash(`สร้าง ${n} สินค้าแล้ว 🎉`);
    setRows([]);
  };

  const maker = db.manufacturers.find((m) => m.id === sd.manufacturer_id);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <span className="text-xl font-extrabold">เพิ่มสินค้าหลายรายการ</span>
        <button onClick={onDone} className="ml-auto rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">← ทีละตัว</button>
      </div>

      {/* shared defaults */}
      <div className="mb-4 rounded-2xl border border-subtle bg-surface-2 p-4">
        <div className="mb-2.5 text-[12px] text-ink-muted">ค่าเริ่มต้นร่วม (ล็อกได้) — ซีรีย์ตั้งแยกรายแถวด้านล่าง</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <select className={inputCls} value={sd.franchise_id} onChange={(e) => setSd((d) => {
            const fid = e.target.value;
            const makers = makersForFranchise(db, fid);
            const mid = makers.some((m) => m.id === d.manufacturer_id) ? d.manufacturer_id : (makers[0]?.id ?? '');
            return { ...d, franchise_id: fid, manufacturer_id: mid };
          })}>{db.franchises.map((f) => <option key={f.id} value={f.id}>เรื่อง · {f.name}</option>)}</select>
          <select className={inputCls} value={sd.manufacturer_id} onChange={(e) => setSd((d) => ({ ...d, manufacturer_id: e.target.value }))}>{makerOpts.map((m) => <option key={m.id} value={m.id}>ค่าย · {m.name}</option>)}</select>
          <select className={inputCls} value={sd.wcf_type} onChange={(e) => setSd((d) => ({ ...d, wcf_type: e.target.value as WcfType }))}>
            <option value="wcf">ชนิด · WCF (มัดจำ {baht(st.deposit_wcf)})</option>
            <option value="mega_wcf">ชนิด · Mega (มัดจำ {baht(st.deposit_mega)})</option>
          </select>
          <select className={inputCls} value={sd.eta_q} onChange={(e) => setSd((d) => ({ ...d, eta_q: e.target.value }))}><option value="">ETA · ไตรมาส</option>{['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q} value={q}>{q}</option>)}</select>
          <select className={inputCls} value={sd.eta_year} onChange={(e) => setSd((d) => ({ ...d, eta_year: e.target.value }))}><option value="">ETA · ปี</option>{YEARS.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        </div>
        <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">
          <Icon name={uploading ? 'box' : 'camera'} size={16} className={uploading ? 'animate-pulse' : ''} /> {uploading ? 'กำลังอัปโหลด…' : 'เลือกรูปหลายรูป'}
          <input type="file" accept="image/*" multiple className="hidden" disabled={uploading} onChange={(e) => addImages(e.target.files)} />
        </label>
      </div>

      {/* selection toolbar */}
      {selCount > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-accent-soft bg-[#b91c1c]/[0.08] px-3 py-2">
          <span className="text-[12.5px] font-semibold text-primary-soft">เลือก {selCount} แถว</span>
          <select value={assign} onChange={(e) => e.target.value && applyAssign(e.target.value)} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12.5px] text-ink outline-none">
            <option value="">จัดเข้าซีรีย์…</option>
            <option value="__none">— ไม่มีซีรีย์ —</option>
            {seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={merge} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">รวมเป็น variants</button>
          <button onClick={() => setRows((rs) => rs.map((r) => ({ ...r, sel: false })))} className="text-[12px] text-ink-faint">ล้างเลือก</button>
        </div>
      )}

      {/* rows */}
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-subtle py-12 text-center text-[13px] text-ink-faint">ยังไม่มีแถว — กด “เลือกรูปหลายรูป” ด้านบน (1 รูป = 1 สินค้า)</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const ok = rowValid(r);
            return (
              <div key={r.key} className={cx('rounded-xl border bg-surface-2 p-2', ok ? 'border-subtle' : 'border-[#f87171]/40')}>
                <div className="flex items-start gap-2">
                  <button onClick={() => set(r.key, { sel: !r.sel })} className={cx('mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border-[1.5px]', r.sel ? 'border-primary bg-primary' : 'border-subtle')}>{r.sel && <Icon name="check" size={12} className="text-white" />}</button>
                  {!r.variants && (
                    <button type="button" onClick={() => r.image && setPreview(r.image)} title={r.image ? 'กดเพื่อดูรูปใหญ่' : undefined} className="group relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">
                      {r.image ? <img src={r.image} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={18} className="text-primary-soft/25" />}
                      {r.image && <span className="pointer-events-none absolute inset-0 hidden place-items-center bg-black/45 text-white group-hover:grid"><Icon name="search" size={16} /></span>}
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="grid grid-cols-[1fr_110px] gap-1.5">
                      <input className={inputCls} value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder={r.variants ? 'ชื่อสินค้า (ตัวหลัก)' : 'ชื่อตัวละคร'} />
                      <select className={inputCls} value={r.series_id} onChange={(e) => set(r.key, { series_id: e.target.value })}>
                        <option value="">ซีรีย์…</option>
                        {seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-faint">{r.name.trim() ? `${r.name.trim()}${seriesName(r.series_id) ? ` - ${seriesName(r.series_id)}` : ''}` : '— กรอกชื่อ —'}</div>
                    {/* simple: yuan + size ; variant: variant chips */}
                    {!r.variants ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1">
                          <input className={cx(inputCls, 'w-20 text-center')} inputMode="numeric" value={r.cost_yuan} onChange={(e) => set(r.key, { cost_yuan: e.target.value.replace(/[^\d]/g, '') })} placeholder="หยวน" />
                          <span className="text-[11px] text-primary-soft">{r.cost_yuan ? `= ${baht(priceFromYuan(st, Number(r.cost_yuan) || 0))}` : ''}</span>
                        </span>
                        <span className="ml-1 flex items-center gap-1">
                          <input className={cx(inputCls, 'w-12 text-center')} inputMode="decimal" value={r.height} onChange={(e) => set(r.key, { height: e.target.value.replace(/[^\d.]/g, '') })} placeholder="สูง*" />
                          <input className={cx(inputCls, 'w-12 text-center')} inputMode="decimal" value={r.width} onChange={(e) => set(r.key, { width: e.target.value.replace(/[^\d.]/g, '') })} placeholder="กว้าง" />
                          <input className={cx(inputCls, 'w-12 text-center')} inputMode="decimal" value={r.depth} onChange={(e) => set(r.key, { depth: e.target.value.replace(/[^\d.]/g, '') })} placeholder="ลึก" />
                        </span>
                      </div>
                    ) : (
                      <div className="mt-1.5 rounded-lg border border-subtle bg-surface-3/50 p-1.5">
                        <div className="mb-1 flex items-center gap-2 text-[11px] font-bold text-ink-muted2"><Icon name="tag" size={12} /> แบบ ({r.variants.length}) · ราคาต่อแบบ
                          <span className="ml-1 flex items-center gap-1 font-normal text-ink-faint">สูง <input className={cx(inputCls, 'w-11 text-center')} value={r.height} onChange={(e) => set(r.key, { height: e.target.value.replace(/[^\d.]/g, '') })} placeholder="*" /></span>
                          <button onClick={() => splitVariant(r.key)} className="ml-auto text-[11px] text-primary-soft">แยกกลับ</button>
                        </div>
                        <div className="flex flex-col gap-1">
                          {r.variants.map((v, i) => (
                            <div key={v.key} className="flex items-center gap-1.5 rounded-lg bg-surface-3/40 p-1">
                              <button type="button" onClick={() => v.image && setPreview(v.image)} title={v.image ? 'กดเพื่อดูรูปใหญ่' : undefined} className="group relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded bg-stripe">
                                {v.image ? <img src={v.image} alt="" className="h-full w-full object-cover" /> : <Icon name="box" size={14} className="text-primary-soft/25" />}
                                {v.image && <span className="pointer-events-none absolute inset-0 hidden place-items-center bg-black/45 text-white group-hover:grid"><Icon name="search" size={13} /></span>}
                              </button>
                              <span className="w-5 shrink-0 text-center text-[11px] font-bold text-ink-faint">#{i + 1}</span>
                              <input className={cx(inputCls, 'min-w-0 flex-1')} value={v.vname} onChange={(e) => setV(r.key, v.key, { vname: e.target.value })} placeholder={`ตั้งชื่อแบบที่ ${i + 1} เช่น สีแดง`} />
                              <input className={cx(inputCls, 'shrink-0 text-center')} style={{ width: 92 }} inputMode="numeric" value={v.cost_yuan} onChange={(e) => setV(r.key, v.key, { cost_yuan: e.target.value.replace(/[^\d]/g, '') })} placeholder="หยวน" />
                              <span className="w-14 shrink-0 text-right text-[11px] text-primary-soft">{v.cost_yuan ? baht(priceFromYuan(st, Number(v.cost_yuan) || 0)) : ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
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

      {/* footer */}
      <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-subtle bg-surface-2/95 p-3 backdrop-blur">
        <span className="text-[13px] text-ink-muted">พร้อมสร้าง <b className="text-ink">{validRows.length}</b>{rows.length > validRows.length ? ` · ยังไม่ครบ ${rows.length - validRows.length}` : ''} · {maker?.name}</span>
        <button onClick={create} disabled={validRows.length === 0} className="ml-auto rounded-lg bg-cta px-6 py-2.5 text-[13px] font-bold text-white disabled:opacity-50">สร้างทั้งหมด ({validRows.length})</button>
      </div>

      {/* image lightbox — click any thumbnail to see the full picture */}
      {preview && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-black/85 p-6" onClick={() => setPreview(null)}>
          <img src={preview} alt="" className="max-h-[85vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button onClick={() => setPreview(null)} className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white"><Icon name="x" size={20} /></button>
          <div className="absolute bottom-6 text-[12px] text-white/70">แตะที่ว่างเพื่อปิด</div>
        </div>
      )}
    </div>
  );
}
