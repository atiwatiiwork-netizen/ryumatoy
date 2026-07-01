'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { rankPiecesOf } from '@/domain/services/ranks';
import { approveMember, removeUser } from '@/data/mutations';
import type { User } from '@/domain/entities';

export default function AdminMembersPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [openId, setOpenId] = useState<string | null>(null);

  const pending = db.users.filter((u) => u.approved === false);
  const members = db.users.filter((u) => u.id !== 'u-admin' && u.approved !== false);

  const del = (u: User) => {
    if (!confirm(`ลบสมาชิก "${u.display_name}" ?\n(ใบพรี/ออเดอร์เดิมจะไม่ถูกลบ)`)) return;
    dispatch(removeUser(u.id));
    flash('ลบสมาชิกแล้ว');
    if (openId === u.id) setOpenId(null);
  };

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
          {members.map((u) => {
            const open = openId === u.id;
            const pieces = rankPiecesOf(db, u.id);
            const tickets = db.tickets.filter((t) => t.owner_id === u.id).length;
            return (
              <div key={u.id} className="py-2">
                <div className="flex items-center gap-3">
                  <Avatar u={u} />
                  <button onClick={() => setOpenId(open ? null : u.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5 text-sm font-semibold">{u.display_name} <span className={cx('text-[10px] text-ink-faint transition-transform', open && 'inline-block rotate-180')}>▾</span></div>
                    <div className="text-[11.5px] text-ink-faint">{u.phone ?? 'ยังไม่มีเบอร์'}{u.shipping_address ? ' · มีที่อยู่' : ''} · {tickets} ใบพรี</div>
                  </button>
                  <span className={cx('rounded-full border px-2.5 py-1 text-[11.5px] font-bold', RANK[u.rank as RankKey].cls)}>{RANK[u.rank as RankKey].emoji} {RANK[u.rank as RankKey].label}</span>
                  <button onClick={() => del(u)} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint hover:text-[#f87171]"><Icon name="x" size={15} /></button>
                </div>
                {open && (
                  <div className="ml-[52px] mt-2 grid gap-1.5 rounded-xl border border-subtle bg-surface-3 p-3 text-[12.5px]">
                    <Row label="เบอร์โทร" value={u.phone} />
                    <Row label="ที่อยู่จัดส่ง" value={u.shipping_address} />
                    <Row label="LINE ID" value={u.line_id} />
                    <Row label="สะสม" value={`${pieces} ชิ้น · ${RANK[u.rank as RankKey].label}`} />
                    <Row label="Facebook" value={u.facebook_id ? 'เชื่อมต่อแล้ว' : '—'} />
                  </div>
                )}
              </div>
            );
          })}
          {members.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีสมาชิก</div>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-ink-faint">{label}</span>
      <span className="text-ink">{value || '—'}</span>
    </div>
  );
}

function Avatar({ u }: { u: { display_name: string; avatar_url?: string } }) {
  return u.avatar_url
    ? <img src={u.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
    : <div className="grid h-10 w-10 place-items-center rounded-full bg-primary text-sm font-bold text-white">{u.display_name.charAt(0)}</div>;
}
