'use client';

/**
 * ฟอร์มที่อยู่จัดส่งแบบแยกช่อง (แพลตฟอร์มที่อยู่ — เจ้าของ 2026-09-12):
 * ชื่อผู้รับ / เบอร์โทร / ที่อยู่ / จังหวัด (datalist 77 จังหวัด) / รหัสไปรษณีย์.
 * ใช้ตัวเดียวทั้ง 3 ที่ (DNA shared component): กรอกครั้งแรก (ProfileGate) · ปุ่มแก้ไขในโปรไฟล์ ·
 * "ส่งที่อยู่ใหม่" ตอนเลือกวิธีรับของ — ห้ามวาดฟอร์มที่อยู่ซ้ำที่อื่น.
 */

import { useId } from 'react';
import { Icon } from './Icon';
import { cx } from './ui';
import { THAI_PROVINCES } from '@/domain/services/address';
import type { ShippingInfo } from '@/domain/entities';

const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-[13.5px] text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-accent';

export function AddressForm({ value, onChange }: { value: ShippingInfo; onChange: (v: ShippingInfo) => void }) {
  const listId = useId(); // กัน datalist id ชนกันเมื่อฟอร์มโผล่ 2 ที่ในหน้าเดียว
  const set = (k: keyof ShippingInfo) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-ink-muted"><Icon name="user" size={13} className="text-primary-soft" /> ชื่อผู้รับ <span className="text-primary-soft">*</span></span>
          <input className={inputCls} value={value.name ?? ''} onChange={set('name')} placeholder="ชื่อ-นามสกุล ผู้รับพัสดุ" autoComplete="name" />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-ink-muted"><Icon name="bell" size={13} className="text-primary-soft" /> เบอร์โทร <span className="text-primary-soft">*</span></span>
          <input className={inputCls} value={value.phone ?? ''} onChange={set('phone')} inputMode="tel" placeholder="08x-xxx-xxxx" autoComplete="tel" />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-ink-muted"><Icon name="home" size={13} className="text-primary-soft" /> ที่อยู่ <span className="text-primary-soft">*</span></span>
        <textarea className={cx(inputCls, 'h-[76px] resize-none')} value={value.address ?? ''} onChange={set('address')}
          placeholder="บ้านเลขที่ / หมู่ / ซอย / ถนน / ตำบล / อำเภอ" autoComplete="street-address" />
      </label>
      <div className="grid grid-cols-[1fr_120px] gap-2.5">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-muted">จังหวัด <span className="text-primary-soft">*</span></span>
          <input className={inputCls} value={value.province ?? ''} onChange={set('province')} list={listId} placeholder="พิมพ์เพื่อค้นหา…" />
          <datalist id={listId}>{THAI_PROVINCES.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-muted">ไปรษณีย์ <span className="text-primary-soft">*</span></span>
          <input className={inputCls} value={value.postal ?? ''} onChange={(e) => onChange({ ...value, postal: e.target.value.replace(/[^\d]/g, '').slice(0, 5) })}
            inputMode="numeric" placeholder="10110" autoComplete="postal-code" />
        </label>
      </div>
    </div>
  );
}
