'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { CURRENT_USER_ID } from '@/data/seed';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { RANK_ORDER } from '@/domain/services/ranks';
import { markRankSeen } from '@/data/mutations';
import type { RankName, ShopSettings } from '@/domain/entities';
import { cx } from './ui';

/** Human list of a rank's perks (given current settings). */
export function perksFor(s: ShopSettings, rank: RankName): string[] {
  if (rank === 'gold') {
    const out = [`มัดจำเหลือ ${s.rank_gold_deposit_pct}% (เช่น ฿${s.deposit_wcf}→฿${s.deposit_wcf * s.rank_gold_deposit_pct / 100})`];
    if (s.instock_disc_gold_value > 0) out.push(`ลดสินค้า In-Stock ${s.instock_disc_gold_type === 'percent' ? s.instock_disc_gold_value + '%' : '฿' + s.instock_disc_gold_value}`);
    return out;
  }
  if (rank === 'diamond' || rank === 'legend') return ['ไม่ต้องมัดจำ (จ่ายเต็มตอนของถึง)', 'สิทธิพิเศษระดับสูง (เร็วๆ นี้)'];
  if (rank === 'silver') return ['สะสมต่อเพื่อปลดล็อก Gold'];
  return ['เริ่มต้น — ยังไม่มีสิทธิพิเศษ'];
}

/** Global congrats popup — fires once when a user's rank changes (rank !== rank_seen). */
export function RankCongrats() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const me = db.users.find((u) => u.id === CURRENT_USER_ID);
  if (!me || me.rank === 'bronze' || me.rank === me.rank_seen) return null;
  const r = RANK[me.rank as RankKey];
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-6" onClick={() => dispatch(markRankSeen(me.id))}>
      <div className="w-full max-w-[360px] rounded-3xl border p-7 text-center" style={{ background: r.grad, borderColor: 'transparent' }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-[56px] leading-none">{r.emoji}</div>
        <div className="text-[13px] font-semibold text-ink-muted2">ยินดีด้วย! คุณได้เลื่อนเป็น</div>
        <div className={cx('mb-3 mt-1 text-3xl font-extrabold', r.cls.split(' ')[0])}>{r.label}</div>
        <ul className="mb-5 flex flex-col gap-1.5 text-[13px] text-ink">
          {perksFor(db.settings, me.rank).map((p, i) => <li key={i}>✦ {p}</li>)}
        </ul>
        <button onClick={() => dispatch(markRankSeen(me.id))} className="w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">เย่! รับทราบ</button>
      </div>
    </div>
  );
}

/** All-ranks perks sheet (opened from the profile). */
export function RankPerksModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useDatabase();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-5" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-[420px] overflow-y-auto rounded-3xl border border-subtle bg-surface-2 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-lg font-extrabold text-ink">สิทธิพิเศษแต่ละระดับ</div>
          <button onClick={onClose} className="text-ink-faint">✕</button>
        </div>
        <div className="flex flex-col gap-2.5">
          {RANK_ORDER.map((rk) => {
            const r = RANK[rk as RankKey];
            return (
              <div key={rk} className="rounded-2xl border p-3.5" style={{ background: r.grad, borderColor: 'transparent' }}>
                <div className={cx('mb-1.5 flex items-center gap-2 text-sm font-extrabold', r.cls.split(' ')[0])}>{r.emoji} {r.label}
                  {rk === db.users.find((u) => u.id === CURRENT_USER_ID)?.rank && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] text-ink">ของคุณ</span>}
                </div>
                <ul className="flex flex-col gap-1 text-[12.5px] text-ink-muted2">
                  {perksFor(db.settings, rk).map((p, i) => <li key={i}>· {p}</li>)}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Convenience: a button that opens the perks modal. */
export function RankPerksButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className={className}>ดูสิทธิพิเศษทุกระดับ →</button>
      <RankPerksModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
