'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/state/AuthProvider';
import { cx } from './ui';

/**
 * Floating switch between the customer site and the admin desktop.
 * Shown only to shop admins (logged-in admin FB account) or in local dev —
 * real customers never see it.
 */
export function PreviewSwitcher() {
  const path = usePathname();
  const { isAdmin: isAdminUser } = useAuth();
  const onAdmin = path.startsWith('/admin');
  const show = isAdminUser || process.env.NODE_ENV !== 'production';
  if (!show) return null;
  const base = 'rounded-full px-3.5 py-1.5 text-xs font-bold';
  return (
    // อยู่เหนือแถบ "ชำระรวม" ของกระเป๋า และอยู่ใต้แผง/ป๊อปอัป (z 110 < 120) — เดิมบังบรรทัดบัญชีรับเงินในแผงเปลี่ยนใบ (audit รอบ E R3-25)
    <div className="fixed bottom-[148px] right-3 z-[110] flex gap-1 rounded-full border border-subtle bg-[rgba(10,8,9,.96)] p-1 lg:bottom-4">
      <Link href="/" className={cx(base, !onAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>📱 ลูกค้า</Link>
      <Link href="/admin" className={cx(base, onAdmin ? 'bg-primary text-white' : 'text-ink-muted')}>🖥️ แอดมิน</Link>
    </div>
  );
}
