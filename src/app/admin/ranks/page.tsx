'use client';

import { useState, useEffect } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { rankPiecesOf, RANK_ORDER } from '@/domain/services/ranks';
import { approveRankRequest, rejectRankRequest, grantRank, updateSettings } from '@/data/mutations';
import type { RankName } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const GRANTABLE: RankName[] = ['bronze', 'silver', 'gold', 'diamond', 'legend'];

export default function AdminRanksPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const st = db.settings;

  const pending = db.rankRequests.filter((r) => r.status === 'pending');
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? uid;

  // grant form
  const [grantUser, setGrantUser] = useState(db.users[0]?.id ?? '');
  const [grantTo, setGrantTo] = useState<RankName>('gold');
  // the seeded default user id won't exist after the real data loads → snap to a valid one
  useEffect(() => { if (db.users.length && !db.users.some((u) => u.id === grantUser)) setGrantUser(db.users[0].id); }, [db.users, grantUser]);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">Ranks</div>
      <div className="mb-5 text-[13px] text-ink-faint">คำร้องเปลี่ยนยศ · มอบยศเอง · ตั้งสิทธิพิเศษแต่ละ rank</div>

      {/* request queue */}
      <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 flex items-center gap-2 text-base font-bold text-ink"><Icon name="bell" size={18} className="text-[#fbbf24]" /> <span>คำร้องรออนุมัติ</span> <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{pending.length}</span></div>
        {pending.length === 0 ? <div className="py-3 text-[13px] text-ink-faint">ไม่มีคำร้องค้าง 🎉</div> : (
          <div className="flex flex-col gap-2.5">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3">
                <span className="text-xl">{RANK[r.to_rank as RankKey].emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{userName(r.user_id)}</div>
                  <div className="text-[11.5px] text-ink-faint">{RANK[r.from_rank as RankKey].label} → <b className="text-ink-muted2">{RANK[r.to_rank as RankKey].label}</b> · สะสม {r.pieces} ชิ้น</div>
                </div>
                <button onClick={() => { dispatch(approveRankRequest(r.id)); flash(`อนุมัติ ${RANK[r.to_rank as RankKey].label} แล้ว`); }} className="rounded-[9px] bg-success px-3.5 py-2 text-[13px] font-bold text-white">อนุมัติ</button>
                <button onClick={() => { dispatch(rejectRankRequest(r.id)); flash('ปฏิเสธคำร้องแล้ว'); }} className="rounded-[9px] border border-subtle bg-surface-2 px-3 py-2 text-[13px] font-bold text-ink-muted2">ปฏิเสธ</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* grant directly */}
      <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 text-base font-bold text-ink">มอบยศเอง (ข้ามเงื่อนไข)</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ลูกค้า</span>
            <select className={inputCls} value={grantUser} onChange={(e) => setGrantUser(e.target.value)}>
              {db.users.filter((u) => u.id !== 'u-admin').map((u) => <option key={u.id} value={u.id}>{u.display_name} · {RANK[u.rank as RankKey].label} · {rankPiecesOf(db, u.id)} ชิ้น</option>)}
            </select>
          </label>
          <label className="block w-[160px]">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ยศ</span>
            <select className={inputCls} value={grantTo} onChange={(e) => setGrantTo(e.target.value as RankName)}>
              {GRANTABLE.map((r) => <option key={r} value={r}>{RANK[r as RankKey].emoji} {RANK[r as RankKey].label}</option>)}
            </select>
          </label>
          <button onClick={() => { dispatch(grantRank(grantUser, grantTo)); flash(`มอบยศ ${RANK[grantTo as RankKey].label} ให้ ${userName(grantUser)}`); }} className="rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white">มอบยศ</button>
        </div>
        <div className="mt-2 text-[11.5px] text-ink-faint">ลูกค้าจะเห็น popup แสดงความยินดีครั้งถัดไปที่เข้าหน้าเว็บ</div>
      </div>

      {/* perk config */}
      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 text-base font-bold text-ink">สิทธิพิเศษ & เกณฑ์</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Num label="เกณฑ์ Silver (ชิ้น)" value={st.rank_silver_pieces} onSave={(v) => dispatch(updateSettings({ rank_silver_pieces: v }))} />
          <Num label="เกณฑ์ Gold (ชิ้น)" value={st.rank_gold_pieces} onSave={(v) => dispatch(updateSettings({ rank_gold_pieces: v }))} />
          <Num label="Gold จ่ายมัดจำ (% ของมาตรฐาน)" value={st.rank_gold_deposit_pct} onSave={(v) => dispatch(updateSettings({ rank_gold_deposit_pct: v }))} hint={`เช่น 50 = มัดจำครึ่งเดียว (${st.deposit_wcf}→${st.deposit_wcf * st.rank_gold_deposit_pct / 100}, ${st.deposit_mega}→${st.deposit_mega * st.rank_gold_deposit_pct / 100})`} />
          <div>
            <div className="mb-1 text-[12.5px] font-semibold text-ink-muted">ส่วนลด In-Stock (Gold+)</div>
            <div className="flex gap-2">
              <select className={cx(inputCls, 'w-[110px]')} value={st.instock_disc_gold_type} onChange={(e) => dispatch(updateSettings({ instock_disc_gold_type: e.target.value as 'percent' | 'baht' }))}>
                <option value="percent">%</option>
                <option value="baht">บาท</option>
              </select>
              <input className={inputCls} inputMode="numeric" defaultValue={st.instock_disc_gold_value} onBlur={(e) => dispatch(updateSettings({ instock_disc_gold_value: Number(e.target.value) || 0 }))} />
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">Bronze/Silver = ไม่มีส่วนลด In-Stock</div>
          </div>
        </div>
      </div>

      {/* rank ladder reference */}
      <div className="mt-[18px] flex flex-wrap gap-2">
        {RANK_ORDER.map((r) => (
          <span key={r} className={cx('rounded-full border px-3 py-1.5 text-[12.5px] font-bold', RANK[r as RankKey].cls)}>{RANK[r as RankKey].emoji} {RANK[r as RankKey].label}</span>
        ))}
      </div>
    </div>
  );
}

function Num({ label, value, onSave, hint }: { label: string; value: number; onSave: (v: number) => void; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>
      <input className={inputCls} inputMode="numeric" defaultValue={value} onBlur={(e) => onSave(Number(e.target.value) || 0)} />
      {hint && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}
