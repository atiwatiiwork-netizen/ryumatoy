'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId, useAuth } from '@/state/AuthProvider';
import { store } from '@/data/store';
import {
  placeBidLocal, buyNowLocal, toggleAuctionWatch, submitAuctionEntry,
} from '@/data/mutations';
import * as rpc from '@/lib/auction';
import { pushEnabled, sendAuctionPush, pushSupported, currentPushSubscription, enablePush } from '@/lib/push';
import {
  AUCTION_STATUS_TH, BID_REJECT_TH, bidRight, checkBid, extendCapped, inSnipeWindow, isLive,
  isRoundAmount, minNextBid, pendingEntry, stepBands, timeLeftLabel,
} from '@/domain/services/auctions';
import { productLabel } from '@/domain/services/catalog';
import { baht } from '@/lib/theme';
import type { Auction, AuctionBidRow } from '@/domain/entities';
import { StockCondCard } from './StockCond';
import { AuctionCondCard } from './AuctionCond';
import { Button, Card, cx } from './ui';
import { Icon } from './Icon';

/**
 * ห้องประมูล — **คอมโพเนนต์เดียวใช้ทั้งฝั่งลูกค้าและหน้าพรีวิวในแอดมิน**
 * (เจ้าของ 2026-07-31: "ในแอดมินทำแท็บประมูล โดยเห็นหน้าตาเดียวกับฝั่งผู้ใช้เลย เพื่อลองเล่นดูก่อน")
 * ถ้าแยกโค้ดสองชุด สิ่งที่แอดมินทดลองจะไม่ใช่สิ่งที่ลูกค้าเห็นจริง — ห้ามแยก
 *
 * แหล่งความจริงของ ราคา/เวลาปิด = **server** (`ryuma_auction_state` ทุก 4 วิ). ถ้ายังไม่ได้รัน
 * migration v60 จะสลับเป็น "โหมดทดลอง" ที่คิดในเครื่อง เพื่อให้กดเล่นดูหน้าตาได้ก่อน
 */

const POLL_MS = 4000;

type Live = { price: number; bidCount: number; endsAt: string; status: string; nextMin: number; leading: boolean; skewMs: number };

export function AuctionRoom({ auctionId, embedded }: { auctionId: string; embedded?: boolean }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const { isAdmin } = useAuth();
  const cart = useCart();
  const router = useRouter();

  const auction = db.auctions.find((a) => a.id === auctionId);
  const bands = stepBands(db);

  // ── สถานะสดจาก server (ถ้ามี) ────────────────────────────────────────────
  const [live, setLive] = useState<Live | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [bids, setBids] = useState<AuctionBidRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0); // เดินนาฬิกาถอยหลังทุกวินาที (ค่าไม่ได้ใช้ ใช้แค่ให้ re-render)
  const [custom, setCustom] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pullSeq = useRef(0);

  const pull = useCallback(async () => {
    // ตัวกันคำตอบสลับลำดับ: บนเน็ตช้า คำขอที่ยิงก่อนอาจกลับมาทีหลัง แล้วเขียนราคาเก่าทับราคาใหม่
    // (เห็นชัดช่วงท้ายที่ราคาขยับทุกไม่กี่วินาที) — รับเฉพาะคำตอบของคำขอล่าสุดเท่านั้น
    const seq = ++pullSeq.current;
    const mine = auctionId;
    const s = await rpc.auctionState(auctionId);
    if (seq !== pullSeq.current || mine !== auctionId) return;
    if (rpc.isNoServer(s)) { setTestMode(true); return; }
    if (!s.ok) return;
    setTestMode(false);
    setLive({
      price: s.price ?? 0, bidCount: s.bid_count ?? 0, endsAt: s.ends_at ?? '',
      status: s.status ?? 'live', nextMin: s.next_min ?? 0, leading: !!s.leading,
      // นาฬิกาเครื่องลูกค้าเชื่อไม่ได้ — จับส่วนต่างกับเวลา server ไว้ใช้กับตัวนับถอยหลัง
      skewMs: s.server_now ? new Date(s.server_now).getTime() - Date.now() : 0,
    });
    const list = await rpc.auctionBids(auctionId);
    if (seq !== pullSeq.current) return;
    if (list) setBids(list);
  }, [auctionId]);

  // เปลี่ยนห้อง = ล้างข้อมูลห้องเก่าทิ้งทันที ไม่งั้นราคา/นาฬิกา/ประวัติของห้องก่อนหน้าค้างทับห้องใหม่
  useEffect(() => { setLive(null); setBids(null); setCustom(''); }, [auctionId]);

  useEffect(() => {
    void pull();
    pollRef.current = setInterval(() => { if (document.visibilityState === 'visible') void pull(); }, POLL_MS);
    // กลับมาที่แท็บ = ดึงทันที ไม่ต้องรอครบรอบ (ราคาช่วงท้ายขยับเร็วกว่านั้นมาก)
    const onVisible = () => { if (document.visibilityState === 'visible') void pull(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pull]);

  // ตัวนับถอยหลังเดินทุกวินาที (คนละเรื่องกับการดึงข้อมูล)
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  if (!auction) return <Card><div className="p-4 text-sm text-ink-muted">ไม่พบห้องประมูลนี้</div></Card>;

  // ── ค่าที่ใช้แสดงผล: server ก่อนเสมอ, ไม่มีค่อยใช้ของในเครื่อง ─────────────
  const view: Auction = live
    ? { ...auction, current_price: live.price, bid_count: live.bidCount, ends_at: live.endsAt || auction.ends_at, status: live.status as Auction['status'] }
    : auction;
  const now = new Date(Date.now() + (live?.skewMs ?? 0));
  const msLeft = new Date(view.ends_at).getTime() - now.getTime();
  const running = isLive(view, now);
  /** หมดเวลาแล้วแต่สถานะยังเป็น live = ยังไม่มีใครกดสรุปผล (ระบบไม่มีตัวปิดอัตโนมัติ) */
  const awaitingResult = view.status === 'live' && !running;
  const nextMin = live?.nextMin || minNextBid(view, bands);
  // ปุ่มบวกสำเร็จรูป +20/+50/+100 (เจ้าของ 2026-08-03) — ปัดขึ้นให้ลงท้าย 0 และไม่ต่ำกว่าขั้นต่ำจริง
  // ยุบตัวซ้ำทิ้ง: บิดแรก (ขั้นต่ำ = ราคาเปิด) หรือราคาสูงจนขั้นบันได > 100 จะเหลือปุ่มเดียว
  const ceil10 = (n: number) => Math.ceil(n / 10) * 10;
  const quickBids = (() => {
    const seen = new Set<number>();
    const out: { label: string; amount: number }[] = [];
    for (const plus of [20, 50, 100]) {
      const amount = Math.max(nextMin, ceil10(view.current_price + plus));
      if (seen.has(amount)) continue;
      seen.add(amount);
      out.push({ label: amount === nextMin && view.bid_count === 0 ? 'ราคาเปิด' : `+${plus}`, amount });
    }
    // เหลือใบเดียว = ไม่ต้องบอก "+20" ให้งง บอกตรงๆ ว่านี่คือขั้นต่ำ
    if (out.length === 1 && out[0].label !== 'ราคาเปิด') out[0] = { label: 'ขั้นต่ำ', amount: out[0].amount };
    return out;
  })();
  /** ใส่เองต้องอย่างน้อย +100 (เจ้าของสั่ง) — ต่ำกว่านั้นใช้ปุ่มด้านบนแทน */
  const customMin = Math.max(nextMin, ceil10(view.current_price + 100));
  // ตรวจยอดที่พิมพ์เองตั้งแต่ยังพิมพ์ไม่เสร็จ (ไม่ต้องรอให้กดแล้วเด้ง toast)
  const customErr: 'too_low' | 'not_round' | null = !custom ? null
    : !isRoundAmount(Number(custom)) ? 'not_round'
    : Number(custom) < customMin ? 'too_low' : null;

  const product = auction.product_id ? db.products.find((p) => p.id === auction.product_id) : undefined;
  const maker = product ? db.manufacturers.find((m) => m.id === product.manufacturer_id) : undefined;
  const images = auction.images.length ? auction.images : (product?.images ?? []);

  // ── สิทธิ์เข้าประมูล ─────────────────────────────────────────────────────
  const right = uid ? bidRight(db, uid) : ({ ok: false, reason: 'no_right' } as const);
  const waitingEntry = uid ? pendingEntry(db, uid) : undefined;
  // "คุณเป็นผู้นำ" — server บอกตรงๆ ถ้ามี; โหมดทดลองดูจากบิดในเครื่อง (ไม่งั้นป้ายไม่เคยขึ้นเลยตอนลองเล่น)
  const myTopAmount = bids
    ? bids.find((b) => b.mine && b.status === 'active')?.amount
    : db.auctionBids.filter((b) => b.auction_id === auctionId && b.user_id === uid && b.status === 'active')
        .reduce((m, b) => Math.max(m, b.amount), 0) || undefined;
  const leading = live ? live.leading : myTopAmount != null && myTopAmount === view.current_price;

  // ── ยิงบิด ───────────────────────────────────────────────────────────────
  async function bid(amount: number) {
    if (!uid) { flash('ต้องเข้าสู่ระบบก่อน'); return; }
    const local = checkBid(view, amount, now, bands);
    if (local) { flash(BID_REJECT_TH[local]); return; }
    if (!right.ok) { flash(BID_REJECT_TH[right.reason]); return; }
    setBusy(true);
    try {
      const res = await rpc.placeBid(auctionId, amount);
      if (rpc.isNoServer(res)) {
        // โหมดทดลอง: ยังไม่ได้รัน v60 — คิดในเครื่องเพื่อให้ลองเล่นได้
        dispatch(placeBidLocal(auctionId, uid, amount));
        flash(`บิด ${baht(amount)} แล้ว (โหมดทดลอง)`);
      } else if (res.ok) {
        flash(res.extended ? `บิด ${baht(amount)} · ต่อเวลาอีก ${view.extend_min} นาที` : `บิด ${baht(amount)} แล้ว`);
        // แจ้งคนที่โดนแซง (ทันที) + คนกดกระดิ่ง (เซิร์ฟเวอร์หรี่ให้ไม่ถี่กว่า 5 นาที)
        // fire-and-forget: push ล้มเหลวห้ามทำให้การบิดที่สำเร็จแล้วดูเหมือนพัง
        if (pushEnabled(db, 'auction_outbid')) void sendAuctionPush(auctionId, 'outbid');
        if (pushEnabled(db, 'auction_price')) void sendAuctionPush(auctionId, 'price');
        await pull();
      } else {
        const key = (res.error ?? '') as keyof typeof BID_REJECT_TH;
        flash(BID_REJECT_TH[key] ?? `บิดไม่สำเร็จ (${res.error})`);
        await pull();
      }
    } finally { setBusy(false); setCustom(''); }
  }

  async function doBuyNow() {
    if (!uid || !view.buy_now_price) return;
    if (!right.ok) { flash(BID_REJECT_TH[right.reason]); return; }
    if (!confirm(`ซื้อเลยที่ ${baht(view.buy_now_price)} — ปิดประมูลทันทีและคุณเป็นผู้ชนะ`)) return;
    setBusy(true);
    try {
      const res = await rpc.buyNow(auctionId);
      if (rpc.isNoServer(res)) { dispatch(buyNowLocal(auctionId, uid)); flash('ซื้อเลยสำเร็จ (โหมดทดลอง)'); }
      else if (res.ok) { flash('ซื้อเลยสำเร็จ — รอแอดมินแจ้งยอดชำระ'); await pull(); }
      else flash(BID_REJECT_TH[(res.error ?? '') as keyof typeof BID_REJECT_TH] ?? `ไม่สำเร็จ (${res.error})`);
    } finally { setBusy(false); }
  }

  // ── ผู้ชนะกดจ่าย: โหลดเข้าตะกร้าแล้วไป /checkout ตัวเดิม (สลิป→อนุมัติ→ตั๋ว→จัดส่ง ใช้ท่อเดิมหมด)
  const iWon = !!uid && auction.winner_user_id === uid && ['ended', 'awarded', 'paid'].includes(auction.status);
  function payNow() {
    const pid = view.product_id;
    if (!pid) { flash('รายการนี้ไม่ได้ผูกกับสินค้าในระบบ — ทักแอดมินเพื่อชำระเงินครับ'); return; }
    if (!db.products.some((p) => p.id === pid)) { flash('สินค้าถูกนำออกจากระบบแล้ว — ทักแอดมินได้เลยครับ'); return; }
    if (cart.lines.length > 0 && !confirm('ตะกร้ามีสินค้าอยู่ — จะแทนที่ด้วยรายการที่ชนะประมูล?')) return;
    cart.clear();
    cart.add({
      productId: pid, auctionId: view.id, qty: 1,
      priceEach: view.winning_amount ?? 0, depositEach: view.winning_amount ?? 0,
    });
    router.push('/checkout');
  }

  async function askCancel(bidId: string) {
    const reason = prompt('บอกเหตุผลสั้นๆ ให้แอดมินหน่อยครับ (เช่น พิมพ์ยอดผิด)');
    if (!reason) return;
    const res = await rpc.requestBidCancel(bidId, reason);
    if (rpc.isNoServer(res)) { flash('โหมดทดลอง — ยังส่งคำขอจริงไม่ได้'); return; }
    flash(res.ok ? 'ส่งคำขอให้แอดมินแล้ว — รอแอดมินตรวจสอบ' : 'ส่งคำขอไม่สำเร็จ');
    if (res.ok) await pull();
  }

  const watching = !!uid && db.auctionWatch.some((w) => w.auction_id === auctionId && w.user_id === uid);

  /** เปิดกระดิ่ง = ติดตามห้องนี้ + เปิดสิทธิ์แจ้งเตือนของเครื่อง (ถ้ายังไม่เคยเปิด)
   *  ต้องเรียก enablePush จากปุ่มโดยตรง เพราะเบราว์เซอร์ยอมขอสิทธิ์เฉพาะตอนผู้ใช้กดเท่านั้น */
  async function turnOnBell() {
    if (!uid) { flash('เข้าสู่ระบบก่อนถึงจะกดกระดิ่งได้'); return; }
    dispatch(toggleAuctionWatch(auctionId, uid));
    try {
      if (pushSupported() && !(await currentPushSubscription())) {
        await enablePush(uid, dispatch);
        flash('เปิดกระดิ่งแล้ว — จะเด้งเตือนเมื่อราคาขยับ');
        return;
      }
    } catch {
      // ปฏิเสธสิทธิ์/ยังไม่ได้ลงจอ (iOS) — ยังติดตามห้องไว้ได้ แต่ต้องบอกความจริงว่าเครื่องจะไม่เด้ง
      flash('ติดตามห้องนี้แล้ว — แต่เครื่องยังไม่อนุญาตแจ้งเตือน เปิดได้ที่หน้าโปรไฟล์');
      return;
    }
    flash('เปิดกระดิ่งแล้ว — จะแจ้งเตือนเมื่อราคาขยับ');
  }
  const historyRows: { key: string; amount: number; at: string; label: string; mine: boolean; void: boolean }[] =
    bids
      ? bids.map((b) => ({ key: b.id, amount: b.amount, at: b.created_at, mine: b.mine, void: b.status === 'void',
          label: b.name ? `${b.name}${b.member_code ? ` (${b.member_code})` : ''}` : `ผู้ประมูล #${b.seq}` }))
      : db.auctionBids.filter((b) => b.auction_id === auctionId)
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((b, _i, arr) => {
            const seq = [...new Set(arr.map((x) => x.user_id).reverse())].indexOf(b.user_id) + 1;
            const u = db.users.find((x) => x.id === b.user_id);
            return { key: b.id, amount: b.amount, at: b.created_at, mine: b.user_id === uid, void: b.status === 'void',
              label: isAdmin ? `${u?.display_name ?? '?'}${u?.member_code ? ` (${u.member_code})` : ''}` : `ผู้ประมูล #${seq}` };
          });

  return (
    <div className={cx('flex flex-col gap-3', embedded && 'mx-auto max-w-[430px]')}>
      {testMode && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-2 text-[12px] font-semibold text-[#fbbf24]">
          โหมดทดลอง — ยังไม่ได้รัน <code>migration_auction_v60.sql</code> ราคาที่บิดยังคิดในเครื่อง ยังไม่ใช่ของจริง
        </div>
      )}

      {/* รูป */}
      <Card>
        <div className="relative aspect-square w-full overflow-hidden rounded-t-2xl bg-surface-3">
          {images[0]
            ? <img src={images[0]} alt={auction.title} className="h-full w-full object-cover" />
            : <div className="grid h-full place-items-center text-sm text-ink-faint">ยังไม่มีรูป</div>}
          <div className="absolute left-3 top-3 flex gap-1.5">
            <span className={cx('rounded-full px-2.5 py-1 text-[11px] font-extrabold',
              running ? 'bg-primary text-white' : awaitingResult ? 'bg-[#fbbf24] text-black' : 'bg-surface-4 text-ink-muted')}>
              {running ? 'กำลังประมูล' : awaitingResult ? 'หมดเวลา · รอประกาศผล' : AUCTION_STATUS_TH[view.status]}
            </span>
            {running && inSnipeWindow(view, now) && (
              <span className="rounded-full bg-[#fbbf24] px-2.5 py-1 text-[11px] font-extrabold text-black">
                {extendCapped(view) ? 'ชนเพดานต่อเวลาแล้ว' : `บิดตอนนี้ต่อเวลา +${auction.extend_min} นาที`}
              </span>
            )}
          </div>
        </div>
        {images.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto p-2.5">
            {images.slice(1, 8).map((src) => (
              <img key={src} src={src} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1 px-3.5 pb-3.5 pt-3">
          <div className="text-[17px] font-extrabold leading-snug">{auction.title}</div>
          {/* productLabel มีชื่อค่ายต่อท้ายอยู่แล้ว — ใส่ maker ซ้ำจะได้ "Bandai · Zoro - Bandai" */}
          <div className="text-[12.5px] text-ink-muted">
            {product ? productLabel(db, product.id) : (maker?.name ?? '')}
          </div>
        </div>
      </Card>

      {/* ราคา + เวลา */}
      <Card>
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11.5px] font-semibold text-ink-faint">ราคาปัจจุบัน</div>
              <div className="text-[30px] font-extrabold leading-none text-primary-bright">
                {view.bid_count === 0 ? baht(auction.start_price) : baht(view.current_price)}
              </div>
              <div className="mt-1 text-[11.5px] text-ink-muted">
                {view.bid_count === 0 ? 'ราคาเปิด · ยังไม่มีใครบิด' : `บิดแล้ว ${view.bid_count} ครั้ง`}
                {view.extend_count > 0 && ` · ต่อเวลาแล้ว ${view.extend_count} รอบ`}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11.5px] font-semibold text-ink-faint">{running ? 'เหลือเวลา' : 'ปิดเมื่อ'}</div>
              <div className={cx('text-[22px] font-extrabold leading-none tabular-nums',
                running && msLeft < 5 * 60_000 ? 'text-primary-bright' : 'text-ink')}>
                {running ? timeLeftLabel(msLeft) : '—'}
              </div>
              <div className="mt-1 text-[11px] text-ink-faint">
                {new Date(view.ends_at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} น.
              </div>
            </div>
          </div>

          {leading && running && (
            <div className="rounded-lg bg-[#16a34a]/15 px-3 py-1.5 text-[12.5px] font-bold text-[#4ade80]">
              คุณเป็นผู้นำอยู่ตอนนี้
            </div>
          )}

          {running && (
            <>
              {right.ok ? (
                <div className="flex flex-col gap-2">
                  {/* ปุ่มบวกสำเร็จรูป (เจ้าของ 2026-08-03): +20 / +50 / +100 จากราคาปัจจุบัน
                      ทุกปุ่มถูกดันขึ้นให้ถึงขั้นต่ำจริงเสมอ — ที่ราคาสูงขั้นบันไดโตกว่า 100 ปุ่มจะยุบเหลือใบเดียว
                      (บิดแรกของห้องก็ยุบเหลือใบเดียว = ราคาเปิดพอดี) กดแล้วบิดทันที ไม่ต้องพิมพ์ */}
                  <div className="flex gap-2">
                    {quickBids.map((q) => (
                      <Button key={q.amount} className="flex-1 flex-col !gap-0 !py-2.5" disabled={busy} onClick={() => void bid(q.amount)}>
                        <span className="text-[11px] font-bold opacity-80">{q.label}</span>
                        <span className="text-[15px] font-extrabold leading-tight">{baht(q.amount)}</span>
                      </Button>
                    ))}
                  </div>
                  {!!auction.buy_now_price && view.current_price < auction.buy_now_price && (
                    <Button variant="ghost" disabled={busy} onClick={() => void doBuyNow()}>
                      ซื้อเลย {baht(auction.buy_now_price)}
                    </Button>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
                      inputMode="numeric" placeholder={`ใส่เอง (ขั้นต่ำ ${baht(customMin)})`}
                      className={cx('flex-1 rounded-lg border bg-surface-3 px-3 py-2 text-sm text-ink placeholder:text-ink-faint',
                        customErr ? 'border-[#dc2626]' : 'border-subtle')}
                    />
                    <Button variant="ghost" disabled={busy || !custom || !!customErr} onClick={() => void bid(Number(custom))}>บิด</Button>
                  </div>
                  {/* บอกเหตุผลตรงใต้ช่องกรอกตั้งแต่ยังพิมพ์อยู่ + ปิดปุ่มไว้เลย — เดิมต้องกดก่อน
                      แล้วค่อยเด้ง toast แดงทับการ์ดข้างล่าง ทำให้ดูเหมือนหน้าจอพัง */}
                  <div className={cx('text-[11.5px]', customErr ? 'font-bold text-[#f87171]' : 'text-ink-faint')}>
                    {customErr === 'too_low' ? `ใส่เองต้องอย่างน้อย ${baht(customMin)} (ต่ำกว่านี้ใช้ปุ่มด้านบน)`
                      : customErr === 'not_round' ? 'ยอดบิดต้องลงท้ายด้วย 0 (เช่น 1,100 / 1,500)'
                      : `ขั้นต่ำตอนนี้ ${baht(nextMin)} · ใส่เองได้ตั้งแต่ ${baht(customMin)} ขึ้นไป ลงท้ายด้วย 0`}
                  </div>
                </div>
              ) : (
                <EntryGate reason={right.reason} pending={!!waitingEntry} onPay={() => {
                  if (!uid) return;
                  dispatch(submitAuctionEntry(uid));
                  flash('ส่งคำขอเข้าสนามแล้ว — รอแอดมินตรวจสลิป');
                }} />
              )}
            </>
          )}

          {!running && view.status !== 'draft' && (
            iWon
              ? <WinnerPay a={auction} onPay={payNow} />
              : (
                <div className="rounded-lg bg-surface-3 px-3 py-2.5 text-[12.5px] text-ink-muted">
                  {/* หมดเวลาแล้วแต่ยังไม่มีใครกดสรุปผล ≠ ไม่มีคนบิด — เดิมบอก "ไม่มีผู้บิด" ทั้งที่บิดกันเป็นสิบครั้ง */}
                  {awaitingResult ? 'หมดเวลาแล้ว — กำลังรอประกาศผล'
                    : view.winner_user_id ? 'ปิดประมูลแล้ว — มีผู้ชนะแล้ว'
                    : view.bid_count > 0 ? 'ปิดประมูลแล้ว'
                    : 'ปิดประมูลแล้ว — ไม่มีผู้บิด'}
                </div>
              )
          )}

          {/* กระดิ่ง (เจ้าของ 2026-08-03): เปิดแล้วปุ่มหายไปเลย ไม่ต้องมีปุ่มปิด
              + กดแล้วขอสิทธิ์แจ้งเตือนของเครื่องด้วย (ต้องอยู่ใน user gesture) ไม่งั้นบอกว่าจะเตือนแต่ไม่เคยเตือน */}
          {!watching && (
            <button onClick={() => void turnOnBell()}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-subtle bg-surface-3 py-2 text-[13px] font-bold text-ink-muted">
              <Icon name="bell" size={16} />
              กดกระดิ่งรับแจ้งเตือนราคา
            </button>
          )}
          {watching && (
            <div className="flex items-center justify-center gap-1.5 py-1 text-[12px] font-bold text-primary-bright">
              <Icon name="bell" size={14} />
              เปิดกระดิ่งแล้ว — จะแจ้งเตือนเมื่อราคาขยับ
            </div>
          )}
        </div>
      </Card>

      {/* สภาพสินค้า + ตำหนิ */}
      {/* เช็คลิสต์สภาพของห้องนี้มาก่อนเสมอ (ระบุรายชิ้น) — ห้องเก่าที่ยังไม่มี ค่อยถอยไปใช้สภาพของ SKU */}
      {auction.cond
        ? <Card><AuctionCondCard cond={auction.cond} /></Card>
        : product && <div className="-mb-3"><StockCondCard cond={product.stock_cond} /></div>}
      {auction.detail && (
        <Card>
          <div className="flex flex-col gap-1.5 p-3.5">
            <div className="text-[13.5px] font-extrabold">หมายเหตุ</div>
            <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-muted">{auction.detail}</div>
          </div>
        </Card>
      )}

      {/* ประวัติบิด — ปิดชื่อ (เจ้าของ: ลูกค้าเห็นครบทุกบรรทัดแต่ไม่เห็นว่าใคร) */}
      <Card>
        <div className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center justify-between">
            <div className="text-[13.5px] font-extrabold">ประวัติการบิด</div>
            <div className="text-[11.5px] text-ink-faint">{historyRows.length} รายการ</div>
          </div>
          {historyRows.length === 0 && <div className="text-[12.5px] text-ink-faint">ยังไม่มีใครบิด — เป็นคนแรกได้เลย</div>}
          {historyRows.map((r) => (
            <div key={r.key} className={cx('flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px]',
              r.mine ? 'bg-primary/12' : 'bg-surface-3', r.void && 'opacity-45 line-through')}>
              <span className={cx('font-semibold', r.mine ? 'text-primary-bright' : 'text-ink-muted')}>
                {r.mine ? 'คุณ' : r.label}
                {/* บิดผิดถอนเองไม่ได้ (กติกา) — ส่งเรื่องให้แอดมินตัดสิน */}
                {r.mine && !r.void && running && (
                  <button onClick={() => void askCancel(r.key)} className="ml-2 rounded border border-subtle px-1.5 py-0.5 text-[10.5px] font-normal text-ink-faint">
                    ขอยกเลิก
                  </button>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-extrabold tabular-nums">{baht(r.amount)}</span>
                <span className="text-[11px] text-ink-faint">
                  {new Date(r.at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <AuctionRules a={auction} />
    </div>
  );
}

/** ผู้ชนะ — กล่องชำระเงิน (24 ชม.) พร้อมนาฬิกานับถอยหลัง */
function WinnerPay({ a, onPay }: { a: Auction; onPay: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (a.status === 'paid') {
    return (
      <div className="rounded-lg bg-[#16a34a]/15 px-3 py-2.5 text-[12.5px] font-bold text-[#4ade80]">
        ชำระเรียบร้อยแล้ว — ดูตั๋วและเลือกวิธีรับของได้ที่ “กระเป๋าตั๋ว”
      </div>
    );
  }
  if (a.status === 'awarded') {
    return (
      <div className="rounded-lg bg-surface-3 px-3 py-2.5 text-[12.5px] text-ink-muted">
        ส่งสลิปแล้ว — รอแอดมินตรวจสอบ พออนุมัติจะได้ตั๋วทันที
      </div>
    );
  }
  const left = a.pay_due_at ? new Date(a.pay_due_at).getTime() - Date.now() : 0;
  const late = left <= 0;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[#16a34a]/40 bg-[#16a34a]/[0.1] p-3">
      <div className="text-[13.5px] font-extrabold text-[#4ade80]">คุณชนะการประมูลนี้ที่ {baht(a.winning_amount ?? 0)}</div>
      <div className="text-[12px] leading-relaxed text-ink-muted">
        {late
          ? 'เลยกำหนดชำระ 24 ชม. แล้ว — ยังกดจ่ายได้ แต่สิทธิ์อาจถูกยกให้ผู้บิดอันดับ 2 ตามกติกา รีบทักแอดมินครับ'
          : <>ชำระเต็มจำนวนภายใน <b className="text-ink">{timeLeftLabel(left)}</b> · ราคานี้รวมค่าส่งแล้ว</>}
      </div>
      <Button onClick={onPay}>ชำระเงิน {baht(a.winning_amount ?? 0)}</Button>
    </div>
  );
}

/** กติกา — ต้องประกาศไว้ตั้งแต่แรกเพราะข้อ "2 อันดับแรกมีสิทธิ์" ผูกพันผู้บิดอันดับ 2 ด้วย */
function AuctionRules({ a }: { a: Auction }) {
  const rules = [
    `ราคาเปิด ${baht(a.start_price)} · บิดข้ามขั้นได้ ขอแค่ยอดลงท้ายด้วย 0`,
    'ขั้นบันได: ต่ำกว่า 3,000 = +20 · 3,000–4,999 = +50 · 5,000–9,999 = +100 · 10,000 ขึ้นไป = +200',
    `ทุกครั้งที่มีคนบิดใน ${a.window_min} นาทีสุดท้าย เวลาปิดจะเลื่อนออกไปอีก ${a.extend_min} นาที (รวมแล้วไม่เกิน ${a.cap_min} นาทีจากเวลาปิดเดิม)`,
    'ราคาที่ชนะรวมค่าส่งแล้ว · ใช้คูปองและส่วนลดยศไม่ได้',
    'ผู้ชนะต้องชำระเต็มจำนวนภายใน 24 ชั่วโมง',
    '**2 อันดับแรกมีสิทธิ์**: ถ้าผู้ชนะไม่ชำระใน 24 ชม. สิทธิ์จะตกไปที่ผู้บิดอันดับ 2 ที่ราคาที่เขาบิดไว้',
    'บิดแล้วถอนเองไม่ได้ — ถ้าพิมพ์ผิดให้แจ้งแอดมินเพื่อขอยกเลิก',
    'ผู้เข้าประมูลต้องมีใบพรีที่ของยังไม่ถึงมือ หรือชำระค่าเข้าสนาม ฿300 (ใช้เป็นมัดจำพรีรายการอื่นได้ ไม่ใช่ค่าธรรมเนียม)',
  ];
  return (
    <Card>
      <div className="flex flex-col gap-1.5 p-3.5">
        <div className="text-[13.5px] font-extrabold">กติกาการประมูล</div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-ink-muted">
          {rules.map((r) => <li key={r}>{r.replace(/\*\*/g, '')}</li>)}
        </ul>
      </div>
    </Card>
  );
}

/** ยังไม่มีสิทธิ์บิด — บอกทางออกให้ชัด ไม่ใช่แค่ปิดปุ่มเฉยๆ */
function EntryGate({ reason, pending, onPay }: { reason: 'no_right' | 'too_many_wins'; pending: boolean; onPay: () => void }) {
  if (reason === 'too_many_wins') {
    return (
      <div className="rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.12] p-3 text-[12.5px] text-[#fbbf24]">
        คุณมีรายการที่ชนะแล้วยังไม่ชำระ 2 รายการ — เคลียร์ให้เหลือน้อยกว่า 2 ก่อนจึงบิดต่อได้
      </div>
    );
  }
  if (pending) {
    return (
      <div className="rounded-lg bg-surface-3 p-3 text-[12.5px] text-ink-muted">
        ส่งสลิปค่าเข้าสนามแล้ว — รอแอดมินตรวจสอบ พออนุมัติจะบิดได้ทันที
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-3 p-3">
      <div className="text-[12.5px] leading-relaxed text-ink-muted">
        ห้องประมูลเปิดให้เฉพาะลูกค้าที่<b className="text-ink"> มีใบพรีที่ของยังไม่ถึงมือ</b> หรือชำระ
        <b className="text-ink"> ค่าเข้าสนาม ฿300</b> — เงิน 300 นี้ไม่ใช่ค่าธรรมเนียม
        เอาสลิปใบเดิมไปใช้เป็นมัดจำพรีรายการอื่นได้
      </div>
      <div className="flex gap-2">
        <Link href="/shop" className="flex-1 rounded-lg border border-subtle bg-surface px-3 py-2 text-center text-[13px] font-bold text-ink">
          ไปพรีสินค้า
        </Link>
        <Button className="flex-1" onClick={onPay}>ส่งสลิป ฿300</Button>
      </div>
    </div>
  );
}

/** การ์ดในหน้ารวมห้องประมูล */
export function AuctionCard({ a, href }: { a: Auction; href: string }) {
  const db = useDatabase();
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const product = a.product_id ? db.products.find((p) => p.id === a.product_id) : undefined;
  const img = a.images[0] ?? product?.images?.[0];
  const now = new Date();
  const running = isLive(a, now);
  const msLeft = new Date(a.ends_at).getTime() - now.getTime();
  // จบแล้ว = ไม่โชว์ราคาปิด (เจ้าของ 2026-08-03) — ขึ้นข้อความกระพริบแทน
  // รวมห้องที่หมดเวลาแล้วแต่ยังไม่ประกาศผลด้วย: ราคาตอนนั้นคือราคาที่ชนะอยู่ดี ไม่ควรโชว์
  const cancelled = a.status === 'cancelled';
  const awaitingResult = a.status === 'live' && !running;
  const finished = awaitingResult || ['ended', 'awarded', 'paid'].includes(a.status);
  return (
    <Link href={href}>
      <Card className="overflow-hidden">
        <div className="relative aspect-square w-full bg-surface-3">
          {img ? <img src={img} alt={a.title} className={cx('h-full w-full object-cover', (finished || cancelled) && 'opacity-55')} />
               : <div className="grid h-full place-items-center text-xs text-ink-faint">ไม่มีรูป</div>}
          <span className={cx('absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10.5px] font-extrabold',
            running ? 'bg-primary text-white' : awaitingResult ? 'bg-[#fbbf24] text-black' : 'bg-surface-4 text-ink-muted')}>
            {running ? timeLeftLabel(msLeft) : awaitingResult ? 'หมดเวลา' : AUCTION_STATUS_TH[a.status]}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-2.5">
          <div className="line-clamp-2 text-[12.5px] font-bold leading-snug">{a.title}</div>
          {finished ? (
            <div className="animate-pulse text-[15px] font-extrabold text-primary-bright">ประมูลจบแล้ว</div>
          ) : cancelled ? (
            <div className="text-[15px] font-extrabold text-ink-faint">ยกเลิกแล้ว</div>
          ) : (
            <>
              <div className="text-[15px] font-extrabold text-primary-bright">
                {a.bid_count === 0 ? baht(a.start_price) : baht(a.current_price)}
              </div>
              <div className="text-[10.5px] text-ink-faint">
                {a.bid_count === 0 ? 'ราคาเปิด' : `บิดแล้ว ${a.bid_count} ครั้ง`}
              </div>
            </>
          )}
        </div>
      </Card>
    </Link>
  );
}

/** โหลดข้อมูลทั้งก้อนใหม่ (ใช้ในหน้าแอดมินหลังกดปิดประมูลผ่าน RPC) */
export const reloadDb = () => { void store.reloadIfIdle(); };
