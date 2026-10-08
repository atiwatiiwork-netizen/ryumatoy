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
import { ticketDue } from '@/domain/services/money';
import { inClosedBoard, openBoards } from '@/domain/services/catalog';
import { homeLines, isNewLine, linesPublicEnabled } from '@/domain/services/lines';
import { isAdminUser } from '@/domain/services/admins';
import { LineCoverCard } from '@/components/lines/LineCoverCard';
import { ticketBadgeKey } from '@/domain/services/delivery';
import { ticketPayable, pendingRpFor } from '@/domain/services/payments';

/** Home — responsive (mobile phone layout ↔ desktop top-nav web, HANDOFF.md). */
export default function HomePage() {
  const db = useDatabase();
  const CURRENT_USER_ID = useCurrentUserId();
  // only sellable items appear on home: in-stock, or pre-orders still open for booking
  // (a product whose board has closed has ended its round → not sellable anymore)
  const sellable = (p: (typeof db.products)[number]) => (p.is_stock || p.status === 'open') && !inClosedBoard(db, p);
  const promos = db.settings.announcements ?? [];
  const closingBoards = openBoards(db);
  const lineUps = homeLines(db, CURRENT_USER_ID, 3);
  const isAdmin = isAdminUser(db, CURRENT_USER_ID);
  const myTickets = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID).slice(0, 3);
  const newest = [...db.products].filter(sellable).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 5);

  return (
    <div>
      {/* live event: banner + my progress (renders nothing when no event is running) */}
      <EventBanner />

      {/* promo / announcement carousel (admin-managed, top of home) */}
      {promos.length > 0 && <PromoCarousel promos={promos} />}

      {/* กระดานปิดพรี (เจ้าของ 2026-10-08): โปสเตอร์ใหญ่ย้ายไปแท็บ "ปิดพรี" — หน้าแรกเหลือแถบบรรทัดเดียว */}
      {closingBoards.length > 0 && (
        <Link href="/closing" className="mb-4 flex items-center gap-2.5 rounded-xl border border-[#16a34a]/40 bg-[#0e1310] px-3.5 py-2.5 text-[13px] font-bold lg:mb-6">
          <Icon name="bolt" size={16} className="text-[#4ade80]" /> กำลังปิดพรี
          <span className="rounded-full bg-[#16a34a] px-2 py-0.5 text-[11px] text-white">{closingBoards.length} กระดาน</span>
          <span className="ml-auto text-[12.5px] font-semibold text-[#4ade80]">กดดูรายการ →</span>
        </Link>
      )}

      {/* ไลน์อัป 3 ล่าสุด (v81 · เจ้าของ 2026-10-08) — ไม่มีฟิลเตอร์ที่นี่ (ไปหน้า /lines) · ลูกค้าเห็นเมื่อเปิดสวิตช์แล้ว (homeLines ตัดสิน) */}
      {lineUps.length > 0 && (
        <>
          <SectionHeader title="🧩 ไลน์อัป" href="/lines" link="ดูทั้งหมด →" tag={isAdmin && !linesPublicEnabled(db) ? 'แอดมินเห็นคนเดียว' : undefined} />
          <div className="mb-8 flex flex-col gap-3 lg:grid lg:grid-cols-3 lg:gap-4">
            {lineUps.map((l, i) => (
              <LineCoverCard key={l.id} db={db} line={l} size={i === 0 ? 'hero' : 'wide'} admin={isAdmin} isNew={isNewLine(l)} eager={i === 0} />
            ))}
          </div>
        </>
      )}

      {/* my pre-order updates */}
      {myTickets.length > 0 && (
        <>
          <SectionHeader title="อัปเดตพรีของคุณ" href="/wallet" link="ไปกระเป๋าใบพรี →" />
          <div className="mb-8 flex gap-3 overflow-x-auto pb-1.5 no-scrollbar lg:grid lg:grid-cols-3 lg:overflow-visible">
            {myTickets.map((t) => {
              // ⚠ ห้าม non-null assertion ตรงนี้ (audit 2026-07-25): ถ้าสินค้าถูกลบ/RLS ซ่อน
              // หน้าแรกของลูกค้าจะจอขาวทั้งหน้า — ข้ามการ์ดใบนั้นแทน (กระเป๋าตั๋วก็ทำแบบนี้)
              const product = db.products.find((p) => p.id === t.product_id);
              if (!product) return null;
              const due = ticketDue(t);
              // ข้อความ + สี ผูกกับ ticketBadgeKey ตัวเดียว — ห้ามตัดสินเองจาก field ดิบ (การ์ดเคยขัดแย้งกันเอง)
              const badgeKey = ticketBadgeKey(t);
              const sub = badgeKey === 'shipped' ? 'เสร็จสิ้น รับของเรียบร้อย ✓'
                : badgeKey === 'awaiting_ship' ? 'รอจัดส่ง — เลือกวิธีรับของแล้ว ✓'
                : badgeKey === 'paid_full' || due <= 0 ? 'จ่ายครบแล้ว ✓'
                // ส่งสลิปแล้ว = รอแอดมินตรวจ (เดิมยังบอก "รอชำระ" ทั้งที่จ่ายไปแล้ว — audit 2026-09-12) · เปิดให้จ่าย = กติกาเดียวกับแท็บ "รอชำระ"
                : pendingRpFor(db, t.id) ? `ส่งสลิปแล้ว ${baht(pendingRpFor(db, t.id)!.amount)} · รอตรวจ`
                : ticketPayable(t) ? `รอชำระส่วนต่าง ${baht(due)}` : `ค้างจ่าย ${baht(due)}`;
              return (
                <Link key={t.id} href="/wallet" className="min-w-[168px] rounded-card border border-subtle bg-surface-2 p-4 lg:min-w-0">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
                    <StatusBadge status={badgeKey as StatusKey} />
                  </div>
                  <div className="mb-3 text-[15px] font-bold leading-tight">{product.series_name}</div>
                  <ProgressBar pct={paidPercent(t.deposit_paid, t.remaining_amount, t.remaining_paid)} fill={STATUS_FILL[badgeKey as StatusKey]} />
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

function SectionHeader({ title, href, link, tag }: { title: string; href: string; link: string; tag?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between lg:mb-4">
      <div className="flex items-center gap-2 text-[17px] font-extrabold lg:text-xl">
        {title}
        {tag && <span className="rounded-md bg-[#f59e0b]/15 px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">{tag}</span>}
      </div>
      <Link href={href} className="text-[13.5px] font-semibold text-primary-soft">{link}</Link>
    </div>
  );
}
