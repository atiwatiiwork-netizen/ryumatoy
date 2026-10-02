'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { store } from '@/data/store';
import { setMarketPublic, setMarketDirect, approveRemainingPayment, rejectRemainingPayment, logActivity } from '@/data/mutations';
import { baht } from '@/lib/theme';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import * as mk from '@/lib/market';
import { productLabel } from '@/domain/services/catalog';
import { pairItemsWithTickets, ticketPayer } from '@/domain/services/tickets';
import { marketPublicEnabled, directEnabled, marketQueue, effectiveStatus, sellerSlaLeft, isDirect, dealStatusLabel, TRANSFER_STATUS_LABEL } from '@/domain/services/market';
import { bankOf, maskAccount } from '@/lib/thaiBanks';
import type { Database, RemainingPayment, TicketTransfer } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MarketBoard } from '@/components/market/MarketBoard';
import { MyDeals } from '@/components/market/MyDeals';
import { MarketDeal } from '@/components/market/MarketDeal';
import { WalletCodeChip } from '@/components/market/WalletCodeChip';
import { HoldButton, StubArt } from '@/components/market/MarketUi';
import { BankLogo } from '@/components/market/PayoutPicker';

/**
 * แอดมิน › ตลาดใบพรี (เฟส 1 · 2026-09-23) + "เปลี่ยนใบพรี" โอนตรง (v73 · 2026-10-02)
 * เจ้าของสั่ง: "อย่าเพิ่งให้ลูกค้าเห็น รอทุกอย่างพร้อมก่อน" → สวิตช์ 2 ตัวแยกกัน (ค่าเริ่ม = ปิดทั้งคู่)
 *   market_public = กระดาน · market_direct = เปลี่ยนใบด้วยเลขกระเป๋า — ปิดอยู่: ลูกค้าไม่เห็น และ server ไม่ให้ใช้
 *   แอดมินลองได้ครบทุกขั้นด้วย 2 บัญชีแอดมิน
 * คิวงาน: 💰 เติมมัดจำ แยกหัวข้อ (เจ้าของ 2026-10-02 ข้อ 2.2) · 📨 ข้อเสนอรอผู้รับ (ดูเฉยๆ) · ✅ พร้อมโอนสิทธิ์ · 🔎 ตรวจสอบ
 * แท็บ "ดูแบบลูกค้า" เรนเดอร์คอมโพเนนต์ตัวเดียวกับหน้าลูกค้า (DNA shared preview)
 * ⚠ คอมโพเนนต์ลูกทุกตัวอยู่ระดับไฟล์ (DNA react-state)
 */
type Tab = 'queue' | 'all' | 'preview';
type Flash = (m: string) => void;
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const who = (db: Database, id?: string) => {
  const u = db.users.find((x) => x.id === id);
  return u ? `${u.display_name}${u.member_code ? ` · ${u.member_code}` : ''}` : '—';
};

export default function AdminMarketPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [tab, setTab] = useState<Tab>('queue');
  const [probe, setProbe] = useState<'ok' | 'no_v72' | 'no_rpc' | 'no_server' | null>(null);
  const [probe73, setProbe73] = useState<'ok' | 'no_v73' | null>(null);
  useEffect(() => {
    void mk.marketFeed().then((r) => setProbe(r.error === 'no_server' ? 'no_server' : mk.isMissingRpc(r) ? 'no_rpc' : r.ok && r.closed === undefined ? 'no_v72' : 'ok'));
    void mk.walletCode().then((r) => setProbe73(r.error === 'no_server' ? null : mk.isMissingRpc(r) ? 'no_v73' : 'ok'));
  }, []);
  const isPublic = marketPublicEnabled(db);
  const isDirectOn = directEnabled(db);
  const q = marketQueue(db);

  const toggle = async () => {
    if (!isPublic) {
      const ok = window.confirm('เปิดตลาดใบพรี (กระดาน) ให้ลูกค้าทุกคนเห็นเลยไหม?\n\n• แท็บ "ตลาด" ขึ้นที่เมนูล่างของทุกคน\n• ลูกค้าลงขาย/จองได้ทันที\n• มีคนลงขาย = push หาทุกคน (ยกเว้นคนที่ปิดค่าย/เรื่องนั้น)\n\nลองครบทุกขั้นกับบัญชีแอดมินแล้วค่อยเปิด');
      if (!ok) return;
    }
    dispatch(setMarketPublic(!isPublic));
    if (await store.flush()) { flash('บันทึกสวิตช์ไม่สำเร็จ — ลองใหม่'); return; }
    flash(isPublic ? 'ปิดกระดานจากฝั่งลูกค้าแล้ว' : 'เปิดกระดานให้ลูกค้าเห็นแล้ว 🎉');
  };
  const toggleDirect = async () => {
    if (!isDirectOn) {
      const ok = window.confirm('เปิด "เปลี่ยนใบพรี" ให้ลูกค้าทุกคนเลยไหม?\n\n• ทุกคนเห็นเลขกระเป๋า 4 หลักที่หัวหน้ากระเป๋าพรี\n• ปุ่ม "เปลี่ยนใบพรี" ขึ้นในหน้าใบพรีทุกใบที่เข้าเกณฑ์\n• ส่งข้อเสนอ = push ถึงผู้รับทันที\n\nเช็คลิสต์ก่อนเปิด: แก้ RLS tickets_own + กติกาแต้ม (เฟส 2) แล้วหรือยัง?');
      if (!ok) return;
    }
    dispatch(setMarketDirect(!isDirectOn));
    if (await store.flush()) { flash('บันทึกสวิตช์ไม่สำเร็จ — ลองใหม่'); return; }
    flash(isDirectOn ? 'ปิด "เปลี่ยนใบพรี" จากฝั่งลูกค้าแล้ว' : 'เปิด "เปลี่ยนใบพรี" ให้ลูกค้าแล้ว 🎉');
  };

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'queue', label: 'งานรอ', badge: q.jobs },
    { key: 'all', label: `ดีลทั้งหมด (${db.transfers.length})` },
    { key: 'preview', label: '👀 ดูแบบลูกค้า' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold">ตลาดใบพรี · เปลี่ยนใบพรี</h1>
          <p className="text-[12.5px] text-ink-muted">ผู้ซื้อ/ผู้รับโอนตรงถึงคนขาย → คนขายยืนยัน → ร้านกดค้างโอนสิทธิ์ · ย้ายเจ้าของตั๋วเดิม (เงินร้านไม่ขยับ)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void toggleDirect()}
            className={cx('rounded-lg border px-3.5 py-2 text-[12.5px] font-bold', isDirectOn ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted')}>
            🔁 เปลี่ยนใบพรี: {isDirectOn ? 'ลูกค้าใช้ได้ · กดเพื่อปิด' : '🔒 ยังปิด (แอดมินลองได้) · กดเพื่อเปิด'}
          </button>
          <button type="button" onClick={() => void toggle()}
            className={cx('rounded-lg border px-3.5 py-2 text-[12.5px] font-bold', isPublic ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted')}>
            🏷️ กระดาน: {isPublic ? 'ลูกค้าเห็นแล้ว · กดเพื่อปิด' : '🔒 ยังปิด · กดเพื่อเปิด'}
          </button>
        </div>
      </div>

      {probe && probe !== 'ok' && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          {probe === 'no_rpc' && <><b>ยังไม่ได้รัน migration ตลาด (v71/v72)</b> — หน้าจอดูได้ แต่ลงขาย/จองจริงไม่ได้</>}
          {probe === 'no_v72' && <><b>ยังไม่ได้รัน <code>migration_market_gate_v72.sql</code></b> — ตอนนี้ด่าน "ลูกค้าห้ามใช้" มีแค่การซ่อนหน้าจอ ยังไม่มีที่ฐานข้อมูล · push ยังส่งไม่ได้</>}
          {probe === 'no_server' && <>โหมดพรีวิว (ไม่ได้ต่อฐานข้อมูล) — กระดานว่างเสมอ ลองจริงต้องใช้เว็บจริง</>}
        </div>
      )}
      {probe73 === 'no_v73' && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          <b>ยังไม่ได้รัน <code>migration_direct_v73.sql</code></b> — "เปลี่ยนใบพรี" ยังใช้ไม่ได้: เลขกระเป๋าไม่ออก · ส่งข้อเสนอไม่ได้ · กระดานเดิมใช้ได้ตามปกติ
        </div>
      )}
      {!isDirectOn && (
        <div className="rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted2">
          <b className="text-ink">วิธีลอง "เปลี่ยนใบพรี" ก่อนเปิด (บัญชีแอดมิน 2 บัญชี):</b> ① บัญชี B เปิดกระเป๋าพรี → จดเลขกระเป๋า 4 หลัก (กล่องเหลืองบนสุด) ②
          บัญชี A เปิดใบพรีของตัวเอง → “เปลี่ยนใบพรี” → เลือก/เพิ่มบัญชีรับเงิน → ใส่ยอด → ใส่เลขของ B → ค้นหา → ส่งข้อเสนอ ③ B ได้ push → เปิดดีล → โอน + แนบสลิป (หรือกดรับถ้ายอด 0)
          ④ A กด “ได้รับเงินแล้ว” ⑤ กลับมาหน้านี้ กดค้าง “โอนสิทธิ์” → ใบย้ายไปกระเป๋า B พร้อมเลข -T1 · ใบที่มัดจำไม่เต็มจะให้เติมก่อน แล้วสลิปมาเข้าหัวข้อ 💰 ข้างล่าง
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-subtle pb-3">
        {TABS.map((t) => (
          <button type="button" key={t.key} onClick={() => setTab(t.key)}
            className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold', tab === t.key ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2 hover:text-ink')}>
            {t.label}
            {!!t.badge && <span className={cx('rounded-full px-[7px] text-[11px] font-extrabold', tab === t.key ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {tab === 'queue' && <QueueTab db={db} flash={flash} />}
      {tab === 'all' && <AllTab db={db} />}
      {tab === 'preview' && <PreviewTab />}
    </div>
  );
}

// ── งานรอ ──────────────────────────────────────────────────────────────────────
function QueueTab({ db, flash }: { db: Database; flash: Flash }) {
  const q = marketQueue(db);
  const groups: { title: string; hint: string; rows: TicketTransfer[] }[] = [
    { title: '✅ พร้อมโอนสิทธิ์', hint: 'คนขายยืนยันรับเงินแล้ว — ตรวจเช็คลิสต์แล้วกดค้าง', rows: q.ready },
    { title: '🔎 รอตรวจสอบ', hint: 'คนขายแจ้งไม่ได้รับเงิน / เงียบเกินเวลา — ขอหลักฐานสองฝั่งแล้วตัดสิน', rows: q.reviewing },
    { title: '⏰ คนขายเงียบเกิน 12 ชม.', hint: 'ผู้ซื้อโอนแล้ว — เตือน/โทรหาคนขาย หรือส่งเข้าตรวจสอบ', rows: q.overdue },
    { title: '⏳ รอคนขายเช็คเงิน', hint: 'ยังอยู่ในเวลา 12 ชม.', rows: q.waiting },
    { title: '📨 ข้อเสนอเปลี่ยนใบ · รอผู้รับ', hint: 'ส่งแล้ว ผู้รับมี 24 ชม. โอน/กดรับ — ไม่ต้องทำอะไร แค่รู้ไว้ (ยกเลิกได้ถ้าจำเป็น)', rows: q.offers },
  ];
  if (groups.every((g) => g.rows.length === 0) && q.topups.length === 0) {
    return <div className="rounded-2xl border border-dashed border-white/10 px-4 py-12 text-center text-[13px] text-ink-muted2">ไม่มีดีลที่ต้องจัดการตอนนี้ ✓</div>;
  }
  return (
    <div className="flex flex-col gap-5">
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

/** สลิปเติมมัดจำ 1 ใบ (เจ้าของ 2026-10-02 ข้อ 2.2: แยกหัวข้อจากสลิปส่วนต่างปกติ) — อนุมัติ = เข้า remaining_paid เหมือนสลิปส่วนต่าง
 *  (approveRemainingPayment ข้ามโบนัสยศให้แล้วเพราะ purpose=topup) · ปฏิเสธ = ลบแถว ลูกค้าส่งใหม่ได้ */
function TopupCard({ db, rp, flash }: { db: Database; rp: RemainingPayment; flash: Flash }) {
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  const t = db.tickets.find((x) => x.id === rp.ticket_id);
  const u = db.users.find((x) => x.id === rp.user_id);
  const act = async (approve: boolean) => {
    if (busy) return;
    if (!approve && !window.confirm(`ปฏิเสธสลิปเติมมัดจำ ${baht(rp.amount)} ของ ${u?.display_name ?? ''}?\nลูกค้าจะต้องส่งสลิปใหม่`)) return;
    setBusy(true);
    dispatch(approve ? approveRemainingPayment(rp.id) : rejectRemainingPayment(rp.id));
    let changed = false;
    dispatch((d) => { const x = d.remainingPayments.find((r) => r.id === rp.id); changed = approve ? x?.status === 'approved' : !x; return d; });
    if (!changed) { setBusy(false); return flash('รายการนี้ถูกจัดการไปแล้ว (อีกเครื่อง/แท็บ) — รีเฟรชหน้าเช็คอีกที'); }
    dispatch(logActivity('admin', approve ? 'approve_topup' : 'reject_topup', `${approve ? 'อนุมัติ' : 'ปฏิเสธ'}สลิปเติมมัดจำ ${t?.ticket_no ?? rp.ticket_id} · ${baht(rp.amount)} (${u?.display_name ?? ''})`, { targetId: rp.ticket_id, targetLabel: t?.ticket_no, amount: rp.amount }));
    const failed = await store.flush();
    setBusy(false);
    if (failed) return flash('ทำแล้วในเครื่องนี้ แต่ยังบันทึกไม่ขึ้น — ระบบลองใหม่ให้เอง ❗ห้ามกดซ้ำ');
    if (approve && pushEnabled(db, 'rp_approved'))
      sendPush(subsForUsers(db, [rp.user_id]), { title: '💚 รับยอดเติมมัดจำแล้ว', body: `${t?.ticket_no ?? ''} มัดจำครบแล้ว — กลับไปเปลี่ยนใบ/ลงขายได้เลย`, url: t ? `/wallet/${encodeURIComponent(t.ticket_no)}` : '/wallet' }, dispatch).catch(() => {});
    flash(approve ? `รับยอดเติมมัดจำ ${baht(rp.amount)} แล้ว ✓` : 'ปฏิเสธสลิปแล้ว');
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
  const checks: { ok: boolean; label: string }[] = [
    { ok: !!tr.seller_confirmed_at, label: tr.seller_confirmed_at ? `คนขายยืนยัน${free ? 'แล้ว' : 'รับเงินแล้ว'} · ${fmt(tr.seller_confirmed_at)}` : `คนขายยังไม่ยืนยัน${free ? '' : 'รับเงิน'}` },
    free
      ? { ok: !!tr.paid_at, label: tr.paid_at ? `ยกให้ฟรี · ผู้รับกดรับแล้ว · ${fmt(tr.paid_at)}` : 'ยกให้ฟรี · ผู้รับยังไม่กดรับ' }
      : { ok: !!tr.slip_url, label: tr.slip_url ? `${buyerWord}แนบสลิปแล้ว · ${fmt(tr.paid_at)}` : 'ยังไม่มีสลิป' },
    { ok: !!t && t.owner_id === tr.from_user_id, label: t ? (t.owner_id === tr.from_user_id ? 'ตั๋วยังอยู่กับคนขาย' : 'ตั๋วเปลี่ยนเจ้าของไปแล้ว!') : 'ไม่พบตั๋ว' },
    { ok: !!t && !t.delivery && t.status !== 'shipped', label: 'ยังไม่เลือกวิธีรับของ / ยังไม่ส่ง' },
    { ok: !!t && (tr.qty ?? t.qty) <= t.qty, label: `${direct ? 'เปลี่ยน' : 'ขาย'} ${tr.qty ?? t?.qty ?? 1} จาก ${t?.qty ?? '?'} ชิ้น${t && (tr.qty ?? t.qty) < t.qty ? ' (แตกตั๋วลูกให้' + buyerWord + ')' : ''}` },
    ...(direct ? [
      { ok: !!buyer && !!(buyer.shipping_address ?? '').trim(), label: buyer ? ((buyer.shipping_address ?? '').trim() ? `${buyerWord}มีที่อยู่จัดส่ง ✓` : `${buyerWord}ยังไม่มีที่อยู่จัดส่ง!`) : `ไม่พบ${buyerWord}` },
      { ok: !(buyer && db.users.find((x) => x.id === tr.from_user_id && ((x.phone && x.phone === buyer.phone) || (x.shipping_address && x.shipping_address === buyer.shipping_address)))), label: 'ผู้รับกับคนส่งไม่ได้ใช้เบอร์/ที่อยู่เดียวกัน' },
    ] : []),
  ];
  const act = async (fn: () => Promise<mk.MarketRes>, okMsg: string, after?: (r: mk.MarketRes) => void) => {
    if (busy) return;
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await store.reload();
    after?.(r);
    flash(okMsg);
  };
  const finalize = () => act(() => mk.marketFinalize(tr.id, orderItemIdFor(db, tr.ticket_id)), `โอนสิทธิ์แล้ว ✓ ใบเข้ากระเป๋า${buyerWord}`, () => {
    void mk.marketPush(tr.id, 'done'); void mk.marketPush(tr.id, 'sold');
  });
  const pay = tr.payout_snap;
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
        {pay && <><span className="text-ink-faint">บัญชีรับเงิน</span><span className="flex items-center gap-1.5 truncate"><BankLogo code={pay.account_no ? pay.bank : 'promptpay'} size={16} />{pay.promptpay ? `พร้อมเพย์ ${pay.promptpay}` : `${bankOf(pay.bank).name} ${maskAccount(pay.account_no)}`} · {pay.account_name}</span></>}
        {direct && st === 'reserved' && tr.hold_until && <><span className="text-ink-faint">ผู้รับต้องตอบใน</span><span>{fmt(tr.hold_until)}</span></>}
        {st === 'paid' && Number.isFinite(sla) && <><span className="text-ink-faint">เวลาคนขาย</span><span className={sla <= 0 ? 'font-bold text-[#f87171]' : ''}>{sla > 0 ? `เหลือ ${Math.ceil(sla / 3_600_000)} ชม.` : `เกินมา ${Math.ceil(-sla / 3_600_000)} ชม.`}</span></>}
        {tr.review_reason && <><span className="text-ink-faint">ตรวจสอบเพราะ</span><span>{tr.review_reason === 'not_received' ? 'คนขายแจ้งไม่ได้รับเงิน' : tr.review_reason === 'seller_silent' ? 'คนขายเงียบเกินเวลา' : 'แอดมินส่งเข้าตรวจ'}{tr.review_note ? ` — “${tr.review_note}”` : ''}</span></>}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {tr.slip_url && <a href={tr.slip_url} target="_blank" rel="noreferrer" className="shrink-0 text-center text-[10.5px] text-ink-faint"><img src={tr.slip_url} alt="สลิป" className="h-24 w-[68px] rounded-lg bg-white object-cover" />สลิป{buyerWord}</a>}
        {(tr.review_evidence ?? []).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="shrink-0 text-center text-[10.5px] text-ink-faint"><img src={u} alt="หลักฐาน" className="h-24 w-[68px] rounded-lg bg-white object-cover" />หลักฐานคนขาย</a>)}
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
            <div className="text-[12px] text-ink-muted2">{tr.paid_at && !free ? `${buyerWord}โอนไปแล้ว — ตามกติกา คนขายต้องคืนเงินเอง + แนบสลิปคืน` : 'ยังไม่มีการโอนเงิน'}</div>
            <input id={`cancel-${tr.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผล (ลูกค้าจะเห็น)" className="mt-2 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none" />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setCancelling(false)} className="flex-1 rounded-lg border border-subtle py-2 text-[12.5px] font-bold text-ink-muted2">ไม่ยกเลิก</button>
              <button type="button" disabled={!reason.trim() || busy} onClick={() => void act(() => mk.marketAdminCancel(tr.id, reason.trim()), 'ยกเลิกดีลแล้ว', () => { void mk.marketPush(tr.id, 'cancelled'); setCancelling(false); })}
                className="flex-1 rounded-lg bg-[#b91c1c] py-2 text-[12.5px] font-bold text-white disabled:opacity-50">ยืนยันยกเลิก</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ดีลทั้งหมด ─────────────────────────────────────────────────────────────────
function AllTab({ db }: { db: Database }) {
  const [f, setF] = useState<string>('');
  const rows = db.transfers.map((tr) => ({ tr, st: effectiveStatus(tr) }))
    .filter((x) => !f || x.st === f || (f === 'direct' && isDirect(x.tr)))
    .sort((a, b) => (b.tr.updated_at ?? b.tr.listed_at).localeCompare(a.tr.updated_at ?? a.tr.listed_at));
  const counts = new Map<string, number>();
  for (const tr of db.transfers) { const s = effectiveStatus(tr); counts.set(s, (counts.get(s) ?? 0) + 1); }
  const directCount = db.transfers.filter(isDirect).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setF('')} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', !f ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>ทั้งหมด {db.transfers.length}</button>
        {directCount > 0 && <button type="button" onClick={() => setF('direct')} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', f === 'direct' ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>🔁 เปลี่ยนใบ {directCount}</button>}
        {[...counts.entries()].map(([s, n]) => (
          <button type="button" key={s} onClick={() => setF(s)} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', f === s ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>{TRANSFER_STATUS_LABEL[s as TicketTransfer['status']] ?? s} {n}</button>
        ))}
      </div>
      {rows.length === 0 && <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center text-[13px] text-ink-muted2">ยังไม่มีดีล</div>}
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead className="bg-surface-3 text-left text-[11.5px] text-ink-faint">
            <tr><th className="px-3 py-2">สินค้า</th><th className="px-3 py-2">คนขาย → ผู้ซื้อ/ผู้รับ</th><th className="px-3 py-2 text-right">ราคา</th><th className="px-3 py-2">สถานะ</th><th className="px-3 py-2">อัปเดต</th></tr>
          </thead>
          <tbody>
            {rows.map(({ tr, st }) => (
              <tr key={tr.id} className="border-t border-hair">
                <td className="max-w-[220px] truncate px-3 py-2">{isDirect(tr) && <span className="mr-1 rounded bg-[#f1d27a]/15 px-1 text-[10px] font-bold text-[#f1d27a]">🔁</span>}{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : '—'}{(tr.qty ?? 1) > 1 ? ` ×${tr.qty}` : ''}<div className="font-mono text-[10.5px] text-ink-faint">{tr.new_ticket_no ?? tr.prev_ticket_no ?? ''}</div></td>
                <td className="px-3 py-2">{who(db, tr.from_user_id)} <span className="text-ink-faint">→</span> {tr.to_user_id ? who(db, tr.to_user_id) : '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{isDirect(tr) && (tr.asking_price ?? 0) <= 0 ? 'ฟรี' : baht(tr.asking_price)}</td>
                <td className="px-3 py-2">{dealStatusLabel(tr, st)}{tr.cancel_reason && !['seller', 'buyer_declined'].includes(tr.cancel_reason) ? <div className="text-[10.5px] text-ink-faint">{tr.cancel_reason}</div> : null}</td>
                <td className="px-3 py-2 text-ink-faint">{fmt(tr.updated_at ?? tr.listed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── ดูแบบลูกค้า (คอมโพเนนต์เดียวกับหน้าจริง ในกรอบมือถือ) ─────────────────────────────
function PreviewTab() {
  const [view, setView] = useState<'board' | 'mine' | 'code'>('mine');
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-1.5">
        {(['mine', 'code', 'board'] as const).map((v) => (
          <button type="button" key={v} onClick={() => { setView(v); setOpenId(null); }} className={cx('rounded-lg px-3 py-1.5 text-[12.5px] font-bold', view === v ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2')}>
            {v === 'board' ? 'กระดาน' : v === 'code' ? 'เลขกระเป๋าของฉัน' : 'ซื้อขาย / เปลี่ยนใบของฉัน'}
          </button>
        ))}
      </div>
      <div className="w-full max-w-[390px] overflow-hidden rounded-[32px] border border-subtle bg-base p-4 shadow-frame">
        <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-faint"><Icon name="verified" size={12} />หน้าเดียวกับที่ลูกค้าเห็น (บัญชีแอดมินของคุณ)</div>
        {view === 'board'
          ? <MarketBoard mode="preview" />
          : view === 'code'
            ? <div className="flex flex-col gap-3"><WalletCodeChip /><div className="text-[12px] leading-relaxed text-ink-muted2">กล่องนี้อยู่บนสุดของ “กระเป๋าพรี” ของทุกคนเมื่อเปิดสวิตช์ · ให้บัญชีอีกเครื่องใส่เลขนี้ตอนกด “เปลี่ยนใบพรี” เพื่อส่งข้อเสนอมาหาบัญชีนี้</div></div>
            : openId ? <MarketDeal id={openId} mode="preview" onBack={() => setOpenId(null)} /> : <MyDeals onOpen={setOpenId} />}
      </div>
    </div>
  );
}
