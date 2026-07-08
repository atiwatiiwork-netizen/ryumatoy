'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht, RANK } from '@/lib/theme';
import type { RankKey, StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, RankBadge, cx } from '@/components/ui';
import { rankPiecesOf } from '@/domain/services/ranks';
import { usableGrantsFor, couponExpired } from '@/domain/services/coupons';
import { setSuspended } from '@/data/mutations';
import { CouponTierPill } from '@/components/CouponTicket';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fbUrl = (s: string) => (/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://www.facebook.com/search/top?q=${encodeURIComponent(s.trim())}`);

/** Customer 360°: everything about ONE member on a single page — profile, KPIs, every ticket,
 *  order, coupon, and remaining payment. Linked from members / the ticket table. */
export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const u = db.users.find((x) => x.id === id);
  if (!u) return <div className="py-10 text-center text-ink-faint">ไม่พบสมาชิกนี้</div>;

  const tickets = db.tickets.filter((t) => t.owner_id === u.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const orders = db.orders.filter((o) => o.user_id === u.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const grants = db.couponGrants.filter((g) => g.user_id === u.id).sort((a, b) => (b.granted_at ?? '').localeCompare(a.granted_at ?? ''));
  const rps = db.remainingPayments.filter((r) => r.user_id === u.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const totalDue = tickets.reduce((s, t) => s + Math.max(0, t.remaining_amount - t.remaining_paid), 0);
  const totalPaid = tickets.reduce((s, t) => s + t.deposit_paid + t.remaining_paid, 0);
  const usableCoupons = usableGrantsFor(db, u.id).length;
  const pieces = rankPiecesOf(db, u.id);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button onClick={() => router.back()} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] border border-subtle bg-surface-2 text-ink"><Icon name="arrowLeft" size={19} /></button>
        <div className="text-xl font-extrabold">โปรไฟล์ลูกค้า 360°</div>
      </div>

      {/* profile header */}
      <div className="mb-4 rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-primary text-xl font-extrabold text-white">{u.display_name.charAt(0)}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-extrabold">{u.display_name}</span>
              <RankBadge rank={u.rank} />
              {u.suspended && <span className="rounded-md bg-[#b91c1c]/[0.2] px-2 py-0.5 text-[11px] font-bold text-primary-soft">⏸ ระงับอยู่</span>}
              {u.approved === false && <span className="rounded-md bg-[#d97706]/[0.2] px-2 py-0.5 text-[11px] font-bold text-[#fbbf24]">รออนุมัติ</span>}
            </div>
            <div className="mt-1.5 grid gap-1 text-[12.5px] text-ink-muted2 sm:grid-cols-2">
              <span>รหัส: <b className="font-mono text-ink">{u.member_code ?? '—'}</b></span>
              <span>สมัคร: {fmtDate(u.created_at)}</span>
              <span>เบอร์: {u.phone ?? '—'}</span>
              <span>LINE: {u.line_id ?? '—'}</span>
              {u.fb_link && <a href={fbUrl(u.fb_link)} target="_blank" rel="noopener noreferrer" className="truncate text-[#60a5fa] hover:underline">FB: {u.fb_link} ↗</a>}
              {u.shipping_address && <span className="sm:col-span-2">ที่อยู่: {u.shipping_address}</span>}
            </div>
          </div>
          <button
            onClick={() => { const v = !u.suspended; if (confirm(v ? `ระงับ "${u.display_name}" ชั่วคราว?` : `ปลดระงับ "${u.display_name}"?`)) { dispatch(setSuspended(u.id, v)); flash(v ? 'ระงับแล้ว' : 'ปลดระงับแล้ว'); } }}
            className={cx('rounded-lg border px-3 py-2 text-[12.5px] font-bold', u.suspended ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.12] text-[#4ade80]' : 'border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] text-primary-soft')}
          >{u.suspended ? 'ปลดระงับ' : 'ระงับชั่วคราว'}</button>
        </div>

        {/* KPIs */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Kpi label="ตั๋วทั้งหมด" value={`${tickets.length} ใบ`} sub={`สะสม ${pieces} ชิ้น`} />
          <Kpi label="ค้างชำระรวม" value={baht(totalDue)} tone={totalDue > 0 ? 'red' : 'green'} />
          <Kpi label="จ่ายแล้วรวม" value={baht(totalPaid)} />
          <Kpi label="คูปองใช้ได้" value={`${usableCoupons} ใบ`} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* tickets */}
        <Section title={`ตั๋วพรี (${tickets.length})`}>
          {tickets.length === 0 ? <Empty text="ยังไม่มีตั๋ว" /> : tickets.map((t) => {
            const product = db.products.find((p) => p.id === t.product_id);
            const d = t.remaining_amount - t.remaining_paid;
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="w-[135px] shrink-0 font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{product?.series_name ?? '—'}{t.qty > 1 ? ` ×${t.qty}` : ''}</span>
                <StatusBadge status={(t.status === 'paid_full' ? 'paid_full' : t.product_status) as StatusKey} />
                <span className={cx('text-[12px] font-bold', d > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{d > 0 ? `ค้าง ${baht(d)}` : 'ครบ ✓'}</span>
              </div>
            );
          })}
        </Section>

        {/* orders */}
        <Section title={`ออเดอร์ (${orders.length})`}>
          {orders.length === 0 ? <Empty text="ยังไม่มีออเดอร์" /> : orders.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="w-[64px] shrink-0 font-mono text-[11px] text-ink-faint">#{o.id.slice(-4)}</span>
              <span className="min-w-0 flex-1 text-[12.5px] text-ink-muted2">{o.items.length} รายการ · {baht(o.total_deposit)}{o.coupon_discount ? <span className="text-[#4ade80]"> · คูปอง −{baht(o.coupon_discount)}</span> : null}</span>
              <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-bold', o.status === 'approved' ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : o.status === 'rejected' ? 'bg-[#b91c1c]/[0.14] text-primary-soft' : 'bg-[#d97706]/[0.14] text-[#fbbf24]')}>
                {o.status === 'approved' ? 'อนุมัติ' : o.status === 'rejected' ? 'ปฏิเสธ' : 'รอตรวจ'}
              </span>
              {o.status === 'pending_approval' && <Link href={`/admin/orders/${o.id}`} className="text-[11.5px] font-bold text-primary-soft">ตรวจ →</Link>}
              <span className="text-[11px] text-ink-faint">{fmtDate(o.created_at)}</span>
            </div>
          ))}
        </Section>

        {/* coupons */}
        <Section title={`คูปอง (${grants.length})`}>
          {grants.length === 0 ? <Empty text="ยังไม่เคยได้รับคูปอง" /> : grants.map((g) => {
            const c = db.coupons.find((x) => x.id === g.coupon_id);
            if (!c) return null;
            const label = g.status === 'used' ? `ใช้แล้ว ${fmtDate(g.used_at)}` : g.status === 'revoked' ? 'ถูกถอน' : couponExpired(c) ? 'หมดอายุ' : 'พร้อมใช้';
            return (
              <div key={g.id} className="flex flex-wrap items-center gap-2 py-2">
                <CouponTierPill value={c.value} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.label} · ลด {baht(c.value)}</span>
                <span className={cx('text-[11px] font-semibold', g.status === 'active' && !couponExpired(c) ? 'text-[#4ade80]' : 'text-ink-faint')}>{label}</span>
              </div>
            );
          })}
        </Section>

        {/* remaining payments */}
        <Section title={`สลิปส่วนต่าง (${rps.length})`}>
          {rps.length === 0 ? <Empty text="ยังไม่มีการจ่ายส่วนต่าง" /> : rps.map((r) => {
            const tk = db.tickets.find((t) => t.id === r.ticket_id);
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="w-[135px] shrink-0 font-mono text-[11px] text-ink-faint">{tk?.ticket_no ?? '—'}</span>
                <span className="flex-1 text-[12.5px] font-semibold">{baht(r.amount)}{r.coupon_discount ? <span className="font-normal text-[#4ade80]"> · คูปอง −{baht(r.coupon_discount)}</span> : null}</span>
                <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-bold', r.status === 'approved' ? 'bg-[#16a34a]/[0.14] text-[#4ade80]' : 'bg-[#d97706]/[0.14] text-[#fbbf24]')}>{r.status === 'approved' ? 'อนุมัติ' : 'รอตรวจ'}</span>
                <span className="text-[11px] text-ink-faint">{fmtDate(r.created_at)}</span>
              </div>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-3 p-3">
      <div className="text-[11.5px] text-ink-faint">{label}</div>
      <div className={cx('mt-0.5 text-[17px] font-extrabold', tone === 'red' ? 'text-primary-soft' : tone === 'green' ? 'text-[#4ade80]' : 'text-ink')}>{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-1 text-[14px] font-bold">{title}</div>
      <div className="flex max-h-[340px] flex-col divide-y divide-hair overflow-y-auto">{children}</div>
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <div className="py-6 text-center text-[12.5px] text-ink-faint">{text}</div>;
