'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth, useCurrentUserId, canLogin } from '@/state/AuthProvider';
import { RANK } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { Button, ProgressBar, RankBadge } from '@/components/ui';
import { rankPiecesOf, nextRankInfo } from '@/domain/services/ranks';
import { RankPerksButton } from '@/components/RankModals';

export default function ProfilePage() {
  const db = useDatabase();
  const { flash } = useToast();
  const CURRENT_USER_ID = useCurrentUserId();
  const { isLoggedIn, needsApproval, signInFacebook, signOut } = useAuth();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);
  if (!me) return <div className="p-10 text-center text-ink-faint">กำลังโหลด…</div>;
  const r = RANK[me.rank];

  const pieces = rankPiecesOf(db, me.id);
  const next = nextRankInfo(db.settings, me.rank, pieces);
  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).length;
  const progress = next ? Math.min(100, (pieces / next.target) * 100) : 100;

  // Only ใบพรีของฉัน is live this phase; the rest are coming soon.
  const menu: { icon: IconName; label: string; href?: string; right?: React.ReactNode }[] = [
    { icon: 'ticket', label: 'ใบพรีของฉัน', href: '/wallet', right: <Pill>{myTickets}</Pill> },
    { icon: 'swap', label: 'รายการขาย P2P' },
    { icon: 'bell', label: 'การแจ้งเตือน' },
    { icon: 'store', label: 'ภาษา' },
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
        <div className="mt-0.5 text-xs text-ink-faint">{isLoggedIn ? 'เชื่อมต่อด้วย Facebook' : 'โหมดเดโม (ยังไม่ได้เข้าสู่ระบบ)'}</div>
        {needsApproval && <div className="mt-1.5 rounded-full border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-1 text-[11.5px] font-bold text-[#fbbf24]">⏳ รอแอดมินอนุมัติสมาชิก</div>}
      </div>

      {(me.phone || me.shipping_address) && (
        <div className="mb-[18px] rounded-card border border-subtle bg-surface-2 p-4">
          <div className="mb-2 text-[12.5px] font-bold text-ink">ข้อมูลจัดส่ง</div>
          {me.phone && <div className="flex gap-2 py-0.5 text-[13px]"><span className="w-14 shrink-0 text-ink-faint">เบอร์</span><span className="text-ink">{me.phone}</span></div>}
          {me.shipping_address && <div className="flex gap-2 py-0.5 text-[13px]"><span className="w-14 shrink-0 text-ink-faint">ที่อยู่</span><span className="text-ink">{me.shipping_address}</span></div>}
          {me.line_id && <div className="flex gap-2 py-0.5 text-[13px]"><span className="w-14 shrink-0 text-ink-faint">LINE</span><span className="text-ink">{me.line_id}</span></div>}
        </div>
      )}

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
          <div className="text-[12.5px] text-ink-muted2">🥇 คุณคือสมาชิก Gold — ขอบคุณที่อุดหนุน!</div>
        )}
      </div>

      <div className="mb-[18px] overflow-hidden rounded-card border border-subtle bg-surface-2">
        {menu.map((m, i) =>
          m.href ? (
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

      {isLoggedIn ? (
        <Button variant="outline" icon="logout" className="border-[#f87171]/40 text-[#f87171]" onClick={signOut}>ออกจากระบบ</Button>
      ) : canLogin ? (
        <button onClick={signInFacebook} className="flex w-full items-center justify-center gap-2.5 rounded-btn bg-[#1877f2] py-3.5 text-sm font-bold text-white">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[13px] font-black text-[#1877f2]">f</span> เข้าสู่ระบบด้วย Facebook
        </button>
      ) : (
        <Button variant="outline" className="border-subtle text-ink-faint" onClick={() => flash('ยังไม่ได้ตั้งค่า Facebook (โหมดพรีวิว)')}>โหมดพรีวิว</Button>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-lg bg-surface-3 px-2.5 py-0.5 text-xs font-bold text-ink-muted2">{children}</span>;
}
