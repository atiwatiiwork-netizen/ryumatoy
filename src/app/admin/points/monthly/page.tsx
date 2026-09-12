'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { cx } from '@/components/ui';
import { setMonthlyConfig, closeMonth } from '@/data/mutations';
import { monthlyConfig, monthlyBoard, monthsWithTickets, monthsToClose, closedMonths, currentYm, prevYm, ymLabel, sharePerPiece, DEFAULT_MONTHLY, type MonthlyConfig, type MonthlyTier } from '@/domain/services/monthly';
import { PointsPanel } from '@/components/PointsPanel';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const num = (n: number) => n.toLocaleString('en-US');
const fmtDT = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * รางวัลประจำเดือน "ยศ" (Phase 1 — เจ้าของ 2026-09-12 ค่ำ)
 *  · สิ้นเดือนระบบปิดเดือนเอง (เซสชันแอดมินแรกของเดือนใหม่) → snapshot ยศ + "N ใบแรกตามลำดับอนุมัติ" ที่ได้รางวัล
 *  · รางวัลผูกกับใบ: ปิดใบนั้นเมื่อไหร่ ได้ส่วนลดอัตโนมัติ (share = คะแนนยศ ÷ เกณฑ์) · ใบที่ปิดไปก่อนวันปิดเดือน → ได้เป็นแต้ม
 *  · กติกาเก็บใน app_config (ไม่ต้องรัน SQL) · พรีวิวหน้าลูกค้า = <PointsPanel> ตัวเดียวกับ /points
 */
export default function AdminMonthlyPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const adminId = useCurrentUserId();
  const { flash } = useToast();
  const cfg = monthlyConfig(db);
  const months = useMemo(() => monthsWithTickets(db), [db]);
  const [ym, setYm] = useState(prevYm(currentYm()));
  const board = useMemo(() => monthlyBoard(db, ym, cfg), [db, ym, cfg]);
  const snap = closedMonths(db)[ym];
  const toClose = monthsToClose(db);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '(ไม่พบ)';
  const isCurrent = ym === currentYm();
  const canCloseNow = !isCurrent && !snap && cfg.enabled && !!cfg.start_ym && ym >= cfg.start_ym;

  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/coupons', label: '🎟️ คูปอง' }, { href: '/admin/events', label: '🎯 กิจกรรม / Event' }, { href: '/admin/points', label: '⭐ คะแนนสะสม' }, { href: '/admin/points/monthly', label: '🏆 รางวัลประจำเดือน' }]} />
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-2xl font-extrabold">รางวัลประจำเดือน · ยศ</span>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-extrabold', cfg.enabled ? 'bg-[#16a34a]/[0.18] text-[#4ade80]' : 'bg-[#d97706]/[0.18] text-[#fbbf24]')}>{cfg.enabled ? `● เปิดใช้ · เริ่มนับ ${cfg.start_ym ? ymLabel(cfg.start_ym) : '—'}` : '○ ยังไม่เปิด (พรีวิว)'}</span>
      </div>
      <div className="mb-5 text-[13px] text-ink-faint">นับ "ใบ" ที่ร้านอนุมัติในเดือนนั้น · สิ้นเดือนระบบสรุปยศเอง · รางวัลผูกกับ N ใบแรกตามลำดับอนุมัติ (Silver 10 ลูกค้ามี 14 = 10 ใบแรก) → ปิดใบไหน ลดใบนั้นอัตโนมัติ · ใบที่ปิดไปก่อนสิ้นเดือนได้เป็นแต้ม · ใบที่ถูกโอนไม่ได้</div>

      {cfg.enabled && !db.settings.points_enabled && (
        <div className="mb-4 rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.10] px-3.5 py-2.5 text-[12.5px] text-[#fbbf24]">
          ⚠ เปิดรางวัลประจำเดือนแล้ว แต่ "คะแนนสะสม" ยังปิดอยู่ — ลูกค้ายังไม่เห็นหน้าคะแนน (เปิดสวิตช์ที่แท็บ ⭐ คะแนนสะสม เมื่อพร้อม)
        </div>
      )}
      {toClose.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#b91c1c]/40 bg-[#b91c1c]/[0.10] px-3.5 py-2.5 text-[12.5px]">
          <span className="text-primary-soft">⏳ เดือนที่ยังไม่ปิด: {toClose.map(ymLabel).join(', ')} — ระบบจะปิดให้เองเมื่อเปิดหน้าแอดมิน (กำลังทำ) หรือกดปิดเองได้</span>
          <button onClick={() => { for (const m of toClose) dispatch(closeMonth(adminId, m)); flash(`ปิดเดือน ${toClose.map(ymLabel).join(', ')} แล้ว`); }} className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-[12px] font-bold text-white">ปิดเดือนตอนนี้</button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <ConfigPanel cfg={cfg} />
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-bold">📊 กระดานเดือน</span>
            <span className={cx('rounded-md px-2 py-0.5 text-[11px] font-bold', snap ? 'bg-[#16a34a]/[0.16] text-[#4ade80]' : isCurrent ? 'bg-[#2563eb]/[0.16] text-[#60a5fa]' : 'bg-[#d97706]/[0.16] text-[#fbbf24]')}>{snap ? `ปิดแล้ว ${fmtDT(snap.closed_at)}` : isCurrent ? 'เดือนนี้ · คำนวณสด' : 'ยังไม่ปิด · คำนวณสด'}</span>
            <select className={cx(inputCls, 'ml-auto w-auto !py-1.5')} value={ym} onChange={(e) => setYm(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{ymLabel(m)}</option>)}
            </select>
          </div>
          <div className="mb-3 text-[12px] text-ink-muted2">{board.length} คนพรีเดือนนี้ · ถึงยศ <b className="text-[#f1d27a]">{board.filter((r) => r.tier).length}</b> คน · นับ{cfg.count === 'pre' ? 'เฉพาะใบพรี' : 'ทุกตั๋ว (รวมพร้อมส่ง)'}</div>
          {canCloseNow && (
            <button onClick={() => { if (confirm(`ปิดเดือน ${ymLabel(ym)} ตอนนี้? สรุปยศ + ล็อกใบที่ได้รางวัลจากตั๋ว ณ ตอนนี้`)) { dispatch(closeMonth(adminId, ym)); flash(`ปิดเดือน ${ymLabel(ym)} แล้ว`); } }} className="mb-3 rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white">ปิดเดือน {ymLabel(ym)} ตอนนี้</button>
          )}
          {board.length === 0 ? <div className="py-8 text-center text-[13px] text-ink-faint">ยังไม่มีใครพรีในเดือนนี้</div> : (
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <tr className="border-b border-subtle"><th className="py-1.5 pr-2">ลูกค้า</th><th className="px-2 text-right">ใบ</th><th className="px-2">ยศ</th><th className="px-2 text-right">ใบที่ได้ลด</th><th className="px-2 text-right">ลด/ใบ</th><th className="px-2 text-right">ใช้แล้ว</th><th className="px-2 text-right">รอปิดใบ</th><th className="px-2 text-right">ถูกโอน</th></tr>
                </thead>
                <tbody>
                  {board.map((r) => (
                    <tr key={r.userId} className="border-b border-hair">
                      <td className="py-1.5 pr-2"><Link href={`/admin/customers/${r.userId}`} className="font-semibold hover:underline">{name(r.userId)}</Link></td>
                      <td className="px-2 text-right tabular-nums">{r.pieces}</td>
                      <td className="px-2">{r.tier ? <span className="rounded-md bg-[#d4af37]/[0.14] px-1.5 py-0.5 text-[11.5px] font-bold text-[#f1d27a]">{r.tier.emoji} {r.tier.label}</span> : <span className="text-ink-faint">—</span>}</td>
                      <td className="px-2 text-right tabular-nums">{r.rewardCount || '—'}</td>
                      <td className="px-2 text-right tabular-nums text-[#4ade80]">{r.share ? num(r.share) : '—'}</td>
                      <td className="px-2 text-right tabular-nums text-[#4ade80]">{r.used || '—'}</td>
                      <td className="px-2 text-right tabular-nums text-[#fbbf24]">{r.pending || '—'}</td>
                      <td className="px-2 text-right tabular-nums text-ink-faint">{r.transferred || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 text-[11px] text-ink-faint">{snap ? 'ตัวเลขยศ/ใบที่ได้ลด ล็อกแล้วตอนปิดเดือน (เปลี่ยนกติกาทีหลังไม่กระทบ) · "ใช้แล้ว" = หักส่วนลดตอนปิดใบหรือให้เป็นแต้มแล้ว' : 'ยังไม่ปิด: ยศ/ใบที่ได้ลด เปลี่ยนได้จนถึงสิ้นเดือน'}</div>
        </div>
      </div>

      <div className="mt-4"><PreviewPanel /></div>
    </div>
  );
}

// ── ตั้งค่ากติกา ─────────────────────────────────────────────────────────────
function ConfigPanel({ cfg }: { cfg: MonthlyConfig }) {
  const dispatch = useDispatch();
  const { flash } = useToast();
  const save = (next: MonthlyConfig) => dispatch(setMonthlyConfig(next));
  const setTier = (i: number, patch: Partial<MonthlyTier>) => save({ ...cfg, tiers: cfg.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">⚙️ กติกา</div>
      <div className="mb-3 text-[12.5px] text-ink-faint">แก้แล้วมีผลกับเดือนที่ยังไม่ปิดเท่านั้น (เดือนที่ปิดแล้วล็อกไว้)</div>

      <button
        onClick={() => {
          const v = !cfg.enabled;
          if (!confirm(v ? `เปิดรอบเดือน? เริ่มนับตั้งแต่ ${ymLabel(currentYm())} (สิ้นเดือนระบบสรุปยศเอง)` : 'ปิดรอบเดือน? เดือนที่ปิดแล้วยังอยู่ แค่หยุดนับเดือนใหม่')) return;
          // start_ym ตั้งครั้งแรกตอนเปิด — ไม่ปิดเดือนย้อนหลังก่อนเปิดใช้
          save({ ...cfg, enabled: v, start_ym: cfg.start_ym ?? currentYm() });
          flash(v ? 'เปิดรอบเดือนแล้ว' : 'ปิดรอบเดือนแล้ว');
        }}
        className={cx('mb-3 w-full rounded-xl border px-4 py-3 text-left', cfg.enabled ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.10]' : 'border-[#d97706]/40 bg-[#d97706]/[0.10]')}
      >
        <div className="flex items-center justify-between">
          <span className="font-bold">{cfg.enabled ? '● รอบเดือนทำงาน' : '○ ยังไม่เปิดรอบเดือน (พรีวิว)'}</span>
          <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11.5px] font-bold text-ink-muted2">{cfg.enabled ? 'กดเพื่อหยุด' : 'กดเพื่อเปิด'}</span>
        </div>
        <div className="mt-1 text-[12px] text-ink-muted2">{cfg.enabled ? `เริ่มนับ ${cfg.start_ym ? ymLabel(cfg.start_ym) : '—'} · ปิดเดือนอัตโนมัติเมื่อแอดมินเปิดแอปหลังสิ้นเดือน` : 'ดูกระดานจำลองได้ แต่ยังไม่สรุปยศ/ให้ส่วนลดจริง'}</div>
      </button>

      <label className="mb-3 block">
        <div className="mb-1 text-[12px] font-semibold text-ink-muted2">นับอะไรเป็น "ใบ"</div>
        <select className={inputCls} value={cfg.count} onChange={(e) => save({ ...cfg, count: e.target.value === 'all' ? 'all' : 'pre' })}>
          <option value="pre">เฉพาะใบพรี (ยอดพรี) — ค่าเริ่มต้น</option>
          <option value="all">ทุกตั๋ว รวมพร้อมส่ง/จ่ายเต็ม</option>
        </select>
      </label>

      <div className="mb-1 grid grid-cols-[48px_64px_1fr_84px_28px] gap-2 text-[11px] font-semibold text-ink-muted2"><span>ไอคอน</span><span>ใบ</span><span>ยศ</span><span>คะแนนยศ</span><span /></div>
      <div className="flex flex-col gap-2">
        {cfg.tiers.map((t, i) => <TierRow key={i} tier={t} onChange={(p) => setTier(i, p)} onRemove={cfg.tiers.length > 1 ? () => save({ ...cfg, tiers: cfg.tiers.filter((_, j) => j !== i) }) : undefined} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => save({ ...cfg, tiers: [...cfg.tiers, { pieces: (cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 0) + 10, label: 'Platinum', emoji: '💎', points: 1000, perks: [] }] })} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">+ เพิ่มยศ</button>
        <button onClick={() => { if (confirm('คืนค่ายศเป็นค่าเริ่มต้น Bronze 5/100 · Silver 10/250 · Gold 20/600?')) { save({ ...cfg, tiers: DEFAULT_MONTHLY.tiers }); flash('คืนค่าเริ่มต้นแล้ว'); } }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">คืนค่าเริ่มต้น</button>
      </div>
      <div className="mt-3 rounded-xl border border-subtle bg-surface-3/40 p-3 text-[11.5px] text-ink-muted2">
        ส่วนลดต่อใบ = คะแนนยศ ÷ เกณฑ์: {cfg.tiers.map((t) => `${t.emoji} ${t.label} ${num(sharePerPiece(t))}/ใบ × ${t.pieces} ใบแรก = ${num(sharePerPiece(t) * t.pieces)}`).join(' · ')}
        <br />big spender {cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 0} ใบ/เดือน: ปิดใบ 20×{cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 0} + ส่วนลด {num(cfg.tiers[cfg.tiers.length - 1]?.points ?? 0)} · กำไร 200/ใบ เหลือราว {200 - 20 - sharePerPiece(cfg.tiers[cfg.tiers.length - 1] ?? DEFAULT_MONTHLY.tiers[2])}฿/ใบ
      </div>
    </div>
  );
}

/** แถวแก้ยศ — ระดับบนสุดตาม DNA react-state */
function TierRow({ tier, onChange, onRemove }: { tier: MonthlyTier; onChange: (p: Partial<MonthlyTier>) => void; onRemove?: () => void }) {
  return (
    <div className="grid grid-cols-[48px_64px_1fr_84px_28px] items-center gap-2 rounded-xl border border-subtle bg-surface-3/40 p-2">
      <input className={cx(inputCls, 'text-center !px-1')} value={tier.emoji} onChange={(e) => onChange({ emoji: e.target.value })} />
      <input type="number" className={cx(inputCls, '!px-2')} value={tier.pieces} onChange={(e) => onChange({ pieces: Math.max(1, Number(e.target.value) || 1) })} />
      <input className={inputCls} value={tier.label} placeholder="ชื่อยศ เช่น Bronze" onChange={(e) => onChange({ label: e.target.value })} />
      <input type="number" className={cx(inputCls, '!px-2 text-right font-bold text-[#4ade80]')} value={tier.points} onChange={(e) => onChange({ points: Math.max(0, Number(e.target.value) || 0) })} />
      <button disabled={!onRemove} onClick={onRemove} className="grid h-8 w-7 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171] disabled:opacity-30">×</button>
    </div>
  );
}

// ── พรีวิวหน้าลูกค้า (คอมโพเนนต์เดียวกับ /points) ────────────────────────────
function PreviewPanel() {
  const db = useDatabase();
  const customers = db.users.filter((u) => !u.is_admin && u.id !== 'u-admin');
  const [uid, setUid] = useState<string>(customers[0]?.id ?? '');
  const [q, setQ] = useState('');
  const u = db.users.find((x) => x.id === uid);
  const matches = q ? customers.filter((c) => c.display_name.toLowerCase().includes(q.toLowerCase()) || (c.member_code ?? '').includes(q)).slice(0, 8) : [];
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-bold">👀 พรีวิวหน้าลูกค้า</span>
        <span className="text-[11.5px] text-ink-faint">บล็อก 🏆 อยู่ในหน้า /points ของลูกค้า — คอมโพเนนต์ตัวเดียวกัน แก้ที่ไหนเปลี่ยนทั้งคู่</span>
      </div>
      <div className="relative mb-3">
        <input className={cx(inputCls, 'w-[240px] !py-1.5')} placeholder={u ? `ดูเป็น: ${u.display_name}` : 'ค้นชื่อลูกค้า'} value={q} onChange={(e) => setQ(e.target.value)} />
        {matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-[240px] overflow-hidden rounded-lg border border-subtle bg-surface-2 shadow-lg">
            {matches.map((c) => <button key={c.id} onClick={() => { setUid(c.id); setQ(''); }} className="block w-full border-b border-hair px-3 py-2 text-left text-[12.5px] last:border-0 hover:bg-surface-3">{c.display_name} <span className="text-ink-faint">{c.member_code ?? ''}</span></button>)}
          </div>
        )}
      </div>
      <div className="mx-auto w-[375px] max-w-full overflow-hidden rounded-[28px] border-[6px] border-black/60 bg-base shadow-2xl">
        <div className="flex items-center gap-3 border-b border-hair px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-full border border-subtle bg-surface-3 text-ink">‹</span>
          <span className="text-[15px] font-bold">คะแนนสะสม</span>
        </div>
        <div className="max-h-[720px] overflow-y-auto p-4 text-ink">
          {u ? <PointsPanel userId={u.id} mode="preview" simulateEnabled /> : <div className="py-8 text-center text-ink-faint">ยังไม่มีลูกค้า</div>}
        </div>
      </div>
    </div>
  );
}
