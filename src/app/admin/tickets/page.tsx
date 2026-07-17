'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { ProductThumb, cx } from '@/components/ui';
import { TicketPeek } from '@/components/TicketPeek';
import type { PreorderTicket, Product } from '@/domain/entities';
import { productLabel } from '@/domain/services/catalog';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const due = (t: PreorderTicket) => t.remaining_amount - t.remaining_paid;

type PayFilter = '' | 'owing' | 'paid';

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

  // tickets → filter → bucket per product → group ค่าย → เรื่อง (only products with tickets)
  const groups = useMemo(() => {
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
    const makers = db.manufacturers
      .map((m) => ({
        maker: m,
        franchises: db.franchises
          .map((f) => ({
            franchise: f,
            products: db.products
              .filter((p) => p.manufacturer_id === m.id && p.franchise_id === f.id && byProduct.has(p.id))
              .map((p) => ({ product: p, tickets: byProduct.get(p.id)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) }))
              .sort((a, b) => a.product.series_name.localeCompare(b.product.series_name)),
          }))
          .filter((g) => g.products.length > 0),
      }))
      .filter((g) => g.franchises.length > 0);
    return makers;
  }, [db, q, pay]);

  const shown = groups.reduce((s, m) => s + m.franchises.reduce((s2, f) => s2 + f.products.reduce((s3, p) => s3 + p.tickets.length, 0), 0), 0);

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

      {groups.length === 0 ? (
        <div className="rounded-2xl border border-subtle bg-surface-2 py-12 text-center text-[13px] text-ink-faint">ไม่พบตั๋วตามตัวกรอง</div>
      ) : (
        <>
          <div className="mb-2 text-[12px] text-ink-faint">แสดง {shown} ใบ</div>
          {groups.map(({ maker, franchises }) => (
            <div key={maker.id} className="mb-7">
              {/* ── ค่าย ── */}
              <div className="mb-2.5 flex items-center gap-2 text-[16px] font-extrabold">
                <span className="h-4 w-1 rounded-full bg-primary-bright" /> {maker.name}
                <span className="text-[12px] font-semibold text-ink-faint">· {franchises.reduce((s, f) => s + f.products.reduce((s2, p) => s2 + p.tickets.length, 0), 0)} ใบ</span>
              </div>
              {franchises.map(({ franchise, products }) => (
                <div key={franchise.id} className="mb-4">
                  {/* ── เรื่อง ── */}
                  <div className="mb-2 text-[12.5px] font-bold text-ink-muted2">🏷️ {franchise.name} · {products.reduce((s, p) => s + p.tickets.length, 0)} ใบ</div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {products.map(({ product, tickets }) => (
                      <ProductTicketCard
                        key={product.id}
                        product={product}
                        tickets={tickets}
                        open={openPid === product.id}
                        onToggle={() => setOpenPid((cur) => (cur === product.id ? null : product.id))}
                      />
                    ))}
                  </div>
                  {/* droplist ของการ์ดที่เปิดในเรื่องนี้ */}
                  {products.some((p) => p.product.id === openPid) && (
                    <BuyerList
                      entry={products.find((p) => p.product.id === openPid)!}
                      onPick={setPeek}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {peek && <TicketPeek ticket={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

function ProductTicketCard({ product, tickets, open, onToggle }: { product: Product; tickets: PreorderTicket[]; open: boolean; onToggle: () => void }) {
  const db = useDatabase();
  const owing = tickets.reduce((s, t) => s + Math.max(0, due(t)), 0);
  const pieces = tickets.reduce((s, t) => s + t.qty, 0);
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
              <span className={cx('w-[90px] text-right text-[12px] font-bold', d > 0 ? 'text-primary-soft' : 'text-[#4ade80]')}>{d > 0 ? `ค้าง ${baht(d)}` : 'ครบ ✓'}</span>
              <span className="w-[70px] text-right text-[11px] text-ink-faint">{fmtDate(t.created_at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
