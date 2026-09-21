'use client';

import { useState } from 'react';
import type { PreorderTicket } from '@/domain/entities';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { productLabel } from '@/domain/services/catalog';
import { baht } from '@/lib/theme';
import { completeTicketOffline, logActivity } from '@/data/mutations';
import { store } from '@/data/store';
import { Icon } from './Icon';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** Modal แสดงรายละเอียดคร่าวๆ ของตั๋ว 1 ใบ (แอดมิน) + สลิปทุกใบ — แตะสลิปเพื่อขยายเต็มจอเผื่อตรวจ.
 *  สลิปมัดจำ trace จากออเดอร์ของลูกค้าที่มีรายการสินค้า/รอบเดียวกัน (เลือกออเดอร์ที่เวลาอนุมัติ
 *  ใกล้เวลาออกตั๋วที่สุด กันเคสลูกค้าสั่งสินค้าเดิมซ้ำหลายรอบ). */
export function TicketPeek({ ticket: t, onClose }: { ticket: PreorderTicket; onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
  const [big, setBig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = db.products.find((x) => x.id === t.product_id);
  const batch = t.batch_id ? db.batches.find((b) => b.id === t.batch_id) : undefined;
  const buyer = db.users.find((u) => u.id === t.owner_id);
  const due = t.remaining_amount - t.remaining_paid;
  // อ่านสถานะสดจาก store เสมอ — ตั๋วที่ส่งเข้ามาเป็น snapshot ตอนเปิดป๊อปอัป (กดจบแล้วป้ายต้องเปลี่ยนทันที)
  const live = db.tickets.find((x) => x.id === t.id) ?? t;
  const done = live.status === 'shipped';

  /** "จบงานตั๋วนี้เลย" — เคลียร์กันนอกระบบ (มารับเอง/โอนตรง/ตกลงทางแชท)
   *  ใบที่ยังค้างเงินต้องยืนยันว่ารับเงินแล้ว ไม่งั้นหนี้หายจากบัญชีแต่รายได้ไม่ขึ้น = เงินหายจากสมุด */
  const complete = async () => {
    const dueNow = Math.max(0, live.remaining_amount - live.remaining_paid);
    const msg = dueNow > 0
      ? `จบงานตั๋ว ${live.ticket_no} เลยไหม?\n\nใบนี้ยังค้าง ${baht(dueNow)}\n`
        + `กดตกลง = ยืนยันว่า "รับเงินส่วนต่างนอกระบบครบแล้ว" — ระบบจะบันทึกเป็นรายได้ ${baht(dueNow)} ให้ด้วย\n`
        + `(ถ้ายังไม่ได้รับเงิน ห้ามกด — บัญชีจะเพี้ยน)\n\nตั๋วจะกลายเป็น "เสร็จสิ้น" ไม่ต้องใส่เลขพัสดุ`
      : `จบงานตั๋ว ${live.ticket_no} เลยไหม?\n\nจ่ายครบแล้ว · ตั๋วจะกลายเป็น "เสร็จสิ้น" ไม่ต้องใส่เลขพัสดุ\n(ใช้กับเคสมารับเอง/ส่งกันเองนอกระบบ)`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      dispatch(completeTicketOffline(live.id, { collectRemaining: dueNow > 0 }));
      // read-back: mutation อาจ no-op (ใบถูกปิดไปแล้วจากอีกแท็บ) — ห้ามขึ้น ✓ ทั้งที่ไม่มีอะไรเปลี่ยน
      let ok = false;
      dispatch((d) => { ok = d.tickets.find((x) => x.id === live.id)?.status === 'shipped'; return d; });
      if (!ok) { flash('ปิดใบไม่สำเร็จ — รีเฟรชแล้วลองใหม่'); return; }
      // DNA save: ต้องเซฟผ่านก่อนถึงบอกว่าสำเร็จ (ปุ่มนี้ idempotent — กดซ้ำได้ ไม่บวกเงินซ้ำ)
      if (await store.flush()) { flash('ยังบันทึกขึ้นระบบไม่ได้ — ระบบลองใหม่ให้อัตโนมัติ รอสักครู่แล้วรีเฟรชเช็ค'); return; }
      dispatch(logActivity(adminId, 'close_delivery',
        `จบงานนอกระบบ ${live.ticket_no} · ${buyer?.display_name ?? ''}${dueNow > 0 ? ` · รับส่วนต่างนอกระบบ ${baht(dueNow)}` : ''}`,
        { targetId: live.id, targetLabel: live.ticket_no, amount: dueNow }));
      flash(dueNow > 0 ? `จบงาน ${live.ticket_no} ✓ บันทึกรับเงิน ${baht(dueNow)} แล้ว` : `จบงาน ${live.ticket_no} ✓`);
    } finally { setBusy(false); }
  };

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

        {/* จบงานนอกระบบ (เจ้าของ 2026-09-21): มารับเอง/โอนตรง/ตกลงทางแชท → ปิดใบจากตรงนี้ได้เลย
            ใบที่ยังค้างเงินจะถูกบันทึกเป็นรายได้ด้วย เพื่อไม่ให้หนี้หายแต่รายได้ไม่ขึ้น */}
        {done ? (
          <div className="mt-4 rounded-xl border border-[#16a34a]/35 bg-[#16a34a]/[0.1] py-2.5 text-center text-[12.5px] font-bold text-[#4ade80]">
            ✓ เสร็จสิ้นแล้ว{live.shipped_out_at ? ` · ${fmtDate(live.shipped_out_at)}` : ''}
          </div>
        ) : (
          <button onClick={complete} disabled={busy}
            className="mt-4 w-full rounded-xl border border-[#16a34a]/45 bg-[#16a34a]/[0.14] py-2.5 text-center text-[12.5px] font-bold text-[#4ade80] disabled:opacity-50">
            {busy ? 'กำลังปิดใบ…' : `✅ จบงานตั๋วนี้เลย${due > 0 ? ` (รับส่วนต่าง ${baht(due)} นอกระบบ)` : ''}`}
          </button>
        )}
        <a href={`/wallet/${encodeURIComponent(t.ticket_no)}`} target="_blank" rel="noreferrer" className="mt-2 block rounded-xl border border-subtle bg-surface-3 py-2.5 text-center text-[12.5px] font-bold text-ink-muted2">เปิดหน้าตั๋วเต็ม →</a>
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
