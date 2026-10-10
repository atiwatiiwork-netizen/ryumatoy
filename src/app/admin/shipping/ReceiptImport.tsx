'use client';

import { useMemo, useRef, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { ocrImage } from '@/lib/ocr';
import { copyText } from '@/lib/clipboard';
import { store } from '@/data/store';
import { persistFailText } from '@/data/persistErrors';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { setParcel, logActivity } from '@/data/mutations';
import { labelSlots, parcelQueue, type LabelSlot } from '@/domain/services/delivery';
import { parseParcelReceipt, matchReceiptRows, unmatchedText, type ReceiptMatch, type MatchStatus } from '@/domain/services/parcelReceipt';
import type { Carrier } from '@/domain/entities';

/**
 * 📷 อ่านใบเสร็จขนส่ง → กรอกเลขพัสดุให้ทั้งคิวในครั้งเดียว (เจ้าของ 2026-10-10)
 * ทำงานในเครื่องแอดมินทั้งหมด (tesseract.js ไม่ส่งรูปออกไปไหน ไม่มีค่าใช้จ่าย)
 * ใช้ mutation เดิม setParcel ทีละใบ → อ่านกลับทุกใบ → flush ครั้งเดียว → แล้วค่อย push/log (DNA save)
 * ⚠ ไม่แนบรูปใบเสร็จเป็น parcel_image: ในใบมีชื่อ/เบอร์ลูกค้าคนอื่น ส่วนนั้นโชว์บนตั๋วลูกค้า = ข้อมูลรั่ว
 */
const CARRIERS: { key: Carrier; label: string }[] = [
  { key: 'jt', label: 'J&T' }, { key: 'flash', label: 'Flash' }, { key: 'kerry', label: 'Kerry' }, { key: 'ems', label: 'EMS' },
];
const STATUS_TH: Record<MatchStatus, { label: string; cls: string }> = {
  ok: { label: 'เบอร์ตรง', cls: 'bg-[#16a34a]/20 text-[#4ade80]' },
  suggest: { label: 'ชื่อคล้าย — ตรวจก่อน', cls: 'bg-[#d97706]/20 text-[#fbbf24]' },
  ambiguous: { label: 'มีหลายช่อง — เลือกเอง', cls: 'bg-[#d97706]/20 text-[#fbbf24]' },
  used: { label: 'กรอกไปแล้ว', cls: 'bg-white/[0.08] text-ink-faint' },
  unmatched: { label: 'ไม่เจอในระบบ', cls: 'bg-[#b91c1c]/20 text-[#f87171]' },
};

type Pick = { slotKey: string | null; on: boolean; waybill: string };

export function ReceiptImport() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrPct, setOcrPct] = useState(0);
  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [guessed, setGuessed] = useState(false);
  const [picks, setPicks] = useState<Record<string, Pick>>({}); // key = row.waybill ตอน parse
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const slots = useMemo(() => labelSlots(db, parcelQueue(db)), [db]);
  const parsed = useMemo(() => parseParcelReceipt(text), [text]);
  const matches = useMemo(() => matchReceiptRows(db, parsed.rows, slots), [db, parsed, slots]);
  const slotByKey = (k: string | null) => (k ? slots.find((s) => s.key === k) : undefined);

  const applyText = (raw: string) => {
    setText(raw); setDone(null);
    const p = parseParcelReceipt(raw);
    setCarrier(p.carrier ?? null); setGuessed(p.carrierGuessed);
    const ms = matchReceiptRows(db, p.rows, slots);
    const next: Record<string, Pick> = {};
    for (const m of ms) next[m.row.waybill] = { slotKey: m.slot?.key ?? null, on: m.status === 'ok', waybill: m.row.waybill };
    setPicks(next);
    if (p.rows.length === 0) flash('อ่านเลขพัสดุไม่เจอ — ลองถ่ายใหม่ให้ตรง/สว่างขึ้น หรือวางข้อความเอง');
  };
  const onFile = async (file?: File) => {
    if (!file) return;
    setOcrBusy(true); setOcrPct(0);
    try { applyText(await ocrImage(file, setOcrPct, 'eng+tha')); }
    catch { flash('อ่านรูปไม่สำเร็จ — ลองใหม่ หรือวางข้อความเอง'); }
    finally { setOcrBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const setPick = (k: string, patch: Partial<Pick>) => setPicks((old) => ({ ...old, [k]: { ...old[k], ...patch } }));

  const chosen = matches.filter((m) => { const p = picks[m.row.waybill]; return p?.on && p.slotKey && slotByKey(p.slotKey) && p.waybill.trim(); });
  // เลขซ้ำกันในตารางเดียว (แอดมินแก้เลขจนชนกัน) → ห้ามยืนยัน
  const dupWaybill = (() => { const seen = new Set<string>(); for (const m of chosen) { const w = picks[m.row.waybill].waybill.trim().toUpperCase(); if (seen.has(w)) return w; seen.add(w); } return null; })();

  const confirm = async () => {
    if (busy) return;
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (chosen.length === 0) return flash('ยังไม่มีแถวที่ติ๊กไว้');
    if (dupWaybill) return flash(`เลขพัสดุ ${dupWaybill} ซ้ำกัน 2 แถว — แก้ก่อน`);
    setBusy(true);
    try {
      type Applied = { slot: LabelSlot; waybill: string; ticketIds: string[] };
      const applied: Applied[] = []; const skipped: string[] = [];
      for (const m of chosen) {
        const p = picks[m.row.waybill]; const slot = slotByKey(p.slotKey)!; const wb = p.waybill.trim().toUpperCase();
        const okIds: string[] = [];
        for (const t of slot.tickets) {
          dispatch(setParcel(t.id, carrier, wb));
          // อ่านกลับ: setParcel ไม่ทำอะไรถ้าตั๋ว shipped ไปแล้ว/ยังค้างเงิน — ห้ามนับว่าสำเร็จ
          let ok = false;
          dispatch((d) => { const x = d.tickets.find((tt) => tt.id === t.id); ok = x?.status === 'shipped' && x.parcel_no === wb; return d; });
          if (ok) okIds.push(t.id); else skipped.push(t.ticket_no);
        }
        if (okIds.length) applied.push({ slot, waybill: wb, ticketIds: okIds });
      }
      if (applied.length === 0) { setDone(`ไม่ได้กรอกใบไหนเลย — ${skipped.length ? `ตั๋ว ${skipped.join(', ')} ถูกส่งไปแล้ว/ค้างเงิน` : 'ตรวจหน้าอีกครั้ง'}`); return; }
      // DNA save: เซฟให้ผ่านก่อนค่อย push — push ที่ออกไปแล้วเรียกคืนไม่ได้
      const pf = await store.flush();
      if (pf) { setDone(persistFailText(pf, 'บันทึกไม่สำเร็จ — ยังไม่ได้แจ้งลูกค้า ระบบลองใหม่ให้เอง รอสักครู่แล้วรีเฟรชเช็ค')); return; }
      const cLabel = CARRIERS.find((c) => c.key === carrier)?.label ?? carrier;
      for (const a of applied) {
        const tks = a.slot.tickets.filter((t) => a.ticketIds.includes(t.id));
        // push 1 ครั้งต่อพัสดุ (ช่อง) ไม่ใช่ต่อใบ — คนเดียว 2 ใบในกล่องเดียวไม่ควรเด้ง 2 รอบ
        if (pushEnabled(db, 'parcel'))
          sendPush(subsForUsers(db, [a.slot.tickets[0].owner_id]), { title: '📮 พัสดุจัดส่งแล้ว!', body: `${cLabel} · ${a.waybill} — แตะเพื่อดูตั๋ว`, url: tks.length === 1 ? `/wallet/${encodeURIComponent(tks[0].ticket_no)}` : '/wallet' }, dispatch).catch(() => {});
        for (const t of tks) dispatch(logActivity(adminId, 'set_parcel', `ส่งพัสดุ ${cLabel} ${a.waybill} (อ่านจากใบเสร็จ)`, { targetId: t.id, targetLabel: t.ticket_no }));
      }
      const n = applied.reduce((s, a) => s + a.ticketIds.length, 0);
      setDone(`✓ กรอกเลขพัสดุแล้ว ${n} ใบ (${applied.length} พัสดุ) + แจ้งลูกค้าแล้ว${skipped.length ? ` · ข้าม ${skipped.length} ใบ (ส่งไปแล้ว/ค้างเงิน): ${skipped.join(', ')}` : ''}`);
      flash(`กรอกเลขพัสดุแล้ว ${n} ใบ ✓`);
    } finally { setBusy(false); }
  };

  const unmatched = unmatchedText(matches);
  const copyUnmatched = async () => flash((await copyText(unmatched)) ? 'คัดลอกรายชื่อ–เลขพัสดุแล้ว' : 'คัดลอกไม่สำเร็จ');

  return (
    <div className="mb-[18px] rounded-2xl border border-[#0ea5e9]/35 bg-[#0ea5e9]/[0.05] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-base font-bold text-ink"><Icon name="camera" size={18} className="text-[#7dd3fc]" /> อ่านใบเสร็จขนส่ง → กรอกเลขพัสดุทั้งชุด</div>
        <span className="text-[11.5px] text-ink-faint">ฟรี · อ่านในเครื่องนี้ ไม่ส่งรูปออกไปไหน</span>
        <button onClick={() => setOpen((v) => !v)} className="ml-auto rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-bold text-ink-muted2">{open ? 'ซ่อน' : 'เปิด'}</button>
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={ocrBusy} className="rounded-xl bg-[#0284c7] px-4 py-2.5 text-[13.5px] font-bold text-white disabled:opacity-60">
              {ocrBusy ? `กำลังอ่านรูป… ${ocrPct}%` : '📷 ถ่าย/เลือกรูปใบเสร็จ'}
            </button>
            <span className="self-center text-[11.5px] text-ink-faint">รองรับ J&T · Flash · Kerry · EMS · ถ่ายให้ตรง แสงพอ · หรือวางข้อความด้านล่างแทน</span>
          </div>
          <textarea value={text} onChange={(e) => applyText(e.target.value)} rows={3} placeholder="วางข้อความจากใบเสร็จที่นี่ได้ (ถ้าอ่านรูปไม่ชัด)" className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent" />

          {parsed.rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="font-bold">ขนส่ง:</span>
                {CARRIERS.map((c) => (
                  <button key={c.key} onClick={() => { setCarrier(c.key); setGuessed(false); }} className={cx('rounded-lg border px-3 py-1 text-[12.5px] font-bold', carrier === c.key ? 'border-accent bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{c.label}</button>
                ))}
                {carrier && guessed && <span className="rounded bg-[#d97706]/20 px-1.5 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">เดาจากรูปแบบเลข — ตรวจด้วย</span>}
                {!carrier && <span className="rounded bg-[#b91c1c]/20 px-1.5 py-0.5 text-[10.5px] font-bold text-[#f87171]">อ่านชื่อขนส่งไม่ออก — เลือกเอง</span>}
                <span className="ml-auto text-ink-faint">อ่านได้ {parsed.rows.length} ใบ · จับคู่ได้ {matches.filter((m) => m.status === 'ok').length} · ไม่เจอ {matches.filter((m) => m.status === 'unmatched').length}</span>
              </div>

              <div className="flex flex-col gap-1.5">
                {matches.map((m) => <MatchRow key={m.row.waybill} m={m} pick={picks[m.row.waybill]} slots={slots} onChange={(p) => setPick(m.row.waybill, p)} />)}
              </div>

              {unmatched && (
                <div className="rounded-xl border border-[#b91c1c]/35 bg-[#b91c1c]/[0.06] p-3">
                  <div className="mb-1 flex items-center gap-2 text-[12.5px] font-bold text-[#f87171]">ไม่เจอในระบบ (ลูกค้านอกระบบ) — ก๊อปไปแจ้งเอง
                    <button onClick={() => void copyUnmatched()} className="ml-auto rounded-lg border border-subtle bg-surface-3 px-2.5 py-1 text-[11.5px] font-bold text-ink-muted2">📋 ก๊อปทั้งหมด</button>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-[12px] text-ink">{unmatched}</pre>
                </div>
              )}

              <button onClick={() => void confirm()} disabled={busy || chosen.length === 0 || !carrier} className="w-full rounded-xl bg-success py-2.5 text-[13.5px] font-bold text-white disabled:opacity-50">
                {busy ? 'กำลังบันทึก…' : `✓ กรอกเลขพัสดุ ${chosen.reduce((s, m) => s + (slotByKey(picks[m.row.waybill].slotKey)?.tickets.length ?? 0), 0)} ใบ (${chosen.length} พัสดุ) + แจ้งลูกค้า`}
              </button>
              {done && <div className="rounded-lg bg-surface-3 px-3 py-2 text-[12.5px] text-ink">{done}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MatchRow({ m, pick, slots, onChange }: { m: ReceiptMatch; pick?: Pick; slots: LabelSlot[]; onChange: (p: Partial<Pick>) => void }) {
  if (!pick) return null;
  const st = STATUS_TH[m.status];
  const selectable = m.status !== 'used';
  const options = m.status === 'ambiguous' ? m.candidates : slots;
  return (
    <div className={cx('min-w-0 rounded-xl border px-3 py-2.5', pick.on ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.06]' : 'border-subtle bg-surface-3', m.status === 'used' && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <input type="checkbox" checked={pick.on} disabled={!selectable || !pick.slotKey} onChange={(e) => onChange({ on: e.target.checked })} className="h-4 w-4 accent-[#16a34a]" />
        <input value={pick.waybill} onChange={(e) => onChange({ waybill: e.target.value })} className="w-[150px] rounded-md border border-subtle bg-surface-2 px-2 py-1 font-mono text-[12.5px] text-ink" />
        <span className={cx('rounded px-1.5 py-0.5 text-[10.5px] font-bold', st.cls)}>{st.label}{m.usedBy ? ` ที่ ${m.usedBy}` : ''}</span>
        <span className="text-[12px] text-ink-muted2">ใบเสร็จ: {m.row.name ?? '—'}{m.row.phone ? ` · ${m.row.phone}` : ''}</span>
      </div>
      {selectable && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink-faint">→ ตั๋วในระบบ:</span>
          <select value={pick.slotKey ?? ''} onChange={(e) => onChange({ slotKey: e.target.value || null, on: !!e.target.value && m.status !== 'suggest' ? pick.on || m.status === 'ok' : pick.on })}
            className="min-w-0 max-w-full rounded-md border border-subtle bg-surface-2 px-2 py-1 text-[12px] text-ink">
            <option value="">— เลือกช่อง —</option>
            {options.map((s) => <option key={s.key} value={s.key}>#{s.queueNo} {s.to.name} {s.to.phone} · {s.tickets.map((t) => t.ticket_no).join(', ')}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
