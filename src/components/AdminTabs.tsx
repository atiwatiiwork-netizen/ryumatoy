'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

/**
 * แถบแท็บของ "หน้าพี่น้อง" (เจ้าของ 2026-07-26 — จัดระเบียบฝั่งแอดมิน).
 *
 * เมนูข้างเดิมมี 19 ปุ่ม เพราะแตกทุกหน้าออกมาเป็นเมนูของตัวเอง ทั้งที่หลายหน้าคือ "งานเดียวกัน
 * คนละมุม" (เช่น สมาชิก ↔ Ranks, คูปอง ↔ กิจกรรม, ปิดรอบ ↔ กระดานปิดพรี) — ทำให้หาไม่เจอ
 * และไม่รู้ว่าควรเริ่มตรงไหน. วิธีแก้: ยุบเป็นเมนูเดียวต่อ "งาน" แล้วให้หน้าพี่น้องอยู่เป็นแท็บ
 * บนหัวหน้านั้นแทน — เส้นทาง (URL) เดิมยังใช้ได้ทั้งหมด ไม่มีลิงก์ไหนพัง
 */
export interface AdminTab { href: string; label: string; badge?: number }

export function AdminTabs({ tabs }: { tabs: AdminTab[] }) {
  const path = usePathname();
  if (tabs.length < 2) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1.5 border-b border-subtle pb-3">
      {tabs.map((t) => {
        const active = t.href === '/admin' ? path === '/admin' : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href}
            className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold',
              active ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2 hover:text-ink')}>
            {t.label}
            {!!t.badge && t.badge > 0 && (
              <span className={cx('rounded-full px-[7px] text-[11px] font-extrabold', active ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{t.badge}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
