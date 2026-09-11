'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { cx } from '@/components/ui';
import { setMonthlyConfig, payMonthlyRewards } from '@/data/mutations';
import { monthlyConfig, monthlyBoard, monthsWithTickets, currentYm, ymLabel, DEFAULT_MONTHLY, type MonthlyConfig, type MonthlyTier } from '@/domain/services/monthly';
import { PointsPanel } from '@/components/PointsPanel';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const num = (n: number) => n.toLocaleString('en-US');

/**
 * รางวัลประจำเดือน "ยศ" — พรีครบ X ใบในเดือนนี้ → Bronze/Silver/Gold + คะแนนโบนัส (เจ้าของ 2026-09-12)
 *  · กติกา (เปิด/ปิด · นับเฉพาะพรี/รวมพร้อมส่ง · ยศ+คะแนน) เก็บใน app_config — ไม่ต้องรัน SQL
 *  · กระดานเดือน: ใครพรีกี่ใบ ถึงยศไหน โบนัสค้าง/จ่ายแล้ว → ปุ่ม "จ่ายโบนัสเดือนนี้" (idempotent ต่อ เดือน+คน+ยศ)
 *  · พรีวิวหน้าลูกค้า = <PointsPanel> ตัวเดียวกับ /points (บล็อก 🏆 อยู่ในนั้น) — แก้ที่เดียวเปลี่ยนทั้งคู่
 */
export default function AdminMonthlyPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const adminId = useCurrentUserId();
  const { flash } = useToast();
  const cfg = monthlyConfig(db);
  const months = useMemo(() => monthsWithTickets(db), [db]);
  const [ym, setYm] = useState(currentYm());
  const board = useMemo(() => monthlyBoard(db, ym, cfg), [db, ym, cfg]);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '(ไม่พบ)';
  const reachedCount = board.filter((r) => r.tier).length;
  const dueTotal = board.reduce((s, r) => s + r.due, 0);
  const paidTotal = board.reduce((s, r) => s + r.paid, 0);
  const isCurrent = ym === currentYm();

  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/coupons', label: '🎟️ คูปอง' }, { href: '/admin/events', label: '🎯 กิจกรรม / Event' }, { href: '/admin/points', label: '⭐ คะแนนสะสม' }, { href: '/admin/points/monthly', label: '🏆 รางวัลประจำเดือน' }]} />
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-2xl font-extrabold">รางวัลประจำเดือน · ยศ</span>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-extrabold', cfg.enabled ? 'bg-[#16a34a]/[0.18] text-[#4ade80]' : 'bg-[#d97706]/[0.18] text-[#fbbf24]')}>{cfg.enabled ? '● ลูกค้าเห็นแล้ว' : '○ ซ่อนจากลูกค้า (พรีวิว)'}</span>
      </div>
      <div className="mb-5 text-[13px] text-ink-faint">นับ "ใบ" ที่พรีในเดือนนั้น (ตั๋วเกิดเดือนไหนนับเดือนนั้น) · นับใหม่ทุกต้นเดือน · ถึงยศไหนได้คะแนนโบนัสของยศนั้น (สะสมต่อกัน: Gold = ได้ทั้ง 3 ก้อน) · ไม่นับตั๋วหาของ · แยกจากคะแนนปิดใบ (ยังได้ตามปกติ)</div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <ConfigPanel cfg={cfg} />
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-bold">📊 กระดานเดือน</span>
            <select className={cx(inputCls, 'ml-auto w-auto !py-1.5')} value={ym} onChange={(e) => setYm(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{ymLabel(m)}</option>)}
            </select>
          </div>
          <div className="mb-2 text-[12px] text-ink-muted2">{board.length} คนพรีเดือนนี้ · ถึงยศ <b className="text-[#f1d27a]">{reachedCount}</b> คน · นับ{cfg.count === 'pre' ? 'เฉพาะใบพรี' : 'ทุกตั๋ว (รวมพร้อมส่ง)'}</div>
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-subtle bg-surface-3/40 p-3 text-[12.5px]">
            <div><div className="text-[11px] text-ink-faint">โบนัสค้างจ่าย</div><div className="text-[18px] font-extrabold text-[#fbbf24]">{num(dueTotal)}</div></div>
            <div><div className="text-[11px] text-ink-faint">จ่ายแล้ว</div><div className="text-[18px] font-extrabold text-[#4ade80]">{num(paidTotal)}</div></div>
            <button
              disabled={!dueTotal}
              onClick={() => { if (confirm(`จ่ายโบนัสยศ ${ymLabel(ym)} รวม ${num(dueTotal)} คะแนน ให้ ${board.filter((r) => r.due > 0).length} คน?${isCurrent ? '\n\n⚠ เดือนนี้ยังไม่จบ — ถ้าลูกค้าพรีเพิ่มจนถึงยศถัดไป กดจ่ายซ้ำได้ (จ่ายเฉพาะยศที่ยังไม่ได้)' : ''}`)) { dispatch(payMonthlyRewards(adminId, ym)); flash(`จ่ายโบนัสยศแล้ว ${num(dueTotal)} คะแนน`); } }}
              className="ml-auto rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-40"
            >จ่ายโบนัส{isCurrent ? 'เดือนนี้' : 'เดือน ' + ymLabel(ym)}</button>
          </div>
          {board.length === 0 ? <div className="py-8 text-center text-[13px] text-ink-faint">ยังไม่มีใครพรีในเดือนนี้</div> : (
            <div className="max-h-[480px] overflow-auto divide-y divide-hair">
              {board.map((r, i) => (
                <div key={r.userId} className="flex items-center gap-3 py-2 text-[12.5px]">
                  <span className="w-5 text-right text-[11px] text-ink-faint">{i + 1}</span>
                  <Link href={`/admin/customers/${r.userId}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">{name(r.userId)}</Link>
                  <span className="w-12 text-right tabular-nums">{r.pieces} ใบ</span>
                  <span className={cx('w-[92px] truncate rounded-md px-2 py-0.5 text-center text-[11.5px] font-bold', r.tier ? 'bg-[#d4af37]/[0.14] text-[#f1d27a]' : 'text-ink-faint')}>{r.tier ? `${r.tier.emoji} ${r.tier.label}` : '—'}</span>
                  <span className="w-[86px] text-right text-[11.5px] tabular-nums">
                    {r.due > 0 && <span className="font-bold text-[#fbbf24]">ค้าง +{num(r.due)}</span>}
                    {r.due === 0 && r.paid > 0 && <span className="text-[#4ade80]">✓ +{num(r.paid)}</span>}
                    {r.due === 0 && r.paid === 0 && <span className="text-ink-faint">—</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-ink-faint">แนะนำกดจ่ายหลังสิ้นเดือนเมื่อยอดตั๋วนิ่ง · ถ้าตั๋วถูกลบหลังจ่ายแล้ว ใช้ "เติม/หักมือ" ที่แท็บคะแนนสะสมปรับคืน</div>
        </div>
      </div>

      <div className="mt-4"><PreviewPanel board={board} /></div>
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
      <div className="mb-3 text-[12.5px] text-ink-faint">แก้แล้วมีผลทันทีทั้งกระดานและหน้าลูกค้า (คอมโพเนนต์เดียวกัน)</div>

      <button
        onClick={() => { const v = !cfg.enabled; if (confirm(v ? 'เปิดให้ลูกค้าเห็น "รางวัลประจำเดือน"?' : 'ซ่อนรางวัลประจำเดือนจากลูกค้า?')) { save({ ...cfg, enabled: v }); flash(v ? 'เปิดให้ลูกค้าเห็นแล้ว' : 'ซ่อนแล้ว'); } }}
        className={cx('mb-3 w-full rounded-xl border px-4 py-3 text-left', cfg.enabled ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.10]' : 'border-[#d97706]/40 bg-[#d97706]/[0.10]')}
      >
        <div className="flex items-center justify-between">
          <span className="font-bold">{cfg.enabled ? '● ลูกค้าเห็นบล็อกรางวัลประจำเดือน' : '○ ซ่อนจากลูกค้า (แอดมินเห็นพรีวิว)'}</span>
          <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11.5px] font-bold text-ink-muted2">{cfg.enabled ? 'กดเพื่อซ่อน' : 'กดเพื่อเปิด'}</span>
        </div>
      </button>

      <label className="mb-3 block">
        <div className="mb-1 text-[12px] font-semibold text-ink-muted2">นับอะไรเป็น "ใบ"</div>
        <select className={inputCls} value={cfg.count} onChange={(e) => save({ ...cfg, count: e.target.value === 'all' ? 'all' : 'pre' })}>
          <option value="pre">เฉพาะใบพรี (ยอดพรี) — ค่าเริ่มต้น</option>
          <option value="all">ทุกตั๋ว รวมพร้อมส่ง/จ่ายเต็ม</option>
        </select>
      </label>

      <div className="mb-1 grid grid-cols-[48px_64px_1fr_84px_28px] gap-2 text-[11px] font-semibold text-ink-muted2"><span>ไอคอน</span><span>ใบ</span><span>ยศ · สิทธิ์เพิ่ม (ถ้ามี, คั่น ,)</span><span>+คะแนน</span><span /></div>
      <div className="flex flex-col gap-2">
        {cfg.tiers.map((t, i) => <TierRow key={i} tier={t} onChange={(p) => setTier(i, p)} onRemove={cfg.tiers.length > 1 ? () => save({ ...cfg, tiers: cfg.tiers.filter((_, j) => j !== i) }) : undefined} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => save({ ...cfg, tiers: [...cfg.tiers, { pieces: (cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 0) + 10, label: 'Platinum', emoji: '💎', points: 1000, perks: [] }] })} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">+ เพิ่มยศ</button>
        <button onClick={() => { if (confirm('คืนค่ายศเป็นค่าเริ่มต้น Bronze 5/+100 · Silver 10/+250 · Gold 20/+600?')) { save({ ...cfg, tiers: DEFAULT_MONTHLY.tiers }); flash('คืนค่าเริ่มต้นแล้ว'); } }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">คืนค่าเริ่มต้น</button>
      </div>
      <div className="mt-3 rounded-xl border border-subtle bg-surface-3/40 p-3 text-[11.5px] text-ink-muted2">
        ต้นทุน: big spender 20 ใบ/เดือน ได้โบนัสครบ 3 ยศ = <b className="text-ink">{num(cfg.tiers.reduce((s, t) => s + t.points, 0))} คะแนน</b>/เดือน ≈ {Math.round(cfg.tiers.reduce((s, t) => s + t.points, 0) / Math.max(1, cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 1))}฿ ต่อใบ บวกจากคะแนนปิดใบ 20 · กำไร 200/ใบ เหลือราว {200 - 20 - Math.round(cfg.tiers.reduce((s, t) => s + t.points, 0) / Math.max(1, cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 1))}฿
      </div>
    </div>
  );
}

/** แถวแก้ยศ — ระดับบนสุดตาม DNA react-state (ประกาศในฟังก์ชันหน้า = remount ทุกคีย์ โฟกัสหลุด) */
function TierRow({ tier, onChange, onRemove }: { tier: MonthlyTier; onChange: (p: Partial<MonthlyTier>) => void; onRemove?: () => void }) {
  return (
    <div className="grid grid-cols-[48px_64px_1fr_84px_28px] items-center gap-2 rounded-xl border border-subtle bg-surface-3/40 p-2">
      <input className={cx(inputCls, 'text-center !px-1')} value={tier.emoji} onChange={(e) => onChange({ emoji: e.target.value })} />
      <input type="number" className={cx(inputCls, '!px-2')} value={tier.pieces} onChange={(e) => onChange({ pieces: Math.max(1, Number(e.target.value) || 1) })} />
      <div className="flex flex-col gap-1">
        <input className={inputCls} value={tier.label} placeholder="ชื่อยศ เช่น Bronze" onChange={(e) => onChange({ label: e.target.value })} />
        <input className={inputCls} value={tier.perks.join(', ')} placeholder="สิทธิ์เพิ่ม (ไม่บังคับ) เช่น เห็นรอบใหม่ก่อน 3 ชม." onChange={(e) => onChange({ perks: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </div>
      <input type="number" className={cx(inputCls, '!px-2 text-right font-bold text-[#4ade80]')} value={tier.points} onChange={(e) => onChange({ points: Math.max(0, Number(e.target.value) || 0) })} />
      <button disabled={!onRemove} onClick={onRemove} className="grid h-8 w-7 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171] disabled:opacity-30">×</button>
    </div>
  );
}

// ── พรีวิวหน้าลูกค้า (คอมโพเนนต์เดียวกับ /points) ────────────────────────────
function PreviewPanel({ board }: { board: ReturnType<typeof monthlyBoard> }) {
  const db = useDatabase();
  const customers = db.users.filter((u) => !u.is_admin && u.id !== 'u-admin');
  const [uid, setUid] = useState<string>(board[0]?.userId ?? customers[0]?.id ?? '');
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
