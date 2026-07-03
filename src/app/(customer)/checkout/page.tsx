'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth, canLogin } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { uploadImage } from '@/lib/upload';
import { reserveStock, payReservation } from '@/lib/reserve';
import { Icon } from '@/components/Icon';
import { Button, BackBar, QrPanel, cx } from '@/components/ui';
import { submitOrder } from '@/data/mutations';
import { lineDepositForRank } from '@/domain/services/ranks';
import { useSmartBack } from '@/lib/nav';

export default function CheckoutPage() {
  const router = useRouter();
  const goBack = useSmartBack('/cart');
  const db = useDatabase();
  const dispatch = useDispatch();
  const cart = useCart();
  const { flash } = useToast();
  const { currentUserId, isLoggedIn, needsApproval } = useAuth();
  const mustLogin = canLogin && !isLoggedIn; // login required to place an order (live only)
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const myRank = db.users.find((u) => u.id === currentUserId)?.rank ?? 'bronze';
  // pre-orders get the member's rank deposit perk (Gold 50%) — same as submitOrder writes
  const unitDeposit = (l: (typeof cart.lines)[number]) => {
    const p = db.products.find((pp) => pp.id === l.productId);
    return lineDepositForRank(db.settings, { deposit: l.depositEach, price: l.priceEach, isStock: p?.is_stock ?? true }, myRank);
  };
  // only lines whose product still exists (a persisted cart may reference a since-removed product)
  const validLines = cart.lines.filter((l) => db.products.some((p) => p.id === l.productId));
  const payNow = validLines.reduce((s, l) => s + unitDeposit(l) * l.qty, 0);
  const noPayment = payNow <= 0; // e.g. Diamond rank (0% deposit) → nothing to transfer now
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];

  // ── stock reservation (in-stock / batch lines get a 15-min hold) ──────────
  const stockLines = validLines.filter((l) => l.batchId || db.products.find((p) => p.id === l.productId)?.is_stock);
  const needsReserve = canLogin && stockLines.length > 0;
  const [resIds, setResIds] = useState<string[]>([]);
  const [resUntil, setResUntil] = useState<number | null>(null);
  const [soldOut, setSoldOut] = useState(false);
  const [expired, setExpired] = useState(false);
  const [nowTs, setNowTs] = useState(Date.now());
  const started = useRef(false);

  useEffect(() => {
    if (started.current || mustLogin || needsApproval || !needsReserve) return;
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
  }, [mustLogin, needsApproval, needsReserve, stockLines, currentUserId]);

  useEffect(() => {
    if (!resUntil) return;
    const t = setInterval(() => { const n = Date.now(); setNowTs(n); if (n >= resUntil) setExpired(true); }, 1000);
    return () => clearInterval(t);
  }, [resUntil]);

  const secsLeft = resUntil ? Math.max(0, Math.floor((resUntil - nowTs) / 1000)) : 0;
  const mmss = `${String(Math.floor(secsLeft / 60)).padStart(2, '0')}:${String(secsLeft % 60).padStart(2, '0')}`;
  const blockedByStock = needsReserve && (soldOut || expired);

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดสลิปไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if ((!slip && !noPayment) || blockedByStock) return;
    setBusy(true);
    // slip submitted → stop the 15-min timer on each hold (kept until admin decides)
    await Promise.all(resIds.map((rid) => payReservation(rid)));
    dispatch(submitOrder(currentUserId, validLines, slip ?? '', resIds));
    cart.clear();
    setBusy(false);
    flash('ส่งคำขอแล้ว · รอ Admin ตรวจสอบ');
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
            <div key={l.productId + (l.variantId ?? '')} className="flex justify-between gap-2.5 py-1 text-[13px]">
              <span className="text-ink-muted2">{product.series_name}{variant ? ` · ${variant.name}` : ''} ×{l.qty}</span>
              <span className="font-semibold">{baht(unitDeposit(l) * l.qty)}</span>
            </div>
          );
        })}
        <div className="my-2.5 border-t border-subtle" />
        <div className="flex items-center justify-between">
          <span className="font-bold">ยอดโอน</span>
          <span className="text-xl font-extrabold text-primary-soft">{baht(payNow)}</span>
        </div>
      </div>

      <div className="mb-3.5 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
        <div className="mb-3.5 text-sm font-bold">สแกนจ่ายผ่าน PromptPay</div>
        <div className="mb-3.5 flex justify-center">
          {account?.qr_url
            ? <img src={account.qr_url} alt="PromptPay QR" className="h-[172px] w-[172px] rounded-2xl bg-white object-contain p-2" />
            : <QrPanel size={172} />}
        </div>
        {account ? (
          <>
            <CopyRow label="ชื่อบัญชี" value={account.name} onCopy={() => flash('คัดลอกแล้ว')} />
            <CopyRow label="พร้อมเพย์" value={account.number} onCopy={() => flash('คัดลอกเบอร์แล้ว')} />
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
            <div className="mt-1 text-[11.5px] text-ink-faint">JPG / PNG ≤ 5MB · {noPayment ? 'ไม่บังคับ (ยศนี้ไม่ต้องมัดจำ)' : 'บังคับแนบ'}</div>
          </>
        )}
      </label>

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
          {needsReserve && !soldOut && resUntil && !expired && (
            <div className="mb-3 flex items-center justify-center gap-2 rounded-card border border-[#d97706]/40 bg-[#d97706]/[0.12] py-2.5 text-[13px] font-bold text-[#fbbf24]">
              <Icon name="bell" size={16} /> จองสินค้าไว้ให้แล้ว · ชำระภายใน {mmss}
            </div>
          )}
          {needsReserve && soldOut && (
            <div className="mb-3 rounded-card border border-accent bg-[#b91c1c]/[0.12] px-4 py-3 text-center text-[13px] font-bold text-primary-soft">สินค้าถูกจองครบแล้ว · ขออภัย สั่งไม่ได้ในรอบนี้</div>
          )}
          {needsReserve && expired && !soldOut && (
            <div className="mb-3 rounded-card border border-accent bg-[#b91c1c]/[0.12] px-4 py-3 text-center text-[13px] font-bold text-primary-soft">หมดเวลาชำระ · การจองถูกคืนแล้ว กรุณาเริ่มสั่งใหม่</div>
          )}
          <Button disabled={(!slip && !noPayment) || busy || blockedByStock} onClick={submit}>ส่งคำขอ · รอ Admin ตรวจสอบ</Button>
          <div className="mt-2.5 text-center text-[11.5px] text-ink-faint">เมื่อ Admin อนุมัติสลิป ระบบจะออก Ticket ให้อัตโนมัติ</div>
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
