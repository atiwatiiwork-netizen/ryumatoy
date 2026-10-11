'use client';

import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { productLabel } from '@/domain/services/catalog';
import { activeListingOf, depositGap, listingPreview, sellBlockReason, sellBlockedForGood } from '@/domain/services/market';
import type { PreorderTicket } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { StubArt, LotPill } from './MarketUi';

type Row = { t: PreorderTicket; reason: string | null; gap: number; listingId?: string };

/**
 * "ลงขายใบพรี" จากกระดาน (เจ้าของ 2026-09-24: "ผู้ขาย เลือกใบพรี ตั้งราคา") — เลือกตั๋วของตัวเองก่อน แล้วเปิดแผงลงขาย
 * ใช้ร่วมทั้ง /market และกรอบพรีวิว/ทดลองเล่นของแอดมิน (DNA shared preview)
 * จัดกลุ่ม: ลงขายได้เลย → ต้องเติมมัดจำก่อน → ลงขายอยู่ → ยังลงไม่ได้ตอนนี้ · ใบที่ขายในตลาดไม่ได้แน่ๆ (เปิดจองอยู่/พร้อมส่ง/
 * เลือกวิธีรับของแล้ว) ไม่โชว์เป็นแถว — บอกแค่จำนวน + เหตุผล (sellBlockedForGood ตัวเดียวกับปุ่มในหน้าใบพรี)
 */
export function TicketPicker({ onPick, onOpenDeal, onClose }: { onPick: (t: PreorderTicket) => void; onOpenDeal: (id: string) => void; onClose: () => void }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const mine = db.tickets.filter((t) => t.owner_id === uid && t.status !== 'shipped');
  const rows: Row[] = [];
  const hidden = new Map<string, number>();
  for (const t of mine) {
    if (sellBlockedForGood(db, t, uid)) {
      const why = sellBlockReason(db, t, uid) ?? 'ขายไม่ได้';
      const key = why.split(' — ')[0];
      hidden.set(key, (hidden.get(key) ?? 0) + 1);
      continue;
    }
    rows.push({ t, reason: sellBlockReason(db, t, uid), gap: depositGap(db, t), listingId: activeListingOf(db, t.id)?.id });
  }
  const byNewest = (a: Row, b: Row) => (a.t.created_at < b.t.created_at ? 1 : -1);
  const ready = rows.filter((r) => !r.reason && !r.listingId).sort(byNewest);
  const topup = rows.filter((r) => !r.listingId && r.gap > 0 && (r.reason ?? '').startsWith('ต้องเติมมัดจำ')).sort(byNewest);
  const listed = rows.filter((r) => r.listingId).sort(byNewest);
  const later = rows.filter((r) => r.reason && !r.listingId && !(r.gap > 0 && (r.reason ?? '').startsWith('ต้องเติมมัดจำ'))).sort(byNewest);
  const hiddenCount = [...hidden.values()].reduce((s, n) => s + n, 0);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-[520px] overflow-y-auto rounded-t-3xl border border-subtle bg-surface-2 p-4 pb-[calc(16px+env(safe-area-inset-bottom))] sm:rounded-3xl motion-safe:animate-riseIn" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[17px] font-extrabold">เลือกใบพรีที่จะลงขาย</div>
            <div className="text-[12px] text-ink-faint">ระบบอ่านยอดที่จ่ายแล้ว/ยอดค้างให้เอง · ขั้นต่อไปตั้งราคา</div>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle text-ink-faint" aria-label="ปิด"><Icon name="x" size={16} /></button>
        </div>

        {ready.length + topup.length + listed.length + later.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center">
            <div className="text-2xl">🎟️</div>
            <div className="mt-1.5 text-[13.5px] font-bold">ยังไม่มีใบพรีที่ลงขายได้</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-faint">ลงขายได้เมื่อปิดรอบแล้ว (ของกำลังผลิต / เดินทาง / ถึงไทย) และยังไม่ได้เลือกวิธีรับของ</div>
          </div>
        )}

        <Group title="ลงขายได้เลย" rows={ready} cta={() => 'ตั้งราคา ›'} tone="go" onTap={(r) => onPick(r.t)} />
        <Group title="ต้องเติมมัดจำก่อน" hint="ใบที่ได้ส่วนลดมัดจำจากยศ — เติมให้ครบมัดจำปกติแล้วลงขายได้" rows={topup}
          cta={(r) => `เติม ${baht(r.gap)} ›`} tone="gold" onTap={(r) => onPick(r.t)} />
        <Group title="ลงขายอยู่" rows={listed} cta={() => 'ดูประกาศ ›'} tone="muted" onTap={(r) => r.listingId && onOpenDeal(r.listingId)} />
        <Group title="ยังลงไม่ได้ตอนนี้" rows={later} cta={(r) => r.reason ?? ''} tone="off" />

        {hiddenCount > 0 && (
          <div className="mt-3 rounded-xl bg-surface-3 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            อีก {hiddenCount} ใบขายในตลาดไม่ได้ · {[...hidden.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

function Group({ title, hint, rows, cta, tone, onTap }: {
  title: string; hint?: string; rows: Row[]; cta: (r: Row) => string; tone: 'go' | 'gold' | 'muted' | 'off'; onTap?: (r: Row) => void;
}) {
  const db = useDatabase();
  if (rows.length === 0) return null;
  return (
    <div className="mb-3.5">
      <div className="mb-1.5 text-[12.5px] font-bold text-ink-muted">{title} <span className="font-mono text-[11px] text-ink-faint">{rows.length}</span></div>
      {hint && <div className="-mt-1 mb-1.5 text-[11px] text-ink-faint">{hint}</div>}
      <div className="flex flex-col gap-2">
        {rows.map((r) => {
          const pv = listingPreview(r.t, r.t.qty, 0);
          return (
            <button type="button" key={r.t.id} disabled={!onTap} onClick={() => onTap?.(r)}
              className={cx('flex items-center gap-3 rounded-2xl border bg-surface-3 px-3 py-2.5 text-left transition-transform active:scale-[.985] disabled:active:scale-100',
                tone === 'go' ? 'border-accent' : tone === 'gold' ? 'border-[#d4af37]/40' : 'border-subtle', tone === 'off' && 'opacity-60')}>
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl"><StubArt db={db} productId={r.t.product_id} variantId={r.t.variant_id} /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-bold">{productLabel(db, r.t.product_id, r.t.variant_id)}{r.t.qty > 1 ? ` ×${r.t.qty}` : ''}</div>
                <div className="mt-0.5 flex items-center gap-1.5"><span className="font-mono text-[10.5px] text-primary-soft">{r.t.ticket_no}</span><LotPill status={r.t.product_status} /></div>
                <div className="mt-0.5 text-[11px] text-ink-faint">จ่ายแล้ว {baht(pv.paid)} · ค้างร้าน {baht(pv.due)}</div>
              </div>
              <span className={cx('max-w-[38%] shrink-0 text-right text-[12px] font-bold leading-tight',
                tone === 'go' ? 'text-primary-soft' : tone === 'gold' ? 'text-[#f1d27a]' : 'text-ink-faint')}>{cta(r)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
