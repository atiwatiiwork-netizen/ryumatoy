'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, BackBar, QrPanel, cx } from '@/components/ui';
import { productLabel, lineImage } from '@/domain/services/catalog';
import { ticketDue } from '@/domain/services/money';
import { ticketSelectable } from '@/domain/services/payments';
import { usableGrantsFor, scopeAllows, couponMatchesProduct, couponDiscount } from '@/domain/services/coupons';
import { CouponTicket } from '@/components/CouponTicket';
import { submitRemainingPayment } from '@/data/mutations';
import { store } from '@/data/store';
import { useSmartBack } from '@/lib/nav';
import { notifyAdminLine } from '@/lib/notify';
import { copyText, digitsOnly } from '@/lib/clipboard';
import type { PreorderTicket } from '@/domain/entities';

/**
 * ชำระส่วนต่างหลายใบด้วยสลิปเดียว (เจ้าของ 2026-09-12 "ปิดใบพรีแบบตะกร้า")
 *  · เลือกใบจากแท็บ "รอชำระ" ใน /wallet → มาหน้านี้ด้วย ?t=<ticketId,…>
 *  · 1 สลิป → remaining_payments ใบละ 1 แถว ใช้ slip_url เดียวกัน = กลุ่มเดียวกัน (ไม่พึ่ง group_id — v67 ยังไม่รัน)
 *  · คูปองพรีใช้ได้ 1 ใบต่อการชำระ: ผูกกับใบที่ค้างมากสุดที่คูปองใช้ได้
 *  · ⚠ ยังไม่มีขั้น "ใช้แต้ม" — เจ้าของสั่งรอจนระบบแต้มเสร็จทั้งชุดค่อยเปิด (จะเสียบเป็น step ระหว่างเลือกใบกับโอนเงิน)
 *  DNA save: อ่านกลับก่อนบอกสำเร็จ + flush ให้จบก่อนทิ้งสลิป (แบบเดียวกับหน้าจ่ายทีละใบ)
 */
export default function PayPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-ink-faint">กำลังโหลด…</div>}>
      <PayInner />
    </Suspense>
  );
}

function PayInner() {
  const params = useSearchParams();
  const router = useRouter();
  const goBack = useSmartBack('/wallet');
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [couponGrantId, setCouponGrantId] = useState('');

  const ids = useMemo(() => (params.get('t') ?? '').split(',').filter(Boolean), [params]);
  // ใบที่จ่ายได้จริง ณ ตอนนี้ (ของตัวเอง · เปิดให้จ่าย · ไม่มีสลิปค้าง) — ใบที่หลุดเกณฑ์ระหว่างทางถูกตัดออกเงียบๆ พร้อมบอก
  const tickets = useMemo(() => ids.map((id) => db.tickets.find((t) => t.id === id)).filter((t): t is PreorderTicket => !!t && t.owner_id === uid && ticketSelectable(db, t)), [ids, db, uid]);
  const dropped = ids.length - tickets.length;
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];

  // คูปองพรี 1 ใบ → ผูกกับใบที่ค้างมากสุดที่คูปองใช้ได้
  const eligible = usableGrantsFor(db, uid).filter((x) => scopeAllows(x.coupon.scope, false) && tickets.some((t) => { const p = db.products.find((pp) => pp.id === t.product_id); return !!p && couponMatchesProduct(x.coupon, p); }));
  const selected = eligible.find((x) => x.grant.id === couponGrantId);
  const couponTicket = selected
    ? [...tickets].sort((a, b) => ticketDue(b) - ticketDue(a)).find((t) => { const p = db.products.find((pp) => pp.id === t.product_id); return !!p && couponMatchesProduct(selected.coupon, p); })
    : undefined;
  const couponOff = selected && couponTicket ? couponDiscount(selected.coupon, ticketDue(couponTicket)) : 0;
  const lineAmount = (t: PreorderTicket) => Math.max(0, ticketDue(t) - (couponTicket?.id === t.id ? couponOff : 0));
  const total = tickets.reduce((s, t) => s + lineAmount(t), 0);

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if ((!slip && total > 0) || busy || tickets.length === 0) return; // คูปองครอบทั้งยอด = ไม่ต้องมีสลิป
    setBusy(true);
    try {
      const before = db.remainingPayments.length;
      // สลิปเดียว = slip_url เดียวกันทุกแถว → แอดมินเห็นเป็นกลุ่ม (pendingRpGroups)
      for (const t of tickets) {
        dispatch(submitRemainingPayment(t.id, uid, lineAmount(t), slip ?? '', couponTicket?.id === t.id && selected ? { grantId: selected.grant.id, discount: couponOff } : undefined));
      }
      let after = before;
      dispatch((d) => { after = d.remainingPayments.length; return d; });
      const made = after - before;
      if (made === 0) { setBusy(false); return flash('ส่งสลิปไม่สำเร็จ — ใบที่เลือกอาจมีสลิปรอตรวจอยู่แล้ว ลองรีเฟรช'); }
      const failed = await store.flush();
      setBusy(false);
      if (failed) return flash('บันทึกไม่สำเร็จ — อย่าเพิ่งปิดหน้านี้ เช็คเน็ตแล้วกดส่งอีกครั้ง');
      notifyAdminLine(`💸 สลิปส่วนต่างรวม ${made} ใบ: ${tickets.map((t) => t.ticket_no).join(', ')} · ${total.toLocaleString()} บาท`);
      flash(made < tickets.length ? `ส่งสลิปแล้ว ${made}/${tickets.length} ใบ · รอ Admin ตรวจสอบ` : `ส่งสลิป ${made} ใบแล้ว · รอ Admin ตรวจสอบ`);
      router.replace('/wallet');
    } catch { setBusy(false); flash('เกิดข้อผิดพลาด ลองใหม่อีกครั้ง'); }
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="ชำระส่วนต่างรวม" onBack={goBack} />

      {tickets.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 p-8 text-center text-[13px] text-ink-faint">ไม่มีใบที่จ่ายได้ในรายการนี้ — กลับไปเลือกใหม่ที่แท็บ "รอชำระ"</div>
      ) : (
        <>
          {dropped > 0 && <div className="mb-3 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.10] px-3.5 py-2.5 text-[12.5px] text-[#fbbf24]">ตัดออก {dropped} ใบที่จ่ายไม่ได้แล้ว (มีสลิปรอตรวจ / จ่ายครบแล้ว)</div>}

          {/* รายการใบที่เลือก */}
          <div className="mb-4 overflow-hidden rounded-card border border-subtle bg-surface-2">
            {tickets.map((t, i) => {
              const img = lineImage(db, t.product_id, t.variant_id);
              const off = couponTicket?.id === t.id ? couponOff : 0;
              return (
                <div key={t.id} className={cx('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-hair')}>
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-[9px] border border-subtle">
                    {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center bg-stripe"><Icon name="box" size={18} className="text-primary-soft/25" /></div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                    <div className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13.5px] font-extrabold text-primary-soft">{baht(lineAmount(t))}</div>
                    {off > 0 && <div className="text-[10.5px] text-[#4ade80]">คูปอง −{baht(off)}</div>}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between border-t border-subtle bg-surface-3/40 px-4 py-3">
              <span className="text-[13px] text-ink-muted2">รวม {tickets.length} ใบ{couponOff > 0 && <span className="ml-1 text-[#4ade80]">· ลด {baht(couponOff)}</span>}</span>
              <span className="text-[18px] font-extrabold text-primary-soft">{baht(total)}</span>
            </div>
          </div>

          {/* คูปอง (1 ใบ/การชำระ) */}
          {eligible.length > 0 && (
            <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-[#c4b5fd]"><Icon name="tag" size={15} /> ใช้คูปองส่วนลด (1 ใบต่อการชำระ)</div>
              <select value={couponGrantId} onChange={(e) => setCouponGrantId(e.target.value)} className="w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent">
                <option value="">ไม่ใช้คูปอง</option>
                {eligible.map((x) => <option key={x.grant.id} value={x.grant.id}>{x.coupon.label} · ลด {baht(x.coupon.value)}</option>)}
              </select>
              {selected && <div className="mt-2.5"><CouponTicket coupon={selected.coupon} size="sm" /></div>}
              {couponTicket && couponOff > 0 && <div className="mt-1.5 text-[11.5px] text-ink-faint">ใช้กับใบ {couponTicket.ticket_no}</div>}
            </div>
          )}

          {/* โอนเงิน + แนบสลิป */}
          <div className="mb-4 rounded-card border border-[#b91c1c]/30 bg-surface-2 p-[18px] text-center">
            <div className="mb-1 text-sm font-bold">โอน {baht(total)} ครั้งเดียว</div>
            <div className="mb-3.5 text-[12px] text-ink-faint">โอนผ่านบัญชีธนาคาร / สแกนจ่าย → แนบสลิป 1 ใบ → รอ Admin อนุมัติทุกใบพร้อมกัน</div>
            <div className="mb-3.5 flex justify-center">
              {account?.qr_url ? <img src={account.qr_url} alt="QR" className="h-[160px] w-[160px] rounded-2xl bg-white object-contain p-2" /> : <QrPanel size={160} />}
            </div>
            {account && (
              <button onClick={async () => flash((await copyText(digitsOnly(account.number))) ? 'คัดลอกเลขบัญชีแล้ว ✓' : 'คัดลอกไม่สำเร็จ')} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] text-ink-muted2">
                {account.name} · <span className="font-mono text-ink">{account.number}</span> <Icon name="copy" size={14} className="text-ink-faint" />
              </button>
            )}
            <label className={cx('mb-3 block cursor-pointer rounded-xl border-[1.5px] border-dashed p-4 text-center', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.06]' : 'border-accent')}>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onSlip(e.target.files?.[0])} />
              {slip ? <img src={slip} alt="สลิป" className="mx-auto max-h-40 rounded-lg object-contain" /> : <div className="text-[13px] font-semibold text-primary-soft">{busy ? 'กำลังอัปโหลด…' : '📎 แตะเพื่อแนบสลิปโอนเงิน'}</div>}
            </label>
            <div className="flex gap-2.5">
              <Button variant="ghost" onClick={goBack}>ยกเลิก</Button>
              <Button disabled={(!slip && total > 0) || busy} onClick={submit}>ส่งสลิป {tickets.length} ใบ · รอตรวจสอบ</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
