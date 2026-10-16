'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCart } from '@/state/CartProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useLiveStock } from '@/lib/useLiveStock';
import { myPendingHold } from '@/domain/services/reservations';
import { useLiveStockMap, liveKey } from '@/lib/liveStockMap';
import { isAdminUser } from '@/domain/services/admins';
import {
  lineStates, liveTargetsForLine, linesPublicEnabled, lineToneCounts, memberThumb, hasPin, lineSetPlan, LINE_LIVE_MAX, type LineMemberState,
} from '@/domain/services/lines';
import { baht } from '@/lib/theme';
import type { LineMember, Product, ProductLine } from '@/domain/entities';
import { lineDepositForRank } from '@/domain/services/ranks';
import { cx } from '@/components/ui';
import { LinePoster, type PosterPin } from './LinePoster';
import { TONE_HEX, TONE_LEGEND } from './lineUi';

/**
 * เนื้อหาหน้าไลน์ — คอมโพเนนต์เดียวทั้งหน้าลูกค้า (/line/[id] · mode="live") และพรีวิวในแอดมิน (mode="preview")
 * DNA shared preview: แก้หน้าลูกค้าที่นี่ พรีวิวแอดมินเปลี่ยนตามเอง ห้ามวาดซ้ำ
 *
 * ลูกค้าเห็นเฉพาะตัวที่มีสถานะ (state.visible) · เลข 1, 2, 3 นับใหม่เฉพาะตัวที่เห็น — ป้ายบนรูปกับรายการใช้เลขเดียวกัน
 * live: ถามของเหลือจริงจาก server (RLS ทำให้สูตร local ฝั่งลูกค้านับขายแล้วไม่ครบ) · preview: แอดมินเห็นตั๋วครบ ใช้ local
 */
export function LineView({ line, userId, mode }: { line: ProductLine; userId: string; mode: 'live' | 'preview' }) {
  const db = useDatabase();
  // hook ต้องเรียกทุก render ก่อนเงื่อนไขใดๆ
  const targets = mode === 'live' ? liveTargetsForLine(db, line) : [];
  const liveMap = useLiveStockMap(targets.map((t) => ({ key: liveKey(t.productId, t.batchId), productId: t.productId, batchId: t.batchId })), LINE_LIVE_MAX);
  const [hi, setHi] = useState<string | null>(null);
  const hiTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(hiTimer.current), []);

  const all = lineStates(db, line, {
    uid: mode === 'preview' ? '' : userId,
    live: mode === 'live' ? (pid, bid) => liveMap[liveKey(pid, bid)] : undefined,
    lineOa: db.settings.line_oa_id,
  });
  const shown = all.filter((s) => s.state.visible).map((s, i) => ({ ...s, no: i + 1 }));
  const hiddenN = all.length - shown.length;
  const counts = lineToneCounts(shown);
  const maker = db.manufacturers.find((m) => m.id === line.maker_id)?.name ?? '—';
  const franchise = line.franchise_id ? db.franchises.find((f) => f.id === line.franchise_id)?.name : undefined;
  const adminLive = mode === 'live' && isAdminUser(db, userId);
  // เหตุผลที่ลูกค้ายังไม่เห็น (แบนเนอร์แอดมิน) — ร่าง · ระบบไลน์ · รูปหมู่ · ตัวที่เห็นได้ (ครบชุดเดียวกับ lineOpenToCustomers · ร่างขึ้นก่อนเพราะปุ่ม 🚀 แก้ได้ทั้งสองข้อ)
  const blockedWhy = !line.active ? 'ไลน์นี้ยังเป็นร่าง — กด "🚀 เปิดไลน์ให้ลูกค้า" ในหน้าแก้ไลน์'
    : !linesPublicEnabled(db) ? 'ระบบไลน์ปิดอยู่ — กด "🚀 เปิดไลน์ให้ลูกค้า" ในหน้าแก้ไลน์ (เปิดระบบให้พร้อมกัน)'
      : !line.cover_url ? 'ยังไม่มีรูปหมู่'
        : shown.length === 0 ? 'ยังไม่มีตัวที่ลูกค้าเห็นได้' : null;

  const focus = (memberId: string) => {
    setHi(memberId);
    clearTimeout(hiTimer.current);
    hiTimer.current = setTimeout(() => setHi(null), 1800);
    if (typeof document !== 'undefined') document.getElementById(`lm-${memberId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const pins: PosterPin[] = shown
    .filter((s) => hasPin(s.member))
    .map((s) => ({ id: s.member.id, no: s.no, x: s.member.pin_x!, y: s.member.pin_y!, tone: s.state.tone, text: s.state.pinLabel, short: s.state.pinShort }));

  return (
    <div>
      {adminLive && blockedWhy && (
        <div className="mb-3 rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-2 text-[12px] leading-relaxed text-[#fbbf24]">
          👀 แอดมินเห็นคนเดียว — ลูกค้ายังไม่เห็นหน้านี้ ({blockedWhy})
          {hiddenN > 0 && <> · ตัวที่ลูกค้าไม่เห็น {hiddenN} ตัว</>}
          {' '}· <Link href="/admin/lines" className="font-bold underline">จัดการไลน์ →</Link>
        </div>
      )}

      <div className="mb-3">
        <div className="text-[20px] font-extrabold leading-tight">{line.name.trim() || 'ไลน์'}</div>
        <div className="mt-0.5 text-[12px] text-ink-muted2">{maker}{franchise ? ` · ${franchise}` : ''} · {shown.length} ตัว</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TONE_LEGEND.filter((t) => counts[t.tone] > 0).map((t) => (
            <span key={t.tone} className="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-3 px-2.5 py-1 text-[11px] font-semibold text-ink-muted2">
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: TONE_HEX[t.tone] }} />{t.label} {counts[t.tone]}
            </span>
          ))}
        </div>
      </div>

      {line.cover_url && (
        <>
          <LinePoster src={line.cover_url} pins={pins} onPinTap={focus} highlightId={hi} />
          <div className="mb-1 mt-2 flex flex-wrap gap-x-3 gap-y-1 px-0.5 text-[11px] text-ink-faint">
            {TONE_LEGEND.map((t) => (
              <span key={t.tone} className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-full" style={{ background: TONE_HEX[t.tone] }} />{t.label}</span>
            ))}
            {shown.length > 0 && shown.every((x) => hasPin(x.member)) && <span>ไม่มีป้าย = ค่ายยังไม่เปิดตัวนั้น</span>}
          </div>
        </>
      )}

      <SetPanel line={line} shown={shown} preview={mode === 'preview'} />

      <div className="mt-3 flex flex-col gap-2">
        {shown.map((s) => (
          <MemberRow key={s.member.id} member={s.member} no={s.no} state={s.state} thumb={memberThumb(db, s.member)} hi={hi === s.member.id} preview={mode === 'preview'} />
        ))}
        {shown.length === 0 && <div className="rounded-card border border-subtle bg-surface-2 p-6 text-center text-[13px] text-ink-faint">ยังไม่มีรายการในไลน์นี้</div>}
      </div>
    </div>
  );
}

/** ความคืบหน้า "ชื่อไลน์ x/y ตัว" + ปุ่ม "พรีทั้งเซต / พรีที่เหลือ" (เจ้าของ 2026-10-16 รอบ 1)
 *  · โชว์เมื่อไลน์มี ≥2 ตัว และมีอะไรให้ทำ (ใส่ตะกร้าได้ / อยู่ในตะกร้า / พรีไปแล้วบางส่วน)
 *  · ใส่ตะกร้าเฉพาะตัวที่ใส่ได้ทีเดียว (lineSetPlan) ตัวที่ต้องเลือกแบบ/รอบพิเศษ บอกใน toast ให้ไปกดที่แถว
 *  · พรีวิวในแอดมิน: หน้าตาเหมือนจริง กดไม่ได้ */
function SetPanel({ line, shown, preview }: { line: ProductLine; shown: { member: LineMember; state: LineMemberState }[]; preview: boolean }) {
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const meId = useCurrentUserId();
  // มัดจำตามยศของคนดู — สูตรเดียวกับตะกร้า/checkout/submitOrder (lineDepositForRank) ตัวเลขบนปุ่มต้องตรงกับที่จ่ายจริง
  const myRank = db.users.find((u) => u.id === meId)?.rank ?? 'bronze';
  const depOf = (p: Product) => lineDepositForRank(db.settings, { deposit: p.deposit_amount, price: p.price_total, isStock: p.is_stock }, myRank);
  const plan = lineSetPlan(shown, (pid) => cart.lines.some((l) => l.productId === pid && !l.batchId && !l.variantId), depOf);
  if (plan.total < 2) return null;
  if (plan.addable.length === 0 && plan.inCart === 0 && plan.mine === 0) return null;
  const name = line.name.trim() || 'ไลน์นี้';
  const addAll = () => {
    if (preview) return;
    for (const a of plan.addable) cart.add({ productId: a.product.id, depositEach: depOf(a.product), priceEach: a.product.price_total });
    flash(`ใส่ตะกร้า ${plan.addable.length} ตัวแล้ว ✓ ไปชำระที่ตะกร้า${plan.rowOnly.length ? ` · ${plan.rowOnly.join(' · ')} กดที่แถวด้านล่าง (ต้องเลือกแบบ/รอบ หรือจ่ายเต็ม)` : ''}`);
  };
  const complete = plan.mine > 0 && plan.missing.length === 0;
  return (
    <div className="mt-3">
      {plan.mine > 0 && (
        <div className="mb-2 rounded-xl border border-[#16a34a]/40 bg-gradient-to-br from-[#0f2416] to-[#121a14] p-3">
          <div className="flex items-center gap-2 text-[14px] font-extrabold">🧩 {name} {plan.mine}/{plan.total} ตัว{complete && <span className="ml-auto text-[12px] text-[#4ade80]">ครบเซตแล้ว 🎉</span>}</div>
          <div className="mt-2 flex gap-1.5">
            {shown.filter((s) => s.state.visible).map((s) => <i key={s.member.id} className={cx('h-[7px] flex-1 rounded-full', s.state.mine ? 'bg-[#4ade80]' : 'bg-white/[0.12]')} />)}
          </div>
          {!complete && (
            <div className="mt-1.5 text-[12px] text-ink-muted2">ยังขาด <b className="text-ink">{plan.missing.map((m) => m.name).join(' · ')}</b>{plan.missingDeposit > 0 && <> · มัดจำรวม <b className="text-ink">{baht(plan.missingDeposit)}</b></>}</div>
          )}
        </div>
      )}
      {plan.addable.length > 0 ? (
        <button onClick={addAll} className="w-full animate-pulseRed rounded-xl bg-cta px-4 py-3 text-[14.5px] font-extrabold text-white shadow-cta">
          {plan.mine > 0 ? `พรีที่เหลือทั้ง ${plan.addable.length} ตัว` : `พรีทั้งเซต ${plan.addable.length} ตัว`} · มัดจำ {baht(plan.deposit)}
        </button>
      ) : plan.inCart > 0 && !preview ? (
        <Link href="/cart" className="block w-full rounded-xl border border-[#16a34a]/50 bg-[#16a34a]/15 px-4 py-3 text-center text-[14px] font-extrabold text-[#4ade80]">อยู่ในตะกร้าแล้ว {plan.inCart} ตัว ✓ ไปชำระ</Link>
      ) : null}
    </div>
  );
}

function MemberRow({ member, no, state, thumb, hi, preview }: { member: LineMember; no: number; state: LineMemberState; thumb?: string; hi: boolean; preview: boolean }) {
  const db = useDatabase();
  const cart = useCart();
  const { flash } = useToast();
  const meId = useCurrentUserId();
  const { checking, ensure } = useLiveStock();
  const strong = state.kind === 'stock' || state.kind === 'special' || state.kind === 'preorder';
  const btnCls = cx('shrink-0 rounded-[10px] px-3.5 py-2 text-[12.5px] font-extrabold', strong ? 'animate-pulseRed bg-cta text-white shadow-cta' : 'border border-subtle bg-surface-3 text-ink');
  const cta = state.cta;
  // กดพรี/ซื้อ = ใส่ตะกร้าเลย ไม่เด้งไปหน้าอื่น แล้วปุ่มกลายเป็น "อยู่ในตะกร้าแล้ว" กันกดซ้ำ (เจ้าของ 2026-10-08)
  //   ทำได้เฉพาะของที่ไม่ต้องเลือกอะไรเพิ่ม: พรีกระดานหลัก / ของพร้อมส่ง ที่ไม่มีแบบ A/B — รอบพิเศษ (มีด่านใบพรี+โควตา)
  //   และสินค้าที่มีแบบ ยังพาไปหน้าสินค้าเหมือนเดิม
  const p = state.product;
  const quick = !preview && !!p && !p.has_variants && (state.kind === 'preorder' || state.kind === 'stock');
  const inCart = !!p && cart.lines.some((l) => l.productId === p.id && !l.batchId && !l.variantId);
  const addNow = async () => {
    if (!p) return;
    if (p.is_stock && !(await ensure(p.id, undefined, myPendingHold(db, meId, p.id)))) return;
    cart.add({ productId: p.id, depositEach: p.is_stock ? p.price_total : p.deposit_amount, priceEach: p.price_total });
    flash(p.is_stock ? 'ใส่ตะกร้าแล้ว ✓ ไปจ่ายเงินได้ที่ตะกร้า' : 'ใส่ตะกร้าแล้ว ✓ พรีต่อตัวอื่นได้เลย แล้วค่อยไปชำระที่ตะกร้า');
  };
  return (
    <div id={`lm-${member.id}`} className={cx('flex items-center gap-3 rounded-card border bg-surface-2 p-2.5 transition-colors', hi ? 'border-white/50 bg-surface-4' : 'border-subtle')}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-extrabold text-[#0b0b0e]" style={{ background: TONE_HEX[state.tone] }}>{no}</span>
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-subtle bg-stripe">
        {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-extrabold">{member.name.trim() || `ตัวที่ ${no}`}</div>
        {/* เปิดรับพรีอยู่ → คำ "Pre-Order" กระพริบ (เจ้าของ 2026-10-12) · พรีไปแล้วไม่กระพริบ (ป้ายเขียวด้านล่างบอกแทน) */}
        <div className="truncate text-[11.5px] text-ink-muted2">
          {state.kind === 'preorder' && state.detail.endsWith(' · Pre-Order')
            ? <>{state.detail.slice(0, -'Pre-Order'.length)}<span className={cx('font-extrabold text-[#60a5fa]', !state.mine && 'animate-pulse')}>Pre-Order</span></>
            : state.detail}
        </div>
        {state.alt && !preview && <Link href={state.alt.href} className="mt-0.5 block truncate text-[11px] font-bold text-primary-soft">{state.alt.label}</Link>}
        {state.alt && preview && <span className="mt-0.5 block truncate text-[11px] font-bold text-primary-soft">{state.alt.label}</span>}
        {/* พรีไปแล้ว = ป้ายเขียวสั้นๆ "พรีแล้ว ✓" (เจ้าของ 2026-10-08 ต้องเตือนกันสั่งซ้ำ · 2026-10-16 ตัด "คุณมีตัวนี้แล้ว" ออก) · รวมออเดอร์ที่สลิปยังรอตรวจ */}
        {state.mine && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#16a34a]/20 px-2 py-0.5 text-[11px] font-extrabold text-[#4ade80]">
            {state.pinLabel.startsWith('ซื้อ') ? 'ซื้อแล้ว ✓' : 'พรีแล้ว ✓'}
          </span>
        )}
      </div>
      {cta && (preview
        // พรีวิวในแอดมิน: ปุ่มหน้าตาเหมือนจริงแต่ไม่พาออกจากหน้าแก้ไข
        ? <span className={btnCls}>{cta.label}</span>
        : quick && inCart
          ? <Link href="/cart" className="shrink-0 rounded-[10px] border border-[#16a34a]/50 bg-[#16a34a]/15 px-3 py-2 text-[12px] font-extrabold text-[#4ade80]">อยู่ในตะกร้าแล้ว ✓</Link>
        : quick && state.mine
          // พรีไปแล้ว: ปุ่มหลักไม่กระพริบไม่แดง — สั่งเพิ่มได้แต่ต้องตั้งใจ
          ? <button onClick={() => void addNow()} disabled={checking} className="shrink-0 rounded-[10px] border border-subtle bg-surface-3 px-3 py-2 text-[12px] font-bold text-ink-muted2 disabled:opacity-60">{checking ? 'เช็คของ…' : 'สั่งเพิ่มอีกตัว'}</button>
        : quick
          ? <button onClick={() => void addNow()} disabled={checking} className={cx(btnCls, 'disabled:animate-none disabled:opacity-60')}>{checking ? 'เช็คของ…' : cta.label}</button>
        : cta.external
          ? <a href={cta.href} target="_blank" rel="noreferrer" className={btnCls}>{cta.label}</a>
          : <Link href={cta.href} className={btnCls}>{cta.label}</Link>)}
    </div>
  );
}
