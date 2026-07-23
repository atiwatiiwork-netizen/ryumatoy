'use client';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { approveRemainingPayment } from '@/data/mutations';
import { deliveryRequests, handoffQueue, parcelQueue, awaitingChoice } from '@/domain/services/delivery';
import { lineImage } from '@/domain/services/catalog';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import type { PreorderTicket } from '@/domain/entities';

/** ศูนย์การเงินออเดอร์: สลิปมัดจำ + ส่วนต่าง + รอถึงไทย. งานจัดส่งทั้งหมดย้ายไปแท็บ "จัดส่ง"
 *  (/admin/shipping — เจ้าของ 2026-07-23) เหลือแบนเนอร์ลิงก์ไว้ที่นี่. */
export default function OrdersHubPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const ticketOf = (tid: string) => db.tickets.find((t) => t.id === tid);
  const productOf = (t: PreorderTicket) => db.products.find((p) => p.id === t.product_id);
  const paidFull = (t: PreorderTicket) => t.remaining_paid >= t.remaining_amount;

  // §1 pending deposit slips
  const pendingOrders = db.orders.filter((o) => o.status === 'pending_approval');
  // §2 pending remaining-balance slips
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending');
  // §3 paid, still travelling — info only
  const waitingArrival = db.tickets.filter((t) => t.product_status === 'shipping' && paidFull(t));
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
                  <div className="text-xs text-ink-faint">{o.items.length} รายการ · {baht(o.total_deposit)}{o.coupon_discount ? <span className="text-[#4ade80]"> · คูปอง −{baht(o.coupon_discount)}</span> : null}</div>
                </div>
                <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">ตรวจสลิป</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* §2 remaining-balance slips */}
      <Section icon="payments" title="ส่วนต่างรอตรวจ" count={pendingRP.length} tone="amber">
        {pendingRP.length === 0 ? <Empty text="ไม่มีส่วนต่างค้างตรวจ" /> : (
          <div className="flex flex-col gap-2.5">
            {pendingRP.map((r) => {
              const tk = ticketOf(r.ticket_id);
              return (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3">
                  {r.slip_url && /^https?:|^data:/.test(r.slip_url)
                    ? <a href={r.slip_url} target="_blank" rel="noreferrer"><img src={r.slip_url} alt="สลิป" className="h-12 w-12 rounded-lg object-cover" /></a>
                    : <div className="grid h-12 w-12 place-items-center rounded-lg bg-stripe"><Icon name="copy" size={16} className="text-ink-faint" /></div>}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{userName(r.user_id)} · {baht(r.amount)}{r.coupon_discount ? <span className="text-[#4ade80]"> · คูปอง −{baht(r.coupon_discount)}</span> : null}</div>
                    <div className="font-mono text-[11px] text-ink-faint">{tk?.ticket_no ?? r.ticket_id}</div>
                  </div>
                  <button onClick={() => {
                    dispatch(approveRemainingPayment(r.id));
                    if (pushEnabled(db, 'rp_approved'))
                      sendPush(subsForUsers(db, [r.user_id]), { title: '💚 รับยอดส่วนต่างแล้ว', body: `${tk?.ticket_no ?? ''} ชำระครบ — เลือกวิธีรับของได้เลย`, url: tk ? `/wallet/${encodeURIComponent(tk.ticket_no)}` : '/wallet' }, dispatch).catch(() => {});
                    flash('อนุมัติส่วนต่างแล้ว');
                  }} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">Approve</button>
                </div>
              );
            })}
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
