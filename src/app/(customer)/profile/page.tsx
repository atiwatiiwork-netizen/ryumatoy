'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth, useCurrentUserId, canLogin } from '@/state/AuthProvider';
import { updateUser } from '@/data/mutations';
import { store } from '@/data/store';
import { AddressForm } from '@/components/AddressForm';
import { shippingInfoOf, composeAddress, addressProblem } from '@/domain/services/address';
import type { User, ShippingInfo } from '@/domain/entities';
import { RANK } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { Button, ProgressBar, RankBadge, cx } from '@/components/ui';
import { rankPiecesOf, nextRankInfo } from '@/domain/services/ranks';
import { usableGrantsFor } from '@/domain/services/coupons';
import { missionLive, missionSubmissionFor } from '@/domain/services/missions';
import { balanceOf, pointsVisibleTo } from '@/domain/services/points';
import { RankPerksButton } from '@/components/RankModals';
import { AuthScreen } from '@/components/AuthScreen';
import { EventProgress } from '@/components/EventBits';
import { PushToggle } from '@/components/PushToggle';

export default function ProfilePage() {
  const db = useDatabase();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();
  const { isLoggedIn, needsApproval, signOut } = useAuth();
  if (canLogin && !isLoggedIn) return <AuthScreen />;
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);
  if (!me) return <div className="p-10 text-center text-ink-faint">กำลังโหลด…</div>;
  const r = RANK[me.rank];

  const pieces = rankPiecesOf(db, me.id);
  const next = nextRankInfo(db.settings, me.rank, pieces);
  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).length;
  const myCoupons = usableGrantsFor(db, CURRENT_USER_ID).length;
  const myPoints = balanceOf(db, CURRENT_USER_ID);
  const progress = next ? Math.min(100, (pieces / next.target) * 100) : 100;

  // Only ใบพรีของฉัน + คูปอง are live this phase; การแจ้งเตือน is a live toggle rendered
  // specially below; the rest are coming soon.
  const mySourcing = db.sourcingRequests.filter((r) => r.user_id === CURRENT_USER_ID && !['expired'].includes(r.status)).length;
  const myOpenPlans = db.paymentPlans.filter((p) => p.user_id === CURRENT_USER_ID && p.status === 'open');
  const myPlans = myOpenPlans.length;
  const planToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const myPlansDue = myOpenPlans.filter((p) => p.due_date <= planToday).length;
  const menu: { icon: IconName; label: string; href?: string; right?: React.ReactNode; push?: boolean }[] = [
    { icon: 'ticket', label: 'ใบพรีของฉัน', href: '/wallet', right: <Pill>{myTickets}</Pill> },
    { icon: 'tag', label: 'คูปองของฉัน', href: '/coupons', right: myCoupons ? <Pill>{myCoupons}</Pill> : undefined },
    // คะแนนสะสม (v66) — ซ่อนจากลูกค้าจนกว่าจะเปิดสวิตช์ (เจ้าของ 2026-09-12); แอดมินเห็นเพื่อพรีวิว
    ...(pointsVisibleTo(db, CURRENT_USER_ID)
      ? [{ icon: 'verified' as IconName, label: 'คะแนนสะสม', href: '/points', right: <Pill>⭐ {myPoints.toLocaleString('en-US')}</Pill> }]
      : []),
    { icon: 'heart', label: 'Event ภารกิจ', href: '/missions', right: missionLive(db) && missionSubmissionFor(db, CURRENT_USER_ID)?.status !== 'approved' ? <span className="animate-pulse rounded-full bg-[#d4af37]/[0.2] px-2 py-0.5 text-[10.5px] font-bold text-[#f1d27a]">🎁 มีกิจกรรม!</span> : undefined },
    // นัดชำระที่แอดมินออกให้ — กดจ่ายได้จากหน้านี้ (v57 เจ้าของ 2026-07-26)
    { icon: 'payments', label: 'นัดชำระ', href: '/plans', right: myPlans ? <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-bold', myPlansDue ? 'animate-blink bg-[#b91c1c]/25 text-[#f87171]' : 'bg-[#a855f7]/20 text-[#c084fc]')}>{myPlansDue ? `ถึงกำหนด ${myPlansDue}` : `${myPlans} รายการ`}</span> : undefined },
    { icon: 'search', label: 'หาของ', href: '/sourcing', right: mySourcing ? <Pill>{mySourcing}</Pill> : undefined },
    // ประวัติการซื้อ + สลิป (เจ้าของ 2026-07-25)
    { icon: 'copy', label: 'ประวัติการซื้อ', href: '/history' },
    { icon: 'bell', label: 'การแจ้งเตือน', push: true },
    { icon: 'swap', label: 'รายการขาย P2P' },
    { icon: 'settings', label: 'ธีม' },
  ];

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="flex flex-col items-center py-5">
        <div className="relative">
          <div className="h-[84px] w-[84px] rounded-full p-[3px]" style={{ background: r.grad.replace('135deg', '135deg') }}>
            <div className="grid h-full w-full place-items-center rounded-full bg-surface-4 text-[30px] font-extrabold text-ink">{me.display_name.charAt(0)}</div>
          </div>
          <div className="absolute bottom-0.5 right-0.5 grid h-[26px] w-[26px] place-items-center rounded-full border-2 border-base bg-[#1877f2] text-[13px] font-extrabold text-white">f</div>
        </div>
        <div className="mt-3 text-[19px] font-extrabold">{me.display_name}</div>
        <div className="mt-0.5 font-mono text-xs text-ink-faint">{me.member_code ? `รหัสสมาชิก ${me.member_code}` : isLoggedIn ? 'สมาชิก Ryuma' : 'โหมดเดโม'}</div>
        {needsApproval && <div className="mt-1.5 rounded-full border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-1 text-[11.5px] font-bold text-[#fbbf24]">⏳ รอแอดมินอนุมัติสมาชิก</div>}
      </div>

      {/* ที่อยู่จัดส่ง — โชว์แยกช่อง + ปุ่มแก้ไข (แพลตฟอร์มที่อยู่ เจ้าของ 2026-09-12) */}
      <ShippingCard me={me} />

      <div className="mb-[18px] rounded-2xl border p-[18px]" style={{ background: r.grad, borderColor: 'transparent' }}>
        <div className="mb-3 flex items-center justify-between">
          <RankBadge rank={me.rank} large />
          <RankPerksButton className="text-xs font-semibold text-ink-muted2 underline" />
        </div>
        {next ? (
          <>
            <div className="mb-[7px] flex justify-between text-xs text-ink-muted2"><span>สะสม {pieces} ชิ้น</span><span>{RANK[next.next].label} · {next.target} ชิ้น</span></div>
            <ProgressBar pct={progress} fill={r.cls.includes('f1d27a') ? '#f1d27a' : '#d7dde6'} />
            <div className="mt-1.5 text-[11.5px] text-ink-faint">อีก {next.need} ชิ้น จะได้เลื่อนเป็น {RANK[next.next].label}</div>
          </>
        ) : (
          // ขั้นสูงสุดมีหลายขั้น (gold/diamond/legend) — เดิมฮาร์ดโค้ดว่า Gold ทำให้ Diamond เห็นผิด
          <div className="text-[12.5px] text-ink-muted2">{r.emoji} คุณคือสมาชิก {r.label} — ขอบคุณที่อุดหนุน!</div>
        )}
      </div>

      <div className="mb-[18px] overflow-hidden rounded-card border border-subtle bg-surface-2">
        {menu.map((m, i) =>
          m.push ? (
            <PushToggle key={m.label} userId={CURRENT_USER_ID} divider={i > 0} />
          ) : m.href ? (
            <Link key={m.label} href={m.href} className={`flex items-center gap-3 px-4 py-3.5 ${i ? 'border-t border-hair' : ''}`}>
              <Icon name={m.icon} size={20} className="text-primary-soft" />
              <span className="flex-1 text-sm font-medium">{m.label}</span>
              {m.right}
              <Icon name="chevronRight" size={18} className="text-ink-faint" />
            </Link>
          ) : (
            <div key={m.label} className={`flex items-center gap-3 px-4 py-3.5 opacity-45 ${i ? 'border-t border-hair' : ''}`}>
              <Icon name={m.icon} size={20} className="text-ink-faint" />
              <span className="flex-1 text-sm font-medium">{m.label}</span>
              <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[10.5px] text-ink-faint">เร็วๆ นี้</span>
            </div>
          ),
        )}
      </div>

      {/* live-event progress toward the next reward coupon (renders nothing when no event) */}
      <div className="mb-[18px]"><EventProgress variant="card" /></div>

      {isLoggedIn ? (
        <Button variant="outline" icon="logout" className="border-[#f87171]/40 text-[#f87171]" onClick={signOut}>ออกจากระบบ</Button>
      ) : (
        <Button variant="outline" className="border-subtle text-ink-faint" onClick={() => flash('โหมดพรีวิว')}>โหมดพรีวิว</Button>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-lg bg-surface-3 px-2.5 py-0.5 text-xs font-bold text-ink-muted2">{children}</span>;
}

/* ── ที่อยู่จัดส่ง: การ์ดโชว์แยกช่อง + ปุ่มแก้ไข → modal ฟอร์ม AddressForm (shared) ──────────
   ประกาศนอกฟังก์ชันหน้า (DNA react-state) — หน้าแม่ re-render แล้วฟอร์มต้องไม่ถูกล้าง */
function ShippingCard({ me }: { me: User }) {
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [editing, setEditing] = useState(false);
  const [info, setInfo] = useState<ShippingInfo>({});
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const openEdit = () => { setInfo(shippingInfoOf(me)); setLine(me.line_id ?? ''); setEditing(true); };
  const save = async () => {
    const bad = addressProblem(info);
    if (bad) return flash(bad);
    setBusy(true);
    // ⚠ shipping_address (ข้อความประกอบแล้ว) ต้องเขียนคู่กับ shipping_info เสมอ — ใบปะหน้า A4 /
    //   หน้าจัดส่ง / หน้าแอดมิน / needsProfile gate อ่านช่องข้อความเดิม (services/address.ts)
    dispatch(updateUser(me.id, { shipping_info: info, shipping_address: composeAddress(info), line_id: line.trim() || undefined }));
    const failed = await store.flush();
    setBusy(false);
    flash(failed ? 'เน็ตสะดุด — บันทึกไว้ในเครื่องแล้ว ระบบกำลังส่งขึ้นระบบให้อัตโนมัติ' : 'บันทึกที่อยู่แล้ว ✓');
    setEditing(false);
  };
  const i = me.shipping_info;
  const hasAny = !!(i?.address || me.shipping_address || me.phone);
  const Row = ({ label, value }: { label: string; value?: string }) =>
    value ? <div className="flex gap-2 py-0.5 text-[13px]"><span className="w-14 shrink-0 text-ink-faint">{label}</span><span className="min-w-0 flex-1 text-ink">{value}</span></div> : null;
  return (
    <div className="mb-[18px] rounded-card border border-subtle bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink"><Icon name="truck" size={15} className="text-primary-soft" /> ที่อยู่จัดส่ง</div>
        <button onClick={openEdit} className="flex items-center gap-1 rounded-lg border border-subtle bg-surface-3 px-2.5 py-1 text-[11.5px] font-bold text-ink-muted2 hover:border-accent hover:text-primary-soft">
          ✏️ แก้ไข
        </button>
      </div>
      {!hasAny ? (
        <button onClick={openEdit} className="w-full rounded-xl border border-dashed border-subtle py-3 text-[12.5px] text-ink-faint">
          ยังไม่มีที่อยู่ในระบบ — แตะเพื่อเพิ่มที่อยู่จัดส่ง
        </button>
      ) : (
        <>
          <Row label="ผู้รับ" value={i?.name ?? me.display_name} />
          <Row label="เบอร์" value={i?.phone ?? me.phone} />
          <Row label="ที่อยู่" value={i?.address ?? me.shipping_address} />
          {(i?.province || i?.postal) && (
            <div className="mt-1 flex flex-wrap gap-1.5 pl-16 text-[11px] font-bold">
              {i?.province && <span className="rounded-md bg-white/[0.07] px-2 py-0.5 text-ink-muted2">📍 {i.province}</span>}
              {i?.postal && <span className="rounded-md bg-white/[0.07] px-2 py-0.5 font-mono text-ink-muted2">{i.postal}</span>}
            </div>
          )}
          {me.line_id && <Row label="LINE" value={me.line_id} />}
        </>
      )}

      {editing && (
        <div className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-black/75 p-5" onClick={() => !busy && setEditing(false)}>
          <div className="w-full max-w-[440px] rounded-3xl border border-subtle bg-surface-2 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center gap-2 text-lg font-extrabold text-ink"><Icon name="truck" size={20} className="text-primary-soft" /> แก้ไขที่อยู่จัดส่ง</div>
            <div className="mb-4 text-[12.5px] text-ink-faint">ใช้กับพัสดุทุกกล่องที่ส่งแบบ &quot;ตามที่อยู่ที่ลงทะเบียน&quot;</div>
            <div className="flex flex-col gap-3">
              <AddressForm value={info} onChange={setInfo} />
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-ink-muted">LINE ID <span className="text-ink-faint">(ไม่บังคับ)</span></span>
                <input className="w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13.5px] text-ink outline-none focus:border-accent" value={line} onChange={(e) => setLine(e.target.value)} placeholder="@yourline" />
              </label>
              <div className="mt-1 flex gap-2.5">
                <button onClick={() => setEditing(false)} disabled={busy} className="flex-1 rounded-xl border border-subtle bg-surface-3 py-3 text-sm font-bold text-ink-muted2">ยกเลิก</button>
                <button onClick={save} disabled={busy} className="flex-[2] rounded-xl bg-cta py-3 text-sm font-bold text-white">{busy ? 'กำลังบันทึก…' : '💾 บันทึกที่อยู่'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
