'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth, canLogin } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { uploadImage } from '@/lib/upload';
import { reserveStock, payReservation, confirmReservation } from '@/lib/reserve';
import { Icon } from '@/components/Icon';
import { Button, BackBar, QrPanel, cx } from '@/components/ui';
import { CouponTicket } from '@/components/CouponTicket';
import { submitOrder, markPlanPaid } from '@/data/mutations';
import { reserveTicketNos } from '@/lib/ticketno';
import { ticketPrefixCounts, canBuySpecialWithLines } from '@/domain/services/tickets';
import { productLabel } from '@/domain/services/catalog';
import { batchAvailable, availableFor, isPendingHold, pendingHeld } from '@/domain/services/reservations';
import { store } from '@/data/store';
import { lineDepositForRank } from '@/domain/services/ranks';
import { livePrice } from '@/domain/services/pricing';
import { instockCouponsFor, couponDiscount, couponMatchesProduct } from '@/domain/services/coupons';
import { useSmartBack } from '@/lib/nav';
import { notifyAdminLine } from '@/lib/notify';
import { copyText, digitsOnly } from '@/lib/clipboard';

export default function CheckoutPage() {
  const router = useRouter();
  const goBack = useSmartBack('/cart');
  // มาจากหน้า "นัดชำระ" (v57): จ่ายจบแล้วต้องปิดนัดใบนั้นให้ ไม่งั้นแอดมินยังเห็นค้างในคิวทวง
  const planId = useSearchParams().get('plan') ?? '';
  const db = useDatabase();
  const dispatch = useDispatch();
  const cart = useCart();
  const { flash } = useToast();
  const { currentUserId, isLoggedIn, needsApproval } = useAuth();
  const mustLogin = canLogin && !isLoggedIn; // login required to place an order (live only)
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const myRank = db.users.find((u) => u.id === currentUserId)?.rank ?? 'bronze';
  // pre-orders get the member's rank deposit perk (Gold 50%) — same as submitOrder writes.
  // price/deposit read LIVE (livePrice) so the amount shown == the amount billed at submit.
  const unitDeposit = (l: (typeof cart.lines)[number]) => {
    const p = db.products.find((pp) => pp.id === l.productId);
    const { price, deposit } = livePrice(db, l);
    return lineDepositForRank(db.settings, { deposit, price, isStock: p?.is_stock ?? true }, myRank);
  };
  // only lines whose product still exists (a persisted cart may reference a since-removed product)
  const validLines = cart.lines.filter((l) => db.products.some((p) => p.id === l.productId));
  const grossPay = validLines.reduce((s, l) => s + unitDeposit(l) * l.qty, 0);

  // ── coupon (in-stock only, applied immediately) ──────────────────────────
  const eligibleCoupons = instockCouponsFor(db, currentUserId, validLines.map((l) => l.productId));
  const [couponGrantId, setCouponGrantId] = useState<string>('');
  const selected = eligibleCoupons.find((x) => x.grant.id === couponGrantId);
  // discount base = ONLY the in-stock lines this coupon actually targets — must match how
  // approveOrder knocks the discount off tickets, or the total would drop more than the tickets do.
  const couponBase = selected
    ? validLines.reduce((s, l) => {
        const p = db.products.find((pp) => pp.id === l.productId);
        return p?.is_stock && couponMatchesProduct(selected.coupon, p) ? s + unitDeposit(l) * l.qty : s;
      }, 0)
    : 0;
  const discount = selected ? couponDiscount(selected.coupon, couponBase) : 0;

  const payNow = Math.max(0, grossPay - discount);
  const diamondFree = grossPay <= 0; // rank perk (Diamond) → nothing to transfer
  const couponFree = grossPay > 0 && payNow <= 0; // a coupon fully covered the amount
  const noPayment = payNow <= 0; // no slip needed → auto-approve + issue ticket now
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];

  // ── stock reservation (in-stock / batch lines get a 15-min hold) ──────────
  const stockLines = validLines.filter((l) => l.batchId || db.products.find((p) => p.id === l.productId)?.is_stock);
  const needsReserve = canLogin && stockLines.length > 0;
  const stockKey = stockLines.map((l) => `${l.productId}|${l.batchId ?? ''}|${l.qty}`).join(',');
  // เช็คของหมดจาก client ทันที (บัญชีเดียว: ตั๋ว+hold ค้าง) — ไม่ต้องรอ RPC ตอบ. เคส Kid Naruto
  // 2026-07-24: ของหมดแต่ตะกร้าค้างของเก่า → หน้าโอนเงินโชว์ก่อนแบนเนอร์หมด → ลูกค้าโอนเงินฟรี!
  // ของหมด = ห้ามเห็นเลขบัญชี/ช่องสลิป/ปุ่มส่ง ตั้งแต่แรก
  // ⚠ ต้องเช็ค "ทุกบรรทัด" ไม่ใช่เฉพาะของที่มีจำนวนจำกัด — พรีปกติที่ปิดรับจองไปแล้ว
  //   เคยไม่ถูกเช็คเลย: หน้าจอโชว์เลขบัญชี → ลูกค้าโอน → submitOrder ปัดตกด้วย sellable guard
  //   = โอนแล้วไม่มีออเดอร์ (เคสเดียวกับ Kid Naruto คนละประตู) audit v57 #2
  const [resIds, setResIds] = useState<string[]>([]);
  // hold "ของออเดอร์นี้เอง" ต้องไม่ถูกนับเป็นของคนอื่น (บั๊กแฝง 2026-07-30): หลัง poll ดึง
  // reservation ของเราเข้ามาใน db แล้ว available จะเหลือ 0 ทั้งที่คนถือคือเราเอง —
  // ไม่หักออกจะโดนบล็อก "ถูกจองครบแล้ว" ทั้งที่กำลังถือของอยู่ (สูตรเดียวกับ submitOrder)
  const ownHeldHere = (batchId: string | undefined, productId: string) => db.stockReservations
    .filter((r) => (batchId ? r.batch_id === batchId : r.product_id === productId && !r.batch_id) && resIds.includes(r.id))
    .filter(isPendingHold).reduce((s, r) => s + r.qty, 0);
  const deadLines = validLines.filter((l) => {
    const p = db.products.find((pp) => pp.id === l.productId);
    if (!p) return true;
    if (l.batchId) {
      const b = db.batches.find((bb) => bb.id === l.batchId);
      if (!b || b.status !== 'open' || b.published === false) return true;   // รอบปิด/ยังเป็นร่าง
      return l.qty > batchAvailable(db, b) + ownHeldHere(l.batchId, p.id);
    }
    if (p.is_stock) return l.qty > availableFor(db, p) + ownHeldHere(undefined, p.id);
    return p.status !== 'open';                                             // พรีปกติปิดรับจองแล้ว
  });
  // ตะกร้ามีของ แต่สินค้าถูกลบออกจากร้านหมดแล้ว → ต้องบล็อกเหมือนของหมด
  // (เดิมหลุดทุกด่าน: validLines ว่าง → ยอด 0 → เข้าโหมด "ไม่ต้องโอน" → กดยืนยันได้ตั๋วเปล่า) audit ลูกค้า #3
  const allGone = cart.lines.length > 0 && validLines.length === 0;
  const clientSoldOut = deadLines.length > 0 || allGone;
  const [resUntil, setResUntil] = useState<number | null>(null);
  const [soldOut, setSoldOut] = useState(false);
  const [expired, setExpired] = useState(false);
  const [nowTs, setNowTs] = useState(Date.now());
  const started = useRef(false);

  // ── ของหมดตั้งแต่ "ก่อนเข้า" หน้า → ไม่ให้เข้าเลย (เจ้าของ 2026-07-30: ลูกค้ากดเข้ามาแล้วงง) ──
  // เด้งกลับตะกร้าพร้อม text ลอยบอกเหตุผล: มี hold/สลิปค้าง = "หมดชั่วคราว รอของหลุด" / ตั๋วครบจริง = หมดแล้ว
  // เฉพาะตอนยังไม่เริ่มจอง (started=false) — ถ้าของหมดกลางทางระหว่างถือ hold อยู่ ให้แผงเดิมในหน้าจัดการ
  const bounced = useRef(false);
  useEffect(() => {
    if (!clientSoldOut || bounced.current || started.current || mustLogin || needsApproval) return;
    bounced.current = true;
    const anyTemp = deadLines.some((l) => {
      const p = db.products.find((pp) => pp.id === l.productId);
      if (!p) return false;
      if (l.batchId) return pendingHeld(db, p.id, l.batchId) > 0;
      return p.is_stock && pendingHeld(db, p.id) > 0;
    });
    flash(allGone ? 'สินค้าในตะกร้าถูกนำออกจากร้านแล้ว — ลบออกจากตะกร้าได้เลย'
      : anyTemp ? '⏳ สินค้าหมดชั่วคราว กรุณารอของหลุด — ถ้าคนที่จองไว้ไม่ชำระ ของจะกลับมาให้กด'
      : 'สินค้าหมดแล้ว — ถูกจองครบทั้งรอบ 🙏');
    router.replace('/cart');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSoldOut, mustLogin, needsApproval]);

  useEffect(() => {
    if (started.current || mustLogin || needsApproval || !needsReserve) return;
    if (clientSoldOut) return; // ของหมดตั้งแต่ยังไม่เริ่ม — ไม่ต้อง hold (ลูกค้าต้องเอาของหมดออกก่อน)
    started.current = true;
    (async () => {
      const ids: string[] = []; let earliest = Infinity;
      for (const l of stockLines) {
        const r = await reserveStock(l.productId, l.batchId, l.qty, currentUserId);
        if (r.ok && r.reservation_id) { ids.push(r.reservation_id); if (r.until) earliest = Math.min(earliest, new Date(r.until).getTime()); }
        else setSoldOut(true);
      }
      setResIds(ids);
      if (earliest !== Infinity) setResUntil(earliest);
    })();
    // ⚠ deps ต้องเป็น "ค่าคงที่" ไม่ใช่ stockLines ที่สร้างใหม่ทุก render — ไม่งั้น effect วิ่งทุกเฟรม
    //   แล้วมีแค่ started.current กันไว้ชั้นเดียว ถ้าใครแก้โค้ดจน ref นั้นเลื่อน = ยิง reserveStock รัว
    //   จนสต๊อกถูกกันจนหมด (audit persist #15)
    // ⚠ clientSoldOut ต้องอยู่ใน deps ด้วย (audit regression #2): ตอนเปิดหน้าของอาจหมดเพราะคนอื่น
    //   ถือ hold อยู่ → effect ออกก่อนโดยไม่ตั้ง started → พอ hold หมดอายุ หน้าจอปลดบล็อกเอง
    //   แต่ถ้าไม่มี dep นี้ effect จะไม่กลับมาจองให้ = จ่ายเงินได้โดย "ไม่มีการกันของเลย" (ขายเกิน)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustLogin, needsApproval, needsReserve, stockKey, currentUserId, clientSoldOut]);

  useEffect(() => {
    if (!resUntil) return;
    const t = setInterval(() => { const n = Date.now(); setNowTs(n); if (n >= resUntil) setExpired(true); }, 1000);
    return () => clearInterval(t);
  }, [resUntil]);

  const secsLeft = resUntil ? Math.max(0, Math.floor((resUntil - nowTs) / 1000)) : 0;
  const mmss = `${String(Math.floor(secsLeft / 60)).padStart(2, '0')}:${String(secsLeft % 60).padStart(2, '0')}`;
  // hard-block ทั้งหน้า: ของหมด (เช็ค client ทันที หรือ server ปฏิเสธ) / หมดเวลาจอง — ห้ามเห็นช่องทางโอน
  const blockedByStock = clientSoldOut || (needsReserve && (soldOut || expired));

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดสลิปไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if ((!slip && !noPayment) || blockedByStock) return;
    // Gate รอบพิเศษ (เจ้าของ 2026-07-23): มีรอบพิเศษในตะกร้าแต่ยังไม่มีใบพรี (และไม่มีพรีปกติพ่วง)
    // — บล็อกก่อนโอนจริง (mutation ก็ guard ซ้ำ ชั้นนี้ไว้กันเงียบ + อธิบายลูกค้า)
    if (validLines.some((l) => l.batchId) && !canBuySpecialWithLines(db, currentUserId, validLines))
      return flash('🔒 รอบพิเศษเฉพาะลูกค้าที่มีใบพรี — เพิ่มพรีปกติลงตะกร้า หรือเปิดพรีก่อนนะครับ');
    setBusy(true);
    // Diamond / coupon-covered (payNow 0) → auto-approve issues the ticket right here in the CUSTOMER
    // session, where RLS hides other customers' tickets → client numbering would collide. Reserve the
    // numbers from the server first (migration v47); seed/preview returns {} → mutation falls back.
    const startNos = noPayment ? await reserveTicketNos(ticketPrefixCounts(db, validLines.map((l) => l.productId))) : undefined;
    // อ่านจำนวนออเดอร์ "ตอนนี้จริงๆ" หลังรอ RPC เสร็จ แล้วค่อย dispatch — เพื่อให้ read-back เชื่อถือได้
    let ordersBefore = 0;
    dispatch((d) => { ordersBefore = d.orders.length; return d; });
    dispatch(submitOrder(currentUserId, validLines, slip ?? '', resIds, noPayment, selected ? { grantId: selected.grant.id, discount } : undefined, startNos));
    // read-back: submitOrder guard อาจปัดตกเงียบ (gate รอบพิเศษ ฯลฯ) — ห้ามเคลียร์ตะกร้า/บอกสำเร็จมั่ว
    // ⚠ ต้องเทียบกับ "จำนวนก่อนหน้าที่อ่านจาก store จริง" ไม่ใช่ db ที่ผูกไว้ตอน render:
    //   ระหว่างรอ reserveTicketNos ตัว poll อาจดึงออเดอร์ของคนอื่นเข้ามา แล้วนับว่าสำเร็จมั่ว (regression #6)
    let submitted = false;
    let newOrderId = '';
    dispatch((d) => { submitted = d.orders.length > ordersBefore; newOrderId = d.orders[0]?.id ?? ''; return d; });
    // ⚠ ลำดับสำคัญ (เคส Madara/Pl Tree 2026-07-25): payReservation ต้องเรียก "หลัง" รู้ว่าออเดอร์เกิดจริง
    // เท่านั้น — เดิมเรียกก่อน แล้วออเดอร์โดนปัดตก → hold ค้าง 'paid' ถาวร ขวางสต๊อกโดยไม่มีออเดอร์คู่.
    // ถ้าไม่ผ่าน: hold ยังเป็น active มีนาฬิกา 15 นาที → คืนของเองอัตโนมัติ
    if (!submitted) { setBusy(false); return flash('ส่งออเดอร์ไม่สำเร็จ — ตรวจสิทธิ์รอบพิเศษ/รีเฟรชหน้าแล้วลองใหม่'); }
    // ออเดอร์เกิดแล้ว → หยุดนาฬิกา hold (กันของจนแอดมินตรวจ)
    await Promise.all(resIds.map((rid) => payReservation(rid)));
    // coupon fully covered an in-stock order → we auto-approve here with no admin step, so the stock
    // holds must be CONFIRMED now (the admin approve screen normally does this). Otherwise they'd
    // stay 'paid' and the stock would be held forever.
    if (noPayment) await Promise.all(resIds.map((rid) => confirmReservation(rid)));
    // ปิดนัดชำระ "ตอนส่งสลิป" (ไม่ใช่ตอนแอดมินอนุมัติ) — นัดจบหน้าที่แล้ว เตือนต่อไม่มีประโยชน์
    // ต้องสั่งก่อน flush() เพื่อให้ไปกับรอบเซฟเดียวกับออเดอร์
    if (planId) dispatch(markPlanPaid(planId, newOrderId));
    // ⚠ ต้องรู้ผลเซฟ "ก่อน" เคลียร์ตะกร้า/บอกสำเร็จ/เด้งหน้า — เดิมเคลียร์ก่อนแล้วค่อยเซฟ
    //   ถ้าเซฟไม่ผ่าน ลูกค้าโอนเงินไปแล้ว แต่ไม่มีทั้งออเดอร์และตะกร้าให้กดใหม่ (audit persist #1/#12)
    const failed = await store.flush();
    if (failed) {
      setBusy(false);
      return flash('บันทึกออเดอร์ไม่สำเร็จ — อย่าเพิ่งปิดหน้านี้ เช็คเน็ตแล้วกดส่งใหม่ (ตะกร้ายังอยู่ครบ)');
    }
    cart.clear();
    // ping the shop owner's LINE (fire-and-forget; no-op if LINE env isn't set)
    const buyerName = db.users.find((x) => x.id === currentUserId)?.display_name ?? 'ลูกค้า';
    notifyAdminLine(noPayment
      ? `🎫 ออเดอร์อนุมัติอัตโนมัติ: ${buyerName} · ${validLines.length} รายการ (ไม่ต้องโอน)`
      : `🧾 สลิปใหม่รอตรวจ: ${buyerName} · ${validLines.length} รายการ · ยอด ${payNow.toLocaleString()} บาท`);
    setBusy(false);
    flash(noPayment ? 'ยืนยันแล้ว · ได้ตั๋วเลย 🎉' : 'ส่งคำขอแล้ว · รอ Admin ตรวจสอบ');
    router.push('/wallet');
  };

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-[640px]">
        <BackBar title="ชำระเงิน" onBack={goBack} />
        <div className="py-16 text-center text-ink-faint">ไม่มีรายการให้ชำระ</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ชำระเงิน" onBack={goBack} />

      <div className="mb-3.5 rounded-card border border-subtle bg-surface-2 p-[15px]">
        {cart.lines.map((l) => {
          const product = db.products.find((p) => p.id === l.productId);
          if (!product) return null; // product removed since added → skip (never crash)
          const variant = db.variants.find((v) => v.id === l.variantId);
          return (
            <div key={l.productId + (l.variantId ?? '') + (l.batchId ?? '')} className="flex justify-between gap-2.5 py-1 text-[13px]">
              <span className="text-ink-muted2">{productLabel(db, l.productId, l.variantId)} ×{l.qty}</span>
              <span className="font-semibold">{baht(unitDeposit(l) * l.qty)}</span>
            </div>
          );
        })}
        {discount > 0 && (
          <div className="mt-1 flex justify-between gap-2.5 py-1 text-[13px] text-[#4ade80]">
            <span>ส่วนลดคูปอง{selected ? ` · ${selected.coupon.label}` : ''}</span>
            <span className="font-semibold">−{baht(discount)}</span>
          </div>
        )}
        <div className="my-2.5 border-t border-subtle" />
        <div className="flex items-center justify-between">
          <span className="font-bold">{noPayment ? 'ชำระตอนนี้' : 'ยอดโอน'}</span>
          <span className="text-xl font-extrabold text-primary-soft">{baht(payNow)}</span>
        </div>
      </div>

      {eligibleCoupons.length > 0 && (
        <div className="mb-3.5 rounded-card border border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.06] p-[14px]">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-[#c4b5fd]"><Icon name="tag" size={16} /> คูปองส่วนลด (พร้อมส่ง)</div>
          <select value={couponGrantId} onChange={(e) => setCouponGrantId(e.target.value)} className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent">
            <option value="">ไม่ใช้คูปอง</option>
            {eligibleCoupons.map((x) => <option key={x.grant.id} value={x.grant.id}>{x.coupon.label} · ลด {baht(x.coupon.value)}</option>)}
          </select>
          {selected && <div className="mt-2.5"><CouponTicket coupon={selected.coupon} size="sm" /></div>}
        </div>
      )}

      {blockedByStock ? (
        /* ของหมด/หมดเวลา = บล็อกทั้งส่วนชำระเงิน — ห้ามโชว์เลขบัญชี/ช่องสลิป/ปุ่มส่งเด็ดขาด
           (เคส Kid Naruto 2026-07-24: ลูกค้าเห็นเลขบัญชีก่อนแบนเนอร์หมดขึ้น → โอนเงินไปฟรี) */
        <div className="mb-4 rounded-card border border-accent bg-[#b91c1c]/[0.12] p-5 text-center">
          <Icon name="warning" size={26} className="mx-auto mb-2 text-primary-soft" />
          <div className="text-[15px] font-extrabold text-primary-soft">
            {allGone ? 'สินค้าในตะกร้าถูกนำออกจากร้านแล้ว'
              : !clientSoldOut && !soldOut && expired ? 'หมดเวลาชำระ · การจองถูกคืนแล้ว'
              : 'สินค้าถูกจองครบแล้ว · สั่งไม่ได้ในรอบนี้'}
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink-muted2">
            {allGone ? 'ล้างตะกร้าแล้วเลือกใหม่ได้เลย — หรือทักแอดมินถ้ายังอยากได้ตัวนี้'
              : !clientSoldOut && !soldOut && expired ? 'กรุณากลับไปเริ่มสั่งใหม่อีกครั้ง'
              : 'ระบบปิดช่องทางโอนเงินไว้ — จะได้ไม่โอนแล้วไม่ได้ของ 🙏'}
          </div>
          {allGone && (
            <button onClick={() => { cart.clear(); flash('ล้างตะกร้าแล้ว'); }} className="mt-3.5 w-full rounded-btn bg-cta py-3 text-sm font-bold text-white">ล้างตะกร้า</button>
          )}
          {deadLines.length > 0 && (
            <>
              <div className="mt-3 flex flex-col items-center gap-1 text-[12.5px] text-ink-muted2">
                {deadLines.map((l) => {
                  const p = db.products.find((pp) => pp.id === l.productId);
                  const why = !p ? 'ถูกนำออกจากร้านแล้ว' : (!l.batchId && !p.is_stock) ? 'ปิดรับจองรอบนี้แล้ว' : 'หมดแล้ว';
                  return <div key={l.productId + (l.variantId ?? '') + (l.batchId ?? '')}>• {productLabel(db, l.productId, l.variantId)} ×{l.qty} — {why}</div>;
                })}
              </div>
              <button onClick={() => { deadLines.forEach((l) => cart.remove(l.productId, l.variantId, l.batchId)); flash('เอาสินค้าที่หมดออกแล้ว'); }} className="mt-3.5 w-full rounded-btn bg-cta py-3 text-sm font-bold text-white">เอาสินค้าที่หมดออกจากตะกร้า</button>
            </>
          )}
          <button onClick={() => router.push('/shop')} className="mt-2.5 w-full rounded-btn border border-subtle py-3 text-sm font-semibold text-ink-muted2">← กลับหน้าร้าน</button>
        </div>
      ) : noPayment ? (
        <div className="mb-4 rounded-card border border-[#8b5cf6]/40 bg-[#8b5cf6]/[0.10] p-[18px] text-center">
          <Icon name="verified" size={26} className="mx-auto mb-1.5 text-[#c4b5fd]" />
          <div className="text-sm font-bold text-[#c4b5fd]">{couponFree ? 'คูปองส่วนลดครอบคลุมเต็มจำนวน' : 'สิทธิ์ Diamond · ไม่ต้องมัดจำ'}</div>
          <div className="mt-1 text-[12.5px] text-ink-muted2">{couponFree ? 'กดยืนยันรับตั๋วได้เลย — ไม่ต้องโอน' : diamondFree ? 'กดยืนยันรับตั๋วได้เลย — จ่ายเต็มจำนวนตอนของถึงไทย' : 'กดยืนยันรับตั๋วได้เลย'}</div>
        </div>
      ) : (
        <>
          <div className="mb-3.5 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
            <div className="mb-3.5 text-sm font-bold">โอนผ่านบัญชีธนาคาร / พร้อมเพย์</div>
            <div className="mb-3.5 flex justify-center">
              {account?.qr_url
                ? <img src={account.qr_url} alt="บัญชีรับเงิน" className="h-[172px] w-[172px] rounded-2xl bg-white object-contain p-2" />
                : <QrPanel size={172} />}
            </div>
            {account ? (
              <>
                <CopyRow label="ชื่อบัญชี" value={account.name} onCopy={async () => flash((await copyText(account.name)) ? 'คัดลอกชื่อบัญชีแล้ว ✓' : 'คัดลอกไม่สำเร็จ')} />
                <CopyRow label="เลขบัญชี / พร้อมเพย์" value={account.number} onCopy={async () => flash((await copyText(digitsOnly(account.number))) ? 'คัดลอกเลขบัญชีแล้ว ✓' : 'คัดลอกไม่สำเร็จ')} />
                <div className="mt-1 text-[11px] text-ink-faint">แตะที่เลขเพื่อคัดลอก แล้วไปวางในแอปธนาคารได้เลย</div>
              </>
            ) : (
              <div className="text-[13px] text-ink-faint">ยังไม่ได้ตั้งค่าบัญชีรับเงิน (Admin → ตั้งค่าการเงิน)</div>
            )}
            <div className="my-3 border-t border-dashed border-subtle" />
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-ink-muted">ยอดโอน</span>
              <span className="text-xl font-extrabold text-primary-soft">{baht(payNow)}</span>
            </div>
          </div>

          <label
            className={cx('mb-4 block cursor-pointer rounded-card border-[1.5px] border-dashed p-[18px] text-center', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.06]' : 'border-accent')}
          >
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onSlip(e.target.files?.[0])} />
            {slip ? (
              <div className="flex flex-col items-center gap-2">
                <img src={slip} alt="สลิป" className="max-h-48 rounded-lg object-contain" />
                <div className="text-[13px] font-semibold text-[#4ade80]">แนบสลิปแล้ว ✓ (แตะเพื่อเปลี่ยน)</div>
              </div>
            ) : (
              <>
                <Icon name={busy ? 'box' : 'camera'} size={28} className={cx('mx-auto mb-2', busy ? 'animate-pulse text-ink-faint' : 'text-primary-soft')} />
                <div className="text-sm font-semibold">{busy ? 'กำลังอัปโหลด…' : 'แตะเพื่อถ่าย / เลือกรูปสลิป'}</div>
                <div className="mt-1 text-[11.5px] text-ink-faint">JPG / PNG ≤ 5MB · บังคับแนบ</div>
              </>
            )}
          </label>
        </>
      )}

      {mustLogin ? (
        <>
          <button onClick={() => router.push('/profile')} className="w-full rounded-btn bg-cta py-3.5 text-sm font-bold text-white">เข้าสู่ระบบ / สมัครสมาชิก เพื่อสั่งซื้อ</button>
          <div className="mt-2.5 text-center text-[11.5px] text-ink-faint">ต้องเข้าสู่ระบบก่อนยืนยันการสั่งซื้อ (เพื่อยืนยันตัวตน + ที่อยู่จัดส่ง)</div>
        </>
      ) : needsApproval ? (
        <div className="rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-4 text-center">
          <Icon name="bell" size={22} className="mx-auto mb-1.5 text-[#fbbf24]" />
          <div className="text-sm font-bold text-[#fbbf24]">บัญชีรอแอดมินอนุมัติ</div>
          <div className="mt-1 text-[12px] text-ink-muted2">ดูสินค้าได้ก่อน — สั่งซื้อได้เมื่อแอดมินอนุมัติสมาชิกแล้ว</div>
        </div>
      ) : (
        <>
          {!blockedByStock && needsReserve && resUntil && (
            <div className="mb-3 flex items-center justify-center gap-2 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.12] py-2.5 text-[13px] font-bold text-[#fbbf24]">
              <Icon name="bell" size={16} /> จองสินค้าไว้ให้แล้ว · ชำระภายใน {mmss}
            </div>
          )}
          {/* ของหมด/หมดเวลา: แผงแดงด้านบนแทนที่ทุกอย่างแล้ว — ไม่มีปุ่มส่งให้กดเลย (เดิมปุ่ม disabled
              แต่ยังมองเห็น ลูกค้าเข้าใจว่ากดได้) */}
          {!blockedByStock && (
            <>
              <Button disabled={(!slip && !noPayment) || busy} onClick={submit}>{noPayment ? 'ยืนยัน · รับตั๋วเลย' : 'ส่งคำขอ · รอ Admin ตรวจสอบ'}</Button>
              <div className="mt-2.5 text-center text-[11.5px] text-ink-faint">{noPayment ? 'ยืนยันแล้วได้ตั๋วทันที · จ่ายเต็มจำนวนตอนของถึงไทย' : 'เมื่อ Admin อนุมัติสลิป ระบบจะออก Ticket ให้อัตโนมัติ'}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between py-[5px] text-[13px]">
      <span className="text-ink-muted">{label}</span>
      <button onClick={onCopy} className="inline-flex items-center gap-1.5 font-semibold text-ink">{value} <Icon name="copy" size={15} className="text-ink-faint" /></button>
    </div>
  );
}
