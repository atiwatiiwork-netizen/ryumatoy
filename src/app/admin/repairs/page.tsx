'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { store } from '@/data/store';
import { persistFailText } from '@/data/persistErrors';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { copyText } from '@/lib/clipboard';
import { sendRepairAddress, setRepairOutTracking, setRepairBackTracking, markRepairReceived, rejectRepairClaim, setRepairNote, setRepairConfig } from '@/data/mutations';
import { productLabel, lineImage } from '@/domain/services/catalog';
import {
  repairLive, repairQueue, repairConfig, repairLastDay, REPAIR_STATUS_SHORT, CARRIERS, CARRIER_NAME,
  REPAIR_PUSH_ADDRESS, REPAIR_PUSH_RETURN, REPAIR_PUSH_REJECT, repairAddressPayload, repairReturnPayload, repairRejectPayload,
} from '@/domain/services/repair';
import type { RepairClaim, Carrier, RepairStatus } from '@/domain/entities';

/**
 * 🔧 เรื่องซ่อม ฝั่งแอดมิน (เจ้าของ 2026-10-26)
 * คิว 3 แท็บ: ต้องทำ (ลูกค้าเพิ่งยื่น / ของอยู่ที่ช่าง) · รอลูกค้า (รอส่งของ / รอกดได้รับ) · จบแล้ว
 * แอดมินทำ: ส่งที่อยู่ช่าง (ค่าตั้งต้นแก้ได้ในหน้านี้) · ไม่รับเรื่อง+เหตุผล · บันทึกเลขส่งไปช่างแทนลูกค้า · แจ้งเลขส่งกลับ · ปิดเรื่อง
 * ทุกปุ่ม: โหลดสด → mutation (ด่านอยู่ข้างใน) → อ่านกลับ → เซฟ → ค่อย push/บอกสำเร็จ (DNA save)
 */
type Tab = 'todo' | 'waiting' | 'closed';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent';
const BADGE: Record<RepairStatus, string> = {
  filed: 'bg-[#b91c1c]/25 text-[#f87171]',
  address_sent: 'bg-[#d97706]/20 text-[#fbbf24]',
  sent_to_tech: 'bg-[#2563eb]/20 text-[#60a5fa]',
  returned: 'bg-[#16a34a]/20 text-[#4ade80]',
  done: 'bg-white/[0.08] text-ink-muted2',
  rejected: 'bg-white/[0.08] text-ink-faint',
};

export default function RepairsAdminPage() {
  const db = useDatabase();
  const [tab, setTab] = useState<Tab>('todo');
  const [showCfg, setShowCfg] = useState(false);
  const q = useMemo(() => repairQueue(db), [db]);
  const cfg = repairConfig(db);
  const rows = tab === 'todo' ? q.todo : tab === 'waiting' ? q.waiting : q.closed;
  const TABS: { key: Tab; label: string; n: number }[] = [
    { key: 'todo', label: 'ต้องทำ', n: q.todo.length },
    { key: 'waiting', label: 'รอลูกค้า', n: q.waiting.length },
    { key: 'closed', label: 'จบแล้ว', n: q.closed.length },
  ];

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-extrabold text-ink">🔧 เรื่องซ่อม</h1>
          <div className="text-[12px] text-ink-faint">ยื่นได้ภายใน {cfg.days} วันหลังส่งของ (+{cfg.transit_days} วันเผื่อขนส่ง)</div>
        </div>
        <button onClick={() => setShowCfg((v) => !v)} className={cx('shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', showCfg ? 'border-accent text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2', !cfg.address && 'animate-pulse border-[#f59e0b] text-[#fbbf24]')}>
          ⚙ ที่อยู่ช่าง{!cfg.address ? ' (ยังไม่ตั้ง)' : ''}
        </button>
      </div>
      {!repairLive(db) && (
        <div className="mb-3 rounded-card border border-[#f59e0b]/50 bg-[#f59e0b]/[0.1] px-4 py-3 text-[12.5px] text-[#fbbf24]">
          ยังไม่ได้รัน SQL <b>migration_repair_v89.sql</b> — ลูกค้ายังไม่เห็นปุ่มยื่นเรื่อง · รันแล้วค่อยตั้งที่อยู่ช่าง
        </div>
      )}
      {showCfg && <ConfigPanel onClose={() => setShowCfg(false)} />}

      <div className="mb-3 flex gap-1.5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold', tab === t.key ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2')}>
            {t.label}{t.n > 0 && <span className={cx('rounded-full px-[7px] text-[11px] font-extrabold', tab === t.key ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{t.n}</span>}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 p-8 text-center text-[13px] text-ink-faint">
          {tab === 'todo' ? 'ไม่มีเรื่องค้าง' : tab === 'waiting' ? 'ไม่มีเรื่องที่รอลูกค้า' : 'ยังไม่มีเรื่องที่จบ'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">{rows.map((c) => <ClaimCard key={c.id} claim={c} />)}</div>
      )}
    </div>
  );
}

/* ── ตั้งค่า: ที่อยู่ช่างตั้งต้น + วัน ─────────────────────────────────────── */
function ConfigPanel({ onClose }: { onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const cur = repairConfig(db);
  const [address, setAddress] = useState(cur.address);
  const [days, setDays] = useState(String(cur.days));
  const [transit, setTransit] = useState(String(cur.transit_days));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!repairLive(db)) return flash('รัน SQL v89 ก่อน แล้วค่อยตั้งค่า');
    const d = Number(days), t = Number(transit);
    if (!address.trim()) return flash('ใส่ที่อยู่ช่างก่อน');
    if (days.trim() === '' || !Number.isFinite(d) || d < 1 || d > 365) return flash('จำนวนวัน 1–365');
    if (transit.trim() === '' || !Number.isFinite(t) || t < 0 || t > 60) return flash('วันเผื่อขนส่ง 0–60');
    setBusy(true);
    dispatch(setRepairConfig(me, { address, days: d, transit_days: t }));
    const failed = await store.flush();
    setBusy(false);
    if (failed) return flash(persistFailText(failed, 'บันทึกไม่สำเร็จ ลองใหม่'));
    flash('บันทึกแล้ว');
    onClose();
  };

  return (
    <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
      <div className="mb-2 text-[13px] font-bold text-ink">ที่อยู่ช่าง (ค่าตั้งต้น — แก้ได้ตอนส่งแต่ละเรื่อง)</div>
      <textarea className={cx(inputCls, 'min-h-[90px]')} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={'ชื่อผู้รับ\nที่อยู่\nเบอร์โทร'} />
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ยื่นได้ภายใน (วัน)</span><input className={inputCls} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))} /></label>
        <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">เผื่อขนส่ง (วัน)</span><input className={inputCls} inputMode="numeric" value={transit} onChange={(e) => setTransit(e.target.value.replace(/[^\d]/g, ''))} /></label>
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-faint">นับจากวันที่กดจัดส่งในระบบ · รับเอง/รถเข้ารับ ไม่บวกวันเผื่อขนส่ง</div>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-subtle bg-surface-3 px-3.5 py-2 text-[12.5px] font-bold text-ink-muted2">ปิด</button>
        <button disabled={busy} onClick={save} className="rounded-lg bg-primary px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
      </div>
    </div>
  );
}

/* ── การ์ด 1 เรื่อง ─────────────────────────────────────────────────────────── */
function ClaimCard({ claim }: { claim: RepairClaim }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const cfg = repairConfig(db);
  const ticket = db.tickets.find((t) => t.id === claim.ticket_id);
  const user = db.users.find((u) => u.id === claim.user_id);
  const label = ticket ? productLabel(db, ticket.product_id, ticket.variant_id) : claim.ticket_id;
  const img = ticket ? lineImage(db, ticket.product_id, ticket.variant_id) : undefined;
  const ticketNo = ticket?.ticket_no ?? claim.ticket_id;
  const hasBell = db.pushSubscriptions.some((s) => s.user_id === claim.user_id);

  // null = ยังไม่แตะ → ใช้ค่าตั้งต้นล่าสุดเสมอ (แก้ค่าตั้งต้นแล้วการ์ดที่เปิดอยู่ต้องเห็นของใหม่)
  const [addressEdit, setAddressEdit] = useState<string | null>(null);
  const address = addressEdit ?? cfg.address;
  const [addrNote, setAddrNote] = useState('');
  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [no, setNo] = useState('');
  const [note, setNote] = useState(claim.admin_note ?? '');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(claim.status !== 'done' && claim.status !== 'rejected');

  /** โหลดสด → mutate → อ่านกลับสถานะที่คาด → เซฟ → after (push) */
  const run = async (mutate: () => void, expect: RepairStatus, okText: string, after?: () => void) => {
    setBusy(true);
    if (!(await store.reload({ safe: true }))) { setBusy(false); return flash(store.reloadFailText('ลองใหม่')); }
    const before = store.getState().repairClaims.find((c) => c.id === claim.id);
    mutate();
    // ต้อง "เปลี่ยนจริงในรอบนี้" — อีกเครื่องเพิ่งทำไปแล้ว mutation no-op แต่สถานะตรง expect อยู่แล้ว ห้ามนับสำเร็จ (push ซ้ำหาลูกค้า)
    let applied = false;
    dispatch((d) => { const now = d.repairClaims.find((c) => c.id === claim.id); applied = !!now && now !== before && now.status === expect; return d; });
    const failed = await store.flush();
    setBusy(false);
    if (!applied) return flash('เรื่องนี้เปลี่ยนสถานะไปแล้ว — รีเฟรชดู');
    if (failed) return flash(persistFailText(failed, 'บันทึกไม่สำเร็จ เช็คเน็ตแล้วลองใหม่'));
    after?.();
    flash(okText + (after && !hasBell ? ' · ลูกค้าไม่มีกระดิ่ง ทักเองด้วย' : ''));
  };
  const pushCustomer = (key: string, payload: { title: string; body: string; url: string }) => {
    if (!pushEnabled(db, key)) return;
    sendPush(subsForUsers(db, [claim.user_id]), payload, dispatch).catch(() => {});
  };

  const sendAddress = () => {
    if (!address.trim()) return flash('ใส่ที่อยู่ช่างก่อน');
    void run(() => dispatch(sendRepairAddress(claim.id, me, address, addrNote)), 'address_sent', 'ส่งที่อยู่ให้ลูกค้าแล้ว',
      () => pushCustomer(REPAIR_PUSH_ADDRESS, repairAddressPayload(label, ticketNo)));
  };
  const reject = () => {
    const why = prompt('เหตุผลที่ไม่รับเรื่อง (ลูกค้าจะเห็นข้อความนี้)');
    if (!why?.trim()) return;
    void run(() => dispatch(rejectRepairClaim(claim.id, me, why)), 'rejected', 'ปิดเรื่องแล้ว (ไม่รับ)',
      () => pushCustomer(REPAIR_PUSH_REJECT, repairRejectPayload(label, why.trim(), ticketNo)));
  };
  const outTracking = () => {
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (!no.trim()) return flash('ใส่เลขพัสดุก่อน');
    void run(() => dispatch(setRepairOutTracking(claim.id, carrier, no, me)), 'sent_to_tech', 'บันทึกแล้ว ของอยู่ที่ช่าง');
  };
  const backTracking = () => {
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (!no.trim()) return flash('ใส่เลขพัสดุก่อน');
    const c = carrier, n = no.trim();
    void run(() => dispatch(setRepairBackTracking(claim.id, me, c, n)), 'returned', 'แจ้งเลขส่งกลับแล้ว',
      () => pushCustomer(REPAIR_PUSH_RETURN, repairReturnPayload(label, CARRIER_NAME[c], n, ticketNo)));
  };
  const close = () => {
    if (!confirm(`ปิดเรื่องซ่อม ${ticketNo} — ลูกค้าได้รับของแล้ว?`)) return;
    void run(() => dispatch(markRepairReceived(claim.id, me)), 'done', 'ปิดเรื่องแล้ว');
  };
  // โน้ตที่อีกเครื่องเพิ่งเซฟ → อัปเดตช่องนี้ด้วย (ยกเว้นกำลังพิมพ์อยู่) ไม่งั้น blur ครั้งถัดไปเขียนของเก่าทับ
  const noteRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (document.activeElement !== noteRef.current) setNote(claim.admin_note ?? ''); }, [claim.admin_note]);
  const saveNote = async () => {
    if (busy) return;
    if ((claim.admin_note ?? '') === note.trim()) return;
    dispatch(setRepairNote(claim.id, note));
    const failed = await store.flush();
    if (failed) flash(persistFailText(failed, 'บันทึกโน้ตไม่สำเร็จ'));
  };

  // render function ไม่ใช่คอมโพเนนต์ลูก — ประกาศคอมโพเนนต์ในฟังก์ชันแล้ว re-render = remount ช่องพิมพ์หลุดโฟกัสทุกตัวอักษร (DNA react-state)
  const trackingForm = ({ title, cta, onGo }: { title: string; cta: string; onGo: () => void }) => (
    <div className="mt-3 rounded-xl border border-subtle bg-surface-3/60 p-3">
      <div className="text-[12px] font-semibold text-ink-muted">{title}</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {CARRIERS.map((c) => (
          <button key={c} onClick={() => setCarrier(c)} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', carrier === c ? 'border-accent bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{CARRIER_NAME[c]}</button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input className={cx(inputCls, 'font-mono')} value={no} onChange={(e) => setNo(e.target.value)} placeholder="เลขพัสดุ" />
        <button disabled={busy} onClick={onGo} className="shrink-0 rounded-lg bg-primary px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{cta}</button>
      </div>
    </div>
  );

  return (
    <div className={cx('rounded-card border bg-surface-2 p-4', claim.status === 'filed' ? 'border-[#b91c1c]/40' : 'border-subtle')}>
      {/* หัวการ์ด */}
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 text-left">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-subtle bg-surface-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img && <img src={img} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-bold', BADGE[claim.status])}>{REPAIR_STATUS_SHORT[claim.status]}</span>
            <span className="text-[11px] text-ink-faint">ยื่น {fmtTime(claim.filed_at)}</span>
          </div>
          <div className="mt-1 truncate text-[13.5px] font-bold text-ink">{label}</div>
          <div className="text-[12px] text-ink-muted2">
            {user?.display_name ?? '—'}{user?.member_code ? ` · ${user.member_code}` : ''}{user?.phone ? ` · ${user.phone}` : ''} · <span className="font-mono">{ticketNo}</span>
          </div>
        </div>
        <Icon name="chevronRight" size={16} className={cx('mt-1 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="mt-3 border-t border-subtle pt-3">
          <div className="whitespace-pre-wrap text-[13px] text-ink">{claim.description || <span className="text-ink-faint">ไม่ได้ระบุอาการ</span>}</div>
          {claim.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {claim.images.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="h-16 w-16 overflow-hidden rounded-md border border-subtle">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-full w-full object-cover" />
                </a>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11.5px] text-ink-faint">
            ส่งของ {fmtDate(claim.shipped_out_at ?? ticket?.shipped_out_at)} · ยื่นได้ถึง {claim.deadline_at ? fmtDate(repairLastDay(claim.deadline_at)) : '—'}
            {claim.deadline_at && claim.filed_at >= claim.deadline_at && <span className="ml-1.5 font-bold text-[#f87171]">ยื่นเกินกำหนด</span>}
          </div>

          {/* ประวัติจังหวะที่ผ่านมา */}
          <div className="mt-2 flex flex-col gap-0.5 text-[12px] text-ink-muted2">
            {claim.address_sent_at && <div>📍 ส่งที่อยู่ช่าง {fmtTime(claim.address_sent_at)}{claim.address_note ? ` · ${claim.address_note}` : ''}</div>}
            {claim.out_sent_at && <div>📮 ลูกค้าส่งให้ช่าง {fmtTime(claim.out_sent_at)} · {claim.out_carrier ? CARRIER_NAME[claim.out_carrier] : ''} <span className="break-all font-mono">{claim.out_tracking}</span></div>}
            {claim.back_sent_at && <div>📦 ส่งคืนลูกค้า {fmtTime(claim.back_sent_at)} · {claim.back_carrier ? CARRIER_NAME[claim.back_carrier] : ''} <span className="break-all font-mono">{claim.back_tracking}</span></div>}
            {claim.received_at && <div className="text-[#4ade80]">✓ ลูกค้าได้รับของ {fmtTime(claim.received_at)}</div>}
            {claim.rejected_at && <div className="text-[#f87171]">✕ ไม่รับเรื่อง {fmtTime(claim.rejected_at)} — {claim.reject_reason}</div>}
          </div>

          {/* จังหวะของแอดมิน */}
          {claim.status === 'filed' && (
            <div className="mt-3 rounded-xl border border-subtle bg-surface-3/60 p-3">
              <div className="text-[12px] font-semibold text-ink-muted">ที่อยู่ช่างที่จะส่งให้ลูกค้า</div>
              <textarea className={cx(inputCls, 'mt-1.5 min-h-[80px]')} value={address} onChange={(e) => setAddressEdit(e.target.value)} placeholder="ยังไม่ตั้งค่าตั้งต้น — พิมพ์ที่อยู่ช่างตรงนี้" />
              <input className={cx(inputCls, 'mt-2')} value={addrNote} onChange={(e) => setAddrNote(e.target.value)} placeholder="ข้อความถึงลูกค้า (ไม่บังคับ)" />
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={reject} className="rounded-lg border border-subtle bg-surface-3 px-3.5 py-2 text-[12.5px] font-bold text-ink-muted2 disabled:opacity-50">ไม่รับเรื่อง</button>
                <button disabled={busy} onClick={sendAddress} className="flex-1 rounded-lg bg-primary px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{busy ? 'กำลังส่ง…' : '📍 ส่งที่อยู่ช่าง'}</button>
              </div>
            </div>
          )}
          {claim.status === 'address_sent' && (
            <>
              <div className="mt-3 rounded-xl border border-subtle bg-surface-3/60 p-3 text-[12px] text-ink-muted2">
                <div className="whitespace-pre-wrap text-ink">{claim.tech_address}</div>
                <button onClick={async () => flash((await copyText(claim.tech_address ?? '')) ? 'ก๊อปแล้ว' : 'ก๊อปไม่ได้ กดค้างเพื่อคัดลอกเอง')} className="mt-1 text-primary-soft underline">ก๊อปที่อยู่</button>
              </div>
              {trackingForm({ title: 'บันทึกเลขพัสดุแทนลูกค้า', cta: 'บันทึก', onGo: outTracking })}
              <button disabled={busy} onClick={reject} className="mt-2 text-[12px] text-ink-faint underline disabled:opacity-50">ไม่รับเรื่อง</button>
            </>
          )}
          {claim.status === 'sent_to_tech' && trackingForm({ title: 'เลขพัสดุส่งคืนลูกค้า', cta: '📦 แจ้งเลขส่งกลับ', onGo: backTracking })}
          {claim.status === 'returned' && (
            <button disabled={busy} onClick={close} className="mt-3 w-full rounded-lg border border-[#16a34a]/40 bg-[#16a34a]/[0.12] px-3.5 py-2 text-[12.5px] font-bold text-[#4ade80] disabled:opacity-50">✓ ปิดเรื่อง (ลูกค้าได้รับแล้ว)</button>
          )}

          <input ref={noteRef} className={cx(inputCls, 'mt-3 text-[12px]')} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => void saveNote()} placeholder="โน้ตแอดมิน" />
        </div>
      )}
    </div>
  );
}
