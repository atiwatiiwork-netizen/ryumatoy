'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';

/** Desktop admin frame: 230px side nav + main (HANDOFF.md §Admin Dashboard). */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const db = useDatabase();
  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const firstPending = pending[0]?.id;

  const nav: { href: string; icon: IconName; label: string; active: boolean; badge?: number }[] = [
    { href: '/admin', icon: 'dashboard', label: 'Dashboard', active: path === '/admin' },
    { href: firstPending ? `/admin/orders/${firstPending}` : '/admin', icon: 'ticket', label: 'สลิป / ออเดอร์', active: path.startsWith('/admin/orders'), badge: pending.length },
    { href: '/admin/products', icon: 'box', label: 'จัดการสินค้า', active: path.startsWith('/admin/products') },
    { href: '/admin/payment', icon: 'payments', label: 'ตั้งค่าการเงิน', active: path.startsWith('/admin/payment') },
  ];

  return (
    <div className="flex min-h-screen bg-base font-sans text-ink">
      <aside className="sticky top-0 flex h-screen w-[230px] flex-col gap-1 border-r border-subtle bg-sidebar px-3.5 py-5">
        <div className="flex items-center gap-2.5 px-2 pb-[18px] pt-1">
          <img src="/ryuma-logo.png" alt="Ryuma" width={36} height={36} className="rounded-[9px]" />
          <div>
            <div className="text-base font-extrabold">Ryuma</div>
            <div className="text-[10px] tracking-widest text-ink-faint">ADMIN PANEL</div>
          </div>
        </div>
        {nav.map((n) => (
          <Link
            key={n.label}
            href={n.href}
            className={cx('flex items-center gap-2.5 rounded-[11px] px-3 py-[11px] text-sm', n.active ? 'bg-cta font-bold text-white' : 'font-medium text-ink-muted2')}
          >
            <Icon name={n.icon} size={19} />
            <span className="flex-1">{n.label}</span>
            {n.badge ? <span className="rounded-full bg-primary-bright px-[7px] text-[11px] font-bold text-white">{n.badge}</span> : null}
          </Link>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-2.5 rounded-xl border border-subtle bg-surface-2 p-3">
          <div className="grid h-[34px] w-[34px] place-items-center rounded-full bg-primary font-bold">R</div>
          <div className="text-xs">
            <div className="font-semibold">Ryuma Admin</div>
            <div className="text-[10px] text-ink-faint">เจ้าของร้าน</div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-x-hidden px-[30px] py-[26px]">{children}</main>
      <PreviewSwitcher />
    </div>
  );
}
