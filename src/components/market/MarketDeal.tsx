'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { uploadImage } from '@/lib/upload';
import { notifyAdminLine } from '@/lib/notify';
import { baht } from '@/lib/theme';
import { productLabel } from '@/domain/services/catalog';
import { livePrice } from '@/domain/services/pricing';
import { dealRole, effectiveStatus, sellerSlaLeft, soldOutInShop, isDirect, dealStatusLabel, sellerMask, MARKET, TRANSFER_STATUS_LABEL } from '@/domain/services/market';
import * as mk from '@/lib/market';
import type { Database, TicketTransfer } from '@/domain/entities';
import { BackBar, cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { StubArt, LotPill, productSub, MoneySplit, HoldRing, SlideToConfirm, PromptPayCard, DealSteps, useMarketFeed, useNow, mmss } from './MarketUi';
import { PayoutLine } from './PayoutPicker';

type Flash = (m: string) => void;
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
/** เวลาที่เหลือแบบอ่านง่าย: เกิน 1 ชม. = "23 ชม. 59 นาที" · ต่ำกว่า = mm:ss */
const leftLabel = (msLeft: number) => msLeft >= 3_600_000 ? `${Math.floor(msLeft / 3_600_000)} ชม. ${Math.floor((msLeft % 3_600_000) / 60_000)} นาที` : mmss(msLeft);
/** ชื่อคู่ดีล — RLS อาจไม่ให้เห็นแถว user ของอีกฝั่ง → ใช้ mask จาก id (เจ้าของ: ไม่ต้องสนชื่อ ขอแค่ยอด+ใบตรง) */
const whoMask = (db: Database, id?: string) => { const u = db.users.find((x) => x.id === id); return u ? sellerMask(u) : `R•••${(id ?? '').replace(/\D/g, '').slice(-2) || (id ?? '').slice(-2)}`; };
const DIRECT_STEPS = ['ได้รับข้อเสนอ', 'โอน + สลิป', 'คนส่งเช็ค', 'ร้านโอนสิทธิ์'];
const FREE_STEPS = ['ได้รับข้อเสนอ', 'กดรับ', 'คนส่งยืนยัน', 'ร้านโอนสิทธิ์'];

/**
 * หน้าดีล 1 รายการ — ใครเปิดก็เห็นมุมของตัวเอง:
 *   กระดาน: คนทั่วไป = รายละเอียด + ปัดเพื่อจอง · ผู้ซื้อที่จองอยู่ = QR คนขาย + แนบสลิป (นับถอยหลัง)
 *   เปลี่ยนใบ (v73 direct): ผู้รับ = ข้อเสนอ 24 ชม. → โอน+สลิป / กดรับ (ยอด 0) / ไม่รับ · คนส่ง = ถอนข้อเสนอ / ยืนยันเงินเข้า
 *   ผู้ซื้อหลังจ่าย = ติดตาม 4 ขั้น · คนขาย = ถอนประกาศ / ยืนยันเงินเข้า / แจ้งไม่ได้รับ
 * ทุกการเปลี่ยนสถานะผ่าน RPC (ด่านอยู่ฝั่ง server) แล้ว store.reload() ดึงของจริง
 */
export function MarketDeal({ id, mode = 'live', onBack }: { id: string; mode?: 'live' | 'preview'; onBack: () => void }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const { flash } = useToast();
  const { rows, refresh, serverNow } = useMarketFeed(true, db);
  const now = useNow(1000);
  const row = rows?.find((r) => r.id === id);
  const tr = db.transfers.find((x) => x.id === id);
  const role = tr ? dealRole(tr, uid) : 'none';
  const direct = !!tr && isDirect(tr);
  const st = tr ? effectiveStatus(tr, new Date(now)) : row?.status;
  const productId = tr?.product_id ?? row?.product_id;
  const variantId = (tr?.variant_id ?? row?.variant_id) || undefined;
  const reload = async () => { await store.reload(); await refresh(); };

  if (!productId) {
    return (
      <div className="mx-auto max-w-[560px]">
        <BackBar title="ตลาดใบพรี" onBack={onBack} />
        <div className="rounded-2xl border border-subtle bg-surface-2 p-8 text-center text-[13px] text-ink-muted2">
          {rows === null ? 'กำลังโหลด…' : 'ประกาศนี้ปิดไปแล้ว หรือมีคนซื้อไปแล้ว'}
        </div>
      </div>
    );
  }

  const price = tr?.asking_price ?? row?.asking_price ?? 0;
  const due = row?.due ?? tr?.snap?.due ?? 0;
  const total = row?.total ?? tr?.snap?.total;
  const lot = row?.product_status ?? tr?.snap?.product_status;
  const hint = row?.ticket_hint ?? tr?.snap?.ticket_hint;
  const qty = row?.qty ?? tr?.qty ?? 1;
  const hot = soldOutInShop(db, productId);
  const title = direct
    ? (role === 'seller' ? 'ข้อเสนอเปลี่ยนใบของฉัน' : role === 'buyer' ? 'มีคนเปลี่ยนใบพรีให้คุณ' : 'เปลี่ยนใบพรี')
    : (role === 'seller' ? 'ประกาศของฉัน' : role === 'buyer' ? 'ดีลของฉัน' : 'รายละเอียดใบพรี');

  return (
    <div className="mx-auto max-w-[560px]">
      <BackBar title={title} onBack={onBack} />
      {/* ตั๋วใบใหญ่ — โฮโลเฉพาะของที่หมดในร้าน */}
      <div className={cx('relative mb-3.5 overflow-hidden rounded-[20px] border bg-surface-3', hot ? 'border-[#f1d27a]/40' : 'border-subtle')}>
        <div className="relative h-[168px]">
          <StubArt db={db} productId={productId} variantId={variantId} />
          {hot && <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,#ff8f8f,#ffd479,#8ff0b4,#86c8ff,#cdb0ff,#ff8f8f)] bg-[length:250%_250%] opacity-20 mix-blend-color-dodge motion-safe:animate-holoMove" />}
          {direct && <span className="absolute left-3 top-3 rounded-full border border-[#f1d27a]/50 bg-[#0a0809]/70 px-2.5 py-0.5 text-[11px] font-bold text-[#f1d27a] backdrop-blur">🔁 เปลี่ยนใบพรี · โอนตรง</span>}
        </div>
        <div className="relative border-t-2 border-dashed border-base/90 px-4 pb-3.5 pt-3 before:absolute before:-left-[10px] before:-top-[10px] before:h-[18px] before:w-[18px] before:rounded-full before:bg-base after:absolute after:-right-[10px] after:-top-[10px] after:h-[18px] after:w-[18px] after:rounded-full after:bg-base">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11.5px] tracking-wider text-primary-soft">{hint ?? '—'}</span>
            <LotPill status={lot} />
          </div>
          <div className="mt-1 text-[18px] font-extrabold leading-snug">{productLabel(db, productId, variantId)}</div>
          <div className="text-[12px] text-ink-faint">{productSub(db, productId)}{qty > 1 ? ` · ${qty} ชิ้น` : ''}{hot ? ' · หมดในร้านแล้ว' : ''}</div>
        </div>
      </div>

      {role === 'buyer' && st === 'reserved' && tr && direct ? (
        <OfferPanel db={db} tr={tr} price={price} due={due} serverNow={serverNow} now={now} flash={flash} reload={reload} lineOa={db.settings.line_oa_id} />
      ) : role === 'buyer' && st === 'reserved' && tr ? (
        <PayPanel tr={tr} price={price} due={due} serverNow={serverNow} now={now} flash={flash} reload={reload} />
      ) : role === 'buyer' && tr ? (
        <BuyerTrack tr={tr} st={st!} price={price} due={due} now={now} flash={flash} reload={reload} lineOa={db.settings.line_oa_id} />
      ) : role === 'seller' && tr ? (
        <SellerPanel db={db} tr={tr} st={st!} price={price} due={due} now={now} flash={flash} reload={reload}
          ticketNo={db.tickets.find((t) => t.id === tr.ticket_id)?.ticket_no} />
      ) : row ? (
        <PublicPanel id={id} row={row} price={price} due={due} total={total}
          shopPrice={livePrice(db, { productId, variantId }).price * qty} now={now} flash={flash} reload={reload} preview={mode === 'preview'} />
      ) : (
        <div className="rounded-2xl border border-subtle bg-surface-2 p-6 text-center text-[13px] text-ink-muted2">{direct ? 'ข้อเสนอนี้ส่งถึงคนอื่น — ไม่ใช่ของคุณ' : 'ประกาศนี้ไม่ได้ลงขายแล้ว'}</div>
      )}
    </div>
  );
}

// ── คนทั่วไป: รายละเอียด + ปัดเพื่อจอง ──────────────────────────────────────────
function PublicPanel({ id, row, price, due, total, shopPrice, now, flash, reload, preview }: {
  id: string; row: mk.MarketRow; price: number; due: number; total?: number; shopPrice: number; now: number; flash: Flash; reload: () => Promise<void>; preview: boolean;
}) {
  const takenLeft = row.status === 'reserved' && !row.reserved_by_me && row.hold_until ? new Date(row.hold_until).getTime() - now : 0;
  const reserve = async () => {
    const r = await mk.marketReserve(id);
    if (!r.ok) { flash(mk.marketErrText(r)); if (r.error === 'reserved' || r.error === 'gone') await reload(); return; }
    await reload();
    void mk.marketPush(id, 'reserved');
    flash(`จองแล้ว · โอนภายใน ${MARKET.holdMin} นาที`);
  };
  return (
    <div className="flex flex-col gap-3">
      <MoneySplit price={price} due={due} total={total} shopPrice={shopPrice} />
      <div className="flex items-center gap-3 rounded-2xl border border-subtle bg-surface-2 px-3.5 py-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[#f1d27a] to-[#b45309] font-mono text-[11px] font-bold text-[#0a0809]">{row.seller.slice(-2)}</span>
        <div className="min-w-0 flex-1 text-[12.5px]">
          <div className="font-bold">ผู้ขาย {row.seller} <span className="ml-1 rounded bg-white/[0.07] px-1 font-mono text-[10px] uppercase text-ink-muted2">{row.seller_rank}</span></div>
          <div className="text-[11.5px] text-ink-faint">{row.seller_sold > 0 ? `ขายสำเร็จ ${row.seller_sold} ครั้ง` : 'ขายครั้งแรก'} · ลงเมื่อ {fmt(row.listed_at)}</div>
        </div>
      </div>
      <div className="flex gap-2 rounded-xl bg-[#16a34a]/[0.08] px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-muted2">
        <Icon name="verified" size={16} className="mt-px shrink-0 text-[#4ade80]" />
        <span>โอนเงินตรงให้คนขาย · ร้านโอนสิทธิ์ให้คุณหลังคนขายยืนยันรับเงินเท่านั้น · ติดปัญหา แอดมินเป็นคนตัดสิน · ส่วนต่างที่ค้าง จ่ายร้านตอนของถึงไทย (ใช้แต้ม/คูปองได้ตามปกติ)</span>
      </div>
      {row.mine ? (
        <div className="rounded-xl border border-subtle bg-surface-2 px-3 py-2.5 text-center text-[12.5px] text-ink-muted2">นี่คือประกาศของคุณ</div>
      ) : takenLeft > 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-3 py-3 text-[12.5px] text-[#fbbf24]">
          <HoldRing msLeft={takenLeft} total={MARKET.holdMin * 60_000} size={24} stroke={3} />มีคนกำลังจอง <b className="font-mono">{mmss(takenLeft)}</b> · ถ้าเขาปล่อย ใบนี้กลับมาให้จองได้
        </div>
      ) : (
        <SlideToConfirm label={`ปัดเพื่อจองใบนี้ · ${MARKET.holdMin} นาที`} doneLabel="กำลังจอง…" onConfirm={reserve} />
      )}
      {preview && <div className="text-center text-[11px] text-ink-faint">โหมดพรีวิวของแอดมิน — ปัดได้จริงถ้าใช้บัญชีที่ไม่ใช่คนลงขาย</div>}
    </div>
  );
}

// ── ผู้รับข้อเสนอ "เปลี่ยนใบพรี" (v73): 24 ชม. → โอน+สลิป / กดรับ (ยอด 0) / ไม่รับ ──────────────
/** สลิปที่แนบหลังดีลปิดไปแล้ว (คนส่งถอน/หมดเวลา/ตั๋วเปลี่ยน) ถูกเก็บเป็นหลักฐาน (v75) → แจ้งคนส่ง+แอดมิน แล้วบอกผู้รับตรงๆ */
async function reportLateSlip(tr: TicketTransfer, price: number, r: mk.MarketRes, flash: Flash, reload: () => Promise<void>) {
  await reload();
  void mk.marketPush(tr.id, 'late_slip');
  notifyAdminLine(`⚠️ [เปลี่ยนใบพรี] ผู้รับโอน ${baht(price)} แล้ว แต่ดีลปิดไปก่อน (${r.error}) — ต้องเคลียร์คืนเงิน · ดีล ${tr.id}`);
  flash('ดีลนี้ปิดไปแล้ว แต่ร้านได้รับสลิปของคุณแล้ว — แอดมินจะติดต่อให้คนส่งคืนเงิน');
}

function OfferPanel({ db, tr, price, due, serverNow, now, flash, reload, lineOa }: {
  db: Database; tr: TicketTransfer; price: number; due: number; serverNow: () => number; now: number; flash: Flash; reload: () => Promise<void>; lineOa?: string;
}) {
  const [payout, setPayout] = useState<mk.MarketRes | null>(null);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const free = price <= 0;
  useEffect(() => { if (!free) void mk.marketPayout(tr.id).then(setPayout); }, [tr.id, free]);
  void now;
  const left = tr.hold_until ? new Date(tr.hold_until).getTime() - serverNow() : 0;
  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'mkslip')); } catch { flash('อัปโหลดสลิปไม่สำเร็จ ลองใหม่อีกครั้ง'); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (busy || (!free && !slip)) return;
    setBusy(true);
    const r = await mk.marketPay(tr.id, slip ?? '');
    setBusy(false);
    if (!r.ok && r.recorded) { await reportLateSlip(tr, price, r, flash, reload); return; }
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    void mk.marketPush(tr.id, 'paid');
    notifyAdminLine(free
      ? `🤝 [เปลี่ยนใบพรี] ผู้รับกดรับใบ (ยกให้ฟรี) แล้ว — รอคนส่งยืนยัน · ดีล ${tr.id}`
      : `💸 [เปลี่ยนใบพรี] ผู้รับโอน ${baht(price)} ให้คนส่งแล้ว (รอคนส่งยืนยัน) · ดีล ${tr.id}`);
    flash(free ? 'กดรับแล้ว · รอคนส่งยืนยัน' : 'ส่งสลิปแล้ว · แจ้งคนส่งให้เช็คเงินแล้ว');
  };
  const decline = async () => {
    if (busy) return;
    if (!window.confirm('ไม่รับข้อเสนอนี้? ใบพรีจะกลับไปที่คนส่ง')) return;
    setBusy(true);
    const r = await mk.marketDecline(tr.id);
    setBusy(false);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    void mk.marketPush(tr.id, 'declined');
    flash('ไม่รับข้อเสนอแล้ว · แจ้งคนส่งแล้ว');
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-2xl border border-[#f1d27a]/35 bg-[#f1d27a]/[0.08] px-3.5 py-3">
        <HoldRing msLeft={left} total={MARKET.offerHours * 3_600_000} size={48} stroke={4}><span className="text-[10px]">24ชม.</span></HoldRing>
        <div className="text-[12px] leading-relaxed text-ink-muted2">
          <b className="block text-[13.5px] text-[#f1d27a]">{whoMask(db, tr.from_user_id)} เปลี่ยนใบพรีใบนี้ให้คุณ</b>
          {free ? 'ยกให้ฟรี — กดรับภายในเวลา' : 'โอนตามยอดแล้วแนบสลิปภายในเวลา'} · เหลือ <b className="font-mono text-ink">{leftLabel(left)}</b>{left <= 0 ? ' · หมดเวลาแล้ว — ถ้าโอนไปแล้วรีบแนบสลิป' : ''}
        </div>
      </div>
      <DealSteps at={1} labels={free ? FREE_STEPS : DIRECT_STEPS} />
      <MoneySplit price={price} due={due} total={tr.snap?.total} />
      <div className="flex gap-2 rounded-xl bg-[#16a34a]/[0.08] px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-muted2">
        <Icon name="verified" size={16} className="mt-px shrink-0 text-[#4ade80]" />
        <span>{free ? 'ไม่มีเงินโอน — ' : 'โอนเงินตรงให้คนส่ง · '}ร้านโอนสิทธิ์ให้คุณหลังคนส่งยืนยันเท่านั้น · ส่วนต่างที่ค้าง {baht(due)} จ่ายร้านตอนของถึงไทย (ใช้แต้ม/คูปองได้ตามปกติ) · ได้ใบมาแล้วต้องถือ {MARKET.resellDays} วันก่อนเปลี่ยนต่อ</span>
      </div>
      {!free && (payout?.ok ? (
        <PromptPayCard amount={price} promptpay={payout.promptpay} accountNo={payout.account_no} bank={payout.bank} accountName={payout.account_name} flash={flash} />
      ) : (
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5 text-center text-[12.5px] text-ink-muted2">{payout ? mk.marketErrText(payout) : 'กำลังโหลดบัญชีคนส่ง…'}</div>
      ))}
      {!free && (
        <label className={cx('flex cursor-pointer items-center gap-3 rounded-2xl border-[1.5px] border-dashed px-4 py-3.5', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.07]' : 'border-accent')}>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => void onSlip(e.target.files?.[0])} />
          {slip ? <img src={slip} alt="สลิป" className="h-16 w-12 shrink-0 rounded-md object-cover" /> : <Icon name="camera" size={22} className="text-primary-soft" />}
          <span className={cx('text-[13px] font-bold', slip ? 'text-[#4ade80]' : 'text-primary-soft')}>{busy && !slip ? 'กำลังอัปโหลด…' : slip ? 'แนบสลิปแล้ว ✓ · แตะเพื่อเปลี่ยน' : 'แตะแนบรูปสลิปการโอน'}</span>
        </label>
      )}
      <button type="button" disabled={busy || (!free && !slip)} onClick={() => void accept()}
        className="rounded-btn bg-cta px-5 py-3.5 text-[15px] font-bold text-white shadow-cta disabled:opacity-50">{busy && (free || slip) ? 'กำลังส่ง…' : free ? '✓ รับใบพรีนี้' : 'ส่งสลิป · แจ้งคนส่ง + ร้าน'}</button>
      <button type="button" disabled={busy} onClick={() => void decline()} className="text-[12px] text-ink-faint underline">ไม่รับข้อเสนอ{free ? '' : ' (ยังไม่ได้โอน)'}</button>
      {lineOa && <a href={`https://line.me/R/ti/p/${encodeURIComponent(lineOa)}`} target="_blank" rel="noreferrer" className="text-center text-[12px] text-ink-faint underline">ติดปัญหา? ติดต่อร้าน (LINE {lineOa})</a>}
    </div>
  );
}

// ── ผู้ซื้อที่จองอยู่ (กระดาน): QR คนขาย + แนบสลิป ────────────────────────────────
function PayPanel({ tr, price, due, serverNow, now, flash, reload }: {
  tr: TicketTransfer; price: number; due: number; serverNow: () => number; now: number; flash: Flash; reload: () => Promise<void>;
}) {
  const [payout, setPayout] = useState<mk.MarketRes | null>(null);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void mk.marketPayout(tr.id).then(setPayout); }, [tr.id]);
  void now; // re-render ทุกวินาทีให้นาฬิกาเดิน
  const left = tr.hold_until ? new Date(tr.hold_until).getTime() - serverNow() : 0;
  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'mkslip')); } catch { flash('อัปโหลดสลิปไม่สำเร็จ ลองใหม่อีกครั้ง'); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!slip || busy) return;
    setBusy(true);
    const r = await mk.marketPay(tr.id, slip);
    setBusy(false);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    void mk.marketPush(tr.id, 'paid');
    notifyAdminLine(`🎟️ ตลาดใบพรี: ผู้ซื้อโอน ${baht(price)} ให้คนขายแล้ว (รอคนขายยืนยัน) · ดีล ${tr.id}`);
    flash('ส่งสลิปแล้ว · แจ้งคนขายให้เช็คเงินแล้ว');
  };
  const release = async () => {
    const r = await mk.marketRelease(tr.id);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    flash('ปล่อยการจองแล้ว');
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-2xl border border-[#fbbf24]/30 bg-[#fbbf24]/[0.08] px-3.5 py-3">
        <HoldRing msLeft={left} total={MARKET.holdMin * 60_000}>{mmss(left)}</HoldRing>
        <div className="text-[12px] leading-relaxed text-ink-muted2">
          <b className="block text-[13.5px] text-[#fbbf24]">จองไว้ให้คุณแล้ว</b>
          โอนตามยอดแล้วแนบสลิปภายในเวลา ไม่งั้นใบนี้กลับขึ้นกระดาน{left <= 0 ? ' · หมดเวลาแล้ว — ถ้าโอนไปแล้วรีบแนบสลิป' : ''}
        </div>
      </div>
      <DealSteps at={1} />
      {payout?.ok ? (
        <PromptPayCard amount={price} promptpay={payout.promptpay} accountNo={payout.account_no} bank={payout.bank} accountName={payout.account_name} flash={flash} />
      ) : (
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5 text-center text-[12.5px] text-ink-muted2">{payout ? mk.marketErrText(payout) : 'กำลังโหลดบัญชีคนขาย…'}</div>
      )}
      <div className="text-center text-[11.5px] text-ink-faint">ส่วนต่าง {baht(due)} ไม่ต้องโอนตอนนี้ — จ่ายร้านตอนของถึงไทย</div>
      <label className={cx('flex cursor-pointer items-center gap-3 rounded-2xl border-[1.5px] border-dashed px-4 py-3.5', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.07]' : 'border-accent')}>
        <input type="file" accept="image/*" className="hidden" onChange={(e) => void onSlip(e.target.files?.[0])} />
        {slip ? <img src={slip} alt="สลิป" className="h-16 w-12 shrink-0 rounded-md object-cover" /> : <Icon name="camera" size={22} className="text-primary-soft" />}
        <span className={cx('text-[13px] font-bold', slip ? 'text-[#4ade80]' : 'text-primary-soft')}>{busy && !slip ? 'กำลังอัปโหลด…' : slip ? 'แนบสลิปแล้ว ✓ · แตะเพื่อเปลี่ยน' : 'แตะแนบรูปสลิปการโอน'}</span>
      </label>
      <button type="button" disabled={!slip || busy} onClick={() => void send()}
        className="rounded-btn bg-cta px-5 py-3.5 text-[15px] font-bold text-white shadow-cta disabled:opacity-50">{busy && slip ? 'กำลังส่ง…' : 'ส่งสลิป · แจ้งคนขาย + ร้าน'}</button>
      <button type="button" onClick={() => void release()} className="text-[12px] text-ink-faint underline">ยกเลิกการจอง (ยังไม่ได้โอน)</button>
    </div>
  );
}

// ── ผู้ซื้อ/ผู้รับ หลังโอน: ติดตาม ───────────────────────────────────────────────────
function BuyerTrack({ tr, st, price, due, now, flash, reload, lineOa }: {
  tr: TicketTransfer; st: string; price: number; due: number; now: number; flash: Flash; reload: () => Promise<void>; lineOa?: string;
}) {
  const direct = isDirect(tr);
  const free = direct && price <= 0;
  const sender = direct ? 'คนส่ง' : 'คนขาย';
  const [lateSlip, setLateSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const at = st === 'paid' || st === 'reviewing' ? 2 : st === 'seller_ok' || st === 'pending_admin' ? 3 : st === 'done' || st === 'approved' ? 4 : 1;
  const slaLeft = sellerSlaLeft(tr, new Date(now));
  const escalate = async () => {
    const r = await mk.marketEscalate(tr.id, `${sender}ยังไม่ยืนยันเกิน 12 ชม.`);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    void mk.marketPush(tr.id, 'reviewing');
    notifyAdminLine(`🔎 ${direct ? '[เปลี่ยนใบพรี]' : 'ตลาดใบพรี:'} ผู้ซื้อขอให้ตรวจสอบ (${sender}เงียบเกิน 12 ชม.) · ดีล ${tr.id}`);
    flash('ส่งเรื่องให้ร้านตรวจสอบแล้ว');
  };
  if (st === 'done' || st === 'approved') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-[22px] font-extrabold motion-safe:animate-riseIn">🎉 ใบพรีเข้ากระเป๋าแล้ว!</div>
        <div className="w-full max-w-[300px] rounded-[18px] border border-accent-soft bg-surface-2 px-4 py-4 motion-safe:animate-dropIn">
          <div className="font-mono text-[14px] tracking-wider text-primary-soft motion-safe:animate-stampIn">{tr.new_ticket_no}</div>
          <div className="mt-1.5 inline-block rounded-full border border-[#c4b5fd]/40 bg-[#c4b5fd]/10 px-2.5 py-0.5 text-[11px] font-bold text-[#c4b5fd]">{direct ? '🔁 ได้มาจากการเปลี่ยนใบ' : '🔁 ได้มาจากตลาด'}</div>
        </div>
        <div className="w-full rounded-2xl border border-subtle bg-surface-2 p-3.5 text-left text-[12.5px] text-ink-muted2">
          ต่อจากนี้เหมือนใบพรีปกติ: ของถึงไทย → จ่ายส่วนต่าง {baht(due)} → เลือกวิธีรับของ
        </div>
        {tr.new_ticket_no && <Link href={`/wallet/${encodeURIComponent(tr.new_ticket_no)}`} className="w-full rounded-btn bg-cta px-5 py-3.5 text-[15px] font-bold text-white shadow-cta">ดูใบพรี</Link>}
      </div>
    );
  }
  if (st === 'cancelled' || st === 'expired') {
    // ดีลตรงที่มีเงิน ปิดไปก่อนผู้รับแนบสลิป: ถ้าโอนไปแล้ว แนบสลิปแจ้งร้านได้ (v75 เก็บเป็นหลักฐาน · audit รอบ B R1-01)
    const canReport = direct && !free && !tr.paid_at;
    const sendLate = async () => {
      if (!lateSlip || busy) return;
      setBusy(true);
      const r = await mk.marketPay(tr.id, lateSlip);
      setBusy(false);
      if (r.recorded) { await reportLateSlip(tr, price, r, flash, reload); return; }
      flash(mk.marketErrText(r));
    };
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-2xl border border-subtle bg-surface-2 p-4 text-[13px] leading-relaxed text-ink-muted2">
          <b className="text-ink">{direct ? dealStatusLabel(tr, st as TicketTransfer['status']) : `ดีลนี้${TRANSFER_STATUS_LABEL[st as TicketTransfer['status']]}`}</b>
          {tr.paid_at && price > 0 && <div className="mt-1">คุณโอนไปแล้ว {baht(price)} — ร้านได้รับสลิปแล้ว แอดมินจะติดต่อให้{sender}คืนเงินพร้อมสลิปคืน</div>}
          {tr.cancel_reason && !['buyer_declined', 'seller'].includes(tr.cancel_reason) && <div className="mt-1 text-[12px] text-ink-faint">เหตุผล: {tr.cancel_reason === 'ticket_changed' ? 'ตั๋วเปลี่ยนไประหว่างดีล' : tr.cancel_reason.replace(/^admin: /, '')}</div>}
        </div>
        {canReport && (
          <div className="rounded-2xl border border-[#fbbf24]/35 bg-[#fbbf24]/[0.06] p-3.5">
            <div className="text-[13px] font-bold">โอนเงินไปแล้วใช่ไหม?</div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">แนบสลิปให้ร้านเก็บเป็นหลักฐาน — แอดมินจะติดต่อ{sender}ให้คืนเงิน (ดีลนี้ไม่เปิดใหม่)</div>
            <label className={cx('mt-2 flex cursor-pointer items-center gap-3 rounded-xl border-[1.5px] border-dashed px-3 py-2.5', lateSlip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.07]' : 'border-accent')}>
              <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { setLateSlip(await uploadImage(f, 'mkslip')); } catch { flash('อัปโหลดสลิปไม่สำเร็จ'); } finally { setBusy(false); } }} />
              <Icon name="camera" size={18} className="text-primary-soft" />
              <span className="text-[12.5px] font-bold text-primary-soft">{lateSlip ? 'แนบสลิปแล้ว ✓' : busy ? 'กำลังอัปโหลด…' : 'แนบสลิปการโอน'}</span>
            </label>
            <button type="button" disabled={!lateSlip || busy} onClick={() => void sendLate()} className="mt-2 w-full rounded-btn bg-cta py-2.5 text-[13.5px] font-bold text-white disabled:opacity-50">ส่งสลิปให้ร้าน</button>
          </div>
        )}
        {lineOa && <a href={`https://line.me/R/ti/p/${encodeURIComponent(lineOa)}`} target="_blank" rel="noreferrer" className="text-center text-[12px] text-ink-faint underline">ติดต่อร้าน (LINE {lineOa})</a>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <DealSteps at={at as 1 | 2 | 3} labels={direct ? (free ? FREE_STEPS : DIRECT_STEPS) : undefined} />
      <div className={cx('rounded-2xl border px-4 py-3 text-[13px] leading-relaxed', st === 'reviewing' ? 'border-[#60a5fa]/35 bg-[#2563eb]/10 text-[#bcd3f5]' : 'border-subtle bg-surface-2 text-ink-muted2')}>
        {st === 'paid' && <>{free ? 'กดรับแล้ว' : 'ส่งสลิปแล้ว'} {fmt(tr.paid_at)} · <b className="text-ink">{free ? `รอ${sender}ยืนยัน` : `รอ${sender}เช็คเงินเข้า`}</b>{Number.isFinite(slaLeft) && (slaLeft > 0 ? ` (ภายใน ${Math.ceil(slaLeft / 3_600_000)} ชม.)` : ` · เกินเวลาที่${sender}ต้องตอบแล้ว`)}</>}
        {st === 'seller_ok' && <><b className="text-ink">{sender}ยืนยันแล้ว ✓</b> · รอร้านโอนสิทธิ์เข้ากระเป๋าคุณ</>}
        {st === 'reviewing' && <><b>ร้านกำลังตรวจสอบดีลนี้</b> · แอดมินจะติดต่อ{sender}และอาจขอหลักฐานการโอนจากคุณ</>}
      </div>
      {st === 'paid' && slaLeft <= 0 && (
        <button type="button" onClick={() => void escalate()} className="rounded-btn border-[1.5px] border-accent px-5 py-3 text-[14px] font-bold text-primary-soft">แจ้งร้านให้ตรวจสอบ</button>
      )}
      {st === 'paid' && slaLeft > 0 && !free && (
        <button type="button" onClick={() => { void mk.marketPush(tr.id, 'remind'); flash(`ส่งแจ้งเตือนหา${sender}แล้ว`); }} className="text-[12px] text-ink-faint underline">เตือน{sender}อีกครั้ง</button>
      )}
      {lineOa && <a href={`https://line.me/R/ti/p/${encodeURIComponent(lineOa)}`} target="_blank" rel="noreferrer" className="text-center text-[12px] text-ink-faint underline">ติดต่อร้าน (LINE {lineOa})</a>}
    </div>
  );
}

// ── คนขาย / คนส่ง ─────────────────────────────────────────────────────────────────
function SellerPanel({ db, tr, st, price, due, now, flash, reload, ticketNo }: {
  db: Database; tr: TicketTransfer; st: string; price: number; due: number; now: number; flash: Flash; reload: () => Promise<void>; ticketNo?: string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const direct = isDirect(tr);
  const free = direct && price <= 0;
  // บัญชีที่ล็อกกับดีลนี้ = เงินต้องเข้าบัญชีไหน (audit รอบ C R1-49 · v76 คนส่ง/คนขายอ่านของดีลตัวเองได้)
  const [myPayout, setMyPayout] = useState<mk.MarketRes | null>(null);
  useEffect(() => { if (!free) void mk.marketPayout(tr.id).then(setMyPayout); }, [tr.id, free]);
  const run = async (fn: () => Promise<mk.MarketRes>, ok: string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { flash(mk.marketErrText(r)); return; }
    await reload();
    after?.();
    flash(ok);
  };
  const holdLeft = st === 'reserved' && tr.hold_until ? new Date(tr.hold_until).getTime() - now : 0;
  const daysLeft = tr.expires_at ? Math.max(0, Math.ceil((new Date(tr.expires_at).getTime() - now) / 86_400_000)) : null;
  const slaLeft = sellerSlaLeft(tr, new Date(now));

  if (direct && st === 'reserved') {
    return (
      <div className="flex flex-col gap-3">
        <MoneySplit price={price} due={due} />
        <div className="flex items-center gap-3 rounded-2xl border border-[#f1d27a]/35 bg-[#f1d27a]/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted2">
          <HoldRing msLeft={holdLeft} total={MARKET.offerHours * 3_600_000} size={40} stroke={4} />
          <div>
            <b className="text-[#f1d27a]">ส่งข้อเสนอให้ {whoMask(db, tr.to_user_id)} แล้ว</b> · เขามีเวลา <b className="font-mono text-ink">{leftLabel(holdLeft)}</b> {free ? 'กดรับ' : 'โอน + แนบสลิป'}<br />
            ใบนี้ถูกล็อก 🔒 จนกว่าเขาจะรับ/ไม่รับ{tr.payout_viewed_at ? '' : ' หรือคุณถอนข้อเสนอ'}
          </div>
        </div>
        {tr.payout_viewed_at ? (
          // ผู้รับเปิดหน้าโอนเงินแล้ว = อาจกำลังโอน → ถอนเองไม่ได้ (v75 · audit รอบ B R1-01) ต้องให้ร้านยกเลิก
          <div className="rounded-xl border border-subtle bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-muted2">
            ผู้รับเปิดหน้าโอนเงินแล้ว {fmt(tr.payout_viewed_at)} · <b className="text-ink">ถอนข้อเสนอเองไม่ได้</b> (กันผู้รับโอนแล้วเสียเงิน) — ถ้าจำเป็นให้ติดต่อร้านยกเลิก
          </div>
        ) : (
          <button type="button" disabled={busy}
            onClick={() => { if (window.confirm('ถอนข้อเสนอนี้? ผู้รับจะเห็นว่าถูกถอน และใบพรีปลดล็อก')) void run(() => mk.marketCancel(tr.id), 'ถอนข้อเสนอแล้ว · ใบพรีปลดล็อกแล้ว', () => { void mk.marketPush(tr.id, 'withdrawn'); }); }}
            className="rounded-btn border border-subtle bg-surface-3 px-5 py-3 text-[14px] font-bold text-ink-muted2">ถอนข้อเสนอ</button>
        )}
      </div>
    );
  }
  if (st === 'listed' || st === 'reserved') {
    return (
      <div className="flex flex-col gap-3">
        <MoneySplit price={price} due={due} />
        <div className="rounded-2xl border border-subtle bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted2">
          <b className="text-ink">ลงขายอยู่</b>{daysLeft != null ? ` · เหลือ ${daysLeft} วันก่อนหมดอายุ` : ''}<br />
          ใบนี้ถูกล็อก 🔒 จ่ายส่วนต่าง/เลือกวิธีรับของไม่ได้จนกว่าจะขายหรือถอนประกาศ
        </div>
        {st === 'reserved' ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-3 py-3 text-[12.5px] text-[#fbbf24]">
            <HoldRing msLeft={holdLeft} total={MARKET.holdMin * 60_000} size={24} stroke={3} />มีคนกำลังจอง <b className="font-mono">{mmss(holdLeft)}</b> · ระหว่างนี้ถอนประกาศไม่ได้
          </div>
        ) : (
          <button type="button" disabled={busy} onClick={() => void run(() => mk.marketCancel(tr.id), 'ถอนประกาศแล้ว · ใบพรีปลดล็อกแล้ว')}
            className="rounded-btn border border-subtle bg-surface-3 px-5 py-3 text-[14px] font-bold text-ink-muted2">ถอนประกาศ</button>
        )}
      </div>
    );
  }
  if (st === 'paid' || (st === 'reviewing' && tr.review_reason === 'seller_silent')) {
    const confirmBtn = (
      <button type="button" disabled={busy} onClick={() => void run(() => mk.marketSellerConfirm(tr.id), 'ยืนยันแล้ว · ส่งให้ร้านโอนสิทธิ์',
        () => { void mk.marketPush(tr.id, 'seller_ok'); notifyAdminLine(`✅ ${direct ? '[เปลี่ยนใบพรี]' : 'ตลาดใบพรี:'} ${free ? 'คนส่งยืนยันยกให้แล้ว' : `คนขายยืนยันรับเงิน ${baht(price)} แล้ว`} — รอไฟนอล · ดีล ${tr.id}`); })}
        className="rounded-btn bg-success px-5 py-3.5 text-[15px] font-bold text-white disabled:opacity-50">{free ? '✓ ยืนยัน ส่งให้ร้านโอนสิทธิ์' : '✓ ได้รับเงินแล้ว'}</button>
    );
    if (free) {
      return (
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl border border-[#16a34a]/35 bg-surface-2 p-3.5 text-[13px] leading-relaxed text-ink-muted2">
            <b className="text-ink">{whoMask(db, tr.to_user_id)} กดรับใบพรีแล้ว</b> · {fmt(tr.paid_at)}<br />กดยืนยัน — ร้านจะโอนสิทธิ์ให้เขาต่อ (ใบนี้จะออกจากกระเป๋าคุณ)
          </div>
          {confirmBtn}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-2xl border border-[#fbbf24]/35 bg-surface-2 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <b className="text-[13.5px]">{direct ? 'ผู้รับแนบสลิปแล้ว' : 'ผู้ซื้อแนบสลิปแล้ว'}</b>
            <span className="rounded-md bg-[#fbbf24]/10 px-2 py-0.5 font-mono text-[10.5px] font-bold text-[#fbbf24]">{Number.isFinite(slaLeft) && slaLeft > 0 ? `ตอบภายใน ${Math.ceil(slaLeft / 3_600_000)} ชม.` : 'เกินเวลา — ร้านตรวจสอบอยู่'}</span>
          </div>
          <div className="mt-2.5 flex items-center gap-3">
            {tr.slip_url && /^https?:\/\//i.test(tr.slip_url) && <a href={tr.slip_url} target="_blank" rel="noreferrer"><img src={tr.slip_url} alt="สลิป" className="h-24 w-[68px] rounded-lg bg-white object-cover" /></a>}
            <div><div className="text-[11px] text-ink-faint">ยอดที่ต้องเข้าบัญชีคุณ</div><div className="font-mono text-[24px] font-bold">{baht(price)}</div><div className="text-[11px] text-ink-faint">{fmt(tr.paid_at)}</div></div>
          </div>
          {myPayout?.ok && !myPayout.none && (
            <div className="mt-2.5 rounded-xl border border-subtle bg-surface-3 px-2.5 py-2 text-[12px]">
              <div className="mb-1 text-[11px] text-ink-faint">เช็คที่บัญชีนี้ (บัญชีที่ผู้{direct ? 'รับ' : 'ซื้อ'}เห็นตอนโอน)</div>
              <PayoutLine info={myPayout} full size={22} />
            </div>
          )}
          <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-[12px] text-ink-muted2">
            <li>เปิดแอปธนาคารของคุณ</li><li>ดูว่ามีเงินเข้า {baht(price)} จริง</li><li>กดยืนยัน — ร้านจะโอนสิทธิ์ให้{direct ? 'ผู้รับ' : 'ผู้ซื้อ'}ต่อ</li>
          </ol>
        </div>
        {confirmBtn}
        {st === 'paid' && !rejecting && (
          <button type="button" onClick={() => setRejecting(true)} className="rounded-btn border border-subtle bg-surface-3 px-5 py-3 text-[13.5px] font-bold text-ink-muted2">ยังไม่ได้รับเงิน…</button>
        )}
        {rejecting && (
          <div className="rounded-2xl border border-subtle bg-surface-2 p-3.5">
            <div className="text-[13px] font-bold">แจ้งร้านว่ายังไม่ได้รับเงิน</div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">แนบรูปหน้ารายการเงินเข้าช่วงเวลานั้น — แอดมินจะเทียบกับสลิปของ{direct ? 'ผู้รับ' : 'ผู้ซื้อ'}</div>
            <textarea id="mk-reject-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น เช็คแล้วไม่มีเงินเข้า 650 บาทตอน 14:05"
              className="mt-2 w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent" rows={2} />
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12.5px] font-bold text-primary-soft">
              <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setProof(await uploadImage(f, 'mkproof')); } catch { flash('อัปโหลดไม่สำเร็จ'); } }} />
              <Icon name="camera" size={16} />{proof ? 'แนบหลักฐานแล้ว ✓' : 'แนบรูปหน้ารายการเงินเข้า'}
            </label>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setRejecting(false)} className="flex-1 rounded-btn border border-subtle bg-surface-3 py-2.5 text-[13px] font-bold text-ink-muted2">ยกเลิก</button>
              <button type="button" disabled={busy || !note.trim()} onClick={() => void run(() => mk.marketSellerReject(tr.id, note.trim(), proof ? [proof] : []), 'ส่งเรื่องให้ร้านตรวจสอบแล้ว',
                () => { void mk.marketPush(tr.id, 'reviewing'); notifyAdminLine(`🔎 ${direct ? '[เปลี่ยนใบพรี]' : 'ตลาดใบพรี:'} คนขายแจ้งยังไม่ได้รับเงิน ${baht(price)} · ดีล ${tr.id}`); })}
                className="flex-1 rounded-btn bg-cta py-2.5 text-[13px] font-bold text-white disabled:opacity-50">ส่งให้ร้านตรวจสอบ</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  const msg: Record<string, string> = {
    reviewing: 'ร้านกำลังตรวจสอบดีลนี้ — แอดมินจะติดต่อคุณ',
    seller_ok: `คุณยืนยัน${free ? 'แล้ว' : 'รับเงินแล้ว'} ✓ · รอร้านโอนสิทธิ์ให้${direct ? 'ผู้รับ' : 'ผู้ซื้อ'}`,
    pending_admin: `คุณยืนยัน${free ? 'แล้ว' : 'รับเงินแล้ว'} ✓ · รอร้านโอนสิทธิ์ให้${direct ? 'ผู้รับ' : 'ผู้ซื้อ'}`,
    done: `${direct ? 'เปลี่ยนใบสำเร็จ' : 'ขายสำเร็จ'} 🤝 · ${tr.prev_ticket_no ?? ''} → ${tr.new_ticket_no ?? ''}`,
    approved: `${direct ? 'เปลี่ยนใบสำเร็จ' : 'ขายสำเร็จ'} 🤝`,
    cancelled: direct ? `${dealStatusLabel(tr, 'cancelled')}${tr.cancel_reason?.startsWith('admin: ') ? ` (${tr.cancel_reason.replace(/^admin: /, '')})` : ''}` : `ประกาศถูกยกเลิก${tr.cancel_reason ? ` (${tr.cancel_reason.replace(/^admin: /, '')})` : ''}`,
    expired: direct ? 'ข้อเสนอหมดเวลา — ผู้รับไม่ได้ตอบใน 24 ชม. · ใบปลดล็อกแล้ว ส่งใหม่ได้จากหน้าใบพรี' : 'ประกาศหมดอายุ — ลงขายใหม่ได้จากหน้าใบพรี',
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-subtle bg-surface-2 px-4 py-3.5 text-[13px] text-ink-muted2">{msg[st] ?? dealStatusLabel(tr, st as TicketTransfer['status'])}</div>
      {/* ผู้รับแนบสลิปหลังดีลปิด (v75) — คนส่งต้องรู้ว่ามีเงินเข้าบัญชีตัวเอง และต้องคืน */}
      {(st === 'expired' || st === 'cancelled') && tr.paid_at && price > 0 && (
        <div className="rounded-2xl border border-[#fbbf24]/40 bg-[#fbbf24]/[0.08] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          ⚠️ ผู้รับแจ้งว่าโอน {baht(price)} เข้าบัญชีคุณแล้ว ({fmt(tr.paid_at)}) แต่ดีลปิดไปก่อน — เช็คบัญชี แล้วคืนเงินผู้รับ · ร้านจะติดต่อคุณ
          {tr.slip_url && /^https?:\/\//.test(tr.slip_url) && <a href={tr.slip_url} target="_blank" rel="noreferrer" className="ml-1 underline">ดูสลิป</a>}
        </div>
      )}
      {(st === 'expired' || st === 'cancelled') && ticketNo && (
        <Link href={`/wallet/${encodeURIComponent(ticketNo)}`} className="rounded-btn border border-accent px-5 py-3 text-center text-[14px] font-bold text-primary-soft">ไปที่ใบพรี {ticketNo}</Link>
      )}
    </div>
  );
}
