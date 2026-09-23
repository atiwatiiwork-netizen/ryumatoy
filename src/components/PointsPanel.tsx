'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { balanceOf, lifetimeOf, ledgerOf, KIND_LABEL, rawPointsForTicket, pointsRates, pointsVisibleTo, ticketEarnEligible, hasEarned, redeemRules, redeemEnabled, redeemFlag, batchPoints, SPECIAL_ROUND_POINTS_DEFAULT } from '@/domain/services/points';
import type { Database } from '@/domain/entities';
import { monthlyConfig, currentYm, ymLabel, ymShort, monthlyStatus, latestRankOf, monthlyBonusForTicket, sharePerPiece } from '@/domain/services/monthly';
import { isStaffAccount } from '@/domain/services/admins';
import { activeCampaign } from '@/domain/services/campaigns';
import { missionLive } from '@/domain/services/missions';
import { ticketDue } from '@/domain/services/money';
import { productLabel } from '@/domain/services/catalog';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const num = (n: number) => n.toLocaleString('en-US');

/**
 * หน้าคะแนนสะสมของลูกค้า — **คอมโพเนนต์เดียว ใช้ 2 ที่** (เจ้าของ 2026-09-12 "พรีวิวแอดมินต้องลิงก์กับหน้าลูกค้า"):
 *   · /points (ลูกค้าจริง)                → mode 'live'
 *   · /admin/points "พรีวิวหน้าลูกค้า"    → mode 'preview' (เลือกลูกค้าได้ + จำลองว่าเปิดระบบแล้ว)
 * DNA: ห้ามก๊อปปี้ UI ไปวาดใหม่ในแอดมิน — แก้ที่นี่ที่เดียว ทั้งสองที่เปลี่ยนพร้อมกันเสมอ
 * DNA: ตัวเลขทุกตัวมาจาก points.ts / monthly.ts — คอมโพเนนต์นี้ไม่คำนวณเอง
 *
 * Phase 1 (เจ้าของ 2026-09-12 ค่ำ): คะแนนปิดใบ/พร้อมส่ง · รอบเดือน = ยศ + "N ใบแรกตามลำดับอนุมัติ" ได้ส่วนลดตอนปิดใบ ·
 *   ใช้แต้มตอนปิดใบ (200/ใบ) / พร้อมส่ง (400/ออเดอร์) · wording: ยอดสะสม · ใบพรี: x ใบ · แลกใช้ได้
 * เปิดตัว (เจ้าของ 2026-09-12 ค่ำ): โชว์แต้มจากใบพรีที่ปิดแล้ว (อัตราพร้อมส่ง = 0 → ซ่อนบรรทัดพร้อมส่ง) · สวิตช์ใช้แต้มยังปิด → "แลกใช้ได้: เร็วๆ นี้"
 * ธีม: Elden Ring แดง-ทอง-ดำ (eldenReveal / lineGrow / goldShine / ember / tierGlow) · ปิดเมื่อ reduced-motion
 */
export function PointsPanel({ userId, mode = 'live', simulateEnabled, dbOverride }: {
  userId: string;
  mode?: 'live' | 'preview';
  simulateEnabled?: boolean;
  /** พรีวิวแอดมิน "หลังกดเปิดตัว": ส่ง db จำลอง (launchPointsPreOnly บนสำเนา) → เห็นแต้มย้อนหลังจริงของลูกค้าคนนั้น */
  dbOverride?: Database;
}) {
  const liveDb = useDatabase();
  const db = dbOverride ?? liveDb;
  const uid = userId;
  const s = db.settings;
  const rate = pointsRates(s);
  const rules = { pre: redeemRules(s, 'pre'), special: redeemRules(s, 'special'), instock: redeemRules(s, 'instock') };
  const simulating = mode === 'preview' && simulateEnabled === true;
  const enabled = simulating ? true : s.points_enabled;
  const visible = mode === 'preview' ? enabled : pointsVisibleTo(db, uid);
  // สวิตช์ 2 "ใช้แต้มตัดยอด" (เจ้าของ 2026-09-12 ค่ำ): เปิดตัวแบบโชว์แต้มก่อน → ส่วน "แลกใช้ได้" บอกว่าเร็วๆ นี้
  // พรีวิวต้องตรงความจริง (เจ้าของ 2026-09-23 "ลูกค้าจะเห็นยังไง"): จำลองว่าเปิดระบบ ≠ เปิดใช้แต้ม → ดูสวิตช์ใช้แต้มจริง
  const canRedeem = simulating ? redeemFlag(db) : redeemEnabled(db);
  // บัญชีทีมงานจริงเท่านั้น (ไม่ใช่ทุกคนในโหมด seed) — โหมดจำลองดูเป็นลูกค้าต้องเห็นเหมือนลูกค้าจริงเป๊ะ
  const adminPreview = mode === 'live' && isStaffAccount(db, uid);

  const balance = balanceOf(db, uid);
  const lifetime = lifetimeOf(db, uid);
  const rows = ledgerOf(db, uid);

  // รอบเดือน (monthly.ts): เดือนนี้ (สด) + ยศล่าสุดที่ปิดแล้ว (snapshot) + ใบที่ได้ส่วนลด
  const mcfg = monthlyConfig(db);
  const ym = currentYm();
  const live = monthlyStatus(db, uid, ym, mcfg);
  const latest = latestRankOf(db, uid);
  const rewardTickets = latest ? latest.snap.tickets.map((id) => db.tickets.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t) : [];
  const showMonthly = mcfg.enabled || adminPreview || simulating;
  // "รางวัลสะสม" บอกเฉพาะทางที่ให้แต้มจริงตอนนี้ (audit 2026-09-23: Event/ภารกิจที่ยังแจกคูปองบาท ห้ามบอกว่าได้แต้ม)
  const liveEvent = activeCampaign(db);
  const liveMission = missionLive(db);
  // รอบพิเศษ: คะแนนต่อใบตั้งต่อรอบ (+20/+40) — โชว์ค่าของรอบที่เปิดอยู่ (ไม่มีรอบเปิด = ค่าเริ่มต้น)
  const specialVals = [...new Set(db.batches.filter((b) => b.status === 'open' && b.label !== 'หาของ').map((b) => batchPoints(db, b.id)))].sort((a, b) => a - b);
  const specialText = specialVals.length > 1 ? `+${specialVals.join(' / +')} คะแนน/ใบ (ตามรอบ)` : `+${specialVals[0] ?? SPECIAL_ROUND_POINTS_DEFAULT} คะแนน/ใบ`;
  // ตัวอย่างการใช้แต้ม (เจ้าของ 2026-09-23): ราคา 1,600 มัดจำ 300 → ของมาเหลือ 1,300 → ใช้ 200 → จ่าย 1,100
  const exPrice = 1600, exDep = 300, exDue = exPrice - exDep;
  const rewardLive = liveEvent?.reward_scope === 'points' || (!!liveMission && db.coupons.find((c) => c.id === liveMission.reward_coupon_id)?.scope === 'points');
  const rewardSources = [
    liveEvent?.reward_scope === 'points' ? `Event ${liveEvent.name}` : null,
    liveMission && db.coupons.find((c) => c.id === liveMission.reward_coupon_id)?.scope === 'points' ? 'ภารกิจ' : null,
    'คูปองแต้มจากร้าน',
  ].filter(Boolean).join(' / ');

  const pending = db.tickets
    .filter((t) => t.owner_id === uid && ticketDue(t) > 0 && ticketEarnEligible(db, { ...t, remaining_paid: t.remaining_amount }).ok)
    .map((t) => ({ t, pts: rawPointsForTicket(db, t), due: ticketDue(t), bonus: monthlyBonusForTicket(db, t) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => a.due - b.due);
  const pendingPts = pending.reduce((a, x) => a + x.pts, 0);
  const awaiting = db.tickets.filter((t) => t.owner_id === uid && ticketEarnEligible(db, t).ok && !hasEarned(db, t.id) && rawPointsForTicket(db, t) > 0);

  if (!visible) {
    return (
      <div className="relative overflow-hidden rounded-card border border-[#d4af37]/25 bg-[#0b0708] p-8 text-center">
        <Embers count={6} />
        <div className="relative text-[34px] drop-shadow-[0_0_12px_rgba(212,175,55,.6)]">⭐</div>
        <div className="relative mt-2 text-[15px] font-bold tracking-[.18em] text-[#f1d27a] motion-safe:animate-eldenReveal">ระบบคะแนนสะสมกำลังจะมา</div>
        <div className="relative mt-1 text-[12.5px] text-ink-muted2">ร้านจะประกาศวันเริ่มใช้อีกครั้ง</div>
      </div>
    );
  }

  return (
    <>
      {!enabled && (
        <div className="mb-3 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.10] px-3.5 py-2.5 text-[12.5px] text-[#fbbf24]">
          🔧 ระบบคะแนนอยู่ในช่วงทดสอบ — ตัวเลขที่เห็นเป็นพรีวิว ร้านจะประกาศวันเริ่มใช้จริงอีกครั้ง
        </div>
      )}

      <div className="mb-3 text-center">
        <div className="text-[11px] font-bold uppercase tracking-[.18em] text-[#f1d27a]/90 motion-safe:animate-eldenReveal">✦ RYUMA POINTS ✦</div>
        <div className="mx-auto mt-1.5 h-px w-40 origin-center bg-gradient-to-r from-transparent via-[#d4af37] to-transparent motion-safe:animate-lineGrow" />
      </div>

      {/* ── การ์ดคะแนน ── */}
      <div className="relative mb-4 overflow-hidden rounded-2xl border border-[#d4af37]/40 bg-[#0b0708] p-5 shadow-[inset_0_0_0_1px_rgba(0,0,0,.6),inset_0_0_0_3px_rgba(212,175,55,.12),0_18px_50px_-20px_rgba(185,28,28,.55)]">
        <div className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(185,28,28,.42),transparent_65%)]" />
        <div className="pointer-events-none absolute -bottom-28 -right-10 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(212,175,55,.22),transparent_65%)]" />
        <Embers count={10} />
        <Rune className="left-2 top-1.5" /><Rune className="right-2 top-1.5" /><Rune className="bottom-1.5 left-2" /><Rune className="bottom-1.5 right-2" />

        <div className="relative flex items-start justify-between">
          <div>
            <div className="text-[11px] font-bold tracking-[.14em] text-[#f1d27a]/75">คะแนนใช้ได้</div>
            <div className="mt-0.5 flex items-end gap-2">
              <span className="bg-[linear-gradient(90deg,#b8860b,#f7e39b,#d4af37,#fff2b8,#b8860b)] bg-[length:200%_100%] bg-clip-text text-[44px] font-extrabold leading-none text-transparent drop-shadow-[0_0_14px_rgba(212,175,55,.45)] motion-safe:animate-goldShine">{num(balance)}</span>
              <span className="pb-1.5 text-[13px] text-ink-muted2">≈ ฿{num(balance)}</span>
            </div>
          </div>
          {showMonthly && (
            <div className={cx('rounded-xl border px-3 py-2 text-center', latest ? 'border-[#d4af37]/50 bg-black/40 motion-safe:animate-tierGlow' : 'border-subtle bg-black/30')}>
              <div className="text-[10px] tracking-[.12em] text-ink-faint">{latest ? `ยศ ${ymShort(latest.ym)}` : 'ยศล่าสุด'}</div>
              <div className="text-[22px] leading-none">{latest?.snap.tier.emoji ?? '🕯️'}</div>
              <div className={cx('mt-1 text-[11px] font-bold', latest ? 'text-[#f1d27a]' : 'text-ink-faint')}>{latest?.snap.tier.label ?? 'ยังไม่มียศ'}</div>
            </div>
          )}
        </div>
        <div className="relative mt-4 grid grid-cols-3 gap-2 text-[11.5px] text-ink-muted2">
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">ยอดสะสม</div><b className="text-[#f1d27a]">{num(lifetime)}</b></div>
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">รอปิดใบ</div><b className="text-[#fbbf24]">+{num(pendingPts)}</b></div>
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">แลกใช้ได้</div>{canRedeem ? <b className="text-[11px] leading-tight text-ink">ส่วนลดส่วนต่างใบพรี / ของพร้อมส่ง</b> : <b className="text-[11px] leading-tight text-[#fbbf24]">เร็วๆ นี้ · ร้านจะประกาศ</b>}</div>
        </div>
      </div>

      {/* ── รอบเดือน: เดือนนี้ (สด) ── */}
      {showMonthly && (
        <div className={cx('relative mb-4 overflow-hidden rounded-card border bg-[#0d0909] p-4', mcfg.enabled ? 'border-[#d4af37]/30' : 'border-dashed border-[#d4af37]/40')}>
          {!mcfg.enabled && <div className="mb-2 rounded-md bg-[#d4af37]/[0.12] px-2 py-1 text-[11px] font-bold text-[#f1d27a]">🔒 พรีวิวแอดมิน — ลูกค้ายังไม่เห็นส่วนนี้ (เปิดที่ /admin/points/monthly)</div>}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[#f1d27a]">🏆 รางวัลประจำเดือน · {ymLabel(ym)}</span>
            <span className="text-[11.5px] text-ink-faint">ใบพรี: <b className="text-ink">{live.pieces}</b> ใบ</span>
          </div>
          <div className="mb-2 text-[11.5px] text-ink-faint">
            {live.next
              ? <>อีก <b className="text-[#fbbf24]">{live.need}</b> ใบ → {live.next.emoji} {live.next.label} <b className="text-[#4ade80]">ลดใบละ {num(sharePerPiece(live.next))}</b></>
              : <span className="font-bold text-[#f1d27a]">ถึงยศสูงสุดของเดือนแล้ว</span>}
            <span className="ml-1">· สรุปสิ้นเดือน</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full border border-[#d4af37]/25 bg-black/60">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#7f1d1d,#d4af37,#f7e39b,#d4af37)] bg-[length:200%_100%] motion-safe:animate-goldShine" style={{ width: `${live.pct}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {mcfg.tiers.map((m) => {
              const got = live.pieces >= m.pieces;
              return (
                <div key={m.pieces} className={cx('relative rounded-xl border p-2.5 text-center', got ? 'border-[#d4af37]/50 bg-[#d4af37]/[0.10] motion-safe:animate-tierGlow' : 'border-white/10 bg-black/30 opacity-75')}>
                  <div className={cx('text-[22px] leading-none', got && 'drop-shadow-[0_0_10px_rgba(212,175,55,.7)]')}>{m.emoji}</div>
                  <div className={cx('mt-1 text-[12.5px] font-extrabold tracking-wide', got ? 'text-[#f1d27a]' : 'text-ink-muted2')}>{m.label}</div>
                  <div className="text-[10.5px] text-ink-faint">{m.pieces} ใบ</div>
                  <div className={cx('mt-1 text-[12px] font-extrabold', got ? 'text-[#4ade80]' : 'text-ink-muted2')}>ลดใบละ {num(sharePerPiece(m))}</div>
                  <div className="text-[10px] text-ink-faint">รวม {num(sharePerPiece(m) * m.pieces)}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10.5px] text-ink-faint">สิ้นเดือนระบบสรุปยศจากใบที่ร้านอนุมัติในเดือนนี้ · รางวัลผูกกับ {mcfg.tiers.map((m) => m.pieces).join('/')} ใบแรกตามลำดับอนุมัติ → <b className="text-ink-muted2">ปิดใบไหน ลดใบนั้นอัตโนมัติ</b></div>
        </div>
      )}

      {/* ── ยศล่าสุด: ใบที่ได้ส่วนลด ── */}
      {showMonthly && latest && (
        <div className="mb-4 rounded-card border border-[#d4af37]/30 bg-[#0d0909] p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[#f1d27a]">{latest.snap.tier.emoji} ยศ {latest.snap.tier.label} · {ymLabel(latest.ym)}</span>
            <span className="text-[11.5px] text-ink-faint">พรี {latest.snap.pieces} ใบ</span>
          </div>
          <div className="mb-2 text-[11.5px] text-ink-muted2">ส่วนลด <b className="text-[#4ade80]">{num(latest.snap.share)} บาท/ใบ</b> ใน {latest.snap.tickets.length} ใบแรกที่ร้านอนุมัติ — หักให้เองตอนปิดใบ</div>
          <div className="flex flex-col divide-y divide-hair">
            {rewardTickets.map((t) => {
              const b = monthlyBonusForTicket(db, t);
              const transferred = !b && t.owner_id !== (t.original_buyer_id || t.owner_id);
              const closed = ticketDue(t) <= 0;
              const label = transferred ? 'ใบถูกโอน — ไม่ได้ส่วนลด' : b?.applied ? (closed ? `ใช้แล้ว −${num(b.amount)}` : `ให้เป็นแต้มแล้ว +${num(b.amount)}`) : closed ? 'ปิดใบแล้ว' : `รอปิดใบ → ลด ${num(b?.amount ?? 0)}`;
              return (
                <div key={t.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                  <span className="w-[118px] shrink-0 font-mono text-[10.5px] text-ink-faint">{t.ticket_no}</span>
                  <span className="min-w-0 flex-1 truncate">{productLabel(db, t.product_id, t.variant_id)}</span>
                  <span className={cx('shrink-0 text-[11px] font-bold', b?.applied ? 'text-[#4ade80]' : transferred ? 'text-ink-faint' : 'text-[#fbbf24]')}>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* วิธีได้คะแนน (เจ้าของ 2026-09-23: ปิดใบพรีรอบปกติ 20 · รอบพิเศษ 40 · ยอดสะสมรายเดือน) */}
      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px] text-ink-muted2">
        <div className="mb-1.5 text-[13.5px] font-bold text-ink">วิธีได้คะแนน</div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2"><span className="w-5 text-center">📝</span><span className="flex-1">ปิดใบพรี (รอบปกติ)</span><b className="text-[#f1d27a]">+{rate.pre} คะแนน/ใบ</b></div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">⚡</span><span className="flex-1">ปิดใบพรี รอบพิเศษ</span><b className="text-[#f1d27a]">{specialText}</b></div>
          <div className="flex items-start gap-2">
            <span className="w-5 text-center">🏆</span>
            <span className="flex-1">ยอดสะสมรายเดือน — ยศ {mcfg.tiers.map((t) => t.label).join(' / ')}<span className="block text-[11px] text-ink-faint">พรีครบ {mcfg.tiers.map((t) => t.pieces).join(' / ')} ใบในเดือน · สรุปยศทุกสิ้นเดือน</span></span>
            {mcfg.enabled
              ? <b className="text-[#f1d27a]">ลดใบละ {mcfg.tiers.map((t) => num(sharePerPiece(t))).join(' · ')}</b>
              : <b className="text-[#fbbf24]">เร็วๆ นี้</b>}
          </div>
          {rate.instock > 0 && <div className="flex items-center gap-2"><span className="w-5 text-center">🛒</span><span className="flex-1">ซื้อของพร้อมส่ง</span><b className="text-[#f1d27a]">+{rate.instock} คะแนน/ใบ</b></div>}
          {rewardLive && <div className="flex items-center gap-2"><span className="w-5 text-center">🎁</span><span className="flex-1">รางวัลกิจกรรม — {rewardSources}</span><b className="text-[#f1d27a]">เข้าแต้มทันที</b></div>}
        </div>
      </div>

      {/* วิธีใช้คะแนน (เจ้าของ 2026-09-23) — ใช้ตอนจ่าย ไม่ใช้กับมัดจำ · ปิดสวิตช์ใช้แต้ม = เร็วๆ นี้ */}
      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px] text-ink-muted2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[13.5px] font-bold text-ink">วิธีใช้คะแนน</span>
          <span className={cx('rounded-md px-2 py-0.5 text-[11px] font-bold', canRedeem ? 'bg-[#16a34a]/[0.16] text-[#4ade80]' : 'bg-[#d97706]/[0.16] text-[#fbbf24]')}>{canRedeem ? 'ใช้ได้แล้ว' : 'เร็วๆ นี้ · ร้านจะประกาศ'}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2"><span className="w-5 text-center">📝</span><span className="flex-1">ปิดใบพรี (รอบปกติ)</span><b className="text-ink">สูงสุด {num(rules.pre.cap)} คะแนน/ใบ</b></div>
          <div className="ml-7 rounded-lg border border-white/5 bg-black/30 px-3 py-2 text-[11.5px] leading-relaxed">
            <div className="font-bold text-ink-muted">ตัวอย่าง</div>
            <div>ราคา {num(exPrice)} · มัดจำ {num(exDep)} → ของมาเหลือจ่าย <b className="text-ink">{num(exDue)}</b></div>
            <div>ใช้ {num(rules.pre.cap)} คะแนน → จ่ายเพียง <b className="text-[#4ade80]">{num(Math.max(0, exDue - rules.pre.cap))}</b></div>
          </div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">⚡</span><span className="flex-1">ปิดใบพรี รอบพิเศษ</span><b className="text-ink">สูงสุด {num(rules.special.cap)} คะแนน/ใบ</b></div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">🛒</span><span className="flex-1">ซื้อของพร้อมส่ง</span><b className="text-ink">สูงสุด {num(rules.instock.cap)} คะแนน/ใบ</b></div>
          <div className="mt-1 text-[11px] text-ink-faint">1 คะแนน = 1 บาท · ใช้ครั้งละอย่างน้อย {rules.pre.min} (ขั้นละ 50) · ใช้ตอนจ่ายส่วนต่าง/ซื้อพร้อมส่ง ไม่ใช้กับมัดจำ{!canRedeem && ' — ร้านจะประกาศวันเปิดใช้แต้มอีกครั้ง'}</div>
        </div>
      </div>

      {/* pending tickets */}
      {pending.length > 0 && (
        <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13.5px] font-bold">⏳ จะได้เมื่อปิดใบ</span>
            <span className="text-[12px] font-bold text-[#fbbf24]">+{num(pendingPts)} คะแนน</span>
          </div>
          <div className="flex flex-col divide-y divide-hair">
            {pending.map(({ t, pts, due, bonus }) => {
              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                    <div className="text-[11px] text-ink-faint">{t.ticket_no} · ค้าง ฿{num(Math.round(due))}{bonus && !bonus.applied ? <span className="ml-1 text-[#4ade80]">· ลด {num(bonus.amount)} ({bonus.tier.emoji} {ymShort(bonus.ym)})</span> : null}</div>
                  </div>
                  <span className="font-extrabold text-[#fbbf24]">+{num(pts)}</span>
                  <Icon name="chevronRight" size={16} className="text-ink-faint" />
                </>
              );
              return mode === 'preview'
                ? <div key={t.id} className="flex items-center gap-3 py-2 text-[12.5px]">{inner}</div>
                : <Link key={t.id} href={`/wallet/${t.ticket_no}`} className="flex items-center gap-3 py-2 text-[12.5px]">{inner}</Link>;
            })}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px]">
          <div className="mb-1 text-[13.5px] font-bold">🕰️ ใบพรีที่ปิดแล้ว {awaiting.length} ใบ</div>
          <div className="text-ink-muted2">รอร้านยืนยันคะแนนย้อนหลัง (รวม <b className="text-ink">{num(awaiting.reduce((a, t) => a + rawPointsForTicket(db, t), 0))}</b> คะแนน)</div>
        </div>
      )}

      {/* history */}
      <div className="mb-6 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-2 text-[13.5px] font-bold">📒 ประวัติคะแนน</div>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีประวัติ — {rate.instock > 0 ? 'ปิดใบพรีหรือซื้อของพร้อมส่ง' : 'ปิดใบพรี'}เพื่อเริ่มสะสม</div>
        ) : (
          <div className="flex flex-col divide-y divide-hair">
            {rows.map((e) => {
              const k = KIND_LABEL[e.kind] ?? { label: e.kind, emoji: '•' };
              return (
                <div key={e.id} className="flex items-start gap-3 py-2 text-[12.5px]">
                  <span className="w-[74px] shrink-0 text-[11px] text-ink-faint">{fmtDate(e.created_at)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{k.emoji} {k.label}</div>
                    {e.note && <div className="truncate text-[11px] text-ink-faint">{e.note}</div>}
                  </div>
                  <span className={cx('shrink-0 font-extrabold tabular-nums', e.delta > 0 ? 'text-[#4ade80]' : 'text-primary-soft')}>{e.delta > 0 ? `+${num(e.delta)}` : num(e.delta)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** ถ่านไฟลอย (ember) — ตำแหน่ง/ดีเลย์คงที่จาก index (กัน hydration mismatch) */
export function Embers({ count }: { count: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden" aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const left = ((i * 37) % 97) + 1;
        const delay = (i * 0.47) % 3.4;
        const dur = 3 + ((i * 0.83) % 2.2);
        const size = 2 + (i % 3);
        const gold = i % 3 !== 0;
        return (
          <span key={i} className="absolute bottom-2 block rounded-full animate-ember"
            style={{ left: `${left}%`, width: size, height: size, animationDelay: `${delay}s`, animationDuration: `${dur}s`, background: gold ? '#f1d27a' : '#ef4444', boxShadow: gold ? '0 0 6px 1px rgba(241,210,122,.8)' : '0 0 6px 1px rgba(239,68,68,.7)' }} />
        );
      })}
    </div>
  );
}

export function Rune({ className }: { className: string }) {
  return <span aria-hidden className={cx('pointer-events-none absolute text-[10px] text-[#d4af37]/70 motion-safe:animate-runePulse', className)}>✦</span>;
}
