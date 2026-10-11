'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDispatch, useStore } from '@/state/DataProvider';
import { persistFailText } from '@/data/persistErrors';
import { approveRemainingPayment, rejectRemainingPayment, logActivity, rpOverDue } from '@/data/mutations';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import * as mk from '@/lib/market';
import { productLabel } from '@/domain/services/catalog';
import { pairItemsWithTickets, ticketPayer } from '@/domain/services/tickets';
import { marketQueue, effectiveStatus, sellerSlaLeft, isDirect, dealStatusLabel, depositGap } from '@/domain/services/market';
import type { Database, RemainingPayment, TicketTransfer } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { HoldButton, StubArt, slipSrc } from './MarketUi';
import { PayoutLine } from './PayoutPicker';

/**
 * คิวงานแอดมินของตลาดใบพรี — ย้ายออกจากหน้า /admin/market (2026-10-11) เพื่อใช้ซ้ำในแท็บ "🎮 ทดลองเล่น"
 * (คิวเดียวกันเป๊ะ แค่ข้อมูลเป็นของจำลอง · DNA shared preview) · ⚠ คอมโพเนนต์ลูกทุกตัวอยู่ระดับไฟล์ (DNA react-state)
 */
type Flash = (m: string) => void;
export const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const who = (db: Database, id?: string) => {
  const u = db.users.find((x) => x.id === id);
  return u ? `${u.display_name}${u.member_code ? ` · ${u.member_code}` : ''}` : '—';
};

// ── งานรอ ──────────────────────────────────────────────────────────────────────
export function QueueTab({ db, flash }: { db: Database; flash: Flash }) {
  const q = marketQueue(db);
  const groups: { title: string; hint: string; rows: TicketTransfer[] }[] = [
    { title: '✅ พร้อมโอนสิทธิ์', hint: 'คนขายยืนยันรับเงินแล้ว — ตรวจเช็คลิสต์แล้วกดค้าง', rows: q.ready },
    { title: '🔎 รอตรวจสอบ', hint: 'คนขายแจ้งไม่ได้รับเงิน / เงียบเกินเวลา — ขอหลักฐานสองฝั่งแล้วตัดสิน', rows: q.reviewing },
    { title: '⏰ คนขายเงียบเกิน 12 ชม.', hint: 'ผู้ซื้อโอนแล้ว — เตือน/โทรหาคนขาย หรือส่งเข้าตรวจสอบ', rows: q.overdue },
    { title: '⏳ รอคนขายเช็คเงิน', hint: 'ยังอยู่ในเวลา 12 ชม.', rows: q.waiting },
    { title: '📨 ข้อเสนอเปลี่ยนใบ · รอผู้รับ', hint: 'ส่งแล้ว ผู้รับมี 24 ชม. โอน/กดรับ — ไม่ต้องทำอะไร แค่รู้ไว้ (ยกเลิกได้ถ้าจำเป็น)', rows: q.offers },
  ];
  if (groups.every((g) => g.rows.length === 0) && q.topups.length === 0 && q.lateSlips.length === 0) {
    return <div className="rounded-2xl border border-dashed border-white/10 px-4 py-12 text-center text-[13px] text-ink-muted2">ไม่มีดีลที่ต้องจัดการตอนนี้ ✓</div>;
  }
  return (
    <div className="flex flex-col gap-5">
      {q.lateSlips.length > 0 && (
        <div>
          <div className="mb-2"><span className="text-[14px] font-bold">⚠️ โอนเงินแล้วแต่ดีลปิดไปก่อน · ต้องเคลียร์คืนเงิน</span> <span className="text-[12px] text-ink-faint">· คนส่งถอน/หมดเวลา/ตั๋วเปลี่ยน/ร้านยกเลิก หลังผู้ซื้อ·ผู้รับโอนเงิน — ติดต่อคนขาย·คนส่งให้คืนเงิน แล้วกดปิดเรื่องพร้อมโน้ต</span></div>
          <div className="grid gap-3 lg:grid-cols-2">{q.lateSlips.map((tr) => <LateSlipCard key={tr.id} db={db} tr={tr} flash={flash} />)}</div>
        </div>
      )}
      {q.topups.length > 0 && (
        <div>
          <div className="mb-2"><span className="text-[14px] font-bold">💰 เติมมัดจำ · รอตรวจสลิป</span> <span className="text-[12px] text-ink-faint">· ลูกค้าเติมมัดจำให้ครบก่อนเปลี่ยนใบ/ลงขาย — เงินเข้าร้าน หักจากส่วนต่าง (ไม่ใช่งวดปิดใบ)</span></div>
          <div className="grid gap-3 lg:grid-cols-2">{q.topups.map((r) => <TopupCard key={r.id} db={db} rp={r} flash={flash} />)}</div>
        </div>
      )}
      {groups.filter((g) => g.rows.length > 0).map((g) => (
        <div key={g.title}>
          <div className="mb-2"><span className="text-[14px] font-bold">{g.title}</span> <span className="text-[12px] text-ink-faint">· {g.hint}</span></div>
          <div className="grid gap-3 lg:grid-cols-2">{g.rows.map((tr) => <DealAdminCard key={tr.id} db={db} tr={tr} flash={flash} />)}</div>
        </div>
      ))}
    </div>
  );
}

/** ผู้รับโอนเงินแล้วแต่ดีลปิดไปก่อน (v75 · audit รอบ B R1-01) — เงินอยู่กับคนส่ง ร้านไม่ได้ถือเงิน: แอดมินติดต่อให้คืน แล้วปิดเรื่อง
 *  ไม่ย้ายตั๋ว ไม่เปิดดีลใหม่ (ถ้าจะเปลี่ยนใบกันจริง ให้คนส่งส่งข้อเสนอใหม่) */
function LateSlipCard({ db, tr, flash }: { db: Database; tr: TicketTransfer; flash: Flash }) {
  const store = useStore(); // ทดลองเล่น = store จำลองในกรอบ · หน้าจริง = store ตัวจริง
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const t = db.tickets.find((x) => x.id === tr.ticket_id);
  const safeSlip = tr.slip_url && /^https?:\/\//i.test(tr.slip_url) ? tr.slip_url : null;
  const resolve = async () => {
    if (busy || !note.trim()) return;
    setBusy(true);
    const r = await mk.marketLateSlipResolve(tr.id, note.trim());
    setBusy(false);
    if (!r.ok) return flash(mk.marketErrText(r));
    const fresh = await store.reload();
    flash(fresh ? 'ปิดเรื่องแล้ว ✓' : 'ปิดเรื่องแล้ว ✓ · ⚠ โหลดข้อมูลใหม่ไม่สำเร็จ รีเฟรชหน้า');
  };
  return (
    <div className="rounded-2xl border border-[#fbbf24]/40 bg-surface-2 p-4">
      <div className="flex gap-3">
        {safeSlip ? <a href={safeSlip} target="_blank" rel="noreferrer" className="shrink-0"><img src={safeSlip} alt="สลิป" className="h-20 w-14 rounded-lg bg-white object-cover" /></a> : <div className="grid h-20 w-14 shrink-0 place-items-center rounded-lg bg-stripe"><Icon name="copy" size={16} className="text-ink-faint" /></div>}
        <div className="min-w-0 flex-1 text-[12.5px]">
          <div className="truncate text-[13.5px] font-bold">{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : '—'}</div>
          <div className="font-mono text-[11px] text-primary-soft">{t?.ticket_no ?? tr.ticket_id}</div>
          <div className="mt-1">{isDirect(tr) ? 'ผู้รับ' : 'ผู้ซื้อ'} <b>{who(db, tr.to_user_id)}</b> โอน <b className="font-mono">{baht(tr.asking_price)}</b> ให้ <b>{who(db, tr.from_user_id)}</b> · {fmt(tr.paid_at)}</div>
          <div className="text-ink-faint">ดีล{dealStatusLabel(tr, effectiveStatus(tr))}{tr.cancel_reason ? ` (${tr.cancel_reason === 'seller' ? `คนส่งถอน${tr.cancel_note ? ` · “${tr.cancel_note}”` : ''}` : tr.cancel_reason === 'ticket_changed' ? 'ตั๋วเปลี่ยนระหว่างดีล' : tr.cancel_reason === 'buyer_declined' ? 'ผู้รับกดไม่รับ' : tr.cancel_reason.replace(/^admin: /, '')})` : ''}</div>
        </div>
      </div>
      <input id={`late-${tr.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="โน้ตปิดเรื่อง เช่น คนส่งคืนเงินแล้ว แนบสลิปคืนทางไลน์" className="mt-3 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none" />
      <button type="button" disabled={busy || !note.trim()} onClick={() => void resolve()} className="mt-2 w-full rounded-lg bg-success py-2 text-[13px] font-bold text-white disabled:opacity-50">เคลียร์แล้ว · ปิดเรื่อง</button>
    </div>
  );
}

/** สลิปเติมมัดจำ 1 ใบ (เจ้าของ 2026-10-02 ข้อ 2.2: แยกหัวข้อจากสลิปส่วนต่างปกติ) — อนุมัติ = เข้า remaining_paid เหมือนสลิปส่วนต่าง
 *  (approveRemainingPayment ข้ามโบนัสยศให้แล้วเพราะ purpose=topup) · ปฏิเสธ = ลบแถว ลูกค้าส่งใหม่ได้ */
function TopupCard({ db, rp, flash }: { db: Database; rp: RemainingPayment; flash: Flash }) {
  const store = useStore(); // ทดลองเล่น = store จำลองในกรอบ · หน้าจริง = store ตัวจริง
  const dispatch = useDispatch();
  const adminId = useCurrentUserId();
  const [busy, setBusy] = useState(false);
  const t = db.tickets.find((x) => x.id === rp.ticket_id);
  const u = db.users.find((x) => x.id === rp.user_id);
  const act = async (approve: boolean) => {
    if (busy) return;
    if (!approve && !window.confirm(`ปฏิเสธสลิปเติมมัดจำ ${baht(rp.amount)} ของ ${u?.display_name ?? ''}?\nลูกค้าจะต้องส่งสลิปใหม่`)) return;
    setBusy(true);
    try {
      // เช็คสถานะล่าสุดจากเซิร์ฟเวอร์ก่อน (audit รอบ C R1-25): เครื่องที่เปิดค้างไว้ อาจยังเห็นสลิปที่อีกเครื่องอนุมัติ/ปฏิเสธไปแล้ว
      //   เดิมกดปฏิเสธ = ลบแถวที่อนุมัติแล้ว (เงินเข้าตั๋วแล้วแต่หลักฐานหาย) · กดอนุมัติ = สลิปที่ถูกปฏิเสธกลับมาเป็นเงินเข้า
      if (!(await store.reload({ safe: true }))) return flash(store.reloadFailText('ลองใหม่ (ยังไม่ได้ทำอะไร)'));
      const cur = store.getState().remainingPayments.find((r) => r.id === rp.id);
      if (!cur || cur.status !== 'pending') return flash('สลิปนี้ถูกจัดการไปแล้ว (อีกเครื่อง/แท็บ) — ดูสถานะล่าสุดในหน้านี้');
      dispatch(approve ? approveRemainingPayment(rp.id) : rejectRemainingPayment(rp.id));
      let changed = false;
      dispatch((d) => { const x = d.remainingPayments.find((r) => r.id === rp.id); changed = approve ? x?.status === 'approved' : !x; return d; });
      if (!changed) {
        const over = approve ? rpOverDue(store.getState(), rp) : 0;
        return flash(over > 0 ? `อนุมัติไม่ได้ — ยอดสลิปเกินยอดค้างของตั๋ว ${baht(over)} · ปฏิเสธแล้วให้ลูกค้าส่งใหม่ตามยอดจริง` : 'รายการนี้ถูกจัดการไปแล้ว (อีกเครื่อง/แท็บ) — รีเฟรชหน้าเช็คอีกที');
      }
      // ผู้กระทำ = แอดมินที่กดจริง (R1-26: เดิมบันทึก 'admin' ตรงๆ ประวัติขึ้น "ไม่ทราบชื่อ")
      dispatch(logActivity(adminId, approve ? 'approve_topup' : 'reject_topup', `${approve ? 'อนุมัติ' : 'ปฏิเสธ'}สลิปเติมมัดจำ ${t?.ticket_no ?? rp.ticket_id} · ${baht(rp.amount)} (${u?.display_name ?? ''})`, { targetId: rp.ticket_id, targetLabel: t?.ticket_no, amount: rp.amount }));
      const failed = await store.flush();
      if (failed) return flash(persistFailText(failed, 'ทำแล้วในเครื่องนี้ แต่ยังบันทึกไม่ขึ้น — ระบบลองใหม่ให้เอง ❗ห้ามกดซ้ำ'));
      const url = t ? `/wallet/${encodeURIComponent(t.ticket_no)}` : '/wallet';
      if (approve) {
        // ครบจริงไหมดูจากตั๋วหลังอนุมัติ (R1-24: เดิมบอก "มัดจำครบแล้ว" เสมอ)
        const after = store.getState().tickets.find((x) => x.id === rp.ticket_id);
        const left = after ? depositGap(store.getState(), after) : 0;
        if (pushEnabled(db, 'rp_approved'))
          sendPush(subsForUsers(db, [rp.user_id]), left > 0
            ? { title: '💚 รับยอดเติมมัดจำแล้ว', body: `${t?.ticket_no ?? ''} ยังขาดอีก ${baht(left)} — เปิดตั๋วเพื่อเติมส่วนที่เหลือ`, url }
            : { title: '💚 รับยอดเติมมัดจำแล้ว', body: `${t?.ticket_no ?? ''} มัดจำครบแล้ว — กลับไปเปลี่ยนใบ/ลงขายได้เลย`, url }, dispatch).catch(() => {});
        flash(`รับยอดเติมมัดจำ ${baht(rp.amount)} แล้ว ✓${left > 0 ? ` · ยังขาดอีก ${baht(left)}` : ''}`);
      } else {
        // ปฏิเสธต้องบอกลูกค้า (R1-24: เดิมเงียบ ลูกค้ารอเก้อ)
        if (pushEnabled(db, 'order_rejected'))
          sendPush(subsForUsers(db, [rp.user_id]), { title: '❌ สลิปเติมมัดจำไม่ผ่าน', body: `${t?.ticket_no ?? ''} — ยอด/สลิปไม่ถูกต้อง เปิดตั๋วแล้วส่งสลิปเติมมัดจำใหม่ได้เลย`, url }, dispatch).catch(() => {});
        flash('ปฏิเสธสลิปแล้ว · แจ้งลูกค้าให้ส่งใหม่');
      }
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-2xl border border-[#8b5cf6]/40 bg-surface-2 p-4">
      <div className="flex gap-3">
        {rp.slip_url && /^https?:|^data:/.test(rp.slip_url)
          ? <a href={rp.slip_url} target="_blank" rel="noreferrer" className="shrink-0"><img src={rp.slip_url} alt="สลิป" className="h-20 w-14 rounded-lg bg-white object-cover" /></a>
          : <div className="grid h-20 w-14 shrink-0 place-items-center rounded-lg bg-stripe"><Icon name="copy" size={16} className="text-ink-faint" /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-bold">
            <span className="rounded-md bg-[#8b5cf6]/[0.18] px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#c4b5fd]">เติมมัดจำ</span>
            <Link href={`/admin/customers/${rp.user_id}`} className="underline decoration-white/20">{who(db, rp.user_id)}</Link>
          </div>
          <div className="mt-0.5 truncate text-[12.5px]">{t ? productLabel(db, t.product_id, t.variant_id) : '—'}</div>
          <div className="font-mono text-[11px] text-primary-soft">{t?.ticket_no ?? rp.ticket_id}</div>
          <div className="mt-1 text-[12px]"><span className="text-ink-faint">ยอดเติม</span> <b className="font-mono text-[15px]">{baht(rp.amount)}</b> <span className="text-ink-faint">· ส่งเมื่อ {fmt(rp.created_at)}</span></div>
          {t && <div className="text-[11.5px] text-ink-faint">มัดจำตอนนี้ {baht(t.deposit_paid)} + จ่ายแล้ว {baht(t.remaining_paid)} · ค้าง {baht(Math.max(0, t.remaining_amount - t.remaining_paid))} → หลังอนุมัติค้าง {baht(Math.max(0, t.remaining_amount - t.remaining_paid - rp.amount))}</div>}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void act(true)} className="flex-1 rounded-lg bg-success py-2 text-[13px] font-bold text-white disabled:opacity-50">Approve · รับยอดเติมมัดจำ</button>
        <button type="button" disabled={busy} onClick={() => void act(false)} className="rounded-lg border border-[#f87171]/40 px-3 py-2 text-[13px] font-bold text-[#f87171] disabled:opacity-50">ปฏิเสธ</button>
      </div>
    </div>
  );
}

/** หารายการในออเดอร์ของคนสั่งที่ตั๋วใบนี้เกิดมา — ส่งให้ RPC สำหรับตั๋วรุ่นเก่า (id ไม่ผูกรายการ) กันตัวกู้ตั๋วฝั่งคนขายเสกคืน */
function orderItemIdFor(db: Database, ticketId: string): string | undefined {
  const t = db.tickets.find((x) => x.id === ticketId);
  if (!t || t.id.startsWith('t-') || t.split_from) return undefined;
  const used = new Set<string>();
  for (const o of db.orders.filter((x) => x.user_id === ticketPayer(t) && x.status === 'approved')) {
    const hit = pairItemsWithTickets(db.tickets, o.user_id, o.items.filter((i) => i.qty > 0), used).find((p) => p.ticket?.id === t.id);
    if (hit) return hit.item.id;
  }
  return undefined;
}

function DealAdminCard({ db, tr, flash }: { db: Database; tr: TicketTransfer; flash: Flash }) {
  const store = useStore(); // ทดลองเล่น = store จำลองในกรอบ · หน้าจริง = store ตัวจริง
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const st = effectiveStatus(tr);
  const direct = isDirect(tr);
  const free = direct && (tr.asking_price ?? 0) <= 0;
  const t = db.tickets.find((x) => x.id === tr.ticket_id);
  const buyer = db.users.find((x) => x.id === tr.to_user_id);
  const sla = sellerSlaLeft(tr);
  const buyerWord = direct ? 'ผู้รับ' : 'ผู้ซื้อ';
  // เบอร์/ที่อยู่ซ้ำ: เทียบแบบตัดช่องว่าง/ขีด (audit รอบ E R1-42: เดิมเทียบตรงตัว + ข้อความเป็นบวกเสมอแม้ติดธงแดง)
  const normPhone = (v?: string) => (v ?? '').replace(/\D/g, '').slice(-9);
  const normAddr = (v?: string) => (v ?? '').replace(/\s+/g, '').toLowerCase();
  const sender = db.users.find((x) => x.id === tr.from_user_id);
  const samePhone = !!(buyer && sender && normPhone(sender.phone) && normPhone(sender.phone) === normPhone(buyer.phone));
  const sameAddr = !!(buyer && sender && normAddr(sender.shipping_address) && normAddr(sender.shipping_address) === normAddr(buyer.shipping_address));
  const sellerWord = direct ? 'คนส่ง' : 'คนขาย';
  const monthAgo = Date.now() - 30 * 86_400_000;
  const senderWithdrawals = db.transfers.filter((x) => x.id !== tr.id && x.from_user_id === tr.from_user_id && isDirect(x) && x.status === 'cancelled'
    && x.cancel_reason === 'seller' && new Date(x.cancelled_at ?? x.updated_at ?? x.listed_at).getTime() > monthAgo).length;
  const checks: { ok: boolean; label: string }[] = [
    { ok: !!tr.seller_confirmed_at, label: tr.seller_confirmed_at ? `${sellerWord}ยืนยัน${free ? 'แล้ว' : 'รับเงินแล้ว'} · ${fmt(tr.seller_confirmed_at)}` : `${sellerWord}ยังไม่ยืนยัน${free ? '' : 'รับเงิน'}` },
    free
      ? { ok: !!tr.paid_at, label: tr.paid_at ? `ยกให้ฟรี · ผู้รับกดรับแล้ว · ${fmt(tr.paid_at)}` : 'ยกให้ฟรี · ผู้รับยังไม่กดรับ' }
      : { ok: !!tr.slip_url, label: tr.slip_url ? `${buyerWord}แนบสลิปแล้ว · ${fmt(tr.paid_at)}` : 'ยังไม่มีสลิป' },
    { ok: !!t && t.owner_id === tr.from_user_id, label: t ? (t.owner_id === tr.from_user_id ? `ตั๋วยังอยู่กับ${sellerWord}` : 'ตั๋วเปลี่ยนเจ้าของไปแล้ว!') : 'ไม่พบตั๋ว' },
    { ok: !!t && !t.delivery && t.status !== 'shipped', label: 'ยังไม่เลือกวิธีรับของ / ยังไม่ส่ง' },
    { ok: !!t && (tr.qty ?? t.qty) <= t.qty, label: `${direct ? 'เปลี่ยน' : 'ขาย'} ${tr.qty ?? t?.qty ?? 1} จาก ${t?.qty ?? '?'} ชิ้น${t && (tr.qty ?? t.qty) < t.qty ? ' (แตกตั๋วลูกให้' + buyerWord + ')' : ''}` },
    ...(direct ? [
      { ok: !!buyer && !!(buyer.shipping_address ?? '').trim(), label: buyer ? ((buyer.shipping_address ?? '').trim() ? `${buyerWord}มีที่อยู่จัดส่ง ✓` : `${buyerWord}ยังไม่มีที่อยู่จัดส่ง!`) : `ไม่พบ${buyerWord}` },
      { ok: !samePhone && !sameAddr, label: samePhone || sameAddr ? `ผู้รับกับคนส่งใช้${samePhone ? 'เบอร์' : ''}${samePhone && sameAddr ? '/' : ''}${sameAddr ? 'ที่อยู่' : ''}เดียวกัน — เช็คว่าไม่ใช่คนเดียวกัน` : 'ผู้รับกับคนส่งไม่ได้ใช้เบอร์/ที่อยู่เดียวกัน' },
    ] : []),
  ];
  const act = async (fn: () => Promise<mk.MarketRes>, okMsg: string, after?: (r: mk.MarketRes) => void) => {
    if (busy) return;
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    // ต้องได้ข้อมูลใหม่จริงหลัง RPC (audit รอบ A R2A-01 ทาง c): เดิมโหลดพลาดเงียบ แท็บนี้ยังถือตั๋วรุ่นก่อนไฟนอล
    //   แล้วงานถัดไปบนแท็บนี้เขียนทับผลไฟนอล — ตอนนี้เซิร์ฟเวอร์ (v74) ปฏิเสธแล้ว แต่ต้องบอกแอดมินให้รีเฟรช
    const fresh = await store.reload();
    after?.(r);
    flash(fresh ? okMsg : `${okMsg} · ⚠ โหลดข้อมูลใหม่ไม่สำเร็จ รีเฟรชหน้าก่อนทำอย่างอื่น`);
  };
  const finalize = () => act(() => mk.marketFinalize(tr.id, orderItemIdFor(db, tr.ticket_id)), `โอนสิทธิ์แล้ว ✓ ใบเข้ากระเป๋า${buyerWord}`, () => {
    void mk.marketPush(tr.id, 'done'); void mk.marketPush(tr.id, 'sold');
  });
  // บัญชีที่ล็อกกับดีลอยู่ในตารางลับ (v76 · R1-10) — แอดมินอ่านผ่าน RPC เดียวกับลูกค้า
  const [pay, setPay] = useState<mk.MarketRes | null>(null);
  useEffect(() => { if (!free) void mk.marketPayout(tr.id).then(setPay); }, [tr.id, free]);
  return (
    <div className={cx('rounded-2xl border bg-surface-2 p-4', st === 'seller_ok' || st === 'pending_admin' ? 'border-[#16a34a]/40' : st === 'reviewing' ? 'border-[#2563eb]/40' : direct ? 'border-[#f1d27a]/30' : 'border-subtle')}>
      <div className="flex gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl">{tr.product_id && <StubArt db={db} productId={tr.product_id} variantId={tr.variant_id} />}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {direct && <span className="shrink-0 rounded-md bg-[#f1d27a]/15 px-1.5 py-0.5 text-[10px] font-extrabold text-[#f1d27a]">🔁 เปลี่ยนใบ</span>}
            <span className="truncate text-[14px] font-bold">{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : '—'}</span>
          </div>
          <div className="font-mono text-[11px] text-primary-soft">{t?.ticket_no ?? tr.prev_ticket_no ?? tr.ticket_id}</div>
          <div className="mt-0.5 text-[12px]"><span className="text-ink-faint">{direct ? 'ยอดโอน' : 'ราคา'}</span> <b className="font-mono">{free ? 'ยกให้ฟรี' : baht(tr.asking_price)}</b> <span className="text-ink-faint">· ค้างร้าน {baht(tr.snap?.due ?? 0)}</span></div>
        </div>
        <span className="h-fit shrink-0 rounded-full border border-subtle px-2 py-0.5 text-[10.5px] font-bold text-ink-muted2">{dealStatusLabel(tr, st)}</span>
      </div>
      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <span className="text-ink-faint">{direct ? 'คนส่ง' : 'คนขาย'}</span><Link href={`/admin/customers/${tr.from_user_id}`} className="truncate underline decoration-white/20">{who(db, tr.from_user_id)}</Link>
        <span className="text-ink-faint">{buyerWord}</span>{tr.to_user_id ? <Link href={`/admin/customers/${tr.to_user_id}`} className="truncate underline decoration-white/20">{who(db, tr.to_user_id)}</Link> : <span>—</span>}
        {/* ก่อนรัน v76 RPC ยังไม่ให้แอดมินอ่าน → ใช้ช่องเดิมในตารางดีลแทน */}
        {pay?.ok && !pay.none
          ? <><span className="text-ink-faint">บัญชีรับเงิน</span><PayoutLine info={pay} full size={16} /></>
          : tr.payout_snap ? <><span className="text-ink-faint">บัญชีรับเงิน</span><PayoutLine info={tr.payout_snap} full size={16} /></> : null}
        {direct && st === 'reserved' && tr.hold_until && <><span className="text-ink-faint">ผู้รับต้องตอบใน</span><span>{fmt(tr.hold_until)}</span></>}
        {/* กันเกรียน (v79): คนส่งที่ถอนข้อเสนอบ่อย — ร้านเห็นทันทีในการ์ด */}
        {direct && senderWithdrawals > 0 && <><span className="text-ink-faint">คนส่งเคยถอน</span><span className={senderWithdrawals >= 3 ? 'font-bold text-[#f87171]' : ''}>{senderWithdrawals} ครั้งใน 30 วัน</span></>}
        {st === 'paid' && Number.isFinite(sla) && <><span className="text-ink-faint">เวลา{sellerWord}</span><span className={sla <= 0 ? 'font-bold text-[#f87171]' : ''}>{sla > 0 ? `เหลือ ${Math.ceil(sla / 3_600_000)} ชม.` : `เกินมา ${Math.ceil(-sla / 3_600_000)} ชม.`}</span></>}
        {tr.review_reason && <><span className="text-ink-faint">ตรวจสอบเพราะ</span><span>{tr.review_reason === 'not_received' ? 'คนขายแจ้งไม่ได้รับเงิน' : tr.review_reason === 'seller_silent' ? 'คนขายเงียบเกินเวลา' : 'แอดมินส่งเข้าตรวจ'}{tr.review_note ? ` — “${tr.review_note}”` : ''}</span></>}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {/* เฉพาะลิงก์ http(s) / รูปในหน้าเว็บ — กันค่าแปลกๆ (javascript:) ที่ลูกค้ายิง RPC ตรงเข้ามา (audit รอบ B R1-16) */}
        {slipSrc(tr.slip_url) && <a href={tr.slip_url} target="_blank" rel="noreferrer" className="shrink-0 text-center text-[10.5px] text-ink-faint"><img src={tr.slip_url} alt="สลิป" className="h-24 w-[68px] rounded-lg bg-white object-cover" />สลิป{buyerWord}</a>}
        {(tr.review_evidence ?? []).filter((u) => /^https?:\/\//i.test(u)).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="shrink-0 text-center text-[10.5px] text-ink-faint"><img src={u} alt="หลักฐาน" className="h-24 w-[68px] rounded-lg bg-white object-cover" />หลักฐานคนขาย</a>)}
      </div>
      {st !== 'reserved' && (
        <ul className="mt-3 space-y-1">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-[12px]">
              <span className={cx('mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-extrabold', c.ok ? 'bg-[#16a34a]/20 text-[#4ade80]' : 'bg-[#b91c1c]/25 text-[#f87171]')}>{c.ok ? '✓' : '!'}</span>
              <span className={c.ok ? 'text-ink-muted2' : 'text-[#f87171]'}>{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      {t && st !== 'reserved' && (
        <div className="mt-2 rounded-lg bg-surface-3 px-3 py-2 text-[11.5px] text-ink-muted2">
          กดแล้ว: ผู้ถือ → {buyerWord} · เลข <span className="font-mono">{t.ticket_no}</span> → <span className="font-mono text-[#4ade80]">…-T{1 + Math.max(0, ...db.tickets.filter((x) => x.ticket_no.startsWith(t.ticket_no.replace(/-T\d+$/, '') + '-T')).map((x) => parseInt(x.ticket_no.split('-T').pop() ?? '0', 10) || 0))}</span> · มัดจำอยู่บนใบเดิม เงินร้านไม่ขยับ · แต้มปิดใบไปที่คนปิดยอด
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {(st === 'seller_ok' || st === 'pending_admin' || st === 'reviewing' || st === 'paid') && (
          <HoldButton label={st === 'seller_ok' || st === 'pending_admin' ? 'กดค้างเพื่อโอนสิทธิ์' : free ? 'กดค้าง: ยืนยันแทนคนส่ง → โอนสิทธิ์' : 'กดค้าง: ยืนยันว่าเงินเข้าจริง → โอนสิทธิ์'} busyLabel="กำลังโอนสิทธิ์…"
            disabled={busy || !t || t.owner_id !== tr.from_user_id} onConfirm={finalize} />
        )}
        <div className="flex flex-wrap gap-2">
          {st === 'paid' && !free && <button type="button" onClick={() => { void mk.marketPush(tr.id, 'remind'); flash('ส่ง push เตือนคนขายแล้ว (ส่งซ้ำได้ทุก 1 ชม.)'); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">⏰ เตือนคนขาย</button>}
          {(st === 'paid' || st === 'seller_ok' || st === 'pending_admin') && (
            <button type="button" onClick={() => void act(() => mk.marketEscalate(tr.id, 'แอดมินส่งเข้าตรวจ'), 'ส่งเข้าตรวจสอบแล้ว', () => { void mk.marketPush(tr.id, 'reviewing'); })} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">🔎 ส่งเข้าตรวจสอบ</button>
          )}
          {!cancelling && <button type="button" onClick={() => setCancelling(true)} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-[#f87171]">ยกเลิกดีล</button>}
        </div>
        {cancelling && (
          <div className="rounded-xl border border-[#b91c1c]/40 bg-[#b91c1c]/[0.08] p-3">
            <div className="text-[12px] text-ink-muted2">{free ? 'ยกให้ฟรี — ไม่มีเงินเปลี่ยนมือ' : tr.paid_at ? `${buyerWord}โอนไปแล้ว — ตามกติกา ${sellerWord}ต้องคืนเงินเอง + แนบสลิปคืน · ดีลจะย้ายไปคิว "เคลียร์คืนเงิน" จนกว่าจะปิดเรื่อง` : 'ยังไม่มีการโอนเงิน'}</div>
            <input id={`cancel-${tr.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผล (ลูกค้าจะเห็น)" className="mt-2 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none" />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setCancelling(false)} className="flex-1 rounded-lg border border-subtle py-2 text-[12.5px] font-bold text-ink-muted2">ไม่ยกเลิก</button>
              <button type="button" disabled={!reason.trim() || busy} onClick={() => void act(() => mk.marketAdminCancel(tr.id, reason.trim()), tr.paid_at && !free ? 'ยกเลิกดีลแล้ว · ย้ายไปคิว "เคลียร์คืนเงิน" ด้านบน' : 'ยกเลิกดีลแล้ว', () => { void mk.marketPush(tr.id, 'cancelled'); setCancelling(false); })}
                className="flex-1 rounded-lg bg-[#b91c1c] py-2 text-[12.5px] font-bold text-white disabled:opacity-50">ยืนยันยกเลิก</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
