'use client';

import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht, STATUS, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { cx } from '@/components/ui';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { approveRemainingPayment } from '@/data/mutations';
import type { ProductStatus } from '@/domain/entities';

const PROGRESS_STATUSES: ProductStatus[] = ['open', 'production', 'shipping', 'arrived'];

export default function AdminDashboardPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending');
  const ticketOf = (tid: string) => db.tickets.find((t) => t.id === tid);
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const totalPre = db.tickets.length + pending.reduce((s, o) => s + o.items.length, 0);
  const todayIncome = db.orders.filter((o) => o.status === 'approved').reduce((s, o) => s + o.total_deposit, 0) || 24800;
  const lowStock = db.products.filter((p) => p.is_stock && (p.stock_qty ?? 0) <= 5).length;

  const statusCounts = PROGRESS_STATUSES.map((st) => ({ st, count: db.products.filter((p) => !p.is_stock && p.status === st).length }));
  const maxCount = Math.max(1, ...statusCounts.map((s) => s.count));

  // shipping lots arriving soon (ETA within ~2 days)
  const arrivingSoon = db.products
    .filter((p) => p.status === 'shipping')
    .map((p) => ({ p, eta: computeEta(db.settings, p.shipped_at) }))
    .filter((x) => x.eta?.arrivingSoon);

  return (
    <div>
      <div className="mb-[22px] flex items-center justify-between">
        <div>
          <div className="text-2xl font-extrabold">ภาพรวมร้าน</div>
          <div className="text-[13px] text-ink-faint">30 มิถุนายน 2026</div>
        </div>
        <div className="flex gap-2.5">
          <button className="grid h-[38px] w-[38px] place-items-center rounded-[11px] border border-subtle bg-surface-2 text-ink"><Icon name="bell" size={19} /></button>
          <div className="grid h-[38px] w-[38px] place-items-center rounded-full bg-primary font-bold">R</div>
        </div>
      </div>

      <div className="mb-[22px] grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat urgent label="สลิปรอ Approve" value={String(pending.length)} icon="warning" />
        <Stat label="พรีทั้งหมด" value={String(totalPre)} icon="box" />
        <Stat label="ยอดเงินวันนี้" value={baht(todayIncome)} icon="payments" green />
        <Stat label="Stock ใกล้หมด" value={String(lowStock)} icon="bolt" />
      </div>

      {arrivingSoon.length > 0 && (
        <div className="mb-[22px] animate-pulseRed rounded-2xl border border-[#2563eb]/40 bg-[#2563eb]/[0.1] p-5">
          <div className="mb-3 flex items-center gap-2 font-bold text-[#bcd3f5]"><Icon name="truck" size={18} /> ใกล้ถึงไทย ({arrivingSoon.length})</div>
          <div className="flex flex-col gap-2">
            {arrivingSoon.map(({ p, eta }) => (
              <div key={p.id} className="flex items-center justify-between rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13px]">
                <span className="font-semibold">{p.series_name}</span>
                <span className="text-[#bcd3f5]">{eta && etaRangeLabel(eta)} <span className="text-ink-faint">{eta && etaDaysLabel(eta)}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pendingRP.length > 0 && (
        <div className="mb-[22px] rounded-2xl border border-[#d97706]/40 bg-surface-2 p-5">
          <div className="mb-3 flex items-center gap-2 text-base font-bold text-[#fbbf24]"><Icon name="payments" size={18} /> ส่วนต่างรอตรวจสอบ ({pendingRP.length})</div>
          <div className="flex flex-col gap-2.5">
            {pendingRP.map((r) => {
              const tk = ticketOf(r.ticket_id);
              return (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3">
                  {r.slip_url && /^https?:|^data:/.test(r.slip_url)
                    ? <a href={r.slip_url} target="_blank" rel="noreferrer"><img src={r.slip_url} alt="สลิป" className="h-12 w-12 rounded-lg object-cover" /></a>
                    : <div className="grid h-12 w-12 place-items-center rounded-lg bg-stripe"><Icon name="copy" size={16} className="text-ink-faint" /></div>}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{userName(r.user_id)} · {baht(r.amount)}</div>
                    <div className="font-mono text-[11px] text-ink-faint">{tk?.ticket_no ?? r.ticket_id}</div>
                  </div>
                  <button onClick={() => { dispatch(approveRemainingPayment(r.id)); flash('อนุมัติส่วนต่างแล้ว'); }} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">Approve</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-[18px] lg:grid-cols-[1.5fr_1fr]">
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-3.5 text-base font-bold">สลิปรอตรวจสอบ</div>
          {pending.length === 0 && <div className="py-5 text-[13px] text-ink-faint">ไม่มีสลิปค้างตรวจ 🎉</div>}
          <div className="flex flex-col gap-3">
            {pending.map((o) => {
              const user = db.users.find((u) => u.id === o.user_id);
              return (
                <div key={o.id} className="flex items-center gap-3.5 rounded-xl border border-subtle bg-surface-3 p-3.5">
                  <div className="grid h-[58px] w-[46px] place-items-center rounded-lg bg-stripe"><Icon name="copy" size={18} className="text-ink-faint" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{user?.display_name}</div>
                    <div className="text-xs text-ink-faint">{o.items.length} รายการ · {baht(o.total_deposit)}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">Approve</button>
                    <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] border border-subtle bg-surface-2 px-3.5 py-2 text-[13px] font-bold text-ink-muted2">ดูสลิป</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-4 text-base font-bold">สถานะพรีทั้งหมด</div>
          <div className="flex flex-col gap-3.5">
            {statusCounts.map(({ st, count }) => (
              <div key={st}>
                <div className="mb-1.5 flex justify-between text-[12.5px]">
                  <span style={{ color: STATUS_FILL[st as StatusKey] }}>{STATUS[st as StatusKey].label}</span>
                  <span className="text-ink-muted">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full" style={{ width: `${(count / maxCount) * 100}%`, background: STATUS_FILL[st as StatusKey] }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-[18px] rounded-xl border border-[#d4af37]/40 p-3.5" style={{ background: 'linear-gradient(135deg, rgba(212,175,55,.18), rgba(161,98,7,.1))' }}>
            <div className="text-xs text-[#f1d27a]">ยอดรวมเดือนนี้</div>
            <div className="mt-0.5 text-[22px] font-extrabold text-[#f1d27a]">{baht(186400)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, icon, urgent, green }: { label: string; value: string; icon: IconName; urgent?: boolean; green?: boolean }) {
  return (
    <div
      className={cx('rounded-card border p-4', urgent ? 'animate-pulseRed border-accent' : 'border-subtle bg-surface-2')}
      style={urgent ? { background: 'linear-gradient(160deg, rgba(220,38,38,.25), #1a0f0e)' } : undefined}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] text-ink-muted">{label}</span>
        <Icon name={icon} size={18} className={urgent ? 'text-[#f87171]' : green ? 'text-[#4ade80]' : 'text-ink-faint'} />
      </div>
      <div className={cx('text-[26px] font-extrabold', green ? 'text-[#4ade80]' : 'text-ink')}>{value}</div>
    </div>
  );
}
