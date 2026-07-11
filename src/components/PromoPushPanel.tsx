'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { sendPush, subsAll } from '@/lib/push';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';

/** ส่ง Push โปรโมชั่นถึงทุกเครื่องที่เปิดการแจ้งเตือน (manual composer — ryuma push spec 3).
 *  Shared by /admin/home and /admin/push. */
export function PromoPushPanel() {
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
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
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
