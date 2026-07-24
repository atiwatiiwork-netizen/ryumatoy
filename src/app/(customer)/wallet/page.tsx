'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, cx } from '@/components/ui';
import { manufacturerOf, productLabel, lineImage } from '@/domain/services/catalog';
import { ticketBadgeKey, ticketDone } from '@/domain/services/delivery';
import { usableGrantsFor } from '@/domain/services/coupons';
import { MyCoupons } from '@/components/CouponTicket';
import type { PreorderTicket } from '@/domain/entities';

type Tab = 'all' | 'preorder' | 'shipping' | 'done' | 'coupon';

// ทั้งหมด / ใบพรี (จอง+ผลิต ยังไม่จบ) / กำลังเดินทาง / เรียบร้อย (ถึงไทย/จ่ายครบ/เสร็จสิ้น)
// Big Test 2026-07-19: ตั๋ว in-stock (ps 'open' แต่จ่ายเต็มตั้งแต่ซื้อ) เคยหลุดไปอยู่แท็บ "ใบพรี"
// และตั๋ว shipped/delivered ของ in-stock ไม่เข้าแท็บไหนเลย → ตัดสินด้วย "จบ/จ่ายครบ" ก่อนเสมอ
function matchTab(tab: Tab, t: PreorderTicket): boolean {
  if (tab === 'all') return true;
  // จ่ายครบแต่ของยังเดินทางอยู่ = "กำลังเดินทาง" อย่างเดียว (เคยโผล่ 2 แท็บพร้อมกัน audit 2026-07-23);
  // ตั๋วจบงาน (shipped) อยู่ "เรียบร้อย" เสมอ
  const inTransit = t.product_status === 'shipping' && t.status !== 'shipped';
  if (tab === 'done') return ticketDone(t) && !inTransit;
  if (tab === 'shipping') return inTransit;
  return (t.product_status === 'open' || t.product_status === 'production') && !ticketDone(t); // ใบพรีที่ยังเดินอยู่
}

export default function WalletPage() {
  const db = useDatabase();
  const CURRENT_USER_ID = useCurrentUserId();
  const [tab, setTab] = useState<Tab>('all');
  const [newest, setNewest] = useState(true);

  const mine = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID);
  const totalDue = mine.reduce((s, t) => s + (t.remaining_amount - t.remaining_paid), 0);
  const couponCount = usableGrantsFor(db, CURRENT_USER_ID).length;

  const filtered = mine
    .filter((t) => matchTab(tab, t))
    .sort((a, b) => (newest ? (a.created_at < b.created_at ? 1 : -1) : a.created_at < b.created_at ? -1 : 1));

  // group by ค่าย (maker), preserving the sorted order within each group
  const groups: { makerId: string; makerName: string; tickets: PreorderTicket[] }[] = [];
  for (const t of filtered) {
    const product = db.products.find((p) => p.id === t.product_id);
    const maker = product ? manufacturerOf(db, product) : undefined;
    const makerId = maker?.id ?? 'none';
    const makerName = maker?.name ?? 'อื่นๆ';
    let g = groups.find((x) => x.makerId === makerId);
    if (!g) { g = { makerId, makerName, tickets: [] }; groups.push(g); }
    g.tickets.push(t);
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="text-[26px] font-extrabold">กระเป๋าพรี</div>
      <div className="mb-4 mt-1 text-[13px] text-ink-muted">{mine.length} ใบ · ค้างชำระรวม <span className="font-bold text-primary-soft">{baht(totalDue)}</span></div>

      <div className="mb-[18px] flex items-center gap-2">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {([['all', 'ทั้งหมด'], ['preorder', 'ใบพรี'], ['shipping', 'กำลังเดินทาง'], ['done', 'เรียบร้อย'], ['coupon', 'คูปอง']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-[13px] font-bold', tab === k ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>
              {label}{k === 'coupon' && couponCount > 0 && <span className={cx('rounded-full px-1.5 text-[10px] font-extrabold', tab === k ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{couponCount}</span>}
            </button>
          ))}
        </div>
        {tab !== 'coupon' && (
          <button onClick={() => setNewest((v) => !v)} className="ml-auto flex flex-shrink-0 items-center gap-1.5 rounded-full border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-ink-muted2">
            <Icon name="swap" size={15} /> {newest ? 'ใหม่→เก่า' : 'เก่า→ใหม่'}
          </button>
        )}
      </div>

      {tab === 'coupon' ? <MyCoupons uid={CURRENT_USER_ID} /> : (<>
      {groups.map((g) => (
        <div key={g.makerId} className="mb-5">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink-muted">
            <Icon name="store" size={15} className="text-primary-soft" />
            {g.makerName}
            <span className="text-ink-faint">· {g.tickets.length}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {g.tickets.map((t) => {
              const due = t.remaining_amount - t.remaining_paid;
              const img = lineImage(db, t.product_id, t.variant_id);
              return (
                <Link key={t.id} href={`/wallet/${t.ticket_no}`} className="flex overflow-hidden rounded-card border border-subtle bg-surface-2">
                  {/* แถบสี + ป้าย ใช้ key เดียวกัน (ฐานระบบ flow รับของ: submit → รอจัดส่ง, ส่งแล้ว → เสร็จสิ้น) */}
                  <div className="w-1" style={{ background: STATUS_FILL[ticketBadgeKey(t) as StatusKey] }} />
                  <div className="flex min-w-0 flex-1 gap-3 p-3">
                    <div className="h-[66px] w-[66px] flex-shrink-0 overflow-hidden rounded-[10px] border border-subtle">
                      {img
                        ? <img src={img} alt="" className="h-full w-full object-cover" />
                        : <div className="grid h-full w-full place-items-center bg-stripe"><Icon name="box" size={26} className="text-primary-soft/25" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
                        <StatusBadge status={ticketBadgeKey(t) as StatusKey} />
                      </div>
                      <div className="my-1.5 text-[13px] font-semibold leading-tight">{productLabel(db, t.product_id, t.variant_id)}</div>
                      <div className="flex items-center justify-between">
                        <span className={cx('text-[12.5px] font-semibold', due > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{due > 0 ? `ค้าง ${baht(due)}` : 'จ่ายครบแล้ว ✓'}</span>
                        <Icon name="qr" size={18} className="text-ink-faint" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      {filtered.length === 0 && <div className="py-12 text-center text-ink-faint">ยังไม่มีใบพรีในหมวดนี้</div>}
      </>)}
    </div>
  );
}
