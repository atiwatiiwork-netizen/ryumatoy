'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { Icon } from '@/components/Icon';
import { uploadImage } from '@/lib/upload';
import { genId, updateSettings } from '@/data/mutations';
import { sendPush, subsAll } from '@/lib/push';
import type { PromoBanner } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';

export default function AdminHomePage() {
  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">หน้าแรก / โปรโมชั่น</div>
      <div className="mb-5 text-[13px] text-ink-faint">จัดการรูปสไลด์ประกาศ/โปรโมชั่นบนสุดของหน้าลูกค้า + แบนเนอร์สินค้าเด่น</div>
      <PromoManager />
      <PromoPushPanel />
    </div>
  );
}

// ── ส่ง Push โปรโมชั่นถึงทุกเครื่องที่เปิดการแจ้งเตือน (ryuma push spec 3) ────
function PromoPushPanel() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('/shop');
  const [sending, setSending] = useState(false);
  const devices = db.pushSubscriptions.length;

  const send = async () => {
    if (!title.trim()) return flash('กรอกหัวข้อก่อน');
    if (devices === 0) return flash('ยังไม่มีลูกค้าเปิดการแจ้งเตือน');
    if (!confirm(`ส่งแจ้งเตือน "${title.trim()}" ถึง ${devices} เครื่อง?`)) return;
    setSending(true);
    try {
      const r = await sendPush(subsAll(db), { title: title.trim(), body: body.trim(), url: url.trim() || '/' }, dispatch);
      flash(`ส่งแล้ว ${r.sent} เครื่อง${r.gone.length ? ` · ลบเครื่องที่ยกเลิก ${r.gone.length}` : ''} 🔔`);
      setTitle(''); setBody('');
    } catch { flash('ส่งไม่สำเร็จ — เช็ค VAPID_PRIVATE_KEY บน Vercel'); }
    finally { setSending(false); }
  };

  return (
    <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">🔔 ส่ง Push แจ้งเตือนโปรโมชั่น</div>
      <div className="mb-3 text-[12px] text-ink-faint">เด้งบนมือถือ/คอมของลูกค้าที่เปิด "การแจ้งเตือน" ไว้ในโปรไฟล์ — ตอนนี้ {devices} เครื่อง</div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">หัวข้อ</span><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น 🔥 ลดพิเศษสุดสัปดาห์นี้" /></label>
        <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ลิงก์เมื่อกด (ในเว็บ)</span><input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/shop" /></label>
        <label className="block sm:col-span-2"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ข้อความ</span><input className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} placeholder="เช่น คูปอง 100 บาท เฉพาะ 20 คนแรก!" /></label>
      </div>
      <button onClick={send} disabled={sending} className="mt-3 rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">{sending ? 'กำลังส่ง…' : `ส่งถึง ${devices} เครื่อง`}</button>
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
      <div className="mb-4 text-[12.5px] text-ink-faint">รูปจะแสดงเต็มตามสัดส่วนจริง (ไม่ครอป) · แนะนำรูปแนวนอนสัดส่วน <b className="text-ink-muted2">เท่ากันทุกรูป</b> เช่น 1200×480 หรือ 1600×500 เพื่อให้สไลด์สูงเท่ากัน · ใส่ลิงก์เมื่อกดรูป (สินค้า /shop/xxx หรือ URL ภายนอก) · จัดลำดับด้วยลูกศร</div>

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
