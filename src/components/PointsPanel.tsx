'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { balanceOf, lifetimeOf, ledgerOf, KIND_LABEL, rawPointsForTicket, pointsRates, pointsVisibleTo, ticketEarnEligible, hasEarned } from '@/domain/services/points';
import { monthlyConfig, monthlyPieces, tierFor, currentYm, ymLabel, monthlyRewardsFor } from '@/domain/services/monthly';
import { isAdminUser } from '@/domain/services/admins';
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
 * Wording (เจ้าของ 2026-09-12): "ยอดสะสม" · "ใบพรี: x ใบ" · "แลกใช้ได้: ส่วนลดส่วนต่างใบพรี / ของพร้อมส่ง" ·
 *   ยศ Bronze/Silver/Gold (5/10/20 ใบ → +100/+250/+600) · วิธีได้คะแนน 4 ทาง (ปิดใบพรี / ซื้อพร้อมส่ง /
 *   รางวัลประจำเดือน / รางวัลสะสม)
 * ธีม: "จัดเต็ม Effect สไตล์ Elden Ring" แดง-ทอง-ดำ — ป้ายเผยตัว (eldenReveal) · เส้นทองงอก (lineGrow) ·
 *   ตัวเลขทองไหล (goldShine) · ถ่านไฟลอย (ember) · การ์ดยศที่ถึงแล้วเรืองทอง (tierGlow) · ปิดเมื่อ reduced-motion
 */
export function PointsPanel({ userId, mode = 'live', simulateEnabled }: {
  userId: string;
  /** live = ผู้ใช้จริง (แอดมินเห็นส่วนพรีวิวเพิ่ม) · preview = "มุมลูกค้าล้วน" ไม่มีส่วนแอดมินเด็ดขาด */
  mode?: 'live' | 'preview';
  /** preview เท่านั้น: จำลองว่าเปิดสวิตช์แล้ว (ดูหน้าที่ลูกค้าจะเห็นหลังเปิด) — undefined = ตามค่าจริง */
  simulateEnabled?: boolean;
}) {
  const db = useDatabase();
  const uid = userId;
  const s = db.settings;
  const rate = pointsRates(s); // อัตราต่อใบ (มี fallback) — โชว์ตัวเลขผ่านตัวนี้เท่านั้น
  const simulating = mode === 'preview' && simulateEnabled === true;
  const enabled = simulating ? true : s.points_enabled;
  // เจ้าของ 2026-09-12: ซ่อนจากลูกค้าจนกว่าจะเปิดสวิตช์
  const visible = mode === 'preview' ? enabled : pointsVisibleTo(db, uid);
  const adminPreview = mode === 'live' && isAdminUser(db, uid);

  const balance = balanceOf(db, uid);
  const lifetime = lifetimeOf(db, uid);
  const rows = ledgerOf(db, uid);

  // รางวัลประจำเดือน / ยศ (monthly.ts) — ลูกค้าเห็นเมื่อเปิดใช้ · แอดมิน/พรีวิวจำลอง เห็นเสมอ (มีป้ายบอก)
  const mcfg = monthlyConfig(db);
  const ym = currentYm();
  const pieces = monthlyPieces(db, uid, ym, mcfg);
  const tier = tierFor(mcfg, pieces);
  const rewards = monthlyRewardsFor(db, uid, ym, mcfg);
  const rewardDue = rewards.filter((r) => !r.paid).reduce((a, r) => a + r.tier.points, 0);
  const showMonthly = mcfg.enabled || adminPreview || simulating;

  // ใบพรีที่ยังค้าง → "จะได้" เท่าไหร่เมื่อปิดใบ (คะแนนคงที่ต่อใบ × qty)
  const pending = db.tickets
    .filter((t) => t.owner_id === uid && ticketDue(t) > 0 && ticketEarnEligible(db, { ...t, remaining_paid: t.remaining_amount }).ok)
    .map((t) => ({ t, pts: rawPointsForTicket(s, t), due: ticketDue(t) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => a.due - b.due);
  const pendingPts = pending.reduce((a, x) => a + x.pts, 0);
  // ใบที่ปิดแล้วแต่ยังไม่ได้ (ก่อนเปิดระบบ) — โชว์เป็น "รอร้านยืนยัน" ไม่ใช่ตัวเลขคงเหลือ
  const awaiting = db.tickets.filter((t) => t.owner_id === uid && ticketEarnEligible(db, t).ok && !hasEarned(db, t.id) && rawPointsForTicket(s, t) > 0);

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

      {/* ── ป้ายหัวเรื่องแบบ Elden Ring: เผยตัวช้าๆ + เส้นทองงอก ── */}
      <div className="mb-3 text-center">
        <div className="text-[11px] font-bold uppercase tracking-[.18em] text-[#f1d27a]/90 motion-safe:animate-eldenReveal">✦ RYUMA POINTS ✦</div>
        <div className="mx-auto mt-1.5 h-px w-40 origin-center bg-gradient-to-r from-transparent via-[#d4af37] to-transparent motion-safe:animate-lineGrow" />
      </div>

      {/* ── การ์ดคะแนน: ดำ-แดงเรือง ขอบทองซ้อน มุมรูน ถ่านไฟลอย ── */}
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
            <div className={cx('rounded-xl border px-3 py-2 text-center', tier.reached ? 'border-[#d4af37]/50 bg-black/40 motion-safe:animate-tierGlow' : 'border-subtle bg-black/30')}>
              <div className="text-[10px] tracking-[.12em] text-ink-faint">ยศเดือนนี้</div>
              <div className="text-[22px] leading-none">{tier.reached?.emoji ?? '🕯️'}</div>
              <div className={cx('mt-1 text-[11px] font-bold', tier.reached ? 'text-[#f1d27a]' : 'text-ink-faint')}>{tier.reached?.label ?? 'ยังไม่มียศ'}</div>
            </div>
          )}
        </div>
        <div className="relative mt-4 grid grid-cols-3 gap-2 text-[11.5px] text-ink-muted2">
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">ยอดสะสม</div><b className="text-[#f1d27a]">{num(lifetime)}</b></div>
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">รอปิดใบ</div><b className="text-[#fbbf24]">+{num(pendingPts)}</b></div>
          <div className="rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5"><div className="text-ink-faint">แลกใช้ได้</div><b className="text-[11px] leading-tight text-ink">ส่วนลดส่วนต่างใบพรี / ของพร้อมส่ง</b></div>
        </div>
      </div>

      {/* ── รางวัลประจำเดือน: พรีครบ X ใบ/เดือน → ยศ + คะแนนโบนัส (monthly.ts) ── */}
      {showMonthly && (
        <div className={cx('relative mb-4 overflow-hidden rounded-card border bg-[#0d0909] p-4', mcfg.enabled ? 'border-[#d4af37]/30' : 'border-dashed border-[#d4af37]/40')}>
          {!mcfg.enabled && <div className="mb-2 rounded-md bg-[#d4af37]/[0.12] px-2 py-1 text-[11px] font-bold text-[#f1d27a]">🔒 พรีวิวแอดมิน — ลูกค้ายังไม่เห็นส่วนนี้ (เปิดที่ /admin/points/monthly)</div>}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[#f1d27a]">🏆 รางวัลประจำเดือน · {ymLabel(ym)}</span>
            <span className="text-[11.5px] text-ink-faint">ใบพรี: <b className="text-ink">{pieces}</b> ใบ</span>
          </div>
          <div className="mb-2 text-[11.5px] text-ink-faint">
            {tier.next
              ? <>อีก <b className="text-[#fbbf24]">{tier.next.pieces - pieces}</b> ใบ → {tier.next.emoji} {tier.next.label} <b className="text-[#4ade80]">+{num(tier.next.points)} คะแนน</b></>
              : <span className="font-bold text-[#f1d27a]">ถึงยศสูงสุดของเดือนแล้ว</span>}
            <span className="ml-1">· นับใหม่ทุกต้นเดือน</span>
          </div>
          {/* แถบความคืบหน้า ทองไหล */}
          <div className="h-2 overflow-hidden rounded-full border border-[#d4af37]/25 bg-black/60">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#7f1d1d,#d4af37,#f7e39b,#d4af37)] bg-[length:200%_100%] motion-safe:animate-goldShine" style={{ width: `${tier.pct}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {mcfg.tiers.map((m) => {
              const got = pieces >= m.pieces;
              const paid = rewards.find((r) => r.tier.pieces === m.pieces)?.paid;
              return (
                <div key={m.pieces} className={cx('relative rounded-xl border p-2.5 text-center', got ? 'border-[#d4af37]/50 bg-[#d4af37]/[0.10] motion-safe:animate-tierGlow' : 'border-white/10 bg-black/30 opacity-75')}>
                  <div className={cx('text-[22px] leading-none', got && 'drop-shadow-[0_0_10px_rgba(212,175,55,.7)]')}>{m.emoji}</div>
                  <div className={cx('mt-1 text-[12.5px] font-extrabold tracking-wide', got ? 'text-[#f1d27a]' : 'text-ink-muted2')}>{m.label}</div>
                  <div className="text-[10.5px] text-ink-faint">{m.pieces} ใบ</div>
                  {m.points > 0 && <div className={cx('mt-1 text-[12px] font-extrabold', got ? 'text-[#4ade80]' : 'text-ink-muted2')}>+{num(m.points)} คะแนน</div>}
                  {got && <div className="mt-0.5 text-[10px] text-ink-faint">{paid ? '✓ รับแล้ว' : 'รอร้านจ่าย'}</div>}
                  {m.perks.length > 0 && <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-ink-muted2">{m.perks.map((p) => <span key={p}>• {p}</span>)}</div>}
                </div>
              );
            })}
          </div>
          {rewardDue > 0 && <div className="mt-2 text-[11px] text-[#fbbf24]">โบนัสยศเดือนนี้รอร้านจ่าย <b>+{num(rewardDue)}</b> คะแนน (จ่ายหลังสิ้นเดือน)</div>}
        </div>
      )}

      {/* how to earn */}
      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px] text-ink-muted2">
        <div className="mb-1.5 text-[13.5px] font-bold text-ink">วิธีได้คะแนน</div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2"><span className="w-5 text-center">📝</span><span className="flex-1">ปิดใบพรี (จ่ายส่วนต่างครบ)</span><b className="text-[#f1d27a]">+{rate.pre} คะแนน/ใบ</b></div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">🛒</span><span className="flex-1">ซื้อของพร้อมส่ง</span><b className="text-[#f1d27a]">+{rate.instock} คะแนน/ใบ</b></div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">🏆</span><span className="flex-1">รางวัลประจำเดือน — พรีครบตามยศ</span><b className="text-[#f1d27a]">{mcfg.tiers.map((t) => `+${num(t.points)}`).join(' / ')}</b></div>
          <div className="flex items-center gap-2"><span className="w-5 text-center">💎</span><span className="flex-1">รางวัลสะสม</span><span className="rounded-md bg-surface-3 px-2 py-0.5 text-[10.5px] text-ink-faint">เร็วๆ นี้</span></div>
          <div className="mt-1 text-[11px] text-ink-faint">1 คะแนน = 1฿ · แลกเป็นส่วนลดส่วนต่างใบพรี / ของพร้อมส่ง (ไม่ใช้กับมัดจำ) — เปิดให้แลกเร็วๆ นี้</div>
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
            {pending.map(({ t, pts, due }) => {
              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                    <div className="text-[11px] text-ink-faint">{t.ticket_no} · ค้าง ฿{num(Math.round(due))}</div>
                  </div>
                  <span className="font-extrabold text-[#fbbf24]">+{num(pts)}</span>
                  <Icon name="chevronRight" size={16} className="text-ink-faint" />
                </>
              );
              // preview ในแอดมิน: ไม่ให้กดหลุดไปหน้าตั๋วของลูกค้า
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
          <div className="text-ink-muted2">รอร้านยืนยันคะแนนย้อนหลัง (รวม <b className="text-ink">{num(awaiting.reduce((a, t) => a + rawPointsForTicket(s, t), 0))}</b> คะแนน)</div>
        </div>
      )}

      {/* history */}
      <div className="mb-6 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-2 text-[13.5px] font-bold">📒 ประวัติคะแนน</div>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีประวัติ — ปิดใบพรีหรือซื้อของพร้อมส่งเพื่อเริ่มสะสม</div>
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

/** ถ่านไฟลอย (ember) — จุดทอง/แดงเล็กๆ ลอยขึ้นแล้วจาง · ตำแหน่ง/ดีเลย์กระจายแบบคงที่ (ไม่สุ่มตอน render กัน hydration mismatch) */
function Embers({ count }: { count: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden" aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const left = ((i * 37) % 97) + 1;           // %
        const delay = (i * 0.47) % 3.4;              // s
        const dur = 3 + ((i * 0.83) % 2.2);          // s
        const size = 2 + (i % 3);                    // px
        const gold = i % 3 !== 0;
        return (
          <span
            key={i}
            className="absolute bottom-2 block rounded-full animate-ember"
            style={{ left: `${left}%`, width: size, height: size, animationDelay: `${delay}s`, animationDuration: `${dur}s`, background: gold ? '#f1d27a' : '#ef4444', boxShadow: gold ? '0 0 6px 1px rgba(241,210,122,.8)' : '0 0 6px 1px rgba(239,68,68,.7)' }}
          />
        );
      })}
    </div>
  );
}

/** มุมรูนทอง ✦ กระพริบช้า */
function Rune({ className }: { className: string }) {
  return <span aria-hidden className={cx('pointer-events-none absolute text-[10px] text-[#d4af37]/70 motion-safe:animate-runePulse', className)}>✦</span>;
}
