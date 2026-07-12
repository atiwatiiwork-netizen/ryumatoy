'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useAuth, canLogin } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { store } from '@/data/store';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';

/** Desktop admin frame: 230px side nav + main (HANDOFF.md §Admin Dashboard). */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const db = useDatabase();
  const { isAdmin, isLoggedIn, signInFacebook } = useAuth();
  const { flash } = useToast();
  // a failed background save (schema drift, RLS, etc.) must not vanish silently → toast it here.
  useEffect(() => {
    store.onPersistError = (m) => flash('บันทึกไม่สำเร็จ — ' + m);
    return () => { store.onPersistError = undefined; };
  }, [flash]);

  // lock the admin panel to admin Facebook accounts on live (preview/dev stays open)
  if (canLogin && !isAdmin) return <AdminLock isLoggedIn={isLoggedIn} onLogin={signInFacebook} />;
  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending').length;
  const awaitingParcel = db.tickets.filter((t) => t.product_status === 'arrived' && t.remaining_paid >= t.remaining_amount && !t.parcel_no).length;

  type NavItem = { href: string; icon: IconName; label: string; active: boolean; badge?: number };
  const it = (href: string, icon: IconName, label: string, badge?: number): NavItem => ({ href, icon, label, active: href === '/admin' ? path === '/admin' : path.startsWith(href), badge });
  const groups: { title?: string; items: NavItem[] }[] = [
    { items: [it('/admin', 'dashboard', 'Dashboard'), it('/admin/analytics', 'sliders', 'วิเคราะห์รายเดือน')] },
    { title: 'สินค้า', items: [
      it('/admin/products', 'box', 'Pre-Order'),
      it('/admin/instock', 'store', 'In-Stock'),
      it('/admin/production', 'swap', 'ปิดรอบสั่งผลิต'),
      it('/admin/board', 'tag', 'กระดานปิดพรี'),
      it('/admin/stock', 'bolt', 'สต๊อกใบพรี'),
    ] },
    { title: 'สมาชิก', items: [
      it('/admin/members', 'user', 'สมาชิก', db.users.filter((u) => u.approved === false && !u.is_admin).length),
      it('/admin/ranks', 'verified', 'Ranks', db.rankRequests.filter((r) => r.status === 'pending').length),
      it('/admin/coupons', 'tag', 'คูปอง'),
    ] },
    { title: 'ออเดอร์', items: [
      it('/admin/orders', 'ticket', 'สลิป / ออเดอร์', pending.length + pendingRP + awaitingParcel),
      it('/admin/sourcing', 'search', 'หาของ', db.sourcingRequests.filter((r) => r.status === 'requested' || r.status === 'paid').length),
      it('/admin/tickets', 'qr', 'ตั๋วทั้งหมด'),
      it('/admin/payment', 'payments', 'ตั้งค่าการเงิน'),
    ] },
    { title: 'แบนเนอร์', items: [
      it('/admin/home', 'home', 'หน้าแรก / โปรโมชั่น'),
      it('/admin/events', 'heart', 'กิจกรรม / Event'),
      it('/admin/push', 'bell', 'Push Control'),
      it('/admin/poster', 'camera', 'สร้างรูปโปรโมท'),
    ] },
  ];

  return (
    <div className="flex min-h-screen bg-base font-sans text-ink">
      <aside className="sticky top-0 flex h-screen w-[230px] flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-sidebar px-3.5 py-5">
        <div className="flex items-center gap-2.5 px-2 pb-[14px] pt-1">
          <img src="/ryuma-logo.png" alt="Ryuma" width={36} height={36} className="rounded-[9px]" />
          <div>
            <div className="text-base font-extrabold">Ryuma</div>
            <div className="text-[10px] tracking-widest text-ink-faint">ADMIN PANEL</div>
          </div>
        </div>
        {groups.map((g, gi) => (
          <div key={g.title ?? gi} className={cx(gi > 0 && 'mt-2.5')}>
            {g.title && <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-ink-faint">{g.title}</div>}
            <div className="flex flex-col gap-0.5">
              {g.items.map((n) => (
                <Link
                  key={n.label}
                  href={n.href}
                  className={cx('flex items-center gap-2.5 rounded-[11px] px-3 py-[10px] text-sm', n.active ? 'bg-cta font-bold text-white' : 'font-medium text-ink-muted2')}
                >
                  <Icon name={n.icon} size={19} />
                  <span className="flex-1">{n.label}</span>
                  {n.badge ? <span className="rounded-full bg-primary-bright px-[7px] text-[11px] font-bold text-white">{n.badge}</span> : null}
                </Link>
              ))}
            </div>
          </div>
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
