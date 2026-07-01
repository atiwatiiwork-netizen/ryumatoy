'use client';

import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, BackBar, ProgressBar, QrPanel, cx } from '@/components/ui';
import { manufacturerNameOf, franchiseOf } from '@/domain/services/catalog';
import { paidPercent } from '@/domain/services/tickets';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { listForResale } from '@/data/mutations';
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
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const ticket = db.tickets.find((t) => t.ticket_no === decodeURIComponent(ticketNo));
  if (!ticket) return <div className="p-10 text-ink-faint">ไม่พบใบพรี</div>;

  const product = db.products.find((p) => p.id === ticket.product_id)!;
  const pct = paidPercent(ticket.deposit_paid, ticket.remaining_amount, ticket.remaining_paid);
  const due = ticket.remaining_amount - ticket.remaining_paid;
  const currentIdx = TIMELINE.findIndex((s) => s.key === ticket.product_status);
  const eta = ticket.product_status === 'shipping' ? computeEta(db.settings, product.shipped_at) : null;

  const resell = () => {
    dispatch(listForResale(ticket.id, CURRENT_USER_ID, ticket.deposit_paid + ticket.remaining_amount));
    flash('ลงขาย P2P แล้ว · รอผู้สนใจ');
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ใบพรี" onBack={() => router.push('/wallet')} />

      <div className="relative mb-4 rounded-2xl border border-[#b91c1c]/35 bg-surface-2 px-[18px] py-[22px] text-center">
        <div className="absolute -left-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="absolute -right-[9px] top-[55%] h-[18px] w-[18px] rounded-full bg-base" />
        <div className="mb-3.5 font-mono text-[15px] tracking-wider text-primary-soft">{ticket.ticket_no}</div>
        <div className="flex justify-center"><QrPanel size={160} /></div>
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

      <div className="flex gap-2.5">
        <Button variant="outline" icon="swap" onClick={resell}>ลงขาย P2P</Button>
        {due > 0 && (
          <button onClick={() => flash('ไปหน้าจ่ายส่วนต่าง')} className="grid w-[52px] flex-shrink-0 place-items-center rounded-btn border border-subtle bg-surface-3 text-primary-soft"><Icon name="payments" size={20} /></button>
        )}
      </div>
    </div>
  );
}
