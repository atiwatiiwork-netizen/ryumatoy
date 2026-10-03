'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { submitRemainingPayment, payoutInfoOf } from '@/data/mutations';
import { isTransientPersistError, persistFailText } from '@/data/persistErrors';
import { uploadImage } from '@/lib/upload';
import { notifyAdminLine } from '@/lib/notify';
import { copyText, digitsOnly } from '@/lib/clipboard';
import { baht } from '@/lib/theme';
import { productLabel } from '@/domain/services/catalog';
import { depositGap, listingPreview, sellBlockReason, standardDepositPerUnit, topupIsFullPayment, MARKET } from '@/domain/services/market';
import { heldByPayer } from '@/domain/services/tickets';
import * as mk from '@/lib/market';
import type { PayoutAccount, PreorderTicket } from '@/domain/entities';
import { QrPanel, cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MoneySplit, StubArt, LotPill } from './MarketUi';
import { PayoutPicker, payoutAccountsOf, payoutLabel, primaryPayoutId } from './PayoutPicker';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SellMode = 'market' | 'direct';
/** ผลค้นเลขกระเป๋า + เลขที่ใช้ค้น (ส่งข้อเสนอด้วยเลขนี้เท่านั้น) */
type LookedUp = mk.WalletLookupRes & { code: string };

/**
 * แผงจากหน้าใบพรีในกระเป๋า — 2 โหมดใช้ร่างเดียวกัน (เจ้าของ 2026-10-02 ข้อ 3.3: บัญชีชุดเดียวกัน):
 *   'market' = ลงขายขึ้นกระดาน (ข้อ 1-11 ของ ryuma-p2p-spec)
 *   'direct' = "เปลี่ยนใบพรี" ให้คนที่รู้จักด้วยเลขกระเป๋า 4 หลัก (ryuma-direct-transfer-spec)
 * ลำดับ: ① เติมมัดจำถ้าไม่เต็ม (สลิปเข้าร้าน · แยกหัวข้อ "เติมมัดจำ" ให้แอดมิน) ② ขายไม่ได้ด้วยเหตุผลอื่น → บอกตรงๆ
 *        ③ เลือกบัญชีรับเงิน (ลงทะเบียนไว้/สร้างใหม่) ④ จำนวนชิ้น + ยอด ⑤ (direct) เลขกระเป๋าผู้รับ → ยืนยันคน → ส่ง
 * ด่านจริงอยู่ที่ RPC (ryuma_market_list / ryuma_market_offer) — หน้านี้แค่บอกเหตุผลก่อนกด
 */
export function SellSheet({ ticket, mode = 'market', onClose }: { ticket: PreorderTicket; mode?: SellMode; onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const router = useRouter();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const t = db.tickets.find((x) => x.id === ticket.id) ?? ticket;
  const me = db.users.find((u) => u.id === uid);
  const direct = mode === 'direct';
  // หลายชิ้น: ตั้งต้นทั้งใบ (audit รอบ C R2B-06: เดิมตั้งต้น 1 ชิ้นแต่ยอดเท่าทุนของทั้งใบ)
  const [qty, setQty] = useState(ticket.qty || 1);
  const pv0 = listingPreview(t, t.qty, 0);
  const [priceStr, setPriceStr] = useState(String(Math.round(pv0.paid)));
  // บัญชีหลัก = ตัวที่ตรงกับ payout_info (เลือกล่าสุด) ไม่งั้นตัวแรก
  const [payoutId, setPayoutId] = useState<string | undefined>(() => primaryPayoutId(me) ?? payoutAccountsOf(me)[0]?.id);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // direct: เลขกระเป๋าผู้รับ + ผลค้น (ผูกกับเลขที่ค้น — เปลี่ยนเลขแล้วผลเดิมใช้ไม่ได้)
  const [code, setCode] = useState('');
  const codeRef = useRef('');
  const [target, setTarget] = useState<LookedUp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const gap = depositGap(db, t);
  const pendingTopup = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending' && r.purpose === 'topup');
  const q = Math.min(Math.max(1, qty), t.qty);
  const price = Math.max(0, Math.round(Number(priceStr) || 0));
  // ช่องยอดว่าง ≠ ยกให้ฟรี (audit รอบ C R3-27: เดิมลบตัวเลขหมดแล้วกลายเป็นข้อเสนอยกให้ฟรีเงียบๆ)
  const priceMissing = priceStr.trim() === '';
  const reason = sellBlockReason(db, t, uid, q);
  // เหตุผล "ต้องเติมมัดจำ" / "มีสลิปเติมมัดจำรอตรวจ" → โชว์แผงเติมมัดจำแทนการบล็อกเฉยๆ (ด่านอื่นมาก่อนเสมอ)
  //   สลิปเติมมัดจำค้างแต่ไม่ขาดแล้ว → บล็อกพร้อมเหตุผล (R2B-07: เดิมปุ่มกดได้แต่ไม่เกิดอะไร)
  const blocked = !!reason && !(gap > 0 && reason.startsWith('ต้องเติมมัดจำ')) && !(pendingTopup && gap > 0 && reason === 'มีสลิปส่วนต่างรอตรวจ');
  const fullPayTopup = gap > 0 && !pendingTopup && topupIsFullPayment(db, t);
  const pv = listingPreview(t, q, price);
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];
  const payout: PayoutAccount | undefined = payoutAccountsOf(me).find((a) => a.id === payoutId);
  // ยกให้ฟรี (ดีลตรง ฿0) ไม่มีเงินให้รับ → ไม่ต้องมีบัญชี (audit รอบ C R1-58)
  const needPayout = !(direct && !priceMissing && price === 0);
  const verb = direct ? 'เปลี่ยนใบ' : 'ลงขาย';

  const saveTopup = async () => {
    if (!slip || busy) return;
    setBusy(true);
    const before = db.remainingPayments.length;
    dispatch(submitRemainingPayment(t.id, uid, 0, slip, undefined, { purpose: 'topup' }));
    let after = before;
    dispatch((d) => { after = d.remainingPayments.length; return d; });
    if (after === before) { setBusy(false); flash('ส่งไม่สำเร็จ — อาจมีสลิปรอตรวจอยู่แล้ว'); return; }
    const failed = await store.flush();
    setBusy(false);
    // เจ้าของ 2026-10-02 ข้อ 2.2: ส่งแอดมิน "แยกหัวข้อว่าเป็นการเติมมัดจำ" (คิว /admin/market หัวข้อ 💰 + LINE บอกชัด)
    const line = () => notifyAdminLine(`💰 [เติมมัดจำ] ${t.ticket_no} · ${baht(gap)} — ${me?.display_name ?? ''} เติมมัดจำให้ครบก่อน${verb} (ตรวจที่ แอดมิน › ตลาดใบพรี › เติมมัดจำ)`);
    if (failed) {
      // audit รอบ C R1-48: เดิมบอก "กดส่งใหม่" แต่แถวในเครื่องซ่อนปุ่มไปแล้ว และพอส่งขึ้นทีหลังแอดมินไม่ได้ LINE
      if (!isTransientPersistError(failed)) { flash(persistFailText(failed, '')); return; } // ถาวร = แถวถูกถอนออก ปุ่มกลับมาให้ส่งใหม่
      flash('เน็ตสะดุด — สลิปอยู่ในเครื่องแล้ว ระบบจะส่งให้เองเมื่อเน็ตกลับมา (ไม่ต้องกดซ้ำ)');
      setSlip(null);
      void (async () => {
        for (let i = 0; i < 24; i++) {
          await sleep(5000);
          const f = await store.flush();
          if (!f) { if (store.getState().remainingPayments.some((r) => r.ticket_id === t.id && r.status === 'pending' && r.purpose === 'topup')) line(); return; }
          if (!isTransientPersistError(f)) return;
        }
      })();
      return;
    }
    line();
    flash('ส่งสลิปเติมมัดจำแล้ว · รอแอดมินตรวจ แล้วค่อยกลับมา' + verb);
    setSlip(null);
  };

  const lookup = async () => {
    const c = digitsOnly(code);
    if (c.length !== 4) return flash('ใส่เลขกระเป๋า 4 หลักของผู้รับ');
    setBusy(true);
    setErr(null);
    const r = await mk.walletLookup(c);
    setBusy(false);
    // ผลที่กลับมาช้า (ระหว่างนั้นพิมพ์เลขใหม่ไปแล้ว) ห้ามจับคู่ชื่อคนเก่ากับเลขใหม่ (audit รอบ B R1-02)
    if (codeRef.current !== c) return;
    setTarget({ ...r, code: c } as LookedUp); // ค้นไม่เจอ = ข้อความแดงใต้ช่องเลข (target.ok false)
  };

  const submit = async () => {
    if (busy || reason) return;
    if (priceMissing) return setErr(direct ? 'ใส่ยอดที่ให้ผู้รับโอน (ยกให้ฟรี = กดปุ่ม "ยกให้ฟรี")' : 'ใส่ราคาขาย');
    if (needPayout && !payout) return setErr('เลือกหรือเพิ่มบัญชีรับเงินก่อน');
    if (direct && (!target?.ok || !target.user_id || target.code !== digitsOnly(code))) return setErr('ค้นเลขกระเป๋าผู้รับก่อน');
    setBusy(true);
    setErr(null);
    const r = direct
      // ส่ง user_id ของคนที่ยืนยันไปด้วย — เซิร์ฟเวอร์ส่งให้เฉพาะเมื่อเลขยังเป็นของคนนั้น (R1-02)
      ? await mk.marketOffer(t.id, q, price, target!.code, needPayout && payout ? payoutInfoOf(payout) : null, target!.user_id!)
      : await mk.marketList(t.id, q, price, payoutInfoOf(payout!)); // บัญชีที่เห็นในแผงนี้ = บัญชีที่ล็อกกับประกาศ (review รอบ C)
    setBusy(false);
    if (!r.ok || !r.id) {
      // ข้อความอยู่ในแผงด้วย (toast อาจโดนบังบนจอเล็ก · R3-08)
      setErr(mk.marketErrText(r));
      flash(mk.marketErrText(r));
      if (direct && ['code_changed', 'self', 'not_ready', 'no_address', 'too_many'].includes(r.error ?? '')) setTarget(null);
      return;
    }
    await store.reload();
    if (direct) {
      void mk.marketPush(r.id, 'offer');
      notifyAdminLine(`🎁 [เปลี่ยนใบพรี] ${t.ticket_no} → ${target?.name ?? (r as { to_mask?: string }).to_mask ?? ''} · ${price > 0 ? baht(price) : 'ยกให้ฟรี'} — รอผู้รับโอนภายใน 24 ชม. · ดีล ${r.id}`);
      flash(`ส่งข้อเสนอให้ ${target?.name ?? 'ผู้รับ'} แล้ว 🎁 · เขามีเวลา ${MARKET.offerHours} ชม.`);
    } else {
      void mk.marketPush(r.id, 'listed');
      flash('ลงประกาศแล้ว 🎉 ใบนี้ขึ้นกระดานแล้ว');
    }
    onClose();
    router.push(`/market/${r.id}`);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-[520px] overflow-y-auto rounded-t-3xl border border-subtle bg-surface-2 p-4 pb-[calc(16px+env(safe-area-inset-bottom))] sm:rounded-3xl motion-safe:animate-riseIn" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl"><StubArt db={db} productId={t.product_id} variantId={t.variant_id} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-primary-soft">{direct ? '🔁 เปลี่ยนใบพรีให้คนที่รู้จัก' : '🏷️ ลงขายขึ้นกระดาน'}</div>
            <div className="truncate text-[15px] font-extrabold">{productLabel(db, t.product_id, t.variant_id)}</div>
            <div className="mt-0.5 flex items-center gap-1.5"><span className="font-mono text-[11px] text-primary-soft">{t.ticket_no}</span><LotPill status={t.product_status} /></div>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle text-ink-faint" aria-label="ปิด"><Icon name="x" size={16} /></button>
        </div>

        {/* ระบบอ่านตั๋วให้ (ข้อ 1.2 ของเจ้าของ) */}
        <div className="mb-3 rounded-2xl border border-[#16a34a]/30 bg-gradient-to-b from-[#16a34a]/10 to-transparent px-3.5 py-3 text-[12.5px]">
          <div className="mb-1 font-bold text-[#4ade80]">✓ ระบบอ่านตั๋วให้แล้ว</div>
          <Row k="ราคาเต็มของใบ" v={baht(pv0.total)} />
          <Row k="จ่ายร้านไปแล้ว (มัดจำ + ส่วนต่างที่จ่าย)" v={baht(pv0.paid)} />
          <Row k="ค้างจ่ายร้าน → ผู้รับรับต่อ" v={baht(pv0.due)} hl />
        </div>

        {blocked ? (
          <div className="rounded-2xl border border-subtle bg-surface-3 px-4 py-4 text-center text-[13px] text-ink-muted2">{verb}ใบนี้ไม่ได้ตอนนี้ — <b className="text-ink">{reason}</b></div>
        ) : fullPayTopup ? (
          // ยอดที่ขาด = ยอดค้างทั้งหมด → เป็นงวดปิดใบ ไม่ใช่เติมมัดจำ (audit รอบ C R1-44)
          <div className="rounded-2xl border border-[#d4af37]/40 bg-[#d4af37]/[0.07] p-3.5 text-[12.5px] leading-relaxed text-ink-muted2">
            <div className="text-[14px] font-bold text-[#f1d27a]">ต้องจ่ายส่วนต่างให้ครบก่อน{verb}</div>
            ใบนี้ยอดที่ขาดเท่ากับยอดค้างทั้งหมด {baht(gap)} — ชำระส่วนต่างตามปกติในหน้าตั๋ว (ได้โบนัส/คูปอง/แต้มครบ) แล้วค่อยกลับมา{verb}
            <button type="button" onClick={onClose} className="mt-3 w-full rounded-btn border-[1.5px] border-accent py-2.5 text-[13.5px] font-bold text-primary-soft">กลับไปหน้าตั๋ว</button>
          </div>
        ) : gap > 0 ? (
          // ① เติมมัดจำก่อน (ข้อ 9 / เจ้าของ 2026-10-02 ข้อ 2.1)
          <div className="rounded-2xl border border-[#d4af37]/40 bg-[#d4af37]/[0.07] p-3.5">
            <div className="text-[14px] font-bold text-[#f1d27a]">ต้องเติมมัดจำอีก {baht(gap)} ก่อน{verb}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-muted2">
              ใบนี้จ่ายมัดจำไม่เต็ม (ส่วนลดยศ) · มัดจำปกติ {baht(standardDepositPerUnit(db, t))}/ชิ้น — เงินที่เติมเข้าร้าน และ<b className="text-ink">หักออกจากส่วนต่าง</b> ราคารวมของใบเท่าเดิม · แอดมินตรวจสลิปแล้วค่อยกลับมา{verb}
            </div>
            {pendingTopup ? (
              <div className="mt-3 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-2.5 text-[12.5px] text-[#fbbf24]">ส่งสลิปเติม {baht(pendingTopup.amount)} แล้ว · รอแอดมินตรวจ แล้วกลับมา{verb}ได้เลย</div>
            ) : (
              <>
                <div className="mt-3 flex justify-center">{account?.qr_url ? <img src={account.qr_url} alt="QR ร้าน" className="h-[150px] w-[150px] rounded-2xl bg-white object-contain p-2" /> : <QrPanel size={150} />}</div>
                {account && (
                  <button type="button" onClick={async () => flash((await copyText(digitsOnly(account.number))) ? 'คัดลอกเลขบัญชีแล้ว ✓' : 'คัดลอกไม่สำเร็จ')}
                    className="mx-auto mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-muted2">{account.name} · <span className="font-mono text-ink">{account.number}</span><Icon name="copy" size={13} /></button>
                )}
                <label className={cx('mt-3 flex cursor-pointer items-center gap-3 rounded-xl border-[1.5px] border-dashed px-3 py-3', slip ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.07]' : 'border-accent')}>
                  <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { setSlip(await uploadImage(f, 'slip')); } catch { flash('อัปโหลดไม่สำเร็จ'); } finally { setBusy(false); } }} />
                  {slip ? <img src={slip} alt="" className="h-12 w-9 rounded object-cover" /> : <Icon name="camera" size={20} className="text-primary-soft" />}
                  <span className="text-[13px] font-bold text-primary-soft">{slip ? 'แนบสลิปแล้ว ✓' : busy ? 'กำลังอัปโหลด…' : `แนบสลิปเติมมัดจำ ${baht(gap)}`}</span>
                </label>
                <button type="button" disabled={!slip || busy} onClick={() => void saveTopup()} className="mt-3 w-full rounded-btn bg-cta py-3 text-[14px] font-bold text-white shadow-cta disabled:opacity-50">ส่งสลิปเติมมัดจำ · รอแอดมินตรวจ</button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* ③ บัญชีรับเงิน — เลือกจากที่ลงทะเบียน / เพิ่มใหม่ (ใช้ร่วมทั้งสองโหมด) */}
            {needPayout
              ? <PayoutPicker selectedId={payoutId} onSelect={(a) => setPayoutId(a?.id)} />
              : <div className="rounded-2xl border border-subtle bg-surface-3 px-3.5 py-3 text-[12.5px] text-ink-muted2">🎁 ยกให้ฟรี — ไม่มีเงินโอน จึงไม่ต้องใช้บัญชีรับเงิน</div>}

            {/* ④ จำนวนชิ้น + ยอด */}
            {t.qty > 1 && (
              <div className="flex items-center justify-between rounded-xl border border-subtle bg-surface-3 px-3 py-2.5">
                <span className="text-[13px]">{verb}กี่ชิ้น <span className="text-ink-faint">(ใบนี้มี {t.qty})</span></span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setQty(Math.max(1, q - 1))} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle"><Icon name="minus" size={14} /></button>
                  <b className="w-6 text-center font-mono">{q}</b>
                  <button type="button" onClick={() => setQty(Math.min(t.qty, q + 1))} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle"><Icon name="plus" size={14} /></button>
                </div>
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">{direct ? 'ยอดที่ให้ผู้รับโอนให้คุณ' : 'ราคาขาย · ผู้ซื้อโอนให้คุณ'}</div>
              <div className="flex items-baseline gap-1.5 rounded-2xl border border-accent bg-surface-3 px-4 py-2.5">
                <span className="font-mono text-[20px] font-bold text-ink-faint">฿</span>
                <input id="mk-price" inputMode="numeric" value={priceStr} onChange={(e) => setPriceStr(e.target.value.replace(/[^\d]/g, '').slice(0, 7))}
                  className="w-full bg-transparent font-mono text-[30px] font-bold text-ink outline-none" />
                <span className={cx('shrink-0 font-mono text-[13px] font-bold', pv.profit >= 0 ? 'text-[#4ade80]' : 'text-[#f87171]')}>{pv.profit >= 0 ? '+' : '−'}{baht(Math.abs(pv.profit))}</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                {[{ l: 'เท่าทุน', v: pv.paid }, ...(direct ? [{ l: 'ยกให้ฟรี', v: 0 }] : []), { l: '+100', v: price + 100 }, { l: '+300', v: price + 300 }, ...(direct ? [] : [{ l: '+500', v: price + 500 }])].map((c) => (
                  <button type="button" key={c.l} onClick={() => setPriceStr(String(Math.round(c.v)))} className="flex-1 rounded-lg border border-subtle bg-surface-3 py-1.5 font-mono text-[12px] font-semibold text-ink-muted2">{c.l}</button>
                ))}
              </div>
              <div className="mt-1.5 text-[11.5px] text-ink-faint">ตั้งยอดได้อิสระ · ตัวเลขเขียว = กำไรจากที่คุณจ่ายร้านไปแล้ว {baht(pv.paid)}{direct && price === 0 ? ' · ยอด 0 = ยกให้ ผู้รับแค่กดรับ' : ''}</div>
            </div>

            {/* ⑤ ผู้รับจะเห็นแบบนี้ */}
            <div className="text-[12px] font-semibold text-ink-muted">{direct ? 'ผู้รับจะเห็นแบบนี้' : 'ผู้ซื้อจะเห็นแบบนี้'}</div>
            <MoneySplit price={price} due={pv.due} />

            {direct && (
              // เลขกระเป๋าผู้รับ → ค้น → ยืนยัน "ใช่คนนี้ไหม" (เจ้าของ: ไม่ต้องสนชื่อ ขอแค่ยอด+ใบตรง — ชื่อโชว์แค่กันส่งผิดคน)
              <div className="rounded-2xl border border-[#f1d27a]/35 bg-[#f1d27a]/[0.06] p-3.5">
                <div className="text-[13.5px] font-bold">เลขกระเป๋าของผู้รับ <span className="font-normal text-ink-faint">(4 หลัก · เขาเห็นที่หัวหน้ากระเป๋าพรี เปลี่ยนทุกวัน)</span></div>
                <div className="mt-2 flex gap-2">
                  <input id="mk-code" inputMode="numeric" value={code} disabled={busy}
                    onChange={(e) => { const c = e.target.value.replace(/\D/g, '').slice(0, 4); codeRef.current = c; setCode(c); setTarget(null); setErr(null); }}
                    placeholder="0000" className="w-[120px] rounded-xl border border-subtle bg-surface-3 px-3 py-2 text-center font-mono text-[24px] font-bold tracking-[0.3em] text-ink outline-none focus:border-accent disabled:opacity-60" />
                  <button type="button" disabled={busy || digitsOnly(code).length !== 4} onClick={() => void lookup()} className="flex-1 rounded-xl border-[1.5px] border-accent text-[13.5px] font-bold text-primary-soft disabled:opacity-50">{busy ? 'กำลังค้น…' : 'ค้นหาผู้รับ'}</button>
                </div>
                {target?.ok && (
                  <div className="mt-3 flex items-center gap-3 rounded-xl border border-[#16a34a]/40 bg-[#16a34a]/[0.08] px-3 py-2.5">
                    {target.avatar_url ? <img src={target.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" /> : <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-[#f1d27a] to-[#b45309] font-mono text-[11px] font-bold text-[#0a0809]">{(target.mask ?? '').slice(-2)}</span>}
                    <div className="min-w-0 flex-1 text-[12.5px]">
                      <div className="truncate font-bold">{target.name} <span className="font-mono text-[11px] text-ink-faint">{target.mask}</span></div>
                      <div className="text-[11.5px] text-[#4ade80]">พร้อมรับใบพรี ✓ · ใช่คนนี้ไหม? ถ้าใช่กดส่งข้อเสนอด้านล่าง</div>
                    </div>
                  </div>
                )}
                {target && !target.ok && <div className="mt-2 text-[12px] text-[#f87171]">{mk.marketErrText(target)}</div>}
                <div className="mt-2 text-[11px] text-ink-faint">ค้นได้วันละ {MARKET.lookupPerDay} ครั้ง · ผู้รับต้องกดรับเอง · คุณถอนข้อเสนอได้จนกว่าผู้รับจะเปิดหน้าโอนเงิน</div>
              </div>
            )}

            <ul className="space-y-1 text-[11.5px] leading-relaxed text-ink-faint">
              <li>🔒 ส่งแล้วใบนี้ล็อก — จ่ายส่วนต่าง/เลือกวิธีรับของไม่ได้จนกว่าจะจบดีลหรือถอน</li>
              {direct
                ? <li>⏳ ผู้รับมี {MARKET.offerHours} ชม. โอน+แนบสลิป · โอนแล้วคุณต้องยืนยันใน {MARKET.sellerSlaH} ชม. · ร้านกดโอนสิทธิ์เป็นขั้นสุดท้าย</li>
                : <li>⏳ ประกาศอยู่ {MARKET.listingDays} วัน · มีคนจอง {MARKET.holdMin} นาที · ผู้ซื้อโอนแล้วคุณต้องยืนยันใน {MARKET.sellerSlaH} ชม.</li>}
              {heldByPayer(t) && <li>🏆 {direct ? 'เปลี่ยนใบแล้ว' : 'ขายแล้ว'}ใบนี้ไม่นับยศรายเดือน/Event ของคุณ · โบนัสยศที่ได้จากใบนี้จะถูกเรียกคืน</li>}
              {needPayout && payout && <li>💳 รับเงินเข้า {payoutLabel(payout)}</li>}
            </ul>
            {err && <div role="alert" className="rounded-xl border border-[#b91c1c]/40 bg-[#b91c1c]/[0.1] px-3 py-2 text-[12.5px] font-semibold text-[#f87171]">{err}</div>}
            <button type="button" disabled={busy || priceMissing || (needPayout && !payout) || (direct && !target?.ok)} onClick={() => void submit()}
              className="rounded-btn bg-cta px-5 py-3.5 text-[15px] font-bold text-white shadow-cta disabled:opacity-50">
              {busy ? 'กำลังส่ง…' : direct
                ? `ส่งข้อเสนอให้ ${target?.ok ? target.name : 'ผู้รับ'} ${q < t.qty ? `· ${q} ชิ้น ` : ''}· ${price > 0 ? baht(price) : 'ยกให้ฟรี'}`
                : `ลงประกาศ ${q < t.qty ? `${q} ชิ้น ` : ''}· ${baht(price)}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const Row = ({ k, v, hl }: { k: string; v: string; hl?: boolean }) => (
  <div className="flex justify-between gap-3 py-0.5"><span className="text-ink-muted2">{k}</span><b className={cx('font-mono', hl && 'text-[#60a5fa]')}>{v}</b></div>
);
