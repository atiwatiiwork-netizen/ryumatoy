'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { submitRemainingPayment, setPayoutInfo } from '@/data/mutations';
import { uploadImage } from '@/lib/upload';
import { notifyAdminLine } from '@/lib/notify';
import { copyText, digitsOnly } from '@/lib/clipboard';
import { baht } from '@/lib/theme';
import { promptPayTarget } from '@/lib/promptpay';
import { productLabel } from '@/domain/services/catalog';
import { depositGap, listingPreview, sellBlockReason, standardDepositPerUnit, MARKET } from '@/domain/services/market';
import { heldByPayer } from '@/domain/services/tickets';
import * as mk from '@/lib/market';
import type { PreorderTicket } from '@/domain/entities';
import { QrPanel, cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MoneySplit, StubArt, LotPill } from './MarketUi';

const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-accent';

/**
 * ลงขายใบพรี (เปิดจากหน้าใบพรีในกระเป๋า) — ข้อ 1-11 ที่เจ้าของตอบ:
 *   ① มัดจำไม่เต็ม (Gold/Diamond) → เติมก่อน (สลิปเข้าร้าน · purpose topup · หักจากส่วนต่าง)
 *   ② ขายไม่ได้ด้วยเหตุผลอื่น → บอกตรงๆ   ③ บัญชีรับเงิน (ครั้งแรกครั้งเดียว)
 *   ④ จำนวนชิ้น (แตกขายได้) + ราคา (อิสระ) → ⑤ ดูตัวเลข 2 ก้อนแบบที่ผู้ซื้อจะเห็น → ลงประกาศ
 * ด่านจริงอยู่ที่ ryuma_market_list (server) — หน้านี้แค่บอกเหตุผลก่อนกด
 */
export function SellSheet({ ticket, onClose }: { ticket: PreorderTicket; onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const router = useRouter();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const t = db.tickets.find((x) => x.id === ticket.id) ?? ticket;
  const me = db.users.find((u) => u.id === uid);
  const [qty, setQty] = useState(1);
  const pv0 = listingPreview(t, t.qty, 0);
  const [priceStr, setPriceStr] = useState(String(Math.round(pv0.paid)));
  const [pp, setPp] = useState({ promptpay: me?.payout_info?.promptpay ?? '', account_name: me?.payout_info?.account_name ?? '', bank: me?.payout_info?.bank ?? '', account_no: me?.payout_info?.account_no ?? '' });
  const [editPayout, setEditPayout] = useState(!me?.payout_info);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const gap = depositGap(db, t);
  const pendingTopup = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending' && r.purpose === 'topup');
  const q = Math.min(Math.max(1, qty), t.qty);
  const price = Math.max(0, Math.round(Number(priceStr) || 0));
  const reason = sellBlockReason(db, t, uid, q);
  // เหตุผล "ต้องเติมมัดจำ" / "มีสลิปเติมมัดจำรอตรวจ" → โชว์แผงเติมมัดจำแทนการบล็อกเฉยๆ (ด่านอื่นมาก่อนเสมอ)
  const blocked = !!reason && !(gap > 0 && reason.startsWith('ต้องเติมมัดจำ')) && !(pendingTopup && reason === 'มีสลิปส่วนต่างรอตรวจ');
  const pv = listingPreview(t, q, price);
  const account = db.paymentAccounts.find((a) => a.active) ?? db.paymentAccounts[0];

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
    if (failed) { flash('บันทึกไม่สำเร็จ — เช็คเน็ตแล้วกดส่งใหม่ (สลิปยังอยู่)'); return; }
    notifyAdminLine(`💸 สลิปเติมมัดจำ (เพื่อลงขายตลาดใบพรี): ${t.ticket_no} · ${baht(gap)}`);
    flash('ส่งสลิปเติมมัดจำแล้ว · รอแอดมินตรวจ แล้วค่อยลงขาย');
    setSlip(null);
  };

  const savePayout = async () => {
    const okTarget = pp.promptpay ? !!promptPayTarget(pp.promptpay) : false;
    if (!pp.account_name.trim()) return flash('ใส่ชื่อบัญชีรับเงิน');
    if (!okTarget && !digitsOnly(pp.account_no)) return flash('ใส่เบอร์/เลขบัตรพร้อมเพย์ หรือเลขบัญชีธนาคาร');
    if (pp.promptpay && !okTarget) return flash('เบอร์พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก');
    dispatch(setPayoutInfo(uid, pp));
    const failed = await store.flush();
    if (failed) return flash('บันทึกบัญชีไม่สำเร็จ — ลองใหม่');
    setEditPayout(false);
    flash('บันทึกบัญชีรับเงินแล้ว ✓');
  };

  const list = async () => {
    if (busy || reason) return;
    if (!me?.payout_info || editPayout) return flash('บันทึกบัญชีรับเงินก่อน');
    setBusy(true);
    const r = await mk.marketList(t.id, q, price);
    setBusy(false);
    if (!r.ok || !r.id) { flash(mk.marketErrText(r)); return; }
    await store.reload();
    void mk.marketPush(r.id, 'listed');
    flash('ลงประกาศแล้ว 🎉 ใบนี้ขึ้นกระดานแล้ว');
    onClose();
    router.push(`/market/${r.id}`);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-[520px] overflow-y-auto rounded-t-3xl border border-subtle bg-surface-2 p-4 pb-[calc(16px+env(safe-area-inset-bottom))] sm:rounded-3xl motion-safe:animate-riseIn" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl"><StubArt db={db} productId={t.product_id} variantId={t.variant_id} /></div>
          <div className="min-w-0 flex-1">
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
          <Row k="ค้างจ่ายร้าน → ผู้ซื้อรับต่อ" v={baht(pv0.due)} hl />
        </div>

        {blocked ? (
          <div className="rounded-2xl border border-subtle bg-surface-3 px-4 py-4 text-center text-[13px] text-ink-muted2">ลงขายใบนี้ไม่ได้ตอนนี้ — <b className="text-ink">{reason}</b></div>
        ) : gap > 0 ? (
          // ① เติมมัดจำก่อน (ข้อ 9)
          <div className="rounded-2xl border border-[#d4af37]/40 bg-[#d4af37]/[0.07] p-3.5">
            <div className="text-[14px] font-bold text-[#f1d27a]">ต้องเติมมัดจำอีก {baht(gap)} ก่อนลงขาย</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-muted2">
              ใบนี้จ่ายมัดจำไม่เต็ม (ส่วนลดยศ) · มัดจำปกติ {baht(standardDepositPerUnit(db, t))}/ชิ้น — เงินที่เติมเข้าร้าน และ<b className="text-ink">หักออกจากส่วนต่าง</b> ราคารวมของใบเท่าเดิม
            </div>
            {pendingTopup ? (
              <div className="mt-3 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3 py-2.5 text-[12.5px] text-[#fbbf24]">ส่งสลิปเติม {baht(pendingTopup.amount)} แล้ว · รอแอดมินตรวจ แล้วกลับมาลงขายได้เลย</div>
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
            {/* ③ บัญชีรับเงิน */}
            {editPayout ? (
              <div className="rounded-2xl border border-subtle bg-surface-3 p-3.5">
                <div className="text-[13.5px] font-bold">บัญชีรับเงินของคุณ <span className="font-normal text-ink-faint">(ใส่ครั้งเดียว)</span></div>
                <div className="mt-0.5 text-[11.5px] text-ink-faint">ผู้ซื้อจะเห็นเฉพาะตอนจองใบของคุณอยู่ · ระบบทำ QR พร้อมเพย์ใส่ยอดให้เอง</div>
                <div className="mt-2.5 grid gap-2">
                  <input id="pp-promptpay" inputMode="numeric" value={pp.promptpay} onChange={(e) => setPp({ ...pp, promptpay: e.target.value })} placeholder="เบอร์พร้อมเพย์ / เลขบัตรประชาชน" className={inputCls} />
                  <input id="pp-name" value={pp.account_name} onChange={(e) => setPp({ ...pp, account_name: e.target.value })} placeholder="ชื่อบัญชี (ตามแอปธนาคาร)" className={inputCls} />
                  <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                    <input id="pp-bank" value={pp.bank} onChange={(e) => setPp({ ...pp, bank: e.target.value })} placeholder="ธนาคาร (สำรอง)" className={inputCls} />
                    <input id="pp-acct" inputMode="numeric" value={pp.account_no} onChange={(e) => setPp({ ...pp, account_no: e.target.value })} placeholder="เลขบัญชี (สำรอง)" className={inputCls} />
                  </div>
                </div>
                <button type="button" onClick={() => void savePayout()} className="mt-3 w-full rounded-btn border-[1.5px] border-accent py-2.5 text-[13.5px] font-bold text-primary-soft">บันทึกบัญชีรับเงิน</button>
              </div>
            ) : (
              <button type="button" onClick={() => setEditPayout(true)} className="flex items-center gap-2 rounded-xl border border-subtle bg-surface-3 px-3 py-2.5 text-left text-[12.5px]">
                <Icon name="payments" size={16} className="text-primary-soft" />
                <span className="flex-1 truncate">รับเงินเข้า {me?.payout_info?.promptpay ? `พร้อมเพย์ ${me.payout_info.promptpay.slice(0, 3)}••••${me.payout_info.promptpay.slice(-2)}` : `${me?.payout_info?.bank ?? 'บัญชี'} ••${(me?.payout_info?.account_no ?? '').slice(-4)}`} · {me?.payout_info?.account_name}</span>
                <span className="text-[11.5px] text-ink-faint underline">เปลี่ยน</span>
              </button>
            )}

            {/* ④ จำนวนชิ้น + ราคา */}
            {t.qty > 1 && (
              <div className="flex items-center justify-between rounded-xl border border-subtle bg-surface-3 px-3 py-2.5">
                <span className="text-[13px]">ขายกี่ชิ้น <span className="text-ink-faint">(ใบนี้มี {t.qty})</span></span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setQty(Math.max(1, q - 1))} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle"><Icon name="minus" size={14} /></button>
                  <b className="w-6 text-center font-mono">{q}</b>
                  <button type="button" onClick={() => setQty(Math.min(t.qty, q + 1))} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle"><Icon name="plus" size={14} /></button>
                </div>
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">ราคาขาย · ผู้ซื้อโอนให้คุณ</div>
              <div className="flex items-baseline gap-1.5 rounded-2xl border border-accent bg-surface-3 px-4 py-2.5">
                <span className="font-mono text-[20px] font-bold text-ink-faint">฿</span>
                <input id="mk-price" inputMode="numeric" value={priceStr} onChange={(e) => setPriceStr(e.target.value.replace(/[^\d]/g, '').slice(0, 7))}
                  className="w-full bg-transparent font-mono text-[30px] font-bold text-ink outline-none" />
                <span className={cx('shrink-0 font-mono text-[13px] font-bold', pv.profit >= 0 ? 'text-[#4ade80]' : 'text-[#f87171]')}>{pv.profit >= 0 ? '+' : '−'}{baht(Math.abs(pv.profit))}</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                {[{ l: 'เท่าทุน', v: pv.paid }, { l: '+100', v: price + 100 }, { l: '+300', v: price + 300 }, { l: '+500', v: price + 500 }].map((c) => (
                  <button type="button" key={c.l} onClick={() => setPriceStr(String(Math.round(c.v)))} className="flex-1 rounded-lg border border-subtle bg-surface-3 py-1.5 font-mono text-[12px] font-semibold text-ink-muted2">{c.l}</button>
                ))}
              </div>
              <div className="mt-1.5 text-[11.5px] text-ink-faint">ตั้งราคาได้อิสระ · ตัวเลขเขียว = กำไรจากที่คุณจ่ายร้านไปแล้ว {baht(pv.paid)}</div>
            </div>

            {/* ⑤ ผู้ซื้อจะเห็นแบบนี้ */}
            <div className="text-[12px] font-semibold text-ink-muted">ผู้ซื้อจะเห็นแบบนี้</div>
            <MoneySplit price={price} due={pv.due} />
            <ul className="space-y-1 text-[11.5px] leading-relaxed text-ink-faint">
              <li>🔒 ลงแล้วใบนี้ล็อก — จ่ายส่วนต่าง/เลือกวิธีรับของไม่ได้จนกว่าจะขายหรือถอนประกาศ</li>
              <li>⏳ ประกาศอยู่ {MARKET.listingDays} วัน · มีคนจอง {MARKET.holdMin} นาที · ผู้ซื้อโอนแล้วคุณต้องยืนยันใน {MARKET.sellerSlaH} ชม.</li>
              {heldByPayer(t) && <li>🏆 ขายแล้วใบนี้ไม่นับยศรายเดือน/Event ของคุณ</li>}
            </ul>
            <button type="button" disabled={busy || editPayout} onClick={() => void list()}
              className="rounded-btn bg-cta px-5 py-3.5 text-[15px] font-bold text-white shadow-cta disabled:opacity-50">{busy ? 'กำลังลงประกาศ…' : `ลงประกาศ ${q < t.qty ? `${q} ชิ้น ` : ''}· ${baht(price)}`}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const Row = ({ k, v, hl }: { k: string; v: string; hl?: boolean }) => (
  <div className="flex justify-between gap-3 py-0.5"><span className="text-ink-muted2">{k}</span><b className={cx('font-mono', hl && 'text-[#60a5fa]')}>{v}</b></div>
);
