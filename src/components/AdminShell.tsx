'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useAuth, canLogin } from '@/state/AuthProvider';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';

/** Desktop admin frame: 230px side nav + main (HANDOFF.md §Admin Dashboard). */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const db = useDatabase();
  const { isAdmin, isLoggedIn, signInFacebook } = useAuth();

  // lock the admin panel to admin Facebook accounts on live (preview/dev stays open)
  if (canLogin && !isAdmin) return <AdminLock isLoggedIn={isLoggedIn} onLogin={signInFacebook} />;
  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending').length;
  const awaitingParcel = db.tickets.filter((t) => t.product_status === 'arrived' && t.remaining_paid >= t.remaining_amount && !t.parcel_no).length;

  const nav: { href: string; icon: IconName; label: string; active: boolean; badge?: number }[] = [
    { href: '/admin', icon: 'dashboard', label: 'Dashboard', active: path === '/admin' },
    { href: '/admin/orders', icon: 'ticket', label: 'สลิป / ออเดอร์', active: path.startsWith('/admin/orders'), badge: pending.length + pendingRP + awaitingParcel },
    { href: '/admin/products', icon: 'box', label: 'จัดการสินค้า', active: path.startsWith('/admin/products') },
    { href: '/admin/production', icon: 'swap', label: 'ปิดรอบสั่งผลิต', active: path.startsWith('/admin/production') },
    { href: '/admin/stock', icon: 'bolt', label: 'ขายสต๊อกส่วนเกิน', active: path.startsWith('/admin/stock') },
    { href: '/admin/members', icon: 'user', label: 'สมาชิก', active: path.startsWith('/admin/members'), badge: db.users.filter((u) => u.approved === false).length },
    { href: '/admin/ranks', icon: 'verified', label: 'Ranks', active: path.startsWith('/admin/ranks'), badge: db.rankRequests.filter((r) => r.status === 'pending').length },
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

/** Shown when a non-admin (or logged-out) visitor hits /admin on the live site. */
function AdminLock({ isLoggedIn, onLogin }: { isLoggedIn: boolean; onLogin: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-base px-6 text-center font-sans text-ink">
      <div className="w-full max-w-[380px] rounded-3xl border border-subtle bg-surface-2 p-8">
        <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-[#b91c1c]/[0.15]"><Icon name="verified" size={30} className="text-primary-soft" /></div>
        <div className="text-lg font-extrabold">ส่วนผู้ดูแลระบบ</div>
        {isLoggedIn ? (
          <>
            <div className="mt-1.5 text-[13px] text-ink-muted2">บัญชี Facebook นี้ไม่มีสิทธิ์แอดมิน</div>
            <Link href="/" className="mt-5 inline-block w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">← กลับหน้าร้าน</Link>
          </>
        ) : (
          <>
            <div className="mt-1.5 text-[13px] text-ink-muted2">เข้าสู่ระบบด้วยบัญชี Facebook ของแอดมิน</div>
            <button onClick={onLogin} className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-xl bg-[#1877f2] py-3 text-sm font-bold text-white">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[13px] font-black text-[#1877f2]">f</span> เข้าสู่ระบบด้วย Facebook
            </button>
            <Link href="/" className="mt-2.5 inline-block text-[12.5px] text-ink-faint">กลับหน้าร้าน</Link>
          </>
        )}
      </div>
    </div>
  );
}
