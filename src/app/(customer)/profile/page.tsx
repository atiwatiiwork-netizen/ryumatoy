'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { baht, RANK } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { Button, ProgressBar, RankBadge } from '@/components/ui';
import { nextTier, tierOf } from '@/domain/services/ranks';

export default function ProfilePage() {
  const db = useDatabase();
  const { flash } = useToast();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID)!;
  const tier = tierOf(db, me.rank);
  const next = nextTier(db, me.rank);
  const r = RANK[me.rank];

  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).length;
  const progress = next ? Math.min(100, (me.total_spent / next.tier.min_spend) * 100) : 100;

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
        <div className="mt-0.5 text-xs text-ink-faint">เชื่อมต่อด้วย Facebook</div>
      </div>

      <div className="mb-[18px] rounded-2xl border p-[18px]" style={{ background: r.grad, borderColor: 'transparent' }}>
        <div className="mb-3 flex items-center justify-between">
          <RankBadge rank={me.rank} large />
          <span className="text-xs text-ink-muted2">ส่วนลด {tier?.discount_percent}%</span>
        </div>
        {next ? (
          <>
            <div className="mb-[7px] flex justify-between text-xs text-ink-muted2"><span>ยอดสะสม {baht(me.total_spent)}</span><span>{RANK[next.tier.name].label} {baht(next.tier.min_spend)}</span></div>
            <ProgressBar pct={progress} fill={r.cls.includes('f1d27a') ? '#f1d27a' : '#9fe9f5'} />
          </>
        ) : (
          <div className="text-[12.5px] text-ink-muted2">คุณอยู่ระดับสูงสุดแล้ว 💎</div>
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

      <Button variant="outline" icon="logout" className="border-[#f87171]/40 text-[#f87171]" onClick={() => flash('ระบบ login กำลังจะมา (เฟสถัดไป)')}>ออกจากระบบ</Button>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-lg bg-surface-3 px-2.5 py-0.5 text-xs font-bold text-ink-muted2">{children}</span>;
}
