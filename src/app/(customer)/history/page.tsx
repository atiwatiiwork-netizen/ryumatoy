'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { BackBar, cx } from '@/components/ui';
import { useSmartBack } from '@/lib/nav';
import { productLabel, lineImage } from '@/domain/services/catalog';
import { ticketPaid, ticketDue } from '@/domain/services/money';
import { closePaymentPlan } from '@/data/mutations';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/**
 * ประวัติการซื้อของฉัน (เจ้าของ 2026-07-25) — ทุกออเดอร์ที่เคยสั่ง + สลิป + ยอดที่จ่ายไปแล้วทั้งหมด
 * + นัดชำระที่ตั้งไว้. ลูกค้าย้อนดูเองได้ ไม่ต้องทักถามแอดมิน.
 */
export default function HistoryPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');
  const [big, setBig] = useState<string | null>(null);

  const orders = db.orders.filter((o) => o.user_id === uid).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const myTickets = db.tickets.filter((t) => t.owner_id === uid);
  const rps = db.remainingPayments.filter((r) => r.user_id === uid);
  const plans = db.paymentPlans.filter((p) => p.user_id === uid && p.status === 'open').sort((a, b) => (a.due_date < b.due_date ? -1 : 1));

  // ยอดสะสมที่จ่ายไปแล้วจริง (มัดจำ + ส่วนต่างที่อนุมัติแล้ว) + ยอดค้างทั้งหมด
  const paidTotal = myTickets.reduce((s, t) => s + ticketPaid(t), 0);
  const dueTotal = myTickets.reduce((s, t) => s + ticketDue(t), 0);

  const ST: Record<string, { label: string; cls: string }> = {
    approved: { label: 'อนุมัติแล้ว ✓', cls: 'bg-[#16a34a]/[0.16] text-[#4ade80]' },
    pending_approval: { label: 'รอตรวจสลิป', cls: 'bg-[#d97706]/[0.16] text-[#fbbf24]' },
    rejected: { label: 'ไม่ผ่าน', cls: 'bg-[#b91c1c]/[0.16] text-[#f87171]' },
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ประวัติการซื้อ" onBack={goBack} />

      <div className="mb-4 grid grid-cols-3 gap-2.5">
        <Kpi label="ออเดอร์ทั้งหมด" value={String(orders.length)} />
        <Kpi label="จ่ายไปแล้วรวม" value={baht(paidTotal)} tone="text-[#4ade80]" />
        <Kpi label="ยอดค้างจ่าย" value={baht(dueTotal)} tone={dueTotal > 0 ? 'text-[#fbbf24]' : 'text-ink'} />
      </div>

      {plans.length > 0 && (
        <div className="mb-4 rounded-card border border-[#a855f7]/40 bg-[#a855f7]/[0.07] p-4">
          <div className="mb-2 text-[13px] font-bold text-[#c084fc]">📅 นัดชำระที่ตั้งไว้</div>
          <div className="flex flex-col gap-2">
            {plans.map((p) => (
              <div key={p.id} className="rounded-xl border border-subtle bg-surface-2 p-3">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-bold">ครบกำหนด {p.due_date}</span>
                  <span className="ml-auto font-extrabold text-primary-soft">{baht(p.amount)}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-muted2">{p.items.map((i) => `${i.label} ×${i.qty}`).join(' · ')}</div>
                <button onClick={() => { if (confirm('ยกเลิกนัดชำระนี้?')) { dispatch(closePaymentPlan(p.id, 'cancelled')); flash('ยกเลิกนัดชำระแล้ว'); } }}
                  className="mt-1.5 text-[11.5px] text-ink-faint underline">ยกเลิกนัดนี้</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {orders.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 py-14 text-center text-[13px] text-ink-faint">
          ยังไม่มีประวัติการซื้อ<br />
          <Link href="/shop" className="mt-2 inline-block font-bold text-primary-soft underline">ไปดูสินค้า →</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {orders.map((o) => {
            const st = ST[o.status] ?? ST.pending_approval;
            // ส่วนต่างที่จ่ายไปกับตั๋วของออเดอร์นี้ (จับคู่ด้วยสินค้า/รอบ)
            const orderRps = rps.filter((r) => myTickets.some((t) => t.id === r.ticket_id && o.items.some((i) => i.product_id === t.product_id && (i.batch_id ?? null) === (t.batch_id ?? null))));
            return (
              <div key={o.id} className="rounded-card border border-subtle bg-surface-2 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-ink-faint">#{o.id.slice(-6)}</span>
                  <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-bold', st.cls)}>{st.label}</span>
                  <span className="text-[11.5px] text-ink-faint">{fmtDate(o.approved_at ?? o.created_at)}</span>
                  <span className="ml-auto text-[15px] font-extrabold text-primary-soft">{baht(o.total_deposit)}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {o.items.map((i) => {
                    const img = lineImage(db, i.product_id, i.variant_id);
                    const tk = myTickets.find((t) => t.product_id === i.product_id && (t.batch_id ?? null) === (i.batch_id ?? null) && (t.variant_id ?? null) === (i.variant_id ?? null));
                    return (
                      <div key={i.id} className="flex items-center gap-2.5">
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">
                          {img && <img src={img} alt="" className="h-full w-full object-cover" />}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{productLabel(db, i.product_id, i.variant_id)} ×{i.qty}</span>
                        {tk && <Link href={`/wallet/${encodeURIComponent(tk.ticket_no)}`} className="shrink-0 font-mono text-[11px] text-primary-soft underline">{tk.ticket_no}</Link>}
                      </div>
                    );
                  })}
                </div>
                {o.coupon_discount ? <div className="mt-1.5 text-[11.5px] text-[#4ade80]">ใช้คูปองลด {baht(o.coupon_discount)}</div> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {o.slip_url && /^https?:|^data:/.test(o.slip_url) && (
                    <button onClick={() => setBig(o.slip_url)} className="rounded-lg border border-subtle px-2.5 py-1 text-[11.5px] text-ink-muted2">🧾 ดูสลิปมัดจำ</button>
                  )}
                  {orderRps.map((r) => (
                    <button key={r.id} onClick={() => r.slip_url && setBig(r.slip_url)} className="rounded-lg border border-subtle px-2.5 py-1 text-[11.5px] text-ink-muted2">
                      💸 สลิปส่วนต่าง {baht(r.amount)} {r.status === 'pending' ? '(รอตรวจ)' : '✓'}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {big && (
        <div className="fixed inset-0 z-[130] grid place-items-center bg-black/80 p-4" onClick={() => setBig(null)}>
          <img src={big} alt="สลิป" className="max-h-[88vh] max-w-full rounded-xl object-contain" />
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-subtle bg-surface-2 px-3 py-2.5 text-center">
      <div className="text-[10.5px] text-ink-muted">{label}</div>
      <div className={cx('mt-0.5 text-[15px] font-extrabold', tone ?? 'text-ink')}>{value}</div>
    </div>
  );
}
