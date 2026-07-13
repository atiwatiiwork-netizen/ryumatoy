'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { fillMissingTicketsFor, reclaimOrphanCouponGrants, markInstalled } from '@/data/mutations';
import { isStandalone } from '@/lib/pwa';
import { unmatchedApprovedItems, ticketPrefixCounts } from '@/domain/services/tickets';
import { reserveTicketNos } from '@/lib/ticketno';
import { orphanUsedGrants } from '@/domain/services/coupons';
import { store } from '@/data/store';
import { useCurrentUserId, useAuth, canLogin } from '@/state/AuthProvider';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';
import { RankCongrats } from './RankModals';
import { CouponReceived } from './CouponTicket';
import { ProfileGate } from './ProfileGate';
import { PublicLanding } from './PublicLanding';
import { InstallBellNudge } from './InstallBellNudge';

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
  const dispatch = useDispatch();
  const { count: cartCount } = useCart();
  // cart lives in localStorage → the server always renders 0. Show the badge only after mount so
  // the first client render matches the server HTML (fixes a hydration mismatch on reload with items).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const count = mounted ? cartCount : 0;
  const { flash } = useToast();
  // a failed background save (RLS, schema drift, endpoint collision) must never vanish silently on
  // the CUSTOMER side either — same guard AdminShell has (ryuma-dna-save).
  useEffect(() => {
    store.onPersistError = (m) => flash('บันทึกไม่สำเร็จ — ' + m);
    return () => { store.onPersistError = undefined; };
  }, [flash]);
  const db = useDatabase();
  const CURRENT_USER_ID = useCurrentUserId();
  // SELF-HEAL "จ่ายแล้วตั๋วหาย": a split flush (mobile backgrounding mid-save on a Diamond
  // auto-approve) can persist the order without its tickets. Re-issue MY missing tickets once per
  // session as soon as the data shows a gap — the customer gets them back without contacting admin.
  const healed = useRef(false);
  useEffect(() => {
    if (healed.current || !CURRENT_USER_ID) return;
    const missingItems = unmatchedApprovedItems(db, CURRENT_USER_ID);
    if (missingItems.length === 0) return;
    healed.current = true;
    // reserve server ticket numbers first — this self-heal runs in the CUSTOMER session, where client
    // numbering would collide behind RLS (the very bug that lost the tickets). (migration v47)
    (async () => {
      const startNos = await reserveTicketNos(ticketPrefixCounts(db, missingItems.map((m) => m.item.product_id)));
      dispatch(fillMissingTicketsFor(CURRENT_USER_ID, startNos));
      flash(`กู้คืนใบพรีที่หายไป ${missingItems.length} ใบแล้ว ✓`);
    })();
  }, [db, CURRENT_USER_ID, dispatch, flash]);
  // SELF-HEAL #2: coupons burned by a split flush (grant 'used' but its order/final-payment never
  // persisted) come back automatically too.
  const reclaimed = useRef(false);
  useEffect(() => {
    if (reclaimed.current || !CURRENT_USER_ID) return;
    const orphans = orphanUsedGrants(db, CURRENT_USER_ID).length;
    if (orphans === 0) return;
    reclaimed.current = true;
    dispatch(reclaimOrphanCouponGrants(CURRENT_USER_ID));
    flash(`↩️ คืนคูปอง ${orphans} ใบ (การใช้ครั้งก่อนไม่สมบูรณ์)`);
  }, [db, CURRENT_USER_ID, dispatch, flash]);
  const { needsApproval, isLoggedIn, authReady } = useAuth();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);
  // install-rate: stamp installed_at the first time a logged-in member opens the app in standalone
  // (home-screen). Idempotent mutation → once-only; own-row write is RLS-safe (ryuma-push-adoption).
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !CURRENT_USER_ID || !me || me.installed_at) return;
    if (!isStandalone()) return;
    marked.current = true;
    dispatch(markInstalled(CURRENT_USER_ID));
  }, [CURRENT_USER_ID, me, dispatch]);
  const isActive = (href: string) =>
    href === '/' ? path === '/' : path.startsWith(href);

  // Members-only: anonymous visitors get the landing (first banner + login/signup) instead of the
  // shop. Wait for the session to restore first so logged-in members never flash the login screen.
  if (canLogin) {
    if (!authReady) return <div className="grid min-h-screen place-items-center bg-base"><img src="/ryuma-logo.png" alt="" width={44} height={44} className="animate-pulse rounded-xl opacity-80" /></div>;
    if (!isLoggedIn) return <PublicLanding />;
    // suspended (กันสปาย): the catalog RLS already hides everything — show a clear notice instead of an empty shop
    if (me?.suspended) {
      return (
        <div className="grid min-h-screen place-items-center bg-base px-6 text-center font-sans text-ink">
          <div className="w-full max-w-[380px] rounded-3xl border border-subtle bg-surface-2 p-8">
            <div className="mb-2 text-4xl">⏸️</div>
            <div className="text-lg font-extrabold">บัญชีถูกระงับชั่วคราว</div>
            <div className="mt-1.5 text-[13px] leading-relaxed text-ink-muted2">บัญชีของคุณถูกพักการใช้งานชั่วคราว<br />ติดต่อแอดมินทาง Facebook เพื่อเปิดใช้งานอีกครั้ง</div>
          </div>
        </div>
      );
    }
  }

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
            <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-sm font-bold">{isLoggedIn ? (me?.display_name.charAt(0) ?? '?') : <Icon name="user" size={16} />}</span>
            <span className="text-[13.5px] font-semibold">{isLoggedIn ? (me?.member_code ?? me?.display_name ?? 'โปรไฟล์') : 'เข้าสู่ระบบ'}</span>
          </Link>
        </div>
      </header>

      {/* mobile top bar — the cart lives here on phones (desktop uses the top nav above) */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-subtle bg-surface px-4 py-2.5 lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <img src="/ryuma-logo.png" alt="Ryuma" width={30} height={30} className="rounded-[9px]" />
          <span className="text-[16px] font-extrabold">Ryuma</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/cart" aria-label="ตะกร้า" className="relative grid h-9 w-9 place-items-center rounded-full border border-subtle bg-surface-3 text-ink">
            <Icon name="cart" size={19} />
            {count > 0 && <span className="absolute -right-1 -top-1 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-primary-bright px-1 text-[10px] font-bold text-white">{count}</span>}
          </Link>
          <Link href="/profile" aria-label="การแจ้งเตือน" className="grid h-9 w-9 place-items-center rounded-full border border-subtle bg-surface-3 text-ink">
            <Icon name="bell" size={18} />
          </Link>
        </div>
      </header>

      {needsApproval && (
        <div className="border-b border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-2 text-center text-[12.5px] font-semibold text-[#fbbf24]">
          บัญชีของคุณรอแอดมินอนุมัติ — ดูสินค้าได้ แต่ยังสั่งซื้อไม่ได้
        </div>
      )}
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
      <CouponReceived />
      <ProfileGate />
      {CURRENT_USER_ID && <InstallBellNudge userId={CURRENT_USER_ID} />}
    </div>
  );
}
