'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { Icon, type IconName } from '@/components/Icon';
import { cx } from '@/components/ui';
import { ticketsInMonth, topFranchises, topMakers, ticketMonths, bellAdoption, installAdoption, currentYm, type RankRow } from '@/domain/services/analytics';
import { cashIn, outstanding, debtors, cashMonths } from '@/domain/services/money';
import { baht } from '@/lib/theme';

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${THAI_MONTHS[m - 1]} ${y}`; };

export default function AnalyticsPage() {
  const db = useDatabase();
  // เดือนที่เลือกได้ = เดือนที่มีใบพรี "หรือ" มีเงินเข้า (บางเดือนเก็บส่วนต่างอย่างเดียว ไม่มีตั๋วใหม่)
  const months = useMemo(() => [...new Set([...ticketMonths(db), ...cashMonths(db)])].sort().reverse(), [db]);
  const [ym, setYm] = useState(() => currentYm());
  const cash = useMemo(() => cashIn(db, ym), [db, ym]);
  const owed = useMemo(() => outstanding(db), [db]);
  const owing = useMemo(() => debtors(db).slice(0, 8), [db]);

  const tickets = useMemo(() => ticketsInMonth(db, ym), [db, ym]);
  const franchises = useMemo(() => topFranchises(db, tickets), [db, tickets]);
  const makers = useMemo(() => topMakers(db, tickets), [db, tickets]);
  const bell = useMemo(() => bellAdoption(db), [db]);
  const install = useMemo(() => installAdoption(db), [db]);

  const totalTickets = tickets.length;
  const totalPieces = tickets.reduce((s, t) => s + (t.qty || 1), 0);
  const bellPct = bell.total > 0 ? Math.round((bell.enabled / bell.total) * 100) : 0;
  const installPct = install.total > 0 ? Math.round((install.installed / install.total) * 100) : 0;

  return (
    <div>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-extrabold">วิเคราะห์รายเดือน</div>
          <div className="text-[13px] text-ink-faint">เงินเข้า-เงินค้าง + ยอดใบพรีแยกตามเรื่อง/ค่าย + การเปิดกระดิ่ง</div>
        </div>
        <label className="text-[11px] text-ink-faint">
          เลือกเดือน
          <select value={ym} onChange={(e) => setYm(e.target.value)} className="mt-0.5 block rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-[13px] font-semibold text-ink">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
      </div>

      {/* headline */}
      <div className="mb-[22px] grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="ใบพรีเดือนนี้" value={String(totalTickets)} sub={`${totalPieces} ชิ้น`} icon="box" />
        <Stat label="จำนวนเรื่อง" value={String(franchises.length)} icon="heart" />
        <Stat label="จำนวนค่าย" value={String(makers.length)} icon="tag" />
        <Stat label="เปิดกระดิ่ง" value={`${bell.enabled}/${bell.total}`} sub={`${bellPct}%`} icon="bell" green />
      </div>

      {/* ── เส้นเงิน (flow review 2026-07-25): เงินเข้าแยกที่มา + ค้างเก็บ ── */}
      <div className="mb-[18px] rounded-2xl border border-[#16a34a]/35 bg-[#16a34a]/[0.05] p-5">
        <div className="mb-3 flex items-center gap-2 text-base font-bold text-[#4ade80]"><Icon name="payments" size={18} /> เงินเข้า · {monthLabel(ym)}</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MoneyCard label="รับเข้าทั้งหมด" value={baht(cash.total)} tone="text-[#4ade80]" big />
          <MoneyCard label="มัดจำ / เต็มจำนวน" value={baht(cash.deposits)} sub={`${cash.orders} ออเดอร์อนุมัติ`} />
          <MoneyCard label="ส่วนต่างที่เก็บได้" value={baht(cash.remaining)} sub="ตอนของถึงไทย" />
          <MoneyCard label="มัดจำหาของ" value={baht(cash.sourcing)} sub="เริ่มงานแล้ว" />
          <MoneyCard label="ตั๋วที่มอบเอง" value={baht(cash.granted)} sub="เก็บเงินนอกระบบ" />
        </div>
        <div className="mt-2 text-[11px] text-ink-faint">นับตามวันที่ “รับเงินจริง” (วันอนุมัติสลิป) · ยอดมัดจำเป็นยอดสุทธิหลังหักคูปองแล้ว</div>
      </div>

      {/* ค้างเก็บ + ใครค้างบ้าง */}
      <div className="mb-[18px] rounded-2xl border border-[#d97706]/35 bg-[#d97706]/[0.05] p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-base font-bold text-[#fbbf24]">
          <Icon name="warning" size={18} /> ค้างเก็บทั้งระบบ <span className="text-[19px] text-primary-soft">{baht(owed.total)}</span>
          <span className="text-[12px] font-semibold text-ink-faint">{owed.tickets} ใบ · {owed.customers} คน</span>
        </div>
        <div className="mb-3 flex flex-wrap gap-1.5 text-[11.5px] font-bold">
          <span className="rounded-md bg-[#d97706]/20 px-2 py-0.5 text-[#fbbf24]">ทวงได้แล้ว {baht(owed.collectable)} · ของถึงไทย</span>
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-ink-muted2">ยังไม่ถึงกำหนด {baht(owed.notYet)} · ของยังไม่ถึง</span>
          {owed.shippedUnpaid > 0 && <span className="animate-blink rounded-md bg-[#b91c1c]/25 px-2 py-0.5 text-[#f87171]">⚠ ส่งของแล้วยังค้าง {baht(owed.shippedUnpaid)}</span>}
        </div>
        {owing.length === 0 ? <div className="text-[13px] text-ink-faint">ไม่มีใครค้าง 🎉</div> : (
          <div className="flex flex-col divide-y divide-hair">
            {owing.map((d) => (
              <div key={d.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                <span className="min-w-[130px] flex-1 truncate font-semibold">{d.name}</span>
                <span className="text-[11.5px] text-ink-faint">{d.tickets.length} ใบ</span>
                {d.collectable > 0 && <span className="rounded-md bg-[#d97706]/20 px-1.5 py-0.5 text-[11px] font-bold text-[#fbbf24]">ทวงได้ {baht(d.collectable)}</span>}
                <span className="w-[92px] text-right font-extrabold text-primary-soft">{baht(d.due)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <RankCard title="ยอดใบพรี · เรื่องไหนเยอะสุด" emptyText="ยังไม่มีใบพรีเดือนนี้" rows={franchises} accent="#f472b6" />
        <RankCard title="ยอดใบพรี · ค่ายไหนเยอะสุด" emptyText="ยังไม่มีใบพรีเดือนนี้" rows={makers} accent="#60a5fa" />
      </div>

      {/* adoption (now snapshot): ลงหน้าจอ + เปิดกระดิ่ง */}
      <div className="mt-[18px] grid gap-[18px] lg:grid-cols-2">
        <AdoptionCard icon="home" title="ติดตั้งลงหน้าจอโทรศัพท์" hint="สมาชิกที่เคยเปิดแอปจากไอคอนบนหน้าจอ (PWA) จากสมาชิกอนุมัติทั้งหมด" done={install.installed} total={install.total} pct={installPct} color="#60a5fa" fill="#2563eb" remainText="ยังไม่ติดตั้ง" />
        <AdoptionCard icon="bell" title="เปิดกระดิ่งแจ้งเตือน" hint="สมาชิกที่เปิดรับแจ้งเตือนอย่างน้อย 1 เครื่อง จากสมาชิกอนุมัติทั้งหมด" done={bell.enabled} total={bell.total} pct={bellPct} color="#4ade80" fill="#16a34a" remainText="ยังไม่เปิด" />
      </div>
      <div className="mt-2 text-[11.5px] text-ink-faint">💡 ตัวช่วยดันยอด: แบนเนอร์ + ป๊อปอัพในแอปคอยแนะนำคนที่ยังไม่ติดตั้ง/ยังไม่เปิดกระดิ่งอัตโนมัติ (ทุก 3 วัน)</div>
    </div>
  );
}

function MoneyCard({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: string; big?: boolean }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-2 px-3.5 py-3">
      <div className="text-[11.5px] text-ink-muted">{label}</div>
      <div className={cx('mt-0.5 font-extrabold', big ? 'text-[22px]' : 'text-[16px]', tone ?? 'text-ink')}>{value}</div>
      {sub && <div className="text-[10.5px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function RankCard({ title, rows, accent, emptyText }: { title: string; rows: RankRow[]; accent: string; emptyText: string }) {
  const max = Math.max(1, ...rows.map((r) => r.tickets));
  const shown = rows.slice(0, 12);
  const rest = rows.slice(12);
  const restTickets = rest.reduce((s, r) => s + r.tickets, 0);
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-4 text-base font-bold">{title}</div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-ink-faint">{emptyText}</div>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((r, i) => (
            <div key={r.name}>
              <div className="mb-1 flex items-center justify-between gap-2 text-[12.5px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cx('grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold', i === 0 ? 'bg-[#d4af37] text-black' : 'bg-white/[0.08] text-ink-muted2')}>{i + 1}</span>
                  <span className="truncate font-semibold text-ink">{r.name}</span>
                </span>
                <span className="shrink-0 text-ink-muted">{r.tickets} ใบ{r.pieces !== r.tickets ? ` · ${r.pieces} ชิ้น` : ''}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full transition-all" style={{ width: `${(r.tickets / max) * 100}%`, background: accent }} />
              </div>
            </div>
          ))}
          {rest.length > 0 && <div className="pt-0.5 text-[11.5px] text-ink-faint">+ อีก {rest.length} รายการ · {restTickets} ใบ</div>}
        </div>
      )}
    </div>
  );
}

function AdoptionCard({ icon, title, hint, done, total, pct, color, fill, remainText }: { icon: IconName; title: string; hint: string; done: number; total: number; pct: number; color: string; fill: string; remainText: string }) {
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-bold"><span style={{ color }}><Icon name={icon} size={18} /></span> {title} <span className="text-[11px] font-normal text-ink-faint">(ปัจจุบัน)</span></div>
      <div className="mb-3 text-[12.5px] text-ink-faint">{hint}</div>
      <div className="flex items-end gap-3">
        <div className="text-[34px] font-extrabold leading-none" style={{ color }}>{done}</div>
        <div className="pb-1 text-[15px] text-ink-muted2">/ {total} คน</div>
        <div className="flex-1" />
        <div className="pb-1 text-2xl font-extrabold" style={{ color }}>{pct}%</div>
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: fill }} />
      </div>
      <div className="mt-2 text-[11.5px] text-ink-faint">{remainText} {Math.max(0, total - done)} คน</div>
    </div>
  );
}

function Stat({ label, value, sub, icon, green }: { label: string; value: string; sub?: string; icon: IconName; green?: boolean }) {
  return (
    <div className="rounded-card border border-subtle bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] text-ink-muted">{label}</span>
        <Icon name={icon} size={18} className={green ? 'text-[#4ade80]' : 'text-ink-faint'} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <div className={cx('text-[26px] font-extrabold', green ? 'text-[#4ade80]' : 'text-ink')}>{value}</div>
        {sub && <div className="text-[12.5px] text-ink-faint">{sub}</div>}
      </div>
    </div>
  );
}
