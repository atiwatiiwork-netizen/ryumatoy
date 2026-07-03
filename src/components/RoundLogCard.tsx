'use client';

import { useState } from 'react';
import type { BoardCloseLog } from '@/domain/entities';
import { Icon } from './Icon';
import { cx } from './ui';

/** One production-round history entry (board close OR plain ปิดรอบสั่งผลิต): date + per-product
 *  booked vs final vs surplus. Immutable snapshot — shown on both the board and production pages. */
export function RoundLogCard({ log, makerName }: { log: BoardCloseLog; makerName: string }) {
  const [open, setOpen] = useState(false);
  const totBooked = log.lines.reduce((s, l) => s + l.booked, 0);
  const totFinal = log.lines.reduce((s, l) => s + l.final, 0);
  return (
    <div className="rounded-xl border border-subtle bg-surface-2 p-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 text-left">
        <Icon name="chevronRight" size={15} className={cx('text-ink-faint transition-transform', open && 'rotate-90')} />
        <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted2">ปิดรอบแล้ว</span>
        <span className="text-[14px] font-bold">{log.board_title}</span>
        <span className="text-[12px] text-ink-faint">{makerName} · {log.lines.length} รายการ · จอง {totBooked} → สั่ง {totFinal}</span>
        <span className="ml-auto whitespace-nowrap text-[12px] text-ink-faint">{new Date(log.closed_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-lg border border-hair">
          <div className="grid grid-cols-[1fr_70px_70px_90px] gap-2 bg-surface-3 px-3 py-2 text-[11.5px] font-semibold text-ink-faint">
            <span>รายการ</span><span className="text-center">ยอดจอง</span><span className="text-center">สั่งไฟนอล</span><span className="text-center">ส่วนเกิน→สต๊อก</span>
          </div>
          <div className="flex flex-col divide-y divide-hair">
            {log.lines.map((l) => (
              <div key={l.product_id} className="grid grid-cols-[1fr_70px_70px_90px] items-center gap-2 px-3 py-2 text-[13px]">
                <span className="truncate font-semibold">{l.name}</span>
                <span className="text-center">{l.booked}</span>
                <span className="text-center font-bold text-primary-soft">{l.final}</span>
                <span className="text-center text-[12px]">{l.surplus > 0 ? <span className="text-primary-soft">+{l.surplus}</span> : <span className="text-ink-faint">—</span>}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
