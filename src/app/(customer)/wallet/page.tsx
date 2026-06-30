'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { baht, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, cx } from '@/components/ui';

type Tab = 'all' | 'active' | 'paid_full';

export default function WalletPage() {
  const db = useDatabase();
  const [tab, setTab] = useState<Tab>('all');

  const mine = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID);
  const filtered = mine.filter((t) => (tab === 'all' ? true : tab === 'active' ? t.status === 'active' : t.status === 'paid_full'));
  const totalDue = mine.reduce((s, t) => s + (t.remaining_amount - t.remaining_paid), 0);

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="text-[26px] font-extrabold">กระเป๋าพรี</div>
      <div className="mb-4 mt-1 text-[13px] text-ink-muted">{mine.length} ใบ · ค้างชำระรวม <span className="font-bold text-primary-soft">{baht(totalDue)}</span></div>

      <div className="mb-[18px] flex gap-2">
        {([['all', 'ทั้งหมด'], ['active', 'Active'], ['paid_full', 'จ่ายครบ']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cx('rounded-full border px-4 py-2 text-[13px] font-bold', tab === k ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{label}</button>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {filtered.map((t) => {
          const product = db.products.find((p) => p.id === t.product_id)!;
          const due = t.remaining_amount - t.remaining_paid;
          return (
            <Link key={t.id} href={`/wallet/${t.ticket_no}`} className="flex overflow-hidden rounded-card border border-subtle bg-surface-2">
              <div className="w-1" style={{ background: STATUS_FILL[t.product_status as StatusKey] }} />
              <div className="flex min-w-0 flex-1 gap-3 p-3">
                <div className="grid h-[66px] w-[66px] flex-shrink-0 place-items-center rounded-[10px] border border-subtle bg-stripe">
                  <Icon name="box" size={26} className="text-primary-soft/25" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
                    <StatusBadge status={(t.status === 'paid_full' ? 'paid_full' : t.product_status) as StatusKey} />
                  </div>
                  <div className="my-1.5 text-[13px] font-semibold leading-tight">{product.series_name}</div>
                  <div className="flex items-center justify-between">
                    <span className={cx('text-[12.5px] font-semibold', due > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{due > 0 ? `ค้าง ${baht(due)}` : 'จ่ายครบแล้ว ✓'}</span>
                    <Icon name="qr" size={18} className="text-ink-faint" />
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
        {filtered.length === 0 && <div className="py-12 text-center text-ink-faint">ยังไม่มีใบพรีในหมวดนี้</div>}
      </div>
    </div>
  );
}
