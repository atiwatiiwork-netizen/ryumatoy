'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht, STATUS, STATUS_FILL } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { Icon, type IconName } from '@/components/Icon';
import { cx } from '@/components/ui';
import { computeEta, etaRangeLabel, etaDaysLabel } from '@/domain/services/shipping';
import { warehouseEtaLabel } from '@/domain/services/warehouse';
import { memosDue } from '@/domain/services/sourcing';
import { unmatchedApprovedItems } from '@/domain/services/tickets';
import { orphanUsedGrants } from '@/domain/services/coupons';
import { deliveryRequests, parcelQueue, handoffQueue, DELIVERY_METHOD_LABEL, resolveShipTo, ticketPaidFull } from '@/domain/services/delivery';
import { productLabel, lineImage } from '@/domain/services/catalog';
import { repairTickets } from '@/data/mutations';
import type { ProductStatus, PreorderTicket } from '@/domain/entities';

const PROGRESS_STATUSES: ProductStatus[] = ['open', 'production', 'shipping', 'arrived'];

export default function AdminDashboardPage() {
  const router = useRouter();
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  // ล็อตเดินทางที่ถูกกดกางดูรายละเอียด (ข้อมูลสินค้า + ลิสลูกค้า + สถานะรายคน)
  const [openLot, setOpenLot] = useState<string | null>(null);
  // "ข้อมูลขาดจาก split flush" watchdog — three failure shapes of the non-atomic multi-table save:
  const lostTickets = unmatchedApprovedItems(db); // approved item, no ticket
  const lostPeople = new Set(lostTickets.map((x) => x.order.user_id)).size;
  const zeroItemOrders = db.orders.filter((o) => (o.status === 'pending_approval' || o.status === 'approved') && o.items.length === 0);
  const orphanGrants = orphanUsedGrants(db).length; // coupon burned, its order/rp never landed (self-heals client-side)
  const hasAnomaly = lostTickets.length > 0 || zeroItemOrders.length > 0 || orphanGrants > 0;

  const pending = db.orders.filter((o) => o.status === 'pending_approval');
  const pendingRP = db.remainingPayments.filter((r) => r.status === 'pending');
  const totalPre = db.tickets.length + pending.reduce((s, o) => s + o.items.length, 0);
  // real revenue from approved orders (by approval date) — no demo fallback
  const now = new Date();
  const sameDay = (d?: string) => d != null && new Date(d).toDateString() === now.toDateString();
  const sameMonth = (d?: string) => d != null && new Date(d).getFullYear() === now.getFullYear() && new Date(d).getMonth() === now.getMonth();
  const approved = db.orders.filter((o) => o.status === 'approved');
  const todayIncome = approved.filter((o) => sameDay(o.approved_at ?? o.created_at)).reduce((s, o) => s + o.total_deposit, 0);
  const monthIncome = approved.filter((o) => sameMonth(o.approved_at ?? o.created_at)).reduce((s, o) => s + o.total_deposit, 0);
  const lowStock = db.products.filter((p) => p.is_stock && (p.stock_qty ?? 0) <= 5).length;
  const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const dateLabel = `${now.getDate()} ${THAI_MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  const statusCounts = PROGRESS_STATUSES.map((st) => ({ st, count: db.products.filter((p) => !p.is_stock && p.status === st).length }));
  const maxCount = Math.max(1, ...statusCounts.map((s) => s.count));

  // ── หมวดใหญ่ 1: สินค้าเดินทางออกจากจีน / ใกล้ถึงไทย (การ์ดมีรูป, เจ้าของ 2026-07-19) ──
  // ล็อตที่กำลังเดินทาง: สินค้า status 'shipping' หรือ มีตั๋วที่ยืนยันโกดังจีนแล้ว (ระบบโกดัง flip
  // รายใบ — สินค้าอาจยังค้าง 'production' จนกว่าจะครบรอบ แต่ของบางใบออกเดินทางแล้วจริง ต้องเห็นที่นี่)
  const inTransit = db.products
    .filter((p) => !p.is_stock && (p.status === 'shipping' || db.tickets.some((t) => t.product_id === p.id && t.product_status === 'shipping')))
    .map((p) => {
      const cohort = db.tickets.filter((t) => t.product_id === p.id && t.product_status === 'shipping');
      const waiting = p.status !== 'shipping' // ล็อตออกบางส่วน (โกดังยืนยันรายใบ ยังไม่ครบรอบ)
        ? db.tickets.filter((t) => t.product_id === p.id && t.product_status === 'production').length
        : 0;
      // ETA: ระดับล็อต (shipped_at) ก่อน — ไม่มีก็ใช้ของตั๋วที่ยืนยันโกดังใบแรก (รถ/เรือ + วันเข้าโกดัง)
      const eta = computeEta(db.settings, p.shipped_at);
      const whTicket = !eta ? cohort.find((t) => t.warehouse_at) : undefined;
      return { p, eta, whEta: whTicket ? warehouseEtaLabel(db, whTicket) : '', waiting, buyers: cohort.length, pieces: cohort.reduce((s, t) => s + t.qty, 0) };
    })
    .sort((a, b) => Number(b.eta?.arrivingSoon ?? false) - Number(a.eta?.arrivingSoon ?? false));
  const soonCount = inTransit.filter((x) => x.eta?.arrivingSoon).length;

  /** การ์ดล็อต 1 ใบ (ใช้ทั้ง group ใกล้ถึงไทย และ ขบวนทั้งหมด) — กดกาง LotDetail. */
  const renderLotCard = ({ p, eta, whEta, waiting, buyers, pieces }: (typeof inTransit)[number]) => (
    <button key={p.id} onClick={() => setOpenLot((cur) => (cur === p.id ? null : p.id))} className={cx('flex items-center gap-3 rounded-xl border p-3 text-left', openLot === p.id ? 'border-accent bg-[#b91c1c]/[0.08]' : eta?.arrivingSoon ? 'border-[#2563eb]/45 bg-[#2563eb]/[0.08]' : 'border-subtle bg-surface-3')}>
      <div className="h-[52px] w-[52px] shrink-0 overflow-hidden rounded-[10px] border border-subtle bg-stripe">
        {p.images[0]
          ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" />
          : <div className="grid h-full w-full place-items-center"><Icon name="box" size={22} className="text-primary-soft/25" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold">{productLabel(db, p.id)}</div>
        <div className="mt-0.5 text-[11.5px] text-ink-faint">
          คนพรี {buyers} · {pieces} ชิ้น
          {waiting > 0 && <span className="text-[#fbbf24]"> · ออกแล้วบางส่วน (รออีก {waiting} ใบ)</span>}
          {p.tracking_no ? <span className="font-mono"> · {p.tracking_no}</span> : null}
        </div>
        {(eta || whEta) && (
          <div className={cx('mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold', eta?.arrivingSoon ? 'bg-[#dc2626]/20 text-[#f87171]' : 'bg-[#2563eb]/15 text-[#8fb8f0]')}>
            {eta ? <>🚚 คาดถึง {etaRangeLabel(eta)} {etaDaysLabel(eta)}{eta.arrivingSoon ? ' · ใกล้ถึง!' : ''}</> : whEta}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[11px] font-bold text-ink-faint">{openLot === p.id ? '▲ ปิด' : '▼ ลูกค้า'}</span>
    </button>
  );

  // ── หมวดใหญ่ 2: สินค้าที่ต้องจัดส่ง (คิวการรับของทั้ง 3 ขั้น รวมที่เดียว) ──
  const dReq = deliveryRequests(db);
  const dParcel = parcelQueue(db);
  const dHandoff = handoffQueue(db);
  const toShipTotal = dReq.length + dParcel.length + dHandoff.length;

  // memo หาของนอกระบบ (แชทเฟส/โทร) ที่เข้าช่วงคาดว่าถึงแล้ว — เตือนให้ไปทวงเช็ค
  const memoDue = memosDue(db);

  return (
    <div>
      <div className="mb-[22px] flex items-center justify-between">
        <div>
          <div className="text-2xl font-extrabold">ภาพรวมร้าน</div>
          <div className="text-[13px] text-ink-faint">{dateLabel}</div>
        </div>
        <div className="flex gap-2.5">
          <button className="grid h-[38px] w-[38px] place-items-center rounded-[11px] border border-subtle bg-surface-2 text-ink"><Icon name="bell" size={19} /></button>
          <div className="grid h-[38px] w-[38px] place-items-center rounded-full bg-primary font-bold">R</div>
        </div>
      </div>

      <div className="mb-[22px] grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat urgent label="สลิปรอ Approve" value={String(pending.length)} icon="warning" />
        <Stat label="พรีทั้งหมด" value={String(totalPre)} icon="box" />
        <Stat label="ยอดเงินวันนี้" value={baht(todayIncome)} icon="payments" green />
        <Stat label="Stock ใกล้หมด" value={String(lowStock)} icon="bolt" />
      </div>

      {hasAnomaly && (
        <div className="mb-[22px] rounded-2xl border border-[#b91c1c]/50 bg-[#b91c1c]/[0.1] p-5">
          <div className="mb-2 flex items-center gap-2 font-bold text-primary-soft"><Icon name="warning" size={18} /> พบข้อมูลขาดจากการเซฟไม่สมบูรณ์ (มือถือหลุดกลางเซฟ)</div>
          <ul className="mb-3 list-inside list-disc text-[12.5px] leading-relaxed text-ink-muted2">
            {lostTickets.length > 0 && <li>ตั๋วหายจากออเดอร์ที่อนุมัติแล้ว <b className="text-ink">{lostTickets.length} ใบ · {lostPeople} คน</b> — กู้เองเมื่อลูกค้าเปิดแอป หรือกดซ่อมด้านล่าง</li>}
            {zeroItemOrders.length > 0 && <li>ออเดอร์ไม่มีรายการสินค้า <b className="text-ink">{zeroItemOrders.length} ออเดอร์</b> — อนุมัติไม่ได้ ให้ปฏิเสธแล้วแจ้งลูกค้าสั่งใหม่</li>}
            {orphanGrants > 0 && <li>คูปองถูกใช้แต่ออเดอร์/สลิปไม่สมบูรณ์ <b className="text-ink">{orphanGrants} ใบ</b> — ระบบคืนให้เองเมื่อลูกค้าเปิดแอป</li>}
          </ul>
          {lostTickets.length > 0 && (
            <button onClick={() => { dispatch(repairTickets()); flash(`ซ่อมตั๋วแล้ว ${lostTickets.length} ใบ ✓`); }} className="rounded-lg bg-cta px-4 py-2 text-[13px] font-bold text-white">🔧 ซ่อมตั๋วทั้งหมดตอนนี้</button>
          )}
        </div>
      )}

      {/* ── หมวดใหญ่ 1: เดินทางออกจากจีน / ใกล้ถึงไทย ── */}
      {inTransit.length > 0 && (
        <div className={cx('mb-[22px] rounded-2xl border p-5', soonCount > 0 ? 'animate-pulseRed border-[#2563eb]/50 bg-[#2563eb]/[0.1]' : 'border-subtle bg-surface-2')}>
          <div className="mb-1 flex items-center gap-2 text-base font-bold text-[#bcd3f5]">
            <Icon name="truck" size={19} /> 🚢 เดินทางออกจากจีน / ใกล้ถึงไทย
            <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[12px] text-ink-muted2">{inTransit.length}</span>
            {soonCount > 0 && <span className="rounded-full bg-[#dc2626] px-2 py-0.5 text-[11px] font-extrabold text-white">ใกล้ถึง {soonCount}</span>}
          </div>
          <div className="mb-3 text-[11.5px] text-ink-faint">ล็อตที่ออกจากโกดังจีนแล้ว · ถึงไทยเมื่อไหร่ไปกดเลื่อนสถานะ "ถึงไทย"</div>

          {/* group ใกล้ถึงไทย แยกชัดจากขบวนทั้งหมด (เจ้าของ 2026-07-20) */}
          {soonCount > 0 && (
            <div className="mb-3 rounded-xl border border-[#dc2626]/45 bg-[#dc2626]/[0.07] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-[#f87171]">🔴 ใกล้ถึงไทย ({soonCount}) — เตรียมรับของ</div>
              <div className="grid gap-2.5 lg:grid-cols-2">
                {inTransit.filter((x) => x.eta?.arrivingSoon).map(renderLotCard)}
              </div>
            </div>
          )}
          {inTransit.some((x) => !x.eta?.arrivingSoon) && (
            <>
              {soonCount > 0 && <div className="mb-2 text-[12px] font-bold text-ink-muted">🚢 กำลังเดินทางทั้งหมด ({inTransit.length - soonCount})</div>}
              <div className="grid gap-2.5 lg:grid-cols-2">
                {inTransit.filter((x) => !x.eta?.arrivingSoon).map(renderLotCard)}
              </div>
            </>
          )}
          {openLot && inTransit.some((x) => x.p.id === openLot) && (
            <LotDetail productId={openLot} onGoUpdate={() => router.push('/admin/products')} />
          )}
        </div>
      )}

      {/* ── หมวดใหญ่ 2: สินค้าที่ต้องจัดส่ง ── */}
      {toShipTotal > 0 && (
        <div className="mb-[22px] rounded-2xl border border-[#d97706]/40 bg-surface-2 p-5">
          <div className="mb-1 flex items-center gap-2 text-base font-bold text-[#fbbf24]">
            <Icon name="box" size={19} /> 📦 สินค้าที่ต้องจัดส่ง
            <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[12px] text-ink-muted2">{toShipTotal}</span>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5 text-[11.5px]">
            {dReq.length > 0 && <span className="rounded-md bg-[#d97706]/20 px-2 py-0.5 font-bold text-[#fbbf24]">รอยืนยันคำขอ {dReq.length}</span>}
            {dParcel.length > 0 && <span className="rounded-md bg-[#b91c1c]/20 px-2 py-0.5 font-bold text-[#f87171]">รอแจ้งเลขพัสดุ {dParcel.length}</span>}
            {dHandoff.length > 0 && <span className="rounded-md bg-[#2563eb]/20 px-2 py-0.5 font-bold text-[#60a5fa]">รถเข้ารับ/มารับเอง {dHandoff.length}</span>}
          </div>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {[
              ...dReq.map((t) => ({ t, tone: 'text-[#fbbf24]', tag: 'รอยืนยัน' })),
              ...dParcel.map((t) => ({ t, tone: 'text-[#f87171]', tag: 'รอแจ้งเลขพัสดุ' })),
              ...dHandoff.map((t) => ({ t, tone: 'text-[#60a5fa]', tag: 'รอปิดงาน' })),
            ].slice(0, 8).map(({ t, tone, tag }) => <ToShipCard key={t.id} ticket={t} tone={tone} tag={tag} onGo={() => router.push('/admin/orders')} />)}
          </div>
          <button onClick={() => router.push('/admin/orders')} className="mt-3 w-full rounded-xl bg-cta py-2.5 text-[13.5px] font-bold text-white">
            ไปจัดการจัดส่งทั้งหมด ({toShipTotal}) →
          </button>
        </div>
      )}

      {pendingRP.length > 0 && (
        <button onClick={() => router.push('/admin/orders')} className="mb-[22px] flex w-full items-center gap-2.5 rounded-2xl border border-[#d97706]/40 bg-surface-2 p-4 text-left text-[#fbbf24]">
          <Icon name="payments" size={18} />
          <span className="flex-1 text-sm font-bold">ส่วนต่างรอตรวจสอบ {pendingRP.length} รายการ</span>
          <span className="text-[13px] text-ink-muted2">ไปที่ สลิป/ออเดอร์ →</span>
        </button>
      )}

      {memoDue.length > 0 && (
        <button onClick={() => router.push('/admin/sourcing')} className="mb-[22px] flex w-full items-center gap-2.5 rounded-2xl border border-[#8b5cf6]/45 bg-surface-2 p-4 text-left text-[#c4b5fd]">
          <Icon name="search" size={18} />
          <span className="flex-1 text-sm font-bold">📒 หาของนอกระบบถึงช่วงคาดแล้ว {memoDue.length} รายการ — ทวงเช็ค!</span>
          <span className="text-[13px] text-ink-muted2">ไปที่ หาของ →</span>
        </button>
      )}

      <div className="grid gap-[18px] lg:grid-cols-[1.5fr_1fr]">
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-3.5 text-base font-bold">สลิปรอตรวจสอบ</div>
          {pending.length === 0 && <div className="py-5 text-[13px] text-ink-faint">ไม่มีสลิปค้างตรวจ 🎉</div>}
          <div className="flex flex-col gap-3">
            {pending.map((o) => {
              const user = db.users.find((u) => u.id === o.user_id);
              return (
                <div key={o.id} className="flex items-center gap-3.5 rounded-xl border border-subtle bg-surface-3 p-3.5">
                  <div className="grid h-[58px] w-[46px] place-items-center rounded-lg bg-stripe"><Icon name="copy" size={18} className="text-ink-faint" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{user?.display_name}</div>
                    <div className="text-xs text-ink-faint">{o.items.length} รายการ · {baht(o.total_deposit)}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">Approve</button>
                    <button onClick={() => router.push(`/admin/orders/${o.id}`)} className="rounded-[9px] border border-subtle bg-surface-2 px-3.5 py-2 text-[13px] font-bold text-ink-muted2">ดูสลิป</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-4 text-base font-bold">สถานะพรีทั้งหมด</div>
          <div className="flex flex-col gap-3.5">
            {statusCounts.map(({ st, count }) => (
              <div key={st}>
                <div className="mb-1.5 flex justify-between text-[12.5px]">
                  <span style={{ color: STATUS_FILL[st as StatusKey] }}>{STATUS[st as StatusKey].label}</span>
                  <span className="text-ink-muted">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full" style={{ width: `${(count / maxCount) * 100}%`, background: STATUS_FILL[st as StatusKey] }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-[18px] rounded-xl border border-[#d4af37]/40 p-3.5" style={{ background: 'linear-gradient(135deg, rgba(212,175,55,.18), rgba(161,98,7,.1))' }}>
            <div className="text-xs text-[#f1d27a]">ยอดรวมเดือนนี้</div>
            <div className="mt-0.5 text-[22px] font-extrabold text-[#f1d27a]">{baht(monthIncome)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * รายละเอียดล็อตเดินทาง (กดการ์ดแล้วกาง): ข้อมูลสินค้า + ลิสลูกค้าในรอบนี้ + สถานะรายคน
 * (ยังไม่ชำระ / ชำระแล้วรอส่ง / ส่งเรียบร้อย) — เจ้าของ 2026-07-19.
 */
function LotDetail({ productId, onGoUpdate }: { productId: string; onGoUpdate: () => void }) {
  const db = useDatabase();
  const p = db.products.find((x) => x.id === productId);
  if (!p) return null;
  // รอบที่กำลังเดินทางของสินค้านี้ (ตั๋วรอบเก่าที่จบไปแล้วไม่ปน)
  const cohort = db.tickets.filter((t) => t.product_id === productId && t.product_status === 'shipping');
  // ล็อตออกบางส่วน (ยืนยันโกดังรายใบ): ใบที่ยังรอออกจากจีน โชว์แยกท้ายลิสต์
  const waitingRows = p.status !== 'shipping'
    ? db.tickets.filter((t) => t.product_id === productId && t.product_status === 'production')
    : [];
  const stateOf = (t: PreorderTicket) =>
    t.status === 'shipped' ? 2 : ticketPaidFull(t) ? 1 : 0; // 0 ยังไม่ชำระ · 1 รอส่ง · 2 เสร็จ
  const rows = [...cohort].sort((a, b) => stateOf(a) - stateOf(b)); // งานค้างเงินขึ้นก่อน
  const paidCount = cohort.filter((t) => stateOf(t) >= 1).length;
  const dueSum = cohort.reduce((s, t) => s + Math.max(0, t.remaining_amount - t.remaining_paid), 0);
  const CHIP = [
    { cls: 'bg-[#b91c1c]/20 text-[#f87171]', label: 'ยังไม่ชำระเงิน' },
    { cls: 'bg-[#d97706]/20 text-[#fbbf24]', label: 'ชำระแล้ว · รอส่ง' },
    { cls: 'bg-[#16a34a]/20 text-[#4ade80]', label: 'ส่งเรียบร้อย ✓' },
  ];
  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-surface-3 p-4">
      {/* 1) ข้อมูลสินค้า */}
      <div className="mb-3 flex items-center gap-3">
        <div className="h-[64px] w-[64px] shrink-0 overflow-hidden rounded-[10px] border border-subtle bg-stripe">
          {p.images[0]
            ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" />
            : <div className="grid h-full w-full place-items-center"><Icon name="box" size={26} className="text-primary-soft/25" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-bold">{productLabel(db, p.id)}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-faint">
            ราคา {baht(p.price_total)} · มัดจำ {baht(p.deposit_amount)}
            {p.shipped_at ? ` · ออกจากจีน ${new Date(p.shipped_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}` : ''}
            {p.tracking_no ? <span className="font-mono"> · Track {p.tracking_no}</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-bold">
            <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-ink-muted2">ลูกค้า {cohort.length} คน</span>
            <span className="rounded-md bg-[#16a34a]/15 px-1.5 py-0.5 text-[#4ade80]">ชำระแล้ว {paidCount}/{cohort.length}</span>
            {dueSum > 0 && <span className="rounded-md bg-[#b91c1c]/15 px-1.5 py-0.5 text-[#f87171]">ค้างรวม {baht(dueSum)}</span>}
          </div>
        </div>
      </div>
      {/* 2) ลิสลูกค้า + 3) สถานะรายคน */}
      <div className="flex flex-col gap-1.5">
        {rows.length === 0 && waitingRows.length === 0 && <div className="py-2 text-[12.5px] text-ink-faint">ไม่มีตั๋วในรอบเดินทางนี้</div>}
        {rows.map((t) => {
          const u = db.users.find((x) => x.id === t.owner_id);
          const st = stateOf(t);
          const due = Math.max(0, t.remaining_amount - t.remaining_paid);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{u?.display_name ?? '—'}{t.qty > 1 ? <span className="text-ink-faint"> ×{t.qty}</span> : null}</span>
              <span className="font-mono text-[10.5px] text-ink-faint">{t.ticket_no}</span>
              {st === 0 && <span className="text-[11.5px] font-bold text-[#f87171]">ค้าง {baht(due)}</span>}
              <span className={cx('rounded-md px-2 py-0.5 text-[10.5px] font-bold', CHIP[st].cls)}>{CHIP[st].label}</span>
            </div>
          );
        })}
        {/* ใบที่ยังไม่ออกจากจีน (ล็อตยืนยันโกดังรายใบ ยังไม่ครบรอบ) */}
        {waitingRows.map((t) => {
          const u = db.users.find((x) => x.id === t.owner_id);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-2 px-3 py-2 opacity-60">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{u?.display_name ?? '—'}{t.qty > 1 ? <span className="text-ink-faint"> ×{t.qty}</span> : null}</span>
              <span className="font-mono text-[10.5px] text-ink-faint">{t.ticket_no}</span>
              <span className="rounded-md bg-white/[0.07] px-2 py-0.5 text-[10.5px] font-bold text-ink-muted2">⏳ รอออกจากโกดังจีน</span>
            </div>
          );
        })}
      </div>
      <button onClick={onGoUpdate} className="mt-3 w-full rounded-xl border border-[#2563eb]/45 bg-[#2563eb]/[0.12] py-2.5 text-[13px] font-bold text-[#8fb8f0]">
        ของถึงไทยแล้ว? ไปเลื่อนสถานะล็อตที่ Pre-Order →
      </button>
    </div>
  );
}

/** การ์ดงานจัดส่ง 1 ใบ (สไตล์การ์ด memo ที่เจ้าของชอบ): รูป + ชื่อ-ค่าย + ลูกค้า + ป้ายขั้นตอน. */
function ToShipCard({ ticket, tone, tag, onGo }: { ticket: PreorderTicket; tone: string; tag: string; onGo: () => void }) {
  const db = useDatabase();
  const img = lineImage(db, ticket.product_id, ticket.variant_id);
  const user = db.users.find((u) => u.id === ticket.owner_id);
  const to = resolveShipTo(db, ticket);
  const isShip = !ticket.delivery || ticket.delivery.method === 'registered' || ticket.delivery.method === 'custom';
  return (
    <button onClick={onGo} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3 text-left">
      <div className="h-[52px] w-[52px] shrink-0 overflow-hidden rounded-[10px] border border-subtle bg-stripe">
        {img
          ? <img src={img} alt="" className="h-full w-full object-cover" />
          : <div className="grid h-full w-full place-items-center"><Icon name="box" size={22} className="text-primary-soft/25" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold">{productLabel(db, ticket.product_id, ticket.variant_id)}{ticket.qty > 1 ? ` ×${ticket.qty}` : ''}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">
          <Icon name="user" size={11} className="mr-0.5 inline" /> {user?.display_name ?? '—'}
          {ticket.delivery ? ` · ${DELIVERY_METHOD_LABEL[ticket.delivery.method]}` : ' · ส่งตามที่อยู่ (flow เดิม)'}
        </div>
        {isShip && to.address && <div className="mt-0.5 truncate text-[11px] text-ink-faint">📍 {to.address}</div>}
      </div>
      <span className={cx('shrink-0 rounded-md bg-white/[0.06] px-2 py-1 text-[10.5px] font-bold', tone)}>{tag}</span>
    </button>
  );
}

function Stat({ label, value, icon, urgent, green }: { label: string; value: string; icon: IconName; urgent?: boolean; green?: boolean }) {
  return (
    <div
      className={cx('rounded-card border p-4', urgent ? 'animate-pulseRed border-accent' : 'border-subtle bg-surface-2')}
      style={urgent ? { background: 'linear-gradient(160deg, rgba(220,38,38,.25), #1a0f0e)' } : undefined}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] text-ink-muted">{label}</span>
        <Icon name={icon} size={18} className={urgent ? 'text-[#f87171]' : green ? 'text-[#4ade80]' : 'text-ink-faint'} />
      </div>
      <div className={cx('text-[26px] font-extrabold', green ? 'text-[#4ade80]' : 'text-ink')}>{value}</div>
    </div>
  );
}
