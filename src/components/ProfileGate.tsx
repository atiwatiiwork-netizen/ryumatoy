'use client';

import { useState } from 'react';
import { useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useAuth } from '@/state/AuthProvider';
import { updateUser } from '@/data/mutations';
import { Icon } from './Icon';
import { cx } from './ui';

/** Blocking overlay shown right after login when phone/address haven't been captured. */
export function ProfileGate() {
  const { currentUserId, needsProfile } = useAuth();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [line, setLine] = useState('');

  if (!needsProfile) return null;

  const save = () => {
    if (!phone.trim()) return flash('กรอกเบอร์โทรศัพท์');
    if (!address.trim()) return flash('กรอกที่อยู่จัดส่ง');
    dispatch(updateUser(currentUserId, { phone: phone.trim(), shipping_address: address.trim(), line_id: line.trim() || undefined }));
    flash('บันทึกข้อมูลแล้ว ยินดีต้อนรับ! 🎉');
  };

  const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-5">
      <div className="w-full max-w-[420px] rounded-3xl border border-subtle bg-surface-2 p-6">
        <div className="mb-1 flex items-center gap-2 text-lg font-extrabold text-ink"><Icon name="user" size={20} className="text-primary-soft" /> กรอกข้อมูลก่อนเริ่มใช้งาน</div>
        <div className="mb-4 text-[12.5px] text-ink-faint">ใช้สำหรับจัดส่งพัสดุ — จำเป็นต้องกรอกให้ครบก่อนสั่งซื้อ</div>
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">เบอร์โทรศัพท์ <span className="text-primary-soft">*</span></span>
            <input className={inputCls} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08x-xxx-xxxx" />
          </label>
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
