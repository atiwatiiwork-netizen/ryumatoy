'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, ProgressBar, cx } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { EventBanner } from '@/components/EventBits';
import { paidPercent } from '@/domain/services/tickets';
import { inClosedBoard } from '@/domain/services/catalog';

/** Home — responsive (mobile phone layout ↔ desktop top-nav web, HANDOFF.md). */
export default function HomePage() {
  const db = useDatabase();
  const CURRENT_USER_ID = useCurrentUserId();
  // only sellable items appear on home: in-stock, or pre-orders still open for booking
  // (a product whose board has closed has ended its round → not sellable anymore)
  const sellable = (p: (typeof db.products)[number]) => (p.is_stock || p.status === 'open') && !inClosedBoard(db, p);
  const promos = db.settings.announcements ?? [];
  const closingBoards = db.boards.filter((b) => b.status === 'open' && b.poster_url);
  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).slice(0, 3);
  const newest = [...db.products].filter(sellable).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 5);

  return (
    <div>
      {/* live event: banner + my progress (renders nothing when no event is running) */}
      <EventBanner />

      {/* promo / announcement carousel (admin-managed, top of home) */}
      {promos.length > 0 && <PromoCarousel promos={promos} />}

      {/* closing pre-order boards (banner #2) */}
      {closingBoards.length > 0 && <BoardBanner boards={closingBoards} />}

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
        {newest.map((p) => <ProductCard key={p.id} product={p} quickAdd />)}
      </div>
    </div>
  );
}

function PromoCarousel({ promos }: { promos: NonNullable<ReturnType<typeof useDatabase>['settings']['announcements']> }) {
  const [i, setI] = useState(0);
  const n = promos.length;
  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 4500);
    return () => clearInterval(t);
  }, [n]);
  const cur = i % n;

  return (
    <div className="mb-4 lg:mb-7">
      <div className="relative overflow-hidden rounded-2xl border border-subtle">
        <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${cur * 100}%)` }}>
          {promos.map((b) => {
            // show the whole banner at its natural aspect ratio (no crop) — full width, auto height
            const img = <img src={b.image_url} alt={b.caption ?? ''} className="block h-auto w-full" />;
            if (!b.link) return <div key={b.id} className="w-full shrink-0">{img}</div>;
            const external = /^https?:\/\//.test(b.link);
            return external
              ? <a key={b.id} href={b.link} target="_blank" rel="noopener noreferrer" className="w-full shrink-0">{img}</a>
              : <Link key={b.id} href={b.link} className="w-full shrink-0">{img}</Link>;
          })}
        </div>
        {n > 1 && (
          <div className="absolute inset-x-0 bottom-2.5 flex justify-center gap-1.5">
            {promos.map((_, k) => (
              <button key={k} onClick={() => setI(k)} aria-label={`slide ${k + 1}`} className={cx('h-1.5 rounded-full transition-all', k === cur ? 'w-5 bg-white' : 'w-1.5 bg-white/50')} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BoardBanner({ boards }: { boards: ReturnType<typeof useDatabase>['boards'] }) {
  const [i, setI] = useState(0);
  const n = boards.length;
  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 5000);
    return () => clearInterval(t);
  }, [n]);
  const cur = i % n;

  return (
    <div className="mb-4 lg:mb-7">
      <div className="relative overflow-hidden rounded-2xl border border-[#16a34a]/40">
        <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${cur * 100}%)` }}>
          {boards.map((b) => (
            <Link key={b.id} href={`/board/${b.id}`} className="relative w-full shrink-0">
              <img src={b.poster_url} alt={b.title} className="block h-auto w-full" />
              {/* blinking "closing pre-order" strip */}
              <div className="pointer-events-none absolute left-0 top-0 flex items-center gap-1.5 rounded-br-xl bg-[#16a34a] px-3 py-1.5 text-[11px] font-extrabold tracking-wide text-white [animation:ryuBlink_1.4s_ease-in-out_infinite]">
                <Icon name="bolt" size={13} /> กำลังปิดพรี · กดดูรายการ
              </div>
            </Link>
          ))}
        </div>
        {n > 1 && (
          <div className="absolute inset-x-0 bottom-2.5 flex justify-center gap-1.5">
            {boards.map((_, k) => (
              <button key={k} onClick={() => setI(k)} aria-label={`board ${k + 1}`} className={cx('h-1.5 rounded-full transition-all', k === cur ? 'w-5 bg-white' : 'w-1.5 bg-white/50')} />
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes ryuBlink{0%,100%{opacity:1}50%{opacity:.28}}`}</style>
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
