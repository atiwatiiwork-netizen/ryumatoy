'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

/**
 * Dev-only floating switch between the customer site and the admin desktop.
 * Hidden for real customers in production — shown only in dev, or when the
 * owner opts in with localStorage `ryuma_dev='1'` (so they can still switch on live).
 */
export function PreviewSwitcher() {
  const path = usePathname();
  const isAdmin = path.startsWith('/admin');
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(process.env.NODE_ENV !== 'production' || localStorage.getItem('ryuma_dev') === '1');
  }, []);
  if (!show) return null;
  const base = 'rounded-full px-3.5 py-1.5 text-xs font-bold';
  return (
    <div className="fixed bottom-[78px] right-4 z-[200] flex gap-1 rounded-full border border-subtle bg-[rgba(10,8,9,.96)] p-1 lg:bottom-4">
      <Link href="/" className={cx(base, !isAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>📱 ลูกค้า</Link>
      <Link href="/admin" className={cx(base, isAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>🖥️ แอดมิน</Link>
    </div>
  );
}
