'use client';

import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { approveMember } from '@/data/mutations';

export default function AdminMembersPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();

  const pending = db.users.filter((u) => u.approved === false);
  const members = db.users.filter((u) => u.id !== 'u-admin' && u.approved !== false);

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">สมาชิก</div>
      <div className="mb-5 text-[13px] text-ink-faint">อนุมัติสมาชิกใหม่ที่ล็อกอินผ่าน Facebook · ดูรายชื่อสมาชิกทั้งหมด</div>

      <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 flex items-center gap-2 text-base font-bold text-ink"><Icon name="bell" size={18} className="text-[#fbbf24]" /> <span>รออนุมัติ</span> <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{pending.length}</span></div>
        {pending.length === 0 ? <div className="py-3 text-[13px] text-ink-faint">ไม่มีสมาชิกรออนุมัติ 🎉</div> : (
          <div className="flex flex-col gap-2.5">
            {pending.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3">
                <Avatar u={u} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{u.display_name}</div>
                  <div className="text-[11.5px] text-ink-faint">สมาชิกใหม่ · ยังไม่ได้กรอกข้อมูล</div>
                </div>
                <button onClick={() => { dispatch(approveMember(u.id)); flash(`อนุมัติ ${u.display_name} แล้ว`); }} className="rounded-[9px] bg-success px-4 py-2 text-[13px] font-bold text-white">อนุมัติ</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 text-base font-bold text-ink">สมาชิกทั้งหมด ({members.length})</div>
        <div className="flex flex-col divide-y divide-hair">
          {members.map((u) => (
            <div key={u.id} className="flex items-center gap-3 py-3">
              <Avatar u={u} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{u.display_name}</div>
                <div className="text-[11.5px] text-ink-faint">{u.phone ?? 'ยังไม่มีเบอร์'}{u.shipping_address ? ' · มีที่อยู่' : ''}</div>
              </div>
              <span className={cx('rounded-full border px-2.5 py-1 text-[11.5px] font-bold', RANK[u.rank as RankKey].cls)}>{RANK[u.rank as RankKey].emoji} {RANK[u.rank as RankKey].label}</span>
            </div>
          ))}
          {members.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีสมาชิก</div>}
        </div>
      </div>
    </div>
  );
}

function Avatar({ u }: { u: { display_name: string; avatar_url?: string } }) {
  return u.avatar_url
    ? <img src={u.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
    : <div className="grid h-10 w-10 place-items-center rounded-full bg-primary text-sm font-bold text-white">{u.display_name.charAt(0)}</div>;
}
