'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth } from '@/state/AuthProvider';
import { updateUser } from '@/data/mutations';
import { Icon } from './Icon';
import { cx } from './ui';

/** Blocking overlay: login → (not approved) wait screen → (approved) fill shipping address. */
export function ProfileGate() {
  const { currentUserId, needsProfile, needsApproval, isLoggedIn, signOut } = useAuth();
  const db = useDatabase();
  const me = db.users.find((u) => u.id === currentUserId);
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [line, setLine] = useState('');
  const [browsing, setBrowsing] = useState(false);

  // logged in but the user's own row hasn't loaded yet → clean loading, never the
  // wrong gate. (Under RLS the row loads once the session-aware fetch completes.)
  // Placed AFTER all hooks so hook order stays stable (Rules of Hooks).
  if (isLoggedIn && !me) {
    return (
      <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
        <div className="flex flex-col items-center gap-3 text-ink-muted2">
          <Icon name="box" size={30} className="animate-pulse text-primary-soft" />
          <div className="text-[13px]">กำลังโหลดบัญชี…</div>
          <button onClick={() => signOut()} className="mt-1 text-[12px] text-ink-faint underline">ค้างนานเกินไป? ออกจากระบบ</button>
        </div>
      </div>
    );
  }

  // profile complete but not yet approved → waiting screen (dismissible to browse)
  if (!needsProfile && needsApproval && !browsing) {
    return (
      <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
        <div className="w-full max-w-[380px] rounded-3xl border border-subtle bg-surface-2 p-7 text-center">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-[#d97706]/[0.15]"><Icon name="bell" size={30} className="text-[#fbbf24]" /></div>
          <div className="text-lg font-extrabold text-ink">ส่งข้อมูลเรียบร้อย</div>
          <div className="mt-1.5 text-[13px] text-ink-muted2">บัญชีของคุณกำลัง<b className="text-[#fbbf24]">รอแอดมินอนุมัติ</b><br />เมื่ออนุมัติแล้วจะสั่งซื้อได้ทันที</div>
          <button onClick={() => setBrowsing(true)} className="mt-5 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">ดูสินค้าไปก่อน</button>
        </div>
      </div>
    );
  }

  if (!needsProfile) return null;

  const needPhone = !me?.phone; // phone-signup users already have it; FB users may not
  const save = () => {
    if (needPhone && !phone.trim()) return flash('กรอกเบอร์โทรศัพท์');
    if (!address.trim()) return flash('กรอกที่อยู่จัดส่ง');
    dispatch(updateUser(currentUserId, { ...(needPhone ? { phone: phone.trim() } : {}), shipping_address: address.trim(), line_id: line.trim() || undefined }));
    flash('บันทึกข้อมูลแล้ว ยินดีต้อนรับ! 🎉');
  };

  const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
      <div className="w-full max-w-[420px] rounded-3xl border border-subtle bg-surface-2 p-6">
        <div className="mb-1 flex items-center gap-2 text-lg font-extrabold text-ink"><Icon name="user" size={20} className="text-primary-soft" /> กรอกที่อยู่จัดส่ง</div>
        <div className="mb-4 text-[12.5px] text-ink-faint">อนุมัติแล้ว 🎉 กรอกที่อยู่ให้ครบก่อนเริ่มสั่งซื้อ</div>
        <div className="flex flex-col gap-3">
          {needPhone && (
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">เบอร์โทรศัพท์ <span className="text-primary-soft">*</span></span>
              <input className={inputCls} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08x-xxx-xxxx" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ที่อยู่จัดส่ง <span className="text-primary-soft">*</span></span>
            <textarea className={cx(inputCls, 'h-24 resize-none')} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="บ้านเลขที่ / หมู่ / ถนน / ตำบล / อำเภอ / จังหวัด / รหัสไปรษณีย์" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">LINE ID <span className="text-ink-faint">(ไม่บังคับ)</span></span>
            <input className={inputCls} value={line} onChange={(e) => setLine(e.target.value)} placeholder="@yourline" />
          </label>
          <button onClick={save} className="mt-1 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white">บันทึก · เริ่มใช้งาน</button>
        </div>
      </div>
    </div>
  );
}
