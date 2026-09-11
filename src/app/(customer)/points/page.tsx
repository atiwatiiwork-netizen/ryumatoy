'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { BackBar, ProgressBar, cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useSmartBack } from '@/lib/nav';
import { balanceOf, lifetimeOf, ledgerOf, milestoneProgress, MILESTONES, KIND_LABEL, pointsForAmount, POINT_BAHT_UNIT, ticketEarnEligible, hasEarned } from '@/domain/services/points';
import { ticketPaid, ticketDue } from '@/domain/services/money';
import { productLabel } from '@/domain/services/catalog';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const num = (n: number) => n.toLocaleString('en-US');

/**
 * คะแนนสะสมของฉัน (ryuma-points-spec เฟส 1 "ได้คะแนน")
 *  · ยอดคงเหลือ + สะสมตลอดชีพ · ด่าน Milestone (สิทธิ์) · ตั๋วที่กำลังจะได้คะแนนเมื่อปิดยอด · ประวัติ
 *  DNA: ตัวเลขทุกตัวมาจาก points.ts — หน้านี้ไม่คำนวณเอง
 */
export default function PointsPage() {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const goBack = useSmartBack('/profile');
  const s = db.settings;

  const balance = balanceOf(db, uid);
  const lifetime = lifetimeOf(db, uid);
  const rows = ledgerOf(db, uid);
  const mp = milestoneProgress(lifetime);
  const top = mp.reached[mp.reached.length - 1];

  // ตั๋วที่ยังค้าง → "จะได้" เท่าไหร่เมื่อปิดยอด (คิดจากยอดเต็มใบ = มัดจำ + ค้าง)
  const pending = db.tickets
    .filter((t) => t.owner_id === uid && ticketDue(t) > 0 && ticketEarnEligible(db, { ...t, remaining_paid: t.remaining_amount }).ok)
    .map((t) => ({ t, pts: pointsForAmount(s, ticketPaid(t) + ticketDue(t)), due: ticketDue(t) }))
    .filter((x) => x.pts > 0)
    .sort((a, b) => a.due - b.due);
  const pendingPts = pending.reduce((a, x) => a + x.pts, 0);
  // ตั๋วปิดยอดแล้วแต่ยังไม่ได้ (ก่อนเปิดระบบ) — โชว์เป็น "รอร้านยืนยัน" ไม่ใช่ตัวเลขคงเหลือ
  const awaiting = db.tickets.filter((t) => t.owner_id === uid && ticketEarnEligible(db, t).ok && !hasEarned(db, t.id) && pointsForAmount(s, ticketPaid(t)) > 0);

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="คะแนนสะสม" onBack={goBack} />

      {!s.points_enabled && (
        <div className="mb-3 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.10] px-3.5 py-2.5 text-[12.5px] text-[#fbbf24]">
          🔧 ระบบคะแนนอยู่ในช่วงทดสอบ — ตัวเลขที่เห็นเป็นพรีวิว ร้านจะประกาศวันเริ่มใช้จริงอีกครั้ง
        </div>
      )}

      {/* balance card */}
      <div className="mb-4 overflow-hidden rounded-2xl border border-[#d4af37]/30 bg-gradient-to-br from-[#2a2410] via-surface-2 to-surface-2 p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[12px] font-semibold text-[#f1d27a]/80">คะแนนใช้ได้</div>
            <div className="mt-0.5 flex items-end gap-2">
              <span className="text-[38px] font-extrabold leading-none text-[#f1d27a]">{num(balance)}</span>
              <span className="pb-1 text-[13px] text-ink-muted2">≈ ฿{num(balance)}</span>
            </div>
          </div>
          {top ? (
            <div className="rounded-xl border border-[#d4af37]/30 bg-black/20 px-3 py-2 text-center">
              <div className="text-[22px] leading-none">{top.emoji}</div>
              <div className="mt-1 text-[11px] font-bold text-[#f1d27a]">{top.label}</div>
            </div>
          ) : (
            <div className="rounded-xl border border-subtle bg-black/20 px-3 py-2 text-center text-[11px] text-ink-faint">ยังไม่ถึงด่านแรก</div>
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11.5px] text-ink-muted2">
          <div className="rounded-lg bg-black/20 px-2.5 py-1.5"><div className="text-ink-faint">สะสมตลอดชีพ</div><b className="text-ink">{num(lifetime)}</b></div>
          <div className="rounded-lg bg-black/20 px-2.5 py-1.5"><div className="text-ink-faint">รอปิดยอด</div><b className="text-[#fbbf24]">+{num(pendingPts)}</b></div>
          <div className="rounded-lg bg-black/20 px-2.5 py-1.5"><div className="text-ink-faint">ใช้ได้ที่</div><b className="text-ink">ส่วนต่าง · พร้อมส่ง</b></div>
        </div>
      </div>

      {/* milestone track */}
      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[13.5px] font-bold">🏁 ด่านสะสม</span>
          {mp.next ? <span className="text-[11.5px] text-ink-faint">อีก {num(mp.need)} คะแนน → {mp.next.emoji} {mp.next.label}</span> : <span className="text-[11.5px] font-bold text-[#f1d27a]">ถึงด่านสูงสุดแล้ว</span>}
        </div>
        <ProgressBar pct={mp.pct} fill="#f1d27a" />
        <div className="mt-3 grid grid-cols-3 gap-2">
          {MILESTONES.map((m) => {
            const got = lifetime >= m.threshold;
            return (
              <div key={m.threshold} className={cx('rounded-xl border p-2.5 text-center', got ? 'border-[#d4af37]/40 bg-[#d4af37]/[0.10]' : 'border-subtle bg-surface-3/40 opacity-70')}>
                <div className="text-[20px] leading-none">{m.emoji}</div>
                <div className={cx('mt-1 text-[12px] font-extrabold', got ? 'text-[#f1d27a]' : 'text-ink-muted2')}>{m.label}</div>
                <div className="text-[10.5px] text-ink-faint">{num(m.threshold)} คะแนน</div>
                <div className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] text-ink-muted2">{m.perks.map((p) => <span key={p}>• {p}</span>)}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-ink-faint">ด่านนับจากคะแนนที่ "เคยได้" ทั้งหมด — ใช้คะแนนไปแล้วด่านไม่ถอย</div>
      </div>

      {/* how to earn */}
      <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px] text-ink-muted2">
        <div className="mb-1.5 text-[13.5px] font-bold text-ink">วิธีได้คะแนน</div>
        <div className="flex flex-col gap-1">
          <span>✨ ทุก <b className="text-ink">{POINT_BAHT_UNIT}฿</b> ที่จ่ายจริง = <b className="text-ink">{s.points_per_100baht} คะแนน</b> (1 คะแนน = 1฿)</span>
          <span>📝 ใบพรี: ได้ตอน <b className="text-ink">จ่ายส่วนต่างครบ</b> (คิดจากยอดเต็มใบ ทั้งมัดจำ + ส่วนต่าง)</span>
          <span>🛒 ของพร้อมส่ง: ได้ทันทีที่ร้านยืนยันสลิป</span>
          <span>🎟️ ใช้ลดได้ตอนจ่ายส่วนต่าง หรือซื้อของพร้อมส่ง (ไม่ใช้กับมัดจำ)</span>
        </div>
      </div>

      {/* pending tickets */}
      {pending.length > 0 && (
        <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13.5px] font-bold">⏳ จะได้เมื่อปิดยอด</span>
            <span className="text-[12px] font-bold text-[#fbbf24]">+{num(pendingPts)} คะแนน</span>
          </div>
          <div className="flex flex-col divide-y divide-hair">
            {pending.map(({ t, pts, due }) => (
              <Link key={t.id} href={`/wallet/${t.ticket_no}`} className="flex items-center gap-3 py-2 text-[12.5px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
                  <div className="text-[11px] text-ink-faint">{t.ticket_no} · ค้าง ฿{num(Math.round(due))}</div>
                </div>
                <span className="font-extrabold text-[#fbbf24]">+{num(pts)}</span>
                <Icon name="chevronRight" size={16} className="text-ink-faint" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="mb-4 rounded-card border border-subtle bg-surface-2 p-4 text-[12.5px]">
          <div className="mb-1 text-[13.5px] font-bold">🕰️ ตั๋วที่ปิดยอดแล้ว {awaiting.length} ใบ</div>
          <div className="text-ink-muted2">รอร้านยืนยันคะแนนย้อนหลัง (รวม <b className="text-ink">{num(awaiting.reduce((a, t) => a + pointsForAmount(s, ticketPaid(t)), 0))}</b> คะแนน)</div>
        </div>
      )}

      {/* history */}
      <div className="mb-6 rounded-card border border-subtle bg-surface-2 p-4">
        <div className="mb-2 text-[13.5px] font-bold">📒 ประวัติคะแนน</div>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีประวัติ — ปิดยอดใบพรีหรือซื้อของพร้อมส่งเพื่อเริ่มสะสม</div>
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
    </div>
  );
}
