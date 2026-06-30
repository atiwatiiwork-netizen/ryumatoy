'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

/**
 * Preview-only floating switch between the customer site and the admin desktop.
 * Not part of the production app — it lets a reviewer jump between both in one
 * running preview. Role is route-based now (/ vs /admin).
 */
export function PreviewSwitcher() {
  const path = usePathname();
  const isAdmin = path.startsWith('/admin');
  const base = 'rounded-full px-3.5 py-1.5 text-xs font-bold';
  return (
    <div className="fixed bottom-[78px] right-4 z-[200] flex gap-1 rounded-full border border-subtle bg-[rgba(10,8,9,.96)] p-1 lg:bottom-4">
      <Link href="/" className={cx(base, !isAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>📱 ลูกค้า</Link>
      <Link href="/admin" className={cx(base, isAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>🖥️ แอดมิน</Link>
    </div>
  );
}
