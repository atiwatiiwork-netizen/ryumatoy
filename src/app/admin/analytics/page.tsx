'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { Icon, type IconName } from '@/components/Icon';
import { cx } from '@/components/ui';
import { ticketsInMonth, topFranchises, topMakers, ticketMonths, bellAdoption, currentYm, type RankRow } from '@/domain/services/analytics';

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${THAI_MONTHS[m - 1]} ${y}`; };

export default function AnalyticsPage() {
  const db = useDatabase();
  const months = useMemo(() => ticketMonths(db), [db]);
  const [ym, setYm] = useState(() => currentYm());

  const tickets = useMemo(() => ticketsInMonth(db, ym), [db, ym]);
  const franchises = useMemo(() => topFranchises(db, tickets), [db, tickets]);
  const makers = useMemo(() => topMakers(db, tickets), [db, tickets]);
  const bell = useMemo(() => bellAdoption(db), [db]);

  const totalTickets = tickets.length;
  const totalPieces = tickets.reduce((s, t) => s + (t.qty || 1), 0);
  const bellPct = bell.total > 0 ? Math.round((bell.enabled / bell.total) * 100) : 0;

  return (
    <div>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-extrabold">วิเคราะห์รายเดือน</div>
          <div className="text-[13px] text-ink-faint">ยอดใบพรีแยกตามเรื่อง/ค่าย + การเปิดกระดิ่งแจ้งเตือน</div>
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

      <div className="grid gap-[18px] lg:grid-cols-2">
        <RankCard title="ยอดใบพรี · เรื่องไหนเยอะสุด" emptyText="ยังไม่มีใบพรีเดือนนี้" rows={franchises} accent="#f472b6" />
        <RankCard title="ยอดใบพรี · ค่ายไหนเยอะสุด" emptyText="ยังไม่มีใบพรีเดือนนี้" rows={makers} accent="#60a5fa" />
      </div>

      {/* bell adoption (now snapshot) */}
      <div className="mt-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-1 flex items-center gap-2 text-base font-bold"><Icon name="bell" size={18} className="text-[#4ade80]" /> การเปิดกระดิ่งแจ้งเตือน <span className="text-[11px] font-normal text-ink-faint">(ปัจจุบัน)</span></div>
        <div className="mb-3 text-[12.5px] text-ink-faint">สมาชิกที่เปิดรับแจ้งเตือนอย่างน้อย 1 เครื่อง จากสมาชิกที่อนุมัติแล้วทั้งหมด</div>
        <div className="flex items-end gap-3">
          <div className="text-[34px] font-extrabold leading-none text-[#4ade80]">{bell.enabled}</div>
          <div className="pb-1 text-[15px] text-ink-muted2">/ {bell.total} คน</div>
          <div className="flex-1" />
          <div className="pb-1 text-2xl font-extrabold text-[#4ade80]">{bellPct}%</div>
        </div>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-[#16a34a] transition-all" style={{ width: `${bellPct}%` }} />
        </div>
        <div className="mt-2 text-[11.5px] text-ink-faint">ยังไม่เปิด {Math.max(0, bell.total - bell.enabled)} คน — กระตุ้นให้ติดตั้งแอปหน้าจอโฮม + เปิดกระดิ่งเพื่อรับข่าวรอบพรี/ของถึง</div>
      </div>
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
