'use client';

/**
 * แถวคุมสถานะ "ลอตพรีปกติ" ของ SKU หนึ่งตัว (กระดานหลัก ไม่ใช่รอบพิเศษ):
 * เปิดจอง → ปิดใบพรี → ผลิต → เดินทาง (ต้องมี Track + ผ่าน gate โกดังจีน) → ถึงไทย + push นับจำนวนส่งจริง.
 * แยกออกมาจาก products/page.tsx (2026-09-05) เพื่อให้หน้า "สต๊อกใบพรี" ใช้ตัวเดียวกันตอนจัดกลุ่มตาม SKU —
 * ห้าม fork ตรรกะ advance/push ไปเขียนซ้ำที่อื่น (จะได้พฤติกรรมเพี้ยนกันคนละหน้า).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { STATUS } from '@/lib/theme';
import type { StatusKey } from '@/lib/theme';
import { TicketQr, cx } from '@/components/ui';
import { franchiseOf, orderedQtyOf } from '@/domain/services/catalog';
import { productAwaitingWarehouse } from '@/domain/services/warehouse';
import { store } from '@/data/store';
import { sendPush, subsForProductOwners, statusPushPayload, pushEnabled } from '@/lib/push';
import { setProductStatus, closeProduction } from '@/data/mutations';
import type { Product, ProductStatus } from '@/domain/entities';

const LOT_STEPS: ProductStatus[] = ['open', 'production', 'shipping', 'arrived', 'delivered'];
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';

export function StatusRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const ordered = orderedQtyOf(db, p.id);
  const count = db.tickets.filter((t) => t.product_id === p.id).length;
  // สเต็ปเปอร์หยุดที่ "ถึงไทยแล้ว" — ส่งมอบทำรายตั๋วที่หน้า สลิป/ออเดอร์
  const idx = LOT_STEPS.indexOf(p.status);
  const arrivedIdx = LOT_STEPS.indexOf('arrived');
  const next = idx < arrivedIdx ? LOT_STEPS[idx + 1] : null;
  // ผลิต → เดินทาง ต้องผ่าน "ยืนยันโกดัง" ก่อน (หน้าสต๊อก) ถ้ายังมีตั๋วรอเข้าโกดัง — กัน 2 ทางชนกัน
  const gateWarehouse = next === 'shipping' && productAwaitingWarehouse(db, p.id);
  const [open, setOpen] = useState(false);
  const [showBuyers, setShowBuyers] = useState(false);
  const [track, setTrack] = useState(p.tracking_no ?? '');
  const [shippedAt, setShippedAt] = useState(p.shipped_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [finalQty, setFinalQty] = useState(String(ordered));
  const buyers = db.tickets.filter((t) => t.product_id === p.id);
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const ticketUrl = (no: string) => (typeof window !== 'undefined' ? `${window.location.origin}/wallet/${encodeURIComponent(no)}` : no);

  const advance = async (extra?: { tracking_no?: string; shipped_at?: string }) => {
    if (!next) return;
    dispatch(setProductStatus(p.id, next, extra));
    // DNA save: เซฟให้ผ่านก่อนค่อยแจ้งลูกค้า/ขึ้น ✓ — push "ถึงไทย มาจ่ายส่วนต่าง" ที่ออกไปทั้งที่
    // สถานะยังไม่ถูกบันทึก = ลูกค้าเปิดตั๋วมายังเป็นสถานะเดิม กดจ่ายไม่ได้ (audit 2026-08-08)
    if (await store.flush()) { flash('บันทึกไม่สำเร็จ — ยังไม่ได้แจ้งลูกค้า ระบบลองใหม่ให้เอง รอสักครู่แล้วรีเฟรชเช็คสถานะ'); return; }
    // notify this lot's buyers when it starts moving / lands (ryuma push spec 4.1/4.2)
    // ⚠ push ไปที่ "เครื่องลูกค้า" ไม่ใช่เครื่องแอดมิน — แอดมินจึงไม่เห็นแจ้งเตือนเอง (เจ้าของ 2026-08-16
    //   เข้าใจผิดว่า push ไม่ทำงาน). โชว์จำนวนที่ยิงจริงในข้อความ เพื่อให้แอดมินตรวจสอบได้ว่าส่งแล้ว
    let note = '';
    if ((next === 'shipping' || next === 'arrived')) {
      const key = next === 'shipping' ? 'lot_shipping' : 'lot_arrived';
      if (!pushEnabled(db, key)) note = ` · ⚠ สวิตช์แจ้งเตือน "${key}" ถูกปิดอยู่ (หน้า Push)`;
      else {
        const targets = subsForProductOwners(db, p.id);
        if (targets.length === 0) note = ' · (ลูกค้ายังไม่เปิดกระดิ่ง — ยังไม่มีเครื่องรับแจ้งเตือน)';
        else {
          try {
            const { sent } = await sendPush(targets, statusPushPayload(next, p.series_name), dispatch);
            note = sent > 0 ? ` · 🔔 แจ้งเตือนลูกค้า ${sent} เครื่องแล้ว` : ' · (กระดิ่งลูกค้าหมดอายุ — ไม่มีเครื่องรับ)';
          } catch { note = ' · ⚠ ส่งแจ้งเตือนไม่สำเร็จ (เน็ต/เซิร์ฟเวอร์) — สถานะบันทึกแล้ว'; }
        }
      }
    }
    flash(`${p.series_name} → ${STATUS[next as StatusKey].label} · ${count} ตั๋ว${note}`);
    setOpen(false);
  };
  // ปิดใบพรี = เปิดจอง → ผลิต ผ่าน closeProduction (โค้ดเดียวกับหน้า ปิดรอบสั่งผลิต)
  const closePre = () => {
    const fq = Number(finalQty) || 0;
    if (fq < ordered) return flash(`สั่งไฟนอลต้อง ≥ ยอดจอง (${ordered})`);
    dispatch(closeProduction([{ productId: p.id, finalQty: fq }]));
    const surplus = Math.max(0, fq - ordered);
    flash(`ปิดใบพรี → ผลิต${surplus > 0 ? ` · เกิน ${surplus} → สต๊อก` : ''}`);
    setOpen(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <button onClick={() => setShowBuyers((o) => !o)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold hover:text-primary-soft">{p.series_name}</span>
            <span className={cx('inline-block text-[10px] text-ink-faint transition-transform', showBuyers && 'rotate-180')}>▾</span>
          </div>
          <div className="text-[11px] text-ink-faint">{franchiseOf(db, p)?.name} · จอง {ordered} ตัว{p.production_qty != null ? ` · สั่ง ${p.production_qty}` : ''}</div>
        </button>
        {p.status === 'open' ? (
          <button onClick={() => setOpen((o) => !o)} className="whitespace-nowrap rounded-lg bg-cta px-3 py-1.5 text-[12.5px] font-bold text-white">ปิดใบพรี →</button>
        ) : !next ? (
          <Link href="/admin/orders" className="whitespace-nowrap rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] px-3 py-1.5 text-[12px] font-bold text-primary-soft">จัดส่งรายตั๋ว →</Link>
        ) : gateWarehouse ? (
          <Link href="/admin/stock" title="ยืนยันเข้าโกดังจีนก่อน (หน้าสต๊อก) จึงจะเป็นกำลังเดินทาง" className="whitespace-nowrap rounded-lg border border-[#2563eb]/45 bg-[#2563eb]/[0.14] px-3 py-1.5 text-[12px] font-bold text-[#93c5fd]">🚢 ยืนยันโกดัง →</Link>
        ) : (
          <button onClick={() => (next === 'shipping' ? setOpen((o) => !o) : advance())} className="whitespace-nowrap rounded-lg bg-cta px-3 py-1.5 text-[12.5px] font-bold text-white">→ {STATUS[next as StatusKey].label}</button>
        )}
      </div>

      {open && p.status === 'open' && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-muted">สั่งไฟนอล</span>
          <input value={finalQty} onChange={(e) => setFinalQty(e.target.value)} inputMode="numeric" className={cx(inputCls, 'w-24 py-2 text-center')} />
          <span className="text-[11.5px] text-ink-faint">{Number(finalQty) > ordered ? `เกิน ${Number(finalQty) - ordered} → สต๊อก` : 'ไม่มีส่วนเกิน'}</span>
          <button onClick={closePre} className="ml-auto whitespace-nowrap rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">ยืนยันปิดใบพรี</button>
        </div>
      )}

      {open && p.status !== 'open' && next === 'shipping' && (
        <div className="mt-2 flex gap-2">
          <input value={track} onChange={(e) => setTrack(e.target.value)} placeholder="เลข Track จีน→ไทย" className={cx(inputCls, 'py-2')} />
          <input type="date" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} className={cx(inputCls, 'w-[150px] py-2')} />
          <button onClick={() => (track.trim() ? advance({ tracking_no: track.trim(), shipped_at: shippedAt }) : flash('ใส่เลข Track ก่อน'))} className="whitespace-nowrap rounded-lg bg-cta px-4 text-[12.5px] font-bold text-white">ยืนยัน</button>
        </div>
      )}

      {/* dropdown รายชื่อลูกค้าที่พรีล็อตนี้ */}
      {showBuyers && (
        <div className="mt-2 rounded-lg border border-subtle bg-surface-3 p-2">
          {buyers.length === 0 ? (
            <div className="py-2 text-center text-[12px] text-ink-faint">ยังไม่มีลูกค้าพรีล็อตนี้</div>
          ) : (
            <div className="flex flex-col divide-y divide-hair">
              {buyers.map((t) => (
                <Link key={t.id} href={`/wallet/${encodeURIComponent(t.ticket_no)}`} className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-white/[0.03]">
                  <TicketQr value={ticketUrl(t.ticket_no)} size={40} pad={5} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{userName(t.owner_id)}</div>
                    <div className="text-[11px] text-ink-faint">{new Date(t.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })} · <span className="font-mono">{t.ticket_no}</span></div>
                  </div>
                  <span className="whitespace-nowrap text-[11px] font-bold text-primary-soft">ดูตั๋ว →</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
