'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { StatusBadge, cx } from '@/components/ui';
import { manufacturerOf, productLabel, lineImage } from '@/domain/services/catalog';
import { ticketBadgeKey, ticketDone } from '@/domain/services/delivery';
import { ticketPayable, pendingRpFor } from '@/domain/services/payments';
import { ticketDue } from '@/domain/services/money';
import { usableGrantsFor } from '@/domain/services/coupons';
import { balanceOf, pointsVisibleTo } from '@/domain/services/points';
import { MyCoupons } from '@/components/CouponTicket';
import type { Database, PreorderTicket } from '@/domain/entities';

type Tab = 'all' | 'preorder' | 'pay' | 'shipping' | 'done' | 'coupon';

// ทั้งหมด / ใบพรี (จอง+ผลิต ยังไม่จบ) / รอชำระ (เปิดให้จ่ายแล้ว) / กำลังเดินทาง (จ่ายครบ) / เรียบร้อย / คูปอง
// Big Test 2026-07-19: ตั๋ว in-stock (ps 'open' แต่จ่ายเต็มตั้งแต่ซื้อ) เคยหลุดไปอยู่แท็บ "ใบพรี"
// และตั๋ว shipped/delivered ของ in-stock ไม่เข้าแท็บไหนเลย → ตัดสินด้วย "จบ/จ่ายครบ" ก่อนเสมอ
// audit 2026-09-12: ใบถึงไทยที่ยังค้างจ่ายเคยโผล่ "เรียบร้อย" (ticketDone ถือ arrived = จบ) และใบเดินทางที่ค้างอยู่
// "กำลังเดินทาง" → ใบที่เปิดให้จ่ายกระจาย 2 แท็บ ไม่มีที่รวม → เพิ่มแท็บ "รอชำระ" และให้ ticketPayable ตัดสินก่อน
function matchTab(tab: Tab, t: PreorderTicket): boolean {
  if (tab === 'all') return true;
  const payable = ticketPayable(t);
  if (tab === 'pay') return payable;
  // จ่ายครบแต่ของยังเดินทางอยู่ = "กำลังเดินทาง" อย่างเดียว (เคยโผล่ 2 แท็บพร้อมกัน audit 2026-07-23);
  // ตั๋วจบงาน (shipped) อยู่ "เรียบร้อย" เสมอ
  const inTransit = t.product_status === 'shipping' && t.status !== 'shipped';
  if (tab === 'done') return ticketDone(t) && !inTransit && !payable;
  if (tab === 'shipping') return inTransit && !payable;
  return (t.product_status === 'open' || t.product_status === 'production') && !ticketDone(t); // ใบพรีที่ยังเดินอยู่
}

export default function WalletPage() {
  const db = useDatabase();
  const router = useRouter();
  const CURRENT_USER_ID = useCurrentUserId();
  const [tab, setTab] = useState<Tab>('all');
  const [newest, setNewest] = useState(true);
  // เลือกหลายใบเพื่อจ่ายสลิปเดียว (แท็บรอชำระ) — เก็บแค่ใน state หน้า (ไปหน้าจ่ายด้วย query ?t=)
  const [sel, setSel] = useState<Set<string>>(new Set());

  const mine = db.tickets.filter((t) => t.owner_id === CURRENT_USER_ID);
  const totalDue = mine.reduce((s, t) => s + (t.remaining_amount - t.remaining_paid), 0);
  const couponCount = usableGrantsFor(db, CURRENT_USER_ID).length;
  const points = balanceOf(db, CURRENT_USER_ID); // คะแนนสะสม (v66) — สูตรกลาง points.ts
  const payCount = mine.filter(ticketPayable).length;

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

  // ใบที่ติ๊กได้ = เปิดให้จ่าย + ไม่มีสลิปค้างตรวจ; รายการที่เลือกไว้แล้วหลุดเกณฑ์ (เช่น poll มาว่าส่งสลิปแล้ว) ถูกตัดออกเอง
  const selectable = (t: PreorderTicket) => ticketPayable(t) && !pendingRpFor(db, t.id);
  const selectedTickets = mine.filter((t) => sel.has(t.id) && selectable(t));
  const selectedTotal = selectedTickets.reduce((s, t) => s + ticketDue(t), 0);
  const toggle = (id: string) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => setSel(new Set(mine.filter(selectable).map((t) => t.id)));

  return (
    <div className="mx-auto max-w-[640px] pb-24">
      <div className="text-[26px] font-extrabold">กระเป๋าพรี</div>
      <div className="mb-4 mt-1 text-[13px] text-ink-muted">{mine.length} ใบ · ค้างชำระรวม <span className="font-bold text-primary-soft">{baht(totalDue)}</span>{pointsVisibleTo(db, CURRENT_USER_ID) && <> · <Link href="/points" className="font-bold text-[#f1d27a]">⭐ {points.toLocaleString('en-US')} คะแนน</Link></>}</div>

      <div className="mb-[18px] flex items-center gap-2">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {([['all', 'ทั้งหมด'], ['preorder', 'ใบพรี'], ['pay', 'รอชำระ'], ['shipping', 'กำลังเดินทาง'], ['done', 'เรียบร้อย'], ['coupon', 'คูปอง']] as [Tab, string][]).map(([k, label]) => {
            const badge = k === 'coupon' ? couponCount : k === 'pay' ? payCount : 0;
            return (
              <button key={k} onClick={() => setTab(k)} className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-[13px] font-bold', tab === k ? 'border-primary bg-primary text-white' : k === 'pay' && payCount > 0 ? 'border-[#d97706]/50 bg-[#d97706]/[0.12] text-[#fbbf24]' : 'border-subtle bg-surface-3 text-ink-muted2')}>
                {label}{badge > 0 && <span className={cx('rounded-full px-1.5 text-[10px] font-extrabold', tab === k ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{badge}</span>}
              </button>
            );
          })}
        </div>
        {tab !== 'coupon' && (
          <button onClick={() => setNewest((v) => !v)} className="ml-auto flex flex-shrink-0 items-center gap-1.5 rounded-full border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-semibold text-ink-muted2">
            <Icon name="swap" size={15} /> {newest ? 'ใหม่→เก่า' : 'เก่า→ใหม่'}
          </button>
        )}
      </div>

      {tab === 'pay' && payCount > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-[#d97706]/30 bg-[#d97706]/[0.08] px-3.5 py-2.5 text-[12.5px]">
          <span className="text-[#fbbf24]">ติ๊กเลือกใบที่จะจ่าย แล้วโอนครั้งเดียว แนบสลิปเดียว</span>
          <button onClick={selectAll} className="shrink-0 font-bold text-ink-muted2 underline">เลือกทั้งหมด</button>
        </div>
      )}

      {tab === 'coupon' ? <MyCoupons uid={CURRENT_USER_ID} /> : (<>
      {groups.map((g) => (
        <div key={g.makerId} className="mb-5">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink-muted">
            <Icon name="store" size={15} className="text-primary-soft" />
            {g.makerName}
            <span className="text-ink-faint">· {g.tickets.length}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {g.tickets.map((t) => (
              <TicketRow key={t.id} db={db} t={t} selecting={tab === 'pay'} selectable={selectable(t)} selected={sel.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </div>
        </div>
      ))}
      {filtered.length === 0 && <div className="py-12 text-center text-ink-faint">{tab === 'pay' ? 'ยังไม่มีใบที่เปิดให้ชำระ — จะขึ้นที่นี่เมื่อของออกเดินทาง/ถึงไทย' : 'ยังไม่มีใบพรีในหมวดนี้'}</div>}
      </>)}

      {/* แถบล่าง: จ่ายรวมใบที่เลือก */}
      {tab === 'pay' && selectedTickets.length > 0 && (
        <div className="fixed inset-x-0 bottom-[64px] z-50 px-3">
          <div className="mx-auto flex max-w-[640px] items-center gap-3 rounded-2xl border border-[#d4af37]/40 bg-[#120c0c]/95 px-4 py-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,.9)] backdrop-blur">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-ink-muted2">เลือก {selectedTickets.length} ใบ</div>
              <div className="text-[17px] font-extrabold text-primary-soft">{baht(selectedTotal)}</div>
            </div>
            <button onClick={() => setSel(new Set())} className="text-[12px] text-ink-faint underline">ล้าง</button>
            <button onClick={() => router.push(`/wallet/pay?t=${selectedTickets.map((t) => t.id).join(',')}`)} className="rounded-xl bg-primary px-4 py-2.5 text-[13.5px] font-bold text-white">ชำระรวม</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** แถวตั๋ว — ระดับบนสุดตาม DNA react-state (ห้ามประกาศในฟังก์ชันหน้า) · โหมดเลือก: ติ๊กได้เฉพาะใบที่จ่ายได้ */
function TicketRow({ db, t, selecting, selectable, selected, onToggle }: { db: Database; t: PreorderTicket; selecting: boolean; selectable: boolean; selected: boolean; onToggle: () => void }) {
  const due = t.remaining_amount - t.remaining_paid;
  const img = lineImage(db, t.product_id, t.variant_id);
  const pending = pendingRpFor(db, t.id);
  const body = (
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
          <span className={cx('text-[12.5px] font-semibold', due > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>
            {due > 0 ? `ค้าง ${baht(due)}` : 'จ่ายครบแล้ว ✓'}
            {pending && <span className="ml-1.5 rounded-md bg-[#d97706]/[0.18] px-1.5 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">ส่งสลิปแล้ว รอตรวจ</span>}
          </span>
          <Icon name="qr" size={18} className="text-ink-faint" />
        </div>
      </div>
    </div>
  );
  return (
    <div className={cx('flex overflow-hidden rounded-card border bg-surface-2', selected ? 'border-[#d4af37]/60' : 'border-subtle')}>
      {/* แถบสี + ป้าย ใช้ key เดียวกัน (ฐานระบบ flow รับของ: submit → รอจัดส่ง, ส่งแล้ว → เสร็จสิ้น) */}
      <div className="w-1" style={{ background: STATUS_FILL[ticketBadgeKey(t) as StatusKey] }} />
      {selecting && (
        <button onClick={onToggle} disabled={!selectable} aria-label="เลือกใบนี้" className={cx('grid w-11 shrink-0 place-items-center border-r border-hair', !selectable && 'opacity-30')}>
          <span className={cx('grid h-5 w-5 place-items-center rounded-md border', selected ? 'border-[#d4af37] bg-[#d4af37] text-black' : 'border-ink-faint')}>{selected && <Icon name="check" size={14} />}</span>
        </button>
      )}
      <Link href={`/wallet/${t.ticket_no}`} className="flex min-w-0 flex-1">{body}</Link>
    </div>
  );
}
