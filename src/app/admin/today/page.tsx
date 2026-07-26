'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { worklist, dataIssues, plansDue, plansUpcoming, type WorkItem, type DataIssue } from '@/domain/services/worklist';
import { closePaymentPlan, markPlanReminded, releaseStuckHold, reclaimCouponGrantsFor, repairTickets, logActivity } from '@/data/mutations';
import { releaseReservation } from '@/lib/reserve';
import { sendPush, subsForUsers, pushEnabled } from '@/lib/push';

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * "งานค้างวันนี้" — ศูนย์รวมงานที่ต้องลงมือจากทุกโมดูล + เครื่องมือซ่อมข้อมูล + นัดชำระ + ประวัติการกระทำ
 * (เจ้าของ 2026-07-25). เปิดหน้าเดียวรู้ว่าวันนี้ต้องทำอะไร แทนการไล่เปิด 5 หน้า.
 */
export default function TodayPage() {
  const db = useDatabase();
  const router = useRouter();
  const [tab, setTab] = useState<'work' | 'plans' | 'health' | 'log'>('work');

  const items = worklist(db);
  const issues = dataIssues(db);
  const due = plansDue(db);
  const nowCount = items.filter((i) => i.urgency === 'now').reduce((s, i) => s + i.count, 0);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">งานค้างวันนี้</div>
      <div className="mb-4 text-[13px] text-ink-faint">
        {nowCount > 0 ? `มี ${nowCount} รายการที่ควรทำก่อน` : 'ไม่มีงานด่วนค้าง 🎉'} · รวมทุกโมดูลไว้ที่เดียว
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Tab active={tab === 'work'} onClick={() => setTab('work')}>📋 งานค้าง {items.length > 0 && <B>{items.reduce((s, i) => s + i.count, 0)}</B>}</Tab>
        <Tab active={tab === 'plans'} onClick={() => setTab('plans')}>📅 นัดชำระ {due.length > 0 && <B>{due.length}</B>}</Tab>
        <Tab active={tab === 'health'} onClick={() => setTab('health')}>🩺 สุขภาพข้อมูล {issues.length > 0 && <B>{issues.length}</B>}</Tab>
        <Tab active={tab === 'log'} onClick={() => setTab('log')}>🕘 ประวัติการกระทำ</Tab>
      </div>

      {tab === 'work' && (
        items.length === 0
          ? <Empty text="เคลียร์หมดแล้ว ไม่มีงานค้าง 🎉" />
          : <div className="grid gap-2.5 lg:grid-cols-2">{items.map((w) => <WorkCard key={w.key} w={w} onGo={() => router.push(w.href)} />)}</div>
      )}
      {tab === 'plans' && <PlansTab />}
      {tab === 'health' && <HealthTab issues={issues} />}
      {tab === 'log' && <LogTab />}
    </div>
  );
}

const URG: Record<string, { label: string; cls: string; ring: string }> = {
  now: { label: 'ทำก่อน', cls: 'bg-[#b91c1c]/20 text-[#f87171]', ring: 'border-[#b91c1c]/45' },
  today: { label: 'วันนี้', cls: 'bg-[#d97706]/20 text-[#fbbf24]', ring: 'border-[#d97706]/40' },
  soon: { label: 'เมื่อว่าง', cls: 'bg-white/[0.07] text-ink-muted2', ring: 'border-subtle' },
};

function WorkCard({ w, onGo }: { w: WorkItem; onGo: () => void }) {
  const u = URG[w.urgency];
  return (
    <button onClick={onGo} className={cx('flex items-center gap-3 rounded-2xl border bg-surface-2 p-4 text-left', u.ring, w.urgency === 'now' && 'animate-pulseRed')}>
      <span className="text-[26px]">{w.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-bold text-ink">{w.title}</span>
          <span className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-extrabold', u.cls)}>{u.label}</span>
        </span>
        {w.detail && <span className="mt-0.5 block text-[11.5px] text-ink-faint">{w.detail}</span>}
        {w.money ? <span className="mt-0.5 block text-[11.5px] font-bold text-[#4ade80]">{baht(w.money)}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[22px] font-extrabold text-primary-soft">{w.count}</span>
        <span className="text-[11px] text-ink-faint">ไปทำ →</span>
      </span>
    </button>
  );
}

/* ── นัดชำระ ── */
function PlansTab() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();
  const due = plansDue(db);
  const upcoming = plansUpcoming(db);
  const today = new Date().toISOString().slice(0, 10);

  const remind = (planId: string, userId: string, amount: number) => {
    if (pushEnabled(db, 'parcel'))
      sendPush(subsForUsers(db, [userId]), { title: '📅 ถึงกำหนดชำระแล้วครับ', body: `ยอดที่นัดไว้ ${baht(amount)} — โอนแล้วแจ้งแอดมินได้เลย`, url: '/wallet' }, dispatch).catch(() => {});
    dispatch(markPlanReminded(planId));
    dispatch(logActivity(me, 'remind_plan', `เตือนนัดชำระ ${baht(amount)}`, { targetId: planId, amount }));
    flash('ส่งเตือนลูกค้าแล้ว 🔔');
  };
  const close = (planId: string, status: 'done' | 'cancelled', amount: number) => {
    if (!confirm(status === 'done' ? 'ยืนยันว่าลูกค้าจ่ายแล้ว?' : 'ยกเลิกนัดชำระนี้?')) return;
    dispatch(closePaymentPlan(planId, status));
    dispatch(logActivity(me, 'close_plan', `${status === 'done' ? 'ปิดนัดชำระ (จ่ายแล้ว)' : 'ยกเลิกนัดชำระ'} ${baht(amount)}`, { targetId: planId, amount }));
    flash(status === 'done' ? 'ปิดนัดชำระแล้ว ✓' : 'ยกเลิกแล้ว');
  };

  const Row = ({ p }: { p: (typeof due)[number] }) => {
    const u = db.users.find((x) => x.id === p.user_id);
    const overdue = p.due_date < today;
    return (
      <div className={cx('rounded-xl border bg-surface-2 p-3.5', overdue ? 'border-[#b91c1c]/45' : 'border-subtle')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-bold">{u?.display_name ?? '—'}</span>
          <span className={cx('rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold', overdue ? 'animate-blink bg-[#b91c1c]/25 text-[#f87171]' : 'bg-[#d97706]/20 text-[#fbbf24]')}>
            {overdue ? `เลยกำหนด ${p.due_date}` : `ครบกำหนด ${p.due_date}`}
          </span>
          <span className="ml-auto text-[15px] font-extrabold text-primary-soft">{baht(p.amount)}</span>
        </div>
        <div className="mt-1 text-[11.5px] text-ink-muted2">{p.items.map((i) => `${i.label} ×${i.qty}`).join(' · ')}</div>
        {p.note && <div className="mt-0.5 text-[11.5px] text-ink-faint">📝 {p.note}</div>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => remind(p.id, p.user_id, p.amount)} className="rounded-lg border border-[#a855f7]/50 px-3 py-1.5 text-[12px] font-bold text-[#c084fc]">🔔 เตือนลูกค้า</button>
          <button onClick={() => close(p.id, 'done', p.amount)} className="rounded-lg bg-success px-3 py-1.5 text-[12px] font-bold text-white">✓ จ่ายแล้ว</button>
          <button onClick={() => close(p.id, 'cancelled', p.amount)} className="rounded-lg border border-subtle px-3 py-1.5 text-[12px] text-ink-faint">ยกเลิก</button>
          {p.reminded_at && <span className="self-center text-[11px] text-ink-faint">เตือนล่าสุด {fmtTime(p.reminded_at)}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Section title={`ถึงกำหนด / เลยกำหนด (${due.length})`} sub="ลูกค้านัดว่าจะจ่ายวันนี้หรือก่อนหน้า">
        {due.length === 0 ? <Empty text="ไม่มีนัดที่ถึงกำหนด" /> : <div className="flex flex-col gap-2.5">{due.map((p) => <Row key={p.id} p={p} />)}</div>}
      </Section>
      <Section title={`นัดล่วงหน้า (${upcoming.length})`} sub="ยังไม่ถึงกำหนด — ไว้ดูแผนเงินเข้า">
        {upcoming.length === 0 ? <Empty text="ยังไม่มีนัดล่วงหน้า" /> : <div className="flex flex-col gap-2.5">{upcoming.map((p) => <Row key={p.id} p={p} />)}</div>}
      </Section>
    </div>
  );
}

/* ── สุขภาพข้อมูล ── */
function HealthTab({ issues }: { issues: DataIssue[] }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const me = useCurrentUserId();

  if (issues.length === 0) return <Empty text="ข้อมูลสะอาด ไม่พบปัญหา 🎉" />;

  const doFix = async (iss: DataIssue, rowId: string, label: string) => {
    if (iss.fix === 'release_hold') {
      if (!confirm(`ปล่อยของที่ถูกกันไว้: ${label}?`)) return;
      await releaseReservation(rowId).catch(() => {});
      dispatch(releaseStuckHold(rowId));
      dispatch(logActivity(me, 'release_hold', `ปล่อย hold ค้าง: ${label}`, { targetId: rowId }));
      flash('ปล่อยของกลับเข้าสต๊อกแล้ว ✓');
    } else if (iss.fix === 'reclaim_coupons') {
      if (!confirm(`คืนคูปองให้ ${label}?`)) return;
      dispatch(reclaimCouponGrantsFor(rowId));
      dispatch(logActivity(me, 'reclaim_coupons', `คืนคูปองให้ ${label}`, { targetId: rowId }));
      flash('คืนคูปองแล้ว ✓');
    }
  };
  const repairAll = () => {
    if (!confirm('ออกตั๋วที่หายให้ครบทุกออเดอร์ที่อนุมัติแล้ว?')) return;
    dispatch(repairTickets());
    dispatch(logActivity(me, 'repair_tickets', 'ซ่อมตั๋วที่หายจากออเดอร์ที่อนุมัติแล้ว'));
    flash('ซ่อมตั๋วแล้ว ✓');
  };

  const SEV: Record<string, string> = { high: 'border-[#b91c1c]/45 bg-[#b91c1c]/[0.07]', mid: 'border-[#d97706]/40 bg-[#d97706]/[0.06]', low: 'border-subtle bg-surface-2' };
  return (
    <div className="flex flex-col gap-3">
      {issues.map((iss) => (
        <div key={iss.key} className={cx('rounded-2xl border p-4', SEV[iss.severity])}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-extrabold text-ink">{iss.title}</span>
            <span className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[11px] font-bold text-ink-muted2">{iss.rows.length} รายการ</span>
            {iss.fix === 'repair_tickets' && <button onClick={repairAll} className="ml-auto rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">🔧 ซ่อมทั้งหมด</button>}
          </div>
          <div className="mt-1 text-[12px] text-ink-muted2">{iss.why}</div>
          <div className="mt-2.5 flex flex-col divide-y divide-hair">
            {iss.rows.slice(0, 12).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                <span className="min-w-[140px] flex-1 font-semibold">{r.label}</span>
                {r.sub && <span className="text-[11.5px] text-ink-faint">{r.sub}</span>}
                {(iss.fix === 'release_hold' || iss.fix === 'reclaim_coupons') && (
                  <button onClick={() => doFix(iss, r.id, r.label)} className="rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-bold text-primary-soft">
                    {iss.fix === 'release_hold' ? 'ปล่อยของ' : 'คืนคูปอง'}
                  </button>
                )}
              </div>
            ))}
            {iss.rows.length > 12 && <div className="py-1.5 text-[11.5px] text-ink-faint">…และอีก {iss.rows.length - 12} รายการ</div>}
          </div>
        </div>
      ))}
      <div className="text-[11.5px] text-ink-faint">💡 ปัญหาที่ไม่มีปุ่มแก้อัตโนมัติ ต้องไปจัดการในหน้าที่เกี่ยวข้อง (ระบุไว้ในคำอธิบาย)</div>
    </div>
  );
}

/* ── ประวัติการกระทำ ── */
function LogTab() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const rows = db.activityLogs
    .filter((l) => !q.trim() || `${l.actor_name} ${l.summary} ${l.target_label ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 200);
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold">ใครทำอะไร เมื่อไหร่</span>
        <span className="text-[11.5px] text-ink-faint">เก็บอัตโนมัติเมื่อมีการอนุมัติ/แก้เงิน/ลบ — ตามรอยได้เวลามีผู้ช่วยหลายคน</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา ชื่อคน / รายการ" className="ml-auto w-full max-w-[240px] rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint" />
      </div>
      {rows.length === 0 ? <Empty text={db.activityLogs.length === 0 ? 'ยังไม่มีประวัติ (เริ่มบันทึกตั้งแต่ migration v56)' : 'ไม่พบรายการที่ค้นหา'} /> : (
        <div className="flex flex-col divide-y divide-hair">
          {rows.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
              <span className="w-[108px] shrink-0 text-[11px] text-ink-faint">{fmtTime(l.created_at)}</span>
              <span className="w-[110px] shrink-0 truncate font-semibold text-ink">{l.actor_name}</span>
              <span className="min-w-[160px] flex-1">{l.summary}</span>
              {l.target_label && <span className="font-mono text-[11px] text-ink-faint">{l.target_label}</span>}
              {l.amount ? <span className="font-bold text-[#4ade80]">{baht(l.amount)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── ชิ้นส่วนเล็ก ── */
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[13px] font-bold', active ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{children}</button>;
}
function B({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-primary-bright px-[7px] text-[11px] font-bold text-white">{children}</span>;
}
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="text-[14px] font-bold text-ink">{title}</div>
      {sub && <div className="mb-2.5 text-[11.5px] text-ink-faint">{sub}</div>}
      {children}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-subtle bg-surface-2 py-10 text-center text-[13px] text-ink-faint">{text}</div>;
}
