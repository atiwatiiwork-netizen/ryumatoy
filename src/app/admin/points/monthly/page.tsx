'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { cx } from '@/components/ui';
import { setMonthlyConfig } from '@/data/mutations';
import { monthlyConfig, monthlyBoard, monthsWithTickets, currentYm, ymLabel, DEFAULT_MONTHLY, type MonthlyConfig, type MonthlyTier } from '@/domain/services/monthly';
import { PointsPanel } from '@/components/PointsPanel';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-accent';

/**
 * รางวัลรายเดือน — "พรีครบ X ชิ้นในเดือนนี้ → ด่าน/สิทธิ์" (เจ้าของ 2026-09-12)
 *  · ตั้งกติกา (เปิด/ปิด · นับเฉพาะพรี/รวมพร้อมส่ง · ด่าน 3 ขั้น) เก็บใน app_config — ไม่ต้องรัน SQL
 *  · กระดานเดือน: ใครพรีกี่ชิ้น ถึงด่านไหน → แอดมินจัดสิทธิ์ให้ (เฟสนี้ยังไม่บังคับใช้อัตโนมัติ)
 *  · พรีวิวหน้าลูกค้า = <PointsPanel> ตัวเดียวกับ /points (บล็อก 🏆 อยู่ในนั้น) — แก้ที่เดียวเปลี่ยนทั้งคู่
 */
export default function AdminMonthlyPage() {
  const db = useDatabase();
  const cfg = monthlyConfig(db);
  const months = useMemo(() => monthsWithTickets(db), [db]);
  const [ym, setYm] = useState(currentYm());
  const board = useMemo(() => monthlyBoard(db, ym, cfg), [db, ym, cfg]);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '(ไม่พบ)';
  const reachedCount = board.filter((r) => r.tier).length;

  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/coupons', label: '🎟️ คูปอง' }, { href: '/admin/events', label: '🎯 กิจกรรม / Event' }, { href: '/admin/points', label: '⭐ คะแนนสะสม' }, { href: '/admin/points/monthly', label: '🏆 รางวัลรายเดือน' }]} />
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-2xl font-extrabold">รางวัลรายเดือน</span>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-extrabold', cfg.enabled ? 'bg-[#16a34a]/[0.18] text-[#4ade80]' : 'bg-[#d97706]/[0.18] text-[#fbbf24]')}>{cfg.enabled ? '● ลูกค้าเห็นแล้ว' : '○ ซ่อนจากลูกค้า (พรีวิว)'}</span>
      </div>
      <div className="mb-5 text-[13px] text-ink-faint">นับ "ชิ้น" ที่พรีในเดือนนั้น (ตั๋วเกิดเดือนไหนนับเดือนนั้น) · รีเซ็ตทุกต้นเดือน · รางวัลเป็นสิทธิ์ ไม่ใช่เงิน · ไม่นับตั๋วหาของ · แยกจากคะแนนสะสม (คะแนนยังได้ตามปกติ)</div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <ConfigPanel cfg={cfg} />
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-bold">📊 กระดานเดือน</span>
            <select className={cx(inputCls, 'ml-auto w-auto !py-1.5')} value={ym} onChange={(e) => setYm(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{ymLabel(m)}</option>)}
            </select>
          </div>
          <div className="mb-3 text-[12px] text-ink-muted2">{board.length} คนพรีเดือนนี้ · ถึงด่าน <b className="text-[#f1d27a]">{reachedCount}</b> คน · นับ{cfg.count === 'pre' ? 'เฉพาะใบพรี' : 'ทุกตั๋ว (รวมพร้อมส่ง)'}</div>
          {board.length === 0 ? <div className="py-8 text-center text-[13px] text-ink-faint">ยังไม่มีใครพรีในเดือนนี้</div> : (
            <div className="max-h-[520px] overflow-auto divide-y divide-hair">
              {board.map((r, i) => (
                <div key={r.userId} className="flex items-center gap-3 py-2 text-[12.5px]">
                  <span className="w-5 text-right text-[11px] text-ink-faint">{i + 1}</span>
                  <Link href={`/admin/customers/${r.userId}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">{name(r.userId)}</Link>
                  <span className="w-14 text-right tabular-nums">{r.pieces} ชิ้น</span>
                  <span className={cx('w-[110px] truncate rounded-md px-2 py-0.5 text-center text-[11.5px] font-bold', r.tier ? 'bg-[#d4af37]/[0.14] text-[#f1d27a]' : 'text-ink-faint')}>{r.tier ? `${r.tier.emoji} ${r.tier.label}` : '—'}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-ink-faint">สิทธิ์ (เห็นก่อน / เพดาน hot / คิวส่งมอบ) ยังจัดให้มือในเฟสนี้ — ระบบบังคับใช้อัตโนมัติเป็นเฟสถัดไป</div>
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
        onClick={() => { const v = !cfg.enabled; if (confirm(v ? 'เปิดให้ลูกค้าเห็น "รางวัลรายเดือน"?' : 'ซ่อนรางวัลรายเดือนจากลูกค้า?')) { save({ ...cfg, enabled: v }); flash(v ? 'เปิดให้ลูกค้าเห็นแล้ว' : 'ซ่อนแล้ว'); } }}
        className={cx('mb-3 w-full rounded-xl border px-4 py-3 text-left', cfg.enabled ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.10]' : 'border-[#d97706]/40 bg-[#d97706]/[0.10]')}
      >
        <div className="flex items-center justify-between">
          <span className="font-bold">{cfg.enabled ? '● ลูกค้าเห็นบล็อกรางวัลรายเดือน' : '○ ซ่อนจากลูกค้า (แอดมินเห็นพรีวิว)'}</span>
          <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11.5px] font-bold text-ink-muted2">{cfg.enabled ? 'กดเพื่อซ่อน' : 'กดเพื่อเปิด'}</span>
        </div>
      </button>

      <label className="mb-3 block">
        <div className="mb-1 text-[12px] font-semibold text-ink-muted2">นับอะไรเป็น "ชิ้น"</div>
        <select className={inputCls} value={cfg.count} onChange={(e) => save({ ...cfg, count: e.target.value === 'all' ? 'all' : 'pre' })}>
          <option value="pre">เฉพาะใบพรี (ยอดพรี) — ค่าเริ่มต้น</option>
          <option value="all">ทุกตั๋ว รวมพร้อมส่ง/จ่ายเต็ม</option>
        </select>
      </label>

      <div className="mb-1 text-[12px] font-semibold text-ink-muted2">ด่าน (เรียงน้อย→มาก) · ชิ้น/เดือน · ชื่อ · สิทธิ์ (คั่นด้วย ,)</div>
      <div className="flex flex-col gap-2">
        {cfg.tiers.map((t, i) => <TierRow key={i} tier={t} onChange={(p) => setTier(i, p)} onRemove={cfg.tiers.length > 1 ? () => save({ ...cfg, tiers: cfg.tiers.filter((_, j) => j !== i) }) : undefined} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => save({ ...cfg, tiers: [...cfg.tiers, { pieces: (cfg.tiers[cfg.tiers.length - 1]?.pieces ?? 0) + 5, label: 'ด่านใหม่', emoji: '🏅', perks: [] }] })} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">+ เพิ่มด่าน</button>
        <button onClick={() => { if (confirm('คืนค่าด่านเป็นค่าเริ่มต้น 5/10/20?')) { save({ ...cfg, tiers: DEFAULT_MONTHLY.tiers }); flash('คืนค่าเริ่มต้นแล้ว'); } }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">คืนค่าเริ่มต้น</button>
      </div>
      <div className="mt-3 rounded-xl border border-subtle bg-surface-3/40 p-3 text-[11.5px] text-ink-muted2">
        ตัวอย่างค่าเริ่มต้น: ลูกค้าประจำ 5 ชิ้น/เดือน ถึง 🥉 · 10 ชิ้น 🥈 · big spender 20 ชิ้น 🥇 — ทุกด่านเป็นสิทธิ์ (ไม่กินกำไร) ต่างจากคะแนนสะสมที่เป็นเงิน 1 ต่อ
      </div>
    </div>
  );
}

/** แถวแก้ด่าน — ระดับบนสุดตาม DNA react-state (ประกาศในฟังก์ชันหน้า = remount ทุกคีย์ โฟกัสหลุด) */
function TierRow({ tier, onChange, onRemove }: { tier: MonthlyTier; onChange: (p: Partial<MonthlyTier>) => void; onRemove?: () => void }) {
  return (
    <div className="grid grid-cols-[52px_72px_1fr_auto] items-center gap-2 rounded-xl border border-subtle bg-surface-3/40 p-2">
      <input className={cx(inputCls, 'text-center')} value={tier.emoji} onChange={(e) => onChange({ emoji: e.target.value })} />
      <input type="number" className={inputCls} value={tier.pieces} onChange={(e) => onChange({ pieces: Math.max(1, Number(e.target.value) || 1) })} />
      <div className="flex flex-col gap-1">
        <input className={inputCls} value={tier.label} placeholder="ชื่อด่าน" onChange={(e) => onChange({ label: e.target.value })} />
        <input className={inputCls} value={tier.perks.join(', ')} placeholder="สิทธิ์ เช่น เห็นรอบใหม่ก่อน 3 ชม., ป้ายในโปรไฟล์" onChange={(e) => onChange({ perks: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </div>
      <button disabled={!onRemove} onClick={onRemove} className="grid h-8 w-8 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171] disabled:opacity-30">×</button>
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
