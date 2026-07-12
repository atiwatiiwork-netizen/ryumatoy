'use client';

import { useState, useEffect } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { RoundLogCard } from '@/components/RoundLogCard';
import { orderedQtyOf, franchiseOf, inOpenBoard } from '@/domain/services/catalog';
import { closeProduction } from '@/data/mutations';

const inputCls = 'w-20 rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-center text-sm text-ink outline-none focus:border-accent';

export default function ProductionPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [makerId, setMakerId] = useState(db.manufacturers[0]?.id ?? '');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  // after the real data loads, the seeded default id may not exist → snap to a valid maker
  useEffect(() => { if (db.manufacturers.length && !db.manufacturers.some((m) => m.id === makerId)) setMakerId(db.manufacturers[0].id); }, [db.manufacturers, makerId]);

  // open pre-orders ready to finalize: for the chosen ค่าย, still 'open', and NOT sitting in an
  // open board (those are managed by the board — close the board first, then they show up here).
  const items = db.products.filter((p) => p.manufacturer_id === makerId && !p.is_stock && p.status === 'open' && !inOpenBoard(db, p));
  const orderedOf = (pid: string) => orderedQtyOf(db, pid);
  // clamp to ≥ ยอดจอง so the surplus preview is truthful — closeProduction clamps the same way, so a
  // typed value below the booked qty would otherwise show a wrong "ไม่มีส่วนเกิน". (audit A#7)
  const finalOf = (pid: string) => Math.max(orderedOf(pid), Number(qty[pid] ?? String(orderedOf(pid))) || 0);
  const chosen = items.filter((p) => sel[p.id]);

  const close = () => {
    if (chosen.length === 0) return flash('เลือกรายการที่จะสั่งผลิตก่อน');
    // irreversible (writes a round log + flips all tickets to production) → confirm first (audit A#8)
    const totalFinal = chosen.reduce((s, p) => s + finalOf(p.id), 0);
    if (!window.confirm(`ปิดรอบสั่งผลิต ${chosen.length} รายการ · รวมสั่ง ${totalFinal} ชิ้น?\nยืนยันแล้วย้อนกลับไม่ได้`)) return;
    dispatch(closeProduction(chosen.map((p) => ({ productId: p.id, finalQty: finalOf(p.id) }))));
    flash(`ปิดรอบ → ผลิต ${chosen.length} รายการ`);
    setSel({});
    setQty({});
  };

  return (
    <div>
      <div className="mb-2 text-2xl font-extrabold">ปิดรอบสั่งผลิต</div>
      <div className="mb-5 text-[13px] text-ink-faint">เลือกค่าย → ติ๊กรายการที่ค่ายเรียกเก็บ → ใส่จำนวนไฟนอลที่จะสั่ง → กดปิดรอบ (ส่วนที่เกินยอดจอง = สต๊อกร้าน)</div>

      <div className="mb-5 flex items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
        <select className="rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none" value={makerId} onChange={(e) => { setMakerId(e.target.value); setSel({}); setQty({}); }}>
          {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        {items.length === 0 ? (
          <div className="py-8 text-center text-ink-faint">ไม่มีรายการเปิดจองของค่ายนี้</div>
        ) : (
          <>
            <div className="mb-2 hidden grid-cols-[28px_1fr_90px_110px_1fr] gap-3 px-1 text-[11.5px] font-semibold text-ink-faint lg:grid">
              <span></span><span>สินค้า</span><span className="text-center">ยอดจอง</span><span className="text-center">สั่งไฟนอล</span><span>ส่วนเกิน → สต๊อก</span>
            </div>
            <div className="flex flex-col divide-y divide-hair">
              {items.map((p) => {
                const ordered = orderedOf(p.id);
                const surplus = Math.max(0, finalOf(p.id) - ordered);
                const on = !!sel[p.id];
                return (
                  <div key={p.id} className="grid grid-cols-[28px_1fr] items-center gap-3 py-3 lg:grid-cols-[28px_1fr_90px_110px_1fr]">
                    <button onClick={() => setSel((s) => ({ ...s, [p.id]: !on }))} className={cx('grid h-5 w-5 place-items-center rounded-[5px] border-[1.5px]', on ? 'border-primary bg-primary' : 'border-subtle')}>
                      {on && <Icon name="check" size={12} className="text-white" />}
                    </button>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{p.series_name}</div>
                      <div className="font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · {baht(p.price_total)}</div>
                    </div>
                    <div className="text-center text-sm font-bold lg:col-start-3"><span className="text-ink-faint lg:hidden">ยอดจอง </span>{ordered}</div>
                    <div className="lg:col-start-4 lg:text-center">
                      <input className={inputCls} inputMode="numeric" value={qty[p.id] ?? String(ordered)} disabled={!on} onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value }))} />
                    </div>
                    <div className="text-[13px] lg:col-start-5">
                      {on && surplus > 0
                        ? <span className="text-primary-soft">+{surplus} ตัว → สต๊อก</span>
                        : <span className="text-ink-faint">{on ? 'ไม่มีส่วนเกิน' : '—'}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex items-center gap-3">
              <span className="text-[13px] text-ink-muted">เลือก {chosen.length} รายการ</span>
              <div className="ml-auto w-auto"><Button onClick={close} icon="check" style={{ width: 'auto', paddingLeft: 24, paddingRight: 24 }}>ปิดรอบ → ผลิต</Button></div>
            </div>
          </>
        )}
      </div>

      {/* history of production rounds for this ค่าย (board closes + plain closes, immutable snapshots) */}
      {(() => {
        const logs = (db.boardLogs ?? []).filter((l) => l.maker_id === makerId);
        if (logs.length === 0) return null;
        const makerName = db.manufacturers.find((m) => m.id === makerId)?.name ?? '—';
        return (
          <div className="mt-8">
            <div className="mb-3 text-base font-bold text-ink-muted2">ประวัติปิดรอบของค่ายนี้ ({logs.length})</div>
            <div className="flex flex-col gap-3">
              {logs.map((log) => <RoundLogCard key={log.id} log={log} makerName={makerName} />)}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
