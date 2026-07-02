'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { Icon } from '@/components/Icon';
import { uploadImage } from '@/lib/upload';
import { genId, updateSettings } from '@/data/mutations';
import type { PromoBanner } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';

export default function AdminHomePage() {
  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">หน้าแรก / โปรโมชั่น</div>
      <div className="mb-5 text-[13px] text-ink-faint">จัดการรูปสไลด์ประกาศ/โปรโมชั่นบนสุดของหน้าลูกค้า + แบนเนอร์สินค้าเด่น</div>
      <PromoManager />
      <div className="h-4" />
      <HeroConfig />
    </div>
  );
}

// ── promo/announcement carousel slides ─────────────────────────────────────
function PromoManager() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const list: PromoBanner[] = db.settings.announcements ?? [];
  const [busy, setBusy] = useState(false);

  const save = (next: PromoBanner[]) => dispatch(updateSettings({ announcements: next }));

  const add = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadImage(file, 'banner');
      save([...list, { id: genId('promo'), image_url: url }]);
      flash('เพิ่มรูปโปรโมชั่นแล้ว');
    } catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const patch = (id: string, p: Partial<PromoBanner>) => save(list.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const remove = (id: string) => save(list.filter((b) => b.id !== id));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };

  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">รูปสไลด์โปรโมชั่น (บนสุดของหน้าแรก)</div>
      <div className="mb-4 text-[12.5px] text-ink-faint">อัปโหลดรูปแนวนอน (เช่น 1200×480) · ใส่ลิงก์เมื่อกดรูป (สินค้า /shop/xxx หรือ URL ภายนอก) · ลากลำดับด้วยปุ่มลูกศร</div>

      {list.length === 0 ? (
        <div className="mb-4 rounded-xl border border-dashed border-subtle py-8 text-center text-[13px] text-ink-faint">ยังไม่มีรูปโปรโมชั่น — เพิ่มรูปแรกด้านล่าง</div>
      ) : (
        <div className="mb-4 flex flex-col gap-3">
          {list.map((b, i) => (
            <div key={b.id} className="flex flex-col gap-3 rounded-xl border border-subtle bg-surface-3 p-3 sm:flex-row sm:items-center">
              <div className="h-20 w-36 shrink-0 overflow-hidden rounded-lg bg-surface-4">
                <img src={b.image_url} alt="" className="h-full w-full object-cover" />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <input className={inputCls} value={b.link ?? ''} onChange={(e) => patch(b.id, { link: e.target.value || undefined })} placeholder="ลิงก์เมื่อกด (เช่น /shop/17268 หรือ https://facebook.com/...)" />
                <input className={inputCls} value={b.caption ?? ''} onChange={(e) => patch(b.id, { caption: e.target.value || undefined })} placeholder="คำอธิบาย (ไม่บังคับ)" />
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="grid h-9 w-9 place-items-center rounded-lg border border-subtle bg-surface-2 text-ink-muted2 disabled:opacity-30">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === list.length - 1} className="grid h-9 w-9 place-items-center rounded-lg border border-subtle bg-surface-2 text-ink-muted2 disabled:opacity-30">↓</button>
                <button onClick={() => remove(b.id)} className="grid h-9 w-9 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171]"><Icon name="x" size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-bold text-white">
        {busy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}
        {busy ? 'กำลังอัปโหลด…' : '+ เพิ่มรูปโปรโมชั่น'}
        <input type="file" accept="image/*" className="hidden" onChange={(e) => add(e.target.files?.[0])} disabled={busy} />
      </label>
    </div>
  );
}

// ── featured product hero (same as before, now here on the home settings page) ──
function HeroConfig() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const s = db.settings;
  const [busy, setBusy] = useState(false);
  const sellable = db.products.filter((p) => p.is_stock || p.status === 'open');

  const onImg = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { const url = await uploadImage(file, 'banner'); dispatch(updateSettings({ hero_image_url: url })); flash('อัปโหลดรูป Banner แล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">แบนเนอร์สินค้าเด่น (Hero)</div>
      <div className="mb-4 text-[12.5px] text-ink-faint">โชว์ใต้สไลด์โปรโมชั่น · เลือกสินค้าเด่น + ใส่รูปเองได้ (ถ้าไม่เลือก ระบบหยิบสินค้าเปิดจองล่าสุดให้)</div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">สินค้าเด่น</span>
          <select className={inputCls} value={s.hero_product_id ?? ''} onChange={(e) => dispatch(updateSettings({ hero_product_id: e.target.value || undefined }))}>
            <option value="">— อัตโนมัติ —</option>
            {sellable.map((p) => <option key={p.id} value={p.id}>{p.series_name}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <label className="grid h-16 w-28 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-accent bg-surface-3 text-ink-faint">
            {busy ? <Icon name="box" size={20} className="animate-pulse" /> : s.hero_image_url ? <img src={s.hero_image_url} alt="" className="h-full w-full object-cover" /> : <Icon name="camera" size={20} />}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onImg(e.target.files?.[0])} />
          </label>
          {s.hero_image_url && <button onClick={() => dispatch(updateSettings({ hero_image_url: undefined }))} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12px] text-ink-muted2">ลบรูป</button>}
        </div>
      </div>
    </div>
  );
}
