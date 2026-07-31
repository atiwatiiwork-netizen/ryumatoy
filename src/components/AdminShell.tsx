'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useAuth, canLogin } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { store } from '@/data/store';
import { deliveryRequests, parcelQueue, handoffQueue, awaitingChoice } from '@/domain/services/delivery';
import { worklist, plansDue, dataIssues } from '@/domain/services/worklist';
import { needsClose } from '@/domain/services/auctions';
import { markPlanReminded } from '@/data/mutations';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';
import { PreviewSwitcher } from './PreviewSwitcher';

/** Desktop admin frame: 230px side nav + main (HANDOFF.md §Admin Dashboard). */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const db = useDatabase();
  const { isAdmin, isLoggedIn, authReady, signInFacebook } = useAuth();
  const { flash } = useToast();
  // a failed background save (schema drift, RLS, etc.) must not vanish silently → toast it here.
  useEffect(() => {
    store.onPersistError = (m) => flash('บันทึกไม่สำเร็จ — ' + m);
    return () => { store.onPersistError = undefined; };
  }, [flash]);

  // ── เตือนนัดชำระอัตโนมัติเมื่อถึงกำหนด (v57) ────────────────────────────
  // Vercel ไม่ได้รันอะไรตอนเราหลับ (ไม่มี scheduler) → ยิงตอน "แอดมินเปิดแอป" แทน
  // ยิงครั้งเดียวต่อนัด (กันด้วย reminded_at ที่ประทับ + เซฟก่อนยิง) แล้วปุ่มเตือนมือยังใช้ได้เหมือนเดิม
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current || !isAdmin) return;
    if (!pushEnabled(db, 'plan_due')) return;   // ปิดสวิตช์อยู่ → อย่าประทับ reminded_at (v57 #6)
    const today = new Date();
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const targets = plansDue(db)
      .filter((p) => !p.reminded_at)
      // นัดที่เพิ่งออกวันนี้ไม่ต้องเตือนซ้ำ — แอดมินเพิ่งยิง "แอดมินส่งนัดชำระให้คุณ" ไปหมาดๆ (v57 #8)
      .filter((p) => !p.created_at || ymd(new Date(p.created_at)) < ymd(today))
      .filter((p) => subsForUsers(db, [p.user_id]).length > 0);
    if (targets.length === 0) return;
    firedRef.current = true;
    (async () => {
      for (const p of targets) store.update(markPlanReminded(p.id));
      // เซฟก่อนยิง: ถ้าเซฟไม่ผ่านห้ามยิง (ไม่งั้นลูกค้าได้แจ้งเตือนของสิ่งที่ไม่ได้บันทึก)
      // ⚠ ยังกันเตือนซ้ำข้ามเครื่องไม่ได้ 100% — สองเครื่องเปิดพร้อมกันอาจยิงคนละครั้ง
      //   (ต้องมี RPC ฝั่ง server ถึงจะกันได้จริง) แต่ผลเสียแค่ลูกค้าได้ 2 เด้ง
      if (await store.flush()) {
        // เซฟไม่ผ่าน → ต้องถอนตราประทับคืนด้วย ไม่งั้นนัดจะถูกมองว่า "เตือนแล้ว" ทั้งที่ลูกค้าไม่เคยได้รับ
        // แล้วรอบเตือนอัตโนมัติจะข้ามใบนี้ตลอดกาล (audit regression #8)
        for (const p of targets) store.update((d) => ({ ...d, paymentPlans: d.paymentPlans.map((x) => (x.id === p.id ? { ...x, reminded_at: p.reminded_at } : x)) }));
        firedRef.current = false;   // ให้ลองใหม่ได้ในเซสชันนี้
        return;
      }
      for (const p of targets)
        sendPush(subsForUsers(db, [p.user_id]), { title: '📅 ถึงกำหนดชำระแล้วครับ', body: `ยอดที่นัดไว้ ${p.amount.toLocaleString()} บาท — กดจ่ายได้เลยที่เมนู "นัดชำระ"`, url: '/plans' }, (m) => store.update(m)).catch(() => {});
      flash(`เตือนนัดชำระอัตโนมัติ ${targets.length} รายการแล้ว 🔔`);
    })();
  }, [db, isAdmin, flash]);

  // Wait for the session restore before deciding lock-vs-admin — otherwise every resume/reload flashes
  // the Facebook login screen (isLoggedIn is momentarily false), and a stalled getSession would strand
  // the admin on it. authReady is watchdog-bounded so this never hangs. (resume — same as CustomerShell)
  if (canLogin && !authReady) return <div className="grid min-h-screen place-items-center bg-base"><img src="/ryuma-logo.png" alt="" width={44} height={44} className="animate-pulse rounded-xl opacity-80" /></div>;
  // lock the admin panel to admin Facebook accounts on live (preview/dev stays open)
  if (canLogin && !isAdmin) return <AdminLock isLoggedIn={isLoggedIn} onLogin={signInFacebook} />;
  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending').length;
  // งานจัดส่งทั้งหมด (รอลูกค้าเลือกวิธีรับ + คำขอรอรับเรื่อง + รอใส่เลขพัสดุ + รถเข้ารับ/มารับเอง) — badge แท็บ "จัดส่ง"
  const shippingJobs = awaitingChoice(db).length + deliveryRequests(db).length + parcelQueue(db).length + handoffQueue(db).length;
  // badge "งานค้างวันนี้" = งานด่วน (ทำก่อน) + นัดชำระที่ถึงกำหนด + ปัญหาข้อมูลที่ต้องแก้
  const todayJobs = worklist(db).filter((w) => w.urgency === 'now').reduce((s, w) => s + w.count, 0) + plansDue(db).length + dataIssues(db).length;

  const newMembers = db.users.filter((u) => u.approved === false && !u.is_admin).length;
  const rankReq = db.rankRequests.filter((r) => r.status === 'pending').length;
  const sourcingJobs = db.sourcingRequests.filter((r) => r.status === 'requested' || r.status === 'paid').length;
  // ประมูล (v60): หมดเวลาแล้วรอกดสรุปผล + สลิปค่าเข้าสนามรอตรวจ (ไม่มี scheduler — ต้องมีคนกด)
  const auctionJobs = db.auctions.filter((a) => needsClose(a)).length
    + db.auctionEntries.filter((e) => e.status === 'pending').length;

  type NavItem = { href: string; icon: IconName; label: string; active: boolean; badge?: number; sub?: string };
  const it = (href: string, icon: IconName, label: string, badge?: number, sub?: string): NavItem =>
    ({ href, icon, label, active: href === '/admin' ? path === '/admin' : path.startsWith(href), badge, sub });
  // ── โครงเมนู (จัดใหม่ 2026-07-26) ────────────────────────────────────────
  // เดิม 19 ปุ่ม 5 กลุ่ม แบ่งตาม "ชื่อฟีเจอร์" (สินค้า/สมาชิก/ออเดอร์/แบนเนอร์) ทำให้
  //   · งานเดียวกันกระจายหลายเมนู (ปิดรอบ ↔ กระดานปิดพรี, สมาชิก ↔ Ranks, คูปอง ↔ Event)
  //   · กลุ่มชื่อไม่ตรงของข้างใน ("แบนเนอร์" มี Push Control, "ออเดอร์" มีตั้งค่าการเงิน)
  //   · เปิดมาไม่รู้ควรเริ่มตรงไหน เพราะ Dashboard/งานค้างวันนี้/วิเคราะห์ ตอบคำถามใกล้กัน
  // ใหม่: แบ่งตาม "จังหวะการทำงานจริง" → ทำวันนี้ → ของ&รอบ → ลูกค้า → ร้าน
  //   หน้าที่เป็นมุมย่อยของงานเดียวกันถูกยุบไปเป็น "แท็บ" บนหัวหน้าหลัก (AdminTabs) — URL เดิมใช้ได้หมด
  const groups: { title?: string; items: NavItem[] }[] = [
    { title: 'ทำวันนี้', items: [
      // หน้าแรกที่ควรเปิด: รวมงานค้างข้ามทุกโมดูล + นัดชำระ + สุขภาพข้อมูล + ประวัติ
      it('/admin/today', 'bolt', 'งานค้างวันนี้', todayJobs, 'เปิดมาดูอันนี้ก่อน'),
      it('/admin/orders', 'ticket', 'สลิป / ออเดอร์', pending.length + pendingRP, 'ตรวจเงินเข้า'),
      it('/admin/shipping', 'truck', 'จัดส่ง', shippingJobs, 'แพ็ค → เลขพัสดุ'),
      it('/admin/sourcing', 'search', 'หาของ', sourcingJobs, 'ตามของให้ลูกค้า'),
    ] },
    { title: 'ของ & รอบขาย', items: [
      it('/admin/products', 'box', 'Pre-Order', undefined, 'แคตตาล็อกพรี'),
      it('/admin/instock', 'store', 'In-Stock', undefined, 'ของพร้อมส่ง'),
      it('/admin/stock', 'bolt', 'สต๊อกใบพรี', undefined, 'รอบพิเศษ + วงจรของ'),
      it('/admin/production', 'swap', 'ปิดรอบ / กระดาน', undefined, 'ปิดยอด + โพสต์กระดาน'),
      it('/admin/auctions', 'tag', 'ประมูล', auctionJobs, 'ห้องประมูล + ลองเล่นก่อนเปิด'),
    ] },
    { title: 'ลูกค้า', items: [
      it('/admin/members', 'user', 'สมาชิก & Ranks', newMembers + rankReq, 'อนุมัติ + เลื่อนขั้น'),
      it('/admin/tickets', 'qr', 'ตั๋วทั้งหมด', undefined, 'ค้นตั๋ว/ตรวจย้อนหลัง'),
      it('/admin/coupons', 'tag', 'คูปอง & กิจกรรม', undefined, 'ส่วนลด + Event'),
    ] },
    { title: 'ร้าน', items: [
      it('/admin', 'dashboard', 'ภาพรวม & ตัวเลข', undefined, 'เงิน + สถานะรวม'),
      it('/admin/home', 'home', 'หน้าร้าน & โปสเตอร์', undefined, 'แบนเนอร์ + รูปโปรโมท'),
      it('/admin/payment', 'payments', 'ตั้งค่า', undefined, 'บัญชีรับเงิน + แจ้งเตือน'),
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
                  className={cx('flex items-center gap-2.5 rounded-[11px] px-3 py-[9px] text-sm', n.active ? 'bg-cta font-bold text-white' : 'font-medium text-ink-muted2')}
                >
                  <Icon name={n.icon} size={19} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate leading-tight">{n.label}</span>
                    {/* คำอธิบายสั้นใต้ชื่อเมนู — บอกว่าเข้าไปทำอะไร ไม่ต้องเดาจากชื่อ */}
                    {n.sub && <span className={cx('block truncate text-[10px] leading-tight', n.active ? 'text-white/70' : 'text-ink-faint')}>{n.sub}</span>}
                  </span>
                  {n.badge ? <span className="shrink-0 rounded-full bg-primary-bright px-[7px] text-[11px] font-bold text-white">{n.badge}</span> : null}
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
