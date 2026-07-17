'use client';

import { cx } from './ui';
import { NEW_STOCK_COND, type StockCond } from '@/domain/entities';

/**
 * สภาพสินค้า In-Stock — picker (แอทมิน) + display (ลูกค้า). Spec เจ้าของ 2026-07-17:
 * มือ1/มือ2 · กล่องสี/กล่องน้ำตาล ติ๊กแยก · มีการ์ด · ไม่มีแตกหัก · มือ2 โชว์นโยบาย
 * "ถึงมือแตกหัก ชดเชย 250 บาททุกกรณี" · ราคา in-stock รวมส่งเสมอ.
 */

export const COMP_BAHT = 250; // ค่าชดเชยมือ 2 แตกหัก (ทุกกรณี)

const FLAGS: { key: keyof Omit<StockCond, 'hand'>; label: string }[] = [
  { key: 'box_color', label: '📦 กล่องสี' },
  { key: 'box_brown', label: '🟫 กล่องน้ำตาล' },
  { key: 'card', label: '🃏 มีการ์ด' },
  { key: 'intact', label: '✅ ไม่มีแตกหัก' },
];

/** ADMIN — เลือกสภาพ (มือ + ติ๊ก 4 ช่องแยกกัน). */
export function StockCondPicker({ value, onChange, compact }: { value?: StockCond; onChange: (c: StockCond) => void; compact?: boolean }) {
  const c = value ?? NEW_STOCK_COND;
  const chip = (on: boolean) => cx('rounded-full border px-2.5 py-1 font-semibold transition-colors', compact ? 'text-[10.5px]' : 'text-[11.5px]', on ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-faint');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex overflow-hidden rounded-lg border border-subtle">
        {([1, 2] as const).map((h) => (
          <button key={h} onClick={() => onChange({ ...c, hand: h })} className={cx('px-2.5 py-1 font-bold', compact ? 'text-[10.5px]' : 'text-[11.5px]', c.hand === h ? (h === 1 ? 'bg-[#16a34a] text-white' : 'bg-[#d97706] text-white') : 'bg-surface-3 text-ink-faint')}>
            มือ {h}
          </button>
        ))}
      </div>
      {FLAGS.map((f) => (
        <button key={f.key} onClick={() => onChange({ ...c, [f.key]: !c[f.key] })} className={chip(c[f.key])}>{c[f.key] ? '' : '✕ '}{f.label}</button>
      ))}
    </div>
  );
}

/** CUSTOMER — การ์ดสภาพสินค้าบนหน้ารายละเอียด (in-stock เท่านั้น). ไม่มีข้อมูลสภาพ (ของเก่า) →
 *  โชว์แค่ "ราคารวมส่งแล้ว". */
export function StockCondCard({ cond }: { cond?: StockCond }) {
  return (
    <div className="mb-[18px] rounded-xl border border-subtle bg-surface-2 p-3.5">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-bold">
        สภาพสินค้า
        {cond && (cond.hand === 1
          ? <span className="rounded-full bg-[#16a34a]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#4ade80]">มือ 1</span>
          : <span className="rounded-full bg-[#d97706]/[0.16] px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">มือ 2</span>)}
      </div>
      {cond && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {FLAGS.map((f) => (
            <span key={f.key} className={cx('rounded-md px-2 py-0.5 text-[11px] font-semibold', cond[f.key] ? 'bg-[#16a34a]/[0.12] text-[#4ade80]' : 'bg-surface-3 text-ink-faint line-through')}>
              {f.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 text-[12px] font-semibold text-[#93c5fd]">🚚 ราคารวมส่งแล้ว</div>
      {cond?.hand === 2 && (
        <div className="mt-1.5 rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.08] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[#fbbf24]">
          🛡️ สินค้ามือ 2: หากถึงมือแล้ว<b>แตกหัก ชดเชย {COMP_BAHT} บาท</b> ทุกกรณี
        </div>
      )}
    </div>
  );
}
