'use client';

import { useState } from 'react';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { approveRemainingPayment, rejectRemainingPayment, logActivity } from '@/data/mutations';
import { deliveryRequests, handoffQueue, parcelQueue, awaitingChoice } from '@/domain/services/delivery';
import { lineImage } from '@/domain/services/catalog';
import { ticketSourceOf } from '@/domain/services/ticketSource';
import { cx } from '@/components/ui';
import { store } from '@/data/store';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { pendingRpGroups, type RpGroup } from '@/domain/services/payments';
import { heldPointsFor, orderPointsIssue } from '@/domain/services/points';
import type { PreorderTicket, RemainingPayment } from '@/domain/entities';

/** ศูนย์การเงินออเดอร์: สลิปมัดจำ + ส่วนต่าง + รอถึงไทย. งานจัดส่งทั้งหมดย้ายไปแท็บ "จัดส่ง"
 *  (/admin/shipping — เจ้าของ 2026-07-23) เหลือแบนเนอร์ลิงก์ไว้ที่นี่. */
export default function OrdersHubPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
  // กันกดอนุมัติ/ปฏิเสธสลิปส่วนต่างรัวๆ ระหว่างรอเซฟ — เงินเข้า-หนี้ลดต้องเกิดครั้งเดียว
  const [rpBusy, setRpBusy] = useState<string | null>(null);

  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const ticketOf = (tid: string) => db.tickets.find((t) => t.id === tid);
  const productOf = (t: PreorderTicket) => db.products.find((p) => p.id === t.product_id);
  const paidFull = (t: PreorderTicket) => t.remaining_paid >= t.remaining_amount;

  // §1 pending deposit slips
  const pendingOrders = db.orders.filter((o) => o.status === 'pending_approval');
  // §2 pending remaining-balance slips
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending');
  const rpGroups = pendingRpGroups(db);

  /** อนุมัติสลิปส่วนต่าง 1 กลุ่ม (1 ใบหรือหลายใบที่ใช้สลิปเดียวกัน) — เงินเข้า-หนี้ลด ต้องเกิดครั้งเดียวต่อใบ */
  const approveRps = async (rps: RemainingPayment[]) => {
    if (rpBusy) return; // กันกดรัวระหว่างรอเซฟ
    setRpBusy('group');
    try {
      const applied: RemainingPayment[] = [];
      let allFull = true;
      for (const r of rps) {
        dispatch(approveRemainingPayment(r.id));
        // read-back ต่อใบ: mutation no-op ได้ (อีกเครื่องอนุมัติไปแล้ว) + ยอดอาจยังไม่ครบจริง (แก้มัดจำระหว่างรอตรวจ)
        let ok = false;
        dispatch((d) => {
          ok = d.remainingPayments.find((x) => x.id === r.id)?.status === 'approved';
          const x = d.tickets.find((t2) => t2.id === r.ticket_id);
          if (!(x && x.remaining_paid >= x.remaining_amount)) allFull = false;
          return d;
        });
        if (ok) applied.push(r);
      }
      if (applied.length === 0) return flash('รายการนี้ถูกจัดการไปแล้ว (อีกเครื่อง/แท็บ) — รีเฟรชหน้าเช็คอีกที');
      // DNA save: เซฟให้ผ่านก่อนค่อยบอกลูกค้า "รับยอดแล้ว" — push ที่ออกไปเรียกคืนไม่ได้
      if (await store.flush()) return flash('อนุมัติแล้วในเครื่องนี้ แต่ยังบันทึกไม่ขึ้น — ระบบลองใหม่ให้เอง ❗ห้ามกดซ้ำ รอสักครู่แล้วรีเฟรช');
      const nos = applied.map((r) => ticketOf(r.ticket_id)?.ticket_no ?? '').filter(Boolean);
      const first = ticketOf(applied[0].ticket_id);
      if (pushEnabled(db, 'rp_approved'))
        sendPush(subsForUsers(db, [applied[0].user_id]), { title: '💚 รับยอดส่วนต่างแล้ว', body: `${nos.join(', ')} ${allFull ? 'ชำระครบ — เลือกวิธีรับของได้เลย' : 'รับยอดแล้ว — เช็คยอดคงเหลือในตั๋ว'}`, url: applied.length === 1 && first ? `/wallet/${encodeURIComponent(first.ticket_no)}` : '/wallet' }, dispatch).catch(() => {});
      const total = applied.reduce((s, r) => s + r.amount, 0);
      dispatch(logActivity(adminId, 'approve_rp', `อนุมัติสลิปส่วนต่าง ${applied.length > 1 ? `${applied.length} ใบ ` : ''}(${userName(applied[0].user_id)})`, { targetId: applied[0].ticket_id, targetLabel: nos.join(' '), amount: total }));
      flash(applied.length > 1 ? `อนุมัติส่วนต่างแล้ว ${applied.length} ใบ` : 'อนุมัติส่วนต่างแล้ว');
    } finally { setRpBusy(null); }
  };

  /** ปฏิเสธสลิปส่วนต่าง (ทั้งกลุ่ม หรือบางใบ) — คืนคูปอง ยอดหนี้คงเดิม (audit 2026-07-25: เดิมไม่มีทางนี้ สลิปปลอมค้างคิวถาวร) */
  const rejectRps = async (rps: RemainingPayment[]) => {
    if (rpBusy) return;
    const total = rps.reduce((s, r) => s + r.amount, 0);
    if (!confirm(`ปฏิเสธสลิปส่วนต่าง${rps.length > 1 ? ` ${rps.length} ใบ` : 'นี้'}? (${baht(total)})\nคูปองที่ใช้จะถูกคืนให้ลูกค้า และยอดค้างคงเดิม`)) return;
    setRpBusy('group');
    try {
      const applied: RemainingPayment[] = [];
      for (const r of rps) {
        dispatch(rejectRemainingPayment(r.id));
        let ok = false;
        dispatch((d) => { ok = !d.remainingPayments.some((x) => x.id === r.id); return d; });
        if (ok) applied.push(r);
      }
      if (applied.length === 0) return flash('รายการนี้ถูกจัดการไปแล้ว (อีกเครื่อง/แท็บ) — รีเฟรชหน้าเช็คอีกที');
      // DNA save: เซฟให้ผ่านก่อนค่อยบอกลูกค้า "สลิปไม่ผ่าน ส่งใหม่" — ถ้าเซฟไม่ขึ้น ลูกค้าส่งใหม่ไม่ได้ (สลิปเดิมยังค้าง)
      if (await store.flush()) return flash('ปฏิเสธแล้วในเครื่องนี้ แต่ยังบันทึกไม่ขึ้น — ระบบลองใหม่ให้เอง ❗ห้ามกดซ้ำ รอสักครู่แล้วรีเฟรช');
      const nos = applied.map((r) => ticketOf(r.ticket_id)?.ticket_no ?? '').filter(Boolean);
      if (pushEnabled(db, 'order_rejected'))
        sendPush(subsForUsers(db, [applied[0].user_id]), { title: '❌ สลิปส่วนต่างไม่ผ่าน', body: `${nos.join(', ')} — ยอด/สลิปไม่ถูกต้อง ส่งใหม่อีกครั้งได้เลย`, url: '/wallet' }, dispatch).catch(() => {});
      dispatch(logActivity(adminId, 'reject_rp', `ปฏิเสธสลิปส่วนต่าง ${applied.length > 1 ? `${applied.length} ใบ ` : ''}(${userName(applied[0].user_id)})`, { targetId: applied[0].ticket_id, targetLabel: nos.join(' '), amount: applied.reduce((s, r) => s + r.amount, 0) }));
      flash('ปฏิเสธสลิปส่วนต่างแล้ว · คืนคูปองให้ลูกค้า');
    } finally { setRpBusy(null); }
  };
  // §3 paid, still producing/travelling — info only (จ่ายครบแล้วแต่ของยังไม่ถึงไทย ทั้งขาผลิต+ขาเดินทาง)
  const waitingArrival = db.tickets.filter((t) => ['production', 'shipping'].includes(t.product_status) && paidFull(t) && t.status !== 'shipped');
  // งานจัดส่ง (ย้ายไป /admin/shipping) — นับไว้โชว์บนแบนเนอร์
  const shippingJobs = awaitingChoice(db).length + deliveryRequests(db).length + parcelQueue(db).length + handoffQueue(db).length;

  return (
    <div>
      <div className="mb-[22px]">
        <div className="text-2xl font-extrabold">สลิป / ออเดอร์</div>
        <div className="text-[13px] text-ink-faint">ศูนย์จัดการออเดอร์ · การเงิน · สถานะ</div>
      </div>

      {/* งานจัดส่งทั้งหมดอยู่แท็บ "จัดส่ง" แล้ว */}
      <button onClick={() => router.push('/admin/shipping')} className="mb-[18px] flex w-full items-center gap-2.5 rounded-2xl border border-[#b91c1c]/40 bg-surface-2 p-4 text-left">
        <Icon name="truck" size={18} className="text-[#f87171]" />
        <span className="flex-1 text-sm font-bold text-ink">🚚 งานจัดส่ง {shippingJobs} รายการ — คำขอรับของ · ใบปะหน้า · ใส่เลขพัสดุ · ปิดงาน</span>
        <span className="text-[13px] text-ink-muted2">ไปที่ จัดส่ง →</span>
      </button>

      {/* §1 deposit slips */}
      <Section icon="copy" title="สลิปมัดจำรอตรวจ" count={pendingOrders.length} tone="amber">
        {pendingOrders.length === 0 ? <Empty text="ไม่มีสลิปค้างตรวจ 🎉" /> : (
          <div className="flex flex-col gap-2.5">
            {pendingOrders.map((o) => (
              <div key={o.id} className="flex items-center gap-3.5 rounded-xl border border-subtle bg-surface-3 p-3.5">
                <div className="grid h-[52px] w-[42px] place-items-center rounded-lg bg-stripe"><Icon name="copy" size={17} className="text-ink-faint" /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{userName(o.user_id)}</div>
                  <div className="text-xs text-ink-faint">{o.items.length} รายการ · {baht(o.total_deposit)}{o.coupon_discount ? <span className="text-[#4ade80]"> · คูปอง −{baht(o.coupon_discount)}</span> : null}{(o.points_redeemed ?? 0) > 0 ? <span className="font-bold text-[#f1d27a]"> · ⭐ ใช้แต้ม −{baht(o.points_redeemed ?? 0)}{orderPointsIssue(db, o) && <span className="text-[#f87171]"> ⚠ {orderPointsIssue(db, o)} — อนุมัติไม่ได้ (รีเฟรช ถ้ายังขึ้นให้ปฏิเสธ)</span>}</span> : null}
                    {/* ออเดอร์ 0 บาท (Diamond/คูปองคลุมเต็ม) ไม่มีสลิปโดยธรรมชาติ — ป้ายกันเข้าใจผิดว่าเป็นขยะแล้วกดปฏิเสธ (เคสจริง 2026-09-03) */}
                    {(o.total_deposit ?? 0) <= 0 && <span className="ml-1 rounded-md bg-[#8b5cf6]/[0.18] px-1.5 py-0.5 text-[10.5px] font-bold text-[#c4b5fd]">💎 ไม่ต้องโอน · กดยืนยันได้เลย</span>}
                  </div>
                </div>
                <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">{(o.total_deposit ?? 0) <= 0 ? 'ยืนยัน' : 'ตรวจสลิป'}</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* §2 remaining-balance slips */}
      {/* สลิปเดียวจ่ายหลายใบ (เจ้าของ 2026-09-12): แถว rp ที่ใช้สลิปเดียวกันโชว์เป็น "กลุ่ม" อนุมัติ/ปฏิเสธทั้งกลุ่มในคลิกเดียว
          หรือปฏิเสธเฉพาะบางใบ (✕ ท้ายบรรทัด) — ตรวจยอดโอนรวมกับสลิปครั้งเดียว ไม่ต้องเห็นสลิปเดิมซ้ำ 3 รอบ */}
      <Section icon="payments" title="ส่วนต่างรอตรวจ" count={rpGroups.length} tone="amber" sub={pendingRP.length > rpGroups.length ? `${pendingRP.length} ใบ ใน ${rpGroups.length} สลิป` : undefined}>
        {rpGroups.length === 0 ? <Empty text="ไม่มีส่วนต่างค้างตรวจ" /> : (
          <div className="flex flex-col gap-2.5">
            {rpGroups.map((g) => (
              <RpGroupCard key={g.key} g={g} busy={rpBusy !== null} userName={userName} ticketOf={ticketOf} nameOf={(t) => productOf(t)?.series_name ?? '(สินค้าถูกลบ)'}
                onApprove={() => approveRps(g.rps)} onRejectAll={() => rejectRps(g.rps)} onRejectOne={(r) => rejectRps([r])} />
            ))}
          </div>
        )}
      </Section>

      {/* §3 paid, travelling — info only */}
      <Section icon="truck" title="จ่ายแล้ว · รอถึงไทย" count={waitingArrival.length} tone="blue" sub="ไม่ต้องทำอะไร รอเลื่อนสถานะเป็นถึงไทย">
        {waitingArrival.length === 0 ? <Empty text="—" /> : (
          <div className="flex flex-col gap-2">
            {waitingArrival.map((t) => {
              const p = productOf(t); const eta = p ? computeEta(db.settings, p.shipped_at) : null;
              return (
                <div key={t.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13px]">
                  <TicketThumb ticket={t} size={42} />
                  <div className="min-w-0 flex-1 truncate"><span className="font-semibold">{p?.series_name}</span> <span className="text-ink-faint">· {userName(t.owner_id)}</span></div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <span className="rounded-md bg-[#16a34a]/15 px-2 py-0.5 text-[11px] font-bold text-[#4ade80]">จ่ายครบ ✓</span>
                    {eta && <span className="text-[#bcd3f5]">{etaRangeLabel(eta)} <span className="text-ink-faint">{etaDaysLabel(eta)}</span></span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* §4 History Log · เงินเข้าทั้งหมด — ค้นย้อนหลังได้ว่าใครโอนมาเท่าไหร่ ค่าอะไร วันไหน */}
      <MoneyHistory />
    </div>
  );
}

/* ── History Log การเงิน (เจ้าของ 2026-08-11: "มีคนโอน 1000 ชื่อประเสริฐ แต่ไม่รู้รายการอะไร") ──
   รวมทุกเงินที่เข้าจริง: มัดจำ (ออเดอร์อนุมัติ) · ส่วนต่าง (สลิปอนุมัติ) · มอบตั๋ว (เก็บนอกระบบ)
   ค้นหาได้ด้วย ชื่อลูกค้า / สินค้า / ยอด / เลขตั๋ว — ไล่ย้อนหลังหาว่าเงินก้อนนั้นคือรายการไหน */
type MoneyEvent = { at: string; kind: 'มัดจำ' | 'ส่วนต่าง' | 'มอบตั๋ว'; who: string; item: string; amount: number; ref: string };
function MoneyHistory() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const nm = (id: string) => db.products.find((p) => p.id === id)?.series_name ?? '(สินค้าถูกลบ)';
  const un = (id: string) => db.users.find((u) => u.id === id)?.display_name ?? '(ผู้ใช้ถูกลบ)';

  const events: MoneyEvent[] = [];
  // มัดจำ — ออเดอร์ที่อนุมัติแล้ว (เงินก้อนแรก)
  for (const o of db.orders) {
    if (o.status !== 'approved') continue;
    const items = o.items.filter((i) => i.qty > 0).map((i) => `${nm(i.product_id)}×${i.qty}`).join(' · ');
    events.push({ at: o.approved_at ?? o.created_at, kind: 'มัดจำ', who: un(o.user_id), item: items || '—', amount: o.total_deposit ?? 0, ref: o.id });
  }
  // ส่วนต่าง — สลิปที่อนุมัติแล้ว (แหล่งความจริงของ "โอน 1000 มาทีหลัง")
  for (const r of db.remainingPayments) {
    if (r.status !== 'approved') continue;
    const t = db.tickets.find((x) => x.id === r.ticket_id);
    events.push({ at: r.approved_at ?? r.created_at, kind: 'ส่วนต่าง', who: un(r.user_id), item: t ? nm(t.product_id) : '(ตั๋วถูกลบ)', amount: r.amount ?? 0, ref: t?.ticket_no ?? r.ticket_id });
  }
  // มอบตั๋ว — เงินมัดจำที่เก็บนอกระบบ (ticketSourceOf granted)
  for (const t of db.tickets) {
    if (ticketSourceOf(db, t) !== 'granted' || (t.deposit_paid ?? 0) <= 0) continue;
    events.push({ at: t.approved_at ?? t.created_at, kind: 'มอบตั๋ว', who: un(t.owner_id), item: nm(t.product_id), amount: t.deposit_paid ?? 0, ref: t.ticket_no });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1));

  const s = q.trim().toLowerCase();
  const rows = !s ? events : events.filter((e) =>
    e.who.toLowerCase().includes(s) || e.item.toLowerCase().includes(s) || e.ref.toLowerCase().includes(s)
    || String(e.amount).includes(s.replace(/[,฿\s]/g, '')));
  const total = rows.reduce((n, e) => n + e.amount, 0);
  const KIND: Record<MoneyEvent['kind'], string> = {
    'มัดจำ': 'bg-[#16a34a]/[0.16] text-[#4ade80]',
    'ส่วนต่าง': 'bg-[#d97706]/[0.18] text-[#fbbf24]',
    'มอบตั๋ว': 'bg-[#8b5cf6]/[0.18] text-[#c4b5fd]',
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-base font-bold text-ink">
        <Icon name="copy" size={18} className="text-[#60a5fa]" /> <span>📋 History Log · เงินเข้าทั้งหมด</span>
        <span className="ml-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{events.length}</span>
      </div>
      <div className="mb-3 text-[11.5px] text-ink-faint">มัดจำ + ส่วนต่าง + มอบตั๋ว — ค้นชื่อลูกค้า / สินค้า / ยอด / เลขตั๋ว เพื่อไล่ย้อนหลัง</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา เช่น ประเสริฐ / 1000 / Orochimaru / NR-2026-07"
        className="mb-3 w-full rounded-lg border border-subtle bg-surface-3 px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent" />
      {q.trim() && <div className="mb-2 text-[12px] text-ink-muted2">พบ {rows.length} รายการ · รวม <b className="text-[#4ade80]">{baht(total)}</b></div>}
      {rows.length === 0 ? (
        <Empty text={q.trim() ? 'ไม่พบรายการ — ลองพิมพ์ยอดหรือชื่ออื่น' : 'ยังไม่มีเงินเข้า'} />
      ) : (
        <div className="flex flex-col divide-y divide-hair">
          {rows.slice(0, 200).map((e, i) => (
            <div key={e.ref + e.kind + i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-[12.5px]">
              <span className="w-[118px] shrink-0 text-[11px] text-ink-faint">{fmt(e.at)}</span>
              <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold', KIND[e.kind])}>{e.kind}</span>
              <span className="min-w-[110px] shrink-0 font-semibold">{e.who}</span>
              <span className="min-w-[120px] flex-1 truncate text-ink-muted2">{e.item}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{e.ref.startsWith('o-') ? '' : e.ref}</span>
              <span className="w-[82px] shrink-0 text-right font-bold text-primary-soft">{baht(e.amount)}</span>
            </div>
          ))}
          {rows.length > 200 && <div className="py-2 text-center text-[11.5px] text-ink-faint">แสดง 200 รายการล่าสุด · พิมพ์ค้นหาเพื่อแคบลง</div>}
        </div>
      )}
    </div>
  );
}

/* ── shared bits ────────────────────────────────────────────────────────── */
/** รูปสินค้าจิ๋วประจำแถวคิว — เคารพรูป variant. */
function TicketThumb({ ticket, size = 48 }: { ticket: PreorderTicket; size?: number }) {
  const db = useDatabase();
  const img = lineImage(db, ticket.product_id, ticket.variant_id);
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-subtle bg-stripe" style={{ width: size, height: size }}>
      {img
        ? <img src={img} alt="" className="h-full w-full object-cover" />
        : <div className="grid h-full w-full place-items-center"><Icon name="box" size={Math.round(size * 0.42)} className="text-primary-soft/25" /></div>}
    </div>
  );
}
const TONE: Record<string, string> = {
  amber: 'text-[#fbbf24]', blue: 'text-[#60a5fa]', red: 'text-[#f87171]', green: 'text-[#4ade80]',
};
function Section({ icon, title, count, tone, sub, children }: {
  icon: Parameters<typeof Icon>[0]['name']; title: string; count: number; tone: string; sub?: string; children: ReactNode;
}) {
  return (
    <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-bold text-ink">
        <Icon name={icon} size={18} className={TONE[tone]} /> <span>{title}</span>
        <span className="ml-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{count}</span>
      </div>
      {sub && <div className="mb-3 text-[11.5px] text-ink-faint">{sub}</div>}
      {!sub && <div className="mb-3" />}
      {children}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="py-3 text-[13px] text-ink-faint">{text}</div>;
}

/** การ์ดสลิปส่วนต่าง 1 กลุ่ม (1 สลิป = 1..n ใบ) — ระดับบนสุดตาม DNA react-state */
function RpGroupCard({ g, busy, userName, ticketOf, nameOf, onApprove, onRejectAll, onRejectOne }: {
  g: RpGroup; busy: boolean;
  userName: (uid: string) => string; ticketOf: (tid: string) => PreorderTicket | undefined; nameOf: (t: PreorderTicket) => string;
  onApprove: () => void; onRejectAll: () => void; onRejectOne: (r: RemainingPayment) => void;
}) {
  const db = useDatabase(); // ตรวจว่าแต้มในสลิปถูก DB จองจริง (heldPointsFor)
  const multi = g.rps.length > 1;
  return (
    <div className={cx('rounded-xl border bg-surface-3 p-3', multi ? 'border-[#d4af37]/40' : 'border-subtle')}>
      <div className="flex items-center gap-3">
        {g.slipUrl && /^https?:|^data:/.test(g.slipUrl)
          ? <a href={g.slipUrl} target="_blank" rel="noreferrer"><img src={g.slipUrl} alt="สลิป" className="h-12 w-12 rounded-lg object-cover" /></a>
          : <div className="grid h-12 w-12 place-items-center rounded-lg bg-stripe"><Icon name="copy" size={16} className="text-ink-faint" /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
            <span>{userName(g.userId)}</span>
            <span>· ยอดโอน <span className="text-primary-soft">{baht(g.total)}</span></span>
            {g.couponOff > 0 && <span className="text-[#4ade80]">· คูปอง −{baht(g.couponOff)}</span>}
            {/* แต้มที่ลูกค้าใช้ลดในสลิปนี้ — แอดมินต้องเห็นก่อนอนุมัติ (audit 2026-09-23: เดิมไม่โชว์เลย) */}
            {g.rps.some((r) => (r.points_redeemed ?? 0) > 0) && <span className="font-bold text-[#f1d27a]">· ⭐ ใช้แต้ม −{baht(g.rps.reduce((s, r) => s + (r.points_redeemed ?? 0), 0))}</span>}
            {multi && <span className="rounded-md bg-[#d4af37]/[0.16] px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#f1d27a]">สลิปรวม {g.rps.length} ใบ</span>}
          </div>
          {!multi && <div className="font-mono text-[11px] text-ink-faint">{ticketOf(g.rps[0].ticket_id)?.ticket_no ?? g.rps[0].ticket_id}</div>}
        </div>
        <button disabled={busy} onClick={onApprove} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50">{multi ? `Approve ${g.rps.length} ใบ` : 'Approve'}</button>
        <button disabled={busy} onClick={onRejectAll} className="rounded-[9px] border border-[#f87171]/40 px-2.5 py-2 text-[13px] font-bold text-[#f87171] disabled:opacity-50">ปฏิเสธ</button>
      </div>
      {multi && (
        <div className="mt-2 divide-y divide-hair rounded-lg border border-hair bg-surface-2/60">
          {g.rps.map((r) => {
            const tk = ticketOf(r.ticket_id);
            return (
              <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px]">
                <span className="w-[130px] shrink-0 font-mono text-[11px] text-ink-faint">{tk?.ticket_no ?? r.ticket_id}</span>
                <span className="min-w-0 flex-1 truncate">{tk ? nameOf(tk) : ''}</span>
                <span className="tabular-nums">{baht(r.amount)}{r.coupon_discount ? <span className="text-[#4ade80]"> (คูปอง −{baht(r.coupon_discount)})</span> : null}{(r.points_redeemed ?? 0) > 0 ? <span className="font-bold text-[#f1d27a]"> (⭐ แต้ม −{baht(r.points_redeemed ?? 0)}{heldPointsFor(db, r.id, r.points_redeemed) === 0 && <span className="text-[#f87171]"> ⚠ ยังไม่ถูกจอง — อนุมัติไม่ได้ (รีเฟรช ถ้ายังขึ้นให้ปฏิเสธ)</span>})</span> : null}</span>
                <button disabled={busy} onClick={() => onRejectOne(r)} title="ปฏิเสธเฉพาะใบนี้" className="grid h-6 w-6 place-items-center rounded-md border border-[#f87171]/40 text-[#f87171] disabled:opacity-40">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
