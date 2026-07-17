'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { addSourcingMemo, updateSourcingMemo, doneSourcingMemo, deleteSourcingMemo } from '@/data/mutations';
import { memoPhase, memoEtaLabel, memosDue } from '@/domain/services/sourcing';
import { memoCustomersOf } from '@/domain/entities';
import type { SourcingMemo, SourcingTransport } from '@/domain/entities';
import { MemoTicketsModal } from './MemoTickets';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const today = () => new Date().toISOString().slice(0, 10);
const fmtD = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

type CustRow = { name: string; fb: string };
type Draft = {
  id?: string; product_name: string; image_url?: string; price: string; deposit: string; qty: string;
  customers: CustRow[]; transport: '' | SourcingTransport; started_at: string; note: string;
};
const fresh = (): Draft => ({ product_name: '', image_url: undefined, price: '', deposit: '', qty: '1', customers: [{ name: '', fb: '' }], transport: '', started_at: today(), note: '' });

/**
 * หาของนอกระบบ (Memo) — ดีลที่คุยกันทางแชทเฟส/โทร (ลูกค้าไม่มีบัญชีในแอป) จดกันลืมแทนการจดในแชท:
 * รูป + ชื่อสินค้า + ราคา/มัดจำ + รถ/เรือ (ETA config เดียวกับหาของในระบบ) + ชื่อลูกค้า + ลิงก์เฟส.
 * แจ้งเตือน = การ์ดกระพริบเมื่อเข้าช่วงคาดว่าถึง (+ การ์ดเตือนบน Dashboard). ADMIN-ONLY (RLS v49).
 */
export function SourcingMemos() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(fresh());
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [ticketFor, setTicketFor] = useState<SourcingMemo | null>(null); // 🎫 modal ออกตั๋วทีละคน
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const active = db.sourcingMemos.filter((m) => m.status === 'active').sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const done = db.sourcingMemos.filter((m) => m.status === 'done').sort((a, b) => ((a.done_at ?? '') < (b.done_at ?? '') ? 1 : -1));
  const due = memosDue(db);

  const onImage = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { set('image_url', await uploadImage(file, 'sourcing')); flash('อัปรูปแล้ว ✓'); }
    catch { flash('อัปโหลดรูปไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const setCust = (i: number, patch: Partial<CustRow>) => setDraft((d) => ({ ...d, customers: d.customers.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const addCust = () => setDraft((d) => ({ ...d, customers: [...d.customers, { name: '', fb: '' }] }));
  const removeCust = (i: number) => setDraft((d) => ({ ...d, customers: d.customers.length > 1 ? d.customers.filter((_, j) => j !== i) : d.customers }));

  const save = () => {
    if (!draft.product_name.trim()) return flash('ใส่ชื่อสินค้าก่อน');
    // ใส่ได้หลายคนทีเดียว — เอาเฉพาะแถวที่มีชื่อ (FB ไม่บังคับ)
    const customers = draft.customers.map((c) => ({ name: c.name.trim(), fb_link: c.fb.trim() || undefined })).filter((c) => c.name);
    if (customers.length === 0) return flash('ใส่ชื่อลูกค้าอย่างน้อย 1 คน');
    const data = {
      product_name: draft.product_name.trim(), image_url: draft.image_url,
      price: Number(draft.price) > 0 ? Number(draft.price) : undefined,
      deposit: Number(draft.deposit) > 0 ? Number(draft.deposit) : undefined,
      qty: Math.max(1, Number(draft.qty) || 1),
      customers,
      customer_name: customers[0].name, fb_link: customers[0].fb_link, // mirror คนแรก (legacy/not-null)
      transport: draft.transport || undefined, started_at: draft.started_at || today(),
      note: draft.note.trim() || undefined,
    };
    if (draft.id) { dispatch(updateSourcingMemo(draft.id, data)); flash('แก้ไขแล้ว ✓'); }
    else { dispatch(addSourcingMemo(data)); flash(`จดรายการแล้ว ✓ (${customers.length} คน)`); }
    setDraft(fresh()); setOpen(false);
  };

  const edit = (m: SourcingMemo) => {
    setDraft({ id: m.id, product_name: m.product_name, image_url: m.image_url, price: m.price != null ? String(m.price) : '', deposit: m.deposit != null ? String(m.deposit) : '', qty: String(m.qty), customers: memoCustomersOf(m).map((c) => ({ name: c.name, fb: c.fb_link ?? '' })), transport: m.transport ?? '', started_at: m.started_at, note: m.note ?? '' });
    setOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="mb-6 rounded-2xl border border-[#8b5cf6]/35 bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-bold">📒 หาของนอกระบบ ({active.length})</span>
        {due.length > 0 && <span className="animate-pulseRed rounded-full border border-accent bg-[#b91c1c]/[0.15] px-2.5 py-0.5 text-[11px] font-bold text-primary-soft">🔔 ถึงช่วงคาดแล้ว {due.length} รายการ</span>}
        <button onClick={() => { if (open && draft.id) setDraft(fresh()); setOpen((o) => !o); }} className="ml-auto rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">{open ? 'ปิดฟอร์ม' : '＋ จดรายการ'}</button>
      </div>
      <div className="mb-3 text-[12px] text-ink-faint">ดีลจากแชทเฟส/โทร (ลูกค้าไม่มีบัญชีในแอป) — จดกันลืมแทนโน้ตในแชท · เข้าช่วงคาดถึงแล้วการ์ดจะเตือนเอง</div>

      {open && (
        <div className="mb-4 rounded-xl border border-subtle bg-surface-3/40 p-4">
          <div className="mb-2 text-[13px] font-bold">{draft.id ? 'แก้ไขรายการ' : 'จดรายการใหม่'}</div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-accent bg-surface-3 p-2.5">
                {draft.image_url
                  ? <img src={draft.image_url} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  : <div className="grid h-16 w-16 place-items-center rounded-lg bg-surface-4 text-ink-faint">{busy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}</div>}
                <span className="text-[12px] text-ink-faint">{draft.image_url ? 'เปลี่ยนรูป' : 'รูปสินค้า (แตะอัปโหลด)'}</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onImage(e.target.files?.[0])} />
              </label>
              <input className={inputCls} value={draft.product_name} onChange={(e) => set('product_name', e.target.value)} placeholder="ชื่อสินค้า * เช่น ฐาน Jacksdo / ลิง VIP Power" />
              <div className="grid grid-cols-3 gap-2">
                <input className={inputCls} inputMode="numeric" value={draft.price} onChange={(e) => set('price', e.target.value)} placeholder="ราคา (฿)" />
                <input className={inputCls} inputMode="numeric" value={draft.deposit} onChange={(e) => set('deposit', e.target.value)} placeholder="มัดจำ (฿)" />
                <input className={inputCls} inputMode="numeric" value={draft.qty} onChange={(e) => set('qty', e.target.value)} placeholder="จำนวน" />
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11.5px] font-semibold text-ink-muted">ลูกค้า (ใส่ได้หลายคนทีเดียว · FB ไม่บังคับ)</span>
                  <button onClick={addCust} className="text-[11.5px] font-bold text-primary-soft">＋ เพิ่มลูกค้า</button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {draft.customers.map((c, i) => (
                    <div key={i} className="flex gap-1.5">
                      <input className={cx(inputCls, 'flex-[2]')} value={c.name} onChange={(e) => setCust(i, { name: e.target.value })} placeholder={`ชื่อลูกค้า ${i + 1} *`} />
                      <input className={cx(inputCls, 'flex-[3]')} value={c.fb} onChange={(e) => setCust(i, { fb: e.target.value })} placeholder="ลิงก์ Facebook (ไม่บังคับ)" />
                      {draft.customers.length > 1 && <button onClick={() => removeCust(i)} aria-label="ลบคน" className="shrink-0 rounded-lg border border-subtle bg-surface-3 px-2.5 text-[#f87171]">✕</button>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select className={inputCls} value={draft.transport} onChange={(e) => set('transport', e.target.value as Draft['transport'])}>
                  <option value="">— ขนส่ง (ยังไม่รู้) —</option>
                  <option value="truck">🚚 รถ</option>
                  <option value="ship">🚢 เรือ</option>
                </select>
                <input type="date" className={inputCls} value={draft.started_at} onChange={(e) => set('started_at', e.target.value)} title="วันเริ่มนับ (วันมัดจำ/สั่ง)" />
              </div>
              <input className={inputCls} value={draft.note} onChange={(e) => set('note', e.target.value)} placeholder="โน้ต เช่น 1.Suthep 2.Jirapat / สีพิเศษ" />
            </div>
          </div>
          <button onClick={save} className="mt-3 w-full rounded-xl bg-cta py-2.5 text-[13.5px] font-bold text-white lg:w-auto lg:px-8">{draft.id ? '✓ บันทึกแก้ไข' : '✓ จดเลย'}</button>
        </div>
      )}

      {active.length === 0 ? (
        <div className="py-5 text-center text-[12.5px] text-ink-faint">ยังไม่มีรายการ — กด "จดรายการ" ตอนคุยแชทได้เลย</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {active.map((m) => {
            const phase = memoPhase(db, m);
            const eta = memoEtaLabel(db, m);
            const owe = (m.price ?? 0) - (m.deposit ?? 0);
            return (
              <div key={m.id} className={cx('rounded-xl border p-3', phase === 'due' ? 'animate-pulseRed border-accent bg-[#b91c1c]/[0.07]' : phase === 'overdue' ? 'border-[#f87171] bg-[#b91c1c]/[0.12]' : 'border-subtle bg-surface-3/40')}>
                <div className="flex gap-3">
                  <div className="h-[64px] w-[64px] shrink-0 overflow-hidden rounded-lg border border-subtle bg-stripe">
                    {m.image_url ? <img src={m.image_url} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center"><Icon name="box" size={22} className="text-primary-soft/25" /></div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-bold">{m.product_name}{m.qty > 1 && <span className="ml-1 text-[11px] font-semibold text-ink-faint">×{m.qty}</span>}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {memoCustomersOf(m).map((c, i) => c.fb_link
                        ? <a key={i} href={c.fb_link} target="_blank" rel="noreferrer" className="rounded-md bg-[#2563eb]/[0.12] px-1.5 py-0.5 text-[11px] font-semibold text-[#60a5fa] underline-offset-2 hover:underline">👤 {c.name} ↗</a>
                        : <span key={i} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted2">👤 {c.name}</span>)}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-faint">
                      {m.price != null && <>ราคา <b className="text-ink">{baht(m.price)}</b></>}
                      {m.deposit != null && <> · มัดจำ <b className="text-[#4ade80]">{baht(m.deposit)}</b></>}
                      {m.price != null && owe > 0 && <> · ค้าง <b className="text-primary-soft">{baht(owe)}</b></>}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-ink-faint">จด {fmtD(m.started_at)}</span>
                  {eta && (
                    <span className={cx('rounded-md px-1.5 py-0.5 font-semibold', phase === 'due' ? 'bg-[#b91c1c]/[0.18] text-primary-soft' : phase === 'overdue' ? 'bg-[#b91c1c]/[0.25] text-[#fca5a5]' : 'bg-[#2563eb]/[0.12] text-[#93c5fd]')}>
                      {phase === 'due' ? '🔔 ถึงช่วงคาดแล้ว — ทวงเช็ค!' : phase === 'overdue' ? '⚠️ เลยช่วงคาด — รีบตาม!' : eta}
                    </span>
                  )}
                  {(phase === 'due' || phase === 'overdue') && eta && <span className="text-ink-faint">({eta})</span>}
                </div>
                {m.note && <div className="mt-1.5 rounded-lg bg-surface-3/60 px-2 py-1 text-[11.5px] text-ink-muted2">📝 {m.note}</div>}
                <div className="mt-2 flex gap-1.5">
                  <button onClick={() => setTicketFor(m)} className="flex-1 rounded-lg border border-[#d4af37]/50 bg-[#d4af37]/[0.12] py-1.5 text-[11.5px] font-bold text-[#f1d27a]">🎫 ออกตั๋ว ({memoCustomersOf(m).length})</button>
                  <button onClick={() => { dispatch(doneSourcingMemo(m.id)); flash(`ปิดงาน ${m.product_name} ✓`); }} className="flex-1 rounded-lg bg-[#16a34a] py-1.5 text-[11.5px] font-bold text-white">✓ จบงาน</button>
                  <button onClick={() => edit(m)} className="rounded-lg border border-subtle bg-surface-3 px-2.5 text-[11.5px] font-semibold text-ink-muted2">แก้</button>
                  <button onClick={() => { if (confirm(`ลบ "${m.product_name}" (${m.customer_name})?`)) { dispatch(deleteSourcingMemo(m.id)); flash('ลบแล้ว'); } }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 text-[11.5px] font-semibold text-[#f87171]">ลบ</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {ticketFor && <MemoTicketsModal memo={ticketFor} onClose={() => setTicketFor(null)} />}

      {done.length > 0 && (
        <div className="mt-3 border-t border-hair pt-2">
          <button onClick={() => setShowDone((v) => !v)} className="text-[12px] font-semibold text-ink-faint">จบแล้ว ({done.length}) {showDone ? '▴' : '▾'}</button>
          {showDone && (
            <div className="mt-1.5 flex flex-col divide-y divide-hair">
              {done.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5 py-1.5 text-[12px] text-ink-faint">
                  <span className="min-w-0 flex-1 truncate"><b className="text-ink-muted2">{m.product_name}</b> · {m.customer_name}</span>
                  <span>{fmtD(m.done_at)}</span>
                  <button onClick={() => { if (confirm(`ลบประวัติ "${m.product_name}"?`)) { dispatch(deleteSourcingMemo(m.id)); flash('ลบแล้ว'); } }} className="text-[#f87171]">ลบ</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
