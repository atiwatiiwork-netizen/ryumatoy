'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { uploadImage } from '@/lib/upload';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { approveRemainingPayment, setParcel } from '@/data/mutations';
import { sendPush, subsForUsers } from '@/lib/push';
import type { Carrier, PreorderTicket } from '@/domain/entities';

const CARRIERS: { key: Carrier; label: string }[] = [
  { key: 'ems', label: 'EMS' },
  { key: 'jt', label: 'J&T' },
  { key: 'flash', label: 'Flash' },
  { key: 'kerry', label: 'Kerry' },
];

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
  // §4 paid, still travelling — info only
  const waitingArrival = db.tickets.filter((t) => t.product_status === 'shipping' && paidFull(t));
  // §5 arrived + paid + no parcel yet → enter tracking
  const awaitingParcel = db.tickets.filter((t) => t.product_status === 'arrived' && paidFull(t) && !t.parcel_no);
  // §6 done
  const shipped = db.tickets.filter((t) => t.status === 'shipped');

  return (
    <div>
      <div className="mb-[22px]">
        <div className="text-2xl font-extrabold">สลิป / ออเดอร์</div>
        <div className="text-[13px] text-ink-faint">ศูนย์จัดการออเดอร์ · การเงิน · สถานะ · จัดส่ง</div>
      </div>

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
                    sendPush(subsForUsers(db, [r.user_id]), { title: '💚 รับยอดส่วนต่างแล้ว', body: `${tk?.ticket_no ?? ''} ชำระครบ — รอจัดส่งได้เลย`, url: tk ? `/wallet/${encodeURIComponent(tk.ticket_no)}` : '/wallet' }, dispatch).catch(() => {});
                    flash('อนุมัติส่วนต่างแล้ว');
                  }} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">Approve</button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* §4 paid, travelling — info only */}
      <Section icon="truck" title="จ่ายแล้ว · รอถึงไทย" count={waitingArrival.length} tone="blue" sub="ไม่ต้องทำอะไร รอเลื่อนสถานะเป็นถึงไทย">
        {waitingArrival.length === 0 ? <Empty text="—" /> : (
          <div className="flex flex-col gap-2">
            {waitingArrival.map((t) => {
              const p = productOf(t); const eta = p ? computeEta(db.settings, p.shipped_at) : null;
              return (
                <div key={t.id} className="flex items-center justify-between rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13px]">
                  <div><span className="font-semibold">{p?.series_name}</span> <span className="text-ink-faint">· {userName(t.owner_id)}</span></div>
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-md bg-[#16a34a]/15 px-2 py-0.5 text-[11px] font-bold text-[#4ade80]">จ่ายครบ ✓</span>
                    {eta && <span className="text-[#bcd3f5]">{etaRangeLabel(eta)} <span className="text-ink-faint">{etaDaysLabel(eta)}</span></span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* §5 arrived + paid → enter parcel tracking (final step) */}
      <Section icon="box" title="รอจัดส่ง · ใส่ Tracking พัสดุ" count={awaitingParcel.length} tone="red" sub="ถึงไทย + จ่ายครบ → เลือกขนส่ง + ใส่เลข = จบกระบวนการ">
        {awaitingParcel.length === 0 ? <Empty text="ไม่มีพัสดุรอจัดส่ง" /> : (
          <div className="flex flex-col gap-3">
            {awaitingParcel.map((t) => <ParcelRow key={t.id} ticket={t} label={`${productOf(t)?.series_name ?? ''} · ${userName(t.owner_id)}`} dispatch={dispatch} flash={flash} />)}
          </div>
        )}
      </Section>

      {/* §6 done */}
      {shipped.length > 0 && (
        <Section icon="check" title="จัดส่งแล้ว (จบกระบวนการ)" count={shipped.length} tone="green">
          <div className="flex flex-col gap-2">
            {shipped.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13px]">
                <div><span className="font-semibold">{productOf(t)?.series_name}</span> <span className="text-ink-faint">· {userName(t.owner_id)}</span></div>
                <div className="flex items-center gap-2 text-ink-muted2">
                  <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] font-bold uppercase">{CARRIERS.find((c) => c.key === t.carrier)?.label ?? t.carrier}</span>
                  <span className="font-mono text-[11px]">{t.parcel_no}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ── parcel tracking row (final step) ───────────────────────────────────── */
function ParcelRow({ ticket, label, dispatch, flash }: {
  ticket: PreorderTicket; label: string; dispatch: ReturnType<typeof useDispatch>; flash: (m: string) => void;
}) {
  const db = useDatabase();
  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [no, setNo] = useState('');
  const [img, setImg] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onImg = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setImg(await uploadImage(file, 'parcel')); flash('แนบรูปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!carrier) return flash('เลือกขนส่งก่อน');
    if (!no.trim()) return flash('ใส่เลขพัสดุก่อน');
    dispatch(setParcel(ticket.id, carrier, no.trim(), img));
    const cLabel = CARRIERS.find((c) => c.key === carrier)?.label ?? carrier;
    sendPush(subsForUsers(db, [ticket.owner_id]), { title: '📮 พัสดุจัดส่งแล้ว!', body: `${cLabel} · ${no.trim()} — แตะเพื่อดูตั๋ว`, url: `/wallet/${encodeURIComponent(ticket.ticket_no)}` }, dispatch).catch(() => {});
    flash(`จัดส่งแล้ว · ${ticket.ticket_no} จบกระบวนการ ✓`);
  };

  return (
    <div className="rounded-xl border border-[#b91c1c]/30 bg-surface-3 p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-sm font-semibold">{label}</div>
        <div className="font-mono text-[11px] text-ink-faint">{ticket.ticket_no}</div>
      </div>
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {CARRIERS.map((c) => (
          <button key={c.key} onClick={() => setCarrier(c.key)}
            className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-bold', carrier === c.key ? 'border-accent bg-primary text-white' : 'border-subtle bg-surface-2 text-ink-muted2')}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={no} onChange={(e) => setNo(e.target.value)} placeholder="เลขพัสดุ (Tracking no)" className="flex-1 rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint" />
        <label className={cx('grid cursor-pointer place-items-center rounded-lg border px-3 text-[12px]', img ? 'border-[#16a34a]/50 text-[#4ade80]' : 'border-subtle text-ink-faint')}>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onImg(e.target.files?.[0])} />
          {busy ? '…' : img ? '✓ รูป' : <Icon name="camera" size={16} />}
        </label>
        <button onClick={save} className="rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">จัดส่ง</button>
      </div>
    </div>
  );
}

/* ── shared bits ────────────────────────────────────────────────────────── */
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
