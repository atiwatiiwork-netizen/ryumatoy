'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useDatabase } from '@/state/DataProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';
import { RankCongrats } from './RankModals';

const TABS: { href: string; icon: IconName; label: string; topLabel: string }[] = [
  { href: '/', icon: 'home', label: 'หน้าแรก', topLabel: 'หน้าแรก' },
  { href: '/shop', icon: 'store', label: 'ช็อป', topLabel: 'ช็อป' },
  { href: '/profile', icon: 'user', label: 'โปรไฟล์', topLabel: 'โปรไฟล์' },
];

/**
 * Responsive customer frame (HANDOFF.md §Customer Desktop). Below lg it's a
 * mobile PWA with a bottom tab bar; at lg+ it reflows to a full-width top nav +
 * centered 1140px content.
 */
export function CustomerShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { count } = useCart();
  const { flash } = useToast();
  const db = useDatabase();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);
  const isActive = (href: string) =>
    href === '/' ? path === '/' : path.startsWith(href);

  return (
    <div className="min-h-screen bg-base">
      {/* desktop top nav */}
      <header className="sticky top-0 z-50 hidden border-b border-subtle bg-surface lg:block">
        <div className="mx-auto flex max-w-[1140px] items-center gap-[18px] px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/ryuma-logo.png" alt="Ryuma" width={34} height={34} className="rounded-[9px]" />
            <span className="text-[19px] font-extrabold">Ryuma</span>
          </Link>
          <nav className="ml-2 flex gap-1">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={cx('rounded-[9px] px-[15px] py-2 text-sm', isActive(t.href) ? 'bg-surface-4 font-bold text-ink' : 'font-medium text-ink-muted')}
              >
                {t.topLabel}
              </Link>
            ))}
            <button onClick={() => flash('P2P Market — กำลังพัฒนา')} className="rounded-[9px] px-[15px] py-2 text-sm font-medium text-ink-muted">P2P Market</button>
          </nav>
          <div className="flex-1" />
          <Link href="/shop" className="flex w-[260px] items-center gap-2 rounded-[10px] border border-subtle bg-surface-3 px-[13px] py-[9px] text-[13.5px] text-ink-faint">
            <Icon name="search" size={17} />
            ค้นหา figure, franchise...
          </Link>
          <Link href="/cart" className="relative grid h-[42px] w-[42px] place-items-center rounded-[10px] border border-subtle bg-surface-3 text-ink">
            <Icon name="cart" size={20} />
            {count > 0 && <span className="absolute -right-1.5 -top-1.5 rounded-full bg-primary-bright px-1.5 text-[10px] font-bold text-white">{count}</span>}
          </Link>
          <Link href="/profile" className="flex items-center gap-2.5 rounded-full border border-subtle bg-surface-3 py-[5px] pl-[5px] pr-3.5 text-ink">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-sm font-bold">{me?.display_name.charAt(0) ?? 'R'}</span>
            <span className="text-[13.5px] font-semibold">ลงขาย</span>
          </Link>
        </div>
      </header>

      {/* content: mobile px-4 with bottom padding for tab bar; desktop centered */}
      <main className="mx-auto max-w-[1140px] px-4 pb-28 pt-3.5 lg:px-6 lg:pb-16 lg:pt-7">{children}</main>

      {/* mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-subtle bg-surface px-1.5 pb-[calc(8px+env(safe-area-inset-bottom))] pt-2 lg:hidden">
        {TABS.map((t) => {
          const on = isActive(t.href);
          return (
            <Link key={t.href} href={t.href} className={cx('relative flex flex-1 flex-col items-center gap-[3px]', on ? 'text-primary-bright' : 'text-ink-faint')}>
              <Icon name={t.icon} size={22} fill={on ? 'rgba(220,38,38,.12)' : 'none'} />
              <span className={cx('text-[10px]', on ? 'font-bold' : 'font-medium')}>{t.label}</span>
            </Link>
          );
        })}
      </nav>

      <PreviewSwitcher />
      <RankCongrats />
    </div>
  );
}
