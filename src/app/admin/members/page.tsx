'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { RANK } from '@/lib/theme';
import type { RankKey } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { rankPiecesOf } from '@/domain/services/ranks';
import { baht } from '@/lib/theme';
import { updateUser, removeUser, editTicketDeposit, deleteTicket } from '@/data/mutations';
import { releaseReservation } from '@/lib/reserve';
import { supabase } from '@/data/supabaseClient';
import type { User, PreorderTicket } from '@/domain/entities';

export default function AdminMembersPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);

  const pending = db.users.filter((u) => u.approved === false);
  const members = db.users.filter((u) => u.id !== 'u-admin' && u.approved !== false);

  const approve = async (u: User) => {
    if (supabase) {
      const { data } = await supabase.rpc('ryuma_approve', { p_user_id: u.id });
      const code = (data as { member_code?: string })?.member_code;
      dispatch(updateUser(u.id, { approved: true, ...(code ? { member_code: code } : {}) }));
      flash(`อนุมัติ ${u.display_name} · ${code ?? ''}`);
    } else {
      dispatch(updateUser(u.id, { approved: true }));
      flash(`อนุมัติ ${u.display_name} แล้ว`);
    }
  };

  const resetPin = (u: User) => {
    if (!confirm(`อนุญาตให้ "${u.display_name}" ตั้ง PIN ใหม่?`)) return;
    dispatch(updateUser(u.id, { pin_reset: true }));
    flash('อนุญาตตั้ง PIN ใหม่แล้ว · แจ้งลูกค้าให้กด "ลืม PIN" ตั้งใหม่ได้');
  };

  const del = async (u: User) => {
    if (!confirm(`ลบสมาชิก "${u.display_name}" ออกถาวร?\n\nจะลบ: โปรไฟล์ + บัญชีเข้าสู่ระบบ (เบอร์+PIN) + ออเดอร์/ใบพรี/รายการทั้งหมด\nกู้คืนไม่ได้ — ลูกค้าต้องสมัครใหม่ทั้งหมด`)) return;
    if (supabase) {
      const { data, error } = await supabase.rpc('ryuma_admin_purge_user', { p_user_id: u.id });
      const res = (data ?? {}) as { ok?: boolean; error?: string };
      if (error || !res.ok) return flash(res.error === 'not_admin' ? 'ต้องเป็นแอดมินเท่านั้น' : `ลบไม่สำเร็จ: ${error?.message ?? res.error ?? 'error'}`);
    }
    dispatch(removeUser(u.id));
    flash(`ลบ "${u.display_name}" ออกเกลี้ยงแล้ว — ต้องสมัครใหม่`);
    if (openId === u.id) setOpenId(null);
  };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">สมาชิก</div>
      <div className="mb-5 text-[13px] text-ink-faint">อนุมัติสมาชิกใหม่ (สมัครด้วยเบอร์ + PIN) · เช็คเบอร์/FB ก่อนอนุมัติ → ระบบออกรหัส RYU ให้</div>

      <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 flex items-center gap-2 text-base font-bold text-ink"><Icon name="bell" size={18} className="text-[#fbbf24]" /> <span>รออนุมัติ</span> <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{pending.length}</span></div>
        {pending.length === 0 ? <div className="py-3 text-[13px] text-ink-faint">ไม่มีสมาชิกรออนุมัติ 🎉</div> : (
          <div className="flex flex-col gap-2.5">
            {pending.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-3 p-3">
                <Avatar u={u} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{u.display_name}</div>
                  <div className="text-[11.5px] text-ink-faint">{u.phone ?? 'ไม่มีเบอร์'}{u.fb_link ? ` · FB: ${u.fb_link}` : ''}</div>
                </div>
                <button onClick={() => approve(u)} className="rounded-[9px] bg-success px-4 py-2 text-[13px] font-bold text-white">อนุมัติ</button>
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
                    <Row label="รหัสสมาชิก" value={u.member_code} />
                    <Row label="เบอร์โทร" value={u.phone} />
                    <Row label="ที่อยู่จัดส่ง" value={u.shipping_address} />
                    <Row label="LINE ID" value={u.line_id} />
                    <Row label="Facebook" value={u.fb_link || (u.facebook_id ? 'เชื่อมต่อแล้ว' : '—')} />
                    <Row label="สะสม" value={`${pieces} ชิ้น · ${RANK[u.rank as RankKey].label}`} />
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button onClick={() => setManageId(u.id)} className="rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">จัดการตั๋วพรี ({tickets})</button>
                      <button onClick={() => resetPin(u)} className="rounded-lg border border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-bold text-ink-muted2">อนุญาตตั้ง PIN ใหม่</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {members.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีสมาชิก</div>}
        </div>
      </div>

      {manageId && <TicketManagerModal userId={manageId} onClose={() => setManageId(null)} />}
    </div>
  );
}

/** Admin panel to manage one member's pre-order tickets: edit deposit or delete completely. */
function TicketManagerModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const user = db.users.find((u) => u.id === userId);
  const tickets = db.tickets.filter((t) => t.owner_id === userId);
  const [editId, setEditId] = useState<string | null>(null);
  const [depStr, setDepStr] = useState('');

  const saveDeposit = (t: PreorderTicket) => {
    const total = t.deposit_paid + t.remaining_amount;
    const dep = Number(depStr);
    if (!Number.isFinite(dep) || dep < 0 || dep > total) return flash(`มัดจำต้องอยู่ระหว่าง 0–${total}`);
    dispatch(editTicketDeposit(t.id, dep));
    flash(`แก้มัดจำ ${t.ticket_no} → ${baht(dep)} · ส่วนต่างเหลือ ${baht(total - dep)}`);
    setEditId(null);
  };

  const del = async (t: PreorderTicket) => {
    const product = db.products.find((p) => p.id === t.product_id);
    if (!confirm(`ลบตั๋ว ${t.ticket_no} (${product?.series_name ?? ''}) ออกถาวร?\nจะตัดออกจากระบบจริง${product?.is_stock ? ' + คืนสต๊อกสินค้า' : ' (ยอดจองของสินค้านี้จะลดลง)'}`)) return;
    // return stock for in-stock items by releasing a matching confirmed/paid hold
    if (product?.is_stock) {
      const res = db.stockReservations.find((r) => r.product_id === t.product_id && r.user_id === userId && (t.batch_id ? r.batch_id === t.batch_id : true) && ['confirmed', 'paid', 'active'].includes(r.status));
      if (res) await releaseReservation(res.id).catch(() => {});
    }
    dispatch(deleteTicket(t.id));
    flash(`ลบตั๋ว ${t.ticket_no} แล้ว`);
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-2xl border border-subtle bg-surface-2 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-lg font-extrabold">ตั๋วพรีของ {user?.display_name}</div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle text-ink-faint"><Icon name="x" size={16} /></button>
        </div>

        {tickets.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-ink-faint">สมาชิกคนนี้ยังไม่มีตั๋วพรี</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {tickets.map((t) => {
              const product = db.products.find((p) => p.id === t.product_id);
              const total = t.deposit_paid + t.remaining_amount;
              const editing = editId === t.id;
              return (
                <div key={t.id} className="rounded-xl border border-subtle bg-surface-3 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{product?.series_name ?? t.product_id}</div>
                      <div className="font-mono text-[11px] text-ink-faint">{t.ticket_no} · ×{t.qty} · {STATUS_LABEL[t.product_status] ?? t.product_status}</div>
                    </div>
                    <div className="flex gap-1.5">
                      {!editing && <button onClick={() => { setEditId(t.id); setDepStr(String(t.deposit_paid)); }} className="rounded-lg border border-subtle px-2.5 py-1 text-[12px] font-bold text-ink-muted2">แก้</button>}
                      <button onClick={() => del(t)} className="rounded-lg border border-[#f87171]/40 px-2.5 py-1 text-[12px] font-bold text-[#f87171]">ลบ</button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[12px]">
                    <div className="rounded-lg bg-surface-2 py-1.5"><div className="text-[10px] text-ink-faint">ราคาเต็ม</div><div className="font-bold">{baht(total)}</div></div>
                    <div className="rounded-lg bg-surface-2 py-1.5"><div className="text-[10px] text-ink-faint">มัดจำ</div><div className="font-bold text-primary-soft">{baht(t.deposit_paid)}</div></div>
                    <div className="rounded-lg bg-surface-2 py-1.5"><div className="text-[10px] text-ink-faint">ส่วนต่าง (final)</div><div className="font-bold">{baht(t.remaining_amount)}</div></div>
                  </div>
                  {editing && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="text-[12px] text-ink-muted">มัดจำใหม่</span>
                      <input autoFocus className="w-28 rounded-lg border border-accent bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none" inputMode="numeric" value={depStr} onChange={(e) => setDepStr(e.target.value.replace(/[^\d]/g, ''))} />
                      <span className="text-[11.5px] text-ink-faint">ส่วนต่างจะเหลือ {baht(Math.max(0, total - (Number(depStr) || 0)))}</span>
                      <div className="ml-auto flex gap-1.5">
                        <button onClick={() => setEditId(null)} className="rounded-lg border border-subtle px-3 py-1.5 text-[12px] text-ink-muted2">ยกเลิก</button>
                        <button onClick={() => saveDeposit(t)} className="rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">บันทึก</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { open: 'เปิดจอง', production: 'ผลิต', shipping: 'เดินทาง', arrived: 'ถึงไทย', delivered: 'ส่งมอบ' };

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
