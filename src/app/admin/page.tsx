'use client';

import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht, STATUS, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { cx } from '@/components/ui';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { memosDue } from '@/domain/services/sourcing';
import { unmatchedApprovedItems } from '@/domain/services/tickets';
import { orphanUsedGrants } from '@/domain/services/coupons';
import { repairTickets } from '@/data/mutations';
import type { ProductStatus } from '@/domain/entities';

const PROGRESS_STATUSES: ProductStatus[] = ['open', 'production', 'shipping', 'arrived'];

export default function AdminDashboardPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  // "ข้อมูลขาดจาก split flush" watchdog — three failure shapes of the non-atomic multi-table save:
  const lostTickets = unmatchedApprovedItems(db); // approved item, no ticket
  const lostPeople = new Set(lostTickets.map((x) => x.order.user_id)).size;
  const zeroItemOrders = db.orders.filter((o) => (o.status === 'pending_approval' || o.status === 'approved') && o.items.length === 0);
  const orphanGrants = orphanUsedGrants(db).length; // coupon burned, its order/rp never landed (self-heals client-side)
  const hasAnomaly = lostTickets.length > 0 || zeroItemOrders.length > 0 || orphanGrants > 0;

  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending');
  const totalPre = db.tickets.length + pending.reduce((s, o) => s + o.items.length, 0);
  // real revenue from approved orders (by approval date) — no demo fallback
  const now = new Date();
  const sameDay = (d?: string) => d != null && new Date(d).toDateString() === now.toDateString();
  const sameMonth = (d?: string) => d != null && new Date(d).getFullYear() === now.getFullYear() && new Date(d).getMonth() === now.getMonth();
  const approved = db.orders.filter((o) => o.status === 'approved');
  const todayIncome = approved.filter((o) => sameDay(o.approved_at ?? o.created_at)).reduce((s, o) => s + o.total_deposit, 0);
  const monthIncome = approved.filter((o) => sameMonth(o.approved_at ?? o.created_at)).reduce((s, o) => s + o.total_deposit, 0);
  const lowStock = db.products.filter((p) => p.is_stock && (p.stock_qty ?? 0) <= 5).length;
  const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const dateLabel = `${now.getDate()} ${THAI_MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  const statusCounts = PROGRESS_STATUSES.map((st) => ({ st, count: db.products.filter((p) => !p.is_stock && p.status === st).length }));
  const maxCount = Math.max(1, ...statusCounts.map((s) => s.count));

  // shipping lots arriving soon (ETA within ~2 days)
  const arrivingSoon = db.products
    .filter((p) => p.status === 'shipping')
    .map((p) => ({ p, eta: computeEta(db.settings, p.shipped_at) }))
    .filter((x) => x.eta?.arrivingSoon);
  // memo หาของนอกระบบ (แชทเฟส/โทร) ที่เข้าช่วงคาดว่าถึงแล้ว — เตือนให้ไปทวงเช็ค
  const memoDue = memosDue(db);

  return (
    <div>
      <div className="mb-[22px] flex items-center justify-between">
        <div>
          <div className="text-2xl font-extrabold">ภาพรวมร้าน</div>
          <div className="text-[13px] text-ink-faint">{dateLabel}</div>
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

      {hasAnomaly && (
        <div className="mb-[22px] rounded-2xl border border-[#b91c1c]/50 bg-[#b91c1c]/[0.1] p-5">
          <div className="mb-2 flex items-center gap-2 font-bold text-primary-soft"><Icon name="warning" size={18} /> พบข้อมูลขาดจากการเซฟไม่สมบูรณ์ (มือถือหลุดกลางเซฟ)</div>
          <ul className="mb-3 list-inside list-disc text-[12.5px] leading-relaxed text-ink-muted2">
            {lostTickets.length > 0 && <li>ตั๋วหายจากออเดอร์ที่อนุมัติแล้ว <b className="text-ink">{lostTickets.length} ใบ · {lostPeople} คน</b> — กู้เองเมื่อลูกค้าเปิดแอป หรือกดซ่อมด้านล่าง</li>}
            {zeroItemOrders.length > 0 && <li>ออเดอร์ไม่มีรายการสินค้า <b className="text-ink">{zeroItemOrders.length} ออเดอร์</b> — อนุมัติไม่ได้ ให้ปฏิเสธแล้วแจ้งลูกค้าสั่งใหม่</li>}
            {orphanGrants > 0 && <li>คูปองถูกใช้แต่ออเดอร์/สลิปไม่สมบูรณ์ <b className="text-ink">{orphanGrants} ใบ</b> — ระบบคืนให้เองเมื่อลูกค้าเปิดแอป</li>}
          </ul>
          {lostTickets.length > 0 && (
            <button onClick={() => { dispatch(repairTickets()); flash(`ซ่อมตั๋วแล้ว ${lostTickets.length} ใบ ✓`); }} className="rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">🔧 ซ่อมตั๋วทั้งหมดตอนนี้</button>
          )}
        </div>
      )}

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
        <button onClick={() => router.push('/admin/orders')} className="mb-[22px] flex w-full items-center gap-2.5 rounded-2xl border border-[#d97706]/40 bg-surface-2 p-4 text-left text-[#fbbf24]">
          <Icon name="payments" size={18} />
          <span className="flex-1 text-sm font-bold">ส่วนต่างรอตรวจสอบ {pendingRP.length} รายการ</span>
          <span className="text-[13px] text-ink-muted2">ไปที่ สลิป/ออเดอร์ →</span>
        </button>
      )}

      {memoDue.length > 0 && (
        <button onClick={() => router.push('/admin/sourcing')} className="mb-[22px] flex w-full items-center gap-2.5 rounded-2xl border border-[#8b5cf6]/45 bg-surface-2 p-4 text-left text-[#c4b5fd]">
          <Icon name="search" size={18} />
          <span className="flex-1 text-sm font-bold">📒 หาของนอกระบบถึงช่วงคาดแล้ว {memoDue.length} รายการ — ทวงเช็ค!</span>
          <span className="text-[13px] text-ink-muted2">ไปที่ หาของ →</span>
        </button>
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
            <div className="mt-0.5 text-[22px] font-extrabold text-[#f1d27a]">{baht(monthIncome)}</div>
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
