'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, cx } from '@/components/ui';
import type { PreorderTicket } from '@/domain/entities';

const inputCls = 'rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

type PayFilter = '' | 'owing' | 'paid';

/** Central ticket table — EVERY ticket in the system, filterable, in one place
 *  (previously only reachable per-product or per-member). */
export default function AdminTicketsPage() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const [makerId, setMakerId] = useState('');
  const [status, setStatus] = useState('');
  const [pay, setPay] = useState<PayFilter>('');

  const due = (t: PreorderTicket) => t.remaining_amount - t.remaining_paid;

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return db.tickets
      .filter((t) => {
        const product = db.products.find((p) => p.id === t.product_id);
        const owner = db.users.find((u) => u.id === t.owner_id);
        if (makerId && product?.manufacturer_id !== makerId) return false;
        if (status && t.product_status !== status && t.status !== status) return false;
        if (pay === 'owing' && due(t) <= 0) return false;
        if (pay === 'paid' && due(t) > 0) return false;
        if (ql) {
          const hay = `${t.ticket_no} ${owner?.display_name ?? ''} ${owner?.phone ?? ''} ${product?.series_name ?? ''}`.toLowerCase();
          if (!hay.includes(ql)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [db, q, makerId, status, pay]);

  const owingCount = db.tickets.filter((t) => due(t) > 0).length;
  const owingSum = db.tickets.reduce((s, t) => s + Math.max(0, due(t)), 0);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">ตั๋วทั้งหมด</div>
      <div className="mb-4 text-[13px] text-ink-faint">ทุกใบพรีในระบบ · {db.tickets.length} ใบ · ค้างชำระ {owingCount} ใบ รวม <b className="text-primary-soft">{baht(owingSum)}</b></div>

      {/* filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-subtle bg-surface-3 px-3">
          <Icon name="search" size={16} className="text-ink-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา เลขตั๋ว / ชื่อลูกค้า / เบอร์ / สินค้า" className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-ink-faint" />
        </div>
        <select className={inputCls} value={makerId} onChange={(e) => setMakerId(e.target.value)}>
          <option value="">ทุกค่าย</option>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          <option value="open">เปิดจอง</option>
          <option value="production">กำลังผลิต</option>
          <option value="shipping">กำลังเดินทาง</option>
          <option value="arrived">ถึงไทย</option>
          <option value="delivered">ส่งมอบ</option>
          <option value="shipped">จัดส่งแล้ว (จบ)</option>
        </select>
        <select className={inputCls} value={pay} onChange={(e) => setPay(e.target.value as PayFilter)}>
          <option value="">จ่ายครบ + ค้าง</option>
          <option value="owing">เฉพาะค้างจ่าย</option>
          <option value="paid">เฉพาะจ่ายครบ</option>
        </select>
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-2 lg:p-3">
        <div className="mb-1 px-2 text-[12px] text-ink-faint">แสดง {rows.length} ใบ</div>
        {rows.length === 0 ? <div className="py-10 text-center text-[13px] text-ink-faint">ไม่พบตั๋วตามตัวกรอง</div> : (
          <div className="flex flex-col divide-y divide-hair">
            {rows.map((t) => {
              const product = db.products.find((p) => p.id === t.product_id);
              const owner = db.users.find((u) => u.id === t.owner_id);
              const d = due(t);
              return (
                <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2.5">
                  <span className="w-[150px] shrink-0 font-mono text-[11.5px] text-ink-faint">{t.ticket_no}</span>
                  <Link href={`/admin/customers/${t.owner_id}`} className="w-[140px] shrink-0 truncate text-[13px] font-semibold text-ink hover:text-primary-soft">{owner?.display_name ?? '—'}</Link>
                  <span className="min-w-[120px] flex-1 truncate text-[12.5px] text-ink-muted2">{product?.series_name ?? '—'}{t.qty > 1 ? ` ×${t.qty}` : ''}</span>
                  <StatusBadge status={(t.status === 'paid_full' ? 'paid_full' : t.product_status) as StatusKey} />
                  <span className={cx('w-[92px] shrink-0 text-right text-[12.5px] font-bold', d > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{d > 0 ? `ค้าง ${baht(d)}` : 'ครบ ✓'}</span>
                  <span className="w-[72px] shrink-0 text-right text-[11px] text-ink-faint">{fmtDate(t.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
