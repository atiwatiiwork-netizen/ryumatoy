'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { ProductThumb, cx } from '@/components/ui';
import { TicketPeek } from '@/components/TicketPeek';
import type { PreorderTicket, Product, ProductStatus } from '@/domain/entities';
import { productLabel, orderedQtyOf } from '@/domain/services/catalog';
import { ticketBadgeKey } from '@/domain/services/delivery';
import { STATUS, type StatusKey } from '@/lib/theme';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const due = (t: PreorderTicket) => t.remaining_amount - t.remaining_paid;

type PayFilter = '' | 'owing' | 'paid';

/** หมวดสถานะบนสุด (owner spec 2026-07-20): เปิดพรี / ปิดกระดานแล้ว(ผลิต) / กำลังเดินทาง / ถึงไทย-จบ.
 *  ปิดกระดาน+เดินทาง โชว์ "สั่ง/จอง/เกิน" (ข้อมูลลับ เฉพาะแอดมิน). เดินทาง = ป้ายกระพริบ. */
const STATUS_BUCKETS: { key: string; label: string; statuses: ProductStatus[]; adminInfo: boolean; blink?: boolean; tone: string }[] = [
  { key: 'open', label: '🟢 เปิดพรีออเดอร์', statuses: ['open'], adminInfo: false, tone: 'bg-[#16a34a]' },
  { key: 'production', label: '📦 ปิดกระดานแล้ว · กำลังผลิต', statuses: ['production'], adminInfo: true, tone: 'bg-[#d97706]' },
  { key: 'shipping', label: '🚚 กำลังเดินทางมาไทย', statuses: ['shipping'], adminInfo: true, blink: true, tone: 'bg-[#2563eb]' },
  { key: 'done', label: '🇹🇭 ถึงไทย / จบแล้ว', statuses: ['arrived', 'delivered', 'closed'], adminInfo: false, tone: 'bg-[#4b5563]' },
];

/**
 * ตั๋วทั้งหมด — REWORKED (owner spec): a photo GRID of only the products that HAVE tickets,
 * grouped ค่าย → เรื่อง. Tapping a card drops open its buyer list (ชื่อ · วันที่ออกตั๋ว · ค้าง/ครบ);
 * tapping a buyer opens the shared TicketPeek modal (details + slips + lightbox).
 */
export default function AdminTicketsPage() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const [pay, setPay] = useState<PayFilter>('');
  const [openPid, setOpenPid] = useState<string | null>(null); // product whose buyer droplist is open
  const [peek, setPeek] = useState<PreorderTicket | null>(null);

  const owingCount = db.tickets.filter((t) => due(t) > 0).length;
  const owingSum = db.tickets.reduce((s, t) => s + Math.max(0, due(t)), 0);

  // tickets → filter → bucket per product → group ตามสถานะสินค้า (owner spec 2026-07-20)
  const buckets = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const byProduct = new Map<string, PreorderTicket[]>();
    for (const t of db.tickets) {
      if (pay === 'owing' && due(t) <= 0) continue;
      if (pay === 'paid' && due(t) > 0) continue;
      if (ql) {
        const product = db.products.find((p) => p.id === t.product_id);
        const owner = db.users.find((u) => u.id === t.owner_id);
        const hay = `${t.ticket_no} ${owner?.display_name ?? ''} ${owner?.phone ?? ''} ${product?.series_name ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) continue;
      }
      (byProduct.get(t.product_id) ?? byProduct.set(t.product_id, []).get(t.product_id)!).push(t);
    }
    // In-Stock แยกหมวดของตัวเอง — SKU พร้อมส่ง status ค้าง 'open' ตลอด เคยไปนอนอยู่ใต้
    // "เปิดพรีออเดอร์" ทั้งที่ไม่ใช่พรี (audit 2026-07-23)
    const stockBucket = {
      key: 'instock', label: '🛒 In-Stock พร้อมส่ง', statuses: [] as ProductStatus[], adminInfo: false, blink: false as boolean | undefined, tone: 'bg-[#7c3aed]',
      products: db.products
        .filter((p) => byProduct.has(p.id) && p.is_stock)
        .map((p) => ({ product: p, tickets: byProduct.get(p.id)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) }))
        .sort((a, b) => (a.product.manufacturer_id + a.product.series_name).localeCompare(b.product.manufacturer_id + b.product.series_name)),
      tix: 0,
    };
    stockBucket.tix = stockBucket.products.reduce((s, p) => s + p.tickets.length, 0);
    return [...STATUS_BUCKETS.map((bucket) => {
      const products = db.products
        .filter((p) => byProduct.has(p.id) && !p.is_stock && bucket.statuses.includes(p.status))
        .map((p) => ({ product: p, tickets: byProduct.get(p.id)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) }))
        // ค่าย → ชื่อ (คงการเรียงเดิมไว้ในหมวด)
        .sort((a, b) => (a.product.manufacturer_id + a.product.series_name).localeCompare(b.product.manufacturer_id + b.product.series_name));
      const tix = products.reduce((s, p) => s + p.tickets.length, 0);
      return { ...bucket, products, tix };
    }), stockBucket].filter((b) => b.products.length > 0);
  }, [db, q, pay]);

  const shown = buckets.reduce((s, b) => s + b.tix, 0);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">ตั๋วทั้งหมด</div>
      <div className="mb-4 text-[13px] text-ink-faint">ทุกใบพรีในระบบ · {db.tickets.length} ใบ · ค้างชำระ {owingCount} ใบ รวม <b className="text-primary-soft">{baht(owingSum)}</b></div>

      {/* filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-subtle bg-surface-3 px-3">
          <Icon name="search" size={16} className="text-ink-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา เลขตั๋ว / ชื่อลูกค้า / เบอร์ / สินค้า" className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-ink-faint" />
        </div>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={pay} onChange={(e) => setPay(e.target.value as PayFilter)}>
          <option value="">จ่ายครบ + ค้าง</option>
          <option value="owing">เฉพาะค้างจ่าย</option>
          <option value="paid">เฉพาะจ่ายครบ</option>
        </select>
      </div>

      {buckets.length === 0 ? (
        <div className="rounded-2xl border border-subtle bg-surface-2 py-12 text-center text-[13px] text-ink-faint">ไม่พบตั๋วตามตัวกรอง</div>
      ) : (
        <>
          <div className="mb-2 text-[12px] text-ink-faint">แสดง {shown} ใบ</div>
          {buckets.map((bucket) => {
            // ข้อมูลลับแอดมิน (ปิดกระดาน/เดินทาง): รวมสั่งผลิต / ยอดจอง / ส่วนเกิน ทั้งหมวด
            const sumOrdered = bucket.products.reduce((s, p) => s + orderedQtyOf(db, p.product.id), 0);
            const sumFinal = bucket.products.reduce((s, p) => s + (p.product.production_qty ?? orderedQtyOf(db, p.product.id)), 0);
            const sumSurplus = Math.max(0, sumFinal - sumOrdered);
            return (
              <div key={bucket.key} className="mb-7">
                {/* ── หัวหมวดสถานะ ── */}
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  <span className={cx('inline-flex items-center rounded-lg px-2.5 py-1 text-[14px] font-extrabold text-white', bucket.tone, bucket.blink && 'animate-blink')}>{bucket.label}</span>
                  <span className="text-[12px] font-semibold text-ink-faint">· {bucket.tix} ใบ · {bucket.products.length} รายการ</span>
                  {bucket.adminInfo && (
                    <span className="rounded-md border border-[#d4af37]/40 bg-[#d4af37]/[0.1] px-2 py-0.5 text-[11px] font-bold text-[#f1d27a]">
                      🔒 สั่งผลิต {sumFinal} · จอง {sumOrdered}{sumSurplus > 0 ? ` · เกิน ${sumSurplus}` : ''}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {bucket.products.map(({ product, tickets }) => (
                    <ProductTicketCard
                      key={product.id}
                      product={product}
                      tickets={tickets}
                      adminInfo={bucket.adminInfo}
                      open={openPid === product.id}
                      onToggle={() => setOpenPid((cur) => (cur === product.id ? null : product.id))}
                    />
                  ))}
                </div>
                {/* droplist ของการ์ดที่เปิดในหมวดนี้ */}
                {bucket.products.some((p) => p.product.id === openPid) && (
                  <BuyerList entry={bucket.products.find((p) => p.product.id === openPid)!} onPick={setPeek} />
                )}
              </div>
            );
          })}
        </>
      )}

      {peek && <TicketPeek ticket={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

function ProductTicketCard({ product, tickets, adminInfo, open, onToggle }: { product: Product; tickets: PreorderTicket[]; adminInfo?: boolean; open: boolean; onToggle: () => void }) {
  const db = useDatabase();
  const owing = tickets.reduce((s, t) => s + Math.max(0, due(t)), 0);
  const pieces = tickets.reduce((s, t) => s + t.qty, 0);
  // ข้อมูลลับแอดมิน: สั่งผลิตจากค่าย (production_qty) vs ยอดจอง → ส่วนเกิน (โชว์เฉพาะปิดกระดาน/เดินทาง)
  const ordered = orderedQtyOf(db, product.id);
  const finalQty = product.production_qty ?? ordered;
  const surplus = Math.max(0, finalQty - ordered);
  return (
    <button onClick={onToggle} className={cx('overflow-hidden rounded-card border bg-surface-2 text-left', open ? 'border-primary-soft ring-1 ring-primary-soft' : 'border-subtle')}>
      <div className="relative">
        <ProductThumb isStock={product.is_stock} radius="rounded-none" src={product.images[0]} showRibbon={false} />
        <span className="absolute right-2 top-2 rounded-md bg-cta px-2 py-0.5 text-[10.5px] font-extrabold text-white">{tickets.length} ใบ</span>
      </div>
      <div className="px-[11px] pb-3 pt-2">
        <div className="line-clamp-2 min-h-[34px] text-[12.5px] font-semibold leading-tight">{productLabel(db, product.id)}</div>
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-ink-faint">{pieces} ตัว</span>
          {owing > 0
            ? <span className="font-bold text-primary-soft">ค้าง {baht(owing)}</span>
            : <span className="font-bold text-[#4ade80]">ครบ ✓</span>}
        </div>
        {adminInfo && (
          <div className="mt-1 rounded-md border border-[#d4af37]/35 bg-[#d4af37]/[0.08] px-1.5 py-1 text-center text-[10px] font-bold text-[#f1d27a]">
            🔒 สั่ง {finalQty} · จอง {ordered}{surplus > 0 ? ` · เกิน ${surplus}` : ''}
          </div>
        )}
        <div className={cx('mt-1.5 text-center text-[10.5px] font-semibold', open ? 'text-primary-soft' : 'text-ink-faint')}>{open ? 'ปิดรายชื่อ ▴' : 'ดูคนพรี ▾'}</div>
      </div>
    </button>
  );
}

function BuyerList({ entry, onPick }: { entry: { product: Product; tickets: PreorderTicket[] }; onPick: (t: PreorderTicket) => void }) {
  const db = useDatabase();
  return (
    <div className="mt-3 rounded-xl border border-primary-soft/40 bg-surface-2 p-3">
      <div className="mb-2 text-[12px] font-semibold text-ink-muted">คนพรี {productLabel(db, entry.product.id)} ({entry.tickets.length} ใบ) · แตะรายชื่อดูรายละเอียดตั๋ว</div>
      <div className="flex flex-col divide-y divide-hair">
        {entry.tickets.map((t) => {
          const owner = db.users.find((u) => u.id === t.owner_id);
          const d = due(t);
          return (
            <button key={t.id} onClick={() => onPick(t)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 text-left hover:bg-white/[0.03]">
              <span className="flex min-w-[140px] flex-1 items-center gap-2 text-[13px] font-semibold"><Icon name="user" size={13} className="text-primary-soft" /> <span className="truncate">{owner?.display_name ?? '—'}</span></span>
              <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span>
              {t.qty > 1 && <span className="text-[11.5px] text-ink-muted">×{t.qty}</span>}
              {/* สถานะจริงรายใบ (ส่งแล้ว/รอจัดส่ง/จ่ายครบ ≠ กันหมด) — เดิม "ครบ ✓" อย่างเดียวแยกไม่ออก */}
              {(() => { const k = ticketBadgeKey(t) as StatusKey; const s = STATUS[k]; return s ? <span className={cx('rounded-md border px-1.5 py-0.5 text-[10px] font-bold', s.cls)}>{s.label}</span> : null; })()}
              <span className={cx('w-[90px] text-right text-[12px] font-bold', d > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{d > 0 ? `ค้าง ${baht(d)}` : 'ครบ ✓'}</span>
              <span className="w-[70px] text-right text-[11px] text-ink-faint">{fmtDate(t.created_at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
