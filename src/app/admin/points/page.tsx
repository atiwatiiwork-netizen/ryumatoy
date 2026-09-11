'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { cx } from '@/components/ui';
import { updateSettings, adjustPoints, backfillPoints } from '@/data/mutations';
import { simulateAll, ticketsMissingEarn, pointsLiability, KIND_LABEL, MILESTONES, milestoneProgress, rawPointsForTicket, pointsRates } from '@/domain/services/points';
import type { ShopSettings } from '@/domain/entities';
import { PointsPanel } from '@/components/PointsPanel';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtDT = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const num = (n: number) => n.toLocaleString('en-US');

/**
 * คะแนนสะสม — หน้าจัดการ + พรีวิว (เฟส 1 "ได้คะแนน" · ryuma-points-spec)
 *  · เปิด/ปิดระบบ + ตั้งค่าอัตรา/เพดาน   · จำลองทั้งร้าน "ใครควรมีกี่คะแนน" จากตั๋วที่ปิดยอดแล้วจริง
 *  · หนี้คะแนนค้าง (คะแนน = บาท)         · ให้คะแนนย้อนหลัง / เติม-หักมือ / สมุดบัญชีล่าสุด
 */
export default function AdminPointsPage() {
  const db = useDatabase();
  const s = db.settings;
  const rate = pointsRates(s); // อัตราต่อชิ้น (มี fallback) — โชว์ตัวเลขผ่านตัวนี้เท่านั้น
  const on = s.points_enabled;
  const missing = useMemo(() => ticketsMissingEarn(db), [db]);
  const missingPts = missing.reduce((a, t) => a + rawPointsForTicket(s, t), 0);
  const liab = pointsLiability(db);
  const sim = useMemo(() => simulateAll(db), [db]);
  const monthKey = new Date().toISOString().slice(0, 7);
  const earnedThisMonth = db.pointLedger.filter((e) => e.kind === 'earn_ticket' && e.created_at.slice(0, 7) === monthKey).reduce((a, e) => a + e.delta, 0);

  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/coupons', label: '🎟️ คูปอง' }, { href: '/admin/events', label: '🎯 กิจกรรม / Event' }, { href: '/admin/points', label: '⭐ คะแนนสะสม' }]} />
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-2xl font-extrabold">คะแนนสะสม</span>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-extrabold', on ? 'bg-[#16a34a]/[0.18] text-[#4ade80]' : 'bg-[#d97706]/[0.18] text-[#fbbf24]')}>{on ? '● เปิดใช้งาน' : '○ โหมดพรีวิว (ยังไม่ให้คะแนนจริง)'}</span>
      </div>
      <div className="mb-5 text-[13px] text-ink-faint">คะแนน "คงที่ต่อชิ้น" (กำไรร้าน fix ต่อชิ้น ไม่ขึ้นกับราคา): ใบพรี <b className="text-ink">{rate.pre}</b> · พร้อมส่ง/จ่ายเต็ม <b className="text-ink">{rate.instock}</b> · ได้ครั้งเดียวตอน "ตั๋วปิดยอด" (ใบพรี = งวดสุดท้ายอนุมัติ · พร้อมส่ง = อนุมัติออเดอร์) · 1 คะแนน = 1฿ · ไม่ให้ตอนมัดจำ / ตั๋วหาของ / ประมูล</div>

      {/* KPIs */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Kpi label="หนี้คะแนนค้างทั้งร้าน" value={`${num(liab.points)} คะแนน`} sub={`≈ ${baht(liab.points)} · ${liab.customers} คน`} tone={liab.points > 0 ? 'red' : undefined} />
        <Kpi label="ให้ไปเดือนนี้" value={`${num(earnedThisMonth)} คะแนน`} sub={monthKey} />
        <Kpi label="ตั๋วปิดยอดที่ยังไม่ได้คะแนน" value={`${missing.length} ใบ`} sub={`รวม ${num(missingPts)} คะแนน (ของเก่าก่อนเปิดระบบ)`} tone={missing.length ? 'amber' : 'green'} />
        <Kpi label="ลูกค้าที่จะมีคะแนน" value={`${sim.filter((r) => r.wouldEarn > 0).length} คน`} sub="จากตั๋วที่ปิดยอดแล้วทั้งหมด" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <SettingsPanel />
        <BackfillPanel missingCount={missing.length} missingPts={missingPts} />
      </div>

      <div className="mt-4"><CustomerPreviewPanel rows={sim} /></div>
      <div className="mt-4"><SimulationTable rows={sim} /></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <AdjustPanel />
        <LedgerPanel />
      </div>
    </div>
  );
}

// ── ตั้งค่า ──────────────────────────────────────────────────────────────────
function SettingsPanel() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const s = db.settings;
  const rate = pointsRates(s); // อัตราต่อชิ้น (มี fallback) — โชว์ตัวเลขผ่านตัวนี้เท่านั้น
  const set = (patch: Partial<ShopSettings>) => { dispatch(updateSettings(patch)); };
  // DNA react-state: ช่องตัวเลขเป็นคอมโพเนนต์ระดับบนสุด (NumField) — ถ้าประกาศในฟังก์ชันนี้จะ remount ทุกครั้งที่พิมพ์ → โฟกัสหลุด
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">⚙️ ตั้งค่า</div>
      <div className="mb-4 text-[12.5px] text-ink-faint">ทุกหน้าคิดคะแนนผ่านสูตรกลาง (points.ts) — แก้ที่นี่มีผลทันทีทั้งฝั่งลูกค้าและแอดมิน</div>

      <button
        onClick={() => { const v = !s.points_enabled; if (confirm(v ? 'เปิดระบบคะแนน? ตั้งแต่นี้ตั๋วที่ปิดยอดจะได้คะแนนจริง (ของเก่าใช้ปุ่ม "ให้คะแนนย้อนหลัง")' : 'ปิดระบบคะแนน? คะแนนที่มีอยู่ยังอยู่ แค่หยุดให้ใหม่')) { set({ points_enabled: v }); flash(v ? 'เปิดระบบคะแนนแล้ว' : 'ปิดระบบคะแนนแล้ว (พรีวิว)'); } }}
        className={cx('mb-4 w-full rounded-xl border px-4 py-3 text-left', s.points_enabled ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.10]' : 'border-[#d97706]/40 bg-[#d97706]/[0.10]')}
      >
        <div className="flex items-center justify-between">
          <span className="font-bold">{s.points_enabled ? '● ระบบเปิดอยู่' : '○ ระบบปิด (โหมดพรีวิว)'}</span>
          <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11.5px] font-bold text-ink-muted2">{s.points_enabled ? 'กดเพื่อปิด' : 'กดเพื่อเปิด'}</span>
        </div>
        <div className="mt-1 text-[12px] text-ink-muted2">{s.points_enabled ? 'ตั๋วที่ปิดยอดตั้งแต่นี้ได้คะแนนอัตโนมัติในจังหวะที่แอดมินกดอนุมัติ' : 'ดูตัวเลขจำลองได้ครบ แต่ยังไม่มีใครได้คะแนนจริง — เปิดเมื่อตัวเลขลงตัว'}</div>
      </button>

      <div className="grid gap-3 sm:grid-cols-2">
        <NumField s={s} onChange={set} k="points_per_piece_pre" label="คะแนน/ชิ้น · ใบพรี" hint="กำไร 200-250/ชิ้น → 20 = ~10% ทุกราคา" />
        <NumField s={s} onChange={set} k="points_per_piece_instock" label="คะแนน/ชิ้น · พร้อมส่ง / จ่ายเต็ม" hint="กำไร in-stock สูงกว่า (ราคาบวก 200-400)" />
        <NumField s={s} onChange={set} k="points_min_redeem" label="ใช้ขั้นต่ำต่อครั้ง" hint="เฟสใช้คะแนน" />
        <NumField s={s} onChange={set} k="points_max_per_piece_pre" label="เพดานลด/ชิ้น · ส่วนต่างใบพรี" hint="กันชิ้นเดียวกำไรติดลบ" />
        <NumField s={s} onChange={set} k="points_max_per_piece_instock" label="เพดานลด/ชิ้น · พร้อมส่ง" hint="ราคา in-stock บวกจากพรี 200-400" />
        <NumField s={s} onChange={set} k="points_expire_months" label="หมดอายุเมื่อไม่เคลื่อนไหว (เดือน)" hint="ตัวกวาดยังไม่เปิด — ปีแรกไม่มีใครถึง" />
      </div>

      <div className="mt-4 rounded-xl border border-subtle bg-surface-3/40 p-3 text-[12px] text-ink-muted2">
        <div className="mb-1 font-bold text-ink">ตัวอย่าง กำไร 200/ชิ้น (ไม่ว่าของราคา 800 หรือ 4,000)</div>
        ใบพรี: ลูกค้าได้ <b className="text-ink">{rate.pre}</b>/ชิ้น · ร้านเหลือ <b className="text-[#4ade80]">{200 - rate.pre} ฿ ({Math.round(((200 - rate.pre) / 200) * 100)}%)</b>
        <br />พร้อมส่ง (กำไร ~400): ได้ <b className="text-ink">{rate.instock}</b>/ชิ้น · ร้านเหลือ <b className="text-[#4ade80]">{400 - rate.instock} ฿ ({Math.round(((400 - rate.instock) / 400) * 100)}%)</b>
        <br />เท่ากันทุกราคา ทุกขนาดลูกค้า · ด่าน 500/1,000/2,000 = {Math.ceil(500 / Math.max(1, rate.pre))}/{Math.ceil(1000 / Math.max(1, rate.pre))}/{Math.ceil(2000 / Math.max(1, rate.pre))} ชิ้นพรี
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11.5px]">
        {MILESTONES.map((m) => (
          <span key={m.threshold} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1 text-ink-muted2">{m.emoji} {num(m.threshold)} · {m.label} → {m.perks.join(' + ')}</span>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-ink-faint">Milestone นับ "สะสมตลอดชีพ" รางวัลเป็นสิทธิ์ (ยังไม่บังคับใช้อัตโนมัติในเฟสนี้ — แอดมินดูป้ายแล้วจัดให้)</div>
    </div>
  );
}

// ── ย้อนหลัง ─────────────────────────────────────────────────────────────────
function BackfillPanel({ missingCount, missingPts }: { missingCount: number; missingPts: number }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const adminId = useCurrentUserId();
  const { flash } = useToast();
  const [open, setOpen] = useState(false);
  const missing = useMemo(() => ticketsMissingEarn(db), [db]);
  const byUser = useMemo(() => {
    const m = new Map<string, { n: number; pts: number }>();
    for (const t of missing) { const r = m.get(t.owner_id) ?? { n: 0, pts: 0 }; r.n += 1; r.pts += rawPointsForTicket(db.settings, t); m.set(t.owner_id, r); }
    return [...m.entries()].sort((a, b) => b[1].pts - a[1].pts);
  }, [missing, db.settings]);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? uid;

  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">🕰️ ตั๋วที่ปิดยอดแล้วแต่ยังไม่ได้คะแนน</div>
      <div className="mb-3 text-[12.5px] text-ink-faint">ของเก่าที่จบก่อนเปิดระบบ (หรือเซฟล้มกลางคัน) — เจ้าของตัดสินใจเองว่าจะนับย้อนหลังไหม · กดแล้ว "ทุกใบ" ในรายการได้คะแนนตามสูตรปัจจุบัน · id แถวผูกตั๋ว กดซ้ำไม่ซ้ำ</div>
      <div className="mb-3 flex items-end gap-4">
        <div><div className="text-[11.5px] text-ink-faint">ตั๋ว</div><div className="text-[22px] font-extrabold">{missingCount} <span className="text-[13px] font-semibold text-ink-muted2">ใบ</span></div></div>
        <div><div className="text-[11.5px] text-ink-faint">คะแนนรวม</div><div className="text-[22px] font-extrabold text-[#fbbf24]">{num(missingPts)}</div></div>
        <div><div className="text-[11.5px] text-ink-faint">ลูกค้า</div><div className="text-[22px] font-extrabold">{byUser.length} <span className="text-[13px] font-semibold text-ink-muted2">คน</span></div></div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button disabled={!missingCount} onClick={() => setOpen((v) => !v)} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-ink-muted2 disabled:opacity-40">{open ? 'ซ่อนรายชื่อ' : 'ดูรายชื่อ'}</button>
        <button
          disabled={!missingCount}
          onClick={() => { if (confirm(`ให้คะแนนย้อนหลัง ${missingCount} ใบ รวม ${num(missingPts)} คะแนน ให้ ${byUser.length} คน?\n\nทำงานแม้ระบบยังปิด — ลูกค้าจะเห็นคะแนนทันที`)) { dispatch(backfillPoints(adminId)); flash(`ให้คะแนนย้อนหลังแล้ว ${num(missingPts)} คะแนน`); } }}
          className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-40"
        >ให้คะแนนย้อนหลังทั้งหมด</button>
      </div>
      {open && (
        <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-subtle">
          {byUser.map(([uid, r]) => (
            <div key={uid} className="flex items-center gap-3 border-b border-hair px-3 py-2 text-[12.5px] last:border-0">
              <Link href={`/admin/customers/${uid}`} className="flex-1 truncate font-semibold hover:underline">{name(uid)}</Link>
              <span className="text-ink-faint">{r.n} ใบ</span>
              <span className="w-16 text-right font-bold text-[#fbbf24]">+{num(r.pts)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── จำลองทั้งร้าน ─────────────────────────────────────────────────────────────
function SimulationTable({ rows }: { rows: ReturnType<typeof simulateAll> }) {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '(ไม่พบ)';
  const list = rows.filter((r) => !q || name(r.userId).toLowerCase().includes(q.toLowerCase()));
  const shown = showAll ? list : list.slice(0, 25);
  const tot = rows.reduce((a, r) => ({ would: a.would + r.wouldEarn, earned: a.earned + r.earned, bal: a.bal + r.balance }), { would: 0, earned: 0, bal: 0 });
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-bold">🔎 จำลองทั้งร้าน · ใครควรมีกี่คะแนน</span>
        <span className="text-[11.5px] text-ink-faint">คิดจากตั๋วที่ "ปิดยอดแล้วจริง" ในระบบ ณ ตอนนี้ · เทียบกับที่ให้ไปแล้ว</span>
        <input className={cx(inputCls, 'ml-auto max-w-[220px] !py-1.5')} placeholder="ค้นชื่อลูกค้า" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-[12px] text-ink-muted2">
        <span>ควรมีรวม <b className="text-ink">{num(tot.would)}</b></span>
        <span>ให้แล้ว <b className="text-[#4ade80]">{num(tot.earned)}</b></span>
        <span>ยังไม่ให้ <b className="text-[#fbbf24]">{num(tot.would - tot.earned)}</b></span>
        <span>คงเหลือรวม (หนี้) <b className="text-primary-soft">{num(tot.bal)}</b></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[12.5px]">
          <thead className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
            <tr className="border-b border-subtle">
              <th className="py-2 pr-2">ลูกค้า</th>
              <th className="px-2 text-right">ตั๋วปิดยอด</th>
              <th className="px-2 text-right">ควรมี</th>
              <th className="px-2 text-right">ให้แล้ว</th>
              <th className="px-2 text-right">ยังไม่ให้</th>
              <th className="px-2 text-right">คงเหลือ</th>
              <th className="px-2 text-right">สะสมชีพ</th>
              <th className="pl-2">Milestone</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const mp = milestoneProgress(r.wouldEarn); // พรีวิว: ถ้าให้ครบทุกใบ จะอยู่ด่านไหน
              const reached = mp.reached[mp.reached.length - 1];
              return (
                <tr key={r.userId} className="border-b border-hair">
                  <td className="py-2 pr-2"><Link href={`/admin/customers/${r.userId}`} className="font-semibold hover:underline">{name(r.userId)}</Link></td>
                  <td className="px-2 text-right tabular-nums">{r.closedTickets}</td>
                  <td className="px-2 text-right font-bold tabular-nums">{num(r.wouldEarn)}</td>
                  <td className="px-2 text-right tabular-nums text-[#4ade80]">{num(r.earned)}</td>
                  <td className={cx('px-2 text-right tabular-nums', r.missing ? 'font-bold text-[#fbbf24]' : 'text-ink-faint')}>{r.missing ? `+${num(r.missing)}` : '—'}</td>
                  <td className="px-2 text-right font-bold tabular-nums text-primary-soft">{num(r.balance)}</td>
                  <td className="px-2 text-right tabular-nums text-ink-muted2">{num(r.lifetime)}</td>
                  <td className="pl-2 text-[11.5px]">
                    {reached ? <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-bold">{reached.emoji} {reached.label}</span> : <span className="text-ink-faint">—</span>}
                    {mp.next && <span className="ml-1 text-ink-faint">อีก {num(mp.need)} → {mp.next.emoji}</span>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-ink-faint">ยังไม่มีตั๋วที่ปิดยอด</td></tr>}
          </tbody>
        </table>
      </div>
      {list.length > 25 && <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-[12px] font-bold text-ink-muted2 underline">{showAll ? 'แสดงน้อยลง' : `ดูทั้งหมด ${list.length} คน`}</button>}
    </div>
  );
}

// ── เติม/หักมือ ───────────────────────────────────────────────────────────────
function AdjustPanel() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const adminId = useCurrentUserId();
  const { flash } = useToast();
  const [uid, setUid] = useState('');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const members = db.users.filter((u) => !u.is_admin && (!q || u.display_name.toLowerCase().includes(q.toLowerCase()) || (u.member_code ?? '').includes(q))).slice(0, 8);
  const d = Math.trunc(Number(delta) || 0);
  const bal = uid ? db.pointLedger.filter((e) => e.user_id === uid).reduce((s, e) => s + e.delta, 0) : 0;
  const bad = !uid || !d || !note.trim() || (d < 0 && bal + d < 0);
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">🛠️ เติม / หักคะแนนมือ</div>
      <div className="mb-3 text-[12.5px] text-ink-faint">ใช้กับเคสนอกสูตร: ตั๋วมอบเก็บเงินนอกระบบ, แก้ยอดหลังปิดยอด, ชดเชยลูกค้า · ต้องใส่เหตุผลเสมอ (ขึ้นในประวัติ)</div>
      <input className={cx(inputCls, 'mb-2')} placeholder="ค้นชื่อ / รหัสสมาชิก" value={q} onChange={(e) => { setQ(e.target.value); setUid(''); }} />
      {q && !uid && (
        <div className="mb-2 overflow-hidden rounded-lg border border-subtle">
          {members.map((u) => <button key={u.id} onClick={() => { setUid(u.id); setQ(u.display_name); }} className="block w-full border-b border-hair px-3 py-2 text-left text-[12.5px] last:border-0 hover:bg-surface-3">{u.display_name} <span className="text-ink-faint">{u.member_code ?? ''}</span></button>)}
          {members.length === 0 && <div className="px-3 py-2 text-[12px] text-ink-faint">ไม่พบ</div>}
        </div>
      )}
      {uid && <div className="mb-2 text-[12px] text-ink-muted2">คงเหลือปัจจุบัน <b className="text-ink">{num(bal)}</b> คะแนน</div>}
      <div className="grid grid-cols-[120px_1fr] gap-2">
        <input type="number" className={inputCls} placeholder="+50 / -20" value={delta} onChange={(e) => setDelta(e.target.value)} />
        <input className={inputCls} placeholder="เหตุผล (บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {d < 0 && bal + d < 0 && <div className="mt-1 text-[11.5px] text-primary-soft">หักเกินยอดคงเหลือไม่ได้</div>}
      <button disabled={bad} onClick={() => { dispatch(adjustPoints(adminId, uid, d, note)); flash(`${d > 0 ? 'เติม' : 'หัก'} ${Math.abs(d)} คะแนนแล้ว`); setDelta(''); setNote(''); }} className="mt-3 rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-40">บันทึก</button>
    </div>
  );
}

// ── สมุดบัญชีล่าสุด ───────────────────────────────────────────────────────────
function LedgerPanel() {
  const db = useDatabase();
  const rows = [...db.pointLedger].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 40);
  const name = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? uid;
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">📒 สมุดคะแนนล่าสุด</div>
      <div className="mb-3 text-[12.5px] text-ink-faint">เขียนเพิ่มอย่างเดียว ไม่แก้ย้อนหลัง · {db.pointLedger.length} แถวทั้งหมด</div>
      {rows.length === 0 ? <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีแถวในสมุด — เปิดระบบหรือกดให้คะแนนย้อนหลังก่อน</div> : (
        <div className="max-h-[420px] overflow-auto divide-y divide-hair">
          {rows.map((e) => {
            const k = KIND_LABEL[e.kind] ?? { label: e.kind, emoji: '•' };
            return (
              <div key={e.id} className="flex items-start gap-2.5 py-2 text-[12.5px]">
                <span className="w-[92px] shrink-0 text-[11px] text-ink-faint">{fmtDT(e.created_at)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate"><Link href={`/admin/customers/${e.user_id}`} className="font-semibold hover:underline">{name(e.user_id)}</Link> <span className="text-ink-faint">· {k.emoji} {k.label}</span></div>
                  {e.note && <div className="truncate text-[11.5px] text-ink-muted2">{e.note}</div>}
                </div>
                <span className={cx('w-16 shrink-0 text-right font-extrabold tabular-nums', e.delta > 0 ? 'text-[#4ade80]' : 'text-primary-soft')}>{e.delta > 0 ? `+${num(e.delta)}` : num(e.delta)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 text-[11px] text-ink-faint">วันที่แถวแรกของแต่ละคน = จุดเริ่มนับหมดอายุ {db.settings.points_expire_months} เดือน (ยังไม่กวาด) · {fmtDate(rows[rows.length - 1]?.created_at)} เก่าสุดในหน้านี้</div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' | 'amber' }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-2 p-3.5">
      <div className="text-[11.5px] text-ink-faint">{label}</div>
      <div className={cx('mt-0.5 text-[18px] font-extrabold', tone === 'red' ? 'text-primary-soft' : tone === 'green' ? 'text-[#4ade80]' : tone === 'amber' ? 'text-[#fbbf24]' : 'text-ink')}>{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

/** ช่องตัวเลขตั้งค่า — ระดับบนสุดตาม DNA react-state (ห้ามประกาศในฟังก์ชันหน้า) */
function NumField({ s, k, label, hint, onChange }: { s: ShopSettings; k: keyof ShopSettings; label: string; hint?: string; onChange: (patch: Partial<ShopSettings>) => void }) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] font-semibold text-ink-muted2">{label}</div>
      <input type="number" className={inputCls} value={Number(s[k] ?? 0)} onChange={(e) => onChange({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<ShopSettings>)} />
      {hint && <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>}
    </label>
  );
}

// ── พรีวิวหน้าลูกค้า ───────────────────────────────────────────────────────────
/** เรนเดอร์ <PointsPanel> ตัวเดียวกับหน้า /points จริง (mode 'preview' = มุมลูกค้าล้วน ไม่มีส่วนแอดมิน)
 *  → แก้ UI ฝั่งลูกค้าที่ไหน พรีวิวนี้เปลี่ยนตามทันทีโดยไม่ต้องแก้ซ้ำ (เจ้าของ 2026-09-12) */
function CustomerPreviewPanel({ rows }: { rows: ReturnType<typeof simulateAll> }) {
  const db = useDatabase();
  const adminId = useCurrentUserId();
  const customers = db.users.filter((u) => !u.is_admin && u.id !== 'u-admin');
  const firstWithPoints = rows.find((r) => r.wouldEarn > 0 || r.balance > 0)?.userId;
  const [uid, setUid] = useState<string>(firstWithPoints ?? customers[0]?.id ?? adminId);
  const [q, setQ] = useState('');
  const [simOn, setSimOn] = useState(true);
  const u = db.users.find((x) => x.id === uid);
  const matches = q ? customers.filter((c) => c.display_name.toLowerCase().includes(q.toLowerCase()) || (c.member_code ?? '').includes(q)).slice(0, 8) : [];
  const enabledNow = db.settings.points_enabled;
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-bold">👀 พรีวิวหน้าลูกค้า</span>
        <span className="text-[11.5px] text-ink-faint">หน้าจอเดียวกับที่ลูกค้าเห็นที่ /points — ใช้คอมโพเนนต์ตัวเดียวกัน แก้ฝั่งลูกค้าที่นี่เปลี่ยนตามอัตโนมัติ</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <input className={cx(inputCls, 'w-[240px] !py-1.5')} placeholder={u ? `ดูเป็น: ${u.display_name}` : 'ค้นชื่อลูกค้า'} value={q} onChange={(e) => setQ(e.target.value)} />
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-subtle bg-surface-2 shadow-lg">
              {matches.map((c) => <button key={c.id} onClick={() => { setUid(c.id); setQ(''); }} className="block w-full border-b border-hair px-3 py-2 text-left text-[12.5px] last:border-0 hover:bg-surface-3">{c.display_name} <span className="text-ink-faint">{c.member_code ?? ''}</span></button>)}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px]">
          <input type="checkbox" checked={simOn} onChange={(e) => setSimOn(e.target.checked)} />
          จำลองว่า "เปิดระบบแล้ว"
        </label>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-bold', (simOn || enabledNow) ? 'bg-[#16a34a]/[0.18] text-[#4ade80]' : 'bg-[#d97706]/[0.18] text-[#fbbf24]')}>
          {enabledNow ? 'ตอนนี้ลูกค้าเห็นแบบนี้จริง' : simOn ? 'ลูกค้าจะเห็นแบบนี้ "หลังกดเปิด"' : 'ตอนนี้ลูกค้าเห็นแบบนี้ (ระบบปิด)'}
        </span>
      </div>
      {/* กรอบมือถือ 375px = ขนาดจริงที่ลูกค้าส่วนใหญ่ใช้ */}
      <div className="mx-auto w-[375px] max-w-full overflow-hidden rounded-[28px] border-[6px] border-black/60 bg-base shadow-2xl">
        <div className="flex items-center gap-3 border-b border-hair px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-full border border-subtle bg-surface-3 text-ink">‹</span>
          <span className="text-[15px] font-bold">คะแนนสะสม</span>
        </div>
        <div className="max-h-[720px] overflow-y-auto p-4 text-ink">
          {u ? <PointsPanel userId={u.id} mode="preview" simulateEnabled={simOn ? true : undefined} /> : <div className="py-8 text-center text-ink-faint">ยังไม่มีลูกค้า</div>}
        </div>
      </div>
    </div>
  );
}
