'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, BackBar, ProgressBar, QrPanel, TicketQr, cx } from '@/components/ui';
import { manufacturerNameOf, franchiseOf } from '@/domain/services/catalog';
import { paidPercent } from '@/domain/services/tickets';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { listForResale, submitRemainingPayment } from '@/data/mutations';
import { preorderCouponsForTicket, couponDiscount } from '@/domain/services/coupons';
import { useSmartBack } from '@/lib/nav';
import type { ProductStatus } from '@/domain/entities';

const TIMELINE: { key: ProductStatus; label: string }[] = [
  { key: 'open', label: 'เปิดจอง' },
  { key: 'production', label: 'ผลิต' },
  { key: 'shipping', label: 'เดินทาง' },
  { key: 'arrived', label: 'ถึงไทย' },
  { key: 'delivered', label: 'ส่งมอบ' },
];

export default function TicketDetailPage() {
  const { ticketNo } = useParams<{ ticketNo: string }>();
  const router = useRouter();
  const goBack = useSmartBack('/wallet');
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();

  const ticket = db.tickets.find((t) => t.ticket_no === decodeURIComponent(ticketNo));
  if (!ticket) return <div className="p-10 text-ink-faint">ไม่พบใบพรี</div>;

  const product = db.products.find((p) => p.id === ticket.product_id)!;
  const pct = paidPercent(ticket.deposit_paid, ticket.remaining_amount, ticket.remaining_paid);
  const due = ticket.remaining_amount - ticket.remaining_paid;
  const isShipped = ticket.status === 'shipped';
  const currentIdx = isShipped ? TIMELINE.length - 1 : TIMELINE.findIndex((s) => s.key === ticket.product_status);
  const carrierLabel: Record<string, string> = { ems: 'EMS', jt: 'J&T', flash: 'Flash', kerry: 'Kerry' };
  const eta = ticket.product_status === 'shipping' ? computeEta(db.settings, product.shipped_at) : null;

  // remaining-balance payment: available once the lot is shipping onward
  const canPay = due > 0 && ['shipping', 'arrived', 'delivered'].includes(ticket.product_status);
  const pendingRP = db.remainingPayments.find((r) => r.ticket_id === ticket.id && r.status === 'pending');
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];
  const [paying, setPaying] = useState(false);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // pre-order coupon: reduces this final payment (only usable coupons that match this product)
  const eligibleCoupons = preorderCouponsForTicket(db, CURRENT_USER_ID, product);
  const [couponGrantId, setCouponGrantId] = useState<string>('');
  const selectedCoupon = eligibleCoupons.find((x) => x.grant.id === couponGrantId);
  const couponOff = selectedCoupon ? couponDiscount(selectedCoupon.coupon, due) : 0;
  const payable = Math.max(0, due - couponOff);

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const payRemaining = () => {
    if (!slip) return;
    dispatch(submitRemainingPayment(ticket.id, CURRENT_USER_ID, payable, slip, selectedCoupon ? { grantId: selectedCoupon.grant.id, discount: couponOff } : undefined));
    flash('ส่งสลิปส่วนต่างแล้ว · รอ Admin ตรวจสอบ');
    setPaying(false); setSlip(null); setCouponGrantId('');
  };

  const resell = () => {
    dispatch(listForResale(ticket.id, CURRENT_USER_ID, ticket.deposit_paid + ticket.remaining_amount));
    flash('ลงขาย P2P แล้ว · รอผู้สนใจ');
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ใบพรี" onBack={goBack} />

      <div className="relative mb-4 rounded-2xl border border-[#b91c1c]/35 bg-surface-2 px-[18px] py-[22px] text-center">
        <div className="absolute -left-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="absolute -right-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="mb-3.5 font-mono text-[15px] tracking-wider text-primary-soft">{ticket.ticket_no}</div>
        <div className="flex justify-center"><TicketQr value={typeof window !== 'undefined' ? `${window.location.origin}/wallet/${encodeURIComponent(ticket.ticket_no)}` : ticket.ticket_no} size={150} /></div>
        <div className="mt-3 text-[11.5px] text-ink-faint">แสดง QR นี้เพื่อยืนยันตัวตนตอนรับของ</div>
      </div>

      <div className="mb-3.5 flex items-center gap-3 rounded-card border border-subtle bg-surface-2 p-3">
        <div className="grid h-[52px] w-[52px] place-items-center rounded-[10px] bg-stripe"><Icon name="box" size={22} className="text-primary-soft/25" /></div>
        <div>
          <div className="text-[13.5px] font-semibold">{product.series_name}</div>
          <div className="text-[11.5px] text-ink-faint">{manufacturerNameOf(db, product)} · {franchiseOf(db, product)?.name}</div>
        </div>
      </div>

      {eta && (
        <div className="mb-3.5 flex items-center gap-2.5 rounded-card border border-[#2563eb]/30 bg-[#2563eb]/10 px-4 py-3">
          <Icon name="truck" size={18} className="text-[#60a5fa]" />
          <div className="text-[13px] text-[#bcd3f5]">คาดว่าถึงไทย <b>{etaRangeLabel(eta)}</b> {etaDaysLabel(eta)}{product.tracking_no ? <> · <span className="font-mono text-[11px]">Track {product.tracking_no}</span></> : null}</div>
        </div>
      )}

      {isShipped && ticket.parcel_no && (
        <div className="mb-3.5 rounded-card border border-[#16a34a]/35 bg-[#16a34a]/[0.1] px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-[#4ade80]"><Icon name="truck" size={17} /> จัดส่งแล้ว · {carrierLabel[ticket.carrier ?? ''] ?? ticket.carrier}</div>
          <div className="font-mono text-[13px] text-ink">เลขพัสดุ {ticket.parcel_no}</div>
          {ticket.parcel_image && /^https?:|^data:/.test(ticket.parcel_image) && (
            <a href={ticket.parcel_image} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[12px] text-[#60a5fa] underline">ดูรูปพัสดุ</a>
          )}
        </div>
      )}

      <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-2 flex justify-between text-[13px]"><span className="text-[#4ade80]">มัดจำที่จ่ายแล้ว ✓</span><span className="font-bold">{baht(ticket.deposit_paid)}</span></div>
        <div className="mb-3 flex justify-between text-[13px]"><span className="text-ink-muted">ส่วนต่างคงเหลือ</span><span className={cx('font-bold', due > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{due > 0 ? baht(due) : 'จ่ายครบ'}</span></div>
        <ProgressBar pct={pct} />
        <div className="mt-[7px] text-[11.5px] text-ink-faint">จ่ายแล้ว {pct}%</div>
      </div>

      <div className="mb-4 rounded-card border border-subtle bg-surface-2 px-4 py-[18px]">
        <div className="relative flex justify-between">
          <div className="absolute left-3.5 right-3.5 top-[11px] h-0.5 bg-white/10" />
          {TIMELINE.map((s, i) => {
            const done = i < currentIdx;
            const current = i === currentIdx;
            return (
              <div key={s.key} className="relative z-10 flex-1 text-center">
                <div className={cx('mx-auto grid h-6 w-6 place-items-center rounded-full border-2', done ? 'border-[#16a34a] bg-[#16a34a]' : current ? 'animate-pulseRed border-[#dc2626] bg-[#dc2626]' : 'border-white/15 bg-surface-3')}>
                  {done && <Icon name="check" size={13} className="text-white" />}
                </div>
                <div className={cx('mt-1.5 text-[10.5px]', current ? 'font-bold text-ink' : 'text-ink-faint')}>{s.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* arrived → notify again to pay the remaining */}
      {ticket.product_status === 'arrived' && due > 0 && !pendingRP && (
        <div className="mb-4 flex animate-pulseRed items-center gap-2.5 rounded-card border border-accent bg-[#b91c1c]/[0.12] px-4 py-3">
          <Icon name="bell" size={18} className="text-primary-soft" />
          <div className="text-[13px] text-primary-soft">ถึงไทยแล้ว! ชำระส่วนต่าง {baht(due)} เพื่อรับของ</div>
        </div>
      )}

      {/* remaining-payment status / action */}
      {pendingRP ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.14] px-4 py-3 text-[13px] text-[#fbbf24]">
          <Icon name="check" size={17} /> ส่งสลิปส่วนต่าง {baht(pendingRP.amount)} แล้ว · รอ Admin ตรวจสอบ
        </div>
      ) : canPay && paying ? (
        <div className="mb-4 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
          <div className="mb-1 text-sm font-bold">ชำระส่วนต่าง {baht(payable)}{couponOff > 0 && <span className="ml-1.5 text-[12px] font-normal text-ink-faint line-through">{baht(due)}</span>}</div>
          <div className="mb-3.5 text-[12px] text-ink-faint">สแกน PromptPay → แนบสลิป → รอ Admin อนุมัติ</div>
          {eligibleCoupons.length > 0 && (
            <div className="mb-3.5 text-left">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-[#c4b5fd]"><Icon name="tag" size={15} /> ใช้คูปองส่วนลด</div>
              <select value={couponGrantId} onChange={(e) => setCouponGrantId(e.target.value)} className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent">
                <option value="">ไม่ใช้คูปอง</option>
                {eligibleCoupons.map((x) => <option key={x.grant.id} value={x.grant.id}>{x.coupon.label} · ลด {baht(x.coupon.value)}</option>)}
              </select>
              {couponOff > 0 && <div className="mt-1.5 flex justify-between text-[12.5px] text-[#4ade80]"><span>ส่วนลด</span><span className="font-semibold">−{baht(couponOff)}</span></div>}
            </div>
          )}
          <div className="mb-3.5 flex justify-center">
            {account?.qr_url ? <img src={account.qr_url} alt="QR" className="h-[160px] w-[160px] rounded-2xl bg-white object-contain p-2" /> : <QrPanel size={160} />}
          </div>
          {account && <div className="mb-3.5 text-[13px] text-ink-muted2">{account.name} · <span className="font-mono">{account.number}</span></div>}
          <label className={cx('mb-3 block cursor-pointer rounded-xl border-[1.5px] border-dashed p-4 text-center', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.06]' : 'border-accent')}>
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onSlip(e.target.files?.[0])} />
            {slip ? <img src={slip} alt="สลิป" className="mx-auto max-h-40 rounded-lg object-contain" /> : <div className="text-[13px] font-semibold text-primary-soft">{busy ? 'กำลังอัปโหลด…' : 'แตะแนบรูปสลิป'}</div>}
          </label>
          <div className="flex gap-2.5">
            <Button variant="ghost" onClick={() => { setPaying(false); setSlip(null); }}>ยกเลิก</Button>
            <Button disabled={!slip || busy} onClick={payRemaining}>ส่งสลิป · รอตรวจสอบ</Button>
          </div>
        </div>
      ) : null}

      <div className="flex gap-2.5">
        <Button variant="outline" icon="swap" onClick={resell}>ลงขาย P2P</Button>
        {canPay && !pendingRP && !paying && (
          <Button icon="payments" onClick={() => setPaying(true)}>จ่ายส่วนต่าง</Button>
        )}
      </div>
    </div>
  );
}
