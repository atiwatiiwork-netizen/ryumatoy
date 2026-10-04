'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { productLabel } from '@/domain/services/catalog';
import { myDeals, dealRole, effectiveStatus, isDirect, dealStatusLabel } from '@/domain/services/market';
import type { TicketTransfer } from '@/domain/entities';
import { cx } from '@/components/ui';
import { StubArt } from './MarketUi';

const TONE: Record<string, string> = {
  listed: 'text-[#4ade80] border-[#16a34a]/40 bg-[#16a34a]/10',
  reserved: 'text-[#fbbf24] border-[#d97706]/40 bg-[#d97706]/10',
  paid: 'text-[#fbbf24] border-[#d97706]/40 bg-[#d97706]/10',
  reviewing: 'text-[#60a5fa] border-[#2563eb]/40 bg-[#2563eb]/10',
  seller_ok: 'text-[#60a5fa] border-[#2563eb]/40 bg-[#2563eb]/10',
  pending_admin: 'text-[#60a5fa] border-[#2563eb]/40 bg-[#2563eb]/10',
  done: 'text-[#c4b5fd] border-[#8b5cf6]/40 bg-[#8b5cf6]/10',
  approved: 'text-[#c4b5fd] border-[#8b5cf6]/40 bg-[#8b5cf6]/10',
  cancelled: 'text-ink-faint border-white/10 bg-white/5',
  expired: 'text-ink-faint border-white/10 bg-white/5',
};

/** งานถัดไปของฉันในดีลนี้ (ข้อความสั้นใต้ชื่อ) — ดีลตรง (v73) ใช้คำ "ส่ง/รับ" แทน "ขาย/ซื้อ" */
function nextStep(tr: TicketTransfer, uid: string, st: string): string {
  const seller = dealRole(tr, uid) === 'seller';
  if (isDirect(tr)) {
    const free = (tr.asking_price ?? 0) <= 0;
    if (st === 'reserved') return seller ? `ส่งข้อเสนอแล้ว · รอผู้รับ${free ? 'กดรับ' : 'โอน'}ใน 24 ชม.` : `🎁 มีคนเปลี่ยนใบให้คุณ · ${free ? 'กดรับ' : 'โอน + แนบสลิป'}ภายใน 24 ชม.`;
    if (st === 'paid') return seller ? (free ? '🤝 ผู้รับกดรับแล้ว · กดยืนยัน' : '💸 เช็คเงินเข้า แล้วกดยืนยัน') : (free ? 'รอคนส่งยืนยัน' : 'รอคนส่งเช็คเงิน');
    if (st === 'reviewing') return 'ร้านกำลังตรวจสอบ';
    if (st === 'seller_ok' || st === 'pending_admin') return 'รอร้านโอนสิทธิ์';
    if (st === 'done' || st === 'approved') return seller ? 'เปลี่ยนใบสำเร็จ' : `ได้ใบพรี ${tr.new_ticket_no ?? ''}`;
    return dealStatusLabel(tr, st as TicketTransfer['status']);
  }
  if (st === 'reserved') return seller ? 'มีคนกำลังจอง · รอเขาโอน' : 'จองอยู่ · โอน + แนบสลิปให้ทันเวลา';
  if (st === 'paid') return seller ? '💸 เช็คเงินเข้า แล้วกดยืนยัน' : 'รอคนขายเช็คเงิน';
  if (st === 'reviewing') return 'ร้านกำลังตรวจสอบ';
  if (st === 'seller_ok' || st === 'pending_admin') return 'รอร้านโอนสิทธิ์';
  if (st === 'listed') return 'ลงขายอยู่บนกระดาน';
  if (st === 'done' || st === 'approved') return seller ? 'ขายสำเร็จ' : `ได้ใบพรี ${tr.new_ticket_no ?? ''}`;
  if (st === 'expired') return 'ประกาศหมดอายุ';
  return 'ยกเลิกแล้ว';
}

/** ซื้อขายของฉัน (/market/mine) — คอมโพเนนต์เดียวกับพรีวิวแอดมิน · ข้อมูลจาก ticket_transfers ที่ RLS ให้เห็นเฉพาะดีลของตัวเอง */
export function MyDeals({ onOpen }: { onOpen?: (id: string) => void }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const g = myDeals(db, uid);
  const sections: { title: string; rows: TicketTransfer[]; hot?: boolean }[] = [
    { title: 'ต้องทำ', rows: g.todo, hot: true },
    { title: 'กำลังดำเนินการ', rows: g.active },
    { title: 'ลงขาย / ส่งข้อเสนออยู่', rows: g.selling },
    { title: 'ประวัติ', rows: g.history.slice(0, 30) },
  ];
  const empty = sections.every((s) => s.rows.length === 0);
  return (
    <div className="flex flex-col gap-4">
      {empty && (
        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
          <div className="text-3xl">🔁</div>
          <div className="mt-2 text-[14px] font-bold">ยังไม่มีรายการซื้อขาย</div>
          <div className="mt-1 text-[12px] text-ink-faint">เปลี่ยนใบ/ลงขายได้จากหน้าใบพรีในกระเป๋า · เมื่อมีคนเปลี่ยนใบให้คุณจะเด้งที่นี่</div>
        </div>
      )}
      {sections.filter((s) => s.rows.length > 0).map((s) => (
        <div key={s.title}>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold">
            {s.hot && <span className="h-2 w-2 rounded-full bg-primary-bright motion-safe:animate-breath" />}{s.title} <span className="font-mono text-[11px] text-ink-faint">{s.rows.length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {s.rows.map((tr) => {
              const st = effectiveStatus(tr);
              const seller = dealRole(tr, uid) === 'seller';
              const body = (
                <>
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl">{tr.product_id && <StubArt db={db} productId={tr.product_id} variantId={tr.variant_id} />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {/* shrink-0 + nowrap: ป้ายไม่ตกบรรทัดบนจอ 375px (audit รอบ E R2B-24) */}
                      <span className={cx('shrink-0 whitespace-nowrap rounded-md px-1.5 text-[10px] font-bold', seller ? 'bg-[#f1d27a]/15 text-[#f1d27a]' : 'bg-[#86c8ff]/15 text-[#86c8ff]')}>{isDirect(tr) ? (seller ? '🔁 ส่งให้' : '🔁 รับ') : seller ? 'ขาย' : 'ซื้อ'}</span>
                      <span className="truncate text-[13.5px] font-bold">{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : 'ใบพรี'}</span>
                    </div>
                    <div className={cx('mt-0.5 truncate text-[11.5px]', s.hot ? 'font-bold text-primary-soft' : 'text-ink-faint')}>{nextStep(tr, uid, st)}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-[14px] font-bold">{isDirect(tr) && (tr.asking_price ?? 0) <= 0 ? 'ฟรี' : baht(tr.asking_price)}</div>
                    <span className={cx('mt-0.5 inline-block whitespace-nowrap rounded-full border px-1.5 text-[10px] font-bold', TONE[st] ?? TONE.cancelled)}>{dealStatusLabel(tr, st)}</span>
                  </div>
                </>
              );
              const cls = cx('flex items-center gap-3 rounded-2xl border bg-surface-2 px-3 py-2.5 text-left', s.hot ? 'border-accent' : 'border-subtle');
              return onOpen
                ? <button type="button" key={tr.id} onClick={() => onOpen(tr.id)} className={cls}>{body}</button>
                : <Link key={tr.id} href={`/market/${tr.id}`} className={cls}>{body}</Link>;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
