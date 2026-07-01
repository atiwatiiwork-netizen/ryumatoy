'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, StatusBadge, ProgressBar } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { paidPercent } from '@/domain/services/tickets';

/** Home — responsive (mobile phone layout ↔ desktop top-nav web, HANDOFF.md). */
export default function HomePage() {
  const db = useDatabase();
  const CURRENT_USER_ID = useCurrentUserId();
  const hero = db.products.filter((p) => !p.is_stock)[0];
  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).slice(0, 3);
  const newest = [...db.products].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 5);

  return (
    <div>
      {/* mobile app bar (hidden on desktop top-nav) */}
      <div className="mb-4 flex items-center justify-between lg:hidden">
        <div className="flex items-center gap-2.5">
          <img src="/ryuma-logo.png" alt="Ryuma" width={38} height={38} className="rounded-[10px]" />
          <div>
            <div className="text-lg font-extrabold leading-none">Ryuma</div>
            <div className="text-[10px] text-ink-faint">ริวมะ · พรีออเดอร์ฟิกเกอร์</div>
          </div>
        </div>
        <button className="relative grid h-10 w-10 place-items-center rounded-full border border-subtle bg-surface-3 text-ink">
          <Icon name="bell" size={20} />
          <span className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full bg-primary-bright" />
        </button>
      </div>

      {/* hero */}
      {hero && (
        <Link
          href={`/shop/${hero.id}`}
          className="relative mb-2 block overflow-hidden rounded-2xl border border-accent-soft lg:mb-7 lg:h-[300px]"
          style={{ background: 'linear-gradient(115deg, rgba(185,28,28,.42), #160d0d 60%, #0d0809 100%)' }}
        >
          <div className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.03)_0_12px,transparent_12px_24px)]" />
          <div className="absolute -left-9 top-5 -rotate-45 bg-cta px-12 py-1 text-[10px] font-extrabold tracking-widest text-white">PRE-ORDER</div>
          <Icon name="box" size={300} strokeWidth={1} className="absolute -right-2 top-4 hidden text-primary/[0.13] lg:block" />
          <div className="relative flex h-[200px] flex-col justify-end p-4 lg:h-full lg:max-w-[520px] lg:justify-center lg:pl-11">
            <div><StatusBadge status={hero.status as StatusKey} /></div>
            <div className="mt-2 text-[19px] font-extrabold leading-tight lg:mt-3.5 lg:text-[40px]">{hero.series_name}</div>
            <div className="mt-0.5 text-xs text-ink-muted2 lg:mb-5 lg:mt-2.5 lg:text-sm">ETA {hero.eta_note} · จองด้วยมัดจำเพียง {baht(hero.deposit_amount)}</div>
            <div className="mt-1 text-xl font-extrabold text-primary-soft lg:hidden">{baht(hero.price_total)}</div>
            <div className="hidden items-center gap-5 lg:flex">
              <Button icon="arrowRight" className="w-auto px-7 py-3">จองเลย</Button>
              <span className="text-[28px] font-extrabold text-primary-soft">{baht(hero.price_total)}</span>
            </div>
          </div>
        </Link>
      )}
      <div className="mb-6 flex justify-center gap-1.5 lg:hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className={i === 0 ? 'h-1 w-[18px] rounded-full bg-primary-bright' : 'h-1 w-1.5 rounded-full bg-white/20'} />
        ))}
      </div>

      {/* my pre-order updates */}
      {myTickets.length > 0 && (
        <>
          <SectionHeader title="อัปเดตพรีของคุณ" href="/wallet" link="ไปกระเป๋าใบพรี →" />
          <div className="mb-8 flex gap-3 overflow-x-auto pb-1.5 no-scrollbar lg:grid lg:grid-cols-3 lg:overflow-visible">
            {myTickets.map((t) => {
              const product = db.products.find((p) => p.id === t.product_id)!;
              const due = t.remaining_amount - t.remaining_paid;
              const sub = t.status === 'paid_full' || due <= 0 ? 'จ่ายครบแล้ว ✓' : t.product_status === 'arrived' ? `รอชำระส่วนต่าง ${baht(due)}` : `ค้างจ่าย ${baht(due)}`;
              return (
                <Link key={t.id} href="/wallet" className="min-w-[168px] rounded-card border border-subtle bg-surface-2 p-4 lg:min-w-0">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
                    <StatusBadge status={(t.status === 'paid_full' ? 'paid_full' : t.product_status) as StatusKey} />
                  </div>
                  <div className="mb-3 text-[15px] font-bold leading-tight">{product.series_name}</div>
                  <ProgressBar pct={paidPercent(t.deposit_paid, t.remaining_amount, t.remaining_paid)} fill={STATUS_FILL[t.product_status as StatusKey]} />
                  <div className={`mt-2.5 text-xs ${due > 0 ? 'text-ink-muted' : 'text-[#4ade80]'}`}>{sub}</div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {/* newest */}
      <SectionHeader title="มาใหม่ล่าสุด" href="/shop" link="ดูทั้งหมด →" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
        {newest.map((p) => <ProductCard key={p.id} product={p} />)}
      </div>
    </div>
  );
}

function SectionHeader({ title, href, link }: { title: string; href: string; link: string }) {
  return (
    <div className="mb-3 flex items-center justify-between lg:mb-4">
      <div className="text-[17px] font-extrabold lg:text-xl">{title}</div>
      <Link href={href} className="text-[13.5px] font-semibold text-primary-soft">{link}</Link>
    </div>
  );
}
