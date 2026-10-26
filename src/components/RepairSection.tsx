'use client';

import { useEffect, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { store } from '@/data/store';
import { persistFailText } from '@/data/persistErrors';
import { notifyAdminLine } from '@/lib/notify';
import { copyText } from '@/lib/clipboard';
import { fileRepairClaim, setRepairOutTracking, markRepairReceived } from '@/data/mutations';
import { productLabel } from '@/domain/services/catalog';
import {
  repairLive, repairWindow, repairClaimsOf, repairLastDay, isOpenClaim, REPAIR_STEPS, repairStep, REPAIR_STATUS_LABEL, REPAIR_STATUS_SHORT, REPAIR_BLOCK_TEXT,
  CARRIERS, CARRIER_NAME, MAX_REPAIR_IMAGES,
} from '@/domain/services/repair';
import type { PreorderTicket, Carrier, RepairClaim } from '@/domain/entities';

/**
 * 🔧 เรื่องซ่อม ฝั่งลูกค้า (เจ้าของ 2026-10-26) — อยู่ในหน้าตั๋ว เฉพาะใบที่ส่งแล้ว (status 'shipped')
 * ลูกค้าทำได้ 3 อย่าง: ยื่นเรื่อง (รูป+อาการ) · แจ้งเลขพัสดุที่ส่งไปช่าง · กดได้รับของ — ที่เหลือเป็นของแอดมิน
 * ด่านอยู่ใน repairWindow()/mutation ไม่ใช่ที่ปุ่ม · ก่อนเขียนทุกครั้ง reload สด + อ่านกลับ (false-success class)
 * แจ้งแอดมินทาง LINE เท่านั้น (push หาแอดมินจากเครื่องลูกค้าส่งไม่ถึง — RLS ซ่อนเครื่องแอดมิน)
 * ออกแบบที่ 375px ก่อน (DNA mobile-first) · ร่างฟอร์มเก็บ sessionStorage (DNA react-state: เปิดกล้องบน iOS แอปโดนฆ่าได้)
 */
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent';

export function RepairSection({ ticket }: { ticket: PreorderTicket }) {
  const db = useDatabase();
  const me = useCurrentUserId();
  const [filing, setFiling] = useState(false);
  const claims = repairClaimsOf(db, ticket.id);
  const open = claims.find(isOpenClaim);
  const last = claims[0];
  const w = repairWindow(db, ticket, me);

  if (!repairLive(db)) return null; // ยังไม่รัน v89 — ซ่อนทั้งก้อน
  // ฟอร์มต้องอยู่จนกว่าจะเซฟสำเร็จ (ถ้าเช็ค open ก่อน ฟอร์มจะหายทันทีที่ dispatch แล้วเซิร์ฟเวอร์ปฏิเสธ = ร่างหาย)
  if (filing) return <FileForm ticket={ticket} onClose={() => setFiling(false)} />;
  if (open) return <ClaimCard claim={open} ticket={ticket} />;
  if (!w.ok && !last && w.reason !== 'expired' && w.reason !== 'no_date') return null; // ไม่ใช่เจ้าของ (แอดมินเปิดดู) — ไม่มีอะไรให้ทำ

  return (
    <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 px-4 py-3">
      {last && (
        <div className={cx('mb-2 text-[12.5px]', last.status === 'done' ? 'text-[#4ade80]' : 'text-ink-muted2')}>
          {last.status === 'done'
            ? <>ซ่อมเสร็จแล้ว ✓ รับของ {fmtDate(last.received_at)}</>
            : <>เรื่องซ่อม {fmtDate(last.filed_at)}: ไม่รับเรื่อง — {last.reject_reason}</>}
        </div>
      )}
      {w.ok ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold text-ink">ของชำรุด? ยื่นเรื่องซ่อมได้</div>
            <div className="text-[11.5px] text-ink-faint">ยื่นได้ถึง {fmtDate(repairLastDay(w.deadline!))} · เหลือ {Math.max(0, w.daysLeft ?? 0)} วัน</div>
          </div>
          <button onClick={() => setFiling(true)} className="shrink-0 rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-ink">🔧 ยื่นเรื่องซ่อม</button>
        </div>
      ) : w.reason === 'expired' || w.reason === 'no_date' ? (
        <div className="text-[12px] text-ink-faint">{REPAIR_BLOCK_TEXT[w.reason]}{w.reason === 'expired' ? ` (วันสุดท้าย ${fmtDate(repairLastDay(w.deadline!))})` : ''}</div>
      ) : null}
    </div>
  );
}

/* ── ฟอร์มยื่นเรื่อง: อาการ + รูป (อย่างน้อย 1) ─────────────────────────── */
type Draft = { desc: string; images: string[] };
const draftKey = (ticketId: string) => `repair-draft:${ticketId}`;
const readDraft = (ticketId: string): Draft => {
  try { const r = sessionStorage.getItem(draftKey(ticketId)); if (r) { const d = JSON.parse(r) as Draft; return { desc: String(d.desc ?? ''), images: Array.isArray(d.images) ? d.images.filter((x) => typeof x === 'string') : [] }; } } catch { /* ไม่มี/พัง = เริ่มใหม่ */ }
  return { desc: '', images: [] };
};

function FileForm({ ticket, onClose }: { ticket: PreorderTicket; onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const [desc, setDesc] = useState(() => readDraft(ticket.id).desc);
  const [images, setImages] = useState<string[]>(() => readDraft(ticket.id).images);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = productLabel(db, ticket.product_id, ticket.variant_id);
  useEffect(() => { try { sessionStorage.setItem(draftKey(ticket.id), JSON.stringify({ desc, images })); } catch { /* เต็ม/ปิดไว้ — ไม่เป็นไร */ } }, [ticket.id, desc, images]);
  const clearDraft = () => { try { sessionStorage.removeItem(draftKey(ticket.id)); } catch { /* ignore */ } };

  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_REPAIR_IMAGES - images.length;
    if (room <= 0) return flash(`ใส่รูปได้สูงสุด ${MAX_REPAIR_IMAGES} รูป`);
    setUploading(true);
    try {
      // เก็บทีละรูปทันที — รูปที่ 2 พังไม่ทำให้รูปที่ 1 หาย
      for (const f of Array.from(files).slice(0, room)) { const url = await uploadImage(f, 'repair'); setImages((a) => [...a, url].slice(0, MAX_REPAIR_IMAGES)); }
    } catch (e) { flash((e as Error).message || 'อัปโหลดรูปไม่สำเร็จ ลองใหม่'); }
    finally { setUploading(false); }
  };

  const submit = async () => {
    if (!desc.trim()) return flash('บอกอาการที่เสียก่อน');
    if (images.length === 0) return flash('แนบรูปจุดที่เสียอย่างน้อย 1 รูป');
    setBusy(true);
    if (!(await store.reload({ safe: true }))) { setBusy(false); return flash(store.reloadFailText('ลองใหม่')); }
    const w = repairWindow(store.getState(), ticket, me);
    if (!w.ok) { setBusy(false); return flash(REPAIR_BLOCK_TEXT[w.reason!]); }
    const id = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch(fileRepairClaim({ id, ticketId: ticket.id, userId: me, description: desc, images }));
    let applied = false;
    dispatch((d) => { applied = d.repairClaims.some((c) => c.id === id); return d; });
    const failed = await store.flush();
    setBusy(false);
    if (!applied) return flash('ยื่นไม่สำเร็จ รีเฟรชแล้วลองใหม่');
    if (failed) return flash(persistFailText(failed, 'บันทึกไม่สำเร็จ เช็คเน็ตแล้วกดส่งใหม่'));
    const name = db.users.find((u) => u.id === me)?.display_name ?? 'ลูกค้า';
    notifyAdminLine(`🔧 เรื่องซ่อมใหม่: ${name} · ${label} · ${ticket.ticket_no}`);
    clearDraft();
    flash('ยื่นเรื่องแล้ว รอแอดมินส่งที่อยู่ช่าง');
    onClose();
  };

  return (
    <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-bold text-ink"><Icon name="warning" size={16} /> ยื่นเรื่องซ่อม</div>
      <div className="mb-3 text-[12px] text-ink-faint">{label} · {ticket.ticket_no}</div>
      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-ink-muted">อาการที่เสีย</span>
        <textarea className={cx(inputCls, 'min-h-[80px]')} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="เช่น แขนซ้ายหัก ฐานร้าว สีถลอกตรงไหน" />
      </label>
      <div className="mt-3">
        <span className="mb-1 block text-[12px] font-semibold text-ink-muted">รูปจุดที่เสีย (1–{MAX_REPAIR_IMAGES} รูป)</span>
        <div className="flex flex-wrap gap-2">
          {images.map((u, i) => (
            <div key={u} className="relative h-[72px] w-[72px] overflow-hidden rounded-lg border border-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
              <button onClick={() => setImages((a) => a.filter((_, j) => j !== i))} aria-label="ลบรูป" className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white"><Icon name="x" size={11} /></button>
            </div>
          ))}
          {images.length < MAX_REPAIR_IMAGES && (
            <label className={cx('grid h-[72px] w-[72px] cursor-pointer place-items-center rounded-lg border border-dashed border-subtle text-ink-faint', uploading && 'opacity-50')}>
              {uploading ? <span className="text-[11px]">กำลังส่ง…</span> : <Icon name="camera" size={20} />}
              <input type="file" accept="image/*" multiple className="hidden" disabled={uploading} onChange={(e) => { void addImages(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </div>
      </div>
      <div className="mt-4 flex gap-2.5">
        <Button variant="ghost" disabled={busy} onClick={onClose}>ยกเลิก</Button>
        <Button disabled={busy || uploading} onClick={submit}>{busy ? 'กำลังส่ง…' : 'ส่งเรื่อง'}</Button>
      </div>
    </div>
  );
}

/* ── เรื่องที่ค้างอยู่: ไทม์ไลน์ 5 ขั้น + สิ่งที่ลูกค้าต้องทำตอนนี้ ─────────── */
function ClaimCard({ claim, ticket }: { claim: RepairClaim; ticket: PreorderTicket }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [no, setNo] = useState('');
  const [busy, setBusy] = useState(false);
  const step = repairStep(claim.status);
  const label = productLabel(db, ticket.product_id, ticket.variant_id);

  /** เขียน 1 จังหวะแล้วอ่านกลับ — ต้อง "เปลี่ยนจริงในรอบนี้" (แอดมินเพิ่งเปลี่ยนจากอีกเครื่อง = mutation no-op) */
  const run = async (mutate: () => void, expect: RepairClaim['status'], okText: string, after?: () => void) => {
    setBusy(true);
    if (!(await store.reload({ safe: true }))) { setBusy(false); return flash(store.reloadFailText('ลองใหม่')); }
    const before = store.getState().repairClaims.find((c) => c.id === claim.id);
    mutate();
    let applied = false;
    dispatch((d) => { const now = d.repairClaims.find((c) => c.id === claim.id); applied = !!now && now !== before && now.status === expect; return d; });
    const failed = await store.flush();
    setBusy(false);
    if (!applied) return flash('สถานะเปลี่ยนไปแล้ว รีเฟรชหน้าดูอีกที');
    if (failed) return flash(persistFailText(failed, 'บันทึกไม่สำเร็จ เช็คเน็ตแล้วลองใหม่'));
    after?.();
    flash(okText);
  };

  const sendTracking = () => {
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (!no.trim()) return flash('ใส่เลขพัสดุก่อน');
    const c = carrier;
    void run(() => dispatch(setRepairOutTracking(claim.id, c, no)), 'sent_to_tech', 'บันทึกแล้ว รอช่างซ่อม', () => {
      const name = db.users.find((u) => u.id === me)?.display_name ?? 'ลูกค้า';
      notifyAdminLine(`📮 ลูกค้าส่งของให้ช่างแล้ว: ${name} · ${label} · ${CARRIER_NAME[c]} ${no.trim()}`);
    });
  };
  const received = () => {
    if (!confirm('ได้รับของที่ซ่อมแล้วใช่ไหม?')) return;
    void run(() => dispatch(markRepairReceived(claim.id)), 'done', 'จบเรื่องซ่อมแล้ว ขอบคุณครับ');
  };

  return (
    <div className="mb-3.5 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.08] p-4">
      <div className="flex items-center gap-2 text-[13px] font-bold text-[#fbbf24]"><Icon name="warning" size={16} /> เรื่องซ่อม · {REPAIR_STATUS_SHORT[claim.status]}</div>
      <div className="mt-0.5 pl-6 text-[12px] text-ink-muted2">{REPAIR_STATUS_LABEL[claim.status]}</div>

      {/* ไทม์ไลน์ */}
      <div className="mt-3 flex items-start">
        {REPAIR_STEPS.map((s, i) => {
          const done = i <= step;
          return (
            <div key={s.key} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <div className={cx('h-[2px] flex-1', i === 0 ? 'bg-transparent' : done ? 'bg-[#fbbf24]' : 'bg-white/10')} />
                <div className={cx('h-3 w-3 rounded-full border-2', done ? 'border-[#fbbf24] bg-[#fbbf24]' : 'border-white/20 bg-transparent', i === step && 'animate-pulse')} />
                <div className={cx('h-[2px] flex-1', i === REPAIR_STEPS.length - 1 ? 'bg-transparent' : i < step ? 'bg-[#fbbf24]' : 'bg-white/10')} />
              </div>
              <div className={cx('mt-1 text-center text-[10px] leading-tight', done ? 'text-ink' : 'text-ink-faint')}>{s.label}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-[11.5px] text-ink-faint">ยื่นเมื่อ {fmtTime(claim.filed_at)}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-ink-muted2">{claim.description}</div>
      {claim.images.length > 0 && (
        <div className="mt-2 flex gap-1.5">
          {claim.images.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="h-12 w-12 overflow-hidden rounded-md border border-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
            </a>
          ))}
        </div>
      )}

      {/* จังหวะของลูกค้า: ได้ที่อยู่ช่างแล้ว → ส่งของ + แจ้งเลข */}
      {claim.status === 'address_sent' && (
        <div className="mt-3 rounded-xl border border-subtle bg-surface-2 p-3">
          <div className="text-[12px] font-semibold text-ink-muted">ส่งของไปที่</div>
          <div className="mt-1 whitespace-pre-wrap text-[13px] text-ink">{claim.tech_address}</div>
          {claim.address_note && <div className="mt-1 text-[12px] text-[#fbbf24]">{claim.address_note}</div>}
          <button onClick={async () => flash((await copyText(claim.tech_address ?? '')) ? 'ก๊อปที่อยู่แล้ว' : 'ก๊อปไม่ได้ กดค้างเพื่อคัดลอกเอง')} className="mt-2 text-[12px] text-primary-soft underline">ก๊อปที่อยู่</button>
          <div className="mt-3 text-[12px] font-semibold text-ink-muted">ส่งแล้ว แจ้งเลขพัสดุ</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CARRIERS.map((c) => (
              <button key={c} onClick={() => setCarrier(c)} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', carrier === c ? 'border-accent bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{CARRIER_NAME[c]}</button>
            ))}
          </div>
          <input className={cx(inputCls, 'mt-2 font-mono')} value={no} onChange={(e) => setNo(e.target.value)} placeholder="เลขพัสดุ" />
          <Button className="mt-2" disabled={busy} onClick={sendTracking}>{busy ? 'กำลังส่ง…' : 'แจ้งเลขพัสดุ'}</Button>
        </div>
      )}

      {claim.status === 'sent_to_tech' && (
        <div className="mt-3 text-[12.5px] text-ink-muted2">ส่งให้ช่าง {fmtDate(claim.out_sent_at)} · {claim.out_carrier ? CARRIER_NAME[claim.out_carrier] : ''} <span className="break-all font-mono">{claim.out_tracking}</span><br />ซ่อมเสร็จแล้วจะแจ้งเลขพัสดุส่งกลับที่นี่</div>
      )}

      {claim.status === 'returned' && (
        <div className="mt-3 rounded-xl border border-[#16a34a]/35 bg-[#16a34a]/[0.1] p-3">
          <div className="flex items-center gap-2 text-[13px] font-bold text-[#4ade80]"><Icon name="truck" size={16} /> ส่งคืนแล้ว · {claim.back_carrier ? CARRIER_NAME[claim.back_carrier] : ''}</div>
          <div className="mt-1 break-all font-mono text-[13px] text-ink">{claim.back_tracking}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-faint">ส่งเมื่อ {fmtDate(claim.back_sent_at)}</div>
          <Button className="mt-3" disabled={busy} onClick={received}>{busy ? 'กำลังบันทึก…' : 'ได้รับของแล้ว ✓'}</Button>
        </div>
      )}
    </div>
  );
}
