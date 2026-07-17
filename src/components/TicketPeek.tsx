'use client';

import { useState } from 'react';
import type { PreorderTicket } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { productLabel } from '@/domain/services/catalog';
import { baht } from '@/lib/theme';
import { Icon } from './Icon';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** Modal แสดงรายละเอียดคร่าวๆ ของตั๋ว 1 ใบ (แอดมิน) + สลิปทุกใบ — แตะสลิปเพื่อขยายเต็มจอเผื่อตรวจ.
 *  สลิปมัดจำ trace จากออเดอร์ของลูกค้าที่มีรายการสินค้า/รอบเดียวกัน (เลือกออเดอร์ที่เวลาอนุมัติ
 *  ใกล้เวลาออกตั๋วที่สุด กันเคสลูกค้าสั่งสินค้าเดิมซ้ำหลายรอบ). */
export function TicketPeek({ ticket: t, onClose }: { ticket: PreorderTicket; onClose: () => void }) {
  const db = useDatabase();
  const [big, setBig] = useState<string | null>(null);
  const p = db.products.find((x) => x.id === t.product_id);
  const batch = t.batch_id ? db.batches.find((b) => b.id === t.batch_id) : undefined;
  const buyer = db.users.find((u) => u.id === t.owner_id);
  const due = t.remaining_amount - t.remaining_paid;

  const tTime = new Date(t.created_at).getTime();
  const order = db.orders
    .filter((o) => o.user_id === t.owner_id && o.items.some((i) =>
      i.product_id === t.product_id && (i.batch_id ?? null) === (t.batch_id ?? null) && (i.variant_id ?? null) === (t.variant_id ?? null)))
    .sort((a, b) => Math.abs(new Date(a.approved_at ?? a.created_at).getTime() - tTime) - Math.abs(new Date(b.approved_at ?? b.created_at).getTime() - tTime))[0];
  const rps = db.remainingPayments.filter((r) => r.ticket_id === t.id && r.slip_url);
  const slips: { label: string; url: string }[] = [
    ...(order?.slip_url ? [{ label: 'สลิปมัดจำ', url: order.slip_url }] : []),
    ...rps.map((r, i) => ({ label: `สลิปส่วนต่าง${rps.length > 1 ? ` #${i + 1}` : ''}${r.status === 'pending' ? ' (รอตรวจ)' : ''}`, url: r.slip_url })),
  ];
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 py-1 text-[13px]"><span className="text-ink-faint">{k}</span><span className="text-right font-semibold text-ink">{v}</span></div>
  );

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-2xl border border-subtle bg-surface-2 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[13px] font-bold text-primary-soft">{t.ticket_no}</span>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
        </div>
        <div className="mb-3 text-[15px] font-extrabold leading-tight">
          {p ? productLabel(db, p.id, t.variant_id) : '—'}
          {batch && <span className="text-[12px] font-semibold text-ink-faint"> · {batch.label}</span>}
        </div>

        <div className="rounded-xl border border-subtle bg-surface-3/50 px-3 py-1.5">
          {row('ลูกค้า', <>{buyer?.display_name ?? '—'}{buyer?.member_code ? <span className="ml-1 font-mono text-[11px] text-ink-faint">{buyer.member_code}</span> : null}</>)}
          {row('จำนวน', `×${t.qty}`)}
          {row('มัดจำจ่ายแล้ว', <span className="text-[#4ade80]">{baht(t.deposit_paid)}</span>)}
          {row('ส่วนต่างค้างจ่าย', due > 0 ? <span className="text-[#fbbf24]">{baht(due)}</span> : <span className="text-[#4ade80]">จ่ายครบ ✓</span>)}
          {row('ราคารวม', baht(t.deposit_paid + t.remaining_amount))}
          {row('วันที่ซื้อ', fmtDate(t.created_at))}
        </div>

        <div className="mt-3 mb-1.5 text-[12px] font-semibold text-ink-muted">สลิป ({slips.length}) · แตะเพื่อขยาย</div>
        {slips.length === 0 ? <div className="text-[12.5px] text-ink-faint">ไม่พบสลิป</div> : (
          <div className="flex flex-wrap gap-2">
            {slips.map((s, i) => (
              <button key={i} onClick={() => setBig(s.url)} className="w-[104px] text-left">
                <img src={s.url} alt={s.label} className="h-[130px] w-full rounded-lg border border-subtle object-cover" />
                <span className="mt-1 block text-[10.5px] font-semibold text-ink-muted2">{s.label}</span>
              </button>
            ))}
          </div>
        )}

        <a href={`/wallet/${encodeURIComponent(t.ticket_no)}`} target="_blank" rel="noreferrer" className="mt-4 block rounded-xl border border-subtle bg-surface-3 py-2.5 text-center text-[12.5px] font-bold text-ink-muted2">เปิดหน้าตั๋วเต็ม →</a>
      </div>

      {/* lightbox — สลิปภาพใหญ่เต็มจอเผื่อตรวจ */}
      {big && (
        <div className="fixed inset-0 z-[130] grid place-items-center bg-black/90 p-4" onClick={(e) => { e.stopPropagation(); setBig(null); }}>
          <img src={big} alt="slip" className="max-h-[92vh] max-w-full rounded-lg object-contain" />
          <button className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white"><Icon name="x" size={20} /></button>
        </div>
      )}
    </div>
  );
}
