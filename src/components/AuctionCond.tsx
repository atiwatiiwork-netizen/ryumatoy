'use client';

import type { AuctionCond } from '@/domain/entities';
import { NEW_AUCTION_COND } from '@/domain/entities';
import { cx } from './ui';
import { Icon } from './Icon';

/**
 * เช็คลิสต์สภาพของชิ้นที่ประมูล (เจ้าของ 2026-08-03: "รายละเอียดตำหนิ ทำเป็น Checklist").
 * ลำดับตามที่สั่งมาเป๊ะ: กล่องน้ำตาลเดิม (ไม่มี → ใส่กล่องอื่นให้) · กล่องสี · การ์ด · ตำหนิ (มี → แนบรูป)
 *
 * ทำไมต้องเป็นเช็คลิสต์ไม่ใช่ช่องพิมพ์: ของประมูลคืนยาก ลูกค้าต้องเห็น "ครบ/ไม่ครบ" แบบเดียวกันทุกห้อง
 * ช่องพิมพ์อิสระทำให้บางห้องลืมบอก แล้วกลายเป็นเรื่องกันทีหลัง
 */

/** ตัวติ๊กในฟอร์มแอดมิน */
export function AuctionCondPicker({ value, onChange }: { value?: AuctionCond; onChange: (c: AuctionCond) => void }) {
  const c = value ?? NEW_AUCTION_COND;
  const set = (patch: Partial<AuctionCond>) => onChange({ ...c, ...patch });

  const Row = ({ on, label, sub, onClick }: { on: boolean; label: string; sub?: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left',
        on ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.1]' : 'border-subtle bg-surface-3')}>
      <span className={cx('grid h-[18px] w-[18px] shrink-0 place-items-center rounded border',
        on ? 'border-[#4ade80] bg-[#16a34a] text-white' : 'border-subtle text-transparent')}>
        <Icon name="check" size={12} />
      </span>
      <span className="min-w-0">
        <span className={cx('block text-[13px] font-bold', on ? 'text-ink' : 'text-ink-muted')}>{label}</span>
        {sub && <span className="block text-[11.5px] text-ink-faint">{sub}</span>}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* มือ 1 / มือ 2 — เดิมโชว์อยู่แล้วในการ์ดสภาพสินค้า ถ้าตัดออกลูกค้าจะเสียข้อมูลสำคัญไป */}
      <div className="flex gap-1.5">
        {([1, 2] as const).map((h) => (
          <button key={h} type="button" onClick={() => set({ hand: h })}
            className={cx('flex-1 rounded-lg border px-3 py-2 text-[13px] font-bold',
              c.hand === h ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted')}>
            มือ {h}
          </button>
        ))}
      </div>

      <Row on={c.box_brown} label="กล่องน้ำตาลเดิม" onClick={() => set({ box_brown: !c.box_brown, box_brown_alt: false })} />
      {/* 1.1 โผล่เฉพาะตอนไม่มีกล่องเดิม — ตามที่เจ้าของสั่ง */}
      {!c.box_brown && (
        <div className="pl-5">
          <Row on={c.box_brown_alt} label="ใส่กล่องน้ำตาลอื่นให้แทน" sub="ไม่ใช่กล่องเดิมของตัวนี้ แต่ห่อกล่องน้ำตาลมาให้"
            onClick={() => set({ box_brown_alt: !c.box_brown_alt })} />
        </div>
      )}
      <Row on={c.box_color} label="กล่องสี" onClick={() => set({ box_color: !c.box_color })} />
      <Row on={c.card} label="การ์ด" onClick={() => set({ card: !c.card })} />
      <Row on={c.has_defect} label="มีตำหนิ" sub={c.has_defect ? 'บอกให้ชัดว่าตรงไหน แล้วแนบรูปตำหนิด้านล่าง' : 'ไม่ติ๊ก = สภาพสมบูรณ์ ไม่มีตำหนิ'}
        onClick={() => set({ has_defect: !c.has_defect, defect_note: c.has_defect ? undefined : c.defect_note })} />
      {c.has_defect && (
        <textarea
          value={c.defect_note ?? ''} onChange={(e) => set({ defect_note: e.target.value })} rows={2}
          placeholder="ตำหนิตรงไหน เช่น กล่องยุบมุมล่างซ้าย · สีถลอกที่ฐาน"
          className="w-full rounded-lg border border-[#d97706]/50 bg-surface-3 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
        />
      )}
    </div>
  );
}

const LINES = (c: AuctionCond) => [
  { on: c.box_brown, label: 'กล่องน้ำตาลเดิม', alt: !c.box_brown && c.box_brown_alt ? 'ใส่กล่องน้ำตาลอื่นให้แทน' : undefined },
  { on: c.box_color, label: 'กล่องสี' },
  { on: c.card, label: 'การ์ด' },
];

/** การ์ดที่ลูกค้าเห็นในห้องประมูล */
export function AuctionCondCard({ cond }: { cond: AuctionCond }) {
  return (
    <div className="flex flex-col gap-2 p-3.5">
      <div className="flex items-center gap-2 text-[13.5px] font-extrabold">
        สภาพสินค้า
        {cond.hand === 1
          ? <span className="rounded-full bg-[#16a34a]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80]">มือ 1</span>
          : <span className="rounded-full bg-[#d97706]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">มือ 2</span>}
      </div>

      <div className="flex flex-col gap-1">
        {LINES(cond).map((l) => (
          <div key={l.label} className="flex items-center gap-2 text-[12.5px]">
            <span className={cx('grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full',
              l.on ? 'bg-[#16a34a]/25 text-[#4ade80]' : 'bg-surface-4 text-ink-faint')}>
              <Icon name={l.on ? 'check' : 'x'} size={11} />
            </span>
            <span className={l.on ? 'text-ink' : 'text-ink-faint'}>{l.label}</span>
            {l.alt && <span className="rounded bg-[#93c5fd]/15 px-1.5 py-0.5 text-[11px] font-semibold text-[#93c5fd]">{l.alt}</span>}
          </div>
        ))}
        <div className="flex items-start gap-2 text-[12.5px]">
          <span className={cx('mt-[1px] grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full',
            cond.has_defect ? 'bg-[#d97706]/25 text-[#fbbf24]' : 'bg-[#16a34a]/25 text-[#4ade80]')}>
            <Icon name={cond.has_defect ? 'warning' : 'check'} size={11} />
          </span>
          <span className={cond.has_defect ? 'text-[#fbbf24]' : 'text-ink'}>
            {cond.has_defect ? <>มีตำหนิ{cond.defect_note ? <> — {cond.defect_note}</> : ''}</> : 'ไม่มีตำหนิ'}
          </span>
        </div>
      </div>

      <div className="text-[12px] font-semibold text-[#93c5fd]">🚚 ราคาที่ชนะรวมค่าส่งแล้ว</div>
    </div>
  );
}
